import { useEffect, useRef, useState, type MouseEvent } from "react";
import { apiFetch } from "../api";
import { useI18n } from "../i18n";
import type { MemberBrowserStatus } from "../../shared/browser-extension-protocol";
import { sectionHeader, hint, cardStyle, codeStyle } from "./access-shared";
import {
  dialogInput,
  dialogLabel,
  dialogSaveBtn,
  disabledLook,
  filledSecondaryBtn,
} from "./dialog-styles";
import { guessBrowserName } from "../browser-name";
import { homeScreenDownload } from "../home-screen-download";

// Chrome refuses to open chrome:// pages from a web page link or
// window.open, so members copy the address into the address bar.
const EXTENSIONS_PAGE = "chrome://extensions";
const EXTENSION_ZIP = "/api/me/browser/extension.zip";
const EXTENSION_ZIP_NAME = "isomux-browser.zip";

function downloadExtension(e: MouseEvent) {
  homeScreenDownload(e, EXTENSION_ZIP, EXTENSION_ZIP_NAME);
}

// The main action of each step is the primary button; a download link looks
// like one too.
const primaryLink = {
  ...dialogSaveBtn,
  display: "inline-block",
  textDecoration: "none",
};
const primary = (disabled: boolean) => ({
  ...dialogSaveBtn,
  ...(disabled ? disabledLook : null),
});
const secondary = (disabled: boolean) => ({
  ...filledSecondaryBtn,
  ...(disabled ? disabledLook : null),
});

export function BrowserPane() {
  const { t, rich, language } = useI18n();
  // Prefilled from the browser the member is on, for example Chrome on
  // Windows; empty when that is not a browser to pair.
  const defaultName = () => {
    const guess = guessBrowserName(
      navigator.userAgent,
      navigator.platform,
      navigator.maxTouchPoints ?? 0,
    );
    return guess ? t("browser.defaultName", guess) : "";
  };
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
        setName(defaultName());
      }
      await refresh();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  // Asks the browser to load the newer extension files; the poll shows it
  // reconnect with the new version.
  async function reload(id: string) {
    setBusy(true);
    setError(false);
    try {
      await apiFetch(
        "POST",
        `/api/me/browser/browsers/${encodeURIComponent(id)}/reload`,
      );
      if (mounted.current) await refresh();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const [revealed, setRevealed] = useState(false);
  const [officeCopied, setOfficeCopied] = useState(false);
  const [extensionsCopied, setExtensionsCopied] = useState(false);
  const [name, setName] = useState(defaultName);
  const expired = !!pair && now >= pair.expiresAt;
  const outdated = status?.browsers.filter((b) => b.outdated) ?? [];
  const reloadable = status?.browsers.filter((b) => b.reloadable) ?? [];
  // Every out-of-date browser has the new files in place: only Reload is left.
  const filesInPlace =
    reloadable.length > 0 &&
    outdated.every((b) => reloadable.some((r) => r.id === b.id));
  return (
    // The Integrations Browser Use tab shows the title and intro above this.
    <section
      data-testid="browser-settings"
      style={{ fontSize: 12, lineHeight: 1.6 }}
    >
      {error && <p role="alert">{t("browser.failed")}</p>}
      {status ? (
        <>
          <p style={hint}>{t("browser.chromeHelp")}</p>
          {outdated.length > 0 && (
            <div
              role="status"
              data-testid="browser-update"
              style={{ ...cardStyle, marginTop: 16 }}
            >
              <p style={{ margin: 0 }}>
                {t("browser.outdated", {
                  names: outdated.map((b) => b.name).join(", "),
                })}
              </p>
              {!filesInPlace && (
                <>
                  <a
                    style={{ ...primaryLink, marginTop: 8 }}
                    href={EXTENSION_ZIP}
                    download={EXTENSION_ZIP_NAME}
                    onClick={downloadExtension}
                  >
                    {t("browser.download", { version: status.version })}
                  </a>
                  <p style={{ ...hint, marginBottom: 0 }}>
                    {t("browser.updateSteps")}
                  </p>
                </>
              )}
              {reloadable.length > 0 && (
                <>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    {reloadable.map((b) => (
                      <button
                        key={b.id}
                        data-testid="browser-reload"
                        style={secondary(busy)}
                        disabled={busy}
                        onClick={() => void reload(b.id)}
                      >
                        {t("browser.reloadBrowser", { name: b.name })}
                      </button>
                    ))}
                  </div>
                  <p style={{ ...hint, marginBottom: 0 }}>
                    {t("browser.reloadNote")}
                  </p>
                </>
              )}
            </div>
          )}
          <div style={{ ...cardStyle, marginTop: 16 }}>
            <h4 style={{ ...sectionHeader, marginBottom: 8 }}>
              {t("browser.setup")}
            </h4>
            <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
              <li>
                <a
                  style={primaryLink}
                  href={EXTENSION_ZIP}
                  download={EXTENSION_ZIP_NAME}
                  onClick={downloadExtension}
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
                        style={filledSecondaryBtn}
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(EXTENSIONS_PAGE)
                            .then(
                              () => setExtensionsCopied(true),
                              () => setError(true),
                            );
                        }}
                      >
                        {t(extensionsCopied ? "common.copied" : "common.copy")}
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
                    {b.agentTabs && (
                      <span data-testid="browser-agent-tabs">
                        {" "}
                        ·{" "}
                        {t("browser.agentTabsSetting", {
                          scope:
                            b.agentTabs === "members"
                              ? t("browser.myAgentsAnd", {
                                  members: new Intl.ListFormat(language, {
                                    type: "conjunction",
                                  }).format(
                                    (b.members ?? []).map((m) => m.name),
                                  ),
                                })
                              : t(
                                  b.agentTabs === "office"
                                    ? "browser.allAgents"
                                    : "browser.myAgents",
                                ),
                        })}
                      </span>
                    )}
                  </span>
                  <button
                    data-testid="browser-revoke"
                    style={secondary(busy)}
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
            <div style={dialogLabel}>{t("browser.office")}</div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <code data-testid="browser-office" style={codeStyle}>
                {window.location.origin}
              </code>
              <button
                style={{ ...filledSecondaryBtn, flexShrink: 0 }}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(window.location.origin)
                    .then(
                      () => setOfficeCopied(true),
                      () => setError(true),
                    );
                }}
              >
                {t(officeCopied ? "common.copied" : "common.copy")}
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
                style={{ ...primary(busy), flexShrink: 0 }}
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
                    style={{ ...secondary(expired), flexShrink: 0 }}
                    disabled={expired}
                    aria-pressed={revealed}
                    onClick={() => setRevealed(!revealed)}
                  >
                    {t(revealed ? "browser.hide" : "browser.show")}
                  </button>
                  <button
                    style={{ ...primary(expired), flexShrink: 0 }}
                    disabled={expired}
                    onClick={() => {
                      void navigator.clipboard.writeText(pair.code).then(
                        () => setCopied(true),
                        () => setError(true),
                      );
                    }}
                  >
                    {t(copied ? "common.copied" : "common.copy")}
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
