import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookSource } from '../types'
import {
  clearAllCoverMatchAttempts,
  clearCoverMatchAttempt,
  computeSourceFingerprint,
  getCoverMatchFingerprint,
  markCoverMatchAttempted,
  shouldSkipCoverMatch,
} from './coverMatchState'

// node 环境提供最小 localStorage
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

function source(url: string, rule?: Record<string, unknown>, enabled = true): BookSource {
  return {
    bookSourceName: url,
    bookSourceUrl: url,
    enabled,
    ruleSearch: rule ?? { name: '.name', author: '.author' },
  }
}

describe('computeSourceFingerprint', () => {
  it('无书源时返回空串', () => {
    expect(computeSourceFingerprint([])).toBe('')
  })

  it('忽略禁用书源；只剩禁用源时返回空串', () => {
    expect(computeSourceFingerprint([source('a', undefined, false)])).toBe('')
  })

  it('对同一组书源产生稳定指纹', () => {
    const sources = [source('https://a.example'), source('https://b.example')]
    expect(computeSourceFingerprint(sources)).toBe(computeSourceFingerprint(sources))
  })

  it('与书源顺序无关', () => {
    const a = source('https://a.example')
    const b = source('https://b.example')
    expect(computeSourceFingerprint([a, b])).toBe(computeSourceFingerprint([b, a]))
  })

  it('书源增删改或规则变化都会改变指纹', () => {
    const base = [source('https://a.example')]
    const fp = computeSourceFingerprint(base)
    expect(computeSourceFingerprint([...base, source('https://b.example')])).not.toBe(fp)
    expect(computeSourceFingerprint([source('https://a.example', { name: '.title' })])).not.toBe(fp)
    expect(computeSourceFingerprint([source('https://a.example', undefined, false)])).not.toBe(fp)
  })
})

describe('静默补封面尝试记录', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('从未尝试的书需要尝试', () => {
    expect(getCoverMatchFingerprint('local-txt:1')).toBeNull()
    expect(shouldSkipCoverMatch('local-txt:1', 'fpA')).toBe(false)
  })

  it('书源未变时跳过，书源更新后重新尝试', () => {
    markCoverMatchAttempted('local-txt:1', 'fpA')
    expect(shouldSkipCoverMatch('local-txt:1', 'fpA')).toBe(true)
    // 书源更新，指纹变化 → 不再跳过
    expect(shouldSkipCoverMatch('local-txt:1', 'fpB')).toBe(false)
  })

  it('空指纹不做跳过判断', () => {
    markCoverMatchAttempted('local-txt:1', '')
    expect(getCoverMatchFingerprint('local-txt:1')).toBeNull()
    expect(shouldSkipCoverMatch('local-txt:1', '')).toBe(false)
  })

  it('清除记录后恢复为需要尝试', () => {
    markCoverMatchAttempted('local-txt:1', 'fpA')
    clearCoverMatchAttempt('local-txt:1')
    expect(shouldSkipCoverMatch('local-txt:1', 'fpA')).toBe(false)
  })

  it('多本书的记录互不干扰', () => {
    markCoverMatchAttempted('local-txt:1', 'fpA')
    markCoverMatchAttempted('local-txt:2', 'fpB')
    expect(shouldSkipCoverMatch('local-txt:1', 'fpA')).toBe(true)
    expect(shouldSkipCoverMatch('local-txt:2', 'fpA')).toBe(false)
    expect(shouldSkipCoverMatch('local-txt:2', 'fpB')).toBe(true)
  })

  it('清空全部记录后所有书恢复为需要尝试', () => {
    markCoverMatchAttempted('local-txt:1', 'fpA')
    markCoverMatchAttempted('local-txt:2', 'fpA')
    clearAllCoverMatchAttempts()
    expect(shouldSkipCoverMatch('local-txt:1', 'fpA')).toBe(false)
    expect(shouldSkipCoverMatch('local-txt:2', 'fpA')).toBe(false)
  })
})
