import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  deleteInput,
  InputError,
  listInputs,
  maxUploadBytes,
  saveInput,
  validateInputName,
} from "../../src/workbench/inputs";

const CSV = new TextEncoder().encode("group,value\nA,1\nB,2\n");

async function root() {
  return join(await mkdtemp(join(tmpdir(), "workbench-inputs-")), "inputs");
}

async function* chunks(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}

async function failure(promise: Promise<unknown>): Promise<InputError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InputError) return error;
    throw error;
  }
  throw new Error("Expected an InputError");
}

test("accepted names are single segments with an allowed extension", () => {
  for (const name of [
    "synthetic.csv",
    "Sales 2026-Q3.xlsx",
    "数据_v2.parquet",
    "a.JSON",
  ])
    expect(validateInputName(name)).toBe(name);
});

test("traversal, separators, hidden prefixes and other extensions are rejected", () => {
  for (const name of [
    "../secret.csv",
    "a/b.csv",
    "a\\b.csv",
    "..csv",
    "a..csv",
    ".hidden.csv",
    "-flag.csv",
    "trailing.csv ",
    "nul\0.csv",
    "script.py",
    "archive.csv.zip",
    "csv",
    "",
    `${"x".repeat(130)}.csv`,
  ])
    expect(() => validateInputName(name)).toThrow(InputError);
});

test("an upload is stored with size and checksum and then listed", async () => {
  const directory = await root();
  const saved = await saveInput(
    "synthetic.csv",
    chunks(CSV.subarray(0, 5), CSV.subarray(5)),
    { maxBytes: 1024, expectedBytes: CSV.length },
    directory,
  );
  const digest = createHash("sha256").update(CSV).digest("hex");
  expect(saved).toMatchObject({
    name: "synthetic.csv",
    size_bytes: CSV.length,
    sha256: digest,
  });
  expect(await readFile(join(directory, "synthetic.csv"))).toEqual(
    Buffer.from(CSV),
  );
  expect(await listInputs(directory)).toEqual([saved]);
  // No temporary file is left behind.
  expect(await readdir(join(directory, ".uploading"))).toEqual([]);
});

test("an existing name is never overwritten", async () => {
  const directory = await root();
  await saveInput("a.csv", chunks(CSV), { maxBytes: 1024 }, directory);
  const error = await failure(
    saveInput(
      "a.csv",
      chunks(new TextEncoder().encode("x\n")),
      { maxBytes: 1024 },
      directory,
    ),
  );
  expect(error.status).toBe(409);
  expect(await readFile(join(directory, "a.csv"))).toEqual(Buffer.from(CSV));
});

test("oversized, truncated and empty uploads leave the area unchanged", async () => {
  const directory = await root();
  const declaredTooLarge = await failure(
    saveInput(
      "big.csv",
      chunks(CSV),
      { maxBytes: 4, expectedBytes: 5 },
      directory,
    ),
  );
  expect(declaredTooLarge.status).toBe(413);
  const streamedTooLarge = await failure(
    saveInput("big.csv", chunks(CSV, CSV), { maxBytes: 30 }, directory),
  );
  expect(streamedTooLarge.status).toBe(413);
  const truncated = await failure(
    saveInput(
      "short.csv",
      chunks(CSV),
      { maxBytes: 1024, expectedBytes: CSV.length + 10 },
      directory,
    ),
  );
  expect(truncated.status).toBe(400);
  const empty = await failure(
    saveInput("empty.csv", chunks(), { maxBytes: 1024 }, directory),
  );
  expect(empty.status).toBe(400);
  expect(await listInputs(directory)).toEqual([]);
  expect(await readdir(join(directory, ".uploading"))).toEqual([]);
});

test("listing and deletion only see regular files with valid names", async () => {
  const directory = await root();
  await mkdir(directory, { recursive: true });
  const outside = join(directory, "..", "outside.csv");
  await writeFile(outside, CSV);
  await symlink(outside, join(directory, "link.csv"));
  await mkdir(join(directory, "folder.csv"));
  await writeFile(join(directory, "notes.txt"), "not an input");
  await writeFile(join(directory, "kept.csv"), CSV);
  expect((await listInputs(directory)).map((file) => file.name)).toEqual([
    "kept.csv",
  ]);
  expect((await failure(deleteInput("link.csv", directory))).status).toBe(404);
  expect((await failure(deleteInput("folder.csv", directory))).status).toBe(
    404,
  );
  expect((await failure(deleteInput("../outside.csv", directory))).status).toBe(
    400,
  );
  await deleteInput("kept.csv", directory);
  expect(await listInputs(directory)).toEqual([]);
  expect(await readFile(outside)).toEqual(Buffer.from(CSV));
});

test("a missing input area lists as empty", async () => {
  expect(await listInputs(await root())).toEqual([]);
});

test("the upload limit defaults to 100 MiB and rejects invalid overrides", () => {
  expect(maxUploadBytes({})).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  expect(maxUploadBytes({ WORKBENCH_MAX_UPLOAD_BYTES: "2048" })).toBe(2048);
  for (const value of ["0", "-1", "1.5", "abc"])
    expect(() =>
      maxUploadBytes({ WORKBENCH_MAX_UPLOAD_BYTES: value }),
    ).toThrow();
});
