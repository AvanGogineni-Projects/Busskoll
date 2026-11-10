"""Settings from the environment (.env is loaded if present). Keys are never logged."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

OPERATOR = "sl"
# Busy blue bus lines (route_short_name). Metro is out of scope: its positions are less precise.
LINES = ("1", "4", "6", "179")
DATA_DIR = Path(os.environ.get("BUSSKOLL_DATA_DIR", "data"))


def key(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set; copy .env.example to .env and fill it in")
    return value
