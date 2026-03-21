"""
Unit tests for XGBoost leeway model
"""
import unittest
import numpy as np
import pandas as pd
import sys
from pathlib import Path

# Add project root to path
_project_root = Path(__file__).resolve().parent.parent.parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

# Import modules to test
sys.path.insert(0, str(_project_root / "server_python" / "scripts" / "gp50"))
from xgboost_leeway_model import (
    prepare_features,
    compute_raw_leeway,
    train_leeway_model,
    predict_leeway,
    apply_tack_symmetry_correction,
    CORE_FEATURES,
)


class TestXGBoostLeewayModel(unittest.TestCase):
    
    def setUp(self):
        """Create synthetic test data"""
        np.random.seed(42)
        n = 1000
        
        # Generate synthetic boat state data
        twa = np.random.uniform(30, 150, n)
        bsp = np.random.uniform(20, 45, n)
        rud_ang = np.random.uniform(-15, 15, n)
        cant = np.random.uniform(-10, 10, n)
        heel = np.abs(np.random.normal(15, 5, n))
        pitch = np.random.normal(0, 3, n)
        jib_load = np.random.uniform(500, 2000, n)
        tws = np.random.uniform(10, 25, n)
        foiling = np.random.choice([0, 1, 2], n)
        yaw_rate = np.random.normal(0, 5, n)
        accel = np.random.normal(0, 1, n)
        aws = np.random.uniform(15, 35, n)
        
        # Generate AWA for tack detection (port negative, stbd positive)
        awa_bow = np.where(np.random.random(n) > 0.5, 
                          np.random.uniform(30, 150, n),   # Starboard
                          np.random.uniform(-150, -30, n)) # Port
        awa_mast = awa_bow + np.random.normal(0, 2, n)  # Mast slightly different
        
        # Synthetic leeway with realistic relationships
        # Leeway increases with: rudder angle, heel, TWA (reaching)
        # Leeway decreases with: boat speed, cant effectiveness
        leeway_true = (
            0.5 * rud_ang +              # Rudder creates side force
            0.1 * heel +                 # Heel affects lateral plane
            0.02 * (twa - 90)**2 / 100 + # Reaching has more leeway
            -0.05 * bsp +                # Higher speed = less leeway
            -0.08 * np.abs(cant) +       # Cant reduces leeway
            np.random.normal(0, 0.5, n)  # Noise
        )
        
        # Add tack sign (port negative, stbd positive)
        tack_sign = np.where(awa_bow >= 0, 1, -1)
        leeway_signed = leeway_true * tack_sign
        
        # Create heading and COG for leeway calculation
        hdg = np.random.uniform(0, 360, n)
        cog = (hdg + leeway_signed + 360) % 360
        
        self.df = pd.DataFrame({
            'ts': np.arange(n) * 0.1,
            'Twa_n_deg': np.abs(twa),
            'Bsp_kph': bsp,
            'RUD_ang_n_deg': np.abs(rud_ang),
            'DB_cant_eff_lwd_deg': cant,
            'Heel_n_deg': heel,
            'Pitch_deg': pitch,
            'JIB_sheet_load_kgf': jib_load,
            'Tws_kph': tws,
            'Foiling_state': foiling,
            'Yaw_rate_dps': yaw_rate,
            'Accel_rate_mps2': accel,
            'Aws_kph': aws,
            'Awa_bow_deg': awa_bow,
            'Awa_mhu_deg': awa_mast,
            'Hdg_deg': hdg,
            'Cog_deg': cog,
            'Lwy_deg': leeway_signed,
            'Lwy_raw_deg': leeway_signed,
        })
    
    def test_prepare_features(self):
        """Test feature preparation"""
        df_features, available_features = prepare_features(
            self.df, features=CORE_FEATURES, create_derived=True
        )
        
        # Should have core features
        self.assertGreater(len(available_features), 0)
        self.assertIn('Twa_n_deg', available_features)
        self.assertIn('Bsp_kph', available_features)
        self.assertIn('RUD_ang_n_deg', available_features)
        
        # Should create derived features
        self.assertIn('TWA_regime', df_features.columns)
        self.assertIn('Rudder_effectiveness', df_features.columns)
        
        # No NaN values
        self.assertEqual(df_features.isna().sum().sum(), 0)
    
    def test_compute_raw_leeway(self):
        """Test raw leeway computation"""
        # With Lwy_deg present
        leeway = compute_raw_leeway(self.df)
        self.assertEqual(len(leeway), len(self.df))
        np.testing.assert_array_almost_equal(leeway, self.df['Lwy_deg'].values, decimal=6)
        
        # Without Lwy_deg (compute from Cog - Hdg)
        df_no_lwy = self.df.drop(columns=['Lwy_deg'])
        leeway_computed = compute_raw_leeway(df_no_lwy)
        self.assertEqual(len(leeway_computed), len(df_no_lwy))
    
    def test_train_leeway_model(self):
        """Test model training"""
        model, diagnostics = train_leeway_model(
            self.df,
            features=CORE_FEATURES,
            target_col='Lwy_raw_deg',
            validation_split=0.2,
            n_estimators=50,  # Fast for testing
        )
        
        # Check model trained
        self.assertIsNotNone(model)
        
        # Check diagnostics
        self.assertIn('train_mae', diagnostics)
        self.assertIn('val_mae', diagnostics)
        self.assertIn('train_r2', diagnostics)
        self.assertIn('val_r2', diagnostics)
        self.assertIn('features', diagnostics)
        
        # MAE should be reasonable (< 2 degrees)
        self.assertLess(diagnostics['val_mae'], 2.0)
        
        # R² should be positive (model better than mean)
        self.assertGreater(diagnostics['val_r2'], 0)
    
    def test_predict_leeway(self):
        """Test leeway prediction"""
        # Train model
        model, diagnostics = train_leeway_model(
            self.df,
            features=CORE_FEATURES,
            n_estimators=50,
        )
        
        # Predict on same data
        predictions = predict_leeway(model, self.df, diagnostics['features'])
        
        # Check output shape
        self.assertEqual(len(predictions), len(self.df))
        
        # Predictions should be in reasonable range (-10 to 10 degrees)
        self.assertGreater(predictions.min(), -10)
        self.assertLess(predictions.max(), 10)
    
    def test_apply_tack_symmetry_correction(self):
        """Test tack symmetry correction"""
        # Create predictions with known bias
        # Port tack: mean = -3.0, Stbd tack: mean = +2.5
        # Correction should be (-3.0 + 2.5) / 2 = -0.25
        n = 1000
        awa_bow = np.where(np.random.random(n) > 0.5, 50, -50)  # Half port, half stbd
        awa_mast = awa_bow + np.random.normal(0, 1, n)
        
        # Create biased predictions
        tack = np.where(awa_bow >= 0, 1, -1)
        leeway_pred = np.where(tack < 0, 
                              np.random.normal(-3.0, 0.5, n),  # Port
                              np.random.normal(2.5, 0.5, n))   # Stbd
        
        df_test = pd.DataFrame({
            'Awa_bow_deg': awa_bow,
            'Awa_mhu_deg': awa_mast,
        })
        
        # Apply correction
        corrected, correction = apply_tack_symmetry_correction(
            df_test, leeway_pred,
            awa_bow_col='Awa_bow_deg',
            awa_mast_col='Awa_mhu_deg',
        )
        
        # Check correction applied
        self.assertAlmostEqual(correction, -0.25, places=1)
        
        # After correction, port + stbd means should be near 0
        port_mean_corrected = corrected[tack < 0].mean()
        stbd_mean_corrected = corrected[tack >= 0].mean()
        self.assertAlmostEqual(port_mean_corrected + stbd_mean_corrected, 0, places=1)
    
    def test_end_to_end(self):
        """Test full pipeline: train -> predict -> correct"""
        # Train model
        model, diagnostics = train_leeway_model(
            self.df,
            features=CORE_FEATURES,
            n_estimators=100,
        )
        
        # Predict
        predictions = predict_leeway(model, self.df, diagnostics['features'])
        
        # Apply symmetry correction
        corrected, correction = apply_tack_symmetry_correction(
            self.df, predictions,
            awa_bow_col='Awa_bow_deg',
            awa_mast_col='Awa_mhu_deg',
        )
        
        # Verify output
        self.assertEqual(len(corrected), len(self.df))
        self.assertIsInstance(correction, float)
        
        # Predictions should correlate with true leeway
        correlation = np.corrcoef(corrected, self.df['Lwy_raw_deg'])[0, 1]
        self.assertGreater(correlation, 0.5)  # Reasonable correlation


if __name__ == '__main__':
    unittest.main()
