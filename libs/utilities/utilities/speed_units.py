"""
Central speed unit handling for calibration and wind pipelines.

Primary convention: channel names end with ``_kph`` or ``_kts``. All speeds passed to
``computeTrueWind_vectorized`` must share the same unit within one call.

**Unsuffixed speed bases:** column names in ``BARE_SPEED_BASE_NAMES`` (e.g. ``Bsp``,
``Tws``, ``Aws_bow``) are interpreted as **knots** when they appear without ``_kph``/``_kts``.
Do not mix a bare base and a suffixed column for the same base (e.g. ``Bsp`` and ``Bsp_kph``).

When inference finds no suffixed or bare speed signals, ``resolve_speed_unit`` defaults to **kts**.
"""

from __future__ import annotations

from typing import FrozenSet, Iterable, List, Optional, Set, Tuple

import numpy as np
import pandas as pd

# Maritime conversion (exact definition used elsewhere in the repo)
KPH_PER_KNOT = 1.852
KNOTS_PER_KPH = 1.0 / KPH_PER_KNOT

SpeedUnit = str  # 'kph' | 'kts'

# Known logical speed columns that may appear without _kph/_kts; values are treated as knots.
BARE_SPEED_BASE_NAMES: FrozenSet[str] = frozenset(
    {"Bsp", "Tws", "Sog", "Aws", "Aws_bow", "Aws_mhu"}
)


def convert_speed_array(values: np.ndarray, from_unit: SpeedUnit, to_unit: SpeedUnit) -> np.ndarray:
    """Convert speed arrays between kph and kts (NaNs preserved)."""
    if from_unit == to_unit:
        return np.asarray(values, dtype=np.float64)
    arr = np.asarray(values, dtype=np.float64)
    if from_unit == "kph" and to_unit == "kts":
        return arr * KNOTS_PER_KPH
    if from_unit == "kts" and to_unit == "kph":
        return arr * KPH_PER_KNOT
    raise ValueError(f"Unsupported speed units: {from_unit!r} -> {to_unit!r}")


def convert_speed_series(s: pd.Series, from_unit: SpeedUnit, to_unit: SpeedUnit) -> pd.Series:
    if from_unit == to_unit:
        return pd.to_numeric(s, errors="coerce")
    v = pd.to_numeric(s, errors="coerce").to_numpy(dtype=np.float64, copy=True)
    out = convert_speed_array(v, from_unit, to_unit)
    return pd.Series(out, index=s.index, dtype="float64")


def _suffix_for(unit: SpeedUnit) -> str:
    if unit not in ("kph", "kts"):
        raise ValueError(f"speed unit must be 'kph' or 'kts', got {unit!r}")
    return f"_{unit}"


def _bases_present(df: pd.DataFrame) -> dict[str, Set[str]]:
    """Map logical base (e.g. 'Bsp', 'Aws_bow') -> {'kph'} or {'kts'} or both."""
    bases: dict[str, Set[str]] = {}
    for c in df.columns:
        if c.endswith("_kph"):
            bases.setdefault(c[: -4], set()).add("kph")
        elif c.endswith("_kts"):
            bases.setdefault(c[: -4], set()).add("kts")
    return bases


def _validate_no_bare_with_suffix(df: pd.DataFrame) -> None:
    """Bare speed base column plus ``Base_kph``/``Base_kts`` is ambiguous."""
    for base in BARE_SPEED_BASE_NAMES:
        if base not in df.columns:
            continue
        if (base + "_kph") in df.columns or (base + "_kts") in df.columns:
            raise ValueError(
                f"Ambiguous speed columns for {base!r}: both bare {base!r} and suffixed "
                f"{base}_kph/{base}_kts exist; keep one naming style or set speed_unit."
            )


def _bare_speed_signal_in_dataframe(df: pd.DataFrame) -> bool:
    for base in BARE_SPEED_BASE_NAMES:
        if base in df.columns:
            return True
    return False


def _bare_speed_signal_from_aws_list(aws_sensor_names: Optional[Iterable[str]]) -> bool:
    if not aws_sensor_names:
        return False
    for name in aws_sensor_names:
        if name.endswith("_kph") or name.endswith("_kts"):
            continue
        if name in BARE_SPEED_BASE_NAMES:
            return True
    return False


