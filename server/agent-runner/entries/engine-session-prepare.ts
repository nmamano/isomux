// A session's files linked back from its store and touched, as the agent
// user or the member, before a cwd move (server/engine-session-store.ts
// prepareResume).
import {
  prepareResume,
  type SessionFilesPrepare,
} from "../../engine-session-store.ts";
import { runEntry } from "./io.ts";

await runEntry((input) => prepareResume(input as SessionFilesPrepare));
