/** Bounded reads for HTTP streams and Request bodies: never buffer without a cap. */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** The `content-length` header, as a finite number, when the sender is honest. */
function declaredLength(response: Response): number {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined || raw === "") return Number.NaN;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

/**
 * Read a stream chunk by chunk and abort as soon as it exceeds maxBytes, so the
 * full payload is never buffered. Returns the bytes read; throws on overflow.
 */
async function readStreamLimited(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  context: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${context} exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Read the body and parse it as JSON. Aborts with an error as soon as the stream
 * exceeds maxBytes, so a hostile or broken upstream cannot exhaust memory. Falls
 * back to response.text() when the body is not a readable stream (unit tests).
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
  context = "response",
): Promise<unknown> {
  const declared = declaredLength(response);
  if (declared > maxBytes) {
    throw new Error(`${context} exceeds ${maxBytes} bytes (content-length: ${declared})`);
  }
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error(`${context} exceeds ${maxBytes} bytes`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${context} is not valid JSON`);
    }
  }
  const merged = await readStreamLimited(body, maxBytes, context);
  const text = new TextDecoder().decode(merged);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${context} is not valid JSON`);
  }
}

/**
 * Read a Request/Response body stream as text with a hard byte ceiling; used for
 * bodies that are not JSON (the outbound request body clone). A missing body
 * reads as the empty string.
 */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  context = "body",
): Promise<string> {
  if (!body || typeof body.getReader !== "function") return "";
  const merged = await readStreamLimited(body, maxBytes, context);
  return new TextDecoder().decode(merged);
}
