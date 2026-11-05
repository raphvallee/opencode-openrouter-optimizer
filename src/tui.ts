/** TUI part: surface routing failures as transient toasts in the terminal UI. */

import { Plugin } from "@opencode/plugin/tui";

import { FailureDedupe, isRoutingFailure, syntheticFromInbox, toastText } from "./failure.js";
import type { SyntheticPayload } from "./failure.js";

export default Plugin.define({
  id: "openrouter-optimizer.tui",
  setup(context) {
    // The "noTUI" option disables this part: setup returns without registering
    // anything, so no toasts are raised. The server part validates the option
    // strictly and aborts startup on a bad value; here an invalid value only
    // warns and keeps toasts on, since failing the TUI host over this option
    // would be worse than ignoring it.
    const raw = context.options?.noTUI;
    if (raw === true || raw === "true") return;
    if (raw !== undefined && raw !== false && raw !== "false") {
      console.warn(
        `[openrouter-optimizer] ignoring invalid option "noTUI": expected a boolean, got ${typeof raw}`,
      );
    }

    // The server part writes a synthetic message whenever a request could not be
    // routed and was sent unfiltered. Echo those as error toasts so the failure is
    // visible even when the user is not reading the transcript. Deduped per
    // session+text: the server already throttles per process, and this keeps a
    // multi-retry burst from flooding the screen.
    //
    // Two transports carry the same message: current OpenCode versions publish
    // it as a synthetic inbox item (`session.inbox.enqueued`), and the
    // `session.synthetic` event remains the documented shape. Both funnel into
    // one handler so a future release moving back to the direct event keeps
    // toasts working.
    const shown = new FailureDedupe();
    const notify = (payload: SyntheticPayload | undefined | null): void => {
      if (!isRoutingFailure(payload)) return;
      const text = toastText(payload);
      if (!shown.once(payload.sessionID, text)) return;
      context.ui.toast.show({
        title: "OpenRouter optimizer",
        message: text,
        variant: "error",
        duration: 8000,
        sessionID: payload.sessionID,
      });
    };
    const offs = [
      context.data.on("session.synthetic", (event) => {
        try {
          notify(event.data as SyntheticPayload);
        } catch (error) {
          // A toast must never take the TUI host down with it.
          console.warn(
            "[openrouter-optimizer] failed to render routing failure:",
            error instanceof Error ? error.message : error,
          );
        }
      }),
      context.data.on("session.inbox.enqueued", (event) => {
        try {
          notify(syntheticFromInbox(event.data));
        } catch (error) {
          // A toast must never take the TUI host down with it.
          console.warn(
            "[openrouter-optimizer] failed to render routing failure:",
            error instanceof Error ? error.message : error,
          );
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  },
});
