import type { SearchBook, Book, BookChapter } from '../types'

// ─── 书源深度链路测试 ───────────────────────────────────────────────────
// 现有「测试书源」只测搜索/发现两步，而兼容性问题（有目录没内容、目录退化
// 1 章、正文为空）都藏在「详情→目录→正文」这一层。本模块用前端已有的 4 个
// 接口编排完整链路，纯前端实现，无需改动后端。
//
// 关键：搜索「无匹配」不等于源不兼容（可能只是关键词没命中），记为 skip，
// 不判失败，避免像书源批量测试那样误伤正常源。

export type DeepStepStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type DeepStepKey = 'search' | 'info' | 'toc' | 'content'

export interface DeepTestStep {
  key: DeepStepKey
  label: string
  status: DeepStepStatus
  detail: string
  ms: number
}

export interface DeepTestResult {
  overall: DeepStepStatus
  ok: boolean // 链路跑通且无致命失败（warn 允许、skip 不算）
  skipped: boolean
  // 中途取消（点停止 / 关闭弹窗）：链路未跑完，调用方不展示、也不写入分组
  cancelled?: boolean
  steps: DeepTestStep[]
  bookName?: string
  chapterCount?: number
  contentLength?: number
  // 正文里的图片数量（漫画/图片源），用于把「图片 N 张」作为可用判据
  imageCount?: number
}

export interface DeepTestDeps {
  search: (keyword: string, sourceUrl: string) => Promise<SearchBook[]>
  info: (bookUrl: string, sourceUrl: string) => Promise<Book>
  toc: (params: { bookUrl: string; bookSourceUrl: string }) => Promise<BookChapter[]>
  content: (params: { chapterUrl: string; bookSourceUrl: string }) => Promise<string>
}

export interface DeepTestOptions {
  // 单步超时（毫秒），默认 20s；避免某个挂起的站点把整个链路拖死
  stepTimeoutMs?: number
  // 正文短于该长度视为「空/异常」，默认 10
  minContentLength?: number
  // 中断信号：abort 后立即停下当前链路，不再发起后续步骤，也不返回有效结论
  signal?: AbortSignal
}

const STEP_LABELS: Record<DeepStepKey, string> = {
  search: '搜索',
  info: '详情',
  toc: '目录',
  content: '正文',
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`步骤超时 ${ms}ms`)), ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('已取消', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err) => {
        cleanup()
        reject(err)
      },
    )
  })
}

export async function runDeepTest(
  sourceUrl: string,
  keyword: string,
  deps: DeepTestDeps,
  options: DeepTestOptions = {},
): Promise<DeepTestResult> {
  const timeout = options.stepTimeoutMs ?? 20000
  const minContent = options.minContentLength ?? 10
  const signal = options.signal
  const steps: DeepTestStep[] = []
  let hasWarn = false
  const result: DeepTestResult = { overall: 'pass', ok: false, skipped: false, steps }

  // 取消/关闭弹窗时立即停下：返回 cancelled 结果，调用方据此不展示、不写分组。
  const isCancelled = () => !!signal?.aborted
  const cancelled = (): DeepTestResult => ({
    overall: 'skip', ok: false, skipped: false, cancelled: true, steps: [...steps],
  })

  function push(key: DeepStepKey, status: DeepStepStatus, detail: string, ms: number) {
    steps.push({ key, label: STEP_LABELS[key], status, detail, ms })
    if (status === 'warn') hasWarn = true
  }

  async function exec<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: string | null; ms: number }> {
    const t0 = Date.now()
    try {
      const value = await withTimeout(fn(), timeout, signal)
      return { value, error: null, ms: Date.now() - t0 }
    } catch (e: unknown) {
      // 中断导致的 reject 不算步骤失败，交给上层的 isCancelled() 统一处理
      if (isCancelled()) return { value: null, error: null, ms: Date.now() - t0 }
      return { value: null, error: (e as Error)?.message || String(e), ms: Date.now() - t0 }
    }
  }

  function finish(overall: DeepStepStatus): DeepTestResult {
    result.overall = overall
    result.skipped = overall === 'skip'
    result.ok = overall === 'pass' || overall === 'warn'
    return result
  }

  // 开始前已取消：一步都不发
  if (isCancelled()) return cancelled()

  // 1. 搜索
  const s1 = await exec(() => deps.search(keyword, sourceUrl))
  if (isCancelled()) return cancelled()
  if (s1.error) {
    push('search', 'fail', `请求失败：${s1.error}`, s1.ms)
    return finish('fail')
  }
  const books = s1.value ?? []
  if (!books.length) {
    push('search', 'skip', '无匹配（可换关键词重试，不代表源不兼容）', s1.ms)
    return finish('skip')
  }
  const first = books[0]
  result.bookName = first.name
  push('search', 'pass', `命中 ${books.length} 本，取《${first.name || first.bookUrl}》`, s1.ms)

  // 2. 详情（失败不致命：仍可用搜索结果的 bookUrl 继续）
  const s2 = await exec(() => deps.info(first.bookUrl, sourceUrl))
  if (isCancelled()) return cancelled()
  if (s2.error) {
    push('info', 'warn', `详情解析失败：${s2.error}，继续用搜索结果测目录/正文`, s2.ms)
  } else {
    push('info', 'pass', '详情解析成功', s2.ms)
  }
  const info = s2.value
  const bookUrl = info?.tocUrl || info?.bookUrl || first.bookUrl

  // 3. 目录
  const s3 = await exec(() => deps.toc({ bookUrl, bookSourceUrl: sourceUrl }))
  if (isCancelled()) return cancelled()
  if (s3.error) {
    push('toc', 'fail', `目录请求失败：${s3.error}`, s3.ms)
    return finish('fail')
  }
  const chapters = s3.value ?? []
  result.chapterCount = chapters.length
  if (!chapters.length) {
    push('toc', 'fail', '目录为空（ruleToc 规则可能不兼容）', s3.ms)
    return finish('fail')
  }
  if (chapters.length === 1) {
    push('toc', 'warn', '目录仅 1 章（疑似 @tag 链 / 规则退化），继续测正文', s3.ms)
  } else {
    push('toc', 'pass', `共 ${chapters.length} 章`, s3.ms)
  }

  // 4. 正文（第一章）
  const s4 = await exec(() =>
    deps.content({ chapterUrl: chapters[0].url, bookSourceUrl: sourceUrl }),
  )
  if (isCancelled()) return cancelled()
  if (s4.error) {
    push('content', 'fail', `正文请求失败：${s4.error}`, s4.ms)
    return finish('fail')
  }
  const content = (s4.value ?? '').trim()
  result.contentLength = content.length
  const imgCount = (content.match(/<img/gi) || []).length
  result.imageCount = imgCount
  if (imgCount > 0) {
    // 漫画/图片源：正文是 <img> 标签，按图片数判可用，不卡正文长度
    push('content', 'pass', `图片 ${imgCount} 张`, s4.ms)
  } else if (content.length < minContent) {
    push('content', 'fail', '正文为空或过短（「有目录没内容」）', s4.ms)
    return finish('fail')
  } else {
    push('content', 'pass', `正文 ${content.length} 字`, s4.ms)
  }

  return finish(hasWarn ? 'warn' : 'pass')
}
