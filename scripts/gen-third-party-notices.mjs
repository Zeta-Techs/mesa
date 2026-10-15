// 生成随包分发的第三方开源许可清单（src-tauri/resources/third-party-notices.md）。
// npm 侧读 package-lock.json 的生产依赖（锁文件自带 license 字段）；Rust 侧跑
// `cargo metadata`（--locked 防 Cargo.lock 漂移）取依赖树。产物进 git、进
// bundle.resources、经 about.rs include_str! 嵌进二进制供「设置 → 关于」渲染——
// 三个出口同一份文件，改依赖后必须 `npm run gen:notices` 再提交。
// 手工维护的内嵌资产署名（字体 / 图标 / 数据来源 / 设计致谢）在
// docs/licenses/THIRD-PARTY.md，不归本脚本管。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(root, "src-tauri/resources/third-party-notices.md");

// 个别包缺 license 字段时的兜底：khroma（mermaid 传递依赖）package.json 无字段，
// 盘上 LICENSE 实为 MIT（© Fabio Spampinato, Andrew Maney）——显式写死，
// 避免公司发布前的许可扫描把它报成 UNKNOWN。
const LICENSE_OVERRIDES = new Map([["khroma", "MIT"]]);

/** 从手工清单（docs/licenses/THIRD-PARTY.md）按标题摘录整节。
 *  随包文件必须自带内嵌资产署名与 OFL 全文——「随包携带声明」的许可义务
 *  （OFL 条件 2）落在安装包内，而不是只落在仓库文档里；仓库文档仍是唯一事实源。
 *  标题一旦改动，摘录会静默变空——OFL 全文是硬义务，这里宁可构建失败也不许无声缺文。 */
function manualSections() {
  const md = readFileSync(join(root, "docs/licenses/THIRD-PARTY.md"), "utf8");
  const wanted = ["内嵌资产", "数据来源", "设计参考致谢"];
  const out = [];
  let capturing = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      capturing = wanted.some((w) => line.slice(3).trim().startsWith(w));
      if (capturing) out.push(line);
      continue;
    }
    if (capturing) out.push(line);
  }
  const text = out.join("\n").trim();
  if (!text.includes("SIL OPEN FONT LICENSE") || !text.includes("lobe-icons")) {
    console.error(
      "[gen-notices] 摘录自 docs/licenses/THIRD-PARTY.md 的「内嵌资产」缺 OFL 全文或图标署名——" +
        "多半是标题被改动导致按前缀摘录落空。修 THIRD-PARTY.md 的 ## 标题再生成。",
    );
    process.exit(1);
  }
  return text;
}

/** npm 生产依赖：锁文件 packages 里非 dev 的条目（optional 也随装算分发内）。 */
function npmProdDeps() {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const rows = [];
  const seen = new Set();
  for (const [key, info] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/") || info.dev) continue;
    // 顶层键是 "node_modules/<名>"（无前导斜杠）、嵌套是 ".../node_modules/<名>"——
    // 按 "node_modules/" 切取最末段，两种都得到裸包名；去重副本同版本只留一行
    const name = key.split(/node_modules\//).pop();
    const version = info.version ?? "";
    const dedupKey = `${name}@${version}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const license = info.license ?? LICENSE_OVERRIDES.get(name) ?? "UNKNOWN";
    rows.push({ name, version, license });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return rows;
}

/** Rust 依赖：cargo metadata 的 packages 减去本仓 workspace 成员。
 *  含 dev-dependencies（Cargo.lock 本就锁全集，许可清单只多不少）。 */
function cargoDeps() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1"],
      // 636+ crates 的 metadata JSON 超过 spawnSync 默认 1MB 缓冲，必须放大
      { cwd: join(root, "src-tauri"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const rows = meta.packages
    .filter((p) => !p.manifest_path.startsWith(join(root, "src-tauri")))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? "UNKNOWN",
    }));
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return rows;
}

// 表格里许可字段可能带竖线（少见但存在），统一替换防止破坏 Markdown 表格
const cell = (s) => String(s).replaceAll("|", "\\|");

function table(rows) {
  if (!rows.length) return "_（无）_\n";
  const lines = ["| 组件 | 版本 | 许可 |", "|---|---|---|"];
  for (const r of rows) {
    lines.push(`| ${cell(r.name)} | ${cell(r.version)} | ${cell(r.license)} |`);
  }
  return lines.join("\n") + "\n";
}

const npm = npmProdDeps();
let rust;
try {
  rust = cargoDeps();
} catch (e) {
  // cargo 不可用 / 锁文件漂移：已有清单原样保留、不写半份占位文件直接退出
  // （打包链路宁可沿用提交在仓的上次好文件，也不把 Rust 表冲成占位文案）
  if (existsSync(outPath)) {
    console.warn(`[gen-notices] Rust 侧生成失败，保留现有清单不动：${e.message}`);
    process.exit(0);
  } else {
    throw e;
  }
}

const body = `# Mesa 第三方开源许可清单

Mesa 按 Apache-2.0 发布（版权 2026 泽塔前沿科技（杭州）有限公司；名称与商标不随代码授权）。
本文件由 \`npm run gen:notices\`（scripts/gen-third-party-notices.mjs）生成，请勿手改：
手工维护的唯一事实源是仓库 docs/licenses/THIRD-PARTY.md，下面「内嵌资产 / 数据来源 /
设计参考致谢」三节由脚本从那里摘录。

${manualSections()}

## 前端依赖（npm，随安装包分发）

${table(npm)}
## Rust 依赖（静态链接进安装包）

${table(rust)}
`;

writeFileSync(outPath, body);
console.log(
  `[gen-notices] ${outPath}（npm ${npm.length} 项${rust ? `，Rust ${rust.length} 项` : "，Rust 侧未更新"}）`,
);
