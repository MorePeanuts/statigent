import type { ResultSummary } from "../lib/api";
import { fileUrl } from "../lib/api";
import { formatBytes, formatDuration, formatNumber } from "../lib/format";
import styles from "./Result.module.css";

const FILE_LABELS: Record<string, string> = {
  analysis_json: "结构化结论 analysis.json",
  analysis_markdown: "结论文本 analysis.md",
  notebook: "Notebook",
  script: "脚本",
  export_manifest: "导出清单",
};

const EXPORT_LABELS: Record<string, string> = {
  exported: "已导出",
  not_requested: "未导出",
  failed: "导出失败",
  not_available: "无运行记录",
};

export function FilesTab({
  runId,
  result,
}: {
  runId: string;
  result: ResultSummary | null;
}) {
  if (!result) return <p className="muted">加载中…</p>;
  const { cost } = result;
  return (
    <div className={styles.result}>
      <section className="panel">
        <h2>结果文件</h2>
        <p className="muted">
          导出：{EXPORT_LABELS[result.export.status] ?? result.export.status}
          {result.export.kind === "scripts" ? "（独立脚本）" : ""}
          {result.export.error ? ` · ${result.export.error}` : ""}
          {result.replay &&
            ` · 重放资格：${result.replay.eligible ? "符合" : `不符合（${result.replay.reasons.join("、") || "未说明"}）`}`}
        </p>
        {result.files.length === 0 ? (
          <p className="muted">没有可下载的文件。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>路径</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.files.map((file) => (
                <tr key={file.path}>
                  <td>{FILE_LABELS[file.kind] ?? file.kind}</td>
                  <td>
                    <code>{file.path}</code>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {file.available ? (
                      <>
                        <a
                          href={fileUrl(runId, file.path)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看
                        </a>
                        {" · "}
                        <a href={fileUrl(runId, file.path, true)}>下载</a>
                      </>
                    ) : (
                      <span className="muted">未生成</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>成本</h2>
        <dl className={styles.costGrid}>
          <dt>总 token</dt>
          <dd>
            {formatNumber(cost.total_tokens)}
            {!cost.tokens_known && cost.total_tokens !== null && (
              <span className="muted">（部分用量未知）</span>
            )}
          </dd>
          <dt>输入 / 输出 token</dt>
          <dd>
            {formatNumber(cost.input_tokens)} /{" "}
            {formatNumber(cost.output_tokens)}
          </dd>
          <dt>模型调用次数</dt>
          <dd>{formatNumber(cost.model_attempts)}</dd>
          <dt>代码执行次数</dt>
          <dd>{formatNumber(cost.executions)}</dd>
          <dt>总耗时</dt>
          <dd>{formatDuration(cost.wall_ms)}</dd>
        </dl>
        <p className="muted">金额未计算；按所用模型的计价自行换算。</p>
      </section>

      <section className="panel">
        <h2>输入数据</h2>
        {result.inputs.length === 0 ? (
          <p className="muted">没有记录输入文件。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>文件</th>
                <th>大小</th>
                <th>sha256</th>
              </tr>
            </thead>
            <tbody>
              {result.inputs.map((input) => (
                <tr key={input.path}>
                  <td>{input.path}</td>
                  <td>{formatBytes(input.size_bytes)}</td>
                  <td>
                    <code title={input.sha256}>
                      {input.sha256.slice(0, 16)}…
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
