import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { obj } from "../models/validation";
import { bounded, id, LIMITS, validateScore } from "./contracts";
import { describeFile, regular, verifyFiles } from "./files";
import { inspect } from "./records";
import { csv } from "./report";

/** 独立配对导出只读既有评分；不派发智能体、裁判或排名计算。 */
export async function exportComparison(directory: string, scoreId: string) {
  const view = await inspect(directory);
  if (view.plan.tasks.some((task) => task.output.kind !== "predictions"))
    throw new Error("Modeling comparison requires prediction tasks");
  const source = await describeFile(
    directory,
    `scores/${id(scoreId)}/report.json`,
  );
  if (source.bytes > LIMITS.record) throw new Error("Comparison source limit");
  const report = obj(
    JSON.parse(await readFile(await regular(directory, source.path), "utf8")),
  );
  if (
    report.schema_version !== 1 ||
    report.evaluation_id !== view.manifest.evaluation_id ||
    report.plan_sha256 !== view.plan.sha256 ||
    report.score_id !== scoreId ||
    !Array.isArray(report.rows) ||
    !Array.isArray(report.scores)
  )
    throw new Error("Comparison source identity mismatch");
  if (
    report.rows.length !== view.plan.units.length ||
    report.scores.length !== view.plan.units.length
  )
    throw new Error("Comparison must retain every planned unit");
  const rows = report.rows.map(obj),
    scores = report.scores.map(obj);
  if (
    new Set(rows.map((r) => r.unit_id)).size !== rows.length ||
    new Set(scores.map((s) => s.unit_id)).size !== scores.length
  )
    throw new Error("Duplicate comparison unit");
  for (const unit of view.plan.units) {
    const row = rows.find((r) => r.unit_id === unit.id),
      storedScore = scores.find((s) => s.unit_id === unit.id);
    const agent = view.plan.config.agents.find((a) => a.id === unit.agent_id);
    if (
      !row ||
      !storedScore ||
      row.task_id !== unit.task_id ||
      row.agent_config !== unit.agent_id ||
      row.seed !== unit.seed ||
      row.repetition !== unit.repetition ||
      row.method !== (agent?.options.method ?? "unspecified")
    )
      throw new Error("Comparison pair identity mismatch");
    if (storedScore.score !== null) {
      const score = validateScore(storedScore.score, unit.id);
      for (const metric of score.metrics)
        if (row[`metric_${metric.name}`] !== metric.value)
          throw new Error("Comparison metric mismatch");
    }
  }
  const comparisonId = randomUUID(),
    destination = join(directory, "comparisons", comparisonId);
  const result = {
    schema_version: 1,
    comparison_id: comparisonId,
    evaluation_id: view.manifest.evaluation_id,
    score_id: scoreId,
    source,
    plan_sha256: view.plan.sha256,
    planned: view.plan.units.length,
    pairing: ["task_id", "seed", "repetition", "agent_config"],
    aggregation: "none",
    prepared_data: view.plan.provenance,
    reproduction:
      "Not executed by scoring/comparison; independent reproduction records must be linked separately.",
    rows,
  };
  bounded(result, LIMITS.record);
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "pairs.json"),
    JSON.stringify(result, null, 2),
    { flag: "wx", mode: 0o400 },
  );
  await writeFile(join(destination, "pairs.csv"), csv(rows), {
    flag: "wx",
    mode: 0o400,
  });
  await verifyFiles(directory, [source]);
  return {
    comparison_id: comparisonId,
    directory: destination,
    planned: view.plan.units.length,
  };
}
