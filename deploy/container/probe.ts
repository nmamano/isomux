// Setup returns 200; the office's unauthenticated gate returns 401. A locked
// office (server/locked-office.ts) answers 503 with X-Isomux-Locked: it is up
// on purpose, so k8s must not restart it.

export {}; // a module, so the top-level await below typechecks
try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT || 10000}/`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    },
  );
  const locked =
    response.status === 503 && response.headers.get("X-Isomux-Locked") === "1";
  process.exit(
    response.status === 200 || response.status === 401 || locked ? 0 : 1,
  );
} catch {
  process.exit(1);
}
