<div align="center">

<img src="src-tauri/icons/icon.png" width="96" alt="Mesa icon" />

# Mesa

**An open-source AI research workbench. The AI does the work, Mesa manages the environment and the review gates, you make the calls.**

One desktop app for the connections, chats and terminals of nine coding agents, plus reviewed pipelines for reading papers → cleaning data → making figures → writing the manuscript.

<p>
  <a href="https://github.com/Zeta-Techs/mesa/actions/workflows/build.yml"><img src="https://github.com/Zeta-Techs/mesa/actions/workflows/build.yml/badge.svg" alt="Build" /></a>
  <a href="https://github.com/Zeta-Techs/mesa/releases/latest"><img src="https://img.shields.io/github/v/release/Zeta-Techs/mesa?label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows-blue" alt="Platforms" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green" alt="License: Apache-2.0" /></a>
</p>

<p>
  <a href="../../releases/latest"><b>Download</b></a> ·
  <a href="README.md"><b>中文</b></a> ·
  <a href="CHANGELOG.md"><b>Changelog</b></a>
</p>

</div>

<p align="center"><img src="docs/assets/readme/hero.jpg" width="900" alt="Mesa run page: chats grouped by project in the sidebar; the chat view shows the agent reading files, generating a figure and checking it" /></p>

> The app UI and the full documentation are in Chinese. This page is a short English overview.

## Why Mesa

- **One set of keys for nine agents.** Manage API connections and official account logins for Claude Code, Codex, Gemini CLI, Qwen Code, OpenCode, Kimi Code, CodeBuddy Code, Cursor CLI and Grok Build in one place. By default Mesa injects the configuration as environment variables at launch and leaves each CLI's own config files alone. "Set as global default" writes them on request, after a backup.
- **Chat and terminal are the same session.** Chat as in a regular AI client, switch model, reasoning level and permission mode in the composer, and press `⌘⇧T` to see the real terminal underneath. Past local sessions of all nine CLIs can be searched, replayed, resumed, or handed off to the Codex app or Claude desktop.
- **Research pipelines with review gates.** Six templates: literature review, research paper, data analysis, thesis, submission & revision, and LaTeX. Each step runs in an isolated working copy; changes reach your project only after you review them. Searches are logged, and citations may only use keys already in your BibTeX library.

| | Running CLIs in a terminal | With Mesa |
|---|---|---|
| Switching provider or key | Edit each CLI's config or env vars | Pick a connection; gateways are shared across agents |
| Seeing what the AI did | Scroll the terminal | Structured chat view plus the same session's terminal |
| Finding old conversations | Dig through each CLI's folder | One search and replay across nine CLIs |
| AI editing files | Edits land in your project directly | Writing tasks run in an isolated copy, merged after review |
| Cost | Check each provider's dashboard | Totals by project, model and task, with plan quota and gateway balance |

<table>
  <tr>
    <td width="50%"><img src="docs/assets/readme/connections.jpg" alt="Connections page" /><br/><sub>Connections: API keys and official accounts for nine agents</sub></td>
    <td width="50%"><img src="docs/assets/readme/research.jpg" alt="Research pipeline" /><br/><sub>Research pipeline: stepper, current step, review before merge</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/readme/reader.jpg" alt="Reader" /><br/><sub>Reader: notes · PDF · terminal</sub></td>
    <td><img src="docs/assets/readme/usage.jpg" alt="Usage page" /><br/><sub>Usage: plan quota, gateway balance, cost and activity</sub></td>
  </tr>
</table>

## Features

- **Connections**: gateway × binding model, API keys and official accounts side by side, keys stored locally with 0600 permissions and never echoed, a bundled model capability database, one-click CLI install and update.
- **Run page**: chat layer on top of a real xterm.js terminal; file tree, change panel, Monaco preview and editing; inline preview of PDF, docx, pptx, spreadsheets, images, Jupyter notebooks, audio and video; a three-pane reader (notes | PDF | terminal).
- **Sessions**: parses the local session files of all nine CLIs, including ones started outside Mesa; auto titles, archive, Markdown export, session bundles for moving machines.
- **Projects**: research, coding and general work. Coding projects use separate worktrees that merge back or open a PR.
- **Skills & MCP**: one skill library distributed to every CLI, 21 built-in skills; one MCP list, with presets for Consensus, Undermind and Blender.
- **Research extras**: scheduled literature radar, journal metric badges, citation checks, EndNote and Zotero bridges.

## Install

Download from [Releases](../../releases):

| Platform | File |
|---|---|
| macOS, Apple silicon | `Mesa_x.x.x_aarch64.dmg` |
| macOS, Intel | `Mesa_x.x.x_x64.dmg` |
| Windows | `Mesa_x.x.x_x64-setup.exe` (silent install: `setup.exe /S`) |

No Linux build yet. The macOS build is not notarized yet; if macOS says the app is damaged, run `xattr -cr /Applications/Mesa.app`. The Windows installer is not code-signed yet; on the SmartScreen prompt choose **More info → Run anyway**.

## Development

```bash
npm install
npm run tauri:dev      # dev window "Mesa Dev - 热更新", HMR + Rust auto-restart
npm test
cd src-tauri && cargo test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) (Chinese). Security reports: [SECURITY.md](SECURITY.md).

## License & trademarks

[Apache-2.0](LICENSE), with [NOTICE](NOTICE). The license does not grant trademark rights: the "Mesa" name and icon belong to the maintainers. Redistributed modified versions must use a different name and icon; see [TRADEMARKS.md](TRADEMARKS.md). Mesa is not an official product of Claude Code, Codex or any other CLI, and is unrelated to the [Mesa 3D graphics library](https://mesa3d.org/).

Copyright 2026 泽塔前沿科技（杭州）有限公司
