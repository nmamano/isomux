# OpenCode thinking effort feasibility

Verified on 2026-09-10 against the pinned OpenCode 1.18.23 binary and the
matching `@opencode-ai/sdk` 1.18.23 package.

## Result

OpenCode can receive a variant on a turn, and `/provider` supplies a variant
list for each model. Isomux uses the exact intersection between those variant
names and `EffortLevel`; it does not expose provider-specific names.

The served OpenAPI document defines `variant` with `{"type":"string"}` at
`paths./session/{sessionID}/prompt_async.post.requestBody.content.application/json.schema.properties.variant`.
The containing schema sets `additionalProperties: false`, but the pinned
binary accepts an undeclared field with HTTP 204. It rejects a missing required
`parts` field and a numeric `variant` with HTTP 400, while it accepts `variant`
as either a string or null. Isomux posts raw HTTP, so the served behavior is its
contract. As background, the matching SDK's v2
`SessionPromptAsyncData` at `dist/v2/gen/types.gen.d.ts:8660` contains
`variant?: string` at line 8674; the legacy declaration at
`dist/gen/types.gen.d.ts:2329` omits it.

The served OpenAPI schema at `components.schemas.Model.properties.variants`
represents each `/provider` model's variants as an object with arbitrary string
keys. The matching legacy SDK `Model` type at
`dist/gen/types.gen.d.ts:1278` omits this field. The newer
`components.schemas.ModelV2Info.properties.variants` schema represents
variants as an array of objects with string `id` values. With the server
started from this worktree and no `directory` query parameter, `/api/model`
returned 138 entries, including 30 free-model entries, but every free-model
variant array was empty even when `/provider` returned built-in variants. A
review run of the same pinned binary returned no `/api/model` entries. Isomux
must therefore continue to use `/provider` for this metadata.

Isomux exposes all models from connected providers and only marks the free
ones; it does not filter paid models out. Across all 96 connected models on
this machine, 74 had variants. The distinct names and model counts were:

- `high`: 69
- `low`: 59
- `medium`: 51
- `max`: 34
- `xhigh`: 32
- `minimal`: 12
- `none`: 14
- `thinking`: 1

The connected free subset was:

- `opencode/muse-spark-1.2-contributor-free`: `minimal`, `low`, `medium`,
  `high`, `xhigh`
- `opencode/muse-spark-1.3-contributor-free`: `minimal`, `low`, `medium`,
  `high`, `xhigh`
- `opencode/ling-3.0-flash-fin-free`: `low`, `medium`, `high`
- `opencode/nemotron-3-ultra-free`,
  `opencode/nemotron-3.5-lightning-free`, `opencode/mimo-v2.5-free`, and
  `opencode/big-pickle`: no variants

Six of the eight measured names are exact Isomux `EffortLevel` values. The 14
`none` variants and the one `thinking` variant are on paid models;
`opencode-go/minimax-m3` supplies that `thinking` variant. The contract is not
restricted to the measured names: the served OpenAPI schema at
`components.schemas.ProviderConfig` permits custom variants with arbitrary
keys. Isomux has no `none` effort, and `minimal` can exist beside `none`, so
aliasing `none` to `minimal` would discard a real distinction.

There is a second implementation blocker. `validateEffort` at
`server/agent-validators.ts:169` currently returns `DEFAULT_EFFORT` for every
OpenCode agent. An implementation must remove that clamp or every stored
OpenCode choice remains `high` regardless of the advertised variants.

## Implemented policy

Advertise only the exact intersection between a model's `/provider` variant
keys and Isomux's `EffortLevel` values. Send the selected effort unchanged as
`variant`. Ignore `none` and other custom names. Models with no exact matches
continue to report no supported effort choices.

Under this policy, `opencode-go/minimax-m3` advertises no efforts because its
only variants are `none` and `thinking`. The GPT-5.x models retain their exact
`low`, `medium`, `high`, or `xhigh` variants and hide `none`. The policy also
hides any future custom name that Isomux cannot represent.

This policy preserves OpenCode's meaning without inventing aliases. Adding a
first-class `none` effort remains a separate product decision.

The opt-in live tier sends a supported variant through the pinned binary and
requires a completed provider reply. This is a compatibility smoke, not proof
that OpenCode applied the variant: OpenCode 1.18.23 also returns HTTP 204 for
an unknown variant. The transport request-body test proves that Isomux sends
the selected supported name and omits an unsupported one.

## Verification method

The binary at `node_modules/opencode-linux-x64/bin/opencode` reported version
1.18.23. A local `opencode serve --pure` process served its OpenAPI document at
`/doc`; the prompt and provider/model schemas above came from that document.
The generated declarations came from the matching `@opencode-ai/sdk@1.18.23`
package. Runtime model and variant observations came from the local server's
`/provider` and `/api/model` endpoints. The secret-bearing `/provider` response
was reduced to model IDs, zero-cost status, and variant keys before inspection.
