<template>
  <div class="reader-artplayer-stage">
    <div class="reader-artplayer-wrapper" :style="wrapperStyle">
      <div
        v-if="props.title"
        class="reader-video-title"
        :class="{ 'is-hidden': titleHidden }"
      >
        <span class="reader-video-title-text">{{ props.title }}</span>
      </div>

      <!-- 左上角关闭：退出视频返回书架。跟随控制层显隐，全屏时也能用 -->
      <Teleport :to="playerHost" :disabled="!playerHost">
        <button
          class="rv-close-btn"
          :class="{ 'is-hidden': !controlsVisible }"
          aria-label="关闭视频返回书架"
          @click.stop="emit('goHome')"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        <!-- 右上角更多：从底部控制栏移出，点它唤出画面/速度/开关面板。跟随控制层显隐 -->
        <button
          class="rv-more-top-btn"
          :class="{ 'is-hidden': !controlsVisible }"
          aria-label="更多设置"
          @click.stop="toggleMorePanel"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </Teleport>

      <div
        class="reader-artplayer-container"
        :class="{ 'rv-narrow': isNarrowPlayer }"
        ref="artContainerRef"
      ></div>

      <!-- 视频转换下载进度：转码期间持续显示；原生全屏时它作为 .art-video-player 的
           兄弟节点被浏览器自动隐藏，退出全屏后只要仍在转码就自动恢复显示。
           「关闭」只是隐藏弹窗、后台继续转码；「取消」真正中止任务。 -->
      <div v-if="downloadConverting" class="rv-download-progress" aria-label="视频转换下载中">
        <div class="rv-download-progress-card rv-glass">
          <div class="rv-download-spinner"></div>
          <div class="rv-download-text">{{ downloadStatusText }}</div>
          <div class="rv-download-bar" :class="{ 'is-determinate': downloadPercent > 0 }">
            <span
              class="rv-download-bar-inner"
              :style="downloadPercent > 0 ? { width: downloadPercent + '%', animation: 'none' } : undefined"
            ></span>
          </div>
          <div v-if="downloadPercent > 0" class="rv-download-percent">{{ downloadPercent }}%</div>
          <div class="rv-download-hint">转换完成后自动保存到本地</div>
          <div class="rv-download-actions">
            <button class="rv-dl-btn rv-dl-cancel" @click.stop="cancelDownload">取消下载</button>
            <button class="rv-dl-btn rv-dl-close" @click.stop="closeDownloadPopup">继续下载</button>
          </div>
        </div>
      </div>

      <!-- 更多面板：Teleport 进 ArtPlayer 的 .art-video-player 内部，
           这样原生全屏时它随全屏元素一起显示（否则作为兄弟节点会被浏览器隐藏） -->
      <Teleport :to="playerHost" :disabled="!playerHost">
        <div v-if="morePanelVisible" class="rv-more-backdrop" @click.stop="closeMorePanel"></div>
        <div v-if="morePanelVisible" class="rv-more-panel rv-glass" :class="{ 'is-hidden': !controlsVisible }" @click.stop>
          <!-- 画面：最上面 -->
          <div class="rv-more-group">
            <div class="rv-more-title">画面</div>
            <div class="rv-more-row">
              <button
                v-for="opt in FIT_OPTIONS"
                :key="opt.value"
                :class="{ active: currentFit === opt.value }"
                @click="setFit(opt.value)"
              >{{ opt.label }}</button>
            </div>
          </div>
          <!-- 播放速度：中部 -->
          <div class="rv-more-group">
            <div class="rv-more-title">播放速度</div>
            <div class="rv-more-row">
              <button
                v-for="rate in RATE_OPTIONS"
                :key="rate"
                :class="{ active: currentRate === rate }"
                @click="setRate(rate)"
              >{{ rate }}x</button>
            </div>
          </div>
          <!-- 播放开关 -->
          <div class="rv-more-group rv-more-toggles">
            <button :class="{ active: autoPlayToggle }" @click="toggleAutoPlay">自动连播</button>
            <button :class="{ active: loopToggle }" @click="toggleLoop">循环播放</button>
            <button :class="{ active: flipToggle }" @click="toggleFlip">水平翻转</button>
            <button @click="togglePip">画中画</button>
          </div>
        </div>

        <!-- 选集面板：从「更多」里独立出来，由控制栏的选集图标唤出 -->
        <div v-if="catalogPanelVisible" class="rv-catalog-backdrop" @click.stop="closeCatalogPanel"></div>
        <div v-if="catalogPanelVisible" class="rv-catalog-panel rv-glass" :class="{ 'is-hidden': !controlsVisible }" @click.stop>
          <div class="rv-more-title">选集</div>
          <div class="rv-catalog-list">
            <button :disabled="!props.hasPrev" @click="onMorePrev">上一集</button>
            <button @click="onMoreCatalog">目录</button>
            <button :disabled="!props.hasNext" @click="onMoreNext">下一集</button>
            <button @click="downloadCurrentVideo">下载</button>
          </div>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Artplayer from 'artplayer'
import Hls from 'hls.js'
import { buildAuthHeaderValues } from '../../utils/secureAccess'
import { buildVideoFileName } from '../../utils/localBook'
import { isBackgroundTaskActive } from '../../utils/videoDownloadSession'

