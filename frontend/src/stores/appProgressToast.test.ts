import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from './app'

vi.mock('../api/user', () => ({ getUserInfo: vi.fn() }))
vi.mock('../api/update', () => ({
  getVersionUpdate: vi.fn(),
  dismissVersionUpdate: vi.fn(),
}))

function installBrowserGlobals() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
  })
  vi.stubGlobal('navigator', { onLine: true })
}

describe('批量任务进度 toast 与按钮状态', () => {
  beforeEach(() => {
    installBrowserGlobals()
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('进度 toast 常驻、可更新、完成后转结果态并在 3 秒后消失', () => {
    const store = useAppStore()
    const id = store.showProgressToast('正在导入 1/3')
    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0]).toMatchObject({ type: 'progress', message: '正在导入 1/3' })

    store.updateProgressToast(id, '正在导入 2/3')
    expect(store.toasts[0].message).toBe('正在导入 2/3')

    // 进度期间不自动消失
    vi.advanceTimersByTime(10_000)
    expect(store.toasts).toHaveLength(1)

    store.finishProgressToast(id, '已导入 3 本', 'success')
    expect(store.toasts[0]).toMatchObject({ type: 'success', message: '已导入 3 本' })

    vi.advanceTimersByTime(2999)
    expect(store.toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(store.toasts).toHaveLength(0)
  })

  it('batchTask 驱动按钮文字：启动/更新/结束', () => {
    const store = useAppStore()
    expect(store.batchTask.kind).toBeNull()

    store.startBatchTask('export', 8)
    expect(store.batchTask).toEqual({ kind: 'export', current: 0, total: 8 })

    store.updateBatchTask(3)
    expect(store.batchTask.current).toBe(3)

    store.finishBatchTask()
    expect(store.batchTask.kind).toBeNull()
  })
})
