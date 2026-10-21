import { useEffect, useRef, useState, type CSSProperties } from "react";
import { apiFetch, ApiError } from "../api.ts";
import type {
  EnvVariableSource,
  ProviderAccountProvider,
  ProviderAccountScope,
  ProviderAccountWire,
  ProviderAccountsWire,
  ProviderLoginQueueWire,
  ProviderLoginStartRes,
} from "../../shared/types.ts";
import { cardStyle, hint, SettingsLink } from "./access-shared.tsx";
import { dialogCancelBtn, dialogSaveBtn } from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";
import type { Translator } from "../../shared/i18n/translate.ts";
import { ProviderMark } from "./ProviderMark.tsx";
import { Reserved } from "./Reserved.tsx";
import { BuildingIcon, PersonIcon } from "./NavIcons.tsx";
import { Data, HelpTip } from "../integrations/kit.tsx";

// Not a component (it labels a button inside one), so it takes the translator
// rather than reaching for the hook.
export function signOutButtonLabel(i18n: Translator, pending: boolean): string {
  return pending
    ? i18n.t("settings.signIn.signingOut")
    : i18n.t("settings.signIn.confirmSignOut");
}

export function sharedLoginQueueMessage(
  i18n: Translator,
  provider: string,
  queue: ProviderLoginQueueWire,
  now = Date.now(),
): string {
  const minutes = Math.floor(Math.max(0, now - queue.startedAt) / 60_000);
  return minutes < 1
    ? i18n.t("settings.signIn.queueHeldUnderMinute", {
        name: queue.holderName,
        provider,
      })
    : i18n.tn("settings.signIn.queueHeldMinutes", minutes, {
        name: queue.holderName,
        provider,
      });
}

