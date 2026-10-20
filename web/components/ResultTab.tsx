import type { ResultSummary } from "../lib/api";
import { artifactUrl } from "../lib/api";
import { ReportMarkdown } from "./ReportMarkdown";
import styles from "./Result.module.css";

type Evidence = NonNullable<
  ResultSummary["analysis"]
>["findings"][number]["evidence"][number];

function EvidenceChip({
  runId,
  evidence,
  onShowExecution,
}: {
  runId: string;
  evidence: Evidence;
  onShowExecution: (executionId: string) => void;
}) {
  if (evidence.kind === "execution")
    return (
      <button
        type="button"
        className={styles.evidence}
        onClick={() => onShowExecution(evidence.ref)}
        title="在轨迹中查看这次执行"
      >
        执行 {evidence.execution_seq ?? "?"}
        {evidence.execution_status && evidence.execution_status !== "ok"
          ? `（${evidence.execution_status}）`
          : ""}
      </button>
    );
  if (evidence.kind === "artifact" && evidence.artifact)
    return (
      <a
        className={styles.evidence}
        href={artifactUrl(runId, evidence.artifact.artifact_id)}
        target="_blank"
        rel="noreferrer"
      >
        {evidence.artifact.source_path ?? "产物"}
      </a>
    );
  return (
    <span
      className={`${styles.evidence} ${styles.unresolved}`}
      title={evidence.ref}
    >
      未解析的引用 {evidence.ref.slice(0, 8)}
    </span>
  );
}

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return <code className={styles.value}>{String(value)}</code>;
  return (
    <pre className={styles.valueBlock}>{JSON.stringify(value, null, 2)}</pre>
  );
}

export function ResultTab({
  runId,
  result,
  onShowExecution,
}: {
  runId: string;
  result: ResultSummary | null;
  onShowExecution: (executionId: string) => void;
}) {
  if (!result) return <p className="muted">加载结果…</p>;
  const { analysis } = result;
  return (
    <div className={styles.result}>
      {result.notice && (
        <div
          className={`alert ${result.status.status === "running" || result.status.status === "starting" ? "alert-info" : "alert-warn"}`}
        >
          {result.notice}
        </div>
      )}
      {!analysis ? (
        <p className="muted">
          没有可展示的分析结论。已完成的轨迹与产物仍可在“轨迹”和“文件与成本”中查看。
        </p>
      ) : (
        <>
          <section className="panel">
            <h2>结论摘要</h2>
            <p className={styles.summary}>{analysis.summary}</p>
          </section>
          <section className="panel">
            <h2>发现（{analysis.findings.length}）</h2>
            <ol className={styles.findings}>
              {analysis.findings.map((finding, i) => (
                <li key={`${i}-${finding.statement.slice(0, 20)}`}>
                  <p>{finding.statement}</p>
                  <Value value={finding.value} />
                  <div className={styles.evidenceRow}>
                    <span className="muted">证据：</span>
                    {finding.evidence.map((evidence) => (
                      <EvidenceChip
                        key={evidence.ref}
                        runId={runId}
                        evidence={evidence}
                        onShowExecution={onShowExecution}
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {result.report && (
            <section className="panel">
              <h2>报告</h2>
              <ReportMarkdown runId={runId} report={result.report} />
            </section>
          )}
          <section className={styles.twoColumns}>
            <div className="panel">
              <h2>方法与口径</h2>
              <ul>
                {analysis.methods.map((method) => (
                  <li key={method}>{method}</li>
                ))}
              </ul>
            </div>
            <div className="panel">
              <h2>局限</h2>
              <ul>
                {analysis.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
