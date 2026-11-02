import { describe, expect, spyOn, test } from "bun:test";
import tuiPlugin from "../src/tui";

/** Minimal TUI host context: only what src/tui.ts touches. */
function makeContext(options: Record<string, unknown> = {}) {
  const toasts: Array<Record<string, unknown>> = [];
  let handler: ((event: unknown) => void) | undefined;
  const ctx = {
    options,
    data: {
      on: (_type: string, on: (event: unknown) => void) => {
        handler = on;
        return () => {
          handler = undefined;
        };
      },
    },
    ui: {
      toast: {
        show: (toast: Record<string, unknown>) => {
          toasts.push(toast);
        },
      },
    },
  };
  return { ctx, toasts, currentHandler: () => handler };
}

function routingFailure(sessionID = "ses_1", text = "Routing failure: no ranking") {
  return {
    data: {
      sessionID,
      text,
      description: "Routing failure",
      metadata: { "openrouter-optimizer": { kind: "routing-failure" } },
    },
  };
}

describe("tui part", () => {
  test("registers the synthetic listener and raises a toast by default", async () => {
    const { ctx, toasts, currentHandler } = makeContext();
    const cleanup = await tuiPlugin.setup(ctx as never);
    expect(currentHandler()).toBeDefined();

    currentHandler()!(routingFailure());
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.title).toBe("OpenRouter optimizer");
    expect(toasts[0]?.variant).toBe("error");

    // The same session+text is deduped.
    currentHandler()!(routingFailure());
    expect(toasts.length).toBe(1);

    cleanup?.();
  });

  test("noTUI: true disables the part without registering any listener", async () => {
    const { ctx, toasts, currentHandler } = makeContext({ noTUI: true });
    const cleanup = await tuiPlugin.setup(ctx as never);
    expect(currentHandler()).toBeUndefined();
    expect(cleanup).toBeUndefined();
    expect(toasts.length).toBe(0);
  });

  test("noTUI: 'true' (string form) also disables the part", () => {
    const { ctx, currentHandler } = makeContext({ noTUI: "true" });
    tuiPlugin.setup(ctx as never);
    expect(currentHandler()).toBeUndefined();
  });

  test("noTUI: false keeps toasts on", async () => {
    const { ctx, currentHandler } = makeContext({ noTUI: false });
    const cleanup = await tuiPlugin.setup(ctx as never);
    expect(currentHandler()).toBeDefined();
    cleanup?.();
  });

  test("an invalid noTUI value warns and keeps toasts on", async () => {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { ctx, toasts, currentHandler } = makeContext({ noTUI: 1 });
      const cleanup = await tuiPlugin.setup(ctx as never);
      expect(currentHandler()).toBeDefined();
      currentHandler()!(routingFailure());
      expect(toasts.length).toBe(1);
      expect(warnings.some((line) => line.includes('ignoring invalid option "noTUI"'))).toBe(true);
      cleanup?.();
    } finally {
      spy.mockRestore();
    }
  });
});
