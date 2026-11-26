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

/** 解码字面量 \uXXXX 转义（统一接口部分书源会原样返回带 unicode 转义的文本） */
function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
    const code = parseInt(hex, 16)
    return Number.isFinite(code) ? String.fromCodePoint(code) : _
  })
}

/** 从对象/数组节点中挑一个可读名称（name/title/chapterName 等） */
function pickReadableName(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['name', 'title', 'chapterName', 'chapter_name']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return ''
}

/** 章节类字段：遇到章节列表 JSON 时提取最后一章章名；其他字段（如简介）视为机器数据隐藏 */
const CHAPTER_LIST_FIELDS = new Set(['lastChapter', 'latestChapterTitle', 'durChapterTitle'])

/**
 * 拦截统一接口书源塞进展示字段的 JSON 机器数据，形如：
 *   {"chapter_list":[{"id":38713,"name":"\u7b2c1\u8bdd"},...]}
 * - 章节类字段（lastChapter/latestChapterTitle/durChapterTitle）→ 提取最后一章章名；
 * - 其他字段（intro 等）→ 机器数据对用户无意义，返回空串隐藏；
 * - 非 JSON 文本返回 null，走常规清洗流程。
 */
function extractFromJsonPayload(raw: string, field?: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null

  // 明确的章节列表 JSON 标记（解析失败时用于判定是否机器数据）
  const hasChapterListMarker = /"chapter_list"\s*:/.test(trimmed)

  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return hasChapterListMarker ? '' : null
  }

  // 深度收集可读名称（兼容 chapter_list 顶层数组、嵌套在 data/list 等结构下的情况）
  const names: string[] = []
  const collect = (node: unknown, depth = 0): void => {
    if (depth > 4 || names.length > 5000) return
    if (Array.isArray(node)) {
      node.forEach((item) => collect(item, depth + 1))
      return
    }
    if (node && typeof node === 'object') {
      const name = pickReadableName(node)
      if (name) {
        names.push(name)
        return
      }
      Object.values(node as Record<string, unknown>).forEach((v) => collect(v, depth + 1))
    }
  }
  collect(data)

  if (names.length) {
    const target = CHAPTER_LIST_FIELDS.has(field || '') ? names[names.length - 1] : ''
    return target ? decodeUnicodeEscapes(target) : ''
  }
  if (hasChapterListMarker) return ''
  const fallback = pickReadableName(data)
  return fallback ? decodeUnicodeEscapes(fallback) : ''
}

export interface CleanTextOptions {
  /** 块级标签与 <br> 是否保留为换行；短字段（作者/书名）用 false，长文本（简介）用 true */
  lineBreaks?: boolean
  /** 字段名：章节类字段（lastChapter/latestChapterTitle/durChapterTitle）遇到章节列表 JSON 时提取最后一章名 */
  field?: string
}

/**
 * 把可能含 HTML 的字段清洗成可读纯文本。
 * @param value 原始文本（可为空）
 * @param options.lineBreaks true 时块级标签转换行，false（默认）转空格
 */
export function cleanHtmlText(value: string | null | undefined, options: CleanTextOptions = {}): string {
  if (!value) return ''
  const { lineBreaks = false, field } = options

  // 0) 章节列表 JSON / 机器数据拦截（置于最前，原始值判定更可靠）
  const jsonText = extractFromJsonPayload(String(value), field)
  if (jsonText !== null) {
    // 章节类字段提取到的章名可能仍含 HTML 残片，递归走一遍常规清洗
    return jsonText ? cleanHtmlText(jsonText, { lineBreaks }) : ''
  }
  const sep = lineBreaks ? '\n' : ' '

  let text = String(value)
    // 还原书源里常见的字面量转义序列（\n / \r / \t / \uXXXX）
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n|\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
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
      out[field] = cleanHtmlText(value, { lineBreaks: field === 'intro', field })
    }
  }
  return out as T
}

/** 批量清洗书籍列表 */
export function sanitizeBooks<T extends object>(books: T[] | null | undefined): T[] {
  if (!Array.isArray(books)) return []
  return books.map((book) => sanitizeBook(book))
}

/* ────────────────────────────────────────────────────────────
 * 导出正文统一清洗接口
 *
 * 书源正文 / 本地 TXT 原文件常自带「书头垃圾」：分隔线（====）、
 * 下载站广告（更多精校小说尽在 xxx 下载 / http://www.xxx.com）、
 * 以及自带的「内容介绍 / 简介 / 内容简介」段落。导出书头已统一输出
 * 书名/作者/简介，若正文里再留一份就会重复（见用户附图：书头有
 * 「简介：」但正文紧跟着又是一段「内容介绍」）。
 *
 * 这里提供一个统一入口，本地书与网络书导出都走它。清洗只作用于
 * 开头书头扫描区（前 40 行），真正的正文逐字不动，符合「正文不重写」。
 * ──────────────────────────────────────────────────────────── */