const props = withDefaults(
  defineProps<{
    url: string
    title?: string
    bookTitle?: string
    isNight?: boolean
    hasPrev?: boolean
    hasNext?: boolean
  }>(),
  {
    title: '',
    bookTitle: '',
    isNight: false,
    hasPrev: false,
    hasNext: false,
  },
)

const emit = defineEmits<{
  (e: 'prev'): void
  (e: 'next'): void
  (e: 'catalog'): void
  (e: 'goHome'): void
  (e: 'ended'): void
  (e: 'timeupdate', current: number, duration: number): void
}>()

// iOS（含 iPad 桌面模式）判定：只有它能用系统原生视频全屏 webkitEnterFullscreen，
// 这是隐藏手机状态栏 + 让视频随自身方向自动横竖屏的唯一可行方式。
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// 双击统一走自定义全屏：关闭 ArtPlayer 内置双击（PC 切全屏 / 移动端播放暂停），
// 改由我们监听 dblclick 调用 toggleFullscreen（含 iOS 系统原生全屏），两个平台行为一致。
Artplayer.MOBILE_DBCLICK_PLAY = false
Artplayer.DBCLICK_FULLSCREEN = false

const artContainerRef = ref<HTMLDivElement | null>(null)
// 更多面板的 Teleport 目标：ArtPlayer 的 .art-video-player 节点。
// 原生全屏后只有这个节点及其子树可见，面板必须挂到它内部才不会消失。
const playerHost = ref<HTMLDivElement | null>(null)
let art: Artplayer | null = null
let hlsInstance: Hls | null = null
let resizeObserver: ResizeObserver | null = null

// 视频真实宽高比（宽 / 高），未加载完成时为 null
const videoRatio = ref<number | null>(null)
// 精确像素尺寸，保证容器与视频比例完全一致，彻底消除黑边
const boxWidth = ref<number | null>(null)
const boxHeight = ref<number | null>(null)

const titleHidden = ref(false)
// 控制层是否可见：由 ArtPlayer 的 control 事件驱动。
// 顶部关闭/更多按钮、底部选集/全屏按钮统一跟随它显隐——一起出现、一起隐藏，
// 彻底避免「上面按钮显示、下面控制栏隐藏」这种不同步状态。
const controlsVisible = ref(true)
// m3u8 转码下载：弹窗可见性 + 后台任务状态。
// 弹窗「关闭」只隐藏 downloadConverting，轮询/下载在后台继续（taskId 仍在）。
// 「取消」才真正中止任务。原生全屏时遮罩随兄弟节点被浏览器隐藏、退出后恢复。
const downloadConverting = ref(false)
const downloadPercent = ref(0)
// pending/running/done/failed/cancelled —— 用于文案与是否继续轮询
const downloadPhase = ref<'pending' | 'running' | 'done' | 'failed' | 'cancelled'>('pending')
let downloadTaskId = ''
let downloadPollTimer: number | null = null
const downloadStatusText = computed(() => {
  switch (downloadPhase.value) {
    case 'done':
      return '转换完成，正在保存…'
    case 'failed':
      return '转换失败'
    case 'cancelled':
      return '已取消下载'
    default:
      return downloadPercent.value > 0 ? '正在转换并下载视频…' : '正在准备转换…'
  }
})

/** 停止轮询（不中止任务；关闭弹窗时用）。 */
function stopDownloadPolling() {
  if (downloadPollTimer !== null) {
    window.clearInterval(downloadPollTimer)
    downloadPollTimer = null
  }
}

/** 彻底清理一次下载会话状态（切集/组件销毁/任务结束时用）。 */
function resetDownloadSession() {
  stopDownloadPolling()
  downloadTaskId = ''
  downloadPercent.value = 0
  downloadPhase.value = 'pending'
}

/**
 * 是否存在当前视频「后台进行中」的下载任务（点了「继续下载」关闭弹窗后的状态）。
 * 条件：有 taskId 且轮询仍在运行，且阶段为 pending/running（未终结）。
 * done 会在 saveConvertedVideo 里 stop 轮询并 reset；failed/cancelled 也会 stop 轮询，
 * 因此这些终结态不会被误判为后台活跃，再次点击下载会正常开启新任务。
 */
function hasActiveBackgroundTask(): boolean {
  return isBackgroundTaskActive(
    downloadTaskId,
    downloadPollTimer !== null,
    downloadPhase.value,
  )
}

// 更多面板 / 选集面板与播放选项（两者互斥，同时最多显示一个）
const morePanelVisible = ref(false)
const catalogPanelVisible = ref(false)
const autoPlayToggle = ref(true) // 是否按目录连续播放（播完自动下一集）
const currentRate = ref(1)
const currentFit = ref<'contain' | 'cover' | 'fill'>('contain')
const loopToggle = ref(false)
const flipToggle = ref(false)
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2]
const FIT_OPTIONS: { value: 'contain' | 'cover' | 'fill'; label: string }[] = [
  { value: 'contain', label: '适应' },
  { value: 'cover', label: '铺满' },
  { value: 'fill', label: '拉伸' },
]

const wrapperStyle = computed(() => {
  if (boxWidth.value && boxHeight.value) {
    return {
      width: `${boxWidth.value}px`,
      height: `${boxHeight.value}px`,
    }
  }
  // 视频元数据加载前，先给一个中性占位，避免闪烁与黑边
  return {
    width: '100%',
    height: '56vh',
  }
})

