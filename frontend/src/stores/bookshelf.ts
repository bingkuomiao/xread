import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getBookshelfWithCacheInfo,
  getBookGroups,
  deleteBook as apiDeleteBook,
  deleteBooks as apiDeleteBooks,
  saveBookGroupId as apiSaveBookGroupId,
  saveBookGroup as apiSaveBookGroup,
  deleteBookGroup as apiDeleteBookGroup,
  saveBook as apiSaveBook,
  saveBooks as apiSaveBooks,
  enrichLocalBookMeta,
} from '../api/bookshelf'
import type { Book, BookGroup, SearchBook } from '../types'
import { deleteBrowserBookCache, listBrowserCacheSummary } from '../utils/browserCache'
import { isLocalBook } from '../utils/localBook'
import {
  clearCoverMatchAttempt,
  computeSourceFingerprint,
  markCoverMatchAttempted,
  shouldSkipCoverMatch,
} from '../utils/coverMatchState'
import { clearRecentReadBooks, getRecentReadBookKey, loadRecentReadBooks, removeRecentReadBook } from '../utils/recentBooks'
import { useSourceStore } from './source'

/**
 * 书架首屏快照：后端 getShelfBookWithCacheInfo 会对每本书的每个缓存章节做一次同步磁盘 stat，
 * 缓存章节多时可达秒级。冷启动先同步读本地快照渲染，再后台静默拉取服务端最新数据覆盖，
 * 用户不再对着「加载中」空等。仅缓存非空列表，避免掩盖「书架为空」的真实状态。
 */
const SHELF_STORAGE_KEY = 'xread-bookshelf-snapshot-v1'
/** 快照有效期：12 小时。过期后走正常加载（显示 loading），避免无限期展示陈旧进度。 */
const SHELF_TTL = 12 * 60 * 60 * 1000

/**
 * 书架拉取 in-flight 去重：静默补全命中后的刷新、导入完成后的刷新、手动刷新可能在同一时刻
 * 并发调用 fetchBooks/refreshBooks。共享同一个拉取任务，避免较慢的旧响应后返回、用旧数据
 * 覆盖掉刚写入的新封面。真正的解析与写库只执行一次，loading/refreshing 状态由调用方各自管理。
 */
let shelfFetchInFlight: Promise<void> | null = null

/**
 * 把「非紧急」的后台刷新推迟到浏览器空闲时段，避免冷启动首屏渲染阶段
 * 与服务端拉取 + JSON 解析抢占主线程（书多时这段最影响启动体感）。
 * 无 requestIdleCallback 时用 setTimeout 兜底；页面不可见时静默跳过。
 */
function runWhenIdle(task: () => void) {
  const run = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    task()
  }
  const ric = (typeof window !== 'undefined' && (window as unknown as {
    requestIdleCallback?: (cb: IdleRequestCallback, opts?: { timeout: number }) => number
  }).requestIdleCallback)
  if (ric) {
    ric(() => run(), { timeout: 1500 })
  } else {
    // 浏览器/测试环境都可能没有 window；用全局 setTimeout 兜底
    setTimeout(run, 300)
  }
}

