// Test instrument, loaded with `bun --preload` in a child listener (see
// THROWING_HANDLER_PRELOAD in bad-host.ts): a request with the header below
// throws inside the handler, before the listener's own fetch runs. Every
// other Bun.serve option passes through, so the answer to the throw shows
// whether the listener left development mode on.
const THROW_HEADER = "x-isomux-test-throw";

const serve = Bun.serve;
(Bun as { serve: unknown }).serve = (options: Parameters<typeof serve>[0]) => {
  const { fetch } = options as {
    fetch: (req: Request, server: unknown) => unknown;
  };
  return serve({
    ...options,
    fetch(req: Request, server: unknown) {
      if (req.headers.has(THROW_HEADER))
        throw new Error("thrown by throwing-handler-preload");
      return fetch(req, server);
    },
  } as Parameters<typeof serve>[0]);
};
