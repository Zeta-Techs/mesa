//! 自定义模型定价文件（<config>/ccode/pricing.json）的读写——定价链最高层
//! （盖过公共能力库 cost 与内置价目）。条目解析（写入校验与用量算费共用）与带校验的安全落盘。

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

/// 一条自定义价（每百万 token）。缓存价不填按输入价折算（读 1 折、写全价，与内置价目同口径）；
/// `cny` = 按人民币填的，算费时用汇率折成美元——国内中转多按人民币标价，原样填不用自己换算（2026-11-07）
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct CustomPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub cny: bool,
}

/// 解析一条：老格式 `[输入价, 输出价]`（美元），或
/// `{"input", "output", "cacheRead"?, "cacheWrite"?, "currency"?: "USD" | "CNY"}`。写入校验与用量算费共用这一个口径
pub(crate) fn parse_entry(key: &str, val: &serde_json::Value) -> Result<CustomPrice, String> {
    let num = |v: Option<&serde_json::Value>, which: &str| -> Result<f64, String> {
        match v.and_then(|x| x.as_f64()) {
            Some(n) if n.is_finite() && n >= 0.0 => Ok(n),
            _ => Err(format!("「{key}」的{which}必须是非负数字")),
        }
    };
    if let Some(arr) = val.as_array() {
        if arr.len() != 2 {
            return Err(format!("「{key}」必须恰好 2 个价格（[输入价, 输出价]）"));
        }
        return Ok(CustomPrice {
            input: num(arr.first(), "输入价")?,
            output: num(arr.get(1), "输出价")?,
            cache_read: None,
            cache_write: None,
            cny: false,
        });
    }
    let obj = val
        .as_object()
        .ok_or_else(|| format!("「{key}」必须是 [输入价, 输出价] 或带 input / output 的对象"))?;
    let optional = |k: &str, which: &str| -> Result<Option<f64>, String> {
        match obj.get(k) {
            None | Some(serde_json::Value::Null) => Ok(None),
            v => num(v, which).map(Some),
        }
    };
    let cny = match obj.get("currency").and_then(|c| c.as_str()) {
        None | Some("USD") => false,
        Some("CNY") => true,
        Some(other) => return Err(format!("「{key}」的币种只能是 USD 或 CNY，不是 {other}")),
    };
    Ok(CustomPrice {
        input: num(obj.get("input"), "输入价")?,
        output: num(obj.get("output"), "输出价")?,
        cache_read: optional("cacheRead", "缓存读价")?,
        cache_write: optional("cacheWrite", "缓存写价")?,
        cny,
    })
}

/// 整份文件里能用的条目：空前缀（会匹配一切模型）与下划线键（`_rate` 等）跳过，坏条目跳过不连坐
pub(crate) fn parse_entries(text: &str) -> Vec<(String, CustomPrice)> {
    let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    obj.iter()
        .filter(|(k, _)| !k.trim().is_empty() && !k.starts_with('_'))
        .filter_map(|(k, v)| parse_entry(k, v).ok().map(|p| (k.to_lowercase(), p)))
        .collect()
}

/// 写入 pricing.json：先校验结构与数值，再原子写（tmp + rename）。
/// 格式：{"模型前缀": [输入价, 输出价] 或对象（见 parse_entry）, "_rate": 汇率}；价格必须是非负有限数，汇率必须为正
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
            parse_entry(k, val)?;
        }
    }
    let path = pricing_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    crate::profiles::atomic_write(&path, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_entry_reads_legacy_pair_and_full_object() {
        let legacy = parse_entry("m", &serde_json::json!([1.0, 5.0])).unwrap();
        assert_eq!((legacy.input, legacy.output, legacy.cache_read, legacy.cny), (1.0, 5.0, None, false));
        let full = parse_entry(
            "m",
            &serde_json::json!({"input": 4, "output": 16, "cacheRead": 1, "cacheWrite": 5, "currency": "CNY"}),
        )
        .unwrap();
        assert_eq!(full, CustomPrice { input: 4.0, output: 16.0, cache_read: Some(1.0), cache_write: Some(5.0), cny: true });
        assert!(parse_entry("m", &serde_json::json!({"input": 1, "output": -1})).is_err());
        assert!(parse_entry("m", &serde_json::json!({"input": 1, "output": 1, "currency": "EUR"})).is_err());
        assert!(parse_entry("m", &serde_json::json!([1.0])).is_err());
    }

    #[test]
    fn parse_entries_skips_rate_blank_and_bad_rows() {
        let got = parse_entries(r#"{"_rate": 7.1, "": [1, 1], "Bad": "x", "Kimi-K3": {"input": 3, "output": 15}}"#);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "kimi-k3");
    }
}
