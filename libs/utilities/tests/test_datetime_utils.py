import unittest
import utilities as u
from datetime import datetime, timedelta

class TestDateTimeUtils(unittest.TestCase):
    def test_get_utc_offset(self):
        dt_obj = datetime(2024, 1, 1, 12, 0)
        offset = u.get_utc_offset(dt_obj, "UTC")
        self.assertEqual(offset, 0)
        # Test with different timezone
        offset_madrid = u.get_utc_offset(dt_obj, "Europe/Madrid")
        self.assertIsInstance(offset_madrid, int)
    
    def test_get_utc_datetime_from_ts(self):
        # Test with Unix timestamp
        ts = 1704110400  # 2024-01-01 12:00:00 UTC
        dt = u.get_utc_datetime_from_ts(ts)
        self.assertEqual(dt.year, 2024)
        self.assertEqual(dt.month, 1)
        self.assertEqual(dt.day, 1)
    
    def test_get_local_datetime_from_ts(self):
        ts = 1704110400
        dt = u.get_local_datetime_from_ts(ts)
        self.assertIsInstance(dt, datetime)
    
    def test_get_timestamp_from_str(self):
        ts = u.get_timestamp_from_str("2024-01-01 12:00:00")
        self.assertIsInstance(ts, float)
        self.assertGreater(ts, 0)
    
    def test_get_datetime_obj(self):
        dt = u.get_datetime_obj("2024-01-01 12:00:00")
        self.assertEqual(dt.year, 2024)
        self.assertEqual(dt.month, 1)
        self.assertEqual(dt.day, 1)
        # Test with timezone
        dt_utc = u.get_datetime_obj("2024-01-01 12:00:00", force_utc=True)
        self.assertIsNotNone(dt_utc)
    
    def test_get_date(self):
        self.assertEqual(u.get_date("2024-01-01 12:00:00"), "2024-01-01")
        self.assertIsNone(u.get_date(None))
    
    def test_get_year(self):
        self.assertEqual(u.get_year("2024-01-01 12:00:00"), "2024")
        self.assertIsNone(u.get_year(None))
    
    def test_clean_datetime(self):
        result = u.clean_datetime("2024-01-01T12:00:00Z")
        self.assertNotIn("T", result)
        self.assertNotIn("Z", result)

if __name__ == "__main__":
    unittest.main()
