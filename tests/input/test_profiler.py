import zipfile
from pathlib import Path

import pandas as pd
import pytest

from statigent.errors import StatigentInputError
from statigent.input import InputProfiler


def test_profile_csv_file_records_shape_and_columns(tmp_path: Path) -> None:
    data = tmp_path / "sales.csv"
    data.write_text("date,revenue,region\n2026-01-01,10,East\n2026-01-02,20,West\n")

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([data])

    table = profile.tables[0]
    assert table.rows == 2
    assert table.columns == 3
    assert table.column_names == ["date", "revenue", "region"]
    assert "revenue" in table.dtypes
    assert table.missing_rates == {"date": 0.0, "revenue": 0.0, "region": 0.0}
    assert table.unique_counts == {"date": 2, "revenue": 2, "region": 2}
    assert table.sample_rows == [
        {"date": "2026-01-01", "revenue": 10, "region": "East"},
        {"date": "2026-01-02", "revenue": 20, "region": "West"},
    ]
    assert table.likely_time_columns == ["date"]
    assert "region" in table.likely_categorical_columns


def test_profile_directory_scans_nested_tabular_files(tmp_path: Path) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "customers.tsv").write_text("id\tsegment\n1\tA\n2\tB\n")

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([tmp_path])

    assert any(
        table.relative_path.endswith("customers.tsv") for table in profile.tables
    )


def test_profile_zip_extracts_and_profiles_csv(tmp_path: Path) -> None:
    archive = tmp_path / "bundle.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("data/orders.csv", "id,total\n1,12.5\n2,8.0\n")

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([archive])

    assert profile.tables[0].relative_path.endswith("orders.csv")
    assert profile.tables[0].numeric_summaries["total"]["mean"] == 10.25


def test_profile_invalid_zip_raises_input_error(tmp_path: Path) -> None:
    archive = tmp_path / "invalid.zip"
    archive.write_text("not a zip")

    with pytest.raises(StatigentInputError):
        InputProfiler(work_dir=tmp_path / "work").profile_paths([archive])


def test_profile_zip_path_traversal_raises_input_error(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../escape.csv", "id\n1\n")

    with pytest.raises(StatigentInputError):
        InputProfiler(work_dir=tmp_path / "work").profile_paths([archive])


def test_profile_zip_oversized_member_records_warning_only(tmp_path: Path) -> None:
    archive = tmp_path / "large.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("large.csv", "id\n123\n")

    profile = InputProfiler(
        work_dir=tmp_path / "work",
        max_file_bytes=4,
    ).profile_paths([archive])

    assert len(profile.files) == 1
    assert profile.files[0].relative_path == "large.zip/large.csv"
    assert profile.files[0].suffix == ".csv"
    assert profile.files[0].is_tabular
    assert profile.files[0].size_bytes == len("id\n123\n")
    assert profile.tables == []
    assert any(
        "file exceeds max_file_bytes=4" in warning for warning in profile.warnings
    )


def test_profile_zip_too_many_members_records_warning_and_scans_cap(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "many.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("one.csv", "id\n1\n")
        zf.writestr("two.csv", "id\n2\n")

    profile = InputProfiler(
        work_dir=tmp_path / "work",
        max_files=1,
    ).profile_paths([archive])

    assert [file.relative_path for file in profile.files] == ["many.zip/one.csv"]
    assert [table.relative_path for table in profile.tables] == ["many.zip/one.csv"]
    assert any("first 1 out of 2" in warning for warning in profile.warnings)


def test_profile_zip_clears_stale_extracted_files(tmp_path: Path) -> None:
    archive = tmp_path / "bundle.zip"
    work_dir = tmp_path / "work"

    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("old.csv", "id\n1\n")

    profiler = InputProfiler(work_dir=work_dir)
    first_profile = profiler.profile_paths([archive])

    assert first_profile.tables[0].relative_path.endswith("old.csv")

    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("new.csv", "id\n2\n")

    second_profile = profiler.profile_paths([archive])

    assert [table.relative_path for table in second_profile.tables] == [
        "bundle.zip/new.csv"
    ]


def test_profile_excel_and_parquet(tmp_path: Path) -> None:
    frame = pd.DataFrame({"id": [1, 2], "value": [3.0, 4.0]})
    excel_path = tmp_path / "data.xlsx"
    parquet_path = tmp_path / "data.parquet"
    frame.to_excel(excel_path, index=False)
    frame.to_parquet(parquet_path, index=False)

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths(
        [excel_path, parquet_path]
    )

    assert len(profile.tables) == 2
    assert {file.suffix for file in profile.files if file.is_tabular} == {
        ".xlsx",
        ".parquet",
    }


def test_profile_missing_path_raises_input_error(tmp_path: Path) -> None:
    profiler = InputProfiler(work_dir=tmp_path / "work")

    with pytest.raises(StatigentInputError):
        profiler.profile_paths([tmp_path / "missing.csv"])


def test_profile_oversized_tabular_file_records_warning_only(
    tmp_path: Path,
) -> None:
    data = tmp_path / "large.csv"
    data.write_text("id\n1\n")

    profile = InputProfiler(
        work_dir=tmp_path / "work",
        max_file_bytes=1,
    ).profile_paths([data])

    assert len(profile.files) == 1
    assert profile.files[0].is_tabular
    assert profile.tables == []
    assert "exceeds max_file_bytes=1" in profile.warnings[0]


def test_profile_non_tabular_file_records_file_info_only(tmp_path: Path) -> None:
    notes = tmp_path / "notes.txt"
    notes.write_text("not tabular")

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([notes])

    assert len(profile.files) == 1
    assert profile.files[0].suffix == ".txt"
    assert not profile.files[0].is_tabular
    assert profile.tables == []


def test_profile_table_failure_adds_warning_without_failing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = tmp_path / "bad.csv"
    data.write_text("id\n1\n")

    def raise_bad_table(*_args: object) -> None:
        raise ValueError("bad table")

    monkeypatch.setattr(InputProfiler, "_profile_table", raise_bad_table)

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([data])

    assert len(profile.files) == 1
    assert profile.files[0].is_tabular
    assert profile.tables == []
    assert any("bad table" in warning for warning in profile.warnings)


def test_profile_type_error_adds_warning_without_failing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = tmp_path / "bad.csv"
    data.write_text("id\n1\n")

    def read_unhashable_frame(
        _profiler: InputProfiler,
        _path: Path,
    ) -> pd.DataFrame:
        return pd.DataFrame({"items": [[1], [2]]})

    monkeypatch.setattr(InputProfiler, "_read_table", read_unhashable_frame)

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([data])

    assert len(profile.files) == 1
    assert profile.files[0].is_tabular
    assert profile.tables == []
    assert any("unhashable type" in warning for warning in profile.warnings)


def test_profile_xls_suffix_is_tabular_and_profiled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = tmp_path / "legacy.xls"
    data.write_bytes(b"placeholder")

    def read_frame(_profiler: InputProfiler, _path: Path) -> pd.DataFrame:
        return pd.DataFrame({"id": [1, 2], "segment": ["A", "B"]})

    monkeypatch.setattr(InputProfiler, "_read_table", read_frame)

    profile = InputProfiler(work_dir=tmp_path / "work").profile_paths([data])

    assert profile.files[0].suffix == ".xls"
    assert profile.files[0].is_tabular
    assert profile.tables[0].relative_path == "legacy.xls"
    assert profile.tables[0].rows == 2
