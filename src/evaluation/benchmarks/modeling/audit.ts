import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { obj } from "../../../models/validation";
import { command, commandEnvironment } from "../../process";
import { assertCatalogCoverage, parseModelingCatalog } from "./catalog";

export async function auditModeling(args: string[]): Promise<unknown> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !["--data-root", "--catalog", "--output"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options[key] !== undefined
    )
      throw new Error(
        "evaluate audit [--data-root benchmarks] [--catalog FILE] [--output NEW_FILE]",
      );
    options[key] = value;
  }
  const root = resolve(options["--data-root"] ?? "benchmarks");
  const path = resolve(
    options["--catalog"] ?? `${root}/metadata/modeling-task-catalog.json`,
  );
  const catalog = parseModelingCatalog(await Bun.file(path).json());
  const selection = obj(
    await Bun.file(`${root}/metadata/ds-modeling-selection.json`).json(),
  );
  const tab: unknown = await Bun.file(
    `${root}/metadata/tabarena-tasks.json`,
  ).json();
  if (
    !Array.isArray(selection.included) ||
    !selection.included.every((id) => typeof id === "string") ||
    !Array.isArray(tab)
  )
    throw new Error("Invalid downloaded selection");
  const tabIds = tab.map((item) => {
    const id = obj(item).task_id;
    if (typeof id !== "string") throw new Error("Invalid TabArena identity");
    return id;
  });
  assertCatalogCoverage(catalog, {
    "dsbench-modeling": selection.included,
    "tabarena-lite": tabIds,
  });
  const result = await command(
    [
      "uv",
      "run",
      "--offline",
      "--frozen",
      "--no-sync",
      "python",
      "-m",
      "statigent_benchmarks.audit",
      "--root",
      root,
      "--catalog",
      path,
      "--references",
      resolve("src/evaluation/benchmarks/modeling/dsbench-references.json"),
    ],
    {
      timeout_ms: 600000,
      stdout_limit: 2 * 1024 * 1024,
      env: { ...commandEnvironment(), PYTHONPATH: resolve("python") },
    },
  );
  const report = obj(JSON.parse(result.stdout));
  if (
    report.schema_version !== 1 ||
    !Array.isArray(report.tasks) ||
    report.tasks.length !== catalog.tasks.length ||
    report.llm_calls !== 0 ||
    report.fits !== 0 ||
    report.downloads !== 0
  )
    throw new Error("Invalid audit response");
  if (options["--output"])
    await writeFile(
      resolve(options["--output"]),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx" },
    );
  return report;
}
