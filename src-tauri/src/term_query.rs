//! 终端能力查询的应答（DA1 / XTVERSION / Kitty 键盘 / modifyOtherKeys / XTGETTCAP），在 PTY 读线程里当场答。
//!
//! 应答表与 `src/terminal-protocols.ts` 的 `replyToTerminalQuery` 逐条一致（双端镜像：前端仍从画面字节里剥掉
//! 这些查询、跟踪 Kitty 推栈，但不再回写）。挪到后端的原因：前端要等输出事件到了才答，标签在后台时输出进 backlog，
//! 切回来才补发，应答晚到——CLI 的探测窗口早关了（Gemini 只等 1 秒），迟到的应答被当成按键打进输入框，
//! 跟着下一条消息发出去（2026-10-21 Windows 实证：Gemini 第二条消息开头带着「5u>|Mesa (xterm.js 6.0.0)」）。

/// 消歧义（1）+ 报告备用键（4），同 terminal-protocols.ts KKP_FLAGS
const KKP_FLAGS: u32 = 5;
/// 同 terminal-protocols.ts TERM_NAME
const TERM_NAME: &str = "Mesa (xterm.js 6.0.0)";
/// terminfo Ms 能力的十六进制（XTGETTCAP 应答值），同 terminal-protocols.ts
const XTGETTCAP_MS_VALUE: &str = "1b5d35323b25633b25703273257307";
/// 半截查询最长攒这么多字节；再长按正文放行（同前端 QUERY_WINDOW）
const QUERY_WINDOW: usize = 1200;

enum Parse {
    /// 完整查询：长度 + 应答（None = 认得但不答，如 Kitty 弹栈）
    Query(usize, Option<String>),
    /// 断在帧尾，等下一块
    Partial,
    NotQuery,
}

/// 跨读取块扫描查询；半截序列留到下一块再判
#[derive(Default)]
pub(crate) struct QueryScanner {
    tail: Vec<u8>,
}

impl QueryScanner {
    /// 喂一块输出，返回这块里（含上一块留下的半截）完整查询的应答，按出现顺序
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut hay = std::mem::take(&mut self.tail);
        hay.extend_from_slice(chunk);
        let mut replies = Vec::new();
        let mut i = 0;
        while let Some(off) = hay[i..].iter().position(|&b| b == 0x1b) {
            let at = i + off;
            match parse(&hay[at..]) {
                Parse::Query(len, reply) => {
                    if let Some(reply) = reply {
                        replies.push(reply.into_bytes());
                    }
                    i = at + len;
                }
                Parse::Partial => {
                    if hay.len() - at <= QUERY_WINDOW {
                        self.tail = hay[at..].to_vec();
                    }
                    break;
                }
                Parse::NotQuery => i = at + 1,
            }
        }
        replies
    }
}

fn digits(s: &[u8]) -> usize {
    s.iter().take_while(|b| b.is_ascii_digit()).count()
}

