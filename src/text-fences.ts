/**
 * 聊天里「纯文本消息」的围栏代码拆分（用户气泡、过程里的文本块；AI 正文走 ChatMarkdown，不经这里）。
 *
 * 围栏只认出现在**行首**的 ``` / ~~~（允许缩进，列表里缩进的围栏也算）。行中间出现的三个反引号是
 * 行内写法，不是围栏——2026-10-19 用户发「4. 一个 ```python 代码块（…），一个没写语言的代码块」，
 * 旧实现按 ``` 在任意位置切分，把这一行之后的全部内容吞成一个「code」块。
 * 收尾围栏要求同一种符号、数量不少于开头，且那一行只有围栏；没收尾（会话尾部截断常见）时后面整段按代码处理。
 */
export type TextPart =
  | { code: false; text: string }
  | { code: true; lang: string; text: string };

const OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const LANG = /^[\w#+.-]{1,20}$/;

export function splitFenced(text: string): TextPart[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const parts: TextPart[] = [];
  let buf: string[] = [];
  let fence: { mark: string; lang: string } | null = null;

  const flush = () => {
    const joined = buf.join("\n");
    buf = [];
    if (fence) parts.push({ code: true, lang: fence.lang, text: joined });
    else if (joined.trim()) parts.push({ code: false, text: joined });
  };

  for (const line of lines) {
    if (!fence) {
      const m = OPEN.exec(line);
      // ``` 围栏的说明行里不能再有反引号（否则是行内代码，如 ```a``` 一行写完）
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        flush();
        const first = m[2].trim().split(/\s+/)[0] ?? "";
        fence = { mark: m[1], lang: LANG.test(first) ? first : "" };
        continue;
      }
      buf.push(line);
      continue;
    }
    const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (close && close[1][0] === fence.mark[0] && close[1].length >= fence.mark.length) {
      flush();
      fence = null;
      continue;
    }
    buf.push(line);
  }
  flush();
  return parts;
}
