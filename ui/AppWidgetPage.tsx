import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppWidgetStatus } from "../shared/contract-shapes.ts";
import type { AgentInfo, LogEntry, Attachment } from "../shared/types.ts";
import { MAX_UPLOAD_BYTES } from "../shared/types.ts";
import { AGENT_LINK_PREFIX } from "../shared/office-links.ts";
import { apiFetch } from "./api.ts";
import { useAppState } from "./store.tsx";
import { useI18n } from "./i18n.tsx";
import { CSS } from "./styles.ts";
import {
  ChatTranscript,
  useChatTranscript,
} from "./log-view/ChatTranscript.tsx";
import { LiveCharacter } from "./office/LiveCharacter.tsx";
import { chatVisibleEntries } from "./log-view/chat-entries.ts";
import { OpenIcon } from "./components/AppsView.tsx";
import { readSafariEnv, safariHref } from "./safari-link.ts";
import {
  APP_WIDGET_RECHECK_MS,
  APP_WIDGET_SANDBOX,
  beginAppHandshake,
  isAppSessionSignal,
  widgetDraftKey,
  screenshotHint,
  type AppWidgetBoot,
} from "./app-widget-state.ts";

const WIDGET_CSS = `
.app-widget { position:fixed; inset:0; background:var(--bg-base); color:var(--text-primary); font-family:var(--font-ui); }
.app-widget-frame { border:0; width:100%; height:100%; display:block; }
.app-widget button,.app-widget a { font:inherit; }
.app-widget button { cursor:pointer; border:1px solid var(--border); border-radius:9px; padding:9px 14px; background:var(--bg-surface-solid); color:var(--text-primary); }
.app-widget button:disabled { cursor:default; opacity:.55; }
.app-widget-dock { display:flex; position:fixed; right:20px; bottom:max(20px,env(safe-area-inset-bottom)); z-index:3; border-radius:9px; box-shadow:0 3px 18px #0004; }
.app-widget-launcher { display:flex; align-items:center; gap:8px; }
.app-widget-launcher[aria-expanded="true"] { border-color:var(--accent); color:var(--accent-text); box-shadow:inset 0 0 0 1px var(--accent); }
.app-widget-dock-direct { display:flex; align-items:center; justify-content:center; min-width:40px; min-height:40px; border:1px solid var(--border); border-radius:9px; background:var(--bg-surface-solid); color:var(--text-secondary); }
.app-widget-dock-direct:hover { color:var(--text-primary); }
.app-widget .app-widget-direct { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--text-secondary); white-space:nowrap; }
.app-widget-direct:hover { color:var(--text-primary); }
.app-widget-panel { position:fixed; right:20px; bottom:calc(max(20px,env(safe-area-inset-bottom)) + 76px); z-index:4; width:420px; max-width:calc(100vw - 24px); height:min(680px,78dvh); border:1px solid var(--border); border-radius:14px; background:var(--bg-surface-solid); box-shadow:0 6px 36px #0005; display:flex; flex-direction:column; overflow:hidden; }
.app-widget-header { padding:14px; display:flex; align-items:center; gap:12px; border-bottom:1px solid var(--border); }
.app-widget-header h1 { flex:1; font-size:16px; margin:0; }
.app-widget-header h1 a { color:var(--accent-text); text-decoration:none; }
.app-widget-header h1 a:hover { text-decoration:underline; }
.app-widget-notice { padding:9px 14px; font-size:12px; color:var(--text-secondary); }
.app-widget-log { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:0 12px; }
.app-widget-compose { padding:12px; border-top:1px solid var(--border); }
.app-widget-compose textarea { display:block; resize:vertical; min-height:70px; max-height:150px; width:100%; font:inherit; font-size:16px; border:1px solid var(--border); border-radius:8px; padding:10px; color:var(--text-primary); background:var(--bg-base); }
.app-widget-actions { display:flex; flex-wrap:wrap; gap:8px 10px; align-items:center; margin-top:8px; }
.app-widget-attach { flex:1 1 100%; display:flex; gap:10px; align-items:center; min-width:0; }
.app-widget-send { margin-left:auto; display:flex; gap:10px; align-items:center; }
.app-widget-images:empty { display:none; }
.app-widget-images { display:flex; gap:8px; overflow:auto; max-height:160px; margin-bottom:8px; }
.app-widget-image { flex:0 0 112px; margin:0; font-size:12px; overflow-wrap:anywhere; }
.app-widget-image img { width:104px; height:80px; object-fit:contain; display:block; }
.app-widget-image button { font-size:12px; padding:3px 8px; }
.app-widget-hint { flex:1; min-width:0; font-size:12px; color:var(--text-secondary); margin:0; }
.app-widget-queue { display:inline-block; margin-bottom:8px; padding:3px 10px; border:1px solid var(--accent); border-radius:999px; color:var(--accent-text); font-size:13px; font-weight:600; }
.app-widget-status { font-size:12px; color:var(--text-secondary); }
.app-widget-unavailable { position:fixed; bottom:20px; right:20px; padding:12px; background:var(--bg-surface-solid); border-radius:8px; }
`;

