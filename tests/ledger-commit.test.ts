import assert from "node:assert/strict";
import test from "node:test";
import { commitProjectLedger, ledgerCommitPaths } from "../src/ledger-commit.ts";

test("ledgerCommitPaths：只留台账白名单、去重、按固定顺序", () => {
  assert.deepEqual(
    ledgerCommitPaths(["papers/to-fetch.md", "papers/included.json", "notes/index.json", "papers/included.json", ".\\papers\\to-fetch.ris"]),
    ["papers/included.json", "papers/to-fetch.md", "papers/to-fetch.ris"],
  );
});

test("commitProjectLedger：有台账才调后端；失败不抛错，回一句提示", async () => {
  const calls: unknown[] = [];
  const ok = await commitProjectLedger("/p", ["papers/included.md", "papers/included.json"], async (cmd, args) => {
    calls.push([cmd, args]);
    return true;
  });
  assert.equal(ok, null);
  assert.deepEqual(calls, [["commit_project_ledger", { projectRoot: "/p", paths: ["papers/included.json", "papers/included.md"] }]]);
  assert.equal(await commitProjectLedger("/p", ["notes/a.md"], async () => assert.fail("不该调用")), null);
  const note = await commitProjectLedger("/p", ["papers/included.json"], async () => {
    throw new Error("git 不可用");
  });
  assert.match(note!, /没能自动提交（git 不可用）/);
});
