import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBookshelfStore } from './bookshelf'
import { getBookshelfWithCacheInfo, saveBook, saveBooks } from '../api/bookshelf'
import { listBrowserCacheSummary } from '../utils/browserCache'

// 测试运行于 node 环境，提供最小 localStorage 内存实现供书架快照逻辑使用
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

vi.mock('../api/bookshelf', () => ({
  getBookshelfWithCacheInfo: vi.fn(),
  getBookGroups: vi.fn(),
  deleteBook: vi.fn(),
  deleteBooks: vi.fn(),
  saveBook: vi.fn(),
  saveBooks: vi.fn(),
  saveBookGroupId: vi.fn(),
  saveBookGroup: vi.fn(),
  deleteBookGroup: vi.fn(),
}))

vi.mock('../utils/browserCache', () => ({
  deleteBrowserBookCache: vi.fn(),
  listBrowserCacheSummary: vi.fn(),
}))

vi.mock('../utils/recentBooks', () => ({
  clearRecentReadBooks: vi.fn(),
  getRecentReadBookKey: vi.fn((book) => `${book.origin || ''}::${book.bookUrl}`),
  loadRecentReadBooks: vi.fn(() => []),
  removeRecentReadBook: vi.fn(),
}))

describe('bookshelf search state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([])
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([])
  })

  it('fetchBooksFast renders cached shelf immediately without loading spinner', async () => {
    const cached = [{ name: '缓存书', author: '甲', origin: 'src', bookUrl: 'https://b.example/cached' }]
    localStorage.setItem('xread-bookshelf-snapshot-v1', JSON.stringify({ books: cached, ts: Date.now() }))
    // 服务端返回稍慢，用于验证首屏不被加载态遮挡
    vi.mocked(getBookshelfWithCacheInfo).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([] as never), 30)),
    )

    const store = useBookshelfStore()
    await store.fetchBooksFast()

    expect(store.books.map((b) => b.bookUrl)).toEqual(['https://b.example/cached'])
    expect(store.loading).toBe(false)
  })

  it('fetchBooks persists shelf snapshot for next cold start', async () => {
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([
      { name: '书', author: '乙', origin: 'src', bookUrl: 'https://b.example/persist' },
    ] as never)

    const store = useBookshelfStore()
    await store.fetchBooks()

    const raw = localStorage.getItem('xread-bookshelf-snapshot-v1')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).books[0].bookUrl).toBe('https://b.example/persist')
  })

  it('starts searches in single-source scope by default', () => {
    const store = useBookshelfStore()

    store.startSearch('星门')

    expect(store.searchKey).toBe('星门')
    expect(store.searchScope).toBe('source')
    expect(store.searchSourceUrl).toBe('')
    expect(store.searchGroup).toBe('')
  })


  it('does not display browser cache counts for uploaded local txt books', async () => {
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([
      {
        name: '本地书',
        author: '本地导入',
        origin: 'local-txt',
        bookUrl: 'local-txt:abc',
        cachedChapterCount: 12,
      },
      {
        name: '远程书',
        author: '作者',
        origin: 'https://source.example',
        bookUrl: 'https://book.example/1',
      },
    ] as never)
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([
      { bookUrl: 'local-txt:abc', cachedChapterCount: 12, bytes: 100, updatedAt: 1 },
      { bookUrl: 'https://book.example/1', cachedChapterCount: 3, bytes: 200, updatedAt: 2 },
    ])
    const store = useBookshelfStore()

    await store.fetchBooks()

    expect(store.books.find((book) => book.bookUrl === 'local-txt:abc')?.browserCachedChapterCount).toBe(0)
    expect(store.books.find((book) => book.bookUrl === 'https://book.example/1')?.browserCachedChapterCount).toBe(3)
  })

  it('can start a search with the active explore source selected', () => {
    const store = useBookshelfStore()

    store.startSearch('星门', { sourceUrl: 'https://m.cuoceng.com' })

    expect(store.searchKey).toBe('星门')
    expect(store.searchScope).toBe('source')
    expect(store.searchSourceUrl).toBe('https://m.cuoceng.com')
  })

  it('places the newly added book at the front of the shelf', async () => {
    const existing = [
      { name: '旧书A', author: '甲', origin: 'src', bookUrl: 'https://b.example/a' },
      { name: '旧书B', author: '乙', origin: 'src', bookUrl: 'https://b.example/b' },
    ]
    const newBook = { name: '新书', author: '丙', origin: 'src', bookUrl: 'https://b.example/new' }
    vi.mocked(saveBook).mockResolvedValue({ ...newBook } as never)
    // 后端把新书 push 到末尾后返回
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([...existing, newBook] as never)

    const store = useBookshelfStore()
    await store.addToShelf(newBook)

    expect(store.books.map((b) => b.bookUrl)).toEqual([
      'https://b.example/new',
      'https://b.example/a',
      'https://b.example/b',
    ])
    // 置顶后的顺序需写回服务端，保证跨设备一致
    expect(saveBooks).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ bookUrl: 'https://b.example/new' })]),
    )
  })

  it('batch-adds multiple books in parallel without losing any book', async () => {
    const existing = [{ name: '旧书', author: '甲', origin: 'src', bookUrl: 'https://b.example/old' }]
    const newBooks = Array.from({ length: 5 }, (_, i) => ({
      name: `新书${i}`, author: '丙', origin: 'src', bookUrl: `https://b.example/new${i}`,
    }))
    // 并发闸门：5 本 saveBook 全部进入后才放行，若串行则永远等不到第 2 本进入
    let entered = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(saveBook).mockImplementation(async (b) => {
      entered++
      await gate
      return { ...b } as never
    })
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([...existing, ...newBooks] as never)

    const store = useBookshelfStore()
    const pending = Promise.all(newBooks.map((b) => store.addToShelf(b)))
    // 等微批窗口过去，若 5 个保存请求真的并行，entered 会到 5
    const deadline = Date.now() + 2000
    while (entered < 5 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(entered).toBe(5)
    release()
    await pending

    const urls = store.books.map((b) => b.bookUrl)
    // 5 本新书 + 1 本旧书，一本不少
    expect(urls).toHaveLength(6)
    newBooks.forEach((b) => expect(urls).toContain(b.bookUrl))
    // 最后加入的排最前
    expect(urls[0]).toBe('https://b.example/new4')
    // saveBook 并行发出（5 次），全量写回只做 1 次（微批合并）
    expect(saveBook).toHaveBeenCalledTimes(5)
    expect(saveBooks).toHaveBeenCalledTimes(1)
  })
})
