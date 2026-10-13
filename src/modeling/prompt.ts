import { sha256 } from "../records/store";
import type { CandidateState } from "./candidates";
import {
  type KnowledgeRef,
  type KnowledgeRevision,
  requireKnowledge,
} from "./knowledge";
export const CONTEXT_LIMITS = {
  knowledge_entries: 24,
  knowledge_bytes: 65536,
  analysis_bytes: 131072,
  state_bytes: 262144,
} as const;
export function knowledgeView(
  history: readonly KnowledgeRevision[],
  refs: readonly KnowledgeRef[] = [],
  candidates: readonly CandidateState[] = [],
  bestCandidate?: string,
) {
  const selected: KnowledgeRevision[] = [],
    seen = new Set<string>();
  const key = (x: KnowledgeRef) => `${x.id}:${x.revision}`;
  const add = (x: KnowledgeRevision) => {
    if (!seen.has(key(x))) {
      selected.push(x);
      seen.add(key(x));
    }
  };
  for (const ref of refs) add(requireKnowledge(history, ref));
  const pack = () => ({
    entries: selected,
    omitted: history
      .filter((x) => !seen.has(key(x)))
      .map((x) => ({ id: x.id, revision: x.revision })),
  });
  if (
    selected.length > CONTEXT_LIMITS.knowledge_entries ||
    Buffer.byteLength(JSON.stringify(pack())) > CONTEXT_LIMITS.knowledge_bytes
  )
    throw new Error("Explicit knowledge context limit");
  const preferred = (
    candidates.find((c) => c.id === bestCandidate)?.knowledge_refs ?? []
  ).map((ref) => requireKnowledge(history, ref));
  const latest = [...new Map(history.map((x) => [x.id, x])).values()];
  const ordered = [
    ...preferred,
    ...latest.filter((x) => x.kind === "question" && x.status === "open"),
    ...latest.reverse(),
  ];
  for (const entry of ordered) {
    if (seen.has(key(entry))) continue;
    add(entry);
    if (
      selected.length > CONTEXT_LIMITS.knowledge_entries ||
      Buffer.byteLength(JSON.stringify(pack())) > CONTEXT_LIMITS.knowledge_bytes
    ) {
      selected.pop();
      seen.delete(key(entry));
    }
  }
  return pack();
}
export function analysisContext(o: {
  question: string;
  candidates: CandidateState[];
  history: KnowledgeRevision[];
  refs: KnowledgeRef[];
  bestCandidate?: string;
}) {
  const refs = [...o.refs];
  for (const candidate of o.candidates)
    for (const ref of candidate.knowledge_refs ?? [])
      if (!refs.some((r) => r.id === ref.id && r.revision === ref.revision))
        refs.push(ref);
  const context = {
    version: 1,
    limits: CONTEXT_LIMITS,
    question: o.question,
    candidates: o.candidates,
    knowledge: knowledgeView(o.history, refs, o.candidates, o.bestCandidate),
    historical_evidence:
      "Entries retain original sources and are not evidence of this analysis execution.",
  };
  if (
    Buffer.byteLength(JSON.stringify(context)) > CONTEXT_LIMITS.analysis_bytes
  )
    throw new Error("Analysis context limit");
  return context;
}
export function contextIdentity(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { sha256: sha256(bytes), bytes: bytes.length };
}
