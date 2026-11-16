// 主窗口入口只懒加载启动模块再调 boot()，不静态 import 任何东西。
// 文件查看窗口懒载的预览块（FilePreviewEditor 等）与主窗口共用 md-render 等模块，Rollup 把它们放进了入口块；
// 入口块顶层就是渲染整个 App，于是打包版独立文件窗口里渲染出了整个 Mesa（2026-11-16 用户反馈，开发态不打包不复现）。
// 入口不带模块，共用模块就进不了入口块；vite.config.ts 的 entryGuardPlugin 守着「一个入口不得引到另一个入口」。
void import("./main-app").then((m) => m.boot());
