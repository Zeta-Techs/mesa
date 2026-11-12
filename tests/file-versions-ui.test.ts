import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

async function mount() {
  const calls: Array<{ command: string; args: Record<string, any> }> = [];
  const versions = ["new", "old"].map((id, index) => ({
    id, path: "outline.md", savedAt: `2026-11-${12 - index}T14:00:00+08:00`, note: index ? "导师看过" : "调整第 3 节", source: "综述大纲", workspaceId: "step", sha256: id,
  }));
  const file = { path: "outline.md", exists: true, tracked: false, versions };
  const files = [file];
  const bundle = await build({
    stdin: { contents: "export {createElement, act} from 'react'; export {createRoot} from 'react-dom/client'; export {FileVersionsButton, FileVersionsPanel} from './src/components/FileVersions';", resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom/client", "react/jsx-runtime"],
    plugins: [{ name: "versions-host", setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "invoke", namespace: "stub" }));
      builder.onResolve({ filter: /^\.\/ProjectFilePreview$/ }, () => ({ path: "preview", namespace: "stub" }));
      builder.onResolve({ filter: /^\.\/ConfirmDialog$/ }, () => ({ path: "confirm", namespace: "stub" }));
      builder.onResolve({ filter: /^\.\.\/project-file-open$/ }, () => ({ path: "open", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ loader: "jsx", contents: args.path === "invoke"
        ? "export const invoke=(command,args)=>globalThis.__versionsInvoke(command,args);"
        : args.path === "confirm" ? "export const confirmDialog=async()=>true;"
          : args.path === "open" ? "export const showProjectFile=async(args)=>globalThis.__versionsInvoke('open_sidebar',args);"
          : "export default function Preview(props){return <div data-preview={props.path} data-readonly={props.readOnly}>历史内容</div>;}" }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    __versionsInvoke: async (command: string, args: Record<string, any>) => {
      calls.push({ command, args });
      if (command === "file_versions") return { root: "/project", files: args.path ? files.filter((file) => args.path === file.path || args.path === `/project/${file.path}`) : files };
      if (command === "file_version_preview") return `/cache/${args.versionId}/outline.md`;
      if (command === "file_version_diff") return { before: "old paragraph", after: "new paragraph" };
      if (command === "file_version_export") return "/project/outline-副本.md";
      if (command === "file_version_update") {
        if (args.action === "track") file.tracked = true;
        if (args.action === "untrack") file.tracked = false;
        if (args.action === "rename") file.versions[0].note = args.note;
        if (args.action === "delete") file.versions = file.versions.filter((version) => version.id !== args.versionId);
      }
      return null;
    },
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
  const { createElement, act, createRoot, FileVersionsButton, FileVersionsPanel } = compiled.exports;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  return {
    createElement, act, root, FileVersionsButton, FileVersionsPanel, calls, document, file, files,
    body: () => document.body.textContent ?? "",
    button: (label: string) => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === label)!,
    setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event(element instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
    },
    async cleanup() {
      await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("步骤卡只显示短入口并打开已有文件侧栏；不创建弹窗、不留存就可看文件", async () => {
  const mounted = await mount();
  try {
    await mounted.act(async () => mounted.root.render(mounted.createElement(mounted.FileVersionsButton, { root: "/project", workspaceId: "step", lead: "补文献…" })));
    assert.equal(mounted.body(), "补文献…·文件版本");
    assert.doesNotMatch(mounted.body(), /outline|做过.*轮|导师|历史内容/);
    await mounted.act(async () => mounted.button("文件版本").click());
    assert.equal(mounted.document.querySelector('[role="dialog"]'), null);
    const request = mounted.calls.find((call) => call.command === "open_sidebar")!.args;
    assert.deepEqual(request.versions, { root: "/project", workspaceId: "step" });
    assert.equal(request.path, "/project/outline.md");
    await mounted.act(async () => mounted.root.render(mounted.createElement(mounted.FileVersionsPanel, { root: "/project", workspaceId: "step" })));
    assert.ok(mounted.document.querySelector('[data-preview="/project/outline.md"]'));
    assert.ok(!mounted.calls.some((call) => call.command === "file_version_update"));
    const selected = mounted.document.querySelector<HTMLSelectElement>('select[aria-label="查看的版本"]')!;
    await mounted.act(async () => mounted.setValue(selected, "new"));
    assert.ok(mounted.document.querySelector('[data-preview="/cache/new/outline.md"]'));
    const box = mounted.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await mounted.act(async () => box.click());
    assert.equal(mounted.calls.find((call) => call.command === "file_version_update")?.args.action, "track");
    await mounted.act(async () => mounted.setValue(mounted.document.querySelector<HTMLSelectElement>('select[aria-label="查看的版本"]')!, "new"));
    const compare = mounted.document.querySelector<HTMLSelectElement>('select[aria-label="比较的版本"]')!;
    await mounted.act(async () => mounted.setValue(compare, "old"));
    assert.match(mounted.body(), /- old paragraph/); assert.match(mounted.body(), /\+ new paragraph/);
    await mounted.act(async () => mounted.button("另存为副本…").click());
    const target = mounted.document.querySelector<HTMLInputElement>('input[aria-label="副本路径"]')!;
    assert.equal(target.value, "outline-副本.md");
    await mounted.act(async () => mounted.button("另存").click());
    assert.equal(mounted.calls.find((call) => call.command === "file_version_export")?.args.target, "outline-副本.md");
    assert.match(mounted.body(), /当前文件未替换/);
    assert.ok(!mounted.calls.some((call) => /merge_workspace|workspace_sync|step_round_record|pty_write|task_launch/.test(call.command)));
  } finally { await mounted.cleanup(); }
});

test("文件选择复用聊天文件树，按目录展开且只显示文件名，可收起让正文变宽", async () => {
  const mounted = await mount();
  mounted.file.path = "notes/topic/outline.md";
  for (const version of mounted.file.versions) version.path = mounted.file.path;
  mounted.files.push({ path: "manuscript/draft.md", exists: true, tracked: false, versions: [] });
  try {
    await mounted.act(async () => mounted.root.render(mounted.createElement(mounted.FileVersionsPanel, { root: "/project", workspaceId: "step" })));
    assert.equal(mounted.document.querySelector('select[aria-label="选择文件"]'), null);
    const tree = mounted.document.querySelector('[role="tree"][aria-label="版本文件树"]')!;
    assert.ok(tree);
    assert.ok(tree.querySelector('[role="treeitem"][aria-label="notes"]'));
    assert.ok(tree.querySelector('[role="treeitem"][aria-label="topic"]'));
    assert.ok(tree.querySelector('[role="treeitem"][aria-label="outline.md"][aria-selected="true"]'));
    assert.ok(mounted.document.querySelector('[data-preview="/project/notes/topic/outline.md"]'));
    const manuscript = mounted.document.querySelector<HTMLElement>('[role="treeitem"][aria-label="manuscript"]')!;
    await mounted.act(async () => manuscript.click());
    const draft = mounted.document.querySelector<HTMLElement>('[role="treeitem"][aria-label="draft.md"]')!;
    await mounted.act(async () => draft.click());
    assert.ok(mounted.document.querySelector('[data-preview="/project/manuscript/draft.md"]'));
    await mounted.act(async () => mounted.button("文件树").click());
    assert.equal(mounted.document.querySelector('[role="tree"]'), null);
    assert.ok(mounted.document.querySelector('[data-preview="/project/manuscript/draft.md"]'));
    await mounted.act(async () => mounted.button("文件树").click());
    assert.ok(mounted.document.querySelector('[role="tree"]'));
    assert.ok(!mounted.calls.some((call) => /list_dir|fs_delete|file_version_update/.test(call.command)));
  } finally { await mounted.cleanup(); }
});

test("原文件已删除直接显示旧版；停止跟踪与删除留存分开", async () => {
  const mounted = await mount(); mounted.file.exists = false; mounted.file.tracked = true;
  try {
    await mounted.act(async () => mounted.root.render(mounted.createElement(mounted.FileVersionsPanel, { root: "/project", path: "/project/outline.md" })));
    assert.ok(mounted.document.querySelector('[data-preview="/cache/new/outline.md"]'));
    assert.ok(mounted.button("留存当前这一版…").disabled);
    const box = mounted.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.ok(!box.disabled);
    await mounted.act(async () => box.click());
    assert.equal(mounted.file.versions.length, 2);
    await mounted.act(async () => mounted.button("删除留存…").click());
    assert.equal(mounted.file.versions.length, 1);
    assert.deepEqual(mounted.calls.filter((call) => call.command === "file_version_update").map((call) => call.args.action), ["untrack", "delete"]);
  } finally { await mounted.cleanup(); }
});
