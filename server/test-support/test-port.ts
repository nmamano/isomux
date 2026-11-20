// A loopback port for a test to hand to a child process or a later bind.
//
// The port comes from this test process's own block (ISOMUX_TEST_APP_PORT_MIN
// ..MAX, claimed by preload.ts). The block is below the kernel's ephemeral
// range and belongs to one process, so no other process can take the port
// between this probe and the bind. A port-0 port could be lost that way
// (tasks 3be3b31b, 72affd86). The walk goes from the top of the block down,
// because the app registry takes its ports from the bottom up.
let next: number | null = null;

export function exclusiveTestPort(): number {
  const rawMin = process.env.ISOMUX_TEST_APP_PORT_MIN;
  const rawMax = process.env.ISOMUX_TEST_APP_PORT_MAX;
  const min = Number(rawMin);
  const max = Number(rawMax);
  if (
    !rawMin ||
    !rawMax ||
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 1 ||
    min > max
  )
    throw new Error("the test preload did not set the app port block");
  if (next === null || next < min || next > max) next = max;
  for (let tries = max - min + 1; tries > 0; tries--) {
    const port: number = next;
    next = port <= min ? max : port - 1;
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(
        true,
      );
      return port;
    } catch (error) {
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`no free port in the test app port block ${min}-${max}`);
}
