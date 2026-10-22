//! OSC 7501 程序状态协议（Program Status Protocol）：CLI 自己把「空闲 / 在干活 / 卡住 / 完成 / 出错」写进终端输出流。
//!
//! 终端先回答 `OSC 7501 ; ?`（term_query.rs，只对开了这条旁路的标签答），支持的 CLI 才开始报；Codex 不问也报。
//! 2026-10-22 本机实测：Claude Code 2.1.306 在干净环境里问（继承了 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` 就不问），
//! 答了报 `state=idle:app=claude-code`；Grok 1.0.67 问，信任菜单报 `blocked:kind=permission:msg=Trust this folder?`，
//! 干活时 msg 是它自己的进度一句（`Waiting for response…`、`Connection failed | Retrying (1/15)`）；
//! Codex 0.163 不问也报 idle / working。规格见 superlogical.com/rex/docs/build/program-status，
//! 机制参照 Orca（MIT，`.reference/orca/src/shared/program-status/`），这里是自己的实现。
//!
//! 只认根记录（不带 id 的那条）：子记录（子 agent）聊天层用不上。msg / title 是 base64 的 UTF-8，
//! 解出来含控制字符、超长都整条丢掉——别的程序也能往终端里写这串，当不可信输入处理。

/// 终端对 `OSC 7501 ; ?` 的唯一应答：列出认得的状态与卡住原因
pub(crate) const QUERY_REPLY: &str =
    "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

