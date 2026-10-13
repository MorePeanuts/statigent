import { keys, obj, str, strings } from "../models/validation";
import { modelingTools } from "./actions";
import { identifier, short } from "./candidates";
import type { ModelingMethod } from "./config";
import type { AnalysisRecord } from "./eda";
import type { KnowledgeRevision, KnowledgeSource } from "./knowledge";
import { KNOWLEDGE_STATUSES } from "./knowledge";
import type { Protocol } from "./protocol";

export const DECISION_INTERFACE = "modeling-decision-v1";
export const CORRECTION_POLICY = "consecutive-unproductive-v1";

/** The model chooses meanings and references; protocol-3 storage is an internal API. */
export function decisionTools(protocol: Protocol, method: ModelingMethod) {
  const tools = modelingTools(protocol, method);
  if (method !== "collaborative") return tools;
  const text = { type: "string", minLength: 1 };
  const refs = {
    type: "array",
    maxItems: 64,
    items: {
      anyOf: [
        text,
        {
          type: "object",
          properties: { id: text, revision: { type: "integer", minimum: 1 } },
          required: ["id", "revision"],
          additionalProperties: false,
        },
      ],
    },
    description:
      "Knowledge IDs resolve to this decision's new revision, otherwise the current revision. Use {id,revision} only to select an older version explicitly.",
  };
  return tools.map((tool) => {
    const parameters = structuredClone(tool.function.parameters);
    const properties = obj(parameters.properties);
    properties.knowledge_refs = refs;
    properties.knowledge_updates = {
      type: "array",
      maxItems: 64,
      description:
        "Optional changes in understanding. Keep the same id to revise a judgment. Host maintains revisions. Omit when nothing changed; do not manufacture observations to fill a form.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "statement", "reason"],
        properties: {
          id: text,
          kind: { enum: Object.keys(KNOWLEDGE_STATUSES) },
          statement: text,
          reason: text,
          status: {
            enum: [...new Set(Object.values(KNOWLEDGE_STATUSES).flat())],
            description:
              "Optional: new observations default active; new hypotheses/questions default open; revisions retain their prior status. Change a judgment explicitly when warranted.",
          },
          sources: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["source_id"],
              properties: {
                source_id: {
                  ...text,
                  description:
                    "Copy a finding source_id, use profile:/<JSON pointer> (e.g. profile:/rows), or experiment:<actual ID>:score/failure. Host binds exact hashes and evidence IDs.",
                },
                applicability: {
                  ...text,
                  description:
                    "Required for analysis findings: explain relevance to the current decision.",
                },
              },
              anyOf: [
                { properties: { source_id: { pattern: "^profile:/" } } },
                {
                  properties: {
                    source_id: {
                      pattern:
                        "^experiment:[A-Za-z0-9_-]{1,128}:(score|failure)$",
                    },
                  },
                },
                {
                  properties: {
                    source_id: {
                      pattern:
                        "^analysis:[A-Za-z0-9_-]{1,128}:(0|[1-9][0-9]*)$",
                    },
                  },
                  required: ["applicability"],
                },
              ],
            },
          },
          candidate_ids: { type: "array", maxItems: 64, items: text },
        },
        anyOf: Object.entries(KNOWLEDGE_STATUSES).map(([kind, statuses]) => ({
          properties: {
            kind: { const: kind },
            status: { enum: statuses },
            ...(kind === "observation" ? { sources: { minItems: 1 } } : {}),
          },
          ...(kind === "observation" ? { required: ["sources"] } : {}),
        })),
      },
    };
    const candidateItems = obj(obj(properties.candidate_updates).items);
    if (Array.isArray(candidateItems.anyOf))
      for (const branch of candidateItems.anyOf) {
        const item = obj(branch);
        obj(item.properties).knowledge_refs = refs;
        item.required = strings(
          item.required,
          "candidate required fields",
        ).filter((key) => key !== "knowledge_refs");
      }
    parameters.required = parameters.required.filter(
      (key) => !["knowledge_updates", "knowledge_refs"].includes(key),
    );
    return { ...tool, function: { ...tool.function, parameters } };
  });
}

export interface DecisionContext {
  profile_sha256: string;
  knowledge: readonly KnowledgeRevision[];
  analyses: readonly Pick<
    AnalysisRecord,
    "id" | "status" | "source_sha256" | "analysis"
  >[];
}

