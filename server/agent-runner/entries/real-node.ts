// The real Node.js binary on the agent user's PATH (server/real-node.ts).
import { resolveRealNode } from "../../real-node.ts";
import { runEntry } from "./io.ts";

await runEntry(() => ({ path: resolveRealNode() }));
