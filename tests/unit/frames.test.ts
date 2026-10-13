import { expect, test } from "bun:test";
import { jsonLines } from "../../src/execution/frames";

async function* chunks(values: Uint8Array[]) {
  yield* values;
}
async function read(values: Uint8Array[], cap = 1024) {
  const result = [];
  for await (const line of jsonLines(chunks(values), cap))
    result.push(line.toString());
  return result;
}
test("bridge frames preserve fragmented UTF-8, multiple lines and exact byte boundaries", async () => {
  const data = Buffer.from('{"text":"中文"}\n\n{"done":true}\n');
  expect(await read([...data].map((b) => Buffer.from([b])))).toEqual([
    '{"text":"中文"}',
    '{"done":true}',
  ]);
  expect(await read([Buffer.from("1234\n12\n")], 4)).toEqual(["1234", "12"]);
  await expect(
    read([Buffer.from("1234"), Buffer.from("5\n")], 4),
  ).rejects.toThrow("oversized");
  await expect(read([Buffer.from("12345")], 4)).rejects.toThrow("oversized");
  await expect(read([Buffer.from("ok\nincomplete")])).rejects.toThrow(
    "incomplete",
  );
});
test("large artifact frame remains intact over many pipe chunks", async () => {
  const body = Buffer.alloc(20 * 1024 ** 2, 65);
  async function* stream() {
    for (let i = 0; i < body.length; i += 8192)
      yield body.subarray(i, i + 8192);
    yield Buffer.from("\n");
  }
  let count = 0;
  for await (const line of jsonLines(stream(), body.length)) {
    expect(line.equals(body)).toBe(true);
    count++;
  }
  expect(count).toBe(1);
});
