<template>
  <div class="home-view">
    <!-- Search Mode -->
    <SearchResults
      v-if="shelfStore.isSearchMode"
      @back="shelfStore.clearSearch()"
    />

    <!-- Normal Bookshelf View -->
    <div v-else class="shelf-content">
      <!-- Shelf Header (Edit mode selection actions) -->
      <div v-if="isLoggedIn && shelfStore.editMode" class="shelf-header">
        <div class="shelf-actions">
          <button class="shelf-btn" type="button" title="全选" aria-label="全选" @click="shelfStore.selectAll()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <span class="shelf-btn-label">全选</span>
          </button>
          <button class="shelf-btn" type="button" title="取消全选" aria-label="取消全选" @click="shelfStore.clearSelection()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M8 12h8" />
            </svg>
            <span class="shelf-btn-label">取消全选</span>
          </button>
          <button
            class="shelf-btn active"
            type="button"
            title="完成"
            aria-label="完成"
            @click="toggleEditMode"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span class="shelf-btn-label">完成</span>
          </button>
        </div>
      </div>

      <input
        ref="localBookFileInputRef"
        type="file"
        multiple
        accept=".txt,.epub,text/plain,application/epub+zip"
        class="hidden-input"
        @change="handleLocalBookFileChange"
      />

      <!-- Group Tabs -->
      <div class="group-tabs">
        <div class="tabs-scroll">
          <button
            v-for="group in shelfStore.displayGroups"
            :key="group.groupId"
            class="tab-item"
            :class="{ active: shelfStore.activeGroupId === group.groupId }"
            @click="shelfStore.activeGroupId = group.groupId"
          >
            {{ group.groupName }}
          </button>
        </div>
      </div>

      <!-- Book Grid -->
      <div class="shelf-grid-wrapper">
        <BookGrid
          :books="shelfStore.filteredBooks"
          :edit-mode="shelfStore.editMode"
          :selected-urls="shelfStore.selectedBookUrls"
          :loading="shelfStore.loading"
          :sortable="!shelfStore.editMode && !shelfStore.loading && !shelfStore.sorting && !shelfStore.isSearchMode"
          empty-text="书架空空如也，搜索添加新书吧"
        @click="handleBookClick"
        @info="handleBookInfo"
        @delete="handleDeleteBook"
        @ai="handleBookAi"
        @select="shelfStore.toggleSelection($event.bookUrl)"
        @reorder="handleReorderBooks"
        />
      </div>

      <!-- Batch Toolbar -->
      <Transition name="slide-up">
        <div v-if="shelfStore.editMode && shelfStore.selectedBookUrls.size > 0" class="batch-toolbar">
          <div class="batch-info">
            已选中 <span>{{ shelfStore.selectedBookUrls.size }}</span> 本书
          </div>
          <div class="batch-actions">
            <button class="batch-btn" :disabled="bulkExporting || appStore.batchTask.kind === 'export'" @click="handleBulkExport">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>
              {{
                appStore.batchTask.kind === 'export'
                  ? `导出 ${appStore.batchTask.current}/${appStore.batchTask.total}`
                  : '批量导出'
              }}
            </button>
            <button class="batch-btn" @click="handleBulkMove">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
              移动分组
            </button>
            <button class="batch-btn danger" @click="handleBulkDelete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a3 3 0 0 1-3-3H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
              批量删除
            </button>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Book Detail Modal -->
    <BookDetailModal
      v-model="showDetail"
      :book="selectedBook"
    />

    <!-- Group Select Modal -->
    <GroupSelectModal
      v-model="showGroupSelect"
      @select="handleSetGroup"
    />
    <GroupManagerModal v-model="showGroupManager" />

    <CacheLibraryModal v-model="showCacheManager" />

    <!-- 批量导出：下载清单，每个文件为原生 <a download> 链接，用户逐个真实点击下载 -->
    <Transition name="fade">
      <div v-if="showDownloadList" class="download-confirm-mask" @click.self="closeDownloadList">
        <div class="download-list-card">
          <div class="dl-confirm-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
            </svg>
          </div>
          <div class="dl-confirm-title">下载文件</div>
          <div class="dl-list-hint">共 {{ downloadList.length }} 个文件，点「下载」逐个保存</div>
          <div class="dl-list-scroll">
            <a
              v-for="(item, i) in downloadList"
              :key="i"
              class="dl-list-item"
              :href="item.url"
              :download="item.fileName"
              target="_blank"
              rel="noopener"
            >
              <span class="dl-item-index">{{ i + 1 }}</span>
              <span class="dl-item-name">{{ item.fileName }}</span>
              <span class="dl-item-download">下载</span>
            </a>
          </div>
          <button class="dl-btn ghost dl-list-close" type="button" @click="closeDownloadList">关闭</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useBookshelfStore } from '../stores/bookshelf'
