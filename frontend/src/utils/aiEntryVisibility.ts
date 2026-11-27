/**
 * 书架卡片「AI」入口显示判定（纯函数，便于单测）。
 *
 * 规则（与后端 can_use_ai_model 的权限语义对齐）：
 * 1. 搜索结果 / 编辑模式 / RSS 书：不显示（沿用原有范围约束）
 * 2. 鉴权信息未就绪：不显示（避免密码模式下先闪现再隐藏）
 * 3. 无密码模式（无账号授权概念）：所有人显示，后端此模式允许所有人用 AI
 * 4. 密码模式：仅当前账号开启「AI模型」授权时显示；管理员同样受此开关约束
 */
export interface AiEntryVisibilityInput {
  isSearch: boolean
  editMode: boolean
  recentKind?: string
  /** 用户信息请求是否已结束（成功或失败） */
  authReady: boolean
  isSecureMode: boolean
  /** 当前账号的 enableAiModel 权限 */
  enableAiModel: boolean
}

export function canShowAiEntry(input: AiEntryVisibilityInput): boolean {
  if (input.isSearch || input.editMode) return false
  if (input.recentKind === 'rss') return false
  if (!input.authReady) return false
  if (!input.isSecureMode) return true
  return input.enableAiModel === true
}
