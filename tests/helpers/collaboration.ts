import { DEFAULT_BUDGET } from "../../src/agent/config";
import {
  type CollaborationRecord,
  emptyLedger,
} from "../../src/records/agent-metadata";
import { RunRecorder } from "../../src/records/store";
import { profile } from "./agent";

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
