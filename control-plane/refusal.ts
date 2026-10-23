// A refusal our own code produced, and who may read its words.
//
// The source of a refusal knows whether its sentence is about the customer's
// request or about this deployment; the web boundary does not. So the source
// says it, and `kind` is required: a new refusal cannot reach a customer by
// default.

/**
 * "customer": a sentence about the customer's own request, shown as it is.
 * "configuration" and "transient": the customer sees only an opaque failure
 * sentence and a reference; the reason goes to the server log.
 */
export type RefusalKind = "customer" | "configuration" | "transient";

export interface Refusal {
  ok: false;
  kind: RefusalKind;
  reason: string;
}
