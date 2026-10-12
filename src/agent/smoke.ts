import { join } from "node:path";
import { dockerCommand } from "../execution/docker";
import { type Notebook, validateNotebook } from "../records/notebook";
import {
  object,
  readArtifact,
  readEvents,
  readManifest,
  writeJson,
} from "../records/store";
import { validateAction } from "./actions";
import { loadConfiguration } from "./cli";
import { type AgentResult, runAgent } from "./run";

function groupMeans(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(groupMeans);
  const x = object(value);
  if (
    typeof x.A === "number" &&
    typeof x.B === "number" &&
    Math.abs(x.A - 2) < 1e-9 &&
    Math.abs(x.B - 4) < 1e-9
  )
    return true;
  return Object.values(x).some(groupMeans);
}
export async function checkSyntheticRun(result: AgentResult) {
  const manifest = await readManifest(result.directory);
  const events = await readEvents(result.directory);
  if (result.status !== "completed" || manifest.status !== "completed")
    throw new Error(`Agent incomplete: ${result.reason}`);
  const successes = events.filter(
    (e) =>
      e.type === "finish" &&
      e.result &&
      object(e.result).started === true &&
      object(e.result).status === "ok",
  );
  if (successes.length < 2)
    throw new Error("At least two successful cells required");
  const evidence = new Set(
    successes.map((e) => String(object(e.result).cell_id)),
  );
  const codeArtifacts = manifest.artifacts.filter(
    (a) => a.cell_id && a.complete,
  );
  for (const a of codeArtifacts) evidence.add(a.artifact_id);
  const stored = object(
    await Bun.file(join(result.directory, "analysis.json")).json(),
  );
  if (stored.run_id !== result.run_id)
    throw new Error("Analysis run identity mismatch");
  const { run_id: _id, ...analysis } = stored;
  validateAction(
    "finish_analysis",
    JSON.stringify(analysis),
    evidence,
    successes.length,
    100000,
  );
  if (
    !Array.isArray(analysis.findings) ||
    !analysis.findings.some((f) => groupMeans(object(f).value))
  )
    throw new Error("Missing expected numerical group means");
  const pngs = codeArtifacts.filter((a) => a.mime_type === "image/png");
  if (!pngs.length) throw new Error("No saved PNG");
  for (const png of pngs) {
    await readArtifact(result.directory, png);
    const proc = Bun.spawn(
      [
        "uv",
        "run",
        "--frozen",
        "python",
        "-c",
        "import sys; from PIL import Image; Image.open(sys.argv[1]).verify()",
        join(result.directory, png.path),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), 30000);
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error(`PNG validation failed: ${stderr}`);
  }
  if (manifest.export.status !== "exported" || !manifest.export.paths.length)
    throw new Error("Notebook not exported");
  for (const path of manifest.export.paths)
    await validateNotebook(
      (await Bun.file(join(result.directory, path)).json()) as Notebook,
    );
  if (
    manifest.tokens === "not_applicable" ||
    manifest.tokens.status !== "known" ||
    manifest.tokens.total_tokens <= 0
  )
    throw new Error("Measured usage required");
  if (
    await dockerCommand([
      "ps",
      "-aq",
      "--filter",
      `label=org.statigent.run=${result.run_id}`,
    ])
  )
    throw new Error("Container remains");
  return {
    status: "passed",
    run_id: result.run_id,
    successful_cells: successes.length,
    pngs: pngs.length,
    tokens: manifest.tokens,
    model: manifest.model,
    notebooks: manifest.export.paths,
  };
}
export async function smokeMain(args: string[]) {
  const config = await loadConfiguration(
    args[0] === "--" ? args.slice(1) : args,
    true,
  );
  console.log(
    JSON.stringify({
      kind: "explicit_model_smoke",
      model: config.profile.model,
      budget: config.task.budget,
      generation: config.profile.generation,
    }),
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let result: AgentResult;
  try {
    result = await runAgent({ ...config, signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  console.log(
    JSON.stringify({
      run_id: result.run_id,
      directory: result.directory,
      status: result.status,
      reason: result.reason,
    }),
  );
  try {
    const check = await checkSyntheticRun(result);
    await writeJson(join(result.directory, "smoke-result.json"), check);
    return check;
  } catch (error) {
    await writeJson(join(result.directory, "smoke-result.json"), {
      status: "failed",
      run_id: result.run_id,
      reason: error instanceof Error ? error.message : "Smoke failed",
    });
    throw error;
  }
}
if (import.meta.main)
  smokeMain(Bun.argv.slice(2))
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Smoke failed");
      process.exitCode = 1;
    });
