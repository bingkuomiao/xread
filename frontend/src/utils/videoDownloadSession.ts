/**
 * 视频转码下载任务的会话判定（纯函数，便于单元测试）。
 *
 * 状态背景（见 ReaderVideoPlayer.vue）：
 * - m3u8 下载采用后端任务制，前端持有 taskId 并以定时器轮询进度；
 * - 弹窗上的「继续下载」只隐藏弹窗（downloadConverting=false），
 *   但 taskId 与轮询仍在，后台继续转码，完成后自动下载；
 * - 此时若再次点击「下载」，应重新弹出原进度弹窗，而不是新建一个任务。
 */

export type DownloadPhase = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * 判断是否存在「后台进行中」的下载任务，用于决定再次点击下载时
 * 是恢复弹窗（true）还是新建任务（false）。
 *
 * @param taskId      当前任务 id（空串表示无任务）
 * @param polling    轮询定时器是否仍在运行
 * @param phase       任务阶段
 */
export function isBackgroundTaskActive(
  taskId: string,
  polling: boolean,
  phase: DownloadPhase,
): boolean {
  return (
    !!taskId &&
    polling &&
    (phase === 'pending' || phase === 'running')
  )
}
