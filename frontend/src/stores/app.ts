import { defineStore } from 'pinia'
import { ref, watch, computed } from 'vue'
import {
  recordReadingTime,
  getUnifiedSummary,
  markBookOpened as recordBookOpened,
  markChapterRead as recordChapterRead,
} from '../utils/readingStats'
import { getUserInfo } from '../api/user'
import { dismissVersionUpdate, getVersionUpdate } from '../api/update'
import type { UserInfo, VersionUpdateInfo } from '../types'
import { applySystemTheme } from '../utils/systemUi'
import { computeNeedSecureKey, readStoredSecureKey, SECURE_KEY_STORAGE_KEY } from '../utils/secureAccess'
import { clearAllCoverMatchAttempts } from '../utils/coverMatchState'

export const useAppStore = defineStore('app', () => {
  // ─── Theme ───
  const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null
  const legacyReaderNight = localStorage.getItem('reader-isNight') === 'true'
  const theme = ref<'light' | 'dark'>(
    savedTheme || (legacyReaderNight ? 'dark' : 'light')
  )

  function setTheme(value: 'light' | 'dark') {
    theme.value = value
    localStorage.setItem('theme', value)
    applySystemTheme(value)
  }

  function toggleTheme() {
    setTheme(theme.value === 'light' ? 'dark' : 'light')
  }

  watch(theme, (val) => {
    localStorage.setItem('theme', val)
    applySystemTheme(val)
  }, { immediate: true })

  // ─── User ───
  const userInfo = ref<UserInfo | null>(null)
  const isSecureMode = ref(false)
  const needSecureKey = ref(false)
  const secureKeyRequired = ref(false)
  const adminAuthorized = ref(false)
  const publicRead = ref(false)
  const isLoggedIn = ref(false)
  const secureKey = ref(readStoredSecureKey())
  const versionUpdate = ref<VersionUpdateInfo | null>(null)
  const versionUpdateLoading = ref(false)
  const versionUpdateChecked = ref(false)
  let versionUpdateToastVersion = ''
  const canCheckVersionUpdate = computed(() => !isSecureMode.value || adminAuthorized.value)
  // 书源管理权限：
  // 1. 管理员（isAdmin 或 adminAuthorized）可管理
  // 2. 已登录普通用户（isLoggedIn）可管理自己的书源
  // 3. 未登录且开启了 publicRead：只读，不允许管理
  // 4. 其他单用户默认情况：允许
  const canManageBookSources = computed(() => {
    if (adminAuthorized.value || !!userInfo.value?.isAdmin) {
      return true
    }
    if (isLoggedIn.value) {
      return true
    }
    return !publicRead.value
  })
  const hasVersionUpdateReminder = computed(() => !!versionUpdate.value?.shouldRemind)

  // 多个视图（App 全局、首页、need-login）都会调用用户信息，
  // 用 in-flight promise 去重，避免同一时刻发出多个重复请求拖慢首屏。
  let userInfoTask: Promise<void> | null = null
  function fetchUserInfo(): Promise<void> {
    if (userInfoTask) return userInfoTask
    userInfoTask = doFetchUserInfo().finally(() => {
      userInfoTask = null
    })
    return userInfoTask
  }

  async function doFetchUserInfo() {
    try {
      const data = await getUserInfo()
      userInfo.value = data.userInfo
      isSecureMode.value = data.secure
      secureKeyRequired.value = data.secureKeyRequired
      adminAuthorized.value = data.adminAuthorized
      publicRead.value = !!data.publicRead
      needSecureKey.value = computeNeedSecureKey({
        secure: data.secure,
        secureKeyRequired: data.secureKeyRequired,
        adminAuthorized: data.adminAuthorized,
      })
      isLoggedIn.value = !!data.userInfo?.username
      if (canCheckVersionUpdate.value) {
        void checkVersionUpdate()
      }
    } catch {
      isLoggedIn.value = false
    }
  }

  function setUser(user: UserInfo) {
    userInfo.value = user
    isLoggedIn.value = true
    adminAuthorized.value = adminAuthorized.value || !!user.isAdmin
    needSecureKey.value = computeNeedSecureKey({
      secure: isSecureMode.value,
      secureKeyRequired: secureKeyRequired.value,
      adminAuthorized: adminAuthorized.value,
    })
    localStorage.setItem('accessToken', user.accessToken)
    if (canCheckVersionUpdate.value) {
      void checkVersionUpdate()
    }
  }

  function clearUser() {
    userInfo.value = null
    isLoggedIn.value = false
    localStorage.removeItem('accessToken')
  }

  function setSecureKey(value: string) {
    const next = value.trim()
    secureKey.value = next
    if (next) {
      localStorage.setItem(SECURE_KEY_STORAGE_KEY, next)
    } else {
      localStorage.removeItem(SECURE_KEY_STORAGE_KEY)
    }
  }

  function updateUserInfo(next: UserInfo | null) {
    userInfo.value = next
    isLoggedIn.value = !!next?.username
  }

  async function checkVersionUpdate(force = false) {
    if (versionUpdateLoading.value) return versionUpdate.value
    versionUpdateLoading.value = true
    try {
      const info = await getVersionUpdate(force)
      versionUpdate.value = info
      versionUpdateChecked.value = true
      if (info.shouldRemind && info.latestVersion && versionUpdateToastVersion !== info.latestVersion) {
        versionUpdateToastVersion = info.latestVersion
        showToast(`发现服务端新版本 ${info.latestVersion}`, 'warning')
      }
      return info
    } catch (error) {
      if (force) {
        showToast((error as Error).message || '检查更新失败', 'error')
      }
      return null
    } finally {
      versionUpdateLoading.value = false
    }
  }

  async function dismissVersionUpdateReminder(version = versionUpdate.value?.latestVersion || '') {
    if (!version) {
      showToast('当前没有可忽略的版本', 'warning')
      return null
    }
    versionUpdateLoading.value = true
    try {
      const info = await dismissVersionUpdate(version)
      versionUpdate.value = info
      versionUpdateToastVersion = version
      showToast('已忽略当前版本更新提醒', 'success')
      return info
    } catch (error) {
      showToast((error as Error).message || '忽略版本失败', 'error')
      return null
    } finally {
      versionUpdateLoading.value = false
    }
  }

  // ─── Search: Exact Match ───
  // 全局「精确匹配」开关：开启后搜索结果只保留书名（或作者）与关键词完全一致的书籍。
  // 设置存于 localStorage，跨会话保留。
  const exactMatch = ref(localStorage.getItem('xread-exact-match') === 'true')

  function setExactMatch(value: boolean) {
    exactMatch.value = value
    localStorage.setItem('xread-exact-match', value ? 'true' : 'false')
  }

  function toggleExactMatch() {
    setExactMatch(!exactMatch.value)
  }

  // ─── Search: Default All Sources ───
  // 全局「全部书源」开关：开启后，发起搜索时默认使用「全部书源」范围，
  // 而非默认的单个书源。设置存于 localStorage，跨会话保留。
  const searchAllByDefault = ref(localStorage.getItem('xread-search-all-default') === 'true')

  function setSearchAllByDefault(value: boolean) {
    searchAllByDefault.value = value
    localStorage.setItem('xread-search-all-default', value ? 'true' : 'false')
  }

  function toggleSearchAllByDefault() {
    setSearchAllByDefault(!searchAllByDefault.value)
  }

  // ─── Local Book Cover Matching (idle) ───
  // 「封面匹配」开关：开启后在浏览器空闲时静默为无封面的本地导入书（TXT/EPUB）
  // 从书源匹配封面并写回。严格仅针对本地导入书，网络书永不进入此链路。默认开启，设置持久化。
  const matchCoverByIdle = ref(localStorage.getItem('xread-match-cover-idle') !== 'false')

  function setMatchCoverByIdle(value: boolean) {
    const wasOff = !matchCoverByIdle.value
    matchCoverByIdle.value = value
    localStorage.setItem('xread-match-cover-idle', value ? 'true' : 'false')
    // 从关→开：清空尝试记录，强制重新匹配一轮（否则书源未变会被判定为已搜过而跳过）
    if (value && wasOff) clearAllCoverMatchAttempts()
  }

  function toggleMatchCoverByIdle() {
    setMatchCoverByIdle(!matchCoverByIdle.value)
  }

  // ─── UI State ───
  const showLoginModal = ref(false)
  const showSettingsDrawer = ref(false)
  const showSourceManager = ref(false)
  const showUserManager = ref(false)
  const showWebdavManager = ref(false)
  const showGroupManager = ref(false)
  const showSearchManage = ref(false)
  const showExploreManage = ref(false)
  const showSourceCompatibility = ref(false)
  // 书源数据版本号：兼容检测深度测试把结论写回 bookSourceGroup 后自增，
  // 书源管理页监听它自动重新拉库，无需用户手动点「刷新书源」。
  const sourceGroupVersion = ref(0)
  function bumpSourceGroupVersion() {
    sourceGroupVersion.value += 1
  }
  const isOnline = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const pwaReady = ref(false)
  const pwaUpdateAvailable = ref(false)
  const deferredInstallPrompt = ref<any>(null)
  const waitingServiceWorker = ref<ServiceWorker | null>(null)

  // 阅读统计统一由 utils/readingStats（xread-reading-stats-v2）承载：
  // 本 store 只保留「阅读会话计时」职责（进入/离开阅读页），计时结束把时长记入新数据源；
  // 书籍/章节标记也转发到新数据源。此处不再单独维护 totalSeconds，避免两套数据重复累加。
  let readingSessionStartedAt = 0

  function startReadingSession() {
    if (!readingSessionStartedAt) readingSessionStartedAt = Date.now()
  }

  function stopReadingSession(bookInfo?: { bookUrl: string; bookName: string; author?: string; coverUrl?: string; origin?: string }) {
    if (!readingSessionStartedAt) return
    const delta = Math.max(0, Math.round((Date.now() - readingSessionStartedAt) / 1000))
    readingSessionStartedAt = 0
    if (delta > 0) {
      recordReadingTime(delta, bookInfo)
    }
  }

  function markBookOpened(bookUrl: string) {
    recordBookOpened(bookUrl)
  }

  function markChapterRead(bookUrl: string, index: number, totalChapters: number) {
    recordChapterRead(bookUrl, index, totalChapters)
  }

  const readingStatsSummary = computed(() => getUnifiedSummary())

  // ─── Toast ───
  const toasts = ref<Array<{ id: number; message: string; type: string }>>([])
  let toastId = 0

  function showToast(
    message: string,
    type: 'success' | 'error' | 'warning' = 'success',
    duration = 3000,
  ) {
    const id = ++toastId
    toasts.value.push({ id, message, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, duration)
  }

  // 可更新的进度 toast：复用右上角 toast 容器，进度期间常驻不自动消失，
  // 完成后转成结果态并在 3 秒后消失。用于批量导入/导出等串行任务的实时进度。
  function showProgressToast(message: string) {
    const id = ++toastId
    toasts.value.push({ id, message, type: 'progress' })
    return id
  }

  function updateProgressToast(id: number, message: string) {
    const toast = toasts.value.find((t) => t.id === id)
    if (toast) toast.message = message
  }

  function finishProgressToast(
    id: number,
    message: string,
    type: 'success' | 'error' | 'warning' = 'success',
  ) {
    const toast = toasts.value.find((t) => t.id === id)
    if (!toast) return
    toast.message = message
    toast.type = type
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, 3000)
  }

  // ─── 批量任务进度（驱动导入/导出按钮文字）───
  // kind 为空表示无进行中的任务；同一时刻只允许一种批量任务。
  const batchTask = ref<{ kind: 'import' | 'export' | null; current: number; total: number }>({
    kind: null,
    current: 0,
    total: 0,
  })

  function startBatchTask(kind: 'import' | 'export', total: number) {
    batchTask.value = { kind, current: 0, total }
  }

  function updateBatchTask(current: number) {
    batchTask.value.current = current
  }

  function finishBatchTask() {
    batchTask.value = { kind: null, current: 0, total: 0 }
  }

  function setOnlineStatus(value: boolean) {
    isOnline.value = value
  }

  function setPwaReady(value: boolean) {
    pwaReady.value = value
  }

  function setPwaUpdateAvailable(value: boolean) {
    pwaUpdateAvailable.value = value
  }

  function setWaitingServiceWorker(value: ServiceWorker | null) {
    waitingServiceWorker.value = value
  }

  function setDeferredInstallPrompt(value: any) {
    deferredInstallPrompt.value = value
  }

  async function installPwa() {
    if (!deferredInstallPrompt.value) return false
    deferredInstallPrompt.value.prompt()
    const result = await deferredInstallPrompt.value.userChoice.catch(() => null)
    deferredInstallPrompt.value = null
    return result?.outcome === 'accepted'
  }

  function applyPwaUpdate() {
    if (!waitingServiceWorker.value) return false
    waitingServiceWorker.value.postMessage({ type: 'SKIP_WAITING' })
    return true
  }

  return {
    theme, setTheme, toggleTheme,
    exactMatch, setExactMatch, toggleExactMatch,
    searchAllByDefault, setSearchAllByDefault, toggleSearchAllByDefault,
    matchCoverByIdle, setMatchCoverByIdle, toggleMatchCoverByIdle,
    userInfo, isSecureMode, needSecureKey, secureKeyRequired, adminAuthorized, publicRead,
    canManageBookSources, secureKey, isLoggedIn,
    versionUpdate, versionUpdateLoading, versionUpdateChecked, canCheckVersionUpdate, hasVersionUpdateReminder,
    fetchUserInfo, setUser, clearUser, setSecureKey, updateUserInfo, checkVersionUpdate, dismissVersionUpdateReminder,
    showLoginModal, showSettingsDrawer, showSourceManager, showUserManager, showWebdavManager, showGroupManager, showSearchManage, showExploreManage, showSourceCompatibility,
    sourceGroupVersion, bumpSourceGroupVersion,
    isOnline, pwaReady, pwaUpdateAvailable, deferredInstallPrompt, waitingServiceWorker,
    setOnlineStatus, setPwaReady, setPwaUpdateAvailable, setDeferredInstallPrompt, setWaitingServiceWorker, installPwa, applyPwaUpdate,
    readingStatsSummary, startReadingSession, stopReadingSession, markBookOpened, markChapterRead,
    toasts, showToast, showProgressToast, updateProgressToast, finishProgressToast,
    batchTask, startBatchTask, updateBatchTask, finishBatchTask,
  }
})
