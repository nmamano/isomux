// The apps an agent made when its manager changes (task cf032293): each app
// the agent made that the old manager owns moves to the new manager, except
// those in keepApps (a host move whose new host must not run them). A moved
// app reads only its new owner's personal secrets, so its grants leave the
// old manager's secrets. The ids go to the manager change's audit row.

import type { AppRecord } from "../shared/types.ts";
import { errMessage } from "../shared/errors.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import type { AppGrant } from "./secret-store.ts";
import type { ManagerMoveRequests } from "./secret-requests.ts";

export interface AppOwnerMoveDeps {
  listApps: () => AppRecord[];
  updateOwner: (
    name: string,
    owner: { userId: string; username: string },
  ) => void;
  // The names of the secrets in `userId`'s scope that lost the grant.
  releaseApp: (userId: string, grant: AppGrant) => string[];
  // An id for the audit row of the manager change (noteAuditTarget).
  noteTarget: (id: string) => void;
  log?: (line: string) => void;
}

export interface AppOwnerMove {
  // The apps whose record names the new manager now.
  moved: AppRecord[];
  // Per moved app, the secret names it lost in the old manager's scope.
  released: { app: string; names: string[] }[];
}

export function moveAgentApps(
  deps: AppOwnerMoveDeps,
  input: {
    agentId: string;
    from: string | null;
    to: { id: string; name: string };
    keepApps: ReadonlySet<string>;
  },
): AppOwnerMove {
  const { agentId, from, to, keepApps } = input;
  const log = deps.log ?? ((line: string) => console.error(line));
  const candidates = deps
    .listApps()
    .filter(
      (app) =>
        app.createdByAgentId === agentId &&
        app.userId === from &&
        !keepApps.has(app.name),
    );
  for (const app of candidates) {
    try {
      deps.updateOwner(app.name, { userId: to.id, username: to.name });
    } catch (err) {
      log(
        `[manager] the app ${app.name} of ${agentId} did not move: ${errMessage(err)}`,
      );
    }
  }
  // The registry decides what moved: an update that threw or changed
  // nothing leaves the app, and its secrets, with the old manager.
  const after = deps.listApps();
  const moved = candidates.flatMap((app) => {
    const live = after.find(
      (a) => a.name === app.name && a.createdAt === app.createdAt,
    );
    return live && live.userId === to.id ? [live] : [];
  });
  const released: AppOwnerMove["released"] = [];
  for (const app of moved) {
    deps.noteTarget(app.name);
    if (from === null) continue;
    let names: string[] = [];
    try {
      names = deps.releaseApp(from, {
        name: app.name,
        createdAt: app.createdAt,
      });
    } catch (err) {
      log(
        `[manager] the secrets of ${from} could not release the app ${app.name}: ${errMessage(err)}`,
      );
    }
    for (const name of names) deps.noteTarget(name);
    released.push({ app: app.name, names });
  }
  return { moved, released };
}

// The agent's note on what a manager change did to its apps' secrets and its
// requests: `member` is the new manager, `previous` the old one. Empty when
// nothing changed.
export function managerMoveNote(
  member: string,
  previous: string,
  apps: AppOwnerMove,
  requests: ManagerMoveRequests,
): LogMessage[] {
  const note: LogMessage[] = [];
  for (const { app, names } of apps.released)
    if (names.length > 0)
      note.push(
        msg("systemEntries.managerMove.released", {
          app,
          member,
          previous,
          names: names.join(", "),
        }),
      );
  if (requests.reopened.length > 0)
    note.push(
      msg("systemEntries.managerMove.reopened", {
        member,
        names: requests.reopened.map((r) => r.name).join(", "),
      }),
    );
  for (const { name, app, code } of requests.notReopened)
    note.push(
      app !== undefined
        ? msg("systemEntries.managerMove.giveApp", { member, app, name })
        : code === "secret_exists" ||
            code === "variable_exists" ||
            code === "mcp_server_exists"
          ? msg("systemEntries.managerMove.usesOwn", { member, name })
          : msg("systemEntries.managerMove.notReopened", { name }),
    );
  if (requests.passOn.length > 0)
    note.push(
      msg("systemEntries.managerMove.passOn", {
        previous,
        names: requests.passOn.map((r) => r.name).join(", "),
      }),
    );
  if (requests.withdrawnBot)
    note.push(msg("systemEntries.managerMove.botWithdrawn", { previous }));
  return note;
}
