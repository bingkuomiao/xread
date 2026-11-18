import { describe, expect, it, vi } from 'vitest'
import { runDeepTest, type DeepTestDeps } from './sourceDeepTest'
import type { SearchBook, Book, BookChapter } from '../types'

const SOURCE = 'https://novel.example'
const books: SearchBook[] = [
  { name: '测试书', author: '作者', bookUrl: 'https://novel.example/book/1', origin: SOURCE },
]
const infoBook: Book = {
  name: '测试书',
  author: '作者',
  bookUrl: 'https://novel.example/book/1',
  origin: SOURCE,
}
const chapters: BookChapter[] = [
  { title: '第一章', url: 'https://novel.example/book/1/1', index: 0 },
  { title: '第二章', url: 'https://novel.example/book/1/2', index: 1 },
]

function makeDeps(overrides: Partial<DeepTestDeps> = {}): DeepTestDeps {
  return {
    search: vi.fn(async () => books),
    info: vi.fn(async () => infoBook),
    toc: vi.fn(async () => chapters),
    content: vi.fn(async () => '这是小说正文内容，用来验证非空。'.repeat(4)),
    ...overrides,
  }
}

describe('runDeepTest', () => {
  it('四步全部成功：overall=pass、ok=true、4 个 pass 步骤', async () => {
    const deps = makeDeps()
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps)

    expect(r.overall).toBe('pass')
    expect(r.ok).toBe(true)
    expect(r.skipped).toBe(false)
    expect(r.steps.map((s) => s.key)).toEqual(['search', 'info', 'toc', 'content'])
    expect(r.steps.every((s) => s.status === 'pass')).toBe(true)
    expect(r.chapterCount).toBe(2)
    expect(r.contentLength).toBeGreaterThan(10)
    expect(deps.toc).toHaveBeenCalledWith({
      bookUrl: 'https://novel.example/book/1',
      bookSourceUrl: SOURCE,
    })
    expect(deps.content).toHaveBeenCalledWith({
      chapterUrl: chapters[0].url,
      bookSourceUrl: SOURCE,
    })
  })

  it('搜索无匹配：记为 skip，不算失败，且不再请求目录/正文', async () => {
    const deps = makeDeps({ search: vi.fn(async () => []) })
    const r = await runDeepTest(SOURCE, '冷门关键词', deps)

    expect(r.overall).toBe('skip')
    expect(r.skipped).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].status).toBe('skip')
    expect(deps.toc).not.toHaveBeenCalled()
    expect(deps.content).not.toHaveBeenCalled()
  })

  it('目录仅 1 章：warn 但仍继续测正文，overall=warn、ok=true', async () => {
    const deps = makeDeps({ toc: vi.fn(async () => [chapters[0]]) })
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps)

    expect(r.steps.find((s) => s.key === 'toc')?.status).toBe('warn')
    expect(r.steps.find((s) => s.key === 'content')?.status).toBe('pass')
    expect(r.overall).toBe('warn')
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
  })

  it('正文为空：判 fail（抓「有目录没内容」）', async () => {
    const deps = makeDeps({ content: vi.fn(async () => '') })
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps)

    expect(r.steps.find((s) => s.key === 'content')?.status).toBe('fail')
    expect(r.overall).toBe('fail')
    expect(r.ok).toBe(false)
  })

  it('搜索抛错：fail，链路中止', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => {
        throw new Error('网络错误')
      }),
    })
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps)

    expect(r.overall).toBe('fail')
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].detail).toContain('网络错误')
    expect(deps.info).not.toHaveBeenCalled()
  })

  it('目录为空：判 fail', async () => {
    const deps = makeDeps({ toc: vi.fn(async () => []) })
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps)
    expect(r.overall).toBe('fail')
    expect(r.steps.find((s) => s.key === 'toc')?.status).toBe('fail')
  })

  it('详情失败只记 warn，仍用搜索结果 bookUrl 继续测目录/正文', async () => {
    const deps = makeDeps({
      info: vi.fn(async () => {
        throw new Error('详情规则错误')
      }),
    })
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps)

    expect(r.steps.find((s) => s.key === 'info')?.status).toBe('warn')
    expect(r.overall).toBe('warn')
    expect(r.ok).toBe(true)
    expect(deps.toc).toHaveBeenCalledWith({
      bookUrl: books[0].bookUrl,
      bookSourceUrl: SOURCE,
    })
  })

  it('单步超时：判 fail 且不会永久挂起', async () => {
    const deps = makeDeps({
      search: vi.fn(() => new Promise<SearchBook[]>(() => {})),
    })
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps, { stepTimeoutMs: 20 })

    expect(r.overall).toBe('fail')
    expect(r.steps[0].detail).toContain('超时')
  })

  it('开始前已取消：一步都不发，返回 cancelled', async () => {
    const deps = makeDeps()
    const controller = new AbortController()
    controller.abort()
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps, { signal: controller.signal })

    expect(r.cancelled).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe(false)
    expect(deps.search).not.toHaveBeenCalled()
    expect(deps.info).not.toHaveBeenCalled()
    expect(deps.toc).not.toHaveBeenCalled()
    expect(deps.content).not.toHaveBeenCalled()
  })

  it('链路中途取消：立即停下，不再发起后续步骤', async () => {
    const controller = new AbortController()
    const deps = makeDeps({
      // 详情阶段触发取消，目录/正文都不应再请求
      info: vi.fn(async () => {
        controller.abort()
        return infoBook
      }),
    })
    const r = await runDeepTest(SOURCE, '斗破苍穹', deps, { signal: controller.signal })

    expect(r.cancelled).toBe(true)
    expect(r.ok).toBe(false)
    expect(deps.search).toHaveBeenCalledTimes(1)
    expect(deps.info).toHaveBeenCalledTimes(1)
    expect(deps.toc).not.toHaveBeenCalled()
    expect(deps.content).not.toHaveBeenCalled()
  })

  it('挂起中的步骤被取消：不等超时立即返回 cancelled', async () => {
    const controller = new AbortController()
    const deps = makeDeps({
      search: vi.fn(() => new Promise<SearchBook[]>(() => {})),
    })
    const promise = runDeepTest(SOURCE, '斗破苍穹', deps, {
      stepTimeoutMs: 10000,
      signal: controller.signal,
    })
    controller.abort()
    const r = await promise

    expect(r.cancelled).toBe(true)
    expect(r.ok).toBe(false)
    expect(deps.info).not.toHaveBeenCalled()
    expect(deps.toc).not.toHaveBeenCalled()
    expect(deps.content).not.toHaveBeenCalled()
  })

  it('漫画源正文是 <img> 标签：按图片数判可用，不卡正文长度', async () => {
    // 漫画正文通常是 <img src> 拼接，长度可能不长，但含图片即视为正常渲染
    const imgContent =
      '<img src="https://img.example/1.jpg"><img src="https://img.example/2.jpg">'
    const deps = makeDeps({ content: vi.fn(async () => imgContent) })
    const r = await runDeepTest(SOURCE, '海贼王', deps)

    expect(r.overall).toBe('pass')
    expect(r.ok).toBe(true)
    expect(r.imageCount).toBe(2)
    const contentStep = r.steps.find((s) => s.key === 'content')
    expect(contentStep?.status).toBe('pass')
    expect(contentStep?.detail).toContain('图片 2 张')
  })

  it('漫画源正文为空（无 <img>）：仍判 fail', async () => {
    const deps = makeDeps({ content: vi.fn(async () => '') })
    const r = await runDeepTest(SOURCE, '海贼王', deps)
    expect(r.steps.find((s) => s.key === 'content')?.status).toBe('fail')
    expect(r.overall).toBe('fail')
  })
})
