// Shared by the Codex access tests (task e77304b1).

// Codex reads each key of a thread's `config` map as a dotted path and merges
// it into the effective config (a nested value merges table by table). This
// is that reading, so a test asserts what Codex applies, whichever spelling
// the code uses. Measured on 0.164.0: `mcp_servers.a.b.enabled` is the server
// `a`, not `a.b`; a nested `mcp_servers` next to `mcp_servers.isomux` dropped
// the office server in about half the live runs (task e77304b1).
export function effectiveCodexConfig(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const merge = (
    target: Record<string, unknown>,
    path: string[],
    value: unknown,
  ) => {
    let node = target;
    for (const part of path.slice(0, -1)) {
      const next = node[part];
      if (typeof next !== "object" || next === null || Array.isArray(next))
        node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const existing = node[last];
      if (
        typeof existing !== "object" ||
        existing === null ||
        Array.isArray(existing)
      )
        node[last] = {};
      for (const [k, v] of Object.entries(value))
        merge(node[last] as Record<string, unknown>, [k], v);
    } else {
      node[last] = value;
    }
  };
  // Codex builds the override table from a hash map, so when one key is a
  // dotted prefix of another ("mcp_servers" and "mcp_servers.isomux") the
  // later one wins in no fixed order: the result is not defined.
  const keys = Object.keys(config);
  for (const a of keys)
    for (const b of keys)
      if (b.startsWith(`${a}.`))
        throw new Error(
          `thread config keys "${a}" and "${b}" overlap: Codex applies them in no fixed order`,
        );
  for (const [key, value] of Object.entries(config))
    merge(out, key.split("."), value);
  return out;
}
