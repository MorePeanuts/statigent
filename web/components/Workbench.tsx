"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type InputFile } from "../lib/api";
import { InputsPanel } from "./InputsPanel";
import { type BudgetDefaults, NewRunForm } from "./NewRunForm";
import { RecentRuns } from "./RecentRuns";
import styles from "./Workbench.module.css";

export function Workbench({ defaults }: { defaults: BudgetDefaults }) {
  const [inputs, setInputs] = useState<InputFile[]>([]);
  const [inputsError, setInputsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const refreshInputs = useCallback(async () => {
    try {
      const { inputs } = await api.inputs();
      setInputs(inputs);
      setInputsError(null);
      // Drop selections whose file was deleted.
      setSelected((current) =>
        current.filter((name) => inputs.some((file) => file.name === name)),
      );
    } catch (error) {
      setInputsError(error instanceof Error ? error.message : "读取失败");
    }
  }, []);

  useEffect(() => {
    void refreshInputs();
  }, [refreshInputs]);

  return (
    <div className={styles.grid}>
      <InputsPanel
        inputs={inputs}
        error={inputsError}
        selected={selected}
        onSelectedChange={setSelected}
        onChanged={refreshInputs}
      />
      <NewRunForm defaults={defaults} inputs={selected} />
      <RecentRuns />
    </div>
  );
}
