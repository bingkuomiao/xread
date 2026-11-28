import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, BookChapter } from '../types'

vi.mock('../api/bookshelf', () => ({
  getChapterList: vi.fn(),
  getBookContent: vi.fn(),
  exportLocalBookText: vi.fn(),
}))

import { getChapterList, getBookContent, exportLocalBookText } from '../api/bookshelf'
import { buildExportHeader, exportBookToLocal, normalizeContent } from './exportBook'
import { buildStorageFileName } from './localBook'

const networkBook = {
  name: '皇明',
  author: '雨落见愁',
  intro: '一部历史小说',
  bookUrl: 'https://source.example/book/1',
  origin: 'source-1',
} as Book

const localTxtBook = {
  name: '三国之蜀汉我做主',
  author: '三七开',
  bookUrl: 'local-txt:abc123',
  origin: 'local-txt',
} as Book

const localBook = {
  name: '五行元灵',
  author: '血友人生',
  intro: '一场修仙奇缘',
  bookUrl: 'local-txt:def456',
  origin: 'local-txt',
} as Book

const chapters: BookChapter[] = [
  { title: '序章', url: 'https://source.example/book/1#0', index: 0 },
  { title: '第一章', url: 'https://source.example/book/1#1', index: 1 },
]

let clicks: string[] = []
let blobs: string[][] = []

/** 在 node 环境构造最小 DOM 下载桩。 */
function stubDom() {
  clicks = []
  blobs = []
  const makeAnchor = () => ({
    href: '',
    download: '',
    target: '',
    rel: '',
    click() { clicks.push(this.download) },
    setAttribute() {},
  })
  const doc = {
    createElement: (tag: string) => (tag === 'a' ? makeAnchor() : {}),
    body: { appendChild() {}, removeChild() {} },
  }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('Blob', class {
    parts: unknown[]
    constructor(parts: unknown[]) {
      this.parts = parts
      blobs.push(parts as string[])
    }
  })
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:stub',
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('window', { setTimeout: () => 0 })
}

describe('buildExportHeader', () => {
  it('书名用书名号、作者带前缀、简介另起一段并带「简介：」前缀，且清洗 HTML', () => {
    const header = buildExportHeader({
      name: '皇明',
      author: '雨落见愁',
      intro: '<p>一部<b>历史</b>小说</p>',
    } as Book)
    expect(header).toBe('《皇明》\n作者：雨落见愁\n\n简介：一部历史小说')
  })

  it('无作者、无简介时只有书名', () => {
    expect(buildExportHeader({ name: '皇明', author: '' } as Book)).toBe('《皇明》')
  })

  it('includeIntro=false 时只输出书名/作者', () => {
    expect(buildExportHeader(networkBook, { includeIntro: false })).toBe('《皇明》\n作者：雨落见愁')
  })

  it('书名/作者自带书名号时被剥离，不出现《《书名》》', () => {
    const header = buildExportHeader({
      name: '《三国之宅行天下》',
      author: '《贱宗首席弟子》',
      intro: '简介：正文简介',
    } as Book)
    expect(header).toBe('《三国之宅行天下》\n作者：贱宗首席弟子\n\n简介：正文简介')
  })

  it('简介自带「内容简介：/简要介绍：」标签时先去掉再加统一「简介：」前缀', () => {
    expect(buildExportHeader({ name: 'X', intro: '内容简介：一段内容' } as Book)).toBe('《X》\n\n简介：一段内容')
    expect(buildExportHeader({ name: 'X', intro: '简要介绍：另一段' } as Book)).toBe('《X》\n\n简介：另一段')
  })
})

describe('normalizeContent（网络书正文 HTML 清洗）', () => {
  it('去标签、解码实体、<br>/<p> 转换行', () => {
    const html = '<div class="txt"><p>&nbsp;&nbsp;第一段文字。</p><p>第二段<br>接一行。</p></div>'
    expect(normalizeContent(html)).toBe('第一段文字。\n第二段\n接一行。')
  })

  it('双重转义的 &lt;br&gt; / &amp;nbsp; 也清洗干净（图3场景）', () => {
    const html = '<p data-id="6">&amp;nbsp;&amp;nbsp;刘备曰&lt;br&gt;随后闭目。</p>'
    const out = normalizeContent(html)
    expect(out).not.toContain('&')
    expect(out).not.toContain('<')
    expect(out).not.toContain('>')
    expect(out).toContain('刘备曰')
    expect(out).toContain('随后闭目。')
  })

  it('已是纯文本时保持原样（正常换行保留）', () => {
    expect(normalizeContent('第一行\n第二行')).toBe('第一行\n第二行')
  })
})

