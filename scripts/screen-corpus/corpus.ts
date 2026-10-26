/**
 * 抓屏语料库的公共部分（tests/screen-corpus.test.ts 与 scripts/screen-corpus/add-from-capture.ts 共用）：
 * 一份样本 = 某家 CLI 某个版本在某个时刻的终端画面（只有文字，没有颜色）+ Mesa 读屏解析器当时该读出的结果。
 * 规则见 tests/fixtures/screens/README.md。
 */
import { parseTuiMenu } from "../../src/tui-menu.ts";
import { parseClaudeAsk } from "../../src/tui-ask.ts";
import { parseTrustPrompt } from "../../src/trust-prompt.ts";
import { extractLiveReply, extractLiveThinking, terminalHasInputBox } from "../../src/live-reply.ts";

export interface ScreenFixture {
  agent: string;
  cliVersion: string | null;
  platform: string;
  /** 从哪来的（金丝雀抓屏 / 用户报的问题） */
  source: string;
  /** 这一屏为什么值得留 */
  note: string;
  rows: string[];
  /** 只核对写了的几项；值是解析器该读出的结果（null = 该读不出） */
  expect: {
    menu?: { question: string | null; options: string[]; selected: number } | null;
    trust?: { options: string[]; selected: number; yesIndex: number; noIndex: number } | null;
    liveReply?: string[] | null;
    /** 正在想的那一框（live-reply.ts extractLiveThinking，折行已接回成段） */
    thinking?: string[] | null;
    inputBox?: boolean | null;
    /** Claude 提问表单（tui-ask.ts，不看颜色所以读不出当前题）：问句、单选 / 多选、选项名、光标能停的行 */
    ask?: { question: string; multiSelect: boolean; options: string[]; rows: string[] } | { review: true; answers: number } | null;
  };
}

/** 照当前解析器读一遍（只算 expect 里要的那几项） */
export function readScreen(agent: string, rows: string[], keys: readonly (keyof ScreenFixture["expect"])[]): ScreenFixture["expect"] {
  const out: ScreenFixture["expect"] = {};
  for (const k of keys) {
    if (k === "menu") {
      const m = parseTuiMenu(rows, undefined, agent);
      out.menu = m && { question: m.question, options: m.options, selected: m.selected };
    } else if (k === "trust") {
      const t = parseTrustPrompt(rows);
      out.trust = t && { options: t.options, selected: t.selected, yesIndex: t.yesIndex, noIndex: t.noIndex };
    } else if (k === "liveReply") {
      out.liveReply = extractLiveReply(rows, agent)?.lines ?? null;
    } else if (k === "thinking") {
      out.thinking = extractLiveThinking(rows, agent);
    } else if (k === "inputBox") {
      out.inputBox = terminalHasInputBox(rows, agent);
    } else if (k === "ask") {
      const a = parseClaudeAsk(rows);
      out.ask = !a
        ? null
        : a.kind === "review"
          ? { review: true, answers: a.answers.length }
          : { question: a.question, multiSelect: a.multiSelect, options: a.options.map((o) => o.label), rows: a.rows.map((r) => r.kind) };
    }
  }
  return out;
}

/** 抓屏的临时工作目录每次随机，换成占位（同 scripts/cli-canary/canary.py 的 WORKDIR） */
export function normalizeRow(row: string): string {
  return row.replace(/[^\s'"`]*?[\\/](?:cc-[\w-]+|mesa-e2e-\w+)[\\/]work/g, "<工作目录>");
}
