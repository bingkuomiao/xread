import { beforeEach, describe, expect, it, vi } from 'vitest'

// mock 所有依赖 API：验证合并调用哪些写接口、写了什么
const m = vi.hoisted(() => ({
  getBookshelf: vi.fn(),
  saveBooks: vi.fn(),
  getBookGroups: vi.fn(),
  saveBookGroup: vi.fn(),
  getBookmarks: vi.fn(),
  saveBookmarks: vi.fn(),
  getReplaceRules: vi.fn(),
  saveReplaceRules: vi.fn(),
  getRssSources: vi.fn(),
  saveRssSources: vi.fn(),
  getBookSources: vi.fn(),
  saveBookSources: vi.fn(),
  captureLocalState: vi.fn(),
  applyLocalState: vi.fn(),
}))

vi.mock('../api/bookshelf', () => ({
  getBookshelf: m.getBookshelf,
  saveBooks: m.saveBooks,
  saveBookGroup: m.saveBookGroup,
  getBookGroups: m.getBookGroups,
  deleteBooks: vi.fn(() => { throw new Error('合并恢复不应调用 deleteBooks') }),
}))
vi.mock('../api/bookmark', () => ({ getBookmarks: m.getBookmarks, saveBookmarks: m.saveBookmarks, deleteBookmarks: vi.fn() }))
vi.mock('../api/replaceRule', () => ({ getReplaceRules: m.getReplaceRules, saveReplaceRules: m.saveReplaceRules, deleteReplaceRules: vi.fn() }))
vi.mock('../api/rss', () => ({ getRssSources: m.getRssSources, saveRssSources: m.saveRssSources, deleteRssSource: vi.fn() }))
vi.mock('../api/source', () => ({ getBookSources: m.getBookSources, saveBookSources: m.saveBookSources, deleteAllBookSources: vi.fn() }))
vi.mock('./cleanText', () => ({ sanitizeBooks: (books: unknown) => books }))

import { mergeWebdavBackup, type WebdavBackupPayload } from './webdavBackup'
import type { Book } from '../types'

class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string) { return this.store.get(k) ?? null }
  setItem(k: string, v: string) { this.store.set(k, String(v)) }
  removeItem(k: string) { this.store.delete(k) }
}

const book = (name: string, url: string, origin: string, durChapterTime: number): Book => ({
  name, bookUrl: url, origin, author: '', durChapterTime,
})

function payload(books: ReturnType<typeof book>[]): WebdavBackupPayload {
  return {
    version: 1,
    createdAt: '',
    app: '',
    bookshelf: { books: books as never, groups: [] },
    bookSources: [],
    rssSources: [],
    bookmarks: [],
    replaceRules: [],
    localState: {},
  }
}

describe('mergeWebdavBackup 合并恢复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).localStorage = new MemStorage()
    m.getBookGroups.mockResolvedValue([])
    m.getBookmarks.mockResolvedValue([])
    m.getReplaceRules.mockResolvedValue([])
    m.getRssSources.mockResolvedValue([])
    m.getBookSources.mockResolvedValue([])
  })

  it('保留当前独有书 + 加入备份独有书，不删除任何现有书', async () => {
    m.getBookshelf.mockResolvedValue([book('当前书A', 'u://a', 'o1', 100)])
    await mergeWebdavBackup(payload([book('备份书B', 'u://b', 'o1', 100)]))
    const saved = m.saveBooks.mock.calls[0][0]
    expect(saved).toHaveLength(2)
    expect(saved.map((b: { name: string }) => b.name)).toEqual(['当前书A', '备份书B'])
  })

  it('同一本书取阅读进度较新的版本', async () => {
    // 当前进度较旧(100)，备份进度较新(500) → 取备份
    m.getBookshelf.mockResolvedValue([{ ...book('旧书', 'u://x', 'o1', 100), durChapterIndex: 3 }])
    await mergeWebdavBackup(payload([{ ...book('新书', 'u://x', 'o1', 500), durChapterIndex: 9 }]))
    let saved = m.saveBooks.mock.calls[0][0]
    expect(saved).toHaveLength(1)
    expect(saved[0].durChapterTime).toBe(500)

    // 反向：当前进度较新(900)，备份较旧(200) → 保留当前
    vi.clearAllMocks()
    m.getBookshelf.mockResolvedValue([book('当前新', 'u://x', 'o1', 900)])
    await mergeWebdavBackup(payload([book('备份旧', 'u://x', 'o1', 200)]))
    saved = m.saveBooks.mock.calls[0][0]
    expect(saved).toHaveLength(1)
    expect(saved[0].durChapterTime).toBe(900)
  })

  it('去重按 bookUrl + origin：同 URL 不同源视为不同书', async () => {
    m.getBookshelf.mockResolvedValue([book('同名', 'u://x', '源A', 100)])
    await mergeWebdavBackup(payload([book('同名', 'u://x', '源B', 100)]))
    expect(m.saveBooks.mock.calls[0][0]).toHaveLength(2)
  })

  it('合并本地配置：备份覆盖同名 key，当前独有的白名单 key 保留', async () => {
    const storage = new MemStorage()
    storage.setItem('xread-exact-match', 'false')
    storage.setItem('xread-search-all-default', 'false')
    ;(globalThis as any).localStorage = storage
    m.getBookshelf.mockResolvedValue([])
    const p = payload([])
    p.localState = { 'xread-exact-match': 'true' } // 备份只带一个 key
    await mergeWebdavBackup(p)
    // 备份覆盖同名 key
    expect(storage.getItem('xread-exact-match')).toBe('true')
    // 当前独有的白名单 key 保留（不被清除）
    expect(storage.getItem('xread-search-all-default')).toBe('false')
  })
})
