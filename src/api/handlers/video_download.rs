//! 视频下载：把 m3u8（HLS）流通过 ffmpeg 在本地合并转成 mp4 后返回给浏览器下载。
//!
//! 背景：m3u8 只是分片索引，浏览器 `<a download>` 只能下到索引文本，无法离线播放。
//! 这里由后端代下并用随包内置的静态 ffmpeg 合并转码成单个 mp4，绕过前端 CORS，
//! 也让下载结果是可直接播放的完整文件。
//!
//! 设计要点：
//! - ffmpeg 二进制优先用「可执行文件同目录」的 ffmpeg-{arch}（随包内置），
//!   找不到再回退到 PATH 里的 ffmpeg（便于 dev 环境调试）。
//! - 转码输出到临时文件（可 seek，才能用 +faststart 把 moov 移到文件头），
//!   转完后再流式返回；前端因此能拿到完整文件、显示进度、可续传。
//! - 限制：仅允许 http/https URL、单请求超时、全局并发上限，避免被当作风洞或拖垮服务。

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{process::Command, sync::Semaphore};
use tokio_util::io::ReaderStream;
use url::Url;

use crate::api::{auth::AuthContext, AppState};
use crate::error::error::{ApiResponse, AppError};

/// 单个转码任务的最长时长（防卡死）。HLS 整片合并通常几十秒，5 分钟足够宽松。
const CONVERT_TIMEOUT_SECS: u64 = 300;
/// 同时进行的转码任务上限（ffmpeg 是 CPU 密集，限制并发保护服务）。
const MAX_CONCURRENT_CONVERT: usize = 2;

static CONVERT_SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn convert_semaphore() -> Arc<Semaphore> {
    CONVERT_SEM
        .get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_CONVERT)))
        .clone()
}

#[derive(Debug, Deserialize)]
pub struct ConvertVideoRequest {
    /// m3u8 / 视频直链（仅 http、https）
    pub url: String,
    /// 可选：拉流时附带的 Referer（防盗链站点需要）
    #[serde(default)]
    pub referer: Option<String>,
    /// 可选：拉流时的 User-Agent
    #[serde(default)]
    pub user_agent: Option<String>,
}

/// 仅允许 http/https，拒绝 file://、gopher:// 等可能造成 SSRF 的协议。
fn validate_media_url(raw: &str) -> Result<Url, AppError> {
    let url = Url::parse(raw).map_err(|_| AppError::BadRequest("视频地址格式无效".to_string()))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err(AppError::BadRequest(
            "仅支持 http/https 视频地址".to_string(),
        )),
    }
}

/// 定位 ffmpeg：可执行文件同目录的 ffmpeg-{arch} 优先，回退 PATH 中的 ffmpeg。
fn locate_ffmpeg() -> PathBuf {
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    let bundled_name = format!("ffmpeg-{}", arch);

    // 内置二进制：与 xread 可执行文件同目录（FPK/WSL2 布局 app/bin/）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(&bundled_name);
            if bundled.is_file() {
                return bundled;
            }
            // 开发/其它布局：bin/ 同级的 ffmpeg/{arch}/ffmpeg
            let alt = dir.join("ffmpeg").join(arch).join("ffmpeg");
            if alt.is_file() {
                return alt;
            }
        }
    }

    // 回退：PATH 里的 ffmpeg（dev 环境）
    PathBuf::from("ffmpeg")
}

