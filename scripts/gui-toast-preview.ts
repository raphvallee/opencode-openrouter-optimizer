/**
 * Drives the built GUI part (dist/gui-experimental.cjs) against a stub desktop
 * host, the way scripts/toast-preview.ts previews the TUI toast: it loads the
 * real Plugin.define from the shipped bundle, registers it under a real Solid
 * root, and dispatches one routing-failure synthetic event. The stub toast
 * prints what the desktop app would draw in a window's corner.
 *
 * The real toast appears in the OpenCode Desktop window (desktop app and web
 * tabs alike) when the loaded plugin's server part writes a `Routing failure`
 * synthetic message; this script shows the exact payload the bundle sends.
 */

import * as guiPluginModule from "@opencode/plugin/gui";
import * as solidJs from "solid-js";
import { createRoot } from "solid-js";

const source = await Bun.file("dist/gui-experimental.cjs").text();
if (source.length === 0) throw new Error("dist/gui-experimental.cjs is empty; run bun run build");

// Evaluate the bundle like a CommonJS host would. The require is stubbed
// because @opencode/plugin/gui ships only an "import" condition in its exports
// map; the desktop host resolves it with require(esm), which no CJS sandbox
// here matches. Redirecting the host-provided modules is what the wiring above
// the bundle assumes anyway.
const requireStub = (spec: string): unknown => {
  if (spec === "@opencode/plugin/gui")
    return { ...guiPluginModule, default: guiPluginModule.Plugin };
  if (spec === "solid-js") return solidJs;
  throw new Error(`unexpected require in gui bundle: ${spec}`);
};
const mod = { exports: {} as Record<string, unknown> };
new Function("exports", "require", "module", "__filename", "__dirname", source)(
  mod.exports,
  requireStub,
  mod,
  "dist/gui-experimental.cjs",
  "dist",
);
const guiPlugin = mod.exports.default as { setup(ctx: unknown): unknown };

const toasts: Array<Record<string, unknown>> = [];
let onSynthetic: ((event: unknown) => void) | undefined;

const ctx = {
  options: {},
  servers: {
    list: () => ["sidecar"],
    get: (id: string) =>
      id === "sidecar"
        ? {
            data: {
              on: (_type: string, handler: (event: unknown) => void) => {
                onSynthetic = handler;
                return () => {
                  onSynthetic = undefined;
                };
              },
            },
          }
        : undefined,
  },
  toast: {
    show: (toast: Record<string, unknown>) => {
      toasts.push(toast);
    },
  },
};

createRoot((dispose) => {
  guiPlugin.setup(ctx);
  return dispose;
});

// Solid queues render effects; one macrotask flushes both keyed runs.
await new Promise((resolve) => setTimeout(resolve, 20));
if (!onSynthetic) {
  throw new Error("the bundle never registered the session.synthetic listener");
}

const failure = {
  data: {
    sessionID: "ses_demo",
    text: "OpenRouter optimizer could not route vendor/model (no ranking available); the request was sent unfiltered.",
    description: "Routing failure",
    metadata: { "openrouter-optimizer": { kind: "routing-failure" } },
  },
};

console.log("=== desktop window toast: what ctx.toast.show receives ===");
onSynthetic(failure);
console.log(JSON.stringify(toasts[0], null, 2));

console.log("=== the same event again: suppressed by dedupe ===");
onSynthetic(failure);
console.log(toasts.length === 1 ? "suppressed (1 toast total)" : "LEAKED (more than 1 toast)");

console.log("=== an unrelated synthetic message: ignored ===");
onSynthetic({
  data: { sessionID: "ses_demo", text: "Instructions updated", description: undefined },
});
console.log(toasts.length === 1 ? "ignored (1 toast total)" : "MISMATCH (toast shown)");
