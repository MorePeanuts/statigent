import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parsePositionals } from "./cli-options";
import { cleanupRun } from "./execution/docker";
import { createSession } from "./execution/factory";
import { DEFAULT_LIMITS, type SessionConfig } from "./execution/protocol";
import { DockerSession } from "./execution/session";
import { exportNotebooks } from "./records/notebook";
import { replayRun } from "./records/replay";
import {
  inspectModelJournal,
  RunRecorder,
  readManifest,
} from "./records/store";

export const DEMO_CELLS = [
  'import pandas as pd\ndf = pd.read_csv("/input/synthetic.csv")\nprint("rows", len(df))',
  'means = df.groupby("group")["value"].mean()\nassert means.to_dict() == {"A": 2.0, "B": 4.0}\nprint(means.to_json())',
  'import matplotlib.pyplot as plt\nmeans.plot.bar()\nplt.tight_layout()\nplt.savefig("means.png")\nplt.show()',
];
export const DEMO_SCRIPTS = [
  'import pandas as pd\ndf=pd.read_csv("/input/synthetic.csv")\ndf.groupby("group")["value"].mean().to_csv("means.csv")',
  'import pandas as pd\nmeans=pd.read_csv("means.csv",index_col=0).iloc[:,0]\nassert means.to_dict()=={"A":2.0,"B":4.0}\nprint(means.to_json())\nimport matplotlib.pyplot as plt\nmeans.plot.bar()\nplt.tight_layout()\nplt.savefig("means.png")\nplt.close()',
];
export async function demo(
  runRoot: string,
  image: string,
  scenario = "normal",
) {
  const runId = randomUUID();
  const config: SessionConfig = {
    run_id: runId,
    ...(scenario === "fresh-script"
      ? { backend: "fresh-script" as const }
      : {}),
    image,
    input_root: resolve("tests/fixtures"),
    inputs: ["synthetic.csv"],
    staging_root: resolve(runRoot, ".staging"),
    seed: 42,
    limits: {
      ...DEFAULT_LIMITS,
      ...(scenario === "timeout" ? { cell_timeout_ms: 200 } : {}),
    },
  };
  const recorder = await RunRecorder.create({
    runRoot,
    runId,
    config: { ...config },
    inputs: [],
    image: { id: "unresolved", platform: "unresolved" },
    seed: config.seed,
    maxArtifactBytes: config.limits.max_artifact_bytes,
    maxTotalArtifactBytes:
      config.limits.max_artifacts_bytes + config.limits.max_output_bytes,
  });
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  let failure: unknown;
  const results = [];
  try {
    session = await createSession(config, recorder);
    if (scenario === "timeout") {
      const result = await session.execute(
        "import time\nvalue = 1\ntime.sleep(60)",
      );
      results.push(result);
      if (result.status !== "timed_out")
        throw new Error(`Expected timeout, got ${result.status}`);
    } else {
      for (const code of scenario === "fresh-script"
        ? DEMO_SCRIPTS
        : DEMO_CELLS) {
        const result = await session.execute(code);
        results.push(result);
        if (result.status !== "ok")
          throw new Error(
            `Demo execution ${result.status}: ${result.diagnostic ?? result.error?.evalue ?? ""}`,
          );
      }
      if (scenario === "restart") {
        if (!(session instanceof DockerSession))
          throw Error("Restart requires persistent kernel");
        await session.restart();
        const result = await session.execute("print(df)");
        results.push(result);
        if (result.status !== "error" || result.error?.ename !== "NameError")
          throw new Error("Restart must discard df");
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (session) {
      try {
        await session.close();
        if (session.closeResult?.status !== "ok")
          failure ??= new Error(
            `Session terminal status: ${session.closeResult?.status ?? "unknown"}`,
          );
      } catch (error) {
        failure ??= error;
      }
    }
  }
  await recorder.finish(failure ? "failed" : "completed");
  await exportNotebooks(recorder.directory);
  if (failure)
    throw new Error(`Run ${runId} failed; records: ${recorder.directory}`, {
      cause: failure,
    });
  return {
    run_id: runId,
    directory: recorder.directory,
    results: results.map((result) => ({
      status: result.status,
      ...(result.protocol_version === 1
        ? { cell_id: result.cell_id, kernel_epoch: result.kernel_epoch }
        : { execution_id: result.execution_id, process: result.process }),
      preview: result.preview,
      artifacts: result.artifacts,
    })),
    manifest: await readManifest(recorder.directory),
  };
}
async function main() {
  const [command, value, extra, scenario] = parsePositionals(
    Bun.argv.slice(2),
    "<command> [value] [extra] [scenario]",
    "Usage: bun run runtime demo [RUN_ROOT] [IMAGE] [normal|timeout|restart|fresh-script] | export RUN_DIRECTORY | inspect RUN_DIRECTORY | replay RUN_DIRECTORY [RUN_ROOT] | cleanup RUN_ID",
  );
  switch (command) {
    case "demo":
      return demo(
        resolve(value ?? "runs"),
        extra ?? "statigent-runtime:dev",
        scenario,
      );
    case "export":
      if (!value) throw new Error("export requires RUN_DIRECTORY");
      return exportNotebooks(resolve(value));
    case "inspect":
      if (!value) throw new Error("inspect requires RUN_DIRECTORY");
      return {
        ...(await readManifest(resolve(value))),
        model_journal: await inspectModelJournal(resolve(value)),
      };
    case "replay":
      if (!value) throw new Error("replay requires RUN_DIRECTORY");
      return replayRun(resolve(value), resolve(extra ?? "runs"));
    case "cleanup":
      if (!value) throw new Error("cleanup requires RUN_ID");
      return { removed: await cleanupRun(value) };
    default:
      throw new Error(
        "Usage: bun run runtime demo [RUN_ROOT] [IMAGE] [normal|timeout|restart|fresh-script] | export RUN_DIRECTORY | inspect RUN_DIRECTORY | replay RUN_DIRECTORY [RUN_ROOT] | cleanup RUN_ID",
      );
  }
}
if (import.meta.main)
  main()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (
        "status" in result &&
        (result.status === "failed" || result.status === "unsupported")
      )
        process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
