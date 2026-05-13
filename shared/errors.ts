// Narrow an unknown caught value to a readable string.
// `catch (e)` types e as unknown in modern TS; this is the canonical extractor.
// Pass a fallback to use when the underlying message is empty/undefined.
export function errMessage(err: unknown, fallback = ""): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === "string") return err || fallback;
  if (err == null) return fallback;
  try {
    return JSON.stringify(err) || fallback;
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- last-resort fallback for circular/unstringifiable objects; "[object Object]" is acceptable here
    return String(err) || fallback;
  }
}

// Narrow an unknown caught value to an Error-shaped object that exposes `.code`
// (Node fs/syscall errors). Returns undefined if no code is present.
export function errCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}
