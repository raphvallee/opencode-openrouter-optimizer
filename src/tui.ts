/** TUI part: surface routing failures as transient toasts in the terminal UI. */

import { Plugin } from "@opencode/plugin/tui";

import { sanitizeForOutput } from "./sanitize.js";

/**
 * Must match ROUTING_FAILURE_METADATA_KEY in src/plugin.ts. Duplicated on purpose:
 * this file runs in the TUI process and must not import server code (bun:sqlite).
 */
const METADATA_KEY = "openrouter-optimizer";
const DESCRIPTION = "Routing failure";

/** Cap the dedupe set so a long-running TUI cannot grow it without bound. */
const DEDUPE_CAP = 64;

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
    const shown = new Set<string>();
    const off = context.data.on("session.synthetic", (event) => {
      try {
        const data = event.data;
        if (!data || typeof data.sessionID !== "string" || typeof data.text !== "string") return;
        const meta = data.metadata as Record<string, unknown> | undefined;
        const flag = meta?.[METADATA_KEY] as { kind?: unknown } | undefined;
        const isRoutingFailure =
          flag?.kind === "routing-failure" || data.description === DESCRIPTION;
        if (!isRoutingFailure) return;

        // Untrusted text (model ids, upstream errors) may carry control bytes;
        // strip them and clamp the length before it reaches the screen.
        const text = sanitizeForOutput(data.text, 300);
        const key = `${data.sessionID}:${text}`;
        if (shown.has(key)) return;
        if (shown.size >= DEDUPE_CAP) shown.clear();
        shown.add(key);

        context.ui.toast.show({
          title: "OpenRouter optimizer",
          message: text,
          variant: "error",
          duration: 8000,
          sessionID: data.sessionID,
        });
      } catch (error) {
        // A toast must never take the TUI host down with it.
        console.warn(
          "[openrouter-optimizer] failed to render routing failure:",
          error instanceof Error ? error.message : error,
        );
      }
    });
    return () => off();
  },
});
