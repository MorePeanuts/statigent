import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from shutil import copyfileobj, rmtree

import pandas as pd
from pandas.api.types import is_datetime64_any_dtype, is_numeric_dtype
from pandas.errors import ParserError

from statigent.errors import StatigentInputError
from statigent.schemas import DatasetProfile, InputFileInfo, TableProfile

TABULAR_SUFFIXES = frozenset({".csv", ".tsv", ".xlsx", ".xls", ".parquet"})
ZIP_COPY_CHUNK_BYTES = 1024 * 1024


class _TableProfilingError(Exception):
    """Expected failure while deriving pandas profile statistics."""


@dataclass(frozen=True)
class _DiscoveredFile:
    path: Path
    relative_path: str


@dataclass(frozen=True)
class _DiscoveryResult:
    files: list[_DiscoveredFile]
    input_file_infos: list[InputFileInfo]
    warnings: list[str]


class InputProfiler:
    def __init__(
        self,
        work_dir: Path,
        max_files: int = 200,
        max_file_bytes: int = 250_000_000,
        sample_rows: int = 5,
    ) -> None:
        self.work_dir = work_dir
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.sample_rows = sample_rows

    def profile_paths(self, paths: list[Path] | None) -> DatasetProfile:
        warnings: list[str] = []
        discovery = self._discover_paths(paths, warnings)
        files: list[InputFileInfo] = list(discovery.input_file_infos)
        warnings.extend(discovery.warnings)
        tables: list[TableProfile] = []

        for item in discovery.files:
            suffix = item.path.suffix.lower()
            size_bytes = item.path.stat().st_size
            is_tabular = suffix in TABULAR_SUFFIXES
            files.append(
                InputFileInfo(
                    path=item.path,
                    relative_path=item.relative_path,
                    suffix=suffix,
                    size_bytes=size_bytes,
                    is_tabular=is_tabular,
                )
            )
            if not is_tabular:
                continue

            if size_bytes > self.max_file_bytes:
                warning = (
                    f"Skipped table profiling for {item.relative_path}: "
                    f"{size_bytes} bytes exceeds max_file_bytes={self.max_file_bytes}."
                )
                warnings.append(warning)
                continue

            try:
                table = self._profile_table(item)
            except (
                OSError,
                ValueError,
                ImportError,
                ParserError,
                _TableProfilingError,
                zipfile.BadZipFile,
            ) as err:
                warning = f"Failed to profile {item.relative_path}: {err}"
                warnings.append(warning)
                continue
            if table is not None:
                tables.append(table)

        return DatasetProfile(
            root=self.work_dir,
            files=files,
            tables=tables,
            warnings=warnings,
        )

    def _discover_paths(
        self, paths: list[Path] | None, warnings: list[str]
    ) -> _DiscoveryResult:
        if paths is None:
            return _DiscoveryResult(files=[], input_file_infos=[], warnings=[])

        discovered: list[_DiscoveredFile] = []
        input_file_infos: list[InputFileInfo] = []
        discovery_warnings: list[str] = []
        for raw_path in paths:
            path = raw_path.expanduser()
            if not path.exists():
                msg = f"Input path does not exist: {path}"
                raise StatigentInputError(msg)

            if path.is_dir():
                self._add_discovered(
                    self._scan_directory(path),
                    discovered,
                    warnings,
                )
            elif path.suffix.lower() == ".zip":
                zip_result = self._extract_zip(path)
                input_file_infos.extend(zip_result.input_file_infos)
                discovery_warnings.extend(zip_result.warnings)
                self._add_discovered(
                    zip_result.files,
                    discovered,
                    warnings,
                )
            elif path.is_file():
                self._add_discovered(
                    [_DiscoveredFile(path=path, relative_path=path.name)],
                    discovered,
                    warnings,
                )

        return _DiscoveryResult(
            files=discovered,
            input_file_infos=input_file_infos,
            warnings=discovery_warnings,
        )

    def _add_discovered(
        self,
        items: Iterable[_DiscoveredFile],
        discovered: list[_DiscoveredFile],
        warnings: list[str],
    ) -> None:
        for item in items:
            if len(discovered) >= self.max_files:
                warning = f"Stopped input discovery at max_files={self.max_files}."
                warnings.append(warning)
                return
            discovered.append(item)

    def _scan_directory(self, directory: Path) -> list[_DiscoveredFile]:
        items: list[_DiscoveredFile] = []
        work_dir = self.work_dir.resolve()
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            if self._is_relative_to(path.resolve(), work_dir):
                continue
            items.append(
                _DiscoveredFile(
                    path=path,
                    relative_path=path.relative_to(directory).as_posix(),
                )
            )
        return items

    def _extract_zip(self, archive: Path) -> _DiscoveryResult:
        inputs_root = (self.work_dir / "inputs").resolve()
        target_dir = self.work_dir / "inputs" / archive.stem
        target_root = target_dir.resolve()
        self._prepare_zip_target_dir(target_dir, inputs_root)
        skipped_file_infos: list[InputFileInfo] = []
        discovery_warnings: list[str] = []

        try:
            with zipfile.ZipFile(archive) as zf:
                members = zf.infolist()
                if len(members) > self.max_files:
                    discovery_warnings.append(
                        f"Only the first {self.max_files} out of {len(members)} "
                        "zip members were scanned."
                    )
                total_uncompressed_size = 0
                for member in members[: self.max_files]:
                    member_relative_path = f"{archive.name}/{member.filename}"
                    destination = (target_dir / member.filename).resolve()
                    if not self._is_relative_to(destination, target_root):
                        msg = f"Zip archive contains unsafe path: {member.filename}"
                        raise StatigentInputError(msg)
                    if member.file_size > self.max_file_bytes:
                        suffix = Path(member.filename).suffix.lower()
                        skipped_file_infos.append(
                            InputFileInfo(
                                path=target_dir / member.filename,
                                relative_path=member_relative_path,
                                suffix=suffix,
                                size_bytes=member.file_size,
                                is_tabular=suffix in TABULAR_SUFFIXES,
                            )
                        )
                        discovery_warnings.append(
                            f"Skipped {member_relative_path}: file exceeds "
                            f"max_file_bytes={self.max_file_bytes}."
                        )
                        continue
                    total_uncompressed_size += member.file_size
                    max_uncompressed_size = self.max_files * self.max_file_bytes
                    if total_uncompressed_size > max_uncompressed_size:
                        msg = (
                            "Zip archive uncompressed size exceeds limit: "
                            f"{total_uncompressed_size} > {max_uncompressed_size}."
                        )
                        raise StatigentInputError(msg)

                    if member.is_dir():
                        destination.mkdir(parents=True, exist_ok=True)
                        continue
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(member) as source, destination.open("wb") as output:
                        copyfileobj(source, output, length=ZIP_COPY_CHUNK_BYTES)
        except zipfile.BadZipFile as err:
            msg = f"Invalid zip archive: {archive}"
            raise StatigentInputError(msg) from err

        return _DiscoveryResult(
            files=[
                _DiscoveredFile(
                    path=path,
                    relative_path=(
                        f"{archive.name}/{path.relative_to(target_dir).as_posix()}"
                    ),
                )
                for path in sorted(target_dir.rglob("*"))
                if path.is_file()
            ],
            input_file_infos=skipped_file_infos,
            warnings=discovery_warnings,
        )

    def _prepare_zip_target_dir(self, target_dir: Path, inputs_root: Path) -> None:
        target_root = target_dir.resolve()
        if not self._is_relative_to(target_root, inputs_root):
            msg = f"Unsafe zip extraction target: {target_dir}"
            raise StatigentInputError(msg)
        if target_dir.exists():
            if target_dir.is_dir():
                rmtree(target_dir)
            else:
                target_dir.unlink()

    def _profile_table(self, item: _DiscoveredFile) -> TableProfile | None:
        table_warnings: list[str] = []
        frame = self._read_table(item.path)

        numeric_summaries = self._numeric_summaries(frame)
        likely_time_columns = self._likely_time_columns(frame)
        likely_categorical_columns = self._likely_categorical_columns(frame)

        return TableProfile(
            path=item.path,
            relative_path=item.relative_path,
            rows=len(frame),
            columns=len(frame.columns),
            column_names=[str(column) for column in frame.columns],
            dtypes={str(column): str(dtype) for column, dtype in frame.dtypes.items()},
            missing_rates={
                str(column): float(rate)
                for column, rate in frame.isna().mean(numeric_only=False).items()
            },
            unique_counts=self._unique_counts(frame),
            numeric_summaries=numeric_summaries,
            likely_time_columns=likely_time_columns,
            likely_categorical_columns=likely_categorical_columns,
            sample_rows=self._sample_rows(frame),
            warnings=table_warnings,
        )

    def _read_table(self, path: Path) -> pd.DataFrame:
        suffix = path.suffix.lower()
        match suffix:
            case ".csv":
                return pd.read_csv(path)
            case ".tsv":
                return pd.read_csv(path, sep="\t")
            case ".xlsx" | ".xls":
                return pd.read_excel(path)
            case ".parquet":
                return pd.read_parquet(path)

        msg = f"Unsupported tabular suffix: {suffix}"
        raise ValueError(msg)

    def _numeric_summaries(self, frame: pd.DataFrame) -> dict[str, dict[str, float]]:
        summaries: dict[str, dict[str, float]] = {}
        for column in frame.columns:
            series = frame[column]
            if not is_numeric_dtype(series):
                continue
            stats = series.describe()
            summary: dict[str, float] = {}
            for key in ("mean", "std", "min", "25%", "50%", "75%", "max"):
                value = stats.get(key)
                if pd.notna(value):
                    summary[key] = float(value)
            summaries[str(column)] = summary
        return summaries

    def _likely_time_columns(self, frame: pd.DataFrame) -> list[str]:
        likely: list[str] = []
        time_markers = ("date", "time", "timestamp", "datetime")
        for column in frame.columns:
            column_name = str(column)
            series = frame[column]
            lower_name = column_name.lower()
            if is_datetime64_any_dtype(series):
                likely.append(column_name)
                continue
            if any(marker in lower_name for marker in time_markers):
                parsed = pd.to_datetime(series.dropna().head(20), errors="coerce")
                if not parsed.empty and parsed.notna().mean() >= 0.8:
                    likely.append(column_name)
        return likely

    def _likely_categorical_columns(self, frame: pd.DataFrame) -> list[str]:
        likely: list[str] = []
        row_count = max(len(frame), 1)
        for column in frame.columns:
            series = frame[column]
            try:
                unique_count = int(series.nunique(dropna=True))
            except TypeError as err:
                msg = f"categorical detection failed for {column}: {err}"
                raise _TableProfilingError(msg) from err
            if not is_numeric_dtype(series) and unique_count <= max(20, row_count // 2):
                likely.append(str(column))
        return likely

    def _unique_counts(self, frame: pd.DataFrame) -> dict[str, int]:
        try:
            counts = frame.nunique(dropna=True)
        except TypeError as err:
            msg = f"unique counts failed: {err}"
            raise _TableProfilingError(msg) from err
        return {str(column): int(count) for column, count in counts.items()}

    def _sample_rows(self, frame: pd.DataFrame) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for raw_row in frame.head(self.sample_rows).to_dict(orient="records"):
            row: dict[str, object] = {}
            for key, value in raw_row.items():
                row[str(key)] = None if pd.isna(value) else value
            rows.append(row)
        return rows

    def _is_relative_to(self, path: Path, parent: Path) -> bool:
        try:
            path.relative_to(parent)
        except ValueError:
            return False
        return True
