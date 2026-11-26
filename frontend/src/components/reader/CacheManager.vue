<template>
  <div class="cache-manager" :style="{ background: theme.popup, color: theme.fontColor }">
    <div class="cache-header">
      <div>
        <h3>缓存章节</h3>
        <p v-if="store.book" class="cache-subtitle">{{ store.book.name }}</p>
      </div>
      <button class="close-btn" @click="store.backPanel()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
    </div>

    <div class="cache-body">
      <div v-if="!isLocalBookInServer" class="summary-grid">
        <div class="summary-card">
          <span class="summary-label">服务端缓存</span>
          <strong>{{ serverCachedCount }}</strong>
          <small>已缓存章节</small>
        </div>
        <div class="summary-card">
          <span class="summary-label">浏览器缓存</span>
          <strong>{{ browserCachedCount }}</strong>
          <small>离线可读章节</small>
        </div>
      </div>

      <div v-if="working" class="caching-status">
        <div class="progress-circle">
          <svg viewBox="0 0 36 36">
            <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            <path class="circle" :stroke-dasharray="`${progress}, 100`" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
          </svg>
          <div class="percentage">{{ progress }}%</div>
        </div>
        <div class="status-text">
          <p class="main-status">{{ currentStatus }}</p>
          <p class="sub-status">{{ currentChapterName || '正在准备...' }}</p>
        </div>
        <button class="stop-btn" @click="stopWorking">停止</button>
      </div>

      <div v-else class="cache-sections">
        <div v-if="isLocalBookInServer" class="info-stack">
          <section class="cache-section">
            <div class="section-head">
              <h4>导出到本地</h4>
            </div>
            <div class="option-list">
              <button class="cache-opt primary" @click="exportWholeBook">
                <span class="label">全本下载到本地</span>
              </button>
            </div>
          </section>
          <div class="info-card">
            <p>本地书已存放在服务端书架文件中，不需要额外缓存；阅读时会直接读取上传后的本地文件。</p>
          </div>
          <div class="info-card">
            <p>本地书的封面、作者和简介会自动静默匹配现有书源，无需额外处理；若未匹配，请检查当前书源是否可以搜到本书。</p>
          </div>
          <div class="info-card">
            <p class="info-card-title">快速匹配建议</p>
            <p>文件名推荐用规范格式 <b>《书名》 作者：某某.txt</b>（如 <b>《皇明》 作者：某某.txt</b>），书名和作者优先从文件名识别。</p>
            <p>若文件名不规范（如 <b>皇明.txt</b>），可在正文开头、第一章之前按三行写，同样能识别：</p>
            <pre class="naming-sample">书名：皇明
作者：某某
简介：…</pre>
            <p>其中简介可省略；封面、作者、简介导入后会自动静默匹配书源补全。</p>
          </div>
        </div>

        <template v-else>
          <div class="info-card">
            <p>服务端缓存保存在后端存储目录；浏览器缓存保存在当前设备的 IndexedDB。断网时阅读页会优先读取浏览器已缓存章节。</p>
          </div>

          <section class="cache-section">
            <div class="section-head">
              <h4>缓存到服务端</h4>
              <button class="link-btn" @click="refreshStats">刷新</button>
            </div>
            <div class="option-list">
              <button class="cache-opt" @click="startServerCaching(50)">
                <span class="label">缓存后续 50 章</span>
                <span class="sub">适合当前追更</span>
              </button>
              <button class="cache-opt" @click="startServerCaching(100)">
                <span class="label">缓存后续 100 章</span>
                <span class="sub">中度离线阅读</span>
              </button>
              <button class="cache-opt primary" @click="startServerCaching(0)">
                <span class="label">全本缓存到服务端</span>
                <span class="sub">保存到服务器磁盘</span>
              </button>
              <button class="cache-opt danger" @click="clearServerCache">
                <span class="label">清除服务端缓存</span>
                <span class="sub">删除当前书所有服务端缓存</span>
              </button>
            </div>
          </section>

          <section class="cache-section">
            <div class="section-head">
              <h4>缓存到浏览器</h4>
              <button class="link-btn" @click="refreshStats">刷新</button>
            </div>
            <div class="option-list">
              <button class="cache-opt" @click="startBrowserCaching(50)">
                <span class="label">缓存后续 50 章</span>
                <span class="sub">只保留在当前浏览器</span>
              </button>
              <button class="cache-opt" @click="startBrowserCaching(100)">
                <span class="label">缓存后续 100 章</span>
                <span class="sub">适合本地离线使用</span>
              </button>
              <button class="cache-opt primary" @click="startBrowserCaching(0)">
                <span class="label">全本缓存到浏览器</span>
                <span class="sub">持久化到 IndexedDB</span>
              </button>
              <button class="cache-opt danger" @click="clearBrowserCache">
                <span class="label">清除浏览器缓存</span>
                <span class="sub">删除当前设备离线缓存</span>
              </button>
            </div>
          </section>

          <section class="cache-section">
            <div class="section-head">
              <h4>导出到本地</h4>
            </div>
            <div class="option-list">
              <!-- 漫画导出 EPUB（图片打包进文件、可重新导入阅读），文字书导出 TXT，文案统一 -->
              <button class="cache-opt primary" @click="isComic ? exportComicEpub(0) : exportWholeBook()">
                <span class="label">全本下载到本地</span>
              </button>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useReaderStore } from '../../stores/reader'
