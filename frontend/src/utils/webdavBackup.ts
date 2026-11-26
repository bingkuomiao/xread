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

/**
 * 合并恢复：把备份数据并入当前书架，不删除任何现有数据。
 * 与 restoreWebdavBackup（覆盖式：先 deleteBooks 再整架写入）不同，本函数只做 upsert：
 * - 书籍：按 bookUrl + origin 去重，同一本取「阅读进度较新」者；
 *   用 saveBooks 全量写回（注意：saveBooks 只覆盖书架元数据，不会删本地书原文件/章节缓存，
 *   真正删缓存的是 deleteBooks，所以这里绝不能调用 deleteBooks）。
 * - 书源 / RSS / 书签 / 净化规则 / 分组：后端各 save 接口本身就是按唯一键 upsert，
 *   直接把备份项写进去即可，当前独有项自然保留。
 * - 本地配置：备份值覆盖当前同名 key，当前独有 key 保留。
 */
export async function mergeWebdavBackup(payload: WebdavBackupPayload) {
  const currentBooks = await getBookshelf().catch(() => [] as Book[])

  // 阅读进度权重：优先最后阅读时间，其次最后检查时间，再退到章节序号。
  const progressOf = (b: Book) =>
    (b.durChapterTime ?? 0) || (b.lastCheckTime ?? 0) || (b.durChapterIndex ?? 0) || 0
  const identityOf = (b: Book) => `${b.bookUrl}||${b.origin}`

  const merged = new Map<string, Book>()
  for (const b of currentBooks) merged.set(identityOf(b), b)
  for (const b of payload.bookshelf.books) {
    const key = identityOf(b)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, b)
    } else if (progressOf(b) >= progressOf(current)) {
      // 备份进度更新（或相当）：用备份覆盖，但保留当前书独有的展示字段
      merged.set(key, { ...current, ...b })
    }
    // 当前书进度更新：保留 current，不做任何写回
  }
  await saveBooks([...merged.values()])

  // 其余数据类型：后端均为 upsert，直接写备份项即可，当前数据不删。
  if (payload.bookSources.length) await saveBookSources(payload.bookSources)
  if (payload.rssSources.length) await saveRssSources(payload.rssSources)
  for (const group of payload.bookshelf.groups) await saveBookGroup(group)
  if (payload.bookmarks.length) await saveBookmarks(payload.bookmarks)
  if (payload.replaceRules.length) await saveReplaceRules(payload.replaceRules)

  // 本地配置合并：备份覆盖同名 key，当前独有 key 保留。
  applyLocalState({ ...captureLocalState(), ...payload.localState })
}
