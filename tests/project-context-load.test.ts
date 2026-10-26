import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import {
  renderProjectContextPack,
  renderSessionInjection,
} from "../src/project-context.ts";

/** 三态分派是「对话注入」的行为中枢（off→空串 / custom→模板 / 空模板回落自动 /
 *  config 读失败回落自动 / goal 包免疫）。真实链路经 @tauri-apps invoke，
 * 这里照 pipeline-start.test.ts 的口径用 esbuild 桩替换 invoke 逐分支钉住——
 * 纯函数测试替代不了这层（改丢一个 !isGoal 会让 off 连开工任务书一起杀掉且全绿上线）。 */

interface HostState {
  config: Record<string, unknown>;
  failConfig: boolean;
}

const state: HostState = {
  config: {},
  failConfig: false,
};

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    topic: "镁硫电池",
    settings: ["只写中文"],
    rulesOwned: true,
    workMode: "research",
    steps: [],
    protectedPaths: [],
    skills: [],
    ...overrides,
  };
}

async function bundleLoader(): Promise<{
  loadProjectContextPack: (input: Record<string, unknown>) => Promise<string>;
}> {
  const bundle = await build({
    stdin: {
      contents: `export {loadProjectContextPack} from './src/project-context-load';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    plugins: [
      {
        name: "injection-load-host",
        setup(b) {
          const stubs: Record<string, string> = {
            "@tauri-apps/api/core":
              "export const invoke = async (cmd, args) => globalThis.__injectionLoadHost.invoke(cmd, args);",
          };
          b.onResolve({ filter: /.*/ }, (args) =>
            args.path in stubs
              ? { path: args.path, namespace: "injection-load-stub" }
              : undefined,
          );
          b.onLoad(
            { filter: /.*/, namespace: "injection-load-stub" },
            (args) => ({
              contents: stubs[args.path],
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const compiled = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  return compiled.exports as unknown as {
    loadProjectContextPack: (input: Record<string, unknown>) => Promise<string>;
  };
}

const host = {
  invoke: async (cmd: string, _args: Record<string, unknown>) => {
    switch (cmd) {
      case "read_project_config": {
        if (state.failConfig) throw new Error("读不到档案卡");
        return { config: state.config, warnings: [] };
      }
      case "list_dir":
        return [
          { name: "papers", isDir: true },
          { name: "README.md", isDir: false },
        ];
      case "read_project_memory":
        return "记忆内容";
      case "read_project_status":
        return { accepted: [] };
      case "task_list":
        return [];
      default:
        throw new Error(`桩未覆盖的命令：${cmd}`);
    }
  },
};
(globalThis as Record<string, unknown>).__injectionLoadHost = host;

const LOAD_INPUT = {
  name: "综述流程测试",
  path: "/tmp/综述流程测试",
  workMode: "research",
};

test("off mode returns empty pack for sessions", async () => {
  const { loadProjectContextPack } = await bundleLoader();
  state.failConfig = false;
  state.config = baseConfig({ sessionInjectionMode: "off" });
  assert.equal(
    await loadProjectContextPack({ ...LOAD_INPUT, kind: "session" }),
    "",
  );
});

test("off mode never silences goal packs", async () => {
  const { loadProjectContextPack } = await bundleLoader();
  state.config = baseConfig({ sessionInjectionMode: "off" });
  const goalPack = await loadProjectContextPack({
    ...LOAD_INPUT,
    kind: "goal",
    goal: "写综述",
    writeReview: true,
  });
  assert.match(goalPack, /当前目标：/);
  assert.match(goalPack, /验收再写回/);
});

// 加载器按 hotkeys.IS_WINDOWS 决定要不要补「本机 Python（Windows）」一节；期望值照同一判定算，Windows CI 上才对得上
const LOADER_IS_WINDOWS =
  typeof navigator !== "undefined" && (navigator.platform || "").startsWith("Win");

test("custom mode renders the template with live data", async () => {
  const { loadProjectContextPack } = await bundleLoader();
  const template = "{{课题主题}}\n\n{{项目规则}}\n\n先给结论。";
  state.config = baseConfig({
    sessionInjectionMode: "custom",
    sessionInjectionTemplate: template,
  });
  const pack = await loadProjectContextPack({
    ...LOAD_INPUT,
    kind: "session",
  });
  assert.equal(
    pack,
    renderSessionInjection(template, {
      name: LOAD_INPUT.name,
      path: LOAD_INPUT.path,
      workMode: "research",
      topic: "镁硫电池",
      settings: ["只写中文"],
      rulesOwned: true,
      topLevel: [
        { name: "papers", isDir: true },
        { name: "README.md", isDir: false },
      ],
      kind: "session",
      memory: "记忆内容",
      isWindows: LOADER_IS_WINDOWS,
    }),
  );
  assert.match(pack, /先给结论。/);
});

test("custom mode with empty template falls open to the auto pack", async () => {
  const { loadProjectContextPack } = await bundleLoader();
  state.config = baseConfig({
    sessionInjectionMode: "custom",
    sessionInjectionTemplate: "   ",
  });
  const pack = await loadProjectContextPack({
    ...LOAD_INPUT,
    kind: "session",
  });
  assert.equal(
    pack,
    renderProjectContextPack({
      name: LOAD_INPUT.name,
      path: LOAD_INPUT.path,
      workMode: "research",
      topic: "镁硫电池",
      settings: ["只写中文"],
      rulesOwned: true,
      topLevel: [
        { name: "papers", isDir: true },
        { name: "README.md", isDir: false },
      ],
      kind: "session",
      memory: "记忆内容",
      isWindows: LOADER_IS_WINDOWS,
    }),
  );
});

test("config read failure keeps the auto pack for sessions", async () => {
  const { loadProjectContextPack } = await bundleLoader();
  state.failConfig = true;
  const pack = await loadProjectContextPack({
    ...LOAD_INPUT,
    kind: "session",
  });
  state.failConfig = false;
  // 读不到档案卡：三态未知，按 auto 走现状（短包），不能变成不注入
  assert.match(pack, /你正在项目「综述流程测试」中工作/);
});
