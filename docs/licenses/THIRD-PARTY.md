# 第三方组件与许可

Mesa 本体按 [Apache-2.0](../../LICENSE) 发布（见 [NOTICE](../../NOTICE)）。安装包与源码中再分发的第三方组件如下。

本清单是**手工维护层**：内嵌资产、需要特别声明的许可选择、数据来源与设计致谢。
完整依赖清单（npm 生产依赖 + Rust 依赖树，逐包列版本与许可）由
`npm run gen:notices`（`scripts/gen-third-party-notices.mjs`）生成到
`src-tauri/resources/third-party-notices.md`，**随安装包分发**、应用内
「设置 → 关于 → 开源许可」可查看。**改动依赖后必须再生成**，随包清单与
`package-lock.json` / `Cargo.lock` 不允许漂移。

## 内嵌资产

### JetBrains Mono（OFL 1.1）

- 用途：终端与代码等宽字体（`src/assets/fonts/JetBrainsMono-{400,500,700}.woff2`）
- 版权：© JetBrains Ltd.，主页 <https://www.jetbrains.com/lp/mono/>
- 许可：SIL Open Font License 1.1，全文如下

---

```
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting
from, or substituting -- in part or in whole -- any of the components of
the Original Version, by changing formats or by porting the Font Software
to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer
or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the fonts.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
```

### KaTeX 字体（OFL 1.1）

- 用途：公式渲染字体，随 katex 的样式表打进前端产物（`dist/assets/KaTeX_*.woff2/.ttf`，
  AMS / Caligraphic / Fraktur / Main / Math / SansSerif / Script / Size1–4 / Typewriter 共 12 字族）
- 版权：各字族版权行内嵌于字体文件 name 表（典型形式：© 2009-2010 Design Science, Inc.
  (www.mathjax.org) / © 2014-2018 Khan Academy (www.khanacademy.org)，
  Reserved Font Name KaTeX_*）；未修改字形，字体名原样保留
- 许可：SIL Open Font License 1.1——全文见上节 JetBrains Mono 附带的 OFL 全文
  （同一份许可文本适用于本节全部字族）
- 说明：katex 的 npm 包级许可是 MIT（© 2013-2020 Khan Academy），只覆盖代码；
  字体目录是 OFL 1.1，再分发需随附版权声明与许可全文（本清单 + 随包
  `third-party-notices.md` + 应用内「开源许可」页共同履行）

### 平台标识 SVG（12 个服务商 / 平台小图标）

- 用途：连接页网关库与连接列表标明端点所属服务商、用量页标明订阅套餐所属平台
  （`src/assets/vendor-icons/` 下 anthropic / openai / deepseek / zhipu / kimi / minimax / alibaba /
  tencent / openrouter / xai / ollama / newapi / gemini / cursor / doubao 共 15 个 .svg），指示性使用（nominative use），
  不构成对该平台的关联或背书；只给官方域名的端点配厂商图标；New API 图标标的是中转站所用的平台软件（网关命中已知钱包站或配了钱包才标），
  不是某家中转站的品牌，其余第三方中转站与自建网关不配
