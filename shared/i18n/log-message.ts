// Log text as a message key and its values, not as finished words (task
// c37a7365). The server writes a system line once and every reader of that
// agent sees it, so the line cannot be worded in one person's language. A
// writer hands the log funnel a LogText; the funnel stores the English render
// as `content` (what agents and log search read) and the parts as `message`,
// and each member's UI words the parts in that member's language.
//
// Pure and React-free, like translate.ts: the server renders English with it,
// the UI renders the reader's language.

import { formatBytes, formatDecimal, formatNumber } from "./number.ts";
import {
  formatDateTime,
  isDateShape,
  timeSince,
  timeUntilFine,
  type DateShape,
} from "./time.ts";
import {
  CATALOGS,
  pluralFormKeyFor,
  translatorFor,
  type EnglishText,
  type MessageKey,
  type Messages,
  type Placeholders,
  type PluralKey,
  type Translator,
} from "./translate.ts";

/** One value for a `{name}` placeholder, kept as data until a reader words it. */
export type LogParam =
  // Shown as it is: a path, a command, a name, a code.
  | string
  // Shown as String(n): an exit code or a port, with no grouping.
  | number
  // In the reader's number format; `digits` fixes the fraction digits.
  | { number: number; digits?: number }
  // A size in the reader's number format (formatBytes).
  | { bytes: number }
  // A date in the reader's format and time zone.
  | { time: number; shape: DateShape }
  // A time span, frozen when the server writes it ("in 3 hours").
  | { duration: number }
  // How long ago, frozen when the server writes it ("3 hours ago").
  | { elapsed: number }
  // A moment (epoch ms) worded against the reader's clock when shown: "in 3
  // hours" before it, "3 hours ago" after it (hasLiveTimeParam).
  | { relative: number }
  // A message lowercased in the reader's language. Only for a label with no
  // placeholders: the whole rendered text is lowercased.
  | { lower: LogMessage }
  // Several parts as one value, such as a list; the writer puts the
  // separators in.
  | { parts: LogPart[] }
  // A message inside a message.
  | LogMessage;

export interface LogMessage {
  // A catalog key, or the base of a plural pair when `count` is set.
  key: MessageKey | PluralKey;
  params?: Record<string, LogParam>;
  // Present for a plural pair: `key` is then the pair's base.
  count?: number;
}

export type LogPart = string | LogMessage;

/** What a writer hands the log funnel. A plain string stays plain text. */
export type LogText = string | LogMessage | readonly LogPart[];

/** msg()'s trailing arguments: ParamsFor over the English text, with LogParam values. */
export type LogParamsFor<K extends MessageKey> = [
  Placeholders<EnglishText<K>>,
] extends [never]
  ? []
  : [Record<Placeholders<EnglishText<K>>, LogParam>];

type LogPluralPlaceholders<K extends PluralKey> = Exclude<
  Placeholders<EnglishText<`${K}.other` & MessageKey>>,
  "count"
>;

/** msgN()'s trailing arguments: `{count}` comes from the count argument. */
export type LogPluralParamsFor<K extends PluralKey> = [
  LogPluralPlaceholders<K>,
] extends [never]
  ? []
  : [Record<LogPluralPlaceholders<K>, LogParam>];

export function msg<K extends MessageKey>(
  key: K,
  ...params: LogParamsFor<K>
): LogMessage {
  const values = (params as [Record<string, LogParam>?])[0];
  return values === undefined ? { key } : { key, params: values };
}

export function msgN<K extends PluralKey>(
  key: K,
  count: number,
  ...params: LogPluralParamsFor<K>
): LogMessage {
  const values = (params as [Record<string, LogParam>?])[0];
  return values === undefined ? { key, count } : { key, count, params: values };
}

/** `text` as a list of parts. */
export function logParts(text: LogText): LogPart[] {
  if (typeof text === "string") return [text];
  if (Array.isArray(text)) return [...(text as readonly LogPart[])];
  return [text as LogMessage];
}

/**
 * `text` in `tr`'s language, trusting its shape: the server's English
 * `content`, and the per-recipient deliveries that need one finished string.
 * A defect still gives text (the key, a placeholder as written), never null.
 */
export function renderLogText(tr: Translator, text: LogText): string {
  return wordParts(tr, logParts(text), false) ?? "";
}

/**
 * `parts` in `tr`'s language, or null when any part is unknown or malformed,
 * so the caller shows the stored English for the whole line.
 */
export function localizeLogParts(
  tr: Translator,
  parts: unknown,
): string | null {
  return wordParts(tr, parts, true);
}

/** The text a reader sees for an entry: its message in `tr`'s language, else its content. */
export function logEntryText(
  tr: Translator,
  entry: { content: string; message?: unknown },
): string {
  if (entry.message === undefined) return entry.content;
  return localizeLogParts(tr, entry.message) ?? entry.content;
}

/**
 * The fields a log writer stores for `text`: the English `content`, and the
 * parts as `message` when a part is a message. A message English cannot read
 * (a writer defect) is not stored, so no reader gets a line it cannot word.
 */
