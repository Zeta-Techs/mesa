import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelCapabilityDto } from "../types";
import { modelCapsLabel } from "../model-caps-label";
import { officialModelLabel, type OfficialAliasTable } from "../official-model-names";

/**
 * 连接行展开的模型列表（2026-10-28 用户拍板：行内只「看」和「换启动默认」，添加 / 删除 / 排序统一去编辑）。
 * 每行：型号（官方别名显示成实测型号、别名写灰字）· 能力灰字 · 行尾「启动默认」或「设为默认」。
 * API 连接底下「编辑模型…」打开编辑弹层；官方账号的名单来自 CLI，只说一句来源。
 */
export default function ProfileModelPanel({
  agent,
  official,
  models,
  gatewayId,
  gone,
  aliases,
  busy,
  onSetDefault,
  onEdit,
}: {
  agent: string;
  official: boolean;
  models: string[];
  gatewayId: string | null;
  /** 不在网关目录里的（标橙划掉，不给设默认） */
  gone: string[];
  aliases: OfficialAliasTable;
  /** 正在设默认的那个模型 */
  busy: string | null;
  onSetDefault: (model: string) => void;
  onEdit: () => void;
}) {
  const [caps, setCaps] = useState<Record<string, string>>({});
  const key = models.join("\n");
  useEffect(() => {
    if (!key) return;
    let stale = false;
    invoke<ModelCapabilityDto[]>("model_capabilities", { models: key.split("\n"), gatewayId })
      .then((list) => {
        if (stale) return;
        const out: Record<string, string> = {};
        for (const c of list) out[c.model] = modelCapsLabel(c);
        setCaps(out);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [key, gatewayId]);

  return (
    <div data-no-row-drag className="col-span-full -mx-4 border-t border-hairline bg-inset/40 px-4 py-1.5">
      <ul>
        {models.map((m, i) => {
          const label = official ? officialModelLabel(agent, m, aliases) : { text: m, tip: m };
          const isGone = gone.includes(m);
          const sub = [label.text !== m ? m : "", caps[m] ?? ""].filter(Boolean).join(" · ");
          return (
            <li key={m} className="flex h-8 min-w-0 items-center gap-2 text-xs">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${i === 0 ? "bg-cta" : "bg-transparent"}`}
              />
              <span
                className={`min-w-0 truncate font-mono text-micro ${
                  isGone ? "text-warn-text line-through" : i === 0 ? "text-l1" : "text-l2"
                }`}
                title={isGone ? `${m}：已不在网关的模型目录里，点「编辑模型…」去掉或换一个` : label.tip}
              >
                {label.text}
              </span>
              {sub && <span className="min-w-0 truncate text-micro text-l3">{sub}</span>}
              <span className="ml-auto shrink-0">
                {i === 0 ? (
                  <span className="text-micro text-l3">启动默认</span>
                ) : isGone ? null : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => onSetDefault(m)}
                    title="新开对话时默认用它（会话里照样能换）；已经开着的对话不受影响"
                    className="rounded-md px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    {busy === m ? "设置中…" : "设为默认"}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex h-7 items-center text-micro text-l3">
        {official ? (
          <span>名单来自 CLI 自己（升级后自动更新），这里只能换启动默认</span>
        ) : (
          <button type="button" onClick={onEdit} className="rounded-md px-1.5 py-0.5 -mx-1.5 hover:bg-hover hover:text-l1">
            编辑模型…（添加、删除、调顺序）
          </button>
        )}
      </div>
    </div>
  );
}
