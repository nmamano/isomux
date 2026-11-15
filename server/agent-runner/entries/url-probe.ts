// The pre-flight of a preview capture, as the member (server/preview-capture.ts):
// one request to the page with the server's timeout. Any HTTP response is
// reachable; a network failure answers its message, bounded.
import { runEntry } from "./io.ts";
import {
  checkUrlProbeInput,
  URL_PROBE_ERROR_MAX,
} from "../../preview-probe.ts";

await runEntry(async (input) => {
  const { url, timeoutMs } = checkUrlProbeInput(input);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    await res.body?.cancel().catch(() => {});
    return { reachable: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { reachable: false, error: error.slice(0, URL_PROBE_ERROR_MAX) };
  }
});
