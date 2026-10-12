import { afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupRun } from "../../src/execution/docker.ts";
import {
  DEFAULT_LIMITS,
  type Limits,
  type RuntimeEvent,
  type SessionConfig,
} from "../../src/execution/protocol.ts";
import { DockerSession } from "../../src/execution/session.ts";

const image = process.env.STATIGENT_TEST_IMAGE ?? "statigent-runtime:dev";
const sessions: DockerSession[] = [];
let root = "";

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]}: ${stderr}`);
  return stdout;
}

beforeAll(async () => {
  // Integration is an explicit entry point: unavailable Docker must fail, not skip.
  await docker("version", "--format", "{{.Server.Version}}");
  await docker("image", "inspect", image);
  await mkdir(resolve("runs"), { recursive: true });
  root = await mkdtemp(resolve("runs/integration-"));
  await mkdir(`${root}/input`);
  await writeFile(`${root}/input/data.csv`, "group,value\na,2\na,4\nb,9\n");
  await writeFile(
    `${root}/private-answer.txt`,
    "synthetic-answer-not-for-container",
  );
}, 30000);

afterEach(async () => {
  const owned = sessions.splice(0);
  const outcomes = await Promise.allSettled(
    owned.map((session) => session.close()),
  );
  for (const outcome of outcomes)
    if (outcome.status === "rejected") throw outcome.reason;
});

function config(limits: Partial<Limits> = {}): SessionConfig {
  return {
    run_id: `acceptance-${randomUUID()}`,
    image,
    input_root: `${root}/input`,
    inputs: ["data.csv"],
    staging_root: `${root}/staging`,
    seed: 42,
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
}

async function create(limits: Partial<Limits> = {}) {
  const events: RuntimeEvent[] = [];
  const session = await DockerSession.create(config(limits), {
    onEvent: async (event) => {
      events.push(event);
    },
  });
  sessions.push(session);
  return { session, events };
}

async function until(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("condition deadline exceeded");
    await Bun.sleep(10);
  }
}

test("persistent CSV state, rich output, error side effects, and explicit restart", async () => {
  const { session, events } = await create();
  expect(
    (
      await session.execute(
        "import pandas as pd\ndf = pd.read_csv('/input/data.csv')",
      )
    ).status,
  ).toBe("ok");
  const summary = await session.execute(
    "print(df.groupby('group')['value'].mean().to_dict())",
  );
  expect(summary.status).toBe("ok");
  expect(summary.preview).toContain("'a': 3.0");
  const chart = await session.execute(
    "import matplotlib.pyplot as plt\nplt.plot([1,2],[3,4])\nplt.show()",
  );
  expect(chart.status).toBe("ok");
  expect(JSON.stringify(events)).toContain("image/png");
  const failed = await session.execute(
    "changed = 17\nraise ValueError('intentional fixture error')",
  );
  expect(failed.status).toBe("error");
  expect(failed.kernel_available).toBe(true);
  expect((await session.execute("print(changed)")).preview).toContain("17");
  await session.restart();
  const missing = await session.execute("print(changed)");
  expect(missing.status).toBe("error");
  expect(missing.kernel_epoch).toBeGreaterThan(failed.kernel_epoch);
  expect((await session.execute("input('must not wait')")).status).toBe(
    "error",
  );
}, 120000);

test("two containers isolate state, files, inputs, environment, network and host controls", async () => {
  const previous = process.env.STATIGENT_TEST_SECRET;
  process.env.STATIGENT_TEST_SECRET = "synthetic-secret-not-for-container";
  let first: Awaited<ReturnType<typeof create>>;
  try {
    first = await create();
  } finally {
    if (previous === undefined) delete process.env.STATIGENT_TEST_SECRET;
    else process.env.STATIGENT_TEST_SECRET = previous;
  }
  const second = await create();
  expect(first.session.containerName).not.toBe(second.session.containerName);
  expect(
    (
      await first.session.execute(
        "private_value = 31\nopen('/workspace/only-a.txt','w').write('a')",
      )
    ).status,
  ).toBe("ok");
  expect((await second.session.execute("print(private_value)")).status).toBe(
    "error",
  );
  const result = await second.session.execute(`import os, socket
