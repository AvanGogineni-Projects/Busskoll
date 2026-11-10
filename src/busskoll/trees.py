"""Evaluate exported LightGBM models with NumPy only, so the API needs no LightGBM at runtime
(its Linux wheel needs a system OpenMP library that serverless images may lack).

    to_arrays(booster.dump_model())  -> dict of flat arrays (saved with np.savez_compressed)
    predict(arrays, X)               -> same numbers as booster.predict(X)

Covers what model.fit produces: numeric splits with NaN/zero/none missing handling, and
pandas-categorical splits (category codes as in training).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

_MISSING = {"None": 0, "Zero": 1, "NaN": 2}


def to_arrays(dump: dict) -> dict[str, np.ndarray]:
    """All trees as one node table. Leaves have feature -1 and their value in `value`."""
    feat, thr, left, right, dleft, miss, cat, value, roots = [], [], [], [], [], [], [], [], []

    def add(n: dict) -> int:
        i = len(feat)
        for col in (feat, thr, left, right, dleft, miss, cat, value):
            col.append(0)
        if "leaf_value" in n:
            feat[i], value[i], left[i], right[i] = -1, n["leaf_value"], i, i  # a leaf points to itself
            return i
        feat[i], dleft[i], miss[i] = n["split_feature"], n["default_left"], _MISSING[n["missing_type"]]
        if n["decision_type"] == "==":
            cat[i] = sum(1 << int(c) for c in str(n["threshold"]).split("||"))  # categories going left
        else:
            thr[i], cat[i] = float(n["threshold"]), -1
        left[i] = add(n["left_child"])
        right[i] = add(n["right_child"])
        return i

    for t in dump["tree_info"]:
        roots.append(add(t["tree_structure"]))
    return {"feature": np.array(feat, np.int32), "threshold": np.array(thr), "left": np.array(left, np.int32),
            "right": np.array(right, np.int32), "default_left": np.array(dleft, bool),
            "missing": np.array(miss, np.int8), "cat_mask": np.array(cat, np.int64),
            "value": np.array(value), "roots": np.array(roots, np.int32)}


def matrix(X: pd.DataFrame) -> np.ndarray:
    """Features as float columns; a categorical column becomes its category code (NaN if missing)."""
    cols = [(X[c].cat.codes.where(X[c].notna(), np.nan) if isinstance(X[c].dtype, pd.CategoricalDtype) else X[c])
            .to_numpy(float) for c in X.columns]
    return np.column_stack(cols) if cols else np.empty((len(X), 0))


def predict(a: dict[str, np.ndarray], X: pd.DataFrame) -> np.ndarray:
    x = matrix(X)
    rows = np.arange(len(x))[:, None]
    node = np.broadcast_to(a["roots"], (len(x), len(a["roots"]))).copy()
    while True:
        f = a["feature"][node]
        inner = f >= 0
        if not inner.any():
            return a["value"][node].sum(axis=1)
        v = x[rows, np.maximum(f, 0)]
        nan, miss, cat = np.isnan(v), a["missing"][node], a["cat_mask"][node]
        num_v = np.where(nan & (miss == 0), 0.0, v)  # missing_type None: NaN counts as 0
        go_left = num_v <= a["threshold"][node]
        is_missing = ((miss == 2) & nan) | ((miss == 1) & (nan | (v == 0)))
        go_left = np.where(is_missing, a["default_left"][node], go_left)
        code = np.where(nan | (v < 0), 63, v).astype(np.int64)  # NaN/unseen category: goes right
        in_set = (cat >> np.minimum(code, 62)) & 1 == 1
        go_left = np.where(cat >= 0, in_set & (code < 63), go_left)
        node = np.where(inner, np.where(go_left, a["left"][node], a["right"][node]), node)
