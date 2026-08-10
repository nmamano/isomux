// The Apps tab - agent-built web apps isomux runs and keeps running. Beside
// Cronjobs, which is the precedent for "a thing isomux runs that is not an
// agent" (internal-docs/agent-apps-design.md).
//
// A VIEWER PLUS VERBS: no register form and no edit form here. Agents register
// apps through the API, and this tab is where a human watches them and takes
// them in hand - start, stop, restart, read the log, delete one.
//
// TWO SOURCES OF TRUTH, DELIBERATELY. The app_upserted / app_deleted deltas
// carry anything isomux itself did, immediately. But systemd restarting a
// crash-looping app is not something isomux is told about - the restart count
// only moves when somebody asks - so the list is also re-fetched every few
// seconds WHILE THIS TAB IS OPEN, and never when it is closed. The fetch
// replaces the slice; the deltas patch it; both converge.

import { useEffect, useRef, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { AppState, AppWire } from "../../shared/types.ts";

// How often the open tab re-asks for the list. The server caches app state for
// 1500ms behind the supervisor seam, so several open tabs cost at most one
// systemd read per cache window rather than one per tab per tick.
const POLL_MS = 5000;

/**
 * Should a response that has just come back be allowed to write to the shared
 * state it was fetched for? Extracted and exported because the UI has no React
 * render harness (see CronjobRunView.test.ts) and this is the whole of the
 * race: a request is only allowed to land if nothing has moved on since it was
 * issued.
 *
 * `gen` rules out a superseded request (a second click, a close, an unmount);
 * `target` rules out a response arriving under a DIFFERENT row than the one it
 * was asked for - the case where A's journal would briefly appear under B.
 * A null current target means nothing is open, so nothing may be written.
 */
export function shouldCommit(
  issuedGen: number,
  currentGen: number,
  issuedTarget: string,
  currentTarget: string | null,
): boolean {
  return issuedGen === currentGen && issuedTarget === currentTarget;
}

/**
 * How long to wait before the next poll, or null to stop entirely. Exported for
 * the same reason as shouldCommit: this is the decision that keeps a cancelled
 * polling loop from rescheduling itself, and it is worth pinning even though the
 * lifetime it belongs to (a local `let` per effect run, NOT a ref) can only be
 * shown structurally without a React render harness.
 */
export function nextPollDelay(
  cancelled: boolean,
  landed: boolean,
): number | null {
  if (cancelled) return null;
  return landed ? POLL_MS : 0;
}

// Tailscale's MagicDNS namespace. An office served at a tailnet name answers on
// HTTPS, so the browser upgrades an http link built from that name (cached HSTS
// or auto-upgrade) and it never reaches an app port serving plain http. The
// node's SHORT name carries no https history and resolves on the tailnet, so a
// port link is built from it instead.
//
// The suffix is matched on the LABEL boundary - the same rule as isTailnetName
// in server/app-domain.ts - so `myts.net` and `ts.net.example.com` are ordinary
// domains. The classification is deliberately not identical: that one counts
// the bare apex as tailnet to refuse deriving children, while here the apex
// carries no node label to shorten to, so it is left unchanged.
const TAILNET_SUFFIX = "ts.net";

function portLinkHost(officeHostname: string): string {
  const host = officeHostname.toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(`.${TAILNET_SUFFIX}`)) return officeHostname;
  const node = host.slice(0, host.indexOf("."));
  return node || officeHostname;
}

/**
 * Where the app's name links to. `url` is the office's own answer - the full
 * https origin the app answers on, present exactly when the office has app
 * hostnames at all - so it is used verbatim and nothing about it is derived
 * here. Without one, the link stays what it has always been: this office's
 * host with the app's port, which only reaches the app from inside the box's
 * network - shortened to the node name on a tailnet office, where the long
 * name would be upgraded to https (see portLinkHost). Every other hostname is
 * passed through unchanged.
 *
 * The empty-string check is a boundary fail-safe, not a contract: the wire
 * omits `url` rather than sending "", and an empty href would silently link
 * the row to the page it is already on.
 */
export function appHref(
  app: Pick<AppWire, "url" | "port">,
  officeHostname: string,
): string {
  if (typeof app.url === "string" && app.url !== "") return app.url;
  return `http://${portLinkHost(officeHostname)}:${app.port}/`;
}

const STATE_COLOR: Record<AppState, string> = {
  running: "var(--green)",
  starting: "var(--orange, #d29922)",
  stopped: "var(--text-muted)",
  failed: "var(--red)",
  unknown: "var(--text-muted)",
};