describe('exportBookToLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubDom()
  })

  it('本地 TXT：移除原文件开头不规范书头行，用规范书头替代，不重复', async () => {
    const originalText = '五行元灵 作者：血友人生\n\n===================\n更多精校小说 http://www.xs88.com/\n===================\n\n【第001章】开篇\n正文内容'
    vi.mocked(exportLocalBookText).mockResolvedValue({ text: originalText, storedName: 'x.txt' })
    const result = await exportBookToLocal({ book: localBook })

    expect(result.fileName).toBe('《五行元灵》 作者：血友人生.txt')
    expect(result.total).toBe(1)
    expect(exportLocalBookText).toHaveBeenCalledWith('local-txt:def456')
    expect(getChapterList).not.toHaveBeenCalled()
    expect(getBookContent).not.toHaveBeenCalled()
    const exported = blobs[0][1]
    // 顶部规范书头（含带「简介：」前缀的简介，原文件无「简介：」段）
    expect(exported.startsWith('《五行元灵》\n作者：血友人生\n\n简介：一场修仙奇缘\n\n')).toBe(true)
    // 原文件那行不规范书头被删除，不重复出现「作者：血友人生」两次
    expect(exported.match(/血友人生/g)).toHaveLength(1) // 仅规范书头 1 次，原不规范行已删除
    expect(exported).not.toContain('五行元灵 作者：血友人生')
    expect(exported).toContain('【第001章】开篇\n正文内容')
    expect(exported).not.toContain('序章')
  })

  it('本地 TXT：原文件用「简要介绍：」标签时书头也不重复加简介', async () => {
    const originalText = '《三国之蜀汉我做主》\n作者：三七开\n简要介绍：这是一本关于三国的小说\n\n第一章 开篇\n正文内容'
    vi.mocked(exportLocalBookText).mockResolvedValue({ text: originalText, storedName: 'x.txt' })
    await exportBookToLocal({ book: localTxtBook })
    const exported = blobs[0][1]
    expect(exported.startsWith('《三国之蜀汉我做主》\n作者：三七开\n\n')).toBe(true)
    expect(exported.split('\n').slice(0, 4).join('\n')).not.toContain('简介：')
    expect(exported.match(/这是一本关于三国的小说/g)).toHaveLength(1)
  })

  it('本地 TXT：原文件已带简介段落时，书头不再添加简介，避免重复', async () => {
    const originalText = '《三国之蜀汉我做主》\n作者：三七开\n简介：这是一本关于三国的小说\n\n第一章 开篇\n正文内容'
    vi.mocked(exportLocalBookText).mockResolvedValue({ text: originalText, storedName: 'x.txt' })
    await exportBookToLocal({ book: localTxtBook })
    const exported = blobs[0][1]
    // 书头只放书名/作者，不含「简介」标签段
    expect(exported.startsWith('《三国之蜀汉我做主》\n作者：三七开\n\n')).toBe(true)
    expect(exported.split('\n').slice(0, 3).join('\n')).not.toContain('简介')
    // 原文件自带的简介段保留在正文中（只出现一次）
    expect(exported.match(/这是一本关于三国的小说/g)).toHaveLength(1)
  })

  it('本地 TXT：正文句子中出现书名不会被误删书头', async () => {
    const originalText = '【序章】\n话说三国之蜀汉我做主的往事，源远流长。\n正文内容'
    vi.mocked(exportLocalBookText).mockResolvedValue({ text: originalText, storedName: 'x.txt' })
    await exportBookToLocal({ book: localTxtBook })
    const exported = blobs[0][1]
    expect(exported).toContain('话说三国之蜀汉我做主的往事，源远流长。')
  })

  it('网络书：规范书头 + 每章插入章节标题', async () => {
    vi.mocked(getBookContent)
      .mockResolvedValueOnce('正文内容一')
      .mockResolvedValueOnce('正文内容二')
    const progress: number[] = []
    const result = await exportBookToLocal({
      book: networkBook,
      chapters,
      onProgress: (p) => progress.push(p.completed),
    })

    expect(result.total).toBe(2)
    expect(result.fileName).toBe('《皇明》 作者：雨落见愁.txt')
    expect(progress).toEqual([1, 2])
    expect(getBookContent).toHaveBeenCalledTimes(2)
    // 导出必须显式传 bookUrl，后端才能用正确 key 命中服务端缓存（不靠反查）
    expect(getBookContent).toHaveBeenCalledWith({
      chapterUrl: chapters[0].url,
      bookUrl: networkBook.bookUrl,
      bookSourceUrl: networkBook.origin,
    })
    const exported = blobs[0][1]
    expect(exported).toBe('《皇明》\n作者：雨落见愁\n\n简介：一部历史小说\n\n序章\n\n正文内容一\n\n第一章\n\n正文内容二')
  })

  it('首章复用预取正文：不再重复请求第一章', async () => {
    vi.mocked(getBookContent).mockResolvedValueOnce('第二章正文')
    await exportBookToLocal({
      book: networkBook,
      chapters,
      firstChapterContent: '预取的首章正文',
    })
    // 只请求了第 2 章；第 1 章复用了预取内容
    expect(getBookContent).toHaveBeenCalledTimes(1)
    expect(getBookContent).toHaveBeenCalledWith({
      chapterUrl: chapters[1].url,
      bookUrl: networkBook.bookUrl,
      bookSourceUrl: networkBook.origin,
    })
    const exported = blobs[0][1]
    expect(exported).toContain('预取的首章正文')
    expect(exported).toContain('第二章正文')
  })

  it('网络书：正文开头已自带同名章节标题时不重复插入', async () => {
    vi.mocked(getBookContent)
      .mockResolvedValueOnce('序章 从这里开始\n正文自带标题内容')
      .mockResolvedValueOnce('第一章\n正文二')
    await exportBookToLocal({ book: networkBook, chapters })
    const exported = blobs[0][1]
    // 「序章」正文首行含标题 → 不重复插入；「第一章」首行=标题 → 也不重复
    expect(exported.match(/序章/g)?.length).toBe(1)
    expect(exported.match(/第一章/g)?.length).toBe(1)
    expect(exported).toContain('正文自带标题内容')
  })

  it('无作者时文件名为《书名》.txt', () => {
    expect(buildStorageFileName('皇明', '')).toBe('《皇明》.txt')
  })

  it('书名/作者自带书名号时文件名不出现重复书名号', () => {
    expect(buildStorageFileName('《三国之宅行天下》', '贱宗首席弟子')).toBe('《三国之宅行天下》 作者：贱宗首席弟子.txt')
    expect(buildStorageFileName('《皇明》', '《雨落见愁》')).toBe('《皇明》 作者：雨落见愁.txt')
  })

  it('支持中途取消', async () => {
    vi.mocked(getBookContent).mockResolvedValue('正文')
    const signal = { cancelled: false }
    const result = await exportBookToLocal({
      book: networkBook,
      chapters,
      signal,
      onProgress: (p) => {
        if (p.completed === 1) signal.cancelled = true
      },
    })
    expect(result.completed).toBe(1)
    expect(result.fileName).toBe('')
    expect(getBookContent).toHaveBeenCalledTimes(1)
    expect(clicks).toEqual([])
  })

  it('章节为空时实时拉取目录', async () => {
    vi.mocked(getChapterList).mockResolvedValue(chapters)
    vi.mocked(getBookContent).mockResolvedValue('正文')
    const result = await exportBookToLocal({ book: networkBook })
    expect(getChapterList).toHaveBeenCalledTimes(1)
    expect(result.total).toBe(2)
    expect(result.fileName).toBe('《皇明》 作者：雨落见愁.txt')
  })
})
