import type { Book } from '../types'
import { sanitizeBook } from './cleanText'

const RECENT_BOOKS_KEY = 'reader-recent-books'
const MAX_RECENT_BOOKS = 100
const RSS_RECENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface RecentReadBook extends Book {
  recentReadAt: number
}

export function getRecentReadBookKey(book: Pick<Book, 'bookUrl' | 'origin'>) {
  return `${book.origin || ''}::${book.bookUrl || ''}`
}

function normalizeRecentReadBook(book: Book): RecentReadBook {
  const recentReadAt = book.durChapterTime || Date.now()
  return {
    recentKind: book.recentKind || 'book',
    ...book,
    durChapterTime: recentReadAt,
    recentReadAt,
  }
}

export function loadRecentReadBooks() {
  try {
    const raw = localStorage.getItem(RECENT_BOOKS_KEY)
    if (!raw) return [] as RecentReadBook[]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [] as RecentReadBook[]
    const now = Date.now()
    const next = parsed
      .filter((item): item is RecentReadBook => !!item?.bookUrl && !!item?.origin)
      .filter((item) => {
        if (item.recentKind !== 'rss') return true
        const ts = item.recentReadAt || item.durChapterTime || 0
        return now - ts <= RSS_RECENT_TTL_MS
      })
      .sort((a, b) => (b.recentReadAt || b.durChapterTime || 0) - (a.recentReadAt || a.durChapterTime || 0))
    // 本地历史记录可能是旧版本（无入口清洗时）存入的脏数据，读取时统一清洗一次，
    // 保证 recentBooks 这条本地链路与 API/SSE 入口产出一致的干净数据。
    const clean = next
      .slice(0, MAX_RECENT_BOOKS)
      .map((entry) => sanitizeBook(entry))
    localStorage.setItem(RECENT_BOOKS_KEY, JSON.stringify(clean))
    return clean
  } catch {
    return [] as RecentReadBook[]
  }
}

export function saveRecentReadBook(book: Book) {
  if (!book?.bookUrl || !book?.origin) return
  const key = getRecentReadBookKey(book)
  const nextEntry = normalizeRecentReadBook(book)
  const next = loadRecentReadBooks()
    .filter((item) => getRecentReadBookKey(item) !== key)
  next.unshift(nextEntry)
  localStorage.setItem(RECENT_BOOKS_KEY, JSON.stringify(next.slice(0, MAX_RECENT_BOOKS)))
}

export function removeRecentReadBook(book: Pick<Book, 'bookUrl' | 'origin'>) {
  if (!book?.bookUrl || !book?.origin) return
  const key = getRecentReadBookKey(book)
  const next = loadRecentReadBooks().filter((item) => getRecentReadBookKey(item) !== key)
  localStorage.setItem(RECENT_BOOKS_KEY, JSON.stringify(next))
}

export function clearRecentReadBooks() {
  localStorage.removeItem(RECENT_BOOKS_KEY)
}
