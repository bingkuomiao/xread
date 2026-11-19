import { beforeEach, describe, expect, it } from 'vitest'
import { effect, stop } from 'vue'
import {
  loadReadingStats,
  recordReadingTime,
  markBookOpened,
  markChapterRead,
  getUnifiedSummary,
  getStatsSummary,
  formatTotalTime,
  statsRevision,
} from './readingStats'

// 简易 localStorage mock
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

describe('阅读统计统一数据源', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = new MemStorage()
    statsRevision.value = 0
  })

  it('不兼容旧数据：存在 reader-stats 但无新 key 时返回空状态', () => {
    localStorage.setItem('reader-stats', JSON.stringify({
      totalSeconds: 3600,
      openedBooks: ['url-a'],
      readChapters: ['url-a#0'],
      completedBooks: [],
    }))
    const s = loadReadingStats()
    expect(s.totalSeconds).toBe(0)
    expect(s.openedBooks).toEqual([])
    expect(localStorage.getItem('xread-reading-stats-v2')).toBeNull()
  })

  it('markChapterRead 末章计入 completedBooks，重复调用不重复计数', () => {
    markBookOpened('url-x')
    markBookOpened('url-x') // 重复
    markChapterRead('url-x', 0, 2)
    markChapterRead('url-x', 0, 2) // 重复章节
    markChapterRead('url-x', 1, 2) // 末章
    const out = loadReadingStats()
    expect(out.openedBooks).toEqual(['url-x'])
    expect(out.readChapters.length).toBe(2)
    expect(out.completedBooks).toEqual(['url-x'])
  })

  it('统一 summary 与 recordReadingTime 累加一致，两页面数据源相同', () => {
    recordReadingTime(120, { bookUrl: 'url-z', bookName: 'Z' })
    const unified = getUnifiedSummary()
    const recent = getStatsSummary()
    expect(unified.totalSeconds).toBe(120)
    expect(recent.totalSeconds).toBe(120)
    expect(recent.bookRecords['url-z'].seconds).toBe(120)
  })

  it('统计写入后响应式版本号自增，触发 summary 消费方重算', () => {
    let runs = 0
    let seenTotal = 0
    const runner = effect(() => {
      seenTotal = getUnifiedSummary().totalSeconds
      runs += 1
    })
    expect(runs).toBe(1)
    expect(seenTotal).toBe(0)
    recordReadingTime(60, { bookUrl: 'url-r', bookName: 'R' })
    expect(runs).toBe(2) // 写入触发重算
    expect(seenTotal).toBe(60)
    stop(runner)
  })

  it('formatTotalTime 统一口径：不足1分钟按1分钟，满小时显示 小时+分钟', () => {
    expect(formatTotalTime(0)).toBe('1分钟')
    expect(formatTotalTime(30)).toBe('1分钟')
    expect(formatTotalTime(59)).toBe('1分钟')
    expect(formatTotalTime(60)).toBe('1分钟')
    expect(formatTotalTime(90)).toBe('1分钟')
    expect(formatTotalTime(120)).toBe('2分钟')
    expect(formatTotalTime(3600)).toBe('1小时0分钟')
    expect(formatTotalTime(3720)).toBe('1小时2分钟')
  })

  it('设置页与最近页累计时长显示口径完全一致', () => {
    recordReadingTime(45, { bookUrl: 'url-t', bookName: 'T' }) // 45秒，不足1分钟
    const settingText = getUnifiedSummary().totalTimeText
    const recentText = formatTotalTime(getStatsSummary().totalSeconds)
    expect(settingText).toBe('1分钟')
    expect(recentText).toBe(settingText)

    recordReadingTime(3600, { bookUrl: 'url-t', bookName: 'T' }) // 累计 3645秒 ≈ 1小时0分
    expect(getUnifiedSummary().totalTimeText).toBe(
      formatTotalTime(getStatsSummary().totalSeconds),
    )
  })

  it('RecentView 用 computed 口径：statsRevision 变化后 getStatsSummary 结果被重新读取', () => {
    const read = () => getStatsSummary().totalSeconds
    expect(read()).toBe(0)
    recordReadingTime(300, { bookUrl: 'url-c', bookName: 'C' })
    // 通过同一 statsRevision 依赖驱动，最近页与设置页读到相同的最新值
    expect(read()).toBe(getUnifiedSummary().totalSeconds)
    expect(read()).toBe(300)
  })
})
