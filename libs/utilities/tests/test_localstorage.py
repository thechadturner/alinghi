import unittest
import os
import tempfile
import utilities as u

class TestLocalStorage(unittest.TestCase):
    def setUp(self):
        """Create a temporary storage file for testing"""
        self.temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.json')
        self.temp_file.close()
        self.storage = u.LocalStorage(self.temp_file.name)
    
    def tearDown(self):
        """Clean up temporary file"""
        if os.path.exists(self.temp_file.name):
            os.remove(self.temp_file.name)
    
    def test_set_and_get_item(self):
        """Test setting and getting items"""
        self.storage.set_item('test_key', 'test_value')
        self.assertEqual(self.storage.get_item('test_key'), 'test_value')
    
    def test_get_item_default(self):
        """Test getting non-existent item with default"""
        self.assertEqual(self.storage.get_item('nonexistent', 'default'), 'default')
        self.assertIsNone(self.storage.get_item('nonexistent'))
    
    def test_remove_item(self):
        """Test removing items"""
        self.storage.set_item('to_remove', 'value')
        self.storage.remove_item('to_remove')
        self.assertIsNone(self.storage.get_item('to_remove'))
    
    def test_clear(self):
        """Test clearing all items"""
        self.storage.set_item('key1', 'value1')
        self.storage.set_item('key2', 'value2')
        self.storage.clear()
        self.assertIsNone(self.storage.get_item('key1'))
        self.assertIsNone(self.storage.get_item('key2'))
    
    def test_persistence(self):
        """Test that data persists across instances"""
        self.storage.set_item('persistent', 'data')
        # Create new instance with same file
        storage2 = u.LocalStorage(self.temp_file.name)
        self.assertEqual(storage2.get_item('persistent'), 'data')
    
    def test_different_types(self):
        """Test storing different data types"""
        self.storage.set_item('string', 'test')
        self.storage.set_item('int', 42)
        self.storage.set_item('float', 3.14)
        self.storage.set_item('list', [1, 2, 3])
        self.storage.set_item('dict', {'a': 1, 'b': 2})
        
        self.assertEqual(self.storage.get_item('string'), 'test')
        self.assertEqual(self.storage.get_item('int'), 42)
        self.assertEqual(self.storage.get_item('float'), 3.14)
        self.assertEqual(self.storage.get_item('list'), [1, 2, 3])
        self.assertEqual(self.storage.get_item('dict'), {'a': 1, 'b': 2})

if __name__ == "__main__":
    unittest.main()