import { useReaderStore } from '../stores/reader'
import { useAppStore } from '../stores/app'
import { uploadEpubBook, uploadTxtBook } from '../api/bookshelf'
import type { LocalBookUploadMeta } from '../api/bookshelf'
import { isStandardLocalFileName, parseLocalBookMeta, readTextHead } from '../utils/localBook'
import {
  exportOneBookSilently,
  beginBatchExport,
  takeBatchFiles,
  makeBatchDownloadItems,
  revokeBatchDownloadItems,
  abortBatchExport,
  type BatchFile,
  type BatchDownloadItem,
} from '../utils/exportBook'
import BookGrid from '../components/BookGrid.vue'
import BookDetailModal from '../components/BookDetailModal.vue'
import GroupSelectModal from '../components/bookshelf/GroupSelectModal.vue'
import GroupManagerModal from '../components/bookshelf/GroupManagerModal.vue'
import SearchResults from '../components/SearchResults.vue'
import CacheLibraryModal from '../components/CacheLibraryModal.vue'
import type { Book, SearchBook } from '../types'

const router = useRouter()
const shelfStore = useBookshelfStore()
const readerStore = useReaderStore()
const appStore = useAppStore()
const isLoggedIn = computed(() => appStore.isLoggedIn)

const showDetail = ref(false)
const showGroupSelect = ref(false)
const showGroupManager = ref(false)
const showCacheManager = ref(false)
const selectedBook = ref<Book | SearchBook | null>(null)
const openingBookUrl = ref('')
const localBookFileInputRef = ref<HTMLInputElement | null>(null)
const localBookUploading = ref(false)
const bulkExporting = ref(false)

// 批量数量软提示阈值：超过后仅告知用户将串行处理，不设硬上限、不阻止操作。
const BATCH_SOFT_HINT_LIMIT = 20

// 批量导出：先把所有书导出好，弹出下载清单，每个文件是原生 <a download> 链接，
// 由用户逐个【真实点击】下载。iOS Safari 在系统下载框弹出后会打断页面 JS 流程，
// 因此下载阶段不依赖任何 Promise 链，每个链接点击都是独立用户手势，真正点一个下一个。
const downloadList = ref<BatchDownloadItem[]>([])
const showDownloadList = ref(false)

function closeDownloadList() {
  showDownloadList.value = false
  // 稍后释放 objectURL：给用户留出点击下载的时间窗口
  const items = downloadList.value
  downloadList.value = []
  window.setTimeout(() => revokeBatchDownloadItems(items), 5 * 60_000)
}

/** 数量较大时给一条更持久的提示，让用户知道是串行处理而非卡住（导出额外提示浏览器多下载拦截）。 */
function showBatchSizeHint(kind: 'import' | 'export', total: number) {
  if (total <= BATCH_SOFT_HINT_LIMIT) return
  if (kind === 'export') {
    appStore.showToast(
      `本次 ${total} 本串行导出，完成后逐个点击下载`,
      'warning',
      6000,
    )
  } else {
    appStore.showToast(
      `本次 ${total} 本串行导入，需要一些时间请耐心等待`,
      'warning',
      6000,
    )
  }
}

onMounted(async () => {
  window.addEventListener('trigger-local-book-upload', triggerLocalBookUpload)
  // 用户信息不再串行阻塞书架首屏：App.vue 挂载时已发起同一请求（内部共享 promise 去重无需重复等待），
  // 这里仅做一次不等待的兜底刷新，书架书籍/分组立即并行加载。
  void appStore.fetchUserInfo()
  await Promise.all([
    shelfStore.fetchBooksFast().catch(() => undefined),
    shelfStore.fetchGroups().catch(() => undefined),
  ])
  if (!appStore.isOnline) {
    const restored = await readerStore.restorePersistedSession()
    if (restored) {
      appStore.showToast('已恢复最近阅读的离线章节', 'success')
      router.replace('/reader')
    }
  }
})

