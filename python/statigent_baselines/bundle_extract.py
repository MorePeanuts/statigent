"""解析 Docker 导出的 tar；只复制有界普通文件，不反序列化任何模型。"""

import argparse
import json
import shutil
import tarfile
from pathlib import Path, PurePosixPath


def extract(archive, destination, max_files, max_bytes):
    destination.mkdir(mode=0o700)
    seen, total, count = set(), 0, 0
    try:
        with tarfile.open(archive, mode="r|") as stream:
            for member in stream:
                name = member.name
                while name.startswith("./"):
                    name = name[2:]
                if name in ("", ".") and member.isdir():
                    continue
                path = PurePosixPath(name)
                if (
                    not name
                    or len(name.encode()) > 1024
                    or path.is_absolute()
                    or "\\" in name
                    or any(part in ("", ".", "..") for part in name.split("/"))
                    or name in seen
                    or member.issparse()
                    or not (member.isfile() or member.isdir())
                ):
                    raise ValueError("Unsafe/duplicate bundle member")
                seen.add(name)
                if len(seen) > max_files * 4:
                    raise ValueError("Bundle entry limit")
                target = destination / path
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                count += 1
                total += member.size
                if member.size < 0 or count > max_files or total > max_bytes:
                    raise ValueError("Bundle file/byte limit")
                target.parent.mkdir(parents=True, exist_ok=True)
                with stream.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                if target.stat().st_size != member.size:
                    raise ValueError("Truncated bundle file")
                target.chmod(0o444)
        if count == 0:
            raise ValueError("Empty model bundle")
        return {"files": count, "bytes": total}
    except BaseException:
        shutil.rmtree(destination)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--max-files", type=int, required=True)
    parser.add_argument("--max-bytes", type=int, required=True)
    args = parser.parse_args()
    if args.max_files <= 0 or args.max_bytes <= 0:
        raise ValueError("Positive bundle limits required")
    print(
        json.dumps(
            extract(args.archive, args.destination, args.max_files, args.max_bytes)
        )
    )


if __name__ == "__main__":
    main()
