import type { SearchBook } from '../types'
import { stripAuthorLabel } from './localBook'
import { coverFingerprint, hasEffectiveCover, strictMatchNameAuthor } from './bookSourceRecommend'

/**
 * 本地书元数据匹配（前端完成，后端只按值写回）。
 *
 * 从多书源搜索结果里挑出与目标书最匹配的一本，产出：书名/作者/简介/封面 URL。
 * 与「切换书源推荐」复用同一套共享判断（bookSourceRecommend）：
 *   1. 严格匹配优先：书名 + 作者都严格相等（归一化后）的候选优先于仅模糊相关者；
 *   2. 有封面优先：严格匹配池中优先取有有效封面的，封面情况一致时按排序靠前者；
 *   3. 宽松兜底：完全没有严格候选时退回「精确 > 包含 > 前缀」相关性匹配，避免漏匹配。
 * 封面有效性用共享 URL 黑名单判断，真正的下载缓存由展示链路首次请求时完成。
 */

const PLACEHOLDER_AUTHORS = new Set(['佚名', '未知', '未知作者', '不详', '本地导入', 'unknown'])

function normalize(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

export function isPlaceholderAuthor(author?: string): boolean {
  const a = (author ?? '').trim()
  return !a || PLACEHOLDER_AUTHORS.has(a.toLowerCase())
}

/** 匹配分：3 精确相等 / 2 互相包含 / 1 前缀包含 / 0 不匹配。 */
export function nameMatchScore(candidate: string, target: string): number {
  const c = normalize(candidate)
  const t = normalize(target)
  if (!c || !t) return 0
  if (c === t) return 3
  if (c.length >= 2 && t.length >= 2 && (c.includes(t) || t.includes(c))) return 2
  // 前缀兜底：候选或目标以对方开头
  if (t.length >= 2 && (c.startsWith(t.slice(0, 4)) || t.startsWith(c.slice(0, 4)))) return 1
  return 0
}

/** 相关性评分（与 SearchResults 排序语义对齐）：精确 > 前缀 > 包含 > 作者匹配。 */
export function relevanceScore(book: SearchBook, keyword: string): number {
  const name = (book.name ?? '').trim().toLowerCase()
  const author = (book.author ?? '').trim().toLowerCase()
  const kw = keyword.trim().toLowerCase()
  let score = 0
  if (name === kw) score = 100
  else if (name.startsWith(kw)) score = 80
  else if (name.includes(kw)) score = 60
  else if (author === kw) score = 55
  else if (author.includes(kw)) score = 50
  else score = nameMatchScore(book.name, keyword) * 10
  if (score > 0) score += Math.max(0, 5 - Math.floor((book.name ?? '').length / 4))
  return score
}

export interface LocalBookMatchResult {
  coverUrl?: string
  intro?: string
  author?: string
}

/**
 * 共识封面：在同一批候选里按封面指纹统计票数，取出现次数最多的那张封面。
 * 用途：本地书补封面时，多个书源指向同一本书往往会返回同一张封面，
 * 这张「多数派」封面最可信；个别书源串图/错图（各 1 票）自然被淹没。
 * 平票时取在候选中出现更早（排序更靠前）的那张。
 */
export function pickConsensusCover(books: SearchBook[]): string {
  interface Group { count: number; url: string; firstIndex: number }
  const groups = new Map<string, Group>()
  books.forEach((b, idx) => {
    if (!hasEffectiveCover(b.coverUrl)) return
    const fp = coverFingerprint(b.coverUrl)
    if (!fp) return
    const g = groups.get(fp)
    if (g) g.count += 1
    else groups.set(fp, { count: 1, url: b.coverUrl!.trim(), firstIndex: idx })
  })
  let best: Group | null = null
  for (const g of groups.values()) {
    if (!best || g.count > best.count || (g.count === best.count && g.firstIndex < best.firstIndex)) {
      best = g
    }
  }
  return best ? best.url : ''
}

/**
 * 从搜索候选中挑出最优匹配，返回可用的封面 URL / 简介 / 作者。
 * @param candidates 多书源聚合搜索结果
 * @param targetName 目标书名
 * @param knownAuthor 已知作者（真实作者时用于锁定同名书；占位值则忽略）
 */
export function pickBestMetadata(
  candidates: SearchBook[],
  targetName: string,
  knownAuthor?: string,
): LocalBookMatchResult {
  if (!candidates.length || !targetName.trim()) return {}

  const hasRealAuthor = !isPlaceholderAuthor(knownAuthor)

  // 1. 严格匹配池（复用切换书源推荐的标准）：书名严格相等，作者已知真实时也须严格相等。
  //    作者为占位值（如「本地导入」）时无法用作者锁定，仅要求书名严格相等。
  const strictPool = candidates.filter((b) =>
    strictMatchNameAuthor(b, targetName, hasRealAuthor ? knownAuthor : '').both,
  )

  // 2. 择优顺序：严格匹配优先；严格池里「有效封面优先」，封面情况一致时按传入顺序
  //    （搜索结果已按相关度排序）取靠前者。严格池为空时退回宽松匹配兜底，避免漏匹配。
  let selected: SearchBook[]
  if (strictPool.length) {
    const withCover = strictPool.filter((b) => hasEffectiveCover(b.coverUrl))
    selected = withCover.length ? withCover : strictPool
  } else {
    const scored = candidates
      .map((c) => ({ book: c, score: relevanceScore(c, targetName) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    const exact = scored.filter((x) => x.score >= 100)
    let pool = (exact.length ? exact : scored.filter((x) => x.score >= 60)).map((x) => x.book)
    if (hasRealAuthor) {
      const target = normalize(knownAuthor ?? '')
      const byAuthor = pool.filter((b) => normalize(b.author ?? '') === target)
      if (byAuthor.length) pool = byAuthor
    }
    const withCover = pool.filter((b) => hasEffectiveCover(b.coverUrl))
    selected = withCover.length ? withCover : pool
  }

  if (!selected.length) return {}

  const best = selected[0]
  const result: LocalBookMatchResult = {}

  // 封面：在严格匹配池内取「共识封面」——同批候选中出现次数最多的那张。
  // 多个书源对同一本书往往返回同一张封面，多数派最可信；个别串图源各 1 票被淹没。
  // 严格池为空时退回宽松 selected 池统计。
  const coverPool = strictPool.length ? strictPool : selected
  result.coverUrl = pickConsensusCover(coverPool)

  // 简介：优先最优匹配的简介，其次取池中最长（信息最全）的简介。
  const introOf = (b: SearchBook) => (b.intro ?? '').trim()
  if (introOf(best)) result.intro = introOf(best)
  else {
    const withIntro = selected
      .map(introOf)
      .filter((s) => s.length > 0)
      .sort((a, b) => b.length - a.length)
    if (withIntro.length) result.intro = withIntro[0]
  }

  // 作者：已知为占位值时，用最优匹配的真实作者补全。
  if (!hasRealAuthor) {
    const realAuthor = selected
      .map((b) => stripAuthorLabel((b.author ?? '').trim()))
      .find((a) => !isPlaceholderAuthor(a))
    if (realAuthor) result.author = realAuthor
  }

  return result
}
