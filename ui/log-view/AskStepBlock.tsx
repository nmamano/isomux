// The step of a step ask, done in the card (task e3d1bc63, part 6): a
// provider sign-in, an MCP server sign-in, the browser pairing or a room's
// GitHub link, with the Integrations page's own controls. The server closes
// the ask when it sees the step done (server/step-asks.ts).
//
// A control acts as the viewer. A step on the member's own account (their
// provider sign-in, their browser) draws no control on another member's
// ask, only who does it. An MCP sign-in started here comes back to this
// ask (/inbox/asks/<askId>?mcpSignIn=<code>); a failure shows in the card.

import { useContext, useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import { OfficeLinkOpener } from "../office-link.tsx";
import { officeLinkFor } from "../../shared/office-links.ts";
import {
  isActionStep,
  type AskStep,
  type GithubLinkWire,
  type StepAskRequest,
} from "../../shared/types.ts";
import { ProviderSignInCard } from "../components/ProviderSignInCard.tsx";
import { BrowserPane } from "../components/BrowserPane.tsx";
import {
  RoomGithubLink,
  useGithubSecrets,
} from "../integrations/GithubSection.tsx";
import { signInErrorText } from "../integrations/McpSection.tsx";
import { startMcpSignIn } from "../integrations/sign-in-return.ts";
import type { Target } from "../integrations/target.ts";
import { AskSignInResult } from "./ask-sign-in.ts";

// What the card draws for a step: its control, who does it, or null for a
// step this card cannot draw (a later release's kind, a server of a member
// the store does not know), which keeps the ask's link. AskCard reads it to
// decide the link, and AskStepBlock draws it, so the two cannot disagree.
export type StepView =
  | { kind: "others"; step: StepAskRequest["kind"]; name: string | null }
  | {
      kind: "provider-sign-in";
      provider: "claude" | "codex";
      scope: "personal" | "office";
    }
  | { kind: "browser-pairing" }
  | { kind: "mcp-sign-in"; target: Target; name: string }
  | { kind: "github-link"; roomId: string };

export function useStepView(
  step: AskStep | undefined,
  memberUserId: string | undefined,
): StepView | null {
  const { sessionContext, users } = useAppState();
  if (!step || isActionStep(step)) return null;
  const viewer = sessionContext?.userId ?? null;
  const own = !!viewer && viewer === memberUserId;
  const nameOf = (userId: string | undefined) =>
    [...users.values()].find((u) => u.id === userId)?.name ?? null;
  const others = (): StepView => ({
    kind: "others",
    step: step.kind,
    name: nameOf(memberUserId),
  });
  switch (step.kind) {
    case "provider-sign-in":
      return step.scope === "personal" && !own
        ? others()
        : { kind: step.kind, provider: step.provider, scope: step.scope };
    case "browser-pairing":
      return own ? { kind: step.kind } : others();
    case "mcp-sign-in": {
      if (step.scope === "office")
        return { kind: step.kind, target: { kind: "office" }, name: step.name };
      const owner = step.ownerUserId;
      const self = !!owner && owner === viewer;
      const username = self
        ? (sessionContext?.username ?? null)
        : nameOf(owner);
      if (!owner || username === null) return null;
      return {
        kind: step.kind,
        target: self
          ? { kind: "self", username }
          : { kind: "member", username },
        name: step.name,
      };
    }
    case "github-link":
      return { kind: step.kind, roomId: step.roomId };
    default:
      return null;
  }
}

export function AskStepBlock({
  askId,
  view,
  isMobile,
}: {
  askId: string;
  view: StepView;
  isMobile: boolean;
}) {
  let control: React.ReactNode;
  switch (view.kind) {
    case "others":
      control = <OthersStep name={view.name} />;
      break;
    case "provider-sign-in":
      control = (
        <AskProviderSignIn provider={view.provider} scope={view.scope} />
      );
      break;
    case "browser-pairing":
      control = <BrowserPane />;
      break;
    case "mcp-sign-in":
      control = (
        <AskMcpSignIn
          askId={askId}
          target={view.target}
          name={view.name}
          isMobile={isMobile}
        />
      );
      break;
    case "github-link":
      control = <AskGithubLink roomId={view.roomId} />;
      break;
  }
  return (
    <div
      data-ask-step={view.kind === "others" ? view.step : view.kind}
      style={{
        marginTop: 8,
        fontSize: isMobile ? 13 : 12,
        lineHeight: 1.5,
        color: "var(--text-primary)",
      }}
    >
      {control}
    </div>
  );
}

// A step only the ask's member can do.
function OthersStep({ name }: { name: string | null }) {
  const { t } = useI18n();
  return (
    <p
      data-ask-step-others=""
      style={{ margin: 0, color: "var(--text-muted)" }}
    >
      {name
        ? t("asks.step.others", { member: name })
        : t("asks.step.othersUnknown")}
    </p>
  );
}

function AskProviderSignIn({
  provider,
  scope,
}: {
  provider: "claude" | "codex";
  scope: "personal" | "office";
}) {
  const { providerAccounts, sessionContext } = useAppState();
  return (
    <ProviderSignInCard
      provider={provider}
      accounts={providerAccounts}
      scopes={[scope]}
      canChangeOffice={sessionContext?.role === "owner"}
      style={{ marginTop: 0 }}
    />
  );
}

// The Sign in of an MCP server, and the result of one that came back to
// this ask.
function AskMcpSignIn({
  askId,
  target,
  name,
  isMobile,
}: {
  askId: string;
  target: Target;
  name: string;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const returned = useContext(AskSignInResult);
  const [busy, setBusy] = useState(false);
  // A fixed code from the way back, or the text of a refused start.
  const [failure, setFailure] = useState<
    { code: string } | { text: string } | null
  >(() =>
    returned.result?.askId === askId && returned.result.code !== "ok"
      ? { code: returned.result.code }
      : null,
  );
  // The code is this card's once: the next mount does not show it again.
  useEffect(() => {
    if (returned.result?.askId === askId) returned.take();
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signIn() {
    setBusy(true);
    setFailure(null);
    try {
      await startMcpSignIn(target, name, askId);
    } catch (caught) {
      setFailure({
        text:
          caught instanceof ApiError
            ? signInErrorText(t, caught.detail?.reason, name)
            : t("settings.mcpServers.signInFailed"),
      });
      setBusy(false);
    }
  }

  return (
    <>
      {failure && (
        <p
          role="alert"
          {...("code" in failure
            ? { "data-ask-mcp-sign-in-result": failure.code }
            : {})}
          style={{
            margin: "0 0 6px",
            color: "var(--red-text)",
            overflowWrap: "anywhere",
          }}
        >
          {"code" in failure
            ? signInErrorText(t, failure.code, name)
            : failure.text}
        </p>
      )}
      <button
        type="button"
        data-ask-mcp-sign-in=""
        disabled={busy}
        onClick={() => void signIn()}
        style={{
          padding: isMobile ? "8px 14px" : "5px 14px",
          borderRadius: 8,
          border: "none",
          background: "var(--accent-text)",
          color: "var(--bg-base)",
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {failure
          ? t("settings.mcpServers.signInAgain")
          : t("settings.mcpServers.signIn")}
      </button>
    </>
  );
}

// The GitHub link form of the step's room, as on the Integrations page.
function AskGithubLink({ roomId }: { roomId: string }) {
  const usable = useGithubSecrets();
  const openLink = useContext(OfficeLinkOpener);
  const [saved, setSaved] = useState<GithubLinkWire | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let alive = true;
    void apiFetch<{ link: GithubLinkWire | null }>(
      "GET",
      `/api/rooms/${encodeURIComponent(roomId)}/github-link`,
    )
      .then((r) => r.link)
      .catch(() => null)
      .then((link) => {
        if (alive) setSaved(link);
      });
    return () => {
      alive = false;
    };
  }, [roomId]);
  const ready = saved !== undefined && usable !== null;
  return (
    <RoomGithubLink
      key={ready ? "ready" : "waiting"}
      roomId={roomId}
      saved={saved ?? null}
      usable={usable ?? []}
      waiting={!ready}
      onSecrets={() => {
        const secrets = officeLinkFor("/integrations/secrets");
        if (secrets && openLink) openLink(secrets);
      }}
      onSaved={() => {}}
    />
  );
}
