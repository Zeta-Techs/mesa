//! 每个终端独立的有界输入队列；一个不读 stdin 的 CLI 不得占住 PTY 全局锁。
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

/// 正文与提交键之间的间隔。Codex 把连着到达的字当粘贴，粘贴后 120ms 内的回车只换行不发送
/// （codex-rs tui paste_burst.rs PASTE_ENTER_SUPPRESS_WINDOW）——间隔不够时字留在输入框里没发出去
/// （2026-10-20 Windows 实测：60ms 复现，150ms 通过；留余量取 250ms，chat_channel e2e 可用 E2E_SUBMIT_GAP_MS 复核）
const SUBMIT_GAP: Duration = Duration::from_millis(250);
/// 正文是一次粘贴（bracketed paste 包）时的提交间隔。Qwen Code 在 Windows 上开着 pasteWorkaround：粘贴后 500ms 内
/// 的回车一律吞掉（InputPrompt recentPasteTime），250ms 时多行消息停在输入框里没发出去（2026-10-21 ConPTY 探针：
/// 250ms 复现、600ms 通过；用户实测「聊天层发出去了、终端没发」）。留余量取 650ms，只加在粘贴包上，单行照旧
const PASTE_SUBMIT_GAP: Duration = Duration::from_millis(650);
/// 分段输入的段间隔：ConPTY 的输入解析器一次灌进多条 win32 按键记录会丢同步（pty.rs WIN32_INPUT_RECORD_GAP）
const PIECE_GAP: Duration = Duration::from_millis(2);
/// 写入回执的基础等待；分段输入每段再加一个段间隔
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(2);

struct Request {
    /// 依次写入，段与段之间隔 PIECE_GAP（只有一段时等同整块写）
    pieces: Vec<Vec<u8>>,
    /// 提交键与它前面的等待
    submit: Option<(Vec<u8>, Duration)>,
    cancelled: Arc<AtomicBool>,
    reply: mpsc::Sender<Result<(), String>>,
}
#[derive(Clone)]
pub(crate) struct PtyInput(mpsc::SyncSender<Request>);
impl PtyInput {
    pub(crate) fn new(mut writer: Box<dyn Write + Send>) -> Self {
        let (send, receive) = mpsc::sync_channel::<Request>(16);
        std::thread::spawn(move || {
            while let Ok(request) = receive.recv() {
                if request.cancelled.load(Ordering::Acquire) {
                    continue;
                }
                let result = (|| {
                    for (i, piece) in request.pieces.iter().enumerate() {
                        if i > 0 {
                            std::thread::sleep(PIECE_GAP);
                        }
                        writer.write_all(piece)?;
                        writer.flush()?;
                    }
                    if let Some((submit, gap)) = &request.submit {
                        std::thread::sleep(*gap);
                        writer.write_all(submit)?;
                        writer.flush()?;
                    }
                    Ok::<_, std::io::Error>(())
                })()
                .map_err(|e| format!("写入终端失败：{e}"));
                let failed = result.is_err();
                let _ = request.reply.send(result);
                if failed {
                    break;
                }
            }
        });
        Self(send)
    }
    pub(crate) fn write(&self, bytes: &[u8]) -> Result<(), String> {
        self.enqueue(bytes, None)?.wait()
    }
    /// `pasted`：正文是 bracketed paste 包——提交键多等一会儿（PASTE_SUBMIT_GAP）
    pub(crate) fn enqueue_submit(
        &self,
        pieces: Vec<Vec<u8>>,
        submit: &[u8],
        pasted: bool,
    ) -> Result<InputReceipt, String> {
        if !matches!(submit, b"\r" | b"\n" | b"\x1b[13u") {
            return Err("无效的提交键".into());
        }
        let gap = if pasted { PASTE_SUBMIT_GAP } else { SUBMIT_GAP };
        self.enqueue_request(pieces, Some((submit.to_vec(), gap)))
    }
    pub(crate) fn enqueue(
        &self,
        bytes: &[u8],
        submit: Option<Vec<u8>>,
    ) -> Result<InputReceipt, String> {
        self.enqueue_pieces(vec![bytes.to_vec()], submit)
    }
    /// 分段入队：同一请求内按序写完各段（Windows 上 emoji 改送按键记录时用，见 pty.rs conpty_input_pieces）
    pub(crate) fn enqueue_pieces(
        &self,
        pieces: Vec<Vec<u8>>,
        submit: Option<Vec<u8>>,
    ) -> Result<InputReceipt, String> {
        self.enqueue_request(pieces, submit.map(|key| (key, SUBMIT_GAP)))
    }
    fn enqueue_request(
        &self,
        pieces: Vec<Vec<u8>>,
        submit: Option<(Vec<u8>, Duration)>,
    ) -> Result<InputReceipt, String> {
        if pieces.iter().map(Vec::len).sum::<usize>() > 1024 * 1024 {
            return Err("单次输入超过 1 MB，请分段发送".into());
        }
        let (reply, receive) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let timeout = RECEIPT_TIMEOUT
            + PIECE_GAP * pieces.len().saturating_sub(1) as u32
            + submit.as_ref().map_or(Duration::ZERO, |(_, gap)| *gap);
        self.0
            .try_send(Request {
                pieces,
                submit,
                cancelled: cancelled.clone(),
                reply,
            })
            .map_err(|e| {
                match e {
                    mpsc::TrySendError::Full(_) => "终端输入队列已满，请等待或停止任务",
                    _ => "终端已退出，输入未发送",
                }
                .to_string()
            })?;
        Ok(InputReceipt {
            receive,
            cancelled,
            timeout,
        })
    }
}

