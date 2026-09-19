import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import { useI18n } from "../i18n";
import type { MemberBrowserStatus } from "../../shared/browser-extension-protocol";
import { sectionHeader, hint, cardStyle } from "./access-shared";
import { dialogCancelBtn, dialogInput } from "./dialog-styles";

export function BrowserPane() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MemberBrowserStatus>();
  const [pair, setPair] = useState<{ code: string; expiresAt: number }>();
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(false), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const mounted = useRef(false), serial = useRef(0);
  async function refresh() {
    const request = ++serial.current;
    try {
      const next = await apiFetch<MemberBrowserStatus>("GET", "/api/me/browser");
      if (mounted.current && request === serial.current) { setStatus(next); setError(false); }
    } catch { if (mounted.current && request === serial.current) { setStatus(undefined); setError(true); } }
  }
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 2000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  async function change(method: "PATCH" | "POST" | "DELETE", body?: unknown) {
    setBusy(true); setError(false); setCopied(false);
    try {
      const result = await apiFetch<{ code: string; expiresAt: number }>(method, `/api/me/browser${method === "POST" ? "/pair" : ""}`, body);
      if (!mounted.current) return;
      setPair(method === "POST" ? result : undefined);
      await refresh();
    } catch { if (mounted.current) setError(true); }
    finally { if (mounted.current) setBusy(false); }
  }
  const expired = !!pair && now >= pair.expiresAt;
  return <section data-testid="browser-settings" style={{ marginTop: 24 }}>
    <h4 style={sectionHeader}>{t("browser.title")}</h4>
    <p style={hint}>{t("browser.ownership")}</p>
    {error && <p role="alert">{t("browser.failed")}</p>}
    {status ? <>
      <p>{t("browser.owner", { name: status.member.name })}</p>
      <div style={cardStyle}>
        {status.selectionRequired && <p role="status">{t("browser.choose")}</p>}
        <label>
          {t("browser.title")}{" "}
          <select data-testid="browser-backend" value={status.backend ?? ""} disabled={busy} onChange={event => void change("PATCH", { backend: event.target.value })} style={dialogInput}>
            <option value="" disabled>{t("browser.choose")}</option>
            <option value="headless">{t("browser.server")}</option>
            <option value="extension">{t("browser.chrome")}</option>
          </select>
        </label>
        <p role="status" data-testid="browser-state" data-online={status.online} data-paired={status.paired}>
          {t(status.paired ? "browser.paired" : "browser.unpaired")} · {t(status.online ? "browser.connected" : "browser.offline")}
        </p>
      </div>
      <div style={cardStyle}>
        <a href="/api/me/browser/extension.zip" download="isomux-browser.zip">{t("browser.download", { version: status.version })}</a>
        <p style={hint}>{t("browser.install")}</p>
        <p style={hint}>{t("browser.permission")}</p>
        <button data-testid="browser-pair" style={dialogCancelBtn} disabled={busy || status.selectionRequired} onClick={() => void change("POST", { replace: status.paired })}>
          {t(status.paired ? "browser.replace" : "browser.generate")}
        </button>{" "}
        {status.paired && <button data-testid="browser-revoke" style={dialogCancelBtn} disabled={busy} onClick={() => void change("DELETE")}>{t("browser.unpair")}</button>}
        {status.paired && <p style={hint}>{t("browser.replaceHint")}</p>}
        {pair && <div>
          <p>{t("browser.pairHelp")}</p>
          <p><code>{window.location.origin}</code></p>
          <label>{t("browser.code")}<input data-testid="browser-code" style={dialogInput} readOnly value={expired ? "" : pair.code} /></label>
          <p>{expired ? t("browser.expired") : t("browser.expires", { time: new Date(pair.expiresAt).toLocaleTimeString() })}</p>
          <button style={dialogCancelBtn} disabled={expired} onClick={() => {
            void navigator.clipboard.writeText(pair.code).then(() => setCopied(true), () => setError(true));
          }}>{t(copied ? "browser.copied" : "browser.copy")}</button>
        </div>}
      </div>
      <p style={hint}>{t("browser.retained")}</p>
    </> : !error && <p>{t("common.loading")}</p>}
  </section>;
}
