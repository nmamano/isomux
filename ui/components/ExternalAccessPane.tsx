// Owner-only "Access" section: where can people reach this office from?
// Mounts on the Settings page (UserSettingsView) when the current
// session's role is "owner". The other panes from the old all-in-one
// "Access & invites" section are InvitesPane and SessionsPane.
//
// Pre-claim or with external access disabled, isomux binds 127.0.0.1 only and
// the office is reachable only from the host machine (or via an SSH tunnel).
// Flipping the toggle and saving stores the new state plus the public URL,
// mints an owner self-invite bound to the NEW origin (the running process
// still has the old bind in place, so this URL won't resolve until restart),
// and prompts the operator to restart isomux. The restart is intentional:
// changing the bind interface and cookie/origin policy mid-process is
// brittle, and the toggle is rare enough that "save then restart" is the
// right trade.

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type { AccessSettings } from "../../shared/contract-shapes.ts";
import { useI18n } from "../i18n.tsx";
import { useUnsavedChangesPrompt } from "./UnsavedChangesPrompt.tsx";
import { dialogInput } from "./dialog-styles.ts";
import { SettingsFormLayout, SettingsSaveFooter } from "./SettingsItemPage.tsx";
import {
  MintedUrlBox,
  sectionHeader,
  subsectionHeader,
  subLabel,
  hint,
  cardStyle,
} from "./access-shared.tsx";
import {
  getExternalAccessLayout,
  setExternalAccessLayout,
} from "../device-settings.ts";

const ORIGIN_PATTERN = "https://<host>";