// A drawn dot, not a glyph: iOS Safari emoji-renders characters like ● and ▶
// and then ignores the CSS color, which would make `failed` and `running` look
// identical on a phone.
function StateDot({ state }: { state: AppState }) {
  const hollow = state === "unknown";
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        flexShrink: 0,
        background: hollow ? "transparent" : STATE_COLOR[state],
        border: hollow ? "1.5px solid var(--text-muted)" : "none",
      }}
    />
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--text-dim, var(--text-muted))" }}>
        {label}{" "}
      </span>
      <span style={{ color: "var(--text-secondary)" }}>{value}</span>
    </span>
  );
}

/**
 * The live agent behind an app's `created by`, or null when there is nothing to
 * open - a human registered it, or its agent is gone.
 *
 * A record that names an agent id is answered by that id ALONE. A dead id gets
 * nothing rather than the agent that now holds the same nameplate: a successor
 * did not register the app, and the row states who did. The same rule already
 * governs the app-to-agent message route, which answers a gone target with
 * `target_gone` instead of picking another agent (server/routes/handlers/apps.ts).
 *
 * The name match is for records with no id at all - written before the field
 * existed, or registered by a person - where a name is the only attribution
 * there is. That is the rule the task board resolves its own names by.
 */
export function resolveCreatorAgentId(
  app: Pick<AppWire, "createdBy" | "createdByAgentId">,
  agents: readonly { id: string; name: string }[],
): string | null {
  if (app.createdByAgentId !== undefined) {
    const byId = agents.find((a) => a.id === app.createdByAgentId);
    return byId ? byId.id : null;
  }
  const byName = agents.find(
    (a) => a.name.toLowerCase() === app.createdBy.toLowerCase(),
  );
  return byName ? byName.id : null;
}

// A link, not a button-shaped control: the same accent-and-underline affordance
// the task board gives an agent name. A real <button> rather than the task
// board's <span> so it is reachable by keyboard.
const agentLinkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  color: "var(--accent)",
  cursor: "pointer",
  textDecoration: "none",
};

