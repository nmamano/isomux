// Ask ids in chat text (task 84aadfab). An 8-hex id that is not one of the
// reader's tasks is tried as an ask: first the store's open asks (asks and
// othersAsks), then one GET /api/asks/:askId per id per page load, open or
// closed, with the reach of the ask agent's logs. A resolved id is a chip with
// the task chip's look (task-links.tsx) that opens the ask in the Inbox, pinned
// above the Asks list.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Translator } from "../../shared/i18n/translate.ts";
import type { AskMemberWire } from "../../shared/types.ts";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { askSubject } from "../members-chat/one-line-text.ts";
import { noTranslate } from "../no-translate.ts";
import { useAppState } from "../store.tsx";

/** An ask an id in chat text names, as far as the chip needs it. */
export interface ResolvedAsk {
  id: string;
  agentId: string;
  prompt: string;
  closed: boolean;
}

export interface AskRefsValue {
  /** The ask an id names: the ask, null when it is not an ask the reader can
   *  see, undefined while not known yet. */
  resolve(id: string): ResolvedAsk | null | undefined;
  /** Look up the ids not known yet; each at most once per page load. */
  request(ids: readonly string[]): void;
  /** Open the ask in the Inbox, pinned above the Asks list. */
  open(id: string): void;
  /** Changes when a lookup settles or the store's asks change. */
  version: number;
}

// App provides it; with none, ids stay plain text.
export const AskRefs = createContext<AskRefsValue | null>(null);

// The lookups of this page load. An id is read once: a 404, a 403 or a
// network error is null. The store's open asks win over this cache, so an
// ask that opens after a null still chips.
const MAX_READS = 4;
const looked = new Map<string, ResolvedAsk | null>();
const reading = new Set<string>();
const queued: string[] = [];
const listeners = new Set<() => void>();

function pump() {
  while (reading.size < MAX_READS && queued.length > 0) {
    const id = queued.shift()!;
    reading.add(id);
    apiFetch<{ agentId: string; prompt: string; closed?: unknown }>(
      "GET",
      `/api/asks/${id}`,
    )
      .then(
        (ask) =>
          looked.set(id, {
            id,
            agentId: ask.agentId,
            prompt: ask.prompt,
            closed: ask.closed !== undefined,
          }),
        () => looked.set(id, null),
      )
      .finally(() => {
        reading.delete(id);
        for (const listener of listeners) listener();
        pump();
      });
  }
}

function lookUp(ids: readonly string[]) {
  for (const id of ids)
    if (!looked.has(id) && !reading.has(id) && !queued.includes(id))
      queued.push(id);
  pump();
}

const openAsk = (ask: AskMemberWire): ResolvedAsk => ({
  id: ask.id,
  agentId: ask.agentId,
  prompt: ask.prompt,
  closed: false,
});

/** App's AskRefs, from the store's asks and the lookup cache. A settled read
 *  re-renders only the context's readers, not App. */
export function AskRefsProvider({
  open,
  children,
}: {
  open: (id: string) => void;
  children: ReactNode;
}) {
  const { asks, othersAsks } = useAppState();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const local = useMemo(
    () =>
      new Map(
        [...othersAsks, ...asks].map((ask) => [ask.id, openAsk(ask)] as const),
      ),
    [asks, othersAsks],
  );
  const value = useMemo<AskRefsValue>(
    () => ({
      resolve: (id) => local.get(id) ?? looked.get(id),
      request: (ids) => lookUp(ids.filter((id) => !local.has(id))),
      open,
      version,
    }),
    [local, open, version],
  );
  return <AskRefs.Provider value={value}>{children}</AskRefs.Provider>;
}

/** The chip's title: the ask's subject line in plain text. */
export function askChipTitle(ask: ResolvedAsk): string {
  return askSubject(ask.prompt);
}

/** The chip's suffix after the id, as the task chip's data-task-label. */
export function askChipSuffix(t: Translator["t"], ask: ResolvedAsk): string {
  const words = askChipTitle(ask).split(/\s+/).filter(Boolean);
  const start = words.slice(0, 4).join(" ");
  return ` ${t("asks.chip", { words: words.length > 4 ? `${start}…` : start })}`;
}

/** An id in plain chat text that no task resolves: an ask chip once it
 *  resolves to an ask, else the id as plain text. */
export function AskIdText({ id }: { id: string }) {
  const refs = useContext(AskRefs);
  const { t } = useI18n();
  const ask = refs?.resolve(id);
  useEffect(() => {
    if (refs && refs.resolve(id) === undefined) refs.request([id]);
  }, [refs, id]);
  if (!refs || !ask) return <>{id}</>;
  const suffix = askChipSuffix(t, ask);
  return (
    <button
      type="button"
      {...noTranslate("task-id-chip")}
      title={askChipTitle(ask)}
      aria-label={`${id}${suffix}`}
      data-chip-id={id}
      data-ask-chip={id}
      data-task-label={suffix}
      onClick={() => refs.open(id)}
    >
      {id}
    </button>
  );
}