// `scopes` picks which of the two sign-in scopes this card shows. The
// Integrations page renders one scope per card (office sign-ins on the
// Office-wide card, the viewer's own on the Personal card), while the log
// view's inline card still shows both, so the default stays the full pair.
export function ProviderSignInCard({
  provider,
  accounts,
  loaded = accounts.length > 0,
  canCancelSharedLogin = false,
  canChangeOffice = false,
  onAccounts,
  onStartNewConversation,
  showTitle = true,
  apiKeyNote = false,
  scopes = ["office", "personal"],
  onGoToOtherHalf,
  style,
  pageLook = false,
}: {
  provider: ProviderAccountProvider;
  accounts: ProviderAccountWire[];
  loaded?: boolean;
  canCancelSharedLogin?: boolean;
  // Only an owner signs the office account in or out (Nil, 2026-10-14).
  canChangeOffice?: boolean;
  onAccounts?: (accounts: ProviderAccountWire[]) => void;
  onStartNewConversation?: () => Promise<void>;
  showTitle?: boolean;
  apiKeyNote?: boolean;
  scopes?: readonly ProviderAccountScope[];
  // Moves the Integrations page to the other scope's card. Absent wherever
  // the card is mounted outside that page (the log view), where the pointer
  // stays plain text.
  onGoToOtherHalf?: () => void;
  // The Integrations page lays the card flat inside its own card.
  style?: CSSProperties;
  // The Integrations page's look: the provider's mark, an icon per scope,
  // the account as data, and a Test per sign-in. The log view's card keeps
  // its plain look.
  pageLook?: boolean;
}) {
  const { t } = useI18n();
  const title = provider === "codex" ? "Codex" : "Claude";
  return (
    <section
      data-provider-card={provider}
      style={{ ...cardStyle, marginTop: 14, ...style }}
    >
      {showTitle && (
        <h5
          style={{
            margin: "0 0 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {pageLook && <ProviderMark provider={provider} />}
          {title}
        </h5>
      )}
      {scopes.map((scope, index) => (
        <ProviderScopeConnection
          key={scope}
          provider={provider}
          scope={scope}
          hideTopBorder={index === 0 && !showTitle}
          account={accounts.find(
            (candidate) =>
              candidate.provider === provider && candidate.scope === scope,
          )}
          loaded={loaded}
          canCancelSharedLogin={canCancelSharedLogin}
          readOnly={scope === "office" && !canChangeOffice}
          onAccounts={onAccounts}
          onStartNewConversation={onStartNewConversation}
          onGoToOtherHalf={onGoToOtherHalf}
          pageLook={pageLook}
        />
      ))}
      {apiKeyNote && (
        <p
          style={{
            ...hint,
            margin: "14px 0 0",
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 14,
          }}
        >
          {t("settings.signIn.apiKeyNote")}
        </p>
      )}
    </section>
  );
}

// One sentence per source: a source word inside one sentence does not
// translate.
const API_KEY_SOURCE_LINE = {
  server: "settings.signIn.codexKey.server",
  office_variable: "settings.signIn.codexKey.officeVariable",
  office_secret: "settings.signIn.codexKey.officeSecret",
  member_variable: "settings.signIn.codexKey.memberVariable",
  member_secret: "settings.signIn.codexKey.memberSecret",
} as const satisfies Record<EnvVariableSource, string>;

const scopeLineStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 650,
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const connectedRowStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};

function ProviderScopeConnection({
  provider,
  scope,
  account,
  loaded,
  canCancelSharedLogin,
  readOnly,
  onAccounts,
  onStartNewConversation,
  onGoToOtherHalf,
  hideTopBorder = false,
  pageLook,
}: {
  provider: ProviderAccountProvider;
  scope: ProviderAccountScope;
  account?: ProviderAccountWire;
  loaded: boolean;
  canCancelSharedLogin: boolean;
  // Status and Test only: no sign-in, no sign-out.
  readOnly: boolean;
  onAccounts?: (accounts: ProviderAccountWire[]) => void;
  onStartNewConversation?: () => Promise<void>;
  onGoToOtherHalf?: () => void;
  hideTopBorder?: boolean;
  pageLook: boolean;
}) {
  const i18n = useI18n();
  const { t, rich } = i18n;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // Local mirror of "a sign-in is in flight". The wire's waiting_external
  // can lag or never reach this card (seen live in the chat card), and the
  // paste-code input must not depend on it.
  const [localWaiting, setLocalWaiting] = useState(false);
  const waitingConfirmedByWire = useRef(false);
  const [claudeCode, setClaudeCode] = useState("");
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [test, setTest] = useState<SignInTest>({ state: "idle" });
  // A second click in the same tick still sees the old state: the ref
  // holds a running test back.
  const testing = useRef(false);
  // The one-time code renders from local state the moment the login POST
  // returns - gating it on the pushed account status hid it whenever that
  // update lagged. Once the account reports connected, retire the code so
  // it cannot linger after a later sign-out.
  const connected = account?.accountStatus === "connected";
  useEffect(() => {
    if (connected) {
      setDeviceCode(null);
      setCodeCopied(false);
      setAuthUrl(null);
      setLinkCopied(false);
      setLocalWaiting(false);
    }
  }, [connected]);
  useEffect(() => {
    if (account?.loginStatus === "waiting_external") {
      waitingConfirmedByWire.current = true;
      return;
    }
    if (waitingConfirmedByWire.current) {
      waitingConfirmedByWire.current = false;
      setLocalWaiting(false);
    }
  }, [account?.loginStatus]);
  // A callback response can arrive after the successful account push.
  // Keep sign-in failures separate so sign-out and cancel failures stay visible.
  useEffect(() => {
    if (connected) setSignInError(null);
  }, [connected, signInError]);
  const title = provider === "codex" ? "Codex" : "Claude";
  const queueMessage = account?.loginQueue
    ? sharedLoginQueueMessage(i18n, title, account.loginQueue)
    : null;
  // On the Integrations page the card sits under a header that names the
  // scope, so the line drops the scope word; the chat card keeps it.
  const scopeTitle = pageLook
    ? scope === "office"
      ? t("integrations.signIn.office")
      : t("integrations.signIn.personal")
    : scope === "office"
      ? t("settings.signIn.scopeOffice")
      : t("settings.signIn.scopePersonal");
  // The office scope's sentence names the other section, so it carries the
  // cross-link rather than plain words - one key, the pointer inside it
  // (ruling 16).
  const scopeHint =
    scope === "office"
      ? rich("settings.signIn.officeHint", {
          link: (chunk) => (
            <SettingsLink label={chunk} onGo={onGoToOtherHalf} />
          ),
        })
      : t("settings.signIn.personalHint");

  async function refresh(): Promise<void> {
    const result = await apiFetch<ProviderAccountsWire>(
      "POST",
      "/api/me/provider-accounts/refresh",
    );
    onAccounts?.(result.accounts);
  }

  // Test: the account check Refresh runs, for this sign-in only, with its
  // result stated (the account the provider sees, or that it is signed out).
  async function runTest() {
    if (testing.current) return;
    testing.current = true;
    setTest({ state: "running" });
    try {
      const result = await apiFetch<ProviderAccountsWire>(
        "POST",
        "/api/me/provider-accounts/refresh",
      );
      onAccounts?.(result.accounts);
      const tested = result.accounts?.find(
        (entry) => entry.provider === provider && entry.scope === scope,
      );
      setTest(
        tested?.accountStatus === "connected"
          ? {
              state: "works",
              account: tested.accountLabel?.trim() || null,
            }
          : { state: "signedOut" },
      );
    } catch {
      setTest({ state: "failed" });
    } finally {
      testing.current = false;
    }
  }

  async function connect(method: "browser" | "device") {
    const popup = window.open("about:blank", "_blank");
    setPending(true);
    setSignInError(null);
    setDeviceCode(null);
    setCodeCopied(false);
    setAuthUrl(null);
    setLinkCopied(false);
    try {
      const result = await apiFetch<ProviderLoginStartRes>(
        "POST",
        `/api/me/provider-accounts/${provider}/login`,
        { method, scope },
      );
      if (result.authUrl) {
        if (popup) {
          popup.location.href = result.authUrl;
          popup.opener = null;
        } else window.open(result.authUrl, "_blank", "noopener,noreferrer");
      } else popup?.close();
      setDeviceCode(result.userCode ?? null);
      setAuthUrl(result.authUrl ?? null);
      setLocalWaiting(true);
      await refresh();
    } catch (caught) {
      popup?.close();
      setSignInError(
        caught instanceof ApiError &&
          caught.code === "shared_login_in_progress" &&
          typeof caught.detail?.holderName === "string" &&
          typeof caught.detail.startedAt === "number"
          ? sharedLoginQueueMessage(i18n, title, {
              holderName: caught.detail.holderName,
              startedAt: caught.detail.startedAt,
            })
          : caught instanceof ApiError
            ? caught.message
            : t("settings.signIn.startFailed", { provider: title }),
      );
    } finally {
      setPending(false);
    }
  }

  async function submitClaudeCode() {
    setPending(true);
    setSignInError(null);
    try {
      await apiFetch("POST", "/api/me/provider-accounts/claude/callback", {
        scope,
        code: claudeCode,
      });
      setClaudeCode("");
      setLocalWaiting(false);
      await refresh();
    } catch (caught) {
      setSignInError(
        caught instanceof ApiError
          ? caught.message
          : t("settings.signIn.submitFailed"),
      );
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setPending(true);
    setError(null);
    try {
      await apiFetch("POST", `/api/me/provider-accounts/${provider}/cancel`, {
        scope,
      });
      setDeviceCode(null);
      setAuthUrl(null);
      setLocalWaiting(false);
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : t("settings.signIn.cancelFailed"),
      );
    } finally {
      setPending(false);
    }
  }

  async function disconnect() {
    setPending(true);
    setError(null);
    try {
      const result = await apiFetch<ProviderAccountsWire>(
        "POST",
        `/api/me/provider-accounts/${provider}/disconnect`,
        { scope },
      );
      onAccounts?.(result.accounts);
      setConfirmingSignOut(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : t("settings.signIn.signOutFailed", { provider: title }),
      );
    } finally {
      setPending(false);
    }
  }

  // apiKeySource is set only when the agents use their OPENAI_API_KEY (no
  // stored sign-in in their CODEX_HOME). Only the personal scope trades "not
  // connected" for it: the office scope still says whether the office has a
  // sign-in.
  const apiKeySource = provider === "codex" ? account?.apiKeySource : undefined;
  const statusState = !account
    ? loaded
      ? "unavailable"
      : "checking"
    : account.loginStatus === "waiting_external"
      ? "waiting"
      : scope === "personal" &&
          apiKeySource &&
          account.accountStatus === "not_connected"
        ? "apiKey"
        : account.accountStatus;
  const status =
    statusState === "checking"
      ? t("settings.signIn.checking")
      : statusState === "waiting"
        ? t("settings.signIn.waiting")
        : statusState === "connected"
          ? account?.accountLabel
            ? pageLook
              ? i18n.rich("settings.signIn.connectedAs", {
                  account: <Data>{account.accountLabel}</Data>,
                })
              : t("settings.signIn.connectedAs", {
                  account: account.accountLabel,
                })
            : t("settings.signIn.connected")
          : statusState === "unavailable"
            ? t("settings.signIn.unavailable")
            : statusState === "apiKey"
              ? t("settings.signIn.apiKey")
              : t("settings.signIn.notConnected");
  const externalWarning = account?.externalCli
    ? t("settings.signIn.externalWarning", { provider: title })
    : account?.explicitDirectory
      ? t("settings.signIn.directoryWarning")
      : null;

  // `live` false: the held space of the row, with nothing to act on.
  const signInRow = (live: boolean) => (
    <div
      style={{
        margin: "12px 0",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <button
        data-start-provider-login={live ? "" : undefined}
        style={{ ...dialogSaveBtn, flexShrink: 0 }}
        onClick={
          live
            ? () => void connect(provider === "codex" ? "device" : "browser")
            : undefined
        }
        disabled={pending}
      >
        {pending ? t("settings.signIn.signingIn") : t("settings.signIn.signIn")}
      </button>
      <p style={{ ...hint, margin: 0, flex: 1, minWidth: 180 }}>
        {provider === "codex"
          ? t("settings.signIn.codexHint")
          : t("settings.signIn.claudeHint")}
      </p>
    </div>
  );

  return (
    <div
      style={
        hideTopBorder
          ? {}
          : {
              borderTop: "1px solid var(--border-subtle)",
              paddingTop: 14,
              marginTop: 14,
            }
      }
    >
      {pageLook ? (
        // The page puts the hint beside the scope line, under it when it
        // does not fit.
        <div
          data-sign-in-scope={scope}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            columnGap: 10,
            rowGap: 8,
          }}
        >
          <div style={scopeLineStyle}>
            <span aria-hidden style={{ color: "var(--text-muted)" }}>
              {scope === "office" ? BuildingIcon : PersonIcon}
            </span>
            {scopeTitle}
          </div>
          <p style={{ ...hint, margin: 0 }}>{scopeHint}</p>
        </div>
      ) : (
        <>
          <div data-sign-in-scope={scope} style={scopeLineStyle}>
            {scopeTitle}
          </div>
          <p style={{ ...hint, margin: "8px 0 0" }}>{scopeHint}</p>
        </>
      )}
      <p
        data-provider-account-state={statusState}
        style={{ ...hint, margin: "8px 0 0" }}
      >
        <strong>{t("settings.signIn.status")}</strong> {status}
      </p>
      {apiKeySource && API_KEY_SOURCE_LINE[apiKeySource] && (
        <p
          data-codex-api-key-source={apiKeySource}
          style={{ ...hint, margin: "8px 0 0" }}
        >
          {rich(API_KEY_SOURCE_LINE[apiKeySource], {
            code: (chunk) => <Data>{chunk}</Data>,
          })}
        </p>
      )}
      {account?.error && (
        <p role="alert" style={{ color: "var(--red-text)", fontSize: 12 }}>
          {account.error}
        </p>
      )}
      {signInError && !connected && (
        <p role="alert" style={{ color: "var(--red-text)", fontSize: 12 }}>
          {signInError}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--red-text)", fontSize: 12 }}>
          {error}
        </p>
      )}

      {queueMessage && (
        <div data-provider-login-queue style={{ margin: "12px 0" }}>
          <p style={{ ...hint, margin: "0 0 8px" }}>{queueMessage}</p>
          {canCancelSharedLogin && (
            <button
              data-cancel-shared-login
              style={dialogCancelBtn}
              onClick={() => void cancel()}
              disabled={pending}
            >
              {t("settings.signIn.cancelShared")}
            </button>
          )}
        </div>
      )}

      {readOnly ? (
        // The Integrations page already says only owners change it, and an
        // owner's sign-in in progress shows its own status.
        !pageLook &&
        !connected &&
        !account?.loginQueue &&
        account?.loginStatus !== "waiting_external" && (
          <p data-ask-office-owner style={{ ...hint, margin: "12px 0 0" }}>
            {t("settings.signIn.askOfficeOwner")}
          </p>
        )
      ) : (!account?.loginQueue &&
          account?.loginStatus === "waiting_external") ||
        (localWaiting && !connected) ? (
        <div data-own-login-controls style={{ margin: "12px 0" }}>
          {provider === "claude" && (
            <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
              {t("settings.signIn.pasteCode")}
              <input
                value={claudeCode}
                onChange={(event) => setClaudeCode(event.target.value)}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              />
            </label>
          )}
          {provider === "claude" && (
            <button
              style={{ ...dialogCancelBtn, marginRight: 8 }}
              onClick={() => void submitClaudeCode()}
              disabled={pending || !claudeCode.trim()}
            >
              {t("settings.signIn.submitCode")}
            </button>
          )}
          <button
            style={dialogCancelBtn}
            onClick={() => void cancel()}
            disabled={pending}
          >
            {t("settings.signIn.cancelSignIn")}
          </button>
        </div>
      ) : (
        !account?.loginQueue &&
        account?.canBrowserLogin &&
        account.accountStatus !== "connected" &&
        signInRow(true)
      )}
      {authUrl && !connected && (
        <p style={{ ...hint, margin: "12px 0 0" }}>
          {t("settings.signIn.linkNotOpen")}{" "}
          <button
            style={{ ...dialogCancelBtn, padding: "3px 10px" }}
            onClick={() =>
              void navigator.clipboard
                .writeText(authUrl)
                .then(() => setLinkCopied(true))
            }
          >
            {linkCopied
              ? t("settings.signIn.linkCopied")
              : t("settings.signIn.copyLink")}
          </button>
        </p>
      )}
      {deviceCode && !connected && (
        <div style={{ margin: "12px 0" }}>
          <p style={{ ...hint, margin: "0 0 6px" }}>
            {t("settings.signIn.enterCode")}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: 2,
                color: "var(--accent-text)",
                background: "var(--bg-code)",
                border: "1px solid var(--accent)",
                borderRadius: 8,
                padding: "6px 12px",
              }}
            >
              {deviceCode}
            </span>
            <button
              style={dialogCancelBtn}
              onClick={() =>
                void navigator.clipboard
                  .writeText(deviceCode)
                  .then(() => setCodeCopied(true))
              }
            >
              {codeCopied ? t("common.copied") : t("common.copy")}
            </button>
          </div>
        </div>
      )}
      {/* While the status loads, the page holds the space of the usual
          buttons: the office is mostly signed in, a member mostly not. */}
      {pageLook && statusState === "checking" && (
        <Reserved>
          {scope === "office" ? (
            <div style={connectedRowStyle}>
              <button style={dialogCancelBtn}>{t("common.signOut")}</button>
            </div>
          ) : (
            signInRow(false)
          )}
        </Reserved>
      )}
      {account?.accountStatus === "connected" && (
        <div style={connectedRowStyle}>
          {readOnly ? null : !confirmingSignOut ? (
            <button
              data-provider-sign-out
              style={{
                ...dialogCancelBtn,
                color: "var(--red-text)",
                flexShrink: 0,
              }}
              onClick={() => setConfirmingSignOut(true)}
              disabled={pending}
            >
              {t("common.signOut")}
            </button>
          ) : (
            <div
              role="dialog"
              aria-label={t("settings.signIn.signOutDialog", {
                provider: title,
              })}
              style={{ display: "flex", gap: 8, flexShrink: 0 }}
            >
              <button
                autoFocus
                style={dialogCancelBtn}
                onClick={() => setConfirmingSignOut(false)}
                disabled={pending}
              >
                {t("common.cancel")}
              </button>
              <button
                style={{ ...dialogCancelBtn, color: "var(--red-text)" }}
                onClick={() => void disconnect()}
                disabled={pending}
              >
                {signOutButtonLabel(i18n, pending)}
              </button>
            </div>
          )}
          {pageLook && !confirmingSignOut && (
            <button
              style={{ ...dialogCancelBtn, flexShrink: 0 }}
              disabled={test.state === "running"}
              onClick={() => void runTest()}
              data-sign-in-test
            >
              {test.state === "running"
                ? t("settings.connections.test.running")
                : t("settings.connections.test.button")}
            </button>
          )}
          {externalWarning && (
            <p
              style={{
                ...hint,
                color: "var(--red-text)",
                margin: 0,
                flex: 1,
                minWidth: 180,
              }}
            >
              {externalWarning}
            </p>
          )}
        </div>
      )}
      {/* A "Works" from before a sign-out no longer holds. */}
      {pageLook && (connected || test.state !== "works") && (
        <SignInTestResult test={test} provider={provider} />
      )}
      {onStartNewConversation &&
        (account?.loginStatus === "succeeded" || connected) && (
          <div style={{ margin: "12px 0" }}>
            <p style={hint}>{t("settings.signIn.connectedStart")}</p>
            <button
              style={dialogCancelBtn}
              onClick={() => void onStartNewConversation()}
            >
              {t("settings.signIn.startConversation")}
            </button>
          </div>
        )}
    </div>
  );
}

