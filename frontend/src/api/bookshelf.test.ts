import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 依赖：通过观测 http.post 的 URL 判断写回走的是单本 saveBook 还是全量 saveBooks。
const { postMock, getMock, searchMock, pickMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  searchMock: vi.fn(),
  pickMock: vi.fn(),
}))

vi.mock('./http', () => ({ default: { post: postMock, get: getMock } }))
vi.mock('./search', () => ({ searchBookMultiOnce: searchMock }))
vi.mock('../utils/localBookMatch', () => ({ pickBestMetadata: pickMock }))

import { enrichLocalBookMeta, getCoverUrl, saveLocalBookCover } from './bookshelf'

const baseBook = {
  bookUrl: 'local-txt:book',
  name: '测试书名',
  origin: 'local-txt',
  durChapterIndex: 0,
}

describe('enrichLocalBookMeta 写回安全性（书架清空 bug 回归）', () => {
  beforeEach(() => {
    postMock.mockReset()
    getMock.mockReset()
    searchMock.mockReset()
    pickMock.mockReset()
    // saveBook 走 http.post('/saveBook', book).then(r => sanitizeBook(r.data))
    postMock.mockResolvedValue({ data: { ...baseBook } })
  })

  it('命中元数据时只走单本 saveBook，绝不调用会清空整架的 saveBooks', async () => {
    searchMock.mockResolvedValue([{ bookUrl: 'net://1', name: '测试书名' }])
    pickMock.mockReturnValue({ coverUrl: 'http://cover', intro: '简介', author: '作者' })

    const result = await enrichLocalBookMeta({ ...baseBook, bookUrl: 'local-txt:regression-1' })

    const urls = postMock.mock.calls.map((c) => c[0])
    expect(urls).toContain('/saveBook')
    expect(urls).not.toContain('/saveBooks')
    // 写回参数是单本对象，不是数组
    const saveCall = postMock.mock.calls.find((c) => c[0] === '/saveBook')
    expect(Array.isArray(saveCall?.[1])).toBe(false)
    expect(result.cover).toBe(true)
    expect(result.intro).toBe(true)
  })

  it('未命中任何元数据时不写回书架', async () => {
    searchMock.mockResolvedValue([])
    pickMock.mockReturnValue({})

    const result = await enrichLocalBookMeta({ ...baseBook, bookUrl: 'local-txt:regression-2' })

    expect(postMock).not.toHaveBeenCalled()
    expect(result.cover).toBe(false)
  })

  it('已有封面的书直接跳过，不搜索也不写回', async () => {
    await enrichLocalBookMeta({
      ...baseBook,
      bookUrl: 'local-txt:regression-3',
      customCoverUrl: 'http://existing-cover',
    })
    expect(searchMock).not.toHaveBeenCalled()
    expect(postMock).not.toHaveBeenCalled()
  })

  it('搜索抛错时静默失败，不写回也不向外抛', async () => {
    searchMock.mockRejectedValue(new Error('timeout'))
    const result = await enrichLocalBookMeta({ ...baseBook, bookUrl: 'local-txt:regression-4' })
    expect(result.cover).toBe(false)
    expect(postMock).not.toHaveBeenCalled()
  })

  it('网络书直接跳过：不搜索、不写回（补封面仅针对本地书）', async () => {
    searchMock.mockResolvedValue([{ bookUrl: 'net://1', name: '测试书名' }])
    pickMock.mockReturnValue({ coverUrl: 'http://cover' })
    const result = await enrichLocalBookMeta({
      ...baseBook,
      bookUrl: 'https://example.com/book/1',
      origin: 'example.com',
    })
    expect(searchMock).not.toHaveBeenCalled()
    expect(postMock).not.toHaveBeenCalled()
    expect(result.cover).toBe(false)
  })
})

describe('getCoverUrl 封面接口统一', () => {
  const store: Record<string, string> = {}
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    })
  })

  it('网络书封面走统一 /reader3/cover，path 为远程 URL，并零判断带鉴权', () => {
    store['accessToken'] = 'tk'
    store['secureKey'] = 'sk'
    const url = getCoverUrl('https://img.example.com/a.jpg')
    const q = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/reader3/cover?')).toBe(true)
    expect(q.get('path')).toBe('https://img.example.com/a.jpg')
    // 零判断：远程 URL 也一律带上鉴权参数（后端对远程路径会忽略）
    expect(q.get('accessToken')).toBe('tk')
    expect(q.get('secureKey')).toBe('sk')
  })

  it('本地 EPUB 内嵌封面也走 /reader3/cover，path 为资源路径', () => {
    store['accessToken'] = 'tk'
    store['secureKey'] = 'sk'
    const url = getCoverUrl('/reader3/localEpubAsset?bookUrl=b%2F1&path=cover.jpg')
    expect(url.startsWith('/reader3/cover?')).toBe(true)
    const q = new URLSearchParams(url.split('?')[1])
    expect(q.get('path')).toBe('/reader3/localEpubAsset?bookUrl=b%2F1&path=cover.jpg')
    expect(q.get('accessToken')).toBe('tk')
    expect(q.get('secureKey')).toBe('sk')
  })

  it('空封面返回空串', () => {
    expect(getCoverUrl(undefined)).toBe('')
  })
})

describe('saveLocalBookCover 顺手补封面（零搜索写回）', () => {
  beforeEach(() => {
    postMock.mockReset()
    postMock.mockResolvedValue({ data: { ...baseBook } })
  })

  it('本地书无封面时写回 customCoverUrl', async () => {
    const ok = await saveLocalBookCover({ ...baseBook }, 'http://cdn/cover.jpg')
    expect(ok).toBe(true)
    const saveCall = postMock.mock.calls.find((c) => c[0] === '/saveBook')
    expect(saveCall?.[1]).toMatchObject({ customCoverUrl: 'http://cdn/cover.jpg' })
  })

  it('网络书跳过，不写回', async () => {
    const ok = await saveLocalBookCover(
      { ...baseBook, bookUrl: 'https://x/1', origin: 'example.com' },
      'http://cdn/cover.jpg',
    )
    expect(ok).toBe(false)
    expect(postMock).not.toHaveBeenCalled()
  })

  it('已有封面时跳过（幂等）', async () => {
    const ok = await saveLocalBookCover(
      { ...baseBook, customCoverUrl: 'http://old/cover.jpg' },
      'http://cdn/new.jpg',
    )
    expect(ok).toBe(false)
    expect(postMock).not.toHaveBeenCalled()
  })

  it('空封面 URL 跳过', async () => {
    const ok = await saveLocalBookCover({ ...baseBook }, '   ')
    expect(ok).toBe(false)
    expect(postMock).not.toHaveBeenCalled()
  })
})
