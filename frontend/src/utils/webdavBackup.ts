import { getBookmarks, deleteBookmarks, saveBookmarks } from '../api/bookmark'
import {
  deleteBookGroup,
  deleteBooks,
  getBookGroups,
  getBookshelf,
  saveBooks,
  saveBookGroup,
} from '../api/bookshelf'
import { getReplaceRules, deleteReplaceRules, saveReplaceRules } from '../api/replaceRule'
import { getRssSources, deleteRssSource, saveRssSources } from '../api/rss'
import {
  deleteAllBookSources,
  getBookSources,
  saveBookSources,
} from '../api/source'
import type { Book, BookGroup, Bookmark, BookSource, ReplaceRule, RssSource } from '../types'
import { sanitizeBooks } from './cleanText'

const BACKUP_VERSION = 1
/** 供测试断言白名单覆盖；生产无其他调用。 */
export const LOCAL_STORAGE_KEYS = [
  'theme',
  // 阅读统计唯一数据源（不兼容旧版 reader-stats）。
  'xread-reading-stats-v2',
  'readConfig',
  'reader-themeIndex',
  'reader-isNight',
  'reader-speechConfig',
  'reader-last-session',
  'reader-currentIndex',
  'reader-source-subscriptions',
  // 界面定制（设置页「界面定制」：背景图/背景色/模糊/透明度/主题色）
  'xread-custom-ui-theme',
  // 搜索偏好（设置→搜索管理：精确匹配 / 默认全源搜索）
  'xread-exact-match',
  'xread-search-all-default',
]

export interface WebdavBackupPayload {
  version: number
  createdAt: string
  app: string
  bookshelf: {
    books: Book[]
    groups: BookGroup[]
  }
  bookSources: BookSource[]
  rssSources: RssSource[]
  bookmarks: Bookmark[]
  replaceRules: ReplaceRule[]
  localState: Record<string, string>
}

export function captureLocalState() {
  return LOCAL_STORAGE_KEYS.reduce<Record<string, string>>((acc, key) => {
    const value = localStorage.getItem(key)
    if (value != null) {
      acc[key] = value
    }
    return acc
  }, {})
}

export function applyLocalState(localState: Record<string, string> = {}) {
  LOCAL_STORAGE_KEYS.forEach((key) => {
    const value = localState[key]
    if (value == null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  })
}

export async function createWebdavBackupPayload(): Promise<WebdavBackupPayload> {
  const [books, groups, bookSources, rssSources, bookmarks, replaceRules] = await Promise.all([
    getBookshelf(),
    getBookGroups(),
    getBookSources(),
    getRssSources(),
    getBookmarks(),
    getReplaceRules(),
  ])

  return {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: 'reader-rust-frontend',
    bookshelf: {
      books,
      groups,
    },
    bookSources,
    rssSources,
    bookmarks,
    replaceRules,
    localState: captureLocalState(),
  }
}

export function serializeWebdavBackup(payload: WebdavBackupPayload) {
  return JSON.stringify(payload, null, 2)
}

export function parseWebdavBackup(raw: string) {
  const payload = JSON.parse(raw) as Partial<WebdavBackupPayload>
  if (!payload || typeof payload !== 'object') {
    throw new Error('备份文件格式无效')
  }
  if (!payload.version || !payload.bookshelf) {
    throw new Error('备份文件缺少必要字段')
  }
  return {
    version: payload.version,
    createdAt: payload.createdAt || new Date().toISOString(),
    app: payload.app || 'reader-rust-frontend',
    bookshelf: {
      books: sanitizeBooks(payload.bookshelf.books),
      groups: payload.bookshelf.groups || [],
    },
    bookSources: payload.bookSources || [],
    rssSources: payload.rssSources || [],
    bookmarks: payload.bookmarks || [],
    replaceRules: payload.replaceRules || [],
    localState: payload.localState || {},
  } as WebdavBackupPayload
}

export async function restoreWebdavBackup(payload: WebdavBackupPayload) {
  const currentGroups = await getBookGroups().catch(() => [])
  const currentBooks = await getBookshelf().catch(() => [])
  const currentBookmarks = await getBookmarks().catch(() => [])
  const currentReplaceRules = await getReplaceRules().catch(() => [])
  const currentRssSources = await getRssSources().catch(() => [])

  await Promise.all([
    currentGroups.length
      ? Promise.all(currentGroups.map((group) => deleteBookGroup(group.groupId)))
      : Promise.resolve(),
    currentBooks.length
      ? deleteBooks(currentBooks.map((book) => ({ bookUrl: book.bookUrl, origin: book.origin })) as Book[])
      : Promise.resolve(),
    currentBookmarks.length ? deleteBookmarks(currentBookmarks) : Promise.resolve(),
    currentReplaceRules.length ? deleteReplaceRules(currentReplaceRules) : Promise.resolve(),
    currentRssSources.length
      ? Promise.all(currentRssSources.map((source) => deleteRssSource({
          sourceUrl: source.sourceUrl,
          sourceName: source.sourceName,
        })))
      : Promise.resolve(),
    deleteAllBookSources().catch(() => undefined),
  ])

  if (payload.bookSources.length) {
    await saveBookSources(payload.bookSources)
  }
  if (payload.rssSources.length) {
    await saveRssSources(payload.rssSources)
  }
  for (const group of payload.bookshelf.groups) {
    await saveBookGroup(group)
  }
  if (payload.bookshelf.books.length) {
    await saveBooks(payload.bookshelf.books)
  }
  if (payload.bookmarks.length) {
    await saveBookmarks(payload.bookmarks)
  }
  if (payload.replaceRules.length) {
    await saveReplaceRules(payload.replaceRules)
  }

  applyLocalState(payload.localState)
}
