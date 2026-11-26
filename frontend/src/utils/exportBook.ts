import { getChapterList, getBookContent, exportLocalBookText } from '../api/bookshelf'
import type { Book, BookChapter } from '../types'
import { buildStorageFileName, buildEpubFileName, isLocalTxtBook, stripTitleMarks, stripAuthorLabel } from './localBook'
import { cleanHtmlText, cleanExportedBody } from './cleanText'
import { buildComicEpub, isComicContent, type ComicChapter } from './epubExport'
import { isLocalBook } from './localBook'

export interface ExportProgress {
  total: number
  completed: number
  chapterTitle: string
}

/**
 * 把书源返回的正文清洗成适合纯文本导出的形式。
 *
 * 书源正文常是 HTML（<div>/<p>/<br>/&nbsp; 等），甚至会出现【双重转义】
 * （如字面量 &lt;br&gt;、&amp;nbsp;），若只按纯文本拼接就会像图3那样把标签
 * 原样写进 txt。这里用 cleanHtmlText 做 HTML→纯文本，并对双重转义做二次解码，
 * 最后统一换行、去尾随空白。
 */
export function normalizeContent(content: string): string {
  if (!content) return ''
  let text = cleanHtmlText(content, { lineBreaks: true })
  // 双重转义：第一次解码后暴露出新的实体/标签，再清洗一次（最多两轮，避免异常开销）
  if (/&(?:lt|gt|amp|nbsp|#\d|#x)/i.test(text) || /<[a-z][^>]*>/i.test(text)) {
    text = cleanHtmlText(text, { lineBreaks: true })
  }
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\u00a0]+$/, ''))
    .join('\n')
    .trim()
}

/**
 * 生成规范格式的导出书头：书名、作者、（可选）简介。
 * 书名用《》包裹、作者用「作者：」前缀、简介作为独立段落；
 * 不含章节标题、导出时间、来源等无关信息，避免再次出现「序章」这类多余内容。
 *
 * includeIntro=false 时只输出书名/作者——用于本地书原文件已自带简介的场景，避免重复。
 */
export function buildExportHeader(book: Book, options: { includeIntro?: boolean } = {}): string {
  const { includeIntro = true } = options
  // 书名/作者先剥离自带书名号，避免《《书名》》重复包裹；作者名本就不带书名号。
  const name = stripTitleMarks(cleanHtmlText(book.name)) || '本地小说'
  // 清洗作者自带的「作者：」标签，避免出现「作者：作者：某某」
  const author = stripAuthorLabel(stripTitleMarks(cleanHtmlText(book.author)))
  const lines: string[] = [`《${name}》`]
  if (author) lines.push(`作者：${author}`)
  if (includeIntro) {
    let intro = cleanHtmlText(book.intro, { lineBreaks: true })
    if (intro) {
      // 简介统一加「简介：」前缀；若书源简介本身已带标签则先去掉，避免「简介：简介：xxx」。
      intro = intro.replace(/^\s*(?:内容简介|内容提要|简要介绍|内容简介：|简介)\s*[:：]?\s*/i, '')
      if (intro) lines.push('', `简介：${intro}`)
    }
  }
  return lines.join('\n')
}

/**
 * 判断章节正文开头是否已自带该章节标题（避免导出时重复插入一遍）。
 * 只比对开头前两行的归一化文本：去空白、书名号、序号差异不影响判断。
 */
function bodyStartsWithTitle(body: string, title: string): boolean {
  const norm = (s: string) => s.replace(/[\s\u00a0:：、.。·\-—_(（）)【】\[\]《》]/g, '').toLowerCase()
  const t = norm(title)
  if (!t) return false
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l) ?? ''
  const h = norm(firstLine)
  if (!h) return false
  // 正文首行就是章节标题（相等，或首行以标题开头且长度接近，容忍少量装饰字符差异）
  return h === t || (h.includes(t) && h.length <= t.length + 8)
}

/**
 * 检测本地书原文件开头是否已带简介段落（如「简介：xxx」「内容简介」）。
 * 本地书原文件常自带书名/作者/简介头部，此时导出书头不必再加简介，避免重复。
 */
