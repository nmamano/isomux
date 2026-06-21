import { useEffect, useState } from "react";
import type { Attachment } from "../../shared/types.ts";

// Card emitted by POST /api/agents/:id/read-file. Images render inline (clickable
// for lightbox); other media types render as a clickable file chip via the
// same /api/files/<agentId>/<filename> route used by uploaded attachments.
export function FileViewCard({
  attachments,
  agentId,
  isMobile,
}: {
  attachments: Attachment[];
  agentId: string;
  isMobile?: boolean;
}) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const images = attachments.filter((a) => a.mediaType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mediaType.startsWith("image/"));

  // Capture-phase Escape so the global window handler in App.tsx (which navs
  // back to the room view) doesn't fire while the lightbox is open.
  useEffect(() => {
    if (!lightboxSrc) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLightboxSrc(null);
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [lightboxSrc]);

  return (
    <div style={{ margin: "8px 0" }}>
      {images.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {images.map((att) => {
            const src = `/api/files/${agentId}/${att.filename}`;
            return (
              <img
                key={att.filename}
                src={src}
                alt={att.originalName}
                onClick={() => setLightboxSrc(src)}
                style={{
                  maxWidth: isMobile ? "100%" : 300,
                  maxHeight: 200,
                  borderRadius: 4,
                  cursor: "pointer",
                  border: "1px solid var(--green-border)",
                }}
              />
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
              att.size < 1024
                ? `${att.size} B`
                : att.size < 1024 * 1024
                  ? `${(att.size / 1024).toFixed(1)} KB`
                  : `${(att.size / (1024 * 1024)).toFixed(1)} MB`;
            return (
              <a
                key={att.filename}
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
                  fontFamily: "'JetBrains Mono',monospace",
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
            );
          })}
        </div>
      )}
      {lightboxSrc && (
        <div
          onClick={() => setLightboxSrc(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.85)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
          }}
        >
          <img
            src={lightboxSrc}
            alt="Full size"
            style={{ maxWidth: "90vw", maxHeight: "90vh", borderRadius: 8 }}
          />
        </div>
      )}
    </div>
  );
}
