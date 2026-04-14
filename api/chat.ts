import Anthropic from "@anthropic-ai/sdk";

export const config = { runtime: "edge" };

// --- Rate limiting (in-memory, resets on cold start) ---
const hits = new Map<string, number[]>();

function rateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const timestamps = (hits.get(ip) || []).filter((t) => now - t < windowMs);

  const lastMinute = timestamps.filter((t) => now - t < 60_000);
  if (lastMinute.length >= 5) return { allowed: false, retryAfterSeconds: 60 };
  if (timestamps.length >= 20) {
    return { allowed: false, retryAfterSeconds: Math.ceil((timestamps[0] + windowMs - now) / 1000) };
  }

  timestamps.push(now);
  hits.set(ip, timestamps);
  return { allowed: true };
}

// --- System prompt ---
const SYSTEM_PROMPT = `You are a helpful assistant on the Isomux website (isomux.com). Answer questions about Isomux based on the information below.

## What is Isomux?
Isomux is a free, open-source agent office for running multiple Claude Code agents simultaneously. It provides a browser-based UI with a cute isometric office metaphor where each agent sits at a desk. It's described as "cute in a useful way."

## Key Facts
- **Free, open source, no cloud, no account required**
- Works with your existing Claude subscription (Pro or Max) — if \`claude\` works in your terminal, Isomux works in your browser
- Built with Bun, React, TypeScript, and the Claude Agent SDK
- Runs as a single Bun process on your machine
- No database, no cloud dependency, no API key needed beyond your Claude CLI auth
- GitHub: github.com/nmamano/isomux
- Created by Nil Mamano (nilmamano.com)

## Features
- **Visual office metaphor**: see what every agent is doing at a glance
  - Animated characters: sleeping when idle, typing when working, waving when waiting
  - Skeuomorphic touches: click the moon for dark mode, click doors to switch rooms
- **Mobile UI**: touch-optimized interface, continue conversations on your phone
- **Works locally or as a self-hosted persistent server** (Mac Mini style):
  - Run at home, access from any device via Tailscale
  - Same conversations, same filesystem, real-time sync across all devices
- **Embedded terminal** per agent
- **Voice-to-text** prompting and **text-to-speech** responses
- **Pre-tool-call safety hooks**: blocks dangerous commands like \`rm -rf\`
- **Custom commands** with autocomplete (e.g., /isomux-peer-review, /isomux-all-hands)
- **Agents can check on each other**: inter-agent discovery via shared manifest
- **Shared task board**: humans and agents can create, assign, claim, and close tasks
- **Image/PDF attachments**: agents understand images and PDFs, can show images inline
- **Sound notifications**: get pinged when an agent finishes

## Getting Started
1. Install Bun (v1.2+) and Claude Code CLI
2. Clone the repo, \`bun install\`, \`bun run dev\`
3. Open http://localhost:4000, click an empty desk to spawn an agent

## Persistent Server Setup
Run Isomux on an always-on machine (like a Mac Mini), access from any device via Tailscale. Set up a systemd service for persistence.

## How It Works
- Uses the Claude Agent SDK to create and manage agent sessions (one per desk)
- WebSocket layer keeps every connected device in sync in real time
- Agent sessions persist across server restarts
- Piggybacks on your existing Claude CLI authentication and inherits global Claude skills

## Guidelines
- Keep responses concise (2-4 sentences unless more detail is asked for)
- Be friendly and enthusiastic about Isomux
- If asked something you don't know about Isomux, say so rather than guessing
- You can direct people to the GitHub repo or the blog post at nilmamano.com/blog/isomux for more details
- Don't make up features that aren't listed above`;

// --- Handler ---
export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const { allowed, retryAfterSeconds } = rateLimit(ip);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.` }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  const { messages } = await req.json();

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const userAgent = req.headers.get("user-agent") || "unknown";
  const referer = req.headers.get("referer") || "unknown";
  const meta = `> IP: \`${ip}\` | UA: \`${userAgent.slice(0, 100)}\` | Ref: \`${referer}\``;

  // Log user message to Discord (fire-and-forget)
  const lastUserMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
  if (lastUserMsg && webhookUrl) {
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `[isomux.com] **User:**\n${lastUserMsg.content}\n${meta}`.slice(0, 2000) }),
    }).catch(() => {});
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const stream = await client.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: messages.map((m: { role: string; content: string }) => ({
      role: m.role,
      content: m.content,
    })),
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      let fullText = "";
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            fullText += event.delta.text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`));
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();

        // Log bot response to Discord (fire-and-forget)
        if (webhookUrl && fullText) {
          fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `[isomux.com] **Bot:**\n${fullText}`.slice(0, 2000) }),
          }).catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
