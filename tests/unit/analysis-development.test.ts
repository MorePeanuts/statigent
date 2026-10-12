import { expect, test } from "bun:test";
import development from "../../configs/evaluations/dsbench-analysis-development.json";
import selection from "../../configs/evaluations/dsbench-analysis-development-selection.json";
import smoke from "../../configs/evaluations/dsbench-analysis-smoke.json";
import profiles from "../../configs/models.json";
import { selectDsbench } from "../../src/evaluation/analysis-development";
import { validateConfig } from "../../src/evaluation/plan";
import { defaultRegistry } from "../../src/evaluation/registry";

const listing = (
  id: string,
  files: string[],
  questions = ["question1", "question2", "question3"],
) => ({
  id,
  questions,
  files: ["introduction.txt", ...questions.map((q) => `${q}.txt`), ...files],
});
test("DSBench development selection follows public file rules and is order independent", () => {
  const cases = [
    listing("00000004", ["a.xlsx", "flow.jpg"]),
    listing("00000002", []),
    listing("00000006", ["a.xlsx", "get_results.ipynb"]),
    listing("00000003", ["a.xlsb"]),
    listing("00000007", ["a.csv", "b.xlsx"]),
    listing("00000001", ["a.xlsx"]),
    listing("00000009", ["a.xlsx"], ["question1"]),
    listing("00000010", ["a.xlsx"]),
    listing("00000011", ["a.xlsx"]),
  ];
  const selected = selectDsbench(cases);
  expect(selected.cases).toEqual(["00000001", "00000007", "00000010"]);
  expect(selected.tasks).toEqual([
    "00000001-question1",
    "00000001-question2",
    "00000007-question1",
    "00000007-question2",
    "00000010-question1",
    "00000010-question2",
  ]);
  expect(selected.smoke).toEqual(selected.tasks.slice(0, 2));
  expect(selectDsbench([...cases].reverse())).toEqual(selected);
  expect(() => selectDsbench(cases.slice(0, 3))).toThrow("Insufficient");
});
test("frozen DSBench configs agree with the selection manifest and stay development-only", async () => {
  expect(development.benchmark.task_ids).toEqual(selection.tasks);
  expect(smoke.benchmark.task_ids).toEqual(selection.tasks.slice(0, 2));
  for (const c of [development, smoke]) {
    expect(c.purpose).toBe("development");
    expect(c.benchmark.version).toBe(selection.data_version);
    const parsed = validateConfig(c, defaultRegistry(), profiles);
    expect(parsed.scoring?.judges.equivalence?.id).toBe("deepseek-flash-judge");
    expect(parsed.agents[0]?.model?.generation.max_output_tokens).toBe(65536);
    expect(parsed.task_budget.total_tokens).toBeGreaterThan(65536 * 2);
  }
  // The selector reads the public index and file names, never the answer index.
  const source = await Bun.file(
    "src/evaluation/analysis-development.ts",
  ).text();
  expect(source).not.toContain("tasks-with-answers");
});
