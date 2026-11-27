//! 视频下载：把 m3u8（HLS）流通过 ffmpeg 在本地合并转成 mp4 后返回给浏览器下载。
//!
//! 背景：m3u8 只是分片索引，浏览器 `<a download>` 只能下到索引文本，无法离线播放。
//! 这里由后端代下并用随包内置的静态 ffmpeg 合并转码成单个 mp4，绕过前端 CORS。
//!
//! 任务制（支撑真实进度与取消）：
//! - POST convertVideoToMp4 立即返回 taskId，后台 spawn ffmpeg 转码；
//! - 后台用 `-progress pipe:1` 逐行解析 out_time_us，结合 m3u8 总时长算出真实百分比；
//! - GET  convertVideoProgress 查询进度/状态；
//! - GET  convertVideoResult 转完后流式返回 mp4（带 Content-Disposition）；
//! - POST convertVideoCancel 置取消标志并 kill ffmpeg 子进程。
//! 每个任务按 user_ns 归属隔离，taskId 为随机 UUID，10 分钟 TTL 自动清理临时文件。

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{io::AsyncBufReadExt, process::Command, sync::Semaphore};
use tokio_util::io::ReaderStream;
use url::Url;

use crate::api::{auth::AuthContext, AppState};
use crate::error::error::{ApiResponse, AppError};
use crate::service::video_download_task::{
    first_variant_url, parse_m3u8_duration, task_table, TaskStatus,
};

/// 单个转码任务的最长时长（防卡死）。HLS 整片合并通常几十秒，5 分钟足够宽松。
const CONVERT_TIMEOUT_SECS: u64 = 300;
/// 同时进行的转码任务上限（ffmpeg 是 CPU 密集，限制并发保护服务）。
const MAX_CONCURRENT_CONVERT: usize = 2;

/// HLS 分片拉取加速参数（放在 -i 之前作为输入选项，对非 HLS 直链无害）。
const HLS_FETCH_ARGS: [&str; 2] = ["-http_multiple", "1"];

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
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    /// 可选：下载文件名（不含扩展名），前端传书名+章节。会被严格清洗。
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TaskQuery {
    pub task_id: String,
}

#[derive(Debug, Deserialize)]
pub struct CancelRequest {
    pub task_id: String,
}

#[derive(Debug, Serialize)]
pub struct StartResponse {
    pub task_id: String,
    pub file_name: String,
}

#[derive(Debug, Serialize)]
pub struct ProgressResponse {
    /// pending / running / done / failed / cancelled
    pub status: TaskStatus,
    pub percent: u8,
    pub error: String,
}

/// 清洗下载文件名：只保留安全字符，去掉路径分隔符、控制字符与 Windows 保留名，
/// 限制长度，避免 Content-Disposition 注入或被当成路径。返回不含扩展名的安全名。
fn sanitize_download_filename(raw: Option<&str>) -> String {
    let cleaned: String = raw
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_whitespace() => '_',
            c => c,
        })
        .collect();
    let mut collapsed = String::with_capacity(cleaned.len());
    let mut prev_underscore = false;
    for c in cleaned.chars() {
        if c == '_' {
            if prev_underscore {
                continue;
            }
            prev_underscore = true;
        } else {
            prev_underscore = false;
        }
        collapsed.push(c);
    }
    let mut safe = collapsed.trim_matches(|c| c == '_' || c == '.').to_string();
    const RESERVED: [&str; 8] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4",
    ];
    if RESERVED.contains(&safe.to_ascii_lowercase().as_str()) {
        safe.clear();
    }
    safe = safe.chars().take(48).collect();
    if safe.is_empty() {
        "video".to_string()
    } else {
        safe
    }
}

/// 构造 RFC 6266 Content-Disposition 值：ASCII 回退名 + UTF-8 filename* 中文名。
fn build_content_disposition(base: &str) -> String {
    let ascii_base: String = base
        .chars()
        .map(|c| if c.is_ascii() { c } else { '_' })
        .collect();
    let ascii_name = if ascii_base.is_empty() {
        "video".to_string()
    } else {
        ascii_base
    };
    let mut encoded = String::with_capacity(base.len() * 3);
    for b in base.as_bytes() {
        match *b {
            b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*b as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", b)),
        }
    }
    format!(
        "attachment; filename=\"{}.mp4\"; filename*=UTF-8''{}.mp4",
        ascii_name, encoded
    )
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

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(&bundled_name);
            if bundled.is_file() {
                return bundled;
            }
            let alt = dir.join("ffmpeg").join(arch).join("ffmpeg");
            if alt.is_file() {
                return alt;
            }
        }
    }
    PathBuf::from("ffmpeg")
}

