/**
 * 漫画 EPUB 导出：把含 <img> 的漫画章节打包为标准 EPUB，
 * 图片作为包内资源内嵌，可被 XRead（及通用阅读器）重新导入阅读，形成闭环。
 *
 * - 只做前端：图片经现有 /reader3/bookSourceProxy 代理下载，绕开跨域/防盗链；
 * - 图片下载失败时不内嵌，章节 XHTML 保留原远程 <img src> 占位（在线可看）；
 * - 书头（书名/作者/简介）写入 OPF metadata，不插入正文。
 */
import { zip, strToU8, type Zippable } from 'fflate'
import { appendAuthQueryParams } from './secureAccess'

export interface ComicChapter {
  title: string
  /** 章节正文原始 HTML（含 <img src>） */
  content: string
}

export interface ComicEpubParams {
  name: string
  author: string
  intro?: string
  chapters: ComicChapter[]
  bookSourceUrl?: string
  /** 阶段回调：download=下载图片中，pack=打包中 */
  onPhase?: (phase: 'download' | 'pack') => void
  /** 图片下载进度回调：completed 已完成图片数，total 总图片数 */
  onImageProgress?: (completed: number, total: number) => void
  /** 每章下载进度回调（保留兼容，图片阶段不再逐章调用） */
  onProgress?: (completed: number, total: number, title: string) => void
  /** 取消标记 */
  signal?: { cancelled: boolean }
  /** 注入的下载函数，默认走 bookSourceProxy（测试可替换） */
  fetchImage?: (url: string) => Promise<Uint8Array>
}

/** 图片下载并发度：兼顾提速与不压垮书源/代理。 */
const IMAGE_CONCURRENCY = 6

/**
 * 带并发上限与取消检查的异步 map，保留结果顺序。
 * 取消后未开始的任务不再发起，已在途的任务等待其自然结束。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  isCancelled: () => boolean,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!isCancelled()) {
      const index = next++
      if (index >= items.length) break
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export interface ComicEpubResult {
  /** 最终 zip 字节 */
  bytes: Uint8Array
  /** 下载失败、以远程链接占位的图片 URL 列表 */
  failedImages: string[]
  totalImages: number
}

const AUDIO_VIDEO_HINT =
  /(mime_type=audio|mime_type=video|\.mp3(\?|$)|\.mp4(\?|$)|\.m3u8(\?|$))/i

/** 从正文 HTML 提取 img 的 src 列表（按出现顺序），过滤空值与非 http(s)/本地资源。 */
export function extractImageUrls(html: string): string[] {
  if (!html) return []
  const urls: string[] = []
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const src = m[1].trim()
    if (!src || AUDIO_VIDEO_HINT.test(src)) continue
    urls.push(src)
  }
  return urls
}

/**
 * 判定章节正文是否为漫画：含至少一张图片，且图片数相对文字明显占优。
 * 规则：img>=1 且（去除 img 标签后的可见文字 < 图片数 * 40 字符）。
 */
export function isComicContent(html: string): boolean {
  if (!html) return false
  const urls = extractImageUrls(html)
  if (!urls.length) return false
  const text = html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')
  return text.length < urls.length * 40
}

/** 判定整本书是否以漫画为主：漫画章占比超过一半。 */
export function isComicBook(chapters: ComicChapter[]): boolean {
  if (!chapters.length) return false
  const comic = chapters.filter((c) => isComicContent(c.content)).length
  return comic > chapters.length / 2
}

function xmlEscape(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 由 URL 推断图片扩展名。 */
function imageExt(url: string, contentType?: string): string {
  const ct = (contentType || '').toLowerCase()
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('gif')) return 'gif'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i)
  return m ? m[1].toLowerCase() : 'jpg'
}

/** 构造经后端代理的图片下载 URL（带鉴权参数）。 */
export function buildImageProxyUrl(
  imageUrl: string,
  bookSourceUrl: string | undefined,
  origin?: string,
  storage: Pick<Storage, 'getItem'> = typeof localStorage !== 'undefined' ? localStorage : ({ getItem: () => null } as never),
): string {
  const base = origin || (typeof window !== 'undefined' ? window.location.origin : '')
  const params = new URLSearchParams()
  appendAuthQueryParams(params, storage)
  if (bookSourceUrl) params.set('bookSourceUrl', bookSourceUrl)
  params.set('url', imageUrl)
  return `${base}/reader3/bookSourceProxy?${params.toString()}`
}

