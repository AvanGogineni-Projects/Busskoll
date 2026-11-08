import io
import zipfile

from busskoll.gtfs.static import trip_lines_from_dir
from tests.conftest import gtfs_zip


def test_trip_lines_keeps_only_tracked_bus_lines(tmp_path):
    zipfile.ZipFile(io.BytesIO(gtfs_zip())).extractall(tmp_path)
    m = trip_lines_from_dir(tmp_path)  # files sit one level down, like real archives
    # M1 is line "1" but metro (route_type 401); line 99 isn't tracked
    assert dict(zip(m["trip_id"], m["line"])) == {"T1": "1", "T4": "4"}
