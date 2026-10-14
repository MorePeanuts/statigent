import * as z from "zod";
import defaults from "../../python/statigent_modeling/data_limits.json";

export type DataLimits = typeof defaults;
export const DEFAULT_DATA_LIMITS: Readonly<DataLimits> =
  Object.freeze(defaults);
const positiveInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 1);
const dataLimitsSchema = z.strictObject({
  max_file_bytes: positiveInteger,
  max_rows: positiveInteger,
  max_columns: positiveInteger,
  max_field_bytes: positiveInteger,
  max_memory_bytes: positiveInteger,
});
export function parseDataLimits(value: unknown): DataLimits {
  return dataLimitsSchema.parse(value);
}
