<template>
  <div
    class="reader-view"
    :class="{
      'disable-system-callout': disableSystemCallout,
      'is-video-immersive': mediaContent && mediaContent.kind === 'video',
    }"
    :style="{
      background: effectiveBodyBg,
      color: theme.fontColor,
      fontFamily: currentFontFamily,
    }"
    @click="handleBackgroundClick"
    @contextmenu.prevent="handleContextMenu"
  >
    <!-- Left Drawer Panels -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="store.activePanel" class="reader-overlay" @click="store.closePanel()"></div>
      </Transition>
      <Transition name="slide-left">
        <div v-if="store.activePanel" class="reader-drawer" :style="{ background: chromeTheme.popup }">
          <ReaderCatalog
            v-if="store.activePanel === 'catalog' || store.activePanel === 'bookmark'"
            :initial-tab="store.activePanel === 'bookmark' ? 'bookmarks' : 'chapters'"
            @jump-chapter="jumpFromCatalog"
          />
          <ReadSettings v-else-if="store.activePanel === 'settings'" />
          <ReaderBookshelf v-else-if="store.activePanel === 'bookshelf'" @go-home="goHome" />
          <ReaderSource v-else-if="store.activePanel === 'source'" />
          <ReplaceRuleManager v-else-if="store.activePanel === 'rule'" />
          <CacheManager v-else-if="store.activePanel === 'cache'" />
        </div>
      </Transition>
    </Teleport>

    <!-- 阅读控制面板：手机与桌面统一使用居中悬浮卡片（点击屏幕中间呼出/收起） -->
    <ReaderMobileControls
      :show="readerPanelVisible"
      :is-speaking="store.isSpeaking"
      :is-paused="store.isPaused"
      @goHome="goHome"
      @scrollTop="scrollToTop"
      @scrollBottom="scrollToBottom"
      @prev="prevChapter"
      @next="nextChapter"
      @bookmark="toggleBookmark"
      @search="openSearch"
      @info="openInfo"
      @ai="openAiBook"
      @tts="handleTTS"
      @progress="openCachePanel"
      @goExplore="goExplore"
      @removeBook="handleRemoveBook"
    />

    <ReaderTtsPanel
      :show="showTTSPanel"
      :theme="chromeTheme"
      :chapter-title="store.currentChapter?.title"
      :provider="store.speechConfig.provider"
      :provider-label="store.speechProviderLabel"
      :is-speaking="store.isSpeaking"
      :is-loading="store.isSpeechLoading"
      :is-paused="store.isPaused"
      :voices="store.voiceList"
      :voice-name="store.speechConfig.voiceName"
      :rate="store.speechConfig.speechRate"
      :pitch="store.speechConfig.speechPitch"
      :supports-pitch="store.speechConfig.provider === 'system'"
      :openai-model="store.speechConfig.openaiModel"
      :openai-voice="store.speechConfig.openaiVoice"
      :openai-source="store.speechConfig.openaiSource"
      :stop-after-minutes="store.speechConfig.stopAfterMinutes"
      :timer-text="speechTimerText"
      @close="closeTTSPanel"
      @prev="speechPrev"
      @toggle-play="toggleSpeechFromPanel"
      @stop="handleStopTTS"
      @next="speechNext"
      @voice-change="changeVoice"
      @openai-voice-change="changeOpenAIVoice"
      @rate-change="adjustSpeechRate"
      @pitch-change="adjustSpeechPitch"
      @timer-change="setSpeechTimer"
    />

    <!-- Main Content Area -->
    <div
      class="reader-scroll-container"
      :class="{ 'horizontal-page-mode': isHorizontalPageMode }"
      ref="scrollContainerRef"
      @scroll="handleScroll"
      @mousedown="stopAutoScroll"
      @touchstart="handleTouchStart"
      @touchmove="handleTouchMove"
      @touchend="handleTouchEnd"
      @click="handleGlobalClick"
    >
      <div v-if="store.loading" class="content-loading">
        <div class="loading-spinner"></div>
      </div>

      <div v-else-if="offlineBannerText" class="offline-banner">
        {{ offlineBannerText }}
      </div>

      <article
        v-if="!store.loading && !isContinuousMode"
        class="chapter-content"
        :class="{
          'horizontal-page-article': isHorizontalPageMode,
          'media-video-article': mediaContent && mediaContent.kind === 'video'
        }"
        :style="{
          maxWidth: mediaContent ? 'none' : (isHorizontalPageMode ? 'none' : (config.pageWidth + 'px')),
          fontSize: config.fontSize + 'px',
          fontWeight: config.fontWeight,
          lineHeight: config.lineHeight,
          '--reader-page-width': config.pageWidth + 'px',
          '--reader-side-padding': '24px',
          '--reader-page-step': horizontalPageStepStyle,
        }"
      >
        <div v-if="isHorizontalPageMode" class="horizontal-page-layout">
          <section class="horizontal-content-page">
            <div
              ref="chapterTextRef"
              class="horizontal-pages"
              :style="{
                transform: horizontalPageTransform,
                transitionDuration: horizontalPageTransitionDuration,
              }"
            >
              <section v-for="(page, idx) in horizontalPages" :key="`h-page-${idx}`" class="horizontal-page">
                <div
                  class="chapter-text horizontal-page-content"
                  :style="{
                    '--p-spacing': config.paragraphSpacing + 'em',
                  }"
                  v-html="page"
                ></div>
              </section>
            </div>
          </section>
        </div>

        <div v-else>
          <!-- 媒体播放页：播放器停靠在底部 Dock 位置，不再占据页面上方 -->
          <template v-if="mediaContent">
            <!-- 有声书舞台区域：书籍封面、标题及实时歌词/字幕 -->
            <div v-if="mediaContent.kind === 'audio'" class="chapter-media media-audio-stage">
              <div class="audio-stage-card">
                <img
                  v-if="store.book?.customCoverUrl || store.book?.coverUrl"
                  :src="getCoverUrl(store.book?.customCoverUrl || store.book?.coverUrl)"
                  alt="cover"
                  class="audio-stage-cover"
                />
                <div v-else class="audio-stage-cover-placeholder">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                </div>
                <div class="audio-stage-info">
                  <div class="audio-stage-book-name">{{ store.book?.name || '有声书' }}</div>
                  <div class="audio-stage-author" v-if="store.book?.author">{{ store.book.author }}</div>
                  <div class="audio-stage-chapter-title">{{ store.currentChapter?.title || '' }}</div>
                </div>
              </div>

              <!-- LRC 实时字幕展示 -->
              <div v-if="audioLrcLines.length > 0" class="audio-lrc-container">
                <div
                  v-for="(line, idx) in audioLrcLines"
                  :key="idx"
                  class="audio-lrc-line"
                  :class="{ active: idx === currentLrcIndex }"
                >
                  {{ line.text }}
                </div>
              </div>
            </div>

            <div
              v-if="mediaContent.kind === 'audio'"
              class="media-dock"
              :class="{ 'media-dock-dark': store.isNight || appStore.theme === 'dark' }"
            >
              <div class="media-dock-title">{{ store.currentChapter?.title || '加载中...' }}</div>
              <div class="custom-audio-player">
                <audio
                  ref="mediaPlayerRef"
                  :src="mediaPlaybackUrl"
                  preload="metadata"
                  @loadedmetadata="onAudioMetadata"
                  @timeupdate="onAudioTick"
                  @play="audioPlaying = true"
                  @pause="audioPlaying = false; persistMediaProgress(true)"
                  @ended="handleMediaEnded"
                ></audio>

                <div class="audio-progress-row">
                  <span class="audio-time">{{ fmtTime(audioCurrent) }}</span>
                  <div class="audio-track" @mousedown="seekStart" @touchstart.prevent="seekStart">
                    <div class="audio-track-bg">
                      <div class="audio-fill" :style="{ width: audioPct + '%' }"></div>
                      <div class="audio-thumb" :style="{ left: audioPct + '%' }"></div>
                    </div>
                  </div>
                  <span class="audio-time">{{ fmtTime(audioDuration) }}</span>
                </div>

                <div class="audio-ctrl-row">
                  <button class="audio-btn" title="选集 / 目录" @click="store.togglePanel('catalog')">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
                  </button>
                  <button class="audio-btn" title="重新播放" @click="replayAudio">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  </button>
                  <button class="audio-btn" :disabled="store.currentIndex <= 0" title="上一集" @click="prevChapter">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                  </button>
                  <button class="audio-btn-play" @click="toggleAudio">
                    <svg v-if="!audioPlaying" viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                    <svg v-else viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                  </button>
                  <button class="audio-btn" :disabled="!store.hasNext" title="下一集" @click="nextChapter">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                  </button>
                  <button class="audio-btn audio-rate" @click="cycleRate">{{ audioRate }}x</button>
                  <button class="audio-btn" title="下载本集" @click="downloadMedia">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="chapter-media media-video-stage">
              <ReaderVideoPlayer
                :url="mediaPlaybackUrl"
                :title="store.currentChapter?.title || ''"
                :book-title="store.book?.name || ''"
                :is-night="store.isNight || appStore.theme === 'dark'"
                :has-prev="store.currentIndex > 0"
                :has-next="store.hasNext"
                @prev="prevChapter"
                @next="nextChapter"
                @catalog="store.togglePanel('catalog')"
                @download="downloadMedia"
                @goHome="goHome"
                @ended="handleMediaEnded"
                @timeupdate="onVideoPlayerTick"
              />
            </div>
          </template>

          <div
            v-else
            ref="chapterTextRef"
            class="chapter-text"
            :style="{
              '--p-spacing': config.paragraphSpacing + 'em',
            }"
            v-html="formattedContent"
          ></div>

          <!-- 移除单章底部的下一章按钮，直接滚动翻页加载 -->
        </div>
      </article>



      <div
        v-if="!store.loading && isContinuousMode"
        class="continuous-reading"
        :style="{
          maxWidth: config.pageWidth + 'px',
          fontSize: config.fontSize + 'px',
          fontWeight: config.fontWeight,
          lineHeight: config.lineHeight,
        }"
      >
        <div v-if="continuousLoadingPrev" class="continuous-loading-inline">正在加载上一章...</div>

        <section
          v-for="chapter in continuousChapters"
          :key="chapter.index"
          class="chapter-content continuous-chapter"
          :data-chapter-index="chapter.index"
        >
          <div class="chapter-title">{{ chapter.title }}</div>

          <div
            class="chapter-text"
            data-role="continuous"
            :data-chapter-index="chapter.index"
            :style="{
              '--p-spacing': config.paragraphSpacing + 'em',
            }"
            v-html="chapter.html"
          ></div>

<!-- 连续滚动模式：滚动到底部自动加载，隐藏手动加载按钮 -->
        </section>

        <div v-if="continuousLoadingNext" class="continuous-loading-inline">正在加载下一章...</div>
      </div>
    </div>

    <!-- 页尾：左侧章节名、右侧本章分屏页码（当前屏/本章总屏），随滚动实时更新；悬浮不占正文流，正文最后一行紧贴页尾不留白 -->
    <div
      v-if="showPageFooter"
      class="reader-page-footer"
      :style="{
        width: config.pageWidth + 'px',
        marginTop: (config.fontSize * config.lineHeight / 2) + 'px',
      }"
    >
      <span class="reader-page-footer-title">{{ pageFooter.title }}</span>
      <span class="reader-page-footer-page">{{ pageFooter.current }}/{{ pageFooter.total }}</span>
    </div>

    <ReaderSearchPanel
      :show="showSearch"
      :theme="chromeTheme"
      :query="searchQuery"
      :results="searchResults"
      :active-index="searchIndex"
      :count="searchCount"
      :status="bookSearchStatus"
      @close="closeSearch"
      @search="runSearch"
      @next="nextSearchResult"
      @prev="prevSearchResult"
      @update:query="searchQuery = $event"
      @jump="jumpToSearchResult"
    />

    <Transition name="fade">
      <div
        v-if="selectionMenu.visible"
        class="selection-menu"
        @click.stop
        :style="{
          top: selectionMenu.top + 'px',
          left: selectionMenu.left + 'px',
          background: chromeTheme.popup,
          color: chromeTheme.fontColor,
        }"
      >
        <div class="selection-menu-text">{{ selectionMenu.text }}</div>
        <div class="selection-menu-actions">
          <button @click="addSelectionBookmark">加入书签</button>
          <button @click="addSelectionReplaceRule('book')">按本书替换</button>
          <button @click="addSelectionReplaceRule('source')">按书源替换</button>
        </div>
      </div>
    </Transition>

    <BookDetailModal
      v-model="showBookInfo"
      :book="bookInfoBook"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, onBeforeUnmount, nextTick, defineAsyncComponent } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { useReaderStore, fontPresets } from '../stores/reader'
import { useAppStore } from '../stores/app'
import { useBookshelfStore } from '../stores/bookshelf'
import { getBookInfo, withAuthQuery, getCoverUrl } from '../api/bookshelf'
import { applySystemTheme } from '../utils/systemUi'
import { countBrowserBookCache } from '../utils/browserCache'
import { APP_VIEWPORT_CHANGE_EVENT, syncViewportSize } from '../utils/viewport'
import { isReaderInteractiveClickTarget } from '../utils/readerClick'
import { parseMediaContent, buildMediaProxyUrl } from '../utils/mediaContent'
import Hls from 'hls.js'
import { parseLrc, type LrcLine } from '../utils/lrcParser'
import { readMediaProgress, writeMediaProgress, createMediaProgressThrottle } from '../utils/mediaProgress'
import { createReaderProgressAutoSaveScheduler, createReaderProgressExitSaver } from '../utils/readerProgressAutoSave'
import type { Book } from '../types'

