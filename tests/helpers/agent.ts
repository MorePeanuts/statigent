import { randomUUID } from "node:crypto";
import profiles from "../../configs/models.json";
import task from "../../configs/tasks/synthetic-eda.json";
import type { RunOptions } from "../../src/agent/run";
import {
  DEFAULT_LIMITS,
  type ExecutionResult,
} from "../../src/execution/protocol";
import {
  ChatClient,
  type ModelResponse,
  parseResponse,
} from "../../src/models/client";
import { validateProfile } from "../../src/models/config";
import type { RunRecorder } from "../../src/records/store";
export { task };
export const profile = validateProfile(profiles[0]);
export function call(name: string, args: unknown, id: string = randomUUID()) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}
export function reply(
  calls?: unknown[],
  override: Record<string, unknown> = {},
): unknown {
  return {
    id: randomUUID(),
    model: "fake-v1",
    choices: [
      {
        index: 0,
        finish_reason: calls?.length ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: calls?.length ? null : "```python\nSIDE_EFFECT()\n```",
          reasoning_content: "test reasoning",
          ...(calls?.length ? { tool_calls: calls } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...override,
  };
}
export function finish(ref: string) {
  return call("finish_analysis", {
    summary: "分组统计",
    findings: [
      {
        statement: "分组均值",
        value: { group_means: { A: 2, B: 4 } },
        evidence_refs: [ref],
      },
    ],
    methods: ["读取全部允许数据，按组求均值；无缺失值。"],
    limitations: ["合成数据不能泛化。"],
  });
}
export class ScriptClient extends ChatClient {
  bodies: Record<string, unknown>[] = [];
  constructor(
    readonly script: (
      body: Record<string, unknown>,
      index: number,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>,
    selected = profile,
  ) {
    super(selected, { [selected.api_key_env]: "fake-key-agent" });
  }
  override async send(
    body: string,
    _limits: unknown,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const parsed: Record<string, unknown> = JSON.parse(body);
    this.bodies.push(parsed);
    const value = await this.script(parsed, this.bodies.length - 1, signal);
    return parseResponse(value, this.profile, 1);
  }
}
export function lastFeedback(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = body.messages as { role: string; content: string }[];
  const feedback = [...messages].reverse().find((m) => m.role === "tool");
  if (!feedback) throw new Error("Missing feedback");
  return JSON.parse(feedback.content);
}
export function fakeRuntime(statuses: Partial<ExecutionResult>[] = []) {
  const state: {
    codes: string[];
    closed: number;
    cancelled: number;
    recorder?: RunRecorder;
  } = { codes: [], closed: 0, cancelled: 0 };
  const createSession: NonNullable<RunOptions["createSession"]> = async (
    config,
    recorder,
  ) => {
    state.recorder = recorder;
    const event = (type: string, fields: Record<string, unknown>) =>
      recorder.onEvent({
        type,
        run_id: config.run_id,
        session_id: "s1",
        at: new Date().toISOString(),
        ...fields,
      });
    return {
      closeResult: { status: "ok" },
      async close() {
        state.closed++;
      },
      async cancel() {
        state.cancelled++;
      },
      async execute(code, { requestId }) {
        state.codes.push(code);
        const seq = state.codes.length;
        const result: ExecutionResult = {
          protocol_version: 1,
          request_id: requestId,
          session_id: "s1",
          cell_id: `cell-${seq}`,
          kernel_epoch: 1,
          execution_seq: seq,
          started: true,
          status: "ok",
          elapsed_ms: 1,
          waiting_ms: 0,
          kernel_available: true,
          persistence_complete: true,
          preview: "{A:2,B:4}",
          preview_truncated: false,
          partial_state_possible: false,
          artifacts: [],
          ...statuses[seq - 1],
        };
        await event("dispatch", {
          request: {
            request_id: requestId,
            cell_id: result.cell_id,
            kernel_epoch: 1,
            execution_seq: seq,
            code,
          },
        });
        await event("finish", { result });
        return result;
      },
    };
  };
  return { ...state, state, createSession };
}
export const executeLimits = DEFAULT_LIMITS;
