import type { BookSource } from '../types'

/**
 * 本地书「静默补封面」的尝试状态。
 *
 * 背景：无封面的本地书若在当前书源下匹配不到，之前每次冷启动都会重新搜一遍，
 * 造成反复、无收益的网络请求。这里为每个「没匹配到封面的本地书」记录一次
 * 「尝试时的书源指纹」。只要书源没变化（没增删改、没改规则），就认定当前书源
 * 已经搜过且搜不到，直接跳过；只有书源指纹变化（=书源有更新）才重新尝试。
 *
 * 状态存 localStorage（无后端契约、无 schema 变更），体积很小（每本书一个短 hash）。
 */

const STATE_KEY = 'xread-cover-match-state-v1'
/** 单条记录上限，防止长期使用后无限膨胀（正常远达不到） */
const MAX_ENTRIES = 500

type AttemptMap = Record<string, string>

function loadState(): AttemptMap {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as AttemptMap
  } catch {
    return {}
  }
}

function saveState(state: AttemptMap) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // 容量不足 / 隐私模式：忽略，退化为每次都尝试（不影响正确性）
  }
}

/**
 * 计算书源指纹：只取参与「搜索匹配」的关键字段，忽略展示类字段。
 * 书源增删改、规则调整、启用状态变化都会改变指纹；纯阅读 UI 的改动不会。
 * 用 FNV-1a 32 位哈希得到稳定短字符串；书源为空时返回空串（表示无可用书源）。
 */
export function computeSourceFingerprint(sources: BookSource[]): string {
  const enabled = sources
    .filter((s) => s.enabled !== false && !!s.bookSourceUrl)
    .map((s) => ({
      url: s.bookSourceUrl,
      group: s.bookSourceGroup || '',
      type: s.bookSourceType || 0,
      rule: s.ruleSearch || {},
      searchUrl: s.searchUrl || '',
    }))
    // 顺序无关：按 url 排序，避免书源顺序调整导致无谓重试
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))

  if (enabled.length === 0) return ''

  const serialized = JSON.stringify(enabled)
  // FNV-1a 32-bit
  let hash = 0x811c9dc5
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `n${enabled.length}_${(hash >>> 0).toString(36)}`
}

/** 读取某本书上次尝试匹配时的书源指纹；从未尝试则返回 null */
export function getCoverMatchFingerprint(bookUrl: string): string | null {
  if (!bookUrl) return null
  const state = loadState()
  return Object.prototype.hasOwnProperty.call(state, bookUrl) ? state[bookUrl] : null
}

/**
 * 判断在当前书源指纹下是否应跳过这本书的匹配。
 * - 无指纹（空书源）→ 不跳过（交给调用方决定是否尝试；通常无书源时调用方会整体跳过）
 * - 没有历史记录 → 需要尝试
 * - 历史指纹 == 当前指纹 → 跳过（当前书源已经搜过且没匹配到）
 * - 历史指纹 != 当前指纹 → 需要尝试（书源有更新）
 */
export function shouldSkipCoverMatch(bookUrl: string, currentFingerprint: string): boolean {
  if (!bookUrl || !currentFingerprint) return false
  const last = getCoverMatchFingerprint(bookUrl)
  return last === currentFingerprint
}

/** 记录这本书已用当前书源尝试过匹配（无论是否匹配到） */
export function markCoverMatchAttempted(bookUrl: string, fingerprint: string) {
  if (!bookUrl || !fingerprint) return
  const state = loadState()
  state[bookUrl] = fingerprint
  const keys = Object.keys(state)
  if (keys.length > MAX_ENTRIES) {
    // 超出上限时丢弃最早写入的若干条（Object 键按插入顺序，数字键除外；这里 key 是 URL 字符串）
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete state[k]
  }
  saveState(state)
}

/** 匹配成功后封面已写回，清除尝试记录（虽然书已有封面不会再进候选，清掉更干净） */
export function clearCoverMatchAttempt(bookUrl: string) {
  if (!bookUrl) return
  const state = loadState()
  if (Object.prototype.hasOwnProperty.call(state, bookUrl)) {
    delete state[bookUrl]
    saveState(state)
  }
}

/** 清空全部尝试记录：用于「封面匹配」开关从关→开时，强制重新匹配一轮 */
export function clearAllCoverMatchAttempts() {
  try {
    localStorage.removeItem(STATE_KEY)
  } catch {
    // 忽略
  }
}
