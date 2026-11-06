// How a critical issue's times read: in the issue's time zone and in UTC, so
// a reader in either sees the time without converting it.

function format(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(at));
}

/** "Jan 15, 2030, 1:47 PM PST (Jan 15, 2030, 9:47 PM UTC)". With a UTC
 * issue, the time once. */
export function zonedTime(at: number, timeZone: string): string {
  const local = format(at, timeZone);
  const utc = format(at, "UTC");
  return local === utc ? utc : `${local} (${utc})`;
}

/** Who posted an update, as the customer reads it. */
export function authorText(author: "engineer" | "support_agent"): string {
  return author === "engineer" ? "Isomux engineer" : "Isomux support agent";
}
