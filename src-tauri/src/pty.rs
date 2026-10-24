use crate::agents;
use crate::profiles::{self, ProfileStore};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

/// 输出合帧周期：每个 PTY 每 16ms 最多一个 IPC 事件。
/// 从 50ms 收紧到 16ms（约一帧屏幕刷新）：TUI 高频小块场景下等待窗口更短，
/// 既减少 IPC 事件数又不让回显有可感延迟
const FRAME: Duration = Duration::from_millis(16);
/// 隐藏标签的输出缓冲上限（1 MB）
const BACKLOG_CAP: usize = 1024 * 1024;
/// 可见时合帧缓冲上限（256 KB）：超限无视帧周期立即 flush。
/// 从 4 MB 收紧：高速输出下更早 flush，pending 不会在大块场景里堆到 MB 级
const PENDING_CAP: usize = 256 * 1024;
/// backlog 截断标记：措辞必须写明是「后台期间的画面回放」被截断——
/// 用户实测把「输出过多已截断」误读成「我的输入被截断」（2026-09-15）。
/// 会话正文与聊天层始终有完整记录，截的只是隐藏标签的终端画面缓冲。
const TRUNC_MARK: &str = "[…后台期间输出过多，较早画面未保留；完整内容见会话记录]\n";
/// 子进程开启 bracketed paste 模式（DECSET 2004）时输出的序列
const BRACKETED_PASTE_ON: &[u8] = b"\x1b[?2004h";

struct PtyEntry {
    writer: crate::pty_input::PtyInput,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// 标签可见才推流；不可见时输出进 backlog（优化 2）
    visible: Arc<AtomicBool>,
    /// 前端输出通道与隐藏期积压（同一把锁，补发严格先于实时块）
    sink: Arc<Mutex<OutputSink>>,
    /// 输出流控：前端没跟上时读线程停读（见 FlowGate）
    flow: Arc<FlowGate>,
    /// 子进程是否开过 bracketed paste（输出里出现过 ESC[?2004h，粘性置位）；
    /// pty_write 据此决定是否给多行输入手工包裹粘贴序列
    bracketed_paste: Arc<AtomicBool>,
    /// 启动用途：归档工作区时只阻止仍在运行的 agent / run 脚本，普通 shell 可自动切回主仓库。
    purpose: PtyPurpose,
    /// 启动目录用于工作区生命周期保护；不用实时 cwd，避免 agent 子命令短暂切目录造成漏判。
    initial_cwd: String,
    /// 交互 Run 身份；进程退出时 close。
    run_id: Option<String>,
    /// Windows 普通 shell 标签的目录记录文件（shell 每次出提示符时写当前目录，pty_get_cwd 读）；
    /// 标签退出时删
    cwd_file: Option<std::path::PathBuf>,
    /// 普通 shell 标签用的哪种 shell（pty_cd 按它拼 cd）；agent 与 run 脚本为 None
    shell_kind: Option<ShellKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PtyPurpose {
    Agent,
    Shell,
    Script,
}

#[derive(Default, Clone)]
pub struct PtyManager {
    entries: Arc<Mutex<HashMap<String, PtyEntry>>>,
}

fn path_within(path: &str, root: &str) -> bool {
    crate::paths::path_within(path, root)
}

impl PtyManager {
    pub(crate) fn shutdown(&self) {
        let entries: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .drain()
            .map(|(_, e)| e)
            .collect();
        let mut workers = Vec::new();
        for entry in entries {
            entry.flow.close();
            workers.push(std::thread::spawn(move || {
                terminate_pty_child(entry.child);
                if let Some(id) = entry.run_id {
                    let _ = crate::runs::close_run_with_result(
                        &id,
                        None,
                        "stopped",
                        None,
                        Some("应用退出"),
                    );
                }
            }));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while workers.iter().any(|w| !w.is_finished()) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(crate) fn has_run(&self, run_id: &str) -> bool {
        self.pty_id_for_run(run_id).is_some()
    }

    /// 这条 Run 已经有活 PTY（标签还在或热更新后前端丢了引用）。
    /// 再 spawn 会抢锁报「此运行已在启动或执行中」——应把现成 PTY 交回去接着用。
    pub(crate) fn pty_id_for_run(&self, run_id: &str) -> Option<String> {
        let id = run_id.trim();
        if id.is_empty() {
            return None;
        }
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(_, entry)| entry.run_id.as_deref() == Some(id))
            .map(|(pty_id, _)| pty_id.clone())
    }

    /// 返回指定工作区里仍存活、会阻止移除工作树的终端类型。
    /// macOS/Linux：普通登录 shell 不阻止（归档后前端把它 cd 回主仓库）。
    /// Windows：进程所在目录删不掉，且 PowerShell 的 cd（Set-Location）不改进程 cwd——
    /// 切回主仓库也解不开占用，`git worktree remove` 会删掉一半文件后失败；shell 一并拦下。
    pub(crate) fn active_workspace_tasks(&self, worktree_path: &str) -> Vec<&'static str> {
        let entries = self.entries.lock().unwrap();
        workspace_blockers(
            entries
                .values()
                .map(|entry| (entry.purpose, entry.initial_cwd.as_str())),
            worktree_path,
            cfg!(windows),
        )
    }

    /// 移除工作树前的占用闸：有阻止项时给出可操作的中文报错（action 如「归档」「删除」）。
    pub(crate) fn ensure_workspace_free(&self, worktree_path: &str, action: &str) -> Result<(), String> {
        match workspace_busy_message(&self.active_workspace_tasks(worktree_path), action) {
            Some(msg) => Err(msg),
            None => Ok(()),
        }
    }
}

/// 应用唯一的 PTY 管理器（首次拉起终端时登记）。删除项目目录这类拿不到 tauri State 的
/// 移除路径用它复查占用；从未开过终端时为 None = 无占用。
static LIVE_MANAGER: std::sync::OnceLock<PtyManager> = std::sync::OnceLock::new();

/// 不经命令层的工作树移除（如彻底删除项目时级联删工作区）调用：仅 Windows 有占用问题，
/// 其它平台恒放行，行为不变。
pub(crate) fn ensure_workspace_free_global(worktree_path: &str, action: &str) -> Result<(), String> {
    if !cfg!(windows) {
        return Ok(());
    }
    match LIVE_MANAGER.get() {
        Some(m) => m.ensure_workspace_free(worktree_path, action),
        None => Ok(()),
    }
}

/// 启动目录落在 root 内的存活终端数（任意用途，含普通 shell）。从未开过终端时为 0。
pub(crate) fn live_ptys_within(root: &str) -> usize {
    LIVE_MANAGER.get().map_or(0, |m| {
        m.entries
            .lock()
            .unwrap()
            .values()
            .filter(|entry| path_within(&entry.initial_cwd, root))
            .count()
    })
}

/// 纯判定：哪些终端落在工作树内且会阻止移除。shells_hold_dir = Windows 语义（shell 也占目录）。
fn workspace_blockers<'a>(
    entries: impl Iterator<Item = (PtyPurpose, &'a str)>,
    worktree_path: &str,
    shells_hold_dir: bool,
) -> Vec<&'static str> {
    entries
        .filter(|(_, cwd)| path_within(cwd, worktree_path))
        .filter_map(|(purpose, _)| match purpose {
            PtyPurpose::Agent => Some("agent"),
            PtyPurpose::Script => Some("run 脚本"),
            PtyPurpose::Shell if shells_hold_dir => Some("终端"),
            PtyPurpose::Shell => None,
        })
        .collect()
}

/// 阻止项 → 报错文案；空 = 放行
fn workspace_busy_message(kinds: &[&str], action: &str) -> Option<String> {
    if kinds.is_empty() {
        return None;
    }
    let shells = kinds.iter().filter(|k| **k == "终端").count();
    if shells == 0 {
        return Some(format!(
            "工作区仍有 {} 个 agent/run 脚本在运行，请先停止或关闭对应终端标签再{action}",
            kinds.len()
        ));
    }
    Some(format!(
        "工作区目录正被 {} 个终端标签使用（其中 {shells} 个是普通终端）。Windows 不能删除正在使用中的目录，\
         强行{action}只会删掉一半。请先在终端页关闭在这个工作区里打开的标签（标签目录在该工作区下的那些），再{action}",
        kinds.len()
    ))
}

/// 从缓冲头部取出尽可能多的完整 UTF-8 文本，返回 (文本, 消耗字节数)。
/// 末尾残缺的多字节序列留给下一轮，避免把中文等字符切成乱码。
pub(crate) fn split_utf8(buf: &[u8]) -> (String, usize) {
    match std::str::from_utf8(buf) {
        Ok(_) => (String::from_utf8_lossy(buf).into_owned(), buf.len()),
        Err(e) => {
            let valid = e.valid_up_to();
            if valid > 0 {
                (String::from_utf8_lossy(&buf[..valid]).into_owned(), valid)
            } else if let Some(len) = e.error_len() {
                (String::from_utf8_lossy(&buf[..len]).into_owned(), len)
            } else {
                (String::new(), 0)
            }
        }
    }
}

/// 输出合帧（优化 1）：读取线程只负责 append，发送线程按帧合并发出。
/// 帧内唤醒会重新评估等待时长；距上次发送已满一帧则立即发（回显无延迟）。
struct FrameCoalescer {
    pending: Mutex<Vec<u8>>,
    cond: Condvar,
    done: AtomicBool,
}

impl FrameCoalescer {
    fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            cond: Condvar::new(),
            done: AtomicBool::new(false),
        }
    }

    fn append(&self, bytes: &[u8]) {
        self.pending.lock().unwrap().extend_from_slice(bytes);
        self.cond.notify_one();
    }

    /// 输出流结束：最后一帧立即发，之后 take_frame 返回 None
    fn finish(&self) {
        self.done.store(true, Ordering::Relaxed);
        self.cond.notify_one();
    }

    /// 取下一帧文本；EOF 且缓冲清空后返回 None（发送线程据此退出）
    fn take_frame(&self, last_emit: Instant, frame: Duration) -> Option<(String, Instant)> {
        let mut pending = self.pending.lock().unwrap();
        loop {
            let done = self.done.load(Ordering::Relaxed);
            if pending.is_empty() {
                if done {
                    return None;
                }
                pending = self.cond.wait(pending).unwrap();
                continue;
            }
            let elapsed = last_emit.elapsed();
            if done || elapsed >= frame || pending.len() >= PENDING_CAP {
                let (text, used) = split_utf8(&pending);
                if used > 0 {
                    pending.drain(..used);
                    return Some((text, Instant::now()));
                }
                // 只剩残缺的 UTF-8 尾部：EOF 时按 lossy 全发，否则等更多数据
                if done {
                    let text = String::from_utf8_lossy(&pending).into_owned();
                    pending.clear();
                    return Some((text, Instant::now()));
                }
                pending = self.cond.wait(pending).unwrap();
                continue;
            }
            // 帧内：睡到帧尾再合并发；新数据唤醒会重算剩余时长
            let (guard, _) = self.cond.wait_timeout(pending, frame - elapsed).unwrap();
            pending = guard;
        }
    }
}

fn is_utf8_boundary(b: u8) -> bool {
    b < 0x80 || b >= 0xc0
}

/// 追加到 backlog；超上限时从头部按 UTF-8 边界丢弃，并加一次性截断标记
fn backlog_push(backlog: &mut Vec<u8>, bytes: &[u8]) {
    backlog.extend_from_slice(bytes);
    if backlog.len() > BACKLOG_CAP {
        let mut drop = backlog.len() - BACKLOG_CAP;
        while drop < backlog.len() && !is_utf8_boundary(backlog[drop]) {
            drop += 1;
        }
        backlog.drain(..drop);
        if !backlog.starts_with(TRUNC_MARK.as_bytes()) {
            let mut marked = TRUNC_MARK.as_bytes().to_vec();
            marked.extend_from_slice(backlog);
            *backlog = marked;
        }
    }
}

/// 补发 backlog 中完整的 UTF-8 前缀（残缺尾部留到下次）；空或无完整内容返回 None
fn drain_backlog(backlog: &mut Vec<u8>) -> Option<String> {
    let (text, used) = split_utf8(backlog);
    if used == 0 {
        return None;
    }
    let rest = backlog.split_off(used);
    *backlog = rest;
    Some(text)
}

/// 前端的输出通道（pty_subscribe 交来，每次 attach 新建一条）与隐藏期积压放在同一把锁下：
/// 补发严格先于之后的实时块。还没接上通道时与隐藏时一样进 backlog，接上再补发
#[derive(Default)]
struct OutputSink {
    backlog: Vec<u8>,
    channel: Option<Channel>,
}

/// 这么大的帧走原始字节（Tauri 用 fetch 取回，不转义、不拼脚本执行）；更小的仍按 JSON 字符串直接执行，
/// 与 Tauri 自己的分界一致（ipc/channel.rs MAX_JSON_DIRECT_EXECUTE_THRESHOLD）。前端两种都收
const RAW_FRAME_MIN: usize = 8 * 1024;

/// 输出流控（2026-10-21，照 VS Code 的确认机制）：前端每画完约 5000 字回一次确认（pty_ack），
/// 已发出未确认的超过 10 万字时读线程停读 PTY——子进程写不出去自然减速，刷屏时按 Ctrl+C 立刻见效，
/// 不再等前端把积起来的几十 MB 写入队列消化完。降到 5000 字以下再接着读。
/// 计数单位 = UTF-16 码元（前端 string.length），两端一致。隐藏标签的输出进 backlog、不计数
const FLOW_HIGH: usize = 100_000;
const FLOW_LOW: usize = 5_000;
/// 停读期间这么久一个确认都没收到（页面重载、监听抛了异常）视为前端失联、放行，
/// 不让子进程永远卡在写上
const FLOW_STALL: Duration = Duration::from_secs(5);

#[derive(Default)]
struct FlowState {
    unacked: usize,
    paused: bool,
    closed: bool,
}

#[derive(Default)]
struct FlowGate {
    state: Mutex<FlowState>,
    cond: Condvar,
}

impl FlowGate {
    fn sent(&self, units: usize) {
        let mut s = self.state.lock().unwrap();
        s.unacked = s.unacked.saturating_add(units);
        if s.unacked > FLOW_HIGH {
            s.paused = true;
        }
    }

    fn ack(&self, units: usize) {
        let mut s = self.state.lock().unwrap();
        s.unacked = s.unacked.saturating_sub(units);
        if s.paused && s.unacked < FLOW_LOW {
            s.paused = false;
            self.cond.notify_all();
        }
    }

