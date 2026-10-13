import { ProtocolError } from "./protocol";

/** A large model frame is assembled once, not copied for every pipe chunk. */
export async function* jsonLines(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [],
    bytes = 0;
  for await (const chunk of chunks) {
    const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (start < data.length) {
      const end = data.indexOf(10, start);
      const part = data.subarray(start, end < 0 ? data.length : end);
      bytes += part.length;
      if (bytes > maxBytes) throw new ProtocolError("oversized bridge frame");
      if (part.length) parts.push(part);
      if (end < 0) break;
      if (bytes) yield Buffer.concat(parts, bytes);
      parts = [];
      bytes = 0;
      start = end + 1;
    }
  }
  if (bytes) throw new ProtocolError("incomplete final JSONL frame");
}
