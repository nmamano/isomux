// Isolated harness only. The production office does not import this listener.
import {
  BrowserExtensionBridge,
  browserCredentialHash,
  type ExtensionConnection,
} from "../browser-extension-bridge";
import {
  BROWSER_EXTENSION_PROTOCOL,
  fields,
} from "../../shared/browser-extension-protocol";

type SocketData = {
  connection?: ExtensionConnection;
  timer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
};
export function browserExtensionFixture() {
  const credential = crypto.randomUUID() + crypto.randomUUID();
  const hash = browserCredentialHash(credential);
  const bridge = new BrowserExtensionBridge({
    memberForCredentialHash: (value) =>
      value === hash ? "fixture-member" : undefined,
    mayUse: (member, agent) =>
      member === "fixture-member" && agent === "fixture-agent",
    agents: () => ["fixture-agent"],
    memberDisplay: () => ({ id: "fixture-member", name: "Fixture member" }),
    agentDisplay: () => ({ id: "fixture-agent", name: "Fixture agent" }),
  });
  let starts = 0;
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/extension") {
        if (server.upgrade(req, { data: {} })) return;
      } else if (url.pathname === "/started" && req.method === "POST") {
        starts++;
        return new Response("ok");
      } else if (url.pathname === "/form") {
        return new Response(
          '<!doctype html><title>Bridge form</title><label>Message <input id="message"></label><button id="apply">Apply</button><output id="result"></output><script>document.querySelector("#apply").onclick = event => {document.querySelector("#result").textContent = document.querySelector("#message").value; document.querySelector("#result").dataset.trusted = String(event.isTrusted);};</script>',
          { headers: { "Content-Type": "text/html" } },
        );
      } else if (url.pathname === "/unrelated")
        return new Response("Unrelated fixture tab");
      return new Response(null, { status: 404 });
    },
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024,
      open(ws) {
        ws.data.timer = setTimeout(() => ws.close(), 3000);
      },
      message(ws, data) {
        try {
          const msg = fields(JSON.parse(String(data)));
          if (!ws.data.connection) {
            if (
              msg.kind !== "hello" ||
              msg.version !== BROWSER_EXTENSION_PROTOCOL ||
              typeof msg.credential !== "string"
            )
              throw new Error("Invalid hello");
            ws.data.connection = bridge.connect(msg.credential, {
              send: (value) => {
                ws.send(JSON.stringify(value));
              },
              close: () => ws.close(),
            });
            clearTimeout(ws.data.timer);
            // The extension closes a connection that sends no ping for 45 s,
            // as the office service does every 15 s.
            const connection = ws.data.connection;
            ws.data.heartbeat = setInterval(
              () =>
                ws.send(
                  JSON.stringify({
                    kind: "ping",
                    generation: connection.generation,
                  }),
                ),
              15_000,
            );
          } else if (msg.kind !== "pong") ws.data.connection.receive(msg);
        } catch {
          ws.close();
        }
      },
      close(ws) {
        clearTimeout(ws.data.timer);
        clearInterval(ws.data.heartbeat);
        ws.data.connection?.close();
      },
    },
  });
  const origin = "http://127.0.0.1:" + server.port;
  return {
    origin,
    credential,
    bridge,
    extensionURL: origin.replace("http:", "ws:") + "/extension",
    starts: () => starts,
    stop: () => {
      bridge.connections("fixture-member")[0]?.close();
      void server.stop(true);
    },
  };
}
