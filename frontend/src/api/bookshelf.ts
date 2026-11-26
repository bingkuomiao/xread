import http from './http'
import type { Book, BookChapter, BookGroup } from '../types'
import { appendAuthQueryParams } from '../utils/secureAccess'
import { sanitizeBook, sanitizeBooks } from '../utils/cleanText'
import { searchBookMultiOnce } from './search'
import { pickBestMetadata } from '../utils/localBookMatch'
import { isLocalBook } from '../utils/localBook'

export function getBookshelf() {
  return http.get<Book[]>('/getBookshelf').then((r) => sanitizeBooks(r.data))
}

export function getBookshelfWithCacheInfo() {
  return http.get<Book[]>('/getShelfBookWithCacheInfo').then((r) => sanitizeBooks(r.data))
}

export function getShelfBook(url: string) {
  return http.post<Book>('/getShelfBook', { url }).then((r) => sanitizeBook(r.data))
}

export function saveBook(book: Partial<Book>) {
  return http.post<Book>('/saveBook', book).then((r) => sanitizeBook(r.data))
}

export function saveBooks(books: Partial<Book>[]) {
  return http.post<Book[]>('/saveBooks', books).then((r) => sanitizeBooks(r.data))
}

export interface LocalBookUploadMeta {
  name: string
  author?: string
  intro?: string
  storedFileName?: string
}

export function uploadTxtBook(file: File, meta?: LocalBookUploadMeta) {
  const formData = new FormData()
  // 上传原文件；书名/作者/简介/存储文件名均由前端解析生成后作为独立字段传给后端，
  // 后端只按值入库，不解析文件名、不生成存储名，彻底零解析。
  formData.append('file', file)
  if (meta?.name) formData.append('name', meta.name)
  if (meta?.author) formData.append('author', meta.author)
  if (meta?.intro) formData.append('intro', meta.intro)
  if (meta?.storedFileName) formData.append('storedFileName', meta.storedFileName)
  return http.post<Book>('/uploadTxtBook', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => sanitizeBook(r.data))
}

