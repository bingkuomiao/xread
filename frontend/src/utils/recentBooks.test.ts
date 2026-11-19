import { describe, it, expect, beforeEach, vi } from 'vitest'

// 内存版 localStorage，避免依赖 jsdom
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
})

const KEY = 'reader-recent-books'

import { loadRecentReadBooks } from './recentBooks'

describe('loadRecentReadBooks 本地历史数据清洗', () => {
  beforeEach(() => store.clear())

  it('清洗旧版本存入的脏 author/intro', () => {
    store.set(KEY, JSON.stringify([{
      bookUrl: 'http://x.com/1',
      origin: 'https://src.com',
      name: '<p>皇明</p>',
      author: '<i class="fa">佚名</i>&nbsp;460 万字',
      intro: '<div>第一段</div><p>第二段</p>',
      durChapterTime: 12345,
    }]))
    const [book] = loadRecentReadBooks()
    expect(book.name).toBe('皇明')
    expect(book.author).toBe('佚名 460 万字')
    expect(book.intro).toBe('第一段\n第二段')
  })

  it('URL / 标识字段不被清洗', () => {
    store.set(KEY, JSON.stringify([{
      bookUrl: 'http://x.com/a?b=1&amp;c=2',
      origin: 'https://src.com',
      name: '书名',
      author: '作者',
      durChapterTime: 1,
    }]))
    const [book] = loadRecentReadBooks()
    expect(book.bookUrl).toBe('http://x.com/a?b=1&amp;c=2')
    expect(book.origin).toBe('https://src.com')
  })

  it('空存储返回空数组', () => {
    expect(loadRecentReadBooks()).toEqual([])
  })
})
