import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useBookshelfStore } from './bookshelf'
import { getBookshelfWithCacheInfo, saveBook, saveBooks } from '../api/bookshelf'
import { listBrowserCacheSummary } from '../utils/browserCache'

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
    vi.mocked(getBookshelfWithCacheInfo).mockResolvedValue([])
    vi.mocked(listBrowserCacheSummary).mockResolvedValue([])
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
})
