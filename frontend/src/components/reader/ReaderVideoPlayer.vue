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

      <div class="reader-artplayer-container" ref="artContainerRef"></div>

      <!-- 视频加载动画：首帧就绪前盖住黑屏居中显示，画面出现后立即隐藏 -->
      <div v-if="videoLoading" class="rv-loading-mask" aria-label="视频加载中">
        <div class="rv-loading-spinner"></div>
        <div class="rv-loading-text">加载中…</div>
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

const props = withDefaults(
  defineProps<{
    url: string
    title?: string
    isNight?: boolean
    hasPrev?: boolean
    hasNext?: boolean
  }>(),
  {
    title: '',
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
// 视频首帧是否就绪：就绪前显示居中加载动画，就绪后隐藏
const videoLoading = ref(true)
let loadingFallbackTimer: number | null = null

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
  const title = (props.title || 'video').trim()
  const safeTitle = title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
  const isM3u8 = /\.m3u8(?:\?|$)/i.test(props.url)

  closeAllPanels()

  // m3u8 无法直接下载成可播放文件：交给后端用 ffmpeg 合并转成 mp4 再下载。
  if (isM3u8) {
    // 转码期间暂停播放，避免边转边下占用带宽影响成功率和流畅度
    const wasPlaying = !!(art && art.video && !art.video.paused)
    if (wasPlaying) art?.pause()
    if (art) art.notice.show = '正在转换视频，请稍候…'
    try {
      const { accessToken, secureKey } = buildAuthHeaderValues(localStorage)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (accessToken) headers.Authorization = accessToken
      if (secureKey) headers['X-Secure-Key'] = secureKey

      const response = await fetch('/reader3/convertVideoToMp4', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: props.url }),
      })
      if (!response.ok) {
        let msg = `HTTP ${response.status}`
        try {
          const data = await response.json()
          if (data?.errorMsg) msg = data.errorMsg
        } catch {}
        throw new Error(msg)
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `${safeTitle}.mp4`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // 延迟释放，确保 WebView 已读完 blob
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
      if (art) art.notice.show = '已开始下载视频'
    } catch (error) {
      const msg = error instanceof Error ? error.message : '未知错误'
      if (art) art.notice.show = `转换失败：${msg}`
    } finally {
      if (wasPlaying) art?.play()
    }
    return
  }

  // 普通直链：保持原有 <a download> 行为
  const match = props.url.match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i)
  const ext = match ? match[1].toLowerCase() : 'mp4'
  const a = document.createElement('a')
  a.href = props.url
  a.download = `${safeTitle}.${ext}`
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  if (art) art.notice.show = '已开始下载本集视频'
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

/** 首帧就绪：隐藏加载动画，并清理兜底定时器（多次调用幂等）。 */
function markVideoReady() {
  if (!videoLoading.value) return
  videoLoading.value = false
  if (loadingFallbackTimer !== null) {
    window.clearTimeout(loadingFallbackTimer)
    loadingFallbackTimer = null
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
  if (loadingFallbackTimer !== null) {
    window.clearTimeout(loadingFallbackTimer)
    loadingFallbackTimer = null
  }
  videoLoading.value = true
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
  // 首帧可播放：画面即将出现，隐藏加载动画
  art.on('video:canplay', () => {
    fitToVideo()
    markVideoReady()
  })
  art.on('video:playing', () => {
    markVideoReady()
  })
  // 兜底：极端情况下 canplay/playing 均未触发（如弱网、部分 WebView），
  // 10 秒后仍隐藏遮罩，避免永久转圈挡住画面。
  loadingFallbackTimer = window.setTimeout(() => {
    loadingFallbackTimer = null
    markVideoReady()
  }, 10_000)

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
  if (loadingFallbackTimer !== null) {
    window.clearTimeout(loadingFallbackTimer)
    loadingFallbackTimer = null
  }
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

/* 加载遮罩：盖在播放器之上、面板之下，首帧就绪前居中显示旋转动画 */
.rv-loading-mask {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  pointer-events: none;
}
.rv-loading-spinner {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--color-primary, #f43f5e);
  animation: rv-spin 0.8s linear infinite;
}
.rv-loading-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 1px;
}
@keyframes rv-spin {
  to { transform: rotate(360deg); }
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
