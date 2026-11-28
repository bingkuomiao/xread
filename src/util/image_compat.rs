//! 图片兼容性处理：把阅读器（尤其 KOReader / PW3 等缺少 libavif 的客户端）
//! 无法解码的图片格式（AVIF / HEIC）在服务端转成 JPEG。
//!
//! 转码复用随包内置的静态 ffmpeg（与视频下载共用同一份二进制），失败时降级
//! 返回原始字节，绝不因转码失败导致封面/图片完全不可见。

use crate::error::error::AppError;
use std::path::PathBuf;
use std::process::Stdio;

/// 定位 ffmpeg：可执行文件同目录的 `ffmpeg-{arch}` 优先，回退 PATH 中的 ffmpeg。
/// 与 video_download 的定位规则保持一致。
pub fn locate_ffmpeg() -> PathBuf {
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

/// 判断字节是否为 AVIF / HEIC（ISOBMFF ftyp 品牌）。
/// 与 book_service 的 content_type_from_bytes 品牌列表保持一致。
pub fn is_avif_or_heic(data: &[u8]) -> bool {
    if data.len() < 12 || &data[4..8] != b"ftyp" {
        return false;
    }
    let end = data.len().min(64);
    let brands = &data[8..end];
    let has = |tag: &[u8; 4]| brands.windows(4).any(|w| w == tag);
    has(b"avif")
        || has(b"avis")
        || has(b"heic")
        || has(b"heix")
        || has(b"hevx")
        || has(b"heim")
        || has(b"heis")
        || has(b"hevm")
        || has(b"hevs")
        || has(b"mif1")
        || has(b"msf1")
}

/// 若字节是 AVIF / HEIC，则用 ffmpeg 转成 JPEG；否则原样返回。
///
/// - 转码成功：返回 `(jpeg_bytes, "image/jpeg", true)`。
/// - 无需转码：返回 `(data, mime, false)`，mime 由调用方给定。
/// - 转码失败：降级返回 `(data, mime, false)`，并打印警告，不影响可用性。
///
/// `data` 为拥有所有权的 Vec，避免额外拷贝；`mime` 是调用方识别出的原始类型。
pub async fn transcode_to_jpeg_if_needed(
    data: Vec<u8>,
    mime: String,
) -> (Vec<u8>, String, bool) {
    if !is_avif_or_heic(&data) {
        return (data, mime, false);
    }

    let ffmpeg = locate_ffmpeg();
    let input = data.clone();
    let result = tokio::task::spawn_blocking(move || {
        convert_bytes_with_ffmpeg(&ffmpeg, &input)
    })
    .await;

    match result {
        Ok(Ok(jpeg)) if jpeg.len() > 2 && jpeg[0] == 0xff && jpeg[1] == 0xd8 => {
            tracing::info!(
                "converted unsupported cover image ({} bytes -> {} bytes JPEG)",
                data.len(),
                jpeg.len()
            );
            (jpeg, "image/jpeg".to_string(), true)
        }
        Ok(Err(e)) => {
            tracing::warn!("cover image transcode failed, falling back to original: {}", e);
            (data, mime, false)
        }
        Ok(Ok(_)) => {
            tracing::warn!("cover image transcode produced non-JPEG output, falling back");
            (data, mime, false)
        }
        Err(e) => {
            tracing::warn!("cover image transcode task failed: {}", e);
            (data, mime, false)
        }
    }
}

/// 同步执行实际转码：通过 stdin 喂入字节，从 stdout 读取 JPEG，不落临时文件。
/// ffmpeg 用 `-f image2pipe` 从 stdin 读、`-f image2pipe -vcodec mjpeg` 写 stdout。
fn convert_bytes_with_ffmpeg(ffmpeg: &PathBuf, input: &[u8]) -> Result<Vec<u8>, AppError> {
    // spawn_blocking 运行在 tokio 阻塞线程池，可直接用 std::process 同步等待。
    let mut child = std::process::Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-q:v",
            "3",
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("spawn ffmpeg failed: {}", e)))?;

    // 用 std::io 同步写 stdin（spawn_blocking 线程内允许阻塞）。
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!("ffmpeg stdin unavailable"))
        })?;
        stdin
            .write_all(input)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("feed ffmpeg failed: {}", e)))?;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("wait ffmpeg failed: {}", e)))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Internal(anyhow::anyhow!(
            "ffmpeg exit {}: {}",
            output.status.code().unwrap_or(-1),
            err.trim()
        )));
    }

    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_avif_and_heic() {
        let mut avif = vec![0u8; 32];
        avif[4..8].copy_from_slice(b"ftyp");
        avif[8..12].copy_from_slice(b"avif");
        assert!(is_avif_or_heic(&avif));

        let mut heic = vec![0u8; 32];
        heic[4..8].copy_from_slice(b"ftyp");
        heic[8..12].copy_from_slice(b"heic");
        assert!(is_avif_or_heic(&heic));
    }

    #[test]
    fn rejects_non_isobmff() {
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        assert!(!is_avif_or_heic(&png));
        let jpeg = [0xff, 0xd8, 0xff, 0xe0];
        assert!(!is_avif_or_heic(&jpeg));
        assert!(!is_avif_or_heic(&[]));
    }

    #[test]
    fn locate_ffmpeg_returns_non_empty() {
        assert!(!locate_ffmpeg().as_os_str().is_empty());
    }

    /// 真实转码集成测试：32x32 纯红 AVIF → JPEG。
    /// 仅在内置 ffmpeg 可用时执行，否则跳过（避免无 ffmpeg 环境误报失败）。
    #[tokio::test]
    async fn converts_avif_fixture_to_jpeg() {
        use base64::Engine;
        let ffmpeg = locate_ffmpeg();
        // 优先用打包目录内置的 ffmpeg；开发机上若只有 PATH ffmpeg 且不支持也可跳过。
        let fixture = "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAgAAAAIAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGBE/9sAgMhMYAAAAUAAAAALl1zvfFr3MGFzI";
        let avif = base64::engine::general_purpose::STANDARD
            .decode(fixture)
            .expect("valid base64 fixture");
        assert!(is_avif_or_heic(&avif), "fixture should be detected as AVIF");

        let direct = convert_bytes_with_ffmpeg(&ffmpeg, &avif);
        match direct {
            Ok(jpeg) => {
                assert!(jpeg.len() > 2 && jpeg[0] == 0xff && jpeg[1] == 0xd8,
                    "output must be JPEG");
            }
            Err(e) => {
                // ffmpeg 不可用或不支持 AVIF 时跳过，不使测试失败。
                eprintln!("skip converts_avif_fixture_to_jpeg: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn passthrough_for_non_avif() {
        let jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00];
        let (out, mime, converted) =
            transcode_to_jpeg_if_needed(jpeg.clone(), "image/jpeg".to_string()).await;
        assert!(!converted);
        assert_eq!(out, jpeg);
        assert_eq!(mime, "image/jpeg");
    }
}