/// 认证：解析当前用户命名空间，作为任务归属，失败返回 NEED_LOGIN。
async fn resolve_owner(state: &AppState, auth: &AuthContext) -> Result<String, AppError> {
    state
        .user_service
        .resolve_read_user_ns(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
        .map_err(|_| AppError::BadRequest("NEED_LOGIN".to_string()))
}

/// 拉取并解析 m3u8 总时长（秒）。master playlist 跟随到第一个子列表。
/// 失败返回 0.0（前端退化为不确定进度，不影响下载本身）。
async fn probe_total_duration(
    url: &Url,
    referer: Option<&str>,
    ua: Option<&str>,
) -> f64 {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(_) => return 0.0,
    };
    let mut req = client.get(url.as_str());
    if let Some(r) = referer.filter(|s| !s.trim().is_empty()) {
        req = req.header("Referer", r);
    }
    if let Some(u) = ua.filter(|s| !s.trim().is_empty()) {
        req = req.header("User-Agent", u);
    }
    let text = match req.send().await {
        Ok(resp) => match resp.text().await {
            Ok(t) => t,
            Err(_) => return 0.0,
        },
        Err(_) => return 0.0,
    };
    // master playlist：跟随到第一个子列表再取时长
    if let Some(variant) = first_variant_url(&text, url) {
        if let Ok(vu) = Url::parse(&variant) {
            let mut req2 = client.get(vu.as_str());
            if let Some(r) = referer.filter(|s| !s.trim().is_empty()) {
                req2 = req2.header("Referer", r);
            }
            if let Some(u) = ua.filter(|s| !s.trim().is_empty()) {
                req2 = req2.header("User-Agent", u);
            }
            if let Ok(resp) = req2.send().await {
                if let Ok(t2) = resp.text().await {
                    return parse_m3u8_duration(&t2);
                }
            }
        }
    }
    parse_m3u8_duration(&text)
}

/// 由 ffmpeg 输出时间戳与总时长计算真实百分比（0-100，单调递增由 TaskTable 保证）。
/// total_duration<=0（如直链）时返回 0，由前端走不确定进度。
fn compute_progress_percent(out_time_us: u64, total_duration: f64) -> u8 {
    if total_duration <= 0.0 {
        return 0;
    }
    let pct = (out_time_us as f64) / (total_duration * 1_000_000.0) * 100.0;
    pct.round().clamp(0.0, 99.0) as u8
}

/// 构造 ffmpeg 命令（复用同步/任务制流程）。
fn build_ffmpeg_command(req: &ConvertVideoRequest, url: &Url, out_path: &Path) -> Command {
    let ffmpeg = locate_ffmpeg();
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-y")
        // progress 逐行写到 stdout，供后端解析真实进度；-nostats 避免 stderr 刷屏
        .arg("-progress")
        .arg("pipe:1")
        .arg("-nostats");
    if let Some(referer) = req.referer.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-headers")
            .arg(format!("Referer: {}\r\n", referer));
    }
    if let Some(ua) = req.user_agent.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("-user_agent").arg(ua);
    }
    cmd.args(HLS_FETCH_ARGS)
        .arg("-i")
        .arg(url.as_str())
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-f")
        .arg("mp4")
        .arg(out_path);
    cmd
}

/// 把 ffmpeg 的失败状态格式化为可诊断的错误信息。
fn format_convert_error(status: &std::process::ExitStatus, stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    let detail = lines
        .iter()
        .rev()
        .take(3)
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");

    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;

    let exit_info = if let Some(sig) = signal {
        let name = match sig {
            11 => "SIGSEGV（段错误，ffmpeg 崩溃）",
            9 => "SIGKILL（可能被系统 OOM 杀死）",
            6 => "SIGABRT",
            _ => "信号终止",
        };
        format!("ffmpeg 异常退出（信号 {} {}）", sig, name)
    } else {
        format!("ffmpeg 退出码 {}", status.code().unwrap_or(-1))
    };

    if detail.is_empty() {
        format!(
            "视频转换失败：{}，无错误输出（ffmpeg 可能不兼容或崩溃）",
            exit_info
        )
    } else {
        format!("视频转换失败：{} — {}", exit_info, detail)
    }
}

