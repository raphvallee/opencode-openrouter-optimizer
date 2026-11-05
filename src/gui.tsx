/**
 * GUI part: surface routing failures as transient toasts in OpenCode Desktop
 * windows (desktop app and web tabs both run this setup). The build compiles
 * this entry to the CommonJS bundle the `./gui-experimental` export points at.
 */

import { createKeyed, Plugin, type Context } from "@opencode/plugin/gui";
import { onCleanup } from "solid-js";

import {
  FailureDedupe,
  isRoutingFailure,
  syntheticFromInbox,
  toastText,
  type SyntheticPayload,
} from "./failure.js";

const TOAST_TITLE = "OpenRouter optimizer";
const TOAST_DURATION_MS = 8000;

/** Watches one listed server's data stream; its owner ends with a reconnect. */
function watchServer(ctx: Context, id: string): void {
  createKeyed(
    // Read per access so a restarted server (new connection under the same id)
    // gets a fresh listener, and an unreachable one forgets its listener.
    () => ctx.servers.get(id)?.data,
    (data) => {
      const shown = new FailureDedupe();
      // Two transports carry the same synthetic message: current OpenCode
      // versions publish it as a synthetic inbox item (`session.inbox.enqueued`),
      // and the `session.synthetic` event remains the documented shape. One
      // handler for both keeps toasts working across releases.
      const notify = (payload: SyntheticPayload | undefined | null): void => {
        try {
          if (!isRoutingFailure(payload)) return;
          const text = toastText(payload);
          if (!shown.once(payload.sessionID, text)) return;
          ctx.toast.show({
            title: TOAST_TITLE,
            description: text,
            variant: "error",
            duration: TOAST_DURATION_MS,
          });
        } catch (error) {
          // A toast must never take the window down with it.
          console.warn(
            "[openrouter-optimizer] failed to render routing failure:",
            error instanceof Error ? error.message : error,
          );
        }
      };
      onCleanup(data.on("session.synthetic", (event) => notify(event.data as SyntheticPayload)));
      onCleanup(
        data.on("session.inbox.enqueued", (event) => notify(syntheticFromInbox(event.data))),
      );
    },
  );
}

export default Plugin.define({
  setup(ctx) {
    // The "noGUI" option disables this part, the way "noTUI" disables the TUI
    // part: setup returns without listening. The server part validates the
    // option strictly and aborts startup on a bad value; here an invalid value
    // only warns and keeps toasts on, since failing every window over this
    // option would be worse than ignoring it.
    const raw = ctx.options?.noGUI;
    if (raw === true || raw === "true") return;
    if (raw !== undefined && raw !== false && raw !== "false") {
      console.warn(
        `[openrouter-optimizer] ignoring invalid option "noGUI": expected a boolean, got ${typeof raw}`,
      );
    }

    // Follow every listed server (the app's own sidecar plus any remote ones),
    // re-watched when the list changes; a run's onCleanup ends its listener.
    createKeyed(
      () => ctx.servers.list().join("\n"),
      () => {
        for (const id of ctx.servers.list()) {
          watchServer(ctx, id);
        }
      },
    );
  },
});
