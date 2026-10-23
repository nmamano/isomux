import { useEffect, type CSSProperties } from "react";
import { useI18n } from "../i18n.tsx";
import { Portal } from "../components/Portal.tsx";

// The chat's download control for attachments (image cards, file chips and the
// lightbox). The server keeps only a sanitized file name, so the link asks the
// file route for ?download=<original name>, which answers with
// Content-Disposition: attachment under that name. The download attribute
// says the same for browsers that honor it; both work on iOS.

export interface LightboxImage {
  src: string;
  name: string;
}

export function downloadHref(src: string, originalName: string): string {
  return `${src}?download=${encodeURIComponent(originalName)}`;
}

export function DownloadButton({
  src,
  name,
  isMobile,
  style,
}: {
  src: string;
  name: string;
  isMobile?: boolean;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const label = t("cards.fileView.download", { file: name });
  const size = isMobile ? 32 : 26;
  return (
    <a
      href={downloadHref(src, name)}
      download={name}
      aria-label={label}
      title={label}
      // Inside the lightbox a click would bubble to the backdrop and close it.
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: 6,
        background: "rgba(0,0,0,0.6)",
        color: "#fff",
        cursor: "pointer",
        ...style,
      }}
    >
      <svg
        width={isMobile ? 18 : 15}
        height={isMobile ? 18 : 15}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
      </svg>
    </a>
  );
}

// Full-size view of a chat image. A click on the backdrop or Escape closes it;
// the download button under the image does not. It renders in a portal on
// document.body: inside a side panel's stacking context, the office top bar
// painted over it.
export function ImageLightbox({
  image,
  isMobile,
  onClose,
}: {
  image: LightboxImage;
  isMobile?: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();

  // Capture-phase Escape so the global window handler in App.tsx (which navs
  // back to the room view) doesn't fire while the lightbox is open.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  return (
    <Portal>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "rgba(0,0,0,0.85)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          cursor: "zoom-out",
        }}
      >
        <img
          src={image.src}
          alt={t("cards.fileView.fullSize")}
          style={{
            maxWidth: "90vw",
            maxHeight: "calc(90vh - 52px)",
            borderRadius: 8,
          }}
        />
        <DownloadButton
          src={image.src}
          name={image.name}
          isMobile={isMobile}
          style={{
            width: 40,
            height: 40,
            background: "rgba(255,255,255,0.15)",
          }}
        />
      </div>
    </Portal>
  );
}
