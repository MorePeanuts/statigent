import { expect, test } from "bun:test";
import profiles from "../../configs/models.json";
import { statigentAdapter } from "../../src/evaluation/agents/statigent";
import { validateConfig } from "../../src/evaluation/plan";
import { defaultRegistry } from "../../src/evaluation/registry";
import { reply, ScriptClient } from "../helpers/agent";
import { invocation } from "../helpers/evaluation";

for (const backend of ["persistent-kernel", "fresh-script"])
  for (const organization of ["single", "planner-executor"])
    test(`adapter snapshots ${organization}/${backend} and respects reduced budget`, async () => {
      const adapter = statigentAdapter({
        image: async () => ({
          runtime_labels: { "org.statigent.fresh-script": "2" },
        }),
        overrides: { client: new ScriptClient(() => reply()) },
      });
      const i = invocation("/tmp");
      i.config.options = { image: "test", backend, organization };
      const preflight = await adapter.preflight(i.config);
      expect(preflight.backend).toBe(backend);
      expect(preflight.role).toBe(organization);
      expect(preflight.execution).toMatchObject({
        files_policy: "task-workspace",
        backend,
      });
      if (backend === "fresh-script")
        expect(JSON.stringify(preflight)).toContain("script-init-v1");
      let captured: unknown;
      await expect(
        statigentAdapter({
          run: async (o) => {
            captured = o.task;
            throw Error("captured");
          },
        }).run({
          ...i,
          budget: { timeout_ms: 2000, total_tokens: 70000, model_attempts: 2 },
        }),
      ).rejects.toThrow("captured");
      expect(captured).toMatchObject({
        backend,
        organization,
        budget: {
          task_timeout_ms: 2000,
          total_tokens: 70000,
          model_attempts: 2,
        },
      });
    });
test("adapter rejects unknown backend and incompatible image before model calls", async () => {
  const client = new ScriptClient(() => reply());
  const adapter = statigentAdapter({
    image: async () => ({}),
    overrides: { client },
  });
  expect(() => adapter.options({ image: "test", backend: "shell" })).toThrow();
  expect(adapter.options({ image: "test" })).toMatchObject({
    backend: "persistent-kernel",
  });
  const i = invocation("/tmp");
  i.config.options = { image: "test", backend: "fresh-script" };
  await expect(adapter.preflight(i.config)).rejects.toThrow("protocol v2");
  expect(client.bodies).toHaveLength(0);
});
for (const name of ["infiagent", "dsbench-analysis", "dacomp-da"])
  test(`${name} four-way plan retains frozen selection and budgets`, async () => {
    const old = await Bun.file(
        `configs/evaluations/${name}-development.json`,
      ).json(),
      raw = await Bun.file(
        `configs/evaluations/${name}-backend-ablation-development.json`,
      ).json(),
      selection = await Bun.file(
        `configs/evaluations/${name}-development-selection.json`,
      ).json();
    expect(raw.benchmark.task_ids).toEqual(old.benchmark.task_ids);
    expect(raw.benchmark.task_ids).toEqual(
      name === "infiagent"
        ? selection.tasks.map((t: { id: number }) => String(t.id))
        : selection.tasks,
    );
    expect(raw.agents).toHaveLength(4);
    expect(
      new Set(
        raw.agents.map(
          (a: { options: { backend: string; organization: string } }) =>
            `${a.options.backend}/${a.options.organization}`,
        ),
      ).size,
    ).toBe(4);
    expect(
      new Set(
        raw.agents.map((a: { options: { image: string } }) => a.options.image),
      ).size,
    ).toBe(1);
    expect(
      new Set(raw.agents.map((a: { model_profile: string }) => a.model_profile))
        .size,
    ).toBe(1);
    expect(raw.task_budget).toEqual(old.task_budget);
    const config = validateConfig(raw, defaultRegistry(), profiles);
    const units =
      config.agents.length *
      config.benchmark.task_ids.length *
      config.repetitions;
    expect(units).toBe(name === "infiagent" ? 48 : 24);
    for (const key of ["model_attempts", "total_tokens", "timeout_ms"])
      expect(raw.batch_budget[key]).toBeGreaterThanOrEqual(
        units * raw.task_budget[key],
      );
    if (raw.scoring)
      for (const key of ["model_attempts", "total_tokens", "timeout_ms"])
        expect(raw.scoring.batch_budget[key]).toBeGreaterThanOrEqual(
          units * raw.scoring.unit_budget[key],
        );
  });
