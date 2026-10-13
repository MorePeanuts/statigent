import { finite, rowIds, select, type Table } from "./data";
import type { Protocol } from "./protocol";
export interface Predictions {
  values: (number | string)[];
  probabilities: number[][] | null;
}
export function validatePredictions(
  table: Table,
  expected: string[],
  id: string,
  p: Protocol,
): Predictions {
  const columns = [
    id,
    p.prediction.column,
    ...p.prediction.probability_columns,
  ];
  if (JSON.stringify(table.columns) !== JSON.stringify(columns))
    throw new Error("Invalid prediction columns");
  const ids = rowIds(table, id),
    members = new Set(expected);
  if (
    new Set(expected).size !== expected.length ||
    ids.length !== expected.length ||
    ids.some((v) => !members.has(v))
  )
    throw new Error("Prediction membership mismatch");
  const aligned = select(table, expected, id);
  const values = aligned.rows.map((r) => {
    const v = r[1] ?? "";
    if (p.output === "numeric") return finite(v);
    if (!p.classes.includes(v)) throw new Error("Unknown predicted class");
    return v;
  });
  let probabilities: number[][] | null = null;
  if (p.output === "probabilities") {
    probabilities = aligned.rows.map((r, i) => {
      const a = r.slice(2).map(finite);
      if (
        a.length !== p.classes.length ||
        a.some((v) => v < 0 || v > 1) ||
        Math.abs(a.reduce((x, y) => x + y, 0) - 1) > 1e-6
      )
        throw new Error("Invalid probability range/sum");
      let best = 0;
      for (let j = 1; j < a.length; j++)
        if ((a[j] ?? -1) > (a[best] ?? -1)) best = j;
      if (values[i] !== p.classes[best])
        throw new Error("Probability/label mismatch");
      return a;
    });
  }
  return { values, probabilities };
}
export function samePredictions(
  a: Predictions,
  b: Predictions,
  atol: number,
  rtol: number,
): boolean {
  const close = (x: number, y: number) =>
    Math.abs(x - y) <= atol + rtol * Math.abs(x);
  if (
    a.values.length !== b.values.length ||
    !a.values.every((x, i) => {
      const y = b.values[i];
      return typeof x === "number" && typeof y === "number"
        ? close(x, y)
        : x === y;
    })
  )
    return false;
  if (a.probabilities === null || b.probabilities === null)
    return a.probabilities === b.probabilities;
  const bp = b.probabilities;
  return a.probabilities.every(
    (row, i) =>
      row.length === bp[i]?.length &&
      row.every((x, j) => close(x, bp[i]?.[j] ?? NaN)),
  );
}