pub async fn convert_video_to_mp4(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<ConvertVideoRequest>,
) -> Result<Response, AppError> {
    // 认证：与书源代理一致，真实校验用户身份（避免伪造 token 头滥用转码资源）
    state
        .user_service
        .resolve_read_user_ns(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
        .map_err(|_| AppError::BadRequest("NEED_LOGIN".to_string()))?;

    let url = validate_media_url(&req.url)?;

    // 并发闸门：超过上限时快速失败，避免堆积
    let permit = match convert_semaphore().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return Err(AppError::BadRequest(
                "当前转换任务较多，请稍后重试".to_string(),
            ))
        }
    };

    let ffmpeg = locate_ffmpeg();
    let work_dir = std::env::temp_dir().join(format!("xread-vdl-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("创建临时目录失败: {}", e)))?;
    let out_path = work_dir.join("out.mp4");

    // -c copy 直接封装（快、无损）；+faststart 把 moov 移到文件头便于下载后秒开。
    // 注意：不加 -bsf:a aac_adtstoasc——它在源音频非 AAC 时会报错，
    // 现代 ffmpeg 转 mp4 容器时已能自动处理 AAC ADTS→ASC。
    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-y");
    if let Some(referer) = req.referer.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-headers")
            .arg(format!("Referer: {}\r\n", referer));
    }
    if let Some(ua) = req.user_agent.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-user_agent").arg(ua);
    }
    cmd.arg("-i")
        .arg(url.as_str())
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-f")
        .arg("mp4")
        .arg(&out_path);

    // 转码主流程（含超时），无论成功失败都清理临时目录与并发许可
    let result = run_convert(cmd, &out_path).await;

    // 保持 permit 直到响应体构造完成
    drop(permit);

    match result {
        Ok(()) => {
            let meta = tokio::fs::metadata(&out_path)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("读取转换结果失败: {}", e)))?;
            let total = meta.len();
            if total == 0 {
                let _ = tokio::fs::remove_dir_all(&work_dir).await;
                return Err(AppError::BadRequest("转换结果为空，请检查视频地址".to_string()));
            }

            // 流式读取文件。文件读完后由 ReaderStream 自然结束；
            // 用一个包装 future 在读完后删除临时目录。
            let file = tokio::fs::File::open(&out_path)
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("打开转换结果失败: {}", e)))?;
            let stream = ReaderStream::new(file);
            let body = Body::from_stream(stream);

            let mut resp = Response::new(body);
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("video/mp4"),
            );
            resp.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"video.mp4\""),
            );
            if let Ok(len) = HeaderValue::from_str(&total.to_string()) {
                resp.headers_mut().insert(header::CONTENT_LENGTH, len);
            }
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            );

            // 延迟清理：交给一个分离任务，等前端读完（这里给足够长的宽限期）。
            let cleanup_path = work_dir.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(120)).await;
                let _ = tokio::fs::remove_dir_all(&cleanup_path).await;
            });

            Ok(resp)
        }
        Err(msg) => {
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            Err(AppError::BadRequest(msg))
        }
    }
}

async fn run_convert(mut cmd: Command, out_path: &Path) -> Result<(), String> {
    let timeout = Duration::from_secs(CONVERT_TIMEOUT_SECS);
    let child = cmd.spawn().map_err(|e| {
        format!(
            "无法启动 ffmpeg（请确认服务端已内置或安装 ffmpeg）: {}",
            e
        )
    })?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "转换超时，请稍后重试".to_string())?
        .map_err(|e| format!("转换过程出错: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!(
            "视频转换失败: {}",
            if detail.is_empty() { "源地址不可用或格式不支持" } else { detail }
        ));
    }

    if !out_path.is_file() {
        return Err("转换未产生输出文件".to_string());
    }
    Ok(())
}

/// 探测服务端 ffmpeg 是否可用（供前端/运维排查）。
pub async fn video_download_status() -> impl IntoResponse {
    let ffmpeg = locate_ffmpeg();
    let available = if ffmpeg.is_absolute() {
        ffmpeg.is_file()
    } else {
        tokio::process::Command::new(&ffmpeg)
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    };
    Json(ApiResponse::ok(serde_json::json!({
        "available": available,
        "path": ffmpeg.to_string_lossy(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_media_url_accepts_http_https() {
        assert!(validate_media_url("https://example.com/a.m3u8").is_ok());
        assert!(validate_media_url("http://example.com/a.m3u8?token=1").is_ok());
    }

    #[test]
    fn validate_media_url_rejects_dangerous_schemes() {
        assert!(validate_media_url("file:///etc/passwd").is_err());
        assert!(validate_media_url("ftp://example.com/a.m3u8").is_err());
        assert!(validate_media_url("not a url").is_err());
    }

    #[test]
    fn locate_ffmpeg_returns_a_path() {
        // 不要求必须存在（dev 环境可能没有），但要能返回确定路径不 panic
        let _ = locate_ffmpeg();
    }
}