export function logTextFields(text: LogText): {
  content: string;
  message?: LogPart[];
} {
  const parts = logParts(text);
  if (!parts.some((part) => typeof part !== "string"))
    return { content: (parts as string[]).join("") };
  const content = localizeLogParts(ENGLISH, parts);
  return content === null
    ? { content: renderLogText(ENGLISH, parts) }
    : { content, message: parts };
}

/**
 * Whether `parts` holds a { relative } param at any depth, so a view that
 * shows it re-words it as the clock moves.
 */
export function hasLiveTimeParam(parts: unknown): boolean {
  return Array.isArray(parts) && parts.some((part) => isLive(part, 0));
}

function isLive(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.some((v) => isLive(v, depth + 1));
  if (!isRecord(value)) return false;
  if ("relative" in value) return true;
  if ("key" in value)
    return (
      isRecord(value.params) &&
      Object.values(value.params).some((v) => isLive(v, depth + 1))
    );
  if ("lower" in value) return isLive(value.lower, depth + 1);
  if ("parts" in value) return isLive(value.parts, depth + 1);
  return false;
}

const ENGLISH = translatorFor("en");
const EN: Messages = CATALOGS.en;
const PLACEHOLDER = /\{(\w+)\}/g;
// Deeper than any line the server writes; a stored cycle or a hostile
// payload stops here.
const MAX_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Strict: any defect gives null. Lenient (renderLogText): a defect gives the
// best text it can, because the server must store some content.
function wordParts(
  tr: Translator,
  parts: unknown,
  strict: boolean,
): string | null {
  if (!Array.isArray(parts)) return strict ? null : "";
  let out = "";
  for (const part of parts as unknown[]) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    const worded = wordMessage(tr, part, 0, strict);
    if (worded === null) return null;
    out += worded;
  }
  return out;
}

function catalogText(tr: Translator, key: string): string | undefined {
  const catalog: Messages = CATALOGS[tr.language];
  return Object.hasOwn(catalog, key) ? catalog[key] : EN[key];
}

function isPluralBase(key: string): boolean {
  return Object.hasOwn(EN, `${key}.one`) && Object.hasOwn(EN, `${key}.other`);
}

function wordMessage(
  tr: Translator,
  message: unknown,
  depth: number,
  strict: boolean,
): string | null {
  const fail = (fallback: string) => (strict ? null : fallback);
  if (depth > MAX_DEPTH || !isRecord(message)) return fail("");
  const { key, params, count } = message;
  if (typeof key !== "string") return fail("");
  const values: Record<string, string> = {};
  let template: string | undefined;
  if (count !== undefined) {
    if (typeof count !== "number" || !Number.isFinite(count)) return fail(key);
    if (!isPluralBase(key)) return fail(key);
    template = catalogText(tr, pluralFormKeyFor(tr.language, key, count));
    values.count = String(count);
  } else if (Object.hasOwn(EN, key)) {
    template = catalogText(tr, key);
  }
  if (template === undefined) return fail(key);
  if (params !== undefined) {
    if (!isRecord(params)) return fail(template);
    for (const [name, value] of Object.entries(params)) {
      const worded = wordParam(tr, value, depth, strict);
      if (worded === null) return null;
      values[name] = worded;
    }
  }
  let missing = false;
  const text = template.replace(PLACEHOLDER, (whole, name: string) => {
    if (Object.hasOwn(values, name)) return values[name];
    missing = true;
    return whole;
  });
  return missing && strict ? null : text;
}

function wordParam(
  tr: Translator,
  value: unknown,
  depth: number,
  strict: boolean,
): string | null {
  const fail = (fallback: string) => (strict ? null : fallback);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (!isRecord(value)) return fail("");
  const lang = tr.language;
  if ("key" in value) return wordMessage(tr, value, depth + 1, strict);
  if ("number" in value) {
    const { number, digits } = value;
    if (typeof number !== "number" || !Number.isFinite(number))
      return fail(String(number));
    if (digits === undefined) return formatNumber(lang, number);
    if (
      typeof digits !== "number" ||
      !Number.isInteger(digits) ||
      digits < 0 ||
      digits > 20
    )
      return fail(String(number));
    return formatDecimal(lang, number, digits);
  }
  if ("bytes" in value) {
    const bytes = typeof value.bytes === "number" ? value.bytes : NaN;
    return formatBytes(lang, bytes) ?? fail(String(value.bytes));
  }
  if ("time" in value) {
    const { time, shape } = value;
    if (
      typeof time !== "number" ||
      !Number.isFinite(time) ||
      !isDateShape(shape)
    )
      return fail(String(time));
    return formatDateTime(lang, time, shape);
  }
  if ("duration" in value) {
    const { duration } = value;
    if (typeof duration !== "number" || !Number.isFinite(duration))
      return fail("");
    const now = Date.now();
    const span = timeUntilFine(lang, now + duration, now);
    return span.kind === "formatted" ? span.text : fail("");
  }
  if ("elapsed" in value) {
    const { elapsed } = value;
    if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0)
      return fail("");
    const now = Date.now();
    const since = timeSince(lang, now - elapsed, now);
    return since.kind === "formatted" ? since.text : tr.t("common.justNow");
  }
  if ("relative" in value) {
    const { relative } = value;
    if (typeof relative !== "number" || !Number.isFinite(relative))
      return fail("");
    const now = Date.now();
    if (Math.abs(relative - now) < 60_000) return tr.t("common.justNow");
    const span =
      relative > now
        ? timeUntilFine(lang, relative, now)
        : timeSince(lang, relative, now);
    return span.kind === "formatted" ? span.text : tr.t("common.justNow");
  }
  if ("lower" in value) {
    if (!isRecord(value.lower)) return fail("");
    const worded = wordMessage(tr, value.lower, depth + 1, strict);
    return worded === null ? null : worded.toLocaleLowerCase(lang);
  }
  if ("parts" in value) {
    if (!Array.isArray(value.parts)) return fail("");
    let out = "";
    for (const part of value.parts as unknown[]) {
      if (typeof part === "string") {
        out += part;
        continue;
      }
      const worded = wordMessage(tr, part, depth + 1, strict);
      if (worded === null) return null;
      out += worded;
    }
    return out;
  }
  return fail("");
}

