import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, imageFitScale } from "../src/image-view.ts";
import { armDraftHandoff, stashDraftIfArmed, takeDraft } from "../src/file-draft-handoff.ts";

test("适应窗口：大图缩进框里，小图不放大", () => {
  assert.equal(imageFitScale({ w: 2000, h: 1000 }, { w: 1024, h: 1024 }, 24), 0.5);
  assert.equal(imageFitScale({ w: 100, h: 50 }, { w: 800, h: 600 }, 24), 1);
  assert.equal(imageFitScale({ w: 0, h: 0 }, { w: 800, h: 600 }), 1);
});

test("字节写法", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(300 * 1024), "300 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

const snap = { text: "a", truncated: false, revision: "r1", readOnlyReason: null };

test("预览搬家：arm 过才寄存，取一次就没了", () => {
  const draft = { text: "改过", baseline: snap, mode: "edit" as const, viewState: null };
  assert.equal(stashDraftIfArmed("/p/a.md", draft), false);
  assert.equal(takeDraft("/p/a.md"), null);
  armDraftHandoff("/p/a.md");
  assert.equal(stashDraftIfArmed("/p/a.md", draft), true);
  assert.equal(takeDraft("/p/a.md")?.text, "改过");
  assert.equal(takeDraft("/p/a.md"), null);
});

test("预览搬家：arm 过期不寄存（关预览前确认丢掉的修改不能复活）", () => {
  const draft = { text: "x", baseline: snap, mode: "read" as const, viewState: null };
  armDraftHandoff("/p/b.md", 1000);
  assert.equal(stashDraftIfArmed("/p/b.md", draft, 1000 + 60_000), false);
  assert.equal(takeDraft("/p/b.md"), null);
});
