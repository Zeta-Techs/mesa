//! 自定义模型定价文件（<config>/ccode/pricing.json）的读写——定价链最高层
//! （盖过公共能力库 cost 与内置价目）。这里只做带校验的安全落盘。

use std::path::PathBuf;

fn pricing_path() -> Result<PathBuf, String> {
    Ok(crate::dirs::config_dir()
        .ok_or("无法确定平台配置目录")?
        .join("ccode")
        .join("pricing.json"))
}

/// 读取 pricing.json 内容；文件不存在返回空串（前端据此显示占位）
#[tauri::command]
pub fn read_pricing_file() -> Result<String, String> {
    match std::fs::read_to_string(pricing_path()?) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取 pricing.json 失败: {e}")),
    }
}

/// 写入 pricing.json：先校验结构与数值，再原子写（tmp + rename）。
/// 格式：{"模型前缀": [输入价, 输出价], "_rate": 汇率}；价格必须是非负有限数，汇率必须为正
#[tauri::command]
pub fn write_pricing_file(text: String) -> Result<(), String> {
    if !text.trim().is_empty() {
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("不是合法 JSON: {e}"))?;
        let obj = v.as_object().ok_or("pricing.json 必须是 JSON 对象")?;
        for (k, val) in obj {
            if k == "_rate" {
                match val.as_f64() {
                    Some(r) if r.is_finite() && r > 0.0 => {}
                    _ => return Err("_rate 必须是大于 0 的数字".into()),
                }
                continue;
            }
            let arr = val
                .as_array()
                .ok_or_else(|| format!("「{k}」必须是 [输入价, 输出价] 数组"))?;
            if arr.len() != 2 {
                return Err(format!("「{k}」必须恰好 2 个价格（[输入价, 输出价]）"));
            }
            for (i, p) in arr.iter().enumerate() {
                match p.as_f64() {
                    Some(n) if n.is_finite() && n >= 0.0 => {}
                    _ => {
                        let which = if i == 0 { "输入价" } else { "输出价" };
                        return Err(format!("「{k}」的{which}必须是非负数字"));
                    }
                }
            }
        }
    }
    let path = pricing_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &text)
}
