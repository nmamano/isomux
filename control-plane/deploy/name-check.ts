// Is the app name free?
//
//   bun control-plane/deploy/name-check.ts
//
// The token is org-scoped, so the listing it answers with names every app in
// the organisation - including ones that belong to other projects entirely.
// That listing is parsed in memory and dropped; the one line this prints is
// about the single name this slice is allowed to create.

import {
  APP,
  FLYCTL,
  FLY_TOKEN_FILE,
  readSecretFile,
  realSpawn,
} from "./fly-cli.ts";

const result = await realSpawn(
  [FLYCTL, "apps", "list", "--json"],
  { FLY_API_TOKEN: readSecretFile(FLY_TOKEN_FILE) },
  "",
);

if (result.code !== 0) {
  console.log("listing_readable: false");
  process.exit(1);
}

let names: string[];
try {
  const rows = JSON.parse(result.stdout) as { Name?: string; name?: string }[];
  names = rows.map((r) => r.Name ?? r.name ?? "");
} catch {
  console.log("listing_readable: false");
  process.exit(1);
}

console.log("listing_readable: true");
console.log(`app: ${APP}`);
console.log(`name_available: ${!names.includes(APP)}`);
