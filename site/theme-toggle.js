// Shared theme toggle button. Loaded by site/index.html (landing) and the
// per-page docs site rendered by scripts/build-docs.ts.
//
// State lives in the `isomux-theme` localStorage key. When absent, the host
// page follows the OS `prefers-color-scheme` via @media in its own CSS.
// When present ("dark" | "light" | a registered app theme id like
// "solarized-light"), the `data-theme` attr on <html> overrides the media
// query (see the `:root[data-theme=...]` blocks in the host CSS).
//
// The same localStorage key is used by the embedded /demo iframe (the
// isomux app's ThemeProvider, ui/store.tsx). Both directions sync via the
// cross-window `storage` event: toggling on the landing updates the demo
// iframe live, and clicking the wall moon inside the demo flips the
// landing's palette back the same way.

(function () {
  const KEY = "isomux-theme";
  // App-side theme ids that resolve to the light mode. Keep in sync with
  // ui/themes.ts (light + solarized-light). Other ids default to dark.
  const LIGHT_IDS = ["light", "solarized-light"];

  function isLightId(id) {
    return LIGHT_IDS.indexOf(id) >= 0;
  }

  function getSaved() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function getSystemMode() {
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function currentMode() {
    const saved = getSaved();
    if (saved) return isLightId(saved) ? "light" : "dark";
    return getSystemMode();
  }

  function applyAttrs() {
    const saved = getSaved();
    const root = document.documentElement;
    if (saved) {
      root.setAttribute("data-theme", saved);
      root.setAttribute("data-theme-mode", isLightId(saved) ? "light" : "dark");
    } else {
      root.removeAttribute("data-theme");
      root.removeAttribute("data-theme-mode");
    }
  }

  const SUN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
  const MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

  // Button shows the icon of the mode you'd switch TO (GitHub convention):
  // in dark mode show the sun, in light mode show the moon.
  function updateButton(btn) {
    const mode = currentMode();
    const next = mode === "light" ? "dark" : "light";
    btn.setAttribute("aria-label", `Switch to ${next} mode`);
    btn.setAttribute("title", `Switch to ${next} mode`);
    btn.innerHTML = mode === "light" ? MOON_SVG : SUN_SVG;
  }

  function toggle() {
    const next = currentMode() === "light" ? "dark" : "light";
    try {
      localStorage.setItem(KEY, next);
    } catch (e) {}
    applyAttrs();
    updateButton(btn);
  }

  // Mount: inside `.topbar-inner` on docs pages (next to the existing
  // top-bar links), or fixed top-right on the landing.
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-toggle";
  btn.addEventListener("click", toggle);

  const topbar = document.querySelector(".topbar-inner");
  if (topbar) {
    btn.classList.add("theme-toggle--inline");
    topbar.appendChild(btn);
  } else {
    document.body.appendChild(btn);
  }
  updateButton(btn);

  // Cross-window sync. Fires when another window on the same origin
  // (e.g. the embedded /demo iframe writing via React ThemeProvider, or
  // another open tab) changes our key.
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY && e.key !== null) return;
    applyAttrs();
    updateButton(btn);
  });
})();