export function ExternalAccessPane({
  closeRef,
}: {
  // Registered by the External access card (the one sub-form here with
  // unsaved state). The parent page calls `closeRef.current(after?)` before
  // navigating away; the card gates on its own "Discard unsaved changes?"
  // prompt and runs `after` once the close is committed. Same contract as
  // UserSettingsView's UserEditPanel.
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  return <ExternalAccessSection closeRef={closeRef} />;
}

// The section's heading over its card, laid out with its footer (none on
// Hosted, where the access is managed).
function AccessLayout({
  footer,
  children,
}: {
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <SettingsFormLayout footer={footer}>
      <div style={{ marginTop: 24 }}>
        <h4 style={sectionHeader}>{t("settings.sidebar.access")}</h4>
        {children}
      </div>
    </SettingsFormLayout>
  );
}

function ExternalAccessSection({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { t, rich } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [hosted, setHosted] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [boundLoopback, setBoundLoopback] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  // "Saved" shows only after this pane's own save, as on the Office pane.
  const [savedHere, setSavedHere] = useState(false);
  // While the settings load, the card shows the form it showed last on this
  // device with nothing to act on, so it keeps its height when they arrive.
  const [held] = useState(getExternalAccessLayout);

  // Snapshot of the last-saved state. Compared against the form during
  // render to drive the Save-button enabled/disabled state, so kept as
  // state rather than a ref.
  const [savedSnapshot, setSavedSnapshot] = useState<{
    enabled: boolean;
    urlInput: string;
  }>({ enabled: false, urlInput: "" });

  useEffect(() => {
    let cancelled = false;
    apiFetch<AccessSettings>("GET", "/api/office/access")
      .then((s) => {
        if (cancelled) return;
        const nextEnabled = !!s.externalAccess;
        const nextUrl =
          typeof s.publicOrigin === "string" ? s.publicOrigin : "";
        setHosted(s.hosted);
        setEnabled(nextEnabled);
        setUrlInput(nextUrl);
        setBoundLoopback(!!s.boundLoopback);
        setSavedSnapshot({ enabled: nextEnabled, urlInput: nextUrl });
        setExternalAccessLayout({ hosted: s.hosted, enabled: nextEnabled });
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function submit() {
    const nextEnabled = enabled;
    const nextUrl = nextEnabled ? urlInput.trim() : "";
    setPending(true);
    setError(null);
    setSignInUrl(null);
    setRestartRequired(false);
    apiFetch<{ signInUrl: string | null; restartRequired: boolean }>(
      "PUT",
      "/api/office/access",
      { externalAccess: nextEnabled, publicOrigin: nextUrl },
    )
      .then((r) => {
        setEnabled(nextEnabled);
        setUrlInput(nextUrl);
        setSavedSnapshot({ enabled: nextEnabled, urlInput: nextUrl });
        setExternalAccessLayout({ hosted, enabled: nextEnabled });
        setSignInUrl(typeof r.signInUrl === "string" ? r.signInUrl : null);
        setRestartRequired(!!r.restartRequired);
        setSavedHere(true);
      })
      .catch((err) => {
        setError(
          err instanceof ApiError
            ? err.message
            : t("settings.externalAccess.updateFailed"),
        );
      })
      .finally(() => setPending(false));
  }

  const dirty =
    enabled !== savedSnapshot.enabled ||
    urlInput.trim() !== savedSnapshot.urlInput;

  // Navigation-away dirty gate (see the closeRef prop docs). Dirty → show
  // the inline discard prompt and stash the navigation to run on Discard, or
  // when a save in flight finishes; clean → navigate immediately.
  const discardPrompt = useUnsavedChangesPrompt(loaded && dirty, {
    closeRef,
    // Reset to the saved snapshot: if the navigation re-renders this pane
    // (or is a no-op), the form shouldn't still show the discarded edits.
    onDiscard: () => {
      setEnabled(savedSnapshot.enabled);
      setUrlInput(savedSnapshot.urlInput);
    },
  });
  // Tab-close guard while dirty: in-app navigation already routes through
  // the discard prompt, but closing/reloading the tab was the one silent
  // loss path. No deps - the
  // handler must see the current `dirty` each render.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!loaded || !dirty) return;
      e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  });

  if (loaded ? hosted : held.hosted) {
    return (
      <AccessLayout footer={null}>
        <div style={cardStyle} aria-busy={!loaded}>
          <div style={subLabel}>{t("settings.externalAccess.publicUrl")}</div>
          <p>
            {loaded ? (
              urlInput
            ) : (
              <span style={hint}>{t("common.loading")}</span>
            )}
          </p>
          <p style={hint}>{t("settings.externalAccess.managed")}</p>
        </div>
      </AccessLayout>
    );
  }

  const showUrl = loaded ? enabled : held.enabled;
  // Held: a blank line in its place.
  const reachLine = (
    <p style={hint}>
      {!loaded
        ? "\u00a0"
        : boundLoopback
          ? t("settings.externalAccess.loopback")
          : t("settings.externalAccess.external")}
    </p>
  );
  return (
    <AccessLayout
      footer={
        <SettingsSaveFooter
          error={error}
          prompt={discardPrompt}
          dirty={loaded && dirty}
          saving={pending}
          saved={savedHere}
          canSave={loaded}
          onCancel={() => {
            setEnabled(savedSnapshot.enabled);
            setUrlInput(savedSnapshot.urlInput);
            setError(null);
          }}
          onSave={submit}
        />
      }
    >
      <div style={cardStyle} aria-busy={!loaded}>
        <p style={hint}>{t("settings.externalAccess.intro")}</p>
        <h5 style={{ ...subsectionHeader, margin: "0 0 6px" }}>
          {t("settings.externalAccess.title")}
        </h5>
        {reachLine}
        <label style={{ display: "flex", gap: 6, marginTop: 8, fontSize: 12 }}>
          <input
            type="checkbox"
            // Unknown until the settings arrive: never a real "off".
            ref={(box) => {
              if (box) box.indeterminate = !loaded;
            }}
            disabled={!loaded}
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>{t("settings.externalAccess.enable")}</span>
        </label>
        {showUrl && (
          <>
            <div style={subLabel}>{t("settings.externalAccess.publicUrl")}</div>
            <input
              value={urlInput}
              disabled={!loaded}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder={loaded ? "https://office.example.com" : undefined}
              style={dialogInput}
            />
            <p style={hint}>
              {t("settings.externalAccess.urlHint", {
                pattern: ORIGIN_PATTERN,
              })}
            </p>
          </>
        )}
        {restartRequired && (
          <div style={restartBoxStyle}>
            <p style={{ ...hint, marginTop: 0 }}>
              {rich("settings.externalAccess.restartNote", {
                code: (chunk) => <code>{chunk}</code>,
              })}
            </p>
            {signInUrl && (
              <>
                <p style={{ ...hint, marginTop: 10 }}>
                  {t("settings.externalAccess.signInAfterRestart")}
                </p>
                <MintedUrlBox url={signInUrl} forSelf />
              </>
            )}
          </div>
        )}
      </div>
    </AccessLayout>
  );
}

const restartBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  border: "1px solid var(--accent)",
  borderRadius: 6,
  background: "var(--bg-hover)",
};
