// Setup returns 200; the office's unauthenticated gate returns 401.
try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT || 10000}/`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    },
  );
  process.exit(response.status === 200 || response.status === 401 ? 0 : 1);
} catch {
  process.exit(1);
}
