import { describe, it, expect, vi, beforeEach } from 'vitest'

// 观测传给 http.post 的第三个参数（config），确认 FormData 上传显式携带 multipart 头，
// 覆盖 http 实例默认的 application/json，避免 axios 把 FormData 序列化成 JSON 导致后端 400。
const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }))

vi.mock('./http', () => ({ default: { post: postMock, get: vi.fn() } }))

import { uploadFilesToWebdav, uploadTextToWebdav } from './webdav'

function headerOf(config: { headers?: Record<string, string> } | undefined, key: string): string | undefined {
  const headers = config?.headers as Record<string, string> | undefined
  if (!headers) return undefined
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === key.toLowerCase())
  return hit ? headers[hit] : undefined
}

describe('WebDAV FormData 上传头（400 回归）', () => {
  beforeEach(() => {
    postMock.mockReset()
    postMock.mockResolvedValue({ data: [] })
  })

  it('uploadFilesToWebdav 显式携带 multipart/form-data 头', async () => {
    const blob = new Blob([JSON.stringify({ a: 1 })], { type: 'application/json' })
    await uploadFilesToWebdav([{ file: blob, name: 'backup.json' }], '/backups')

    expect(postMock).toHaveBeenCalledTimes(1)
    const [url, formData, config] = postMock.mock.calls[0]
    expect(url).toBe('/uploadFileToWebdav')
    expect(formData).toBeInstanceOf(FormData)
    expect(headerOf(config, 'Content-Type')).toBe('multipart/form-data')
    // 绝不能是 application/json：那会让 axios 把 FormData 序列化，后端 Multipart 解析报 400
    expect(headerOf(config, 'Content-Type')).not.toBe('application/json')
    expect((formData as FormData).get('path')).toBe('/backups')
  })

  it('uploadTextToWebdav 走同一上传通道，同样携带 multipart 头', async () => {
    await uploadTextToWebdav('{"version":1}', 'reader-backup-test.json', '/backups')
    const [, formData, config] = postMock.mock.calls[0]
    expect(headerOf(config, 'Content-Type')).toBe('multipart/form-data')
    expect([...((formData as FormData).keys())].some((k) => k.startsWith('file'))).toBe(true)
  })
})
