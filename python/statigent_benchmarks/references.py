"""DSBench RPG 私有参考读取：只读指定成员，不解包，不执行文本。"""

import hashlib
import math
import re
import stat
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

from .ds_catalog import sha256

SCORING_DEPENDENCIES = {
    "numpy": "2.3.3",
    "pandas": "2.3.2",
    "scikit-learn": "1.7.2",
    "scipy": "1.16.2",
}
MAX_ARCHIVE_BYTES = 4 * 1024 * 1024
MAX_MEMBER_BYTES = 256


class ReferenceError(ValueError):
    """评分材料/协议错误，不能按模型答错计零。"""


def check_dependencies() -> dict[str, str]:
    actual = {name: version(name) for name in SCORING_DEPENDENCIES}
    if actual != SCORING_DEPENDENCIES:
        raise ReferenceError("DSBench scoring dependency mismatch")
    return actual


def parse_reference(data: bytes) -> float:
    if len(data) > MAX_MEMBER_BYTES:
        raise ReferenceError("Reference size exceeds limit")
    try:
        text = data.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise ReferenceError("Reference is not ASCII numeric text") from error
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text):
        raise ReferenceError("Invalid or non-finite reference")
    value = float(text)
    if not math.isfinite(value):
        raise ReferenceError("Non-finite reference")
    return value


@dataclass(frozen=True)
class References:
    baseline: float
    reference: float
    direction: str

    def __post_init__(self):
        if not all(math.isfinite(v) for v in (self.baseline, self.reference)):
            raise ReferenceError("Non-finite reference")
        if self.direction not in ("minimize", "maximize"):
            raise ReferenceError("Unknown metric direction")
        difference = self.reference - self.baseline
        if not math.isfinite(difference) or difference == 0:
            raise ReferenceError("Zero or non-finite RPG denominator")
        if (difference > 0) != (self.direction == "maximize"):
            raise ReferenceError("RPG reference direction conflict")

    def rpg(self, score: float) -> float:
        if not math.isfinite(score):
            raise ReferenceError("Non-finite native score")
        value = (score - self.baseline) / (self.reference - self.baseline)
        if not math.isfinite(value):
            raise ReferenceError("Non-finite RPG result")
        return max(0.0, value)


def member_name(task_id: str, group: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", task_id) or group not in ("baseline", "GT"):
        raise ReferenceError("Invalid reference task/group")
    return f"save_performance/{group}/{task_id}/result.txt"


def read_members(
    archive: Path, archive_sha256: str, members: dict[str, str]
) -> dict[str, bytes]:
    if archive.stat().st_size > MAX_ARCHIVE_BYTES or sha256(archive) != archive_sha256:
        raise ReferenceError("Reference archive size/hash mismatch")
    result = {}
    with ZipFile(archive) as zipped:
        infos = zipped.infolist()
        names = [info.filename for info in infos]
        if len(infos) > 2048 or len(names) != len(set(names)):
            raise ReferenceError("Too many or duplicate archive members")
        for info in infos:
            name = info.filename
            path = PurePosixPath(name)
            mode = info.external_attr >> 16
            if (
                path.is_absolute()
                or ".." in path.parts
                or "\\" in name
                or "\0" in name
                or str(path) != name.rstrip("/")
                or stat.S_ISLNK(mode)
            ):
                raise ReferenceError("Unsafe archive member")
        for name, expected in members.items():
            if not re.fullmatch(
                r"save_performance/(baseline|GT)/[a-zA-Z0-9_-]+/result\.txt", name
            ):
                raise ReferenceError("Reference member is not allowed")
            if name not in names:
                raise ReferenceError(f"Missing reference: {name}")
            info = zipped.getinfo(name)
            if info.file_size > MAX_MEMBER_BYTES or info.flag_bits & 1:
                raise ReferenceError("Oversized/encrypted reference")
            data = zipped.read(info)
            if hashlib.sha256(data).hexdigest() != expected:
                raise ReferenceError(f"Reference hash mismatch: {name}")
            result[name] = data
    return result


def read_references(
    archive: Path,
    archive_sha256: str,
    task_id: str,
    direction: str,
    member_hashes: dict[str, str],
) -> References:
    names = [member_name(task_id, group) for group in ("baseline", "GT")]
    if any(name not in member_hashes for name in names):
        raise ReferenceError(f"Missing reference manifest: {task_id}")
    data = read_members(archive, archive_sha256, {n: member_hashes[n] for n in names})
    return References(*(parse_reference(data[n]) for n in names), direction)
