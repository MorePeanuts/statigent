import { readFile } from "node:fs/promises";
import {
  type ModelProfile,
  resolveCredential,
  validateProfile,
} from "../models/config";

/** What the browser may know about a profile: never the key, endpoint or generation settings. */
export interface ModelOption {
  id: string;
  display_name: string;
  capabilities: ModelProfile["capabilities"];
  key_present: boolean;
}

function keyPresent(
  profile: ModelProfile,
  environment: Record<string, string | undefined>,
): boolean {
  // Same acceptance rule the model client applies, so "present" means a run would not be refused
  // for its credential.
  try {
    resolveCredential(profile, environment);
    return true;
  } catch {
    return false;
  }
}

export function modelOptions(
  value: unknown,
  environment: Record<string, string | undefined> = process.env,
): ModelOption[] {
  if (!Array.isArray(value)) throw new Error("Models must be an array");
  const profiles = value.map(validateProfile);
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length)
    throw new Error("Duplicate model profile ID");
  return profiles.map((profile) => ({
    id: profile.id,
    display_name: profile.display_name,
    capabilities: { ...profile.capabilities },
    key_present: keyPresent(profile, environment),
  }));
}

export async function listModelOptions(
  configPath: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<ModelOption[]> {
  return modelOptions(
    JSON.parse(await readFile(configPath, "utf8")),
    environment,
  );
}
