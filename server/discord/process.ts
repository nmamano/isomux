// The real gateway child behind the Discord supervisor's spawner.

import { join } from "path";
import { spawnLineChild } from "../messaging/line-child.ts";
import { encodeGatewayCommand, parseGatewayEvent } from "./protocol.ts";
import type { GatewayChild, GatewaySpawnSpec } from "./supervisor.ts";

export const DISCORD_GATEWAY_ENTRY = join(import.meta.dir, "gateway.ts");

export function spawnGateway(spec: GatewaySpawnSpec): GatewayChild {
  return spawnLineChild({
    ...spec,
    encode: encodeGatewayCommand,
    parse: parseGatewayEvent,
    tag: "discord",
  });
}
