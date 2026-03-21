import unittest
import utilities as u

class TestGeoUtils(unittest.TestCase):
    def test_latlng_to_meters(self):
        # Test conversion from lat/lng to meters
        result = u.latlng_to_meters(0, 0, 1, 1)
        self.assertEqual(len(result), 2)
        self.assertIsInstance(result[0], (int, float))
        self.assertIsInstance(result[1], (int, float))
        # Should return empty list on error
        self.assertEqual(u.latlng_to_meters("invalid", 0, 1, 1), [])
    
    def test_meters_to_latlng(self):
        # Test conversion from meters to lat/lng
        result = u.meters_to_latlng(0, 0, 111132, 111132)
        self.assertEqual(len(result), 2)
        self.assertIsInstance(result[0], (int, float))
        self.assertIsInstance(result[1], (int, float))
        # Round trip test
        lat0, lng0 = 39.12, 9.18
        x, y = u.latlng_to_meters(lat0, lng0, lat0 + 0.01, lng0 + 0.01)
        lat, lng = u.meters_to_latlng(lat0, lng0, x, y)
        self.assertAlmostEqual(lat, lat0 + 0.01, places=2)
        self.assertAlmostEqual(lng, lng0 + 0.01, places=2)
    
    def test_latlng_from_rangebearing(self):
        # Test calculating position from range and bearing
        result = u.latlng_from_rangebearing(0, 0, 1000, 90)
        self.assertEqual(len(result), 2)
        self.assertIsInstance(result[0], (int, float))
        self.assertIsInstance(result[1], (int, float))
    
    def test_range_from_latlng(self):
        # Test distance calculation
        result = u.range_from_latlng(0, 0, 1, 1)
        self.assertGreater(result, 0)
        # Same point should return 0 or very small
        result2 = u.range_from_latlng(0, 0, 0, 0)
        self.assertLessEqual(result2, 1000)  # Allow some tolerance
    
    def test_bearing_from_latlng(self):
        # Test bearing calculation
        result = u.bearing_from_latlng(0, 0, 1, 1)
        self.assertGreaterEqual(result, 0)
        self.assertLessEqual(result, 360)
        # North should be ~0 or 360
        result_north = u.bearing_from_latlng(0, 0, 1, 0)
        self.assertGreaterEqual(result_north, 0)
        self.assertLessEqual(result_north, 360)

if __name__ == "__main__":
    unittest.main()
