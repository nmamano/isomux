// Proves the forwarder holds a renewal open past Bun's own 300 s fetch limit,
// with real curl as the office. Takes about 5.5 minutes, so it is a script and
// not a test. Exit 0 when the late answer arrives intact.
//
//   bun control-plane/deploy/forwarder/long-call-proof.ts

import { RENEW_PATH, startForwarder } from "./forwarder.ts";

const ANSWER_AFTER_MS = 310_000;
const answer = JSON.stringify({ certificate: "PEM" });

const provisioner = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch() {
    await Bun.sleep(ANSWER_AFTER_MS);
    return new Response(answer, {
      headers: { "content-type": "application/json" },
    });
  },
});
const forwarder = startForwarder({
  target: new URL(`http://127.0.0.1:${provisioner.port}`),
  port: 0,
  hostname: "127.0.0.1",
});

const started = Date.now();
const curl = Bun.spawn(
  [
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--max-time",
    "600",
    "--data-binary",
    "{}",
    `http://127.0.0.1:${forwarder.port}${RENEW_PATH}`,
  ],
  { stderr: "pipe" },
);
const [out, err, code] = await Promise.all([
  new Response(curl.stdout).text(),
  new Response(curl.stderr).text(),
  curl.exited,
]);
const seconds = Math.round((Date.now() - started) / 1000);
await forwarder.stop(true);
await provisioner.stop(true);

const ok = code === 0 && err === "" && out === answer;
console.log(
  `${ok ? "ok" : "FAILED"}: curl exit ${code} after ${seconds} s` +
    (ok ? "" : `, stderr ${JSON.stringify(err)}, body ${JSON.stringify(out)}`),
);
process.exit(ok ? 0 : 1);
