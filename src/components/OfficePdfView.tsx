import { lazy, Suspense, useEffect, useState } from "react";
import { convertOfficeToPdf } from "../office-convert";
import { useFileVersion } from "../file-watch";

const PdfContinuousView = lazy(() => import("./PdfContinuousView"));

/** Word / 幻灯经 LibreOffice 转出的 PDF：转换中给进度话术，原文件改了重新转 */
export default function OfficePdfView({ path, cwdHint }: { path: string; cwdHint: string | null }) {
  const [pdf, setPdf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useFileVersion(path);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    convertOfficeToPdf(path, cwdHint)
      .then((p) => {
        if (!cancelled) setPdf(p);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, version]);
  if (error) return <p className="px-3 py-4 text-sm text-err-text">{error}</p>;
  if (!pdf)
    return (
      <p className="px-3 py-4 text-sm text-l4">
        正在用 LibreOffice 转成 PDF…第一次要十几秒，之后这份文件没改就直接打开。
      </p>
    );
  return (
    <Suspense fallback={<p className="px-3 py-4 text-sm text-l4">正在打开 PDF…</p>}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PdfContinuousView path={pdf} cwdHint={cwdHint} maxFitMultiplier={1.5} />
      </div>
    </Suspense>
  );
}
