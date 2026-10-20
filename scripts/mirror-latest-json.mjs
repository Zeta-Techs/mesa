// 应用内更新的国内镜像：把 GitHub Release 的 latest.json 改写成镜像地址（.github/workflows/mirror-release.yml 用）。
// 镜像只是换下载地址：签名（signature 字段）原样保留，应用照旧用内置公钥校验安装包，镜像改不了包。
// CLI：node scripts/mirror-latest-json.mjs <latest.json> <镜像根地址> <tag> <改写后输出路径>
//   标准输出逐行打印「原下载地址<TAB>文件名」，工作流按它下载、上传。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 镜像根地址：必须 https（Tauri updater 在正式版只认 https），去掉结尾斜杠 */
export function normalizeMirrorBase(base) {
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/.test(b)) throw new Error(`镜像根地址必须是 https 地址：${base}`);
  return b;
}

/** 桶里的对象路径前缀：取镜像根地址的路径部分（CDN 把域名根映射到桶根时，二者一一对应） */
export function keyPrefixFromBase(base) {
  const path = new URL(normalizeMirrorBase(base)).pathname.replace(/^\/+|\/+$/g, "");
  return path ? `${path}/` : "";
}

/**
 * 改写清单：每个平台的 url 换成「镜像根/tag/文件名」；其余字段（version、notes、signature…）原样。
 * 返回改写后的清单与要搬运的文件（同一文件被多个平台引用只搬一次）。
 */
export function rewriteLatestJson(manifest, base, tag) {
  const root = normalizeMirrorBase(base);
  if (!/^[\w.+-]+$/.test(tag)) throw new Error(`tag 不合法：${tag}`);
  const out = JSON.parse(JSON.stringify(manifest));
  const files = new Map();
  for (const [platform, entry] of Object.entries(out.platforms ?? {})) {
    if (!entry?.url) throw new Error(`${platform} 没有下载地址`);
    if (!entry.signature) throw new Error(`${platform} 没有签名，拒绝镜像`);
    const name = decodeURIComponent(new URL(entry.url).pathname.split("/").pop() ?? "");
    if (!name || name.includes("/") || name.includes("\\")) throw new Error(`${platform} 的文件名不合法：${entry.url}`);
    files.set(name, entry.url);
    entry.url = `${root}/${tag}/${encodeURIComponent(name)}`;
  }
  if (files.size === 0) throw new Error("清单里没有任何平台");
  return { manifest: out, files: [...files].map(([name, url]) => ({ name, url })) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, base, tag, output] = process.argv.slice(2);
  if (!input || !base || !tag || !output) {
    console.error("用法：node scripts/mirror-latest-json.mjs <latest.json> <镜像根地址> <tag> <输出路径>");
    process.exit(1);
  }
  const { manifest, files } = rewriteLatestJson(JSON.parse(readFileSync(input, "utf8")), base, tag);
  writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  for (const f of files) console.log(`${f.url}\t${f.name}`);
}
