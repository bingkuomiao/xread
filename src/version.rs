/// 对外展示用的应用版本号。
///
/// Cargo 的 `version` 字段遵循 semver，核心版本最多三段（major.minor.patch），
/// 因此 `1.0.48.5` 无法直接作为 Cargo 版本（会编译失败）。Cargo.toml 使用合法的
/// `1.0.48+5`（build metadata），而 App 内展示、更新检查 UA 统一使用本常量，
/// 使后端对外显示的版本号为 `1.0.48.5`。
pub const APP_VERSION: &str = "1.0.48.7";
