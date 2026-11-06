// A test run in a process of its own, for pg.test.ts: it acquires one schema,
// prints that schema's name, and waits to be killed.

import { testDsn } from "./pg.ts";

const dsn = await testDsn();
const options = new URL(dsn).searchParams.get("options") ?? "";
console.log(options.replace("-c search_path=", ""));
setInterval(() => {}, 1 << 30);