    /// 前端不会再确认之前那些帧了（换了通道 / 标签转后台）：清零放行
    fn reset(&self) {
        let mut s = self.state.lock().unwrap();
        s.unacked = 0;
        s.paused = false;
        self.cond.notify_all();
    }

    /// 标签被关 / 应用退出：读线程别再等，读到 EOF 自然收尾
    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.cond.notify_all();
    }

    /// 读线程每次读 PTY 之前调：停读中就等前端确认
    fn wait_ready(&self, stall: Duration) {
        let mut s = self.state.lock().unwrap();
        while s.paused && !s.closed {
            let before = s.unacked;
            let (guard, timeout) = self.cond.wait_timeout(s, stall).unwrap();
            s = guard;
            if timeout.timed_out() && s.paused && s.unacked >= before {
                crate::logbuf::record("warn", "pty", "终端输出等确认超时，视为前端失联，继续读取");
                s.unacked = 0;
                s.paused = false;
            }
        }
    }
}

/// 发一帧给前端并计入流控；通道已失效（页面没了）就丢掉通道，之后的输出进 backlog 等重新接上
fn send_frame(sink: &mut OutputSink, flow: &FlowGate, text: String) {
    let Some(channel) = sink.channel.as_ref() else {
        backlog_push(&mut sink.backlog, text.as_bytes());
        return;
    };
    let units = text.encode_utf16().count();
    let body = if text.len() >= RAW_FRAME_MIN {
        InvokeResponseBody::Raw(text.into_bytes())
    } else {
        match serde_json::to_string(&text) {
            Ok(json) => InvokeResponseBody::Json(json),
            Err(_) => return,
        }
    };
    if !send_counted(flow, units, || channel.send(body).is_ok()) {
        sink.channel = None;
    }
}

/// 先记账再发：前端收到帧后立刻确认，确认可能在 send 返回之前就到 FlowGate；先发后记的话，
/// 确认落在计数 0 上被吃掉，随后记上的字数永远没人抵消，读线程白等 5 秒（FLOW_STALL）才放行。
/// 发送失败要把刚记的账退回去
fn send_counted(flow: &FlowGate, units: usize, send: impl FnOnce() -> bool) -> bool {
    flow.sent(units);
    if send() {
        true
    } else {
        flow.ack(units);
        false
    }
}

/// 可见性门控（优化 2）：可见且接上了通道 → 先补发 backlog 再发本块；否则进 backlog。
/// 与 pty_set_visible / pty_subscribe 共用 sink 锁，保证补发严格先于实时块。
/// 返回值 = 要照发给后台标签的带外信号（调用方 emit pty-signal）
fn route_output(sink: &mut OutputSink, visible: bool, flow: &FlowGate, text: String) -> Option<String> {
    if visible && sink.channel.is_some() {
        if let Some(back) = drain_backlog(&mut sink.backlog) {
            send_frame(sink, flow, back);
        }
        send_frame(sink, flow, text);
        return None;
    }
    // 后台标签的正文进 backlog，但带外信号（OSC 9/777 通知与进度、BEL）照发：
    // 通知/进度徽章的主场景就是后台标签，等切回再补发就废了（2026-10-11 复核）。
    // 前端 pty-signal 只喂通知/进度解析、不写画面；切回时的 backlog 补发会再见到
    // 同样的字节，靠前端限频/幂等消化重复。
    backlog_push(&mut sink.backlog, text.as_bytes());
    let signal = text.contains("\x1b]9;") || text.contains("\x1b]777;") || text.contains('\u{7}');
    signal.then_some(text)
}

/// 翻成可见 / 刚接上通道时，在 sink 锁内把积压补发出去
fn flush_backlog(sink: &mut OutputSink, flow: &FlowGate) {
    if sink.channel.is_some() {
        if let Some(text) = drain_backlog(&mut sink.backlog) {
            send_frame(sink, flow, text);
        }
    }
}

/// 在子进程输出中扫描 bracketed paste 开启序列（ESC[?2004h）。
/// tail 保存上一块末尾的 N-1 字节，防止序列恰好跨读取块被漏检。
/// 返回 true 表示本块（含跨界）出现了开启序列。
fn scan_bracketed_paste_on(tail: &mut Vec<u8>, chunk: &[u8]) -> bool {
    let mut hay = std::mem::take(tail);
    hay.extend_from_slice(chunk);
    let found = hay
        .windows(BRACKETED_PASTE_ON.len())
        .any(|w| w == BRACKETED_PASTE_ON);
    if !found {
        let keep = BRACKETED_PASTE_ON.len() - 1;
        let start = hay.len().saturating_sub(keep);
        *tail = hay[start..].to_vec();
    }
    found
}

/// 多行输入在子进程已开 bracketed paste 时包裹为一次粘贴（ESC[200~ … ESC[201~），
/// 避免多行被目标程序逐行提交；单行输入或未开粘贴模式时原样返回——
/// 未开 2004 的程序会把控制序列原样显示出来，绝不能包裹
fn wrap_bracketed_paste(data: &str, paste_mode_on: bool) -> std::borrow::Cow<'_, str> {
    if paste_mode_on && data.contains('\n') {
        format!("\x1b[200~{data}\x1b[201~").into()
    } else {
        data.into()
    }
}

/// 聊天发送的正文：照 bracketed paste 规则包好；`cr_newlines` = 包里的换行改写成 CR。
/// Windows（ConPTY）上 Grok 收到粘贴包里的 LF 会把换行丢掉（两行连成一行），CR 才算换行；
/// 其余几家 CR 会被当成提交或把字写错位（2026-10-20 八家逐个实测），所以只按调用方点名改，没包的不动
fn chat_paste_body(text: &str, paste_mode_on: bool, cr_newlines: bool) -> String {
    let body = wrap_bracketed_paste(text, paste_mode_on);
    if cr_newlines && body.starts_with("\x1b[200~") {
        body.replace("\r\n", "\r").replace('\n', "\r")
    } else {
        body.into_owned()
    }
}

/// 把文本编码成 win32-input-mode 按键记录（`ESC [ Vk;Sc;Uc;Kd;Cs;Rc _`），每字符一条 key-down。
///
/// Windows/ConPTY 会把写进 PTY 输入的**成形 OSC 序列整段剥掉**（ST / BEL 收尾都一样），
/// 子进程收到空；同一时刻写纯文本却能原样送达。ConPTY 启动时发的 `ESC[?9001h` 宣告了
/// win32-input-mode，按这个格式编码后 ConPTY 会在输入侧还原成原始字节交给子进程——
/// 这是把 OSC 底色回报送进 agent 的唯一通道（2026-08-29 本机 portable-pty 实测）。
///
/// 逐条投递、条与条之间必须留间隔：一次性灌进去时 ConPTY 的输入解析器会丢同步，
/// 把中间某条记录原样漏成可见文本（投递间隔见 `WIN32_INPUT_RECORD_GAP`）。
/// 按 UTF-16 码元出记录：BMP 以外的字（emoji）出高、低两条代理记录。
fn win32_input_records(text: &str) -> Vec<String> {
    text.encode_utf16()
        .map(|unit| format!("\x1b[0;0;{unit};1;0;1_"))
        .collect()
}

/// Windows 上写进 PTY 的输入：BMP 以外的字（emoji 等）改送只按下的 win32 按键记录，其余字节原样，按段依次写。
///
/// ConPTY 把 UTF-8 里的 emoji 拆成「高位按下、高位抬起、低位按下、低位抬起」四条按键事件；Codex 用的 crossterm
/// 把抬起也当代理对的一半去拼（windows/parse.rs handle_surrogate），高配高、低配低都拼不成字，整个 emoji 丢掉
/// （2026-10-21 用户实测：Codex 会话里「"引号" 😀」落成「"引号" 」；探针复现：同一版 crossterm 收 `a😀b` 只剩 `ab`，
/// 改送只按下的两条记录后收到完整的 U+1F600）。忽略抬起的读法（Node / .NET / prompt_toolkit）收到的不变；
/// 开了 VT 输入的程序在粘贴包里照样收到原字，粘贴包首尾也不变（同日探针实测）。
fn conpty_input_pieces(bytes: &str) -> Vec<Vec<u8>> {
    let mut pieces = Vec::new();
    let mut text = String::new();
    for ch in bytes.chars() {
        if (ch as u32) <= 0xFFFF {
            text.push(ch);
            continue;
        }
        if !text.is_empty() {
            pieces.push(std::mem::take(&mut text).into_bytes());
        }
        let mut buf = [0u8; 4];
        pieces.extend(win32_input_records(ch.encode_utf8(&mut buf)).into_iter().map(String::into_bytes));
    }
    if !text.is_empty() || pieces.is_empty() {
        pieces.push(text.into_bytes());
    }
    pieces
}

/// 写进 PTY 的分段：只有 Windows 需要改送 emoji（见 conpty_input_pieces），别的平台整块写
fn pty_input_pieces(bytes: &str) -> Vec<Vec<u8>> {
    if cfg!(windows) {
        conpty_input_pieces(bytes)
    } else {
        vec![bytes.as_bytes().to_vec()]
    }
}

/// win32 按键记录之间的投递间隔——低于此值 ConPTY 输入解析器会丢同步漏出字面记录
const WIN32_INPUT_RECORD_GAP: std::time::Duration = std::time::Duration::from_millis(2);

/// Shift+Enter 的 win32 按键记录（VK_RETURN、扫描码 28、字符 CR、按下、SHIFT_PRESSED）
const SHIFT_ENTER_RECORD: &str = "\x1b[13;28;13;1;16;1_";

/// Windows 上发给 Codex 的多行正文：每个换行改送一条 Shift+Enter 按键记录（Codex 的换行键），其余同 conpty_input_pieces。
///
/// Codex（crossterm）在 Windows 上读的是按键事件，ConPTY 把粘贴包里的 LF 转成它认不出的键，换行整个丢掉、几行连成一行；
/// 改写 CR 则每行各自发出去（2026-10-21 ConPTY 探针，Codex 0.163：LF → 「多行第二行第三行」、CR → 拆成三条消息、
/// Shift+Enter / Ctrl+J 记录 → 三行原样；docs 里 10-20「Codex 保留 LF」的结论已不成立）
fn shift_enter_pieces(body: &str) -> Vec<Vec<u8>> {
    let mut pieces = Vec::new();
    for (i, line) in body.split('\n').enumerate() {
        if i > 0 {
            pieces.push(SHIFT_ENTER_RECORD.as_bytes().to_vec());
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if !line.is_empty() {
            pieces.extend(conpty_input_pieces(line));
        }
    }
    if pieces.is_empty() {
        pieces.push(Vec::new());
    }
    pieces
}

/// 向指定 PTY 的独立队列写字节；只在查找 writer 句柄时持全局表锁。
/// PTY 已消失（标签被秒关）时返回 Err，由调用方决定是否静默。
fn write_pty_bytes(manager: &PtyManager, pty_id: &str, bytes: &[u8]) -> Result<(), String> {
    let writer = manager
        .entries
        .lock()
        .unwrap()
        .get(pty_id)
        .map(|entry| entry.writer.clone())
        .ok_or("终端不存在或已退出")?;
    writer.write(bytes)
}

fn expand_tilde(path: &str) -> String {
    crate::paths::expand_tilde(path)
}

/// pty_spawn 的返回：session_hint 是启动时通过 --session-id 固定的会话 ID，
/// 前端用它把终端标签和落盘的会话文件关联起来（无此能力的 agent 为 None）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub pty_id: String,
    pub session_hint: Option<String>,
    /// 初始 prompt 因 CLI 不支持注入被丢弃（前端提示用户手动发送）
    pub prompt_dropped: bool,
    /// 实际生效的模型（前端留空时后端兜底为 profile 首个模型）——
    /// 回传给前端同步标签状态，否则状态栏在兜底路径下无模型可显示
    pub model: Option<String>,
    /// 交互 Run id；登录标签为空
    pub run_id: Option<String>,
    /// 交回这条 Run 上已经在跑的 PTY，没有新开进程。
    /// 前端据此不收启动栏、不改行列。
    pub adopted: bool,
    /// 要恢复的会话从没落盘（上次启动没聊就退出），改开了新会话；前端据此提示一句
    pub resume_unwritten: bool,
}

/// 支持 --session-id <uuid> 的 agent（AgentSpec.fixed_session_id；matrix：claude-code、qwen、codebuddy），
/// 会话文件名可预测
fn session_id_for(agent_id: &str) -> Option<String> {
    crate::agent_specs::agent_spec(agent_id)
        .filter(|s| s.fixed_session_id)
        .map(|_| uuid::Uuid::new_v4().to_string())
}