function loadShelfSnapshot(): Book[] | null {
  try {
    const raw = localStorage.getItem(SHELF_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { books: Book[]; ts: number }
    if (!parsed || !Array.isArray(parsed.books) || typeof parsed.ts !== 'number') return null
    if (Date.now() - parsed.ts > SHELF_TTL) return null
    return parsed.books.length > 0 ? parsed.books : null
  } catch {
    return null
  }
}

function saveShelfSnapshot(list: Book[]) {
  try {
    if (list.length === 0) return
    localStorage.setItem(SHELF_STORAGE_KEY, JSON.stringify({ books: list, ts: Date.now() }))
  } catch {
    // 容量不足 / 隐私模式：忽略，退化为每次走服务端
  }
}

export const useBookshelfStore = defineStore('bookshelf', () => {
  // ─── Bookshelf ───
  const books = ref<Book[]>([])
  const recentBooks = ref<Book[]>([])
  const loading = ref(false)
  const refreshing = ref(false)
  const sorting = ref(false)

  async function refreshRecentBooks(reusedBrowserMap?: Map<string, number>) {
    // 启动加载时 loadShelfOnce 已经扫过一次 IndexedDB 全表，这里复用其结果，
    // 避免同一轮启动对缓存库做第二次全表读取（书/缓存多时是明显的 CPU/IO 开销）。
    const browserMap = reusedBrowserMap ?? new Map(
      (await listBrowserCacheSummary().catch(() => []))
        .map((item) => [item.bookUrl, item.cachedChapterCount] as const),
    )
    const shelfMap = new Map(books.value.map((book) => [getRecentReadBookKey(book), book]))
    recentBooks.value = loadRecentReadBooks().map((entry) => {
      const shelfBook = shelfMap.get(getRecentReadBookKey(entry))
      const merged = shelfBook
        ? {
            ...entry,
            ...shelfBook,
            recentReadAt: entry.recentReadAt,
            durChapterTime: entry.recentReadAt,
          }
        : entry
      return {
        ...merged,
        browserCachedChapterCount: isLocalBook(merged) ? 0 : browserMap.get(merged.bookUrl) || merged.browserCachedChapterCount || 0,
      }
    })
  }

  async function removeRecentBook(book: Pick<Book, 'bookUrl' | 'origin'>) {
    removeRecentReadBook(book)
    await refreshRecentBooks()
  }

  async function clearAllRecentBooks() {
    clearRecentReadBooks()
    await refreshRecentBooks()
  }

  /** 真正执行一次书架拉取并写库；被 fetchBooks/refreshBooks 共享去重 */
  function loadShelfOnce(): Promise<void> {
    if (shelfFetchInFlight) return shelfFetchInFlight
    const task = (async () => {
      const [serverBooks, browserSummaries] = await Promise.all([
        getBookshelfWithCacheInfo(),
        listBrowserCacheSummary().catch(() => []),
      ])
      const browserMap = new Map(browserSummaries.map((item) => [item.bookUrl, item.cachedChapterCount]))
      books.value = serverBooks.map((book) => ({
        ...book,
        browserCachedChapterCount: isLocalBook(book) ? 0 : browserMap.get(book.bookUrl) || 0,
      }))
      saveShelfSnapshot(books.value)
      await refreshRecentBooks(browserMap)
      // 书架数据就绪后，空闲时段静默补本地书封面（受设置页开关控制，幂等）
      if (books.value.length > 0) void matchLocalCoversWhenIdle()
    })()
    shelfFetchInFlight = task
    // 无论成功失败都要释放 in-flight 槽位；用 then 而非 finally 避免产生新的 rejected Promise
    const release = () => {
      if (shelfFetchInFlight === task) shelfFetchInFlight = null
    }
    void task.then(release, release)
    return task
  }

  async function fetchBooks() {
    loading.value = true
    try {
      await loadShelfOnce()
    } finally {
      loading.value = false
    }
  }

  /**
   * 首屏专用加载：命中本地快照时先用它瞬时渲染列表（loading 保持 false，不显示空转），
   * 再后台静默刷新服务端最新数据；未命中时退化为常规 fetchBooks（显示 loading）。
   * 只用于应用冷启动的首屏，下拉刷新等仍走 refreshBooks / fetchBooks。
   */
  async function fetchBooksFast() {
    const cached = loadShelfSnapshot()
    if (cached && books.value.length === 0) {
      books.value = cached
      // 首屏立即渲染缓存；后台刷新推迟到空闲时段，不抢首屏渲染资源。
      // refreshBooks 不触发 loading spinner，完成后自动落盘新快照。
      runWhenIdle(() => { void refreshBooks().catch(() => undefined) })
      // 最近阅读用本地数据即可立即呈现；首屏跳过 IndexedDB 全表扫描（角标稍后由空闲刷新补上），
      // 让冷启动首帧不被缓存库读取拖慢。
      await refreshRecentBooks(new Map())
      return
    }
    await fetchBooks()
  }

  async function refreshBooks() {
    refreshing.value = true
    try {
      await loadShelfOnce()
    } finally {
      refreshing.value = false
    }
  }

  /**
   * 空闲静默补封面：设置页「封面匹配」开关开启时，在浏览器空闲时段串行为
   * 无封面的本地导入书（TXT/EPUB）从书源匹配封面。
   * 严格仅针对本地导入书（isLocalBook = local-txt / local-epub），网络书永不进入此链路；
   * 已有封面自动跳过、单飞 + 串行避免并发搜索压垮书源，补到后刷新书架。不阻塞启动/导入/交互。
   */
  let coverMatchRunning = false
  let coverMatchScheduled = false
  async function matchLocalCoversWhenIdle() {
    // 开关关闭则直接返回（默认开：只有显式存了 'false' 才关）
    if (localStorage.getItem('xread-match-cover-idle') === 'false') return
    // 每个会话只调度一次：补封面是幂等的，没必要每次刷新书架都重排一轮
    if (coverMatchScheduled) return
    coverMatchScheduled = true
    runWhenIdle(() => { void runCoverMatchOnce() })
  }

  async function runCoverMatchOnce() {
    // 执行前再查一次开关，确保用户中途关闭也能即时生效
    if (localStorage.getItem('xread-match-cover-idle') === 'false') return
    if (coverMatchRunning) return
    coverMatchRunning = true
    try {
      const candidates = books.value.filter(
        (b) => isLocalBook(b) && !b.customCoverUrl && !b.coverUrl,
      )
      if (candidates.length === 0) return

      // 书源指纹：只有当书源发生增删改/规则变化时，才对「之前没匹配到的书」重新搜索。
      // 书源加载失败时指纹为空串——此时不做跳过（宁可正常尝试，也不因读不到书源而永久跳过）。
      let sourceFingerprint = ''
      try {
        const sourceStore = useSourceStore()
        if (!sourceStore.sources.length) await sourceStore.fetchSources()
        sourceFingerprint = computeSourceFingerprint(sourceStore.sources)
      } catch {
        sourceFingerprint = ''
      }
      // 完全无书源：搜索注定无结果，直接结束，避免每本书都空跑一次搜索。
      // 不写尝试记录（空指纹不做跳过判断），这样日后新增书源后会自然进入匹配。
      if (sourceFingerprint === '') return

      let changed = false
      // 串行：一本完成再补下一本，避免并发搜索与瞬时 CPU 峰值
      for (const book of candidates) {
        // 当前书源已尝试过且没匹配到 → 跳过；书源更新后指纹变化才会重新进入
        if (shouldSkipCoverMatch(book.bookUrl, sourceFingerprint)) continue
        try {
          const result = await enrichLocalBookMeta(book)
          if (result?.cover || result?.intro || result?.author) {
            changed = true
            clearCoverMatchAttempt(book.bookUrl)
          } else {
            // 搜过但没匹配到：记录指纹，后续同书源不再重复搜索
            markCoverMatchAttempted(book.bookUrl, sourceFingerprint)
          }
        } catch {
          // 单本失败不影响其余；这里也记一次，避免异常书每启动都重试拖慢空闲任务
          markCoverMatchAttempted(book.bookUrl, sourceFingerprint)
        }
      }
      if (changed) await loadShelfOnce().catch(() => undefined)
    } finally {
      coverMatchRunning = false
    }
  }

  async function removeBook(book: Book) {
    await apiDeleteBook(book)
    await deleteBrowserBookCache(book.bookUrl).catch(() => undefined)
    books.value = books.value.filter((b) => b.bookUrl !== book.bookUrl)
    await refreshRecentBooks()
  }

  // ─── Groups ───
  const groups = ref<BookGroup[]>([])
  const activeGroupId = ref<number>(-1) // -1 = all

  const displayGroups = computed(() => {
    const all: BookGroup = { groupId: -1, groupName: '全部' }
    const unassigned: BookGroup = { groupId: 0, groupName: '其它' }
    return [all, ...groups.value, unassigned]
  })

  const filteredBooks = computed(() => {
    if (activeGroupId.value === -1) return books.value
    if (activeGroupId.value === 0) {
      return books.value.filter((b) => !b.group || b.group === 0)
    }
    // 纯粹一对一精确分组，彻底抛弃位掩码，绝不跨组
    return books.value.filter((b) => b.group === activeGroupId.value)
  })

  async function fetchGroups() {
    try {
      groups.value = await getBookGroups()
    } catch {
      groups.value = []
    }
  }

  async function saveGroup(groupName: string, groupId = 0) {
    await apiSaveBookGroup({
      groupId,
      groupName,
      orderNo: groups.value.length,
    })
    await fetchGroups()
    return groups.value.find((group) => group.groupName === groupName)?.groupId || groupId
  }

  async function removeGroup(groupId: number) {
    await apiDeleteBookGroup(groupId)
    groups.value = groups.value.filter((group) => group.groupId !== groupId)
    books.value = books.value.map((book) => {
      if (book.group === groupId) {
        return { ...book, group: 0 }
      }
      return book
    })
  }

  // ─── Search ───
  const searchResults = ref<SearchBook[]>([])
  const isSearching = ref(false)
  const searchKey = ref('')
  const searchScope = ref<'all' | 'group' | 'source'>('source')
  // 搜索分类与书架分组保持一致：直接存用户自定义分组名（全部/小说/漫画/影视/其它…）。
  // 旧版固定四类 novel/manga/audio/skit 已废弃；分类前缀仅为 UI 标记，不参与实际检索。
  const searchCategory = ref<string>('全部')
  const searchGroup = ref('')
  const searchSourceUrl = ref('')
  // 会话内标记：用户是否在搜索页手动指定过书源范围/书源。
  // 用于顶栏再次搜索时沿用当前选择，避免频繁重新选择；刷新页面后自动重置。
  const searchSourcePinned = ref(false)
  function pinSearchSource() { searchSourcePinned.value = true }

  function startSearch(key: string, options: {
    scope?: 'all' | 'group' | 'source'
    group?: string
    sourceUrl?: string
  } = {}) {
    const nextKey = key.trim()
    if (!nextKey) {
      clearSearch()
      return
    }

    searchScope.value = options.scope || 'source'
    searchGroup.value = options.group || ''
    searchSourceUrl.value = options.sourceUrl || ''
    searchKey.value = nextKey
  }

  function clearSearch() {
    searchResults.value = []
    searchKey.value = ''
    isSearching.value = false
    searchScope.value = 'source'
    searchGroup.value = ''
    searchSourceUrl.value = ''
    searchSourcePinned.value = false
  }

  const isSearchMode = computed(() => searchKey.value.length > 0)

  // ─── Edit mode and Selection ───
  const editMode = ref(false)
  const selectedBookUrls = ref<Set<string>>(new Set())

  function toggleSelection(url: string) {
    if (selectedBookUrls.value.has(url)) {
      selectedBookUrls.value.delete(url)
    } else {
      selectedBookUrls.value.add(url)
    }
  }

  function selectAll() {
    filteredBooks.value.forEach(b => selectedBookUrls.value.add(b.bookUrl))
  }

  function clearSelection() {
    selectedBookUrls.value.clear()
  }

  async function bulkDelete() {
    const toDelete = books.value
      .filter(b => selectedBookUrls.value.has(b.bookUrl))
      .map(b => ({ bookUrl: b.bookUrl, origin: b.origin }))
    
    if (toDelete.length === 0) return
    await apiDeleteBooks(toDelete as Book[])
    await Promise.all(toDelete.map((book) => deleteBrowserBookCache(book.bookUrl).catch(() => undefined)))
    books.value = books.value.filter(b => !selectedBookUrls.value.has(b.bookUrl))
    clearSelection()
  }

  async function bulkSetGroup(groupId: number) {
    const urls = Array.from(selectedBookUrls.value)
    for (const url of urls) {
      await apiSaveBookGroupId(url, groupId)
    }
    // Refresh to get updated groups
    await fetchBooks()
    clearSelection()
  }

  async function reorderBooks(draggedUrl: string, targetUrl: string) {
    if (!draggedUrl || !targetUrl || draggedUrl === targetUrl) return

    const snapshot = books.value.slice()
    const fromIndex = snapshot.findIndex((book) => book.bookUrl === draggedUrl)
    const toIndex = snapshot.findIndex((book) => book.bookUrl === targetUrl)
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return

    const next = snapshot.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)

    books.value = next
    sorting.value = true
    try {
      await apiSaveBooks(next)
    } catch (error) {
      books.value = snapshot
      throw error
    } finally {
      sorting.value = false
    }
  }

  async function moveBookToFront(bookUrl: string, origin?: string) {
    if (!bookUrl || books.value.length <= 1) return

    const snapshot = books.value.slice()
    const fromIndex = snapshot.findIndex(
      (book) => book.bookUrl === bookUrl && (origin === undefined || book.origin === origin)
    )
    if (fromIndex <= 0) return

    const next = snapshot.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.unshift(moved)

    books.value = next
    sorting.value = true
    try {
      await apiSaveBooks(next)
    } catch (error) {
      books.value = snapshot
      throw error
    } finally {
      sorting.value = false
    }
  }

  /**
   * 打开书籍后的「静默置顶」：把最近阅读排到书架最前，但推迟到浏览器空闲时段执行，
   * 不占用打开书籍的关键路径。用户点开书后应立刻进阅读，不该先等一次全量写库、
   * 也不该在书架页亲眼看着这本书跳到第一位。同一本书在途只调度一次。
   */
  const pendingMoveToFront = new Set<string>()
  function moveBookToFrontWhenIdle(bookUrl: string, origin?: string) {
    if (!bookUrl || pendingMoveToFront.has(bookUrl)) return
    pendingMoveToFront.add(bookUrl)
    runWhenIdle(() => {
      void moveBookToFront(bookUrl, origin)
        .catch(() => undefined)
        .finally(() => pendingMoveToFront.delete(bookUrl))
    })
  }

  // ─── 加入书架 ───
  // 旧实现每本书串行跑「saveBook + fetchBooks(慢) + saveBooks」三步，连续加 N 本要 3N 次网络往返。
  // 后端 save_book 内部是「读书架→push→写回」的读-改-写，直接并行发会竞态丢书；
  // 而 save_books 是全量写、无竞态。据此重构为「并行 + 批量 + 乐观」：
  //   1) 调用瞬间本地乐观置顶，书架 UI 立即看到书（不等网络）；
  //   2) 微批窗口内把所有待加入书的 saveBook 并行发出（补全详情，服务端竞态由第 4 步修正）；
  //   3) 一次 fetchBooks 拿权威快照，避免丢失其它设备已加入的书；
  //   4) 用各 saveBook 返回的完整书目合并、置顶、去重后，一次 saveBooks 全量写回服务端。
  // 网络阶段从 3N 降为固定 3 步（不随书本数增长），连续加书快且不丢书。
  type PendingAdd = { input: Partial<Book>; resolve: () => void; reject: (e: unknown) => void }
  const pendingAdds: PendingAdd[] = []
  let addFlushTimer: ReturnType<typeof setTimeout> | null = null
  // 微批窗口：收集这段时间内连续的加入请求合并处理；单本加入也只多等这点时间。
  const ADD_BATCH_WINDOW = 120

  function sameAddKey(a: Partial<Book>, b: Partial<Book>) {
    return a.bookUrl === b.bookUrl && a.origin === b.origin
  }

  function optimisticPrepend(book: Partial<Book>) {
    if (!book.bookUrl) return
    const next = books.value.filter((b) => !sameAddKey(b, book))
    next.unshift({ ...book } as Book)
    books.value = next
  }

  async function flushAdds() {
    addFlushTimer = null
    const batch = pendingAdds.splice(0)
    if (!batch.length) return
    try {
      // 阶段1：并行保存（补全详情 + 落盘）。服务端竞态无妨，最终以第 4 步全量写回为准。
      const savedResults = await Promise.all(
        batch.map(({ input }) => apiSaveBook(input).catch(() => null))
      )
      // 阶段2：一次拉取权威书架（其它设备的书不丢）
      await fetchBooks()
      // 阶段3：用补全后的完整书目覆盖/插入并置顶（后加入的排最前）
      const next = books.value.slice()
      for (const saved of savedResults) {
        if (!saved?.bookUrl) continue
        const idx = next.findIndex((b) => sameAddKey(b, saved))
        if (idx >= 0) next.splice(idx, 1)
        next.unshift(saved as Book)
      }
      // 按 bookUrl+origin 去重，避免重复加入产生重复条目
      const seen = new Set<string>()
      const deduped = next.filter((b) => {
        const key = `${b.origin || ''}||${b.bookUrl}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      books.value = deduped
      saveShelfSnapshot(deduped)
      // 阶段4：单次全量写回，修正服务端竞态，保证所有书都在、置顶顺序跨设备一致
      await apiSaveBooks(deduped)
      void refreshRecentBooks()
      batch.forEach((x) => x.resolve())
    } catch (error) {
      // 失败时回滚乐观更新到服务端权威状态，再拒绝各调用方
      await fetchBooks().catch(() => undefined)
      batch.forEach((x) => x.reject(error))
    }
  }

  function addToShelf(book: Partial<Book>): Promise<void> {
    // 立即乐观置顶：UI 秒显示，无需等待网络
    optimisticPrepend(book)
    return new Promise((resolve, reject) => {
      pendingAdds.push({ input: book, resolve, reject })
      if (addFlushTimer) clearTimeout(addFlushTimer)
      addFlushTimer = setTimeout(() => { void flushAdds() }, ADD_BATCH_WINDOW)
    })
  }

  return {
    books, recentBooks, loading, refreshing, sorting,
    fetchBooks, fetchBooksFast, refreshBooks, removeBook,
    refreshRecentBooks, removeRecentBook, clearAllRecentBooks,
    groups, activeGroupId, displayGroups, filteredBooks,
    fetchGroups, saveGroup, removeGroup,
    searchResults, isSearching, searchKey,
    searchScope, searchCategory, searchGroup, searchSourceUrl, searchSourcePinned, pinSearchSource, startSearch, clearSearch, isSearchMode,
    editMode,
    selectedBookUrls, toggleSelection, selectAll, clearSelection,
    bulkDelete, bulkSetGroup, reorderBooks, moveBookToFront, moveBookToFrontWhenIdle, addToShelf,
  }
})
