/** 综述拼图要模型自己看图读坐标、核对裁出来的子图。看不了图的模型只能经第三方看图工具转述，
 *  坐标读偏得很远（2026-10-23 HER 初稿：子图在 0.505–1.0 读成 0.30–0.60，五张拼图全裁错），
 *  开工确认时提前说一句。vision = 能力库查到的「看图」：true 不提示，false / null（不知道）提示。 */
export function figureVisionNotice(
  skills: readonly string[],
  model: string,
  vision: boolean | null | undefined,
): string | null {
  if (!skills.includes("review-figures") || vision === true) return null;
  const name = model.trim() ? `「${model.trim()}」` : "默认模型";
  return vision === false
    ? `这一步要从论文 PDF 里裁子图拼图，${name}不能看图：读不准子图的位置，拼图多半会降级成「见 Fig.n」，裁出来的也要你逐张核对。想要好的拼图，换一个能看图的模型。`
    : `这一步要从论文 PDF 里裁子图拼图，${name}能不能看图不确定（模型能力库里没有）。看不了图时拼图多半会降级成「见 Fig.n」，裁出来的也要你逐张核对。`;
}
