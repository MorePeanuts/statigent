import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { integer, obj, str } from "../../models/validation";
import { sha256 } from "../../records/store";
import {
  type BenchmarkAdapter,
  id,
  type JudgePart,
  type Metric,
  type OutputContract,
  type PublicTask,
  type Score,
} from "../contracts";
import { validateReport } from "../deliverables";
import { describeFile, regular } from "../files";
import provenance from "./dacomp-provenance.json";
import { benchmarkRootAndMetadataOptions } from "./options";
import { scorerRequest } from "./python";

export const DACOMP_PROTOCOL = "dacomp-da-report-v1";
export const DACOMP_COMPAT_PROTOCOL = "dacomp-da-upstream-trajectory-v1";
const SUITE = "evaluator/upstream/dacomp-da/evaluation_suite";
const BRIDGE_LIMIT = 16 * 1024 * 1024;
const OUTPUT: Extract<OutputContract, { kind: "report" }> = {
  kind: "report",
  instructions:
    "Write report.md in English: answer every part of the question with the computed figures, explain the analysis, and include charts saved as PNG or JPEG files referenced with relative Markdown image links.",
  report_file: "report.md",
  image_types: ["png", "jpeg"],
  max_images: 20,
  max_image_bytes: 5 * 1024 * 1024,
  max_report_bytes: 256 * 1024,
};
// Metric ranges follow upstream: totals and rubric dimensions in percent, GSB scores in [0, 1].
const METRICS: [string, number][] = [
  ["total", 100],
  ["rubric_ratio", 1],
  ["completeness", 100],
  ["accuracy", 100],
  ["conclusiveness", 100],
  ["readability", 1],
  ["professionalism", 1],
  ["visualization", 1],
];
interface Entry {
  bytes: number;
  sha256: string;
}
export interface DacompPins {
  data_entries_sha256: string;
  evaluator_entries_sha256: string;
}
/** Order-independent digest of a manifest subset (path, size, hash). */
export function entriesDigest(entries: Map<string, Entry>): string {
  return sha256(
    Buffer.from(
      JSON.stringify(
        [...entries.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([p, e]) => [p, e.bytes, e.sha256]),
      ),
    ),
  );
}
/**
 * Reads the official per-file manifests written by the benchmark downloader and keeps the DAComp-DA
 * entries, keyed relative to the dacomp-da root.
 */
export async function dacompManifest(metadata: string) {
  const data = new Map<string, Entry>();
  const evaluator = new Map<string, Entry>();
  for (const file of ["dacomp-data-files.json", "assets-files.json"]) {
    const rows: unknown = await Bun.file(join(metadata, file)).json();
    if (!Array.isArray(rows)) throw new Error(`Invalid manifest: ${file}`);
    for (const row of rows) {
      const x = obj(row);
      const path = str(x.path, "path");
      if (!path.startsWith("dacomp-da/")) continue;
      const relative = path.slice("dacomp-da/".length);
      const entry = {
        bytes: integer(x.bytes, "bytes", 0),
        sha256: str(x.sha256, "sha256"),
      };
      if (relative.startsWith("public/")) data.set(relative, entry);
      else if (relative.startsWith("evaluator/upstream/"))
        evaluator.set(relative, entry);
    }
  }
  return { data, evaluator };
}
async function verify(root: string, path: string, expected: Entry | undefined) {
  if (!expected) throw new Error(`Unpinned resource: ${path}`);
  const actual = await describeFile(root, path);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
    throw new Error(`Benchmark integrity mismatch: ${path}`);
}
/**
 * DAComp-DA (English): SQLite plus an instruction in, an English Markdown report with charts out.
 * Rubrics, metadata and reference reports are read only on the scoring side.
 */
