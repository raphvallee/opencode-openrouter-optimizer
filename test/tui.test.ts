import { describe, expect, spyOn, test } from "bun:test";

import tuiPlugin from "../src/tui.js";

/** Minimal TUI host context: only what src/tui.ts touches. Handlers are kept per event type. */
function makeContext(options: Record<string, unknown> = {}) {
  const toasts: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const ctx = {
    options,
    data: {
      on: (type: string, on: (event: unknown) => void) => {
        handlers.set(type, on);
        return () => {
          handlers.delete(type);
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
  return {
    ctx,
    toasts,
    currentHandler: (type: string) => handlers.get(type),
    allHandlers: () => handlers.size,
  };
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

/** A synthetic inbox item exactly as newer OpenCode transports publish it. */
function inboxRoutingFailure(
  sessionID = "ses_1",
  text = "Routing failure: no ranking",
  description = "Routing failure",
  withMetadata = true,
) {
  return {
    data: {
      sessionID,
      inboxID: "msg_1",
      item: {
        type: "synthetic",
        payload: {
          text,
          description,
          ...(withMetadata
            ? { metadata: { "openrouter-optimizer": { kind: "routing-failure" } } }
            : {}),
        },
        delivery: "steer",
      },
    },
  };
}

describe("tui part", () => {
  test("registers both synthetic transports and raises a toast by default", async () => {
    const { ctx, toasts, currentHandler, allHandlers } = makeContext();
    const cleanup = await tuiPlugin.setup(ctx as never);
    expect(currentHandler("session.synthetic")).toBeDefined();
    expect(currentHandler("session.inbox.enqueued")).toBeDefined();
    expect(allHandlers()).toBe(2);

    currentHandler("session.synthetic")!(routingFailure());
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.title).toBe("OpenRouter optimizer");
    expect(toasts[0]?.variant).toBe("error");

    // The same session+text is deduped within and across transports.
    currentHandler("session.synthetic")!(routingFailure());
    currentHandler("session.inbox.enqueued")!(inboxRoutingFailure());
    expect(toasts.length).toBe(1);

    cleanup?.();
  });

  test("an inbox-published synthetic item raises the same toast", async () => {
    const { ctx, toasts, currentHandler } = makeContext();
    const cleanup = await tuiPlugin.setup(ctx as never);
    currentHandler("session.inbox.enqueued")!(inboxRoutingFailure("ses_2"));
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.title).toBe("OpenRouter optimizer");
    expect(toasts[0]?.variant).toBe("error");
    cleanup?.();
  });

  test("a synthetic inbox item from another plugin never toasts", async () => {
    const { ctx, toasts, currentHandler } = makeContext();
    const cleanup = await tuiPlugin.setup(ctx as never);
    currentHandler("session.inbox.enqueued")!(
      inboxRoutingFailure("ses_3", "Some other plugin's synthetic message", "Other plugin", false),
    );
    currentHandler("session.inbox.enqueued")!({
      data: {
        sessionID: "ses_3",
        inboxID: "msg_2",
        item: { type: "user", payload: { text: "hi" } },
      },
    });
    expect(toasts.length).toBe(0);
    cleanup?.();
  });

  test("noTUI: true disables the part without registering any listener", async () => {
    const { ctx, toasts, currentHandler, allHandlers } = makeContext({ noTUI: true });
    const cleanup = await tuiPlugin.setup(ctx as never);
    expect(allHandlers()).toBe(0);
    expect(currentHandler("session.synthetic")).toBeUndefined();
    expect(cleanup).toBeUndefined();
    expect(toasts.length).toBe(0);
  });

  test("noTUI: 'true' (string form) also disables the part", () => {
    const { ctx, currentHandler } = makeContext({ noTUI: "true" });
    tuiPlugin.setup(ctx as never);
    expect(currentHandler("session.synthetic")).toBeUndefined();
  });

  test("noTUI: false keeps toasts on", async () => {
    const { ctx, currentHandler } = makeContext({ noTUI: false });
    const cleanup = await tuiPlugin.setup(ctx as never);
    expect(currentHandler("session.synthetic")).toBeDefined();
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
      expect(currentHandler("session.synthetic")).toBeDefined();
      currentHandler("session.synthetic")!(routingFailure());
      expect(toasts.length).toBe(1);
      expect(warnings.some((line) => line.includes('ignoring invalid option "noTUI"'))).toBe(true);
      cleanup?.();
    } finally {
      spy.mockRestore();
    }
  });
});