import ReaderMobileControls from '../components/reader/ReaderMobileControls.vue'
import ReaderVideoPlayer from '../components/reader/ReaderVideoPlayer.vue'
import { useReaderSearch } from '../composables/useReaderSearch'
import { useReaderSelection } from '../composables/useReaderSelection'
import { useHorizontalPaging } from '../composables/useHorizontalPaging'
import { useContinuousReading } from '../composables/useContinuousReading'
import { useReaderAutoPlayback } from '../composables/useReaderAutoPlayback'

const ReaderCatalog = defineAsyncComponent(() => import('../components/reader/ReaderCatalog.vue'))
const ReadSettings = defineAsyncComponent(() => import('../components/reader/ReadSettings.vue'))
const ReaderBookshelf = defineAsyncComponent(() => import('../components/reader/ReaderBookshelf.vue'))
const ReaderSource = defineAsyncComponent(() => import('../components/reader/ReaderSource.vue'))
const ReplaceRuleManager = defineAsyncComponent(() => import('../components/reader/ReplaceRuleManager.vue'))
const CacheManager = defineAsyncComponent(() => import('../components/reader/CacheManager.vue'))
const BookDetailModal = defineAsyncComponent(() => import('../components/BookDetailModal.vue'))
const ReaderTtsPanel = defineAsyncComponent(() => import('../components/reader/ReaderTtsPanel.vue'))
const ReaderSearchPanel = defineAsyncComponent(() => import('../components/reader/ReaderSearchPanel.vue'))

const router = useRouter()
const store = useReaderStore()
const appStore = useAppStore()
const bookshelfStore = useBookshelfStore()
const READER_POSITION_PREFIX = 'reader-position:'
const SERVER_PROGRESS_AUTOSAVE_MS = 10000

interface SavedReadingPosition {
  chapterIndex: number
  progress: number
  paragraphIndex?: number
  paragraphProgress?: number
  updatedAt: number
}

const CONTINUOUS_POSITION_ANCHOR_RATIO = 0.12

function debugPositionLog(message: string, payload?: unknown) {
  void message
  void payload
}

const config = computed(() => store.config)
const theme = computed(() => store.currentTheme)
const chromeTheme = computed(() => {
  if (store.isNight || appStore.theme === 'dark') {
    return {
      ...store.currentTheme,
      popup: 'var(--color-bg-elevated)',
      fontColor: 'var(--color-text)',
    }
  }
  return store.currentTheme
})

const scrollContainerRef = ref<HTMLElement>()
const chapterTextRef = ref<HTMLElement>()
const showControls = ref(false)
const showPcSidebars = ref(false)

/** 页尾信息：左章节名 + 右「当前屏/本章总屏」，在滚动/切章时实时更新。 */
const pageFooter = ref<{ title: string; current: number; total: number }>({ title: '', current: 1, total: 1 })
/** 仅在普通文本阅读（非媒体/非加载/有正文）时显示页尾。 */
const showPageFooter = computed(() => {
  if (!config.value.showPageFooter) return false
  if (store.loading || mediaContent.value || isHorizontalPageMode.value) return false
  if (!store.currentChapter) return false
  return !!(formattedContent.value || continuousChapters.value.length)
})

/** 阅读控制面板可见性：有声书 / 短剧视频播放界面不展示；其余情况一律默认隐藏，点击正文中间区域（或打开抽屉）才显示。 */
const readerPanelVisible = computed(() => {
  if (mediaContent.value) return false
  return (isMobile.value ? showControls.value : showPcSidebars.value) || !!store.activePanel
})
const isMobile = ref(false)
let speechTimerTicker: number | null = null
let suppressNextTapUntil = 0
let restorePositionTimer: number | null = null
let persistPositionTimer: number | null = null
const pendingRestorePosition = ref<SavedReadingPosition | null>(null)
let pendingRestoreAttempts = 0
let suppressPositionSaveUntil = 0
let suppressContinuousScrollSyncUntil = 0
let suppressContinuousAutoLoadUntil = 0
// 连续滚动停止后的末行吸附：定时器 + 抑制标志（避免吸附动作自身/程序化滚动互相触发）
let scrollSnapTimer: number | null = null
let suppressScrollSnapUntil = 0
const restoreStabilizeTimers: number[] = []
const serverProgressAutoSaveScheduler = createReaderProgressAutoSaveScheduler({
  intervalMs: SERVER_PROGRESS_AUTOSAVE_MS,
  flush: () => store.flushProgressToServer(),
})
const readerProgressExitSaver = createReaderProgressExitSaver({
  disposeAutoSave: () => serverProgressAutoSaveScheduler.dispose(),
  savePosition: () => saveReadingPosition({ force: true }),
  flushToServer: () => store.flushProgressToServer(true),
  flushToServerKeepalive: () => store.flushProgressToServerKeepalive(true),
})
const isContinuousMode = computed(() => {
  // 媒体章节（有声书 / 短剧）强制使用单章视图，不启用上下连续滚动瀑布流
  if (mediaContent.value) return false
  return config.value.readMethod === '上下滚动' || config.value.readMethod === '上下滚动2'
})
const hideReadChaptersMode = computed(() => config.value.readMethod === '上下滚动2')
const isHorizontalPageMode = computed(() => false)
const isIosWebkit = computed(() => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
})
const disableSystemCallout = computed(() => {
  return isIosWebkit.value && isMobile.value && config.value.selectAction === 'popup'
})
const touchState = ref({
  startX: 0,
  startY: 0,
  startAt: 0,
  moving: false,
  horizontalLocked: false,
})
const showBookInfo = ref(false)
const bookInfoBook = ref<Book | null>(null)
const showTTSPanel = ref(false)
const ttsPanelDismissed = ref(false)
const offlineCachedCount = ref(0)
const speechTimerNow = ref(Date.now())
const speechTimerText = computed(() => {
  if (!store.speechStopAt) return ''
  const remainMs = store.speechStopAt - speechTimerNow.value
  if (remainMs <= 0) return ''
  const totalMinutes = Math.ceil(remainMs / 60000)
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return minutes ? `${hours}小时${minutes}分钟后停止` : `${hours}小时后停止`
  }
  return `${totalMinutes}分钟后停止`
})
const {
  showSearch,
  searchQuery,
  searchResults,
  searchIndex,
  searchCount,
  bookSearchStatus,
  openSearch,
  closeSearch,
  runSearch,
  nextSearchResult,
  prevSearchResult,
  jumpToSearchResult,
  handleContentUpdated,
  handlePresentationUpdated,
} = useReaderSearch(store)
const {
  selectionMenu,
  suppressSelectionCloseUntil,
  hideSelectionMenu,
  scheduleSelectionMenuUpdate,
  handleMouseUpSelection,
  handleTouchEndSelection,
  handleSelectionChange,
  addSelectionBookmark,
  addSelectionReplaceRule,
  clearSelectionState,
  disposeSelection,
} = useReaderSelection(
  store,
  appStore,
  computed(() => ({ selectAction: config.value.selectAction })),
  scrollContainerRef,
)

const offlineBannerText = computed(() => {
  if (appStore.isOnline) return ''
  if (offlineCachedCount.value > 0) {
    return `离线模式：当前书已缓存 ${offlineCachedCount.value} 章，可继续阅读已缓存章节`
  }
  return '离线模式：当前书尚未缓存到浏览器，未缓存章节将无法打开'
})

async function refreshOfflineCacheState() {
  if (!store.book) {
    offlineCachedCount.value = 0
    return
  }
  offlineCachedCount.value = await countBrowserBookCache(store.book.bookUrl).catch(() => 0)
}

let refreshOfflineCacheStateTimer: number | null = null

function scheduleRefreshOfflineCacheState() {
  if (refreshOfflineCacheStateTimer) clearTimeout(refreshOfflineCacheStateTimer)
  refreshOfflineCacheStateTimer = window.setTimeout(() => {
    void refreshOfflineCacheState()
  }, 120)
}

function checkMedia() {
  isMobile.value = window.innerWidth <= 768
  window.setTimeout(() => {
    updateHorizontalMetrics()
    if (isHorizontalPageMode.value) {
      rebuildHorizontalPages()
    }
  }, 0)
}

function handleViewportChange() {
  syncViewportSize()
  checkMedia()
  schedulePageFooterUpdate()
  scheduleRestoreReadingPosition()
}

const currentFontFamily = computed(() => {
  const preset = fontPresets.find(p => p.value === config.value.fontFamily)
  return preset ? preset.family : ''
})

// 过滤书源正文里混入的站点分页垃圾（「本章未完，点击下一页继续阅读」「第1/2页」等），
// 这类内容会让章节标题像出现在文章中间，属于内容噪声而非真实章节
function isPaginationNoise(text: string): boolean {
  const t = (text || '').replace(/[\s\u3000\u00A0]/g, '')
  if (!t) return true
  if (/本章未完|请点击下一页|点击下一页继续|下一页继续阅读|点击查看下一页/.test(t)) return true
  // 「(第1/2页)」「第1/2页」这类页码标记（必须带“页”字，避免误伤正文分数），且整行较短
  if (t.length <= 40 && /(?:[（(]\s*)?第?\s*\d+\s*[\/／]\s*\d+\s*页/.test(t)) return true
  // 书源分页残留的假章节标题：整行是「第X章 标题」这种紧凑短标题（可能带 (第M/N页)）。
  // 真实章节标题由渲染层的 .chapter-title 统一显示，正文里的这类短标题是重复内容，
  // 会造成「双标题」「标题时粗时不粗」，必须清除。
  // 严格限制：整行不含句读标点、总长很短，避免误伤「第一章就写了三千字」这类正常正文句子。
  if (t.length <= 24 && !/[，。、；：！？,.!?;:]/.test(t)) {
    if (/^第[\d零〇一二三四五六七八九十百千万两]+[章节回部篇集][\s\u3000\u00A0]*[^，。、]/.test(t)) return true
    if (/^第[\d零〇一二三四五六七八九十百千万两]+[章节回部篇集]$/.test(t)) return true
  }
  return false
}

// 在 HTML 容器内逐文本节点清洗噪声行。书源正文常把假标题/分页提示塞在裸文本节点里
// （不在 <p> 中），旧逻辑只处理 <p>，导致这类噪声漏网；这里统一按文本行过滤。
function stripNoiseTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent && ['SCRIPT', 'STYLE'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  nodes.forEach((node) => {
    const val = node.nodeValue || ''
    if (!val) return
    if (isPaginationNoise(val)) {
      node.nodeValue = ''
      return
    }
    if (val.includes('\n')) {
      node.nodeValue = val.split('\n').filter((line) => !isPaginationNoise(line)).join('\n')
    }
  })
}

function formatChapterHtml(rawText: string) {
  if (!rawText) return ''
  const text = rawText
  const stripLeadingIndent = (line: string) => line.replace(/^[\u3000\u00A0 \t]+/, '')
  const wrapper = document.createElement('div')

  if (/<[a-z][\s\S]*>/i.test(text)) {
    wrapper.innerHTML = text

    // 先逐文本节点清洗假标题/分页提示（这些常散落在 <p> 之外的裸文本节点里）
    stripNoiseTextNodes(wrapper)

    // 去掉 <p> 之外散落的裸 <br>，避免段落间出现整行空白（无双小说等站点常见）
    Array.from(wrapper.childNodes).forEach((node) => {
      if (node.nodeName === 'BR') node.parentNode?.removeChild(node)
    })

    const paragraphs = Array.from(wrapper.querySelectorAll('p')) as HTMLParagraphElement[]
    if (paragraphs.length) {
      paragraphs.forEach((paragraph) => {
        // 先剔除整段分页噪声，避免「本章未完」「第1/2页」等混入正文
        if (isPaginationNoise(paragraph.textContent || '')) {
          paragraph.remove()
          return
        }
        // 归一化 &nbsp; 为普通空格，避免拆段后段首残留字面实体
        let inner = paragraph.innerHTML.replace(/&nbsp;/gi, ' ')
        // 去掉段落首尾的空白文本节点与 <br>
        inner = inner
          .replace(/^(?:[\s\u3000\u00A0]|<br\s*\/?>)+/i, '')
          .replace(/(?:[\s\u3000\u00A0]|<br\s*\/?>)+$/i, '')
        // 连续 <br>（站点段尾常塞 4~5 个）折叠为一个分段标记
        inner = inner.replace(/(?:<br\s*\/?>[\s\u3000\u00A0]*){2,}/gi, '<br>')
        paragraph.innerHTML = inner

        // 段内用单个 <br> 分隔的，拆成独立段落，保证每段都有统一段间距/缩进
        const brs = Array.from(paragraph.querySelectorAll('br'))
        if (brs.length && /(?:<img|<ruby|<table|<ul|<ol)/i.test(paragraph.innerHTML) === false) {
          const fragment = document.createDocumentFragment()
          const parts = paragraph.innerHTML.split(/<br\s*\/?>/i)
          parts.forEach((part) => {
            const cleaned = part.replace(/^[\u3000\u00A0\s]+/, '').trim()
            if (!cleaned || isPaginationNoise(cleaned)) return
            const p = document.createElement('p')
            p.innerHTML = cleaned
            fragment.appendChild(p)
          })
          paragraph.replaceWith(fragment)
          return
        }

        const plainText = (paragraph.textContent || '').replace(/[\u3000\u00A0\s]/g, '').trim()
        const hasRenderableChildren = Boolean(paragraph.querySelector('img, ruby, table, ul, ol'))
        if (!plainText && !hasRenderableChildren) {
          paragraph.remove()
          return
        }
        paragraph.innerHTML = paragraph.innerHTML.replace(/^[\u3000\u00A0 \t]+/, '')
      })

      // 统一设置所有最终段落（含刚拆出的）的间距与缩进
      Array.from(wrapper.querySelectorAll('p')).forEach((p) => {
        p.style.marginTop = '0'
        p.style.marginBottom = `${config.value.paragraphSpacing}em`
        p.classList.toggle('reader-indent', config.value.firstLineIndent)
      })
    }
  } else {
    wrapper.innerHTML = text
      .split(/\n/)
      .filter((line: string) => line.trim() && !isPaginationNoise(line))
      .map((line: string) => {
        const shouldIndent = config.value.firstLineIndent
        const content = escapeHtmlText(stripLeadingIndent(line.trimEnd()))
        return `<p${shouldIndent ? ' class="reader-indent"' : ''} style="margin-top: 0; margin-bottom: ${config.value.paragraphSpacing}em;">${content}</p>`
      })
      .join('')
  }

  appendLocalEpubAssetAuth(wrapper)
  highlightSearchText(wrapper)
  return wrapper.innerHTML
}

function appendLocalEpubAssetAuth(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll('img')) as HTMLImageElement[]
  images.forEach((image) => {
    const src = image.getAttribute('src') || ''
    if (src.startsWith('/reader3/localEpubAsset')) {
      image.setAttribute('src', withAuthQuery(src))
    }
  })
}

