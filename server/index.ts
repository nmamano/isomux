// Back-compat entry point. DO NOT DELETE.
//
// The office server moved to ./isomux-office.ts so that its command line says
// what it is. `bun run server/index.ts` is the single most collision-prone
// string on a dev box - a `pkill -f "server/index.ts"` meant for some other
// project's dev server took the office down with it.
//
// This file stays because systemd units written before the rename still point
// at it, including on self-hosted installs we don't control. Those keep
// booting; they just keep the old command line until their unit is updated.
// Once no supported install can predate the rename, this shim can be deleted.
import { runOfficeMain } from "./isomux-office.ts";

if (import.meta.main) await runOfficeMain();