function triggerLocalBookUpload() {
  if (localBookUploading.value) return
  localBookFileInputRef.value?.click()
}

async function handleLocalBookFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return

  // 先按扩展名过滤，非法文件单独计数，不阻断合法文件导入。
  const valid = files.filter((f) => {
    const lower = f.name.toLowerCase()
    return lower.endsWith('.txt') || lower.endsWith('.epub')
  })
  const skipped = files.length - valid.length
  if (!valid.length) {
    appStore.showToast('只支持导入 .txt 或 .epub 文件', 'warning')
    return
  }

  if (localBookUploading.value || appStore.batchTask.kind) return
  localBookUploading.value = true
  appStore.startBatchTask('import', valid.length)
  showBatchSizeHint('import', valid.length)
  const toastId = appStore.showProgressToast(`正在导入 1/${valid.length}`)

  const importedUrls: Array<{ bookUrl: string; origin?: string }> = []
  let success = 0
  let failed = 0
  let nonStandard = 0

  // 串行导入：逐本解析+上传，单本失败不影响其余，避免并发峰值。
  for (let i = 0; i < valid.length; i += 1) {
    const file = valid[i]
    appStore.updateBatchTask(i + 1)
    appStore.updateProgressToast(toastId, `正在导入 ${i + 1}/${valid.length}：${file.name}`)
    const lowerName = file.name.toLowerCase()
    try {
      // 前端解析出书名/作者/简介，作为字段传给后端；后端按值入库，不再解析文件名规范。
      let book
      if (lowerName.endsWith('.epub')) {
        book = await uploadEpubBook(file)
      } else {
        const headText = await readTextHead(file)
        const meta: LocalBookUploadMeta = parseLocalBookMeta(file.name, headText)
        book = await uploadTxtBook(file, meta)
      }
      if (book?.bookUrl) importedUrls.push({ bookUrl: book.bookUrl, origin: book.origin })
      success += 1
      if (!isStandardLocalFileName(file.name)) nonStandard += 1
    } catch {
      failed += 1
    }
  }

  // 全部导入完成后统一刷新书架一次，再批量置顶（逆序 forEach，保持选择顺序：最后导入的在最前）。
  if (success > 0) {
    await shelfStore.fetchBooks().catch(() => undefined)
    for (const item of importedUrls.slice().reverse()) {
      await shelfStore.moveBookToFront(item.bookUrl, item.origin).catch(() => undefined)
    }
  }

  // 汇总提示：与批量导出风格一致。
  const parts = [`已导入 ${success} 本`]
  if (failed > 0) parts.push(`${failed} 本失败`)
  if (skipped > 0) parts.push(`${skipped} 个非 txt/epub 已跳过`)
  if (nonStandard > 0) parts.push(`${nonStandard} 本文件名格式需兼容`)
  const hasProblem = failed > 0 || skipped > 0 || nonStandard > 0
  appStore.finishProgressToast(toastId, parts.join('，'), success > 0 ? (hasProblem ? 'warning' : 'success') : 'error')

  appStore.finishBatchTask()
  localBookUploading.value = false

  // 导入完成后不再自动打开书籍，也不在导入时搜索补封面，减轻批量导入负担。
  // 本地书封面改由书架空闲时静默匹配（设置→搜索管理→封面匹配 开关控制，仅本地导入书）。
}

async function handleBookClick(book: Book | SearchBook) {
  const b = book as Book
  if (openingBookUrl.value === b.bookUrl) return

  openingBookUrl.value = b.bookUrl
  const targetIndex = b.durChapterIndex || 0

  try {
    // 打开书籍不再先等「置顶写库」：直接进阅读页，置顶改为打开完成后的空闲静默任务，
    // 既加快打开速度，也避免用户在书架页亲眼看到这本书跳到第一位。
    const loadBookTask = readerStore.loadBook(b)
    await router.push('/reader')
    await loadBookTask
    await readerStore.loadChapter(targetIndex)
    shelfStore.moveBookToFrontWhenIdle(b.bookUrl, b.origin)
  } finally {
    openingBookUrl.value = ''
  }
}

