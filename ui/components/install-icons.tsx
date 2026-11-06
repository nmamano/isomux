// The icons of "Install as app" (ui/app-install.ts).

import { useI18n } from "../i18n.tsx";

export function InstallIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2v8M4.75 6.75 8 10l3.25-3.25" />
      <path d="M2.5 11v1.25c0 .97.78 1.75 1.75 1.75h7.5c.97 0 1.75-.78 1.75-1.75V11" />
    </svg>
  );
}

// The icons the iPhone install steps draw inside their sentence (rich()
// placeholders {share}, {more} and {add}), at the text size. SVG, not
// glyphs: iOS draws shape glyphs as emoji.
const inlineIcon = {
  "aria-hidden": true,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function inlineStyle(size: number | string) {
  return {
    color: "var(--accent-text)",
    ...(size === "1em" ? { verticalAlign: "-0.15em" } : {}),
  };
}

// The iPhone steps: one sentence with Share, ••• and Add to Home Screen
// drawn where the sentence names them.
export function InstallStepsText() {
  const { rich } = useI18n();
  return rich("appWidget.installSteps", {
    share: <ShareIcon />,
    more: <MoreIcon />,
    add: <AddToHomeIcon />,
  });
}

// Share, as Safari and Chrome draw it.
export function ShareIcon({ size = "1em" }: { size?: number | string }) {
  return (
    <svg
      {...inlineIcon}
      data-install-icon="share"
      width={size}
      height={size}
      strokeWidth="1.5"
      style={inlineStyle(size)}
    >
      <path d="M8 1.75v8.5M5.25 4.5 8 1.75l2.75 2.75" />
      <path d="M5.5 6.75H4.25c-.69 0-1.25.56-1.25 1.25v5c0 .69.56 1.25 1.25 1.25h7.5c.69 0 1.25-.56 1.25-1.25V8c0-.69-.56-1.25-1.25-1.25H10.5" />
    </svg>
  );
}

// Safari's Page Menu button (•••), which holds Share in its Compact layout.
export function MoreIcon({ size = "1em" }: { size?: number | string }) {
  return (
    <svg
      {...inlineIcon}
      data-install-icon="more"
      width={size}
      height={size}
      style={inlineStyle(size)}
    >
      <circle cx="3" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="13" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Add to Home Screen, as the iOS share sheet draws it.
export function AddToHomeIcon({ size = "1em" }: { size?: number | string }) {
  return (
    <svg
      {...inlineIcon}
      data-install-icon="add"
      width={size}
      height={size}
      strokeWidth="1.5"
      style={inlineStyle(size)}
    >
      <rect x="2" y="2" width="12" height="12" rx="3" />
      <path d="M8 5.25v5.5M5.25 8h5.5" />
    </svg>
  );
}

// The install popover's close control.
export function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
