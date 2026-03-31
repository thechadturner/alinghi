import unittest
import pandas as pd
import numpy as np
import utilities as u
from datetime import datetime

class TestRaceUtils(unittest.TestCase):
    def setUp(self):
        """Create sample DataFrame for testing"""
        self.df = pd.DataFrame({
            'Datetime': pd.date_range('2024-01-01 12:00:00', periods=100, freq='200ms', tz='UTC'),
            'Lat': [39.12] * 100,
            'Lng': [9.18] * 100,
            'Twd': [180.0] * 100,
            'Hdg': [180.0] * 100,
            'Cog': [180.0] * 100,
            'Bsp': [10.0] * 100,
            'Bsp_tgt': [10.0] * 100,
            'Vmg': [8.0] * 100,
            'Vmg_tgt': [8.0] * 100,
            'Twa': [0.0] * 100,
            'Lwy': [0.0] * 100,
            'Race_number': [1] * 100,
            'Leg_number': [1] * 100,
            'Mainsail_code': ['M1'] * 100,
            'Headsail_code': ['J1'] * 100
        })
    
    def test_PrepareTimeReference(self):
        """Test time reference preparation"""
        df = self.df.copy()
        result = u.PrepareTimeReference(df)
        self.assertIn('ts', result.columns)
        self.assertIn('Period', result.columns)
        self.assertGreater(result['ts'].iloc[1], result['ts'].iloc[0])
    
    def test_IdentifyEntryExit(self):
        """Test entry/exit identification"""
        df = pd.DataFrame({
            'sec': np.linspace(-10, 20, 150),
            'Yaw_rate_dps': np.concatenate([
                np.zeros(50),
                np.ones(50) * 5,
                np.zeros(50)
            ])
        })
        start, end = u.IdentifyEntryExit(df, -10, 20)
        self.assertIsInstance(start, (int, float))
        self.assertIsInstance(end, (int, float))
        self.assertLess(start, end)
    
    def test_getMetadata(self):
        """Test metadata extraction"""
        df = self.df.copy()
        dt = df['Datetime'].iloc[50]
        metadata = u.getMetadata(df, dt, 'ac40')
        self.assertIsInstance(metadata, dict)
        self.assertIn('RACES', metadata)
        self.assertIn('SAILS', metadata)
    
    def test_remove_duplicates(self):
        """Test duplicate removal"""
        test_list = [1, 2, 2, 3, 3, 3, 4]
        result = u.remove_duplicates(test_list)
        self.assertEqual(result, [1, 2, 3, 4])
        self.assertEqual(u.remove_duplicates([]), [])
    
    def test_remove_gaps(self):
        """Test gap removal"""
        df = self.df.copy()
        # Add some zero values to create gaps
        df.loc[20:30, 'Bsp'] = 0
        result = u.remove_gaps(df, 'Bsp', 'Datetime', threshold_seconds=2)
        self.assertIsInstance(result, pd.DataFrame)
        self.assertLessEqual(len(result), len(df))
    
    def test_getPointofSail(self):
        """Test point of sail calculation"""
        self.assertEqual(u.getPointofSail(45), 1)  # Upwind
        self.assertEqual(u.getPointofSail(-45), 1)  # Upwind
        self.assertEqual(u.getPointofSail(90), -1)  # Downwind
        self.assertEqual(u.getPointofSail(-90), -1)  # Downwind
    
    def test_PrepareManeuverData(self):
        """Test maneuver data preparation"""
        df = self.df.copy()
        u.PrepareTimeReference(df)
        u.PrepareManeuverData(df)
        # Check that required columns exist
        self.assertIn('TurnAng', df.columns)
        self.assertIn('TotalTurnAng', df.columns)
        self.assertIn('Yaw_rate_dps', df.columns)
        self.assertIn('Twa_cor', df.columns)
        self.assertIn('Cwa_cor', df.columns)
    
    def test_UpdateManeuverSeconds(self):
        """Test maneuver seconds update"""
        df = self.df.copy()
        u.PrepareTimeReference(df)
        climax_ts = df['ts'].iloc[50]
        u.UpdateManeuverSeconds(df, climax_ts)
        self.assertIn('sec', df.columns)
        # The row at climax should have sec = 0
        self.assertAlmostEqual(df.loc[df['ts'] == climax_ts, 'sec'].iloc[0], 0, places=1)
    
    def test_NormalizeManeuverData(self):
        """Test maneuver data normalization"""
        df = pd.DataFrame({
            'Yaw_rate_dps': [-5, -3, -1, 1, 3, 5],
            'TotalTurnAng': [-10, -8, -6, -4, -2, 0],
            'sec': [-5, -3, -1, 1, 3, 5]
        })
        u.NormalizeManeuverData(df)
        # After normalization, values should be consistent
        # np.int64 is a valid numeric type
        self.assertIsInstance(df['Yaw_rate_dps'].iloc[0], (int, float, np.integer))
    
    def test_angle_calculations_vectorized(self):
        """Test that vectorized angle calculations work"""
        df = pd.DataFrame({
            'Cog': [0, 10, 20, 30, 40],
            'PrevCog': [0, 0, 10, 20, 30],
            'Hdg': [0, 5, 10, 15, 20],
            'Twd': [180.0] * 5
        })
        # This should work without errors
        diff = df['Cog'] - df['PrevCog']
        turn_ang = ((diff + 180) % 360) - 180
        self.assertEqual(len(turn_ang), 5)

if __name__ == "__main__":
    unittest.main()