pub(crate) struct InputReceipt {
    receive: mpsc::Receiver<Result<(), String>>,
    cancelled: Arc<AtomicBool>,
    timeout: Duration,
}
impl InputReceipt {
    pub(crate) fn wait(self) -> Result<(), String> {
        match self.receive.recv_timeout(self.timeout) {
            Ok(result) => result,
            Err(_) => {
                self.cancelled.store(true, Ordering::Release);
                Err("终端未确认输入写入，可能仍在处理中；请检查终端后再操作，勿重复发送".into())
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_writer_does_not_block_another_terminal() {
        struct Block(mpsc::Receiver<()>);
        impl Write for Block {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                let _ = self.0.recv();
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (release, wait) = mpsc::channel();
        let blocked = PtyInput::new(Box::new(Block(wait)));
        let first = std::thread::spawn(move || blocked.write(b"waiting"));
        let other = PtyInput::new(Box::new(Vec::<u8>::new()));
        assert!(other.write(b"responsive").is_ok());
        release.send(()).unwrap();
        assert!(first.join().unwrap().is_ok());
    }

    #[test]
    fn submit_is_serialized_and_invalid_submit_is_refused() {
        struct Buffer(Arc<std::sync::Mutex<Vec<u8>>>);
        impl Write for Buffer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let data = Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = PtyInput::new(Box::new(Buffer(data.clone())));
        let first = input.enqueue(b"1", None).unwrap();
        let second = input.enqueue(b"2", None).unwrap();
        second.wait().unwrap();
        first.wait().unwrap();
        input
            .enqueue_submit(vec![b"message".to_vec()], b"\r", false)
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(*data.lock().unwrap(), b"12message\r");
        assert!(input.enqueue_submit(vec![b"x".to_vec()], b"shell command", false).is_err());
        // 分段：按序写完各段再写提交键
        input
            .enqueue_pieces(vec![b"a".to_vec(), b"<rec>".to_vec(), b"b".to_vec()], Some(b"\r".to_vec()))
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(*data.lock().unwrap(), b"12message\ra<rec>b\r");
    }

    #[test]
    fn independent_inputs_and_failed_writer() {
        struct Fail;
        impl Write for Fail {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("broken"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let broken = PtyInput::new(Box::new(Fail));
        let healthy = PtyInput::new(Box::new(Vec::<u8>::new()));
        assert!(broken.write(b"x").is_err());
        assert!(healthy.write(b"y").is_ok());
        assert!(healthy.write(&vec![0; 1024 * 1024 + 1]).is_err());
    }
}
