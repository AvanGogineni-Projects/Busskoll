import numpy as np
import pandas as pd
import pytest

from busskoll import trees

lgb = pytest.importorskip("lightgbm")


@pytest.mark.parametrize("objective", [{"objective": "l1"}, {"objective": "quantile", "alpha": 0.9}])
def test_numpy_predict_matches_lightgbm_with_nans_zeros_and_categories(objective):
    rng = np.random.default_rng(0)
    n = 3000
    X = pd.DataFrame({"a": rng.normal(size=n), "b": rng.integers(-2, 3, n).astype(float),
                      "line": pd.Categorical(rng.choice(["1", "4", "6"], n), categories=["1", "4", "6"])})
    X.loc[::7, "a"] = np.nan
    X.loc[::11, "b"] = np.nan
    y = X["a"].fillna(1) * 20 + (X["line"] == "4") * 30 - X["b"].fillna(0) * 5 + rng.normal(size=n)
    m = lgb.train({**objective, "verbose": -1, "num_leaves": 15, "min_data_in_leaf": 20}, lgb.Dataset(X, y),
                  num_boost_round=30)
    a = trees.to_arrays(m.dump_model())
    np.testing.assert_allclose(trees.predict(a, X), m.predict(X), rtol=1e-9, atol=1e-9)