export function uploadEpubBook(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  return http.post<Book>('/uploadEpubBook', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then((r) => sanitizeBook(r.data))
}

/** 读取本地 TXT 书的原始上传文件全文（原样，不切片不改写），用于原样导出。 */
export function exportLocalBookText(bookUrl: string): Promise<{ text: string; storedName: string }> {
  return http.post<{ text: string; storedName: string }>('/exportLocalBook', { bookUrl })
    .then((r) => r.data)
}

export interface EnrichResult {
  cover: boolean
  intro: boolean
  author: boolean
  searched: number
}

/**
 * 尽力为本地书补全封面/简介/作者；失败请调用方自行忽略。
 * 匹配逻辑全部在前端完成：多书源搜索 → 精确/作者锁定/打分择优 → 写回；
 * 后端只负责写回数据与展示时按需缓存封面（/reader3/cover），零匹配逻辑。
 * 按 bookUrl 做 in-flight 去重：同一本书在请求完成前的重复调用（例如多次点击刷新 +
 * 导入时刷新同时触发静默补全）复用同一个 Promise，避免并发重复搜索/下载/写回封面。
 *
 * ⚠️ 写回必须使用单本 saveBook，绝不能用 saveBooks：
 * 后端 saveBooks 是全量覆盖书架，用它写回单本会把整架清空成只剩这一本
 * （导入第二本本地书后书架只剩新书的 bug 根因）。
 */
const enrichInFlight = new Map<string, Promise<EnrichResult>>()

/**
 * 单本书写回串行队列。
 * 后端 save_book 是 read-modify-write 且无锁：批量补全时多个写回若并发，
 * 会读到同一份旧书架再各自写回，后者覆盖前者导致丢书。这里把写回串行化，
 * 保证每次 read 都发生在上一次 write 之后。
 */
let bookSaveQueue: Promise<unknown> = Promise.resolve()
function enqueueBookSave(book: Book): Promise<unknown> {
  const task = bookSaveQueue.then(() => saveBook(book))
  bookSaveQueue = task.catch(() => undefined)
  return task
}

const EMPTY_ENRICH: EnrichResult = { cover: false, intro: false, author: false, searched: 0 }

export function enrichLocalBookMeta(book: Partial<Book>): Promise<EnrichResult> {
  const key = book.bookUrl || book.name || ''
  const pending = key ? enrichInFlight.get(key) : undefined
  if (pending) return pending

  const request = (async (): Promise<EnrichResult> => {
    // 防御：补封面只针对本地书（local-txt / local-epub），网络书自带书源封面，永不进入搜索写回链路。
    // 注：调用方传的是 Partial<Book>，isLocalBook 内部已对缺失字段做容错，这里做类型收窄。
    if (!isLocalBook(book as Parameters<typeof isLocalBook>[0])) return { ...EMPTY_ENRICH }
    const name = (book.name ?? '').trim()
    if (!name || !book.bookUrl) return { ...EMPTY_ENRICH }
    // 已有封面的书直接跳过，保持幂等（与后端旧逻辑一致）。
    if (book.customCoverUrl || book.coverUrl) return { ...EMPTY_ENRICH }

    try {
      // 1. 多书源聚合搜索（统一走 SSE 流式接口，与切换书源推荐同源；无 EventSource 环境自动回退普通接口）
      const candidates = await searchBookMultiOnce({ key: name })
      // 2. 前端匹配择优
      const best = pickBestMetadata(candidates, name, book.author)
      const cover = !!best.coverUrl
      const intro = !!best.intro
      const author = !!best.author
      if (!cover && !intro && !author) {
        return { ...EMPTY_ENRICH, searched: candidates.length }
      }
      // 3. 按值写回：只改这四项，其余字段原样保留。
      //    必须走单本 saveBook（经串行队列），不能用全量覆盖的 saveBooks，
      //    否则会把整架清空成只剩这一本。
      const updated: Book = {
        ...(book as Book),
        ...(best.coverUrl ? { customCoverUrl: best.coverUrl } : {}),
        ...(best.intro ? { intro: best.intro } : {}),
        ...(best.author ? { author: best.author } : {}),
      }
      await enqueueBookSave(updated)
      return { cover, intro, author, searched: candidates.length }
    } catch {
      // 补全失败不影响导入/刷新主流程
      return { ...EMPTY_ENRICH }
    }
  })().finally(() => {
    if (key) enrichInFlight.delete(key)
  })

  if (key) enrichInFlight.set(key, request)
  return request
}

/**
 * 阅读页「顺手补封面」：零额外搜索，把已知封面 URL 写回本地书。
 * 仅对本地书、且当前无封面时生效（幂等），其它书一律跳过。
 * 供切换书源页复用 SSE 推荐结果中的共识封面，避免再发一次搜索请求。
 */
export async function saveLocalBookCover(book: Partial<Book>, coverUrl?: string): Promise<boolean> {
  const url = (coverUrl ?? '').trim()
  if (!url) return false
  if (!isLocalBook(book as Parameters<typeof isLocalBook>[0])) return false
  if (book.customCoverUrl || book.coverUrl) return false
  const updated: Book = { ...(book as Book), customCoverUrl: url }
  try {
    await enqueueBookSave(updated)
    return true
  } catch {
    return false
  }
}

export function deleteBook(book: Partial<Book>) {
  return http.post<string>('/deleteBook', book).then((r) => r.data)
}

export function deleteBooks(books: Partial<Book>[]) {
  return http.post<{ deleted: number }>('/deleteBooks', books).then((r) => r.data)
}

export function getBookInfo(url: string, origin?: string) {
  return http.post<Book>('/getBookInfo', { url, bookSourceUrl: origin }).then((r) => sanitizeBook(r.data))
}

export function getChapterList(params: {
  bookUrl?: string
  tocUrl?: string
  bookSourceUrl?: string
  refresh?: number
}) {
  return http.post<BookChapter[]>('/getChapterList', params).then((r) => r.data)
}

export function getBookContent(params: {
  chapterUrl?: string
  bookSourceUrl?: string
  index?: number
  refresh?: number
}) {
  return http.post<string>('/getBookContent', params).then((r) => r.data)
}

export function saveBookProgress(params: {
  bookUrl: string
  index: number
  position?: number
}) {
  return http.post<string>('/saveBookProgress', params).then((r) => r.data)
}

export function deleteBookCache(bookUrl: string) {
  return http.post('/deleteBookCache', { bookUrl }).then((r) => r.data)
}

// ─── Groups ───
export function getBookGroups() {
  return http.get<BookGroup[]>('/getBookGroups').then((r) => r.data)
}

export function saveBookGroup(group: BookGroup) {
  return http.post<string>('/saveBookGroup', group).then((r) => r.data)
}

export function deleteBookGroup(groupId: number) {
  return http.post<string>('/deleteBookGroup', { groupId }).then((r) => r.data)
}

export function saveBookGroupId(bookUrl: string, groupId: number) {
  return http.post<string>('/saveBookGroupId', { bookUrl, groupId }).then((r) => r.data)
}

export function setBookSource(params: {
  bookUrl: string
  newUrl: string
  bookSourceUrl: string
}) {
  return http.post<Book>('/setBookSource', params).then((r) => sanitizeBook(r.data))
}

// ─── Cover helper ───
/**
 * 封面统一入口（零判断）：本地书与网络书封面都走 /reader3/cover，且一律带上鉴权参数。
 * 前端不再判断封面来源（不需区分本地书/网络书，也不看 URL 前缀形态）——
 * 后端对远程 URL 会忽略鉴权参数（仍走 public 下载），仅对本地 EPUB 资源路径使用鉴权。
 * 因此任何前端只要把 coverUrl 原值交给 path、并带上鉴权参数即可。
 */
export function getCoverUrl(coverUrl?: string) {
  if (!coverUrl) return ''
  // 已是完整 URL（绝对地址）也继续走统一接口，由后端收敛，前端不做来源判断
  const params = new URLSearchParams({ path: coverUrl })
  appendAuthQueryParams(params)
  return `/reader3/cover?${params.toString()}`
}

export function withAuthQuery(url: string) {
  if (!url.startsWith('/reader3/localEpubAsset')) return url
  const [path, rawQuery = ''] = url.split('?')
  const params = new URLSearchParams(rawQuery)
  appendAuthQueryParams(params)
  return `${path}?${params.toString()}`
}
