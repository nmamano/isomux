// The icons of "Install as app" (ui/app-install.ts).

export function InstallIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
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

// Safari's Share icon, drawn: iOS draws shape glyphs as emoji.
export function ShareIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 1.75v8.5M5.25 4.5 8 1.75l2.75 2.75" />
      <path d="M5.5 6.75H4.25c-.69 0-1.25.56-1.25 1.25v5c0 .69.56 1.25 1.25 1.25h7.5c.69 0 1.25-.56 1.25-1.25V8c0-.69-.56-1.25-1.25-1.25H10.5" />
    </svg>
  );
}
