import { describe, expect, it, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import {
  buildComicEpub,
  buildImageProxyUrl,
  extractImageUrls,
  isComicBook,
  isComicContent,
  type ComicChapter,
} from './epubExport'

const img = (url: string) => `<img src="${url}" />`

describe('extractImageUrls', () => {
  it('按顺序提取 img src，忽略单双引号差异', () => {
    const html = `<p>${img('https://a/1.jpg')}<img src='https://a/2.png'><img alt=x src="https://a/3.webp"></p>`
    expect(extractImageUrls(html)).toEqual([
      'https://a/1.jpg',
      'https://a/2.png',
      'https://a/3.webp',
    ])
  })

  it('忽略音视频直链', () => {
    const html = `${img('https://a/v.mp4')}${img('https://a/1.jpg')}`
    expect(extractImageUrls(html)).toEqual(['https://a/1.jpg'])
  })
})

describe('isComicContent / isComicBook', () => {
  it('多图少字判定为漫画章', () => {
    const html = `${img('https://a/1.jpg')}${img('https://a/2.jpg')}${img('https://a/3.jpg')}`
    expect(isComicContent(html)).toBe(true)
  })

  it('纯文字章不是漫画', () => {
    expect(isComicContent('<p>这是一段很长的正文文字内容</p>')).toBe(false)
  })

  it('大量文字配少量图不是漫画', () => {
    const html = `${img('https://a/1.jpg')}<p>${'字'.repeat(200)}</p>`
    expect(isComicContent(html)).toBe(false)
  })

  it('整本书漫画章过半即判定漫画书', () => {
    const chapters: ComicChapter[] = [
      { title: '1', content: `${img('https://a/1.jpg')}${img('https://a/2.jpg')}` },
      { title: '2', content: `${img('https://a/3.jpg')}${img('https://a/4.jpg')}` },
      { title: '3', content: '<p>纯文字章节</p>' },
    ]
    expect(isComicBook(chapters)).toBe(true)
  })
})

describe('buildImageProxyUrl', () => {
  it('带上鉴权参数与书源、目标URL', () => {
    const storage = { getItem: (k: string) => (k === 'accessToken' ? 'tok' : null) }
    const url = buildImageProxyUrl('https://img/1.jpg', 'src-1', 'https://host', storage)
    expect(url.startsWith('https://host/reader3/bookSourceProxy?')).toBe(true)
    const q = new URL(url).searchParams
    expect(q.get('url')).toBe('https://img/1.jpg')
    expect(q.get('bookSourceUrl')).toBe('src-1')
    expect(q.get('accessToken')).toBe('tok')
  })
})

describe('buildComicEpub', () => {
  const fetchImage = vi.fn(async (_url: string) => new Uint8Array([1, 2, 3]))

  it('打包出标准 EPUB 结构，图片内嵌，metadata 含书名作者简介', async () => {
    const chapters: ComicChapter[] = [
      {
        title: '第1话',
        content: `${img('https://a/1.jpg')}${img('https://a/2.jpg')}`,
      },
      { title: '第2话', content: `${img('https://a/3.jpg')}` },
    ]
    const result = await buildComicEpub({
      name: '妖神记',
      author: '踏雪动漫',
      intro: '妖灵世界',
      chapters,
      fetchImage,
    })

    expect(result.failedImages).toEqual([])
    expect(result.totalImages).toBe(3)
    const files = unzipSync(result.bytes)
    const names = Object.keys(files)

    // mimetype 首条目且不压缩
    expect(names[0]).toBe('mimetype')
    expect(strFromU8(files['mimetype'])).toBe('application/epub+zip')
    expect(names).toContain('META-INF/container.xml')
    expect(names).toContain('OEBPS/content.opf')
    expect(names).toContain('OEBPS/nav.xhtml')
    expect(names).toContain('OEBPS/toc.ncx')

    const opf = strFromU8(files['OEBPS/content.opf'])
    expect(opf).toContain('<dc:title>妖神记</dc:title>')
    expect(opf).toContain('<dc:creator>踏雪动漫</dc:creator>')
    expect(opf).toContain('<dc:description>妖灵世界</dc:description>')
    expect(opf).toContain('properties="nav"')
    // 闭环关键：图片必须在 manifest 中声明为 image/*，否则重新导入 XRead 时会被丢弃
    expect(opf).toContain('href="Images/00001.jpg" media-type="image/jpeg"')
    expect((opf.match(/media-type="image\//g) || []).length).toBe(3)

    // 3 张图片内嵌，章节 2 个
    expect(names.filter((n) => n.startsWith('OEBPS/Images/'))).toHaveLength(3)
    expect(names.filter((n) => /OEBPS\/Text\/ch\d+\.xhtml/.test(n))).toHaveLength(2)

    const ch0 = strFromU8(files['OEBPS/Text/ch0000.xhtml'])
    expect(ch0).toContain('第1话')
    expect(ch0).toContain('src="../Images/00001.jpg"')
  })

  it('图片下载失败时保留远程链接占位并记录失败清单', async () => {
    const failFetch = vi.fn(async (url: string) => {
      if (url.includes('bad')) throw new Error('fail')
      return new Uint8Array([9])
    })
    const result = await buildComicEpub({
      name: '测试',
      author: '',
      chapters: [
        {
          title: '第1话',
          content: `${img('https://a/good.jpg')}${img('https://a/bad.jpg')}`,
        },
      ],
      fetchImage: failFetch,
    })
    expect(result.failedImages).toEqual(['https://a/bad.jpg'])
    const files = unzipSync(result.bytes)
    const ch0 = strFromU8(files['OEBPS/Text/ch0000.xhtml'])
    expect(ch0).toContain('src="../Images/00001.jpg"')
    expect(ch0).toContain('src="https://a/bad.jpg"')
    expect(Object.keys(files).filter((n) => n.startsWith('OEBPS/Images/'))).toHaveLength(1)
  })

  it('取消后返回空字节与空字节标记', async () => {
    const signal = { cancelled: false }
    const cancelFetch = vi.fn(async () => {
      signal.cancelled = true
      return new Uint8Array([1])
    })
    const result = await buildComicEpub({
      name: '测试',
      author: '',
      chapters: [{ title: '1', content: `${img('https://a/1.jpg')}${img('https://a/2.jpg')}` }],
      signal,
      fetchImage: cancelFetch,
    })
    expect(result.bytes.length).toBe(0)
  })

  it('逐章进度回调', async () => {
    const progress: number[] = []
    await buildComicEpub({
      name: '测试',
      author: '',
      chapters: [
        { title: '1', content: `${img('https://a/1.jpg')}` },
        { title: '2', content: `${img('https://a/2.jpg')}` },
      ],
      fetchImage,
      onProgress: (c) => progress.push(c),
    })
    expect(progress).toEqual([1, 2])
  })

  it('图片阶段进度从 0 递增到总数，并先于打包阶段', async () => {
    const phases: string[] = []
    const imageProgress: number[] = []
    await buildComicEpub({
      name: '测试',
      author: '',
      chapters: [
        { title: '1', content: `${img('https://a/1.jpg')}${img('https://a/2.jpg')}` },
      ],
      fetchImage,
      onPhase: (p) => phases.push(p),
      onImageProgress: (c) => imageProgress.push(c),
    })
    expect(phases).toEqual(['download', 'pack'])
    expect(imageProgress[0]).toBe(0)
    expect(imageProgress[imageProgress.length - 1]).toBe(2)
  })

  it('同一图片 URL 跨章只下载一次', async () => {
    const countedFetch = vi.fn(async () => new Uint8Array([1]))
    const result = await buildComicEpub({
      name: '测试',
      author: '',
      chapters: [
        { title: '1', content: `${img('https://a/same.jpg')}` },
        { title: '2', content: `${img('https://a/same.jpg')}` },
      ],
      fetchImage: countedFetch,
    })
    expect(countedFetch).toHaveBeenCalledTimes(1)
    // 两章各引用一次，包内仍内嵌两张（按章节出现顺序命名）
    expect(result.totalImages).toBe(1)
    const files = unzipSync(result.bytes)
    expect(Object.keys(files).filter((n) => n.startsWith('OEBPS/Images/'))).toHaveLength(2)
  })

  it('并发下载图片（同时发起超过 1 个请求）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const urls = Array.from({ length: 8 }, (_, i) => `https://a/${i}.jpg`)
    const concurrentFetch = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return new Uint8Array([1])
    })
    await buildComicEpub({
      name: '测试',
      author: '',
      chapters: [{ title: '1', content: urls.map(img).join('') }],
      fetchImage: concurrentFetch,
    })
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('多张图片失败时清单顺序稳定（按 URL 首次出现顺序）', async () => {
    const failFetch = vi.fn(async (url: string) => {
      if (url.includes('bad')) throw new Error('fail')
      return new Uint8Array([1])
    })
    const result = await buildComicEpub({
      name: '测试',
      author: '',
      chapters: [
        {
          title: '1',
          content: `${img('https://a/bad1.jpg')}${img('https://a/ok.jpg')}${img('https://a/bad2.jpg')}`,
        },
      ],
      fetchImage: failFetch,
    })
    expect(result.failedImages).toEqual(['https://a/bad1.jpg', 'https://a/bad2.jpg'])
  })
})
