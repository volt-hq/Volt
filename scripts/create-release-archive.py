#!/usr/bin/env python3
"""Create deterministic, extraction-safe Volt release archives."""

from __future__ import annotations

import argparse
import gzip
import os
import re
import stat
import tarfile
import time
import zipfile
from pathlib import Path, PurePosixPath


MIN_ZIP_EPOCH = 315532800  # 1980-01-01T00:00:00Z
SAFE_ROOT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--format", required=True, choices=("tar.gz", "zip"))
    parser.add_argument("--root", default="")
    parser.add_argument(
        "--epoch",
        type=int,
        default=int(os.environ.get("SOURCE_DATE_EPOCH", MIN_ZIP_EPOCH)),
    )
    return parser.parse_args()


def normalized_mode(path: Path) -> int:
    # Keep the shipped CLI executable executable even on Windows, where stat
    # permission bits are otherwise a platform-dependent approximation.
    if path.name in ("volt", "volt.exe"):
        return 0o755
    mode = path.stat().st_mode
    return 0o755 if mode & 0o111 else 0o644


def archive_entries(source: Path) -> list[tuple[Path, PurePosixPath, bool]]:
    entries: list[tuple[Path, PurePosixPath, bool]] = []
    for path in sorted(source.rglob("*"), key=lambda item: item.relative_to(source).as_posix()):
        metadata = path.lstat()
        is_reparse_point = bool(
            getattr(metadata, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        )
        if path.is_symlink() or is_reparse_point:
            raise ValueError(
                f"release archives must not contain symlinks or reparse points: {path}"
            )
        relative = PurePosixPath(path.relative_to(source).as_posix())
        mode = metadata.st_mode
        if stat.S_ISDIR(mode):
            entries.append((path, relative, True))
        elif stat.S_ISREG(mode):
            entries.append((path, relative, False))
        else:
            raise ValueError(f"release archives must contain only files and directories: {path}")
    return entries


def rooted_name(root: str, relative: PurePosixPath) -> str:
    return (PurePosixPath(root) / relative).as_posix() if root else relative.as_posix()


def write_tar_gz(source: Path, output: Path, root: str, epoch: int) -> None:
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
                if root:
                    info = tarfile.TarInfo(f"{root}/")
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    info.mtime = epoch
                    archive.addfile(info)
                for path, relative, is_directory in archive_entries(source):
                    name = rooted_name(root, relative)
                    info = tarfile.TarInfo(f"{name}/" if is_directory else name)
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    info.mtime = epoch
                    info.mode = 0o755 if is_directory else normalized_mode(path)
                    if is_directory:
                        info.type = tarfile.DIRTYPE
                        archive.addfile(info)
                    else:
                        info.size = path.stat().st_size
                        with path.open("rb") as contents:
                            archive.addfile(info, contents)


def write_zip(source: Path, output: Path, root: str, epoch: int) -> None:
    zip_epoch = max(epoch, MIN_ZIP_EPOCH)
    date_time = time.gmtime(zip_epoch)[:6]
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        if root:
            info = zipfile.ZipInfo(f"{root}/", date_time=date_time)
            info.create_system = 3
            info.external_attr = (stat.S_IFDIR | 0o755) << 16
            archive.writestr(info, b"")
        for path, relative, is_directory in archive_entries(source):
            name = rooted_name(root, relative)
            if is_directory:
                name = f"{name}/"
            info = zipfile.ZipInfo(name, date_time=date_time)
            info.create_system = 3
            mode = 0o755 if is_directory else normalized_mode(path)
            info.external_attr = ((stat.S_IFDIR if is_directory else stat.S_IFREG) | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, b"" if is_directory else path.read_bytes())


def main() -> None:
    args = parse_args()
    source = args.input.resolve(strict=True)
    if not source.is_dir():
        raise ValueError(f"archive input is not a directory: {source}")
    if args.root and (
        not SAFE_ROOT.fullmatch(args.root)
        or PurePosixPath(args.root).is_absolute()
        or len(PurePosixPath(args.root).parts) != 1
    ):
        raise ValueError("archive root must be one safe relative path component")
    if args.epoch < 0:
        raise ValueError("archive epoch must be non-negative")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        if args.format == "tar.gz":
            write_tar_gz(source, temporary, args.root, args.epoch)
        else:
            write_zip(source, temporary, args.root, args.epoch)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
