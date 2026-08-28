const port = Number(process.env.PORT ?? "41200")

function chunk(id: string, delta: Record<string, unknown>, finish: string | null = null) {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "gate-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
}

function lastUser(messages: Array<Record<string, unknown>>) {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? ""
}

function hasToolResult(messages: Array<Record<string, unknown>>) {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user")
  return messages.slice(lastUserIndex + 1).some((message) => message.role === "tool")
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ ok: true })
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "gate-model", object: "model" }] })
    }
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
    if (request.headers.get("authorization") === "Bearer INVALID_GATE_KEY") {
      return Response.json(
        { error: { message: "invalid gate credential", type: "authentication_error" } },
        { status: 401, headers: { "x-provider-secret": "GATE_HEADER_SECRET_SENTINEL" } },
      )
    }

    const body = (await request.json()) as {
      messages?: Array<Record<string, unknown>>
      stream?: boolean
    }
    const messages = body.messages ?? []
    const userContent = lastUser(messages)
    const prompt =
      typeof userContent === "string" ? userContent : JSON.stringify(userContent)
    const isSummary = prompt.includes("Create a new anchored summary")
    const id = `gate-${Date.now()}`
    console.log(JSON.stringify({ at: new Date().toISOString(), prompt, messageCount: messages.length }))

    const stream = new ReadableStream({
      async start(controller) {
        const send = (value: string) => controller.enqueue(`data: ${value}\n\n`)
        send(chunk(id, { role: "assistant" }))
        if (prompt.includes("GATE_ABORT")) await Bun.sleep(Number(process.env.GATE_ABORT_MS ?? "2500"))

        if (!isSummary && (prompt.includes("GATE_TOOL") || prompt.includes("GATE_FAIL") || prompt.includes("GATE_ABORT_TOOL") || prompt.includes("GATE_QUESTION") || prompt.includes("GATE_CWD")) && !hasToolResult(messages)) {
          const command = prompt.includes("GATE_ABORT_TOOL")
            ? "sleep 30"
            : prompt.includes("GATE_CWD")
            ? "pwd > s4-cwd-observed.txt"
            : prompt.includes("GATE_FAIL")
            ? "printf failed-before-exit; exit 7"
            : "printf tool-ok > gate-output.txt"
          const tool = prompt.includes("GATE_QUESTION") ? "question" : "bash"
          const args = tool === "question"
            ? { questions: [{ header: "Gate", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }] }
            : { command }
          send(
            chunk(id, {
              tool_calls: [
                {
                  index: 0,
                  id: "call_gate_001",
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                },
              ],
            }),
          )
          send(chunk(id, {}, "tool_calls"))
        } else {
          const contextCanary = messages
            .map((message) => typeof message.content === "string" ? message.content : "")
            .find((content) => content.includes("S4_CONTEXT_CANARY"))
          const text = prompt.includes("GATE_RECALL")
            ? contextCanary
              ? "RECALLED:S4_CONTEXT_CANARY"
              : "RECALLED:EMPTY"
            : hasToolResult(messages)
            ? "RECOVERED_AFTER_TOOL"
            : `ANSWER:${prompt.replaceAll("\n", " ").slice(0, 160)}`
          send(chunk(id, { reasoning_content: "gate-reasoning" }))
          for (const part of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
            send(chunk(id, { content: part }))
            await Bun.sleep(20)
          }
          send(chunk(id, {}, "stop"))
        }
        send(
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "gate-model",
            choices: [],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
              prompt_tokens_details: { cached_tokens: 2 },
              completion_tokens_details: { reasoning_tokens: 3 },
            },
          }),
        )
        send("[DONE]")
        controller.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  },
})

console.log(JSON.stringify({ ready: true, url: server.url.toString() }))
