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

## 许可证

贡献按 [MIT](LICENSE) 发布。