/// 后台转码任务：读 stdout 的进度行算百分比，检测取消标志，按时结束。
async fn run_convert_task(
    task_id: String,
    mut cmd: Command,
    out_path: PathBuf,
    total_duration: f64,
    cancel_flag: Arc<std::sync::atomic::AtomicBool>,
    cancel_notify: Arc<tokio::sync::Notify>,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let table = task_table();
    let work_dir = out_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);

    // 配置 stdout 为管道以读进度，stderr 也捕获用于错误诊断
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            table.fail(
                &task_id,
                format!("无法启动 ffmpeg（请确认服务端已内置）: {}", e),
            );
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return;
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 ffmpeg 进度输出".to_string());
    let mut reader = match stdout {
        Ok(s) => tokio::io::BufReader::new(s),
        Err(e) => {
            table.fail(&task_id, e);
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return;
        }
    };

    let mut line = String::new();
    let mut cancelled = false;
    let mut run_err: Option<String> = None;

    // 逐行解析 -progress 输出；用 select! 同时监听取消信号，
    // 避免 ffmpeg 长时间不输出进度时取消检测不到。
    loop {
        line.clear();
        tokio::select! {
            _ = cancel_notify.notified() => {
                // 收到取消：以标志复核（防止伪唤醒），kill 进程后退出
                if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = child.start_kill();
                    cancelled = true;
                    break;
                }
            }
            n = reader.read_line(&mut line) => {
                match n {
                    Ok(0) => break, // EOF：ffmpeg 已退出
                    Ok(_) => {
                        // 解析 out_time_us=12345678 → 进度百分比
                        if let Some(rest) = line.strip_prefix("out_time_us=") {
                            if let Ok(us) = rest.trim().parse::<u64>() {
                                let pct = compute_progress_percent(us, total_duration);
                                if pct > 0 {
                                    table.set_progress(&task_id, pct);
                                }
                            }
                        }
                        if line.trim() == "progress=end" {
                            if total_duration > 0.0 {
                                table.set_progress(&task_id, 99);
                            }
                        }
                    }
                    Err(e) => {
                        run_err = Some(e.to_string());
                        break;
                    }
                }
            }
        }
    }

    // 等待进程退出，收集 stderr 用于错误诊断
    let mut stderr_text = String::new();
    if let Some(mut err) = child.stderr.take() {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let _ = err.read_to_end(&mut buf).await;
        stderr_text = String::from_utf8_lossy(&buf).into_owned();
    }
    let status = child.wait().await;

    // 取消优先：kill 后 status 可能异常，统一以标志为准标记为 cancelled
    if cancelled || cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
        table.set_status(&task_id, TaskStatus::Cancelled);
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return;
    }

    if let Some(msg) = run_err {
        table.fail(&task_id, msg);
        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        return;
    }
    match status {
        Ok(s) if !s.success() => {
            table.fail(&task_id, format_convert_error(&s, &stderr_text));
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
        }
        Err(e) => {
            table.fail(&task_id, format!("等待 ffmpeg 结束出错: {}", e));
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
        }
        Ok(_) => match tokio::fs::metadata(&out_path).await {
            Ok(meta) if meta.len() > 0 => {
                table.finish(&task_id, out_path);
            }
            _ => {
                table.fail(&task_id, "转换结果为空，请检查视频地址".to_string());
                let _ = tokio::fs::remove_dir_all(&work_dir).await;
            }
        },
    }
}

