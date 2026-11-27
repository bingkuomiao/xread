import { beforeEach, describe, expect, it, vi } from 'vitest'

const { postMock, searchMock, pickMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  searchMock: vi.fn(),
  pickMock: vi.fn(),
}))

vi.mock('./http', () => ({ default: { post: postMock, get: vi.fn() } }))
vi.mock('./search', () => ({ searchBookMultiOnce: searchMock }))
vi.mock('../utils/localBookMatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/localBookMatch')>()
  return { ...actual, pickBestMetadata: pickMock }
})

import { enrichLocalBookMeta } from './bookshelf'
import { clearLocalCoverCache, setCachedCover } from '../utils/localCoverCache'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

const book = {
  bookUrl: 'local-txt:new-hash-after-reimport',
  name: '皇明',
  author: '雨落未敢愁',
  origin: 'local-txt',
  durChapterIndex: 0,
}

describe('enrichLocalBookMeta 封面缓存复用', () => {
  beforeEach(() => {
    postMock.mockReset()
    searchMock.mockReset()
    pickMock.mockReset()
    ;(globalThis as any).localStorage = new MemStorage()
    clearLocalCoverCache()
    postMock.mockResolvedValue({ data: { ...book } })
    searchMock.mockResolvedValue([])
    pickMock.mockReturnValue({})
  })

  it('缓存命中时跳过搜索，直接写回复用封面（新 bookUrl 也能命中）', async () => {
    setCachedCover('皇明', '雨落未敢愁', { coverUrl: 'http://img/reused.jpg' })

    const result = await enrichLocalBookMeta({ ...book })

    expect(searchMock).not.toHaveBeenCalled()
    expect(result.cover).toBe(true)
    expect(result.searched).toBe(0)
    const saveCall = postMock.mock.calls.find((c) => c[0] === '/saveBook')
    expect(saveCall).toBeDefined()
    expect(saveCall?.[1].customCoverUrl).toBe('http://img/reused.jpg')
  })

  it('缓存未命中时正常搜索，成功后写缓存', async () => {
    searchMock.mockResolvedValue([{ bookUrl: 'net://1', name: '皇明' }])
    pickMock.mockReturnValue({ coverUrl: 'http://img/fresh.jpg' })

    const result = await enrichLocalBookMeta({ ...book })

    expect(searchMock).toHaveBeenCalled()
    expect(result.cover).toBe(true)
    expect(postMock.mock.calls.some((c) => c[0] === '/saveBook')).toBe(true)
  })
})
