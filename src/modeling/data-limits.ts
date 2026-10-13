import defaults from "../../python/statigent_modeling/data_limits.json";
import { integer, keys, obj } from "../models/validation";

export type DataLimits = typeof defaults;
export const DEFAULT_DATA_LIMITS: Readonly<DataLimits> =
  Object.freeze(defaults);
export function parseDataLimits(value: unknown): DataLimits {
  const raw = obj(value);
  keys(raw, Object.keys(DEFAULT_DATA_LIMITS));
  return {
    max_file_bytes: integer(raw.max_file_bytes, "file limit"),
    max_rows: integer(raw.max_rows, "row limit"),
    max_columns: integer(raw.max_columns, "column limit"),
    max_field_bytes: integer(raw.max_field_bytes, "field limit"),
    max_memory_bytes: integer(raw.max_memory_bytes, "memory limit"),
  };
}
