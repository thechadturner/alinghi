from typing import Optional, List
import pandas as pd

# Import logging utilities with fallback
try:
    from .logging_utils import log_error
except ImportError:
    # Fallback for when running as script or in certain environments
    from logging_utils import log_error

def parse_str(input_str: str, delimiter: str = ",") -> List[str]:
    """
    Parse a string into a list of substrings based on a delimiter.

    Args:
        input_str (str): The input string to parse.
        delimiter (str, optional): The delimiter to split the string. Defaults to ",".

    Returns:
        list: A list of substrings.
    """
    try:
        return [s.strip() for s in input_str.split(delimiter)]
    except Exception as e:
        log_error("Error in parse_str", e)
        return []

def trim_str(string: Optional[str], chars: int) -> Optional[str]:
    """
    Trim a string to a specified number of characters.

    Args:
        string (str): The input string to trim.
        chars (int): The number of characters to keep.

    Returns:
        str: The trimmed string.
    """
    return string[:chars] if string is not None else None

def left(string: str, amount: int) -> str:
    """
    Get the leftmost characters of a string.

    Args:
        string (str): The input string.
        amount (int): The number of characters to return.

    Returns:
        str: The leftmost characters of the string.
    """
    return string[:amount]

def right(string: str, amount: int) -> str:
    """
    Get the rightmost characters of a string.

    Args:
        string (str): The input string.
        amount (int): The number of characters to return.

    Returns:
        str: The rightmost characters of the string.
    """
    return string[-amount:]

def mid(string: str, offset: int, amount: int) -> str:
    """
    Get a substring from a string starting at a specified offset.

    Args:
        string (str): The input string.
        offset (int): The starting position of the substring.
        amount (int): The number of characters to return.

    Returns:
        str: The substring.
    """
    return string[offset:offset+amount]

def minsec(seconds: int) -> str:
    """
    Convert seconds to a string in the format MM:SS.

    Args:
        seconds (int): The number of seconds.

    Returns:
        str: The formatted time string.
    """
    minutes = (seconds % 3600) // 60
    seconds = seconds % 60
    return f"{minutes:02}:{seconds:02}"

def strip(string: str, chars: str = "-") -> str:
    """
    Remove all occurrences of specified characters from a string.

    Args:
        string (str): The input string.
        chars (str, optional): The characters to remove. Defaults to "-".

    Returns:
        str: The string with specified characters removed.
    """
    return string.replace(chars, "")

def fill_between(series: pd.Series) -> pd.Series:
    """
    Fills zero values in a pandas Series with the nearest non-zero value between consecutive occurrences of that value.
    For each unique non-zero value in the input Series, this function finds all indices where the value occurs.
    For each pair of consecutive indices of the same value, it replaces any zero values between them with that value.
    Parameters
    ----------
    series : pandas.Series
        The input Series containing numeric values, where zeros may be present between non-zero values.
    Returns
    -------
    pandas.Series
        A copy of the input Series with zeros between consecutive non-zero values replaced by those values.
    Examples
    --------
    >>> import pandas as pd
    >>> s = pd.Series([0, 1, 0, 0, 1, 0, 2, 0, 2])
    >>> fill_between(s)
    0    0
    1    1
    2    1
    3    1
    4    1
    5    0
    6    2
    7    2
    8    2
    dtype: int64
    """
    s = series.copy()
    valid_values = s.dropna().unique()
    valid_values = [v for v in valid_values if v != 0]

    for val in valid_values:
        positions = [i for i, v in enumerate(s) if v == val]
        for i in range(len(positions) - 1):
            start = positions[i]
            end = positions[i + 1]
            # Find indices where zeros are present between start and end
            zero_indices = [j for j in range(start + 1, end) if s.iloc[j] == 0]
            # Assign directly using .iloc and a list of indices to avoid chained assignment
            if zero_indices:
                s.iloc[zero_indices] = val
    return s