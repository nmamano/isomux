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

import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type { AccessSettings } from "../../shared/contract-shapes.ts";
import { normalizePublicOrigin } from "../../shared/public-origin.ts";
import { dialogInput, dialogSaveBtn } from "./dialog-styles.ts";
import {
  MintedUrlBox,
  sectionHeader,
  subsectionHeader,
  subLabel,
  hint,
  cardStyle,
} from "./access-shared.tsx";

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
  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>Access</h4>
      <p style={hint}>
        Control whether this office is reachable from outside the host machine.
        Invite links and signed-in devices live in the Invites and Sessions
        sections.
      </p>
      <ExternalAccessSection closeRef={closeRef} />
    </div>
  );
}

function ExternalAccessSection({
  closeRef,
}: {
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [envOriginSet, setEnvOriginSet] = useState(false);
  // The normalized env value, or null when the env var is absent OR set but
  // invalid (in which case envOriginSet is true while envOrigin is null -
  // the UI uses that combination to flag the invalid case).
  const [envOrigin, setEnvOrigin] = useState<string | null>(null);
  const [boundLoopback, setBoundLoopback] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

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
        setEnabled(nextEnabled);
        setUrlInput(nextUrl);
        setEnvOriginSet(!!s.envOriginSet);
        setEnvOrigin(typeof s.envOrigin === "string" ? s.envOrigin : null);
        setBoundLoopback(!!s.boundLoopback);
        setSavedSnapshot({ enabled: nextEnabled, urlInput: nextUrl });
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
    // Save supersedes any in-flight discard prompt (the user picked Save
    // over Discard) - drop the stashed navigation so it can't replay.
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
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
        setSignInUrl(typeof r.signInUrl === "string" ? r.signInUrl : null);
        setRestartRequired(!!r.restartRequired);
      })
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : "Failed to update settings",
        );
      })
      .finally(() => setPending(false));
  }

  const dirty =
    enabled !== savedSnapshot.enabled ||
    urlInput.trim() !== savedSnapshot.urlInput;

  // Navigation-away dirty gate (see the closeRef prop docs). Dirty → show
  // the inline discard prompt and stash the navigation to run on Discard;
  // clean → navigate immediately. Cancel drops the stashed navigation so a
  // later Discard can't replay it.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
  // The prompt sits mid-pane (no sticky footer here) - scroll it into view
  // when it opens, so a header-back/ESC while scrolled elsewhere doesn't
  // look like a dead click.
  const discardPromptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (confirmDiscard)
      discardPromptRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirmDiscard]);
  function requestClose(after?: () => void) {
    if (loaded && dirty) {
      pendingDiscardActionRef.current = after ?? null;
      setConfirmDiscard(true);
    } else {
      after?.();
    }
  }
  function commitDiscard() {
    const next = pendingDiscardActionRef.current;
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
    // Reset to the saved snapshot: if the navigation re-renders this pane
    // (or is a no-op), the form shouldn't still show the discarded edits.
    setEnabled(savedSnapshot.enabled);
    setUrlInput(savedSnapshot.urlInput);
    next?.();
  }
  function cancelDiscard() {
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
  }
  // Mirror requestClose into the parent's ref every render so the captured
  // closure always sees fresh form state - same no-deps pattern as
  // UserSettingsView's UserEditPanel.
  useEffect(() => {
    if (closeRef) closeRef.current = requestClose;
    return () => {
      if (closeRef) closeRef.current = null;
    };
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

  // Apply the same normalization the server uses, so the env-conflict /
  // env-match notes don't flash a false warning when the operator types
  // an equivalent-but-unnormalized URL (e.g. with a trailing slash).
  // Returns null when the input doesn't parse as a valid public origin,
  // in which case neither the match nor the conflict note renders.
  const normalizedInput = normalizePublicOrigin(urlInput);

  if (!loaded) {
    return (
      <div style={cardStyle}>
        <h5 style={{ ...subsectionHeader, margin: "0 0 6px" }}>
          External access
        </h5>
        <p style={hint}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h5 style={{ ...subsectionHeader, margin: "0 0 6px" }}>
        External access
      </h5>
      <p style={hint}>
        Currently {boundLoopback ? "loopback-only" : "listening externally"}.
        {boundLoopback
          ? " The office is reachable from this machine, or from other machines via an SSH tunnel."
          : " The office is reachable from anywhere the public URL resolves."}
      </p>
      <label style={{ display: "flex", gap: 6, marginTop: 8, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enable external access</span>
      </label>
      {enabled && (
        <>
          <div style={subLabel}>Public URL</div>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://auntie.tailnet.ts.net"
            style={dialogInput}
          />
          <p style={hint}>
            Pattern: https://&lt;host&gt; (the address you'll open from your
            laptop / phone). Saving doesn't change the running server's bind on
            its own - restart isomux to apply.
          </p>
        </>
      )}
      {envOriginSet && !envOrigin && (
        <p style={{ ...hint, marginTop: 6, color: "var(--text-hint)" }}>
          Note: <code>ISOMUX_PUBLIC_ORIGIN</code> is set in the environment but
          not a valid public origin, so the server ignores it. Remove it from
          your env file or set it to <code>https://&lt;host&gt;</code>
          or <code>http://localhost</code>.
        </p>
      )}
      {envOrigin && enabled && normalizedInput === envOrigin && (
        <p style={{ ...hint, marginTop: 6, color: "var(--text-hint)" }}>
          Note: <code>ISOMUX_PUBLIC_ORIGIN={envOrigin}</code> is set in the
          environment and matches this Public URL. The env var is deprecated -
          remove it from your env file once this office-config value is saved.
        </p>
      )}
      {envOrigin &&
        enabled &&
        normalizedInput &&
        normalizedInput !== envOrigin && (
          <p style={{ ...hint, marginTop: 6, color: "var(--text-hint)" }}>
            Note: <code>ISOMUX_PUBLIC_ORIGIN={envOrigin}</code> is set in the
            environment. After restart it would override any different value
            saved here, so the save will be refused until you either match this
            URL to the env value or remove the env var from your service
            environment.
          </p>
        )}
      {error && (
        <p style={{ fontSize: 11, color: "#ff6b6b", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
      {confirmDiscard && (
        <div
          ref={discardPromptRef}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 10,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-base)",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>
            Discard unsaved external-access changes?
          </span>
          <button
            onClick={commitDiscard}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--red)",
              background: "var(--red)",
              color: "var(--bg-base)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Discard
          </button>
          <button
            onClick={cancelDiscard}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={submit}
          disabled={pending || !dirty}
          style={{
            ...dialogSaveBtn,
            opacity: pending || !dirty ? 0.5 : 1,
          }}
        >
          {pending ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      {restartRequired && (
        <div style={restartBoxStyle}>
          <p style={{ ...hint, marginTop: 0 }}>
            Saved. Restart isomux for the new bind to take effect. User service:{" "}
            <code>systemctl --user restart isomux</code>. System service:{" "}
            <code>sudo systemctl restart isomux</code>.
          </p>
          <code style={codeBlockStyle}>systemctl --user restart isomux</code>
          {signInUrl && (
            <>
              <p style={{ ...hint, marginTop: 10 }}>
                After the restart, open this URL on whichever device you want to
                use from the public address. (It expires 1 hour after minting.)
              </p>
              <MintedUrlBox url={signInUrl} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const restartBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  border: "1px solid var(--accent)",
  borderRadius: 6,
  background: "var(--bg-hover)",
};
const codeBlockStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: "4px 6px",
  borderRadius: 4,
  background: "var(--bg-code)",
  color: "var(--text-primary)",
  margin: "4px 0",
};
