import { ref } from 'vue'
import { useReaderStore } from '../stores/reader'
import { useAppStore } from '../stores/app'
import { cacheBookSSE } from '../api/cache'
import { getBookshelfWithCacheInfo, deleteBookCache } from '../api/bookshelf'
import { countBrowserBookCache, deleteBrowserBookCache } from '../utils/browserCache'
import { cacheBookToBrowser, resolveBookChapters } from '../utils/bookCache'
import { isLocalBook } from '../utils/localBook'
import { exportBookToLocal, exportComicEpubToLocal } from '../utils/exportBook'
import { isComicContent } from '../utils/epubExport'

/**
 * 缓存任务全局单例。
 *
 * 状态放在模块级而非组件内，这样关闭缓存面板（组件卸载）后任务仍在后台运行；
 * 重新打开面板时读到的仍是同一份状态，可继续查看进度并点「停止」。
 * 只有显式调用 stopWorking() 才会中断服务端 SSE / 浏览器缓存循环。
 */
const working = ref(false)
/** 当前任务类型：导出到本地 or 章节缓存（供面板标题区分显示） */
const taskKind = ref<'export' | 'cache'>('cache')
const progress = ref(0)
const currentStatus = ref('准备中...')
const currentChapterName = ref('')
const serverCachedCount = ref(0)
const browserCachedCount = ref(0)

let sse: EventSource | null = null
let browserSignal = { cancelled: false }
let exportSignal = { cancelled: false }

