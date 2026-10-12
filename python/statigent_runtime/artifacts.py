"""Bounded file snapshots that never follow task-created links."""

import os
import stat
from collections.abc import Iterator
from pathlib import Path


class ArtifactError(ValueError):
    """A file cannot safely be collected."""


def read_workspace(
    root: Path, max_file_bytes: int, max_entries: int = 10000
) -> Iterator[tuple[str, bytes | ArtifactError]]:
    # Directory descriptors and O_NOFOLLOW close rename/stat/open link races.
    # scandir streams names instead of materializing an unbounded directory list.
    visited = 0

    def walk(directory_fd: int, prefix: str, depth: int):
        nonlocal visited
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                visited += 1
                if visited > max_entries:
                    yield (
                        prefix,
                        ArtifactError("directory scan exceeds max_artifacts_bytes"),
                    )
                    return
                name = entry.name
                path = f"{prefix}/{name}" if prefix else name
                if "\\" in path or len(path.encode()) > 1024 or depth > 32:
                    yield path[:1024], ArtifactError("invalid artifact path or depth")
                    continue
                descriptor = None
                try:
                    before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if stat.S_ISDIR(before.st_mode):
                        descriptor = os.open(
                            name,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory_fd,
                        )
                        yield from walk(descriptor, path, depth + 1)
                        if visited > max_entries:
                            return
                        continue
                    if not stat.S_ISREG(before.st_mode):
                        raise ArtifactError("symbolic link or special file rejected")
                    if before.st_size > max_file_bytes:
                        raise ArtifactError("file exceeds max_artifact_bytes")
                    descriptor = os.open(
                        name,
                        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                        dir_fd=directory_fd,
                    )
                    opened = os.fstat(descriptor)
                    if (
                        not stat.S_ISREG(opened.st_mode)
                        or opened.st_ino != before.st_ino
                    ):
                        raise ArtifactError("file changed during collection")
                    with os.fdopen(descriptor, "rb") as stream:
                        descriptor = None
                        data = stream.read(max_file_bytes + 1)
                        after = os.fstat(stream.fileno())
                    if len(data) > max_file_bytes:
                        raise ArtifactError("file exceeds max_artifact_bytes")
                    if (opened.st_size, opened.st_mtime_ns) != (
                        after.st_size,
                        after.st_mtime_ns,
                    ):
                        raise ArtifactError("file changed during collection")
                    yield path, data
                except (OSError, ArtifactError) as exc:
                    yield path, ArtifactError(str(exc))
                finally:
                    if descriptor is not None:
                        os.close(descriptor)

    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield from walk(root_fd, "", 0)
    finally:
        os.close(root_fd)