/// 前端量到的终端格子。缺省或非法时用 24×80（xterm 默认）。
/// 恢复会话会在进程活着的第一帧按这个宽度重放整段对话；先 80 列再拉宽，
/// 窄的那份会留在滚动记录里（审阅退回修改实测）。
fn pty_size_from(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    let cols = cols.filter(|n| *n >= 2).unwrap_or(80);
    let rows = rows.filter(|n| *n >= 1).unwrap_or(24);
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// 在 PTY 中拉起进程并登记到管理器，输出/退出通过 `pty-output-<id>` / `pty-exit-<id>` 事件推送。
fn spawn_tracked(
    app: &AppHandle,
    manager: &PtyManager,
    mut cmd: CommandBuilder,
    cwd: &str,
    purpose: PtyPurpose,
    run_id: Option<String>,
    size: PtySize,
    cwd_file: Option<std::path::PathBuf>,
    // 这个标签用程序状态（OSC 7501，program_status.rs）当聊天层旁路：答探询、读报告
    program_status: bool,
) -> Result<String, String> {
    if crate::process::shutting_down() {
        return Err("应用正在退出，拒绝启动终端".into());
    }
    // 声明现代终端能力：缺少这些时 CLI 会按哑终端处理，输出退化为黑白
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Mesa");
    cmd.env_remove("TERM_PROGRAM_VERSION"); // 避免继承到宿主终端的版本号
                                            // 这两个只要存在就会强制 CLI 关闭彩色，优先级高于 TERM/COLORTERM。
                                            // Mesa Dev 若从带 FORCE_COLOR=0 的终端拉起，不剔除则所有会话都是灰白。
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("FORCE_COLOR");
    cmd.cwd(cwd);
    // PWD 跟工作目录一致：否则子进程继承的是 Mesa 启动时那个 shell 的 PWD，按 PWD 取目录的 CLI（opencode run）
    // 会跑到别处干活（process::background_command 同一条，那边是删掉）
    cmd.env("PWD", cwd);
    // 出图：告诉 Agent 随包 helper 在哪（技能 image-gen 按它调）；密钥不进环境变量，helper 出图时自己取
    if let Some(tool) = crate::image_gen::helper_exe() {
        cmd.env(crate::image_gen::TOOL_ENV, tool);
    }

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("创建 PTY 失败: {e}"))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动进程失败: {e}"))?;
    // spawn 已成功：后续任一步失败都必须先杀子进程，否则它脱离管理器成为孤儿
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            terminate_pty_child(child);
            return Err(format!("读取 PTY 失败: {e}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            terminate_pty_child(child);
            return Err(format!("写入 PTY 失败: {e}"));
        }
    };

    let pty_id = uuid::Uuid::new_v4().to_string();
    let visible = Arc::new(AtomicBool::new(false)); // 默认不可见：前端随即按标签状态标记
    let sink = Arc::new(Mutex::new(OutputSink::default()));
    let flow = Arc::new(FlowGate::default());
    let bracketed_paste = Arc::new(AtomicBool::new(false));
    LIVE_MANAGER.get_or_init(|| manager.clone());
    let input = crate::pty_input::PtyInput::new(writer);
    let query_input = input.clone();
    manager.entries.lock().unwrap().insert(
        pty_id.clone(),
        PtyEntry {
            writer: input,
            master: pair.master,
            child,
            visible: visible.clone(),
            sink: sink.clone(),
            flow: flow.clone(),
            bracketed_paste: bracketed_paste.clone(),
            purpose,
            initial_cwd: cwd.to_string(),
            run_id: run_id.clone(),
            cwd_file,
            shell_kind: None,
        },
    );

    let coalescer = Arc::new(FrameCoalescer::new());
    let signal_event = format!("pty-signal-{pty_id}");
    let exit_event = format!("pty-exit-{pty_id}");

    // 发送线程：按帧合并发出（优化 1），经可见性门控（优化 2）走前端交来的通道
    let emitter = {
        let coalescer = coalescer.clone();
        let app = app.clone();
        let flow = flow.clone();
        std::thread::spawn(move || {
            let mut last_emit = Instant::now() - FRAME; // 首字节立即发
            while let Some((text, at)) = coalescer.take_frame(last_emit, FRAME) {
                let signal = {
                    let mut sink = sink.lock().unwrap();
                    route_output(&mut sink, visible.load(Ordering::Relaxed), &flow, text)
                };
                if let Some(signal) = signal {
                    let _ = app.emit(&signal_event, signal);
                }
                last_emit = at;
            }
        })
    };

    let entries = manager.entries.clone();
    let id = pty_id.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        // bracketed paste 检测的跨块尾部（序列可能恰好被 8KB 读取边界切开）
        let mut scan_tail: Vec<u8> = Vec::new();
        // 终端能力查询在这里当场答，不等前端（标签在后台时输出进 backlog，前端答就晚了，见 term_query.rs）
        let mut queries = crate::term_query::QueryScanner::new(program_status);
        let mut reports = program_status.then(crate::program_status::ReportScanner::default);
        loop {
            // 前端没跟上就先停读（流控，见 FlowGate）
            flow.wait_ready(FLOW_STALL);
            let mut buf = [0u8; 8192];
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // 粘性检测：一旦见过 ESC[?2004h 就记住，pty_write 据此包裹多行粘贴
                    if !bracketed_paste.load(Ordering::Relaxed)
                        && scan_bracketed_paste_on(&mut scan_tail, &buf[..n])
                    {
                        bracketed_paste.store(true, Ordering::Relaxed);
                    }
                    for reply in queries.feed(&buf[..n]) {
                        // 只入队不等回执：读线程不能被一个不读 stdin 的子进程卡住
                        let _ = query_input.enqueue(&reply, None);
                    }
                    if let Some(scanner) = reports.as_mut() {
                        for report in scanner.feed(&buf[..n]) {
                            crate::chat_channel::program_status_report(&id, &report);
                        }
                    }
                    if let Some(id) = run_id.as_deref() {
                        // 有界队列仅传递副本；数据库/脱敏不占用终端读取线程。
                        let text = String::from_utf8_lossy(&buf[..n]);
                        let _ = crate::runs::record_output(id, &text);
                    }
                    coalescer.append(&buf[..n]);
                }
                Err(_) => break,
            }
        }
        coalescer.finish();
        // 等发送线程把尾帧发完，再发退出事件，保证输出先于退出到达
        let _ = emitter.join();
        crate::chat_channel::close_for_pty(&id);
        // 输出流结束视为进程结束；谁先移除 entry 谁负责回收并发退出事件
        let entry = entries.lock().unwrap().remove(&id);
        if let Some(mut entry) = entry {
            forget_cwd_file(&mut entry);
            // wait 失败按异常退出（-1）上报，不误报正常退出
            let deadline = Instant::now() + Duration::from_secs(2);
            let code = loop {
                match entry.child.try_wait() {
                    Ok(Some(status)) => break status.exit_code() as i64,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    _ => {
                        terminate_pty_child(entry.child);
                        break -1;
                    }
                }
            };
            if let Some(run_id) = entry.run_id {
                let status = if code == 0 { "completed" } else { "failed" };
                let _ = crate::runs::close_run_with_result(
                    &run_id,
                    None,
                    status,
                    i32::try_from(code).ok(),
                    (code != 0).then_some("进程以非零退出码结束"),
                );
            }
            let _ = app.emit(&exit_event, code);
        }
    });

    Ok(pty_id)
}

/// 拉起与停止终端一律在后台线程做（2026-10-21，conventions/terminal.md「会等待的命令不占主线程」）：
/// 不带 async 的 Tauri 命令跑在主线程上，而 Rust 往网页推终端输出也要排主线程的队。起 Codex 标签要等
/// app-server 就绪（最长 4 秒），停止要等子进程退出（最长 2 秒）并可能冻结评审快照——放在主线程上，
/// 这期间所有标签的输出和按键都会停住。
/// 几种拉起之间仍逐个进行：挪出主线程前它们靠主线程天然串行，Run 认领、会话预登记、启动前文件准备
///（Codex 模型 catalog 等）都是按这个前提写的
static SPAWN_LOCK: Mutex<()> = Mutex::new(());

