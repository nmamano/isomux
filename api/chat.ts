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

Free · open source · no cloud · no account.

- Works with your existing Claude subscription (Pro or Max) — if \`claude\` works in your terminal, Isomux works in your browser. No API key needed — it piggybacks on your CLI auth.
- Built with Bun, React, TypeScript, and the Claude Agent SDK
- Runs as a single Bun process on your machine. No bundler, no database, minimal deps.
- GitHub: github.com/nmamano/isomux
- Created by Nil Mamano (nilmamano.com)
- Blog post with deeper dive: nilmamano.com/blog/isomux

## Getting Started
1. Install Bun (v1.2+) and the Claude Code CLI, authenticated with a Claude Pro or Max subscription
2. \`git clone https://github.com/nmamano/isomux.git && cd isomux && bun install && bun run dev\`
3. Open http://localhost:4000, click an empty desk to spawn your first agent

For persistent server setup (systemd + Tailscale) and voice input configuration, see isomux.com.

## Full Feature List

### Office View
- Isometric office with 8 desks — see all your agents at a glance
- Multiple rooms — click doors to switch rooms, each room has 8 desks, no hard limit on agents
- Name your agents — each gets a nametag on their desk
- Unique character per agent — customize hat, shirt, hair, accessory, or randomize
- Animated characters — sleeping when idle, typing when working, waving when waiting for you
- Desk monitors glow based on agent state (green / purple / red)
- Status light with escalating warnings: amber at 2 min, red at 5 min
- Auto-generated conversation topic below nametag
- Drag agents between desks to rearrange
- Light / dark theme toggle (click the moon)

### Agent Creation & Editing
- Click empty desk to spawn — name, working directory, permission mode, custom instructions
- Working directory input with recent CWD suggestions
- Outfit customization: color swatches, hat, accessory, randomize with live preview
- Custom instructions per agent, editable at spawn and later

### Conversation View
- Input drafts preserved when switching between agents
- Markdown rendering for agent output
- Collapsible thinking and tool-call cards with timing for each step
- Copy buttons on code blocks, user messages, full agent turns, and entire conversations
- Send disabled while agent is busy — type ahead freely, send when ready
- File attachments: agents understand images and PDFs. Upload via button, drag-and-drop, or paste
- Image display: agents can show images inline in the conversation
- Embedded terminal for direct shell access per agent
- Conversation branching — edit a past message to fork the conversation from that point, preserving the original
- Right-click context menu — resume past sessions, edit agent, kill

### Keyboard Shortcuts
- Number keys 1–8 jump to agents from office view
- Tab / Shift+Tab cycle between agents in chat view
- Escape returns to office
- Ctrl+C to interrupt — cleanly aborts and lets you resume

### Slash Commands & Autocomplete
- Built-in commands: /clear, /help, /cost, /context
- User skills from ~/.claude/skills/ and project commands
- Bundled skills like /grill-me — available to every agent out of the box
- Autocomplete dropdown with keyboard navigation

### Persistence & Lifecycle
- Agents persist across server restarts
- Auto-resume last conversation on restart
- Agent manifest for inter-agent discovery
- Resume past conversations from session files
- Kill removes agent and frees desk

### Mobile Support
- Open from your phone — same Tailscale URL, touch-optimized UI
- Instant sync — laptop and phone see the same state in real time over WebSocket
- Agent list view replaces isometric office on small screens
- Full conversation view with readable font sizes and two-row header
- Send & abort buttons for touch input
- Safe area insets for notch/home bar devices

### Notifications
- Sound notification when agent finishes and tab is unfocused
- Activity badge on desk when attention needed

### Self-hosted Persistent Server
- Works on a headless server — run on a Mac Mini or Linux box, access from anywhere via Tailscale
- Same conversations, same filesystem, every device updates in real time
- No syncing headaches — WebSocket keeps every connected device in lockstep

### Safety & Inter-agent
- Built-in safety hooks — blocks \`rm -rf\`, \`git reset --hard\`, and other footguns out of the box
- Agents can check on each other: inter-agent discovery via shared manifest
- Shared task board: humans and agents can create, assign, claim, and close tasks — full interop via UI and HTTP API

### Other
- Voice-to-text prompting and text-to-speech responses (requires HTTPS via Tailscale for remote access)
- Custom commands in addition to your own, all with autocomplete: e.g. /isomux-peer-review to review another agent's work, or /isomux-all-hands to see what everyone is up to

## Guidelines
- Keep responses concise (2-4 sentences unless more detail is asked for)
- Be friendly and enthusiastic about Isomux
- NEVER make up features or capabilities that aren't listed above. If you don't know, say so and point them to the GitHub repo or blog post.
- When answering about limits (e.g. number of agents), use only the information above — don't speculate.`;

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