function handleBookInfo(book: Book | SearchBook) {
  selectedBook.value = book
  showDetail.value = true
}

function handleBookAi(book: Book | SearchBook) {
  const currentBook = book as Book
  router.push({
    name: 'ai-book',
    query: { bookUrl: currentBook.bookUrl },
  })
}

async function handleDeleteBook(book: Book | SearchBook) {
  const b = book as Book
  if (!confirm(`确定从书架删除 "${b.name}"？`)) return
  try {
    await shelfStore.removeBook(b)
    appStore.showToast(`已删除 "${b.name}"`, 'success')
  } catch (e: unknown) {
    appStore.showToast((e as Error).message, 'error')
  }
}

function toggleEditMode() {
  shelfStore.editMode = !shelfStore.editMode
  if (!shelfStore.editMode) {
    shelfStore.clearSelection()
  }
}

/**
 * 批量导出：逐本串行把内容导出到内存（无下载），全部完成后弹出下载清单。
 * 清单里每个文件是原生 <a download> 链接，由用户逐个真实点击下载——iOS Safari
 * 系统下载框弹出会打断页面 JS，故下载阶段不依赖任何 JS 流程，点一个下一个。
 * 结束时一个 toast 汇总准备成功/失败数，清单关闭后延迟释放 objectURL。
 */
async function handleBulkExport() {
  if (bulkExporting.value || appStore.batchTask.kind) return
  const selected = shelfStore.books.filter((b) => shelfStore.selectedBookUrls.has(b.bookUrl))
  if (!selected.length) {
    appStore.showToast('请先选择要导出的书籍', 'warning')
    return
  }
  bulkExporting.value = true
  appStore.startBatchTask('export', selected.length)
  showBatchSizeHint('export', selected.length)
  const toastId = appStore.showProgressToast(`正在准备 1/${selected.length}`)
  let failed = 0
  const allFiles: BatchFile[] = []
  beginBatchExport()
  try {
    for (let i = 0; i < selected.length; i += 1) {
      appStore.updateBatchTask(i + 1)
      appStore.updateProgressToast(toastId, `正在准备 ${i + 1}/${selected.length}：${selected[i].name}`)
      try {
        await exportOneBookSilently(selected[i])
      } catch {
        failed += 1
      }
      // 取出这本书生成的文件（小说 1 个，漫画可能多个分卷），汇总到清单
      allFiles.push(...takeBatchFiles())
    }
    const parts: string[] = []
    if (allFiles.length > 0) parts.push(`已备好 ${allFiles.length} 个文件`)
    if (failed > 0) parts.push(`${failed} 本失败`)
    appStore.finishProgressToast(
      toastId,
      parts.join('，') || '没有可下载的文件',
      failed > 0 ? (allFiles.length > 0 ? 'warning' : 'error') : 'success',
    )
    if (allFiles.length > 0) {
      downloadList.value = makeBatchDownloadItems(allFiles)
      showDownloadList.value = true
    }
  } catch {
    abortBatchExport()
    appStore.finishProgressToast(toastId, '导出失败', 'error')
  } finally {
    abortBatchExport() // 幂等：文件已转成本地 objectURL，收集器可安全关闭
    appStore.finishBatchTask()
    bulkExporting.value = false
  }
}

async function handleBulkDelete() {
  const count = shelfStore.selectedBookUrls.size
  if (!confirm(`确定删除选中的 ${count} 本书？`)) return
  try {
    await shelfStore.bulkDelete()
    appStore.showToast(`成功删除 ${count} 本书`, 'success')
  } catch (e: any) {
    appStore.showToast(e.message, 'error')
  }
}

async function handleBulkMove() {
  showGroupSelect.value = true
}

