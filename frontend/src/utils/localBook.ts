import type { Book, SearchBook } from '../types'

type BookLike = Pick<Book | SearchBook, 'origin' | 'bookUrl'>

export function isLocalTxtBook(book?: BookLike | null) {
  if (!book) return false
  return book.origin?.trim() === 'local-txt' || book.bookUrl?.trim().startsWith('local-txt:')
}

export function isLocalEpubBook(book?: BookLike | null) {
  if (!book) return false
  return book.origin?.trim() === 'local-epub' || book.bookUrl?.trim().startsWith('local-epub:')
}

export function isLocalBook(book?: BookLike | null) {
  return isLocalTxtBook(book) || isLocalEpubBook(book)
}

const PLACEHOLDER_AUTHORS = new Set([
  '佚名',
  '未知',
  '未知作者',
  '不详',
  '本地导入',
  'unknown',
])

/**
 * 把任意本地 TXT 文件名格式化为后端唯一识别的规范格式：
 *   《书名》 作者：某某.txt  /  《书名》.txt（无作者或占位作者时）
 * 解析规则：
 *   - 书名优先取书名号《》/〈〉内的文字；书名号后允许版本说明等其它文字（会被丢弃）。
 *   - 无书名号时取「作者」标记前的主干，并去掉版本括号、站点方括号等噪音。
 *   - 作者取「作者」标记后「：/:」后的文字，占位值（佚名/未知等）视为无作者。
 * 前端负责全部格式化，后端只认这里的规范格式。
 */
