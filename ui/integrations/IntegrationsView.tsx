// The Integrations page (task 911c9bbb, design A of the mocks): what agents
// can use, in five tabs - model providers, MCP servers, secrets, variables,
// browser. Each tab but Browser shows the office-wide ones, then the personal
// ones; Browser pairs only the viewer's own Chrome (task f2d5cf9f moved it
// here from Settings). An owner can
// pick another member's personal ones; the card then turns orange, takes the
// member's name and offers a way back, and every form names the member, so an
// owner cannot forget whose items they are changing (Nil, 2026-10-13).
//
// The member choice lives in this component only. Each open starts on You,
// except the Settings member profile's link, which opens on that member once.
// The tab is remembered on the device: an open starts on the last one, except
// an MCP sign-in that came back, which opens MCP servers on the card of the
// server it signed in to, and a request that names a tab.

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { BEDROCK_GUIDE } from "../connection-rows.ts";
import {
  MyConnectionsProvider,
  useMyConnectionsFailed,
} from "./my-connections.tsx";
import { ProvidersSection, useProviderAccounts } from "./ProvidersSection.tsx";
import { McpSection, SignInNotice } from "./McpSection.tsx";
import { SecretsSection } from "./SecretsSection.tsx";
import { VariablesSection } from "./VariablesSection.tsx";
import { ConnectorList, EngineMcpList } from "./ClaudeLists.tsx";
import { takeSignIn, type SignInNote } from "./sign-in-return.ts";
import { Btn, Data, card, hintText, input } from "./kit.tsx";
import { targetKey, type Role, type Target } from "./target.ts";
import { BuildingIcon, PersonIcon } from "../components/NavIcons.tsx";
import { getIntegrationsTab, setIntegrationsTab } from "../device-settings.ts";
import { BrowserPane } from "../components/BrowserPane.tsx";

export type IntegrationsRequest = {
  // The result code of an MCP sign-in that came back (?mcpSignIn=<code>).
  signIn?: string;
  // The tab to open on, for a door that names one.
  tab?: IntegrationsTab;
};

export type IntegrationsTab =
  | "providers"
  | "mcp"
  | "secrets"
  | "variables"
  | "browser";
const TABS: IntegrationsTab[] = [
  "providers",
  "mcp",
  "secrets",
  "variables",
  "browser",
];

const TAB_LABEL = {
  providers: "integrations.tabs.providers",
  mcp: "integrations.tabs.mcp",
  secrets: "integrations.tabs.secrets",
  variables: "integrations.tabs.variables",
  browser: "integrations.tabs.browser",
} as const;

const TAB_INTRO = {
  providers: "integrations.tabIntro.providers",
  mcp: "integrations.tabIntro.mcp",
  secrets: "integrations.tabIntro.secrets",
  variables: "integrations.tabIntro.variables",
  browser: "browser.intro",
} as const;

type IntegrationsProps = {
  onClose: () => void;
  request?: IntegrationsRequest | null;
  onRequestHandled?: () => void;
};

// The caller's connections list is read once for the whole page.
export function IntegrationsView(props: IntegrationsProps) {
  return (
    <MyConnectionsProvider>
      <IntegrationsPage {...props} />
    </MyConnectionsProvider>
  );
}