async function handleSetGroup(groupId: number) {
  const count = shelfStore.selectedBookUrls.size
  try {
    await shelfStore.bulkSetGroup(groupId)
    appStore.showToast(`成功将 ${count} 本书移至新分组`, 'success')
  } catch (e: any) {
    appStore.showToast(e.message, 'error')
  }
}
async function handleReorderBooks(payload: { draggedUrl: string; targetUrl: string }) {
  try {
    await shelfStore.reorderBooks(payload.draggedUrl, payload.targetUrl)
  } catch (e: any) {
    appStore.showToast(e.message || '排序失败', 'error')
  }
}
</script>

<style scoped>
.home-view {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.home-view::-webkit-scrollbar {
  display: none;
}

.shelf-content {
  height: 100%;
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding: 0 var(--space-6);
  display: flex;
  flex-direction: column;
  min-height: 0;
}


.hidden-input {
  display: none;
}

.shelf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-6) 0 var(--space-3);
}

.shelf-title {
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.book-count {
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--color-text-tertiary);
}

.shelf-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.shelf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 90px;
  min-height: 38px;
  padding: 0;
  border-radius: 999px;
  font-size: 13.5px;
  font-weight: 500;
  color: #555862;
  background: rgba(255, 255, 255, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.8);
  box-shadow:
    0 4px 12px rgba(0, 0, 0, 0.04),
    inset 0 1px 1.5px rgba(255, 255, 255, 0.95),
    inset 0 -1px 1px rgba(0, 0, 0, 0.03);
  backdrop-filter: blur(24px) saturate(190%);
  -webkit-backdrop-filter: blur(24px) saturate(190%);
  transition: all var(--duration-fast);
  white-space: nowrap;
}

[data-theme='dark'] .shelf-btn,
.theme-dark .shelf-btn {
  color: rgba(235, 237, 242, 0.75);
  background: rgba(28, 29, 34, 0.62);
  border-color: rgba(255, 255, 255, 0.14);
  box-shadow:
    0 6px 16px rgba(0, 0, 0, 0.35),
    inset 0 1px 1px rgba(255, 255, 255, 0.18),
    inset 0 -1px 1px rgba(0, 0, 0, 0.45);
}

.shelf-btn:disabled {
  opacity: 0.55;
  cursor: wait;
}

.shelf-btn svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.shelf-btn:hover {
  background: rgba(255, 255, 255, 0.85);
  color: var(--color-primary);
  border-color: rgba(255, 255, 255, 0.95);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.07);
}

[data-theme='dark'] .shelf-btn:hover,
.theme-dark .shelf-btn:hover {
  background: rgba(45, 47, 54, 0.85);
  color: var(--color-primary);
  border-color: rgba(255, 255, 255, 0.25);
}

.shelf-btn.active {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--color-primary) 35%, transparent);
}

.shelf-btn:active {
  transform: scale(0.96);
}

.shelf-btn .spinning {
  animation: shelf-spin 0.9s linear infinite;
}

@keyframes shelf-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.group-tabs {
  border-bottom: none;
  margin-bottom: var(--space-2);
  position: relative;
}

.tabs-scroll {
  display: flex;
  gap: 0;
  /* 关键修复：原先 justify-content:center 与 overflow-x:auto 同时存在时，
     内容超出一屏会被两端裁切、且左端无法滚动到（经典 flex 居中溢出 bug）。
     改为 width:fit-content + max-width:100% + margin:0 auto：
     分类少时整体居中，分类多时占满宽度并能在内部完整横向滚动。 */
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  /* 左右两端各 14px 渐隐，提示还有更多分类可滑动 */
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.tabs-scroll::-webkit-scrollbar {
  display: none;
}

.tab-item {
  padding: var(--space-3) var(--space-5);
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text-tertiary);
  white-space: nowrap;
  position: relative;
  transition: color var(--duration-fast);
  border-bottom: none;
  margin-bottom: 0;
}

.tab-item:hover {
  color: var(--color-text-secondary);
}

.tab-item.active {
  color: var(--color-primary);
  border-bottom: none;
}

.shelf-grid-wrapper {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: calc(104px + var(--space-6));
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.shelf-grid-wrapper::-webkit-scrollbar {
  display: none;
}

.batch-toolbar {
  position: fixed;
  bottom: calc(104px + var(--space-4));
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-xl);
  border-radius: var(--radius-2xl);
  padding: var(--space-3) var(--space-6);
  display: flex;
  align-items: center;
  gap: var(--space-8);
  z-index: calc(var(--z-sticky) + 5);
  backdrop-filter: blur(12px);
}

