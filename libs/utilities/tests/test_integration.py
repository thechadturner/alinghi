"""
Integration tests for utilities library.
Tests multiple modules working together.
"""
import unittest
import pandas as pd
import numpy as np
import utilities as u
from datetime import datetime

class TestIntegration(unittest.TestCase):
    def setUp(self):
        """Create comprehensive test data"""
        self.df = pd.DataFrame({
            'Datetime': pd.date_range('2024-01-01 12:00:00', periods=200, freq='200ms', tz='UTC'),
            'Lat': np.linspace(39.12, 39.13, 200),
            'Lng': np.linspace(9.18, 9.19, 200),
            'Twd': [180.0] * 200,
            'Hdg': np.linspace(175, 185, 200),
            'Cog': np.linspace(175, 185, 200),
            'Bsp': [10.0] * 200,
            'Bsp_tgt': [10.0] * 200,
            'Vmg': [8.0] * 200,
            'Vmg_tgt': [8.0] * 200,
            'Twa': [0.0] * 200,
            'Lwy': [0.0] * 200,
            'Race_number': [1] * 200,
            'Leg_number': [1] * 200,
            'Mainsail_code': ['M1'] * 200,
            'Headsail_code': ['J1'] * 200
        })
    
    def test_full_maneuver_processing(self):
        """Test complete maneuver processing pipeline"""
        df = self.df.copy()
        
        # Step 1: Prepare time reference
        df = u.PrepareTimeReference(df)
        self.assertIn('ts', df.columns)
        
        # Step 2: Prepare maneuver data
        u.PrepareManeuverData(df)
        self.assertIn('TurnAng', df.columns)
        self.assertIn('Yaw_rate_dps', df.columns)
        
        # Step 3: Calculate angles using math utils
        twd_avg = u.mean360(df['Twd'].tolist())
        self.assertIsInstance(twd_avg, (int, float))
        
        # Step 4: Test metadata extraction
        dt = df['Datetime'].iloc[100]
        metadata = u.getMetadata(df, dt, 'gp50')
        self.assertIsInstance(metadata, dict)
    
    def test_geo_and_datetime_integration(self):
        """Test geographical and datetime functions together"""
        # Convert datetime to timestamp
        dt_str = "2024-01-01 12:00:00"
        ts = u.get_timestamp_from_str(dt_str)
        
        # Use timestamp for geo calculations
        lat1, lng1 = 39.12, 9.18
        lat2, lng2 = 39.13, 9.19
        
        # Calculate range
        distance = u.range_from_latlng(lat1, lng1, lat2, lng2)
        self.assertGreater(distance, 0)
        
        # Calculate bearing
        bearing = u.bearing_from_latlng(lat1, lng1, lat2, lng2)
        self.assertGreaterEqual(bearing, 0)
        self.assertLessEqual(bearing, 360)
    
    def test_wind_and_math_integration(self):
        """Test wind calculations with math utilities"""
        # Calculate true wind
        aws, awa = 15.0, 45.0
        stw, hdg, lwy = 10.0, 180.0, 2.0
        
        tws, twa, twd = u.computeTrueWind(aws, awa, stw, hdg, lwy)
        
        # Normalize angles
        twd_normalized = u.angle360_normalize(twd)
        self.assertGreaterEqual(twd_normalized, 0)
        self.assertLessEqual(twd_normalized, 360)
        
        # Calculate angle differences
        angle_diff = u.angle_subtract(twd, hdg)
        self.assertIsInstance(angle_diff, (int, float))
    
    def test_storage_and_api_integration(self):
        """Test storage with API token handling"""
        storage = u.LocalStorage()
        
        # Store API token
        test_token = "test_token_123"
        storage.set_item('api_token', test_token)
        
        # Retrieve and verify
        retrieved = storage.get_item('api_token')
        self.assertEqual(retrieved, test_token)
        
        # Clean up
        storage.remove_item('api_token')
    
    def test_vectorized_operations(self):
        """Test that vectorized operations work correctly"""
        df = self.df.copy()
        u.PrepareTimeReference(df)
        
        # Test vectorized angle calculations
        df['PrevCog'] = df['Cog'].shift(fill_value=df['Cog'].iloc[0])
        diff = df['Cog'] - df['PrevCog']
        df['TurnAng'] = ((diff + 180) % 360) - 180
        
        # Verify all rows processed
        self.assertEqual(len(df['TurnAng']), len(df))
        self.assertFalse(df['TurnAng'].isna().any())
        
        # Test mean calculation on angles
        mean_cog = u.mean360(df['Cog'].tolist())
        self.assertIsInstance(mean_cog, (int, float))

if __name__ == "__main__":
    unittest.main()