- 来源链条：[lobe-icons](https://github.com/lobehub/lobe-icons)（MIT，Copyright (c) 2023 LobeHub）
  → [cc-switch](https://github.com/farion1231/cc-switch)（MIT，Copyright (c) 2025 Jason Young）
  `src/icons/extracted/` → 本仓库逐字节引入（15 个文件均为 lobe-icons 导出格式；doubao 为 2026-10-30 自 @lobehub/icons-static-svg 1.101.0 的 doubao-color.svg 逐字节引入，出图模型按模型名认出豆包 Seedream 时用；gemini 为 2026-10-28 自 cc-switch 引入；cursor 为同日自 lobe-icons 的 npm 包 @lobehub/icons-static-svg 1.101.0（MIT）逐字节引入；2026-10-20 核对：
  anthropic / zhipu / xai / ollama / deepseek / alibaba / tencent 与 lobe-icons 当前版本逐字节相同，
  openai / kimi / minimax / openrouter / newapi 是 cc-switch 引入时的版本，上游之后有修订）
- 许可：MIT——再分发需随附版权声明与许可全文，两份原文如下
- 商标：各 logo 本身归对应公司所有（Anthropic、OpenAI、DeepSeek、智谱、Moonshot AI、MiniMax、阿里巴巴、腾讯、OpenRouter、xAI、Ollama、QuantumNous / New API、Google、Anysphere / Cursor、字节跳动 / 豆包）

### Agent 产品标识 SVG（9 个命令行 AI 工具图标）

- 用途：连接页左栏与各 Agent 节标题标明是哪家命令行 AI 工具（`src/assets/agent-icons/` 下 claude-code / codex / gemini / qwen /
  opencode / kimi / codebuddy / cursor / grok 共 9 个 .svg，2026-10-29 加），指示性使用（nominative use），不构成对该产品的关联或背书
- 来源：[lobe-icons](https://github.com/lobehub/lobe-icons) 的 npm 包 @lobehub/icons-static-svg 1.101.0（MIT，Copyright (c) 2023 LobeHub），
  逐字节引入并按 agent id 改文件名（claude-color → claude-code、openai → codex、gemini-color → gemini、qwen-color → qwen、
  opencode → opencode、kimi-color → kimi、codebuddy → codebuddy、cursor → cursor、grok → grok；用各家品牌标识，不用 app 方块图标）；渲染时把文件内渐变 id 的
  `lobe-icons-` 前缀按实例改写，图形本身不改
- 许可：MIT，原文同上一节（lobe-icons LICENSE）
- 商标：各 logo 本身归对应公司所有（Anthropic、OpenAI、Google、阿里巴巴、SST / OpenCode、Moonshot AI、腾讯、Anysphere / Cursor、xAI）

lobe-icons 的许可原文（取自其仓库 LICENSE）：

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

cc-switch 的许可原文（取自其仓库 LICENSE）：

```text
MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Codex CLI 默认系统提示词（Apache-2.0）

- 用途：Mesa 为第三方连接生成的 Codex 模型清单里的 `base_instructions` 的**兜底**
  （`src-tauri/src/codex_base_instructions.md`，编译进二进制）。清单必须填这一项，
  填了就整段替换 Codex 自己的提示词，所以照搬 Codex 对未登记模型用的默认原文；
  平时取用户本机所装 Codex 的同一段原文（不随包），取不到时才用这份
- 来源：[openai/codex](https://github.com/openai/codex) 0.163.0 的默认提示词（© OpenAI），
  从该版本会话文件的 `session_meta.base_instructions` 取出，只把换行统一为 LF；
  Windows 上另拼接 Mesa 自己写的补充说明（`codex_windows_patch_note.md`，不属上游）
- 许可：Apache License 2.0（与 Mesa 本体同许可，全文见仓库 [LICENSE](../../LICENSE)）

## 主要依赖（前端，随安装包分发）

| 组件 | 用途 | 许可 |
|---|---|---|
| Tauri v2（含各官方插件） | 应用框架 | MIT / Apache-2.0 |
| React、react-dom | UI 框架 | MIT |
| zustand | 状态管理 | MIT |
| @xterm/xterm 及 addons | 内嵌终端 | MIT |
| monaco-editor（含 codicon 字体） | 代码编辑器 | MIT |
| katex | 公式渲染（代码） | MIT（字体见上节，OFL 1.1） |
| marked | Markdown 渲染 | MIT |
| dompurify | HTML 净化 | MPL-2.0 OR Apache-2.0，**本产品按 Apache-2.0 分发**（package.json overrides 同时钉给 monaco，dist 内仅一份） |
| mermaid | 图表渲染 | MIT；传递依赖 chevrotain 系 Apache-2.0、jszip 择 MIT、d3 系 ISC、khroma MIT（盘上 LICENSE 核实） |
| lucide-react | 图标 | ISC |
| mammoth 及依赖 | .docx 读取 | BSD-2-Clause |
| pdfjs-dist | PDF 渲染（含 worker） | Apache-2.0 |
| tailwindcss、vite、esbuild、typescript | 构建链（不随包分发） | MIT |
| 各 AI CLI（Claude Code、Codex 等） | Mesa 只做拉起与配置，不捆绑其本体 | 各自协议，与本项目无关 |

## Rust 侧随包义务要点（静态链接进安装包）

完整清单见随包 `third-party-notices.md`；这里只列**许可形态特殊、需要明示**的：

| 组件 | 义务 |
|---|---|
| cssparser、cssparser-macros、selectors、dtoa-short、option-ext（MPL-2.0） | 文件级弱 copyleft：二进制按 Mesa 许可分发不受影响，但需随附 MPL-2.0 文本、标明覆盖组件并指明源码获取途径（crates.io / GitHub） |
| webpki-roots / webpki-root-certs（CDLA-Permissive-2.0） | 内嵌 WebPKI 根证书数据集：无 copyleft，需保留署名 |
| ring（Apache-2.0 AND ISC） | 含 OpenSSL 血统代码的声明条款 |
| rusqlite bundled SQLite、liblzma | 公共领域 / 宽松条款，署名即可 |
| zstd-sys（libzstd：BSD-3 OR GPL-2） | 择 BSD-3 分发，附文本 |
| bzip2-sys | bzip2 专有宽松许可，附其许可文本 |
| notify（CC0-1.0） | 公共领域奉献，无义务 |
| 其余（tauri 全家 / wry / tao / rustls / reqwest / portable-pty / trash / keyring 等） | MIT OR Apache-2.0 为主，按惯例附版权与许可声明 |

无 openssl-sys 静态链接（reqwest 走 rustls）；全树无 GPL / AGPL / LGPL 单一许可项。

## 数据来源（运行期外联，不随包分发）

- 期刊缩写与 ISSN 线：JabRef / abbrv.jabref.org 缩写表（CC0-1.0）、NLM Catalog
  eutils（MedlineTA）——EndNote / Zotero 同步时拉取
- ISO 4 期刊缩写：ISSN 国际中心的期刊标题词缩写表（LTWA，issn.org）——同步到 EndNote / Zotero 时
  第一次下载、缓存在本机，用来给每本刊算 ISO 4 写法；不随包分发
- 期刊指标（IF / 分区徽章）：ShowJCR（github.com/hitfyd/ShowJCR——CSV 经 jsDelivr /
  raw.githubusercontent 下载到本机，更新检查经 api.github.com）；刊名缺失时向
  OpenAlex 补查
- 文献元数据补全：Crossref
- 开放获取状态：Unpaywall（OA_EMAIL 联系邮箱随请求携带）
- 以上只在用户执行同步 / 下载 / 远查时访问，Mesa 不上传用户数据

## 设计参考致谢

Mesa 的机制设计参考了三个开源项目（学机制与取舍，未复制代码；唯一例外是上文的
十二个平台图标文件）：

- [cc-switch](https://github.com/farion1231/cc-switch)（MIT，Copyright (c) 2025 Jason Young）— provider 预设、配置同步、订阅余量解析口径
- [waveterm](https://github.com/wavetermdev/waveterm)（Apache-2.0，© 2025 Command Line Inc.）— block/workspace 对象模型、注意力标记与滚动缓冲恢复思路
- [VS Code](https://github.com/microsoft/vscode)（MIT，© Microsoft Corporation）— 文件树、编辑器标签与面板布局

内置科研技能中四个（proposal-writer / rebuttal-crafter / slides-deck / figure-forge）
在文件尾注明了理念参考来源；figure-forge 引用的 Anthropic Claude Science
figure-composer 上游许可待独立核实（自述 Apache-2.0）。
