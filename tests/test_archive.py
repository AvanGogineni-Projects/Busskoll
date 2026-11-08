import py7zr
import pytest

from busskoll.ingest.archive import CorruptArchive, unpack
from tests.conftest import gtfs_zip


def test_unpack_zip_and_7z(tmp_path):
    z = tmp_path / "a.zip"
    z.write_bytes(gtfs_zip())
    (tmp_path / "z").mkdir()
    assert {p.name for p in unpack(z, tmp_path / "z")} == {"routes.txt", "trips.txt"}

    s = tmp_path / "a.7z"
    with py7zr.SevenZipFile(s, "w") as w:
        w.writestr(b"x", "sl/TripUpdates/2026/11/01/10/a.pb")
    (tmp_path / "s").mkdir()
    assert [p.name for p in unpack(s, tmp_path / "s")] == ["a.pb"]


@pytest.mark.parametrize("data", [b"<html>outage</html>", b"7z\xbc\xaf\x27\x1c" + b"\0" * 40])
def test_unpack_rejects_garbage_and_truncated_7z(tmp_path, data):
    f = tmp_path / "bad.arc"
    f.write_bytes(data)
    with pytest.raises(CorruptArchive):
        unpack(f, tmp_path)
