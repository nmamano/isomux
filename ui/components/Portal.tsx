import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Mount-detection: render null on the first pass (SSR / pre-mount) and
    // flip to true once we're in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
