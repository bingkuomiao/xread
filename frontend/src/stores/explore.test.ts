import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useExploreStore, isExploreDefaultSource } from './explore'
import { useSourceStore } from './source'
import { getBookSources } from '../api/source'
import { exploreBook, getExploreKinds } from '../api/explore'
import type { BookSource } from '../types'

vi.mock('../api/source', () => ({
  getBookSources: vi.fn(),
}))

vi.mock('../api/explore', () => ({
  exploreBook: vi.fn(),
  getExploreKinds: vi.fn(),
}))

const getBookSourcesMock = vi.mocked(getBookSources)
const exploreBookMock = vi.mocked(exploreBook)
const getExploreKindsMock = vi.mocked(getExploreKinds)

describe('explore store source sync', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getBookSourcesMock.mockReset()
    exploreBookMock.mockReset()
    getExploreKindsMock.mockReset()
    exploreBookMock.mockResolvedValue([])
    // 默认走静态 exploreUrl 回退分支，保持断言稳定
    getExploreKindsMock.mockResolvedValue([])
  })

  it('repairs a stale active source when explore sources are already loaded', async () => {
    const sourceStore = useSourceStore()
    sourceStore.sources = [sourceWithExplore()]
    const store = useExploreStore()
    store.activeSourceUrl = 'https://missing.example'

    await store.init()

    expect(store.activeSourceUrl).toBe('https://m.cuoceng.com')
    expect(store.fallbackCategories.map((category) => category.title)).toEqual(['书 库', '排 行'])
    expect(store.activeCategoryUrl).toBe('/book/category/catalog.html')
  })

  it('reflects the preferred source immediately without switching pages', () => {
    const store = useExploreStore()
    // 让 setSource 走「当前源已生效」分支，避免触发异步 applySource / 网络请求
    store.activeSourceUrl = 'https://a.example'
    const flag = computed(() => isExploreDefaultSource('https://a.example'))
    expect(flag.value).toBe(false)
    store.setSource('https://a.example')
    // computed 依赖的是响应式偏好镜像：再次读取即为新值，无需切换书源或重开弹窗
    expect(flag.value).toBe(true)
  })

  it('keeps a local user choice when a stale server preference arrives', () => {
    const sourceStore = useSourceStore()
    const a = sourceWithExplore()
    const b = { ...a, bookSourceUrl: 'https://b.example', bookSourceName: 'b.example' }
    sourceStore.sources = [a, b]
    const store = useExploreStore()
    store.activeSourceUrl = a.bookSourceUrl
    store.setSource(b.bookSourceUrl) // 用户主动选择 b
    // 服务端仍返回旧值 a（且 a 有效）：不应把刚选的 b 覆盖回去
    store.applyServerPreference(a.bookSourceUrl)
    expect(store.activeSourceUrl).toBe(b.bookSourceUrl)
  })

  it('follows a valid server preference when no local choice was made', () => {
    const sourceStore = useSourceStore()
    const a = sourceWithExplore()
    const b = { ...a, bookSourceUrl: 'https://b.example', bookSourceName: 'b.example' }
    sourceStore.sources = [a, b]
    const store = useExploreStore()
    store.activeSourceUrl = a.bookSourceUrl
    store.applyServerPreference(b.bookSourceUrl)
    expect(store.activeSourceUrl).toBe(b.bookSourceUrl)
  })
})

function sourceWithExplore(): BookSource {
  return {
    bookSourceName: 'm.cuoceng.com',
    bookSourceUrl: 'https://m.cuoceng.com',
    enabledExplore: true,
    exploreUrl: JSON.stringify([
      {
        style: { layout_flexBasisPercent: 1.0, layout_flexGrow: 1 },
        title: '书 库',
        url: '/book/category/catalog.html',
      },
      {
        style: { layout_flexBasisPercent: 0.25, layout_flexGrow: 1 },
        title: '排 行',
        url: '/book/ranking.html',
      },
    ]),
  }
}