export function AppWidgetPage({
  boot,
  onOpenOffice,
}: {
  boot: AppWidgetBoot;
  onOpenOffice?: (agent: AgentInfo) => void;
}) {
  const { t } = useI18n();
  const state = useAppState();
  const frame = useRef<HTMLIFrameElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const recovering = useRef(false);
  const recoveryStopped = useRef(false);
  const [status, setStatus] = useState<AppWidgetStatus | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);

  const [verified, setVerified] = useState("");
  // State-only agent updates do not force extra readiness requests.
  const accessStamp = JSON.stringify([
    state.hydrationEpoch,
    state.connected,
    state.apps,
    state.rooms,
    [...state.users.values()],
    state.agents.map((agent) => [agent.id, agent.roomId]),
  ]);
  const liveStatus = verified === accessStamp ? status : null;

  const recover = useCallback(
    (url: string) => {
      if (recovering.current || recoveryStopped.current) return;
      if (!beginAppHandshake(sessionStorage, boot, Date.now())) {
        recoveryStopped.current = true;
        ++requestSeq.current;
        setUnavailable(true);
        setStatus(null);
        setFrameUrl(null);
        return;
      }
      recovering.current = true;
      ++requestSeq.current;
      const query = new URLSearchParams({
        app: new URL(url).hostname.split(".")[0],
        mode: "wrapper",
        registration: String(boot.registration),
        r: "/" + window.location.search,
      });
      window.location.assign("/auth/app?" + query.toString());
    },
    [boot],
  );

  const refresh = useCallback(async () => {
    if (
      recoveryStopped.current ||
      recovering.current ||
      document.visibilityState === "hidden"
    )
      return;
    const seq = ++requestSeq.current;
    try {
      const next = await apiFetch<AppWidgetStatus>(
        "GET",
        `/api/apps/${encodeURIComponent(boot.name)}/widget?registration=${boot.registration}`,
      );
      if (seq !== requestSeq.current) return;
      setAppUrl(next.appUrl);
      setVerified(accessStamp);
      if (
        next.sessionExpiresAt === null ||
        next.sessionExpiresAt <= Date.now()
      ) {
        setStatus(null);
        recover(next.appUrl);
        return;
      }
      setStatus(next);
      setUnavailable(false);
      setFrameUrl(next.appUrl + "/" + window.location.search);
    } catch {
      if (seq !== requestSeq.current) return;
      setStatus(null);
      setFrameUrl(null);
      setUnavailable(true);
      setOpen(false);
    }
  }, [boot, accessStamp, recover]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      clearInterval(interval);
      interval = undefined;
      if (document.visibilityState !== "hidden") {
        void refresh();
        interval = setInterval(() => {
          void refresh();
        }, APP_WIDGET_RECHECK_MS);
      }
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      // This scalar invalidates old HTTP responses; it is not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++requestSeq.current;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!status?.sessionExpiresAt) return;
    const timer = setTimeout(
      () => {
        void refresh();
      },
      Math.max(0, status.sessionExpiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [status?.sessionExpiresAt, refresh]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        isAppSessionSignal(event, frame.current?.contentWindow ?? null, appUrl)
      ) {
        recover(appUrl!);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [recover, appUrl]);

  const target = liveStatus?.chat;
  const agent = state.agents.find((item) => item.id === target?.agentId);
  const agentLogs = target ? state.logs.get(target.agentId) : undefined;
  const logs = useMemo(() => chatVisibleEntries(agentLogs ?? []), [agentLogs]);
  const latest = logs.at(-1)?.id;
  const [readMark, setReadMark] = useState<{ agent?: string; latest?: string }>(
    {},
  );
  if (
    readMark.agent !== target?.agentId ||
    (open && readMark.latest !== latest)
  ) {
    setReadMark({ agent: target?.agentId, latest });
  }
  const unread = !open && !!readMark.latest && latest !== readMark.latest;

  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };
  const directHref = appUrl
    ? safariHref(appUrl + "/" + window.location.search, readSafariEnv())
    : null;
  const chatReady = !!target && !!agent;
  // With a chat, only the open panel's header holds the direct link; with no
  // chat, the dock does.
  const dockDirect = !chatReady && directHref;
  return (
    <main
      className="app-widget"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
    >
      <style>{CSS + WIDGET_CSS}</style>
      {frameUrl && (
        <iframe
          ref={frame}
          className="app-widget-frame"
          title={boot.name}
          src={frameUrl}
          sandbox={APP_WIDGET_SANDBOX}
        />
      )}
      {unavailable && (
        <p role="status" className="app-widget-unavailable">
          {t("appWidget.unavailable")}
        </p>
      )}
      {(dockDirect || chatReady) && (
        <div className="app-widget-dock">
          {dockDirect && (
            <a
              className="app-widget-dock-direct"
              href={dockDirect}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("appWidget.direct")}
              title={t("appWidget.direct")}
            >
              <OpenIcon size={16} />
            </a>
          )}
          {target && agent && (
            <button
              ref={launcher}
              className="app-widget-launcher"
              aria-expanded={state.isMobile ? undefined : open}
              aria-controls={state.isMobile ? undefined : "app-widget-chat"}
              onClick={() => {
                if (state.isMobile) {
                  onOpenOffice?.(agent);
                  return;
                }
                setOpen(!open);
                setReadMark({ agent: target?.agentId, latest });
              }}
            >
              <span
                aria-hidden="true"
                className="app-widget-avatar"
                data-agent-id={agent.id}
                data-agent-state={agent.state}
              >
                <LiveCharacter agent={agent} height={36} />
              </span>
              {t("appWidget.launcher")}
              {unread && (
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    marginLeft: 8,
                    borderRadius: "50%",
                    background: "currentColor",
                  }}
                />
              )}
            </button>
          )}
        </div>
      )}
      {target && agent && (
        <>
          {!state.isMobile && (
            <section
              id="app-widget-chat"
              className="app-widget-panel"
              role="dialog"
              aria-label={t("appWidget.title", { agentName: target.agentName })}
              style={{ display: open ? "flex" : "none" }}
              onKeyDown={(event) => {
                if (event.key === "Escape") close();
              }}
            >
              <WidgetChat
                key={widgetDraftKey(boot, target.agentId)}
                boot={boot}
                agent={agent}
                logs={logs}
                stateChangedAt={state.stateChangedAt.get(agent.id)}
                connected={state.connected}
                open={open}
                directHref={directHref}
                onRecheck={() => {
                  void refresh();
                }}
              />
            </section>
          )}
        </>
      )}
    </main>
  );
}

