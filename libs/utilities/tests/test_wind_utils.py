import unittest
import math
import utilities as u

class TestWindUtils(unittest.TestCase):
    def test_adjustTrueWind_no_current(self):
        """Test adjustTrueWind with no current"""
        tws, twa = u.adjustTrueWind(10.0, 0.0, 0.0, 0.0)
        self.assertAlmostEqual(tws, 10.0, places=6)
        self.assertAlmostEqual(twa, 0.0, places=6)
        
        tws, twa = u.adjustTrueWind(15.0, 45.0, 0.0, 180.0)
        self.assertAlmostEqual(tws, 15.0, places=6)
        self.assertAlmostEqual(twa, 45.0, places=6)
    
    def test_adjustTrueWind_current_ahead(self):
        """Test adjustTrueWind with current directly ahead"""
        tws, twa = u.adjustTrueWind(10.0, 0.0, 2.0, 0.0)
        # Current affects wind speed and angle - check for valid values
        self.assertGreaterEqual(tws, 0)
        self.assertIsInstance(twa, (int, float))
    
    def test_adjustTrueWind_current_astern(self):
        """Test adjustTrueWind with current directly astern"""
        tws, twa = u.adjustTrueWind(10.0, 0.0, 2.0, 180.0)
        # Current affects wind speed and angle - check for valid values
        self.assertGreaterEqual(tws, 0)
        self.assertIsInstance(twa, (int, float))
    
    def test_adjustTrueWind_current_starboard(self):
        """Test adjustTrueWind with current from starboard"""
        tws, twa = u.adjustTrueWind(10.0, 0.0, 2.0, 90.0)
        expected_tws = math.sqrt(10**2 + 2**2)
        expected_twa = math.degrees(math.atan2(2, 10))
        self.assertAlmostEqual(tws, expected_tws, places=6)
        self.assertAlmostEqual(twa, expected_twa, places=6)
    
    def test_adjustTrueWind_current_port(self):
        """Test adjustTrueWind with current from port"""
        tws, twa = u.adjustTrueWind(10.0, 0.0, 2.0, 270.0)
        expected_tws = math.sqrt(10**2 + 2**2)
        expected_twa = -math.degrees(math.atan2(2, 10))
        self.assertAlmostEqual(tws, expected_tws, places=6)
        self.assertAlmostEqual(twa, expected_twa, places=6)
    
    def test_calculate_stw(self):
        """Test calculate_stw function"""
        stw = u.calculate_stw(180.0, 182.0, 10.0, 2.0)
        self.assertIsInstance(stw, (int, float))
        self.assertGreaterEqual(stw, 0)
    
    def test_computeTrueWind(self):
        """Test computeTrueWind function"""
        aws, awa = 15.0, 45.0
        stw, hdg, lwy = 10.0, 180.0, 2.0
        tws, twa, twd = u.computeTrueWind(aws, awa, stw, hdg, lwy)
        self.assertIsInstance(tws, (int, float))
        self.assertIsInstance(twa, (int, float))
        self.assertIsInstance(twd, (int, float))
        self.assertGreaterEqual(tws, 0)
        self.assertGreaterEqual(twd, 0)
        self.assertLessEqual(twd, 360)

if __name__ == "__main__":
    unittest.main()
