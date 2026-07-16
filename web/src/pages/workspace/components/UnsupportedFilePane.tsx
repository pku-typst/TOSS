import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { renderPdfBytesToCanvas } from "@/lib/pdf";
import type { Translator } from "@/lib/i18n";

export function UnsupportedFilePane({
  path,
  hasData,
  isImage,
  isPdf,
  dataUrl,
  t
}: {
  path: string;
  hasData: boolean;
  isImage: boolean;
  isPdf: boolean;
  dataUrl: string;
  t: Translator;
}) {
  const downloadName = path.split("/").filter(Boolean).pop() || path;
  const pdfCanvasRef = useRef<HTMLDivElement | null>(null);
  const [pdfRenderError, setPdfRenderError] = useState<string | null>(null);
  const [pdfRendering, setPdfRendering] = useState(false);
  const pdfBase64 = useMemo(() => {
    if (!isPdf || !dataUrl.startsWith("data:")) return "";
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return "";
    return dataUrl.slice(comma + 1);
  }, [dataUrl, isPdf]);

  useEffect(() => {
    if (!isPdf || !hasData) return;
    const container = pdfCanvasRef.current;
    if (!container || !pdfBase64) return;
    let cancelled = false;
    setPdfRenderError(null);
    setPdfRendering(true);
    const binary = atob(pdfBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    renderPdfBytesToCanvas(container, bytes, { pixelPerPt: 2.5 })
      .then(() => {
        if (!cancelled) setPdfRendering(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(t("errors.pdfPreview"), err);
        setPdfRendering(false);
        setPdfRenderError(t("errors.pdfPreview"));
      });
    return () => {
      cancelled = true;
    };
  }, [hasData, isPdf, pdfBase64, t]);

  const media = isImage ? (
    <img src={dataUrl} alt={path} className="file-preview-image" />
  ) : isPdf ? (
    <div className="file-preview-pdf-canvas" aria-label={path}>
      {pdfRendering && <div className="file-preview-pdf-overlay">{t("workspace.fileLoading")}</div>}
      {pdfRenderError && <div className="file-preview-pdf-overlay error">{pdfRenderError}</div>}
      <div ref={pdfCanvasRef} className="file-preview-pdf-surface" />
    </div>
  ) : (
    <div className="file-icon" aria-hidden />
  );

  if (!hasData) {
    return (
      <div className="file-preview file-preview-asset">
        <div className="file-preview-media">
          <div className="file-icon" aria-hidden />
        </div>
        <div className="file-preview-meta">
          <div className="file-preview-name">{path}</div>
          <small>{t("workspace.fileLoading")}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="file-preview file-preview-asset">
      <div className="file-preview-media">{media}</div>
      <div className="file-preview-meta">
        <div className="file-preview-name">{downloadName}</div>
        <small className="muted">{path}</small>
        <nve-icon-button
          className="ui-icon-button"
          role="button"
          container="flat"
          size="sm"
          title={t("workspace.download")}
          aria-label={t("workspace.download")}
        >
          <a href={dataUrl} download={downloadName}>
            <Download size={16} />
          </a>
        </nve-icon-button>
      </div>
    </div>
  );
}
