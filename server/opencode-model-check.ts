// The check of each OpenCode agent's model against the model list OpenCode
// reports (the list the model picker reads), at boot and once a day (task
// 73951c9f). It only flags: a member chose the model, so nothing switches it.

export interface OpenCodeModelCheckAgent {
  id: string;
  userId: string | null;
  cwd: string;
  modelFamily: string;
}

// "unknown": the listing failed, or it has no model of the agent's provider
// (the provider is not connected now), so it cannot say the model is gone.
export type OpenCodeModelStatus = "listed" | "gone" | "unknown";

// Above the OpenCode server's start limit (60 s). A catalog load that takes
// longer goes on, and the next check reads what it kept.
export const OPENCODE_MODEL_LISTING_LIMIT_MS = 3 * 60_000;

// The listing holds only connected providers' models, so a model is gone only
// when the listing has a model of its provider and not this id. A listing
// comes from the OpenCode server of the agent's environment, which keeps the
// list it loaded at start: the check reports what that server's turns meet.
// One listing at a time, so a boot check does not start every environment's
// OpenCode server at once.
export async function checkOpenCodeModels(
  agents: readonly OpenCodeModelCheckAgent[],
  listModels: (
    userId: string | null,
    cwd: string,
  ) => Promise<readonly { id: string }[]>,
): Promise<Map<string, OpenCodeModelStatus>> {
  const groups = new Map<
    string,
    { userId: string | null; cwd: string; agents: OpenCodeModelCheckAgent[] }
  >();
  for (const agent of agents) {
    const key = JSON.stringify([agent.userId, agent.cwd]);
    const group = groups.get(key);
    if (group) group.agents.push(agent);
    else
      groups.set(key, {
        userId: agent.userId,
        cwd: agent.cwd,
        agents: [agent],
      });
  }
  const result = new Map<string, OpenCodeModelStatus>();
  for (const group of groups.values()) {
    let ids: Set<string> | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A listing that never answers would stall every group after it.
      const listed = await Promise.race([
        listModels(group.userId, group.cwd),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("OpenCode model listing timed out.")),
            OPENCODE_MODEL_LISTING_LIMIT_MS,
          );
        }),
      ]);
      ids = new Set(listed.map((model) => model.id));
    } catch {
      ids = null;
    } finally {
      clearTimeout(timer);
    }
    for (const agent of group.agents)
      result.set(agent.id, modelStatus(agent.modelFamily, ids));
  }
  return result;
}

function modelStatus(
  model: string,
  ids: ReadonlySet<string> | null,
): OpenCodeModelStatus {
  if (ids === null) return "unknown";
  if (ids.has(model)) return "listed";
  const slash = model.indexOf("/");
  if (slash <= 0) return "unknown";
  const prefix = model.slice(0, slash + 1);
  for (const id of ids) if (id.startsWith(prefix)) return "gone";
  return "unknown";
}
