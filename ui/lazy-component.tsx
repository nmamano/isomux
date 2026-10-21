// A component whose module loads only when it first mounts, so heavy panels
// (terminal, editor, diff) stay out of the first bundle. Renders nothing while
// the chunk loads. When the load fails it shows a short line and a Reload
// button: a chunk that is gone after an update comes back only with a new
// index.js. React.lazy would instead unmount the whole app, since no error
// boundary sits above these panels.

import { createElement, useEffect, useState, type ComponentType } from "react";
import { useI18n } from "./i18n.tsx";
import { cardActionBtn } from "./components/dialog-styles.ts";

export function lazyComponent<P>(
  load: () => Promise<ComponentType<P>>,
  opts: { reload?: () => void } = {},
): ComponentType<P> {
  const reload = opts.reload ?? (() => location.reload());
  let loaded: ComponentType<P> | null = null;
  let failed = false;
  // One load for every mount.
  let pending: Promise<void> | null = null;
  const start = () =>
    (pending ??= load().then(
      (component) => {
        loaded = component;
      },
      (err) => {
        console.error("[lazy] module load failed:", err);
        failed = true;
      },
    ));

  function Lazy(props: P) {
    const { t } = useI18n();
    const [, settled] = useState(0);
    useEffect(() => {
      if (loaded || failed) return;
      let live = true;
      void start().then(() => {
        if (live) settled((n) => n + 1);
      });
      return () => {
        live = false;
      };
    }, []);

    // P is unconstrained, which createElement does not accept; the props are
    // the loaded component's own.
    if (loaded) {
      return createElement(
        loaded as ComponentType<Record<string, unknown>>,
        props as Record<string, unknown>,
      );
    }
    if (!failed) return null;
    return (
      <div
        style={{
          padding: 12,
          fontSize: 12,
          color: "var(--text-muted)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>{t("lazyPanel.loadFailed")}</span>
        <button type="button" onClick={reload} style={cardActionBtn}>
          {t("lazyPanel.reload")}
        </button>
      </div>
    );
  }
  return Lazy;
}
