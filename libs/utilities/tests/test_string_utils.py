import unittest
import utilities as u

class TestStringUtils(unittest.TestCase):
    def test_parse_string(self):
        self.assertEqual(u.parse_str("a,b,c"), ["a", "b", "c"])
        self.assertEqual(u.parse_str("a|b|c", "|"), ["a", "b", "c"])
    
    def test_trim(self):
        self.assertEqual(u.trim_str("Hello, World!", 5), "Hello")
    
    def test_left(self):
        self.assertEqual(u.left("abcdef", 3), "abc")
    
    def test_right(self):
        self.assertEqual(u.right("abcdef", 3), "def")
    
    def test_mid(self):
        self.assertEqual(u.mid("abcdef", 2, 3), "cde")
    
    def test_minsec(self):
        self.assertEqual(u.minsec(125), "02:05")
    
    def test_strip(self):
        self.assertEqual(u.strip("--hello--", "-"), "hello")

if __name__ == "__main__":
    unittest.main()