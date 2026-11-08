"""Unpack a downloaded archive (zip or 7z, detected by magic bytes) into a fresh directory."""
from __future__ import annotations

import zipfile
from pathlib import Path

SEVEN_Z_MAGIC = b"7z\xbc\xaf\x27\x1c"


class CorruptArchive(Exception):
    """The file is not a readable zip/7z (KoDa sometimes serves truncated archives)."""


def unpack(archive: Path, dest: Path) -> list[Path]:
    """Extract every member into `dest` (must be empty) and return the extracted files.
    Both libraries refuse members that would escape `dest`."""
    head = archive.read_bytes()[:6]
    try:
        if head.startswith(b"PK"):
            with zipfile.ZipFile(archive) as z:
                z.extractall(dest)
        elif head == SEVEN_Z_MAGIC:
            import py7zr  # backfill-only dependency

            with py7zr.SevenZipFile(archive) as z:
                z.extractall(dest)
        else:
            raise CorruptArchive(f"{archive.name}: not a zip or 7z file (starts with {head!r})")
    except CorruptArchive:
        raise
    except Exception as e:  # zipfile/py7zr raise many types for bad data
        raise CorruptArchive(f"{archive.name}: {type(e).__name__}: {e}") from e
    return sorted(p for p in dest.rglob("*") if p.is_file())