const PREFIX: &[u8] = b"\x1b]7501;";
/// 整条序列（OSC 到 ST）上限
const MAX_SEQUENCE: usize = 4096;
const MAX_MSG_ENCODED: usize = 2732;
const MAX_MSG_DECODED: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum State {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
    Clear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BlockedKind {
    Permission,
    Question,
    Auth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Report {
    pub state: State,
    pub kind: Option<BlockedKind>,
    pub msg: Option<String>,
}

fn base64_val(b: u8) -> Option<u32> {
    Some(match b {
        b'A'..=b'Z' => b - b'A',
        b'a'..=b'z' => b - b'a' + 26,
        b'0'..=b'9' => b - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    } as u32)
}

/// 解 base64（允许省略补位），得到单行文字；不合规、超长、含控制字符返回 None
fn decode_text(encoded: &str) -> Option<String> {
    if encoded.len() > MAX_MSG_ENCODED {
        return None;
    }
    let body = encoded.trim_end_matches('=');
    if encoded.len() - body.len() > 2 || body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for b in body.bytes() {
        acc = (acc << 6) | base64_val(b)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if out.len() > MAX_MSG_DECODED {
        return None;
    }
    let text = String::from_utf8(out).ok()?;
    if text.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(text)
}

/// 解析 `OSC 7501 ;` 与终止符之间的正文。查询（`?`）与不是根记录的报告返回 None
pub(crate) fn parse_body(body: &str) -> Option<Report> {
    if body.len() > MAX_SEQUENCE || body.trim() == "?" {
        return None;
    }
    let mut state = None;
    let mut kind = None;
    let mut msg = None;
    for pair in body.split(':') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim());
        if key.len() > 16 {
            return None;
        }
        match key {
            // 子记录（子 agent）不要；根记录不带 id
            "id" => return None,
            "state" => {
                state = Some(match value {
                    "idle" => State::Idle,
                    "working" => State::Working,
                    "done" => State::Done,
                    "blocked" => State::Blocked,
                    "error" => State::Error,
                    "clear" => State::Clear,
                    _ => return None,
                })
            }
            "kind" => {
                kind = match value {
                    "permission" => Some(BlockedKind::Permission),
                    "question" => Some(BlockedKind::Question),
                    "auth" => Some(BlockedKind::Auth),
                    _ => None,
                }
            }
            // 超限的整条作废，不让后面的同名键把它洗掉
            "msg" => msg = Some(decode_text(value)?),
            _ => {}
        }
    }
    let state = state?;
    Some(Report {
        state,
        kind: if state == State::Blocked { kind } else { None },
        msg: msg.filter(|m| !m.trim().is_empty()),
    })
}

/// 跨读取块找报告；半截序列留到下一块
#[derive(Default)]
pub(crate) struct ReportScanner {
    tail: Vec<u8>,
}

impl ReportScanner {
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<Report> {
        let mut hay = std::mem::take(&mut self.tail);
        hay.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut i = 0;
        while let Some(off) = hay[i..].iter().position(|&b| b == 0x1b) {
            let at = i + off;
            let rest = &hay[at..];
            if rest.len() < PREFIX.len() {
                if PREFIX.starts_with(rest) {
                    self.tail = rest.to_vec();
                }
                break;
            }
            if !rest.starts_with(PREFIX) {
                i = at + 1;
                continue;
            }
            let body_start = PREFIX.len();
            // 终止符：BEL 或 ESC \
            let end = rest[body_start..]
                .iter()
                .position(|&b| b == 0x07 || b == 0x1b)
                .map(|p| body_start + p);
            match end {
                None => {
                    if rest.len() <= MAX_SEQUENCE {
                        self.tail = rest.to_vec();
                    }
                    break;
                }
                Some(e) => {
                    let term_len = if rest[e] == 0x07 {
                        1
                    } else {
                        match rest.get(e + 1) {
                            None => {
                                self.tail = rest.to_vec();
                                break;
                            }
                            Some(b'\\') => 2,
                            // ESC 后面不是 \：不是合规的终止，整条跳过
                            Some(_) => {
                                i = at + e;
                                continue;
                            }
                        }
                    };
                    if let Ok(body) = std::str::from_utf8(&rest[body_start..e]) {
                        if let Some(r) = parse_body(body) {
                            out.push(r);
                        }
                    }
                    i = at + e + term_len;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes = s.as_bytes();
        let mut out = String::new();
        for c in bytes.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for k in 0..=c.len() {
                out.push(T[(n >> (18 - 6 * k) & 63) as usize] as char);
            }
        }
        out
    }

    #[test]
    fn parses_grok_trust_prompt_report() {
        // 本机抓到的 Grok 1.0.67 原样（msg 不带补位）
        let body = format!("state=blocked:kind=permission:app=grok-build:msg={}", b64("Trust this folder?"));
        assert_eq!(
            parse_body(&body),
            Some(Report {
                state: State::Blocked,
                kind: Some(BlockedKind::Permission),
                msg: Some("Trust this folder?".into()),
            })
        );
    }

    #[test]
    fn kind_only_counts_when_blocked_and_children_are_ignored() {
        let r = parse_body("state=working:kind=permission:app=codex").unwrap();
        assert_eq!((r.state, r.kind), (State::Working, None));
        assert_eq!(parse_body("state=working:id=agent/1"), None);
        assert_eq!(parse_body("?"), None);
        assert_eq!(parse_body("kind=auth"), None);
        assert_eq!(parse_body("state=sleeping"), None);
    }

    #[test]
    fn hostile_msg_voids_the_report() {
        assert_eq!(parse_body(&format!("state=working:msg={}", b64("a\x1b[2Jb"))), None);
        assert_eq!(parse_body("state=working:msg=@@@"), None);
        let long = b64(&"x".repeat(MAX_MSG_DECODED + 1));
        assert_eq!(parse_body(&format!("state=working:msg={long}")), None);
        // 中文照常解
        let r = parse_body(&format!("state=working:msg={}", b64("写入命令…"))).unwrap();
        assert_eq!(r.msg.as_deref(), Some("写入命令…"));
    }

    #[test]
    fn scanner_finds_reports_across_chunks_and_skips_queries() {
        let mut s = ReportScanner::default();
        let msg = b64("Waiting for response…");
        let seq = format!("text\x1b]7501;?\x1b\\\x1b[c\x1b]7501;state=working:app=grok-build:msg={msg}\x07tail");
        let bytes = seq.as_bytes();
        let mut got = Vec::new();
        for piece in bytes.chunks(7) {
            got.extend(s.feed(piece));
        }
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].state, State::Working);
        assert_eq!(got[0].msg.as_deref(), Some("Waiting for response…"));
        // ST 结尾也认
        assert_eq!(s.feed(b"\x1b]7501;state=idle:app=claude-code\x1b\\").len(), 1);
        // 别的 OSC 不当回事
        assert!(s.feed(b"\x1b]0;title\x07\x1b]7502;state=idle\x07").is_empty());
    }
}
