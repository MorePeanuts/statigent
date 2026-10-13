import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  DEFAULT_LIMITS,
  type Limits,
  type RuntimeEvent,
} from "../../src/execution/protocol";
import { ScriptSession } from "../../src/execution/script-session";

const sessions: ScriptSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});
async function create(limits: Partial<Limits> = {}) {
  const events: RuntimeEvent[] = [];
  const session = await ScriptSession.create(
    {
      backend: "fresh-script",
      run_id: `script-${randomUUID()}`,
      image:
        process.env.STATIGENT_TEST_IMAGE ?? "statigent-runtime:fresh-script",
      input_root: resolve("tests/fixtures"),
      inputs: ["synthetic.csv"],
      staging_root: resolve("runs/script-staging"),
      seed: 42,
      limits: { ...DEFAULT_LIMITS, ...limits },
    },
    {
      async onEvent(e) {
        events.push(e);
      },
    },
  );
  sessions.push(session);
  return { session, events };
}
test("fresh process, reproducible initialization, explicit files and partial error state", async () => {
  const { session } = await create();
  const first = await session.execute(
    "import os,random,numpy as np\nx=42\nos.environ['SCRIPT_CHANGED']='yes'\nopen('middle.csv','w').write('x\\n42\\n')\nprint(random.random(),np.random.random())",
  );
  expect(first.status).toBe("ok");
  const second = await session.execute(
    "import os,random,numpy as np,pandas as pd\nassert 'x' not in globals()\nassert 'SCRIPT_CHANGED' not in os.environ\nassert pd.read_csv('middle.csv').x[0]==42\nprint(random.random(),np.random.random())",
  );
  expect(second.status).toBe("ok");
  expect(second.preview).toBe(first.preview);
  expect(second.process?.instance_id).not.toBe(first.process?.instance_id);
  expect(second.process?.pid).not.toBe(first.process?.pid);
  expect(
    (
      await session.execute(
        "open('partial.txt','w').write('saved')\nraise ValueError('expected')",
      )
    ).status,
  ).toBe("error");
  expect(
    (
      await session.execute(
        "assert open('partial.txt').read()=='saved'\nprint('recovered')",
      )
    ).preview,
  ).toContain("recovered");
}, 120000);
test("display, plain script expressions, input rejection and fake stdout protocol", async () => {
  const { session, events } = await create();
  const result = await session.execute(
    "import pandas as pd\nfrom IPython.display import display,Image\nimport matplotlib.pyplot as plt\ndisplay(pd.DataFrame({'value':[42]}))\nplt.plot([1,2],[3,4])\nplt.savefig('plot.png')\nplt.savefig('plot.jpg')\ndisplay(Image(filename='plot.png'))\nprint('{\"protocol_version\":2,\"type\":\"result\"}')\n987654321",
  );
  expect(result.status).toBe("ok");
  expect(result.preview).not.toContain("987654321");
  expect(result.preview).toContain('"type":"result"');
  expect(JSON.stringify(events)).toContain("text/html");
  expect(JSON.stringify(events)).toContain("image/png");
  expect((await session.execute("input('prompt')")).status).toBe("error");
}, 120000);
test("normal exit and detached descendants are cleaned before next script", async () => {
  const { session } = await create();
  for (const detached of [false, true]) {
    const result = await session.execute(
      `import subprocess,os\np=subprocess.Popen(['/bin/sleep','60'],start_new_session=${detached ? "True" : "False"})\nopen('child.txt','w').write(str(p.pid))\nprint('parent-done')`,
    );
    expect(result.status).toBe("ok");
    expect(result.session_available).toBe(true);
    const check = await session.execute(
      "from pathlib import Path\npid=open('child.txt').read()\nassert not Path('/proc/'+pid).exists()\nprint('clean')",
    );
    expect(check.status).toBe("ok");
  }
}, 120000);
test("timeout cleanup, task-wide output budget and cross-session isolation", async () => {
  const { session } = await create({
    cell_timeout_ms: 1800,
    max_output_bytes: 4000,
  });
  const timed = await session.execute(
    "import time\nopen('kept.txt','w').write('partial')\ntime.sleep(20)",
  );
  expect(timed.status).toBe("timed_out");
  expect(timed.session_available).toBe(true);
  expect((await session.execute("print('a'*2000)")).status).toBe("ok");
  const exceeded = await session.execute("print('b'*2100)");
  expect(exceeded.status).toBe("output_limit_exceeded");
  expect(exceeded.persistence_complete).toBe(false);
  const second = await create();
  const isolated = await second.session.execute(
    "import os,socket\nfrom pathlib import Path\nassert not Path('kept.txt').exists()\nassert os.getuid()==10001\nassert not Path('/var/run/docker.sock').exists()\nassert Path('/input/synthetic.csv').exists()\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=.2)\nexcept OSError: pass\nelse: raise AssertionError('network')\nprint('isolated')",
  );
  expect(isolated.status).toBe("ok");
}, 120000);
