import { beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_STORAGE_KEYS, captureLocalState, applyLocalState } from './webdavBackup'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

describe('WebDAV 备份白名单', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = new MemStorage()
  })

  it('白名单包含两个搜索偏好开关', () => {
    expect(LOCAL_STORAGE_KEYS).toContain('xread-exact-match')
    expect(LOCAL_STORAGE_KEYS).toContain('xread-search-all-default')
  })

  it('两个搜索开关可被备份捕获，并在恢复后写回', () => {
    localStorage.setItem('xread-exact-match', 'true')
    localStorage.setItem('xread-search-all-default', 'false')

    const captured = captureLocalState()
    expect(captured['xread-exact-match']).toBe('true')
    expect(captured['xread-search-all-default']).toBe('false')

    // 模拟换设备：清空本地后恢复
    localStorage.clear()
    expect(localStorage.getItem('xread-exact-match')).toBeNull()
    applyLocalState(captured)
    expect(localStorage.getItem('xread-exact-match')).toBe('true')
    expect(localStorage.getItem('xread-search-all-default')).toBe('false')
  })

  it('恢复时白名单内未提供的 key 会被清除，避免残留旧值', () => {
    localStorage.setItem('xread-exact-match', 'true')
    applyLocalState({}) // 备份里没有该 key
    expect(localStorage.getItem('xread-exact-match')).toBeNull()
  })
})
