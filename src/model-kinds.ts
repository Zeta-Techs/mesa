// 模型分类（2026-10-23）：网关目录里的出图 / 视频 / 向量 / 语音等模型不能当 Agent 的对话模型。
// 与后端 src-tauri/src/image_gen.rs 的 model_kind / is_image_gen_model 互为镜像，
// 两侧测试共读 tests/fixtures/model-kinds.json——改一侧必须同改另一侧。

export type ModelKind = "chat" | "image" | "video" | "embedding" | "rerank" | "audio" | "moderation";

/** 去掉 `厂商/` 前缀、小写、按 - _ : 空格等切词；`.` 留在词里（wan2.6、flux.1） */
function tokens(id: string): string[] {
  const base = (id.split("/").pop() ?? id).toLowerCase();
  return base.split(/[^a-z0-9.]+/).filter(Boolean);
}

const anyExact = (t: string[], words: string[]) => t.some((x) => words.includes(x));
const anyPrefix = (t: string[], prefixes: string[]) => t.some((x) => prefixes.some((p) => x.startsWith(p)));

/** 判定顺序同后端：视频先于出图（grok-imagine-video），重排先于向量（bge-reranker） */
export function modelKind(id: string): ModelKind {
  const t = tokens(id);
  if (
    anyExact(t, ["video", "videos", "t2v", "i2v", "r2v", "kf2v", "s2v", "animate", "vace"]) ||
    anyPrefix(t, ["sora", "veo", "kling", "seedance", "hailuo", "vidu", "cogvideo", "runway", "pika"])
  )
    return "video";
  if (
    anyExact(t, ["image", "images", "imageedit", "t2i", "i2i", "imagine", "banana", "diffusion"]) ||
    anyPrefix(t, [
      "imagen", "seedream", "seededit", "cogview", "flux", "dall", "midjourney", "ideogram",
      "recraft", "kolors", "hidream", "jimeng", "wanx", "sdxl", "sd3",
    ])
  )
    return "image";
  if (anyPrefix(t, ["rerank"])) return "rerank";
  if (anyExact(t, ["embedding", "embeddings", "embed"]) || anyPrefix(t, ["bge", "m3e"])) return "embedding";
  if (
    anyExact(t, ["tts", "whisper", "transcribe", "asr", "speech"]) ||
    anyPrefix(t, ["cosyvoice", "paraformer", "sambert", "sensevoice"])
  )
    return "audio";
  if (anyExact(t, ["moderation"])) return "moderation";
  return "chat";
}

/** 只给一句话就能出图的模型（去掉改图 / 图生图 / 图片翻译） */
export function isImageGenModel(id: string): boolean {
  if (modelKind(id) !== "image") return false;
  const t = tokens(id);
  return !(anyExact(t, ["edit", "imageedit", "i2i", "mt"]) || anyPrefix(t, ["seededit"]));
}

const KIND_LABEL: Record<Exclude<ModelKind, "chat">, string> = {
  image: "出图模型",
  video: "视频模型",
  embedding: "向量模型",
  rerank: "重排模型",
  audio: "语音模型",
  moderation: "审核模型",
};

/** 不能对话的原因（菜单置灰的说明）；对话模型返回 null */
export function nonChatReason(id: string): string | null {
  const kind = modelKind(id);
  if (kind === "chat") return null;
  const tail = kind === "image" ? "，到设置 → AI 与 Agent → 出图模型 里配，Agent 就能用它出图" : "";
  return `${KIND_LABEL[kind]}，不能用来对话${tail}`;
}

/** 目录拆两份：能对话的 / 被隐藏的非对话模型 */
export function splitChatModels(ids: string[]): { chat: string[]; hidden: string[] } {
  const chat: string[] = [];
  const hidden: string[] = [];
  for (const id of ids) (modelKind(id) === "chat" ? chat : hidden).push(id);
  return { chat, hidden };
}
