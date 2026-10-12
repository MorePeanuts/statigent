import { resolve } from "node:path";
import { prepareDataset } from "./data";
export function flags(
  args: string[],
  allowed: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i],
      v = args[i + 1];
    if (
      !k ||
      !allowed.includes(k) ||
      !v ||
      v.startsWith("--") ||
      out[k] !== undefined
    )
      throw new Error("Invalid or duplicate CLI option");
    out[k] = v;
  }
  return out;
}
export async function modelingMain(args: string[]): Promise<unknown> {
  if (args[0] !== "prepare")
    throw new Error(
      "Usage: modeling prepare --config CONFIG --out NEW_DIRECTORY",
    );
  const f = flags(args.slice(1), ["--config", "--out"]);
  if (!f["--config"] || !f["--out"])
    throw new Error("prepare requires --config and --out");
  return prepareDataset(
    await Bun.file(resolve(f["--config"])).json(),
    resolve(f["--out"]),
  );
}
if (import.meta.main)
  modelingMain(Bun.argv.slice(2))
    .then((x) => console.log(JSON.stringify(x, null, 2)))
    .catch((e) => {
      console.error(String(e));
      process.exitCode = 1;
    });
