import { describe, expect, it, vi } from 'vitest'
import { findFittingCharCount } from './useHorizontalPaging'

describe('findFittingCharCount', () => {
  it('空文本返回 0，且不调用测量函数', () => {
    const fits = vi.fn(() => true)
    expect(findFittingCharCount(0, fits)).toBe(0)
    expect(findFittingCharCount(-5, fits)).toBe(0)
    expect(fits).not.toHaveBeenCalled()
  })

  it('全部能放下时返回总字数', () => {
    expect(findFittingCharCount(10, () => true)).toBe(10)
  })

  it('一个都放不下时返回 0', () => {
    expect(findFittingCharCount(10, () => false)).toBe(0)
  })

  it('返回满足 fits 的最大字符数（单调阈值）', () => {
    // 模拟最多放 7 个字
    expect(findFittingCharCount(20, (n) => n <= 7)).toBe(7)
    expect(findFittingCharCount(20, (n) => n <= 1)).toBe(1)
    expect(findFittingCharCount(20, (n) => n <= 19)).toBe(19)
    expect(findFittingCharCount(20, (n) => n <= 20)).toBe(20)
  })

  it('测量函数单调时，二分调用次数约为 log2(n) 级别（性能约束）', () => {
    const fits = vi.fn((n: number) => n <= 500)
    expect(findFittingCharCount(1000, fits)).toBe(500)
    // 线性扫描需 ~500 次；二分应远小于该量级
    expect(fits.mock.calls.length).toBeLessThan(15)
  })

  it('与线性扫描结果一致（多个阈值交叉验证）', () => {
    const linear = (n: number, limit: number) => {
      let best = 0
      for (let i = 1; i <= n; i += 1) if (i <= limit) best = i
      return best
    }
    for (const limit of [0, 1, 3, 8, 15, 31, 64, 99, 100]) {
      expect(findFittingCharCount(100, (n) => n <= limit)).toBe(linear(100, limit))
    }
  })
})