/** The text fields of a choice card, as one reader sees them. */
export interface ChoiceCardText {
  title: string;
  instruction: string;
  choices: { label: string; description?: string }[];
}

interface ChoiceCardSource {
  title: string;
  instruction: string;
  message?: { title?: unknown; instruction?: unknown };
  choices: {
    label: string;
    description?: string;
    message?: { label?: unknown; description?: unknown };
  }[];
}

/**
 * A choice card's text in `tr`'s language. A field with no message keeps its
 * text (a model id, a session topic). When any field's message is unreadable,
 * every field shows its stored English, so a card never mixes two languages.
 */
export function choiceCardText(
  tr: Translator,
  card: ChoiceCardSource,
): ChoiceCardText {
  const english: ChoiceCardText = {
    title: card.title,
    instruction: card.instruction,
    choices: card.choices.map((c) => ({
      label: c.label,
      description: c.description,
    })),
  };
  let unreadable = false;
  const field = (stored: string, message: unknown): string => {
    if (message === undefined) return stored;
    const worded = localizeLogParts(tr, message);
    if (worded === null) unreadable = true;
    return worded ?? stored;
  };
  const worded: ChoiceCardText = {
    title: field(card.title, card.message?.title),
    instruction: field(card.instruction, card.message?.instruction),
    choices: card.choices.map((c) => ({
      label: field(c.label, c.message?.label),
      description:
        c.description === undefined
          ? undefined
          : field(c.description, c.message?.description),
    })),
  };
  return unreadable ? english : worded;
}

/** `items` as one list of parts, with `separator` between them. */
export function joinLogText(
  items: readonly LogText[],
  separator = "",
): LogPart[] {
  const out: LogPart[] = [];
  items.forEach((item, index) => {
    if (index > 0 && separator) out.push(separator);
    out.push(...logParts(item));
  });
  return out;
}

/** One choice of a card as a writer hands it over. */
export interface ChoiceInput {
  value: string;
  label: LogText;
  description?: LogText;
  current?: boolean;
}

/**
 * The text fields a choice card stores: English, and the parts as `message`
 * beside each field that has a message part.
 */
export function choiceCardFields(
  title: LogText,
  instruction: LogText,
  choices: readonly ChoiceInput[],
): {
  title: string;
  instruction: string;
  message?: { title?: LogPart[]; instruction?: LogPart[] };
  choices: {
    value: string;
    label: string;
    description?: string;
    current?: boolean;
    message?: { label?: LogPart[]; description?: LogPart[] };
  }[];
} {
  const t = logTextFields(title);
  const i = logTextFields(instruction);
  const cardMessage = {
    ...(t.message ? { title: t.message } : {}),
    ...(i.message ? { instruction: i.message } : {}),
  };
  return {
    title: t.content,
    instruction: i.content,
    ...(Object.keys(cardMessage).length > 0 ? { message: cardMessage } : {}),
    choices: choices.map((choice) => {
      const label = logTextFields(choice.label);
      const description =
        choice.description === undefined
          ? undefined
          : logTextFields(choice.description);
      const message = {
        ...(label.message ? { label: label.message } : {}),
        ...(description?.message ? { description: description.message } : {}),
      };
      return {
        value: choice.value,
        label: label.content,
        ...(description ? { description: description.content } : {}),
        ...(choice.current !== undefined ? { current: choice.current } : {}),
        ...(Object.keys(message).length > 0 ? { message } : {}),
      };
    }),
  };
}

/** `text` as one placeholder value: several parts become a { parts } value. */
export function logParam(text: LogText): LogParam {
  if (typeof text === "string") return text;
  if (!Array.isArray(text)) return text as LogMessage;
  const parts = text as readonly LogPart[];
  if (parts.length === 1) return parts[0];
  return { parts: [...parts] };
}
