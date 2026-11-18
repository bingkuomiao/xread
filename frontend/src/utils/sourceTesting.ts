import type { BookSourceTestResponse } from '../types'

export const MAX_SOURCE_TEST_BATCH_SIZE = 100

export function chunkBookSourceUrls(
  urls: string[],
  batchSize = MAX_SOURCE_TEST_BATCH_SIZE
) {
  if (batchSize < 1) {
    throw new Error('batchSize must be greater than 0')
  }
  const chunks: string[][] = []
  for (let index = 0; index < urls.length; index += batchSize) {
    chunks.push(urls.slice(index, index + batchSize))
  }
  return chunks
}

export function mergeBookSourceTestResponses(
  responses: BookSourceTestResponse[]
): BookSourceTestResponse {
  return responses.reduce<BookSourceTestResponse>(
    (merged, response) => ({
      total: merged.total + response.total,
      valid: merged.valid + response.valid,
      invalid: merged.invalid + response.invalid,
      markedInvalid: merged.markedInvalid + response.markedInvalid,
      results: merged.results.concat(response.results),
    }),
    {
      total: 0,
      valid: 0,
      invalid: 0,
      markedInvalid: 0,
      results: [],
    }
  )
}

// ─── 超时自适应细分（递归二分） ───────────────────────────────────────────
// 后端 /testBookSources 会等一批里所有源测完才返回；单个源的 search+explore 是
// 串行多次请求，只要有一个站点挂起（或几个慢源累积），整批就可能触发前端 HTTP
// 超时。旧逻辑超时只拆一层（10→5+5），含慢源的那半仍超时就被整体标记「失效」，
// 误伤同批正常源。
//
// 这里改为递归二分到底：正常批一次成功、不拆分；仅超时分支继续对半拆，直到把
// 慢源隔离成单源。只有「单独测试仍超时」的源才进 timeoutUrls 标记失效 —— 正常
// 源一定会落在某个不含慢源的子批里按真实结果返回，因此不会被误伤。等价于用户
// 说的「超时就一个个测」+「二分法」的结合，且比整批改串行逐个测高效得多。
export interface BisectTestOutcome<T> {
  responses: T[]
  timeoutUrls: string[]
  untestedUrls: string[]
}

export interface BisectTestOptions<T> {
  // 发一批请求；由调用方注入，便于在测试里 mock 超时行为
  request: (urls: string[]) => Promise<T>
  // 判定是否为前端 HTTP 超时（axios 专有文案），避免把业务错误误判为超时
  isTimeout: (e: unknown) => boolean
  // 单源超时后再单独复测一次，避免偶发网络抖动误伤；默认开启
  confirmSingleTimeout?: boolean
  // 每次发生拆分时回调（参数为被拆分的批次大小），供 UI 反馈「细分中」
  onSplit?: (batchSize: number) => void
}

export async function runBisectSourceTest<T>(
  urls: string[],
  options: BisectTestOptions<T>
): Promise<BisectTestOutcome<T>> {
  const outcome: BisectTestOutcome<T> = { responses: [], timeoutUrls: [], untestedUrls: [] }
  const { request, isTimeout, confirmSingleTimeout = true, onSplit } = options

  async function attempt(batch: string[]): Promise<void> {
    try {
      outcome.responses.push(await request(batch))
    } catch (e: unknown) {
      if (!isTimeout(e)) {
        // 断网 / 5xx 等非超时错误：整批留作「未测」，不误标失效
        outcome.untestedUrls.push(...batch)
        return
      }
      if (batch.length > 1) {
        // 递归二分：不论拆多少层都继续拆，直到把慢源隔离成单源
        onSplit?.(batch.length)
        const mid = Math.ceil(batch.length / 2)
        await attempt(batch.slice(0, mid))
        await attempt(batch.slice(mid))
      } else if (confirmSingleTimeout) {
        // 单源超时：再单独复测一次；成功则按真实结果计入，仍超时才标记失效
        try {
          outcome.responses.push(await request(batch))
        } catch (e2: unknown) {
          if (isTimeout(e2)) outcome.timeoutUrls.push(...batch)
          else outcome.untestedUrls.push(...batch)
        }
      } else {
        outcome.timeoutUrls.push(...batch)
      }
    }
  }

  await attempt(urls)
  return outcome
}

// ─── 有界并发池 ──────────────────────────────────────────────────────────
// 深度测试等场景需要「多个源同时测」，但一次性 Promise.all 上千个会瞬间打满
// 后端连接、拖垮浏览器。这里用固定数量的 worker 滚动消费队列：同时进行的异步
// 任务始终不超过 size，整体耗时从「N × 单源耗时」降到「N / size × 单源耗时」。
// worker 抛错会向上传播（批量测试中由调用方 catch 住，不影响其余任务）。
export async function runWithConcurrency<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!items.length) return
  const limit = Math.max(1, Math.floor(size))
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      if (index >= items.length) break
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}