function IntegrationsPage({
  onClose,
  request = null,
  onRequestHandled,
}: IntegrationsProps) {
  const { isMobile, sessionContext, users } = useAppState();
  const { t, rich } = useI18n();
  const role: Role = sessionContext?.role === "owner" ? "owner" : "member";
  const self = sessionContext?.username ?? "";

  // Read once: the request is one-shot, and App clears it below.
  const [initial] = useState(() => request);
  const [tab, setTabState] = useState<IntegrationsTab>(() =>
    initial?.signIn
      ? "mcp"
      : (initial?.tab ?? getIntegrationsTab(TABS) ?? "providers"),
  );
  const setTab = (next: IntegrationsTab) => {
    setTabState(next);
    setIntegrationsTab(next);
  };
  const others = [...users.values()]
    .filter((user) => user.id !== sessionContext?.userId)
    .sort((a, b) => a.name.localeCompare(b.name));
  // The result of an MCP sign-in that came back, with the note the page left
  // before it went: which server, on whose card. With the note it shows on
  // the server's row until the next action on that card; without one, at
  // the top of the tab.
  const [signIn, setSignIn] = useState<{
    code: string;
    note: SignInNote | null;
  } | null>(() =>
    initial?.signIn ? { code: initial.signIn, note: takeSignIn() } : null,
  );
  // A sign-in for another member opens on that member's card.
  const opensOn =
    signIn?.note?.target.kind === "member"
      ? signIn.note.target.username
      : undefined;
  const [member, setMember] = useState<string | null>(() =>
    role === "owner" && opensOn && opensOn.toLowerCase() !== self.toLowerCase()
      ? opensOn
      : null,
  );
  // A member who left the office while picked: the card goes back to You and
  // says so, never an empty card under their name.
  const [gone, setGone] = useState<string | null>(null);
  const connectionsFailed = useMyConnectionsFailed();

  useEffect(() => {
    // A named tab counts as picked, so the next open starts there too.
    if (initial?.tab) setIntegrationsTab(initial.tab);
    if (request) onRequestHandled?.();
    // Once, on mount: the page has what it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A member who leaves the office (or is renamed) while picked: back to You.
  // Before the roster arrives nobody is known yet, which is not the same.
  const memberKnown =
    member !== null && others.some((user) => user.name === member);
  const goneMember =
    gone ?? (member !== null && !memberKnown && users.size > 0 ? member : null);
  const personal: Target =
    member !== null && memberKnown
      ? { kind: "member", username: member }
      : { kind: "self", username: self };
  const pick = (next: string | null) => {
    setGone(null);
    setMember(next);
  };
  const memberGone = () => {
    if (personal.kind !== "member") return;
    setGone(personal.username);
    setMember(null);
  };
  const office: Target = { kind: "office" };

  // The sign-in result for this card's servers, if any.
  const signInFor = (target: Target) =>
    signIn?.note && targetKey(signIn.note.target) === targetKey(target)
      ? { code: signIn.code, server: signIn.note.server }
      : null;
  // The next action on that card (a button, a link, a field) clears it.
  const actOn = (target: Target) => (e: MouseEvent) => {
    if (
      signInFor(target) &&
      e.target instanceof Element &&
      e.target.closest("button, a, input, select, textarea, label, summary")
    )
      setSignIn(null);
  };

  const accounts = useProviderAccounts();
  const personalRef = useRef<HTMLElement>(null);

  function section(target: Target): ReactNode {
    const key = `${tab}:${targetKey(target)}`;
    switch (tab) {
      case "providers":
        return (
          <ProvidersSection
            key={key}
            target={target}
            role={role}
            accounts={accounts}
            onGone={memberGone}
            onVariables={() => setTab("variables")}
            onGoToOtherCard={
              target.kind === "office"
                ? () =>
                    personalRef.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    })
                : undefined
            }
          />
        );
      case "mcp":
        return (
          <div key={key}>
            <McpSection
              target={target}
              role={role}
              onGone={memberGone}
              signIn={signInFor(target)}
            />
            {target.kind !== "member" && (
              <ConnectorList
                scope={target.kind === "office" ? "office" : "personal"}
              />
            )}
            {target.kind !== "member" && (
              <EngineMcpList
                scope={target.kind === "office" ? "office" : "personal"}
              />
            )}
          </div>
        );
      case "secrets":
        return (
          <SecretsSection
            key={key}
            target={target}
            role={role}
            onGone={memberGone}
          />
        );
      case "variables":
        return (
          <VariablesSection
            key={key}
            target={target}
            role={role}
            onGone={memberGone}
          />
        );
      // The Browser tab has no cards (see the page below).
      case "browser":
        return null;
    }
  }

  return (
    <div
      data-integrations-page=""
      style={{
        height: isMobile
          ? "calc(100dvh - var(--banner-h, 0px))"
          : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <button
          onClick={onClose}
          data-page-close=""
          aria-label={t("common.back")}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: "2px 8px",
          }}
        >
          &larr;
        </button>
        <h1 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
          {t("common.integrations")}
        </h1>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            maxWidth: 900,
            margin: "0 auto",
            padding: isMobile ? "14px 14px 40px" : "20px 24px 60px",
          }}
        >
          <p style={{ ...hintText, margin: "0 0 16px" }}>
            {role === "owner"
              ? t("integrations.ownerIntro")
              : t("integrations.memberIntro")}
          </p>
          <div
            role="tablist"
            aria-label={t("common.integrations")}
            style={{
              display: "flex",
              gap: 2,
              borderBottom: "1px solid var(--border)",
              // Five tabs do not fit a phone's width in one row: they wrap,
              // so no tab hides past the edge.
              flexWrap: isMobile ? "wrap" : undefined,
              overflowX: "auto",
              marginBottom: 16,
            }}
          >
            {TABS.map((id) => {
              const on = id === tab;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`integrations-tab-${id}`}
                  aria-selected={on}
                  aria-controls="integrations-panel"
                  data-integrations-tab={id}
                  onClick={() => setTab(id)}
                  style={{
                    padding: isMobile ? "9px 10px" : "9px 14px",
                    border: "none",
                    borderBottom: `2px solid ${on ? "var(--accent-text)" : "transparent"}`,
                    background: "none",
                    color: on ? "var(--text-primary)" : "var(--text-muted)",
                    fontWeight: on ? 650 : 500,
                    fontSize: 13,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    fontFamily: "inherit",
                  }}
                >
                  {t(TAB_LABEL[id])}
                </button>
              );
            })}
          </div>
          <div
            role="tabpanel"
            id="integrations-panel"
            aria-labelledby={`integrations-tab-${tab}`}
          >
            <p style={{ ...hintText, margin: "0 0 16px" }}>
              {t(TAB_INTRO[tab])}
              {tab === "secrets" && (
                <>
                  <br />
                  {t("integrations.secretsHonesty")}
                  <br />
                  <span data-secrets-model-keys="">
                    {rich("integrations.secrets.modelKeys", {
                      code: (chunk) => <Data>{chunk}</Data>,
                      link: (chunk) => (
                        <Btn
                          kind="link"
                          onClick={() => setTab("variables")}
                          data-go-variables
                        >
                          {chunk}
                        </Btn>
                      ),
                    })}
                  </span>
                </>
              )}
              {tab === "variables" && (
                <>
                  <br />
                  {rich("integrations.variables.modelKeys", {
                    code: (chunk) => <Data>{chunk}</Data>,
                  })}
                </>
              )}
            </p>
            {/* No note, or none for a card on this page. */}
            {signIn &&
              !signInFor(office) &&
              !signInFor(personal) &&
              tab === "mcp" && (
                <SignInNotice
                  code={signIn.code}
                  server={null}
                  style={{ margin: "0 0 14px" }}
                />
              )}
            {connectionsFailed && tab === "mcp" && (
              <p
                role="alert"
                data-connections-failed
                style={{
                  ...hintText,
                  color: "var(--red-text)",
                  margin: "0 0 14px",
                }}
              >
                {t("integrations.connectionsFailed")}
              </p>
            )}

            {tab === "browser" ? (
              // Only a session has its own Chrome to pair.
              sessionContext && <BrowserPane />
            ) : (
              <>
                <section
                  data-integrations-card="office"
                  style={card}
                  onClickCapture={actOn(office)}
                >
                  <CardHead
                    icon={BuildingIcon}
                    title={t("integrations.office")}
                    sub={
                      role === "owner"
                        ? t("integrations.officeWho")
                        : t("integrations.officeWhoMember")
                    }
                    action={
                      tab === "providers" ? (
                        <Btn
                          small
                          disabled={accounts.refreshing}
                          onClick={accounts.refresh}
                          data-providers-refresh
                        >
                          {accounts.refreshing
                            ? t("settings.connections.refreshing")
                            : t("settings.connections.refresh")}
                        </Btn>
                      ) : undefined
                    }
                  />
                  {section(office)}
                </section>

                <PersonalCard
                  cardRef={personalRef}
                  target={personal}
                  role={role}
                  others={others.map((user) => user.name)}
                  onPick={pick}
                  gone={goneMember}
                  onClickCapture={actOn(personal)}
                >
                  {section(personal)}
                </PersonalCard>

                {tab === "providers" && (
                  <ProvidersFooter onVariables={() => setTab("variables")} />
                )}
                <p style={{ ...hintText, marginTop: 8 }}>
                  {t("integrations.applies")}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CardHead({
  icon,
  title,
  sub,
  action,
  accent,
}: {
  // The card's scope at a glance: a building for Office-wide, a person for
  // Personal (Nil, 2026-10-13).
  icon: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        margin: "0 0 8px",
        flexWrap: "wrap",
      }}
    >
      {/* Title and subtitle share a line; the subtitle wraps under the
          title when it does not fit (Nil, 2026-10-14). */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          columnGap: 10,
          rowGap: 2,
        }}
      >
        <h2
          data-card-title
          style={{
            fontSize: 13,
            fontWeight: 700,
            margin: 0,
            color: accent ? "var(--orange-text)" : undefined,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            aria-hidden
            data-card-icon=""
            style={{
              color: accent ? "var(--orange-text)" : "var(--text-muted)",
            }}
          >
            {icon}
          </span>
          {title}
        </h2>
        {sub && <div style={hintText}>{sub}</div>}
      </div>
      {action}
    </div>
  );
}

// The personal card. An owner picks whose items it shows; another member's
// turn the card orange, put their name in the title and offer the way back.
function PersonalCard({
  cardRef,
  target,
  role,
  others,
  onPick,
  gone,
  onClickCapture,
  children,
}: {
  cardRef: React.RefObject<HTMLElement | null>;
  target: Target;
  role: Role;
  others: string[];
  onPick: (member: string | null) => void;
  // A member who left while picked.
  gone: string | null;
  onClickCapture: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  const { t, rich } = useI18n();
  const other = target.kind === "member";
  const picker =
    role === "owner" && others.length > 0 ? (
      <select
        data-integrations-picker
        aria-label={t("integrations.picker")}
        value={other ? target.username : ""}
        onChange={(e) => onPick(e.target.value || null)}
        style={{
          ...input,
          width: "auto",
          padding: "4px 8px",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--text-primary)",
        }}
      >
        <option value="">{t("common.you")}</option>
        {others.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    ) : null;
  return (
    <section
      ref={cardRef}
      onClickCapture={onClickCapture}
      data-integrations-card="personal"
      data-integrations-member={other ? target.username : undefined}
      style={{
        ...card,
        marginTop: 14,
        scrollMarginTop: 12,
        ...(other
          ? {
              border: "1.5px solid var(--orange-border)",
              boxShadow: "inset 4px 0 0 var(--orange-border)",
            }
          : {}),
      }}
    >
      <CardHead
        icon={PersonIcon}
        accent={other}
        title={
          <>
            {/* One flex item, so the name chip stays inside its sentence. */}
            <span>
              {other
                ? rich("integrations.memberTitle", {
                    member: <Data>{target.username}</Data>,
                  })
                : t("integrations.personal")}
            </span>
            {picker}
          </>
        }
        sub={
          other
            ? rich("integrations.personalWhoMember", {
                member: <Data>{target.username}</Data>,
              })
            : t("integrations.personalWhoSelf")
        }
        action={
          other ? (
            <Btn kind="link" onClick={() => onPick(null)} data-back-to-yours>
              {t("integrations.backToYours")}
            </Btn>
          ) : undefined
        }
      />
      {gone && (
        <p
          role="status"
          data-member-gone
          style={{
            ...hintText,
            color: "var(--orange-text)",
            margin: "0 0 8px",
          }}
        >
          {rich("integrations.memberGone", { member: <Data>{gone}</Data> })}
        </p>
      )}
      {children}
    </section>
  );
}

function ProvidersFooter({ onVariables }: { onVariables: () => void }) {
  const { rich } = useI18n();
  return (
    <>
      <p data-api-keys-hint style={{ ...hintText, marginTop: 14 }}>
        {rich("integrations.providers.apiKeys", {
          code: (chunk) => <Data>{chunk}</Data>,
          link: (chunk) => (
            <Btn kind="link" onClick={onVariables} data-go-variables>
              {chunk}
            </Btn>
          ),
        })}
      </p>
      <p style={{ ...hintText, marginTop: 8 }}>
        {rich("settings.connections.bedrockHint", {
          link: (chunk) => (
            <a
              href={BEDROCK_GUIDE}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent-text)" }}
            >
              {chunk}
            </a>
          ),
        })}
      </p>
    </>
  );
}