def _infer_units_from_suffixes(
    df: pd.DataFrame,
    aws_sensor_names: Optional[Iterable[str]],
) -> Set[SpeedUnit]:
    """Collect speed units implied by *_kph / *_kts columns (same rules as before)."""
    bases = _bases_present(df)
    units: Set[str] = set()
    priority_bases: List[str] = ["Bsp", "Tws"]

    def consider_base(b: str) -> None:
        if b not in bases:
            return
        sufs = bases[b]
        if len(sufs) > 1:
            raise ValueError(
                f"Mixed speed units for {b!r}: found both _kph and _kts in dataframe; "
                f"remove one column or set CalibrationConfig.speed_unit explicitly."
            )
        units.add(next(iter(sufs)))

    for b in priority_bases:
        consider_base(b)

    if aws_sensor_names:
        for name in aws_sensor_names:
            if name.endswith("_kph"):
                consider_base(name[: -4])
            elif name.endswith("_kts"):
                consider_base(name[: -4])

    for b in sorted(bases.keys()):
        if b.startswith("Aws") or b == "Sog":
            consider_base(b)

    return units


def infer_speed_unit_from_dataframe(
    df: pd.DataFrame,
    aws_sensor_names: Optional[Iterable[str]] = None,
) -> Optional[SpeedUnit]:
    """
    Infer a single speed unit from column suffixes and/or bare speed base names.

    Returns None if no recognised speed columns or bare/list signals exist (caller defaults to kts).
    Raises if mixed kph/kts appear on the same logical base, or bare+suffixed same base, or
    suffix-implied unit conflicts with unsuffixed bare/kts semantics.
    """
    _validate_no_bare_with_suffix(df)

    units = _infer_units_from_suffixes(df, aws_sensor_names)
    bare_signal = _bare_speed_signal_in_dataframe(df) or _bare_speed_signal_from_aws_list(
        aws_sensor_names
    )

    if len(units) > 1:
        raise ValueError(
            f"Inconsistent speed units across channels: {sorted(units)}; "
            f"use a single suffix family or set CalibrationConfig.speed_unit."
        )

    suffix_unit: Optional[SpeedUnit] = next(iter(units)) if units else None

    if suffix_unit is not None and bare_signal:
        if suffix_unit != "kts":
            raise ValueError(
                f"Speed unit conflict: suffixed columns imply {suffix_unit!r} but bare speed "
                f"columns or unsuffixed AWS names are defined as knots; use consistent naming "
                f"or set CalibrationConfig.speed_unit."
            )
        return "kts"

    if suffix_unit is not None:
        return suffix_unit

    if bare_signal:
        return "kts"

    return None


def resolve_speed_unit(
    explicit: Optional[SpeedUnit],
    df: pd.DataFrame,
    aws_sensor_names: Optional[Iterable[str]] = None,
) -> SpeedUnit:
    """
    Resolve final unit: explicit 'kph'/'kts' wins; else infer from df; else 'kts'.
    """
    if explicit in ("kph", "kts"):
        return explicit
    if explicit not in (None, "auto"):
        raise ValueError(f"speed_unit must be 'kph', 'kts', 'auto', or None, got {explicit!r}")
    inferred = infer_speed_unit_from_dataframe(df, aws_sensor_names)
    return inferred if inferred is not None else "kts"


def ensure_speed_columns(df: pd.DataFrame, target_unit: SpeedUnit) -> None:
    """
    In-place: promote bare speed bases to ``Base_kts``, then for each logical speed base present,
    ensure the ``_{target_unit}`` column exists (convert from the peer suffix if needed).
    Refuses mixed suffixes on the same base and bare+suffixed same base.
    Drops peer columns after conversion so the frame is not left with both _kph and _kts
    for the same base (avoids ambiguous downstream reads).
    """
    _validate_no_bare_with_suffix(df)

    for base in list(BARE_SPEED_BASE_NAMES):
        if base not in df.columns:
            continue
        kts_col = base + "_kts"
        kph_col = base + "_kph"
        if kts_col in df.columns or kph_col in df.columns:
            continue
        df[kts_col] = pd.to_numeric(df[base], errors="coerce")
        df.drop(columns=[base], inplace=True)

    other = "kts" if target_unit == "kph" else "kph"
    bases = _bases_present(df)
    for base, sufs in bases.items():
        if len(sufs) > 1:
            raise ValueError(
                f"Mixed speed units for {base!r}: cannot materialize {target_unit}; "
                f"fix input columns or set speed_unit."
            )
    t_suf = _suffix_for(target_unit)
    o_suf = _suffix_for(other)
    to_drop: List[str] = []
    for base in list(bases.keys()):
        col_t = base + t_suf
        col_o = base + o_suf
        if col_t in df.columns:
            continue
        if col_o in df.columns:
            df[col_t] = convert_speed_series(df[col_o], other, target_unit)
            to_drop.append(col_o)
    for c in to_drop:
        if c in df.columns:
            df.drop(columns=[c], inplace=True)


def bsp_tws_feature_names(unit: SpeedUnit) -> Tuple[str, str]:
    return f"Bsp_{unit}", f"Tws_{unit}"


def aws_fused_output_column(unit: SpeedUnit) -> str:
    return f"Aws_fused_{unit}"


def tws_fused_output_column(unit: SpeedUnit) -> str:
    return f"Tws_fused_{unit}"
