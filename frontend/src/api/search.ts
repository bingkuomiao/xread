import http from './http'
import type { SearchBook } from '../types'
import { appendAuthQueryParams } from '../utils/secureAccess'
import { sanitizeBooks } from '../utils/cleanText'

export function searchBookMulti(params: {
  key: string
  page?: number
  bookSourceGroup?: string
  bookSourceUrl?: string
}) {
  return http.post<SearchBook[]>('/searchBookMulti', params).then((r) => sanitizeBooks(r.data))
}

/**
 * SSE-based multi-source search. Returns an EventSource.
 * Caller is responsible for closing the connection.
 */
export function searchBookMultiSSE(params: {
  key: string
  bookSourceGroup?: string
  bookSourceUrl?: string
  concurrentCount?: number
  searchSize?: number
}) {
  const query = new URLSearchParams()
  query.set('key', params.key)
  if (params.bookSourceGroup) query.set('bookSourceGroup', params.bookSourceGroup)
  if (params.bookSourceUrl) query.set('bookSourceUrl', params.bookSourceUrl)
  if (params.concurrentCount) query.set('concurrentCount', String(params.concurrentCount))
  if (params.searchSize) query.set('searchSize', String(params.searchSize))

  appendAuthQueryParams(query)

  return new EventSource(`/reader3/searchBookMultiSSE?${query.toString()}`)
}

export function exploreBook(params: {
  ruleFindUrl: string
  bookSourceUrl: string
  page?: number
}) {
  return http.post<SearchBook[]>('/exploreBook', params).then((r) => sanitizeBooks(r.data))
}

export function getAvailableBookSource(params: {
  url?: string
  name?: string
  author?: string
  origin?: string
  refresh?: number
  lastIndex?: number
  resultLimit?: number
  concurrentCount?: number
}) {
  return http
    .post<SearchBook[] | AvailableBookSourceResult>('/getAvailableBookSource', params)
    .then((r) => normalizeAvailableBookSourceResult(r.data))
}

export function getAvailableBookSourceSSE(params: {
  url?: string
  name?: string
  author?: string
  origin?: string
  refresh?: number
  lastIndex?: number
  concurrentCount?: number
}) {
  const query = new URLSearchParams()
  if (params.url) query.set('url', params.url)
  if (params.name) query.set('name', params.name)
  if (params.author) query.set('author', params.author)
  if (params.origin) query.set('origin', params.origin)
  if (typeof params.refresh !== 'undefined') query.set('refresh', String(params.refresh))
  query.set('lastIndex', String(params.lastIndex ?? -1))
  query.set('concurrentCount', String(params.concurrentCount ?? 8))

  appendAuthQueryParams(query)

  return new EventSource(`/reader3/getAvailableBookSourceSSE?${query.toString()}`)
}

export interface AvailableBookSourceResult {
  books: SearchBook[]
  lastIndex: number
  hasMore: boolean
}

function normalizeAvailableBookSourceResult(
  data: SearchBook[] | AvailableBookSourceResult,
): AvailableBookSourceResult {
  if (Array.isArray(data)) {
    return {
      books: sanitizeBooks(data),
      lastIndex: data.length - 1,
      hasMore: false,
    }
  }
  return { ...data, books: sanitizeBooks(data.books) }
}

export function searchBookSourceSSE(params: {
  url: string
  bookSourceGroup?: string
  lastIndex?: number
  concurrentCount?: number
  searchSize?: number
  refresh?: number
}) {
  const query = new URLSearchParams()
  query.set('url', params.url)
  query.set('concurrentCount', String(params.concurrentCount ?? 24))
  query.set('lastIndex', String(params.lastIndex ?? -1))
  if (typeof params.refresh !== 'undefined') query.set('refresh', String(params.refresh))
  if (params.bookSourceGroup !== undefined) query.set('bookSourceGroup', params.bookSourceGroup)
  if (params.searchSize) query.set('searchSize', String(params.searchSize))

  appendAuthQueryParams(query)

  return new EventSource(`/reader3/searchBookSourceSSE?${query.toString()}`)
}

/**
 * 一次性多书源关键词搜索（SSE 版，与推荐书源共用流式接口）。
 * 收集所有流式批次的候选，收到 end / 出错 / 超时后 resolve 汇总结果。
 * 无 EventSource 的环境（SSR / 部分测试）自动回退到普通接口，保证可调用性。
 */
export function searchBookMultiOnce(params: {
  key: string
  concurrentCount?: number
  searchSize?: number
  timeoutMs?: number
}): Promise<SearchBook[]> {
  if (typeof EventSource === 'undefined') {
    return searchBookMulti({ key: params.key })
  }
  return new Promise((resolve) => {
    const books: SearchBook[] = []
    const seen = new Set<string>()
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const es = searchBookMultiSSE({
      key: params.key,
      concurrentCount: params.concurrentCount ?? 10,
      searchSize: params.searchSize ?? 50,
    })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { es.close() } catch { /* noop */ }
      resolve(sanitizeBooks(books))
    }
    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { data?: SearchBook[] }
        const batch = Array.isArray(payload?.data) ? payload.data : []
        for (const b of batch) {
          const k = `${b.name}__${b.author}__${b.bookUrl}`
          if (seen.has(k)) continue
          seen.add(k)
          books.push(b)
        }
      } catch { /* 忽略畸形消息 */ }
    }
    es.addEventListener('end', finish)
    es.onerror = finish
    timer = setTimeout(finish, params.timeoutMs ?? 8000)
  })
}
