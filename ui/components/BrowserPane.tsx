import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import { useI18n } from "../i18n";
import type { MemberBrowserStatus } from "../../shared/browser-extension-protocol";
import { sectionHeader, hint, cardStyle } from "./access-shared";
import { dialogCancelBtn, dialogInput, dialogLabel } from "./dialog-styles";

// Chrome refuses to open chrome:// pages from a web page link or
// window.open, so members copy the address into the address bar.
const EXTENSIONS_PAGE = "chrome://extensions";

export function BrowserPane() {
  const { t, rich } = useI18n();
  const [status, setStatus] = useState<MemberBrowserStatus>();
  const [pair, setPair] = useState<{ code: string; expiresAt: number }>();
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const mounted = useRef(false),
    serial = useRef(0);
  async function refresh() {
    const request = ++serial.current;
    try {
      const next = await apiFetch<MemberBrowserStatus>(
        "GET",
        "/api/me/browser",
      );
      if (mounted.current && request === serial.current) {
        setStatus(next);
        setError(false);
      }
    } catch {
      if (mounted.current && request === serial.current) {
        setStatus(undefined);
        setError(true);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  async function change(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) {
    setBusy(true);
    setError(false);
    setCopied(false);
    setRevealed(false);
    try {
      const result = await apiFetch<{ code: string; expiresAt: number }>(
        method,
        path,
        body,
      );
      if (!mounted.current) return;
      if (method === "POST") {
        setPair(result);
        setName("");
      }
      await refresh();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const [revealed, setRevealed] = useState(false);
  const [officeCopied, setOfficeCopied] = useState(false);
  const [extensionsCopied, setExtensionsCopied] = useState(false);
  const [name, setName] = useState("");
  const expired = !!pair && now >= pair.expiresAt;
  return (
    <section
      data-testid="browser-settings"
      style={{ marginTop: 24, fontSize: 12, lineHeight: 1.6 }}
    >
      <h4 style={sectionHeader}>{t("browser.title")}</h4>
      <p style={hint}>{t("browser.intro")}</p>
      {error && <p role="alert">{t("browser.failed")}</p>}
      {status ? (
        <>
          <p style={hint}>{t("browser.chromeHelp")}</p>
          <div style={{ ...cardStyle, marginTop: 16 }}>
            <h4 style={{ ...sectionHeader, marginBottom: 8 }}>
              {t("browser.setup")}
            </h4>
            <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
              <li>
                <a
                  style={{ color: "var(--accent-text)" }}
                  href="/api/me/browser/extension.zip"
                  download="isomux-browser.zip"
                >
                  {t("browser.download", { version: status.version })}
                </a>
              </li>
              <li>{t("browser.extract")}</li>
              <li>
                {rich("browser.extensions", {
                  address: (
                    <>
                      <code>{EXTENSIONS_PAGE}</code>{" "}
                      <button
                        data-testid="browser-extensions-copy"
                        style={{ ...dialogCancelBtn, padding: "2px 8px" }}
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(EXTENSIONS_PAGE)
                            .then(
                              () => setExtensionsCopied(true),
                              () => setError(true),
                            );
                        }}
                      >
                        {t(extensionsCopied ? "browser.copied" : "common.copy")}
                      </button>
                    </>
                  ),
                })}
              </li>
              <li>{t("browser.load")}</li>
              <li>{t("browser.pin")}</li>
              <li>{t("browser.finish")}</li>
              <li>{t("browser.offerHelp")}</li>
            </ol>
            <p style={{ ...hint, marginTop: 16, marginBottom: 0 }}>
              {t("browser.permission")}
            </p>
          </div>
          <div style={{ ...cardStyle, marginTop: 16 }}>
            <h4 style={sectionHeader}>{t("browser.connection")}</h4>
            <p style={hint}>
              {t("browser.owner", { name: status.member.name })}
            </p>
            <ul
              role="status"
              data-testid="browser-state"
              data-online={status.online}
              data-paired={status.paired}
              style={{
                margin: "16px 0",
                padding: 0,
                listStyle: "none",
                display: "grid",
                gap: 8,
                color: "var(--text-secondary)",
              }}
            >
              {status.browsers.length === 0 && <li>{t("browser.unpaired")}</li>}
              {status.browsers.map((b) => (
                <li
                  key={b.id}
                  data-testid="browser-row"
                  data-online={b.online}
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ color: "var(--text-primary)" }}>
                      {b.name}
                    </strong>{" "}
                    · {t(b.online ? "browser.connected" : "browser.offline")}
                    {b.pairedAt !== null && (
                      <>
                        {" "}
                        ·{" "}
                        {t("browser.pairedOn", {
                          date: new Date(b.pairedAt).toLocaleDateString(),
                        })}
                      </>
                    )}
                  </span>
                  <button
                    data-testid="browser-revoke"
                    style={dialogCancelBtn}
                    disabled={busy}
                    onClick={() =>
                      void change(
                        "DELETE",
                        `/api/me/browser/browsers/${encodeURIComponent(b.id)}`,
                      )
                    }
                  >
                    {t("browser.unpair")}
                  </button>
                </li>
              ))}
            </ul>
            <label style={dialogLabel} htmlFor="browser-office">
              {t("browser.office")}
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                id="browser-office"
                style={{ ...dialogInput, minWidth: 0 }}
                readOnly
                value={window.location.origin}
              />
              <button
                style={dialogCancelBtn}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(window.location.origin)
                    .then(
                      () => setOfficeCopied(true),
                      () => setError(true),
                    );
                }}
              >
                {t(officeCopied ? "browser.copied" : "common.copy")}
              </button>
            </div>
            <label style={dialogLabel} htmlFor="browser-name">
              {t("browser.name")}
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="browser-name"
                data-testid="browser-name"
                style={{ ...dialogInput, minWidth: 0 }}
                maxLength={40}
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button
                data-testid="browser-pair"
                style={dialogCancelBtn}
                disabled={busy}
                onClick={() =>
                  void change("POST", "/api/me/browser/pair", { name })
                }
              >
                {t("browser.generate")}
              </button>
            </div>
            <p style={hint}>{t("browser.nameHint")}</p>
            {pair && (
              <div style={{ marginTop: 16 }}>
                <p style={hint}>{t("browser.pairHelp")}</p>
                <label style={dialogLabel} htmlFor="browser-code">
                  {t("browser.code")}
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    id="browser-code"
                    data-testid="browser-code"
                    style={{ ...dialogInput, minWidth: 0 }}
                    type={revealed ? "text" : "password"}
                    autoComplete="off"
                    readOnly
                    value={expired ? "" : pair.code}
                  />
                  <button
                    style={dialogCancelBtn}
                    disabled={expired}
                    aria-pressed={revealed}
                    onClick={() => setRevealed(!revealed)}
                  >
                    {t(revealed ? "browser.hide" : "browser.show")}
                  </button>
                  <button
                    style={dialogCancelBtn}
                    disabled={expired}
                    onClick={() => {
                      void navigator.clipboard.writeText(pair.code).then(
                        () => setCopied(true),
                        () => setError(true),
                      );
                    }}
                  >
                    {t(copied ? "browser.copied" : "common.copy")}
                  </button>
                </div>
                <p style={hint}>
                  {expired
                    ? t("browser.expired")
                    : t("browser.expires", {
                        time: new Date(pair.expiresAt).toLocaleTimeString(),
                      })}
                </p>
              </div>
            )}
          </div>
          <p style={hint}>{t("browser.retained")}</p>
        </>
      ) : (
        !error && <p style={hint}>{t("common.loading")}</p>
      )}
    </section>
  );
}
