import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { obj } from "../../../models/validation";
import { command, commandEnvironment } from "../../process";
import { assertCatalogCoverage, parseModelingCatalog } from "./catalog";

export function parseAuditOptions(args: string[]) {
  const help =
    "evaluate audit [--data-root benchmarks] [--catalog FILE] [--output NEW_FILE]";
  const uniqueValue = (value: string, previous: string | undefined) => {
    if (!value || previous !== undefined || value.startsWith("--"))
      throw new InvalidArgumentError("Invalid or duplicate option");
    return value;
  };
  const cli = new Command()
    .name("evaluate audit")
    .helpOption(false)
    .configureOutput({ writeErr: () => {} })
    .exitOverride()
    .addOption(new Option("--data-root <path>").argParser(uniqueValue))
    .addOption(new Option("--catalog <file>").argParser(uniqueValue))
    .addOption(new Option("--output <file>").argParser(uniqueValue));
  try {
    cli.parse(args, { from: "user" });
    if (cli.args.length) throw new Error(help);
  } catch {
    throw new Error(help);
  }
  return cli.opts<{
    dataRoot?: string;
    catalog?: string;
    output?: string;
  }>();
}

export async function auditModeling(args: string[]): Promise<unknown> {
  const options = parseAuditOptions(args);
  const root = resolve(options.dataRoot ?? "benchmarks");
  const path = resolve(
    options.catalog ?? `${root}/metadata/modeling-task-catalog.json`,
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
  if (options.output)
    await writeFile(
      resolve(options.output),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx" },
    );
  return report;
}