export function AppsView({
  onClose,
  onFocusAgent,
}: {
  onClose: () => void;
  onFocusAgent?: (agentId: string) => void;
}) {
  const { apps, appsLoaded, appsRevision, isMobile, hydrationEpoch, agents } =
    useAppState();
  const dispatch = useDispatch();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AppWire | null>(null);
  const [openLogs, setOpenLogs] = useState<string | null>(null);
  // Moves when the USER changes what the log pane is showing - opening a row,
  // closing one, deleting the open one - so a request in flight can tell that it
  // no longer speaks for what is on screen.
  //
  // Deliberately NOT touched by any lifecycle event. Coupling it to the polling
  // effect's cleanup meant a rehydrate (which restarts that effect while the tab
  // and its open pane stay mounted) invalidated a pending log request that
  // nothing would then re-issue, stranding the pane on "Loading…" forever. An
  // unmount needs no bump either: the component is gone, so its setState is a
  // no-op, and inventing a lifecycle bump is what created the bug.
  const logGenRef = useRef(0);
  const openLogsRef = useRef<string | null>(null);
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  // Mirrors the store's app revision so the async poll body reads the CURRENT
  // value rather than the one captured when its closure was created.
  const revisionRef = useRef(appsRevision);

  // Both refs sync in effects rather than during render (writing a ref while
  // rendering is the anti-pattern the lint rule names). Neither has to be exact
  // at every instant:
  //   - openLogsRef is also set imperatively by toggleLogs, which is what the
  //     in-flight request actually races against; this only backstops it.
  //   - revisionRef lagging by a commit can only make the poll capture a value
  //     that is too LOW, and the reducer then refuses a snapshot it might have
  //     accepted. Refusing a good snapshot costs a re-fetch; accepting a stale
  //     one is the bug.
  useEffect(() => {
    openLogsRef.current = openLogs;
  }, [openLogs]);
  useEffect(() => {
    revisionRef.current = appsRevision;
  }, [appsRevision]);

  // Fetch on mount and on every rehydration, then poll while open.
  //
  // hydrationEpoch, NOT `connected`: ws.ts reconnects a frozen mobile socket
  // without the connected flag ever going false, so an effect keyed on that
  // edge would silently never re-run and this list would sit on whatever it
  // held before the gap.
  //
  // `cancelled` is a LOCAL of each effect run, not a ref, and that is the whole
  // point. A shared ref cannot name a lifecycle: on a rehydrate the outgoing
  // cleanup would clear it and the incoming effect would immediately set it
  // again, so the outgoing loop - still awaiting its fetch - would wake up, see
  // a live flag, and schedule itself alongside the new one. Every rehydrate
  // would leave another poll loop running. A local can only ever be cancelled.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // SINGLE FLIGHT: the next fetch is scheduled when the last one finishes,
    // never on a fixed interval. Against a sick systemd, where a list can take
    // longer than the poll period, an interval would pile up requests that are
    // all obsolete before they land.
    const tick = async () => {
      // The revision AS OF THE REQUEST. Anything the deltas do while this is in
      // flight moves it, and the reducer then refuses this now-older snapshot.
      const revision = revisionRef.current;
      let landed = true;
      try {
        const list = await apiFetch<AppWire[]>("GET", "/api/apps");
        if (cancelled) return;
        dispatch({ type: "apps_loaded", apps: list, revision });
        setError(null);
        // A snapshot beaten by a delta is refused by the reducer, so come back
        // for a current one instead of leaving the list short for a full tick.
        landed = revision === revisionRef.current;
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err.message : "Could not load apps.",
        );
      }
      const delay = nextPollDelay(cancelled, landed);
      if (delay === null) return;
      timer = setTimeout(() => void tick(), delay);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [dispatch, hydrationEpoch]);

  async function act(name: string, verb: "start" | "stop" | "restart") {
    setBusy(`${name}:${verb}`);
    setError(null);
    try {
      // The response is the app's fresh state, and the same wire object reaches
      // every other open tab as a delta - so nothing here has to re-fetch.
      const app = await apiFetch<AppWire>(
        "POST",
        `/api/apps/${encodeURIComponent(name)}/${verb}`,
      );
      dispatch({ type: "app_upserted", app });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not ${verb}.`);
    } finally {
      setBusy(null);
    }
  }

  async function doDelete(app: AppWire) {
    setBusy(`${app.name}:delete`);
    setError(null);
    try {
      await apiFetch("DELETE", `/api/apps/${encodeURIComponent(app.name)}`);
      dispatch({ type: "app_deleted", name: app.name });
      setConfirmDelete(null);
      if (openLogs === app.name) {
        logGenRef.current++;
        setOpenLogs(null);
        openLogsRef.current = null;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleLogs(name: string) {
    // Bumped BEFORE the close returns as well, so a request issued for the row
    // being closed cannot populate the pane a later row opens.
    const gen = ++logGenRef.current;
    if (openLogs === name) {
      setOpenLogs(null);
      openLogsRef.current = null;
      return;
    }
    setOpenLogs(name);
    openLogsRef.current = name;
    setLogLines(null);
    setLogError(null);
    try {
      const res = await apiFetch<{ name: string; lines: string[] }>(
        "GET",
        `/api/apps/${encodeURIComponent(name)}/logs`,
      );
      if (!shouldCommit(gen, logGenRef.current, name, openLogsRef.current)) {
        return;
      }
      setLogLines(res.lines);
    } catch (err) {
      if (!shouldCommit(gen, logGenRef.current, name, openLogsRef.current)) {
        return;
      }
      setLogError(
        err instanceof ApiError ? err.message : "Could not read the log.",
      );
    }
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && confirmDelete) {
        e.stopPropagation();
        setConfirmDelete(null);
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [confirmDelete]);

  const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      style={{
        height: isMobile ? "100dvh" : "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {/* minHeight (not height) so the safe-area padding extends the bar below
          the notch instead of squashing its contents. */}
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
          aria-label="Back"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: "2px 8px",
          }}
        >
          ←
        </button>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Apps</div>
        <div
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {appsLoaded ? `${sorted.length}` : ""}
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--bg-subtle)",
            borderBottom: "1px solid var(--border-subtle)",
            color: "var(--red)",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? 12 : 20 }}>
        {!appsLoaded ? null : sorted.length === 0 ? (
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: 13,
              padding: "24px 4px",
            }}
          >
            No apps yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sorted.map((app) => {
              const isBusy = busy?.startsWith(`${app.name}:`) ?? false;
              const creatorAgentId = onFocusAgent
                ? resolveCreatorAgentId(app, agents)
                : null;
              return (
                <div
                  key={app.name}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    background: "var(--bg-subtle)",
                    padding: isMobile ? 12 : 14,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <StateDot state={app.state} />
                    {/* An app with a hostname links to it; see appHref. */}
                    <a
                      href={appHref(app, window.location.hostname)}
                      target="_blank"
                      rel="noreferrer"
                      title="Open the app"
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                      }}
                    >
                      {app.name}
                    </a>
                    <span
                      style={{
                        fontSize: 11,
                        color: STATE_COLOR[app.state],
                        textTransform: "lowercase",
                      }}
                    >
                      {app.state}
                    </span>
                  </div>

                  {app.description && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        color: "var(--text-secondary)",
                      }}
                    >
                      {app.description}
                    </div>
                  )}

                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      gap: 14,
                      flexWrap: "wrap",
                      fontSize: 11,
                    }}
                  >
                    <Meta label="port" value={String(app.port)} />
                    <Meta label="restarts" value={String(app.restartCount)} />
                    {/* The creator opens its conversation when it is still an
                        agent of this office; otherwise it stays plain text. */}
                    <Meta
                      label="created by"
                      value={
                        creatorAgentId !== null ? (
                          <button
                            type="button"
                            title="Open the agent"
                            onClick={() => onFocusAgent?.(creatorAgentId)}
                            style={agentLinkStyle}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.textDecoration =
                                "underline")
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.textDecoration = "none")
                            }
                          >
                            {app.createdBy}
                          </button>
                        ) : (
                          app.createdBy
                        )
                      }
                    />
                    {app.username && (
                      <Meta label="owner" value={app.username} />
                    )}
                  </div>

                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono, monospace)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {app.command}
                    <span style={{ opacity: 0.7 }}> in {app.cwd}</span>
                  </div>

                  {/* Presence only. startError is in-memory on the server, so
                      its absence proves nothing and this never renders an
                      all-clear - `state` is the durable signal. */}
                  {app.startError && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: "6px 8px",
                        borderRadius: 6,
                        background: "var(--bg-code, var(--bg-base))",
                        color: "var(--red)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono, monospace)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {app.startError}
                    </div>
                  )}

                  <div
                    style={{
                      marginTop: 10,
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    {(["start", "stop", "restart"] as const).map((verb) => {
                      const inert = isBusy || verbInert(verb, app.state);
                      return (
                        <button
                          key={verb}
                          title={VERB_TITLES[verb]}
                          disabled={inert}
                          onClick={() => void act(app.name, verb)}
                          style={btnStyle(false, inert)}
                        >
                          {verb}
                        </button>
                      );
                    })}
                    <button
                      title="Show the app's recent output"
                      disabled={isBusy}
                      onClick={() => void toggleLogs(app.name)}
                      style={btnStyle(false, isBusy)}
                    >
                      {openLogs === app.name ? "hide log" : "log"}
                    </button>
                    <button
                      title="Remove the app"
                      disabled={isBusy}
                      onClick={() => setConfirmDelete(app)}
                      style={btnStyle(true, isBusy)}
                    >
                      delete
                    </button>
                  </div>

                  {openLogs === app.name && (
                    <pre
                      style={{
                        marginTop: 10,
                        marginBottom: 0,
                        padding: 10,
                        borderRadius: 6,
                        background: "var(--bg-code, var(--bg-base))",
                        border: "1px solid var(--border-subtle)",
                        color: "var(--text-secondary)",
                        fontSize: 11,
                        maxHeight: 260,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {logError ??
                        (logLines === null
                          ? "Loading…"
                          : logLines.length === 0
                            ? "Nothing in the log yet."
                            : logLines.join("\n"))}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmDelete && (
        <div
          onClick={() => setConfirmDelete(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-base)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 18,
              maxWidth: 420,
              width: "100%",
            }}
          >
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              Delete {confirmDelete.name}? Its data directory will be kept.
            </div>
            <div
              style={{
                marginTop: 16,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setConfirmDelete(null)}
                style={btnStyle(false, false)}
              >
                cancel
              </button>
              <button
                disabled={busy !== null}
                onClick={() => void doDelete(confirmDelete)}
                style={btnStyle(true, busy !== null)}
              >
                delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const VERB_TITLES = {
  start: "Run the app",
  stop: "Shut the app down (its data is kept)",
  restart: "Stop the app and start it again",
} as const;

// A verb that cannot change the app's current state renders disabled: "start"
// on a running app reads as a bug even though systemd would no-op it. State
// can be up to one poll (5s) stale, so this is an affordance, not a guard -
// "unknown" leaves every verb enabled. "restart" stays enabled on a failed
// app because it is the recovery verb.
function verbInert(
  verb: "start" | "stop" | "restart",
  state: AppState,
): boolean {
  switch (state) {
    case "running":
    case "starting":
      return verb === "start";
    case "stopped":
      return verb !== "start";
    case "failed":
      return verb === "stop";
    case "unknown":
      return false;
  }
}

function btnStyle(danger: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: `1px solid ${danger ? "var(--red)" : "var(--border)"}`,
    background: "transparent",
    color: danger ? "var(--red)" : "var(--text-secondary)",
    fontSize: 11,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
