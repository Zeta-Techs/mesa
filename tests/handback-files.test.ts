import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDeclarations,
  parsePermissionRows,
  setPermissionStatus,
  writeDeclarations,
} from "../src/handback-files.ts";

const PERMS = `# 换原图与转载许可

拼图共 2 块。

| 图 | 原文 | 原图 | 出版社 | 许可 | 要不要申请 | 图注出处 | 状态 |
|---|---|---|---|---|---|---|---|
| 1(a) | Zhang et al., 2020, *ChemCatChem* 12 — Title [DOI](https://doi.org/10.1002/cctc.202000315) | Fig. 4(a) | Wiley | 非开放获取 | 要申请：RightsLink | Adapted with permission from Fig. 4(a) of [@k1]. | 待申请 |
| 5(a) | Zhai et al., 2022 — Stability [DOI](https://doi.org/10.1002/inf2.12357) | Fig. 4 | Wiley | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | 不用申请 | Adapted from Fig. 4 of [@k2], licensed under CC BY 4.0. | 无需申请 |

尾注。
`;

test("许可清单逐行拆出，改状态只动那一格（2026-10-24 用户：打开清单不方便）", () => {
  const rows = parsePermissionRows(PERMS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].figure, "1(a)");
  assert.equal(rows[0].doiUrl, "https://doi.org/10.1002/cctc.202000315");
  assert.doesNotMatch(rows[0].paper, /DOI\]/);
  assert.equal(rows[1].licence, "CC BY 4.0");
  assert.equal(rows[1].status, "无需申请");
  const next = setPermissionStatus(PERMS, rows[0].line, "已申请");
  assert.equal(parsePermissionRows(next)[0].status, "已申请");
  assert.equal(parsePermissionRows(next)[1].status, "无需申请");
  assert.match(next, /尾注。/);
  assert.equal(next.split("\n").length, PERMS.split("\n").length);
});

const DECL = `# Declarations（投稿声明模板）

> 空白模板，由作者本人填写。

## Authors

待填（作者姓名、单位、通讯作者邮箱；一行一位作者）

## Funding

待填

## AI use declaration

待作者核对（以下为草稿）：

In preparing this review, the authors used an AI assistant.
`;

test("投稿声明按节拆成一框一节，空的写回「待填」带原提示，开头说明不动", () => {
  const sections = parseDeclarations(DECL);
  assert.deepEqual(sections.map((s) => s.label), ["作者与单位", "基金", "AI 使用声明"]);
  assert.equal(sections[0].body, "");
  assert.match(sections[0].hint, /通讯作者邮箱/);
  assert.match(sections[2].body, /AI assistant/);
  const filled = sections.map((s) => (s.heading === "Funding" ? { ...s, body: "NSFC 21902127" } : s));
  const out = writeDeclarations(DECL, filled);
  assert.match(out, /> 空白模板，由作者本人填写。/);
  assert.match(out, /## Authors\n\n待填（作者姓名、单位、通讯作者邮箱；一行一位作者）/);
  assert.match(out, /## Funding\n\nNSFC 21902127/);
  assert.deepEqual(parseDeclarations(out).map((s) => s.body), ["", "NSFC 21902127", sections[2].body]);
});

