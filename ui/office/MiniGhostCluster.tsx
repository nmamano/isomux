import type { CSSProperties } from "react";
import type { PresenceInfo } from "../../shared/types.ts";
import { GhostGraphic } from "./ghostVariants.tsx";

export function selectMiniGhosts(
  presences: PresenceInfo[],
  selfConnectionId: string | null,
  max: number,
  filter: (presence: PresenceInfo) => boolean = () => true,
): PresenceInfo[] {
  return presences
    .filter(
      (presence) =>
        presence.connectionId !== selfConnectionId && filter(presence),
    )
    .slice(0, max);
}

export function MiniGhostCluster({
  presences,
  selfConnectionId,
  size,
  max,
  overlap,
  filter,
  ghostStyle,
  paintedHitTest = false,
}: {
  presences: PresenceInfo[];
  selfConnectionId: string | null;
  size: number;
  max: number;
  overlap: number;
  filter?: (presence: PresenceInfo) => boolean;
  ghostStyle?: CSSProperties;
  paintedHitTest?: boolean;
}) {
  const visible = selectMiniGhosts(presences, selfConnectionId, max, filter);
  // Collapse completely instead of leaving a zero-width span with hidden
  // hover or focus regions.
  if (visible.length === 0) return null;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        verticalAlign: "middle",
      }}
    >
      {/* One ghost per WS connection. Do not deduplicate by user: another
          device owned by the same person is a separate presence. */}
      {visible.map((presence, index) => {
        const title = presence.device
          ? `${presence.username} (${presence.device})`
          : presence.username;
        return (
          <span
            key={presence.connectionId}
            title={title}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginLeft: index === 0 ? 0 : overlap,
              // Away mode uses the same 40% opacity as the office scene.
              opacity: presence.viewMode === "away" ? 0.4 : 1,
              pointerEvents: paintedHitTest ? "none" : undefined,
              ...ghostStyle,
            }}
          >
            <GhostGraphic
              variant={presence.avatarVariant}
              color={presence.avatarColor}
              size={size}
              animated={false}
              shadow={false}
              hitTestPainted={paintedHitTest}
            />
          </span>
        );
      })}
      {/* There is no +N overflow marker. The caller's cap provides the
          presence signal without letting the cluster consume unbounded room. */}
    </span>
  );
}
