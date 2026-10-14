import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { obj, str, strings } from "../../models/validation";
import { sha256 } from "../../records/store";
import {
  type BenchmarkAdapter,
  type InputFile,
  id,
  LIMITS,
  type PublicTask,
  type Score,
} from "../contracts";
import { describeFile, regular } from "../files";
import provenance from "./dsbench-provenance.json";
import { benchmarkRootOptions } from "./options";
import { scorerRequest } from "./python";

export const DSBENCH_PROTOCOL = "dsbench-analysis-judge-v1";
const QUESTION = /^question\d+\.txt$/;
interface Resource {
  path: string;
  bytes: number;
  sha256: string;
}
async function text(root: string, path: string): Promise<string> {
  const file = await regular(root, path);
  const data = await Bun.file(file).text();
  if (Buffer.byteLength(data) > LIMITS.request)
    throw new Error(`Benchmark text too large: ${path}`);
  return data;
}
async function jsonl(root: string, path: string): Promise<unknown[]> {
  return (await text(root, path))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
/**
 * DSBench-Analysis: one task per question, grouped by case for case-averaged accuracy. Answers stay in
 * `analysis/private`; any notebook shipped in a case directory is withheld because it may hold a solution.
 */
export function createDsbenchAnalysis(
  resources: Resource[] = provenance.resources,
): BenchmarkAdapter {
  const options = (value: unknown) => {
    return benchmarkRootOptions(value);
  };
  const verify = async (root: string, path: string) => {
    const expected = resources.find((r) => r.path === path);
    if (!expected) throw new Error(`Unpinned resource: ${path}`);
    const actual = await describeFile(root, path);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new Error(`Benchmark integrity mismatch: ${path}`);
  };
  const answers = async (root: string) => {
    await verify(root, "analysis/private/tasks-with-answers.jsonl");
    const result = new Map<
      string,
      { questions: string[]; answers: unknown[] }
    >();
    for (const row of await jsonl(
      root,
      "analysis/private/tasks-with-answers.jsonl",
    )) {
      const x = obj(row);
      const questions = strings(x.questions, "questions");
      if (!Array.isArray(x.answers) || x.answers.length !== questions.length)
        throw new Error(`Answers do not align with questions: ${String(x.id)}`);
      // Answers are strings, numbers or (15 cases) objects; the scorer formats them with Python str().
      for (const a of x.answers)
        if (
          !(
            typeof a === "string" ||
            (typeof a === "number" && Number.isFinite(a)) ||
            (a !== null && typeof a === "object" && !Array.isArray(a))
          )
        )
          throw new Error(`Invalid reference answer in case ${String(x.id)}`);
      result.set(id(x.id), { questions, answers: x.answers });
    }
    return result;
  };
  const split = (taskId: string) => {
    const match = /^([0-9]+)-(question[0-9]+)$/.exec(taskId);
    if (!match?.[1] || !match[2]) throw new Error(`Invalid task id: ${taskId}`);
    return { caseId: match[1], question: match[2] };
  };
  return {
    id: "dsbench-analysis",
    version: "1",
    protocol: DSBENCH_PROTOCOL,
    options,
    judgeRoles: () => [{ id: "equivalence", needs: ["text"] }],
    summaries: [
      {
        name: "case_accuracy",
        metric: "accuracy",
        within: "mean",
        across: "mean",
      },
    ],
    async catalog(value) {
      const root = str(options(value).root, "root");
      for (const r of resources.filter(
        (r) => !r.path.startsWith("analysis/private"),
      ))
        await verify(root, r.path);
      const publicRoot = resolve(root, "analysis/public");
      const tasks: PublicTask[] = [];
      const groups: Record<string, string> = {};
      const files: InputFile[] = [];
      const excluded: { path: string; reason: string }[] = [];
      for (const row of await jsonl(publicRoot, "tasks.jsonl")) {
        const x = obj(row);
        const caseId = id(x.id);
        const questions = strings(x.questions, "questions");
        const introduction = await text(
          publicRoot,
          `${caseId}/introduction.txt`,
        );
        const inputs: InputFile[] = [];
        for (const name of (
          await readdir(resolve(publicRoot, caseId))
        ).sort()) {
          const path = `${caseId}/${name}`;
          if (name === "introduction.txt" || QUESTION.test(name)) {
            files.push(await describeFile(publicRoot, path));
            continue;
          }
          if (name.endsWith(".ipynb")) {
            excluded.push({
              path,
              reason:
                "notebook shipped with the case may contain a reference solution",
            });
            continue;
          }
          const input = await describeFile(publicRoot, path);
          inputs.push(input);
          files.push(input);
        }
        for (const question of questions) {
          if (!/^question[0-9]+$/.test(question))
            throw new Error(`Invalid question name: ${question}`);
          const body = await text(publicRoot, `${caseId}/${question}.txt`);
          const taskId = `${caseId}-${question}`;
          groups[taskId] = caseId;
          tasks.push({
            schema_version: 2,
            id: taskId,
            version: sha256(
              Buffer.from(JSON.stringify({ introduction, body, inputs })),
            ),
            goal: `${introduction.trim()}\n\nQuestion:\n${body.trim()}`,
            constraints: [
              "Use the case description and any provided files; the files are read-only.",
            ],
            inputs,
            output: {
              kind: "text",
              instructions:
                "Give one clear final answer, not only a calculation process. For a multiple-choice question state the chosen option (letter and value).",
            },
          });
        }
      }
      files.sort((a, b) => (a.path < b.path ? -1 : 1));
      return {
        tasks,
        groups,
        source_root: publicRoot,
        provenance: {
          version: sha256(
            Buffer.from(
              JSON.stringify({
                index: resources.find(
                  (r) => r.path === "analysis/public/tasks.jsonl",
                )?.sha256,
                files: files.map((f) => [f.path, f.sha256, f.bytes]),
              }),
            ),
          ),
          protocol: DSBENCH_PROTOCOL,
          repository: provenance.repository,
          commit: provenance.commit,
          dataset_revision: provenance.dataset_revision,
          archive: provenance.archive,
          resources,
          excluded,
          upstream_default_judge: provenance.default_judge,
          deviations: [
            "Judge model is configurable (upstream: gpt-4o-2024-05-13); the prompt text is unchanged.",
            "A failed or unparseable judge call is a scoring error; upstream counts it as False.",
            "Units without a final answer score 0 without a judge call.",
            "Upstream answering setup (eval_GPT.ipynb) is not reproduced; only its judging rule is.",
            "Notebooks shipped inside case directories are withheld from the agent.",
          ],
        },
      };
    },
    async preflight(value, tasks) {
      const root = str(options(value).root, "root");
      const map = await answers(root);
      for (const t of tasks) {
        const { caseId, question } = split(t.id);
        const entry = map.get(caseId);
        if (!entry?.questions.includes(question))
          throw new Error(`Missing reference answer: ${t.id}`);
      }
    },
    async score(value, task, submission, context): Promise<Score> {
      const { caseId, question } = split(task.id);
      const root = str(options(value).root, "root");
      const entry = (await answers(root)).get(caseId);
      const index = entry?.questions.indexOf(question) ?? -1;
      if (!entry || index < 0)
        throw new Error(`Missing reference answer: ${task.id}`);
      const base = {
        schema_version: 2 as const,
        unit_id: submission.unit_id,
        protocol: DSBENCH_PROTOCOL,
        status: "scored" as const,
        error: null,
        judge: null,
      };
      const metric = (correct: boolean) => [
        {
          name: "accuracy",
          value: Number(correct),
          minimum: 0,
          maximum: 1,
          direction: "higher" as const,
        },
      ];
      const prediction =
        submission.status === "completed" ? submission.answer_text : "";
      // A terminal failure or empty answer is wrong by the benchmark rule; no judge is needed.
      if (!prediction.trim())
        return {
          ...base,
          metrics: metric(false),
          details: { answered: false },
        };
      if (!context.judge) throw new Error("DSBench scoring requires a judge");
      const prompt = str(
        (
          await scorerRequest(
            {
              operation: "dsbench_prompt",
              question: await text(
                resolve(root, "analysis/public"),
                `${caseId}/${question}.txt`,
              ),
              answer: entry.answers[index],
              prediction,
            },
            { signal: context.signal },
          )
        ).text,
        "prompt",
      );
      const correct = await context.judge.ask(
        "equivalence",
        [{ type: "text", text: prompt }],
        task.id,
        async (reply) => {
          const verdict = await scorerRequest(
            { operation: "dsbench_verdict", reply },
            { signal: context.signal },
          );
          if (typeof verdict.correct !== "boolean")
            throw new Error("Invalid verdict");
          return verdict.correct;
        },
      );
      return {
        ...base,
        metrics: metric(correct),
        details: { answered: true, correct },
      };
    },
  };
}
