import { useState } from "react";
import type { Attachment } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { formatBytes } from "../../shared/i18n/number.ts";
import {
  DownloadButton,
  ImageLightbox,
  type LightboxImage,
} from "./attachment-download.tsx";

// Card emitted by POST /api/agents/:id/read-file and /preview-url. Images render
// inline (clickable for lightbox); other media types render as a clickable file
// chip via the same /api/files/<agentId>/<filename> route used by uploaded
// attachments. Each image and chip has a download button. `caption`
// (preview-url provenance: sanitized origin + pathname) renders as a dim line
// under the attachments when provided.
export function FileViewCard({
  attachments,
  agentId,
  isMobile,
  caption,
}: {
  attachments: Attachment[];
  agentId: string;
  isMobile?: boolean;
  caption?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const images = attachments.filter((a) => a.mediaType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mediaType.startsWith("image/"));

  return (
    <div style={{ margin: "8px 0" }}>
      {images.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {images.map((att) => {
            const src = `/api/files/${agentId}/${att.filename}`;
            return (
              <div
                key={att.filename}
                style={{ position: "relative", maxWidth: "100%" }}
              >
                <img
                  src={src}
                  alt={att.originalName}
                  onClick={() => setLightbox({ src, name: att.originalName })}
                  style={{
                    display: "block",
                    maxWidth: isMobile ? "100%" : 300,
                    maxHeight: 200,
                    borderRadius: 4,
                    cursor: "pointer",
                    border: "1px solid var(--green-border)",
                  }}
                />
                <DownloadButton
                  src={src}
                  name={att.originalName}
                  isMobile={isMobile}
                  overlay
                />
              </div>
            );
          })}
        </div>
      )}
      {files.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: images.length > 0 ? 8 : 0,
          }}
        >
          {files.map((att) => {
            const src = `/api/files/${agentId}/${att.filename}`;
            const sizeStr =
              formatBytes(i18n.language, att.size) ?? t("common.unknownSize");
            return (
              <span
                key={att.filename}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  maxWidth: "100%",
                }}
              >
                <a
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--green-border)",
                    background: "var(--green-bg)",
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-ui)",
                    fontSize: isMobile ? 13 : 12,
                    textDecoration: "none",
                    cursor: "pointer",
                    maxWidth: "100%",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {att.originalName}
                  </span>
                  <span style={{ color: "var(--text-ghost)", flexShrink: 0 }}>
                    {sizeStr}
                  </span>
                </a>
                <DownloadButton
                  src={src}
                  name={att.originalName}
                  isMobile={isMobile}
                  style={{
                    boxSizing: "border-box",
                    background: "var(--green-bg)",
                    border: "1px solid var(--green-border)",
                    color: "var(--text-secondary)",
                  }}
                />
              </span>
            );
          })}
        </div>
      )}
      {caption && (
        <div
          style={{
            marginTop: 4,
            fontFamily: "var(--font-ui)",
            fontSize: isMobile ? 12 : 11,
            color: "var(--text-ghost)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {caption}
        </div>
      )}
      {lightbox && (
        <ImageLightbox
          image={lightbox}
          isMobile={isMobile}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