interface WidgetImage {
  id: string;
  name: string;
  attachment?: Attachment;
  error?: "size" | "upload";
}
interface SavedWidgetDraft {
  text: string;
  clientMessageId: string;
  images: WidgetImage[];
}

function readDraft(key: string): SavedWidgetDraft {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(key) ?? "null",
    ) as Partial<SavedWidgetDraft> | null;
    if (
      saved &&
      typeof saved.text === "string" &&
      typeof saved.clientMessageId === "string"
    ) {
      const images = Array.isArray(saved.images)
        ? saved.images.filter(
            (image) =>
              image &&
              typeof image.id === "string" &&
              typeof image.name === "string" &&
              image.attachment &&
              typeof image.attachment.filename === "string" &&
              typeof image.attachment.originalName === "string" &&
              typeof image.attachment.mediaType === "string" &&
              typeof image.attachment.size === "number",
          )
        : [];
      return {
        text: saved.text,
        clientMessageId: saved.clientMessageId,
        images,
      };
    }
  } catch {
    /* A missing or old draft starts empty. */
  }
  return { text: "", clientMessageId: crypto.randomUUID(), images: [] };
}

export function WidgetChat({
  boot,
  agent,
  logs,
  connected,
  open,
  directHref,
  onRecheck,
  stateChangedAt,
}: {
  boot: AppWidgetBoot;
  agent: AgentInfo;
  logs: LogEntry[];
  connected: boolean;
  open: boolean;
  directHref?: string | null;
  onRecheck: () => void;
  stateChangedAt?: number;
}) {
  const { t, rich } = useI18n();
  const transcript = useChatTranscript(
    logs,
    agent.state === "thinking" || agent.state === "tool_executing",
  );
  const key = widgetDraftKey(boot, agent.id);
  const freshDraft = () => ({
    key,
    ...readDraft(key),
    sending: false,
    failed: false,
  });
  const [draft, setDraft] = useState(freshDraft);
  // A target can change through readiness alone, without a parent remount.
  if (draft.key !== key) setDraft(freshDraft());
  const { text, sending, failed } = draft;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // The log follows new entries only while the member is at the bottom, as
  // LogView does. Opening the panel and a sent message return to the bottom.
  const follow = useRef(true);
  const lastScrollTop = useRef(0);
  const wasOpen = useRef(false);
  const scrollToEnd = () => end.current?.scrollIntoView?.({ block: "end" });
  useEffect(() => {
    if (open) textarea.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open && !wasOpen.current) follow.current = true;
    wasOpen.current = open;
    if (open && follow.current) scrollToEnd();
  }, [logs, open]);
  useEffect(() => {
    if (draft.key !== key) return;
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          text: draft.text,
          clientMessageId: draft.clientMessageId,
          images: draft.images.filter((image) => image.attachment),
        }),
      );
    } catch {
      /* Keep the live draft. */
    }
  }, [draft, key]);
  const update = (value: string) => {
    setDraft((current) => ({
      ...current,
      text: value,
      clientMessageId: crypto.randomUUID(),
      failed: false,
    }));
  };
  const removeImage = (id: string) => {
    setDraft((current) => ({
      ...current,
      images: current.images.filter((image) => image.id !== id),
      clientMessageId: crypto.randomUUID(),
      failed: false,
    }));
  };
  const selectImages = (files: File[]) => {
    if (sending) return;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const id = crypto.randomUUID();
      const tooLarge = file.size > MAX_UPLOAD_BYTES;
      setDraft((current) => ({
        ...current,
        clientMessageId: crypto.randomUUID(),
        failed: false,
        images: [
          ...current.images,
          {
            id,
            name: file.name,
            ...(tooLarge ? { error: "size" as const } : {}),
          },
        ],
      }));
      if (tooLarge) continue;
      const form = new FormData();
      form.append("file", file);
      // Both the URL and key are captured before the upload starts.
      void fetch(`/api/upload/${agent.id}`, { method: "POST", body: form })
        .then(async (response) => {
          if (!response.ok) throw new Error("upload");
          const data = (await response.json()) as { attachments: Attachment[] };
          const attachment = data.attachments[0];
          if (!attachment) throw new Error("upload");
          setDraft((current) =>
            current.key === key &&
            current.images.some((image) => image.id === id)
              ? {
                  ...current,
                  images: current.images.map((image) =>
                    image.id === id ? { ...image, attachment } : image,
                  ),
                }
              : current,
          );
        })
        .catch(() => {
          setDraft((current) =>
            current.key === key
              ? {
                  ...current,
                  images: current.images.map((image) =>
                    image.id === id
                      ? { ...image, error: "upload" as const }
                      : image,
                  ),
                }
              : current,
          );
        });
    }
  };
  const pendingImages = draft.images.some((image) => !image.attachment);
  const busy = agent.state === "thinking" || agent.state === "tool_executing";
  const send = async () => {
    if (
      draft.key !== key ||
      (!text.trim() && draft.images.length === 0) ||
      pendingImages ||
      sending ||
      !connected
    )
      return;
    setDraft({ ...draft, sending: true, failed: false });
    try {
      await apiFetch("POST", `/api/agents/${agent.id}/messages`, {
        text,
        clientMessageId: draft.clientMessageId,
        appContext: boot,
        attachments: draft.images.map((image) => image.attachment!),
      });
      const next = {
        key,
        text: "",
        clientMessageId: crypto.randomUUID(),
        images: [],
        sending: false,
        failed: false,
      };
      setDraft((current) => (current.key === key ? next : current));
      follow.current = true;
      scrollToEnd();
    } catch {
      setDraft((current) =>
        current.key === key
          ? { ...current, sending: false, failed: true }
          : current,
      );
      onRecheck();
    }
  };
  return (
    <div
      className="app-widget-chat-content"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        selectImages(Array.from(event.dataTransfer.files));
      }}
      onPaste={(event) => {
        const images = Array.from(event.clipboardData.items)
          .filter(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (images.length) {
          event.preventDefault();
          selectImages(images);
        }
      }}
    >
      <header className="app-widget-header">
        <span
          aria-hidden="true"
          className="app-widget-avatar"
          data-agent-id={agent.id}
          data-agent-state={agent.state}
        >
          <LiveCharacter agent={agent} height={44} />
        </span>
        <h1>
          {rich("appWidget.title", {
            // The agent's chat in the office, on the same origin as this page.
            agentName: (
              <a
                href={`${AGENT_LINK_PREFIX}${agent.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {agent.name}
              </a>
            ),
          })}
        </h1>
        {directHref && (
          <a
            className="app-widget-direct"
            href={directHref}
            target="_blank"
            rel="noopener noreferrer"
          >
            <OpenIcon />
            {t("appWidget.direct")}
          </a>
        )}
      </header>
      <p className="app-widget-notice">{t("appWidget.notice")}</p>
      <div
        className="app-widget-log"
        role="log"
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          // Only a move up leaves the bottom; content that grew under a
          // pinned view widens the gap without a move.
          const movedUp = scrollTop < lastScrollTop.current;
          lastScrollTop.current = scrollTop;
          follow.current =
            scrollHeight - scrollTop - clientHeight < 50 ||
            (follow.current && !movedUp);
        }}
      >
        <ChatTranscript
          logs={logs}
          view={transcript}
          isMobile={false}
          activity={{ state: agent.state, stateChangedAt }}
        />
        <div ref={end} />
      </div>
      <form
        className="app-widget-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {agent.queue?.length ? (
          <div className="app-widget-queue" role="status">
            {t("logView.queue.count", { count: agent.queue.length })}
          </div>
        ) : null}
        <div className="app-widget-images">
          {draft.images.map((image) => (
            <figure className="app-widget-image" key={image.id}>
              {image.attachment && (
                <img
                  src={`/api/files/${agent.id}/${encodeURIComponent(image.attachment.filename)}`}
                  alt={image.name}
                />
              )}
              <figcaption>{image.name}</figcaption>
              {!image.attachment && (
                <span role="status">
                  {image.error === "size"
                    ? t("logView.attachTooLarge")
                    : image.error
                      ? t("membersChat.uploadFailed")
                      : t("logView.attachUploading")}
                </span>
              )}
              <button
                type="button"
                disabled={sending}
                onClick={() => removeImage(image.id)}
              >
                {t("settings.env.remove")}
              </button>
            </figure>
          ))}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            selectImages(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <textarea
          ref={textarea}
          aria-label={t("logView.composer.typeShort")}
          placeholder={t("logView.composer.typeShort")}
          value={text}
          disabled={sending}
          onChange={(event) => {
            update(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !window.matchMedia("(pointer: coarse)").matches
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="app-widget-actions">
          <div className="app-widget-attach">
            <button
              type="button"
              disabled={sending}
              onClick={() => fileInput.current?.click()}
            >
              {t("appWidget.attach")}
            </button>
            <p className="app-widget-hint">
              {t(
                screenshotHint(
                  navigator.platform,
                  navigator.userAgent,
                  navigator.maxTouchPoints,
                ),
              )}
            </p>
          </div>
          <div className="app-widget-send">
            <span className="app-widget-status" role="status">
              {!connected
                ? t("app.reconnecting")
                : failed
                  ? t("logView.outbox.notSent")
                  : ""}
            </span>
            <button
              type="submit"
              disabled={
                !connected ||
                sending ||
                pendingImages ||
                (!text.trim() && draft.images.length === 0)
              }
            >
              {busy ? t("logView.composer.queue") : t("common.send")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
