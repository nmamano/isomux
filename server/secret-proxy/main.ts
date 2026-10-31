// The secret proxy's child process (internal-docs/secrets-design.md, section
// 2.2). The server starts it with an IPC channel and sends it every snapshot
// over that channel: values never pass through argv or the environment, and
// the only files this process reads are /proc/net/tcp and /proc/net/tcp6
// (peer-uid.ts). It passes no test seam to the proxy.
//
// It exits when the channel closes, so a server that dies, even by SIGKILL,
// leaves no child holding the port.

import { runProxyChild } from "./child.ts";

runProxyChild({});
