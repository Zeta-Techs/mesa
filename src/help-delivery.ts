export async function sendHelpDelivery(
  runId: string,
  take: (runId: string) => Promise<[string, string] | null>,
  send: (text: string) => Promise<{ error: string | null; needsTerminal?: boolean }>,
  acknowledge: (id: string, runId: string) => Promise<void>,
): Promise<string | null> {
  const delivery = await take(runId);
  if (!delivery) return null;
  const [id, text] = delivery;
  try {
    const result = await send(text);
    if (result.error) return `回答发送结果未确认，请核对原对话；未自动重发：${result.error}`;
    if (result.needsTerminal) return "回答尚未确认送到，请回终端核对；未自动重发";
    await acknowledge(id, runId);
    return null;
  } catch (error) {
    return `回答送达未确认，请核对原对话；未自动重发：${String(error)}`;
  }
}
