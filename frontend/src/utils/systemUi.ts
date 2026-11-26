export type SystemThemeMode = 'light' | 'dark'

function upsertMeta(name: string, content: string, media?: string) {
  const selector = media
    ? `meta[name="${name}"][media="${media}"]`
    : `meta[name="${name}"]:not([media])`
  const existing = document.querySelector(selector) as HTMLMetaElement | null
  const meta = document.createElement('meta')
  meta.setAttribute('name', name)
  meta.setAttribute('content', content)
  if (media) {
    meta.setAttribute('media', media)
  }
  if (existing?.parentNode) {
    existing.parentNode.replaceChild(meta, existing)
  } else {
    document.head.appendChild(meta)
  }
  return meta
}

export function applySystemTheme(mode: SystemThemeMode, themeColor?: string) {
  if (typeof document === 'undefined') return

  const resolvedThemeColor = themeColor || (mode === 'dark' ? '#141414' : '#faf9f7')
  // 阅读器传入 themeColor 即为「沉浸阅读」：正文用阅读器主题色铺满屏幕，
  // body/#app 必须同色。界面定制（themeCustom.ts）会用
  // `body, #app { background-color: ... !important }` 强染背景，普通内联样式压不过，
  // iPhone 底部安全区就会露出 body 的自定义色、形成与正文不同的色带。
  // 沉浸模式用 important 内联样式覆盖；离开阅读器（不传 themeColor）恢复普通内联，
  // 让界面定制背景重新生效。
  const priority: string = themeColor ? 'important' : ''
  const root = document.documentElement
  const app = document.getElementById('app')

  root.setAttribute('data-theme', mode)
  root.style.setProperty('color-scheme', mode)
  root.style.setProperty('background', resolvedThemeColor, priority)
  root.style.setProperty('background-color', resolvedThemeColor, priority)
  document.body.style.setProperty('background', resolvedThemeColor, priority)
  document.body.style.setProperty('background-color', resolvedThemeColor, priority)
  document.body.style.colorScheme = mode
  if (app) {
    app.style.setProperty('background', resolvedThemeColor, priority)
    app.style.setProperty('background-color', resolvedThemeColor, priority)
    app.style.colorScheme = mode
  }

  upsertMeta('theme-color', resolvedThemeColor)
  upsertMeta('theme-color', mode === 'light' ? resolvedThemeColor : '#faf9f7', '(prefers-color-scheme: light)')
  upsertMeta('theme-color', mode === 'dark' ? resolvedThemeColor : '#141414', '(prefers-color-scheme: dark)')
  upsertMeta('msapplication-navbutton-color', resolvedThemeColor)
  upsertMeta('color-scheme', mode)
  upsertMeta('apple-mobile-web-app-status-bar-style', 'black-translucent')

  requestAnimationFrame(() => {
    upsertMeta('theme-color', resolvedThemeColor)
    upsertMeta('msapplication-navbutton-color', resolvedThemeColor)
  })
}
