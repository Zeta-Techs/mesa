# 抓屏语料库

聊天层有一部分靠读终端画面（`src/live-reply.ts`、`src/tui-menu.ts`、`src/trust-prompt.ts`），这一层最容易随 CLI 改版**悄悄**失效。
这里存的是各家 CLI 真实的终端画面（只有文字），以及 Mesa 的解析器当时该读出的结果；`tests/screen-corpus.test.ts` 每次把它们重读一遍。

## 一份样本

`<agent>/<平台>-<CLI 版本>-<场景>.json`：

| 字段 | 说明 |
|---|---|
| `agent` / `cliVersion` / `platform` | 哪家、哪个版本、哪个平台（Windows 的画面和 macOS 不同） |
| `source` / `note` | 从哪来、为什么值得留 |
| `rows` | 一屏的文字行；临时工作目录换成 `<工作目录>` |
| `expect` | 只核对写了的几项：`menu`（问句 / 选项 / 高亮）、`trust`、`liveReply`（读出的段落）、`inputBox`、`ask`（Claude 提问表单：问句 / 单选多选 / 选项名 / 光标能停的行）；`null` = 该读不出 |

## 什么时候加

- **金丝雀跑出新版本**：`node --experimental-strip-types scripts/screen-corpus/add-from-capture.ts <out>/<agent>/screen.json --version <版本> --platform <平台>`，
  每份抓屏挑三屏（审批菜单、边写边显示、写完回到输入框）。先加 `--dry` 看读出来的对不对，读对了再存。
- **修了一个读屏问题**：把出问题那一屏存进来（`E2E_RAW` 录下的原文、用户截图里抄的都行），`expect` 写成修好后该读出的样子。
  以后再改解析器，不会把这个问题改回来。

## 规矩

- 读错了的画面不能照抄当前结果存进来——要么先修解析器，要么手写正确的 `expect`。
- 老版本的样本不删：用户可能还在用那个版本。CLI 改了画法，就同时留新旧两份。
- 颜色信息不在样本里：靠字色分辨的逻辑（Kimi 选择器的说明行）仍在 `tests/tui-menu.test.ts` 里用带颜色的单元格测。
