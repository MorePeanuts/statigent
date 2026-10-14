import type { Dirent } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { parseStrictOptions } from "../../../cli-options";
import { parseDataLimits } from "../../../modeling/data-limits";
import { writeJson } from "../../../records/store";
import { codeSnapshot } from "../../records";
import { auditModeling } from "./audit";
import { parseModelingCatalog } from "./catalog";
import { prepareModeling } from "./prepare";

const nonemptyString = z.string().refine((value) => value.trim().length > 0);
const positiveInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 1);
const preparationAuditSchema = z.strictObject({
  schema_version: z.literal(1),
  catalog: nonemptyString,
  data_root: nonemptyString,
  seed: z.number().refine((value) => Number.isSafeInteger(value) && value >= 0),
  limits: z.unknown(),
  timeout_ms: positiveInteger,
  batch_timeout_ms: positiveInteger,
  max_output_bytes: positiveInteger,
  minimum_free_bytes: positiveInteger,
});
export function preparationAuditConfig(value: unknown) {
  const x = preparationAuditSchema.parse(value);
  return {
    schema_version: 1,
    catalog: resolve(x.catalog),
    data_root: resolve(x.data_root),
    seed: x.seed,
    limits: parseDataLimits(x.limits),
    timeout_ms: x.timeout_ms,
    batch_timeout_ms: x.batch_timeout_ms,
    max_output_bytes: x.max_output_bytes,
    minimum_free_bytes: x.minimum_free_bytes,
  };
}
async function treeBytes(root: string): Promise<number> {
  let result = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return 0;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error("Unexpected preparation symlink");
    const path = join(root, entry.name);
    result += entry.isDirectory()
      ? await treeBytes(path)
      : (await stat(path)).size;
  }
  return result;
}

export async function auditPreparations(
  args: string[],
  options: {
    signal?: AbortSignal;
    progress?: (value: unknown) => void;
    sourceAudit?: typeof auditModeling;
    prepare?: typeof prepareModeling;
  } = {},
) {
  const parsed = parseStrictOptions(
    args,
    ["--config", "--out"],
    "audit-prepare --config FILE --out NEW_DIRECTORY",
  );
  if (!parsed["--config"] || !parsed["--out"])
    throw new Error("audit-prepare requires --config and --out");
  const config = preparationAuditConfig(
    await Bun.file(parsed["--config"]).json(),
  );
  const catalog = parseModelingCatalog(await Bun.file(config.catalog).json());
  const root = resolve(parsed["--out"]),
    begin = Date.now();
  await mkdir(root, { recursive: false });
  for (const folder of [
    "configs",
    "receipts",
    "datasets/dsbench-modeling",
    "datasets/tabarena-lite",
  ])
    await mkdir(join(root, folder), { recursive: true });
  const tasks: Record<string, unknown>[] = catalog.tasks.map((task) => ({
    benchmark: task.benchmark,
    task_id: task.task_id,
    status: "not_run",
    reason: "not_dispatched",
    research: task.research,
    issues: task.issues,
    metric: task.protocol?.metric ?? null,
    dataset: null,
    llm_calls: 0,
    fits: 0,
  }));
  const report = {
    schema_version: 1,
    operation: "bounded-all-candidate-preparation",
    config,
    status: "running",
    elapsed_ms: 0,
    output_bytes: 0,
    llm_calls: 0,
    fits: 0,
    downloads: 0,
    source_audit: "source-audit.json",
    code: await codeSnapshot(),
    created_at: new Date(begin).toISOString(),
    tasks,
  };
  await writeJson(join(root, "preparation-audit.json"), report);
  try {
    await (options.sourceAudit ?? auditModeling)([
      "--data-root",
      config.data_root,
      "--catalog",
      config.catalog,
      "--output",
      join(root, "source-audit.json"),
    ]);
    for (const [index, task] of catalog.tasks.entries()) {
      const entry = tasks[index];
      if (!entry) throw new Error("Audit record mismatch");
      const remaining = config.batch_timeout_ms - (Date.now() - begin);
      const disk = await statfs(root),
        reserved = 10 * config.limits.max_file_bytes;
      const oversized = task.files.filter(
        (f) => f.bytes > config.limits.max_file_bytes,
      );
      if (
        options.signal?.aborted ||
        remaining <= 0 ||
        report.output_bytes + reserved > config.max_output_bytes ||
        disk.bavail * disk.bsize < config.minimum_free_bytes + reserved
      ) {
        entry.reason = options.signal?.aborted
          ? "cancelled"
          : remaining <= 0
            ? "batch_timeout"
            : "storage_reserve";
      } else if (oversized.length) {
        entry.status = "blocked";
        entry.reason = "source_file_resource_limit";
        entry.oversized = oversized.map((f) => ({
          path: f.path,
          bytes: f.bytes,
        }));
      } else {
        const name = `${task.benchmark}--${task.task_id}`,
          destination = join(root, "datasets", task.benchmark, task.task_id);
        const file = join(root, "configs", `${name}.json`),
          receipt = join(root, "receipts", `${name}.json`);
        await writeFile(
          file,
          JSON.stringify({
            schema_version: 1,
            benchmark: task.benchmark,
            task_id: task.task_id,
            data_root: config.data_root,
            catalog: config.catalog,
            seed: config.seed,
            limits: config.limits,
            timeout_ms: Math.min(config.timeout_ms, remaining),
          }),
          { flag: "wx" },
        );
        const started = Date.now();
        try {
          const result = await (options.prepare ?? prepareModeling)(
            ["--config", file, "--out", destination, "--receipt", receipt],
            { signal: options.signal },
          );
          Object.assign(entry, {
            status: "passed",
            reason: "prepared_and_validated",
            dataset: `datasets/${task.benchmark}/${task.task_id}`,
            dataset_sha256: result.dataset_sha256,
            rows: result.rows,
            metric: result.protocol.metric,
            protocol_sha256: result.protocol.protocol_sha256,
            receipt: `receipts/${name}.json`,
          });
        } catch (error) {
          const reason = String(error);
          Object.assign(entry, {
            status: /limit|memory|too large|timed out|budget/i.test(reason)
              ? "blocked"
              : "failed",
            reason,
            receipt: `receipts/${name}.json`,
          });
        }
        entry.elapsed_ms = Date.now() - started;
        entry.output_bytes = await treeBytes(destination);
        report.output_bytes += Number(entry.output_bytes);
      }
      report.elapsed_ms = Date.now() - begin;
      await writeJson(join(root, "preparation-audit.json"), report);
      options.progress?.({
        checked: index + 1,
        total: tasks.length,
        task_id: task.task_id,
        status: entry.status,
        reason: entry.reason,
      });
    }
    report.status = tasks.every((t) => t.status === "passed")
      ? "passed"
      : "completed_with_exceptions";
  } catch (error) {
    report.status = "failed";
    for (const task of tasks)
      if (task.status === "not_run" && task.reason === "not_dispatched")
        task.reason = `audit_aborted:${String(error)}`;
  }
  report.elapsed_ms = Date.now() - begin;
  await writeJson(join(root, "preparation-audit.json"), report);
  await chmod(join(root, "preparation-audit.json"), 0o444);
  return { directory: root, report };
}
