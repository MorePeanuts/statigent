import type { ModelClient } from "../models/client";
import { type ModelProfile, validateProfile } from "../models/config";
import { MODELING_PROMPT_VERSION, modelingPrompt } from "./actions";
import { validateModelingTask } from "./config";
import { datasetProtocol, loadDataset } from "./data";
import { deliver } from "./delivery";
import { analyze } from "./eda";
import { runExperiment } from "./experiments";
import { createBasicProfile } from "./profile";
import { better } from "./protocol";
import type { ModelingRecord } from "./records";
import { runModelingSession } from "./run-session";
import { createValidationPlan } from "./validation";

export interface ModelingOptions {
  task: unknown;
  profile: ModelProfile;
  edaProfile: ModelProfile;
  runRoot: string;
  signal?: AbortSignal;
  client?: ModelClient;
  edaClient?: ModelClient;
  experiment?: typeof runExperiment;
  analysis?: typeof analyze;
  delivery?: typeof deliver;
  createRecord?: typeof ModelingRecord.create;
  prepareProfile?: typeof createBasicProfile;
}
export async function runModeling(o: ModelingOptions) {
  const start = performance.now(),
    task = validateModelingTask(o.task);
  const profile = validateProfile(o.profile),
    edaProfile = validateProfile(o.edaProfile);
  if (profile.id !== task.model_profile || edaProfile.id !== task.eda_profile)
    throw new Error("Profile/task mismatch");
  const data = await loadDataset(task.dataset_root),
    protocol = datasetProtocol(data.dataset);
  const validationPlan = createValidationPlan(
    data.dataset,
    data.train,
    task.confirmation.mode,
  );
  return runModelingSession(
    { ...o, task, start },
    {
      dataset: data.dataset,
      protocol,
      validationPlan,
      promptVersion: MODELING_PROMPT_VERSION,
      prompt: modelingPrompt(task.method),
      promptProtocol: {
        ...protocol,
        features: data.dataset.features,
        target: data.dataset.target,
        training_rows: data.dataset.split.train.length,
        validation_rows: data.dataset.split.validation.length,
      },
      initialQuestion: `Examine allowed training data for ${data.dataset.kind} prediction of ${data.dataset.target}. Which missingness, distributions or data-quality issues should inform the initial pipeline?`,
      prepareProfile: (options) =>
        (o.prepareProfile ?? createBasicProfile)({
          ...options,
          dataset: data.dataset,
          train: data.train,
        }),
      execute: (options) =>
        (o.experiment ?? runExperiment)({ ...options, ...data }),
      analyze: (options) =>
        (o.analysis ?? analyze)({
          ...options,
          dataset: data.dataset,
          train: data.train,
        }),
      better,
      deliver: (options) =>
        (o.delivery ?? deliver)(
          options.root,
          options.task,
          options.selected,
          options.final,
          data.dataset,
          options.selection,
        ),
    },
  );
}