// 窄播放器（典型：竖屏短剧在 PC 上容器宽度被压到很窄）。
// 此时 ArtPlayer 底部控制栏的左侧「播放+时间+音量」+右侧「选集+全屏」会超出容器宽度，
// 导致右侧按钮溢出被裁。手机上 ArtPlayer 自带 .art-mobile 会压缩控件所以正常，
// PC 上没有该类，需要我们主动加 .rv-narrow 压缩控制栏尺寸，保证右侧按钮完整可见。
const isNarrowPlayer = computed(() => {
  // 阈值 460px：低于此宽度时控制栏控件会明显拥挤
  return !!boxWidth.value && boxWidth.value < 460
})

function destroyHls() {
  if (hlsInstance) {
    try {
      hlsInstance.destroy()
    } catch {}
    hlsInstance = null
  }
}

/**
 * 依据视频真实分辨率与可用视口，计算与视频比例完全一致的精确像素尺寸。
 * 容器比例 === 视频比例，因此不会出现任何左右 / 上下黑边。
 */
function fitToVideo() {
  if (!art || !art.video) return
  const vw = art.video.videoWidth || 0
  const vh = art.video.videoHeight || 0
  if (!vw || !vh) return

  const ratio = vw / vh
  videoRatio.value = ratio

  const holder = artContainerRef.value?.parentElement?.parentElement
  const availW = holder && holder.clientWidth > 0 ? holder.clientWidth : window.innerWidth
  const isMobile = window.innerWidth <= 768
  const availH = window.innerHeight * (isMobile ? 0.62 : 0.74)

  let w = availW
  let h = w / ratio
  if (h > availH) {
    h = availH
    w = h * ratio
  }

  boxWidth.value = Math.max(1, Math.floor(w))
  boxHeight.value = Math.max(1, Math.floor(h))
}

function onWindowResize() {
  fitToVideo()
}

async function downloadCurrentVideo() {
  if (!props.url) return
  const isM3u8 = /\.m3u8(?:\?|$)/i.test(props.url)
  // 文件名：书名 + 章节标题（章节常是「1」这种序号，单用它会得到 1.mp4）。
  // 扩展名：m3u8 统一转 mp4；直链沿用 URL 后缀。
  const ext = isM3u8 ? 'mp4' : (props.url.match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i)?.[1] || 'mp4').toLowerCase()
  const fileName = buildVideoFileName(props.bookTitle || '', props.title || '', ext)
  // 传给后端的 filename 不含扩展名（后端统一补 .mp4）
  const fileNameBase = fileName.replace(/\.[^.]+$/, '')

  closeAllPanels()

  // m3u8 无法直接下载成可播放文件：交给后端用 ffmpeg 合并转成 mp4。
  // 采用任务制：启动后轮询真实进度，转完自动下载；转码期间不暂停播放。
  if (isM3u8) {
    // 若当前视频已有后台进行中的任务（此前点了「继续下载」关闭弹窗），
    // 再次点击下载只重新弹出原进度弹窗，不新建任务，避免重复转码/任务并存。
    if (hasActiveBackgroundTask()) {
      downloadConverting.value = true
      // 立即同步一次进度，弹窗弹出即显示真实进度（轮询本身也在继续）
      void pollDownloadProgress()
      return
    }
    await startM3u8Download(fileNameBase, fileName)
    return
  }

  // 普通直链：保持原有 <a download> 行为
  const a = document.createElement('a')
  a.href = props.url
  a.download = fileName
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  if (art) art.notice.show = '已开始下载本集视频'
}

/** 拼装当前用户的认证头（与书源代理一致）。 */
function authHeaders(json = false): Record<string, string> {
  const { accessToken, secureKey } = buildAuthHeaderValues(localStorage)
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (accessToken) headers.Authorization = accessToken
  if (secureKey) headers['X-Secure-Key'] = secureKey
  return headers
}

/** 启动 m3u8 后台转换任务，随后轮询进度。 */
async function startM3u8Download(fileNameBase: string, fileName: string) {
  // 若上一个任务还在跑，先停掉旧轮询（不重复启动 ffmpeg 由后端并发闸门兜底）
  stopDownloadPolling()
  downloadPercent.value = 0
  downloadPhase.value = 'pending'
  downloadConverting.value = true

  try {
    const response = await fetch('/reader3/convertVideoToMp4', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ url: props.url, filename: fileNameBase }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.isSuccess) {
      const msg = data?.errorMsg || `HTTP ${response.status}`
      throw new Error(msg)
    }
    const taskId = data?.data?.task_id
    if (!taskId) throw new Error('未获取到有效的下载任务')
    downloadTaskId = taskId
    downloadPhase.value = 'running'
    // 保存最终文件名供下载结果使用
    pendingDownloadFileName = fileName
    // 立即拉取一次，随后定时轮询
    await pollDownloadProgress()
    downloadPollTimer = window.setInterval(pollDownloadProgress, 1000)
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    downloadPhase.value = 'failed'
    if (art) art.notice.show = msg.startsWith('转换失败') ? msg : `转换失败：${msg}`
    // 失败弹窗短暂展示后自动隐藏
    window.setTimeout(() => {
      if (downloadPhase.value === 'failed') downloadConverting.value = false
    }, 2500)
  }
}

/** 结果文件的最终名（含扩展名），启动任务时保存。 */
let pendingDownloadFileName = 'video.mp4'

