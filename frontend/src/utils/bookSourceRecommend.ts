import type { SearchBook } from '../types'

/**
 * 书源推荐共享判断标准。
 * 「切换书源推荐」与「本地书封面匹配」复用同一套规则，避免两处标准不一致：
 *   1. 严格匹配：书名 + 作者（归一化后）都相等才算命中；
 *   2. 有效封面：非空且非占位图 URL；
 *   3. 字数可信：剔除「432 章却标 17K」这类书源明显写错的数据。
 */

/** 封面 URL 黑名单：命中即视为占位/缺省图，不可用。 */
const COVER_URL_BLOCKLIST = [
  'nocover', 'no_cover', 'no-cover', 'blank', 'default', 'nopic', 'no_pic',
  'logo', 'loading', 'placeholder', 'tmp', 'temp', 'def_cover', 'book_default',
  'defaultbook', 'default.jpg', 'default.png', 'nobook', 'nullpic',
  '暂无封面', '暂无', 'noimage', 'no-image', 'cover_default', 'emptycover',
]

/** 是否为有效封面（非空 + 非占位图）。 */
export function hasEffectiveCover(url?: string | null): boolean {
  const u = (url ?? '').trim().toLowerCase()
  if (!u) return false
  return !COVER_URL_BLOCKLIST.some((token) => u.includes(token))
}

/**
 * 把书源的字数文本解析成统一的「字」数值，供排序打分使用。
 * 支持「7474K / 355万字 / 23K / 1.2M / 8000 / 3亿」等写法。
 * 无法解析返回 0。解析结果与展示原文无关，仅用于内部比较。
 */
export function parseWordCountToNumber(wordCount?: string): number {
  const raw = (wordCount ?? '').trim()
  if (!raw) return 0
  const m = raw.match(/([\d.]+)\s*([千万亿kKmMwW]?)/)
  if (!m) return 0
  const num = parseFloat(m[1])
  if (!Number.isFinite(num) || num < 0) return 0
  const unit = m[2].toLowerCase()
  let words = num
  if (unit === 'k') words = num * 1e3
  else if (unit === 'm' || unit === 'w') words = num * 1e4
  else if (unit === '万') words = num * 1e4
  else if (unit === '千万') words = num * 1e7
  else if (unit === '亿') words = num * 1e8
  return Math.round(words)
}

/**
 * 字数是否可信。书源常返回明显错误的值（图例：1015 章的书标「23K」= 每章 22 字）。
 * 用「折算每章字数」判断上下界：太低（<150 字/章）或太高（>3 万字/章）都不可信，
 * 展示与评分时都不采信，避免异常值干扰「字数多者优先」的排序。
 */
export function isPlausibleWordCount(wordCount?: string, chapterCount?: number): boolean {
  const raw = (wordCount ?? '').trim()
  if (!raw) return false
  const words = parseWordCountToNumber(raw)
  // 无法解析（如「约三百万字」中文数字）时保守保留，不因解析不了而误杀大体量书。
  if (!words) return true
  if (!chapterCount || chapterCount <= 0) return true // 无章数无法折算，保守保留
  const perChapter = words / chapterCount
  // 每章 150 字以下几乎必然是书源写错；3 万字以上多为把总章数/字数单位填错
  if (perChapter < 150 || perChapter > 30000) return false
  return true
}

/**
 * 封面归一化标识：用于判断「同一批书源里哪些封面是同一张」。
 * 只保留 host + 路径主体，去掉协议、查询串、片段与末尾扩展名差异，
 * 因为同一封面在不同书源常被拼接不同 CDN 参数。无法识别时返回空串。
 */
export function coverFingerprint(url?: string | null): string {
  const u = (url ?? '').trim()
  if (!hasEffectiveCover(u)) return ''
  try {
    const parsed = new URL(u, 'http://placeholder.local')
    const host = parsed.hostname.replace(/^www\./, '')
    // 路径去掉扩展名与纯数字/十六进制长串差异前的部分，保留足够辨识度
    const path = parsed.pathname.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/\/{2,}/g, '/')
    return `${host}${path}`.toLowerCase()
  } catch {
    return u.split('?')[0].replace(/^https?:\/\//i, '').toLowerCase()
  }
}

/** 书名/作者归一化：去空白、常见标点书名号、小写，并去掉「作者」标签。 */
export function normalizeRecommendText(value?: string): string {
  return (value ?? '')
    .replace(/\s+/g, '')
    .replace(/[：:,.，。！？!?\-—_()（）【】\[\]<>《》'"“”‘’]/g, '')
    .toLowerCase()
}

export function normalizeRecommendAuthor(value?: string): string {
  return normalizeRecommendText(value).replace(/^作者/, '')
}

/**
 * 严格匹配判断：书名与作者（归一化后）都相等。
 * 目标作者为空/占位时只要求书名严格相等（无法用作者进一步锁定）。
 */
export function strictMatchNameAuthor(
  book: SearchBook,
  targetName: string,
  targetAuthor?: string,
): { name: boolean; author: boolean; both: boolean } {
  const name = normalizeRecommendText(book.name) === normalizeRecommendText(targetName)
  const ta = normalizeRecommendAuthor(targetAuthor)
  const author = !ta || normalizeRecommendAuthor(book.author) === ta
  return { name, author, both: name && author }
}
