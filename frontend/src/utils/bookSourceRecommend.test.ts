import { describe, expect, it } from 'vitest'
import type { SearchBook } from '../types'
import {
  coverFingerprint,
  hasEffectiveCover,
  isPlausibleWordCount,
  normalizeRecommendText,
  normalizeRecommendAuthor,
  parseWordCountToNumber,
  strictMatchNameAuthor,
} from './bookSourceRecommend'

function book(name: string, author: string, coverUrl?: string): SearchBook {
  return { name, author, bookUrl: `${name}-${author}`, origin: 'src', coverUrl }
}

describe('hasEffectiveCover', () => {
  it('rejects empty and placeholder cover urls', () => {
    expect(hasEffectiveCover('')).toBe(false)
    expect(hasEffectiveCover('http://x/nocover.jpg')).toBe(false)
    expect(hasEffectiveCover('http://x/default.png')).toBe(false)
    expect(hasEffectiveCover('暂无封面')).toBe(false)
  })
  it('accepts real cover urls', () => {
    expect(hasEffectiveCover('http://x/real-cover.webp')).toBe(true)
  })
})

describe('isPlausibleWordCount', () => {
  it('rejects tiny word count for a large book', () => {
    // 432 章却标 17K —— 图例中的错误数据
    expect(isPlausibleWordCount('17K', 432)).toBe(false)
  })
  it('accepts reasonable word counts', () => {
    expect(isPlausibleWordCount('120万', 432)).toBe(true)
    expect(isPlausibleWordCount('80万字')).toBe(true)
  })
  it('accepts free-form text conservatively', () => {
    expect(isPlausibleWordCount('约三百万字', 432)).toBe(true)
  })
})

describe('parseWordCountToNumber', () => {
  it('parses K / 万 / M / 亿 into word numbers', () => {
    expect(parseWordCountToNumber('7474K')).toBe(7_474_000)
    expect(parseWordCountToNumber('355万字')).toBe(3_550_000)
    expect(parseWordCountToNumber('23K')).toBe(23_000)
    expect(parseWordCountToNumber('1.2M')).toBe(12_000)
    expect(parseWordCountToNumber('3亿')).toBe(300_000_000)
    expect(parseWordCountToNumber('8000')).toBe(8000)
  })
  it('returns 0 for empty/unparseable', () => {
    expect(parseWordCountToNumber('')).toBe(0)
    expect(parseWordCountToNumber('约三百万字')).toBe(0)
  })
})

describe('isPlausibleWordCount upper/lower bounds', () => {
  it('rejects absurdly high per-chapter count', () => {
    // 1015 章却标 7474K 也在合理区间（约 7363 字/章），但 200K 则明显单位写错
    expect(isPlausibleWordCount('7474K', 1015)).toBe(true)
    expect(isPlausibleWordCount('23K', 1015)).toBe(false)
  })
})

describe('coverFingerprint', () => {
  it('normalizes same cover across query params and protocol', () => {
    const a = 'https://cdn.example.com/covers/abc123.jpg'
    const b = 'http://cdn.example.com/covers/abc123.jpg?x=1'
    expect(coverFingerprint(a)).toBe(coverFingerprint(b))
  })
  it('returns empty for placeholders', () => {
    expect(coverFingerprint('')).toBe('')
    expect(coverFingerprint('http://x/nocover.jpg')).toBe('')
  })
})

describe('normalize helpers', () => {
  it('strips punctuation, marks and author label', () => {
    expect(normalizeRecommendText('《三国之宅行天下》')).toBe('三国之宅行天下')
    expect(normalizeRecommendAuthor('作者：贱宗首席弟子')).toBe('贱宗首席弟子')
  })
})

describe('strictMatchNameAuthor', () => {
  it('requires both name and author to match', () => {
    const b = book('三国之宅行天下', '贱宗首席弟子', 'http://x/c.jpg')
    expect(strictMatchNameAuthor(b, '三国之宅行天下', '贱宗首席弟子').both).toBe(true)
    expect(strictMatchNameAuthor(b, '三国之宅行天下', '别人').both).toBe(false)
    expect(strictMatchNameAuthor(b, '别的书', '贱宗首席弟子').both).toBe(false)
  })
  it('only checks name when target author is empty', () => {
    const b = book('三国之宅行天下', '任意作者')
    expect(strictMatchNameAuthor(b, '三国之宅行天下', '').both).toBe(true)
  })
})