/**
 * 把章节列表打包成标准 EPUB。返回结果字节，不落盘（由调用方触发下载）。
 */
export async function buildComicEpub(params: ComicEpubParams): Promise<ComicEpubResult> {
  const files: Record<string, Uint8Array> = {}
  const failedImages: string[] = []
  const failedSet = new Set<string>()
  let totalImages = 0
  let imageSeq = 0
  const spineHtmlFiles: string[] = []
  const navItems: string[] = []
  // 内嵌图片的 manifest 项（XRead EPUB 导入器只收集 manifest 中声明的图片资源）
  const imageManifestItems: string[] = []

  const fetchImage =
    params.fetchImage ??
    (async (url: string) => {
      const proxy = buildImageProxyUrl(url, params.bookSourceUrl)
      const resp = await fetch(proxy)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return new Uint8Array(await resp.arrayBuffer())
    })

  const chapters = params.chapters

  // ---- 阶段 1：收集全部图片任务并按 URL 去重，有限并发下载 ----
  // 先把所有章节的图片 URL 扁平化，便于按图片数汇报统一进度；
  // 同一 URL 只下载一次（漫画分章常复用同一张图），缓存字节后按顺序写包。
  const chapterUrls: string[][] = chapters.map((ch) => extractImageUrls(ch.content))
  const uniqueUrls: string[] = []
  const urlSet = new Set<string>()
  for (const urls of chapterUrls) {
    for (const url of urls) {
      if (!urlSet.has(url)) {
        urlSet.add(url)
        uniqueUrls.push(url)
      }
    }
  }
  totalImages = uniqueUrls.length
  const bytesByUrl = new Map<string, Uint8Array>()
  let downloaded = 0

  params.onPhase?.('download')
  params.onImageProgress?.(0, totalImages)

  await mapWithConcurrency(
    uniqueUrls,
    IMAGE_CONCURRENCY,
    async (url) => {
      try {
        bytesByUrl.set(url, await fetchImage(url))
      } catch {
        failedSet.add(url)
      }
      downloaded += 1
      params.onImageProgress?.(downloaded, totalImages)
    },
    () => !!params.signal?.cancelled,
  )

  // 按 URL 首次出现顺序确定失败清单，避免并发完成顺序造成不稳定结果
  for (const url of uniqueUrls) {
    if (failedSet.has(url)) failedImages.push(url)
  }

  // 被取消：返回空字节；调用方依据 signal 决定丢弃
  if (params.signal?.cancelled) {
    return { bytes: new Uint8Array(), failedImages, totalImages }
  }

  // ---- 阶段 2：按章节顺序组装 XHTML，图片字节复用缓存 ----
  for (let ci = 0; ci < chapters.length; ci++) {
    const chapter = chapters[ci]
    const urls = chapterUrls[ci]
    const bodyParts: string[] = []

    for (const url of urls) {
      const bytes = bytesByUrl.get(url)
      if (bytes) {
        imageSeq += 1
        const ext = imageExt(url)
        const imgName = `${String(imageSeq).padStart(5, '0')}.${ext}`
        const imgPath = `OEBPS/Images/${imgName}`
        files[imgPath] = bytes
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
        imageManifestItems.push(
          `<item id="img${imageSeq}" href="Images/${imgName}" media-type="${mime}" />`,
        )
        bodyParts.push(`<div class="page"><img src="../Images/${imgName}" alt="" /></div>`)
      } else {
        // 失败：保留远程链接占位，在线可看
        bodyParts.push(`<div class="page"><img src="${xmlEscape(url)}" alt="" /></div>`)
      }
    }

    const htmlName = `ch${String(ci).padStart(4, '0')}.xhtml`
    const htmlPath = `OEBPS/Text/${htmlName}`
    spineHtmlFiles.push(htmlPath)
    files[htmlPath] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n` +
        `<head><title>${xmlEscape(chapter.title)}</title>` +
        `<link rel="stylesheet" type="text/css" href="../Styles/comic.css" /></head>\n` +
        `<body><h1 class="chapter-title">${xmlEscape(chapter.title)}</h1>\n` +
        bodyParts.join('\n') +
        `\n</body></html>`,
    )
    navItems.push(
      `<li><a href="../Text/${htmlName}">${xmlEscape(chapter.title || `第 ${ci + 1} 章`)}</a></li>`,
    )
    params.onProgress?.(ci + 1, chapters.length, chapter.title)
  }

  const name = params.name?.trim() || '本地漫画'
  const author = params.author?.trim() || ''
  const intro = params.intro?.trim() || ''

  // OPF：XRead 导入器读取 dc:title / dc:creator，以及 manifest / spine / nav
  const manifestItems: string[] = []
  const spineItems: string[] = []
  spineHtmlFiles.forEach((path, i) => {
    const fileName = path.split('/').pop()!
    manifestItems.push(
      `<item id="ch${i}" href="Text/${fileName}" media-type="application/xhtml+xml" />`,
    )
    spineItems.push(`<itemref idref="ch${i}" />`)
  })
  manifestItems.push(
    ...imageManifestItems,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />`,
    `<item id="css" href="Styles/comic.css" media-type="text/css" />`,
  )

  const opf =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `<dc:identifier id="bookid">comic-export-${Date.now()}</dc:identifier>\n` +
    `<dc:title>${xmlEscape(name)}</dc:title>\n` +
    (author ? `<dc:creator>${xmlEscape(author)}</dc:creator>\n` : '') +
    (intro ? `<dc:description>${xmlEscape(intro)}</dc:description>\n` : '') +
    `<dc:language>zh-CN</dc:language>\n` +
    `</metadata>\n` +
    `<manifest>${manifestItems.join('')}</manifest>\n` +
    `<spine toc="ncx">${spineItems.join('')}</spine>\n` +
    `</package>`

  const container =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />` +
    `</rootfiles></container>`

  const nav =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n` +
    `<head><title>目录</title></head><body>` +
    `<nav epub:type="toc"><h1>目录</h1><ol>${navItems.join('')}</ol></nav>` +
    `</body></html>`

  const ncxPoints = navItems
    .map((_item, i) => {
      const fileName = `ch${String(i).padStart(4, '0')}.xhtml`
      const label = chapters[i]?.title || `第 ${i + 1} 章`
      return `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${xmlEscape(label)}</text></navLabel><content src="Text/${fileName}" /></navPoint>`
    })
    .join('')
  const ncx =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n` +
    `<head><meta name="dtb:uid" content="comic-export" /></head>` +
    `<docTitle><text>${xmlEscape(name)}</text></docTitle>` +
    `<navMap>${ncxPoints}</navMap></ncx>`

  const css = `body{margin:0;padding:0;background:#fff;} .chapter-title{font-size:1em;text-align:center;margin:0.5em;} .page{margin:0;padding:0;text-align:center;} .page img{width:100%;height:auto;display:block;margin:0;}`

  files['META-INF/container.xml'] = strToU8(container)
  files['OEBPS/content.opf'] = strToU8(opf)
  files['OEBPS/nav.xhtml'] = strToU8(nav)
  files['OEBPS/toc.ncx'] = strToU8(ncx)
  files['OEBPS/Styles/comic.css'] = strToU8(css)

  params.onPhase?.('pack')
  const zipped = await zipEpub(files)
  return { bytes: zipped, failedImages, totalImages }
}

/**
 * 打包为 EPUB：mimetype 必须是首个条目且不压缩（level:0），
 * 其余条目正常压缩。这是通用阅读器识别 EPUB 的硬性要求。
 *
 * 用 fflate 的异步 zip（回调式）替代同步 zipSync：压缩几百 MB 漫画图片时
 * 分批让出主线程，界面不会假死；图片本身已是 JPEG/WebP 高熵数据，
 * 用 level:0（STORE）打包既不损失可读性、体积几乎不变，又大幅缩短耗时。
 */
function zipEpub(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const entries: Zippable = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  }
  for (const [name, data] of Object.entries(files)) {
    // 图片无需再压缩（高熵 + 已压缩格式），STORE 即可；文本仍正常压缩。
    const isImage = name.startsWith('OEBPS/Images/')
    entries[name] = [data, { level: isImage ? 0 : 6 }]
  }
  return new Promise((resolve, reject) => {
    zip(entries, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}
