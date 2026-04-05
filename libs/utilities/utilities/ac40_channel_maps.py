"""
AC40 public column names (racesight fusion + fetch) → legacy short names for downstream scripts.

Keeps ``get_channel_values`` requests on ``AC40_*`` where files use those keys; call
``apply_ac40_fusion_legacy_names`` immediately after fetch so existing code still sees
``Twd_cor_deg``, ``Awa_cor_deg``, etc.
"""

import re
from typing import Dict

# fusion_corrections_racesight.parquet (post-``_rename_fusion_outputs_to_ac40``)
AC40_RACESIGHT_FUSION_TO_LEGACY: Dict[str, str] = {
    'AC40_BowWand_AWA_offset_deg': 'Awa_offset_deg',
    'AC40_Leeway_offset_deg': 'Lwy_offset_deg',
    'AC40_Leeway_offset_n_deg': 'Lwy_offset_norm_deg',
    'AC40_BowWand_AWA_cor_deg': 'Awa_cor_deg',
    'AC40_BowWand_AWS_cor_kts': 'Aws_cor_kts',
    'AC40_BowWand_TWS_cor_kts': 'Tws_cor_kts',
    'AC40_TWA_cor_deg': 'Twa_cor_deg',
    'AC40_BowWand_TWD_cor_deg': 'Twd_cor_deg',
    'AC40_Leeway_cor_deg': 'Lwy_cor_deg',
    'AC40_BowWand_AWA_n_cor_deg': 'Awa_n_cor_deg',
    'AC40_TWA_n_cor_deg': 'Twa_n_cor_deg',
    'AC40_Leeway_n_cor_deg': 'Lwy_n_cor_deg',
    'AC40_Cse_cor_deg': 'Cse_cor_deg',
    'AC40_CWA_cor_deg': 'Cwa_cor_deg',
    'AC40_CWA_n_cor_deg': 'Cwa_n_cor_deg',
}


def apply_ac40_fusion_legacy_names(dfi) -> None:
    """In-place: rename AC40 fusion columns to legacy ``*_cor_*`` / offset names."""
    if dfi is None or len(dfi) == 0:
        return
    rename: Dict[str, str] = {
        k: v for k, v in AC40_RACESIGHT_FUSION_TO_LEGACY.items() if k in dfi.columns
    }
    for col in list(dfi.columns):
        m = re.match(r'^AC40_BowWand_AWA(\d+)_cor_deg$', col)
        if m:
            rename[col] = f'Awa{m.group(1)}_cor_deg'
            continue
        m = re.match(r'^AC40_BowWand_AWA(\d+)_offset_deg$', col)
        if m:
            rename[col] = f'Awa{m.group(1)}_offset_deg'
            continue
        m = re.match(r'^AC40_BowWand_AWS(\d+)_cor_kts$', col)
        if m:
            rename[col] = f'Aws{m.group(1)}_cor_kts'
            continue
    if rename:
        dfi.rename(columns=rename, inplace=True)
