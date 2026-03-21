import unittest
import utilities as u

class TestWeatherUtils(unittest.TestCase):
    def test_fahrenheit_to_celsius(self):
        self.assertAlmostEqual(u.fahrenheit_to_celsius(32), 0)
        self.assertAlmostEqual(u.fahrenheit_to_celsius(212), 100)
    
    def test_fahrenheit_to_kelvin(self):
        self.assertAlmostEqual(u.fahrenheit_to_kelvin(32), 273.15)
        self.assertAlmostEqual(u.fahrenheit_to_kelvin(212), 373.15)
    
    def test_saturation_vapor_pressure(self):
        self.assertAlmostEqual(u.saturation_vapor_pressure(273.15), 610.94, delta=1)
    
    def test_compute_air_density(self):
        density = u.compute_air_density(68, 50, 29.92)
        self.assertIsNotNone(density)
        self.assertGreater(density, 1)

if __name__ == "__main__":
    unittest.main()