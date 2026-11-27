import { describe, expect, it } from 'vitest'
import { canShowAiEntry, type AiEntryVisibilityInput } from './aiEntryVisibility'

const base: AiEntryVisibilityInput = {
  isSearch: false,
  editMode: false,
  recentKind: undefined,
  authReady: true,
  isSecureMode: false,
  enableAiModel: false,
}

describe('canShowAiEntry', () => {
  it('无密码模式：所有人显示', () => {
    expect(canShowAiEntry({ ...base, isSecureMode: false, enableAiModel: false })).toBe(true)
    expect(canShowAiEntry({ ...base, isSecureMode: false, enableAiModel: true })).toBe(true)
  })

  it('密码模式：仅开启 AI 模型授权显示', () => {
    expect(canShowAiEntry({ ...base, isSecureMode: true, enableAiModel: true })).toBe(true)
    expect(canShowAiEntry({ ...base, isSecureMode: true, enableAiModel: false })).toBe(false)
  })

  it('管理员也受开关控制：即便有管理员身份，未开授权也隐藏', () => {
    // 组件只传 enableAiModel，不因管理员身份网开一面
    expect(canShowAiEntry({ ...base, isSecureMode: true, enableAiModel: false })).toBe(false)
  })

  it('鉴权未就绪时一律隐藏（避免密码模式闪现）', () => {
    expect(canShowAiEntry({ ...base, authReady: false, isSecureMode: false })).toBe(false)
    expect(canShowAiEntry({ ...base, authReady: false, isSecureMode: true, enableAiModel: true })).toBe(false)
  })

  it('搜索结果 / 编辑模式 / RSS 书始终隐藏', () => {
    expect(canShowAiEntry({ ...base, isSearch: true, enableAiModel: true })).toBe(false)
    expect(canShowAiEntry({ ...base, editMode: true, enableAiModel: true })).toBe(false)
    expect(canShowAiEntry({ ...base, recentKind: 'rss', enableAiModel: true })).toBe(false)
  })

  it('取消授权后立即隐藏（模拟用户管理实时同步）', () => {
    const granted = canShowAiEntry({ ...base, isSecureMode: true, enableAiModel: true })
    const revoked = canShowAiEntry({ ...base, isSecureMode: true, enableAiModel: false })
    expect(granted).toBe(true)
    expect(revoked).toBe(false)
  })
})
