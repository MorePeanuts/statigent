import { keys, obj, str, strings } from "../models/validation";
import {
  type CandidateUpdate,
  type EvidenceUse,
  identifier,
  parseCandidateUpdates,
  parseEvidence,
  short,
  source,
} from "./candidates";
import type { ModelingMethod } from "./config";
import {
  KNOWLEDGE_STATUSES,
  type KnowledgeRef,
  type KnowledgeUpdate,
  parseKnowledgeRefs,
  parseKnowledgeUpdates,
} from "./knowledge";
import { MODELING_PROMPT as LEGACY_PROMPT } from "./legacy-actions";
import type { Protocol } from "./protocol";

export type { EvidenceUse } from "./candidates";
export { identifier } from "./candidates";
export type ModelingAction = (
  | {
      kind: "train";
      candidate_id: string;
      change: string;
      reason: string;
      source_experiment: string | null;
      repair_of_experiment: string | null;
      evidence: EvidenceUse[];
      code: string;
    }
  | {
      kind: "analyze";
      purpose: "explore" | "diagnose" | "compare";
      candidates: string[];
      question: string;
      expected_evidence: string;
      source_experiments: string[];
    }
  | { kind: "finish"; experiment_id: string; reason: string }
) & {
  candidate_updates: CandidateUpdate[];
  knowledge_updates?: KnowledgeUpdate[];
  knowledge_refs?: KnowledgeRef[];
};
const text = { type: "string", minLength: 1 };
const nullable = { type: ["string", "null"] };
const positive = { type: "integer", minimum: 1 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (items: unknown, maxItems = 64) => ({
  type: "array",
  items,
  maxItems,
});
const refs = array(object({ id: text, revision: positive }));
const evidence = array(
  object({
    analysis_id: text,
    source_experiment: nullable,
    refs: { ...array(text, 32), minItems: 1 },
    applicability: text,
  }),
  32,
);
const sources = array(
  {
    anyOf: [
      object({
        kind: { const: "profile" },
        profile_sha256: text,
        path: {
          ...text,
          pattern: "^/",
          description:
            "JSON pointer relative to basic_profile, e.g. /rows or /columns/0/missing. Use the actual basic_profile_sha256. Not a filename and not basic_profile itself.",
        },
      }),
      object({
        kind: { const: "analysis" },
        analysis_id: text,
        finding: { type: "integer", minimum: 0 },
        evidence_refs: {
          ...array(text, 32),
          minItems: 1,
          description:
            "Use only IDs belonging to this exact zero-based finding index; never combine refs from different findings in one source. Copy a provided knowledge_source_hint when applicable.",
        },
        source_sha256: text,
        applicability: text,
      }),
      object({
        kind: { const: "experiment" },
        experiment_id: text,
        fact: { enum: ["score", "failure"] },
      }),
    ],
  },
  32,
);
const knowledgeUpdates = array({
  ...object({
    op: { enum: ["create", "revise"] },
    id: text,
    kind: { enum: ["observation", "hypothesis", "question"] },
    base_revision: {
      type: ["integer", "null"],
      minimum: 1,
      description:
        "create requires null; revise requires the exact existing revision.",
    },
    statement: text,
    status: {
      enum: [...new Set(Object.values(KNOWLEDGE_STATUSES).flat())],
      description:
        "observation: active/withdrawn; hypothesis: open/supported/challenged/withdrawn; question: open/resolved/withdrawn. supported requires a successful experiment score source.",
    },
    reason: text,
    sources,
    candidate_ids: array(text),
  }),
  anyOf: Object.entries(KNOWLEDGE_STATUSES).map(([kind, statuses]) => ({
    properties: {
      kind: { const: kind },
      status: { enum: statuses },
      ...(kind === "observation" ? { sources: { minItems: 1 } } : {}),
    },
  })),
  description:
    "Optional knowledge changes: [] is valid. An observation must have a real source; hypotheses and questions start open and may have no source. Invalid updates reject the whole action.",
});
function candidateUpdates(knowledge: boolean) {
  const fields = {
    reason: text,
    evidence,
    ...(knowledge ? { knowledge_refs: refs } : {}),
  };
  return array({
    anyOf: [
      object({
        op: { const: "create" },
        id: text,
        hypothesis: text,
        change: text,
        priority: positive,
        ...fields,
      }),
      object({
        op: { const: "update" },
        id: text,
        priority: { type: ["integer", "null"], minimum: 1 },
        disposition: { enum: ["keep", "defer", "resume"] },
        ...fields,
      }),
    ],
  });
}
export function modelingTools(
  protocol: Protocol,
  method: ModelingMethod = "adaptive_eda",
) {
  const knowledge = method === "collaborative";
  const shared = {
    candidate_updates: candidateUpdates(knowledge),
    ...(knowledge
      ? { knowledge_updates: knowledgeUpdates, knowledge_refs: refs }
      : {}),
  };
  const definitions = [
    {
      name: "run_experiment",
      description:
        "Fit and evaluate one complete pipeline. The host computes the frozen metric; explain the change and use existing evidence only when applicable.",
      properties: {
        ...shared,
        candidate_id: text,
        change: text,
        reason: text,
        source_experiment: nullable,
        repair_of_experiment: nullable,
        evidence,
        code: text,
      },
    },
    ...(method === "adaptive_eda" || knowledge
      ? [
          {
            name: "analyze",
            description:
              "Explore a focused data question without a prior model, diagnose one successful search experiment, or compare two successful search experiments. The host allocates resources.",
            properties: {
              ...shared,
              purpose: { enum: ["explore", "diagnose", "compare"] },
              candidates: array(text),
              question: text,
              expected_evidence: text,
              source_experiments: array(text, 2),
            },
          },
        ]
      : []),
    {
      name: "finish_modeling",
      description:
        "Freeze search using the current search best ID. The host performs configured terminal confirmation and final delivery; confirmation may select a different pipeline. No further model calls.",
      properties: { ...shared, experiment_id: text, reason: text },
    },
  ];
  return definitions.map((d) => ({
    type: "function",
    function: {
      name: d.name,
      description: `${d.description} Frozen task: ${protocol.kind}; ${protocol.direction} ${protocol.metric}; output ${protocol.output}.`,
      parameters: object(d.properties),
    },
  }));
}
export function action(
  name: string,
  args: string,
  codeLimit: number,
  maxCandidates: number,
  method: ModelingMethod = "adaptive_eda",
): ModelingAction {
  const x = obj(JSON.parse(args));
  const knowledge = method === "collaborative";
  const commonKeys = [
    "candidate_updates",
    ...(knowledge ? ["knowledge_updates", "knowledge_refs"] : []),
  ];
  const shared = {
    candidate_updates: parseCandidateUpdates(
      x.candidate_updates,
      maxCandidates,
      knowledge,
    ),
    ...(knowledge
      ? {
          knowledge_updates: parseKnowledgeUpdates(x.knowledge_updates ?? []),
          knowledge_refs: parseKnowledgeRefs(x.knowledge_refs ?? []),
        }
      : {}),
  };
  if (name === "finish_modeling") {
    keys(x, [...commonKeys, "experiment_id", "reason"]);
    return {
      kind: "finish",
      ...shared,
      experiment_id: identifier(x.experiment_id),
      reason: short(x.reason, "reason"),
    };
  }
  if (name === "analyze") {
    if (method !== "adaptive_eda" && !knowledge)
      throw new Error("Analysis is disabled for this method");
    keys(x, [
      ...commonKeys,
      "purpose",
      "candidates",
      "question",
      "expected_evidence",
      "source_experiments",
    ]);
    const candidates = strings(x.candidates, "candidates").map(identifier),
      experiments = strings(x.source_experiments, "source experiments").map(
        identifier,
      );
    if (
      candidates.length > maxCandidates ||
      new Set(candidates).size !== candidates.length
    )
      throw new Error("Invalid candidate count/identity");
    if (
      x.purpose !== "explore" &&
      x.purpose !== "diagnose" &&
      x.purpose !== "compare"
    )
      throw new Error("Invalid analysis purpose");
    if (
      experiments.length !==
        { explore: 0, diagnose: 1, compare: 2 }[x.purpose] ||
      new Set(experiments).size !== experiments.length
    )
      throw new Error("Invalid analysis source count/identity");
    return {
      kind: "analyze",
      ...shared,
      purpose: x.purpose,
      candidates,
      question: short(x.question, "question"),
      expected_evidence: short(x.expected_evidence, "expected evidence"),
      source_experiments: experiments,
    };
  }
  if (name !== "run_experiment") throw new Error("Unknown modeling action");
  keys(x, [
    ...commonKeys,
    "candidate_id",
    "change",
    "reason",
    "source_experiment",
    "repair_of_experiment",
    "evidence",
    "code",
  ]);
  const code = str(x.code, "code");
  if (Buffer.byteLength(code) > codeLimit)
    throw new Error("Code limit exceeded");
  return {
    kind: "train",
    ...shared,
    candidate_id: identifier(x.candidate_id),
    change: short(x.change, "change"),
    reason: short(x.reason, "reason"),
    source_experiment: source(x.source_experiment),
    repair_of_experiment: source(x.repair_of_experiment),
    evidence: parseEvidence(x.evidence),
    code,
  };
}
export const MODELING_PROMPT_VERSION = "modeling-v5";
// Keep the existing runner contract verbatim; method guidance is independently versioned below.
const runnerContract = LEGACY_PROMPT.split("\n").slice(0, 2).join("\n");
export function modelingPrompt(method: ModelingMethod) {
  return `${runnerContract}
Optimize predictive quality with reliable evaluation and reproducible delivery. You may explore data before proposing candidates, train directly, diagnose one model or compare two. Use analysis when it can inform the next decision; consecutive analyses, direct training, deferring or rejecting a finding are legitimate. No mandatory EDA count or order. The host allocates resources and reserves closing time; do not request quotas. Explain each choice using the actual evidence available. Do not claim an improvement without the host's scores.
Maintain stable candidates through candidate_updates (empty when unchanged): create {op:"create",id,hypothesis,change,priority,reason,evidence:[]}; update {op:"update",id,priority:null,disposition:"keep"|"defer"|"resume",reason,evidence:[]}. A new direction gets a new candidate ID. Failed code can be repaired under the same candidate; repair_of_experiment must identify its confirmed failed search trial. Resume a deferred candidate before using it. Priority is advice, not a scheduling requirement. The host owns revisions and experiment identities. Cite EDA evidence using its original analysis and source experiment plus applicability; do not relabel historical model evidence. You may choose older evidence or no analysis evidence when that is justified.
Use the current search best_experiment_id in finish_modeling and explain why further search is unnecessary. Acceptance freezes search. Configured terminal confirmation uses two additional training-internal splits to choose among up to two different pipelines; it may select another pipeline. This is adaptive internal resampling, not independent generalization evidence. No model calls follow acceptance. All phases share the recorded budget.
Method: ${method}. ${method === "collaborative" ? "Maintain task-local observations, hypotheses and questions with knowledge_updates (create/revise, exact base_revision; [] is valid). For create use base_revision:null; for revise use the exact existing revision. Valid status by kind: observation=active|withdrawn; hypothesis=open|supported|challenged|withdrawn; question=open|resolved|withdrawn. Never set a hypothesis to active. Observations require real sources; optional unsupported observations should be omitted. Profile sources use the actual basic_profile_sha256 and a JSON pointer relative to the profile object, e.g. /rows, /column_count, /columns/0/missing; do not prepend basic_profile. Analysis sources must cite only evidence_refs belonging to their exact finding index; use knowledge_source_hints and explain applicability. Hypotheses are judgments, not facts: use open until a successful experiment score source supports the claim. Failed code is evidence of execution failure, not automatic statistical refutation. Preserve observations while revising explanations. Link candidates and actions via knowledge_refs {id,revision}; use exact revisions and original sources. Updates and action commit atomically. Do not invent host scores or acceptance sequence." : "Use the normal task, candidate, report and experiment history. Do not submit knowledge_updates or knowledge_refs."}`;
}
export const MODELING_PROMPT = modelingPrompt("adaptive_eda");
