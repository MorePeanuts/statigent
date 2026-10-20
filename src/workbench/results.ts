import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { ArtifactReference, Manifest } from "../records/store";
import { resultFilePaths, runManifest } from "./artifacts";
import { readNewEvents } from "./events";
import { HttpError } from "./http";
import { type RunSource, readRun, type StatusView } from "./runs";

// What a finished (or unfinished) run delivered, assembled from its own records. A run that did
// not complete never presents its partial analysis as an accepted result.

const analysisSchema = z
  .object({
    summary: z.string(),
    findings: z.array(
      z
        .object({
          statement: z.string(),
          value: z.unknown().optional(),
          evidence_refs: z.array(z.string()),
        })
        .loose(),
    ),
    methods: z.array(z.string()),
    limitations: z.array(z.string()),
    report: z
      .object({
        artifact_id: z.string(),
        source_path: z.string(),
        images: z.array(
          z.object({
            reference: z.string(),
            path: z.string(),
            artifact_id: z.string(),
          }),
        ),
      })
      .nullish(),
  })
  .loose();

export interface EvidenceView {
  ref: string;
  kind: "execution" | "artifact" | "unknown";
  execution_seq: number | null;
  execution_status: string | null;
  role: string | null;
  artifact: {
    artifact_id: string;
    mime_type: string;
    source_path: string | null;
  } | null;
}

export interface ResultSummary {
  run_id: string;
  status: StatusView;
  termination: string | null;
  /** True only for a completed run with an accepted final analysis. */
  complete: boolean;
  notice: string | null;
  analysis: {
    summary: string;
    findings: {
      statement: string;
      value: unknown;
      evidence: EvidenceView[];
    }[];
    methods: string[];
    limitations: string[];
  } | null;
  report: {
    artifact_id: string;
    source_path: string;
    images: { reference: string; path: string; artifact_id: string }[];
  } | null;
  files: { path: string; kind: string; available: boolean }[];
  export: { status: string; kind: string | null; error: string | null };
  replay: { eligible: boolean; reasons: string[] } | null;
  inputs: { path: string; sha256: string; size_bytes: number }[];
  cost: {
    total_tokens: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    tokens_known: boolean;
    model_attempts: number | null;
    executions: number | null;
    wall_ms: number | null;
  };
}

interface ExecutionFacts {
  seq: number | null;
  status: string | null;
  role: string | null;
}

async function executionFacts(
  directory: string,
): Promise<Map<string, ExecutionFacts>> {
  const { events } = await readNewEvents(join(directory, "events.jsonl"), {
    offset: 0,
    seq: 0,
  });
  const facts = new Map<string, ExecutionFacts>();
  for (const event of events) {
    if (!event.execution_id) continue;
    const known = facts.get(event.execution_id) ?? {
      seq: null,
      status: null,
      role: null,
    };
    if (event.kind === "code")
      facts.set(event.execution_id, {
        ...known,
        seq:
          typeof event.data.execution_seq === "number"
            ? event.data.execution_seq
            : null,
        role: event.role,
      });
    if (event.kind === "result")
      facts.set(event.execution_id, {
        ...known,
        status:
          typeof event.data.status === "string" ? event.data.status : null,
      });
  }
  return facts;
}

