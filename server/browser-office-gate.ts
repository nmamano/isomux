// Browser control may not take an agent to an Isomux office page that the
// member did not offer. Every office response carries this header; the bridge
// learns office origins from it.
export const OFFICE_MARKER_HEADER = "x-isomux-office";

/** The origin of an http(s) URL, or undefined. */
export function httpOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when url is an http(s) page of a known office other than the offer's. */
export function officePageRefused(
  url: string,
  offerOrigin: string | undefined,
  offices: ReadonlySet<string>,
): boolean {
  const origin = httpOrigin(url);
  return (
    origin !== undefined &&
    offices.has(origin) &&
    origin !== (offerOrigin && httpOrigin(offerOrigin))
  );
}

/** The office origins this process knows: the seed, read at each check, and
 * the origins learned from marked responses, oldest dropped past the cap. */
export class OfficeOrigins {
  // A Set keeps insertion order, so its first entry is the oldest.
  private learned = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly seed: () => string[],
    private readonly cap = 1000,
  ) {}

  has(origin: string): boolean {
    const normalized = httpOrigin(origin);
    return normalized !== undefined && this.all().has(normalized);
  }

  /** Learns the origin of url. True when the origin is new. */
  learn(url: string): boolean {
    const origin = httpOrigin(url);
    if (origin === undefined || this.all().has(origin)) return false;
    this.learned.add(origin);
    if (this.learned.size > this.cap)
      this.learned.delete(this.learned.values().next().value!);
    for (const listener of this.listeners) listener();
    return true;
  }

  /** The seed and the learned origins, normalized. */
  all(): ReadonlySet<string> {
    const origins = new Set(this.learned);
    for (const value of this.seed()) {
      const origin = httpOrigin(value);
      if (origin !== undefined) origins.add(origin);
    }
    return origins;
  }

  /** Calls listener after each new origin; returns the unsubscribe. */
  onLearn(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
