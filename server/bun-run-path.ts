import { delimiter, dirname, join, resolve } from "path";

// `bun run <file>` prepends <cwd>/node_modules/.bin twice and then the
// node_modules/.bin of every directory above the cwd (bun 1.3.11, checked
// 2026-10-07). The service unit starts the office that way, and every agent
// inherits the server's PATH. Keep the cwd's own entry once, drop the walk
// above it, and drop any other repeated entry.
export function normalizeBunRunPath(path: string, cwd: string): string {
  const root = resolve(cwd);
  const own = join(root, "node_modules", ".bin");
  const walk = new Set<string>();
  for (let dir = root; dirname(dir) !== dir; ) {
    dir = dirname(dir);
    walk.add(join(dir, "node_modules", ".bin"));
  }
  const entries = path.split(delimiter);
  // bun's run starts with the cwd's own entry; without it, nothing here came
  // from bun, and an ancestor entry is the operator's.
  let prefix = 0;
  if (entries[0] === own)
    while (
      prefix < entries.length &&
      (entries[prefix] === own || walk.has(entries[prefix]))
    )
      prefix++;
  const kept = [
    ...entries.slice(0, prefix).filter((entry) => !walk.has(entry)),
    ...entries.slice(prefix),
  ];
  // An empty entry means the current directory; leave those as they are.
  const seen = new Set<string>();
  return kept
    .filter((entry) => {
      if (entry === "") return true;
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(delimiter);
}
