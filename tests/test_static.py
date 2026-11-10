import io
import zipfile

from busskoll.gtfs.static import tables_from_dir, trip_lines_from_dir
from tests.conftest import gtfs_zip


def test_trip_lines_keeps_only_tracked_bus_lines(tmp_path):
    zipfile.ZipFile(io.BytesIO(gtfs_zip())).extractall(tmp_path)
    m = trip_lines_from_dir(tmp_path)  # files sit one level down, like real archives
    # M1 is line "1" but metro (route_type 401); line 99 isn't tracked
    assert dict(zip(m["trip_id"], m["line"])) == {"T1": "1", "T4": "4"}


def test_tables_include_our_routes_and_all_stops(tmp_path):
    zipfile.ZipFile(io.BytesIO(gtfs_zip())).extractall(tmp_path)
    t = tables_from_dir(tmp_path)
    assert t["routes"].to_dict("records") == [{"route_id": "R1", "line": "1"}, {"route_id": "R4", "line": "4"}]
    assert t["stops"]["stop_id"].tolist() == ["S1", "S2"] and t["stops"]["lat"].iloc[0] == 59.33
