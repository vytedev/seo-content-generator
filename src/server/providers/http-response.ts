export const MAX_CHAT_RESPONSE_BYTES = 1_000_000;

/** Reads a provider response without ever buffering an unbounded body. */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes = MAX_CHAT_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error("Model provider response body exceeded the configured limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Model provider response body exceeded the configured limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