.batch-info {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.batch-info span {
  font-weight: 700;
  color: var(--color-primary);
  margin: 0 4px;
}

.batch-actions {
  display: flex;
  gap: var(--space-2);
}

.batch-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  font-weight: 600;
  background: var(--color-bg-hover);
  color: var(--color-text-secondary);
  transition: all var(--duration-fast);
}

.batch-btn:hover {
  background: var(--color-bg-sunken);
  color: var(--color-text);
}

.batch-btn.danger {
  color: var(--color-danger);
}

.batch-btn svg {
  width: 16px;
  height: 16px;
}

/* slide-up transition */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all var(--duration-normal) var(--ease-out);
}
.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translate(-50%, 20px);
}

@media (max-width: 640px) {
  .shelf-content {
    padding: 0 var(--space-4);
  }

  .shelf-header {
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5) 0 var(--space-3);
  }

  .shelf-title {
    flex: 0 0 auto;
    font-size: var(--text-2xl);
  }

  .shelf-actions {
    flex: 1 1 auto;
    justify-content: flex-end;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .shelf-actions::-webkit-scrollbar {
    display: none;
  }

  .shelf-btn {
    width: 42px;
    min-width: 42px;
    height: 42px;
    min-height: 42px;
    padding: 0;
    border-radius: var(--radius-lg);
  }

  .shelf-btn svg {
    width: 19px;
    height: 19px;
  }

  .shelf-btn-label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .batch-toolbar {
    width: calc(100% - var(--space-8));
    bottom: calc(104px + var(--space-3));
    gap: var(--space-4);
    justify-content: space-between;
  }
  .batch-info { display: none; }
}

/* ===== 批量导出：下载清单（玻璃拟态 + 主题色，跟随日/夜主题） ===== */
.download-confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding:
    calc(16px + var(--safe-area-top, 0px))
    calc(16px + var(--safe-area-right, 0px))
    calc(16px + var(--safe-area-bottom, 0px))
    calc(16px + var(--safe-area-left, 0px));
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.download-list-card {
  width: 100%;
  max-width: 380px;
  max-height: calc(var(--app-height, 100dvh) - var(--safe-area-top, 0px) - var(--safe-area-bottom, 0px) - 32px);
  padding: var(--space-6);
  border-radius: var(--radius-2xl, 20px);
  /* 玻璃拟态：与 toast 同一套变量，自动跟随日间/夜间 */
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow), var(--glass-inset-highlight);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  text-align: center;
  display: flex;
  flex-direction: column;
}

.dl-confirm-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto var(--space-3);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--color-primary);
  background: var(--color-primary-bg);
  flex-shrink: 0;
}
.dl-confirm-icon svg { width: 22px; height: 22px; }

.dl-confirm-title {
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--color-text);
  flex-shrink: 0;
}

.dl-list-hint {
  margin-top: var(--space-2);
  margin-bottom: var(--space-3);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.dl-list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.dl-list-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 10px 12px;
  border-radius: var(--radius-lg, 12px);
  background: var(--color-bg-hover);
  border: 1px solid var(--glass-border-subtle);
  text-decoration: none;
  color: var(--color-text);
  text-align: left;
  transition: background 0.15s ease;
}
.dl-list-item:hover { background: var(--glass-bg-hover); }
.dl-list-item:active { opacity: 0.7; }

.dl-item-index {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text-inverse, #fff);
  background: var(--color-primary);
}

.dl-item-name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-item-download {
  flex-shrink: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-primary);
}

.dl-list-close {
  margin-top: var(--space-4);
  flex-shrink: 0;
}

.dl-btn {
  min-width: 0;
  padding: 10px 8px;
  border-radius: var(--radius-lg, 12px);
  font-size: var(--text-sm);
  font-weight: 600;
  border: 1px solid var(--glass-border-subtle);
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.dl-btn:active { opacity: 0.7; }
.dl-btn.ghost {
  color: var(--color-text-secondary);
  background: var(--color-bg-hover);
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
