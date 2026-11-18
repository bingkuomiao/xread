import http from './http'
import type { BookSource, BookSourceTestResponse } from '../types'
import { MAX_SOURCE_TEST_BATCH_SIZE } from '../utils/sourceTesting'

export function getBookSources() {
  return http.get<BookSource[]>('/getBookSources').then((r) => r.data)
}

export function getDefaultBookSourceOwner() {
  return http.get<{ username: string | null }>('/getDefaultBookSourceOwner').then((r) => r.data)
}

export interface LoginCredentials {
  username?: string
  password?: string
}

export function loginBookSource(
  bookSourceUrl: string,
  credentials?: LoginCredentials,
) {
  return http
    .post<{
      success: boolean
      message?: string
      status: number
      url: string
      checkResult?: string | null
      cookie?: string
      result?: string
      bodyPreview?: string
      bodyHtml?: string
    }>('/loginBookSource', {
      bookSourceUrl,
      ...(credentials ?? {}),
    })
    .then((r) => r.data)
}

export function getBookSource(bookSourceUrl: string) {
  return http.post<BookSource>('/getBookSource', { bookSourceUrl }).then((r) => r.data)
}

export function saveBookSource(source: BookSource) {
  return http.post<{ saved: boolean }>('/saveBookSource', source).then((r) => r.data)
}

export function saveBookSources(sources: BookSource[]) {
  return http.post<{ saved: boolean; count: number }>('/saveBookSources', sources).then((r) => r.data)
}

export function deleteBookSource(bookSourceUrl: string) {
  return http.post<{ deleted: boolean }>('/deleteBookSource', { bookSourceUrl }).then((r) => r.data)
}

export function deleteBookSources(sources: { bookSourceUrl: string }[]) {
  return http.post<{ deleted: boolean }>('/deleteBookSources', sources).then((r) => r.data)
}

export function deleteAllBookSources() {
  return http.post<{ deleted: boolean }>('/deleteAllBookSources').then((r) => r.data)
}

// 书源测试单请求超时（秒）：由飞牛安装向导「运行参数」页配置，cmd/main 启动时
// 把向导值注入 index.html 的 window.__XREAD_CONFIG__。
// 配置值优先（1-120s）；未注入或值非法时回退默认 120s，保证独立部署也能正常使用。
function testSourceTimeoutMs(): number {
  const cfg = (window as unknown as { __XREAD_CONFIG__?: { testSourceTimeout?: number } }).__XREAD_CONFIG__
  const secs = Number(cfg?.testSourceTimeout)
  return Number.isFinite(secs) && secs >= 1 && secs <= 120 ? secs * 1000 : 120000
}

export function testBookSources(params: {
  bookSourceUrls?: string[]
  keyword?: string
  markInvalid?: boolean
  concurrent?: number
}) {
  if ((params.bookSourceUrls?.length || 0) > MAX_SOURCE_TEST_BATCH_SIZE) {
    throw new Error(`单次最多测试 ${MAX_SOURCE_TEST_BATCH_SIZE} 个书源`)
  }
  return http.post<BookSourceTestResponse>('/testBookSources', params, { timeout: testSourceTimeoutMs() }).then((r) => r.data)
}

export function deleteInvalidBookSources() {
  return http.post<{ deleted: number }>('/deleteInvalidBookSources').then((r) => r.data)
}

export function setAsDefaultBookSources(username: string) {
  return http.post<{ success: boolean; count: number }>('/setAsDefaultBookSources', { username }).then((r) => r.data)
}

export function readRemoteSourceFile(url: string) {
  return http.post<string[]>('/readRemoteSourceFile', { url }).then((r) => r.data)
}

export function readSourceFile(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  return http.post<BookSource[]>('/readSourceFile', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  }).then((r) => r.data)
}

export function getInvalidBookSources() {
  return http.post<unknown[]>('/getInvalidBookSources').then((r) => r.data)
}