/** 轮询一次任务进度；done 时下载结果，failed/cancelled 时提示并停止。 */
async function pollDownloadProgress() {
  const taskId = downloadTaskId
  if (!taskId) return
  try {
    const response = await fetch(
      `/reader3/convertVideoProgress?task_id=${encodeURIComponent(taskId)}`,
      { headers: authHeaders() },
    )
    const wrapper = await response.json().catch(() => null)
    if (!response.ok || !wrapper?.isSuccess) {
      // 任务过期/丢失：停止，避免无限轮询
      throw new Error(wrapper?.errorMsg || `HTTP ${response.status}`)
    }
    const p = wrapper.data || {}
    const status = (p.status || 'pending') as 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
    if (typeof p.percent === 'number') {
      downloadPercent.value = Math.max(0, Math.min(100, p.percent))
    }
    downloadPhase.value = status

    if (status === 'done') {
      stopDownloadPolling()
      await saveConvertedVideo(taskId)
      return
    }
    if (status === 'failed') {
      stopDownloadPolling()
      const err = typeof p.error === 'string' && p.error ? p.error : '转换失败'
      if (art) art.notice.show = err.startsWith('转换失败') ? err : `转换失败：${err}`
      window.setTimeout(() => {
        if (downloadPhase.value === 'failed') downloadConverting.value = false
      }, 2500)
      return
    }
    if (status === 'cancelled') {
      stopDownloadPolling()
      downloadConverting.value = false
      return
    }
  } catch {
    // 单次轮询失败不打断，网络抖动可自恢复；连续失败由整体超时兜底
  }
}

/** 从后端拉取转好的 mp4 并触发浏览器下载。 */
async function saveConvertedVideo(taskId: string) {
  try {
    const response = await fetch(
      `/reader3/convertVideoResult?task_id=${encodeURIComponent(taskId)}`,
      { headers: authHeaders() },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = pendingDownloadFileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
    if (art) art.notice.show = '已开始下载视频'
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    if (art) art.notice.show = `保存失败：${msg}`
  } finally {
    downloadConverting.value = false
    resetDownloadSession()
  }
}

/** 「关闭」：隐藏弹窗，后台转换与轮询继续，转完自动下载；可继续播放视频。 */
function closeDownloadPopup() {
  downloadConverting.value = false
}

/** 「取消」：真正中止后端任务、停止轮询、隐藏弹窗。 */
async function cancelDownload() {
  const taskId = downloadTaskId
  stopDownloadPolling()
  if (taskId) {
    try {
      await fetch('/reader3/convertVideoCancel', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ task_id: taskId }),
      })
    } catch {
      // 取消请求失败也隐藏弹窗；后端有 TTL 兜底清理
    }
  }
  downloadPhase.value = 'cancelled'
  downloadConverting.value = false
  resetDownloadSession()
  if (art) art.notice.show = '已取消视频下载'
}

/**
 * 全屏切换：
 * - iOS：改用系统原生视频全屏（video.webkitEnterFullscreen）。这样状态栏会自动隐藏，
 *   且视频会按自身方向自动横竖屏，彻底解决"状态栏还在 / 不支持自旋"的问题。
 *   代价是全屏期间由系统接管画面，Artplayer 自定义控制栏不可用，退出后自动恢复。
 * - 其他平台：沿用 Artplayer 内置全屏（PC 浏览器 / 安卓 Chrome 全屏本就能隐藏状态栏）。
 */
function toggleFullscreen() {
  if (!art) return
  const video = art.video as (HTMLVideoElement & {
    webkitEnterFullscreen?: () => void
    webkitExitFullscreen?: () => void
    webkitDisplayingFullscreen?: boolean
  }) | null
  if (isIOS && video && typeof video.webkitEnterFullscreen === 'function') {
    try {
      if (video.webkitDisplayingFullscreen) {
        video.webkitExitFullscreen?.()
      } else {
        video.webkitEnterFullscreen()
      }
    } catch {
      // 某些 iOS WebView 不支持，退回 Artplayer 全屏
      art.fullscreen = !art.fullscreen
    }
  } else {
    art.fullscreen = !art.fullscreen
  }
}

// ── 面板开关（更多 / 选集互斥）──
function closeMorePanel() {
  morePanelVisible.value = false
}
function closeCatalogPanel() {
  catalogPanelVisible.value = false
}
function closeAllPanels() {
  morePanelVisible.value = false
  catalogPanelVisible.value = false
}

/**
 * 点击视频以外的页面区域时，强制收起所有屏幕控制元素：
 * 面板、标题、关闭/更多按钮，以及 ArtPlayer 底部控制栏与进度条。
 * 做法：给 .art-video-player 加一个自定义 class，用更高特异性 CSS 覆盖控制栏显示
 * （不碰 ArtPlayer 内部的 art-control-show 状态，避免与之失步）。
 */
function forceHideControls() {
  closeAllPanels()
  controlsVisible.value = false
  titleHidden.value = true
  if (playerHost.value) playerHost.value.classList.add('rv-force-hide')
}

/** 点回播放器内部：移除强制隐藏，让顶部按钮与控制栏一起恢复显示。 */
function clearForcedHide() {
  if (playerHost.value) playerHost.value.classList.remove('rv-force-hide')
  // 与 control 事件保持同一套状态：移除强制隐藏的同时恢复控制层显隐，
  // 确保顶部按钮和底部控制栏同步出现，不出现「上显示、下隐藏」。
  controlsVisible.value = true
  titleHidden.value = false
}