fn spawn_turn() -> std::sync::MutexGuard<'static, ()> {
    SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 参数含义见 `pty_spawn_sync`
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    agent_id: String,
    profile_id: String,
    cwd: String,
    model: Option<String>,
    extra_env: Option<HashMap<String, String>>,
    resume_session_id: Option<String>,
    initial_prompt: Option<String>,
    link_claim_id: Option<String>,
    readonly: Option<bool>,
    resume_provider: Option<String>,
    reuse_key: Option<String>,
    run_id: Option<String>,
    permission: Option<String>,
    effort_override: Option<String>,
    permission_mode: Option<String>,
    task_id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SpawnResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = spawn_turn();
        pty_spawn_sync(
            app.clone(),
            app.state(),
            app.state(),
            agent_id,
            profile_id,
            cwd,
            model,
            extra_env,
            resume_session_id,
            initial_prompt,
            link_claim_id,
            readonly,
            resume_provider,
            reuse_key,
            run_id,
            permission,
            effort_override,
            permission_mode,
            task_id,
            cols,
            rows,
        )
    })
    .await
    .map_err(|e| format!("启动终端失败: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn pty_spawn_sync(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    store: tauri::State<'_, ProfileStore>,
    agent_id: String,
    profile_id: String,
    cwd: String,
    // 启动时选中的模型；None 时取 profile 模型列表的首个
    model: Option<String>,
    // 工作区端口段（CCODE_PORT 块）等附加 env：在 launch_plan env 之后、TERM 三元组之前注入
    extra_env: Option<HashMap<String, String>>,
    // 恢复已有会话（§6.12 A）：注入各 CLI 的恢复参数，跳过 --session-id，hint 直接锁定该会话
    resume_session_id: Option<String>,
    // 初始 prompt（一键开步首条指令）：按注册表形态注入 args；仅全新会话生效，恢复会话不注入
    initial_prompt: Option<String>,
    // 无固定 session id 的 agent 用终端标签 id 预登记关联声明，避免并发标签抢同一会话
    link_claim_id: Option<String>,
    // 「聊想法」只读模式：新建和恢复均注入注册表 readonly_args，缺能力拒绝
    readonly: Option<bool>,
    // 恢复会话时 rollout 记下的 provider（旧 "ccode" 或派生名 ccode-<gid>）
    resume_provider: Option<String>,
    reuse_key: Option<String>,
    run_id: Option<String>,
    // 对外政策名；缺省时回落 readonly 布尔（旧启动入口）。
    permission: Option<String>,
    // 开工弹层的本次思考档覆盖（2026-09-15）：非空时盖过绑定逐模型策略，
    // 只影响本次进程、不写回绑定；后续 launch_plan 照常按 policy 注入
    effort_override: Option<String>,
    // 可写时的本机原生权限档（ask 请求批准 / auto 帮我批准 / full 完全访问）；None = 按 CLI 本机设置
    permission_mode: Option<String>,
    // 已由任务入口创建的 Run 所属 Task。
    task_id: Option<String>,
    // 当前 xterm 格子。恢复会话按这个宽度重放；缺省保持 24×80。
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SpawnResult, String> {
    let selected = model.filter(|m| !m.trim().is_empty());
    let mut profile = store.get_with_model(&profile_id, selected.as_deref())?;
    if let Some(effort) = effort_override
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        // 本次覆盖优先于绑定逐模型策略（弹层是一次性决策点；改持久默认去网关库）
        profile.request_policy.reasoning_effort = Some(effort.to_string());
    }
    if profile.agent != agent_id {
        return Err("profile 与所选 agent 不匹配".into());
    }
    if profile.slot_missing && profile.account_type != crate::profiles::AccountType::Official {
        return Err("这个网关还没配该协议的端点，请先在网关库补槽".into());
    }
    profile.apply_session_provider(resume_provider.as_deref());
    let binary = agents::binary_for(&agent_id).ok_or_else(|| format!("未知 agent: {agent_id}"))?;
    let binary_path = agents::resolve_binary(binary)
        .ok_or_else(|| format!("未找到 {binary}（PATH 与常见安装目录均无）"))?;
    // 密钥只在启动瞬间从 keys.json 读出，注入子进程环境后即丢弃；keys.json 损坏时报错阻断启动
    let key = profiles::get_key_for_profile(&profile)?;
    agents::ensure_launch_credentials(&profile, key.as_deref())?;
    let model = selected.or_else(|| profile.models.first().cloned());
    crate::combo::apply_to_profile(&mut profile, model.as_deref());
    agents::validate_launch_compatibility(&profile, model.as_deref())?;
    // 恢复会话不注入初始 prompt（那是既有会话的延续，不是开步）
    let prompt = match &resume_session_id {
        Some(_) => None,
        None => initial_prompt.as_deref(),
    };
    let mut plan = agents::launch_plan_with_prompt(&profile, key, model.as_deref(), prompt)?;
    // 口径 C：原始文献（PDF/导入）允许直写主仓 papers/——从步骤工作区启动的 codex
    // 把该目录预授权进 workspace-write 沙箱（sandbox_workspace_write.writable_roots），
    // 免得每写一篇 PDF 都停下来等提权确认（2026-09-15 用户实测「总是让我授权」）。
    // 只加 papers/ 子目录：派生产物仍必须走工作区 + 评审合并，不开放整个主仓；
    // TOML 基本字符串里 Windows 反斜杠要转义
    if agent_id == "codex" {
        if let Some(papers) = crate::workspaces::papers_dir_for_worktree(&cwd) {
            let escaped = papers.replace('\\', "\\\\");
            plan.args.push("-c".into());
            plan.args.push(format!(
                r#"sandbox_workspace_write.writable_roots=["{escaped}"]"#
            ));
        }
    }
    // 预分配 id 的会话在第一条消息前不落盘：上次启动即退出 / 启动即崩时，Run 记着 id、盘上没有
    // 这段对话，按 id 恢复只会报「No conversation found」退出 1。没有可接的对话就在原目录开新会话，
    // Run 的会话换成新 id（恢复入口一律经这里，工作台「继续工作」、收件箱、运行页同一条路）
    let mut resume_session_id = resume_session_id;
    let mut unwritten_session: Option<String> = None;
    if let Some(sid) = resume_session_id.clone() {
        if crate::sessions::fixed_id_session_exists(&agent_id, &sid, &plan.env) == Some(false) {
            resume_session_id = None;
            unwritten_session = Some(sid);
        }
    }
    // 恢复模式：hint = 被恢复的会话；普通模式：claude/qwen 生成新 id 固定文件名
    let session_hint = match &resume_session_id {
        Some(sid) => Some(sid.clone()),
        None => session_id_for(&agent_id),
    };
    if let (Some(old), Some(rid), Some(new)) = (
        unwritten_session.as_deref(),
        run_id.as_deref(),
        session_hint.as_deref(),
    ) {
        crate::runs::replace_unwritten_session(rid, old, new, |sid| {
            crate::sessions::fixed_id_session_exists(&agent_id, sid, &plan.env) == Some(false)
        })?;
    }
    // 每-agent 启动前文件准备（codex：写模型 catalog，让 /model 选择器列出全部模型）
    let extra_args = agents::prepare_launch(&profile)?;
    // 可写时的原生权限档（聊天权限徽标，2026-10-17）：ask / auto / full 只加在本次命令行上；
    // 缺省 = 按这家 CLI 本机设置。Run 的权限政策仍只有 discuss / write_tree 两种，不受影响
    let native_mode = match permission_mode.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(mode @ ("ask" | "auto" | "full")) => Some(mode),
        Some(other) => return Err(format!("不支持的权限档: {other}")),
    };
    let discuss = match permission.as_deref() {
        Some("discuss") => true,
        Some("write_tree") => false,
        Some(other) if !other.trim().is_empty() => {
            return Err(format!("不支持的权限政策: {other}"));
        }
        _ => readonly.unwrap_or(false),
    };
    // 恢复和新建必须兑现同一权限；能力不足不能只保留 discuss 标签。
    let plan_args = if discuss {
        agents::readonly_launch_args(&agent_id, &plan.args).ok_or(
            "此 Agent 不支持只讨论启动约束，请换支持只读/计划模式的 Agent 或明确选择可写权限",
        )?
    } else if let Some(mode) = native_mode {
        agents::permission_launch_args(&agent_id, &plan.args, mode)
            .ok_or("这家 Agent 没有所选的权限档，请换一档或改回「按本机设置」")?
    } else {
        plan.args.clone()
    };
    // 沉浸阅读会话（reuse_key = reader:<项目根>）按「请求批准」启动时，Claude Code 预放行
    // 改项目 notes/ 下的文件：读文献时让它写笔记不必一次次批准，改别处照常先问（2026-10-18）
    let mut plan_args = plan_args;
    if agent_id == "claude-code"
        && !discuss
        && native_mode == Some("ask")
        && reuse_key.as_deref().is_some_and(|k| k.starts_with("reader:"))
    {
        plan_args.push("--allowedTools".into());
        plan_args.push("Edit(./notes/**)".into());
    }

    let mut command_args = Vec::new();
    if let Some(sid) = &resume_session_id {
        let (prepend, args) = agents::resume_args(&agent_id, sid);
        if prepend {
            command_args.extend(args.iter().cloned());
        }
        command_args.extend(plan_args.iter().cloned());
        command_args.extend(extra_args.iter().cloned());
        if !prepend {
            command_args.extend(args.iter().cloned());
        }
    } else {
        command_args.extend(plan_args.iter().cloned());
        command_args.extend(extra_args.iter().cloned());
        // 确定性关联：会话文件名 = 该 uuid，启动即锁定（architecture §6.7）
        if let Some(sid) = &session_hint {
            command_args.push("--session-id".into());
            command_args.push(sid.clone());
        }
    }
    // MCP 密钥（mcp-keys.json）：清单只留 ${VAR}，启动时注入给各家 MCP 客户端展开
    let mcp_env = crate::mcp::spawn_env_secrets();
    let registered_claim = if session_hint.is_none() {
        link_claim_id.as_deref().map(|claim_id| {
            crate::sessions::register_session_claim(claim_id, &agent_id, &cwd);
            claim_id.to_string()
        })
    } else {
        None
    };
    let opened = crate::runs::open_for_interactive_spawn(
        &agent_id,
        &profile_id,
        &expand_tilde(&cwd),
        reuse_key.as_deref(),
        resume_session_id.as_deref().or(session_hint.as_deref()),
        discuss,
        run_id.as_deref(),
        task_id.as_deref(),
    )?;
    if opened.is_none() {
        let reuse = reuse_key.as_deref().unwrap_or("");
        if !reuse.starts_with("login:") {
            return Err("交互启动必须先登记任务".into());
        }
    }
    let opened_id = opened.as_ref().map(|r| r.id.clone());
    if let Some(id) = opened_id.as_deref() {
        // 这条 Run 的 Codex 还在跑（本机已有 `codex resume <id>`）：把现成 PTY 交回，
        // 不要再 claim/再拉起——否则报「此运行已在启动或执行中」，快速开聊无法恢复。
        if let Some(existing_pty) = manager.inner().pty_id_for_run(id) {
            crate::sessions::invalidate_scan_cache();
            return Ok(SpawnResult {
                pty_id: existing_pty,
                session_hint,
                prompt_dropped: false,
                model,
                run_id: opened_id,
                adopted: true,
                resume_unwritten: unwritten_session.is_some(),
            });
        }
        crate::runs::claim_interactive_start(id, false)?;
    }
    if let (Some(id), Some(sid)) = (opened_id.as_deref(), session_hint.as_deref()) {
        let _ = crate::runs::attach_session_impl(id, sid);
    }
    // 聊天层结构化旁路（chat_channel.rs）：按这家改启动参数 / 加环境变量，Codex 先拉起私有 app-server。
    // 起不来就照旧启动；参数里还没有初始 prompt（位置参数必须在最后）
    let mut channel_env_full: Vec<(String, String)> = plan.env.clone();
    channel_env_full.extend(mcp_env.iter().map(|(k, v)| (k.clone(), v.clone())));
    if let Some(extra) = &extra_env {
        channel_env_full.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    let (channel_env, channel) = crate::chat_channel::prepare(
        &agent_id,
        link_claim_id.as_deref(),
        &expand_tilde(&cwd),
        &binary_path,
        &mut command_args,
        &channel_env_full,
        &plan.env_remove,
    );
    if resume_session_id.is_none() {
        // 初始 prompt 放最后：位置参数形态（claude/codex）必须是命令行最后一个参数
        for arg in &plan.prompt_args {
            command_args.push(arg.clone());
        }
    }
    let mut cmd = crate::process::pty_command(&binary_path, &command_args);
    for (k, v) in &plan.env {
        cmd.env(k, v);
    }
    // 官方账号模式：剔除继承环境里的残留 API 密钥变量（防静默覆盖账号登录）
    for k in &plan.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &mcp_env {
        cmd.env(k, v);
    }
    if let Some(extra) = &extra_env {
        for (k, v) in extra {
            cmd.env(k, v);
        }
    }
    for (k, v) in &channel_env {
        cmd.env(k, v);
    }
    let pty_id = match spawn_tracked(
        &app,
        manager.inner(),
        cmd,
        &expand_tilde(&cwd),
        PtyPurpose::Agent,
        opened_id.clone(),
        pty_size_from(cols, rows),
        None,
        channel.as_ref().is_some_and(|c| c.program_status()),
    ) {
        Ok(pty_id) => pty_id,
        Err(error) => {
            if let Some(channel) = channel {
                channel.abort();
            }
            if let Some(claim_id) = registered_claim {
                crate::sessions::release_session_claim_impl(&claim_id);
            }
            if let Some(id) = opened_id {
                let _ = crate::runs::close_run_with_result(
                    &id,
                    None,
                    "failed",
                    None,
                    Some("PTY 启动失败"),
                );
            }
            return Err(error);
        }
    };
    if let Some(channel) = channel {
        crate::chat_channel::start(&app, &pty_id, channel);
    }
    if let Some(id) = opened_id.as_deref() {
        if let Err(error) = crate::runs::mark_started(id) {
            discard_spawned_pty(&app, manager.inner(), &pty_id);
            let _ = crate::runs::close_run_with_result(
                id,
                None,
                "failed",
                None,
                Some("Run 状态登记失败"),
            );
            return Err(error);
        }
    }
    // 官方账号（订阅制）启动：按会话级登记 usage provenance，统计页费用栏据此显示「订阅」。
    // 尽力而为：登记失败不阻断启动（与 touch_last_used 同语义）；
    // session_hint 为空（无固定会话 id 的 agent 新开）时不落行，重建索引按会话档案的 profile 兜底
    if profile.account_type == profiles::AccountType::Official {
        let _ = crate::usage::register_official_launch(
            &agent_id,
            std::path::Path::new(&cwd),
            session_hint.as_deref(),
        );
    }
    crate::sessions::invalidate_scan_cache();
    store.touch_last_used(&profile_id);
    Ok(SpawnResult {
        pty_id,
        session_hint,
        prompt_dropped: plan.prompt_dropped,
        model,
        run_id: opened_id,
        adopted: false,
        resume_unwritten: unwritten_session.is_some(),
    })
}

/// 拉起用户的登录 shell，供 agent 退出后回落或纯终端使用。参数含义见 `shell_spawn_sync`
#[tauri::command]
pub async fn shell_spawn(
    app: AppHandle,
    cwd: String,
    extra_env: Option<std::collections::HashMap<String, String>>,
    purpose: Option<String>,
    run_id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = spawn_turn();
        shell_spawn_sync(app.clone(), app.state(), cwd, extra_env, purpose, run_id, cols, rows)
    })
    .await
    .map_err(|e| format!("启动终端失败: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn shell_spawn_sync(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    cwd: String,
    // 附加环境变量（如工作区 CCODE_PORT 段），run 脚本场景必须传入
    extra_env: Option<std::collections::HashMap<String, String>>,
    // script = 工作区 run 脚本；其他/缺省 = 普通登录 shell
    purpose: Option<String>,
    // 自定义 Runtime 等：进程退出时 close 该 Run
    run_id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let (shell, mut shell_args, kind) = if purpose.as_deref() == Some("script") {
        let (shell, args) = script_shell_argv()?;
        (shell, args, None)
    } else {
        let setting = crate::settings::read_current().terminal_shell;
        let (shell, args, kind) = interactive_shell(setting.as_deref());
        (shell, args, Some(kind))
    };
    let mut cmd = CommandBuilder::new(&shell);
    let cwd_file = kind.and_then(|k| attach_cwd_tracking(&mut cmd, &mut shell_args, k));
    for arg in &shell_args {
        cmd.arg(arg);
    }
    if let Some(env) = extra_env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let purpose = if purpose.as_deref() == Some("script") {
        PtyPurpose::Script
    } else {
        PtyPurpose::Shell
    };
    let run_id = run_id.filter(|s| !s.trim().is_empty());
    if let Some(id) = run_id.as_deref() {
        crate::runs::claim_interactive_start(id, manager.inner().has_run(id))?;
    }
    match spawn_tracked(
        &app,
        manager.inner(),
        cmd,
        &expand_tilde(&cwd),
        purpose,
        run_id.clone(),
        pty_size_from(cols, rows),
        cwd_file,
        false,
    ) {
        Ok(id) => {
            if let Some(entry) = manager.inner().entries.lock().unwrap().get_mut(&id) {
                entry.shell_kind = kind;
            }
            if let Some(run_id) = run_id.as_deref() {
                if let Err(error) = crate::runs::mark_started(run_id) {
                    discard_spawned_pty(&app, manager.inner(), &id);
                    let _ = crate::runs::close_run_with_result(
                        run_id,
                        None,
                        "failed",
                        None,
                        Some("Run 状态登记失败"),
                    );
                    return Err(error);
                }
            }
            Ok(id)
        }
        Err(e) => {
            if let Some(run_id) = run_id.as_deref() {
                let _ = crate::runs::close_run_with_result(
                    run_id,
                    None,
                    "failed",
                    None,
                    Some("Runtime 启动失败"),
                );
            }
            Err(e)
        }
    }
}

/// 直接启动登记的 Custom Runtime。刻意不经过 shell，避免引号拼接、
/// shell 注入以及 Windows/POSIX 参数语义差异。
#[tauri::command]
pub async fn pty_spawn_custom(
    app: AppHandle,
    runtime_id: String,
    cwd: String,
    run_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SpawnResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = spawn_turn();
        pty_spawn_custom_sync(app.clone(), app.state(), runtime_id, cwd, run_id, cols, rows)
    })
    .await
    .map_err(|e| format!("启动终端失败: {e}"))?
}

fn pty_spawn_custom_sync(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    runtime_id: String,
    cwd: String,
    run_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SpawnResult, String> {
    let runtime = crate::custom_runtime::get_custom_runtime(&runtime_id)?;
    let cwd = crate::custom_runtime::resolve_custom_cwd(&cwd, runtime.cwd.as_deref())?;
    let cwd = expand_tilde(&cwd);
    let run = crate::runs::run_get_sync(run_id.clone())?
        .ok_or_else(|| "Custom Runtime 对应的 Run 不存在".to_string())?;
    let isolation = expand_tilde(&run.isolation_path);
    let cwd_path = crate::paths::canonicalize_plain(std::path::Path::new(&cwd))
        .map_err(|e| format!("工作目录不可用：{e}"))?;
    let isolation_path = crate::paths::canonicalize_plain(std::path::Path::new(&isolation))
        .map_err(|e| format!("隔离目录不可用：{e}"))?;
    if !crate::paths::path_within_path(&cwd_path, &isolation_path) {
        return Err("Custom Runtime 的工作目录必须位于 Run 隔离目录内".into());
    }
    if run.runtime != "custom" {
        return Err("Run 不是 Custom Runtime".into());
    }
    crate::runs::claim_interactive_start(&run_id, manager.inner().has_run(&run_id))?;
    let mut cmd =
        crate::process::pty_command(std::path::Path::new(&runtime.command), &runtime.args);
    for (key, value) in runtime.env {
        cmd.env(key, value);
    }
    let pty_id = match spawn_tracked(
        &app,
        manager.inner(),
        cmd,
        &cwd_path.to_string_lossy(),
        PtyPurpose::Agent,
        Some(run_id.clone()),
        pty_size_from(cols, rows),
        None,
        false,
    ) {
        Ok(id) => id,
        Err(error) => {
            let _ = crate::runs::close_run_with_result(
                &run_id,
                None,
                "failed",
                None,
                Some("Custom Runtime 启动失败"),
            );
            return Err(error);
        }
    };
    if let Err(error) = crate::runs::mark_started(&run_id) {
        discard_spawned_pty(&app, manager.inner(), &pty_id);
        let _ = crate::runs::close_run_with_result(
            &run_id,
            None,
            "failed",
            None,
            Some("Custom Runtime 状态登记失败"),
        );
        return Err(error);
    }
    Ok(SpawnResult {
        pty_id,
        session_hint: None,
        prompt_dropped: false,
        model: None,
        run_id: Some(run_id),
        adopted: false,
        resume_unwritten: false,
    })
}

/// 这条 Run 上已经在跑的 PTY。只读，不启动、不改行列。
/// 空 id 返回 None。前端在收起启动栏之前先问这一次，避免按矮格子新开进程。
#[tauri::command]
pub fn pty_id_for_run(manager: tauri::State<'_, PtyManager>, run_id: String) -> Option<String> {
    manager.inner().pty_id_for_run(&run_id)
}

/// 登录 shell 的程序与参数（纯函数，便于单测）。
///
/// Windows 上**刻意不读 `SHELL`**：从资源管理器/开始菜单启动根本读不到；
/// 从 Git Bash 启动读到的是 MSYS 路径（`/usr/bin/bash`），Win32 CreateProcess
/// 同样找不到 —— 读了只会把失败从「没有该变量」变成「路径无效」。
/// 选 PowerShell 而非 cmd：它是 Windows 10+ 标配与 Windows Terminal 的默认交互 shell，
/// 且单引号引用语义与 POSIX 接近，前端预填的 `cd '<路径>'` 无需另写一套转义。
/// `-l` 是 POSIX 登录 shell 专属参数，Windows 侧不传。
/// `-ExecutionPolicy Bypass` 只作用于这个进程：客户端 Windows 默认策略 Restricted，
/// 用户在内置终端敲 `codex`/`claude` 会命中 npm 生成的 `.ps1` 垫片并报「禁止运行脚本」。
/// 不改用户机器/账户级策略；组策略强制的策略仍优先（PowerShell 自身语义）。
#[cfg(windows)]
fn login_shell_argv() -> (String, Vec<String>) {
    if let Some(ps) = crate::agents::resolve_binary("powershell") {
        return (
            ps.to_string_lossy().into_owned(),
            vec![
                "-NoLogo".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
            ],
        );
    }
    (
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
        Vec::new(),
    )
}

#[cfg(not(windows))]
fn login_shell_argv() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    (shell, vec!["-l".to_string()])
}

