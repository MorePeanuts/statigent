import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validBase64 } from "../../src/execution/base64";
import { parseBridgeMessage } from "../../src/execution/protocol";
import { RunRecorder, readArtifact } from "../../src/records/store";

test("Base64 validation preserves alphabet and padding rules without repeated-group matching", () => {
  for (const value of ["", "AAAA", "AA==", "AAA=", "Ab+/", "AB==", "AAB="])
    expect(validBase64(value)).toBe(true);
  for (const value of [
    "A",
    "AA",
    "AAA",
    "AAAA=",
    "====",
    "A===",
    "AA=A",
    "=AAA",
    "AAA\n",
    "AA A",
    "AA-_",
    "AAéA",
  ])
    expect(validBase64(value)).toBe(false);
});

test("a model larger than 16 MiB passes bridge validation and artifact persistence intact", async () => {
  const bytes = Buffer.alloc(17 * 1024 ** 2, 37),
    encoded = bytes.toString("base64");
  expect(validBase64(encoded)).toBe(true);
  expect(validBase64(`${encoded.slice(0, -4)}A===`)).toBe(false);
  expect(validBase64(`${encoded.slice(0, -4)}AAA?`)).toBe(false);
  const value = {
    protocol_version: 1,
    session_id: "session-1",
    request_id: "request-1",
    kernel_epoch: 1,
    type: "artifact",
    path: "model.joblib",
    mime_type: "application/octet-stream",
    data_base64: encoded,
  };
  const frame = JSON.stringify(value);
  const message = parseBridgeMessage(
    frame,
    Buffer.byteLength(frame),
    "session-1",
  );
  expect(message.type).toBe("artifact");
  const root = await mkdtemp(join(tmpdir(), "large-artifact-"));
  try {
    const record = await RunRecorder.create({
      runRoot: root,
      config: {},
      inputs: [],
      image: { id: "test", platform: "test" },
      maxArtifactBytes: bytes.length,
      maxTotalArtifactBytes: bytes.length,
    });
    const artifact = await record.onArtifact(message);
    expect(artifact.size_bytes).toBe(bytes.length);
    expect(await readArtifact(record.directory, artifact)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