from pathlib import Path
assert os.getuid() != 0
assert not Path('/workspace/only-a.txt').exists()
assert Path('/input/data.csv').is_file()
assert not Path(${JSON.stringify(`${root}/private-answer.txt`)}).exists()
assert not Path('/var/run/docker.sock').exists()
assert os.environ.get('STATIGENT_TEST_SECRET') is None
for path in ['/input/data.csv', '/runtime-write-probe', ${JSON.stringify(`${root}/record-write-probe`)}]:
    try:
        with open(path, 'w') as target: target.write('forbidden')
    except OSError:
        pass
    else:
        raise AssertionError('unexpected writable path: '+path)
try:
    connection = socket.create_connection(('1.1.1.1', 443), timeout=0.3)
except OSError:
    pass
else:
    connection.close()
    raise AssertionError('external network accessible')
print('isolation-ok')`);
  expect(result.status).toBe("ok");
  expect(result.preview).toContain("isolation-ok");
  expect(await readFile(`${root}/input/data.csv`, "utf8")).toBe(
    "group,value\na,2\na,4\nb,9\n",
  );
  const hostConfig = JSON.parse(
    await docker(
      "inspect",
      first.session.containerName,
      "--format",
      "{{json .HostConfig}}",
    ),
  ) as Record<string, unknown>;
  expect(hostConfig.NetworkMode).toBe("none");
  expect(hostConfig.ReadonlyRootfs).toBe(true);
  expect(hostConfig.Privileged).toBe(false);
  expect(hostConfig.Memory).toBe(DEFAULT_LIMITS.memory_bytes);
  expect(hostConfig.PidsLimit).toBe(DEFAULT_LIMITS.pids);
  expect(hostConfig.NanoCpus).toBe(DEFAULT_LIMITS.cpus * 1e9);
  expect(JSON.stringify(hostConfig.SecurityOpt)).toContain("no-new-privileges");
}, 120000);

test("serial scheduling, queued cancellation and duplicate identifiers have no extra side effects", async () => {
  const { session } = await create();
  const active = session.execute("import time\ntime.sleep(0.5)\ncounter = 1", {
    requestId: "first",
  });
  const cancelled = session.execute("counter += 100", { requestId: "queued" });
  await session.cancel("queued");
  const duplicate = session.execute("counter += 1000", { requestId: "first" });
  await expect(duplicate).rejects.toThrow();
  expect((await cancelled).started).toBe(false);
  expect((await active).status).toBe("ok");
  const result = await session.execute("print(counter)");
  expect(result.preview.trim()).toBe("1");
  expect(result.execution_seq).toBe(2);
}, 120000);

test("interruptible timeout and explicit cancellation leave no unconfirmed active execution", async () => {
  const { session } = await create({ cell_timeout_ms: 1000 });
  const timed = await session.execute("import time\ntime.sleep(20)");
  expect(timed.status).toBe("timed_out");
  expect(timed.kernel_available).toBe(true);
  expect((await session.execute("print(123)")).status).toBe("ok");
  const pending = session.execute("import time\ntime.sleep(20)", {
    requestId: "cancel-active",
  });
  await until(() => session.state === "busy");
  await session.cancel("cancel-active");
  expect((await pending).status).toBe("cancelled");
  expect((await session.execute("print(456)")).status).toBe("ok");
}, 120000);

test("code ignoring interrupts is force-stopped and container is removed", async () => {
  const { session } = await create({
    cell_timeout_ms: 1000,
    interrupt_grace_ms: 500,
  });
  const result = await session.execute(
    "import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True: time.sleep(0.1)",
  );
  expect(result.kernel_available).toBe(false);
  expect(["timed_out", "kernel_lost"]).toContain(result.status);
  await session.close();
  expect(
    (
      await docker("ps", "-aq", "--filter", `name=^/${session.containerName}$`)
    ).trim(),
  ).toBe("");
}, 120000);

test("preview truncation and persistent-output limit are distinguishable", async () => {
  const { session } = await create({
    preview_chars: 80,
    max_output_bytes: 16384,
  });
  const preview = await session.execute("print('x' * 2000)");
  expect(preview.status).toBe("ok");
  expect(preview.preview_truncated).toBe(true);
  expect(preview.persistence_complete).toBe(true);
  const flood = await session.execute("while True: print('y' * 1024)");
  expect(flood.status).toBe("output_limit_exceeded");
  expect(flood.persistence_complete).toBe(false);
}, 120000);

test("bounded workspace and process count prevent unlimited resource use", async () => {
  const { session } = await create({
    workspace_bytes: 2 * 1024 * 1024,
    pids: 64,
  });
  const disk = await session.execute(
    "import os\ntry:\n    with open('/workspace/oversize.bin', 'wb') as f:\n        f.write(b'x' * (3 * 1024 * 1024))\nfinally:\n    os.unlink('/workspace/oversize.bin')",
  );
  expect(disk.status).toBe("error");
  const pids = await session.execute(`import subprocess