// ===== 内置终端 shell 选择（设置 → 终端 → 内置终端 shell）=====

/// shell 的种类：决定启动参数与「跟随 cd」怎么接（只有 Windows 需要接，macOS / Linux 直接读进程 cwd）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum ShellKind {
    PowerShell,
    GitBash,
    Cmd,
    Posix,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOptionDto {
    /// 落 settings.terminal_shell 的值
    pub id: &'static str,
    pub label: &'static str,
    pub path: String,
}

/// 本机找得到的可选 shell：(id, 显示名, 程序, 种类)。顺序即设置页下拉顺序
#[cfg(windows)]
fn shell_candidates() -> Vec<(&'static str, &'static str, std::path::PathBuf, ShellKind)> {
    let mut out = Vec::new();
    if let Some(p) = crate::agents::resolve_binary("powershell") {
        out.push(("powershell", "Windows PowerShell", p, ShellKind::PowerShell));
    }
    if let Some(p) = crate::agents::resolve_binary("pwsh") {
        out.push(("pwsh", "PowerShell 7", p, ShellKind::PowerShell));
    }
    if let Some(p) = crate::agents::resolve_git_bash() {
        out.push(("git-bash", "Git Bash", p, ShellKind::GitBash));
    }
    let cmd = std::env::var_os("COMSPEC")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| crate::agents::resolve_binary("cmd"));
    if let Some(p) = cmd {
        out.push(("cmd", "命令提示符（cmd）", p, ShellKind::Cmd));
    }
    out
}

#[cfg(not(windows))]
fn shell_candidates() -> Vec<(&'static str, &'static str, std::path::PathBuf, ShellKind)> {
    let mut out = Vec::new();
    for (id, fixed) in [("zsh", "/bin/zsh"), ("bash", "/bin/bash")] {
        let p = std::path::PathBuf::from(fixed);
        let found = if p.is_file() {
            Some(p)
        } else {
            crate::agents::resolve_binary(id)
        };
        if let Some(p) = found {
            out.push((id, id, p, ShellKind::Posix));
        }
    }
    if let Some(p) = crate::agents::resolve_binary("fish") {
        out.push(("fish", "fish", p, ShellKind::Posix));
    }
    out
}

/// 某个 shell 的启动参数（PowerShell 带进程级 Bypass，理由见 login_shell_argv）
fn shell_args_for(kind: ShellKind) -> Vec<String> {
    match kind {
        ShellKind::PowerShell => ["-NoLogo", "-ExecutionPolicy", "Bypass"]
            .map(String::from)
            .to_vec(),
        ShellKind::GitBash | ShellKind::Posix => vec!["-l".to_string()],
        ShellKind::Cmd => Vec::new(),
    }
}

/// 内置终端（普通 shell 标签）实际用的 shell：设置里选了且本机找得到就用它，否则平台默认。
/// run 脚本不走这里（script_shell_argv：Windows 固定 Git Bash，其余平台登录 shell）
fn interactive_shell(setting: Option<&str>) -> (String, Vec<String>, ShellKind) {
    if let Some(id) = setting.filter(|v| !v.is_empty() && *v != "auto") {
        if let Some((_, _, path, kind)) = shell_candidates().into_iter().find(|c| c.0 == id) {
            return (path.to_string_lossy().into_owned(), shell_args_for(kind), kind);
        }
    }
    let (program, args) = login_shell_argv();
    let lower = program.to_ascii_lowercase();
    let kind = if lower.contains("powershell") || lower.contains("pwsh") {
        ShellKind::PowerShell
    } else if cfg!(windows) && lower.ends_with("cmd.exe") {
        ShellKind::Cmd
    } else {
        ShellKind::Posix
    };
    (program, args, kind)
}

/// 设置页「内置终端 shell」下拉的候选（只列本机找得到的；「自动」由前端固定加在最前）
#[tauri::command]
pub fn terminal_shell_options() -> Vec<ShellOptionDto> {
    shell_candidates()
        .into_iter()
        .map(|(id, label, path, _)| ShellOptionDto {
            id,
            label,
            path: crate::paths::strip_verbatim(path).to_string_lossy().into_owned(),
        })
        .collect()
}

// ===== Windows：shell 里 cd 后文件树 / Git 面板跟随 =====
//
// macOS 用 lsof、Linux 读 /proc 拿进程 cwd；Windows 没有轻量办法，而且 PowerShell 的 Set-Location
// 根本不改进程工作目录。所以由 shell 自己在每次出提示符时把当前目录写进一个小文件
// （PowerShell 包一层 prompt 函数，Git Bash 用 PROMPT_COMMAND 跑 `pwd -W`），pty_get_cwd 读它；
// cmd 的 cd 会改进程工作目录，读不到文件时从进程环境块（PEB）里取。文件随标签退出删除，启动时清残留。

/// PowerShell 的 prompt 包装：先记目录再交回原来的 prompt（用户 profile 里的主题照常生效）。
/// 只用单引号：整段经 CreateProcess 命令行传，不能含双引号
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
const PS_CWD_HOOK: &str = "$global:__ccodeCwdFile = $env:CCODE_CWD_FILE; \
$global:__ccodePrompt = $function:prompt; \
function global:prompt { if ($global:__ccodeCwdFile -and $PWD.Provider.Name -eq 'FileSystem') { \
try { [IO.File]::WriteAllText($global:__ccodeCwdFile, $PWD.ProviderPath) } catch { } }; & $global:__ccodePrompt }";

#[cfg_attr(not(windows), allow(dead_code))]
fn cwd_track_dir() -> Option<std::path::PathBuf> {
    crate::storage::config_root().map(|r| r.join("pty-cwd"))
}

/// 启动时清掉上次没删成的目录记录文件（崩溃 / 强杀留下的）
pub(crate) fn purge_cwd_track_files() {
    if let Some(dir) = cwd_track_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// 给这个 shell 接上目录记录：返回记录文件路径（不支持或建目录失败返回 None，照常启动）
#[cfg(windows)]
fn attach_cwd_tracking(
    cmd: &mut CommandBuilder,
    args: &mut Vec<String>,
    kind: ShellKind,
) -> Option<std::path::PathBuf> {
    if kind == ShellKind::Cmd || kind == ShellKind::Posix {
        return None;
    }
    let dir = cwd_track_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("{}.txt", uuid::Uuid::new_v4()));
    cmd.env("CCODE_CWD_FILE", &file);
    match kind {
        ShellKind::PowerShell => {
            args.extend(["-NoExit", "-Command", PS_CWD_HOOK].map(String::from));
        }
        ShellKind::GitBash => {
            let posix = file.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
            cmd.env("PROMPT_COMMAND", format!("pwd -W > '{posix}' 2>/dev/null"));
        }
        ShellKind::Cmd | ShellKind::Posix => {}
    }
    Some(file)
}

#[cfg(not(windows))]
fn attach_cwd_tracking(
    _cmd: &mut CommandBuilder,
    _args: &mut Vec<String>,
    _kind: ShellKind,
) -> Option<std::path::PathBuf> {
    None
}

/// 读 shell 写下的目录记录：正斜杠转回反斜杠，必须是存在的目录
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn read_cwd_track_file(file: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let p = text.trim().trim_start_matches('\u{feff}');
    if p.is_empty() {
        return None;
    }
    let p = if cfg!(windows) { p.replace('/', "\\") } else { p.to_string() };
    std::path::Path::new(&p).is_dir().then_some(p)
}

/// 流水线 run 脚本（render-pdf 等）是 bash。Windows 交互 shell 是 PowerShell，
/// 必须改走 Git Bash，否则 `mkdir -p` / `command -v` 整链失败。
#[cfg(windows)]
fn script_shell_argv() -> Result<(String, Vec<String>), String> {
    let bash = crate::agents::resolve_git_bash().ok_or(
        "找不到 Git Bash，无法运行流水线脚本（setup/archive 钩子与 render-pdf）。请安装 Git for Windows 后重启 Mesa。",
    )?;
    Ok((bash.to_string_lossy().into_owned(), vec!["-l".to_string()]))
}

#[cfg(not(windows))]
fn script_shell_argv() -> Result<(String, Vec<String>), String> {
    Ok(login_shell_argv())
}

#[tauri::command]
pub async fn pty_write(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    let (writer, paste_on) = {
        let entries = manager.entries.lock().unwrap();
        let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
        (
            entry.writer.clone(),
            entry.bracketed_paste.load(Ordering::Relaxed),
        )
    };
    // 先按 IPC 到达次序入队，再后台等待；不能让线程池调度把按键顺序打乱。
    let receipt = writer.enqueue_pieces(pty_input_pieces(&wrap_bracketed_paste(&data, paste_on)), None)?;
    tauri::async_runtime::spawn_blocking(move || receipt.wait())
        .await
        .map_err(|e| e.to_string())?
}

/// 按 shell 方言拼一行「切到这个目录」（含回车）：PowerShell / POSIX 单引号，Git Bash 转正斜杠，
/// cmd 用 `cd /d` + 双引号（cmd 不认单引号，跨盘还得带 /d）
fn cd_line(kind: ShellKind, path: &str) -> String {
    let enter = if cfg!(windows) { "\r" } else { "\n" };
    match kind {
        ShellKind::PowerShell => format!("cd '{}'{enter}", path.replace('\'', "''")),
        ShellKind::Cmd => format!("cd /d \"{}\"{enter}", path.replace('"', "")),
        ShellKind::GitBash => format!(
            "cd '{}'{enter}",
            path.replace('\\', "/").replace('\'', "'\\''")
        ),
        ShellKind::Posix => format!("cd '{}'{enter}", path.replace('\'', "'\\''")),
    }
}

/// 让普通 shell 标签切到某个目录（工作区归档后切回主仓、最近项目「真进入」）：按这个标签实际
/// 用的 shell 写 cd——用户在设置里换成 cmd / Git Bash 后，前端拼的 PowerShell 写法会失败
#[tauri::command]
pub async fn pty_cd(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    path: String,
) -> Result<(), String> {
    let (writer, line) = {
        let entries = manager.entries.lock().unwrap();
        let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
        let kind = entry.shell_kind.unwrap_or_else(|| interactive_shell(None).2);
        (entry.writer.clone(), cd_line(kind, &path))
    };
    let receipt = writer.enqueue(line.as_bytes(), None)?;
    tauri::async_runtime::spawn_blocking(move || receipt.wait())
        .await
        .map_err(|e| e.to_string())?
}

/// Windows 专用：把终端前景/底色（OSC 10/11 回报载荷）主动推给 agent。
///
/// agent TUI 启动时会用 OSC 11 查询终端底色来选浅/深配色，但 ConPTY **两个方向都不通**：
/// 子进程发出的查询到不了宿主终端（xterm 的 OSC handler 永不触发），成形的回报也进不了
/// 子进程。所以这里不等查询，attach 后直接按 win32-input-mode 记录推一次——ConPTY 会
/// 缓冲，即便早于子进程开始读 stdin 也不会丢（详见 docs/conventions/terminal.md）。
///
/// 投递放后台线程：整串约 100ms（每条记录间隔 `WIN32_INPUT_RECORD_GAP`），不能阻塞 IPC，
/// 更不能把 `entries` 锁攥满全程——那会卡住其它标签的按键。
#[tauri::command]
pub fn pty_report_terminal_colors(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    reports: Vec<String>,
) -> Result<(), String> {
    let manager = PtyManager {
        entries: manager.entries.clone(),
    };
    std::thread::spawn(move || {
        for report in reports {
            for record in win32_input_records(&report) {
                // 标签被秒关 / agent 已退出：静默收手，这只是配色兜底，失败不该打扰用户
                if write_pty_bytes(&manager, &pty_id, record.as_bytes()).is_err() {
                    return;
                }
                std::thread::sleep(WIN32_INPUT_RECORD_GAP);
            }
        }
    });
    Ok(())
}

/// 将聊天消息和提交键作为同一个输入队列请求，避免其它输入插入中间。
/// 文本仍遵守 bracketed-paste 规则，提交键在粘贴包结束后单独写入，
/// 避免前端两个 IPC 调用之间被 TUI 切帧，也避免多行消息把回车吞进粘贴文本。
/// `paste_newline`：粘贴包里的换行写成什么——"\r"（见 chat_paste_body）或 "shift-enter"（见 shift_enter_pieces），缺省照原样 LF
#[tauri::command]
pub async fn pty_write_submit(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    text: String,
    submit: String,
    paste_newline: Option<String>,
) -> Result<(), String> {
    let (cr_newlines, shift_enter) = match paste_newline.as_deref() {
        None | Some("\n") => (false, false),
        Some("\r") => (true, false),
        Some("shift-enter") => (false, true),
        Some(_) => return Err("无效的粘贴换行".into()),
    };
    let (writer, paste_on) = {
        let entries = manager.entries.lock().unwrap();
        let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
        (
            entry.writer.clone(),
            entry.bracketed_paste.load(Ordering::Relaxed),
        )
    };
    let body = chat_paste_body(&text, paste_on, cr_newlines);
    // 粘贴包后的回车多等一会儿：Qwen 在 Windows 上吞掉粘贴后 500ms 内的回车（pty_input PASTE_SUBMIT_GAP）
    let pasted = body.starts_with("\x1b[200~");
    let pieces = if shift_enter && cfg!(windows) {
        shift_enter_pieces(&body)
    } else {
        pty_input_pieces(&body)
    };
    let receipt = writer.enqueue_submit(pieces, submit.as_bytes(), pasted)?;
    tauri::async_runtime::spawn_blocking(move || receipt.wait())
        .await
        .map_err(|e| format!("写入终端失败：{e}"))?
}

