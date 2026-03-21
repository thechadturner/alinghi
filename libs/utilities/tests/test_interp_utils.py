import unittest
import numpy as np
import tempfile
import os
import utilities as u

class TestInterpUtils(unittest.TestCase):
    def test_read_polar_data_basic(self):
        """Test reading polar data from a file"""
        content = "TWS\tBSP1\tTWA1\tBSP2\tTWA2\n" \
                  "6\t4.2\t45\t3.8\t60\n" \
                  "8\t5.1\t44\t4.7\t62\n"
        with tempfile.NamedTemporaryFile(mode='w+', delete=False) as tmp:
            tmp.write(content)
            tmp_filename = tmp.name

        try:
            data = u.read_polar_data(tmp_filename)
            self.assertIsInstance(data, np.ndarray)
            self.assertEqual(data.shape, (2, 5))
            np.testing.assert_array_almost_equal(
                data,
                np.array([
                    [6, 4.2, 45, 3.8, 60],
                    [8, 5.1, 44, 4.7, 62]
                ])
            )
        finally:
            os.remove(tmp_filename)
    
    def test_read_polar_data_empty_file(self):
        """Test reading empty polar data file"""
        content = "TWS\tBSP1\tTWA1\n"
        with tempfile.NamedTemporaryFile(mode='w+', delete=False) as tmp:
            tmp.write(content)
            tmp_filename = tmp.name

        try:
            data = u.read_polar_data(tmp_filename)
            self.assertIsInstance(data, np.ndarray)
            # Empty array may have shape (0,) or (0, 3) depending on implementation
            self.assertTrue(len(data) == 0 or data.shape[0] == 0)
        finally:
            os.remove(tmp_filename)
    
    def test_read_polar_data_non_numeric(self):
        """Test reading polar data with non-numeric values"""
        content = "TWS\tBSP1\tTWA1\n" \
                  "6\tfoo\t45\n"
        with tempfile.NamedTemporaryFile(mode='w+', delete=False) as tmp:
            tmp.write(content)
            tmp_filename = tmp.name

        try:
            with self.assertRaises(ValueError):
                u.read_polar_data(tmp_filename)
        finally:
            os.remove(tmp_filename)
    
    def test_interpolate_twa(self):
        """Test TWA interpolation"""
        # Create simple polar data
        data = np.array([
            [6, 4.2, 45, 3.8, 60],
            [8, 5.1, 44, 4.7, 62]
        ])
        result = u.interpolate_twa(7.0, 4.5, 50.0, data)
        self.assertIsInstance(result, (int, float, type(None)))
    
    def test_interpolate_tws(self):
        """Test TWS interpolation"""
        # Create simple polar data arrays
        tws_values = np.array([6, 8])
        twa_values = np.array([45, 60])
        input_values = np.array([4.2, 5.1])
        result = u.interpolate_tws('tws', 4.5, 50.0, tws_values, twa_values, input_values)
        self.assertIsInstance(result, (int, float, type(None)))

if __name__ == "__main__":
    unittest.main()
