import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsWebglRenderer } from "../src/terminal-renderer.ts";

test("自动档：Mac 默认清晰（DOM），Gemini 标签例外走 WebGL；Windows 一律 WebGL", () => {
  const mac = (agentId: string | undefined) =>
    wantsWebglRenderer({ setting: "auto", isMac: true, agentId });
  assert.equal(mac("claude-code"), false);
  assert.equal(mac(undefined), false); // shell / 还没选 agent
  assert.equal(mac("gemini"), true);
  assert.equal(
    wantsWebglRenderer({ setting: undefined, isMac: true, agentId: "gemini" }),
    true,
  );
  assert.equal(
    wantsWebglRenderer({ setting: "auto", isMac: false, agentId: "claude-code" }),
    true,
  );
});

test("用户显式选的档位不被 agent 覆盖", () => {
  assert.equal(
    wantsWebglRenderer({ setting: "dom", isMac: true, agentId: "gemini" }),
    false,
  );
  assert.equal(
    wantsWebglRenderer({ setting: "dom", isMac: false, agentId: "gemini" }),
    false,
  );
  assert.equal(
    wantsWebglRenderer({ setting: "webgl", isMac: true, agentId: "codex" }),
    true,
  );
});