export function useCacheTask() {
  const store = useReaderStore()
  const appStore = useAppStore()

  async function refreshStats() {
    if (!store.book) return
    if (isLocalBook(store.book)) {
      serverCachedCount.value = 0
      browserCachedCount.value = 0
      return
    }
    const [serverList, browserCount] = await Promise.all([
      getBookshelfWithCacheInfo().catch(() => []),
      countBrowserBookCache(store.book.bookUrl).catch(() => 0),
    ])
    const matched = serverList.find((book) => book.bookUrl === store.book?.bookUrl)
    serverCachedCount.value = matched?.cachedChapterCount || 0
    browserCachedCount.value = browserCount
  }

  function closeSSE() {
    if (sse) {
      sse.close()
      sse = null
    }
  }

  function stopWorking() {
    browserSignal.cancelled = true
    exportSignal.cancelled = true
    closeSSE()
    working.value = false
  }

  /** 全本导出到本地 TXT：服务器端书与本地导入书均支持，文件名按规范生成。 */
  async function exportWholeBook() {
    if (!store.book) return
    stopWorking()
    exportSignal = { cancelled: false }
    taskKind.value = 'export'
    working.value = true
    progress.value = 0
    currentStatus.value = '准备导出...'
    currentChapterName.value = ''

    try {
      const result = await exportBookToLocal({
        book: store.book,
        chapters: store.chapters.length ? store.chapters : undefined,
        signal: exportSignal,
        onProgress: ({ completed, total, chapterTitle }) => {
          currentChapterName.value = chapterTitle
          currentStatus.value = `导出中 (${completed}/${total})`
          progress.value = total > 0 ? Math.round((completed / total) * 100) : 100
        },
      })
      if (exportSignal.cancelled) {
        currentStatus.value = '导出已取消'
      } else if (result.fileName) {
        currentStatus.value = `已导出《${store.book.name}》，共 ${result.completed} 章`
        progress.value = 100
        appStore.showToast(`已导出：${result.fileName}`, 'success')
      }
    } catch (error) {
      currentStatus.value = '导出失败'
      appStore.showToast((error as Error).message || '导出失败', 'error')
    } finally {
      window.setTimeout(() => {
        working.value = false
      }, 800)
    }
  }

  /**
   * 漫画 EPUB 导出：volumeSize=0 全本一个文件，>0 按该章数分卷。
   * 图片下载失败会保留远程链接占位，并在完成后提示失败数量。
   */
  async function exportComicEpub(volumeSize: number) {
    if (!store.book || isLocalBook(store.book)) return
    stopWorking()
    exportSignal = { cancelled: false }
    taskKind.value = 'export'
    working.value = true
    progress.value = 0
    currentStatus.value = '准备导出漫画...'
    currentChapterName.value = ''

    try {
      const result = await exportComicEpubToLocal({
        book: store.book,
        chapters: store.chapters.length ? store.chapters : undefined,
        volumeSize,
        signal: exportSignal,
        onProgress: ({ completed, total, chapterTitle, phase }) => {
          currentChapterName.value = chapterTitle === '下载图片中' || chapterTitle === '打包中' ? '' : chapterTitle
          if (phase === 'image') {
            // 图片阶段是耗时大头：占进度 10%~95%
            currentStatus.value = total > 0
              ? `下载图片中 (${completed}/${total})`
              : '下载图片中...'
            progress.value = total > 0 ? 10 + Math.round((completed / total) * 85) : 10
          } else if (phase === 'pack') {
            currentStatus.value = '正在打包 EPUB...'
            progress.value = 96
          } else {
            // 抓取章节正文：占进度 0%~10%
            currentStatus.value = `抓取章节正文 (${completed}/${total})`
            progress.value = total > 0 ? Math.round((completed / total) * 10) : 10
          }
        },
      })
      if (exportSignal.cancelled) {
        currentStatus.value = '导出已取消'
      } else if (result.files.length) {
        currentStatus.value = `已导出 ${result.files.length} 个 EPUB，共 ${result.totalImages} 张图`
        progress.value = 100
        const failTip = result.failedImages.length
          ? `，${result.failedImages.length} 张图用远程链接占位`
          : ''
        appStore.showToast(`已导出 ${result.files.length} 个 EPUB${failTip}`, 'success')
      }
    } catch (error) {
      currentStatus.value = '漫画导出失败'
      appStore.showToast((error as Error).message || '导出失败', 'error')
    } finally {
      window.setTimeout(() => {
        working.value = false
      }, 800)
    }
  }

  function startServerCaching(count: number) {
    if (!store.book || isLocalBook(store.book)) return
    stopWorking()
    taskKind.value = 'cache'
    working.value = true
    progress.value = 0
    currentStatus.value = '连接服务端缓存任务...'
    currentChapterName.value = ''

    const total = count === 0
      ? Math.max(0, store.chapters.length - store.currentIndex)
      : Math.min(count, Math.max(0, store.chapters.length - store.currentIndex))

    sse = cacheBookSSE({
      bookUrl: store.book.bookUrl,
      tocUrl: store.currentChapter?.url,
      count,
      concurrentCount: 8,
    })

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        const completed = (data.successCount || 0) + (data.cachedCount || 0) - (data.failedCount || 0)
        if (total > 0) {
          progress.value = Math.min(100, Math.round((Math.max(0, completed) / total) * 100))
        }
        currentStatus.value = `服务端缓存中 (${data.cachedCount || 0} 已缓存 / ${data.successCount || 0} 新增)`
      } catch {
        currentStatus.value = '服务端缓存处理中...'
      }
    }

    sse.addEventListener('end', async (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data)
        currentStatus.value = `服务端缓存完成，累计 ${data.cachedCount || 0} 章`
        progress.value = 100
      } finally {
        closeSSE()
        await refreshStats()
        window.setTimeout(() => {
          working.value = false
        }, 800)
      }
    })

    sse.onerror = async () => {
      currentStatus.value = '服务端缓存已中断'
      closeSSE()
      await refreshStats()
      window.setTimeout(() => {
        working.value = false
      }, 1200)
    }
  }

  async function startBrowserCaching(count: number) {
    if (!store.book || isLocalBook(store.book)) return
    stopWorking()
    browserSignal = { cancelled: false }
    taskKind.value = 'cache'
    working.value = true
    progress.value = 0
    currentStatus.value = '准备浏览器缓存...'
    currentChapterName.value = ''

    try {
      const chapters = store.chapters.length ? store.chapters : await resolveBookChapters(store.book)
      const total = count === 0
        ? Math.max(0, chapters.length - store.currentIndex)
        : Math.min(count, Math.max(0, chapters.length - store.currentIndex))
      await cacheBookToBrowser({
        book: store.book,
        chapters,
        startIndex: store.currentIndex,
        count: count || undefined,
        signal: browserSignal,
        onProgress: ({ completed, total, chapterTitle }) => {
          currentChapterName.value = chapterTitle
          currentStatus.value = `浏览器缓存中 (${completed}/${total})`
          progress.value = total > 0 ? Math.round((completed / total) * 100) : 100
        },
      })
      if (!browserSignal.cancelled) {
        currentStatus.value = `浏览器缓存完成，共 ${total} 章`
        progress.value = 100
        // 静默完成：不弹 Toast，下次打开面板看统计数字
      }
    } catch (error) {
      currentStatus.value = '浏览器缓存失败'
      appStore.showToast((error as Error).message || '浏览器缓存失败', 'error')
    } finally {
      await refreshStats()
      window.setTimeout(() => {
        working.value = false
      }, 800)
    }
  }

  async function clearServerCache() {
    if (!store.book || isLocalBook(store.book)) return
    await deleteBookCache(store.book.bookUrl)
    appStore.showToast('服务端缓存已清除', 'success')
    await refreshStats()
  }

  async function clearBrowserCache() {
    if (!store.book || isLocalBook(store.book)) return
    await deleteBrowserBookCache(store.book.bookUrl)
    appStore.showToast('浏览器缓存已清除', 'success')
    await refreshStats()
  }

  return {
    working,
    taskKind,
    progress,
    currentStatus,
    currentChapterName,
    serverCachedCount,
    browserCachedCount,
    refreshStats,
    startServerCaching,
    startBrowserCaching,
    stopWorking,
    clearServerCache,
    clearBrowserCache,
    exportWholeBook,
    exportComicEpub,
  }
}

/** 依据当前章节正文预判是否为漫画书（供导出入口展示用）。 */
export function isComicBookByContent(content: string | undefined | null): boolean {
  return isComicContent(content || '')
}
