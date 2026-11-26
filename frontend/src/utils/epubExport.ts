/**
 * 漫画 EPUB 导出：把含 <img> 的漫画章节打包为标准 EPUB，
 * 图片作为包内资源内嵌，可被 XRead（及通用阅读器）重新导入阅读，形成闭环。
 *
 * - 只做前端：图片经现有 /reader3/bookSourceProxy 代理下载，绕开跨域/防盗链；
 * - 图片下载失败时不内嵌，章节 XHTML 保留原远程 <img src> 占位（在线可看）；
 * - 书头（书名/作者/简介）写入 OPF metadata，不插入正文。
 */
import { zipSync, strToU8, type Zippable } from 'fflate'
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
  /** 每章下载进度回调 */
  onProgress?: (completed: number, total: number, title: string) => void
  /** 取消标记 */
  signal?: { cancelled: boolean }
  /** 注入的下载函数，默认走 bookSourceProxy（测试可替换） */
  fetchImage?: (url: string) => Promise<Uint8Array>
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
  const total = chapters.length
  let completed = 0

  for (let ci = 0; ci < chapters.length; ci++) {
    if (params.signal?.cancelled) break
    const chapter = chapters[ci]
    const urls = extractImageUrls(chapter.content)
    totalImages += urls.length
    const bodyParts: string[] = []

    for (const url of urls) {
      let imgHtml: string
      try {
        const bytes = await fetchImage(url)
        imageSeq += 1
        const ext = imageExt(url)
        const imgName = `${String(imageSeq).padStart(5, '0')}.${ext}`
        const imgPath = `OEBPS/Images/${imgName}`
        files[imgPath] = bytes
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
        imageManifestItems.push(
          `<item id="img${imageSeq}" href="Images/${imgName}" media-type="${mime}" />`,
        )
        imgHtml = `<div class="page"><img src="../Images/${imgName}" alt="" /></div>`
      } catch {
        failedImages.push(url)
        // 失败：保留远程链接占位，在线可看
        imgHtml = `<div class="page"><img src="${xmlEscape(url)}" alt="" /></div>`
      }
      bodyParts.push(imgHtml)
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

    completed += 1
    params.onProgress?.(completed, total, chapter.title)
  }

  // 被取消：只返回已处理部分（调用方可据 signal 决定丢弃）
  if (params.signal?.cancelled) {
    return { bytes: new Uint8Array(), failedImages, totalImages }
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

  const zipped = await zipEpub(files)
  return { bytes: zipped, failedImages, totalImages }
}

/**
 * 打包为 EPUB：mimetype 必须是首个条目且不压缩（level:0），
 * 其余条目正常压缩。这是通用阅读器识别 EPUB 的硬性要求。
 */
function zipEpub(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  // zipSync 的逐文件选项：mimetype 用 level:0（STORE），其余 level:6
  const entries: Zippable = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  }
  for (const [name, data] of Object.entries(files)) {
    entries[name] = [data, { level: 6 }]
  }
  return Promise.resolve(zipSync(entries))
}
