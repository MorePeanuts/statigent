import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import {
  ApiError,
  api,
  type FieldIssue,
  type ModelOption,
  type PreflightProblem,
} from "../lib/api";
import { BACKEND_LABELS, ORGANIZATION_LABELS } from "../lib/format";
import styles from "./Workbench.module.css";

export interface BudgetDefaults {
  model_attempts: number;
  executions: number;
  total_tokens: number;
  task_timeout_ms: number;
}

type Organization = "single" | "planner-executor";
type Backend = "persistent-kernel" | "fresh-script";

const ORGANIZATION_HINTS: Record<Organization, string> = {
  single: "一个智能体直接决定执行代码或提交结论。",
  "planner-executor": "规划者委派子任务，执行者在同一内核中求解并返回结果。",
};
const BACKEND_HINTS: Record<Backend, string> = {
  "persistent-kernel": "增量执行单元，变量在同一内核中保留。",
  "fresh-script": "每次执行完整脚本，新进程，只保留工作区文件。",
};

interface Failure {
  message: string;
  issues: FieldIssue[];
  problems: PreflightProblem[];
  active: string[];
}

function failureFrom(error: unknown): Failure {
  if (!(error instanceof ApiError))
    return {
      message: error instanceof Error ? error.message : "提交失败",
      issues: [],
      problems: [],
      active: [],
    };
  const body = error.body;
  return {
    message: error.message,
    issues: Array.isArray(body.issues) ? (body.issues as FieldIssue[]) : [],
    problems: Array.isArray(body.problems)
      ? (body.problems as PreflightProblem[])
      : [],
    active: Array.isArray(body.active) ? (body.active as string[]) : [],
  };
}

