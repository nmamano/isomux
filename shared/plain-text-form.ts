// The plain-text form of a route that carries one block of text (RouteDef
// plainText). A text/plain body is the `text` field and each declared query
// parameter is one more field, so a caller sends a message with a quoted
// heredoc and no JSON escaping:
//
//   curl ... "localhost:4000/api/agents/<id>/messages?steer=1" \
//     -H 'Content-Type: text/plain' --data-binary @- <<'EOF'
//
// readPlainTextForm builds the same body object a JSON caller sends, before
// authorization, so guards, preconditions and handlers see one shape and
// every field rule stays in the handler.

import type {
  ApiTokenInboxSendReq,
  SendMessageReq,
} from "./contract-shapes.ts";

export type PlainTextParamKind = "flag" | "string";

// The query parameters of a plain-text route, keyed by request field: "flag"
// fills a boolean field (steer=1), "string" a string field.
export type PlainTextParams<Req> = {
  readonly [K in Exclude<keyof Req, "text">]?: NonNullable<
    Req[K]
  > extends boolean
    ? "flag"
    : NonNullable<Req[K]> extends string
      ? "string"
      : never;
};

// The query parameters of the two plain-text routes. The route table and the
// chat's curl card (ui/log-view/isomux-curl.ts) both read these.
export const MESSAGE_PLAIN_TEXT_PARAMS = {
  steer: "flag",
  deliverAt: "string",
  clientMessageId: "string",
} as const satisfies PlainTextParams<SendMessageReq>;
export const INBOX_PLAIN_TEXT_PARAMS =
  {} as const satisfies PlainTextParams<ApiTokenInboxSendReq>;

export type PlainTextForm =
  // Not the plain-text form: parse the body as JSON, as for any route.
  | { kind: "json" }
  | { kind: "text"; body: Record<string, unknown> }
  | { kind: "error"; status: 422; code: "invalid_request"; message: string };

const invalid = (message: string): PlainTextForm => ({
  kind: "error",
  status: 422,
  code: "invalid_request",
  message,
});

export function isTextPlain(contentType: string): boolean {
  return contentType.split(";", 1)[0].trim().toLowerCase() === "text/plain";
}

type QueryPair = { name: string | null; value: string | null; raw: string };

// URLSearchParams decodes "+" as a space, which turns deliverAt=...+02:00
// into an invalid time. Split the query by hand and decode with
// decodeURIComponent, which keeps "+" literal. `name` or `value` is null when
// its percent-encoding is malformed; `value` is also null when there is no
// "=" (a bare "?steer").
function splitQuery(search: string): QueryPair[] {
  const pairs: QueryPair[] = [];
  for (const raw of search.replace(/^\?/, "").split("&")) {
    if (raw === "") continue;
    const eq = raw.indexOf("=");
    const name = decode(eq === -1 ? raw : raw.slice(0, eq));
    const value = eq === -1 ? null : decode(raw.slice(eq + 1));
    pairs.push({ name, value, raw });
  }
  return pairs;
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// Today a JSON body reaches the handler whatever its Content-Type, and fetch()
// with a string body and no headers sends text/plain;charset=UTF-8. A caller
// that sends JSON that way keeps working: with no declared option in the
// query, a body that parses to a plain object with a string `text` takes the
// JSON path.
function isJsonMessage(rawBody: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as { text?: unknown }).text === "string"
  );
}

export function readPlainTextForm(
  params: Readonly<Record<string, PlainTextParamKind>>,
  contentType: string,
  search: string,
  rawBody: string,
): PlainTextForm {
  const declared = new Set(Object.keys(params));
  const pairs = splitQuery(search);
  const options = pairs.filter(
    (p) => p.name !== null && declared.has(p.name),
  );

  if (!isTextPlain(contentType)) {
    // Options in the query belong to the text/plain form only. On a JSON,
    // form-encoded or untyped request they are refused, never merged with the
    // body and never ignored. Other query parameters stay ignored, as before.
    if (options.length > 0)
      return invalid(
        `Query parameter ${options[0].name} needs Content-Type: text/plain. With a JSON body, send it as a field.`,
      );
    return { kind: "json" };
  }
  if (options.length === 0 && isJsonMessage(rawBody)) return { kind: "json" };

  const accepted = [...declared].join(", ");
  const fields: Record<string, string | boolean> = {};
  for (const pair of pairs) {
    if (pair.name === null)
      return invalid(
        `Query parameter ${pair.raw} has malformed percent-encoding.`,
      );
    if (!declared.has(pair.name))
      return invalid(
        accepted
          ? `Unknown query parameter ${pair.name}. This route accepts: ${accepted}.`
          : `Unknown query parameter ${pair.name}. This route accepts no query parameters.`,
      );
    if (pair.name in fields)
      return invalid(`Query parameter ${pair.name} appears more than once.`);
    if (params[pair.name] === "flag") {
      if (pair.value !== "1" && pair.value !== "true")
        return invalid(`Use ${pair.name}=1 or ${pair.name}=true.`);
      fields[pair.name] = true;
      continue;
    }
    if (pair.value === null)
      return invalid(
        pair.raw.includes("=")
          ? `Query parameter ${pair.name} has malformed percent-encoding.`
          : `Query parameter ${pair.name} needs a value.`,
      );
    fields[pair.name] = pair.value;
  }

  // A heredoc ends the body with one line break the sender did not type.
  const text = rawBody.replace(/\r?\n$/, "");
  // A fixed key order (text, then the declared order), so equal requests give
  // equal idempotency fingerprints.
  const body: Record<string, unknown> = { text };
  for (const name of declared) if (name in fields) body[name] = fields[name];
  return { kind: "text", body };
}
