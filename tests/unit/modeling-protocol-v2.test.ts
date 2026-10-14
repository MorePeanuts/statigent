import { expect, test } from "bun:test";
import { modelingMain } from "../../src/modeling/cli";
import { createProtocol, validateProtocol } from "../../src/modeling/protocol";
import {
  createProtocolV2,
  predictionColumnsV2,
  validateProtocolV2,
} from "../../src/modeling/protocol-v2";
import { obj } from "../../src/models/validation";
import fixtures from "../fixtures/modeling-protocol-v2.json";

test("shared V2 fixtures freeze every metric, original labels and target ordering", () => {
  for (const fixture of fixtures.valid) {
    expect<unknown>(createProtocolV2(fixture.input)).toEqual(fixture.protocol);
    const protocol = validateProtocolV2(fixture.protocol, "id");
    const columns = predictionColumnsV2(protocol);
    expect(new Set(columns).size).toBe(columns.length);
    if (protocol.output === "ranked-labels")
      expect(predictionColumnsV2(protocol, false)).toEqual(["id", "ranked_0"]);
  }
});
test("shared invalid fixtures reject missing fields, combinations, mappings and tampering", () => {
  for (const fixture of fixtures.invalid_inputs)
    expect(() => createProtocolV2(fixture.input)).toThrow();
  for (const fixture of fixtures.invalid_protocols)
    expect(() => validateProtocolV2(fixture.protocol)).toThrow();
  expect(() =>
    validateProtocolV2(fixtures.valid[0]?.protocol, "wrong-id"),
  ).toThrow();
});
test("legacy V1 hashes and protocol parsing remain unchanged", () => {
  const protocol = createProtocol(
    "binary",
    "log_loss",
    ["01", "1"],
    "01",
    "id",
  );
  expect<unknown>(protocol).toEqual(fixtures.legacy_v1);
  expect(validateProtocol(fixtures.legacy_v1, "id")).toEqual(protocol);
  expect(() => validateProtocolV2(fixtures.legacy_v1)).toThrow();
});

test("documented synthetic protocol previews require no model configuration", async () => {
  for (const name of ["multilabel", "ranked"]) {
    const result = obj(
      await modelingMain([
        "protocol",
        "--config",
        `configs/modeling/protocol-${name}.json`,
      ]),
    );
    expect(result.scope).toBe("protocol-only");
    expect(result.llm_calls).toBe(0);
    expect(result.execution).toBe("not_checked");
    validateProtocolV2(result.protocol);
  }
  await expect(
    modelingMain(["protocol", "--config", "ignored", "--model", "paid"]),
  ).rejects.toThrow();
});
