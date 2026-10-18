import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Marked } from "marked";
import { Search } from "lucide-react";
import { LoadingRows, SegTabs, searchFieldClass } from "./PageFrame";
import { sanitizeDocumentHtml } from "../document-html";
import {
  filterNoticeGroups,
  noticeDepCount,
  parseNotices,
} from "../third-party-notices";
import { toast } from "../toast";

/**
 * 「开源许可与致谢」内容区：帮助菜单 → 关于、设置 → 关于两处共用（各自套 Modal）。
 * 两页签：致谢与来源（清单里的说明各节，按阅读版式渲染）/ 组件许可（npm + Rust 依赖表，
 * 可按名字或许可搜索）。清单文本嵌在二进制里（about.rs），读一次缓存到进程结束。
 */

let noticesCache: string | null = null;

/** 读随包清单；失败返回 null 并提示（调用方保持在原视图） */
export async function loadThirdPartyNotices(): Promise<string | null> {
  if (noticesCache !== null) return noticesCache;
  try {
    noticesCache = await invoke<string>("read_third_party_notices");
    return noticesCache;
  } catch (e) {
    toast(`开源许可清单读取失败：${String(e)}`, "warning");
    return null;
  }
}

// 清单是随包资源（可信），仍按文档口径转义原始 HTML、再过一遍清洗
const noticesMarked = new Marked({ gfm: true, async: false });
noticesMarked.use({
  renderer: {
    html({ text }) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  },
});

type NoticesTab = "credits" | "deps";

export function ThirdPartyNotices({ text }: { text: string | null }) {
  const parsed = useMemo(() => (text ? parseNotices(text) : null), [text]);
  const [tab, setTab] = useState<NoticesTab>("credits");
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [tab]);

  const proseHtml = useMemo(() => {
    if (!parsed) return "";
    // 许可全文（OFL 等）很长，收进可展开的 <details>，默认只看说明
    const html = String(noticesMarked.parse(parsed.prose))
      .replace(/<pre>/g, "<details><summary>展开许可全文</summary><pre>")
      .replace(/<\/pre>/g, "</pre></details>");
    return sanitizeDocumentHtml(html);
  }, [parsed]);

  if (!parsed) return <LoadingRows compact />;
  const total = noticeDepCount(parsed.groups);
  const groups = filterNoticeGroups(parsed.groups, query);
  const shown = noticeDepCount(groups);

  return (
    <div className="flex min-h-0 flex-col">
      <SegTabs<NoticesTab>
        items={[
          { id: "credits", label: "致谢与数据来源" },
          { id: "deps", label: `组件许可 · ${total}` },
        ]}
        value={tab}
        onChange={setTab}
        className="-ml-1 mb-3 text-xs"
      />
      {tab === "credits" ? (
        <div
          className="md-body max-h-[56vh] overflow-auto pr-1 [&_details]:my-2 [&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:text-l3 [&_summary:hover]:text-l1"
          // 链接一律交系统浏览器，不让 WebView 自己跳走
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest("a");
            if (!a) return;
            e.preventDefault();
            const href = a.getAttribute("href") ?? "";
            if (/^https?:/i.test(href)) {
              openUrl(href).catch(() => toast("浏览器没打开，稍后再试", "warning"));
            }
          }}
          dangerouslySetInnerHTML={{ __html: proseHtml }}
        />
      ) : (
        <>
          <div className="ccode-search-shell relative mb-2">
            <Search
              size={13}
              strokeWidth={1.8}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-l4"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按组件名或许可搜索，如 react、MPL"
              aria-label="搜索组件许可"
              className={`${searchFieldClass} w-full pl-7`}
            />
          </div>
          <div className="max-h-[52vh] overflow-auto rounded-md ccode-well">
            {groups.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-l3">没有匹配「{query.trim()}」的组件</p>
            ) : (
              groups.map((g) => (
                <section key={g.title}>
                  <h3 className="sticky top-0 z-1 flex items-baseline gap-2 bg-inset px-3 py-1.5 text-micro">
                    <span className="font-medium text-l2">{g.title}</span>
                    {g.note && <span className="min-w-0 truncate text-l4">{g.note}</span>}
                    <span className="ml-auto shrink-0 tabular-nums text-l4">{g.deps.length}</span>
                  </h3>
                  <ul>
                    {g.deps.map((d, i) => (
                      <li
                        key={`${d.name}@${d.version}#${i}`}
                        className="flex items-baseline gap-2 px-3 py-1 text-xs hover:bg-hover"
                      >
                        <span className="min-w-0 truncate text-l2" title={d.name}>
                          {d.name}
                        </span>
                        <span className="shrink-0 font-mono text-micro text-l4">{d.version}</span>
                        <span className="ml-auto min-w-0 shrink truncate text-right text-l3" title={d.license}>
                          {d.license}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </div>
          {query.trim() && groups.length > 0 && (
            <p className="mt-1.5 text-micro text-l4">
              匹配 {shown} / {total} 项
            </p>
          )}
        </>
      )}
    </div>
  );
}
