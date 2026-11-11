# Contributing

Bug reports and pull requests are welcome.

## Setup

```sh
bun install
bun install --cwd control-plane/web
bun run build:ui
```

The first command also turns on the pre-push hook in `.githooks/`. The type check needs the second, and some tests need the third.

## Before you open a pull request

Start your branch from an up-to-date `main`, then run:

```sh
bun run typecheck
bun run lint
bun run format
bun scripts/gate-tests.ts
```

`gate-tests.ts` lists the tests your change reaches. Give the lines that are plain paths to `bun test`, and ignore the `base` line. A `cp <path>` line is a control-plane test: it needs the local Postgres in [control-plane/README.md](control-plane/README.md#tests). A `web` line means: also run `bun run ci:web`.

## The full CI gate

`bun run ci` runs every check that GitHub runs, and it passes only on Linux. On Linux, the pre-push hook runs it before each push. On other systems, the hook skips it, and GitHub runs it on your pull request.