function originalTextHasIntro(text: string): boolean {
  const head = (text ?? '').replace(/^\s+/, '').slice(0, 800)
  // 识别原文常见的各种简介标签：内容简介/内容提要/简要介绍/内容介绍/简介/introduction，
  // 命中任一即认为原文已自带简介，书头不再重复添加（保留原文那一份）。
  return /(?:^|\n)[ \t]*(?:内容简介|内容提要|简要介绍|内容介绍|简介|introduction)\s*[:：]/i.test(head)
}

/**
 * 判断一行是否像「不规范的书名/作者头部」（仅用于本地书开头扫描区）。
 * 命中条件：整行较短、包含当前书的书名或作者，且剔除书名/作者与常见标签、
 * 书名号、分隔符、空白后基本没有其它内容。正文句子因含有大量其它文字不会误判。
 */
function looksLikeLegacyHeader(line: string, name: string, author: string): boolean {
  if (!line || line.length > 120) return false
  const hitName = !!name && line.includes(name)
  const hitAuthor = !!author && line.includes(author)
  if (!hitName && !hitAuthor) return false
  let rest = line
  if (name) rest = rest.split(name).join('')
  if (author) rest = rest.split(author).join('')
  rest = rest
    .replace(/(作者|著|书名|by|author|《|》|〈|〉|\[|\]|【|】|[:：\s\-—_=*·、,，。.（）()])/gi, '')
    .trim()
  return rest.length === 0
}

/**
 * 删除本地书原文件开头自带的、格式不一致的书名/作者行（如「五行元灵 作者：血友人生」）。
 * 只扫描开头有限行，避免触碰正文；简介行不含书名/作者，不会被删除。
 */
function stripLegacyHeaderLines(text: string, book: Book): string {
  const name = stripTitleMarks(cleanHtmlText(book.name)).trim()
  const author = stripTitleMarks(cleanHtmlText(book.author)).trim()
  const lines = text.split('\n')
  const HEAD_SCAN_LINES = 15
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i < HEAD_SCAN_LINES && looksLikeLegacyHeader(lines[i].trim(), name, author)) continue
    kept.push(lines[i])
  }
  return kept.join('\n').replace(/^\n+/, '')
}

/**
 * 全本导出为 TXT 到本地。
 *
 * - 本地 TXT 书：直接读取服务端保存的原始上传文件全文，正文逐字不改；仅在最前面
 *   加一段规范书头（书名/作者/简介），不切片、不改写正文、不插入章节标题。
 * - 网络书 / 本地 EPUB：逐章读取正文，按章节顺序拼接为完整文本，同样加规范书头。
 *
 * 文件名严格按规范生成：《书名》 作者：某某.txt（无作者为《书名》.txt）。
 */
export async function exportBookToLocal(params: {
  book: Book
  chapters?: BookChapter[]
  onProgress?: (progress: ExportProgress) => void
  signal?: { cancelled: boolean }
}): Promise<{ total: number; completed: number; fileName: string }> {
  const fileName = buildStorageFileName(params.book.name, params.book.author)

  // 本地 TXT：原文件原样导出，一次读取，无需逐章拼接；仅在顶部加规范书头
  if (isLocalTxtBook(params.book)) {
    const { text } = await exportLocalBookText(params.book.bookUrl)
    if (params.signal?.cancelled) return { total: 1, completed: 0, fileName: '' }
    const rawBody = text.replace(/\r\n?/g, '\n')
    // 书头将统一输出简介：仅当原文件【没有】自带简介时才放简介，避免重复
    const headHasIntro = originalTextHasIntro(rawBody)
    // 统一清洗：移除开头书头区的分隔线/广告/自带重复简介块（正文逐字不动）
    const cleaned = cleanExportedBody(rawBody, { dropHeadIntro: !headHasIntro })
    // 移除原文件开头格式不一致的书名/作者行（如「书名 作者：某某」），交由规范书头统一提供
    const body = stripLegacyHeaderLines(cleaned, params.book)
    const header = buildExportHeader(params.book, { includeIntro: !headHasIntro })
    downloadTextAsFile(`${header}\n\n${body}`, fileName)
    params.onProgress?.({ total: 1, completed: 1, chapterTitle: params.book.name })
    return { total: 1, completed: 1, fileName }
  }

  // 网络书 / 本地 EPUB：书头带简介（原文件无自带简介的概念，不影响使用）
  const header = buildExportHeader(params.book)

  // 网络书 / 本地 EPUB：逐章拉取正文拼接
  const chapters = params.chapters?.length ? params.chapters : await getChapterList({
    bookUrl: params.book.bookUrl,
    bookSourceUrl: params.book.origin,
  })

  const parts: string[] = []
  let completed = 0
  for (const chapter of chapters) {
    if (params.signal?.cancelled) break
    const content = await getBookContent({
      chapterUrl: chapter.url,
      bookSourceUrl: params.book.origin,
    })
    // 统一清洗网络书正文：去 HTML/双重转义，并移除开头书头区的分隔线、下载站广告、
    // 以及自带「内容介绍/简介」重复块（书头已输出简介）。正文主体逐字不动。
    const body = cleanExportedBody(content, { dropHeadIntro: true })
    // 每章前插入章节标题，避免导出后整本只看到一坨正文、分不清章节。
    // 若正文开头已自带同名标题则跳过插入，防止「第1章 xxx」出现两次。
    const rawTitle = cleanHtmlText(chapter.title || '').trim()
    if (rawTitle && !bodyStartsWithTitle(body, rawTitle)) {
      parts.push(rawTitle)
    }
    parts.push(body)
    completed += 1
    params.onProgress?.({ total: chapters.length, completed, chapterTitle: chapter.title })
  }

  if (params.signal?.cancelled) {
    return { total: chapters.length, completed, fileName: '' }
  }

  const text = `${header}\n\n${parts.join('\n\n')}`
  downloadTextAsFile(text, fileName)
  return { total: chapters.length, completed, fileName }
}