children=[]
limited=False
try:
    for _ in range(80):
        try: children.append(subprocess.Popen(['/bin/sleep', '5']))
        except BlockingIOError:
            limited=True
            break
finally:
    for child in children: child.terminate()
    for child in children: child.wait()
assert limited, 'process limit not enforced'
print('pids-limited')`);
  expect(pids.status).toBe("ok");
  expect(pids.preview).toContain("pids-limited");
}, 120000);

test("memory exhaustion has explicit failure and does not hang the host", async () => {
  const { session } = await create({
    memory_bytes: 384 * 1024 * 1024,
    cell_timeout_ms: 15000,
  });
  const result = await session.execute(
    "blocks=[]\nfor _ in range(128): blocks.append(bytearray(16 * 1024 * 1024))",
  );
  expect(["kernel_lost", "error"]).toContain(result.status);
  expect(result.status).not.toBe("ok");
}, 120000);

test("task deadline cancels remaining work and closes the container", async () => {
  const { session } = await create({
    task_timeout_ms: 6000,
    cell_timeout_ms: 30000,
  });
  const active = session.execute("import time\ntime.sleep(30)");
  const queued = session.execute("print('must not execute')");
  expect(["timed_out", "cancelled"]).toContain((await active).status);
  expect((await queued).started).toBe(false);
  await session.close();
  expect(
    (
      await docker("ps", "-aq", "--filter", `name=^/${session.containerName}$`)
    ).trim(),
  ).toBe("");
}, 120000);

test("invalid paths and unavailable images never start user execution", async () => {
  const link = `outside-${randomUUID()}`;
  await symlink(`${root}/private-answer.txt`, `${root}/input/${link}`);
  for (const inputs of [["../private-answer.txt"], [link]]) {
    const request = { ...config(), inputs };
    await expect(DockerSession.create(request)).rejects.toThrow();
    expect(
      (
        await docker(
          "ps",
          "-aq",
          "--filter",
          `label=org.statigent.run=${request.run_id}`,
        )
      ).trim(),
    ).toBe("");
  }
  const unavailable = {
    ...config(),
    image: `statigent-missing-${randomUUID()}:none`,
  };
  await expect(DockerSession.create(unavailable)).rejects.toThrow();
  expect(
    (
      await docker(
        "ps",
        "-aq",
        "--filter",
        `label=org.statigent.run=${unavailable.run_id}`,
      )
    ).trim(),
  ).toBe("");
}, 120000);

test("cleanup selects one run and preserves another container", async () => {
  const first = await create();
  const second = await create();
  const removed = await cleanupRun(first.session.runId);
  expect(removed.length).toBe(1);
  expect(
    (await second.session.execute("print('still-running')")).preview,
  ).toContain("still-running");
  expect(
    (
      await docker(
        "ps",
        "-aq",
        "--filter",
        `name=^/${first.session.containerName}$`,
      )
    ).trim(),
  ).toBe("");
  await second.session.close();
  await second.session.close();
}, 120000);
