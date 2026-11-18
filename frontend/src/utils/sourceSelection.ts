import type { BookSource, RssSource } from '../types'
import { DEEP_GROUP_BAD, DEEP_GROUP_WARN } from './sourceCompatibility'

export function getVisibleSelection<T>(
  visibleItems: T[],
  selectedKeys: ReadonlySet<string>,
  keyOf: (item: T) => string,
) {
  return visibleItems.filter((item) => selectedKeys.has(keyOf(item)))
}

export function toBookSourceDeletePayload(sources: Pick<BookSource, 'bookSourceUrl'>[]) {
  return sources.map((source) => ({ bookSourceUrl: source.bookSourceUrl }))
}

export function toRssSourceDeletePayload(sources: Pick<RssSource, 'sourceName' | 'sourceUrl'>[]) {
  return sources.map((source) => ({
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
  }))
}

export function getBookSourceGroups(sources: Pick<BookSource, 'bookSourceGroup'>[]) {
  const groups = new Set<string>()
  sources.forEach((source) => {
    source.bookSourceGroup?.split(/[,;；、]/).forEach((group) => {
      const trimmed = group.trim()
      if (trimmed) groups.add(trimmed)
    })
  })
  return Array.from(groups).sort()
}

/** 书源管理「测试书源」把无响应（两次超时仍失败）源追加的分组名。 */
export const SOURCE_GROUP_INVALID = '失效'

/** 分组下拉的一个选项。value 恒为纯分组名，保证筛选按原分组匹配；label 只用于展示。 */
export interface BookSourceGroupOption {
  value: string
  label: string
  count: number
  tone: 'bad' | 'warn' | null
  icon: string | null
  pinned: boolean
}

// 需要置顶、带数量、带醒目符号的三个标记分组，图标与名称一一对应、互不混用：
// 「不兼容 / 需留意」由兼容检测按静态等级写回，「失效」由书源测试写回。
// 兼容检测常量直接复用 sourceCompatibility，避免魔法字符串漂移。
const MARKED_GROUPS: { name: string; icon: string; tone: 'bad' | 'warn' }[] = [
  { name: DEEP_GROUP_BAD, icon: '⛔', tone: 'bad' },
  { name: DEEP_GROUP_WARN, icon: '⚠️', tone: 'warn' },
  { name: SOURCE_GROUP_INVALID, icon: '❌', tone: 'bad' },
]

/**
 * 生成书源管理分组下拉的选项：
 * - 统计每个分组实际包含的书源数（按 /[,;；、]/ 切分，与筛选口径一致，同源去重）；
 * - 「不兼容 / 需留意 / 失效」三个标记分组置顶，label 带符号与数量，value 仍为纯分组名；
 * - 其余分组沿用原有字典序，不带后缀，避免下拉文本整体变化。
 */
export function getBookSourceGroupOptions(
  sources: Pick<BookSource, 'bookSourceGroup'>[],
): BookSourceGroupOption[] {
  const counts = new Map<string, number>()
  sources.forEach((source) => {
    const parts = (source.bookSourceGroup || '')
      .split(/[,;；、]/)
      .map((item) => item.trim())
      .filter(Boolean)
    for (const name of new Set(parts)) {
      counts.set(name, (counts.get(name) || 0) + 1)
    }
  })

  const options: BookSourceGroupOption[] = []
  for (const marked of MARKED_GROUPS) {
    const count = counts.get(marked.name) || 0
    if (!count) continue
    options.push({
      value: marked.name,
      label: `${marked.icon} ${marked.name} (${count})`,
      count,
      tone: marked.tone,
      icon: marked.icon,
      pinned: true,
    })
    counts.delete(marked.name)
  }
  for (const name of Array.from(counts.keys()).sort()) {
    options.push({
      value: name,
      label: name,
      count: counts.get(name) || 0,
      tone: null,
      icon: null,
      pinned: false,
    })
  }
  return options
}

export function filterBookSources(
  sources: BookSource[],
  filterText: string,
  filterGroup: string,
) {
  const keyword = filterText.trim().toLowerCase()
  return sources.filter((source) => {
    const matchesText = !keyword
      || source.bookSourceName.toLowerCase().includes(keyword)
      || source.bookSourceUrl.toLowerCase().includes(keyword)
    const matchesGroup = !filterGroup || source.bookSourceGroup?.includes(filterGroup)
    return matchesText && matchesGroup
  })
}