/** document 级手势：点在播放器（含 Teleport 面板）之外则强制隐藏控制层。 */
function onDocumentPointerDown(event: PointerEvent) {
  const container = artContainerRef.value
  const target = event.target as Node | null
  if (!container || !target) return
  if (container.contains(target)) {
    clearForcedHide()
  } else {
    forceHideControls()
  }
}

function toggleMorePanel() {
  const show = !morePanelVisible.value
  morePanelVisible.value = show
  if (show) catalogPanelVisible.value = false // 互斥
}
function toggleCatalogPanel() {
  const show = !catalogPanelVisible.value
  catalogPanelVisible.value = show
  if (show) morePanelVisible.value = false // 互斥
}
function onMorePrev() {
  closeCatalogPanel()
  if (props.hasPrev) emit('prev')
}
function onMoreNext() {
  closeCatalogPanel()
  if (props.hasNext) emit('next')
}
function onMoreCatalog() {
  closeCatalogPanel()
  emit('catalog')
}
function setRate(rate: number) {
  currentRate.value = rate
  if (art) art.playbackRate = rate as Artplayer['playbackRate']
}
function setFit(mode: 'contain' | 'cover' | 'fill') {
  currentFit.value = mode
  // Artplayer 无 object-fit 选项，直接作用于 video 元素
  if (art?.video) art.video.style.objectFit = mode
  fitToVideo()
}
function toggleAutoPlay() {
  autoPlayToggle.value = !autoPlayToggle.value
}
function toggleLoop() {
  loopToggle.value = !loopToggle.value
  if (art?.video) art.video.loop = loopToggle.value
}
function toggleFlip() {
  flipToggle.value = !flipToggle.value
  if (art) art.flip = flipToggle.value ? 'rotateY' : 'normal'
}
function togglePip() {
  if (art) art.pip = !art.pip
  closeMorePanel()
}

function initPlayer() {
  if (!artContainerRef.value || !props.url) return

  if (art) {
    art.destroy(false)
    art = null
  }
  destroyHls()
  // 切集/重建播放器：停止旧轮询并重置弹窗状态；不取消后端任务（后台继续下载）
  resetDownloadSession()
  downloadConverting.value = false
  videoRatio.value = null
  boxWidth.value = null
  boxHeight.value = null
  morePanelVisible.value = false
  catalogPanelVisible.value = false
  controlsVisible.value = true
  titleHidden.value = false
  playerHost.value = null

  const isM3u8 = /\.m3u8(?:\?|$)/i.test(props.url)

  art = new Artplayer({
    container: artContainerRef.value,
    url: props.url,
    volume: 0.8,
    isLive: false,
    muted: false,
    autoplay: true,
    pip: false,
    autoSize: false,
    autoMini: false,
    screenshot: false,
    // 右侧功能全部收进「更多」面板，仅保留自定义全屏按钮
    setting: false,
    loop: false,
    flip: false,
    playbackRate: false,
    aspectRatio: false,
    fullscreen: false,
    fullscreenWeb: false,
    miniProgressBar: true,
    mutex: true,
    backdrop: true,
    playsInline: true,
    gesture: true,
    // 保留长按快进/快退手势（纯手势、不占控制栏按钮、不影响界面）；
    // 自动连播内置按钮关闭，连播由我们按目录控制
    fastForward: true,
    autoPlayback: false,
    autoOrientation: false,
    theme: '#3b82f6',
    lang: 'zh-cn',
    // 左侧自定义键全部去掉；更多按钮已移到右上角独立按钮。
    // 底部控制栏右侧仅保留：全屏 + 选集（目录图标）。
    controls: [
      {
        name: 'native-fullscreen',
        index: 71,
        position: 'right',
        html: `<button class="art-custom-btn rv-glass-btn" title="全屏">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
          </svg>
        </button>`,
        click: () => toggleFullscreen(),
      },
      {
        name: 'catalog',
        index: 70,
        position: 'right',
        html: `<button class="art-custom-btn rv-glass-btn" title="选集">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3 6h.01M3 12h.01M3 18h.01" stroke-width="3" />
          </svg>
        </button>`,
        click: () => toggleCatalogPanel(),
      },
    ],
    customType: {
      m3u8: function (video: HTMLVideoElement, url: string, artInstance: Artplayer) {
        if (Hls.isSupported()) {
          destroyHls()
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
          })
          hlsInstance = hls
          hls.loadSource(url)
          hls.attachMedia(video)
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  hls.startLoad()
                  break
                case Hls.ErrorTypes.MEDIA_ERROR:
                  hls.recoverMediaError()
                  break
                default:
                  artInstance.notice.show = '播放器流媒体加载失败'
                  break
              }
            }
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url
        } else {
          artInstance.notice.show = '当前浏览器不支持播放该 m3u8 视频'
        }
      },
    },
  })

  if (isM3u8) {
    art.type = 'm3u8'
  }

  // 把播放器节点设为更多面板的挂载目标，使面板在全屏时也可见
  playerHost.value = art.template.$player

  // 双击画面切换全屏（含 iOS 原生全屏），两个平台行为一致
  art.on('dblclick', () => {
    toggleFullscreen()
  })

  // 全屏状态变化时收起所有面板，避免面板遮挡全屏画面
  art.on('fullscreen', (state: boolean) => {
    if (state) closeAllPanels()
  })

  // 元数据就绪后按真实分辨率自适应，消除黑边
  art.on('video:loadedmetadata', () => {
    fitToVideo()
  })
  // 首帧可播放：按真实分辨率自适应，消除黑边
  art.on('video:canplay', () => {
    fitToVideo()
  })

  // 控制层显隐：顶部关闭/更多按钮、底部选集/全屏按钮、章节标题、更多/选集面板
  // 全部由同一个 control 事件统一驱动——一起出现、一起隐藏，不再各用一套状态，
  // 彻底避免「上面按钮显示、下面控制栏隐藏」这种不同步。
  art.on('control', (state: boolean) => {
    if (state) {
      // 控制层被唤出（hover / 点击 / 暂停）：同步清除强制隐藏 class，
      // 让底部控制栏与顶部按钮一起恢复，避免顶部已显示、底部仍被 CSS 压住。
      if (playerHost.value) playerHost.value.classList.remove('rv-force-hide')
    }
    controlsVisible.value = state
    titleHidden.value = !state
    if (!state) closeAllPanels()
  })

  // ArtPlayer 在 play()/pause() 内部先写 notice（"播放"/"暂停"）再 emit 对应事件，
  // 这两条提示会与左上角章节标题重叠。事件回调里立即清空 notice 即可去掉文字，
  // 且不影响下载成功、流加载失败等其它提示（它们不走 play/pause）。
  // 注意：这里不再单独控制任何按钮/标题的显隐，一律交给上面的 control 事件，保证同步。
  art.on('play', () => {
    if (art) art.notice.show = ''
  })
  art.on('pause', () => {
    if (art) art.notice.show = ''
  })

  art.on('video:timeupdate', () => {
    if (art && art.video) {
      emit('timeupdate', art.video.currentTime || 0, art.video.duration || 0)
    }
  })

  // 播完按目录自动进入下一集（受「自动连播」开关控制）
  art.on('video:ended', () => {
    if (autoPlayToggle.value) emit('ended')
  })

  nextTick(() => {
    fitToVideo()
  })
}

