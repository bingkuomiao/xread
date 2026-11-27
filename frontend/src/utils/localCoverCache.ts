import { stripTitleMarks } from './localBook'
import { isPlaceholderAuthor } from './localBookMatch'
import { hasEffectiveCover } from './bookSourceRecommend'

/**
 * 本地书封面复用缓存。
 *
 * 背景：本地书的 bookUrl 由「原始文件名 + 文件正文」的 hash 决定，同一本书重复导入
 * （文件名或内容有差异）会生成不同 bookUrl、被当作新书，从而每次都要重新跑多书源
 * 搜索匹配封面。这里按「书名 + 作者」建立一个持久缓存，命中即复用已有封面，跳过搜索。
 *
 * 误配防护：
 *  - 有真实作者时用「书名+作者」联合键；作者为占位值（本地导入/佚名等）时才退化为
 *    仅书名键，与原匹配逻辑 pickBestMetadata 的作者锁定语义一致；
 *  - 缓存值必须是有效封面 URL（复用 hasEffectiveCover 的黑名单判断）；
 *  - 容量有上限，避免 localStorage 无限膨胀。
 */
import type { LocalBookMatchResult } from './localBookMatch'

const CACHE_KEY = 'xread-local-cover-cache-v1'
const MAX_ENTRIES = 500

interface CachedCover {
  coverUrl: string
  intro?: string
  author?: string
  updatedAt: number
}

type CoverCache = Record<string, CachedCover>

function normalize(value: string): string {
  return stripTitleMarks(value ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 生成缓存键：真实作者 → 书名+作者；占位作者 → 仅书名。 */
export function localCoverKey(name: string, author?: string): string {
  const n = normalize(name)
  if (!n) return ''
  const a = (author ?? '').trim()
  return isPlaceholderAuthor(a) ? `n:${n}` : `n:${n}|a:${normalize(a)}`
}

function loadCache(): CoverCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as CoverCache
  } catch {
    return {}
  }
}

function saveCache(cache: CoverCache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 容量不足 / 隐私模式：静默降级为不缓存
  }
}

/**
 * 读取已缓存的封面元数据；无有效封面返回 null。
 */
export function getCachedCover(name: string, author?: string): LocalBookMatchResult | null {
  const key = localCoverKey(name, author)
  if (!key) return null
  const cache = loadCache()
  const hit = cache[key]
  if (!hit || !hasEffectiveCover(hit.coverUrl)) return null
  const result: LocalBookMatchResult = { coverUrl: hit.coverUrl }
  if (hit.intro) result.intro = hit.intro
  if (hit.author) result.author = hit.author
  return result
}

/**
 * 写入封面元数据缓存。只在确实拿到有效封面时写入。
 */
export function setCachedCover(name: string, author: string | undefined, meta: LocalBookMatchResult) {
  if (!hasEffectiveCover(meta.coverUrl)) return
  const key = localCoverKey(name, author)
  if (!key) return
  const cache = loadCache()
  cache[key] = {
    coverUrl: meta.coverUrl!.trim(),
    ...(meta.intro ? { intro: meta.intro } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    updatedAt: Date.now(),
  }
  const keys = Object.keys(cache)
  if (keys.length > MAX_ENTRIES) {
    // 按更新时间淘汰最旧的若干条
    const sorted = keys
      .map((k) => ({ k, t: cache[k]?.updatedAt ?? 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(0, keys.length - MAX_ENTRIES)
    for (const { k } of sorted) delete cache[k]
  }
  saveCache(cache)
}

/** 清空封面缓存（设置页可暴露「重置封面匹配缓存」入口）。 */
export function clearLocalCoverCache() {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // 忽略
  }
}
