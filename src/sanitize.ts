/**
 * Output sanitizers: strip control characters before strings reach a terminal,
 * the TUI or the transcript. Untrusted upstream text (provider slugs, permaslugs,
 * model ids, error messages) can carry ANSI/OSC sequences that rewrite the screen
 * or forge links; removing every control character closes that hole.
 */

/** Remove every control character (C0, DEL, C1); keep everything else. */
export function stripControlChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += "?";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Replace control chars with "?" and clamp length. Safe for any single-line output. */
export function sanitizeForOutput(input: unknown, maxLength = 200): string {
  const raw = typeof input === "string" ? input : String(input ?? "");
  const out = stripControlChars(raw);
  return out.length > maxLength ? `${out.slice(0, Math.max(0, maxLength - 3))}...` : out;
}

/** Sanitize the message of an unknown caught value; never injects the object itself. */
export function errorMessage(error: unknown, maxLength = 200): string {
  return sanitizeForOutput(error instanceof Error ? error.message : error, maxLength);
}
