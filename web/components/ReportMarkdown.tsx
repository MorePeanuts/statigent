import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ResultSummary } from "../lib/api";
import { artifactText, artifactUrl } from "../lib/api";
import styles from "./Result.module.css";

type Report = NonNullable<ResultSummary["report"]>;

function normalize(path: string): string {
  return path.replace(/^\.\//, "");
}

/**
 * Renders the run's report without trusting it: raw HTML is dropped, images resolve only to
 * artifacts the run registered for this report, and links are limited to http(s) and open
 * without a referrer. Nothing in the report can make the browser fetch a remote resource.
 */
export function ReportMarkdown({
  runId,
  report,
}: {
  runId: string;
  report: Report;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    artifactText(runId, report.artifact_id)
      .then(setMarkdown)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "读取报告失败"),
      );
  }, [runId, report.artifact_id]);

  const images = new Map<string, string>();
  for (const image of report.images) {
    images.set(normalize(image.reference), image.artifact_id);
    images.set(normalize(image.path), image.artifact_id);
  }

  const transform = (url: string, key: string): string | null => {
    if (key === "src") {
      const artifactId = images.get(normalize(url));
      return artifactId ? artifactUrl(runId, artifactId) : null;
    }
    if (key === "href") return /^https?:\/\//i.test(url) ? url : null;
    return null;
  };

  const components: Components = {
    img: ({ src, alt }) =>
      typeof src === "string" && src ? (
        // biome-ignore lint/performance/noImgElement: report figures are run artifacts served by the local API
        <img src={src} alt={alt ?? ""} className={styles.reportImage} />
      ) : (
        <span className={styles.dropped}>
          ［图片未登记为本次运行的产物，已忽略：{alt || "无说明"}］
        </span>
      ),
    a: ({ href, children }) =>
      href ? (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      ),
  };

  if (error) return <div className="alert alert-error">{error}</div>;
  if (markdown === null) return <p className="muted">加载报告…</p>;
  return (
    <div className={styles.report}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={transform}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
