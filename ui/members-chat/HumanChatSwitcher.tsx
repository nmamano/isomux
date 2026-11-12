// The title of a human chat where no sidebar lists the chats (a phone): the
// current chat's name, opening a list of Members chat and each other member,
// with online dot, unread badge and, for an owner, a gear to that member's
// settings. Same order as the sidebar (member-rows.ts).
import { useEffect, useRef, useState } from "react";
import { humanChatId, MEMBERS_CHAT, type HumanChatKey } from "../human-chat.ts";
import { useI18n } from "../i18n.tsx";
import { useAppState } from "../store.tsx";
import { noTranslate } from "../no-translate.ts";
import { useDmPeer, useMemberChatRows } from "./member-rows.ts";
import { ChevronDownIcon, GearIcon } from "./icons.tsx";

export interface HumanChatSwitcherProps {
  current: HumanChatKey;
  onSelect: (chat: HumanChatKey) => void;
  onOpenMemberSettings: (userId: string) => void;
}

const optionStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  minHeight: 44,
  padding: "0 12px",
  border: "none",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-primary)",
  font: "inherit",
  fontSize: 15,
  textAlign: "left",
  cursor: "pointer",
};

export function HumanChatSwitcher({
  current,
  onSelect,
  onOpenMemberSettings,
}: HumanChatSwitcherProps) {
  const { t } = useI18n();
  const { sessionContext } = useAppState();
  const peerName = useDmPeer(current.kind === "dm" ? current.peerId : "").name;
  const rows = useMemberChatRows();
  const amOwner = sessionContext?.role === "owner";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const currentId = humanChatId(current);
  const title = current.kind === "members" ? t("membersChat.title") : peerName;
  const pick = (chat: HumanChatKey) => {
    setOpen(false);
    onSelect(chat);
  };
  return (
    <div
      ref={rootRef}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
      style={{ position: "relative", minWidth: 0 }}
    >
      <button
        type="button"
        data-chat-switcher=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("humanChat.switch")}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          padding: "4px 8px",
          border: "1px solid var(--border-subtle)",
          borderRadius: 6,
          background: "var(--btn-surface)",
          color: "var(--text-primary)",
          font: "inherit",
          fontSize: 16,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        <span
          {...noTranslate()}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <span style={{ display: "flex", color: "var(--text-dim)" }}>
          {ChevronDownIcon}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 20,
            minWidth: 240,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "60vh",
            overflowY: "auto",
            padding: 6,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-surface)",
            boxShadow: "0 8px 24px var(--shadow-heavy)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-chat-switcher-option="members"
            aria-current={currentId === "members" ? "true" : undefined}
            onClick={() => pick(MEMBERS_CHAT)}
            style={{
              ...optionStyle,
              background:
                currentId === "members" ? "var(--bg-hover)" : "transparent",
            }}
          >
            <span style={{ width: 10 }} />
            <span style={{ flex: 1 }}>{t("membersChat.title")}</span>
          </button>
          {rows.map((row) => (
            <div
              key={row.id}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <button
                type="button"
                role="menuitem"
                data-chat-switcher-option={row.id}
                aria-current={currentId === row.id ? "true" : undefined}
                onClick={() => pick({ kind: "dm", peerId: row.id })}
                style={{
                  ...optionStyle,
                  flex: 1,
                  opacity: row.removed ? 0.6 : 1,
                  background:
                    currentId === row.id ? "var(--bg-hover)" : "transparent",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: row.online ? "var(--green)" : "var(--text-dim)",
                  }}
                />
                <span
                  {...noTranslate()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: row.unread > 0 ? 700 : 400,
                  }}
                >
                  {row.name}
                </span>
                {row.removed && (
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {t("humanChat.removed")}
                  </span>
                )}
                {row.unread > 0 && (
                  <span
                    style={{
                      minWidth: 20,
                      padding: "1px 6px",
                      borderRadius: 10,
                      background: "var(--red)",
                      color: "white",
                      fontSize: 12,
                      textAlign: "center",
                    }}
                  >
                    {row.unread}
                  </span>
                )}
              </button>
              {amOwner && !row.removed && (
                <button
                  type="button"
                  aria-label={t("humanChat.memberSettings", { name: row.name })}
                  title={t("humanChat.memberSettings", { name: row.name })}
                  onClick={() => {
                    setOpen(false);
                    onOpenMemberSettings(row.id);
                  }}
                  style={{
                    width: 44,
                    height: 44,
                    border: "none",
                    borderRadius: 8,
                    background: "var(--btn-surface)",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {GearIcon}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
