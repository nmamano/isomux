// Two-stage authorization dispatcher. The central authz semantics that the
// route table and the strangler call: stage 1 checks a route's coarse
// `requiredCapability` against the identity's capability set;
// stage 2 runs the route's `resourceGuard`. No authorization logic lives in
// handler bodies. See internal-docs/generic-runtime-refactor.md → Conventions
// "Two-stage authorization, both declared" + "Error envelope".
//
// Status ladder:
//   no identity at all       → 401 unauthenticated   (the ONLY 401 path)
//   missing capability (s1)  → 403 forbidden          (stage 2 NOT run)
//   resourceGuard deny  (s2) → the guard's outcome, verbatim (403, non-leak)
// A missing capability is 403, never 401; 401 means "no identity".

import {
  identityHasCapability,
  type Capability,
  type Identity,
} from "./index.ts";
import {
  UNAUTHENTICATED,
  FORBIDDEN,
  type AuthzOutcome,
  type Guard,
  type GuardContext,
  type GuardDeps,
} from "./guards.ts";

// The authz slice of a route declaration the dispatcher needs. The full route
// table carries more (method/path/schemas/emits); this is the subset
// that drives authorization.
export interface RouteAuthz {
  // The capability/capabilities required to clear stage 1. A single capability
  // for almost every route; a set (any-of - the caller needs at least one) for
  // the composite agents.sendMessage route, whose
  // `agent:converse | agent:send-as-self` lets both a USER (converse) and an
  // AGENT (send-as-self) through stage 1 so messageSend's scope-specific stage-2
  // branch runs. Without any-of, a single cap would 403 one legitimate caller
  // class before the composite guard could dispatch on it.
  requiredCapability: Capability | readonly Capability[];
  resourceGuard: Guard;
}

// Everything the dispatcher needs besides the route. `identity` is nullable to
// model the unauthenticated caller (the only 401 path); the rest mirrors
// GuardContext minus identity.
export interface AuthorizeInput {
  identity: Identity | null;
  params: GuardContext["params"];
  body?: unknown;
  deps: GuardDeps;
}

export function authorize(
  route: RouteAuthz,
  input: AuthorizeInput,
): AuthzOutcome {
  const { identity } = input;
  // Authn stage: no identity at all is the ONLY 401.
  if (identity === null) return UNAUTHENTICATED;
  // Stage 1: coarse capability (any-of - the caller needs at least one of the
  // declared capabilities). A missing capability is 403, and we MUST NOT run the
  // resourceGuard - stage 2 never observes a caller that failed stage 1.
  const required: readonly Capability[] =
    typeof route.requiredCapability === "string"
      ? [route.requiredCapability]
      : route.requiredCapability;
  if (!required.some((cap) => identityHasCapability(identity, cap)))
    return FORBIDDEN;
  // Stage 2: object-level resource guard.
  return route.resourceGuard({
    identity,
    params: input.params,
    body: input.body,
    deps: input.deps,
  });
}
