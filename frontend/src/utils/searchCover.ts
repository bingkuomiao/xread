import { stripTitleMarks } from './localBook'

/** 规范化书名用于同书分组：剥离书名号、去所有空白、忽略大小写。 */
function normalizeName(name: string): string {
  return stripTitleMarks((name ?? '').trim()).replace(/\s+/g, '').toLowerCase()
}

/** 判断封面 URL 是否可用（过滤空值、data URL、过短的无效值）。 */
function isValidCover(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const u = url.trim()
  if (!u || u.length < 8) return false
  if (/^data:/i.test(u)) return false
  return true
}

/**
 * 统一搜索结果中同一本书的封面。
 *
 * 背景：多书源搜索时，同一本书会返回多条结果，各书源封面质量参差不齐——
 * 有的没返回封面（显示文字占位），有的抓错图（封面串成别的书），有的正确。
 * 这些结果已按相关性排序，精确匹配、质量高的书源排在前。
 *
 * 策略：以规范化书名为键分组，取组内第一个有效封面作为该书代表封面，
 * 补给缺封面的条目，并覆盖明显串图的错误封面，使同一本书在结果里封面一致。
 * 纯前端处理，不请求网络、不改后端。
 */
export function unifySearchCovers<T extends { name: string; coverUrl?: string }>(books: T[]): T[] {
  const representative = new Map<string, string>()
  for (const book of books) {
    const key = normalizeName(book.name)
    if (!key || representative.has(key)) continue
    if (isValidCover(book.coverUrl)) representative.set(key, book.coverUrl!.trim())
  }
  if (representative.size === 0) return books
  return books.map((book) => {
    const cover = representative.get(normalizeName(book.name))
    if (!cover || book.coverUrl === cover) return book
    return { ...book, coverUrl: cover }
  })
}
