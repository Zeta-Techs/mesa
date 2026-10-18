import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { CodingOverviewDto, CodingWorktreeDto } from "../src/types.ts";

function tree(branch: string, primary = false): CodingWorktreeDto {
  return {
    path: primary ? "/project" : `/worktrees/${branch}`,
    branch, isPrimary: primary, isBase: primary, dirty: false, dirtyCount: 0,
    ahead: 0, behind: primary ? 0 : 1, unpushed: 0, hasUpstream: primary,
    upstreamBehind: 0, detached: false, lastCommitAt: "2026-09-10T00:00:00Z",
  };
}

test("编程页：分支地图以基准为根、分支不重复、菜单原操作与主仓确认", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement, act} from 'react';
        export {createRoot} from 'react-dom/client';
        export {default as View} from './src/components/CodingProjectView';`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    plugins: [{
      name: "coding-host",
      setup(b) {
        b.onResolve({ filter: /^(\.\.\/store|\.\.\/project-context-load|\.\/ProjectSettingsDrawer|\.\/PortsSection|\.\/ConfirmDialog)$/ },
          ({ path }) => ({ path, namespace: "coding-stub" }));
        b.onLoad({ filter: /.*/, namespace: "coding-stub" }, ({ path }) => ({
          loader: "js",
          contents: path === "../store"
            ? `export const useAppStore = select => select(globalThis.__codingUiHost.store);
              useAppStore.getState = () => globalThis.__codingUiHost.store;`
            : path === "../project-context-load"
              ? "export const loadProjectContextPack = async () => 'project context';"
              : path === "./ConfirmDialog"
                ? `export const confirmDialog = async text => {
                    globalThis.__codingUiHost.confirmations.push(text);
                    return globalThis.__codingUiHost.confirm;
                  };`
                : "export default function Panel(){return null;}",
        }));
      },
    }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const pending: Array<{ cwd: string; rightTab?: string }> = [];
  const confirmations: string[] = [];
  const errors: string[] = [];
  const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
  const store = {
    profiles: [],
    terminalRunInputs: [] as Array<{ cwd: string; agentId: string; running: boolean }>,
    setPage() {},
    setPendingTerminal(value: { cwd: string; rightTab?: string }) { pending.push(value); },
  };
  const hostState = { store, confirmations, confirm: false };
  const restore: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    __codingUiHost: hostState,
  })) {
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value() {} });
  let overview: CodingOverviewDto;
  let revealError = false;
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        commands.push({ command, args });
        if (command === "coding_overview") return overview;
        if (command === "list_custom_runtimes") return [];
        if (command === "plugin:opener|reveal_item_in_dir") {
          if (revealError) throw new Error("目录不可用");
          return;
        }
        if (["coding_pull", "coding_push", "coding_open_pr"].includes(command)) {
          return { ok: true, code: "ok", message: "ok" };
        }
        throw new Error(command);
      },
    },
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, act, createRoot, View } = compiled.exports;
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let seq = 0;
  async function render(changes: Partial<CodingOverviewDto> = {}) {
    const trees = [tree("master", true), tree("test")];
    overview = {
      repoPath: "/project", baseBranch: "master", isRepo: true, worktrees: trees,
      branches: trees.map((w) => ({ ...w, name: w.branch, worktreePath: w.path })),
      ...changes,
    };
    await act(async () => root.render(h(View, {
      key: ++seq, project: null, repoPath: `/project-ui-${seq}`, homeDir: "/home",
      onError: (error: string) => errors.push(error), onNotice() {},
    })));
  }
  function row(label: string): HTMLElement {
    const result = container.querySelector<HTMLElement>(`li[aria-label="${label}"]`);
    assert.ok(result, label);
    return result;
  }
  function button(text: string, parent: ParentNode = container): HTMLButtonElement {
    const buttons = [...parent.querySelectorAll("button")];
    const result = buttons.find((b) => b.textContent?.trim() === text)
      ?? buttons.find((b) => b.getAttribute("aria-label") === text);
    assert.ok(result, text);
    return result;
  }
  async function click(text: string, parent: ParentNode = container) {
    await act(async () => button(text, parent).click());
  }
  try {
    await render();
    const main = row("主仓 master");
    const work = row("工作树 test");
    assert.match(main.textContent!, /基准/);
    assert.match(main.textContent!, /无未提交改动/);
    assert.match(main.textContent!, /最近提交/);
    assert.equal(main.querySelectorAll("button").length, 2);
    assert.match(work.textContent!, /空闲/);
    assert.match(work.textContent!, /比 master 落后 1 个提交/);
    assert.match(work.textContent!, /未关联远程分支/);
    assert.ok(button("进入", work));
    assert.equal(container.querySelector('button[aria-label="再开一条"]'), null);
    // 地图：基准（主仓 master）是根，已检出的分支只出现一次，全部检出时没有折叠头
    const map = container.querySelector('ul[aria-label="分支地图"]')!;
    assert.equal(map.firstElementChild, main);
    assert.equal(container.querySelector('li[aria-label^="本地分支"]'), null);
    assert.ok(![...container.querySelectorAll("button")].some((b) => /未检出的分支/.test(b.textContent ?? "")));

    await click("更多操作：test", work);
    assert.equal(button("合并进 master").disabled, false);
    await click("再开一条");
    const branchInput = container.querySelector<HTMLInputElement>('input[aria-label="新分支名（从基准拉出）"]')!;
    assert.equal(branchInput.value, "test-2");
    assert.equal(dom.window.document.activeElement, branchInput);
    assert.ok(!commands.some((call) => call.command === "coding_create_worktree"));

    await click("更多操作：master", main);
    assert.ok(button("拉取"));
    assert.ok(button("推送"));
    assert.ok(button("查看改动"));
    await click("查看改动");
    assert.deepEqual(pending.at(-1), {
      cwd: "/project", extraEnv: {}, title: "master", reuseKey: "lane:/project", rightTab: "git", surface: "terminal",
    });
    await click("更多操作：master", main);
    await click("拉取");
    assert.equal(commands.find((call) => call.command === "coding_pull")?.args.cwd, "/project");

    pending.length = 0;
    await click("进入", main);
    assert.match(confirmations.at(-1)!, /主仓正停在基准分支上/);
    assert.equal(pending.length, 0);
    await click("进入", work);
    assert.equal(pending.at(-1)?.cwd, "/worktrees/test");
    await click("打开工作树目录：test", work);
    assert.deepEqual(commands.at(-1)?.args, { paths: ["/worktrees/test"] });
    revealError = true;
    await click("打开工作树目录：test", work);
    assert.match(errors.pop()!, /目录不可用/);
    revealError = false;

    await render({
      worktrees: [tree("master", true), { ...tree("test"), dirty: true, dirtyCount: 2 }],
      branches: [{ name: "waiting", worktreePath: null, isPrimary: false, isBase: false,
        dirty: false, ahead: 3, behind: 0, unpushed: 0, hasUpstream: false }],
    });
    assert.equal(row("工作树 test").textContent!.match(/2 个文件未提交/g)?.length, 1);
    const fold = [...container.querySelectorAll("button")].find((b) => /未检出的分支/.test(b.textContent ?? ""))!;
    assert.match(fold.textContent!, /未检出的分支\s*1/);
    assert.equal(fold.getAttribute("aria-expanded"), "true");
    assert.match(row("本地分支 waiting").textContent!, /比 master 领先 3 个提交/);
    assert.ok(button("建工作树", row("本地分支 waiting")));
    await act(async () => fold.click());
    assert.equal(container.querySelector('li[aria-label="本地分支 waiting"]'), null);

    store.terminalRunInputs = [{ cwd: "/worktrees/test", agentId: "codex", running: true }];
    await render({
      origin: { name: "origin", url: "https://github.com/example/project.git", display: "example/project", hostKind: "github" },
    });
    assert.match(row("工作树 test").textContent!, /Codex/);
    assert.doesNotMatch(row("工作树 test").textContent!, /空闲/);
    assert.equal(button("先推送才能开 PR", row("工作树 test")).disabled, true);
    assert.equal(button("打开 Pull Request", row("主仓 master")).disabled, false);

    await render({ merging: true, mergingCwd: "/worktrees/test" });
    assert.match(row("工作树 test").textContent!, /有冲突/);
    assert.ok(button("去解决", row("工作树 test")));
    assert.equal(row("工作树 test").querySelector('button[aria-label="拉取"]'), null);
    await click("去解决", row("工作树 test"));
    assert.equal(pending.at(-1)?.rightTab, "git");
    assert.equal(pending.at(-1)?.cwd, "/worktrees/test");

    await render({ worktrees: [{ ...tree("feature/main", true), isBase: false }], branches: [] });
    assert.doesNotMatch(row("主仓 feature/main").textContent!, /基准/);

    // 基准没检出：根退成轻行，建树入口在根上；主仓挂在根下显示领先/落后
    await render({
      baseBranch: "dev",
      origin: { name: "origin", url: "https://github.com/example/project.git", display: "example/project", hostKind: "github" },
      worktrees: [{ ...tree("feat/chat", true), isBase: false, ahead: 2, behind: 33, dirty: true, dirtyCount: 2 }],
      branches: [
        { name: "dev", worktreePath: null, isPrimary: false, isBase: true, dirty: false,
          ahead: 0, behind: 0, unpushed: 0, hasUpstream: true, upstreamBehind: 3 },
        { name: "feat/chat", worktreePath: "/project", isPrimary: true, isBase: false, dirty: true,
          ahead: 2, behind: 33, unpushed: 0, hasUpstream: false },
      ],
    });
    const baseRoot = row("基准 dev");
    assert.equal(container.querySelector('ul[aria-label="分支地图"]')!.firstElementChild, baseRoot);
    assert.match(baseRoot.textContent!, /未检出/);
    assert.match(baseRoot.textContent!, /GitHub 有 3 个新提交/);
    assert.ok(button("建工作树", baseRoot));
    assert.match(row("主仓 feat/chat").textContent!, /比 dev 领先 2 · 落后 33 个提交/);
    assert.doesNotMatch(container.textContent!, /主仓不在基准/);
    assert.deepEqual(errors, []);
    assert.ok(!commands.some((call) => /^(coding_create|coding_remove|coding_merge|coding_delete)/.test(call.command)));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
