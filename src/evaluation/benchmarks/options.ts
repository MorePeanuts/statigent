import { resolve } from "node:path";
import * as z from "zod";

const path = z.string().refine((value) => value.trim().length > 0);
const rootSchema = z.strictObject({ root: path });
const rootAndMetadataSchema = z.strictObject({
  root: path,
  metadata: path.optional(),
});

export function benchmarkRootOptions(value: unknown) {
  const options = rootSchema.parse(value);
  return { root: resolve(options.root) };
}

export function benchmarkRootAndMetadataOptions(value: unknown) {
  const options = rootAndMetadataSchema.parse(value);
  return {
    root: resolve(options.root),
    metadata: resolve(options.metadata ?? "benchmarks/metadata"),
  };
}
