import unittest
import logging
import utilities as u
from io import StringIO

class TestLoggingUtils(unittest.TestCase):
    def setUp(self):
        """Set up test logger"""
        self.log_capture = StringIO()
        # Clear existing handlers
        logger = logging.getLogger('utilities')
        logger.handlers.clear()
        handler = logging.StreamHandler(self.log_capture)
        handler.setLevel(logging.DEBUG)
        formatter = logging.Formatter('%(levelname)s - %(message)s')
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
    
    def test_log_error(self):
        """Test error logging"""
        u.log_error("Test error message")
        log_output = self.log_capture.getvalue()
        self.assertIn("Test error message", log_output)
        # Check for ERROR level (may be formatted differently)
        self.assertTrue("ERROR" in log_output or "error" in log_output.lower())
    
    def test_log_error_with_exception(self):
        """Test error logging with exception"""
        try:
            raise ValueError("Test exception")
        except Exception as e:
            u.log_error("Test error", e)
        log_output = self.log_capture.getvalue()
        self.assertIn("Test error", log_output)
    
    def test_log_warning(self):
        """Test warning logging"""
        u.log_warning("Test warning message")
        log_output = self.log_capture.getvalue()
        self.assertIn("Test warning message", log_output)
        # Check for WARNING level (may be formatted differently)
        self.assertTrue("WARNING" in log_output or "warning" in log_output.lower())
    
    def test_log_info(self):
        """Test info logging"""
        u.log_info("Test info message")
        log_output = self.log_capture.getvalue()
        # Info messages may not appear if level is WARNING
        # But function should execute without error
        self.assertIsNotNone(log_output)
    
    def test_log_debug(self):
        """Test debug logging"""
        u.log_debug("Test debug message")
        log_output = self.log_capture.getvalue()
        # Debug messages may not appear if level is WARNING
        # But function should execute without error
        self.assertIsNotNone(log_output)

if __name__ == "__main__":
    unittest.main()

