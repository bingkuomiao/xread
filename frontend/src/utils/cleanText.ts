/**
 * 书源返回的短文本字段（作者/书名/分类等）常混入 HTML 标签与实体，
 * 例如无限小说把「作者+字数+时间」连同字体图标标签塞进 author：
 *   <p><i class="fa fa-user-circle-o">&nbsp;佚名&nbsp;&nbsp; class="s_gray">460 万字&nbsp;&nbsp;3个月前</span></p>
 * 直接插值会把标签当纯文本显示。本工具把任意此类文本清洗为可读纯文本。
 *
 * 处理顺序：还原字面量转义 → 块级标签转换行/空格 → 去标签 →
 *          解码 HTML 实体 → 压缩空白。
 */

const BLOCK_TAGS = 'p|div|li|h[1-6]|tr|section|article|ul|ol|table|blockquote'

/** 常见 HTML 实体解码表（含常用中文场景） */
const ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&middot;': '·',
  '&ldquo;': '“',
  '&rdquo;': '”',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(nbsp|amp|lt|gt|quot|apos|mdash|ndash|hellip|middot|ldquo|rdquo);/gi, m => ENTITY_MAP[m.toLowerCase()] ?? m)
    // 数字实体：&#39; / &#x4F60;
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
}

export interface CleanTextOptions {
  /** 块级标签与 <br> 是否保留为换行；短字段（作者/书名）用 false，长文本（简介）用 true */
  lineBreaks?: boolean
}

/**
 * 把可能含 HTML 的字段清洗成可读纯文本。
 * @param value 原始文本（可为空）
 * @param options.lineBreaks true 时块级标签转换行，false（默认）转空格
 */
export function cleanHtmlText(value: string | null | undefined, options: CleanTextOptions = {}): string {
  if (!value) return ''
  const { lineBreaks = false } = options
  const sep = lineBreaks ? '\n' : ' '

  let text = String(value)
    // 还原书源里常见的字面量转义序列（\n / \r / \t）
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n|\\r/g, '\n')
    .replace(/\\t/g, ' ')
    // <br> 与块级闭合标签 → 换行或空格（开标签直接去掉，避免多出空行）
    .replace(/<br\s*\/?>/gi, sep)
    .replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi'), sep)
    .replace(new RegExp(`<(?:${BLOCK_TAGS})(\\s[^>]*)?>`, 'gi'), '')
    // 去掉其余所有标签
    .replace(/<[^>]*>/g, '')
    // 清掉书源拼接错误留下的残缺属性片段（如 class="s_gray"> 丢了 <span ）
    .replace(/[a-zA-Z-]+\s*=\s*["'][^"']*["']\s*>/g, ' ')

  text = decodeEntities(text)

  return text
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 需要清洗的书籍展示类文本字段。
 * 只清洗会被显示给用户看的文本，不碰 bookUrl/origin/coverUrl/tocUrl 等 URL 或标识字段
 * （URL 可能含合法查询串 &amp;，且参与匹配与请求，清洗会引入错误）。
 */
const BOOK_TEXT_FIELDS = [
  'name', 'author', 'intro', 'kind', 'originName', 'originGroup',
  'lastChapter', 'durChapterTitle', 'latestChapterTitle',
  'wordCount', 'updateTime', 'rssPubDate', 'rssLink',
] as const

/**
 * 统一清洗一本书的所有展示文本字段（数据入口调用一次，下游全链路拿到干净数据）。
 * 用泛型 T 保持调用处的具体类型（Book / SearchBook / RecentReadBook 等）不变，
 * 不引入 Partial 或索引签名，避免破坏 book.name: string 等必填字段的类型。
 * 不修改原对象，返回浅拷贝；保留所有非文本字段原样。
 */
export function sanitizeBook<T extends object>(book: T): T {
  if (!book || typeof book !== 'object') return book
  const out = { ...book } as Record<string, unknown>
  for (const field of BOOK_TEXT_FIELDS) {
    const value = out[field]
    if (typeof value === 'string') {
      out[field] = cleanHtmlText(value, { lineBreaks: field === 'intro' })
    }
  }
  return out as T
}

/** 批量清洗书籍列表 */
export function sanitizeBooks<T extends object>(books: T[] | null | undefined): T[] {
  if (!Array.isArray(books)) return []
  return books.map((book) => sanitizeBook(book))
}
