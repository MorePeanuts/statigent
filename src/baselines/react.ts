import { randomUUID } from "node:crypto";
import * as z from "zod";
import { Stop } from "../agent/stop";
import type { Message } from "../models/client";
import type { baselineModel } from "./model";
import {
  type BridgeRequest,
  relativePathSchema,
  submissionSchema,
} from "./protocol";

export const REACT_PROMPT = `You are a single ReAct data agent. Alternate reasoning, one action and the actual observation. Keep using the same Python session. There are no planner, debugger, EDA or notebook-summary agents.
Reply with exactly one JSON object, without markdown fences:
{"action":"execute","code":"Python code"}
{"action":"read_artifact","path":"relative output path"}
{"action":"register_bundle","bundle":"selected","entrypoint":"predict.py"}
{"action":"finish","submission":{"kind":"text","answer":"explicit answer"}}
For reports use {"kind":"report","path":"report.md"}; for fitted models use {"kind":"predictions","bundle":"selected","entrypoint":"predict.py"}.
Read only the listed files under /input, write report/images under /workspace. Packages are preinstalled, CPU only, no network or installation. Files and variables persist until the task ends. Save fitted model bundles under /tmp/baseline-models/<bundle>. All dependencies for inference must be inside that directory. predict.py receives --features, --output, --schema paths and only loads and predicts; schema contains protocol and seed. Test features are withheld until freezing, then no LLM, search or refitting is possible. Explicit bundle registration permits no-LLM delivery when the search budget ends. A claim in reasoning or a code output is not a final submission.`;
const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("execute"), code: z.string().min(1) }),
  z.strictObject({
    action: z.literal("read_artifact"),
    path: relativePathSchema,
  }),
  z.strictObject({
    action: z.literal("register_bundle"),
    bundle: relativePathSchema,
    entrypoint: relativePathSchema,
  }),
  z.strictObject({ action: z.literal("finish"), submission: submissionSchema }),
]);
export async function runReAct(options: {
  runId: string;
  task: Record<string, unknown>;
  maxTurns: number;
  model: ReturnType<typeof baselineModel>;
  handle: (request: BridgeRequest) => Promise<Record<string, unknown>>;
}) {
  const messages: Message[] = [
    { role: "system", content: REACT_PROMPT },
    { role: "user", content: JSON.stringify(options.task) },
  ];
  for (let turn = 1; turn <= options.maxTurns; turn++) {
    const response = await options.model.request(messages, "react");
    messages.push(response.message);
    let action: z.infer<typeof actionSchema>;
    try {
      if (response.message.tool_calls?.length)
        throw new Error("Use the declared JSON action protocol");
      action = actionSchema.parse(JSON.parse(response.message.content ?? ""));
    } catch (error) {
      messages.push({
        role: "user",
        content: `Invalid action: ${String(error).slice(0, 1024)}`,
      });
      continue;
    }
    const base = {
      protocol_version: 1 as const,
      run_id: options.runId,
      request_id: randomUUID(),
      sequence: turn,
    };
    const request: BridgeRequest =
      action.action === "execute"
        ? { ...base, type: "execution.execute", code: action.code }
        : action.action === "read_artifact"
          ? { ...base, type: "artifact.read", path: action.path }
          : action.action === "register_bundle"
            ? {
                ...base,
                type: "bundle.register",
                bundle: action.bundle,
                entrypoint: action.entrypoint,
              }
            : {
                ...base,
                type: "submission.finish",
                submission: action.submission,
              };
    const result = await options.handle(request);
    if (request.type === "submission.finish") return;
    messages.push({
      role: "user",
      content: JSON.stringify({ observation: result }),
    });
  }
  throw new Stop("budget_exhausted", "react_turn_limit");
}
