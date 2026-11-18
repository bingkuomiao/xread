import http from './http'
import type { UserInfo } from '../types'

export function login(username: string, password: string) {
  return http
    .post<UserInfo>('/login', { username, password, isLogin: true })
    .then((r) => r.data)
}

export function register(username: string, password: string, code?: string) {
  return http
    .post<UserInfo>('/login', { username, password, isLogin: false, code })
    .then((r) => r.data)
}

export function logout() {
  return http.post('/logout').catch(() => {
    // Logout always clears local state
  })
}

export function getUserInfo() {
  return http
    .get<{
      userInfo: UserInfo | null
      secure: boolean
      secureKeyRequired: boolean
      adminAuthorized: boolean
      publicRead: boolean
    }>('/getUserInfo')
    .then((r) => r.data)
}

export function getUserList() {
  return http.get<UserInfo[]>('/getUserList').then((r) => r.data)
}

export function addUser(username: string, password: string) {
  return http.post<UserInfo[]>('/addUser', { username, password }).then((r) => r.data)
}

export function resetPassword(username: string, password: string) {
  return http.post<string>('/resetPassword', { username, password }).then((r) => r.data)
}

export function changePassword(oldPassword: string, newPassword: string) {
  return http.post<string>('/changePassword', { oldPassword, newPassword }).then((r) => r.data)
}

export function updateUser(
  username: string,
  payload: { enableWebdav?: boolean; enableLocalStore?: boolean; enableAiModel?: boolean },
) {
  return http.post<UserInfo[]>('/updateUser', { username, ...payload }).then((r) => r.data)
}

export function deleteUsers(usernames: string[]) {
  return http.post<UserInfo[]>('/deleteUsers', usernames).then((r) => r.data)
}

// ─── 用户配置（服务端持久化，用于跨设备同步偏好） ───
const EXPLORE_SOURCE_FIELD = 'exploreSourceUrl'

export function getUserConfig() {
  return http.get<Record<string, unknown>>('/getUserConfig').then((r) => r.data)
}

export function saveUserConfig(config: Record<string, unknown>) {
  return http.post<string>('/saveUserConfig', config).then((r) => r.data)
}

/**
 * 读取服务端保存的「发现书源」选择。
 * 未登录 / 尚无备份文件 / 网络异常时返回空串，调用方回退到本地 localStorage。
 */
export async function fetchExploreSourcePreference(): Promise<string> {
  try {
    const cfg = await getUserConfig()
    if (!cfg || typeof cfg !== 'object') return ''
    return String((cfg as Record<string, unknown>)[EXPLORE_SOURCE_FIELD] ?? '')
  } catch {
    return ''
  }
}

/**
 * 把「发现书源」选择写回服务端：先读回现有配置再合并，避免覆盖其他字段；
 * 值未变化或写入失败（如未登录）时静默跳过，本地选择仍然有效。
 */
export async function saveExploreSourcePreference(url: string): Promise<void> {
  let cfg: Record<string, unknown> = {}
  try {
    const current = await getUserConfig()
    if (current && typeof current === 'object') cfg = { ...current }
  } catch {
    // 首次使用（服务端尚无 userConfig.json）时以空对象为基线
  }
  if (String(cfg[EXPLORE_SOURCE_FIELD] ?? '') === url) return
  delete cfg['@updateTime']
  try {
    await saveUserConfig({ ...cfg, [EXPLORE_SOURCE_FIELD]: url })
  } catch {
    // 未登录或写入失败时保留本地选择，不打断用户操作
  }
}
