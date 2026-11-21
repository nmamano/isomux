// The store of an agent's current engine session, kept as the agent user or
// the member (server/engine-session-store.ts keepSessionFiles).
import {
  keepSessionFiles,
  type KeepInput,
} from "../../engine-session-store.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => keepSessionFiles(input as KeepInput));
