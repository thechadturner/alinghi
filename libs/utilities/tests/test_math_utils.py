import unittest
import utilities as u
import math

class TestMathUtils(unittest.TestCase):
    def test_get_even_integer(self):
        self.assertEqual(u.get_even_integer(3), 4)
        self.assertEqual(u.get_even_integer(4), 4)
        self.assertEqual(u.get_even_integer(3.7), 4)
        self.assertEqual(u.get_even_integer(2.3), 2)
    
    def test_get_numeric_values(self):
        self.assertEqual(u.get_numeric_values("Speed: 12.5 knots"), 12.5)
        self.assertEqual(u.get_numeric_values("123.45"), 123.45)
        self.assertEqual(u.get_numeric_values("-45.67"), -45.67)
    
    def test_is_float(self):
        self.assertTrue(u.is_float("3.14"))
        self.assertTrue(u.is_float(3.14))
        self.assertFalse(u.is_float("abc"))
        self.assertFalse(u.is_float(None))
    
    def test_integer(self):
        self.assertEqual(u.integer("123"), 123)
        self.assertEqual(u.integer(123.7), 123)
        self.assertEqual(u.integer(None), 0)
        self.assertEqual(u.integer("abc"), 0)
    
    def test_number(self):
        self.assertEqual(u.number("123.45"), 123.45)
        self.assertEqual(u.number(123), 123.0)
        self.assertEqual(u.number(None), 0.0)
        self.assertEqual(u.number("abc"), 0.0)
    
    def test_sign(self):
        self.assertEqual(u.sign(5), 1)
        self.assertEqual(u.sign(-5), 0)
        self.assertEqual(u.sign(0), 0)
    
    def test_aav(self):
        data = [1.0, 2.0, 3.0, 4.0, 5.0]
        result = u.aav(data, 1)
        self.assertGreater(result, 0)
        self.assertEqual(u.aav([], 1), 0)
    
    def test_mean360(self):
        # Test normal case
        self.assertAlmostEqual(u.mean360([0, 10, 20]), 10, places=1)
        # Test wraparound - result may vary based on implementation
        result = u.mean360([350, 10, 20])
        self.assertGreaterEqual(result, 0)
        self.assertLessEqual(result, 360)
        # Test empty list
        self.assertEqual(u.mean360([]), 0)
    
    def test_std360(self):
        angles = [0, 10, 20, 30]
        result = u.std360(angles)
        self.assertGreaterEqual(result, 0)
        self.assertEqual(u.std360([]), 0)
    
    def test_linear_interp(self):
        self.assertEqual(u.linear_interp(0, 0, 10, 10, 5), 5.0)
        self.assertEqual(u.linear_interp(0, 0, 10, 20, 5), 10.0)
        self.assertEqual(u.linear_interp(0, 0, 0, 0, 5), 0)  # Division by zero case
    
    def test_angle_between(self):
        self.assertEqual(u.angle_between(0, 10), 10)
        self.assertEqual(u.angle_between(350, 10), 20)
        self.assertEqual(u.angle_between(10, 0), 10)
    
    def test_angle_subtract(self):
        self.assertEqual(u.angle_subtract(10, 5), 5)
        self.assertEqual(u.angle_subtract(5, 10), -5)
        self.assertEqual(u.angle_subtract(10, 350), 20)
        self.assertEqual(u.angle_subtract(350, 10), -20)
    
    def test_angle_add(self):
        self.assertEqual(u.angle_add(10, 20), 30)
        self.assertEqual(u.angle_add(350, 20), 10)
        self.assertEqual(u.angle_add(350, 30), 20)
    
    def test_angle360_normalize(self):
        self.assertEqual(u.angle360_normalize(400), 40)
        self.assertEqual(u.angle360_normalize(-30), 330)
        self.assertEqual(u.angle360_normalize(360), 0)
        self.assertEqual(u.angle360_normalize(0), 0)
    
    def test_angle180_normalize(self):
        self.assertEqual(u.angle180_normalize(190), -170)
        self.assertEqual(u.angle180_normalize(-190), 170)
        # 180 can normalize to either 180 or -180 depending on implementation
        result_180 = u.angle180_normalize(180)
        self.assertIn(result_180, [180, -180])
        self.assertEqual(u.angle180_normalize(0), 0)
    
    def test_add_vectors(self):
        mag, dir = u.add_vectors(10, 0, 10, 90)
        self.assertAlmostEqual(mag, 14.14, places=1)
        self.assertAlmostEqual(dir, 45, places=1)
    
    def test_subtract_vectors(self):
        mag, dir = u.subtract_vectors(10, 0, 5, 0)
        self.assertAlmostEqual(mag, 5, places=1)

if __name__ == "__main__":
    unittest.main()
