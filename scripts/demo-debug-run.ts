/**
 * Demo: run the real plugin against a real OpenRouter request of "." to
 * z-ai/glm-5.3-flash (reasoning effort low), with debug + debugBlacklistReasons
 * enabled, and capture all log output. Usage: bun run scripts/demo-debug-run.ts
 */

import { definePlugin } from "../src/plugin.js";

// Capture all console output so nothing is lost.
const logs: string[] = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const origInfo = console.info;

console.log = (...args: unknown[]) => {
  logs.push(args.map(String).join(" "));
  origLog(...args);
};
console.warn = (...args: unknown[]) => {
  logs.push(`[WARN] ${args.map(String).join(" ")}`);
  origWarn(...args);
};
console.error = (...args: unknown[]) => {
  logs.push(`[ERROR] ${args.map(String).join(" ")}`);
  origError(...args);
};
console.info = (...args: unknown[]) => {
  logs.push(`[INFO] ${args.map(String).join(" ")}`);
  origInfo(...args);
};

async function main() {
  const hooks = new Map<string, { handler: (event: unknown) => Promise<void> }>();
  const ctx = {
    options: {},
    event: { subscribe: async function* () {} },
    session: {
      hook: async (name: string, handler: (event: unknown) => Promise<void>) => {
        hooks.set(name, { handler });
        return { dispose: async () => {} };
      },
    },
  };

  const plugin = definePlugin({
    dbPath: ":memory:",
    debug: true,
    debugBlacklistReasons: true,
    keepAtLeastN: 2,
    statsRun: async () => JSON.stringify({ models: [] }),
  } as never);

  await plugin.setup!(ctx as never);
  const handler = hooks.get("http.request")!.handler;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey)
    origWarn(
      "OPENROUTER_API_KEY is not set; endpoint ranking will use the public endpoints API only, and no request body will be sent to OpenRouter",
    );

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const request = new Request("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "z-ai/glm-5.3-flash",
      messages: [{ role: "user", content: "." }],
      reasoning: { effort: "low" },
    }),
  });

  const evt = {
    request,
    model: { providerID: "openrouter" },
    kind: "primary",
  };

  origLog("=== sending request to z-ai/glm-5.3-flash (reasoning effort: low) ===");
  await handler(evt);

  // Give the background ranking and any async logging time to finish.
  await new Promise((resolve) => setTimeout(resolve, 8000));

  origLog("=== captured logs ===");
  for (const line of logs) origLog(line);
  process.exit(0);
}

main().catch((error) => {
  origError(error);
  process.exit(1);
});
