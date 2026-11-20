//! 本地 HTML 预览的专用协议 `mesa-html`（2026-11-20 用户拍板：预览里也能播动画、跑交互）。
//!
//! srcdoc / blob / data 框会继承主窗口 CSP（`script-src 'self'`），内联脚本一律被拦，所以预览页要有自己的
//! 响应头：前端把拼好的整页（本地 CSS / 图 / 脚本已内联）交给 `html_preview_put` 换一个一次性地址，
//! 本协议按地址吐出页面并附带 [`PAGE_CSP`]。隔离靠三层：CSP `sandbox` 与 iframe sandbox 都不给
//! `allow-same-origin`（不透明源，碰不到主窗口）；Tauri 的 IPC 脚本与调用密钥只注入主框架，
//! 框里的脚本拿不到密钥、调不了任何命令；`connect-src 'none'` 不让脚本自己联网收发。

use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "mesa-html";

/// 只放行页面自带的内联脚本 / 样式和 https 静态资源（CDN 上的图表库、字体、图片），
/// 不放行 fetch / XHR / WebSocket；表单、嵌套框架、插件一律不给
const PAGE_CSP: &str = "sandbox allow-scripts allow-popups allow-downloads; \
default-src 'none'; \
script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:; \
style-src 'unsafe-inline' data: blob: https:; \
img-src data: blob: https:; \
font-src data: blob: https:; \
media-src data: blob: https:; \
worker-src data: blob:; \
connect-src 'none'; \
frame-src 'none'; \
object-src 'none'; \
form-action 'none'; \
base-uri 'none'";

/// 同时开着的预览很少超过几个；超出按先进先出丢最早的（框只在挂上时取一次页面）
const MAX_PAGES: usize = 8;

static PAGES: Mutex<VecDeque<(String, Vec<u8>)>> = Mutex::new(VecDeque::new());

fn put(html: String) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut pages = PAGES.lock().unwrap_or_else(|e| e.into_inner());
    while pages.len() >= MAX_PAGES {
        pages.pop_front();
    }
    pages.push_back((token.clone(), html.into_bytes()));
    token
}

fn release(token: &str) {
    let mut pages = PAGES.lock().unwrap_or_else(|e| e.into_inner());
    pages.retain(|(t, _)| t != token);
}

fn page(token: &str) -> Option<Vec<u8>> {
    let pages = PAGES.lock().unwrap_or_else(|e| e.into_inner());
    pages.iter().find(|(t, _)| t == token).map(|(_, b)| b.clone())
}

/// 登记一页预览，返回地址里用的一次性令牌（前端 `convertFileSrc(token, "mesa-html")` 拼成各平台地址）
#[tauri::command]
pub fn html_preview_put(html: String) -> String {
    put(html)
}

/// 预览框卸下时释放
#[tauri::command]
pub fn html_preview_release(token: String) {
    release(&token);
}

/// 协议入口：`mesa-html://localhost/<令牌>`（Windows 为 `http://mesa-html.localhost/<令牌>`）
pub fn serve(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let token = request.uri().path().trim_start_matches('/');
    let body = if request.method() == tauri::http::Method::GET {
        page(token)
    } else {
        None
    };
    let builder = Response::builder()
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    match body {
        Some(bytes) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, PAGE_CSP)
            .header(header::REFERRER_POLICY, "no-referrer")
            .body(bytes),
        None => builder
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Vec::new()),
    }
    .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(path: &str) -> Response<Vec<u8>> {
        let req = Request::builder()
            .uri(format!("{SCHEME}://localhost{path}"))
            .body(Vec::new())
            .unwrap();
        serve(&req)
    }

    #[test]
    fn serves_page_with_isolating_csp_until_released() {
        let token = put("<script>tick()</script>".into());
        let res = get(&format!("/{token}"));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"<script>tick()</script>");
        let csp = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(csp.starts_with("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("allow-top-navigation"));
        assert!(csp.contains("connect-src 'none'"));
        release(&token);
        assert_eq!(get(&format!("/{token}")).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn unknown_token_and_non_get_are_not_served() {
        assert_eq!(get("/nope").status(), StatusCode::NOT_FOUND);
        let token = put("x".into());
        let req = Request::builder()
            .method("POST")
            .uri(format!("{SCHEME}://localhost/{token}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(serve(&req).status(), StatusCode::NOT_FOUND);
        release(&token);
    }
}
