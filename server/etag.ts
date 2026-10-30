// If-None-Match against one ETag: weak comparison, as RFC 9110 asks for a
// GET, so W/"x" and "x" match. "*" and comma-separated lists are handled.
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}