type SignInTest =
  | { state: "idle" }
  | { state: "running" }
  | { state: "works"; account: string | null }
  | { state: "signedOut" }
  | { state: "failed" };

function SignInTestResult({
  test,
  provider,
}: {
  test: SignInTest;
  provider: ProviderAccountProvider;
}) {
  const { t } = useI18n();
  if (test.state === "idle" || test.state === "running") return null;
  const ok = test.state === "works";
  return (
    <div
      data-sign-in-test-result={test.state}
      style={{
        fontSize: 12,
        margin: "8px 0 0",
        color: ok ? "var(--green-text)" : "var(--red-text)",
        overflowWrap: "anywhere",
      }}
    >
      {test.state === "works" ? (
        <>
          {t("settings.connections.test.works")}
          {test.account && (
            <>
              {" · "}
              <Data>{test.account}</Data>
            </>
          )}
          {/* What Works means: the check the test ran (Nil, 2026-10-14). */}
          <HelpTip
            text={t(
              provider === "claude"
                ? "settings.connections.test.help.claude"
                : "settings.connections.test.help.codex",
            )}
          />
        </>
      ) : test.state === "signedOut" ? (
        t("integrations.providers.testSignedOut")
      ) : (
        t("settings.connections.test.requestFailed")
      )}
    </div>
  );
}