/// 关窗守卫用：PTY 在管且子进程尚未退出才为 true。
/// try_wait 是非阻塞探测（unix 走 waitpid WNOHANG，Windows 查进程退出码），
/// 已退出时会顺带回收并缓存退出状态，不影响清理路径再 wait 取真实退出码；
/// 探测本身出错按「未在运行」处理（entry 缺失/进程已回收等边界都归到 false）
#[tauri::command]
pub fn pty_has_running_process(manager: tauri::State<'_, PtyManager>, pty_id: String) -> bool {
    has_running_process(manager.inner(), &pty_id)
}

fn has_running_process(manager: &PtyManager, pty_id: &str) -> bool {
    let mut entries = manager.entries.lock().unwrap();
    match entries.get_mut(pty_id) {
        Some(entry) => child_running(entry.child.as_mut()),
        None => false,
    }
}

/// 子进程仍在运行 = 非阻塞 try_wait 尚未取到退出状态（探测出错按未运行处理）
fn child_running(child: &mut (dyn Child + Send + Sync)) -> bool {
    matches!(child.try_wait(), Ok(None))
}

#[tauri::command]
pub fn pty_resize(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let entries = manager.entries.lock().unwrap();
    let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
    entry
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}

/// 标签退出：删掉目录记录文件（先 take，entry 随后会被拆开消费）
fn forget_cwd_file(entry: &mut PtyEntry) {
    if let Some(file) = entry.cwd_file.take() {
        let _ = std::fs::remove_file(file);
    }
}

/// 进程的真实 cwd：macOS 走 lsof，Linux 读 /proc，Windows 见下（读不到返回 None，前端回落启动栏 cwd）
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32, _cwd_file: Option<&std::path::Path>) -> Option<String> {
    let out = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|s| s.to_string()))
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32, _cwd_file: Option<&std::path::Path>) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Windows：先读 shell 写下的目录记录（PowerShell / Git Bash），没有再从进程环境块取（cmd 的 cd 改的就是它）
#[cfg(target_os = "windows")]
fn process_cwd(pid: u32, cwd_file: Option<&std::path::Path>) -> Option<String> {
    cwd_file
        .and_then(read_cwd_track_file)
        .or_else(|| peb_current_directory(pid))
}

/// 读另一个进程的当前目录：PEB → RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath。
/// 偏移按 64 位布局（PEB+0x20 = ProcessParameters，参数块 +0x38 = DosPath 的 UNICODE_STRING）；
/// 只读自己拉起的子进程，读不到返回 None
#[cfg(all(target_os = "windows", target_pointer_width = "64"))]
fn peb_current_directory(pid: u32) -> Option<String> {
    use std::ffi::c_void;
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return None;
        }
        let read = |addr: usize, buf: *mut c_void, len: usize| -> bool {
            let mut got = 0usize;
            ReadProcessMemory(handle, addr as *const c_void, buf, len, &mut got) != 0 && got == len
        };
        let result = (|| {
            // PROCESS_BASIC_INFORMATION：6 个指针宽的槽，第 2 个是 PebBaseAddress
            let mut pbi = [0usize; 6];
            let mut ret = 0u32;
            let status = NtQueryInformationProcess(
                handle,
                ProcessBasicInformation,
                pbi.as_mut_ptr() as *mut c_void,
                std::mem::size_of_val(&pbi) as u32,
                &mut ret,
            );
            if status < 0 || pbi[1] == 0 {
                return None;
            }
            let mut params = 0usize;
            if !read(pbi[1] + 0x20, &mut params as *mut usize as *mut c_void, 8) || params == 0 {
                return None;
            }
            // UNICODE_STRING：Length(u16) MaximumLength(u16) 填充(4) Buffer(ptr)
            let mut ustr = [0u8; 16];
            if !read(params + 0x38, ustr.as_mut_ptr() as *mut c_void, 16) {
                return None;
            }
            let len = u16::from_le_bytes([ustr[0], ustr[1]]) as usize;
            let buf = usize::from_le_bytes(ustr[8..16].try_into().ok()?);
            if len == 0 || len > 0x8000 || buf == 0 {
                return None;
            }
            let mut wide = vec![0u16; len / 2];
            if !read(buf, wide.as_mut_ptr() as *mut c_void, len) {
                return None;
            }
            Some(trim_dir_backslash(String::from_utf16_lossy(&wide)))
        })();
        CloseHandle(handle);
        result
    }
}

#[cfg(all(target_os = "windows", not(target_pointer_width = "64")))]
fn peb_current_directory(_pid: u32) -> Option<String> {
    None
}

/// PEB 里的目录带结尾反斜杠（`C:\work\`）；盘根保留（`C:\`）
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn trim_dir_backslash(p: String) -> String {
    let trimmed = p.trim_end_matches('\\');
    if trimmed.len() <= 2 && trimmed.ends_with(':') {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    }
}

/// 活动 PTY 进程的真实工作目录（文件树/git 面板跟随 shell 内的 cd）
/// macOS 上取 cwd 要起 lsof（实测 25–50ms）：全局锁里只取 pid，锁外再查；同步命令还会占主线程，所以放后台线程
#[tauri::command]
pub async fn pty_get_cwd(app: AppHandle, pty_id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (pid, file) = {
            let manager = app.state::<PtyManager>();
            let mut entries = manager.entries.lock().unwrap();
            let entry = entries.get_mut(&pty_id)?;
            (entry.child.process_id()?, entry.cwd_file.clone())
        };
        process_cwd(pid, file.as_deref())
    })
    .await
    .ok()
    .flatten()
}

/// 终端里点到的路径能不能打开：相对路径按 cwd 拼、`~` 按 home 展开，
/// 存在且是文件才返回规范化绝对路径（None = 点空）。终端链接的点击时终审，
/// 一次调用一次 stat，避免为整屏候选做 IPC。
#[tauri::command]
pub fn terminal_link_target(cwd: String, path: String) -> Option<String> {
    use std::path::Path;
    if path.len() > 512 || path.is_empty() {
        return None;
    }
    let expanded = if path.starts_with('~') {
        let tilde = crate::paths::expand_tilde(&path);
        std::path::PathBuf::from(tilde)
    } else {
        Path::new(&cwd).join(&path)
    };
    // canonicalize 顺带解符号链接；显示/回传前剥 Windows 的 \\?\ 前缀
    let canonical = crate::paths::canonicalize_plain(&expanded).ok()?;
    if !canonical.is_file() {
        return None;
    }
    Some(
        crate::paths::strip_verbatim(canonical)
            .to_string_lossy()
            .into_owned(),
    )
}

/// 标记标签可见性（优化 2）：翻转为可见时在 sink 锁内补发积压输出，
/// 与发送线程互斥，保证补发严格先于之后的实时输出。转后台时流控清零（前端不再收这个标签的帧）
#[tauri::command]
pub fn pty_set_visible(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    visible: bool,
) -> Result<(), String> {
    let entries = manager.entries.lock().unwrap();
    let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
    let mut sink = entry.sink.lock().unwrap();
    entry.visible.store(visible, Ordering::Relaxed);
    if visible {
        flush_backlog(&mut sink, &entry.flow);
    } else {
        entry.flow.reset();
    }
    Ok(())
}

/// 前端接上这个 PTY 的输出通道（attach 时每次新建一条；旧通道随 drop 通知前端收尾）。
/// 接上之前与隐藏期间的输出都在 backlog 里，可见就当场补发
#[tauri::command]
pub fn pty_subscribe(
    manager: tauri::State<'_, PtyManager>,
    pty_id: String,
    channel: Channel,
) -> Result<(), String> {
    let entries = manager.entries.lock().unwrap();
    let entry = entries.get(&pty_id).ok_or("终端不存在或已退出")?;
    let mut sink = entry.sink.lock().unwrap();
    sink.channel = Some(channel);
    entry.flow.reset();
    if entry.visible.load(Ordering::Relaxed) {
        flush_backlog(&mut sink, &entry.flow);
    }
    Ok(())
}

/// 前端画完了这么多字（UTF-16 码元）：流控确认，读线程按需恢复读取
#[tauri::command]
pub fn pty_ack(manager: tauri::State<'_, PtyManager>, pty_id: String, units: usize) {
    if let Some(entry) = manager.entries.lock().unwrap().get(&pty_id) {
        entry.flow.ack(units);
    }
}

/// unix 下终止子进程的整个进程组：portable-pty spawn 时子进程已 setsid
///（pid == pgid），kill 负 pgid 连带杀掉 agent 拉起的子孙。只杀直接子进程
/// 会让持有 PTY slave 的子孙成孤儿，reader 线程永远等不到 EOF。
/// Windows（ConPTY）无进程组语义，保持 child.kill() 原路径。
/// 已知边角：交互 shell 的作业控制会把每个作业放进新进程组，不在此覆盖——
/// entry 随本函数 drop 时 master 关闭，内核会向 slave 前台进程组发 SIGHUP 兜底。
#[cfg(unix)]
pub(crate) fn kill_process_group(pid: u32) {
    // 用 /bin/kill 绝对路径：打包版 GUI 的 PATH 很短；负 pid 表示整个进程组
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", &format!("-{pid}")])
        .status();
}

/// 连带终止子孙进程（非 PTY、走裸管道的超时路径专用）。
///
/// 只杀直接子进程在 Windows 上必然留孤儿：`shell_cmd` 走的是 `cmd /C <script>`，
/// cmd.exe 永不 exec-替换自己，真正干活的 npm/node 是**孙进程**。
/// `TerminateProcess(cmd.exe)` 之后孙进程照常运行，且它继承了 stdout/stderr 管道写端
/// ⇒ 读线程永远等不到 EOF，`join()` 永久阻塞、工作线程泄漏，构建进程还占着端口和工作树
/// 文件让后续「归档工作区」失败。taskkill 的 `/T` 遍历整棵进程树。
pub(crate) fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    kill_process_group(pid);
    #[cfg(windows)]
    {
        let mut cmd = crate::process::background_command("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
        cmd.stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Ok(mut taskkill) = cmd.spawn() {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match taskkill.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) if Instant::now() >= deadline => {
                        let _ = taskkill.kill();
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        }
    }
}

