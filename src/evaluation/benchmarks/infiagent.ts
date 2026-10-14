import { resolve } from "node:path";
import { integer, obj, str } from "../../models/validation";
import { sha256 } from "../../records/store";
import {
  type BenchmarkAdapter,
  id,
  LIMITS,
  type PublicTask,
  validateScore,
} from "../contracts";
import { describeFile, regular } from "../files";
import provenance from "./infiagent-provenance.json";
import { benchmarkRootOptions } from "./options";
import { scorerRequest } from "./python";

export const INFI_PROTOCOL = "infiagent-fixed-denominator-v1";
export interface Resource {
  path: string;
  sha256: string;
  url: string;
  bytes: number;
}
async function jsonl(root: string, path: string): Promise<unknown[]> {
  const file = await regular(root, path);
  const data = await Bun.file(file).text();
  if (Buffer.byteLength(data) > LIMITS.record)
    throw new Error("Benchmark resource too large");
  return data
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
function labels(
  rows: unknown[],
  selected: Set<string>,
): Map<string, string[][]> {
  const result = new Map<string, string[][]>();
  for (const row of rows) {
    const x = obj(row);
    const taskId = id(String(integer(x.id, "label id", 0)));
    if (!selected.has(taskId)) continue;
    if (
      result.has(taskId) ||
      !Array.isArray(x.common_answers) ||
      !x.common_answers.length
    )
      throw new Error("Duplicate or invalid labels");
    const answers = x.common_answers.map((p) => {
      if (!Array.isArray(p) || p.length !== 2 || typeof p[1] !== "string")
        throw new Error("Invalid answer pair");
      return [str(p[0], "answer key"), p[1]];
    });
    if (new Set(answers.map((a) => a[0])).size !== answers.length)
      throw new Error("Duplicate answer key");
    result.set(taskId, answers);
  }
  return result;
}
export function createInfiAgent(
  resources: Resource[] = provenance.resources,
): BenchmarkAdapter {
  const options = (value: unknown) => {
    return benchmarkRootOptions(value);
  };
  const verifyResource = async (root: string, path: string) => {
    const expected = resources.find((r) => r.path === path);
    if (!expected) throw new Error(`Unpinned resource: ${path}`);
    const actual = await describeFile(root, path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new Error(`Benchmark integrity mismatch: ${path}`);
    return actual;
  };
  const loadLabels = async (root: string, selected: Set<string>) => {
    await verifyResource(root, "private/labels.jsonl");
    return labels(await jsonl(root, "private/labels.jsonl"), selected);
  };
  return {
    async compatibility(scores) {
      return scorerRequest({ operation: "aggregate", scores });
    },
    id: "infiagent-dabench",
    version: "1",
    protocol: INFI_PROTOCOL,
    options,
    async catalog(value) {
      const root = str(options(value).root, "root");
      const question = await verifyResource(root, "public/questions.jsonl");
      await verifyResource(
        root,
        "upstream/examples/DA-Agent/eval_closed_form.py",
      );
      await verifyResource(root, "upstream/LICENSE");
      const inputCache = new Map<
        string,
        Awaited<ReturnType<typeof describeFile>>
      >();
      const tasks: PublicTask[] = [];
      for (const row of await jsonl(root, "public/questions.jsonl")) {
        const q = obj(row);
        const path = str(q.file_name, "file_name");
        if (!inputCache.has(path)) {
          const f = await verifyResource(root, `public/tables/${path}`);
          inputCache.set(path, { ...f, path });
        }
        const input = inputCache.get(path);
        if (!input) throw new Error("Missing input");
        tasks.push({
          schema_version: 2,
          id: String(integer(q.id, "question id", 0)),
          version: sha256(Buffer.from(JSON.stringify({ question: q, input }))),
          goal: str(q.question, "question"),
          constraints: [str(q.constraints, "constraints")],
          inputs: [input],
          output: { kind: "text", instructions: str(q.format, "format") },
        });
      }
      return {
        tasks,
        source_root: resolve(root, "public/tables"),
        provenance: {
          version: question.sha256,
          upstream_commit: provenance.commit,
          resources,
          protocol: INFI_PROTOCOL,
        },
      };
    },
    async preflight(value, tasks) {
      const map = await loadLabels(
        str(options(value).root, "root"),
        new Set(tasks.map((t) => t.id)),
      );
      for (const task of tasks)
        if (!map.has(task.id)) throw new Error(`Missing labels: ${task.id}`);
    },
    async score(value, task, submission, { signal }) {
      const answers = (
        await loadLabels(str(options(value).root, "root"), new Set([task.id]))
      ).get(task.id);
      if (!answers) throw new Error("Missing labels");
      const request = {
        schema_version: 1,
        unit_id: submission.unit_id,
        answers,
        answer_text:
          submission.status === "completed" ? submission.answer_text : "",
      };
      return validateScore(
        await scorerRequest(request, { signal }),
        submission.unit_id,
      );
    },
  };
}