function integerOrUndefined(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

export function NewRunForm({
  defaults,
  inputs,
}: {
  defaults: BudgetDefaults;
  inputs: string[];
}) {
  const router = useRouter();
  const uid = useId();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [model, setModel] = useState("");
  const [organization, setOrganization] = useState<Organization>("single");
  const [backend, setBackend] = useState<Backend>("persistent-kernel");
  const [report, setReport] = useState(false);
  const [attempts, setAttempts] = useState("");
  const [executions, setExecutions] = useState("");
  const [tokens, setTokens] = useState("");
  const [minutes, setMinutes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    api
      .models()
      .then(({ models }) => {
        setModels(models);
        setModel((current) => current || models[0]?.id || "");
      })
      .catch((error: unknown) =>
        setModelsError(error instanceof Error ? error.message : "读取失败"),
      );
  }, []);

  const selectedModel = models.find((m) => m.id === model);
  const issueFor = (...fields: string[]) =>
    failure?.issues
      .filter((issue) =>
        fields.some(
          (f) => issue.field === f || issue.field.startsWith(`${f}.`),
        ),
      )
      .map((issue) => issue.message)
      .join("；");
  const shownFields = [
    "goal",
    "constraints",
    "model_profile",
    "budget",
    "inputs",
    "organization",
    "backend",
  ];
  const otherIssues =
    failure?.issues.filter(
      (issue) =>
        !shownFields.some(
          (f) => issue.field === f || issue.field.startsWith(`${f}.`),
        ),
    ) ?? [];

  async function submit() {
    setSubmitting(true);
    setFailure(null);
    const minutesValue = integerOrUndefined(minutes);
    const budget = Object.fromEntries(
      Object.entries({
        model_attempts: integerOrUndefined(attempts),
        executions: integerOrUndefined(executions),
        total_tokens: integerOrUndefined(tokens),
        task_timeout_ms:
          minutesValue === undefined ? undefined : minutesValue * 60_000,
      }).filter(([, value]) => value !== undefined),
    );
    try {
      const { run_id } = await api.submit({
        agent_type: "eda",
        goal,
        constraints: constraints
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        inputs,
        model_profile: model,
        organization,
        backend,
        budget,
        report,
      });
      router.push(`/runs/${run_id}`);
    } catch (error) {
      setFailure(failureFrom(error));
      setSubmitting(false);
    }
  }

  return (
    <section className="panel" aria-label="新建分析">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <h2>新建分析</h2>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${uid}-goal`}>
            分析目标
          </label>
          <textarea
            id={`${uid}-goal`}
            rows={5}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例如：分析 sales.csv 中各地区销售额的分布与月度趋势，找出异常月份并给出可能原因。"
            aria-invalid={Boolean(issueFor("goal"))}
          />
          {issueFor("goal") && (
            <div className="field-error">{issueFor("goal")}</div>
          )}
        </div>

        <div className={styles.field}>
          <span className={styles.label}>输入文件</span>
          {inputs.length ? (
            <div className={styles.chips}>
              {inputs.map((name) => (
                <span key={name} className={styles.chip}>
                  {name}
                </span>
              ))}
            </div>
          ) : (
            <span className={styles.hint}>
              未选择文件。可在左侧勾选；不选文件时智能体只能回答无需数据的问题。
            </span>
          )}
          {issueFor("inputs") && (
            <div className="field-error">{issueFor("inputs")}</div>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${uid}-constraints`}>
            约束（每行一条，可选）
          </label>
          <textarea
            id={`${uid}-constraints`}
            rows={2}
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            placeholder="只使用提供的数据，不安装依赖、不联网。"
          />
          {issueFor("constraints") && (
            <div className="field-error">{issueFor("constraints")}</div>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${uid}-model`}>
            模型
          </label>
          <select
            id={`${uid}-model`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}（{m.id}）{m.key_present ? "" : " · 未配置密钥"}
              </option>
            ))}
          </select>
          {modelsError && <div className="field-error">{modelsError}</div>}
          {selectedModel && !selectedModel.key_present && (
            <div className={styles.hint}>
              服务端环境中未找到该模型的密钥，提交时会被前置检查拒绝。
            </div>
          )}
          {issueFor("model_profile") && (
            <div className="field-error">{issueFor("model_profile")}</div>
          )}
        </div>

        <div className={styles.field}>
          <span className={styles.label}>智能体组织</span>
          <div className={styles.choices} role="radiogroup">
            {(Object.keys(ORGANIZATION_HINTS) as Organization[]).map(
              (value) => (
                <label
                  key={value}
                  className={`${styles.choice} ${organization === value ? styles.choiceActive : ""}`}
                  title={ORGANIZATION_HINTS[value]}
                >
                  <input
                    type="radio"
                    name="organization"
                    checked={organization === value}
                    onChange={() => setOrganization(value)}
                  />
                  {ORGANIZATION_LABELS[value]}
                </label>
              ),
            )}
          </div>
          <span className={styles.hint}>
            {ORGANIZATION_HINTS[organization]}
          </span>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>执行后端</span>
          <div className={styles.choices} role="radiogroup">
            {(Object.keys(BACKEND_HINTS) as Backend[]).map((value) => (
              <label
                key={value}
                className={`${styles.choice} ${backend === value ? styles.choiceActive : ""}`}
                title={BACKEND_HINTS[value]}
              >
                <input
                  type="radio"
                  name="backend"
                  checked={backend === value}
                  onChange={() => setBackend(value)}
                />
                {BACKEND_LABELS[value]}
              </label>
            ))}
          </div>
          <span className={styles.hint}>{BACKEND_HINTS[backend]}</span>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>预算（留空使用默认值）</span>
          <div className={styles.row}>
            <BudgetInput
              label="模型调用次数"
              value={attempts}
              onChange={setAttempts}
              placeholder={defaults.model_attempts}
              error={issueFor("budget.model_attempts")}
            />
            <BudgetInput
              label="代码执行次数"
              value={executions}
              onChange={setExecutions}
              placeholder={defaults.executions}
              error={issueFor("budget.executions")}
            />
            <BudgetInput
              label="token 上限"
              value={tokens}
              onChange={setTokens}
              placeholder={defaults.total_tokens}
              error={issueFor("budget.total_tokens")}
            />
            <BudgetInput
              label="总时限（分钟）"
              value={minutes}
              onChange={setMinutes}
              placeholder={defaults.task_timeout_ms / 60_000}
              error={issueFor("budget.task_timeout_ms")}
            />
          </div>
          {issueFor("budget") &&
            !issueFor(
              "budget.model_attempts",
              "budget.executions",
              "budget.total_tokens",
              "budget.task_timeout_ms",
            ) && <div className="field-error">{issueFor("budget")}</div>}
        </div>

        <label className={styles.choice} style={{ alignSelf: "flex-start" }}>
          <input
            type="checkbox"
            checked={report}
            onChange={(e) => setReport(e.target.checked)}
          />
          要求提交含图表的 Markdown 报告
        </label>

        {failure && (
          <FailureNotice failure={failure} otherIssues={otherIssues} />
        )}

        <div className={styles.actions}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !model}
          >
            {submitting ? "正在检查并启动…" : "开始分析"}
          </button>
          <span className={styles.hint}>
            提交前会检查模型密钥与执行镜像；运行在独立进程中进行。
          </span>
        </div>
      </form>
    </section>
  );
}

function BudgetInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: number;
  error?: string;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.hint} htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={props.value}
        placeholder={String(props.placeholder)}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={Boolean(props.error)}
      />
      {props.error && <div className="field-error">{props.error}</div>}
    </div>
  );
}

function FailureNotice({
  failure,
  otherIssues,
}: {
  failure: Failure;
  otherIssues: FieldIssue[];
}) {
  if (failure.problems.length)
    return (
      <div className="alert alert-warn" role="alert">
        <strong>运行前置条件未满足</strong>
        <ul>
          {failure.problems.map((problem) => (
            <li key={problem.code + problem.message}>{problem.message}</li>
          ))}
        </ul>
      </div>
    );
  if (failure.active.length)
    return (
      <div className="alert alert-warn" role="alert">
        已达到同时运行上限。请等待或取消正在进行的运行：
        {failure.active.map((id) => (
          <a key={id} href={`/runs/${id}`} style={{ marginLeft: 8 }}>
            {id.slice(0, 8)}
          </a>
        ))}
      </div>
    );
  // Field issues are shown next to their fields; only the rest is summarised here.
  if (failure.issues.length && !otherIssues.length)
    return (
      <div className="alert alert-error" role="alert">
        请修正上面标出的字段。
      </div>
    );
  return (
    <div className="alert alert-error" role="alert">
      {otherIssues.length
        ? otherIssues.map((issue) => (
            <div key={issue.field + issue.message}>{issue.message}</div>
          ))
        : failure.message}
    </div>
  );
}