fn terminate_pty_child(mut child: Box<dyn Child + Send + Sync>) {
    if let Some(pid) = child.process_id() {
        kill_process_tree(pid);
    }
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() >= deadline => {
                // 最后回收不阻塞 IPC；管理表已移除，主窗口仍可响应。
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn discard_spawned_pty(app: &AppHandle, manager: &PtyManager, id: &str) {
    let entry = manager.entries.lock().unwrap().remove(id);
    if let Some(mut entry) = entry {
        entry.flow.close();
        forget_cwd_file(&mut entry);
        terminate_pty_child(entry.child);
        let _ = app.emit(&format!("pty-exit-{id}"), -1);
    }
}

/// 在后台线程做（见 SPAWN_LOCK 上方说明）。紧接着要按同一 Run 重新拉起的调用方必须 await 它：
/// Run 的收尾登记在等子进程退出之后，不等完就拉起，新进程认领的 Run 会被这里随后的收尾关掉
#[tauri::command]
pub async fn pty_kill(app: AppHandle, pty_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<PtyManager>();
        let entry = manager.entries.lock().unwrap().remove(&pty_id);
        if let Some(mut entry) = entry {
            entry.flow.close();
            forget_cwd_file(&mut entry);
            terminate_pty_child(entry.child);
            if let Some(run_id) = entry.run_id {
                let _ = crate::runs::close_run_with_result(
                    &run_id,
                    None,
                    "stopped",
                    None,
                    Some("用户主动停止"),
                );
            }
            let _ = app.emit(&format!("pty-exit-{pty_id}"), -1);
        }
    })
    .await
    .map_err(|e| format!("停止终端失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_commands_stay_off_main_thread() {
        // 不带 async 的 Tauri 命令跑在主线程上。这几个会等子进程 / 外部应用 / 回收站或冻结快照，
        // 改回同步，等待期间所有终端的输出和按键都会停住（conventions/terminal.md「会等待的命令不占主线程」）
        let sources: [(&str, &str, &[&str]); 5] = [
            (
                "pty.rs",
                include_str!("pty.rs"),
                &["pty_spawn", "shell_spawn", "pty_spawn_custom", "pty_kill", "pty_get_cwd"],
            ),
            (
                "agents.rs",
                include_str!("agents.rs"),
                &["resume_external_terminal", "new_external_terminal", "digest_external_terminal"],
            ),
            (
                "runs.rs",
                include_str!("runs.rs"),
                &["run_close", "run_get", "run_list", "task_list"],
            ),
            (
                "scheduler.rs",
                include_str!("scheduler.rs"),
                &["delete_schedule", "schedule_run_delete", "adopt_watch_run", "list_schedules"],
            ),
            ("clipboard.rs", include_str!("clipboard.rs"), &["save_clipboard_image"]),
        ];
        for (file, source, commands) in sources {
            let source = source.replace("\r\n", "\n");
            for name in commands {
                assert!(
                    source.contains(&format!("#[tauri::command]\npub async fn {name}(")),
                    "{file} 的 {name} 必须是 async 命令并在后台线程里干活"
                );
            }
        }
    }

    #[test]
    fn workspace_path_matching_is_segment_safe() {
        assert!(path_within("/repo/task", "/repo/task"));
        assert!(path_within("/repo/task/src", "/repo/task"));
        assert!(!path_within("/repo/task-two", "/repo/task"));
    }

    #[cfg(unix)]
    #[test]
    fn process_cwd_reads_own_process() {
        // lsof//proc 读自己进程的 cwd，与 current_dir 一致（canonicalize 归一化）
        let got = process_cwd(std::process::id(), None).expect("应能读取本进程 cwd");
        let expect = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(std::path::Path::new(&got).canonicalize().unwrap(), expect);
    }

    #[test]
    fn split_utf8_keeps_incomplete_multibyte_tail() {
        let (text, used) = split_utf8("中".as_bytes());
        assert_eq!(text, "中");
        assert_eq!(used, 3);
        let (text, used) = split_utf8(&"中".as_bytes()[..2]);
        assert_eq!(text, "");
        assert_eq!(used, 0);
    }

    #[test]
    fn expand_tilde_resolves_home() {
        let expanded = expand_tilde("~/work");
        assert!(!expanded.starts_with('~'));
        assert!(expanded.ends_with("/work"));
    }

    #[test]
    fn pty_size_uses_measured_grid_and_rejects_tiny_values() {
        let sized = pty_size_from(Some(140), Some(42));
        assert_eq!(sized.cols, 140);
        assert_eq!(sized.rows, 42);
        let fallback = pty_size_from(Some(1), Some(0));
        assert_eq!(fallback.cols, 80);
        assert_eq!(fallback.rows, 24);
        let missing = pty_size_from(None, None);
        assert_eq!(missing.cols, 80);
        assert_eq!(missing.rows, 24);
    }

    #[test]
    fn session_id_only_for_claude_qwen_and_codebuddy() {
        for agent in ["claude-code", "qwen", "codebuddy"] {
            let id = session_id_for(agent).expect("应生成会话 ID");
            assert!(uuid::Uuid::parse_str(&id).is_ok(), "会话 ID 应为 uuid");
        }
        for agent in ["codex", "gemini", "opencode", "kimi", "unknown"] {
            assert!(
                session_id_for(agent).is_none(),
                "{agent} 不支持 --session-id"
            );
        }
    }

    // ===== 优化 1：输出合帧 =====

    #[test]
    fn coalescer_emits_immediately_when_idle() {
        let c = FrameCoalescer::new();
        c.append(b"a");
        let frame = Duration::from_millis(40);
        let last = Instant::now() - Duration::from_secs(1);
        let start = Instant::now();
        let (text, _) = c.take_frame(last, frame).unwrap();
        assert_eq!(text, "a");
        // 语义断言：超过截止时间应立即返回（不阻塞到帧尾）。
        // CI 慢节点上线程调度延迟不可控，时序上界只做防挂死的宽松兜底
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "空闲后发送疑似阻塞"
        );
    }

    #[test]
    fn coalescer_merges_within_frame_and_flushes_tail() {
        let c = FrameCoalescer::new();
        let frame = Duration::from_millis(40);
        c.append(b"burst-1;");
        let (_, at) = c
            .take_frame(Instant::now() - Duration::from_secs(1), frame)
            .unwrap();
        // 帧内连续到达：应等待到帧尾合并发出
        c.append(b"burst-2;");
        c.append(b"burst-3");
        let (text, _) = c.take_frame(at, frame).unwrap();
        assert_eq!(text, "burst-2;burst-3");
        // 合帧语义由内容断言保证（burst-2/3 被合并成一帧发出）；
        // CI 慢节点线程调度延迟可达数百 ms，任何时序上下界硬断言都会偶发失败，不做
        // 尾部无新数据：下一帧也应正常发出
        c.append(b"tail");
        let (text, _) = c.take_frame(Instant::now(), frame).unwrap();
        assert_eq!(text, "tail");
    }

    #[test]
    fn coalescer_flushes_immediately_when_pending_exceeds_cap() {
        // 帧远未到期时超限也必须立即 flush（防止高速输出下 pending 无限增长）。
        // 用 1 小时的帧周期：若无超限路径，take_frame 会睡到帧尾（测试由 10s 兜底判负）
        let c = Arc::new(FrameCoalescer::new());
        let big = vec![b'a'; PENDING_CAP + 1];
        c.append(&big);
        let c2 = c.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let got = c2.take_frame(Instant::now(), Duration::from_secs(3600));
            let _ = tx.send(got);
        });
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Some((text, _))) => assert_eq!(text.len(), PENDING_CAP + 1),
            other => {
                // 唤醒被卡住的线程再判负，避免泄漏一个睡在 condvar 上的线程
                c.finish();
                let _ = handle.join();
                panic!("超限未触发立即 flush: {other:?}");
            }
        }
        handle.join().unwrap();
    }

    #[test]
    fn coalescer_finish_flushes_then_returns_none() {
        let c = FrameCoalescer::new();
        c.append("中文结尾".as_bytes());
        c.finish();
        let (text, _) = c
            .take_frame(Instant::now(), Duration::from_millis(40))
            .expect("EOF 应立即 flush，不等帧");
        assert_eq!(text, "中文结尾");
        assert!(c
            .take_frame(Instant::now(), Duration::from_millis(40))
            .is_none());
    }

    // ===== 优化 2：隐藏标签缓冲 =====

    #[test]
    fn backlog_cap_truncates_on_utf8_boundary_with_marker() {
        let mut bl = Vec::new();
        // 反复推入含多字节字符的内容直到超限
        let chunk = "数据块-中文-".repeat(1000);
        while bl.len() <= BACKLOG_CAP {
            backlog_push(&mut bl, chunk.as_bytes());
        }
        assert!(bl.len() <= BACKLOG_CAP + TRUNC_MARK.len());
        assert!(bl.starts_with(TRUNC_MARK.as_bytes()), "应有截断标记");
        // 去掉标记后必须是合法 UTF-8（从字符边界截断）
        let body = &bl[TRUNC_MARK.len()..];
        assert!(std::str::from_utf8(body).is_ok(), "截断后必须是合法 UTF-8");
    }

    #[test]
    fn visibility_flip_drains_backlog_before_live_emit() {
        // 模拟：隐藏期积压 → 翻转为可见（pty_set_visible 的锁内补发）→ 实时块
        let visible = AtomicBool::new(false);
        let mut bl: Vec<u8> = Vec::new();
        // 隐藏期：两块输出进 backlog（含末尾残缺多字节，应留到下次）
        backlog_push(&mut bl, "hidden-中".as_bytes());
        backlog_push(&mut bl, "文".as_bytes()[..2].as_ref());
        assert!(!visible.load(Ordering::Relaxed));
        // 翻转为可见：先置 flag 再补发（与命令同序）
        visible.store(true, Ordering::Relaxed);
        let drained = drain_backlog(&mut bl);
        assert_eq!(drained.as_deref(), Some("hidden-中"));
        // 残缺尾部（"文" 的前 2 字节）仍在 backlog，等补齐后随下一块发出
        assert!(!bl.is_empty());
        backlog_push(&mut bl, "文".as_bytes()[2..].as_ref());
        backlog_push(&mut bl, b"-live");
        let drained2 = drain_backlog(&mut bl);
        assert_eq!(drained2.as_deref(), Some("文-live"));
        assert!(bl.is_empty());
    }

    /// 测试用通道：把收到的帧按顺序记下来（Json 帧还原成字符串，Raw 帧标 raw）
    fn recording_channel() -> (Channel, Arc<Mutex<Vec<(bool, String)>>>) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let channel = Channel::new(move |body| {
            let frame = match body {
                InvokeResponseBody::Json(json) => {
                    (false, serde_json::from_str::<String>(&json).unwrap())
                }
                InvokeResponseBody::Raw(bytes) => (true, String::from_utf8(bytes).unwrap()),
            };
            sink.lock().unwrap().push(frame);
            Ok(())
        });
        (channel, got)
    }

    #[test]
    fn output_waits_in_backlog_until_channel_and_visible() {
        let flow = FlowGate::default();
        let mut sink = OutputSink::default();
        // 可见但还没接上通道：不丢，进 backlog
        assert_eq!(route_output(&mut sink, true, &flow, "先到-".into()), None);
        // 隐藏：进 backlog，带外信号照发
        assert_eq!(route_output(&mut sink, false, &flow, "响铃\u{7}".into()).as_deref(), Some("响铃\u{7}"));
        let (channel, got) = recording_channel();
        sink.channel = Some(channel);
        // 接上 + 可见：先补发积压，再发本块
        assert_eq!(route_output(&mut sink, true, &flow, "实时".into()), None);
        let frames: Vec<String> = got.lock().unwrap().iter().map(|(_, t)| t.clone()).collect();
        assert_eq!(frames, vec!["先到-响铃\u{7}".to_string(), "实时".to_string()]);
        assert!(sink.backlog.is_empty());
        // 计数按 UTF-16 码元，与前端 string.length 一致
        assert_eq!(flow.state.lock().unwrap().unacked, "先到-响铃\u{7}实时".encode_utf16().count());
    }

    #[test]
    fn big_frames_go_raw_small_frames_go_json() {
        let flow = FlowGate::default();
        let (channel, got) = recording_channel();
        let mut sink = OutputSink { backlog: Vec::new(), channel: Some(channel) };
        let big = "画".repeat(RAW_FRAME_MIN);
        route_output(&mut sink, true, &flow, "小帧\x1b[0m".into());
        route_output(&mut sink, true, &flow, big.clone());
        let got = got.lock().unwrap();
        assert_eq!(got[0], (false, "小帧\x1b[0m".to_string()));
        assert_eq!(got[1], (true, big));
    }

    #[test]
    fn flow_pauses_above_high_and_resumes_below_low() {
        let flow = FlowGate::default();
        flow.sent(FLOW_HIGH);
        assert!(!flow.state.lock().unwrap().paused, "等于上限还不停");
        flow.sent(1);
        assert!(flow.state.lock().unwrap().paused);
        // 回落到 LOW 之上仍停（滞回，免得在上限附近来回抖）
        flow.ack(FLOW_HIGH + 1 - FLOW_LOW);
        assert!(flow.state.lock().unwrap().paused);
        flow.ack(1);
        assert!(!flow.state.lock().unwrap().paused);
        // 多确认不会减成负数
        flow.ack(FLOW_HIGH);
        assert_eq!(flow.state.lock().unwrap().unacked, 0);
    }

    #[test]
    fn flow_ack_arriving_during_send_is_not_swallowed() {
        let flow = FlowGate::default();
        // 前端在 send 返回前就确认了这一帧：账已先记，确认正好抵消
        assert!(send_counted(&flow, 5000, || {
            flow.ack(5000);
            true
        }));
        assert_eq!(flow.state.lock().unwrap().unacked, 0, "不该留下没人确认的残账");
        // 发送失败：刚记的账退回，不让读线程为一帧没送出去的输出等确认
        assert!(!send_counted(&flow, FLOW_HIGH + 1, || false));
        let s = flow.state.lock().unwrap();
        assert_eq!(s.unacked, 0);
        assert!(!s.paused);
    }

    #[test]
    fn flow_wait_releases_on_ack_close_or_stall() {
        // 确认放行
        let flow = Arc::new(FlowGate::default());
        flow.sent(FLOW_HIGH + 1);
        let waiter = {
            let flow = flow.clone();
            std::thread::spawn(move || flow.wait_ready(Duration::from_secs(60)))
        };
        flow.ack(FLOW_HIGH + 1);
        assert!(finished_within(waiter, Duration::from_secs(10)), "确认后读线程应恢复");
        // 关闭放行
        flow.sent(FLOW_HIGH + 1);
        let waiter = {
            let flow = flow.clone();
            std::thread::spawn(move || flow.wait_ready(Duration::from_secs(60)))
        };
        flow.close();
        assert!(finished_within(waiter, Duration::from_secs(10)), "关闭后读线程应收尾");
        // 前端失联：等满失联时限自己放行并清零
        let flow = FlowGate::default();
        flow.sent(FLOW_HIGH + 1);
        flow.wait_ready(Duration::from_millis(20));
        let s = flow.state.lock().unwrap();
        assert!(!s.paused && s.unacked == 0);
    }

    fn finished_within(handle: std::thread::JoinHandle<()>, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while !handle.is_finished() {
            if Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        handle.join().is_ok()
    }

    // ===== bracketed paste 手工包裹 =====

    #[test]
    fn bracketed_paste_scan_detects_across_chunk_boundary() {
        let mut tail = Vec::new();
        // 普通输出不命中
        assert!(!scan_bracketed_paste_on(&mut tail, b"hello \x1b[1mworld"));
        // 序列跨两块切开也应命中
        assert!(!scan_bracketed_paste_on(&mut tail, b"prompt \x1b[?20"));
        assert!(scan_bracketed_paste_on(&mut tail, b"04h rest"));
    }

    #[test]
    fn chat_paste_body_cr_only_when_named_and_wrapped() {
        // 点名 CR：只改粘贴包里的换行（含 CRLF），包标记不动
        assert_eq!(
            chat_paste_body("一\n二\r\n三", true, true),
            "\x1b[200~一\r二\r三\x1b[201~"
        );
        // 没点名：与原规则一致
        assert_eq!(chat_paste_body("一\n二", true, false), "\x1b[200~一\n二\x1b[201~");
        // 子进程没开粘贴模式（不包）：换行原样，不能改成 CR——那就成了逐行提交
        assert_eq!(chat_paste_body("一\n二", false, true), "一\n二");
        assert_eq!(chat_paste_body("单行", true, true), "单行");
    }

    #[test]
    fn wrap_bracketed_paste_only_multiline_and_only_when_on() {
        // 已开 2004 + 多行 → 包裹
        let wrapped = wrap_bracketed_paste("line1\nline2", true);
        assert_eq!(wrapped, "\x1b[200~line1\nline2\x1b[201~");
        // 未开 2004 → 原样直写（否则控制序列会被原样显示）
        assert_eq!(wrap_bracketed_paste("line1\nline2", false), "line1\nline2");
        // 单行 → 行为不变，即使已开 2004 也不包裹
        assert_eq!(wrap_bracketed_paste("one-liner", true), "one-liner");
    }

    // ===== 登录 shell 选取（平台方言） =====

    #[test]
    fn login_shell_is_executable_on_this_platform() {
        let (shell, args) = login_shell_argv();
        assert!(!shell.is_empty(), "登录 shell 不能为空");
        #[cfg(windows)]
        {
            // 回归：曾经无条件用 $SHELL 回落 /bin/zsh，Windows 上必然 spawn 失败，
            // 「开 shell」「run 脚本标签」「官方账号登录」全线不可用。
            assert!(
                !shell.starts_with('/'),
                "Windows 上不得回落 POSIX 路径，实际: {shell}"
            );
            assert!(
                !args.iter().any(|a| a == "-l"),
                "-l 是 POSIX 登录 shell 专属参数，Windows shell 不认"
            );
            assert!(
                std::path::Path::new(&shell).exists() || shell.eq_ignore_ascii_case("cmd.exe"),
                "选出的 shell 必须真实存在: {shell}"
            );
            if shell.to_ascii_lowercase().contains("powershell") {
                // 回归：默认 Restricted 策略下 npm 的 .ps1 垫片（codex/claude）跑不起来
                let pos = args.iter().position(|a| a == "-ExecutionPolicy");
                assert!(
                    pos.is_some_and(|i| args.get(i + 1).map(String::as_str) == Some("Bypass")),
                    "PowerShell 须以进程级 -ExecutionPolicy Bypass 启动: {args:?}"
                );
            }
        }
        #[cfg(not(windows))]
        assert_eq!(args, vec!["-l".to_string()], "POSIX 侧保持登录 shell 语义");
    }

    #[test]
    fn script_shell_is_login_shell_or_git_bash() {
        #[cfg(not(windows))]
        {
            let (login, login_args) = login_shell_argv();
            let (script, script_args) = script_shell_argv().unwrap();
            assert_eq!(script, login, "macOS/Linux 的 run 脚本仍走登录 shell");
            assert_eq!(script_args, login_args);
        }
        #[cfg(windows)]
        match script_shell_argv() {
            Ok((shell, args)) => {
                let lower = shell.to_ascii_lowercase();
                assert!(
                    lower.contains("bash"),
                    "Windows run 脚本必须走 Git Bash，实际: {shell}"
                );
                assert!(
                    args.iter().any(|a| a == "-l"),
                    "Git Bash 用登录 shell 加载 PATH"
                );
            }
            Err(e) => assert!(e.contains("Git Bash"), "{e}"),
        }
    }

    // ===== 内置终端 shell 选择 + Windows 跟随 cd =====

    #[test]
    fn interactive_shell_falls_back_to_platform_default() {
        let (default_shell, default_args) = login_shell_argv();
        for setting in [None, Some("auto"), Some(""), Some("no-such-shell")] {
            let (shell, args, _) = interactive_shell(setting);
            assert_eq!(shell, default_shell, "{setting:?}");
            assert_eq!(args, default_args, "{setting:?}");
        }
        // 候选里有的都能选上，且参数合该 shell 的口径
        for opt in terminal_shell_options() {
            let (shell, args, kind) = interactive_shell(Some(opt.id));
            assert!(std::path::Path::new(&shell).is_file(), "{shell}");
            match kind {
                ShellKind::PowerShell => assert!(args.iter().any(|a| a == "Bypass"), "{args:?}"),
                ShellKind::GitBash | ShellKind::Posix => assert_eq!(args, vec!["-l".to_string()]),
                ShellKind::Cmd => assert!(args.is_empty()),
            }
            assert!(crate::settings::KNOWN_TERMINAL_SHELLS.contains(&opt.id), "{}", opt.id);
        }
    }

    #[test]
    fn cd_line_follows_shell_dialect() {
        let enter = if cfg!(windows) { "\r" } else { "\n" };
        assert_eq!(
            cd_line(ShellKind::PowerShell, r"C:\it's\proj"),
            format!(r"cd 'C:\it''s\proj'{enter}")
        );
        assert_eq!(
            cd_line(ShellKind::Cmd, r"D:\work dir"),
            format!("cd /d \"D:\\work dir\"{enter}")
        );
        assert_eq!(
            cd_line(ShellKind::GitBash, r"C:\it's\proj"),
            format!("cd 'C:/it'\\''s/proj'{enter}")
        );
        assert_eq!(
            cd_line(ShellKind::Posix, "/Users/me/it's"),
            format!("cd '/Users/me/it'\\''s'{enter}")
        );
    }

    #[test]
    fn dir_backslash_trim_keeps_drive_root() {
        assert_eq!(trim_dir_backslash(r"C:\work\proj\".into()), r"C:\work\proj");
        assert_eq!(trim_dir_backslash(r"C:\".into()), r"C:\");
        assert_eq!(trim_dir_backslash(r"\\server\share\x\".into()), r"\\server\share\x");
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ccode-pty-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cwd_track_file_reads_existing_dir_only() {
        let dir = scratch("cwdfile");
        let file = dir.join("cwd.txt");
        assert_eq!(read_cwd_track_file(&file), None, "文件还没写");
        let target = dir.join("a b");
        std::fs::create_dir(&target).unwrap();
        // Git Bash 的 pwd -W 写正斜杠；PowerShell 写反斜杠；两种都认，结尾换行忽略
        let fwd = target.to_string_lossy().replace('\\', "/");
        std::fs::write(&file, format!("{fwd}\n")).unwrap();
        let got = read_cwd_track_file(&file).unwrap();
        assert!(crate::paths::same_path(&got, &target.to_string_lossy()), "{got}");
        std::fs::write(&file, dir.join("gone").to_string_lossy().as_bytes()).unwrap();
        assert_eq!(read_cwd_track_file(&file), None, "目录已不在");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真起一个 PowerShell / Git Bash（ConPTY），cd 之后记录文件跟着变；cmd 从进程环境块读
    #[cfg(windows)]
    #[test]
    fn windows_shells_report_cwd_after_cd() {
        let root = scratch("shells");
        let _guard = crate::storage::TestConfigRoot::redirect_to(&root);
        let start = root.join("start");
        let target = root.join("目标 dir");
        std::fs::create_dir_all(&start).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        for opt in terminal_shell_options() {
            let (shell, mut args, kind) = interactive_shell(Some(opt.id));
            let mut cmd = CommandBuilder::new(&shell);
            let file = attach_cwd_tracking(&mut cmd, &mut args, kind);
            for a in &args {
                cmd.arg(a);
            }
            cmd.cwd(&start);
            let pair = native_pty_system()
                .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
                .unwrap();
            let mut child = pair.slave.spawn_command(cmd).unwrap();
            let mut reader = pair.master.try_clone_reader().unwrap();
            // 读端要一直抽走，不然 ConPTY 输出管道写满会把 shell 卡住；顺带应答光标位置查询
            let mut writer = pair.master.take_writer().unwrap();
            let pid = child.process_id().unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            let pump = |writer: &mut Box<dyn std::io::Write + Send>, secs: u64| {
                let end = Instant::now() + Duration::from_secs(secs);
                while Instant::now() < end {
                    if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                        if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                            let _ = writer.write_all(b"\x1b[1;1R");
                        }
                    }
                }
            };
            pump(&mut writer, 6);
            let quoted = match kind {
                ShellKind::GitBash => format!("cd '{}'\r", target.to_string_lossy().replace('\\', "/")),
                ShellKind::Cmd => format!("cd /d \"{}\"\r", target.to_string_lossy()),
                _ => format!("cd '{}'\r", target.to_string_lossy()),
            };
            writer.write_all(quoted.as_bytes()).unwrap();
            pump(&mut writer, 4);
            let got = process_cwd(pid, file.as_deref());
            let _ = child.kill();
            if let Some(f) = &file {
                let _ = std::fs::remove_file(f);
            }
            let got = got.unwrap_or_else(|| panic!("{}：读不到目录", opt.id));
            assert!(
                crate::paths::same_path(&got, &target.to_string_lossy()),
                "{}：cd 后应是 {}，实际 {got}",
                opt.id,
                target.display()
            );
        }
    }

    // ===== win32-input-mode 底色回报（Windows/ConPTY 绕行通道） =====

    #[test]
    fn win32_input_records_encode_one_key_down_per_char() {
        let recs = win32_input_records("ab");
        // 每字符一条 key-down 记录：Vk/Sc 留 0，Uc 用码点，Kd=1，Cs=0，Rc=1
        assert_eq!(recs, vec!["\x1b[0;0;97;1;0;1_", "\x1b[0;0;98;1;0;1_"]);
    }

    #[test]
    fn shift_enter_pieces_replace_newlines_with_key_records() {
        let text: Vec<String> = shift_enter_pieces("\x1b[200~第一行\r\n第二行\n😀\x1b[201~")
            .into_iter()
            .map(|p| String::from_utf8(p).unwrap())
            .collect();
        assert_eq!(
            text,
            vec![
                "\x1b[200~第一行",
                SHIFT_ENTER_RECORD,
                "第二行",
                SHIFT_ENTER_RECORD,
                "\x1b[0;0;55357;1;0;1_",
                "\x1b[0;0;56832;1;0;1_",
                "\x1b[201~",
            ]
        );
        assert_eq!(shift_enter_pieces("单行"), vec!["单行".as_bytes().to_vec()]);
    }

    #[test]
    fn conpty_input_sends_emoji_as_key_down_surrogate_records() {
        // 😀 = U+1F600 = D83D DE00：拆成两条只按下的记录，前后文字（含粘贴包首尾）原样
        let pieces = conpty_input_pieces("\x1b[200~\"引号\" 😀\n第四行\x1b[201~");
        let text: Vec<String> = pieces
            .iter()
            .map(|p| String::from_utf8(p.clone()).unwrap())
            .collect();
        assert_eq!(
            text,
            vec![
                "\x1b[200~\"引号\" ",
                "\x1b[0;0;55357;1;0;1_",
                "\x1b[0;0;56832;1;0;1_",
                "\n第四行\x1b[201~",
            ]
        );
        // 连着两个 emoji 中间没有空文字段；没有 emoji 时整块一段（空输入也留一段）
        assert_eq!(conpty_input_pieces("😀😀").len(), 4);
        assert_eq!(conpty_input_pieces("中文 abc"), vec!["中文 abc".as_bytes().to_vec()]);
        assert_eq!(conpty_input_pieces(""), vec![Vec::<u8>::new()]);
    }

    #[test]
    fn win32_input_records_carry_esc_and_osc_payload_intact() {
        // ESC(27) 是关键：裸 OSC 会被 ConPTY 剥掉，编码成记录后才能送进子进程
        let report = "\x1b]11;rgb:fdfd/fdfd/fefe\x1b\\";
        let recs = win32_input_records(report);
        assert_eq!(recs.len(), report.chars().count());
        assert_eq!(recs[0], "\x1b[0;0;27;1;0;1_");
        assert_eq!(recs[1], "\x1b[0;0;93;1;0;1_"); // ']'
        assert_eq!(recs[recs.len() - 1], "\x1b[0;0;92;1;0;1_"); // ST 的 '\'
                                                                // 把码点解回去应当还原成原文——ConPTY 输入侧做的就是这一步
        let decoded: String = recs
            .iter()
            .map(|r| {
                let uc: u32 = r
                    .trim_start_matches("\x1b[0;0;")
                    .split(';')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                char::from_u32(uc).unwrap()
            })
            .collect();
        assert_eq!(decoded, report);
    }

    #[test]
    fn win32_input_record_gap_is_nonzero() {
        // 间隔为 0 时 ConPTY 输入解析器会丢同步、把记录原样漏成可见文本（实测）
        assert!(WIN32_INPUT_RECORD_GAP > std::time::Duration::ZERO);
    }

    // ===== 输出批处理调优（16ms 帧 / 256KB cap） =====
    #[test]
    fn coalescer_tuning_constants() {
        // 固化调优目标：高频小块更早合帧、大块更早 flush
        assert_eq!(FRAME, Duration::from_millis(16));
        assert_eq!(PENDING_CAP, 256 * 1024);
    }

    #[test]
    fn coalescer_merges_small_burst_into_one_frame() {
        // 帧窗口内到达的多个小块必须合并成一个事件（减少 TUI 高频输出的 IPC 事件数）
        let c = FrameCoalescer::new();
        c.append(b"chunk-1;");
        c.append(b"chunk-2;");
        c.append(b"chunk-3");
        let (text, _) = c.take_frame(Instant::now(), FRAME).expect("帧内应合并发出");
        assert_eq!(text, "chunk-1;chunk-2;chunk-3");
    }

    // ===== 进程存活检查 =====

    #[test]
    fn has_running_process_false_for_unknown_pty() {
        assert!(!has_running_process(&PtyManager::default(), "no-such-pty"));
    }

    #[test]
    fn has_run_false_when_empty() {
        assert!(!PtyManager::default().has_run("run-1"));
        assert!(!PtyManager::default().has_run(""));
        assert_eq!(PtyManager::default().pty_id_for_run("run-1"), None);
        assert_eq!(PtyManager::default().pty_id_for_run(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn child_running_tracks_lifecycle() {
        use portable_pty::Child as _;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("应能启动 sleep");
        assert!(child_running(&mut child), "运行中应判 true");
        child.kill().expect("应能 kill");
        // 退出判定靠轮询等待（禁墙钟硬断言）：宽松上限内终应判 false
        let deadline = Instant::now() + Duration::from_secs(10);
        while child_running(&mut child) {
            assert!(Instant::now() < deadline, "kill 后 10s 内应判定退出");
            std::thread::sleep(Duration::from_millis(20));
        }
        // 退出状态被缓存：再次探测仍为 false，且 wait 能取到真实状态
        assert!(!child_running(&mut child));
        assert!(child.try_wait().unwrap().is_some());
    }

    /// 工作树移除闸：Windows 语义下普通 shell 也占目录（否则 git worktree remove 删一半后失败）；
    /// 非 Windows 语义保持旧行为——只拦 agent / run 脚本
    #[test]
    fn workspace_blockers_shell_semantics_per_platform() {
        let wt = "/ws/task";
        let entries = [
            (PtyPurpose::Shell, "/ws/task"),
            (PtyPurpose::Shell, "/ws/task/sub"),
            (PtyPurpose::Agent, "/ws/task"),
            (PtyPurpose::Script, "/ws/task2"), // 段边界：不是 /ws/task 内
            (PtyPurpose::Shell, "/repo"),
        ];
        let posix = workspace_blockers(entries.iter().copied(), wt, false);
        assert_eq!(posix, vec!["agent"]);
        let win = workspace_blockers(entries.iter().copied(), wt, true);
        assert_eq!(win, vec!["终端", "终端", "agent"]);
        // 跨方言（Windows 分隔符/大小写由 path_within 处理）
        #[cfg(windows)]
        {
            let e = [(PtyPurpose::Shell, r"C:\Users\A\ws\Task\src")];
            assert_eq!(
                workspace_blockers(e.iter().copied(), r"\\?\c:\users\a\ws\task", true),
                vec!["终端"]
            );
        }
    }

    #[test]
    fn workspace_busy_message_names_action_and_shells() {
        assert_eq!(workspace_busy_message(&[], "归档"), None);
        let agent = workspace_busy_message(&["agent"], "归档").unwrap();
        assert!(agent.contains("agent/run 脚本") && agent.ends_with("再归档"), "{agent}");
        let shell = workspace_busy_message(&["终端", "agent"], "删除").unwrap();
        assert!(shell.contains("2 个终端标签"), "{shell}");
        assert!(shell.contains("1 个是普通终端"), "{shell}");
        assert!(shell.contains("关闭") && shell.ends_with("再删除"), "{shell}");
    }

    #[test]
    fn empty_manager_never_blocks() {
        assert!(PtyManager::default()
            .ensure_workspace_free("/ws/task", "归档")
            .is_ok());
    }
}
