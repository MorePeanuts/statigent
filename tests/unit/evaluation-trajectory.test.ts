import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerCommandAdapter } from "../../src/evaluation/agents/container-command";
import { statigentAdapter } from "../../src/evaluation/agents/statigent";
import {
  buildTrajectory,
  truncateMiddle,
} from "../../src/evaluation/agents/trajectory";
import { validateConfig } from "../../src/evaluation/plan";
import { exportNotebooks } from "../../src/records/notebook";
import {
  call,
  fakeRuntime,
  finish,
  lastFeedback,
  reply,
  ScriptClient,
} from "../helpers/agent";
import { config, fixtureRegistry, invocation } from "../helpers/evaluation";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function runWithTrajectory(script: (root: string) => string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "trajectory-")));
  const codes = script(root);
  roots.push(root);
  await writeFile(join(root, "data.csv"), "value\n1\n2\n");
  await mkdir(join(root, "deliverables"));
  const client = new ScriptClient((body, n) => {
    const code = codes[n];
    if (code !== undefined) return reply([call("execute_python", { code })]);
    return reply([finish(String(lastFeedback(body).cell_id))]);
  });
  const adapter = statigentAdapter({
    overrides: {
      client,
      createSession: fakeRuntime().createSession,
      export: (dir, _, status) => exportNotebooks(dir, async () => {}, status),
    },
  });
  const s = await adapter.run({ ...invocation(root), trajectory: true });
  return { s, root };
}
test("Statigent delivers a unified trajectory in execution order without host paths or keys", async () => {
  const secret = "sk-trajectory-secret";
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = secret;
  let result: Awaited<ReturnType<typeof runWithTrajectory>>;
  try {
    result = await runWithTrajectory((dir) => [
      "df = load()",
      `print("${dir}/units and ${secret}")`,
    ]);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
  const { s, root } = result;
  expect(s.status, s.reason).toBe("completed");
  expect(s.trajectory).toBe("trajectory.txt");
  expect(s.deliverables).toEqual([]);
  const text = await readFile(
    join(root, "deliverables/trajectory.txt"),
    "utf8",
  );
  expect(text.startsWith("# Analysis trajectory (trajectory-v1)")).toBe(true);
  expect(text.indexOf("df = load()")).toBeLessThan(text.indexOf("print("));
  expect(text).toContain("## Step 2");
  expect(text).toContain("## Final report");
  expect(text).not.toContain(root);
  expect(text).toContain("[host]/units");
  expect(text).not.toContain(secret);
  expect(statigentAdapter().capabilities.trajectory).toBe("unified");
  expect(containerCommandAdapter().capabilities.trajectory).toBe("none");
});
test("trajectories over the limit are cut from the middle and marked", async () => {
  const text = `HEAD${"x".repeat(1000)}TAIL`;
  const cut = truncateMiddle(text, 200);
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(200);
  expect(cut.startsWith("HEAD")).toBe(true);
  expect(cut.endsWith("TAIL")).toBe(true);
  expect(cut).toContain("bytes omitted from the middle");
  expect(truncateMiddle("short", 200)).toBe("short");
  const { root, s } = await runWithTrajectory(() => ["print(1)"]);
  expect(s.status).toBe("completed");
  const native = s.native_run?.directory ?? "";
  const small = await buildTrajectory(native, "R".repeat(5000), [root], 1024);
  expect(Buffer.byteLength(small)).toBeLessThanOrEqual(1024);
  expect(small).toContain("omitted");
});
test("plans needing a unified trajectory reject agents that cannot deliver one", () => {
  const registry = fixtureRegistry();
  const benchmark = registry.getBenchmark("synthetic");
  benchmark.requiresTrajectory = () => true;
  expect(() => validateConfig(config(), registry)).toThrow(
    "cannot deliver a unified trajectory",
  );
  registry.getAgent("fixture").capabilities.trajectory = "unified";
  expect(validateConfig(config(), registry).agents).toHaveLength(1);
});
