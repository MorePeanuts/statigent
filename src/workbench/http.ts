import { InputError } from "./inputs";

/** Expected client errors keep their message; anything else is logged and hidden from the browser. */
export function errorResponse(error: unknown, operation: string): Response {
  if (error instanceof InputError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error(`[workbench] ${operation} failed`, error);
  return Response.json({ error: `${operation} failed` }, { status: 500 });
}

export async function* streamChunks(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Stops the transfer when saving aborts early (size limit, conflict) instead of draining it.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
