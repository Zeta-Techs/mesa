import assert from "node:assert/strict";
import test from "node:test";
import {
  isBuiltinSkill,
  skillDeleteImpact,
  skillOriginLabel,
} from "../src/skill-delete.ts";

const AGENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "kimi", label: "Kimi Code" },
];

test("内置种子判定只看 source=builtin", () => {
  assert.equal(isBuiltinSkill("builtin"), true);
  for (const s of ["ccode", "local", "zip", "github", "discovered", ""]) {
    assert.equal(isBuiltinSkill(s), false, s);
  }
});

test("来源说明：内置与 Mesa 自建不需要来源行", () => {
  assert.equal(skillOriginLabel({ source: "builtin" }), null);
  assert.equal(skillOriginLabel({ source: "ccode" }), null);
});

test("来源说明：外部导入给出渠道，github 带仓库名", () => {
  assert.equal(
    skillOriginLabel({ source: "github", repo: "anthropics/skills" }),
    "GitHub 仓库 anthropics/skills 导入",
  );
  assert.equal(
    skillOriginLabel({ source: "github", repo: null }),
    "GitHub 导入（未记录仓库）",
  );
  assert.equal(skillOriginLabel({ source: "zip" }), "ZIP 文件导入");
  assert.equal(skillOriginLabel({ source: "discovered" }), "从 Agent 目录收编");
});

test("fail-safe：旧 local 与未知来源一律按非自建提示", () => {
  // 旧数据的自建与本地导入同记 local 无法区分，按外部导入对待
  assert.equal(skillOriginLabel({ source: "local" }), "本地目录导入或早期自建");
  assert.equal(skillOriginLabel({ source: "" }), "未知来源");
  assert.equal(skillOriginLabel({ source: "whatever" }), "未知来源");
});

test("删除影响面：只列 apps=true 的 Agent，按 agents 表序", () => {
  assert.deepEqual(
    skillDeleteImpact(
      { "claude-code": true, codex: false, kimi: true },
      AGENTS,
    ),
    ["Claude Code", "Kimi Code"],
  );
  // 全未启用 = 空数组（弹层不列影响面行）
  assert.deepEqual(skillDeleteImpact({}, AGENTS), []);
  // apps 里的未知 Agent id 不在 agents 表中：不计入
  assert.deepEqual(skillDeleteImpact({ ghost: true }, AGENTS), []);
});