/** 用 Blob + a[download] 触发下载，延迟释放 objectURL 确保 WebView 完成读取。 */
export function downloadTextAsFile(text: string, fileName: string) {
  const blob = new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' })
  downloadBlobAsFile(blob, fileName)
}

/** 下载二进制文件（EPUB 等）。 */
export function downloadBytesAsFile(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/epub+zip' })
  downloadBlobAsFile(blob, fileName)
}

/**
 * 批量导出收集器：开启后 downloadBlobAsFile 只把 {文件名, blob} 入列、不落盘；
 * 全部导出完成后由 makeBatchDownloadItems 生成一组原生 <a download> 链接，
 * 让用户在清单里逐个【真实点击】下载。
 *
 * 原因：iOS Safari 对【程序化】连续下载有严格限制——系统下载框弹出会打断页面 JS 流程，
 * 靠 Promise 链/合成 a.click() 逐本下载只会成功第一个。改为真实链接用户点击后，
 * 每次点击都是独立用户手势，iOS 正常处理，且保留独立文件、无需解压。
 * 单本导出不开启收集器，行为完全不变。
 */
export interface BatchFile { fileName: string; blob: Blob }
/** 清单里的一条：文件名 + 可直接点击下载的 objectURL。 */
export interface BatchDownloadItem { fileName: string; url: string }
let batchFiles: BatchFile[] | null = null

/** 开启批量收集；期间的 download* 调用只入列。 */
export function beginBatchExport() {
  batchFiles = []
}

/** 异常兜底：关闭收集器并丢弃未下载文件（幂等）。 */
export function abortBatchExport() {
  batchFiles = null
}

/**
 * 取出当前收集到的文件（一本书可能多个，如漫画分卷）并清空缓冲，
 * 收集器保持开启，供下一本书继续入列。
 */
export function takeBatchFiles(): BatchFile[] {
  const files = batchFiles ?? []
  if (batchFiles) batchFiles = []
  return files
}

/** 为收集到的文件生成原生下载链接（用户逐个点击 <a download> 触发下载）。 */
export function makeBatchDownloadItems(files: BatchFile[]): BatchDownloadItem[] {
  return files.map((file) => ({ fileName: file.fileName, url: URL.createObjectURL(file.blob) }))
}

