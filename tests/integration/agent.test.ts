import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgent } from "../../src/agent/run";
import { checkSyntheticRun } from "../../src/agent/smoke";
import { dockerCommand } from "../../src/execution/docker";
import { replayRun } from "../../src/records/replay";
import {
  readArtifact,
  readEvents,
  readManifest,
  sha256,
} from "../../src/records/store";
import {
  call,
  finish,
  lastFeedback,
  profile,
  reply,
  ScriptClient,
  task,
} from "../helpers/agent";

const inputCode =
  'import os\nfrom pathlib import Path\nimport pandas as pd\nassert "DEEPSEEK_API_KEY" not in os.environ\nassert "STATIGENT_FAKE_SECRET" not in os.environ\nassert not Path("/Users").exists()\nassert sorted(p.name for p in Path("/input").iterdir()) == ["synthetic.csv"]\ndf=pd.read_csv("/input/synthetic.csv")\nprint(df.shape)';
const statsCode =
  'means=df.groupby("group")["value"].mean()\nprint(means.to_json())\nimport matplotlib.pyplot as plt\nmeans.plot.bar()\nplt.tight_layout()\nplt.savefig("means.png")\nplt.show()';
const runRoot = resolve("runs/integration-agent");
async function snapshot(directory: string) {
  const names = [
    "manifest.json",
    "events.jsonl",
    "analysis.json",
    "analysis.md",
    ...(await readdir(join(directory, "artifacts"))).map(
      (n) => `artifacts/${n}`,
    ),
    ...(await readdir(join(directory, "notebooks"))).map(
      (n) => `notebooks/${n}`,
    ),
  ];
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        sha256(await readFile(join(directory, name))),
      ]),
    ),
  );
}
test("scripted model real Docker: state, isolation, evidence, PNG, notebooks, independent replay", async () => {
  const client = new ScriptClient((body, i) => {
    if (i === 0) return reply([call("execute_python", { code: inputCode })]);
    if (i === 1) return reply([call("execute_python", { code: statsCode })]);
    const feedback = lastFeedback(body);
    expect(feedback.preview).toContain('"A":2.0');
    expect(feedback.preview).toContain('"B":4.0');
    const artifacts = feedback.artifacts as {
      artifact_id: string;
      visually_observed: boolean;
    }[];
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every((a) => a.visually_observed === false)).toBe(true);
    const action = finish(String(feedback.cell_id));
    const args = JSON.parse(action.function.arguments);
    args.findings[0].evidence_refs.push(artifacts[0]?.artifact_id);
    action.function.arguments = JSON.stringify(args);
    return reply([action]);
  });
  const result = await runAgent({ task, profile, runRoot, client });
  expect(result.status, result.reason).toBe("completed");
  expect((await checkSyntheticRun(result)).status).toBe("passed");
  const manifest = await readManifest(result.directory);
  for (const ref of manifest.artifacts) {
    const bytes = await readArtifact(result.directory, ref);
    expect(bytes.includes(Buffer.from("fake-key-agent"))).toBe(false);
  }
  const before = await snapshot(result.directory);
  const replay = await replayRun(result.directory, runRoot);
  expect(replay.status, replay.reasons.join(";")).toBe("passed");
  expect(await snapshot(result.directory)).toEqual(before);
  if (!replay.directory) throw new Error("Missing replay");
  const m = await readManifest(replay.directory);
  expect(m.run_kind).toBe("code_replay");
  expect(m.model).toBe("not_applicable");
  expect(m.tokens).toBe("not_applicable");
  console.log(
    JSON.stringify({
      kind: "scripted_agent_acceptance",
      run_id: result.run_id,
      replay_id: replay.run_id,
    }),
  );
}, 180000);
test("scripted real Docker: reject mixed actions, partial-state repair, truncation and budgets", async () => {
  const client = new ScriptClient((body, i) => {
    if (i === 0)
      return reply([
        call("execute_python", {
          code: "raise AssertionError('MUST NOT RUN')",
        }),
        finish("foreign"),
      ]);
    if (i === 1)
      return reply([
        call("execute_python", {
          code: 'x=7\nprint("v"*100)\nraise ValueError("repair this")',
        }),
      ]);
    if (i === 2) {
      const feedback = lastFeedback(body);
      expect(feedback.partial_state_possible).toBe(true);
      expect(feedback.preview_truncated).toBe(true);
      return reply([call("execute_python", { code: "print(x+1)" })]);
    }
    return reply([finish(String(lastFeedback(body).cell_id))]);
  });
  const result = await runAgent({
    task: {
      ...task,
      execution: { ...task.execution, limits: { preview_chars: 20 } },
    },
    profile,
    runRoot,
    client,
  });
  expect(result.status, result.reason).toBe("completed");
  const m = await readManifest(result.directory);
  expect(m.timing.execution_count).toBe(2);
  expect(m.replay.reasons).toContain("cell_error");
  expect((await replayRun(result.directory, runRoot)).status).toBe(
    "unsupported",
  );
  const events = await readEvents(result.directory);
  expect(events.filter((e) => e.type === "dispatch")).toHaveLength(2);
  const capped = await runAgent({
    task: { ...task, budget: { executions: 1 } },
    profile,
    runRoot,
    client: new ScriptClient(() =>
      reply([call("execute_python", { code: "print(1)" })]),
    ),
  });
  expect(capped.status).toBe("budget_exhausted");
  expect((await readManifest(capped.directory)).timing.execution_count).toBe(1);
  for (const run of [result, capped])
    expect(
      await dockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=org.statigent.run=${run.run_id}`,
      ]),
    ).toBe("");
  console.log(
    JSON.stringify({
      kind: "scripted_agent_faults",
      repair_run_id: result.run_id,
      budget_run_id: capped.run_id,
    }),
  );
}, 120000);
test("real Docker cancellation during active code has one terminal and cleans up", async () => {
  const controller = new AbortController();
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const result = await runAgent({
    task,
    profile,
    runRoot,
    signal: controller.signal,
    client: new ScriptClient(() =>
      reply([call("execute_python", { code: "import time\ntime.sleep(30)" })]),
    ),
    createSession: async (config, recorder) => {
      const { DockerSession } = await import("../../src/execution/session");
      const session = await DockerSession.create(config, recorder);
      return {
        get closeResult() {
          return session.closeResult;
        },
        close: () => session.close(),
        cancel: (id) => session.cancel(id),
        execute: (code, opts) => {
          cancelTimer = setTimeout(() => controller.abort(), 300);
          return session.execute(code, opts);
        },
      };
    },
  });
  clearTimeout(cancelTimer);
  expect(result.status, result.reason).toBe("cancelled");
  expect(
    (await readEvents(result.directory)).filter(
      (e) => e.type === "run_finished",
    ),
  ).toHaveLength(1);
  expect(
    await dockerCommand([
      "ps",
      "-aq",
      "--filter",
      `label=org.statigent.run=${result.run_id}`,
    ]),
  ).toBe("");
}, 90000);

test("CLI fake HTTP documents run/inspect/export/cleanup and non-success exit", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "statigent-cli-integration-"));
  let count = 0;
  let reject = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(req.headers.get("authorization")).toBe("Bearer cli-fake-secret");
      const body = (await req.json()) as Record<string, unknown>;
      if (reject) return new Response("denied", { status: 401 });
      return Response.json(
        count++ === 0
          ? reply([call("execute_python", { code: inputCode })])
          : reply([finish(String(lastFeedback(body).cell_id))]),
      );
    },
  });
  const command = async (args: string[]) => {
    const p = Bun.spawn(["bun", ...args], {
      env: { ...process.env, STATIGENT_CLI_TEST_KEY: "cli-fake-secret" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(stdout + stderr).not.toContain("cli-fake-secret");
    return { stdout, stderr, code };
  };
  try {
    const path = join(root, "models.json");
    await Bun.write(
      path,
      JSON.stringify([
        {
          ...profile,
          base_url: server.url.href,
          allow_loopback_http: true,
          api_key_env: "STATIGENT_CLI_TEST_KEY",
        },
      ]),
    );
    const args = [
      "src/agent/cli.ts",
      "run",
      "--task",
      "configs/tasks/synthetic-eda.json",
      "--models",
      path,
      "--runs",
      runRoot,
    ];
    const first = await command(args);
    expect(first.code, first.stderr).toBe(0);
    const result = JSON.parse(
      first.stdout.slice(first.stdout.indexOf("\n") + 1),
    );
    const inspected = await command([
      "src/cli.ts",
      "inspect",
      result.directory,
    ]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout).run_kind).toBe("agent");
    expect(
      (await command(["src/cli.ts", "export", result.directory])).code,
    ).toBe(0);
    expect((await command(["src/cli.ts", "cleanup", result.run_id])).code).toBe(
      0,
    );
    reject = true;
    const failed = await command(args);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("http_401");
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
