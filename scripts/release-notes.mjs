// 发版更新说明：从 CHANGELOG.md 取本版本段落，供 CI 写进 Release 正文 / latest.json 的 notes。
// 优先「## v<版本>」段，其次「## 未发布」段；两者都空则失败（否则用户看到的更新说明是空的）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function extractReleaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versioned = new RegExp(`^##\\s+v?${esc}(?![\\w.])`);
  const section = (match) => {
    const start = lines.findIndex((l) => match(l));
    if (start < 0) return "";
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  };
  return (
    section((l) => versioned.test(l)) ||
    section((l) => /^##\s+未发布\s*$/.test(l))
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version) {
    console.error("用法：node scripts/release-notes.mjs <版本号>");
    process.exit(1);
  }
  const notes = extractReleaseNotes(readFileSync("CHANGELOG.md", "utf8"), version);
  if (!notes) {
    console.error(`CHANGELOG.md 里没有「## v${version}」或「## 未发布」段的内容：先写更新说明再发版`);
    process.exit(1);
  }
  process.stdout.write(notes + "\n");
}
