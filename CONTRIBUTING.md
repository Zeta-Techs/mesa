# 参与 Mesa

Mesa 是桌面应用：Tauri v2 + React/TypeScript + Rust。展示名是 Mesa，仓库和内部身份仍是 `ccode`。

## 先看这些

- [使用教程](docs/guide/tutorial.md)：第一次上手。
- [产品说明书](docs/guide/user-guide.md)：按钮、状态、页面。
- [AGENTS.md](AGENTS.md)：开发时必须遵守的约定。
- [docs/architecture.md](docs/architecture.md)：为什么这样设计。

## 环境

Node 22、npm、Rust stable。每个新开的终端先把 Cargo 放进 PATH：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm install
npm run tauri:dev
```

开发窗口标题是 **Mesa Dev - 热更新**，端口 17575。不要用已经安装的 Mesa.app 验收界面。

要走「第一次打开」的流程（上手引导、CLI 首次启动画面），用 `scripts/dev-sandbox.sh`：空家目录、独立端口 17577，`--reset` 清空重来。

发版前把本版本的用户可见改动写进 [CHANGELOG.md](CHANGELOG.md)，应用内的「更新说明」取自那里。

## 提交前

一个主题一个提交。提交前这三样都要过：

```bash
npm test
npm run build
cd src-tauri && cargo test
```

`npm test` 不做类型检查，类型错误只有 `npm run build` 抓得住。

## 提问题

用仓库的 Issue 模板。缺陷请写：系统、Mesa 版本（设置 → 关于）、你做了什么、屏幕上出现了什么。能复现时附上 **设置 → 诊断** 导出的日志。

不要在 Issue 里贴 API 密钥、网关密钥、官方账号 token。导出的诊断包和配置快照已经去掉密钥；你自己复制的终端输出可能还带着。

## 许可证与签署

贡献按 [Apache-2.0](LICENSE) 发布。提交请带签署（DCO）：`git commit -s` 会在提交说明末尾
生成 `Signed-off-by: <姓名> <邮箱>`，PR 里每个提交都要有——表示你有权按本仓库的许可证
提交这份改动。贡献者保留自己的版权，只是按同一许可证发布。
