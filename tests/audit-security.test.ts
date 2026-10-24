import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("CSP：生产禁止脚本内联与 eval，保留 IPC、worker 和图片功能", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const policy = config.app.security.csp as string;
  const scripts = policy.split(";").find((part) => part.trim().startsWith("script-src"))!;
  assert.ok(!scripts.includes("'unsafe-inline'"));
  assert.ok(!scripts.includes("'unsafe-eval'"));
  for (const directive of ["object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "worker-src 'self' blob:", "ipc:"]) assert.ok(policy.includes(directive), directive);
  assert.ok(config.app.security.devCsp.includes("ws://127.0.0.1:*"));
});

test("构建配置以 TS 为显式唯一入口，不受旧生成 JS 遮蔽", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const script of ["dev", "build", "preview"]) assert.ok(pkg.scripts[script].includes("--config vite.config.ts"));
  assert.equal(pkg.overrides["monaco-editor"].dompurify, "$dompurify");
});

test("所有保存预览入口都传读取版本；只讨论恢复不跳过参数约束", () => {
  for (const path of ["src/components/FilePreviewEditor.tsx", "src/components/ArtifactChecklist.tsx"]) assert.ok(read(path).includes("expectedRevision:"));
  const pty = read("src-tauri/src/pty.rs");
  assert.ok(!pty.includes("discuss && resume_session_id.is_none()"));
  assert.match(pty, /if discuss \{[\s\S]*?readonly_launch_args/);
});

test("本步文件的外部打开走 open_in_system（限根目录内、限文档类型），不直接调 openPath（2026-10-24）", () => {
  const src = read("src/components/ArtifactChecklist.tsx");
  assert.match(src, /function OpenExternalHandle[\s\S]*?invoke\("open_in_system", \{ path, root \}\)/);
  assert.equal((src.match(/<OpenExternalHandle /g) ?? []).length, 2);
  assert.ok(!/openPath\(/.test(src));
});
