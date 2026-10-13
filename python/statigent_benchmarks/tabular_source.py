"""流式格式解码。依赖只在显式数据准备时导入，不进入默认模型环境。"""

import math
from contextlib import contextmanager
from importlib.metadata import version


def data_dependencies():
    for package, expected in [("liac-arff", "2.5.0"), ("pyarrow", "24.0.0")]:
        if version(package) != expected:
            raise ValueError(f"Install locked data group: {package}=={expected}")


def normalize(value):
    if isinstance(value, float):
        if math.isnan(value):
            return None
        if not math.isfinite(value):
            raise ValueError("Infinite source value")
    return value


@contextmanager
def decoded_source(path, limits):
    data_dependencies()
    if path.stat().st_size > limits["max_file_bytes"]:
        raise ValueError("Raw source file limit exceeded")

    def checked_rows(rows, columns):
        for index, values in enumerate(rows):
            if (
                index >= limits["max_rows"]
                or values is None
                or len(values) != len(columns)
            ):
                raise ValueError("Decoded row/shape limit exceeded")
            values = [normalize(value) for value in values]
            byte_count = sum(len(str(v).encode()) for v in values if v is not None)
            if byte_count * 8 + 256 * len(values) > limits["max_memory_bytes"] // 4:
                raise ValueError("Decoded row memory limit exceeded")
            if any(
                v is not None and len(str(v).encode()) > limits["max_field_bytes"]
                for v in values
            ):
                raise ValueError("Decoded field limit exceeded")
            yield index, dict(zip([c["name"] for c in columns], values, strict=True))

    def check_columns(columns):
        if (
            not columns
            or len(columns) > limits["max_columns"]
            or len({c["name"] for c in columns}) != len(columns)
        ):
            raise ValueError("Decoded column limit/identity mismatch")

    if path.suffix == ".arff":
        import arff

        with path.open(encoding="utf-8") as stream:

            def bounded_lines():
                while line := stream.readline(limits["max_memory_bytes"] // 8 + 1):
                    if len(line.encode()) > limits["max_memory_bytes"] // 8:
                        raise ValueError("ARFF line memory limit exceeded")
                    yield line

            decoded = arff.load(bounded_lines(), return_type=arff.DENSE_GEN)
            columns = []
            for name, source_type in decoded["attributes"]:
                nominal = isinstance(source_type, list)
                if not nominal and source_type.upper() not in (
                    "INTEGER",
                    "REAL",
                    "NUMERIC",
                    "STRING",
                ):
                    raise ValueError(f"Unsupported ARFF type: {source_type}")
                columns.append(
                    {
                        "name": name,
                        "kind": "categorical"
                        if nominal
                        else "string"
                        if source_type.upper() == "STRING"
                        else "numeric",
                        "source_type": "ARFF/NOMINAL"
                        if nominal
                        else f"ARFF/{source_type.upper()}",
                        "categories": source_type if nominal else None,
                    }
                )
            check_columns(columns)
            yield columns, checked_rows(decoded["data"], columns)
    elif path.suffix in (".parquet", ".pq"):
        import pyarrow as pa
        import pyarrow.parquet as pq

        with pq.ParquetFile(path) as source:
            if source.metadata.num_rows > limits["max_rows"]:
                raise ValueError("Parquet row limit exceeded")
            columns = []
            for field in source.schema_arrow:
                dtype = field.type
                if pa.types.is_dictionary(dtype):
                    kind = "categorical"
                elif pa.types.is_integer(dtype) or pa.types.is_floating(dtype):
                    kind = "numeric"
                elif pa.types.is_string(dtype) or pa.types.is_large_string(dtype):
                    kind = "string"
                elif pa.types.is_boolean(dtype):
                    kind = "boolean"
                elif pa.types.is_timestamp(dtype) or pa.types.is_date(dtype):
                    kind = "datetime"
                else:
                    raise ValueError(f"Unsupported Parquet type: {dtype}")
                columns.append(
                    {
                        "name": field.name,
                        "kind": kind,
                        "source_type": f"Parquet/{dtype}",
                        "categories": None,
                    }
                )
            check_columns(columns)
            # 防止压缩文件绕过明示内存预算；有界批次也必须能容纳单个解码页组。
            for group in range(source.metadata.num_row_groups):
                if (
                    source.metadata.row_group(group).total_byte_size
                    > limits["max_memory_bytes"] // 2
                ):
                    raise ValueError("Parquet row group memory limit exceeded")
            batch_size = max(
                1, min(4096, limits["max_memory_bytes"] // (2048 * len(columns)))
            )

            def batches():
                for batch in source.iter_batches(
                    batch_size=batch_size, use_threads=False
                ):
                    if batch.nbytes * 4 > limits["max_memory_bytes"] // 2:
                        raise ValueError("Parquet batch memory limit exceeded")
                    for row in batch.to_pylist():
                        yield [row[column["name"]] for column in columns]

            yield columns, checked_rows(batches(), columns)
    else:
        raise ValueError("Unsupported source format")
