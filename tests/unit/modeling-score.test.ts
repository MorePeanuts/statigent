import { expect, test } from "bun:test";
import { parseCsv } from "../../src/modeling/data";
import { predictionValues, rmse } from "../../src/modeling/experiments";

test("trusted RMSE aligns IDs and rejects invalid candidate predictions", () => {
  expect(
    rmse(
      predictionValues(parseCsv("id,prediction\nb,6\na,1\n"), ["a", "b"], "id"),
      [3, 4],
    ),
  ).toBe(2);
  for (const rows of [
    "a,1\n",
    "a,1\na,2\n",
    "a,1\nc,3\n",
    "a,NaN\nb,2\n",
    "a,Infinity\nb,2\n",
  ]) {
    expect(() =>
      predictionValues(parseCsv(`id,prediction\n${rows}`), ["a", "b"], "id"),
    ).toThrow();
  }
  expect(() => rmse([Infinity], [1])).toThrow();
  expect(() => rmse([1], [])).toThrow();
});
