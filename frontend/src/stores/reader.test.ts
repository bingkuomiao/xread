import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from './app'
import { useReaderStore } from './reader'
import { getBookContent } from '../api/bookshelf'
import { getBrowserCachedChapter, setBrowserCachedChapter } from '../utils/browserCache'

vi.mock('../api/bookshelf', () => ({
  getChapterList: vi.fn(),
  getBookContent: vi.fn(),
  saveBookProgress: vi.fn(),
  setBookSource: vi.fn(),
}))

vi.mock('../api/bookmark', () => ({
  getBookmarks: vi.fn(),
  saveBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  deleteBookmarks: vi.fn(),
}))

vi.mock('../api/replaceRule', () => ({
  getReplaceRules: vi.fn(),
}))

vi.mock('../utils/browserCache', () => ({
  getBrowserCachedChapter: vi.fn(),
  setBrowserCachedChapter: vi.fn(),
}))

vi.mock('../utils/recentBooks', () => ({
  saveRecentReadBook: vi.fn(),
}))

vi.mock('../utils/openaiSpeech', () => ({
  DEFAULT_OPENAI_BASE_URL: 'https://api.openai.com/v1',
  requestOpenAISpeechAudio: vi.fn(),
}))

describe('reader local txt chapters', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
      clear: vi.fn(() => storage.clear()),
    })
    vi.mocked(getBookContent).mockReset()
    vi.mocked(getBrowserCachedChapter).mockReset()
    vi.mocked(setBrowserCachedChapter).mockReset()
    vi.mocked(setBrowserCachedChapter).mockResolvedValue(undefined)
  })

  function setupLocalBook() {
    const appStore = useAppStore()
    const readerStore = useReaderStore()
    readerStore.book = {
      name: '本地书',
      author: '本地导入',
      origin: 'local-txt',
      bookUrl: 'local-txt:abc123',
    }
    readerStore.chapters = [
      { title: '第一章', url: 'local-txt:abc123#0', index: 0 },
    ]
    return { appStore, readerStore }
  }

  it('fetches uploaded local txt content from backend even when browser reports offline', async () => {
    vi.mocked(getBookContent).mockResolvedValue('本地正文')
    vi.mocked(getBrowserCachedChapter).mockResolvedValue(null)
    const { appStore, readerStore } = setupLocalBook()
    appStore.setOnlineStatus(false)

    await expect(readerStore.fetchChapterContent(0)).resolves.toBe('本地正文')

    // 方案A：本地书也查浏览器缓存（未命中），离线时仍回退后端本地文件读取
    expect(getBrowserCachedChapter).toHaveBeenCalledWith('local-txt:abc123', 'local-txt:abc123#0')
    expect(getBookContent).toHaveBeenCalledWith({
      chapterUrl: 'local-txt:abc123#0',
      bookSourceUrl: 'local-txt',
      refresh: 0,
    })
  })

  it('本地书命中浏览器缓存时秒开，不请求后端', async () => {
    vi.mocked(getBrowserCachedChapter).mockResolvedValue('缓存正文')
    const { readerStore } = setupLocalBook()

    await expect(readerStore.fetchChapterContent(0)).resolves.toBe('缓存正文')

    expect(getBookContent).not.toHaveBeenCalled()
  })

  it('本地书后端读取后写回浏览器缓存，供下次秒开', async () => {
    vi.mocked(getBookContent).mockResolvedValue('后端正文')
    vi.mocked(getBrowserCachedChapter).mockResolvedValue(null)
    const { readerStore } = setupLocalBook()

    await readerStore.fetchChapterContent(0)
    await Promise.resolve() // 让 fire-and-forget 的写缓存 Promise 被触发

    expect(setBrowserCachedChapter).toHaveBeenCalledWith({
      bookUrl: 'local-txt:abc123',
      chapterUrl: 'local-txt:abc123#0',
      chapterTitle: '第一章',
      content: '后端正文',
    })
  })

  it('forceRefresh 时本地书绕过缓存读取，取到最新正文并覆盖缓存', async () => {
    vi.mocked(getBrowserCachedChapter).mockResolvedValue('旧缓存')
    vi.mocked(getBookContent).mockResolvedValue('最新正文')
    const { readerStore } = setupLocalBook()

    await expect(readerStore.fetchChapterContent(0, true)).resolves.toBe('最新正文')

    expect(getBrowserCachedChapter).not.toHaveBeenCalled()
    expect(getBookContent).toHaveBeenCalledWith(expect.objectContaining({ refresh: 1 }))
  })
})
