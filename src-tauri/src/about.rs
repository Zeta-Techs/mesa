//! 「关于」分区的只读法律与构建信息。
//!
//! 第三方许可清单由 `npm run gen:notices`（scripts/gen-third-party-notices.mjs）
//! 生成进 resources、编译期嵌进二进制——dev 与打包版同一份；OFL/MIT 等许可的
//! 「随包携带声明」义务由 bundle.resources 的同名文件 + 本命令的界面出口共同履行。
//! 构建信息用于关于页辨认安装包类型（Intel 自构建版撞更新清单等问题）。

/// 随包第三方开源许可清单（Markdown，构建期生成，勿手改）
const THIRD_PARTY_NOTICES_MD: &str = include_str!("../resources/third-party-notices.md");

/// 关于页展示的构建信息（嵌 camelCase DTO；`channel` 区分 dev/release 构建）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfoDto {
    pub os: String,
    pub arch: String,
    pub channel: String,
}

#[tauri::command]
pub fn read_third_party_notices() -> String {
    THIRD_PARTY_NOTICES_MD.to_string()
}

#[tauri::command]
pub fn build_info() -> BuildInfoDto {
    BuildInfoDto {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        channel: if cfg!(debug_assertions) { "dev" } else { "release" }.to_string(),
    }
}
