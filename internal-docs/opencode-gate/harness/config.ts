export function gateConfig(mockBaseUrl: string, apiKey = "GATE_PROVIDER_SENTINEL") {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: "gate/gate-model",
    small_model: "gate/gate-model",
    share: "disabled",
    permission: { bash: "ask", edit: "ask" },
    provider: {
      gate: {
        name: "Gate mock",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          "gate-model": {
            name: "Gate model",
            reasoning: true,
            tool_call: true,
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
          },
        },
        options: { apiKey, baseURL: mockBaseUrl },
      },
    },
  }
}