/** 纯分隔线：整行由 = - — _ * ~ 等重复符号组成（可含空格） */
function isDividerLine(line: string): boolean {
  const t = line.replace(/[\s\u00a0]/g, '')
  return t.length >= 4 && /^[=＝\-—_～~＊*=*]+$/.test(t)
}

/** 下载站广告 / 站务推广行 */
function isPromoLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  // 明确的下载站广告特征
  if (/(更多.{0,8}(小说|精校|电子书).{0,6}下载|精校小说|请收藏|请记住|最新网址|手机阅读|\n?欢迎访问|_txt|全集下载|免费下载|尽在.{0,20}(下载|阅读)|http:\/\/|https:\/\/|www\.[^\s]+\.(com|cn|net|org|cc|top))/i.test(t)) {
    return true
  }
  return false
}

/**
 * 正文自带的「简介」标题行：独占一行（可带空冒号），按用户要求直接去掉这几个字所在的整行。
 * 例如「内容简介」「简介:」「introduction」→ 整行丢弃。
 */
function introHeadingMatch(line: string): boolean {
  return /^\s*(?:内容介绍|内容简介|内容提要|简要介绍|简介|introduction)\s*[:：]?\s*$/i.test(line)
}

/**
 * 标题 + 冒号 + 同行内容的行（如「内容简介：早知道要穿越…」）：
 * 只去掉「内容简介：」这几个字，保留其后的正文内容，避免误删真正的正文。
 * 返回值与原行相同表示不是这种结构。
 */
function stripInlineIntroHeading(line: string): string {
  const m = line.match(/^\s*(?:内容介绍|内容简介|内容提要|简要介绍|简介|introduction)\s*[:：]\s*(.*)$/i)
  if (!m) return line
  // 冒号后无内容（如「内容简介：」）交给 introHeadingMatch 整块处理；仅同行有正文时才去前缀。
  if (!m[1].trim()) return line
  return m[1].trim()
}

/**
 * 统一清洗导出正文：去 HTML、去双重转义、去开头书头区的分隔线/广告/重复简介块。
 *
 * @param raw 章节正文 / 本地书原文（可能含 HTML）
 * @param options.dropHeadIntro true=书头已输出简介，移除正文开头自带的「内容介绍」块
 */
export function cleanExportedBody(
  raw: string | null | undefined,
  options: { dropHeadIntro?: boolean } = {},
): string {
  if (!raw) return ''
  const { dropHeadIntro = true } = options

  // 1) HTML → 纯文本 + 双重转义二次解码（最多两轮）
  let text = cleanHtmlText(raw, { lineBreaks: true })
  if (/&(?:lt|gt|amp|nbsp|#\d|#x)/i.test(text) || /<[a-z][^>]*>/i.test(text)) {
    text = cleanHtmlText(text, { lineBreaks: true })
  }
  text = text.replace(/\r\n?/g, '\n')

  const lines = text.split('\n')
  const HEAD_SCAN = 40 // 只清洗开头书头区，正文不动
  const kept: string[] = []
  let skippingIntro = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (i < HEAD_SCAN) {
      // 广告行、分隔线：直接丢弃
      if (isPromoLine(line) || isDividerLine(line)) continue

      // 「内容简介：正文…」标题与正文同行：只去掉标题这几个字，保留正文。
      // 用户要求「直接去掉原有的几个字」——不能把同行正文整行吞掉。
      if (dropHeadIntro && !skippingIntro) {
        const stripped = stripInlineIntroHeading(line)
        if (stripped !== line) {
          kept.push(stripped)
          continue
        }
      }

      // 独占一行的「简介 / 内容简介」标题：连同其后的简介文字块一起去掉，
      // 直到空行/章节标题/正文标志。保留原有整块去除能力（书头已输出规范简介）。
      if (dropHeadIntro && introHeadingMatch(line)) {
        skippingIntro = true
        continue
      }
      if (skippingIntro) {
        const t = line.trim()
        if (!t) {
          // 简介块结束于空行：保留一个空行后恢复
          skippingIntro = false
          kept.push('')
          continue
        }
        if (isPromoLine(t) || isDividerLine(t)) continue
        // 遇到章节标题/正文标志则恢复，绝不吞正文
        if (/^第[一二三四五六七八九十百千万\d]+[章节回卷部篇集]/.test(t) || /^[（(]?正文[）)]?/.test(t)) {
          skippingIntro = false
          kept.push(line)
          continue
        }
        continue // 丢弃简介文字行
      }
    }

    kept.push(line)
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trim()
}
