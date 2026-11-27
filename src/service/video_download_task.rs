//! 视频转换下载任务表：支撑真实进度百分比与取消操作。
//!
//! 设计：
//! - 每个转换任务一个 task_id（UUID），状态存在内存表里；任务完成后结果文件保留一段时间供下载，
//!   之后由清理任务删除临时目录，避免磁盘泄漏。
//! - 后台 ffmpeg 进程把 `-progress pipe:1` 的进度逐行上报到任务表，前端轮询 progress 接口即可
//!   拿到真实百分比（out_time_us / 总时长）。总时长来自解析 m3u8 的 EXTINF 之和。
//! - 取消：置 cancelled 标志，后台任务在进度循环里检测到后 kill ffmpeg 子进程并清理。

use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock, RwLock},
    time::Instant,
};

/// 任务状态。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    /// 正在解析源/启动 ffmpeg
    Pending,
    /// 正在转换
    Running,
    /// 转换完成，可下载
    Done,
    /// 转换失败
    Failed,
    /// 用户取消
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct TaskEntry {
    pub status: TaskStatus,
    /// 任务归属用户命名空间，用于隔离，防止他人凭 taskId 下载
    pub owner: String,
    /// 0-100 的真实进度
    pub percent: u8,
    pub error: String,
    /// 结果文件名（已清洗，含 .mp4）
    pub file_name: String,
    /// 结果文件路径（仅 Done 有）
    pub out_path: Option<std::path::PathBuf>,
    /// 临时工作目录（用于清理）
    pub work_dir: Option<std::path::PathBuf>,
    /// 取消标志：后台任务据此判定是否已取消（先置标志再发通知，避免竞态丢失）
    pub cancel_flag: Arc<std::sync::atomic::AtomicBool>,
    /// 取消信号：后台任务用 select! 监听，收到后立即 kill ffmpeg，无需轮询等待进度行
    pub cancel_notify: Arc<tokio::sync::Notify>,
    /// 创建时间，用于 TTL 清理
    pub created_at: Instant,
    /// 上次状态更新时间，用于超时判定
    pub updated_at: Instant,
}

impl TaskEntry {
    fn new(file_name: String, owner: String) -> Self {
        let now = Instant::now();
        Self {
            status: TaskStatus::Pending,
            owner,
            percent: 0,
            error: String::new(),
            file_name,
            out_path: None,
            work_dir: None,
            cancel_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cancel_notify: Arc::new(tokio::sync::Notify::new()),
            created_at: now,
            updated_at: now,
        }
    }
}

/// 任务表（全局单例）。
#[derive(Debug, Default)]
pub struct TaskTable {
    tasks: RwLock<HashMap<String, TaskEntry>>,
}

static TABLE: OnceLock<Arc<TaskTable>> = OnceLock::new();

pub fn task_table() -> Arc<TaskTable> {
    TABLE.get_or_init(|| Arc::new(TaskTable::default())).clone()
}