watch(
  () => props.url,
  (newUrl) => {
    if (!newUrl) return
    nextTick(() => {
      titleHidden.value = false
      initPlayer()
    })
  },
)

onMounted(() => {
  initPlayer()
  window.addEventListener('resize', onWindowResize)
  // 点击视频外页面区域时收起所有屏幕控制元素
  document.addEventListener('pointerdown', onDocumentPointerDown)
  const holder = artContainerRef.value?.parentElement?.parentElement
  if (holder && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      fitToVideo()
    })
    resizeObserver.observe(holder)
  }
})

onBeforeUnmount(() => {
  destroyHls()
  // 组件销毁：停止轮询；后端任务按 TTL 自行完成/清理
  stopDownloadPolling()
  window.removeEventListener('resize', onWindowResize)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (art) {
    art.destroy(false)
    art = null
  }
  playerHost.value = null
})
</script>

<style scoped>
/* 视频沉浸舞台：整块纯黑背景，杜绝视频比例不符时露出页面米色底（图1/图2的浅色边） */
.reader-artplayer-stage {
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: #000;
}

/* 顶部视频标题：仅悬浮在视频播放器画面内部正上方，绝不外溢撑满全屏 */
.reader-video-title {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  padding: 10px 48px 20px;
  display: flex;
  align-items: center;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.45) 0%, rgba(0, 0, 0, 0) 100%);
  transition: opacity 0.35s ease;
}

.reader-video-title.is-hidden {
  opacity: 0;
}

.reader-video-title-text {
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: 0.2px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 左上角关闭 / 右上角更多：无底色透明按钮，与播放画面融为一体；
   左右各内缩，与底部控制栏的播放/全屏按钮对齐，不过于贴边；跟随控制层淡出 */
.rv-close-btn,
.rv-more-top-btn {
  position: absolute;
  top: 6px;
  z-index: 95;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  cursor: pointer;
  background: transparent;
  border: none;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.9));
  -webkit-tap-highlight-color: transparent;
  transition: opacity 0.3s ease;
}
.rv-close-btn { left: 12px; }
.rv-more-top-btn { right: 12px; }
.rv-close-btn.is-hidden,
.rv-more-top-btn.is-hidden { opacity: 0; pointer-events: none; }
.rv-close-btn:active,
.rv-more-top-btn:active { opacity: 0.7; }

/* 转换下载进度遮罩：盖在播放器之上、面板之下。
   作为 .art-video-player 的兄弟节点，原生全屏时被浏览器自动隐藏，退出后恢复。 */
