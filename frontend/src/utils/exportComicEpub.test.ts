import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, BookChapter } from '../types'

vi.mock('../api/bookshelf', () => ({
  getChapterList: vi.fn(),
  getBookContent: vi.fn(),
  exportLocalBookText: vi.fn(),
}))

import { getBookContent } from '../api/bookshelf'
import { exportComicEpubToLocal } from './exportBook'

const comicBook = {
  name: '妖神记',
  author: '踏雪动漫',
  intro: '妖灵世界',
  bookUrl: 'https://source.example/book/comic',
  origin: 'source-1',
} as Book

const chapters: BookChapter[] = Array.from({ length: 5 }, (_, i) => ({
  title: `第${i + 1}话`,
  url: `https://source.example/book/comic#${i}`,
  index: i,
}))

let clicks: string[] = []

function stubDom() {
  clicks = []
  const makeAnchor = () => ({
    href: '', download: '', target: '', rel: '',
    click() { clicks.push(this.download) },
    setAttribute() {},
  })
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'a' ? makeAnchor() : {}),
    body: { appendChild() {}, removeChild() {} },
  })
  vi.stubGlobal('Blob', class { constructor(_parts: unknown[]) {} })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} })
  vi.stubGlobal('window', { setTimeout: () => 0 })
}

const fetchImage = vi.fn(async () => new Uint8Array([1, 2, 3]))

describe('exportComicEpubToLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubDom()
    vi.mocked(getBookContent).mockImplementation(async ({ chapterUrl }) => `<img src="${chapterUrl}/1.jpg" /><img src="${chapterUrl}/2.jpg" />`)
  })

  it('全本：产出单个 EPUB，文件名规范，进度覆盖全部章节', async () => {
    const progress: number[] = []
    const result = await exportComicEpubToLocal({
      book: comicBook,
      chapters,
      volumeSize: 0,
      fetchImage,
      onProgress: (p) => progress.push(p.completed),
    })
    expect(result.files).toEqual(['《妖神记》 作者：踏雪动漫.epub'])
    expect(result.totalImages).toBe(10) // 5 章 * 2 图
    expect(result.failedImages).toEqual([])
    expect(progress).toEqual([1, 2, 3, 4, 5])
    expect(clicks).toEqual(['《妖神记》 作者：踏雪动漫.epub'])
  })

  it('分卷：按 volumeSize 切成多个 EPUB，文件名带卷第', async () => {
    const result = await exportComicEpubToLocal({
      book: comicBook,
      chapters,
      volumeSize: 2, // 5 章 -> 3 卷（2+2+1）
      fetchImage,
    })
    expect(result.files).toEqual([
      '《妖神记》 作者：踏雪动漫 第1卷.epub',
      '《妖神记》 作者：踏雪动漫 第2卷.epub',
      '《妖神记》 作者：踏雪动漫 第3卷.epub',
    ])
    expect(result.totalImages).toBe(10)
    expect(clicks).toHaveLength(3)
  })

  it('取消后不产出文件', async () => {
    const signal = { cancelled: false }
    vi.mocked(getBookContent).mockImplementation(async ({ chapterUrl }) => {
      signal.cancelled = true
      return `<img src="${chapterUrl}/1.jpg" />`
    })
    const result = await exportComicEpubToLocal({
      book: comicBook, chapters, fetchImage, signal,
    })
    expect(result.files).toEqual([])
    expect(clicks).toEqual([])
  })

  it('实时拉取目录（未传 chapters）', async () => {
    const { getChapterList } = await import('../api/bookshelf')
    vi.mocked(getChapterList).mockResolvedValue(chapters)
    const result = await exportComicEpubToLocal({ book: comicBook, fetchImage })
    expect(getChapterList).toHaveBeenCalledTimes(1)
    expect(result.files).toHaveLength(1)
  })
})