export function createDacomp(
  pins: DacompPins = provenance.pins,
): BenchmarkAdapter {
  const options = (value: unknown) => {
    return benchmarkRootAndMetadataOptions(value);
  };
  const manifest = async (value: Record<string, unknown>) => {
    const o = options(value);
    const m = await dacompManifest(o.metadata);
    if (
      entriesDigest(m.data) !== pins.data_entries_sha256 ||
      entriesDigest(m.evaluator) !== pins.evaluator_entries_sha256
    )
      throw new Error("DAComp manifest does not match the pinned version");
    return { ...o, ...m };
  };
  const scoring = (value: unknown) => {
    const x = z
      .strictObject({ upstream_compatible: z.boolean().optional() })
      .parse(value);
    return { upstream_compatible: x.upstream_compatible === true };
  };
  const evaluatorFiles = (m: Map<string, Entry>, taskId: string) =>
    [...m.keys()].filter(
      (p) =>
        p.startsWith(`${SUITE}/src/${taskId}/`) ||
        (p.startsWith(`${SUITE}/core/`) && p.endsWith(".py")),
    );
  return {
    id: "dacomp-da",
    version: "1",
    protocol: DACOMP_PROTOCOL,
    options,
    scoringOptions: scoring,
    requiresTrajectory: (s) => scoring(s).upstream_compatible,
    judgeRoles: () => [
      { id: "rubric", needs: ["text"] },
      { id: "gsb_text", needs: ["text"] },
      { id: "gsb_vision", needs: ["vision"] },
    ],
    async catalog(value) {
      const m = await manifest(value);
      await verify(
        m.root,
        "public/dacomp-da.jsonl",
        m.data.get("public/dacomp-da.jsonl"),
      );
      const publicRoot = resolve(m.root, "public");
      const content = await Bun.file(
        await regular(publicRoot, "dacomp-da.jsonl"),
      ).text();
      const tasks: PublicTask[] = [];
      for (const line of content.trim().split("\n")) {
        const row = obj(JSON.parse(line));
        const taskId = id(row.instance_id);
        const path = `${taskId}/${taskId}.sqlite`;
        const entry = m.data.get(`public/${path}`);
        if (!entry) throw new Error(`Unpinned database: ${path}`);
        // Full hashing of multi-GB databases happens in preflight for selected tasks only.
        if ((await lstat(await regular(publicRoot, path))).size !== entry.bytes)
          throw new Error(`Benchmark integrity mismatch: ${path}`);
        const input = { path, bytes: entry.bytes, sha256: entry.sha256 };
        const instruction = str(row.instruction, "instruction");
        tasks.push({
          schema_version: 2,
          id: taskId,
          version: sha256(Buffer.from(JSON.stringify({ instruction, input }))),
          goal: instruction,
          constraints: [
            `The SQLite database /input/${path} is read-only; open it read-only, e.g. sqlite3.connect("file:/input/${path}?mode=ro", uri=True).`,
          ],
          inputs: [input],
          output: OUTPUT,
        });
      }
      return {
        tasks,
        source_root: publicRoot,
        provenance: {
          version: sha256(
            Buffer.from(JSON.stringify({ ...pins, protocol: DACOMP_PROTOCOL })),
          ),
          protocol: DACOMP_PROTOCOL,
          compat_protocol: DACOMP_COMPAT_PROTOCOL,
          repository: provenance.repository,
          commit: provenance.commit,
          dataset_revision: provenance.dataset_revision,
          pins,
          upstream_default_judges: provenance.default_judges,
          weights: {
            rubric: 0.6,
            readability: 0.1,
            professionalism: 0.1,
            visualization: 0.2,
          },
          deviations: provenance.deviations,
        },
      };
    },
    async preflight(value, tasks) {
      const m = await manifest(value);
      for (const task of tasks) {
        const path = `public/${task.id}/${task.id}.sqlite`;
        await verify(m.root, path, m.data.get(path));
        const files = evaluatorFiles(m.evaluator, task.id);
        if (!files.some((f) => f.endsWith(`/${task.id}/rubric.txt`)))
          throw new Error(`Missing evaluator materials: ${task.id}`);
        for (const f of files) await verify(m.root, f, m.evaluator.get(f));
      }
    },
    async compatibility(scores) {
      const compat = scores.flatMap((s) => {
        const c = s.details.compat;
        return c && typeof c === "object" ? [obj(c)] : [];
      });
      if (!compat.length) return { enabled: false };
      const mean = (key: string) =>
        compat.reduce((n, c) => n + Number(c[key]), 0) / compat.length;
      return {
        enabled: true,
        protocol: DACOMP_COMPAT_PROTOCOL,
        units: compat.length,
        total: mean("total"),
        rubric_ratio: mean("rubric_ratio"),
        note: "Rubric judged on the unified trajectory (upstream input); GSB shared with the primary protocol. Not averaged with primary scores.",
      };
    },
    async score(value, task, submission, context): Promise<Score> {
      const m = await manifest(value);
      const options = scoring(context.scoring);
      for (const f of evaluatorFiles(m.evaluator, task.id))
        await verify(m.root, f, m.evaluator.get(f));
      const metrics = (values: Record<string, number>): Metric[] =>
        METRICS.map(([name, maximum]) => {
          const v = values[name];
          if (typeof v !== "number" || !Number.isFinite(v))
            throw new Error(`Missing metric ${name}`);
          return {
            name,
            value: Math.min(maximum, Math.max(0, v)),
            minimum: 0,
            maximum,
            direction: "higher",
          };
        });
      const base = {
        schema_version: 2 as const,
        unit_id: submission.unit_id,
        protocol: DACOMP_PROTOCOL,
        status: "scored" as const,
        error: null,
        judge: null,
      };
      // Without an accepted report the unit scores zero under the fixed denominator; no judge call.
      if (submission.status !== "completed")
        return {
          ...base,
          metrics: metrics(Object.fromEntries(METRICS.map(([n]) => [n, 0]))),
          details: {
            report: false,
            compat: options.upstream_compatible
              ? { total: 0, rubric_ratio: 0 }
              : null,
          },
        };
      if (!context.judge) throw new Error("DAComp scoring requires judges");
      const report = await validateReport(
        task.output,
        context.deliverables_root,
        submission.deliverables,
      );
      if (options.upstream_compatible && !submission.trajectory)
        throw new Error(
          "Upstream-compatible scoring needs a unified trajectory",
        );
      const prepared = await scorerRequest(
        {
          operation: "dacomp_prepare",
          instance_dir: resolve(m.root, `${SUITE}/src/${task.id}`),
          report_path: join(context.deliverables_root, OUTPUT.report_file),
          report_images: report.images.map((p) =>
            join(context.deliverables_root, p),
          ),
          query: task.goal,
          trajectory_path:
            options.upstream_compatible && submission.trajectory
              ? join(context.deliverables_root, submission.trajectory)
              : null,
        },
        { signal: context.signal, limit: BRIDGE_LIMIT, timeout_ms: 60000 },
      );
      if (!Array.isArray(prepared.items))
        throw new Error("Invalid prepared items");
      const replies = new Map<string, string>();
      for (const value of prepared.items) {
        const item = obj(value);
        const role = str(item.role, "role");
        const label = str(item.label, "label");
        if (!Array.isArray(item.parts)) throw new Error("Invalid judge parts");
        const parts = item.parts.map((p): JudgePart => {
          const x = obj(p);
          return x.type === "image"
            ? { type: "image", path: str(x.path, "path") }
            : { type: "text", text: str(x.text, "text") };
        });
        replies.set(
          label,
          await context.judge.ask(
            role,
            parts,
            `${task.id}:${label}`,
            async (reply) => {
              const check = await scorerRequest(
                {
                  operation: "dacomp_valid",
                  kind: role === "rubric" ? "rubric" : "gsb",
                  reply,
                },
                { signal: context.signal, limit: BRIDGE_LIMIT },
              );
              if (check.valid !== true)
                throw new Error(`Unparseable ${label} reply`);
              return reply;
            },
          ),
        );
      }
      const pick = (prefix: string) =>
        [...replies.entries()]
          .filter(([l]) => l.startsWith(prefix))
          .map(([, r]) => r);
      const gsbVision = pick("gsb_vision:");
      const combined = await scorerRequest(
        {
          operation: "dacomp_combine",
          instance_dir: resolve(m.root, `${SUITE}/src/${task.id}`),
          rubric: replies.get("rubric"),
          gsb_text: pick("gsb_text:"),
          gsb_vision: report.images.length ? gsbVision : null,
          compat_rubric: replies.get("compat_rubric") ?? null,
        },
        { signal: context.signal, limit: BRIDGE_LIMIT },
      );
      const values = obj(combined.metrics) as Record<string, number>;
      return {
        ...base,
        metrics: metrics(values),
        details: {
          report: true,
          images: report.images,
          judged: [...replies.keys()],
          compat: combined.compat ?? null,
          report_bytes: Buffer.byteLength(report.report),
        },
      };
    },
  };
}
