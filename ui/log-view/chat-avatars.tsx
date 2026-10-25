// Avatars and agent links in an agent's chat: the sender's avatar before its
// name on a message from another agent or member, the receiver's on a
// message the agent sends, and an agent's name that opens its chat.
import type { ReactNode } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { getUsername } from "../device-settings.ts";
import { Character } from "../office/Character.tsx";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import { defaultGhostColorForUserId } from "../../shared/avatar.ts";

export const CHAT_AVATAR_SIZE = 24;

function AvatarFrame({ children }: { children: ReactNode }) {
  return (
    <span
      data-chat-avatar=""
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: CHAT_AVATAR_SIZE,
        height: CHAT_AVATAR_SIZE,
        borderRadius: "50%",
        overflow: "hidden",
        background: "var(--bg-code)",
        border: "1px solid var(--border-subtle)",
        verticalAlign: "middle",
        marginRight: Math.round(CHAT_AVATAR_SIZE * 0.35),
        position: "relative",
        top: -1,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

// Nothing for an agent that no longer exists.
export function AgentAvatar({ agentId }: { agentId: string | undefined }) {
  const { agents } = useAppState();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  return (
    <AvatarFrame>
      <Character
        state="idle"
        outfit={agent.outfit}
        portrait
        headCrop={CHAT_AVATAR_SIZE}
      />
    </AvatarFrame>
  );
}

// Nothing for an unknown member, and nothing on the viewer's own messages.
export function MemberAvatar({ username }: { username: string | undefined }) {
  const { users, sessionContext } = useAppState();
  const key = username?.toLowerCase();
  const user = key ? users.get(key) : undefined;
  const self = (sessionContext?.username ?? getUsername())?.toLowerCase();
  if (!user || key === self) return null;
  // The ghost's view box has room for hats and tails around the body;
  // oversize it and let the frame crop to the body.
  return (
    <AvatarFrame>
      <span style={{ display: "flex", flexShrink: 0 }}>
        <GhostGraphic
          variant={user.avatarVariant ?? "classic"}
          color={user.avatarColor ?? defaultGhostColorForUserId(user.id)}
          size={Math.round(CHAT_AVATAR_SIZE * 1.05)}
          animated={false}
          shadow={false}
        />
      </span>
    </AvatarFrame>
  );
}

// An agent's name that opens its chat, while the agent exists. A span with
// the link role, so it can sit inside the tool-call card's button.
export function AgentLink({
  agentId,
  children,
}: {
  agentId: string | undefined;
  children: ReactNode;
}) {
  const { agents } = useAppState();
  const dispatch = useDispatch();
  if (!agentId || !agents.some((a) => a.id === agentId)) return <>{children}</>;
  const open = (e: {
    stopPropagation: () => void;
    preventDefault: () => void;
  }) => {
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: "focus", agentId });
  };
  return (
    <span
      role="link"
      tabIndex={0}
      data-agent-link={agentId}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(e);
      }}
      style={{
        color: "var(--accent-text)",
        cursor: "pointer",
        textDecoration: "underline",
        textDecorationColor:
          "color-mix(in srgb, currentColor 40%, transparent)",
        textUnderlineOffset: 2,
      }}
    >
      {children}
    </span>
  );
}

// POST /api/agents/<id>/messages: the receiver's id.
export function messageTargetId(req: {
  method: string;
  path: string;
}): string | null {
  if (req.method !== "POST") return null;
  const m = /^\/api\/agents\/([^/]+)\/messages$/.exec(req.path.split("?")[0]);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

// The text of a message to another agent, which its card shows on the
// header row.
export function messageText(req: {
  method: string;
  path: string;
  bodyFields: { key: string; value: string }[] | null;
}): string | null {
  if (!messageTargetId(req)) return null;
  return req.bodyFields?.find((f) => f.key === "text")?.value || null;
}