export function normalizeLocalBookFileName(fileName: string): string {
  let stem = (fileName ?? '').trim().split(/[\\/]/).pop() ?? ''
  stem = stem.replace(/\.(txt|epub)$/i, '').trim()

  // 书名号优先定位书名（书名号内的文字即书名，其后的其它文字忽略）。
  const bracket = stem.match(/[《〈]([^《》〈〉]+)[》〉]/)
  const scope = bracket ? stem.slice((bracket.index ?? 0) + bracket[0].length) : stem

  // 作者：在书名号之后（或无书名号的整个主干）定位「作者」，取其后的「：/:」内容。
  let author = ''
  const authorPos = scope.indexOf('作者')
  if (authorPos >= 0) {
    let rest = scope.slice(authorPos + '作者'.length)
    rest = rest.replace(/^\s*[:：]\s*/, '').trimStart()
    const cut = rest.search(/[（(\[［【《〈]/)
    author = (cut >= 0 ? rest.slice(0, cut) : rest).trim()
    if (!author || PLACEHOLDER_AUTHORS.has(author.toLowerCase())) author = ''
  }

  // 书名：有书名号取号内文字；否则取作者标记前的主干并去噪。
  let name = ''
  if (bracket) {
    name = bracket[1].trim()
  } else {
    const namePart = authorPos >= 0 ? scope.slice(0, authorPos) : scope
    name = namePart
      .replace(/[（(\[［【][^)）\]］】]*[)）\]］】]?.*$/, '')
      .replace(/^\s*[\[［【][^\]］】]*[\]］】]\s*/, '')
      .trim()
  }
  if (!name) name = '本地小说'

  // 清理文件系统非法字符，与后端 build_storage_file_name 保持一致。
  const sanitize = (s: string) => s.replace(/[\\/:*?"<>|\r\n]/g, '_')
  name = sanitize(name)
  author = sanitize(author)

  return author ? `《${name}》 作者：${author}.txt` : `《${name}》.txt`
}

/**
 * 判断本地书名是否为「规范」文件名：以书名号包裹书名即视为规范，作者可选，冒号全/半角均可。
 * 规范形式（去扩展名后）：
 *   《书名》 / 《书名》 作者：某某 / 《书名》（版本说明） 作者：某某（书名号后允许其他文字）
 *   书名 / 书名 作者：某某
 * 无书名号且含版本括号、站点名、方括号等噪音的视为非规范。
 * 仅用于导入提示，不影响导入本身。
 */
export function isStandardLocalFileName(fileName: string): boolean {
  let stem = (fileName ?? '').trim().split(/[\\/]/).pop() ?? ''
  stem = stem.replace(/\.(txt|epub)$/i, '').trim()
  if (!stem) return false

  // 以书名号包裹书名即视为规范：其后允许版本说明等其他文字与可选作者。
  // 书名号内部允许任意非书名号字符（含副标题、冒号等）。
  if (/^《[^《》]+》/.test(stem)) return true

  // 无书名号：纯书名 或 书名 作者：某某（书名部分不含书名号/方括号/版本括号等噪音）
  const plain = /^[^《》〈〉\[\]【】()（）]+(?:\s+作者\s*[:：]\s*.+)?$/
  return plain.test(stem)
}

/** 从任意文件名解析出的本地书元数据，直接传给后端，后端无需再关心文件名规范。 */
export interface LocalBookMeta {
  name: string
  author: string // 空串表示无作者
  intro: string // 空串表示未解析到简介
  storedFileName: string // 前端生成的规范存储文件名：《书名》 作者：某某.txt
}

/**
 * 前端从文件名或正文头部过滤出书名、作者、简介并生成规范存储文件名，随上传一并传给后端。
 * 解析优先级（核心原则）：
 *   - 文件名规范（书名号包裹或纯书名）→ 书名/作者以文件名为准。
 *   - 文件名不规范（噪名，如 boot.txt / [站点]xxx 等）→ 书名/作者以正文头部为准。
 *   - 简介始终从正文头部解析（文件名不含简介）。
 * 后端只接收这些值、按值入库，不解析文件名、不生成存储名，从而在前端完成全部格式化。
 */
export function parseLocalBookMeta(fileName: string, headText = ''): LocalBookMeta {
  const fileMeta = parseNameAuthorFromFileName(fileName)
  const strongFileName = hasStrongFileNameMeta(fileName)
  const headerMeta = parseNameAuthorFromText(headText)

  // 强规范文件名（带书名号或作者标签）以文件名为准，正文仅补齐缺失字段；
  // 弱文件名（如 boot.txt / 纯书名）在正文头部有明确书名时以正文为准，否则回退文件名。
  const name = strongFileName
    ? (fileMeta.name || headerMeta.name || '本地小说')
    : (headerMeta.name || fileMeta.name || '本地小说')
  const author = strongFileName
    ? (fileMeta.author || headerMeta.author)
    : (headerMeta.author || fileMeta.author)

  const intro = parseIntroFromText(headText)
  const storedFileName = buildStorageFileName(name, author)
  return { name, author, intro, storedFileName }
}

/**
 * 判断文件名是否携带「强元数据」：带书名号，或带有效「作者：某某」标签。
 * 这类文件名明确表达了书名/作者，优先于正文头部；
 * 光秃书名（含 boot.txt 这类噪名）视为弱文件名，正文有明确书名时以正文为准。
 */
function hasStrongFileNameMeta(fileName: string): boolean {
  let stem = (fileName ?? '').trim().split(/[\\/]/).pop() ?? ''
  stem = stem.replace(/\.(txt|epub)$/i, '').trim()
  if (/[《〈][^》〉]+[》〉]/.test(stem)) return true
  return !!parseNameAuthorFromFileName(fileName).author
}

/**
 * 从正文头部解析书名与作者（文件名不规范时的回退来源）。
 * 识别「书名/名称/标题：」「作者：」标签及单独的《书名》行，遇空行/章节标题/正文即停止。
 */
export function parseNameAuthorFromText(raw: string): { name: string; author: string } {
  const text = (raw || '').slice(0, 4000)
  let name = ''
  let author = ''
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) {
      if (name || author) break
      continue
    }
    // 书名号包裹的独立行即书名
    if (!name) {
      const b = t.match(/^[《〈]([^》〉]+)[》〉]/)
      if (b) {
        name = b[1].trim()
        continue
      }
    }
    const m = t.match(/^(书名|名称|标题|author|title)\s*[:：]\s*(.+)$/i)
    if (m) {
      if (!name) name = m[2].trim()
      continue
    }
    const a = t.match(/^(作者|author)\s*[:：]\s*(.+)$/i)
    if (a) {
      if (!author) author = a[2].trim()
      continue
    }
    // 已拿到所需字段，或遇到章节标题/其它正文行，停止扫描
    if ((name && author) || /^(第.+[章节回卷部篇]|序章|序言|楔子|引子|前言|chapter\s*\d+)/i.test(t)) {
      break
    }
  }
  const sanitize = (s: string) => s.replace(/[\\/:*?"<>|\r\n]/g, '_')
  return {
    name: name ? sanitize(name) : '',
    author: author && !PLACEHOLDER_AUTHORS.has(author.toLowerCase()) ? sanitize(author) : '',
  }
}

/**
 * 剥离字符串外层成对包裹符（书名号/引号等），反复剥离以支持《《书名》》这种多层包裹。
 * 用于导出前规范化书名/作者：书源或本地文件名常自带书名号，若不加处理再包一层
 * 就会变成《《书名》》；作者名同样不应带书名号。仅剥离首尾成对的符号，不误伤正文中作为内容的书名号。
 */
export function stripTitleMarks(value: string): string {
  let s = (value ?? '').trim()
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['《', '》'], ['〈', '〉'], ['「', '」'], ['『', '』'],
    ['“', '”'], ['"', '"'], ["'", "'"], ['【', '】'], ['[', ']'],
  ]
  let changed = true
  while (changed) {
    changed = false
    for (const [open, close] of pairs) {
      if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length) {
        s = s.slice(open.length, s.length - close.length).trim()
        changed = true
      }
    }
  }
  return s
}

