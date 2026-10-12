import { DEFAULT_BUDGET } from "../../src/agent/config";
import { obj } from "../../src/models/validation";
import {
  type CollaborationRecord,
  emptyLedger,
} from "../../src/records/agent-metadata";
import { RunRecorder } from "../../src/records/store";
import { call, finish, lastFeedback, profile, reply } from "./agent";

export function currentSubtask(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) throw new Error("Missing messages");
  for (const value of [...messages].reverse()) {
    const m = obj(value);
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const content = obj(JSON.parse(m.content));
    if (typeof content.subtask_id === "string") return content.subtask_id;
  }
  throw new Error("Missing subtask");
}
export function returned(
  body: Record<string, unknown>,
  refs?: string[],
  overrides: Record<string, unknown> = {},
) {
  const ref = refs ?? [String(lastFeedback(body).cell_id)];
  return call("return_result", {
    subtask_id: currentSubtask(body),
    status: "completed",
    summary: "Computed means",
    findings: [
      {
        statement: "Group means",
        value: { group_means: { A: 2, B: 4 } },
        evidence_refs: ref,
      },
    ],
    methods: ["All input rows"],
    limitations: [],
    diagnostic: null,
    ...overrides,
  });
}
export function twoSubtasks(body: Record<string, unknown>, i: number) {
  if (i === 0 || i === 3)
    return reply([
      call("delegate_analysis", {
        task: i === 0 ? "Compute means" : "Check difference",
        constraints: [],
      }),
    ]);
  if (i === 1 || i === 4)
    return reply([
      call("execute_python", {
        code: i === 1 ? "secret_state=2" : "print(secret_state)",
      }),
    ]);
  if (i === 2 || i === 5) return reply([returned(body)]);
  const feedback = lastFeedback(body);
  const findings = feedback.findings;
  if (!Array.isArray(findings)) throw new Error("Missing findings");
  const refs = obj(findings[0]).evidence_refs;
  if (!Array.isArray(refs)) throw new Error("Missing refs");
  return reply([finish(String(refs[0]))]);
}

export function collaborationMetadata(): CollaborationRecord {
  const role = () => ({
    model: { profile, returned_models: [], response_ids: [], fingerprints: [] },
    prompt: { version: "fixture", sha256: "a".repeat(64) },
    tokens: emptyLedger(),
  });
  return {
    organization: "planner-executor",
    roles: { planner: role(), executor: role() },
    subtasks: [],
  };
}
export function collaborationRecorder(root: string) {
  const collaboration = collaborationMetadata();
  return RunRecorder.create({
    runRoot: root,
    config: {},
    inputs: [],
    image: { id: "fixture", platform: "linux/arm64" },
    agent: {
      model: structuredClone(collaboration.roles.planner.model),
      prompt: { version: "collaboration-fixture", sha256: "b".repeat(64) },
      tokens: emptyLedger(),
      collaboration,
      metadata: {
        goal: "test",
        constraints: [],
        budget: { ...DEFAULT_BUDGET },
        remaining: {
          model_attempts: 12,
          executions: 8,
          tokens: 100000,
          task_ms: 300000,
        },
        executions: 0,
        termination: null,
        final_result: null,
        trace_bytes: 0,
        trace_incomplete: false,
      },
    },
  });
}
