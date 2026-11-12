import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { citeTipFor, decorateCitations, linkFileRefs } from "../src/chat-inline-refs.ts";

/** 回复渲染后的就地加工：文件路径（后端核实过的才变链接）、引用键胶囊（读 bib 换成作者年份） */
function setup(html: string, ipc: (cmd: string, args: Record<string, unknown>) => unknown) {
  const dom = new JSDOM(`<div id="host">${html}</div>`);
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return ipc(cmd, args);
      },
    },
  });
  (globalThis as Record<string, unknown>).window = dom.window;
  return { host: dom.window.document.getElementById("host")!, calls };
}

test("文件路径：核实存在的才变链接（行内代码可只是文件名，正文要带目录）；代码块与链接里的不动", async () => {
  const { host, calls } = setup(
    `<p>改了 <code>src/a.ts:12</code>、<code>README.md</code> 和 notes/plan.md，<code>src/gone.ts</code> 不在了；见 <a href="x">src/a.ts</a></p>
     <pre><code>src/a.ts</code></pre>`,
    (cmd, args) => {
      assert.equal(cmd, "existing_files");
      assert.equal(args.cwd, "/proj-files");
      const exists: Record<string, string> = {
        "src/a.ts": "/proj-files/src/a.ts",
        "README.md": "/proj-files/README.md",
        "notes/plan.md": "/proj-files/notes/plan.md",
      };
      return (args.paths as string[]).filter((p) => exists[p]).map((p) => ({ path: p, abs: exists[p] }));
    },
  );
  await linkFileRefs(host, "/proj-files");
  const links = Array.from(host.querySelectorAll<HTMLElement>(".md-file-link"));
  assert.deepEqual(
    links.map((l) => [l.tagName, l.textContent, l.dataset.fileAbs]),
    [
      ["CODE", "src/a.ts:12", "/proj-files/src/a.ts"],
      ["CODE", "README.md", "/proj-files/README.md"],
      ["SPAN", "notes/plan.md", "/proj-files/notes/plan.md"],
    ],
  );
  assert.equal(host.querySelector("pre .md-file-link"), null);
  assert.equal(host.querySelector("a .md-file-link"), null);
  assert.equal(calls.length, 1);
  // 同一批路径 15 秒内不再问后端
  await linkFileRefs(host, "/proj-files");
  assert.equal(calls.length, 1);
});

test("引用键：先按键名占位，读到 bib 换成作者年份；bib 里没有的标 missing；行内代码里的不动", async () => {
  const { host } = setup(
    `<p>前人工作 [@smith2020; @nope] 已说明，另见 [-@lee2021, p. 3]。<code>[@inline]</code></p>`,
    (cmd, args) => {
      assert.equal(cmd, "cite_lookup");
      assert.equal(args.cwd, "/proj-cite");
      return {
        bibFound: true,
        entries: [
          { key: "smith2020", authors: ["Smith", "Lee", "Kim"], year: "2020", title: "A study" },
          { key: "lee2021", authors: ["Lee"], year: "2021", title: "Another" },
        ],
      };
    },
  );
  await decorateCitations(host, "/proj-cite");
  const chips = Array.from(host.querySelectorAll<HTMLElement>(".md-cite-item"));
  assert.deepEqual(
    chips.map((c) => [c.textContent, c.dataset.state]),
    [
      ["Smith et al. 2020", "found"],
      ["@nope", "missing"],
      ["2021, p. 3", "found"],
    ],
  );
  assert.equal(host.querySelector("code")?.textContent, "[@inline]");
  assert.match(citeTipFor(chips[0]!)!.text, /A study/);
  assert.match(citeTipFor(chips[1]!)!.warn ?? "", /references\.bib 里没有/);
  // 已经换过的不再包第二层
  await decorateCitations(host, "/proj-cite");
  assert.equal(host.querySelectorAll(".md-cite-item").length, 3);
});

test("引用键：没有会话目录（回放）只留键名胶囊，不问后端", async () => {
  const { host, calls } = setup(`<p>[@solo]</p>`, () => assert.fail("不该问后端"));
  await decorateCitations(host, null);
  assert.equal(host.querySelector(".md-cite-item")?.textContent, "@solo");
  assert.equal(calls.length, 0);
});