/** 前端生成规范存储文件名：《书名》 作者：某某.txt（无作者为《书名》.txt）。 */
/**
 * 剥离作者字段自带的「作者：/作者:/author:」标签，反复剥离以支持「作者：作者：某某」。
 * 书源元数据与文件名解析偶尔会把标签带进 author 值，导出书头统一「作者：${author}」
 * 时若不清洗就会出现「作者：作者：某某」。
 */
export function stripAuthorLabel(value: string): string {
  let s = (value ?? '').trim()
  const re = /^\s*(?:作者|author)\s*[:：]\s*/i
  while (re.test(s)) s = s.replace(re, '').trim()
  return s
}

export function buildStorageFileName(name: string, author: string): string {
  const sanitize = (s: string) => stripTitleMarks(s).trim().replace(/[\\/:*?"<>|\r\n]/g, '_')
  const n = sanitize(name) || '本地小说'
  const a = sanitize(stripAuthorLabel(author))
  return a ? `《${n}》 作者：${a}.txt` : `《${n}》.txt`
}

/**
 * 视频下载文件名：书名_章节标题.ext（如「皇明_第1集.mp4」），避免只显示序号 1.mp4。
 * 清洗规则与导出文件名一致（去书名号/非法字符/首尾点），任一为空时退化为另一个，
 * 都为空时用 video。扩展名仅接受 2-5 位字母数字，异常时回退 mp4。
 */
export function buildVideoFileName(bookName: string, chapterTitle: string, ext: string): string {
  const clean = (s: string) =>
    stripTitleMarks(s || '')
      .trim()
      .replace(/[\\/:*?"<>|\s]/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .replace(/_+/g, '_')
      .slice(0, 40)
  const b = clean(bookName)
  const c = clean(chapterTitle)
  // 章节标题已含书名（如「皇明 第1集」）时直接用章节名（信息更全），避免「皇明_皇明」重复前缀
  let base: string
  if (!b || !c || b === c) base = b || c || 'video'
  else if (c.includes(b)) base = c
  else if (b.includes(c)) base = b
  else base = `${b}_${c}`
  const safeExt = /^[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : 'mp4'
  return `${base.slice(0, 48)}.${safeExt}`
}

/** 漫画 EPUB 导出文件名，规范与 TXT 一致，仅扩展名不同。 */
export function buildEpubFileName(name: string, author: string, volumeSuffix = ''): string {
  const sanitize = (s: string) => stripTitleMarks(s).trim().replace(/[\\/:*?"<>|\r\n]/g, '_')
  const n = sanitize(name) || '本地小说'
  const a = sanitize(stripAuthorLabel(author))
  const base = a ? `《${n}》 作者：${a}` : `《${n}》`
  return `${base}${volumeSuffix}.epub`
}

/** 从文件名解析书名与作者（复用规范化的同一套规则）。 */
export function parseNameAuthorFromFileName(fileName: string): { name: string; author: string } {
  let stem = (fileName ?? '').trim().split(/[\\/]/).pop() ?? ''
  stem = stem.replace(/\.(txt|epub)$/i, '').trim()

  const bracket = stem.match(/[《〈]([^《》〈〉]+)[》〉]/)
  const scope = bracket ? stem.slice((bracket.index ?? 0) + bracket[0].length) : stem

  let author = ''
  const authorPos = scope.indexOf('作者')
  if (authorPos >= 0) {
    let rest = scope.slice(authorPos + '作者'.length)
    rest = rest.replace(/^\s*[:：]\s*/, '').trimStart()
    const cut = rest.search(/[（(\[［【《〈]/)
    author = (cut >= 0 ? rest.slice(0, cut) : rest).trim()
    if (!author || PLACEHOLDER_AUTHORS.has(author.toLowerCase())) author = ''
  }

  let name = ''
  if (bracket) {
    name = bracket[1].trim()
  } else {
    const namePart = authorPos >= 0 ? scope.slice(0, authorPos) : scope
    name = namePart
      .replace(/[（(\[［【][^)）\]］】]*[)）\]］】]?.*$/, '')
      .replace(/^\s*[\[［【][^\]］】]*[\]］】]\s*/, '')
      .trim()
  }
  if (!name) name = '本地小说'

  const sanitize = (s: string) => s.replace(/[\\/:*?"<>|\r\n]/g, '_')
  return { name: sanitize(name), author: sanitize(author) }
}

/**
 * 读取本地 TXT 文件头部文本用于解析简介，兼容 UTF-8 与 GBK：
 * 先按 UTF-8 解码，替换字符占比过高则改用 GBK。失败时回退 UTF-8，绝不影响导入。
 */
export async function readTextHead(file: File, byteCount = 8000): Promise<string> {
  try {
    const buf = await file.slice(0, byteCount).arrayBuffer()
    const utf8 = new TextDecoder('utf-8').decode(buf)
    const replacementRatio = (utf8.match(/\uFFFD/g) || []).length / Math.max(1, utf8.length)
    if (replacementRatio > 0.01) {
      try {
        return new TextDecoder('gbk').decode(buf)
      } catch {
        return utf8
      }
    }
    return utf8
  } catch {
    return ''
  }
}

/** 从文本开头解析简介（标签：简介/内容简介/内容介绍；跨行收集，遇空行或章节标题停止）。 */
export function parseIntroFromText(raw: string): string {
  const text = (raw || '').slice(0, 4000)
  const lines: string[] = []
  let collecting = false
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) {
      if (collecting) break
      continue
    }
    const m = t.match(/^(简介|内容简介|内容介绍|摘要|intro|introduction)\s*[:：]\s*(.*)$/i)
    if (m) {
      collecting = true
      if (m[2]?.trim()) lines.push(m[2].trim())
      continue
    }
    if (/^(书名|名称|标题|作者|类别|字数|状态|author|title)\s*[:：]/i.test(t)) {
      collecting = false
      continue
    }
    if (collecting) {
      // 章节标题视为正文开始，停止收集
      if (/^(第.+[章节回卷部篇]|序章|序言|楔子|引子|前言|chapter\s*\d+)/i.test(t)) break
      lines.push(t)
    } else {
      // 尚未进入简介：跳过书名号行等头部噪音，避免因《书名》行过早停止而错过后面的简介标签。
      if (/^[《〈][^》〉]+[》〉]/.test(t)) continue
      break
    }
  }
  return lines.join('\n').slice(0, 600)
}