/** 关闭清单时释放 objectURL（延迟由调用方按场景决定）。 */
export function revokeBatchDownloadItems(items: BatchDownloadItem[]) {
  for (const item of items) URL.revokeObjectURL(item.url)
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = fileName
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

function downloadBlobAsFile(blob: Blob, fileName: string) {
  if (batchFiles) {
    batchFiles.push({ fileName, blob })
    return
  }
  triggerBlobDownload(blob, fileName)
}

export interface ComicExportResult {
  files: string[]
  failedImages: string[]
  totalImages: number
}

/**
 * 漫画 EPUB 导出：逐章拉取正文 → 打包为 EPUB → 下载。
 *
 * volumeSize=0：全本一个 EPUB；>0：按该章数切分为多个分卷 EPUB。
 * 图片下载失败时在 EPUB 内保留远程链接占位，并返回失败清单。
 */
export async function exportComicEpubToLocal(params: {
  book: Book
  chapters?: BookChapter[]
  volumeSize?: number
  onProgress?: (progress: ExportProgress) => void
  signal?: { cancelled: boolean }
  fetchImage?: (url: string) => Promise<Uint8Array>
}): Promise<ComicExportResult> {
  const chapters = params.chapters?.length ? params.chapters : await getChapterList({
    bookUrl: params.book.bookUrl,
    bookSourceUrl: params.book.origin,
  })
  const volumeSize = params.volumeSize && params.volumeSize > 0 ? params.volumeSize : 0

  // 先把所有章节正文抓下来（EPUB 打包需要一次性拿到全部图片）
  const comicChapters: ComicChapter[] = []
  let completed = 0
  for (const chapter of chapters) {
    if (params.signal?.cancelled) break
    const content = await getBookContent({
      chapterUrl: chapter.url,
      bookSourceUrl: params.book.origin,
    })
    comicChapters.push({ title: chapter.title, content })
    completed += 1
    params.onProgress?.({ total: chapters.length, completed, chapterTitle: chapter.title })
  }
  if (params.signal?.cancelled) return { files: [], failedImages: [], totalImages: 0 }

  // 按分卷切片
  const groups: ComicChapter[][] = []
  if (volumeSize > 0) {
    for (let i = 0; i < comicChapters.length; i += volumeSize) {
      groups.push(comicChapters.slice(i, i + volumeSize))
    }
  } else {
    groups.push(comicChapters)
  }

  const files: string[] = []
  const failedImages: string[] = []
  let totalImages = 0
  for (let gi = 0; gi < groups.length; gi++) {
    if (params.signal?.cancelled) break
    const suffix = groups.length > 1 ? ` 第${gi + 1}卷` : ''
    const fileName = buildEpubFileName(params.book.name, params.book.author, suffix)
    const result = await buildComicEpub({
      name: params.book.name,
      author: params.book.author,
      intro: params.book.intro,
      chapters: groups[gi],
      bookSourceUrl: params.book.origin,
      signal: params.signal,
      fetchImage: params.fetchImage,
    })
    if (params.signal?.cancelled || result.bytes.length === 0) break
    downloadBytesAsFile(result.bytes, fileName)
    files.push(fileName)
    failedImages.push(...result.failedImages)
    totalImages += result.totalImages
  }

  return { files, failedImages, totalImages }
}

/**
 * 静默导出单本书（自动分流小说 / 漫画），供书架批量导出复用。
 *
 * - 本地书（TXT/EPUB）：按原样导出 TXT（本地书正文不重写），不做漫画 EPUB 打包。
 * - 网络书：先抓章节列表与首章正文判断是否漫画；漫画走 EPUB 打包，小说走 TXT。
 *   预抓的章节与首章会复用给实际导出函数，避免重复请求。
 *
 * 返回导出的文件数量（小说=1，漫画可能分卷>1）；失败时抛错由调用方汇总。
 */
export async function exportOneBookSilently(book: Book): Promise<number> {
  if (isLocalBook(book)) {
    const result = await exportBookToLocal({ book })
    return result.completed > 0 ? 1 : 0
  }

  // 网络书：抓章节 + 首章判断是否漫画
  const chapters = await getChapterList({ bookUrl: book.bookUrl, bookSourceUrl: book.origin })
  if (!chapters.length) throw new Error('无章节')

  let firstContent = ''
  try {
    firstContent = await getBookContent({ chapterUrl: chapters[0].url, bookSourceUrl: book.origin })
  } catch {
    // 首章抓取失败不影响：按小说处理，导出函数内部会再抓一次
  }

  if (isComicContent(firstContent)) {
    const result = await exportComicEpubToLocal({ book, chapters })
    return result.files.length
  }

  const result = await exportBookToLocal({ book, chapters })
  return result.completed > 0 ? 1 : 0
}
