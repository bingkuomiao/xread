import { ref } from 'vue'

export interface DayReadingRecord {
  date: string // YYYY-MM-DD
  seconds: number
}

export interface BookReadingRecord {
  bookUrl: string
  bookName: string
  author?: string
  coverUrl?: string
  origin?: string
  seconds: number
  lastReadAt: number
}

export interface ReadingStatsState {
  totalSeconds: number
  dailyGoalMinutes: number // 默认目标分钟数，例如 120 (2小时)
  dailyRecords: Record<string, number> // 'YYYY-MM-DD' -> seconds
  bookRecords: Record<string, BookReadingRecord> // bookUrl -> BookReadingRecord
  // 供设置页「阅读统计」展示；本文件为唯一数据源（不兼容旧版 reader-stats）。
  openedBooks: string[] // bookUrl 列表
  readChapters: string[] // `${bookUrl}#${index}` 列表
  completedBooks: string[] // bookUrl 列表
}

const STATS_STORAGE_KEY = 'xread-reading-stats-v2'

// 响应式版本号：每次统计落盘自增。设置页的 computed 通过 summary 函数读取它，
// 从而在任何写入（阅读结束/开书/读章/设置目标）后都能重算，避免显示启动快照。
export const statsRevision = ref(0)

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function emptyState(): ReadingStatsState {
  return {
    totalSeconds: 0,
    dailyGoalMinutes: 120,
    dailyRecords: {},
    bookRecords: {},
    openedBooks: [],
    readChapters: [],
    completedBooks: [],
  }
}

function getTodayKey(d = new Date()): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const date = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

export function loadReadingStats(): ReadingStatsState {
  // 只读唯一数据源 xread-reading-stats-v2；不再兼容旧版 reader-stats。
  try {
    const raw = localStorage.getItem(STATS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        totalSeconds: Number(parsed.totalSeconds) || 0,
        dailyGoalMinutes: Number(parsed.dailyGoalMinutes) || 120,
        dailyRecords: parsed.dailyRecords || {},
        bookRecords: parsed.bookRecords || {},
        openedBooks: asStringArray(parsed.openedBooks),
        readChapters: asStringArray(parsed.readChapters),
        completedBooks: asStringArray(parsed.completedBooks),
      }
    }
  } catch {
    // fallback
  }
  return emptyState()
}

export function saveReadingStats(state: ReadingStatsState) {
  try {
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
  statsRevision.value += 1
}

export function recordReadingTime(
  seconds: number,
  bookInfo?: { bookUrl: string; bookName: string; author?: string; coverUrl?: string; origin?: string },
) {
  if (seconds <= 0) return
  const state = loadReadingStats()
  state.totalSeconds += seconds

  const today = getTodayKey()
  state.dailyRecords[today] = (state.dailyRecords[today] || 0) + seconds

  if (bookInfo?.bookUrl) {
    const existing = state.bookRecords[bookInfo.bookUrl] || {
      bookUrl: bookInfo.bookUrl,
      bookName: bookInfo.bookName,
      author: bookInfo.author,
      coverUrl: bookInfo.coverUrl,
      origin: bookInfo.origin,
      seconds: 0,
      lastReadAt: Date.now(),
    }
    existing.seconds += seconds
    existing.lastReadAt = Date.now()
    if (bookInfo.bookName) existing.bookName = bookInfo.bookName
    if (bookInfo.author) existing.author = bookInfo.author
    if (bookInfo.coverUrl) existing.coverUrl = bookInfo.coverUrl
    if (bookInfo.origin) existing.origin = bookInfo.origin
    state.bookRecords[bookInfo.bookUrl] = existing
  }

  saveReadingStats(state)
}

export function setDailyGoal(minutes: number) {
  const state = loadReadingStats()
  state.dailyGoalMinutes = Math.max(1, minutes)
  saveReadingStats(state)
}

export function markBookOpened(bookUrl: string) {
  const state = loadReadingStats()
  if (!state.openedBooks.includes(bookUrl)) {
    state.openedBooks.push(bookUrl)
    saveReadingStats(state)
  }
}

export function markChapterRead(bookUrl: string, index: number, totalChapters: number) {
  const state = loadReadingStats()
  const key = `${bookUrl}#${index}`
  let changed = false
  if (!state.readChapters.includes(key)) {
    state.readChapters.push(key)
    changed = true
  }
  if (totalChapters > 0 && index >= totalChapters - 1 && !state.completedBooks.includes(bookUrl)) {
    state.completedBooks.push(bookUrl)
    changed = true
  }
  if (changed) saveReadingStats(state)
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0秒'
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor(seconds / 3600)

  if (h > 0) return `${h}小时${m}分钟`
  if (m > 0) return `${m}分钟${s}秒`
  return `${s}秒`
}

/**
 * 累计阅读时长的统一格式化口径，供设置页与最近阅读页共用。
 * 规则：满 1 小时显示「X小时Y分钟」，不足 1 小时按整分显示，且保底 1 分钟
 * （即不足 1 分钟也显示「1分钟」，两处口径一致）。
 */
export function formatTotalTime(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours}小时${minutes}分钟` : `${Math.max(1, totalMinutes)}分钟`
}

export function getStatsSummary() {
  void statsRevision.value // 建立响应式依赖：统计落盘后消费方自动刷新
  const state = loadReadingStats()
  const today = getTodayKey()
  const todaySeconds = state.dailyRecords[today] || 0

  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = String(now.getMonth() + 1).padStart(2, '0')
  const monthPrefix = `${currentYear}-${currentMonth}`

  let monthSeconds = 0
  let activeDays = 0

  Object.entries(state.dailyRecords).forEach(([dateStr, sec]) => {
    if (sec > 0) {
      activeDays += 1
      if (dateStr.startsWith(monthPrefix)) {
        monthSeconds += sec
      }
    }
  })

  // 如果有总时间但 activeDays 为 0，给保底至少 1 天
  if (state.totalSeconds > 0 && activeDays === 0) {
    activeDays = 1
  }

  return {
    todaySeconds,
    monthSeconds,
    totalSeconds: state.totalSeconds,
    activeDays,
    dailyGoalMinutes: state.dailyGoalMinutes,
    dailyRecords: state.dailyRecords,
    bookRecords: state.bookRecords,
  }
}

/** 设置页「阅读统计」用的统一汇总，字段与旧版 readingStatsSummary 完全兼容。 */
export function getUnifiedSummary() {
  void statsRevision.value // 建立响应式依赖：统计落盘后设置页自动重算
  const state = loadReadingStats()
  return {
    totalSeconds: state.totalSeconds,
    totalTimeText: formatTotalTime(state.totalSeconds),
    openedBooks: state.openedBooks.length,
    readChapters: state.readChapters.length,
    completedBooks: state.completedBooks.length,
  }
}
