import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { selectProfile } from "../models/config";
import { obj, str } from "../models/validation";
import { writeJson } from "../records/store";
import { createDacomp } from "./benchmarks/dacomp";
import { scorerRequest } from "./benchmarks/python";
import type { JudgePart } from "./contracts";
import { JudgeSession } from "./judge";
import { validateJudgeBudget } from "./plan";

/**
 * Explicit paid check that the vision judge accepts images: one DAComp GSB visual comparison, using
 * reference report 1 (and its charts) as the candidate against reference report 0. Not part of any
 * routine check; run with `bun run test:smoke:judge`.
 */
export async function judgeSmoke(
  profileId = "deepseek-flash-judge",
  instance = "dacomp-002",
  root = "benchmarks/dacomp-da",
) {
  const options = { root, metadata: "benchmarks/metadata" };
  const adapter = createDacomp();
  const catalog = await adapter.catalog(options);
  const task = catalog.tasks.find((t) => t.id === instance);
  if (!task) throw new Error(`Unknown task ${instance}`);
  await adapter.preflight(options, [task]);
  const suite = resolve(
    root,
    "evaluator/upstream/dacomp-da/evaluation_suite/src",
    instance,
  );
  const candidateDir = join(suite, "gsb_ref_1");
  const report = (
    await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: candidateDir }))
  ).sort()[0];
  if (!report) throw new Error("Missing candidate report");
  const markdown = await Bun.file(join(candidateDir, report)).text();
  const images = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => join(candidateDir, m[1] ?? ""))
    .filter((p) => Bun.file(p).size > 0);
  const prepared = await scorerRequest(
    {
      operation: "dacomp_prepare",
      instance_dir: suite,
      report_path: join(candidateDir, report),
      report_images: images,
      query: task.goal,
      trajectory_path: null,
    },
    { limit: 16 * 1024 * 1024, timeout_ms: 60000 },
  );
  const item = (prepared.items as unknown[])
    .map(obj)
    .find((i) => i.label === "gsb_vision:gsb_ref_0");
  if (!item || !Array.isArray(item.parts)) throw new Error("No vision item");
  const parts = item.parts.map((p): JudgePart => {
    const x = obj(p);
    return x.type === "image"
      ? { type: "image", path: str(x.path, "path") }
      : { type: "text", text: str(x.text, "text") };
  });
  const profile = selectProfile(
    await Bun.file("configs/models.json").json(),
    profileId,
  );
  const budget = validateJudgeBudget({
    timeout_ms: 300000,
    model_attempts: 3,
    total_tokens: 200000,
  });
  const id = randomUUID();
  const directory = resolve("runs/judge-smoke", id);
  await mkdir(directory, { recursive: true });
  const session = new JudgeSession(
    {
      judges: { gsb_vision: profile },
      unit_budget: budget,
      batch_budget: budget,
      parse_retries: 1,
      options: {},
    },
    directory,
    [],
  );
  session.preflight();
  const judge = session.forUnit("smoke");
  let outcome: { status: "passed" | "failed"; [key: string]: unknown };
  try {
    const reply = await judge.ask(
      "gsb_vision",
      parts,
      `${instance}:gsb_vision:gsb_ref_0`,
      async (r) => {
        const check = await scorerRequest({
          operation: "dacomp_valid",
          kind: "gsb",
          reply: r,
        });
        if (check.valid !== true) throw new Error("Unparseable GSB reply");
        return r;
      },
    );
    const scores = await scorerRequest(
      {
        operation: "dacomp_combine",
        instance_dir: suite,
        rubric: JSON.stringify({ total_score: 0 }),
        gsb_text: [reply],
        gsb_vision: [reply],
        compat_rubric: null,
      },
      { limit: 16 * 1024 * 1024 },
    );
    outcome = {
      status: "passed",
      visualization: obj(scores.metrics).visualization,
    };
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const result = {
    smoke_id: id,
    at: new Date().toISOString(),
    profile: {
      id: profile.id,
      model: profile.model,
      generation: profile.generation,
    },
    instance,
    images_sent: parts.filter((p) => p.type === "image").length,
    ...outcome,
    judge: judge.summary(),
  };
  await writeJson(join(directory, "result.json"), result);
  return { ...result, directory };
}
if (import.meta.main) {
  const result = await judgeSmoke(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
}
