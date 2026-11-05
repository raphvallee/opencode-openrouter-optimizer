import { describe, expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";

import guiPlugin from "../src/gui.js";
import { syntheticFromInbox } from "../src/failure.js";

/** Solid queues render effects; real GUI windows flush them in a frame. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Minimal GUI host context: only what src/gui.tsx touches. Handlers are kept per event type. */
function makeContext(options: Record<string, unknown> = {}) {
  const toasts: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const data = {
    on: (type: string, on: (event: unknown) => void) => {
      handlers.set(type, on);
      return () => {
        handlers.delete(type);
      };
    },
  };
  const ctx = {
    options,
    servers: {
      list: () => ["sidecar"],
      get: (id: string) => (id === "sidecar" ? { data } : undefined),
    },
    toast: {
      show: (toast: Record<string, unknown>) => {
        toasts.push(toast);
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
function inboxRoutingFailure(sessionID = "ses_1", text = "Routing failure: no ranking") {
  return {
    data: {
      sessionID,
      inboxID: "msg_1",
      item: {
        type: "synthetic",
        payload: {
          text,
          description: "Routing failure",
          metadata: { "openrouter-optimizer": { kind: "routing-failure" } },
        },
        delivery: "steer",
      },
    },
  };
}

/** Runs setup under a Solid owner the way every desktop window does. */
function setup(ctx: Record<string, unknown>) {
  const dispose = createRoot((own) => {
    guiPlugin.setup!(ctx as never);
    return own;
  });
  return () => void dispose;
}

describe("syntheticFromInbox", () => {
  test("maps a synthetic inbox item and carries the session ID over", () => {
    const payload = syntheticFromInbox({
      sessionID: "ses_9",
      inboxID: "msg_9",
      item: {
        type: "synthetic",
        payload: { text: "t", description: "Routing failure", metadata: {} },
        delivery: "steer",
      },
    });
    expect(payload?.sessionID).toBe("ses_9");
    expect(payload?.text).toBe("t");
    expect(payload?.description).toBe("Routing failure");
  });

  test("returns undefined for user items and for synthetic items without a payload", () => {
    expect(
      syntheticFromInbox({ sessionID: "s", item: { type: "user", payload: { text: "hi" } } }),
    ).toBeUndefined();
    expect(
      syntheticFromInbox({ sessionID: "s", item: { type: "synthetic", payload: undefined } }),
    ).toBeUndefined();
    expect(syntheticFromInbox(null)).toBeUndefined();
    expect(syntheticFromInbox(undefined)).toBeUndefined();
    expect(syntheticFromInbox({})).toBeUndefined();
  });
});

describe("gui part", () => {
  test("watches the listed servers and raises a toast by default", async () => {
    const { ctx, toasts, currentHandler } = makeContext();
    setup(ctx);
    await flush();
    await flush();
    const handler = currentHandler("session.synthetic");
    expect(handler).toBeDefined();
    expect(currentHandler("session.inbox.enqueued")).toBeDefined();

    handler!(routingFailure());
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.title).toBe("OpenRouter optimizer");
    expect(toasts[0]?.description).toBe("Routing failure: no ranking");
    expect(toasts[0]?.variant).toBe("error");
    expect(toasts[0]?.duration).toBe(8000);
  });

  test("an inbox-published synthetic item raises the same toast", async () => {
    const { ctx, toasts, currentHandler } = makeContext();
    setup(ctx);
    await flush();
    await flush();
    currentHandler("session.inbox.enqueued")!(inboxRoutingFailure("ses_2"));
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.description).toBe("Routing failure: no ranking");

    // The same session+text dedupes across both transports.
    currentHandler("session.synthetic")!(routingFailure("ses_2"));
    expect(toasts.length).toBe(1);
  });

  test("the same session+text is deduped", async () => {
    const { ctx, toasts, currentHandler } = makeContext();
    setup(ctx);
    await flush();
    await flush();

    currentHandler("session.synthetic")!(routingFailure());
    currentHandler("session.synthetic")!(routingFailure());
    expect(toasts.length).toBe(1);
  });

  test("noGUI: true disables the part without registering any listener", async () => {
    const { ctx, toasts, currentHandler, allHandlers } = makeContext({ noGUI: true });
    setup(ctx);
    await flush();
    await flush();
    expect(allHandlers()).toBe(0);
    expect(currentHandler("session.synthetic")).toBeUndefined();
    expect(toasts.length).toBe(0);
  });

  test("noGUI: 'true' (string form) also disables the part", async () => {
    const { ctx, currentHandler } = makeContext({ noGUI: "true" });
    setup(ctx);
    await flush();
    await flush();
    expect(currentHandler("session.synthetic")).toBeUndefined();
  });

  test("noGUI: false keeps toasts on", async () => {
    const { ctx, currentHandler } = makeContext({ noGUI: false });
    setup(ctx);
    await flush();
    await flush();
    expect(currentHandler("session.synthetic")).toBeDefined();
  });

  test("an invalid noGUI value warns and keeps toasts on", async () => {
    const warnings: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { ctx, toasts, currentHandler } = makeContext({ noGUI: 1 });
      setup(ctx);
      await flush();
      await flush();
      const handler = currentHandler("session.synthetic");
      expect(handler).toBeDefined();
      handler!(routingFailure());
      expect(toasts.length).toBe(1);
      expect(warnings.some((line) => line.includes('ignoring invalid option "noGUI"'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("disposing the window owner removes the listener", async () => {
    const { ctx, currentHandler } = makeContext();
    let dispose: () => void = () => {};
    createRoot((own) => {
      dispose = own;
      guiPlugin.setup!(ctx as never);
    });
    await flush();
    await flush();
    expect(currentHandler("session.synthetic")).toBeDefined();

    dispose();
    expect(currentHandler("session.synthetic")).toBeUndefined();
    expect(currentHandler("session.inbox.enqueued")).toBeUndefined();
  });
});