function highlightSearchText(root: HTMLElement) {
  if (!showSearch.value || !searchQuery.value) return
  const regex = new RegExp(escapeRegExp(searchQuery.value), 'gi')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || ['MARK', 'SCRIPT', 'STYLE'].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT
      }
      regex.lastIndex = 0
      return regex.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text)
  }
  nodes.forEach((node) => {
    const value = node.textContent || ''
    regex.lastIndex = 0
    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const match of value.matchAll(regex)) {
      const index = match.index ?? 0
      if (index > cursor) {
        fragment.appendChild(document.createTextNode(value.slice(cursor, index)))
      }
      const mark = document.createElement('mark')
      mark.className = 'search-highlight'
      mark.textContent = match[0]
      fragment.appendChild(mark)
      cursor = index + match[0].length
    }
    if (cursor < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(cursor)))
    }
    node.parentNode?.replaceChild(fragment, node)
  })
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHtmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderChapterHtml(rawText: string) {
  return formatChapterHtml(store.processContentForDisplay(rawText || ''))
}

const formattedContent = computed(() => formatChapterHtml(store.displayContent || ''))

// 听书 / 短剧章节返回的是媒体直链，识别后交给播放器渲染
const mediaContent = computed(() => parseMediaContent(store.content || ''))

// 视频页必须纯黑沉浸：iOS 顶部状态栏与底部 home 安全区会透出根容器背景色，
// 若沿用阅读器米色主题就会在播放器上下露出米色边（用户截图1/图2的白边）。
const isVideoChapter = computed(() => mediaContent.value?.kind === 'video')
const effectiveBodyBg = computed(() => (isVideoChapter.value ? '#000000' : theme.value.body))

// 有声书字幕/歌词解析
const audioLrcLines = computed<LrcLine[]>(() => {
  if (mediaContent.value?.kind !== 'audio') return []
  return parseLrc(store.content)
})

const currentLrcIndex = computed(() => {
  const lines = audioLrcLines.value
  if (!lines.length) return -1
  const t = audioCurrent.value
  for (let i = lines.length - 1; i >= 0; i--) {
    if (t >= lines[i].time) return i
  }
  return 0
})
/*
const mediaFallbackText = computed(() => {
  if (!mediaContent.value) return ''
  return (store.content || '').trim()
})
*/
const mediaPlaybackUrl = computed(() => {
  const media = mediaContent.value
  if (!media) return ''
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('accessToken') : null
  // m3u8 流媒体优先使用源站直链（源站大多带有跨域头且内部相对切片不需要二次代理改写）；非 m3u8 或失败时通过代理
  if (/\.m3u8(?:\?|$)/i.test(media.url)) {
    return media.url
  }
  return buildMediaProxyUrl(media.url, store.book?.origin, token)
})

// ── 听书 / 短剧播放进度与控制 ──
const mediaPlayerRef = ref<HTMLMediaElement | null>(null)
let hlsInstance: Hls | null = null

function destroyHls() {
  if (hlsInstance) {
    try {
      hlsInstance.destroy()
    } catch {}
    hlsInstance = null
  }
}

function setupHlsIfNeeded() {
  destroyHls()
  const media = mediaContent.value
  if (!media || media.kind !== 'video') return
  const videoEl = mediaPlayerRef.value as HTMLVideoElement | null
  if (!videoEl) return

  const playUrl = mediaPlaybackUrl.value
  if (!playUrl) return

  const isM3u8 = /\.m3u8(?:\?|$)/i.test(playUrl) || /\.m3u8(?:\?|$)/i.test(media.url)
  if (!isM3u8) {
    videoEl.src = playUrl
    return
  }

  // Safari 原生支持 HLS
  if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = playUrl
    return
  }

  // 其他现代浏览器（Chrome / Edge / Firefox）通过 hls.js 解复用
  if (Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
    })
    hlsInstance = hls
    hls.loadSource(playUrl)
    hls.attachMedia(videoEl)
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // 网络失败尝试代理重试一次
            if (!videoEl.src.includes('bookSourceProxy')) {
              const proxyUrl = buildMediaProxyUrl(media.url, store.book?.origin, localStorage.getItem('accessToken'))
              hls.loadSource(proxyUrl)
            } else {
              hls.startLoad()
            }
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError()
            break
          default:
            destroyHls()
            break
        }
      }
    })
  } else {
    videoEl.src = playUrl
  }
}

watch(
  () => [mediaPlaybackUrl.value, mediaPlayerRef.value],
  () => {
    nextTick(() => {
      setupHlsIfNeeded()
    })
  },
)

onBeforeUnmount(() => {
  destroyHls()
})

const shouldWriteMediaProgress = createMediaProgressThrottle(5000)
let mediaRestoredKey = ''

/* ---- custom audio player state ---- */
const audioPlaying = ref(false)
const audioCurrent = ref(0)
const audioDuration = ref(0)
const audioRate = ref(1.0)
const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

const audioPct = computed(() => {
  if (!audioDuration.value || audioDuration.value <= 0) return 0
  return Math.min(100, Math.max(0, (audioCurrent.value / audioDuration.value) * 100))
})

function fmtTime(s: number): string {
  if (!s || isNaN(s) || s < 0) return '00:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m + ':' + sec.toString().padStart(2, '0')
}

function onAudioMetadata() {
  const el = mediaPlayerRef.value as HTMLMediaElement | null
  if (!el) return
  audioDuration.value = el.duration || 0
  el.playbackRate = audioRate.value
  restoreMediaProgress()
  el.play().then(() => { audioPlaying.value = true }).catch(() => {})
}

function onAudioTick() {
  const el = mediaPlayerRef.value as HTMLMediaElement | null
  if (!el) return
  audioCurrent.value = el.currentTime || 0
  audioDuration.value = el.duration || audioDuration.value || 0
  persistMediaProgress()
}

function onVideoPlayerTick(current: number, duration: number) {
  if (!shouldWriteMediaProgress()) return
  writeMediaProgress(store.book?.bookUrl, store.currentChapter?.url, current, duration)
}

function toggleAudio() {
  const el = mediaPlayerRef.value as HTMLMediaElement | null
  if (!el) return
  if (el.paused) {
    el.play().then(() => { audioPlaying.value = true }).catch(() => { audioPlaying.value = false })
  } else {
    el.pause()
    audioPlaying.value = false
  }
}

function replayAudio() {
  const el = mediaPlayerRef.value as HTMLMediaElement | null
  if (!el) return
  el.currentTime = 0
  audioCurrent.value = 0
  el.play().then(() => { audioPlaying.value = true }).catch(() => {})
}

function cycleRate() {
  const el = mediaPlayerRef.value as HTMLMediaElement | null
  const idx = RATES.indexOf(audioRate.value)
  audioRate.value = RATES[(idx + 1) % RATES.length]
  if (el) el.playbackRate = audioRate.value
}