/** Only identifiers are expanded here. All scientific claims and provenance still
 * pass the ordinary protocol-3 validators before anything can be committed. */
export function compileDecision(
  args: string,
  context: DecisionContext,
): string {
  const x = obj(JSON.parse(args));
  const revisions = new Map(context.knowledge.map((k) => [k.id, k.revision]));
  if (x.knowledge_updates !== undefined) {
    if (!Array.isArray(x.knowledge_updates) || x.knowledge_updates.length > 64)
      throw new Error("Invalid knowledge updates");
    x.knowledge_updates = x.knowledge_updates.map((value: unknown) => {
      const update = obj(value);
      const id = identifier(update.id);
      const previous = [...context.knowledge]
        .reverse()
        .find((k) => k.id === id);
      // Explicit protocol-3 operations remain available to programmatic callers;
      // never repair an explicit stale revision or invalid status silently.
      const inferred =
        update.op === undefined && update.base_revision === undefined;
      const expanded = {
        ...update,
        ...(inferred
          ? {
              op: previous ? "revise" : "create",
              base_revision: previous?.revision ?? null,
            }
          : {}),
        status:
          update.status === undefined
            ? (previous?.status ??
              (update.kind === "observation" ? "active" : "open"))
            : update.status,
        sources: expandSources(
          update.sources === undefined ? [] : update.sources,
          context,
        ),
        candidate_ids:
          update.candidate_ids === undefined ? [] : update.candidate_ids,
      };
      revisions.set(id, (previous?.revision ?? 0) + 1);
      return expanded;
    });
  }
  const refs = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 64)
      throw new Error("Invalid knowledge references");
    return value.map((ref: unknown) => {
      if (typeof ref !== "string") return ref;
      const id = identifier(ref),
        revision = revisions.get(id);
      if (!revision) throw new Error(`Unknown knowledge ID: ${id}`);
      return { id, revision };
    });
  };
  if (x.knowledge_refs !== undefined) x.knowledge_refs = refs(x.knowledge_refs);
  if (Array.isArray(x.candidate_updates))
    x.candidate_updates = x.candidate_updates.map((value: unknown) => {
      const candidate = obj(value);
      return candidate.knowledge_refs === undefined
        ? candidate
        : {
            ...candidate,
            knowledge_refs: refs(candidate.knowledge_refs),
          };
    });
  return JSON.stringify(x);
}

function expandSources(value: unknown, context: DecisionContext): unknown[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Invalid knowledge sources");
  return value.map((value: unknown): unknown => {
    const source = obj(value);
    if (source.source_id === undefined) return source;
    keys(source, ["source_id", "applicability"]);
    const id = str(source.source_id, "source ID");
    if (id.startsWith("profile:/"))
      return {
        kind: "profile",
        profile_sha256: context.profile_sha256,
        path: id.slice("profile:".length),
      } satisfies KnowledgeSource;
    const experiment =
      /^experiment:([A-Za-z0-9_-]{1,128}):(score|failure)$/.exec(id);
    if (experiment)
      return {
        kind: "experiment",
        experiment_id: experiment[1],
        fact: experiment[2],
      };
    const match = /^analysis:([A-Za-z0-9_-]{1,128}):(0|[1-9][0-9]*)$/.exec(id);
    const analysis = match
      ? context.analyses.find((a) => a.id === match[1])
      : undefined;
    const index = Number(match?.[2]);
    const finding = analysis?.analysis?.findings[index];
    if (
      !analysis ||
      analysis.status !== "completed" ||
      !analysis.source_sha256 ||
      !finding
    )
      throw new Error(
        `Unknown or unavailable source ID: ${id}; use a published finding source_id, profile:/rows, or an actual experiment:<id>:score/failure`,
      );
    return {
      kind: "analysis",
      analysis_id: analysis.id,
      finding: index,
      evidence_refs: [...finding.evidence_refs],
      source_sha256: analysis.source_sha256,
      applicability: short(source.applicability, "finding applicability"),
    } satisfies KnowledgeSource;
  });
}

export function findingSources(a: DecisionContext["analyses"][number]) {
  if (a.status !== "completed" || !a.analysis || !a.source_sha256) return [];
  return a.analysis.findings.map((finding, index) => ({
    source_id: `analysis:${a.id}:${index}`,
    statement: finding.statement,
  }));
}
