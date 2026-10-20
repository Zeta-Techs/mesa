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

struct Request {
    bytes: Vec<u8>,
    submit: Option<Vec<u8>>,
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
                    writer.write_all(&request.bytes)?;
                    writer.flush()?;
                    if let Some(submit) = &request.submit {
                        std::thread::sleep(SUBMIT_GAP);
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
    pub(crate) fn enqueue_submit(
        &self,
        bytes: &[u8],
        submit: &[u8],
    ) -> Result<InputReceipt, String> {
        if !matches!(submit, b"\r" | b"\n" | b"\x1b[13u") {
            return Err("无效的提交键".into());
        }
        self.enqueue(bytes, Some(submit.to_vec()))
    }
    pub(crate) fn enqueue(
        &self,
        bytes: &[u8],
        submit: Option<Vec<u8>>,
    ) -> Result<InputReceipt, String> {
        if bytes.len() > 1024 * 1024 {
            return Err("单次输入超过 1 MB，请分段发送".into());
        }
        let (reply, receive) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        self.0
            .try_send(Request {
                bytes: bytes.to_vec(),
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
        Ok(InputReceipt { receive, cancelled })
    }
}

pub(crate) struct InputReceipt {
    receive: mpsc::Receiver<Result<(), String>>,
    cancelled: Arc<AtomicBool>,
}
impl InputReceipt {
    pub(crate) fn wait(self) -> Result<(), String> {
        match self.receive.recv_timeout(Duration::from_secs(2)) {
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
            .enqueue_submit(b"message", b"\r")
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(*data.lock().unwrap(), b"12message\r");
        assert!(input.enqueue_submit(b"x", b"shell command").is_err());
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
