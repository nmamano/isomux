// The runner's runtime can differ from the server's path and permissions.
import { runEntry } from "./io.ts";
await runEntry(() => ({ path: process.execPath }));