function fileKind(path: string): string {
  if (path === "analysis.json") return "analysis_json";
  if (path === "analysis.md") return "analysis_markdown";
  if (path.endsWith(".ipynb")) return "notebook";
  if (path.endsWith(".py")) return "script";
  return "export_manifest";
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function notice(
  status: StatusView,
  termination: string | null,
  hasAnalysis: boolean,
): string | null {
  if (["starting", "running", "finalizing"].includes(status.status))
    return "The run is still in progress; no final result yet";
  if (status.status === "completed")
    return hasAnalysis
      ? null
      : "The run completed without an accepted final result";
  const ending = `the run ended as ${status.status}${termination ? ` (${termination})` : ""}`;
  return hasAnalysis
    ? `An analysis was submitted, but ${ending}; treat it as incomplete`
    : `No accepted final result: ${ending}`;
}

export async function resultSummary(
  source: RunSource,
  runId: string,
): Promise<ResultSummary> {
  const run = await readRun(source, runId);
  if (!run) throw new HttpError("Run not found", 404);
  const status: StatusView = {
    status: run.status,
    detail: run.detail,
    cancellable: run.cancellable,
  };
  let directory: string | null = null;
  let manifest: Manifest | null = null;
  try {
    ({ directory, manifest } = await runManifest(source.runsRoot, runId));
  } catch (error) {
    // A worker that failed before creating its record still has a status, just no results.
    if (!(error instanceof HttpError && error.status === 404)) throw error;
  }
  const agent =
    manifest?.agent && manifest.agent !== "not_applicable"
      ? manifest.agent
      : null;
  const tokens =
    manifest?.tokens && manifest.tokens !== "not_applicable"
      ? manifest.tokens
      : null;
  const termination = agent?.termination ?? null;

  let analysis: ResultSummary["analysis"] = null;
  let report: ResultSummary["report"] = null;
  if (directory && (await exists(join(directory, "analysis.json")))) {
    const parsed = analysisSchema.parse(
      JSON.parse(await readFile(join(directory, "analysis.json"), "utf8")),
    );
    const facts = await executionFacts(directory);
    const artifacts = new Map(
      ((manifest?.artifacts ?? []) as ArtifactReference[]).map((a) => [
        a.artifact_id,
        a,
      ]),
    );
    const evidence = (ref: string): EvidenceView => {
      const execution = facts.get(ref);
      const artifact = artifacts.get(ref);
      return {
        ref,
        kind: execution ? "execution" : artifact ? "artifact" : "unknown",
        execution_seq: execution?.seq ?? null,
        execution_status: execution?.status ?? null,
        role: execution?.role ?? null,
        artifact: artifact
          ? {
              artifact_id: artifact.artifact_id,
              mime_type: artifact.mime_type,
              source_path: artifact.source_path ?? null,
            }
          : null,
      };
    };
    analysis = {
      summary: parsed.summary,
      findings: parsed.findings.map((finding) => ({
        statement: finding.statement,
        value: finding.value ?? null,
        evidence: finding.evidence_refs.map(evidence),
      })),
      methods: parsed.methods,
      limitations: parsed.limitations,
    };
    report = parsed.report ?? null;
  }

  const files = manifest
    ? await Promise.all(
        resultFilePaths(manifest).map(async (path) => ({
          path,
          kind: fileKind(path),
          // Run record paths are runtime data; keep them out of build output tracing.
          available: directory
            ? await exists(join(/*turbopackIgnore: true*/ directory, path))
            : false,
        })),
      )
    : [];
  return {
    run_id: runId,
    status,
    termination,
    complete: status.status === "completed" && analysis !== null,
    notice: notice(status, termination, analysis !== null),
    analysis,
    report,
    files,
    export: {
      status: manifest?.export.status ?? "not_available",
      kind: manifest?.export.kind ?? null,
      error: manifest?.export.error ?? null,
    },
    replay: manifest
      ? { eligible: manifest.replay.eligible, reasons: manifest.replay.reasons }
      : null,
    inputs: (manifest?.inputs ?? []).map((input) => ({
      path: input.path,
      sha256: input.sha256,
      size_bytes: input.size_bytes,
    })),
    cost: {
      total_tokens: tokens?.total_tokens ?? null,
      input_tokens: tokens?.input_tokens ?? null,
      output_tokens: tokens?.output_tokens ?? null,
      tokens_known: tokens?.status === "known",
      model_attempts: tokens?.attempts ?? null,
      executions: agent?.executions ?? null,
      wall_ms: manifest?.timing.wall_ms ?? null,
    },
  };
}