/// 启动转换任务：立即返回 taskId，后台跑 ffmpeg。
pub async fn convert_video_to_mp4(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<ConvertVideoRequest>,
) -> Result<Json<ApiResponse<StartResponse>>, AppError> {
    let owner = resolve_owner(&state, &auth).await?;
    let url = validate_media_url(&req.url)?;

    // 并发闸门：超过上限时快速失败，避免堆积。permit 移交给后台任务，转完才释放。
    let permit = match convert_semaphore().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return Err(AppError::BadRequest(
                "当前转换任务较多，请稍后重试".to_string(),
            ))
        }
    };

    let file_name = format!(
        "{}.mp4",
        sanitize_download_filename(req.filename.as_deref())
    );
    let task_id = task_table().create(file_name.clone(), owner);

    // 解析总时长（仅 m3u8 有意义；直链则不探测，避免把整个视频 GET 成文本，前端走不确定进度）
    let is_m3u8 = url.path().to_ascii_lowercase().ends_with(".m3u8")
        || url.as_str().to_ascii_lowercase().contains(".m3u8?");
    let total_duration = if is_m3u8 {
        probe_total_duration(&url, req.referer.as_deref(), req.user_agent.as_deref()).await
    } else {
        0.0
    };

    let work_dir = std::env::temp_dir().join(format!("xread-vdl-{}", task_id));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("创建临时目录失败: {}", e)))?;
    task_table().set_work_dir(&task_id, work_dir.clone());
    let out_path = work_dir.join("out.mp4");
    let cmd = build_ffmpeg_command(&req, &url, &out_path);
    let (cancel_flag, cancel_notify) = task_table()
        .cancel_handles(&task_id)
        .expect("刚创建的任务应存在");

    let tid = task_id.clone();
    tokio::spawn(async move {
        // 整体超时兜底：防止 ffmpeg 卡死导致任务永不结束
        match tokio::time::timeout(
            Duration::from_secs(CONVERT_TIMEOUT_SECS),
            run_convert_task(
                tid.clone(),
                cmd,
                out_path,
                total_duration,
                cancel_flag,
                cancel_notify,
                permit,
            ),
        )
        .await
        {
            Ok(()) => {}
            Err(_) => {
                let table = task_table();
                table.fail(&tid, "转换超时，请稍后重试".to_string());
                if let Some(e) = table.get(&tid) {
                    if let Some(dir) = e.work_dir {
                        let _ = tokio::fs::remove_dir_all(&dir).await;
                    }
                }
            }
        }
    });

    Ok(Json(ApiResponse::ok(StartResponse { task_id, file_name })))
}

/// 查询转换进度。
pub async fn convert_video_progress(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(q): Query<TaskQuery>,
) -> Result<Json<ApiResponse<ProgressResponse>>, AppError> {
    let owner = resolve_owner(&state, &auth).await?;
    let entry = task_table()
        .get_owned(&q.task_id, &owner)
        .ok_or_else(|| AppError::BadRequest("任务不存在或已过期".to_string()))?;
    Ok(Json(ApiResponse::ok(ProgressResponse {
        status: entry.status,
        percent: entry.percent,
        error: entry.error,
    })))
}

/// 转换完成后流式返回 mp4 文件。
pub async fn convert_video_result(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(q): Query<TaskQuery>,
) -> Result<Response, AppError> {
    let owner = resolve_owner(&state, &auth).await?;
    let entry = task_table()
        .get_owned(&q.task_id, &owner)
        .ok_or_else(|| AppError::BadRequest("任务不存在或已过期".to_string()))?;
    if entry.status != TaskStatus::Done {
        return Err(AppError::BadRequest("视频尚未转换完成".to_string()));
    }
    let out_path = entry
        .out_path
        .ok_or_else(|| AppError::BadRequest("转换结果不存在".to_string()))?;
    let total = tokio::fs::metadata(&out_path)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("读取转换结果失败: {}", e)))?
        .len();

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
    let disposition = build_content_disposition(&entry.file_name);
    if let Ok(dv) = HeaderValue::from_str(&disposition) {
        resp.headers_mut().insert(header::CONTENT_DISPOSITION, dv);
    }
    if let Ok(len) = HeaderValue::from_str(&total.to_string()) {
        resp.headers_mut().insert(header::CONTENT_LENGTH, len);
    }
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

