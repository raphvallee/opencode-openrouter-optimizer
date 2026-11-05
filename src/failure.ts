/**
 * Shared routing-failure display logic for the client parts (TUI, GUI). Runs
 * outside the server process and must not import server code (bun:sqlite), the
 * same rule src/tui.ts followed before the GUI part needed it too.
 */

import { sanitizeForOutput } from "./sanitize.js";

/**
 * Must match ROUTING_FAILURE_METADATA_KEY in src/plugin.ts. Duplicated on
 * purpose: this module runs in client processes and must not import server code
 * (bun:sqlite).
 */
export const METADATA_KEY = "openrouter-optimizer";
export const DESCRIPTION = "Routing failure";

/** The toast clamps untrusted text to this many characters on every platform. */
export const TOAST_TEXT_LIMIT = 300;

/** Cap the dedupe set so a long-running client cannot grow it without bound. */
export const DEDUPE_CAP = 64;

/** The synthetic-event payload our detection reads. Loosely typed on purpose. */
export interface SyntheticPayload {
  sessionID?: unknown;
  text?: unknown;
  description?: unknown;
  metadata?: unknown;
}

/** True when a `session.synthetic` event is one of the server part's failures. */
export function isRoutingFailure(
  data: SyntheticPayload | undefined | null,
): data is SyntheticPayload & { sessionID: string; text: string } {
  if (!data || typeof data.sessionID !== "string" || typeof data.text !== "string") return false;
  const meta = data.metadata as Record<string, unknown> | undefined;
  const flag = meta?.[METADATA_KEY] as { kind?: unknown } | undefined;
  return flag?.kind === "routing-failure" || data.description === DESCRIPTION;
}

/**
 * Normalize a synthetic item carried by a `session.inbox.enqueued` event into
 * the payload shape the `session.synthetic` event exposes. OpenCode publishes
 * the server part's synthetic messages only through the session inbox (no
 * top-level `session.synthetic` event on the SSE stream), so both transports
 * must funnel into the same detection. Returns undefined for non-synthetic
 * inbox items; a synthetic item without our metadata still flows through
 * `isRoutingFailure`, which rejects it there.
 */
export function syntheticFromInbox(data: unknown): SyntheticPayload | undefined {
  const inbox = data as
    | {
        sessionID?: unknown;
        item?: { type?: unknown; payload?: SyntheticPayload };
      }
    | undefined
    | null;
  const item = inbox?.item;
  if (!item || item.type !== "synthetic") return undefined;
  const payload = item.payload;
  if (!payload) return undefined;
  // The session ID lives at the inbox event level, not in the item payload.
  return { ...payload, sessionID: inbox.sessionID };
}

/**
 * The text a toast shows: untrusted text (model ids, upstream errors) may carry
 * control bytes; strip them and clamp the length before it reaches a screen.
 */
export function toastText(data: { text: string }): string {
  return sanitizeForOutput(data.text, TOAST_TEXT_LIMIT);
}

/**
 * Per-client dedupe for identical failures (session + sanitized text): the
 * server already throttles per process, and this keeps a multi-retry burst from
 * flooding the screen.
 */
export class FailureDedupe {
  private shown = new Set<string>();

  /** True the first time this session + text pair is seen, false after. */
  once(sessionID: string, text: string): boolean {
    const key = `${sessionID}:${text}`;
    if (this.shown.has(key)) return false;
    if (this.shown.size >= DEDUPE_CAP) this.shown.clear();
    this.shown.add(key);
    return true;
  }
}