import { isLocalBook } from '../../utils/localBook'
import { useCacheTask, isComicBookByContent } from '../../composables/useCacheTask'

const store = useReaderStore()
const theme = computed(() => store.currentTheme)
const isLocalBookInServer = computed(() => isLocalBook(store.book))
// 依据当前章节正文预判是否漫画书（含多图、少文字），决定是否显示 EPUB 导出入口
const isComic = computed(() => isComicBookByContent(store.displayContent) && !isLocalBookInServer.value)

// 缓存任务状态提升到全局单例：关闭面板仅卸载本组件，后台缓存继续运行；
// 重新打开面板时读到的仍是同一份进度，可继续查看并点「停止」中断。
const {
  working,
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
} = useCacheTask()

// 不再在 onUnmounted 停止缓存——这是「收回面板但缓存继续」的关键。
// 只在打开面板时刷新一次统计数字。
onMounted(() => {
  refreshStats()
})
</script>

<style scoped>
.cache-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.cache-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}

.cache-header h3 { margin: 0; font-size: 16px; }
.cache-subtitle { margin: 4px 0 0; font-size: 12px; opacity: 0.55; }

.close-btn {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; color: inherit; opacity: 0.6;
  background: transparent; border: none; cursor: pointer;
}

.cache-body {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.summary-card {
  border-radius: 16px;
  padding: 16px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.summary-label { font-size: 12px; opacity: 0.65; }
.summary-card strong { font-size: 28px; line-height: 1; }
.summary-card small { font-size: 12px; opacity: 0.5; }

.cache-sections {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.cache-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-head h4 {
  margin: 0;
  font-size: 15px;
}

.link-btn {
  background: transparent;
  border: none;
  color: var(--color-primary, #f43f5e);
  cursor: pointer;
}

.info-card {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  padding: 16px;
  border-radius: 12px;
  border-left: 4px solid var(--color-primary, #f43f5e);
}

.info-stack { display: flex; flex-direction: column; gap: 12px; }

.info-card p { margin: 0; font-size: 13px; line-height: 1.6; opacity: 0.8; }
.info-card p + p { margin-top: 8px; }
.info-card .info-card-title { font-weight: 600; font-size: 14px; opacity: 1; }
.info-card b { opacity: 1; font-weight: 600; }

.naming-sample {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.9;
}

.option-list { display: flex; flex-direction: column; gap: 12px; }

.cache-opt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 16px 20px;
  border-radius: 16px;
  border: 1px solid rgba(0,0,0,0.1);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s;
}

.cache-opt:hover {
  border-color: var(--color-primary, #f43f5e);
  background: color-mix(in srgb, var(--color-primary) 4%, transparent);
}

.cache-opt.primary {
  background: var(--color-primary, #f43f5e);
  border-color: var(--color-primary, #f43f5e);
  color: white;
}

.cache-opt.danger {
  border-color: rgba(239, 68, 68, 0.2);
  color: #dc2626;
}

.cache-opt .label { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
.cache-opt .sub { font-size: 11px; opacity: 0.6; }


.caching-status {
  min-height: 360px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-bottom: 40px;
}

.progress-circle {
  position: relative;
  width: 150px;
  height: 150px;
  margin-bottom: 24px;
}

.progress-circle svg { transform: rotate(-90deg); width: 100%; height: 100%; }
.circle-bg { fill: none; stroke: rgba(0,0,0,0.05); stroke-width: 2.8; }
.circle { fill: none; stroke: var(--color-primary, #f43f5e); stroke-width: 2.8; stroke-linecap: round; transition: stroke-dasharray 0.3s; }

.percentage {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  font-size: 24px; font-weight: 700;
}

.status-text { text-align: center; margin-bottom: 32px; }
.main-status { font-weight: 600; font-size: 16px; margin: 0 0 8px 0; }
.sub-status { font-size: 13px; opacity: 0.5; margin: 0; }

.stop-btn {
  padding: 8px 24px;
  border-radius: 20px;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.2);
  cursor: pointer;
  font-size: 14px;
}
</style>
