// "Changed for you" (task 7a3b4114): on the viewer's own card, the changes
// someone else (an office owner, or an owner's agent) made to this tab's
// settings in the last 30 days, with who made them. The server keeps the
// list (GET /api/me/integration-changes); it never holds a value.

import { useEffect, useState } from "react";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { timeSince } from "../../shared/i18n/time.ts";
import type {
  IntegrationChange,
  IntegrationChangeKind,
  IntegrationChangesRes,
} from "../../shared/contract-shapes.ts";
import type { IntegrationsTab } from "../../shared/office-links.ts";
import { hintText } from "./kit.tsx";

// The kind of change each tab shows.
const TAB_KIND: Partial<Record<IntegrationsTab, IntegrationChangeKind>> = {
  providers: "provider",
  mcp: "mcp",
  secrets: "secret",
  variables: "variable",
  voice: "voice",
  pager: "pager",
};

// The viewer's list, read once for the page. Null until it arrives, and when
// it cannot be read: the list is a notice, so a failure shows nothing.
export function useIntegrationChanges(
  enabled: boolean,
): IntegrationChange[] | null {
  const [items, setItems] = useState<IntegrationChange[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    apiFetch<IntegrationChangesRes>("GET", "/api/me/integration-changes")
      .then((res) => {
        if (live) setItems(res.items);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled]);
  return items;
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
};

export function ChangedForYou({
  tab,
  items,
}: {
  tab: IntegrationsTab;
  items: IntegrationChange[] | null;
}) {
  const { t, language } = useI18n();
  const kind = TAB_KIND[tab];
  const shown = kind ? (items ?? []).filter((item) => item.kind === kind) : [];
  if (shown.length === 0) return null;
  const line = (item: IntegrationChange): string => {
    const name = item.name ?? "";
    // A sign-out names the provider as the server stores it.
    if (item.kind === "provider") {
      const provider = PROVIDER_LABEL[name] ?? name;
      return item.by === null
        ? t("integrations.changes.signedOutUnknown", { provider })
        : t("integrations.changes.signedOut", { by: item.by, provider });
    }
    if (item.by === null) {
      if (!item.name) return t("integrations.changes.changedUnknown");
      return item.action === "removed"
        ? t("integrations.changes.removedUnknown", { name })
        : t("integrations.changes.setUnknown", { name });
    }
    const by = item.by;
    if (!item.name) return t("integrations.changes.changed", { by });
    return item.action === "removed"
      ? t("integrations.changes.removed", { by, name })
      : t("integrations.changes.set", { by, name });
  };
  return (
    <div data-integration-changes="" style={{ margin: "0 0 12px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, margin: "0 0 4px" }}>
        {t("integrations.changes.title")}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {shown.map((item) => {
          const since = timeSince(language, item.time);
          return (
            <li
              key={`${item.time}:${item.kind}:${item.name ?? ""}:${item.action}`}
              data-integration-change=""
              style={hintText}
            >
              {line(item)}{" "}
              <span style={{ color: "var(--text-muted)" }}>
                · {since.kind === "now" ? t("common.justNow") : since.text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
