import { expect, test } from "bun:test";
import {
  samePredictions,
  validatePredictions,
} from "../../src/modeling/predictions";
import { createProtocol } from "../../src/modeling/protocol";

const p = createProtocol("binary", "roc_auc", ["01", "1"], "01", "id");
const columns = ["id", "prediction", "probability_0", "probability_1"];
const valid = [
  ["b", "1", "0.2", "0.8"],
  ["a", "01", "0.5", "0.5"],
];
test("host prediction validation aligns IDs and rejects untrusted class/probability artifacts", () => {
  expect(
    validatePredictions({ columns, rows: valid }, ["a", "b"], "id", p),
  ).toEqual({
    values: ["01", "1"],
    probabilities: [
      [0.5, 0.5],
      [0.2, 0.8],
    ],
  });
  for (const rows of [
    [valid[0] ?? [], valid[0] ?? []],
    [valid[0] ?? []],
    [...valid, ["c", "01", "1", "0"]],
    [["c", "1", "0.2", "0.8"], valid[1] ?? []],
    [["b", "unknown", "0.2", "0.8"], valid[1] ?? []],
    [["b", "1", "-0.1", "1.1"], valid[1] ?? []],
    [["b", "1", "0.1", "0.8"], valid[1] ?? []],
    [["b", "1", "NaN", "0.8"], valid[1] ?? []],
    [["b", "01", "0.2", "0.8"], valid[1] ?? []],
    [valid[0] ?? [], ["a", "1", "0.5", "0.5"]],
  ])
    expect(() =>
      validatePredictions({ columns, rows }, ["a", "b"], "id", p),
    ).toThrow();
  expect(() =>
    validatePredictions(
      { columns: [...columns, "extra"], rows: valid },
      ["a", "b"],
      "id",
      p,
    ),
  ).toThrow();
});
test("reproduction matches labels exactly and probabilities within frozen tolerance", () => {
  const a = { values: ["01"], probabilities: [[0.6, 0.4]] };
  expect(
    samePredictions(
      a,
      { values: ["1"], probabilities: a.probabilities },
      1e-8,
      1e-6,
    ),
  ).toBe(false);
  expect(
    samePredictions(
      a,
      { values: ["01"], probabilities: [[0.60000001, 0.39999999]] },
      1e-8,
      1e-6,
    ),
  ).toBe(true);
  expect(
    samePredictions(
      a,
      { values: ["01"], probabilities: [[0.61, 0.39]] },
      1e-8,
      1e-6,
    ),
  ).toBe(false);
});
