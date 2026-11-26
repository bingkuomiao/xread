import http from './http'

export interface WebdavFileEntry {
  name: string
  size: number
  path: string
  lastModified: number
  isDirectory: boolean
}

export function getWebdavFileList(path = '/') {
  return http.get<WebdavFileEntry[]>('/getWebdavFileList', {
    params: { path },
  }).then((r) => r.data)
}

export function getWebdavFileText(path: string) {
  return http.get<string>('/getWebdavFile', {
    params: { path },
    responseType: 'text',
    transformResponse: [(value) => value],
  }).then((r) => r.data as unknown as string)
}

export function getWebdavFileBlob(path: string) {
  return http.get<Blob>('/getWebdavFile', {
    params: { path },
    responseType: 'blob',
  }).then((r) => r.data)
}

export function uploadFilesToWebdav(files: Array<{ file: Blob; name: string }>, path = '/') {
  const formData = new FormData()
  formData.append('path', path)
  files.forEach((item, index) => {
    formData.append(`file${index}`, item.file, item.name)
  })
  // 必须显式设置 multipart/form-data 覆盖 http 实例的默认 application/json：
  // 全局 http 实例设了 Content-Type: application/json，若不覆盖，axios transformRequest
  // 检测到 JSON 类型会把 FormData 序列化成 JSON 字符串，后端 axum 的 Multipart extractor
  // 无法解析而直接返回 400（备份/上传都会中招，下载是 GET 不受影响）。
  // 这里与 uploadTxtBook/uploadEpubBook/readSourceFile 保持一致，显式声明 multipart。
  return http.post<WebdavFileEntry[]>('/uploadFileToWebdav', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  }).then((r) => r.data)
}

export function uploadTextToWebdav(content: string, filename: string, path = '/') {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  return uploadFilesToWebdav([{ file: blob, name: filename }], path)
}

export function deleteWebdavFile(path: string) {
  return http.post<string>('/deleteWebdavFile', { path }).then((r) => r.data)
}

export function deleteWebdavFileList(paths: string[]) {
  return http.post<string>('/deleteWebdavFileList', { path: paths }).then((r) => r.data)
}
