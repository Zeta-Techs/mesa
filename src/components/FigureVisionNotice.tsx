import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelCapabilityDto } from "../types";
import { figureVisionNotice } from "../figure-vision";

/** 开工确认「技能」行下的一行小字：步骤要拼图、所选模型看不了图（或不知道）时提醒，不拦开工 */
export default function FigureVisionNotice({ skills, model, gatewayId }: {
  skills: readonly string[]; model: string; gatewayId: string | null;
}) {
  const [vision, setVision] = useState<boolean | null | undefined>(undefined);
  const wants = skills.includes("review-figures");
  useEffect(() => {
    if (!wants || !model.trim()) {
      setVision(model.trim() ? undefined : null);
      return;
    }
    let stale = false;
    setVision(undefined);
    invoke<ModelCapabilityDto[]>("model_capabilities", { models: [model.trim()], gatewayId })
      .then((rows) => { if (!stale) setVision(rows[0]?.vision ?? null); })
      .catch(() => { if (!stale) setVision(null); });
    return () => { stale = true; };
  }, [wants, model, gatewayId]);
  if (vision === undefined) return null;
  const text = figureVisionNotice(skills, model, vision);
  return text ? <p className="mt-1 text-micro text-warn-text">{text}</p> : null;
}
