import { describe, expect, it } from 'vitest'
import { isBackgroundTaskActive, type DownloadPhase } from './videoDownloadSession'

describe('isBackgroundTaskActive', () => {
  // 点了「继续下载」隐藏弹窗后的典型状态：taskId 在、轮询在、running
  it('后台进行中的任务应恢复弹窗', () => {
    expect(isBackgroundTaskActive('task-1', true, 'running')).toBe(true)
    expect(isBackgroundTaskActive('task-1', true, 'pending')).toBe(true)
  })

  it('无任务 id 时不恢复（开启新任务）', () => {
    expect(isBackgroundTaskActive('', true, 'running')).toBe(false)
  })

  it('轮询已停止时不恢复（任务已终结或失败）', () => {
    expect(isBackgroundTaskActive('task-1', false, 'running')).toBe(false)
  })

  it('终结态即使尚残留轮询也不恢复', () => {
    const terminal: DownloadPhase[] = ['done', 'failed', 'cancelled']
    for (const phase of terminal) {
      expect(isBackgroundTaskActive('task-1', true, phase)).toBe(false)
    }
  })
})