impl TaskTable {
    /// 新建任务，返回 task_id。
    pub fn create(&self, file_name: String, owner: String) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.tasks
            .write()
            .unwrap()
            .insert(id.clone(), TaskEntry::new(file_name, owner));
        id
    }

    pub fn get(&self, id: &str) -> Option<TaskEntry> {
        self.tasks.read().unwrap().get(id).cloned()
    }

    /// 取任务并校验归属，防止跨用户凭 taskId 下载/取消。
    pub fn get_owned(&self, id: &str, owner: &str) -> Option<TaskEntry> {
        self.get(id).filter(|e| e.owner == owner)
    }

    fn update<F: FnOnce(&mut TaskEntry)>(&self, id: &str, f: F) {
        if let Some(entry) = self.tasks.write().unwrap().get_mut(id) {
            entry.updated_at = Instant::now();
            f(entry);
        }
    }

    pub fn set_status(&self, id: &str, status: TaskStatus) {
        self.update(id, |e| e.status = status);
    }

    pub fn set_work_dir(&self, id: &str, dir: std::path::PathBuf) {
        self.update(id, |e| e.work_dir = Some(dir));
    }

    pub fn set_progress(&self, id: &str, percent: u8) {
        self.update(id, |e| {
            // 进度单调递增，避免 ffmpeg 输出抖动导致回退
            if percent > e.percent {
                e.percent = percent.min(99); // 100 仅在 Done 时置
            }
            e.status = TaskStatus::Running;
        });
    }

    pub fn finish(&self, id: &str, out_path: std::path::PathBuf) {
        self.update(id, |e| {
            e.status = TaskStatus::Done;
            e.percent = 100;
            e.out_path = Some(out_path);
        });
    }

    pub fn fail(&self, id: &str, error: String) {
        self.update(id, |e| {
            e.status = TaskStatus::Failed;
            e.error = error;
        });
    }

    pub fn cancel(&self, id: &str) -> bool {
        let flag = {
            let tasks = self.tasks.read().unwrap();
            match tasks.get(id) {
                Some(e) => {
                    if matches!(e.status, TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled) {
                        return false;
                    }
                    e.cancel_flag.clone()
                }
                None => return false,
            }
        };
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        self.update(id, |e| e.status = TaskStatus::Cancelled);
        true
    }

    pub fn cancel_flag(&self, id: &str) -> Option<Arc<std::sync::atomic::AtomicBool>> {
        self.tasks.read().unwrap().get(id).map(|e| e.cancel_flag.clone())
    }

    /// 取消句柄：拿到取消标志与通知，供取消接口置位 + 唤醒后台任务。
    pub fn cancel_handles(
        &self,
        id: &str,
    ) -> Option<(
        Arc<std::sync::atomic::AtomicBool>,
        Arc<tokio::sync::Notify>,
    )> {
        self.tasks
            .read()
            .unwrap()
            .get(id)
            .map(|e| (e.cancel_flag.clone(), e.cancel_notify.clone()))
    }

    /// 清理超时/过期任务的结果文件与临时目录。
    /// - 完成/失败/取消的任务：保留 10 分钟（供下载），之后删除文件。
    /// - 一直卡在 Pending/Running 超过 10 分钟：强制删除（异常兜底）。
    pub fn cleanup_expired(&self) {
        let ttl = std::time::Duration::from_secs(600);
        let now = Instant::now();
        let mut to_remove: Vec<String> = Vec::new();
        let mut dirs_to_delete: Vec<std::path::PathBuf> = Vec::new();
        {
            let tasks = self.tasks.read().unwrap();
            for (id, e) in tasks.iter() {
                let terminal = matches!(e.status, TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled);
                let expired = now.duration_since(if terminal { e.updated_at } else { e.created_at }) > ttl;
                if expired {
                    if let Some(dir) = &e.work_dir {
                        dirs_to_delete.push(dir.clone());
                    }
                    to_remove.push(id.clone());
                }
            }
        }
        if !to_remove.is_empty() {
            let mut tasks = self.tasks.write().unwrap();
            for id in &to_remove {
                tasks.remove(id);
            }
        }
        for dir in dirs_to_delete {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// 从 m3u8 文本解析总时长（秒）：累加所有 #EXTINF 的数值。
/// 兼容 master playlist：若含 #EXT-X-STREAM-INF，调用方应先用 resolve_media_playlist 取子列表。
pub fn parse_m3u8_duration(text: &str) -> f64 {
    let mut total = 0.0;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            // 形如 "2.400000," 或 "2.4,标题"
            let num = rest.split(',').next().unwrap_or("").trim();
            if let Ok(v) = num.parse::<f64>() {
                if v > 0.0 && v.is_finite() {
                    total += v;
                }
            }
        }
    }
    total
}

/// 若 m3u8 是 master playlist，返回第一个子 playlist 的绝对 URL；否则返回 None。
pub fn first_variant_url(master: &str, base: &url::Url) -> Option<String> {
    let mut lines = master.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim().starts_with("#EXT-X-STREAM-INF") {
            // 下一条非注释行是子 playlist 地址
            while let Some(next) = lines.next() {
                let t = next.trim();
                if t.is_empty() || t.starts_with('#') {
                    continue;
                }
                return base.join(t).ok().map(|u| u.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duration_sums_extinf() {
        let m3u8 = "#EXTM3U\n#EXTINF:2.4,\na.ts\n#EXTINF:1.92,\nb.ts\n#EXTINF:1.92,\nc.ts\n#EXT-X-ENDLIST\n";
        let d = parse_m3u8_duration(m3u8);
        assert!((d - 6.24).abs() < 0.001, "{}", d);
    }

    #[test]
    fn parse_duration_ignores_invalid() {
        let m3u8 = "#EXTM3U\n#EXTINF:abc,\na.ts\n#EXTINF:3,title\nb.ts\n";
        assert!((parse_m3u8_duration(m3u8) - 3.0).abs() < 0.001);
    }

    #[test]
    fn first_variant_resolves_relative() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720p/index.m3u8\n";
        let base = url::Url::parse("https://example.com/v/master.m3u8").unwrap();
        assert_eq!(
            first_variant_url(master, &base).as_deref(),
            Some("https://example.com/v/720p/index.m3u8")
        );
    }

    #[test]
    fn task_lifecycle() {
        let t = TaskTable::default();
        let id = t.create("书_第1集.mp4".to_string(), "user-a".to_string());
        assert_eq!(t.get(&id).unwrap().status, TaskStatus::Pending);
        // 跨用户隔离
        assert!(t.get_owned(&id, "user-b").is_none());
        assert!(t.get_owned(&id, "user-a").is_some());
        t.set_progress(&id, 50);
        assert_eq!(t.get(&id).unwrap().percent, 50);
        t.set_progress(&id, 30); // 回退应被忽略
        assert_eq!(t.get(&id).unwrap().percent, 50);
        t.finish(&id, std::path::PathBuf::from("/tmp/x.mp4"));
        let e = t.get(&id).unwrap();
        assert_eq!(e.status, TaskStatus::Done);
        assert_eq!(e.percent, 100);
        assert!(e.out_path.is_some());
        assert!(!t.cancel(&id)); // 完成后不能再取消
    }
}
