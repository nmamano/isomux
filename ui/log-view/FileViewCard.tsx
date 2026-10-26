import { useState } from "react";
import type { Attachment } from "../../shared/types.ts";
import { useI18n } from "../i18n.tsx";
import { formatBytes } from "../../shared/i18n/number.ts";
import {
  DownloadButton,
  ImageLightbox,
  type LightboxImage,
} from "./attachment-download.tsx";

// Card emitted by POST /api/agents/:id/read-file and /preview-url, and the
// read files of an ask card. Images render inline (clickable for lightbox);
// video and audio play inline, with the file chip under the player; other
// media types render as a clickable file chip via the same
// /api/files/<agentId>/<filename> route used by uploaded attachments. Each
// image and chip has a download button. `caption`
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
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const images = attachments.filter((a) => a.mediaType.startsWith("image/"));
  const media = attachments.filter(isPlayable);
  const files = attachments.filter(
    (a) => !a.mediaType.startsWith("image/") && !isPlayable(a),
  );

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
      {media.map((att, i) => {
        const src = `/api/files/${agentId}/${att.filename}`;
        return (
          <div
            key={att.filename}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 6,
              marginTop: images.length > 0 || i > 0 ? 8 : 0,
            }}
          >
            {att.mediaType.startsWith("video/") ? (
              <video
                // The fragment makes iOS paint the first frame instead of an
                // empty box; it is not sent to the server.
                src={`${src}#t=0.001`}
                controls
                playsInline
                preload="metadata"
                style={{
                  display: "block",
                  maxWidth: isMobile ? "100%" : 360,
                  maxHeight: isMobile ? "70vh" : 360,
                  borderRadius: 4,
                  border: "1px solid var(--green-border)",
                  background: "#000",
                }}
              />
            ) : (
              <audio
                src={src}
                controls
                preload="metadata"
                style={{ display: "block", maxWidth: "100%" }}
              />
            )}
            <FileChip att={att} src={src} isMobile={isMobile} />
          </div>
        );
      })}
      {files.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: images.length > 0 || media.length > 0 ? 8 : 0,
          }}
        >
          {files.map((att) => (
            <FileChip
              key={att.filename}
              att={att}
              src={`/api/files/${agentId}/${att.filename}`}
              isMobile={isMobile}
            />
          ))}
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

function isPlayable(att: Attachment): boolean {
  return (
    att.mediaType.startsWith("video/") || att.mediaType.startsWith("audio/")
  );
}

function FileChip({
  att,
  src,
  isMobile,
}: {
  att: Attachment;
  src: string;
  isMobile?: boolean;
}) {
  const i18n = useI18n();
  const sizeStr =
    formatBytes(i18n.language, att.size) ?? i18n.t("common.unknownSize");
  return (
    <span
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
}