export function getBookSourceStats(allSources: BookSource[], filteredSources: BookSource[]) {
  return {
    total: allSources.length,
    enabled: allSources.filter((source) => source.enabled !== false).length,
    filtered: filteredSources.length,
  }
}

export function getBookSourceOverview(source: BookSource | null) {
  if (!source) {
    return null
  }
  return {
    group: source.bookSourceGroup?.trim() || '未分组',
    statusText: source.enabled === false ? '停用' : '启用',
    exploreText: source.enabledExplore === false ? '发现停用' : '发现可用',
    cookieText: source.enabledCookieJar ? 'Cookie 独立' : '默认 Cookie',
    hasSearch: Boolean(source.searchUrl || source.ruleSearch),
    hasExplore: Boolean(source.exploreUrl || source.ruleExplore),
    hasBookInfo: Boolean(source.ruleBookInfo),
    hasToc: Boolean(source.ruleToc),
    hasContent: Boolean(source.ruleContent),
    hasLogin: Boolean(source.loginUrl?.trim()),
  }
}

/**
 * 归一化书源 URL，用于「相似」比对：
 * - 去除首尾空白；
 * - http:// 与 https:// 视为相同（去掉 s 差异）；
 * - 末尾多余的 / 去掉；
 * - 整体转小写（域名大小写不敏感）。
 * 返回空串表示无有效 URL。仅覆盖最常见的相似形态，避免误判不同站点。
 */
export function normalizeSourceUrl(url: string | undefined | null): string {
  const raw = (url || '').trim().toLowerCase()
  if (!raw) return ''
  const schemeStripped = raw.replace(/^https?:\/\//, '')
  return schemeStripped.replace(/\/+$/, '')
}

export type SourceDupReason = 'url' | 'url-similar' | 'name'

export interface SourceDupSkipped {
  source: BookSource
  reason: SourceDupReason
}

export interface SourceDedupResult {
  /** 需要新增/写入的书源（已剔除重复项）。 */
  toSave: BookSource[]
  /** 被判定为重复、直接跳过的书源。 */
  skipped: SourceDupSkipped[]
}

/**
 * 导入去重：与已有书源比对，发现重复的「直接跳过、不覆盖」。
 * 重复判定（满足任一即跳过）：
 * - URL 精确相同（忽略首尾空白）；
 * - URL 归一化后相同（http/https、末尾 /、大小写）；
 * - 名称完全相同（忽略大小写与首尾空白）。
 * 同时剔除导入批次内部自身的重复项（后出现的跳过）。
 */
export function dedupeBookSources(
  incoming: BookSource[],
  existing: BookSource[],
): SourceDedupResult {
  const existingExact = new Set(existing.map((s) => (s.bookSourceUrl || '').trim()))
  const existingNorm = new Set(
    existing.map((s) => normalizeSourceUrl(s.bookSourceUrl)).filter(Boolean),
  )
  const existingNames = new Set(
    existing
      .map((s) => (s.bookSourceName || '').trim().toLowerCase())
      .filter(Boolean),
  )

  const seenExact = new Set<string>()
  const seenNorm = new Set<string>()
  const seenNames = new Set<string>()

  const toSave: BookSource[] = []
  const skipped: SourceDupSkipped[] = []

  for (const source of incoming) {
    const exact = (source.bookSourceUrl || '').trim()
    const norm = normalizeSourceUrl(source.bookSourceUrl)
    const name = (source.bookSourceName || '').trim().toLowerCase()

    let reason: SourceDupReason | null = null
    if (exact && (existingExact.has(exact) || seenExact.has(exact))) {
      reason = 'url'
    } else if (norm && (existingNorm.has(norm) || seenNorm.has(norm))) {
      reason = 'url-similar'
    } else if (name && (existingNames.has(name) || seenNames.has(name))) {
      reason = 'name'
    }

    if (reason) {
      skipped.push({ source, reason })
      continue
    }
    if (exact) seenExact.add(exact)
    if (norm) seenNorm.add(norm)
    if (name) seenNames.add(name)
    toSave.push(source)
  }

  return { toSave, skipped }
}
