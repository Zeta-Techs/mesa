import assert from "node:assert/strict";
import test from "node:test";
import {
  KKP_FLAGS,
  TERM_NAME,
  consumeHostSequences,
  consumeTerminalQueries,
  encodeKittyKey,
  kittyImageMime,
  replyToTerminalQuery,
  safeOsc8Url,
  takeHostSequences,
} from "../src/terminal-protocols.ts";

const base = {
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

test("Kitty 查询只答应 Mesa 真会编码的 flags；省略 flags 的 push 按 0（disarm）", () => {
  assert.equal(KKP_FLAGS, 5);
  assert.equal(replyToTerminalQuery("\x1b[?u")?.reply, "\x1b[?5u");
  // Kimi 一次要 7（含松开）。答应的交集不含 bit 2。
  assert.equal(replyToTerminalQuery("\x1b[>7u")?.reply, "\x1b[?5u");
  assert.equal(replyToTerminalQuery("\x1b[>1u")?.reply, "\x1b[?1u");
  assert.equal(replyToTerminalQuery("\x1b[>1u")?.kkp, "arm");
  // kitty 规范：push 省略 flags = 0，恢复传统编码
  assert.equal(replyToTerminalQuery("\x1b[>u")?.reply, "\x1b[?0u");
  assert.equal(replyToTerminalQuery("\x1b[>u")?.kkp, "disarm");
});

test("弹栈认带层数的形式（crossterm/grok 发 CSI < 1 u），并解除改写", () => {
  assert.equal(replyToTerminalQuery("\x1b[<u")?.kkp, "disarm");
  assert.equal(replyToTerminalQuery("\x1b[<1u")?.kkp, "disarm");
  assert.equal(replyToTerminalQuery("\x1b[<2u")?.kkp, "disarm");
  assert.equal(replyToTerminalQuery("\x1b[<1u")?.reply, "");
  // 从输出流里剥掉，不画进 xterm
  const stripped = consumeTerminalQueries("", "a\x1b[<1ub");
  assert.equal(stripped.text, "ab");
  assert.equal(stripped.replies[0]?.kkp, "disarm");
});

test("查询嵌在输出里会被抽走，切帧的尾巴留给下一帧", () => {
  const first = consumeTerminalQueries("", "hi\x1b[?");
  assert.equal(first.text, "hi");
  assert.equal(first.pending, "\x1b[?");
  assert.equal(first.replies.length, 0);
  const second = consumeTerminalQueries(first.pending, "uok");
  assert.equal(second.text, "ok");
  assert.equal(second.replies[0]?.reply, "\x1b[?5u");
  assert.equal(second.replies[0]?.kkp, null);
  const pushed = consumeTerminalQueries("", "\x1b[>5u");
  assert.equal(pushed.text, "");
  assert.equal(pushed.replies[0]?.kkp, "arm");
  const colored = consumeTerminalQueries("", "\x1b[31mred\x1b[0m");
  assert.equal(colored.text, "\x1b[31mred\x1b[0m");
  assert.equal(colored.replies.length, 0);
});

test("其余启动查询有固定应答；XTVERSION 两种问法同一 DCS 应答", () => {
  assert.equal(replyToTerminalQuery("\x1b[>4;?m")?.reply, "\x1b[>4;0m");
  assert.equal(replyToTerminalQuery("\x1b[c")?.reply, "\x1b[?1;2c");
  assert.equal(
    replyToTerminalQuery("\x1b[>q")?.reply,
    `\x1bP>|${TERM_NAME}\x1b\\`,
  );
  assert.equal(
    replyToTerminalQuery("\x1b[>0q")?.reply,
    `\x1bP>|${TERM_NAME}\x1b\\`,
  );
  assert.equal(replyToTerminalQuery("hello"), null);
});

test("XTGETTCAP 问 Ms 时答能力值（OpenCode 据此开 OSC 52），没问到的省略", () => {
  const ms = replyToTerminalQuery("\x1bP+q4d73\x1b\\");
  assert.equal(ms?.reply, "\x1bP1+r4d73=1b5d35323b25633b25703273257307\x1b\\");
  assert.equal(ms?.kkp, null);
  // 断帧的 DCS 查询攒着；非 XTGETTCAP 的 DCS（sixel 等）立即放行
  const split = consumeTerminalQueries("", "\x1bP+q4d");
  assert.equal(split.pending, "\x1bP+q4d");
  const rest = consumeTerminalQueries(split.pending, "73\x1b\\tail");
  assert.equal(rest.text, "tail");
  assert.equal(rest.replies[0]?.reply, "\x1bP1+r4d73=1b5d35323b25633b25703273257307\x1b\\");
  const unknown = consumeTerminalQueries("", "\x1bP+q5448\x1b\\ok");
  assert.equal(unknown.text, "ok");
  assert.equal(unknown.replies[0]?.reply, "");
  const sixel = consumeTerminalQueries("", "\x1bP0;1q\x1b\\x");
  assert.equal(sixel.text, "\x1bP0;1q\x1b\\x");
});

test("encodeKittyKey：无修饰功能键保持传统序列（只改写 Esc），带修饰按 xterm 传统编码", () => {
  // 消歧义档只有 Esc 改写为 CSI 27u（规范要求）
  assert.equal(encodeKittyKey({ ...base, key: "Escape" }), "\x1b[27u");
  assert.equal(encodeKittyKey(base), null);
  assert.equal(encodeKittyKey({ ...base, key: "ArrowUp" }), null);
  assert.equal(encodeKittyKey({ ...base, key: "Home" }), null);
  // 带修饰：方向/Home/End 走 CSI 1;mod 字母形（57417-57426 是小键盘编号，gemini 不认）
  assert.equal(
    encodeKittyKey({ ...base, key: "ArrowUp", ctrlKey: true }),
    "\x1b[1;5A",
  );
  assert.equal(
    encodeKittyKey({ ...base, key: "ArrowLeft", ctrlKey: true }),
    "\x1b[1;5D",
  );
  assert.equal(
    encodeKittyKey({ ...base, key: "Home", altKey: true }),
    "\x1b[1;3H",
  );
  // PageUp/PageDown/Insert/Delete 走 CSI n;mod ~ 形
  assert.equal(
    encodeKittyKey({ ...base, key: "Delete", ctrlKey: true }),
    "\x1b[3;5~",
  );
  assert.equal(
    encodeKittyKey({ ...base, key: "PageUp", shiftKey: true }),
    "\x1b[5;2~",
  );
  // Enter/Tab/Backspace 带修饰走 CSI-u
  assert.equal(
    encodeKittyKey({ ...base, shiftKey: true }),
    "\x1b[13;2u",
  );
  assert.equal(
    encodeKittyKey({ ...base, key: "Tab", ctrlKey: true }),
    "\x1b[9;5u",
  );
  // Ctrl+可打印字符走 CSI-u；纯 Shift 可打印字符留给 xterm / 输入法
  assert.equal(
    encodeKittyKey({ ...base, key: ".", ctrlKey: true }),
    "\x1b[46;5u",
  );
  assert.equal(encodeKittyKey({ ...base, key: "?" }), null);
  assert.equal(encodeKittyKey({ ...base, key: "a" }), null);
  assert.equal(encodeKittyKey({ ...base, type: "keyup" }), null);
});

test("贴图、OSC 52 和通知从写给 xterm 的文本里拿走", () => {
  const png = btoa("\x89PNG\r\n\x1a\nfake");
  const clip = btoa("copied");
  const frame =
    `hello\x1b_Ga=T,f=100;${png}\x1b\\world` +
    `\x1b]52;c;${clip}\x1b\\tail` +
    "\x1b]9;做完了\x07\x1b]9;4;3\x07";
  const taken = takeHostSequences(frame);
  assert.equal(taken.text, "helloworldtail");
  assert.equal(taken.images.length, 1);
  assert.equal(taken.images[0]?.protocol, "kitty");
  assert.equal(taken.images[0]?.payload, png);
  assert.equal(taken.images[0]?.mime, "image/png");
  assert.equal(taken.clipboard, "copied");
  assert.deepEqual(taken.titles, ["做完了"]);
});

test("MIME 按文件头判定：JPEG/GIF/WEBP 各归各，RIFF 非 WEBP（WAV/AVI）不算图", () => {
  assert.equal(kittyImageMime(btoa("\xff\xd8\xff\xe0jpeg")), "image/jpeg");
  assert.equal(kittyImageMime(btoa("GIF89a")), "image/gif");
  const webp = btoa("RIFF\x24\x00\x00\x00WEBPVP8 ");
  assert.equal(kittyImageMime(webp), "image/webp");
  assert.equal(kittyImageMime(btoa("RIFF\x24\x00\x00\x00WAVEfmt ")), null);
  assert.equal(kittyImageMime(btoa("not-an-image")), null);
});

test("分块贴图（m=1 攒块，m=0 收尾）拼成一张，续块不漏进文字流", () => {
  const png = btoa("\x89PNG\r\n\x1a\nfake-data-chunked");
  const mid = Math.ceil(png.length / 2);
  const first = takeHostSequences(
    `\x1b_Ga=T,f=100,m=1;${png.slice(0, mid)}\x1b\\ok`,
  );
  assert.equal(first.text, "ok");
  assert.equal(first.images.length, 0);
  assert.equal(first.kittyAccum, png.slice(0, mid));
  const second = takeHostSequences(
    `\x1b_Gm=0;${png.slice(mid)}\x1b\\!`,
    first.kittyAccum,
  );
  assert.equal(second.text, "!");
  assert.equal(second.images[0]?.payload, png);
  assert.equal(second.images[0]?.mime, "image/png");
  assert.equal(second.kittyAccum, "");
});

test("不像图片的 Kitty 序列不出预览，也不把 base64 画进画面（整体吞掉）", () => {
  const junk = btoa("not-an-image");
  const taken = takeHostSequences(`前\x1b_Ga=T;${junk}\x1b\\后`);
  assert.equal(taken.images.length, 0);
  assert.equal(taken.text, "前后");
});

test("不是 Sixel 的 DCS 原样留给 xterm", () => {
  const taken = consumeHostSequences("", "\x1bPnot-sixel");
  assert.equal(taken.pending, "");
  assert.equal(taken.text, "\x1bPnot-sixel");
});

test("贴图被切在两帧之间时先攒着", () => {
  const png = btoa("\x89PNG\r\n\x1a\nfake");
  const first = consumeHostSequences("", `hi\x1b_Ga=T;${png.slice(0, 2)}`);
  assert.equal(first.text, "hi");
  assert.equal(first.images.length, 0);
  const second = consumeHostSequences(first.pending, `${png.slice(2)}\x1b\\!`);
  assert.equal(second.text, "!");
  assert.equal(second.images[0]?.payload, png);
});

test("通知序列切在两帧之间也攒着，不闪乱码", () => {
  const first = consumeHostSequences("", "hi\x1b]9;做");
  assert.equal(first.text, "hi");
  const second = consumeHostSequences(first.pending, "完了\x07!");
  assert.equal(second.text, "!");
  assert.deepEqual(second.titles, ["做完了"]);
});

test("OSC 52 超长与坏 base64 不写剪贴板", () => {
  const huge = "A".repeat(350_001);
  const taken = takeHostSequences(`\x1b]52;c;${huge}\x1b\\`);
  assert.equal(taken.clipboard, null);
  assert.equal(takeHostSequences("\x1b]52;c;****\x1b\\").clipboard, null);
});

test("OSC 8 只放行 http 与 mailto", () => {
  assert.equal(safeOsc8Url("https://example.com/a"), "https://example.com/a");
  assert.equal(safeOsc8Url("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeOsc8Url("javascript:alert(1)"), null);
  assert.equal(safeOsc8Url("file:///etc/passwd"), null);
  assert.equal(safeOsc8Url("https://a.com/b\nc"), null);
});
