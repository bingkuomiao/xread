import { computed, nextTick, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { useReaderStore } from '../stores/reader'

type ReaderStore = ReturnType<typeof useReaderStore>
const HORIZONTAL_PAGE_SIDE_PADDING = 24
const HORIZONTAL_PAGE_VERTICAL_PADDING = 24
const HORIZONTAL_PAGE_MIN_BOTTOM_GUARD = 18
const HORIZONTAL_PAGE_BOTTOM_GUARD_LINES = 0.5
const NON_STARTING_PUNCTUATION = new Set([
  '，',
  '。',
  '、',
  '：',
  '；',
  '！',
  '？',
  ',',
  '.',
  ':',
  ';',
  '!',
  '?',
  '”',
  '’',
  '）',
  '】',
  '》',
  '」',
  '』',
])
const SPLIT_BACKTRACK_BREAKERS = new Set(['，', '。', '；', '！', '？', ',', '.', ';', '!', '?', ' '])
const PUNCTUATION_ONLY_CHARS = new Set([...NON_STARTING_PUNCTUATION, '“', '‘', '（', '【', '《', '「', '『', '…', '—'])
const MAX_PUNCTUATION_BACKTRACK = 12

/**
 * 在最大高度约束下，用二分找到文本前多少个字符能放下。
 * `fits(count)` 由调用方注入（对应一次 DOM 布局测量），这里只保留纯二分逻辑，
 * 便于单测；调用方 Ny 需保证 fits 在 [1, totalChars] 上单调（放不下之后只会更放不下）。
 * 返回 0 表示一个字符都放不下。
 */
export function findFittingCharCount(totalChars: number, fits: (count: number) => boolean): number {
  if (totalChars <= 0) return 0
  let left = 1
  let right = totalChars
  let best = 0
  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    if (fits(mid)) {
      best = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }
  return best
}

export function useHorizontalPaging(
  store: ReaderStore,
  config: ComputedRef<{ fontSize: number; fontWeight: number; lineHeight: number }>,
  currentFontFamily: ComputedRef<string>,
  formattedContent: ComputedRef<string>,
  isHorizontalPageMode: ComputedRef<boolean>,
  scrollContainerRef: Ref<HTMLElement | undefined>,
) {
  const horizontalPageIndex = ref(0)
  const horizontalPageStep = ref(1)
  const horizontalPageStepStyle = computed(() => `${Math.max(1, horizontalPageStep.value)}px`)
  const horizontalPages = ref<string[]>([])
  const isHorizontalAtEnd = ref(false)

  function escapeHtml(input: string) {
    return input
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  }

  function parseInlineStyle(styleText: string) {
    const entries = styleText
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const idx = item.indexOf(':')
        if (idx <= 0) return null
        const key = item.slice(0, idx).trim().toLowerCase()
        const value = item.slice(idx + 1).trim()
        if (!key || !value) return null
        return [key, value] as const
      })
      .filter(Boolean) as Array<readonly [string, string]>
    return Object.fromEntries(entries) as Record<string, string>
  }

  function buildInlineStyle(styleObj: Record<string, string>) {
    return Object.entries(styleObj)
      .map(([key, value]) => `${key}: ${value}`)
      .join('; ')
  }

  function removeIndentClass(className: string) {
    return className
      .split(/\s+/)
      .filter(Boolean)
      .filter((name) => name !== 'reader-indent')
      .join(' ')
  }

  function normalizeParagraphHtml(paragraphHtml: string) {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = paragraphHtml
    const paragraph = wrapper.querySelector('p')
    if (!paragraph) return paragraphHtml
    const style = paragraph.getAttribute('style') || ''
    const styleObj = parseInlineStyle(style)
    if (paragraph.classList.contains('reader-indent') && !styleObj['text-indent']) {
      styleObj['text-indent'] = '2em'
    }
    const styleText = buildInlineStyle(styleObj)
    if (styleText) paragraph.setAttribute('style', styleText)
    return paragraph.outerHTML
  }

  function parseParagraphHtml(paragraphHtml: string) {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = paragraphHtml
    const paragraph = wrapper.querySelector('p')
    if (!paragraph) return null
    return {
      style: paragraph.getAttribute('style') || '',
      className: paragraph.getAttribute('class') || '',
      text: (paragraph.textContent || '').trimEnd(),
    }
  }

  function buildParagraphHtml(style: string, text: string, className = '') {
    const stylePart = style ? ` style="${style}"` : ''
    const classPart = className ? ` class="${className}"` : ''
    return `<p${classPart}${stylePart}>${escapeHtml(text)}</p>`
  }

  function firstVisibleChar(text: string) {
    return text.trimStart().charAt(0)
  }

  function isPunctuationOnlyText(text: string) {
    const value = text.trim()
    return value.length > 0 && value.length <= 3 && Array.from(value).every((char) => PUNCTUATION_ONLY_CHARS.has(char))
  }

  function adjustFitCountForReadableStart(text: string, fitCount: number) {
    if (fitCount <= 0 || fitCount >= text.length) return fitCount
    if (!NON_STARTING_PUNCTUATION.has(firstVisibleChar(text.slice(fitCount)))) return fitCount

    const minIndex = Math.max(1, fitCount - MAX_PUNCTUATION_BACKTRACK)
    for (let idx = fitCount - 1; idx >= minIndex; idx -= 1) {
      if (SPLIT_BACKTRACK_BREAKERS.has(text[idx])) {
        return idx + 1
      }
    }
    return Math.max(1, fitCount - Math.min(4, fitCount - 1))
  }

  function extractTextFromHtml(html: string) {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = html
    return wrapper.textContent || ''
  }

  function prependTextToFirstParagraph(html: string, text: string) {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = html
    const paragraph = wrapper.querySelector('p')
    if (!paragraph) return `${escapeHtml(text)}${html}`
    paragraph.insertBefore(document.createTextNode(text), paragraph.firstChild)
    return wrapper.innerHTML
  }

  function appendTextToLastParagraph(html: string, text: string) {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = html
    const paragraphs = wrapper.querySelectorAll('p')
    const paragraph = paragraphs[paragraphs.length - 1]
    if (!paragraph) return `${html}${escapeHtml(text)}`
    paragraph.appendChild(document.createTextNode(text))
    return wrapper.innerHTML
  }

  function mergeOrphanPunctuationPages(sourcePages: string[]) {
    const pendingPages = [...sourcePages]
    const mergedPages: string[] = []
    for (let idx = 0; idx < pendingPages.length; idx += 1) {
      const page = pendingPages[idx]
      const text = extractTextFromHtml(page)
      if (isPunctuationOnlyText(text)) {
        const punctuation = text.trim()
        if (mergedPages.length) {
          mergedPages[mergedPages.length - 1] = appendTextToLastParagraph(mergedPages[mergedPages.length - 1], punctuation)
          continue
        }
        if (idx + 1 < pendingPages.length) {
          pendingPages[idx + 1] = prependTextToFirstParagraph(pendingPages[idx + 1], punctuation)
          continue
        }
      }
      mergedPages.push(page)
    }
    return mergedPages
  }

  function buildHorizontalParagraphs() {
    const root = document.createElement('div')
    root.innerHTML = formattedContent.value
    return Array.from(root.querySelectorAll('p')).map((node) => normalizeParagraphHtml(node.outerHTML))
  }

  function updateHorizontalMetrics() {
    const container = scrollContainerRef.value
    if (!container || !isHorizontalPageMode.value) return
    horizontalPageStep.value = Math.max(1, container.clientWidth)
  }

  function getHorizontalPageMeasure(container: HTMLElement) {
    const lineHeightPx = config.value.fontSize * config.value.lineHeight
    const bottomGuard = Math.max(
      HORIZONTAL_PAGE_MIN_BOTTOM_GUARD,
      Math.ceil(lineHeightPx * HORIZONTAL_PAGE_BOTTOM_GUARD_LINES),
    )
    return {
      innerWidth: Math.max(120, horizontalPageStep.value - HORIZONTAL_PAGE_SIDE_PADDING * 2),
      pageHeight: Math.max(160, container.clientHeight - HORIZONTAL_PAGE_VERTICAL_PADDING * 2 - bottomGuard),
    }
  }

  function updateHorizontalEndState() {
    const container = scrollContainerRef.value
    if (!container || !isHorizontalPageMode.value) {
      isHorizontalAtEnd.value = false
      return
    }
    updateHorizontalMetrics()
    const maxPage = Math.max(0, horizontalPages.value.length - 1)
    isHorizontalAtEnd.value = horizontalPageIndex.value >= maxPage
  }

  async function rebuildHorizontalPages() {
    if (!isHorizontalPageMode.value) {
      horizontalPages.value = []
      return
    }
    await nextTick()
    const container = scrollContainerRef.value
    if (!container) return

    updateHorizontalMetrics()

    const { innerWidth, pageHeight } = getHorizontalPageMeasure(container)
    const title = (store.currentChapter?.title || '加载中...').trim()
    const titleHtml = `<h1 class="horizontal-flow-title">${escapeHtml(title)}</h1>`
    const paragraphs = buildHorizontalParagraphs()

    const measurer = document.createElement('div')
    measurer.style.position = 'fixed'
    measurer.style.left = '-99999px'
    measurer.style.top = '0'
    measurer.style.width = `${innerWidth}px`
    // 不固定高度：让内容自然撑开，用一次 scrollHeight 拿到真实内容高度。
    // 固定 height + overflow:hidden 会让 scrollHeight 在内容未溢出时恒等于容器高度，
    // 无法得到精确内容高度；同时避免每次测量反复写 style.height。
    measurer.style.overflow = 'visible'
    measurer.style.visibility = 'hidden'
    measurer.style.pointerEvents = 'none'
    measurer.style.boxSizing = 'border-box'
    measurer.style.fontSize = `${config.value.fontSize}px`
    measurer.style.fontWeight = String(config.value.fontWeight)
    measurer.style.lineHeight = String(config.value.lineHeight)
    measurer.style.fontFamily = currentFontFamily.value || ''
    measurer.style.wordBreak = 'normal'
    measurer.style.overflowWrap = 'break-word'
    measurer.style.textAlign = 'left'
    document.body.appendChild(measurer)

    const pages: string[] = []
    let currentParts: string[] = [titleHtml]

    // 一次 innerHTML 写入 + 一次 scrollHeight 读取即可得到内容真实高度。
    // 相比遍历每个子元素调 getBoundingClientRect()/getComputedStyle()（每个都是强制布局/样式计算），
    // 这里把整页测量压成单次布局，是分页提速的关键。
    // scrollHeight 是浏览器标准的内容高度：最后一个子元素的 margin-bottom 折叠到容器外不计入，
    // 恰好与原实现「忽略最后一个 p 的 margin-bottom」的语义一致，分页结果不变。
    const measureContentHeight = (parts: string[]) => {
      measurer.innerHTML = parts.join('')
      return measurer.scrollHeight
    }

    const overflows = (parts: string[]) => {
      return measureContentHeight(parts) > pageHeight
    }

    const flushPage = () => {
      if (!currentParts.length) return
      pages.push(currentParts.join(''))
      currentParts = []
    }

    const buildSegmentStyle = (style: string, isContinuation: boolean, hasMoreText: boolean) => {
      const styleObj = parseInlineStyle(style)
      if (hasMoreText) delete styleObj['margin-bottom']
      if (isContinuation) delete styleObj['text-indent']
      return buildInlineStyle(styleObj)
    }

    const fitParagraphSegment = (
      blockHtml: string,
      options: { isContinuation: boolean; minRemainingLines?: number },
    ) => {
      const parsed = parseParagraphHtml(blockHtml)
      if (!parsed || parsed.text.length <= 1) return null

      const { style, text, className } = parsed
      const currentHeight = measureContentHeight(currentParts)
      const remainingHeight = pageHeight - currentHeight
      const minRemainingHeight = (options.minRemainingLines || 0) * config.value.fontSize * config.value.lineHeight
      if (remainingHeight < minRemainingHeight) return null

      const segmentClassName = options.isContinuation ? removeIndentClass(className) : className
      // 关键优化：整页固定部分只写入一次 DOM，二分期间只改这一个「探针」段落的文本，
      // 不再每轮 innerHTML 重建整页 + 遍历全部子元素测量。fitting 判断压成纯二分 + 单次 scrollHeight。
      measurer.innerHTML = `${currentParts.join('')}<p data-fit-probe="1"></p>`
      const probe = measurer.querySelector('[data-fit-probe]') as HTMLElement | null
      const fits = (count: number) => {
        if (!probe) return false
        const tryStyle = buildSegmentStyle(style, options.isContinuation, count < text.length)
        probe.setAttribute('style', tryStyle)
        probe.className = segmentClassName
        probe.textContent = text.slice(0, count)
        return measurer.scrollHeight <= pageHeight
      }
      let fitCount = findFittingCharCount(text.length, fits)

      if (fitCount <= 0) return null

      fitCount = adjustFitCountForReadableStart(text, fitCount)
      if (fitCount <= 0 || (fitCount < text.length && isPunctuationOnlyText(text.slice(0, fitCount)))) return null

      const hasMoreText = fitCount < text.length
      const fitStyle = buildSegmentStyle(style, options.isContinuation, hasMoreText)
      return {
        html: buildParagraphHtml(fitStyle, text.slice(0, fitCount), segmentClassName),
        remainingHtml: hasMoreText
          ? buildParagraphHtml(style, text.slice(fitCount), removeIndentClass(className))
          : '',
      }
    }

    const appendOversizedParagraph = (blockHtml: string, isContinuation = false) => {
      const parsed = parseParagraphHtml(blockHtml)
      if (!parsed || parsed.text.length <= 1) {
        pages.push(blockHtml)
        return
      }

      let pending = blockHtml
      let continuation = isContinuation
      while (pending) {
        const fitted = fitParagraphSegment(pending, { isContinuation: continuation })
        if (fitted) {
          currentParts = [...currentParts, fitted.html]
          pending = fitted.remainingHtml
          continuation = true
          if (pending) flushPage()
          continue
        }

        if (currentParts.length) {
          flushPage()
          continue
        }

        pages.push(pending)
        pending = ''
      }
    }

    const appendBlock = (blockHtml: string) => {
      const withBlock = [...currentParts, blockHtml]
      if (!overflows(withBlock)) {
        currentParts = withBlock
        return
      }

      if (currentParts.length) {
        const fitted = fitParagraphSegment(blockHtml, { isContinuation: false })
        if (fitted) {
          currentParts = [...currentParts, fitted.html]
          if (fitted.remainingHtml) {
            flushPage()
            appendOversizedParagraph(fitted.remainingHtml, true)
          }
          return
        }

        flushPage()
        if (!overflows([blockHtml])) {
          currentParts = [blockHtml]
          return
        }
      }

      appendOversizedParagraph(blockHtml)
    }

    for (const paragraph of paragraphs) {
      appendBlock(paragraph)
    }

    if (currentParts.length) {
      flushPage()
    }

    if (!pages.length) {
      pages.push(titleHtml)
    } else if (pages.length === 1 && !pages[0].includes('horizontal-flow-title')) {
      pages[0] = `${titleHtml}${pages[0]}`
    }

    const mergedPages = mergeOrphanPunctuationPages(pages)

    document.body.removeChild(measurer)
    horizontalPages.value = mergedPages
    horizontalPageIndex.value = Math.min(horizontalPageIndex.value, mergedPages.length - 1)

    container.scrollTo({ left: 0, behavior: 'auto' })
    updateHorizontalEndState()
  }

  function alignHorizontalToNearestPage(touchMoving: boolean) {
    const container = scrollContainerRef.value
    if (!container || !isHorizontalPageMode.value || touchMoving) return
    updateHorizontalMetrics()
    const maxPage = Math.max(0, horizontalPages.value.length - 1)
    horizontalPageIndex.value = Math.max(0, Math.min(maxPage, horizontalPageIndex.value))
    if (container.scrollLeft !== 0) {
      container.scrollTo({ left: 0, behavior: 'auto' })
    }
  }

  function resetHorizontalPagePosition() {
    horizontalPageIndex.value = 0
    const container = scrollContainerRef.value
    if (!container) return
    updateHorizontalMetrics()
    container.scrollTo({ left: 0, behavior: 'auto' })
  }

  return {
    horizontalPageIndex,
    horizontalPageStep,
    horizontalPageStepStyle,
    horizontalPages,
    isHorizontalAtEnd,
    rebuildHorizontalPages,
    updateHorizontalMetrics,
    updateHorizontalEndState,
    alignHorizontalToNearestPage,
    resetHorizontalPagePosition,
  }
}