/// 取消转换任务：置取消标志并 kill ffmpeg 子进程。
pub async fn convert_video_cancel(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<CancelRequest>,
) -> Result<Json<ApiResponse<bool>>, AppError> {
    let owner = resolve_owner(&state, &auth).await?;
    let entry = task_table()
        .get_owned(&req.task_id, &owner)
        .ok_or_else(|| AppError::BadRequest("任务不存在或已过期".to_string()))?;

    // 已结束的任务无需 kill
    if matches!(
        entry.status,
        TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled
    ) {
        return Ok(Json(ApiResponse::ok(true)));
    }

    // 置取消标志 + 唤醒后台任务（notify_one 会保留 permit，即使后台尚未进入等待也不丢失）。
    // 后台任务收到信号后复核标志、kill ffmpeg 并清理。
    if let Some((flag, notify)) = task_table().cancel_handles(&req.task_id) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = task_table().cancel(&req.task_id); // 更新状态为 Cancelled
        notify.notify_one();
    }
    Ok(Json(ApiResponse::ok(true)))
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
    fn compute_progress_percent_maps_time_to_0_99() {
        // 12 秒总时长：3 秒→25%，10.5 秒→88%
        assert_eq!(compute_progress_percent(3_000_000, 12.0), 25);
        assert_eq!(compute_progress_percent(10_500_000, 12.0), 88);
        // 上限钳制到 99（100 仅在 Done 时置）
        assert_eq!(compute_progress_percent(20_000_000, 12.0), 99);
        // 未知时长（直链）返回 0
        assert_eq!(compute_progress_percent(5_000_000, 0.0), 0);
        assert_eq!(compute_progress_percent(5_000_000, -1.0), 0);
    }

    #[test]
    fn locate_ffmpeg_returns_a_path() {
        let _ = locate_ffmpeg();
    }

    #[test]
    fn sanitize_download_filename_strips_dangerous_chars() {
        assert_eq!(
            sanitize_download_filename(Some("皇明 第1集")),
            "皇明_第1集"
        );
        let path = sanitize_download_filename(Some("../../etc/passwd"));
        assert_eq!(path, "etc_passwd");
        assert!(!path.contains('/') && !path.contains('\\'));
        assert_eq!(
            sanitize_download_filename(Some("a/b:c*d?e\"f<g>h|i")),
            "a_b_c_d_e_f_g_h_i"
        );
    }

    #[test]
    fn sanitize_download_filename_falls_back_for_empty_or_reserved() {
        assert_eq!(sanitize_download_filename(None), "video");
        assert_eq!(sanitize_download_filename(Some("   ")), "video");
        assert_eq!(sanitize_download_filename(Some("CON")), "video");
        assert_eq!(sanitize_download_filename(Some("...")), "video");
    }

    #[test]
    fn sanitize_download_filename_limits_length() {
        let long = "书名".repeat(40);
        let safe = sanitize_download_filename(Some(&long));
        assert_eq!(safe.chars().count(), 48);
    }

    #[test]
    fn build_content_disposition_encodes_chinese_and_ascii() {
        let d = build_content_disposition("皇明_第1集");
        assert!(d.contains("filename=\""), "{}", d);
        assert!(d.contains("filename*=UTF-8''"), "{}", d);
        assert!(d.contains("%E7%9A%87%E6%98%8E"), "{}", d);
        assert!(d.contains("_.mp4"), "{}", d);
        let d2 = build_content_disposition("video_01");
        assert!(d2.contains("filename=\"video_01.mp4\""), "{}", d2);
        assert!(d2.contains("filename*=UTF-8''video_01.mp4"), "{}", d2);
    }

    #[cfg(unix)]
    #[test]
    fn format_convert_error_reports_exit_code_and_stderr() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(1 << 8);
        let msg = format_convert_error(&status, "Error opening input: 403 Forbidden\n");
        assert!(msg.contains("退出码 1"), "{}", msg);
        assert!(msg.contains("403 Forbidden"), "{}", msg);
        assert!(!msg.contains("源地址不可用"), "{}", msg);
    }

    #[cfg(unix)]
    #[test]
    fn format_convert_error_reports_signal_when_stderr_empty() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(11);
        let msg = format_convert_error(&status, "");
        assert!(msg.contains("信号 11"), "{}", msg);
        assert!(msg.contains("SIGSEGV"), "{}", msg);
        assert!(msg.contains("无错误输出"), "{}", msg);
    }

    #[cfg(unix)]
    #[test]
    fn format_convert_error_keeps_last_stderr_lines_in_order() {
        use std::os::unix::process::ExitStatusExt;
        let status = std::process::ExitStatus::from_raw(1 << 8);
        let msg = format_convert_error(&status, "first\nsecond\nthird\nfourth\n");
        assert!(msg.contains("second | third | fourth"), "{}", msg);
        assert!(!msg.contains("first"), "{}", msg);
    }
}