.rv-download-progress {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.34);
  pointer-events: none; /* 不拦截手势，转码中仍可点画面唤出控制层 */
}
.rv-download-progress-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 26px;
  border-radius: 16px;
  min-width: 220px;
}
.rv-download-spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.18);
  border-top-color: var(--color-primary, #f43f5e);
  animation: rv-spin 0.8s linear infinite;
}
.rv-download-text {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.92);
  letter-spacing: 0.5px;
}
/* 不确定进度条：左右往复动效，表达"进行中"而非虚假百分比 */
.rv-download-bar {
  width: 180px;
  height: 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.16);
  overflow: hidden;
}
.rv-download-bar-inner {
  display: block;
  width: 40%;
  height: 100%;
  border-radius: 4px;
  background: var(--color-primary, #f43f5e);
  animation: rv-progress-slide 1.2s ease-in-out infinite;
}
/* 有真实进度时：确定性宽度、平滑过渡（animation 由内联 style 置 none） */
.rv-download-bar-inner {
  transition: width 0.4s ease;
}
.rv-download-percent {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-primary-light, var(--color-primary, #f43f5e));
  min-height: 14px;
}
.rv-download-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}
/* 操作按钮区：遮罩整体 pointer-events:none 不拦截视频手势，唯独按钮要可点 */
.rv-download-actions {
  display: flex;
  gap: 10px;
  margin-top: 2px;
  pointer-events: auto;
}
.rv-dl-btn {
  border: 1px solid rgba(255, 255, 255, 0.28);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.rv-dl-btn:active { opacity: 0.7; }
.rv-dl-close {
  background: var(--color-primary, #f43f5e);
  border-color: transparent;
}
@keyframes rv-spin {
  to { transform: rotate(360deg); }
}
@keyframes rv-progress-slide {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}

/* ===== 窄播放器（竖屏短剧在 PC 上）控制栏压缩 =====
   fitToVideo 会把容器宽度设成视频真实宽度，竖屏短剧可窄到 ~300px。
   ArtPlayer 默认左侧「播放+时间(D/MM:SS)+音量」+ 右侧「选集+全屏」在窄容器里会溢出，
   右侧按钮被 .reader-artplayer-wrapper 的 overflow:hidden 裁掉（手机有 .art-mobile
   自动压缩控件所以正常，PC 无此类）。这里在窄容器下压缩各控件尺寸与时间字体，
   并把时间收紧为当前时间，确保右侧选集/全屏按钮完整可见。 */
.reader-artplayer-container.rv-narrow :deep(.art-video-player .art-controls .art-control) {
  min-width: 28px;
  padding: 0 2px;
}
.reader-artplayer-container.rv-narrow :deep(.art-video-player .art-controls .art-time) {
  font-size: 11px;
  transform: scale(0.9);
  transform-origin: left center;
}
.reader-artplayer-container.rv-narrow :deep(.art-video-player .art-controls .art-custom-btn.rv-glass-btn) {
  width: 28px;
  margin: 0 1px;
}
/* 极窄时隐藏音量控件，把空间让给右侧选集/全屏按钮 */
.reader-artplayer-container.rv-narrow :deep(.art-video-player .art-controls .art-control-volume) {
  display: none;
}
/* 右侧按钮组贴住内缘，负 margin 归零，避免溢出裁切 */
.reader-artplayer-container.rv-narrow :deep(.art-video-player .art-controls .art-controls-right) {
  margin-right: 4px !important;
}

/* ===== 错误/提示文字：限制宽度并允许换行，避免长文案右端顶到右上角按钮 =====
   .art-notice 默认 inset:0、width:100%、flex 单行撑开，错误文案较长时会横向延伸到
   右上角「更多」按钮（z-index 95 > notice 80）下方被遮挡。这里让提示块居中、限制
   最大宽度、允许换行抬高行距，长文案改为多行显示，避开右上角按钮区域。 */
.reader-artplayer-container :deep(.art-video-player .art-notice) {
  justify-content: center;
  align-items: flex-start;
  padding-top: 16%;
}
.reader-artplayer-container :deep(.art-video-player .art-notice .art-notice-inner) {
  max-width: min(78%, 520px);
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: break-word;
  word-break: break-word;
  text-align: center;
  padding: 8px 12px;
}

/* ===== 玻璃拟态公共样式：视频面板与按钮统一增强玻璃感（深色玻璃，适配黑色播放底） ===== */
.rv-glass {
  background: rgba(30, 30, 34, 0.52);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.42), inset 0 1px 1px rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

/* 面板 Teleport 进 .art-video-player 内部，层级需高于播放器控制层 */
.rv-more-backdrop,
.rv-catalog-backdrop {
  position: absolute;
  inset: 0;
  z-index: 90;
  background: transparent;
}
.rv-more-panel,
.rv-catalog-panel {
  position: absolute;
  right: 12px;
  z-index: 100;
  width: 232px;
  max-width: calc(100% - 24px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 12px;
  border-radius: 14px;
  color: #fff;
  transition: opacity 0.3s ease;
}
/* 更多面板跟随右上角更多按钮，在其正下方展开 */
.rv-more-panel {
  top: 50px;
  max-height: calc(100% - 64px);
}
/* 选集面板跟随底部控制栏的选集按钮，在其上方展开。
   窄列布局：只放一列按钮，宽度刚好容纳文字，不再横向铺开。 */
.rv-catalog-panel {
  bottom: 52px;
  max-height: calc(100% - 64px);
  width: 128px;
}
/* 选集按钮按「上一集→目录→下一集→下载」纵向排列，每个占满整行 */
.rv-catalog-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rv-catalog-list button {
  width: 100%;
  padding: 8px 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.rv-catalog-list button:disabled { opacity: 0.35; cursor: default; }
.rv-catalog-list button:active { opacity: 0.75; }
.rv-more-panel.is-hidden,
.rv-catalog-panel.is-hidden { opacity: 0; pointer-events: none; }
.rv-more-group { margin-bottom: 12px; }
.rv-more-group:last-child { margin-bottom: 0; }
.rv-more-title {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
  margin: 0 2px 6px;
}
.rv-more-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rv-more-row button,
.rv-more-toggles button {
  flex: 1 1 auto;
  min-width: 44px;
  padding: 7px 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.rv-more-toggles { display: flex; flex-wrap: wrap; gap: 6px; }
.rv-more-row button.active,
.rv-more-toggles button.active {
  background: var(--color-primary, #f43f5e);
  border-color: transparent;
  font-weight: 600;
}
.rv-more-row button:disabled { opacity: 0.35; cursor: default; }
.rv-more-row button:active,
.rv-more-toggles button:active { opacity: 0.75; }
.rv-more-download { margin-top: 2px; }

.reader-artplayer-wrapper {
  position: relative;
  margin: 0 auto;
  max-width: 100%;
  background: transparent;
  overflow: hidden;
  transition: width 0.2s ease, height 0.2s ease;
}

.reader-artplayer-container {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
}

.reader-artplayer-container :deep(.art-video-player) {
  border-radius: 0;
  background: #000;
}

.reader-artplayer-container :deep(video) {
  object-fit: contain;
  background: transparent;
}

/* 玻璃感控制栏：底部控制层改为深色半透明 + 背景模糊；
   保留足够不透明度确保白色进度/时间在亮色画面下依然清晰。 */
.reader-artplayer-container :deep(.art-video-player .art-bottom) {
  background: linear-gradient(180deg, rgba(10, 10, 12, 0.32) 0%, rgba(10, 10, 12, 0.62) 100%) !important;
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
}

/* 控制栏自定义按钮（全屏/选集，JS 注入的 .rv-glass-btn）：无底色，与播放画面融为一体 */
.reader-artplayer-container :deep(.art-video-player .art-controls .art-custom-btn.rv-glass-btn) {
  width: 34px;
  height: 34px;
  margin: 0 2px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: transparent;
  border: none;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.9));
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: opacity 0.15s ease;
}
.reader-artplayer-container :deep(.art-video-player .art-controls .art-custom-btn.rv-glass-btn:active) {
  opacity: 0.7;
}

/* 修复控制栏最右侧全屏按钮被屏幕边缘裁切：
   Artplayer 在移动端会【运行时动态注入】以下样式到 <head>（晚于本打包样式）：
     .art-video-player.art-mobile .art-controls-right { margin-right: calc(var(--art-padding) / -1) }  // -10px
   它把右侧按钮组右移 10px，抵消了 .art-bottom 的 10px 内边距，使全屏按钮贴到
   播放器容器最右缘；而 .art-bottom 为 overflow:hidden，播放器宽度又贴合视频宽度
   （竖屏下几乎满屏），于是全屏按钮被屏幕边缘裁掉。
   因此这里必须用【更高特异性 + !important】覆盖运行时样式，恢复安全内边距。 */
.reader-artplayer-container :deep(.art-video-player .art-controls .art-controls-right) {
  margin-right: max(2px, env(safe-area-inset-right, 2px)) !important;
}

.reader-artplayer-container :deep(.art-video-player .art-controls .art-controls-left) {
  margin-left: max(2px, env(safe-area-inset-left, 2px)) !important;
}

/* 控制层隐藏时，连 ArtPlayer 的迷你进度条（底部那条细线）一并隐藏；
   不限定全屏——内嵌播放同样适用。点击画面唤出控制层后细线随之恢复，不影响拖动进度。
   ArtPlayer 自身规则是 .art-mini-progress-bar .art-bottom{opacity:1}，这里用更高特异性覆盖。 */
.reader-artplayer-container :deep(.art-video-player.art-mini-progress-bar .art-bottom) {
  opacity: 0 !important;
  pointer-events: none;
}

/* 点击视频外页面区域后强制隐藏：底部控制栏（含进度条/时间/按钮）、迷你进度条、遮罩。
   用自定义 class + 更高特异性覆盖，不动 ArtPlayer 内部 art-control-show 状态，
   点回播放器内移除本 class 即可让 ArtPlayer 自行恢复，避免显隐失步。 */
.reader-artplayer-container :deep(.art-video-player.rv-force-hide .art-bottom),
.reader-artplayer-container :deep(.art-video-player.rv-force-hide .art-progress) {
  opacity: 0 !important;
  pointer-events: none !important;
}
.reader-artplayer-container :deep(.art-video-player.rv-force-hide .art-mask),
.reader-artplayer-container :deep(.art-video-player.rv-force-hide .art-state) {
  opacity: 0 !important;
  pointer-events: none !important;
}

@media (max-width: 768px) {
  .reader-video-title {
    padding: 10px 44px 22px 48px;
  }
  .reader-video-title-text {
    font-size: 14px;
  }
  /* 小屏手机：更多面板更紧凑，保证在视频区内完整显示 */
  .rv-more-panel {
    width: 208px;
    padding: 10px;
  }
  /* 选集面板保持窄列，小屏下也只比桌面略宽一点 */
  .rv-catalog-panel {
    width: 120px;
    padding: 10px;
    bottom: 48px;
  }
  .rv-more-group { margin-bottom: 9px; }
  .rv-more-row button,
  .rv-more-toggles button {
    padding: 6px 4px;
    font-size: 11px;
  }
}
</style>
