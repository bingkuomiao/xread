import { describe, expect, it } from 'vitest'
import {
  MAX_SOURCE_TEST_BATCH_SIZE,
  chunkBookSourceUrls,
  mergeBookSourceTestResponses,
  runBisectSourceTest,
} from './sourceTesting'
import type { BookSourceTestResponse } from '../types'

describe('sourceTesting', () => {
  it('chunks source urls into frontend batches of at most 100', () => {
    const urls = Array.from({ length: 205 }, (_, index) => `https://source-${index}.example`)

    const chunks = chunkBookSourceUrls(urls)

    expect(MAX_SOURCE_TEST_BATCH_SIZE).toBe(100)
    expect(chunks).toHaveLength(3)
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 5])
    expect(chunks.flat()).toEqual(urls)
  })

  it('merges source test responses across frontend batches', () => {
    const responses: BookSourceTestResponse[] = [
      {
        total: 2,
        valid: 1,
        invalid: 1,
        markedInvalid: 1,
        results: [
          sourceResult('https://valid.example', true),
          sourceResult('https://invalid.example', false),
        ],
      },
      {
        total: 1,
        valid: 1,
        invalid: 0,
        markedInvalid: 0,
        results: [sourceResult('https://valid-2.example', true)],
      },
    ]

    expect(mergeBookSourceTestResponses(responses)).toEqual({
      total: 3,
      valid: 2,
      invalid: 1,
      markedInvalid: 1,
      results: responses.flatMap((response) => response.results),
    })
  })
})

// ─── 超时自适应细分（递归二分）回归用例 ─────────────────────────────────
// 旧逻辑超时只拆一层（10→5+5），含慢源的那半仍超时就把 5 个源整体标记失效，
// 误伤 4 个正常源。下面的用例证明：递归二分后只有真正超时的源被标记，
// 其余源全部按真实结果返回。
const timeoutError = () => new Error('timeout of 60000ms exceeded')
const isTimeout = (e: unknown) =>
  /timeout of \d+ms exceeded|ECONNABORTED/i.test((e as Error)?.message || '')

function urls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://u${i}.example`)
}

function okResponse(batch: string[]): BookSourceTestResponse {
  return {
    total: batch.length,
    valid: batch.length,
    invalid: 0,
    markedInvalid: 0,
    results: batch.map((url) => sourceResult(url, true)),
  }
}

// 收集所有成功响应里出现过的书源 URL（即拿到真实结果、未被误标的源）
function collectedUrls(responses: BookSourceTestResponse[]): string[] {
  return responses.flatMap((r) => r.results.map((item) => item.bookSourceUrl)).sort()
}

describe('runBisectSourceTest', () => {
  it('正常批次一次成功，不拆分、无标记', async () => {
    const calls: string[][] = []
    const request = async (batch: string[]): Promise<BookSourceTestResponse> => {
      calls.push(batch)
      return okResponse(batch)
    }

    const result = await runBisectSourceTest(urls(10), { request, isTimeout })

    expect(calls).toHaveLength(1) // 一次请求，没发生任何拆分
    expect(result.responses).toHaveLength(1)
    expect(result.timeoutUrls).toEqual([])
    expect(result.untestedUrls).toEqual([])
    expect(collectedUrls(result.responses)).toEqual(urls(10).sort())
  })

  it('含单个慢源：递归二分后只标记该源，其余 9 个源结果完整保留', async () => {
    const all = urls(10)
    const slow = all[3]
    const splitSizes: number[] = []
    const request = async (batch: string[]): Promise<BookSourceTestResponse> => {
      if (batch.includes(slow)) throw timeoutError()
      return okResponse(batch)
    }

    const result = await runBisectSourceTest(all, {
      request,
      isTimeout,
      confirmSingleTimeout: false,
      onSplit: (size) => splitSizes.push(size),
    })

    expect(result.timeoutUrls).toEqual([slow]) // 只有慢源被标记失效
    expect(result.untestedUrls).toEqual([])
    // 其余 9 个正常源全部拿到真实结果，一个都没被误标
    expect(collectedUrls(result.responses)).toEqual(all.filter((u) => u !== slow).sort())
    // 确实发生了多层递归拆分（不是只拆一层）
    expect(splitSizes.length).toBeGreaterThan(1)
    expect(splitSizes.every((size) => size > 1)).toBe(true)
  })

  it('含多个慢源：各自被隔离，正常源仍全部保留', async () => {
    const all = urls(10)
    const slowSet = new Set([all[2], all[7]])
    const request = async (batch: string[]): Promise<BookSourceTestResponse> => {
      if (batch.some((u) => slowSet.has(u))) throw timeoutError()
      return okResponse(batch)
    }

    const result = await runBisectSourceTest(all, {
      request,
      isTimeout,
      confirmSingleTimeout: false,
    })

    expect(result.timeoutUrls.sort()).toEqual([all[2], all[7]].sort())
    expect(collectedUrls(result.responses)).toEqual(
      all.filter((u) => !slowSet.has(u)).sort()
    )
    expect(result.untestedUrls).toEqual([])
  })

  it('单源首次超时、二次复测成功：不标记失效', async () => {
    const single = urls(1)
    let calls = 0
    const request = async (batch: string[]): Promise<BookSourceTestResponse> => {
      calls += 1
      if (calls === 1) throw timeoutError() // 首次偶发超时
      return okResponse(batch)
    }

    const result = await runBisectSourceTest(single, { request, isTimeout })

    expect(calls).toBe(2)
    expect(result.timeoutUrls).toEqual([])
    expect(result.untestedUrls).toEqual([])
    expect(collectedUrls(result.responses)).toEqual(single)
  })

  it('单源两次都超时：才标记失效', async () => {
    const single = urls(1)
    const request = async (): Promise<BookSourceTestResponse> => {
      throw timeoutError()
    }

    const result = await runBisectSourceTest(single, { request, isTimeout })

    expect(result.timeoutUrls).toEqual(single)
    expect(result.responses).toEqual([])
  })

  it('非超时错误（断网/5xx）：整批记为未测，不误标失效', async () => {
    const all = urls(4)
    const request = async (): Promise<BookSourceTestResponse> => {
      throw new Error('Network Error')
    }

    const result = await runBisectSourceTest(all, { request, isTimeout })

    expect(result.timeoutUrls).toEqual([])
    expect(result.untestedUrls).toEqual(all)
    expect(result.responses).toEqual([])
  })
})

function sourceResult(bookSourceUrl: string, valid: boolean) {
  return {
    bookSourceName: bookSourceUrl,
    bookSourceUrl,
    valid,
    searchOk: valid,
    exploreOk: false,
    keyword: '斗破苍穹',
    markedInvalid: !valid,
  }
}