function seekStart(e: MouseEvent | TouchEvent) {
  const el = mediaPlayerRef.value as HTMLMediaElement | null
  if (!el || !audioDuration.value) return
  const track = e.currentTarget as HTMLElement
  const rect = track.getBoundingClientRect()
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  el.currentTime = pct * audioDuration.value
  audioCurrent.value = el.currentTime

  /* drag support */
  const onMove = (ev: MouseEvent | TouchEvent) => {
    const cx = 'touches' in ev ? ev.touches[0].clientX : ev.clientX
    const p = Math.max(0, Math.min(1, (cx - rect.left) / rect.width))
    el.currentTime = p * audioDuration.value
    audioCurrent.value = el.currentTime
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.removeEventListener('touchend', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('touchmove', onMove)
  document.addEventListener('mouseup', onUp)
  document.addEventListener('touchend', onUp)
}

function mediaProgressKey() {
  return `${store.book?.bookUrl || ''}::${store.currentChapter?.url || ''}`
}

/** 加载完成后接着上次的位置继续播放（章节切换后只恢复一次）。 */
function restoreMediaProgress() {
  const el = mediaPlayerRef.value
  if (!el) return
  const key = mediaProgressKey()
  if (!key || mediaRestoredKey === key) return
  mediaRestoredKey = key
  const saved = readMediaProgress(store.book?.bookUrl, store.currentChapter?.url)
  if (saved && saved.position > 1 && saved.position < el.duration) {
    try {
      el.currentTime = saved.position
    } catch {
      /* 部分浏览器在元数据就绪前会拒绝赋值，忽略即可 */
    }
  }
}

function persistMediaProgress(force = false) {
  const el = mediaPlayerRef.value
  if (!el) return
  if (!force && !shouldWriteMediaProgress()) return
  writeMediaProgress(store.book?.bookUrl, store.currentChapter?.url, el.currentTime, el.duration)
}

/** 播完自动进入下一章；章节切换前先清掉已播完的进度，避免下次卡在结尾。 */
function handleMediaEnded() {
  const el = mediaPlayerRef.value
  if (el) writeMediaProgress(store.book?.bookUrl, store.currentChapter?.url, 0, el.duration)
  mediaRestoredKey = ''
  if (store.hasNext) void nextChapter()
}

// 换章时保存上一章进度（自动连播时 pause 也已完成一次落盘）
watch(() => store.currentIndex, () => {
  const el = mediaPlayerRef.value
  if (el && el.currentTime > 1 && el.duration - el.currentTime >= 5) {
    writeMediaProgress(store.book?.bookUrl, store.currentChapter?.url, el.currentTime, el.duration)
  }
  mediaRestoredKey = ''
})

/** 下载当前章节的音频 / 视频。
 *  跨域媒体直链上的 a[download] 在 WebView 内会被忽略（表现为点击无反应/跳转播放），
 *  因此改为 fetch 同源书源代理 -> Blob -> objectURL 触发下载，保证真正落盘。
 *  m3u8 是分片流，无法作为单文件下载，给出明确提示。 */
async function downloadMedia() {
  const media = mediaContent.value
  if (!media) return
  const title = (store.currentChapter?.title || store.book?.name || 'media').trim()
  const safeTitle = title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)

  if (/\.m3u8(?:\?|$)/i.test(media.url)) {
    appStore.showToast('该视频为 m3u8 流媒体，暂不支持直接下载', 'warning')
    return
  }

  const guessedExt = media.kind === 'video' ? 'mp4' : 'mp3'
  const match = media.url.match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i)
  const ext = match ? match[1].toLowerCase() : guessedExt
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('accessToken') : null
  const downloadUrl = buildMediaProxyUrl(media.url, store.book?.origin, token)

  try {
    const response = await fetch(downloadUrl, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = `${safeTitle}.${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // 延迟释放 objectURL，确保 WebView 已完成读取
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
    appStore.showToast('已开始下载本集', 'success')
  } catch {
    appStore.showToast('下载失败，请检查网络后重试', 'error')
  }
}

const {
  horizontalPageIndex,
  horizontalPageStep,
  horizontalPageStepStyle,
  horizontalPages,
  rebuildHorizontalPages,
  updateHorizontalMetrics,
  updateHorizontalEndState,
  resetHorizontalPagePosition,
} = useHorizontalPaging(
  store,
  computed(() => ({
    fontSize: config.value.fontSize,
    fontWeight: config.value.fontWeight,
    lineHeight: config.value.lineHeight,
  })),
  currentFontFamily,
  formattedContent,
  isHorizontalPageMode,
  scrollContainerRef,
)

const horizontalPageTransform = computed(() => {
  const offset = horizontalPageIndex.value * Math.max(1, horizontalPageStep.value)
  return `translate3d(${-offset}px, 0, 0)`
})
const horizontalPageTransitionDuration = computed(() => {
  const duration = Number(config.value.animateDuration) || 0
  if (duration <= 0) return '0ms'
  return `${Math.min(220, duration)}ms`
})
const {
  continuousChapters,
  continuousLoadingNext,
  continuousLoadingPrev,
  suppressContinuousSync,
  syncContinuousChapterHtml,
  getContinuousChapter,
  setContinuousActiveChapter,
  initializeContinuousChapters,
  syncContinuousToStoreState,
  loadContinuousNext,
  loadContinuousPrev,
  getContinuousSections,
  pruneReadChapters,
  clearContinuousChapters,
  disposeContinuousReading,
} = useContinuousReading(
  store,
  renderChapterHtml,
  isContinuousMode,
  hideReadChaptersMode,
  scrollContainerRef,
)

function syncHorizontalPageState() {
  const maxPage = Math.max(0, horizontalPages.value.length - 1)
  const progress = maxPage <= 0 ? 1 : horizontalPageIndex.value / maxPage
  store.setChapterScrollProgress(progress)
  updateHorizontalEndState()
  if (config.value.enablePreload && maxPage > 0 && horizontalPageIndex.value >= maxPage - 1) {
    store.preloadAroundChapter(store.currentIndex)
  }
  scheduleSaveReadingPosition()
  serverProgressAutoSaveScheduler.schedule()
}

/**
 * 按"真实渲染行边界"对齐的滚动翻页，解决首行/末行文字被从中间截断、相邻屏重复的问题。
 *
 * 关键：正文段落带段距（margin-bottom）、章节带标题与内边距（padding-top: 80px 等），
 * 真实行顶并不是行高的整数倍，也不是从 0 开始。若按 lineHeight 数学取整，
 * 落点必然卡在某行的中间 → 首行/末行被垂直切掉一半。
 * 这里用 Range.getClientRects() 直接量出每个段落每一行的真实顶部坐标，
 * 翻页落点吸附到这些真实边界，保证每一行都完整落在某一屏内。
 */

/** 收集视口附近的真实行顶坐标（文档坐标系，已含当前 scrollTop） */
function collectLineTops(container: HTMLElement): number[] {
  const cRect = container.getBoundingClientRect()
  const scrollTop = container.scrollTop
  // 只测量视口前后各一屏，避免长篇连续阅读时全量测量带来的开销
  const lo = scrollTop - container.clientHeight
  const hi = scrollTop + container.clientHeight * 2
  const tops: number[] = [0]

  container.querySelectorAll('.chapter-text').forEach((textEl) => {
    const host = textEl as HTMLElement
    const paragraphs = host.querySelectorAll('p')
    const nodes: Element[] = paragraphs.length ? Array.from(paragraphs) : [host]
    nodes.forEach((node) => {
      const el = node as HTMLElement
      const rect = el.getBoundingClientRect()
      const top = rect.top - cRect.top + scrollTop
      if (top + rect.height < lo || top > hi) return
      const range = document.createRange()
      range.selectNodeContents(el)
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects[i]
        if (r.height > 1 && r.width > 0) {
          tops.push(Math.round(r.top - cRect.top + scrollTop))
        }
      }
    })
  })

  // 章节标题顶部也是合法页首边界，避免标题被从中间截断
  container.querySelectorAll('.chapter-title').forEach((title) => {
    const top = (title as HTMLElement).getBoundingClientRect().top - cRect.top + scrollTop
    if (top >= lo && top <= hi) tops.push(Math.round(top))
  })

  return Array.from(new Set(tops)).sort((a, b) => a - b)
}

/**
 * 在真实行顶坐标里，找翻页落点：
 * - 向前（direction=1）：取 <= target 的最后一个整行顶（floor）。这样落点正好是一行的顶部，
 *   新页首行完整；且上一屏底部不会切在行中间——避免「最后一行显示不全」。
 *   不能用 ceil（>= target），否则会跳过一整行、把视口底边切在某行中段。
 * - 向后（direction=-1）：对称地取 >= target 的第一个整行顶（ceil），保证新页首行完整。
 */
function nearestLineTop(tops: number[], target: number, direction: 1 | -1): number {
  if (!tops.length) return target
  if (direction > 0) {
    let best = tops[0]
    for (const t of tops) {
      if (t <= target + 1) best = t
      else break
    }
    return best
  }
  for (const t of tops) {
    if (t >= target - 1) return t
  }
  return tops[tops.length - 1]
}

function pageScrollStep(container: HTMLElement): number {
  // 翻动接近一整屏；真实落点由 nearestLineTop 吸附到整行边界
  return container.clientHeight
}

/**
 * 挑一个"页首对齐真实行顶、页尾落在行间隙"的落点：
 * 之前只用 floor 对齐页首（<= target 的最后一行顶），首行完整，但视口底部常常正好切在
 * 某一行的中间，表现为"最后一行文字显示不全"。这里在目标位置前后各约一行的范围内
 * 枚举候选行顶，优先选择让"落点+视口高"刚好落在下一行顶之前的那一个——这样最后一行
 * 完整显示、底部还留一点空白间隙，不会把字从中间截断。
 */
function bottomSafeLanding(lineTops: number[], target: number, vh: number, curTop: number): number {
  const fallback = nearestLineTop(lineTops, target, 1)
  if (lineTops.length < 2) return fallback
  const pitch = Math.max(1, config.value.fontSize * config.value.lineHeight)
  const lo = target - pitch * 2
  const hi = target + pitch * 2
  let best = fallback
  let bestGap = Infinity
  let bestDist = Infinity
  for (const landing of lineTops) {
    if (landing <= curTop + 1) continue
    if (landing < lo || landing > hi) continue
    const bottom = landing + vh
    // bottom 之上的最近行顶：gap 越小，说明页尾越贴近行间隙，末行越完整
    let gap = Infinity
    for (const t of lineTops) {
      if (t >= bottom) { gap = t - bottom; break }
    }
    if (!Number.isFinite(gap)) continue
    const dist = Math.abs(landing - target)
    if (gap < bestGap - 0.5 || (Math.abs(gap - bestGap) <= 0.5 && dist < bestDist)) {
      bestGap = gap
      bestDist = dist
      best = landing
    }
  }
  return best
}

/**
 * 连续滚动「自由滑动停止后」的末行吸附。
 * 点击翻页走 snapPageTarget，末行本就完整；但手指自由滑动会把 scrollTop 停在任意像素，
 * 导致底部最后一行被从中间截断（只显示上半部分）。这里在滚动停止后做一次温柔的微调：
 * 若当前落点不在「末行完整」的行间隙，就吸附到最近的安全落点。
 * - 只处理连续模式、非自动播放、非位置恢复/程序化滚动期间；
 * - 吸附自身会再次触发 scroll，用 suppressScrollSnapUntil 抑制，避免来回抖动；
 * - 用 smooth 过渡 + 限制最大位移，避免长距离跳动影响阅读手感。
 */
function snapContinuousScrollToSafeLine() {
  const container = scrollContainerRef.value
  if (!container || !isContinuousMode.value) return
  // 自动播放、位置恢复/程序化滚动期间不吸附，避免打架
  if (store.isAutoScrolling || Date.now() < suppressContinuousScrollSyncUntil) return
  if (Date.now() < suppressScrollSnapUntil) return

  const lineTops = collectLineTops(container)
  if (lineTops.length < 2) return
  const vh = container.clientHeight
  const curTop = container.scrollTop
  const maxScroll = Math.max(0, container.scrollHeight - vh)
  // 顶部/底部（含接近切章区间）不吸附，避免干扰加载与切章
  if (curTop <= 2 || curTop >= maxScroll - 2) return

  const pitch = Math.max(1, config.value.fontSize * config.value.lineHeight)
  const bottom = curTop + vh
  // 视口底部下方最近的行顶；gap 越小说明底部越贴近行间隙，末行越完整
  let nextLineTop = Infinity
  for (const t of lineTops) {
    if (t >= bottom) { nextLineTop = t; break }
  }
  if (!Number.isFinite(nextLineTop)) return
  const gap = nextLineTop - bottom
  // 已经落在行间隙附近（末行完整）则不动；容差 3px 避免像素抖动
  if (gap <= 3) return

  // 目标落点：让该行顶对齐视口底部（即 scrollTop += gap），末行完整显示。
  // 位移过大（超过两行，通常是段落大间距/章节切换）时放弃，避免明显跳动。
  const target = Math.min(maxScroll, curTop + gap)
  if (target - curTop > pitch * 2) return
  suppressScrollSnapUntil = Date.now() + 600
  container.scrollTo({ top: target, behavior: 'smooth' })
}

function scheduleScrollSnap() {
  if (scrollSnapTimer) clearTimeout(scrollSnapTimer)
  scrollSnapTimer = window.setTimeout(() => {
    scrollSnapTimer = null
    snapContinuousScrollToSafeLine()
  }, 200)
}

/**
 * 翻页落点：让章节标题另起一页、且首末行都完整。
 * 1) 章节标题：凡是落在当前视口下半部、或紧随其后一屏内的标题，都直接吸附到它的顶部，
 *    让新章节从页首开始（标题在新的一页），避免标题卡在页尾。
 * 2) 无合适标题时，用 bottomSafeLanding 同时照顾页首与页尾，避免末行被从中间截断。
 */
function snapPageTarget(container: HTMLElement, target: number, direction: 1 | -1): number {
  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
  const vh = container.clientHeight
  const clamped = Math.max(0, Math.min(maxScroll, target))
  const lineTops = collectLineTops(container)
  const cRect = container.getBoundingClientRect()
  const curTop = container.scrollTop

  // 章节标题作为分页点：连续模式的 .chapter-title 元素
  const titleEls: HTMLElement[] = Array.from(container.querySelectorAll('.chapter-title'))

  const tolerance = vh * 0.85
  let bestTop: number | null = null
  let bestDist = Infinity
  titleEls.forEach((title) => {
    const top = Math.round(title.getBoundingClientRect().top - cRect.top + curTop)
    if (direction > 0) {
      // 标题在当前视口下半部或紧随其后（属于「下一屏应该从标题开始」的情况）
      const lower = curTop + vh * 0.28
      const upper = curTop + vh + tolerance
      if (top >= lower && top <= upper) {
        const dist = Math.abs(top - clamped)
        if (dist < bestDist) { bestDist = dist; bestTop = top }
      }
    } else {
      // 向后翻：标题在当前视口上半部或紧邻其前
      const upper = curTop + vh * 0.72
      const lower = curTop - vh * 0.85
      if (top <= upper && top >= lower) {
        const dist = Math.abs(top - clamped)
        if (dist < bestDist) { bestDist = dist; bestTop = top }
      }
    }
  })
  if (bestTop !== null) return Math.max(0, Math.min(maxScroll, bestTop))

  const lineTarget = direction > 0
    ? bottomSafeLanding(lineTops, clamped, vh, curTop)
    : nearestLineTop(lineTops, clamped, direction)
  // 接近章节末尾时，整行 floor 可能停在原处导致翻页卡住；此时直接滚到底，下一次翻页切章。
  if (direction > 0 && lineTarget <= curTop + 2) return maxScroll
  return lineTarget
}

function pageForward() {
  const container = scrollContainerRef.value
  if (!container) return
  // 媒体播放页不允许翻页切集（避免误触）
  if (mediaContent.value) return
  // 点击翻页落点已经过 snapPageTarget 对齐末行，抑制自由滚动吸附避免二次抖动
  suppressScrollSnapUntil = Date.now() + 500
  if (isHorizontalPageMode.value) {
    const maxPage = Math.max(0, horizontalPages.value.length - 1)
    if (horizontalPageIndex.value >= maxPage) {
      nextChapter()
      return
    }
    horizontalPageIndex.value = Math.min(maxPage, horizontalPageIndex.value + 1)
    container.scrollTo({ left: 0, behavior: 'auto' })
    syncHorizontalPageState()
    return
  }
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
    nextChapter()
    return
  }
  const step = pageScrollStep(container)
  const target = snapPageTarget(container, container.scrollTop + step, 1)
  container.scrollTo({ top: target, behavior: 'instant' })
}

function pageBackward() {
  const container = scrollContainerRef.value
  if (!container) return
  // 媒体播放页不允许翻页切集（避免误触）
  if (mediaContent.value) return
  // 点击翻页落点已经过 snapPageTarget 对齐末行，抑制自由滚动吸附避免二次抖动
  suppressScrollSnapUntil = Date.now() + 500
  if (isHorizontalPageMode.value) {
    if (horizontalPageIndex.value <= 0) {
      prevChapter()
      return
    }
    horizontalPageIndex.value = Math.max(0, horizontalPageIndex.value - 1)
    container.scrollTo({ left: 0, behavior: 'auto' })
    syncHorizontalPageState()
    return
  }
  const step = pageScrollStep(container)
  if (isContinuousMode.value) {
    if (container.scrollTop <= 2) {
      void loadContinuousPrev()
      return
    }
    const target = snapPageTarget(container, container.scrollTop - step, -1)
    container.scrollTo({ top: Math.max(0, target), behavior: 'instant' })
    return
  }
  if (container.scrollTop <= 2) {
    prevChapter()
    return
  }
  const target = snapPageTarget(container, container.scrollTop - step, -1)
  container.scrollTo({ top: Math.max(0, target), behavior: 'instant' })
}

// Navigation
function goHome() {
  // 返回书架不等待服务端保存：本地进度同步落盘 + 服务端 keepalive 上报后立即跳转。
  // 旧的 await flushBeforeRouteLeave() 会阻塞等待 saveBookProgress 网络返回，
  // 网络抖动时返回明显卡顿；onBeforeRouteLeave 仍会 flushKeepalive 兜底，进度不丢。
  readerProgressExitSaver.flushKeepalive()
  router.replace('/')
}

/** 发现页：保存进度后跳转到发现 */
async function goExplore() {
  await persistReadingProgressBeforeLeave()
  router.push('/explore')
}

/** 从书架移除当前书：二次确认后删除并返回书架 */
async function handleRemoveBook() {
  const currentBook = store.book
  if (!currentBook) return
  if (!confirm(`确定从书架删除 "${currentBook.name}"？`)) return
  try {
    await bookshelfStore.removeBook(currentBook)
    appStore.showToast(`已删除 "${currentBook.name}"`, 'success')
    router.replace('/')
  } catch {
    appStore.showToast('删除失败，请稍后重试', 'warning')
  }
}

function handlePageHide() {
  persistReadingProgressKeepalive()
}

function handleBeforeUnload() {
  persistReadingProgressKeepalive()
}

function handleVisibilityChange() {
  if (document.visibilityState !== 'hidden') return
  persistReadingProgressTemporaryKeepalive()
}

async function persistReadingProgressBeforeLeave() {
  await readerProgressExitSaver.flushBeforeRouteLeave()
}

function persistReadingProgressKeepalive() {
  readerProgressExitSaver.flushKeepalive()
}

function persistReadingProgressTemporaryKeepalive() {
  readerProgressExitSaver.flushTemporaryKeepalive()
}

async function prevChapter() {
  const targetIndex = store.currentIndex - 1
  if (targetIndex < 0) return

  if (!isContinuousMode.value) {
    await store.prevChapter()
    scrollToTop()
    return
  }

  await rebuildContinuousAtChapter(targetIndex)
}

async function nextChapter() {
  const targetIndex = store.currentIndex + 1
  if (targetIndex >= store.chapters.length) return

  if (!isContinuousMode.value) {
    await store.nextChapter()
    scrollToTop()
    return
  }

  await rebuildContinuousAtChapter(targetIndex)
}

async function jumpFromCatalog(targetIndex: number) {
  if (targetIndex < 0 || targetIndex >= store.chapters.length) return

  if (!isContinuousMode.value) {
    await store.loadChapter(targetIndex)
    store.closePanel()
    scrollToTop()
    return
  }

  await rebuildContinuousAtChapter(targetIndex)
  store.closePanel()
}

async function rebuildContinuousAtChapter(targetIndex: number) {
  suppressContinuousScrollSyncUntil = Date.now() + 500
  suppressContinuousAutoLoadUntil = Date.now() + 500
  await initializeContinuousChapters(targetIndex, false)
}

function scrollToTop() {
  if (scrollContainerRef.value) {
    if (isHorizontalPageMode.value) {
      scrollContainerRef.value.scrollTo({ left: 0, behavior: 'smooth' })
    } else {
      scrollContainerRef.value.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }
}

function scrollToBottom() {
  if (scrollContainerRef.value) {
    scrollContainerRef.value.scrollTo({ top: scrollContainerRef.value.scrollHeight, behavior: 'smooth' })
  }
}

function getPositionStorageKey() {
  return store.book?.bookUrl ? `${READER_POSITION_PREFIX}${store.book.bookUrl}` : ''
}

function normalizePositionTimestamp(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return 0
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function buildServerSavedPosition(): SavedReadingPosition | null {
  if (!store.book) return null
  if (store.book.durChapterIndex !== store.currentIndex) return null
  const rawPos = typeof store.book.durChapterPos === 'number' ? store.book.durChapterPos : 0
  const progress = rawPos > 1 ? rawPos / 10000 : rawPos
  return {
    chapterIndex: store.currentIndex,
    progress: Math.max(0, Math.min(1, progress || 0)),
    updatedAt: normalizePositionTimestamp(store.book.durChapterTime),
  }
}

function loadSavedReadingPosition() {
  const key = getPositionStorageKey()
  if (!key) {
    pendingRestorePosition.value = null
    pendingRestoreAttempts = 0
    debugPositionLog('skip load: no storage key')
    return
  }
  try {
    const raw = localStorage.getItem(key)
    const localSaved = raw ? JSON.parse(raw) as SavedReadingPosition : null
    const serverSaved = buildServerSavedPosition()

    let selected: SavedReadingPosition | null = null
    let source: 'local' | 'server' | 'none' = 'none'

    if (localSaved && localSaved.chapterIndex === store.currentIndex) {
      selected = localSaved
      source = 'local'
    }

    if (serverSaved && serverSaved.chapterIndex === store.currentIndex) {
      if (!selected || normalizePositionTimestamp(serverSaved.updatedAt) > normalizePositionTimestamp(selected.updatedAt)) {
        selected = serverSaved
        source = 'server'
      }
    }

    if (!selected) {
      pendingRestorePosition.value = null
      pendingRestoreAttempts = 0
      clearRestoreStabilizers()
      debugPositionLog(raw ? 'ignored saved position' : 'no saved position', {
        key,
        currentIndex: store.currentIndex,
        localSaved,
        serverSaved,
      })
      return
    }

    pendingRestorePosition.value = selected
    pendingRestoreAttempts = 0
    clearRestoreStabilizers()
    debugPositionLog('loaded saved position', {
      key,
      saved: selected,
      source,
      localSaved,
      serverSaved,
      currentIndex: store.currentIndex,
      accepted: !!pendingRestorePosition.value,
    })
    if (pendingRestorePosition.value) {
      suppressPositionSaveUntil = Date.now() + 2500
    }
  } catch {
    pendingRestorePosition.value = null
    pendingRestoreAttempts = 0
    clearRestoreStabilizers()
    debugPositionLog('failed to parse saved position', { key })
  }
}

function saveReadingPosition(options: { force?: boolean } = {}) {
  const key = getPositionStorageKey()
  const container = scrollContainerRef.value
  const suppressed = !options.force && Date.now() < suppressPositionSaveUntil
  if (!key || !container || store.loading || !store.book || suppressed) {
    debugPositionLog('skip save', {
      key,
      hasContainer: !!container,
      loading: store.loading,
      hasBook: !!store.book,
      suppressed,
      currentIndex: store.currentIndex,
    })
    return
  }

  const basePosition: SavedReadingPosition = {
    chapterIndex: store.currentIndex,
    progress: store.chapterScrollProgress,
    updatedAt: Date.now(),
  }

  const anchorRatio = isContinuousMode.value ? CONTINUOUS_POSITION_ANCHOR_RATIO : 0.3
  const anchorViewportY = container.getBoundingClientRect().top + container.clientHeight * anchorRatio
  if (isContinuousMode.value && continuousChapters.value.length) {
    const section = container.querySelector(`.continuous-chapter[data-chapter-index="${store.currentIndex}"]`) as HTMLElement | null
    const paragraphs = Array.from(section?.querySelectorAll('.chapter-text p') || []) as HTMLElement[]
    if (paragraphs.length) {
      let activeParagraph = paragraphs[0]
      let paragraphIndex = 0
      paragraphs.forEach((paragraph, index) => {
        if (paragraph.getBoundingClientRect().top <= anchorViewportY) {
          activeParagraph = paragraph
          paragraphIndex = index
        }
      })
      const rect = activeParagraph.getBoundingClientRect()
      const paragraphProgress = rect.height > 0 ? Math.max(0, Math.min(1, (anchorViewportY - rect.top) / rect.height)) : 0
      basePosition.paragraphIndex = paragraphIndex
      basePosition.paragraphProgress = paragraphProgress
    }
  } else if (!isHorizontalPageMode.value) {
    const paragraphs = Array.from(chapterTextRef.value?.querySelectorAll('p') || []) as HTMLElement[]
    if (paragraphs.length) {
      let activeParagraph = paragraphs[0]
      let paragraphIndex = 0
      paragraphs.forEach((paragraph, index) => {
        if (paragraph.getBoundingClientRect().top <= anchorViewportY) {
          activeParagraph = paragraph
          paragraphIndex = index
        }
      })
      const rect = activeParagraph.getBoundingClientRect()
      const paragraphProgress = rect.height > 0 ? Math.max(0, Math.min(1, (anchorViewportY - rect.top) / rect.height)) : 0
      basePosition.paragraphIndex = paragraphIndex
      basePosition.paragraphProgress = paragraphProgress
    }
  }

  localStorage.setItem(key, JSON.stringify(basePosition))
  debugPositionLog('saved position', { key, position: basePosition })
}

function scheduleSaveReadingPosition() {
  if (persistPositionTimer) clearTimeout(persistPositionTimer)
  persistPositionTimer = window.setTimeout(() => {
    saveReadingPosition()
  }, 120)
}

function restoreReadingPosition() {
  return restoreReadingPositionInternal(pendingRestorePosition.value, true)
}

function clearRestoreStabilizers() {
  while (restoreStabilizeTimers.length) {
    const timer = restoreStabilizeTimers.pop()
    if (typeof timer === 'number') clearTimeout(timer)
  }
}

function scheduleRestoreStabilization(_saved: SavedReadingPosition) {
  // 阅读位置只在打开章节时恢复一次。
  // 之前 iOS 下会在 140/320/680ms 反复重新纠偏，用户已经开始阅读也会被拽回去，故移除。
  clearRestoreStabilizers()
}

function restoreReadingPositionInternal(saved: SavedReadingPosition | null, finalize: boolean) {
  const container = scrollContainerRef.value
  if (!saved || !container || saved.chapterIndex !== store.currentIndex) {
    debugPositionLog('restore aborted', {
      hasSaved: !!saved,
      hasContainer: !!container,
      savedChapterIndex: saved?.chapterIndex,
      currentIndex: store.currentIndex,
    })
    return false
  }

  if (isHorizontalPageMode.value) {
    if (store.loading || container.scrollWidth <= container.clientWidth + 4) {
      debugPositionLog('restore waiting: horizontal content not ready', {
        saved,
        loading: store.loading,
        scrollWidth: container.scrollWidth,
        clientWidth: container.clientWidth,
      })
      return false
    }
    const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth)
    container.scrollTo({ left: maxScroll * Math.max(0, Math.min(1, saved.progress || 0)), behavior: 'auto' })
    if (finalize) {
      pendingRestorePosition.value = null
      pendingRestoreAttempts = 0
    }
    debugPositionLog('restored horizontal position', { saved, maxScroll })
    return true
  }

  const anchorOffset = container.clientHeight * (isContinuousMode.value ? CONTINUOUS_POSITION_ANCHOR_RATIO : 0.3)
  let targetTop = 0

  if (isContinuousMode.value) {
    if (store.loading || !continuousChapters.value.length) {
      debugPositionLog('restore waiting: continuous content not ready', {
        saved,
        loading: store.loading,
        continuousCount: continuousChapters.value.length,
      })
      return false
    }
    const section = container.querySelector(`.continuous-chapter[data-chapter-index="${saved.chapterIndex}"]`) as HTMLElement | null
    if (!section) {
      debugPositionLog('restore failed: section not found', {
        saved,
        availableSections: Array.from(container.querySelectorAll('.continuous-chapter')).map((el) => (el as HTMLElement).dataset.chapterIndex),
      })
      return false
    }
    const paragraphs = Array.from(section.querySelectorAll('.chapter-text p')) as HTMLElement[]
    if (typeof saved.paragraphIndex === 'number' && !paragraphs.length) {
      debugPositionLog('restore waiting: continuous paragraphs not ready', {
        saved,
        sectionIndex: saved.chapterIndex,
      })
      return false
    }
    if (paragraphs.length && typeof saved.paragraphIndex === 'number') {
      const paragraph = paragraphs[Math.max(0, Math.min(paragraphs.length - 1, saved.paragraphIndex))]
      const top = paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      const paragraphProgress = Math.max(0, Math.min(1, saved.paragraphProgress || 0))
      targetTop = Math.max(section.offsetTop, top + paragraph.offsetHeight * paragraphProgress - anchorOffset)
    } else {
      const nextSection = section.nextElementSibling as HTMLElement | null
      const sectionHeight = Math.max(1, (nextSection ? nextSection.offsetTop : container.scrollHeight) - section.offsetTop)
      if ((saved.progress || 0) > 0 && sectionHeight <= Math.max(1, container.clientHeight * 0.25)) {
        debugPositionLog('restore waiting: continuous section height not ready', {
          saved,
          sectionHeight,
          clientHeight: container.clientHeight,
        })
        return false
      }
      targetTop = Math.max(
        section.offsetTop,
        section.offsetTop + sectionHeight * Math.max(0, Math.min(1, saved.progress || 0)),
      )
    }
  } else {
    const paragraphs = Array.from(chapterTextRef.value?.querySelectorAll('p') || []) as HTMLElement[]
    if (store.loading || !chapterTextRef.value) {
      debugPositionLog('restore waiting: chapter content not ready', {
        saved,
        loading: store.loading,
        hasChapterText: !!chapterTextRef.value,
      })
      return false
    }
    if (typeof saved.paragraphIndex === 'number' && !paragraphs.length) {
      debugPositionLog('restore waiting: chapter paragraphs not ready', {
        saved,
      })
      return false
    }
    if (paragraphs.length && typeof saved.paragraphIndex === 'number') {
      const paragraph = paragraphs[Math.max(0, Math.min(paragraphs.length - 1, saved.paragraphIndex))]
      const top = paragraph.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      const paragraphProgress = Math.max(0, Math.min(1, saved.paragraphProgress || 0))
      targetTop = top + paragraph.offsetHeight * paragraphProgress - anchorOffset
    } else {
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
      if ((saved.progress || 0) > 0 && maxScroll <= 4) {
        debugPositionLog('restore waiting: max scroll not ready', {
          saved,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
          maxScroll,
        })
        return false
      }
      targetTop = maxScroll * Math.max(0, Math.min(1, saved.progress || 0))
    }
  }

  container.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' })
  if (finalize) {
    pendingRestorePosition.value = null
    pendingRestoreAttempts = 0
    const suppressMs = isContinuousMode.value && isIosWebkit.value ? 1600 : 500
    suppressContinuousScrollSyncUntil = Date.now() + suppressMs
    suppressContinuousAutoLoadUntil = Date.now() + suppressMs
    scheduleRestoreStabilization(saved)
  }
  suppressPositionSaveUntil = Date.now() + 400
  debugPositionLog('restored vertical position', {
    saved,
    targetTop,
    isContinuous: isContinuousMode.value,
    finalize,
  })
  return true
}

function scheduleRestoreReadingPosition() {
  if (restorePositionTimer) clearTimeout(restorePositionTimer)
  debugPositionLog('schedule restore', {
    attempts: pendingRestoreAttempts,
    hasPending: !!pendingRestorePosition.value,
    currentIndex: store.currentIndex,
  })
  restorePositionTimer = window.setTimeout(() => {
    void nextTick(() => {
      const restored = restoreReadingPosition()
      if (!restored && pendingRestorePosition.value && pendingRestoreAttempts < 12) {
        pendingRestoreAttempts += 1
        debugPositionLog('restore retry', {
          attempts: pendingRestoreAttempts,
          pending: pendingRestorePosition.value,
          currentIndex: store.currentIndex,
        })
        scheduleRestoreReadingPosition()
      } else if (!restored) {
        debugPositionLog('restore gave up', {
          attempts: pendingRestoreAttempts,
          pending: pendingRestorePosition.value,
          currentIndex: store.currentIndex,
        })
        pendingRestorePosition.value = null
        pendingRestoreAttempts = 0
      }
    })
  }, pendingRestoreAttempts === 0 ? 0 : 80)
}

const {
  clearReadingClass,
  startAutoScroll,
  stopAutoScroll,
  startSpeech,
  speechPrev,
  speechNext,
  restartSpeechFromCurrentParagraph,
  cancelSpeechTransition,
  resetAutoParagraphIndex,
  handleContentChanged,
  disposeAutoPlayback,
} = useReaderAutoPlayback(
  store,
  computed(() => ({
    autoPageMode: config.value.autoPageMode,
    clickAction: config.value.clickAction,
    scrollPixel: config.value.scrollPixel,
    pageSpeed: config.value.pageSpeed,
    fontSize: config.value.fontSize,
    lineHeight: config.value.lineHeight,
  })),
  isContinuousMode,
  scrollContainerRef,
  chapterTextRef,
  nextChapter,
  prevChapter,
)

// 点击正文唤出控制面板的中间区域（按屏幕高度比例）。
// 收窄为 0.4~0.6（原 0.3~0.7），避免屏幕下半部点击正文时误触唤出菜单。
const MENU_ZONE_TOP = 0.4
const MENU_ZONE_BOTTOM = 0.6

// Click behavior
function handleBackgroundClick(e: Event) {
  // If clicked directly on the reader-view wrapper, toggle controls
  if ((e.target as HTMLElement).classList.contains('reader-view')) {
    showControls.value = false
  }
}

function handleContextMenu(event: Event) {
  if (!disableSystemCallout.value) return
  event.preventDefault()
}

function handleGlobalClick(e: MouseEvent) {
  if (store.activePanel) return
  if (Date.now() < suppressNextTapUntil) return
  if (Date.now() < suppressSelectionCloseUntil.value) return
  if (selectionMenu.value.visible) {
    hideSelectionMenu()
    return
  }
  if (window.getSelection?.()?.toString().trim()) return

  const target = e.target as HTMLElement | null
  if (isReaderInteractiveClickTarget(target)) return
  if (showControls.value && !store.activePanel) {
    showControls.value = false
    return
  }
  if (store.isAutoScrolling) return

  // 媒体播放页（听书 / 短剧）：点击空白区域不再上下切集，只保留菜单开关
  if (mediaContent.value && !store.activePanel) {
    clickZoneAction('menu')
    return
  }
  
  if (isHorizontalPageMode.value && isMobile.value) {
    const x = e.clientX / window.innerWidth
    if (x < 0.3) {
      clickZoneAction('prev')
    } else if (x > 0.7) {
      clickZoneAction('next')
    } else {
      clickZoneAction('menu')
    }
  } else {
    const y = e.clientY / window.innerHeight
    if (y < MENU_ZONE_TOP) {
      clickZoneAction('prev')
    } else if (y > MENU_ZONE_BOTTOM) {
      clickZoneAction('next')
    } else {
      clickZoneAction('menu')
    }
  }
}

function clickZoneAction(zone: 'prev' | 'menu' | 'next') {
  if (store.isAutoScrolling) return

  if (zone === 'menu') {
    if (isMobile.value) {
      showControls.value = !showControls.value
    } else {
      showPcSidebars.value = !showPcSidebars.value
    }
    return
  }
  
  if (config.value.clickAction === 'none') return
  
  const container = scrollContainerRef.value
  if (!container) return
  
  if (isHorizontalPageMode.value) {
    if (zone === 'next') pageForward()
    else pageBackward()
    return
  }

  const h = container.clientHeight
  const delta = pageScrollStep(container) // 按整行翻页，避免半行截断与相邻屏重复

  if (config.value.clickAction === 'next') {
    pageForward()
    return
  }

  if (zone === 'next') {
    if (container.scrollTop + h >= container.scrollHeight - 2) {
      if (config.value.clickAction === 'auto') nextChapter()
    } else {
      container.scrollTo({ top: snapPageTarget(container, container.scrollTop + delta, 1), behavior: 'instant' })
    }
  } else {
    if (container.scrollTop <= 2) {
      if (config.value.clickAction === 'auto') prevChapter()
    } else {
      container.scrollTo({ top: Math.max(0, snapPageTarget(container, container.scrollTop - delta, -1)), behavior: 'instant' })
    }
  }
}

/**
 * 更新页尾信息：左侧章节名由 store.currentChapter 提供；
 * 右侧「当前屏/本章总屏」按当前章 DOM 高度与视口高度计算，滚动/切章时实时刷新。
 */
function updatePageFooter() {
  if (!showPageFooter.value) return
  const container = scrollContainerRef.value
  if (!container) return
  const vh = Math.max(1, container.clientHeight)
  const scrollTop = container.scrollTop

  let chapterTop = 0
  let chapterRange = 0
  if (isContinuousMode.value) {
    const sections = getContinuousSections()
    if (!sections.length) return
    const anchorLine = scrollTop + vh * CONTINUOUS_POSITION_ANCHOR_RATIO
    let active = sections[0]
    for (const section of sections) {
      if (section.offsetTop <= anchorLine) active = section
      else break
    }
    const next = sections[sections.indexOf(active) + 1] || null
    chapterTop = active.offsetTop
    chapterRange = Math.max(1, (next ? next.offsetTop : container.scrollHeight) - chapterTop)
  } else {
    const article = container.querySelector('.chapter-content') as HTMLElement | null
    chapterTop = article ? article.offsetTop : 0
    chapterRange = Math.max(1, container.scrollHeight - chapterTop)
  }

  const total = Math.max(1, Math.ceil(chapterRange / vh))
  const current = Math.max(1, Math.min(total, Math.floor((scrollTop - chapterTop) / vh) + 1))
  pageFooter.value = {
    title: store.currentChapter?.title || '',
    current,
    total,
  }
}

let updatePageFooterRaf = 0
function schedulePageFooterUpdate() {
  if (updatePageFooterRaf) return
  updatePageFooterRaf = window.requestAnimationFrame(() => {
    updatePageFooterRaf = 0
    updatePageFooter()
  })
}

function handleScroll() {
  hideSelectionMenu()
  schedulePageFooterUpdate()
  const container = scrollContainerRef.value
  if (container && isContinuousMode.value && continuousChapters.value.length) {
    if (Date.now() < suppressContinuousScrollSyncUntil) {
      scheduleSaveReadingPosition()
      return
    }
    const sections = getContinuousSections()
    if (sections.length) {
      const anchorLine = container.scrollTop + container.clientHeight * CONTINUOUS_POSITION_ANCHOR_RATIO
      let activeSection = sections[0]
      for (const section of sections) {
        if (section.offsetTop <= anchorLine) {
          activeSection = section
        } else {
          break
        }
      }

      const activeIndex = Number(activeSection.dataset.chapterIndex || 0)
      const activeChapter = getContinuousChapter(activeIndex)
      const nextSection = sections[sections.indexOf(activeSection) + 1] || null
      const sectionRange = Math.max(
        1,
        (nextSection ? nextSection.offsetTop : container.scrollHeight) - activeSection.offsetTop,
      )
      const progress = Math.max(0, Math.min(1, (container.scrollTop - activeSection.offsetTop) / sectionRange))
      if (activeChapter) {
        if (store.currentIndex !== activeIndex || store.content !== activeChapter.content) {
          setContinuousActiveChapter(activeIndex, activeChapter.content, progress)
        } else {
          store.setChapterScrollProgress(progress)
        }
      }
    }

    // 只向下追加下一章；向上不再自动前插上一章，避免滚动高度补偿导致整页跳动
    if (Date.now() >= suppressContinuousAutoLoadUntil && container.scrollHeight - (container.scrollTop + container.clientHeight) < 480) {
      loadContinuousNext()
    }
    // 手指自由滑动停止后，把末行吸附到整行边界，避免底部文字被从中间截断
    scheduleScrollSnap()
  } else if (container) {
    const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight)
    const progress = isHorizontalPageMode.value
      ? (() => {
          const maxPage = Math.max(0, horizontalPages.value.length - 1)
          return maxPage <= 0 ? 1 : horizontalPageIndex.value / maxPage
        })()
      : (container.scrollHeight <= container.clientHeight ? 1 : container.scrollTop / maxScroll)
    store.setChapterScrollProgress(progress)
    if (isHorizontalPageMode.value) {
      updateHorizontalMetrics()
      const maxPage = Math.max(0, horizontalPages.value.length - 1)
      horizontalPageIndex.value = Math.max(0, Math.min(maxPage, horizontalPageIndex.value))
      if (container.scrollLeft !== 0) {
        container.scrollTo({ left: 0, behavior: 'auto' })
      }
      updateHorizontalEndState()
      if (config.value.enablePreload && maxPage > 0 && horizontalPageIndex.value >= maxPage - 1) {
        store.preloadAroundChapter(store.currentIndex)
      }
    } else {
      // 只做预加载，绝不自动切章：章节切换一律由用户明确操作触发（目录 / 上一章 / 下一章 / 翻页区点击）
      if (config.value.enablePreload && container.scrollHeight - (container.scrollTop + container.clientHeight) < container.clientHeight * 1.5) {
        store.preloadAroundChapter(store.currentIndex)
      }
    }
  }
  if (showControls.value && !store.activePanel) {
    showControls.value = false
  }
  scheduleSaveReadingPosition()
  serverProgressAutoSaveScheduler.schedule()
}

function handleTouchStart(_event: TouchEvent) {
  stopAutoScroll()
  hideSelectionMenu()
  // 小说阅读模式下完全使用原生上下滚动，禁用水平手势与左右翻页滑动，避免移动端乱跳
  touchState.value.moving = false
}

function handleTouchMove(_event: TouchEvent) {
  // 小说阅读不拦截任何 touchmove，保证原生纵向平滑滚动
}

function handleTouchEnd(_event: TouchEvent) {
  touchState.value.moving = false
  scheduleSelectionMenuUpdate(260)
}

function openCachePanel() {
  store.togglePanel('cache')
}

// Keyboard shortcuts
function handleKeydown(e: KeyboardEvent) {
  const activeElement = document.activeElement as HTMLElement | null
  const tagName = activeElement?.tagName?.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || activeElement?.isContentEditable) {
    return
  }

  // Handle Escape key first - close panels or go home
  if (e.key === 'Escape') {
    if (store.activePanel) {
      store.closePanel()
      return
    }
    if (selectionMenu.value.visible) {
      hideSelectionMenu()
      return
    }
    if (showSearch.value) {
      closeSearch()
      return
    }
    if (showTTSPanel.value) {
      closeTTSPanel()
      return
    }
    if (showBookInfo.value) {
      showBookInfo.value = false
      return
    }
    if (showControls.value) {
      showControls.value = false
      return
    }
    // If nothing is open, go home
    goHome()
    return
  }

  // Don't process other keys when panels are open
  if (store.activePanel) return

  const container = scrollContainerRef.value
  if (!container) return

  switch (e.key) {
    case ' ':
    case 'Space':
      e.preventDefault()
      pageForward()
      break
    case 'ArrowDown':
    case 'PageDown':
      e.preventDefault()
      if (isHorizontalPageMode.value) {
        pageForward()
      } else {
        container.scrollTo({ top: snapPageTarget(container, container.scrollTop + pageScrollStep(container), 1), behavior: 'instant' })
      }
      break
    case 'ArrowUp':
    case 'PageUp':
      e.preventDefault()
      if (isHorizontalPageMode.value) {
        pageBackward()
      } else {
        container.scrollTo({ top: Math.max(0, snapPageTarget(container, container.scrollTop - pageScrollStep(container), -1)), behavior: 'instant' })
      }
      break
    case 'ArrowRight':
      e.preventDefault()
      nextChapter()
      break
    case 'ArrowLeft':
      e.preventDefault()
      prevChapter()
      break
    case 'Home':
      e.preventDefault()
      scrollToTop()
      break
    case 'End':
      e.preventDefault()
      scrollToBottom()
      break
  }
}

// Toolbar actions
async function toggleBookmark() {
  store.togglePanel('bookmark')
}

function handleTTS() {
  ttsPanelDismissed.value = false
  showTTSPanel.value = true
}

function closeTTSPanel() {
  showTTSPanel.value = false
  ttsPanelDismissed.value = true
}

function toggleSpeechFromPanel() {
  ttsPanelDismissed.value = false
  showTTSPanel.value = true
  if (!store.isSpeaking) {
    startSpeech()
    return
  }
  cancelSpeechTransition()
  store.pauseTTS()
}

function handleStopTTS() {
  cancelSpeechTransition()
  store.stopTTS()
}

watch(() => store.isAutoScrolling, (val) => {
  store.autoReading = val
  if (val) startAutoScroll()
  else stopAutoScroll()
})

watch(showTTSPanel, (visible) => {
  if (!visible) return
})

function changeVoice(name: string) {
  store.setVoiceName(name)
  ttsPanelDismissed.value = false
  showTTSPanel.value = true
  if (store.isSpeaking && !store.isPaused) {
    restartSpeechFromCurrentParagraph()
  }
}

function changeOpenAIVoice(voiceId: string) {
  if (store.speechConfig.openaiSource === 'server') return
  store.setOpenAISpeechVoice(voiceId)
  ttsPanelDismissed.value = false
  showTTSPanel.value = true
  if (store.isSpeaking && !store.isPaused) {
    restartSpeechFromCurrentParagraph()
  }
}

function adjustSpeechRate(delta: number) {
  const next = Math.max(0.5, Math.min(3, parseFloat((store.speechConfig.speechRate + delta).toFixed(1))))
  store.setSpeechRate(next)
  ttsPanelDismissed.value = false
  showTTSPanel.value = true
  if (store.isSpeaking && !store.isPaused) {
    restartSpeechFromCurrentParagraph()
  }
}

function adjustSpeechPitch(delta: number) {
  const next = Math.max(0.5, Math.min(2, parseFloat((store.speechConfig.speechPitch + delta).toFixed(1))))
  store.setSpeechPitch(next)
  ttsPanelDismissed.value = false
  showTTSPanel.value = true
  if (store.isSpeaking && !store.isPaused) {
    restartSpeechFromCurrentParagraph()
  }
}

function setSpeechTimer(minutes: number) {
  store.setSpeechStopTimer(minutes)
  ttsPanelDismissed.value = false
  showTTSPanel.value = true
}
async function openInfo() {
  if (!store.book) return
  showBookInfo.value = true
  bookInfoBook.value = {
    ...store.book,
    durChapterIndex: store.currentIndex,
    durChapterTitle: store.currentChapter?.title || store.book.durChapterTitle,
  }
  try {
    const latest = await getBookInfo(store.book.bookUrl, store.book.origin)
    bookInfoBook.value = {
      ...store.book,
      ...latest,
      durChapterIndex: store.currentIndex,
      durChapterTitle: store.currentChapter?.title || latest.durChapterTitle || store.book.durChapterTitle,
    }
  } catch {
    appStore.showToast('获取书籍详情失败，已显示当前缓存信息', 'warning')
  }
}

function openAiBook() {
  if (!store.book) return
  router.push({
    name: 'ai-book',
    query: { bookUrl: store.book.bookUrl },
  })
}

onBeforeRouteLeave(() => {
  persistReadingProgressKeepalive()
  return true
})

onMounted(async () => {
  syncViewportSize()
  appStore.startReadingSession()
  if (!store.book) {
    const restored = await store.restorePersistedSession()
    if (!restored) {
      router.replace('/')
      return
    }
    appStore.showToast('已恢复最近阅读的离线章节', 'success')
  }
  loadSavedReadingPosition()
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('mouseup', handleMouseUpSelection)
  document.addEventListener('touchend', handleTouchEndSelection)
    document.addEventListener('selectionchange', handleSelectionChange)
    checkMedia()
    window.addEventListener('resize', checkMedia)
    window.addEventListener(APP_VIEWPORT_CHANGE_EVENT, handleViewportChange)
    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    store.fetchVoices()
  applySystemTheme(
    isVideoChapter.value ? 'dark' : (store.isNight ? 'dark' : appStore.theme),
    isVideoChapter.value ? '#000000' : store.currentTheme.body,
  )
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => store.fetchVoices()
  }
  speechTimerTicker = window.setInterval(() => {
    speechTimerNow.value = Date.now()
  }, 15000)
  await Promise.all([
    store.fetchBookmarks(),
    store.fetchReplaceRules(),
  ])
  scheduleRefreshOfflineCacheState()
  updateHorizontalMetrics()
  await rebuildHorizontalPages()
  if (isContinuousMode.value) {
    await initializeContinuousChapters(store.currentIndex, false)
  }
  scheduleRestoreReadingPosition()
  schedulePageFooterUpdate()
})

onUnmounted(() => {
    persistReadingProgressKeepalive()
    appStore.stopReadingSession(store.book ? {
      bookUrl: store.book.bookUrl,
      bookName: store.book.name,
      author: store.book.author,
      coverUrl: store.book.coverUrl,
      origin: store.book.origin,
    } : undefined)
    window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('mouseup', handleMouseUpSelection)
  document.removeEventListener('touchend', handleTouchEndSelection)
    document.removeEventListener('selectionchange', handleSelectionChange)
    window.removeEventListener('resize', checkMedia)
    window.removeEventListener(APP_VIEWPORT_CHANGE_EVENT, handleViewportChange)
    window.removeEventListener('pagehide', handlePageHide)
    window.removeEventListener('beforeunload', handleBeforeUnload)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (speechTimerTicker) clearInterval(speechTimerTicker)
  if (restorePositionTimer) clearTimeout(restorePositionTimer)
  if (persistPositionTimer) clearTimeout(persistPositionTimer)
  if (scrollSnapTimer) clearTimeout(scrollSnapTimer)
  if (refreshOfflineCacheStateTimer) clearTimeout(refreshOfflineCacheStateTimer)
  clearRestoreStabilizers()
  disposeSelection()
  disposeContinuousReading()
  disposeAutoPlayback()
  store.stopTTS()
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = null
  }
  applySystemTheme(appStore.theme)
  store.closePanel()
})

watch(() => config.value.autoPageMode, () => {
  if (!store.isAutoScrolling) return
  stopAutoScroll()
  store.isAutoScrolling = true
  startAutoScroll()
})

watch(() => config.value.readMethod, async () => {
  clearSelectionState()
  if (isContinuousMode.value) {
    await initializeContinuousChapters(store.currentIndex, false)
  } else {
    clearContinuousChapters()
    await nextTick()
    if (scrollContainerRef.value) {
      scrollContainerRef.value.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    }
  }
  if (isHorizontalPageMode.value && scrollContainerRef.value) {
    resetHorizontalPagePosition()
  }
  await rebuildHorizontalPages()
  updateHorizontalEndState()
  scheduleRestoreReadingPosition()
})

watch(() => store.currentIndex, () => {
  if (!isHorizontalPageMode.value) return
  resetHorizontalPagePosition()
  rebuildHorizontalPages()
  updateHorizontalEndState()
})

watch(
  [() => store.content, () => config.value.fontSize, () => config.value.fontWeight, () => config.value.lineHeight, () => config.value.paragraphSpacing, () => config.value.firstLineIndent, showSearch, searchQuery],
  () => {
    if (isHorizontalPageMode.value) {
      horizontalPageIndex.value = 0
      rebuildHorizontalPages()
    }
    schedulePageFooterUpdate()
  },
)

// 切章 / 内容渲染 / 连续章节变化后重算页尾（延后到 DOM 更新完成）
watch(
  [() => store.currentIndex, () => store.content, () => store.loading, () => continuousChapters.value.length, () => config.value.pageWidth],
  () => schedulePageFooterUpdate(),
  { flush: 'post' },
)

watch(() => store.currentIndex, async () => {
  loadSavedReadingPosition()
  resetAutoParagraphIndex()
  if (!store.isSpeaking) {
    clearReadingClass()
  }
  if (hideReadChaptersMode.value) {
    pruneReadChapters(store.currentIndex)
  }
  if (!isContinuousMode.value && config.value.enablePreload) {
    store.preloadAroundChapter(store.currentIndex)
  }
  if (isContinuousMode.value && !suppressContinuousSync.value) {
    await syncContinuousToStoreState()
  }
  scheduleRefreshOfflineCacheState()
  scheduleRestoreReadingPosition()
})

watch(
  [() => store.chapters.length, () => store.chaptersLoading, () => store.loading, isContinuousMode],
  async ([chapterCount, chaptersLoading, loadingNow, continuousMode]) => {
    if (!continuousMode || !chapterCount || chaptersLoading || loadingNow || continuousChapters.value.length) return
    await initializeContinuousChapters(store.currentIndex, false)
    scheduleRestoreReadingPosition()
  },
  { immediate: true },
)

watch(() => store.content, () => {
  resetAutoParagraphIndex()
  if (isContinuousMode.value) {
    const current = getContinuousChapter(store.currentIndex)
    if (current) {
      current.content = store.content
      current.html = renderChapterHtml(store.content)
    } else if (store.content) {
      void initializeContinuousChapters(store.currentIndex, false)
    }
  }
  handleContentChanged()
  handleContentUpdated()
  scheduleRefreshOfflineCacheState()
  scheduleRestoreReadingPosition()
})

watch(() => store.loading, (loading) => {
  if (!loading && pendingRestorePosition.value) {
    scheduleRestoreReadingPosition()
  }
})

watch(() => store.book?.bookUrl, () => {
  // 切换书籍/书源时清空连续阅读的本地章节缓存，避免新书加载失败时
  // 继续渲染上一本书的正文（面板「当前」标记已切到新书，但正文残留旧书）。
  clearContinuousChapters()
  loadSavedReadingPosition()
  scheduleRefreshOfflineCacheState()
})

watch([showSearch, searchQuery, () => config.value.paragraphSpacing, () => config.value.firstLineIndent, () => config.value.chineseMode, () => store.replaceRules], () => {
  if (isContinuousMode.value) {
    syncContinuousChapterHtml()
  }
  handlePresentationUpdated()
})

watch(() => config.value.selectAction, (value) => {
  if (value !== 'popup') {
    clearSelectionState()
  }
})

watch(() => store.isSpeaking, (speaking) => {
  if (speaking && !ttsPanelDismissed.value) {
    showTTSPanel.value = true
  }
  if (!speaking && !store.isAutoScrolling) {
    clearReadingClass()
  }
})

watch(
  [() => store.isNight, () => store.currentTheme.body, () => appStore.theme, isVideoChapter],
  ([isNight, body, appTheme, videoChapter]) => {
    // 视频页强制 dark + 纯黑铺底，使 iOS 状态栏 / 底部安全区一并变黑，消除上下白边。
    applySystemTheme(videoChapter ? 'dark' : (isNight ? 'dark' : appTheme), videoChapter ? '#000000' : body)
  },
  { immediate: true },
)
</script>

<style scoped>
.reader-view {
  /* 严格对齐 1.0.80：该版本用户实测底部无白边。
     之前的 min-height 兜底会让元素高于可视视口，iOS 全屏下底部多出的部分
     在滚动时会露出外层 body 背景色（表现为白边），故移除，恢复 1.0.80 几何。 */
  height: 100vh;
  height: 100dvh;
  height: var(--app-visual-height, var(--app-height, 100dvh));
  width: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  transition: background 0.3s, color 0.3s;
  padding-top: var(--safe-area-top);
  box-sizing: border-box;
}

/* 视频页纯黑沉浸：连顶部 safe-area padding 区和底部安全区一并压黑，
   避免 iOS 状态栏 / home indicator 处透出阅读器米色主题（图1/图2白边）。
   用 !important 覆盖界面定制可能注入的背景强染。 */
.reader-view.is-video-immersive {
  background: #000 !important;
}

.reader-view.disable-system-callout .chapter-text,
.reader-view.disable-system-callout .horizontal-page-content,
.reader-view.disable-system-callout .continuous-reading {
  -webkit-touch-callout: none;
}

.reader-scroll-container {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  overflow-y: auto;
  position: relative;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.reader-scroll-container.horizontal-page-mode {
  overflow-x: hidden;
  overflow-y: hidden;
  touch-action: pan-y pinch-zoom;
  overscroll-behavior: none;
}

/* Hide scrollbar */
.reader-scroll-container::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.reader-scroll-container::-webkit-scrollbar-thumb {
  background: rgba(0,0,0,0.1);
  border-radius: 4px;
}
.reader-view[style*="background: #1a1a2e"] .reader-scroll-container::-webkit-scrollbar-thumb {
  background: rgba(255,255,255,0.1);
}

.content-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.offline-banner {
  position: sticky;
  top: 0;
  z-index: 6;
  margin: 0 auto;
  width: min(100%, 880px);
  padding: 10px 16px;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
  border-bottom: 1px solid color-mix(in srgb, var(--color-primary) 18%, transparent);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  backdrop-filter: blur(6px);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(0,0,0,0.1);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
.reader-view[style*="background: #1a1a2e"] .loading-spinner {
  border-color: rgba(255,255,255,0.1);
  border-top-color: var(--color-primary);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.chapter-content {
  margin: 0 auto;
  /* 章末底部收紧：最后一行紧贴下方独立页脚行，不留空白行 */
  padding: 80px 24px 2px;
  min-height: 100%;
  transition: all 0.3s ease;
}

.chapter-content.horizontal-page-article {
  margin: 0;
  height: 100%;
  min-height: 100%;
  width: max-content;
  min-width: 100%;
  padding: 0;
}

.horizontal-page-layout {
  width: max-content;
  min-width: var(--reader-page-step);
  height: 100%;
}

.horizontal-content-page {
  width: max-content;
  min-width: var(--reader-page-step);
  height: 100%;
  min-height: 100%;
  padding: 0;
  box-sizing: border-box;
}

.horizontal-pages {
  display: flex;
  width: max-content;
  height: 100%;
  min-height: 100%;
  transform: translate3d(0, 0, 0);
  transition-property: transform;
  transition-timing-function: cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: transform;
}

.horizontal-page {
  width: var(--reader-page-step);
  min-width: var(--reader-page-step);
  height: 100%;
  min-height: 100%;
  padding: 24px var(--reader-side-padding);
  box-sizing: border-box;
}

.continuous-reading {
  margin: 0 auto;
  /* 章末底部收紧：最后一行紧贴下方独立页脚行，不留空白行 */
  padding: 32px 0 2px;
}

.continuous-chapter {
  min-height: auto;
  padding-top: 48px;
  padding-bottom: 24px;
}

/* 连续模式最后一章：去掉章末下间距，避免正文末行与页脚之间出现整行空白 */
.continuous-chapter:last-of-type {
  padding-bottom: 0;
}

.chapter-title {
  font-size: 1.35em;
  font-weight: 700;
  margin-bottom: 2em;
  text-align: center;
  line-height: 1.4;
}

.chapter-text {
  word-break: normal;
  overflow-wrap: anywhere;
  text-align: justify;
  user-select: text;
  -webkit-user-select: text;
  -webkit-touch-callout: default;
}

.horizontal-page-content {
  height: 100%;
  overflow: hidden;
  overflow-wrap: break-word;
  text-align: left;
  word-break: normal;
}

:deep(.horizontal-page-content .horizontal-flow-title) {
  margin: 0 0 1em 0;
  font-size: 1.5em;
  line-height: 1.35;
  font-weight: 700;
  text-align: center;
  break-inside: avoid;
}

:deep(.horizontal-page-content p:first-child) {
  margin-top: 0 !important;
}

:deep(.horizontal-page-content p:last-child) {
  margin-bottom: 0 !important;
}

:deep(.chapter-text p.reading) {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

:deep(.chapter-text p.reader-indent) {
  text-indent: 2em !important;
}

:deep(.chapter-text p) {
  text-indent: 0;
  user-select: text;
  -webkit-user-select: text;
}

:deep(.chapter-text img),
:deep(.horizontal-page-content img) {
  max-width: 100% !important;
  height: auto !important;
  display: block;
  margin: 12px auto;
  object-fit: contain;
}

.chapter-media {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  margin: 24px 0 40px;
}

/* 视频页：取消小说排版的大内边距与最大宽度限制，消除外层大白框，全屏沉浸居中。
   背景强制为夜间纯黑：视频播放区不应透出小说的米色/浅色主题，
   否则会在播放器上下/右侧露出米色边（用户反馈的浅色边、浅底）。 */
.chapter-content.media-video-article {
  padding: 0 !important;
  margin: 0 !important;
  width: 100% !important;
  max-width: 100% !important;
  height: 100% !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  background: #000 !important;
}

/* 视频页：播放器居中展示，自适应视频尺寸 */
.media-video-stage {
  min-height: auto;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 0;
  padding: 0;
}

/* 有声书舞台与字幕卡片 */
.media-audio-stage {
  min-height: calc(60vh - 120px);
  justify-content: center;
  margin: 20px 0 0;
  padding-bottom: 120px;
  gap: 24px;
}

.audio-stage-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
}

.audio-stage-cover {
  width: 130px;
  height: 180px;
  object-fit: cover;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
}

.audio-stage-cover-placeholder {
  width: 130px;
  height: 180px;
  border-radius: 12px;
  background: rgba(128, 128, 128, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary, #888);
}

.audio-stage-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.audio-stage-book-name {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text, #111);
}

.audio-stage-author {
  font-size: 13px;
  color: var(--color-text-secondary, #777);
}

.audio-stage-chapter-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-primary, #f43f5e);
  margin-top: 2px;
}

.audio-lrc-container {
  max-width: 500px;
  width: 90%;
  max-height: 140px;
  overflow-y: auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 14px;
  background: rgba(128, 128, 128, 0.05);
}

.audio-lrc-line {
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text-secondary, #888);
  transition: all 0.25s ease;
}

.audio-lrc-line.active {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-primary, #f43f5e);
  transform: scale(1.04);
}

/* ── 有声书播放器：停靠在底部 Dock 位置（悬浮液态玻璃条） ── */
.media-dock {
  position: fixed;
  left: 50%;
  bottom: calc(22px + var(--safe-area-bottom));
  transform: translateX(-50%);
  z-index: calc(var(--z-sticky) + 2);
  width: min(720px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px 12px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow:
    0 16px 36px rgba(0, 0, 0, 0.10),
    0 4px 10px rgba(0, 0, 0, 0.04),
    inset 0 1.5px 2px rgba(255, 255, 255, 0.95),
    inset 0 -1px 1px rgba(0, 0, 0, 0.04);
  backdrop-filter: blur(28px) saturate(200%);
  -webkit-backdrop-filter: blur(28px) saturate(200%);
}

.media-dock-dark {
  background: rgba(28, 29, 34, 0.66);
  border-color: rgba(255, 255, 255, 0.14);
  box-shadow:
    0 18px 44px rgba(0, 0, 0, 0.45),
    0 4px 12px rgba(0, 0, 0, 0.3),
    inset 0 1.5px 1.5px rgba(255, 255, 255, 0.18),
    inset 0 -1px 1px rgba(0, 0, 0, 0.45);
}

.media-dock-title {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.35;
  opacity: 0.62;
  margin-bottom: 2px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.media-dock .custom-audio-player {
  gap: 6px;
}

/* 视频页控制条与有声书共用一个 Dock 样式，无需额外导航按钮样式 */

/* ── 自定义有声书播放器 ── */
.custom-audio-player {
  width: 100%;
  max-width: 860px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.audio-progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.audio-time {
  min-width: 44px;
  font-size: 12px;
  opacity: 0.6;
  text-align: center;
}

.audio-track {
  flex: 1;
  height: 24px;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.audio-track-bg {
  width: 100%;
  height: 4px;
  background: rgba(128, 128, 128, 0.25);
  border-radius: 2px;
  position: relative;
}

.audio-fill {
  height: 100%;
  background: var(--color-primary, #f43f5e);
  border-radius: 2px;
}

.audio-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-primary, #f43f5e);
  opacity: 0;
  transition: opacity 0.15s;
}

.audio-track:hover .audio-thumb { opacity: 1; }

.audio-ctrl-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
}

.audio-btn {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  opacity: 0.7;
  padding: 6px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s;
}
.audio-btn:hover { opacity: 1; }
.audio-btn:disabled { opacity: 0.25; cursor: default; }

.audio-btn-play {
  background: var(--color-primary, #f43f5e);
  border: none;
  color: #fff;
  cursor: pointer;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--color-primary) 35%, transparent);
  transition: transform 0.12s;
}
.audio-btn-play:hover { transform: scale(1.07); }

.audio-rate {
  min-width: 40px;
  font-size: 13px;
  font-weight: 600;
}

/* ── 短剧视频放大 ── */
.media-video.media-video-lg {
  width: auto;
  height: auto;
  max-width: 92vw;
  max-height: 82vh;
  object-fit: contain;
  border: none !important;
  outline: none !important;
  background: transparent !important;
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
}

.media-player {
  width: 100%;
  max-width: 960px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.04);
}

.media-video {
  max-height: 70vh;
}

.media-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
}

.media-raw {
  width: 100%;
  max-width: 960px;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
  opacity: 0.6;
  text-align: left;
}

.chapter-footer {
  margin-top: 60px;
  text-align: center;
  padding-bottom: 40px;
}

/* 页尾：正文滚动区下方的独立底部行，左章节名 / 右「当前屏·本章总屏」。
   作为 flex item 占据真实高度（不悬浮、不覆盖正文），正文滚动区高度相应缩短，
   从根本上避免页码与正文最后一行重叠。颜色/字形继承正文。
   字号与底部控制面板标签文字保持一致（.m-grid-item span：11.5px / 窄屏 10.5px），
   使用固定值而非 em，避免随正文字号缩放而失衡。 */
.reader-page-footer {
  flex: 0 0 auto;
  margin: 0 auto;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  box-sizing: border-box;
  padding: 2px 24px calc(2px + var(--safe-area-bottom));
  max-width: 100%;
  font-size: 11.5px;
  line-height: 1.4;
  color: inherit;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.reader-page-footer-title {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reader-page-footer-page {
  flex: 0 0 auto;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.horizontal-next-floating {
  position: absolute;
  left: 50%;
  bottom: calc(20px + var(--safe-area-bottom));
  transform: translateX(-50%);
  z-index: 12;
  pointer-events: none;
}

.horizontal-next-floating .next-btn {
  pointer-events: auto;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(6px);
}

.continuous-loading-inline {
  text-align: center;
  padding: 18px 24px;
  opacity: 0.6;
  font-size: 13px;
}

.next-btn {
  padding: 12px 36px;
  border-radius: 30px;
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  font-size: 14px;
  opacity: 0.6;
  cursor: pointer;
  transition: all 0.2s;
}

.next-btn:hover:not(:disabled) {
  opacity: 1;
  background: rgba(0,0,0,0.05);
}

.next-btn:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}



/* Slide Drawer Overlay */
.reader-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 40;
}

.reader-drawer {
  position: fixed;
  top: var(--safe-area-top);
  bottom: var(--safe-area-bottom);
  left: 0;
  width: min(340px, 85vw);
  z-index: 50;
  box-shadow: 4px 0 24px rgba(0,0,0,0.15);
  transition: background 0.3s;
}

.selection-menu {
  position: fixed;
  z-index: 60;
  min-width: 220px;
  max-width: min(320px, calc(100vw - 32px));
  border-radius: 14px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

.selection-menu-text {
  padding: 12px 14px 8px;
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.72;
  word-break: break-all;
}

.selection-menu-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 0 12px 12px;
}

.selection-menu-actions button {
  border: none;
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--color-primary);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}

.selection-menu-actions button:first-child {
  grid-column: 1 / -1;
}

:deep(.search-highlight) {
  background: yellow;
  color: black;
  border-radius: 2px;
}

:deep(.search-highlight.current-match) {
  background: orange;
}

@media (max-width: 768px) {
  .reader-scroll-container.horizontal-page-mode {
    scroll-behavior: auto;
  }

  .chapter-content {
    /* 底部收紧到 2px：最后一行紧贴独立页脚行，不留空白行。
       注意不叠加 safe-area-bottom，否则滚动到底会露出 body 背景色（白边）。 */
    padding: 24px 20px 2px;
    min-height: auto;
    height: auto;
  }

  .continuous-reading {
    padding: 16px 0 2px;
  }

  .continuous-chapter {
    padding-top: 20px;
    padding-bottom: 8px;
  }

  .chapter-title {
    margin-bottom: 0.9em;
  }

  .chapter-footer {
    margin-top: 12px;
    padding-bottom: 0;
  }

  .reader-drawer {
    top: var(--safe-area-top);
    bottom: var(--safe-area-bottom);
    width: min(340px, 85vw);
    padding-top: var(--safe-area-top);
    padding-bottom: var(--safe-area-bottom);
    box-sizing: border-box;
  }
}

/* Transitions */
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.slide-left-enter-active, .slide-left-leave-active { transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1); }
.slide-left-enter-from, .slide-left-leave-to { transform: translateX(-100%); }

.fade-slide-right-enter-active, .fade-slide-right-leave-active { transition: all 0.3s ease; }
.fade-slide-right-enter-from, .fade-slide-right-leave-to { transform: translateX(-20px); opacity: 0; }

.fade-slide-left-enter-active, .fade-slide-left-leave-active { transition: all 0.3s ease; }
.fade-slide-left-enter-from, .fade-slide-left-leave-to { transform: translateX(20px); opacity: 0; }

/* 页尾页码行窄屏字号：与底部控制面板标签 .m-grid-item span 的 380px 断点保持一致 */
@media (max-width: 380px) {
  .reader-page-footer {
    font-size: 10.5px;
  }
}
</style>