fn parse(s: &[u8]) -> Parse {
    use Parse::*;
    let Some(&kind) = s.get(1) else { return Partial };
    match kind {
        b'[' => {
            let Some(&lead) = s.get(2) else { return Partial };
            match lead {
                b'c' => Query(3, Some("\x1b[?1;2c".into())),
                b'?' => match s.get(3) {
                    None => Partial,
                    Some(b'u') => Query(4, Some(format!("\x1b[?{KKP_FLAGS}u"))),
                    Some(_) => NotQuery,
                },
                b'>' => {
                    let n = digits(&s[3..]);
                    let num = &s[3..3 + n];
                    if n > 64 {
                        return NotQuery;
                    }
                    match s.get(3 + n) {
                        None => Partial,
                        Some(b'u') => {
                            // kitty 规范：flags 省略按 0（= 恢复传统编码）
                            let requested = std::str::from_utf8(num)
                                .ok()
                                .and_then(|t| t.parse::<u32>().ok())
                                .unwrap_or(0);
                            Query(4 + n, Some(format!("\x1b[?{}u", requested & KKP_FLAGS)))
                        }
                        Some(b'q') if num.is_empty() || num == b"0" => Query(
                            4 + n,
                            Some(format!("\x1bP>|{TERM_NAME}\x1b\\")),
                        ),
                        Some(b';') if num == b"4" => match (s.get(5), s.get(6)) {
                            (None, _) => Partial,
                            (Some(b'?'), None) => Partial,
                            (Some(b'?'), Some(b'm')) => Query(7, Some("\x1b[>4;0m".into())),
                            _ => NotQuery,
                        },
                        _ => NotQuery,
                    }
                }
                b'<' => {
                    let n = digits(&s[3..]);
                    if n > 64 {
                        return NotQuery;
                    }
                    match s.get(3 + n) {
                        None => Partial,
                        Some(b'u') => Query(4 + n, None),
                        Some(_) => NotQuery,
                    }
                }
                _ => NotQuery,
            }
        }
        b'P' => {
            match s.get(2) {
                None => return Partial,
                Some(b'+') => {}
                Some(_) => return NotQuery,
            }
            match s.get(3) {
                None => return Partial,
                Some(b'q') => {}
                Some(_) => return NotQuery,
            }
            let body = s[4..]
                .iter()
                .take_while(|b| b.is_ascii_hexdigit() || **b == b';')
                .count();
            if body > 256 {
                return NotQuery;
            }
            match (s.get(4 + body), s.get(5 + body)) {
                (None, _) | (Some(0x1b), None) => Partial,
                (Some(0x1b), Some(b'\\')) => {
                    // 只答会的那一项（Ms）；没问到的按规范省略，整个吞掉不应答
                    let asked = String::from_utf8_lossy(&s[4..4 + body]).to_ascii_lowercase();
                    let reply = asked
                        .split(';')
                        .any(|cap| cap == "4d73")
                        .then(|| format!("\x1bP1+r4d73={XTGETTCAP_MS_VALUE}\x1b\\"));
                    Query(6 + body, reply)
                }
                _ => NotQuery,
            }
        }
        _ => NotQuery,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(chunks: &[&str]) -> Vec<String> {
        let mut scanner = QueryScanner::default();
        chunks
            .iter()
            .flat_map(|c| scanner.feed(c.as_bytes()))
            .map(|r| String::from_utf8(r).unwrap())
            .collect()
    }

    #[test]
    fn answers_gemini_startup_probe_in_order() {
        // Gemini 0.65 一次写出的五个查询（OSC 11 不在这里答）
        let probe = "\x1b[8m\x1b[?u\x1b]11;?\x1b\\\x1b[>q\x1b[>4;?m\x1b[c\x1b[2K\r\x1b[0m";
        assert_eq!(
            feed_all(&[probe]),
            vec![
                "\x1b[?5u",
                "\x1bP>|Mesa (xterm.js 6.0.0)\x1b\\",
                "\x1b[>4;0m",
                "\x1b[?1;2c",
            ]
        );
    }

    #[test]
    fn kitty_push_grants_only_supported_flags_and_pop_is_silent() {
        assert_eq!(feed_all(&["\x1b[>7u"]), vec!["\x1b[?5u"]);
        assert_eq!(feed_all(&["\x1b[>u"]), vec!["\x1b[?0u"]);
        assert_eq!(feed_all(&["\x1b[>1u"]), vec!["\x1b[?1u"]);
        assert!(feed_all(&["\x1b[<u\x1b[<1u"]).is_empty());
    }

    #[test]
    fn queries_split_across_chunks_are_answered_once() {
        assert_eq!(feed_all(&["text\x1b", "[>", "0q more"]), vec!["\x1bP>|Mesa (xterm.js 6.0.0)\x1b\\"]);
        assert_eq!(feed_all(&["\x1b[>4", ";", "?m"]), vec!["\x1b[>4;0m"]);
        assert_eq!(
            feed_all(&["\x1bP+q4d", "73\x1b", "\\"]),
            vec!["\x1bP1+r4d73=1b5d35323b25633b25703273257307\x1b\\"]
        );
    }

    #[test]
    fn ordinary_output_and_lookalikes_get_no_reply() {
        assert!(feed_all(&["\x1b[?2004h\x1b[31mred\x1b[0m\x1b[2J\x1b[>1q\x1b[>4;2m"]).is_empty());
        // XTGETTCAP 没问 Ms：认得但不答
        assert!(feed_all(&["\x1bP+q544e\x1b\\"]).is_empty());
        // 其余 DCS（Sixel 等）不是查询
        assert!(feed_all(&["\x1bPq#0;2;0;0;0\x1b\\"]).is_empty());
    }
}
