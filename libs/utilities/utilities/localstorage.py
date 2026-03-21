import json
import os
from typing import Any, Optional, Dict

class LocalStorage:
    def __init__(self, file_name: str = 'local_storage.json') -> None:
        # Get the directory where this localstorage.py file is located
        script_dir = os.path.dirname(os.path.abspath(__file__))
        # Always store the JSON file in the same directory as this script
        self.file_name = os.path.join(script_dir, file_name)

        if not os.path.exists(self.file_name):
            with open(self.file_name, 'w') as f:
                json.dump({}, f)

    def set_item(self, key: str, value: Any) -> None:
        """Save a key-value pair persistently."""
        data = self._read_storage()
        data[key] = value
        self._write_storage(data)

    def get_item(self, key: str, default: Optional[Any] = None) -> Any:
        """Retrieve a value by key. Return default if key doesn't exist."""
        data = self._read_storage()
        return data.get(key, default)

    def remove_item(self, key: str) -> None:
        """Remove a key-value pair."""
        data = self._read_storage()
        if key in data:
            del data[key]
            self._write_storage(data)

    def clear(self) -> None:
        """Clear all data."""
        self._write_storage({})

    def _read_storage(self) -> Dict[str, Any]:
        """Internal method to read the JSON file."""
        try:
            with open(self.file_name, 'r') as f:
                content = f.read().strip()
                if not content:
                    return {}
                return json.loads(content)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _write_storage(self, data: Dict[str, Any]) -> None:
        """Internal method to write to the JSON file."""
        with open(self.file_name, 'w') as f:
            json.dump(data, f, indent=4)