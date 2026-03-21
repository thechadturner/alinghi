"""
Logging utilities for the utilities library.

This module provides a simple logging interface that can be used throughout
the utilities library. It uses Python's standard logging module.
"""

import logging
import sys

# Configure the logger
_logger = None

def get_logger(name='utilities'):
    """
    Get or create a logger instance.
    
    Args:
        name (str): Name of the logger (default: 'utilities')
        
    Returns:
        logging.Logger: Configured logger instance
    """
    global _logger
    if _logger is None:
        _logger = logging.getLogger(name)
        if not _logger.handlers:
            # Create console handler
            handler = logging.StreamHandler(sys.stderr)
            handler.setLevel(logging.WARNING)
            
            # Create formatter
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            handler.setFormatter(formatter)
            
            _logger.addHandler(handler)
            _logger.setLevel(logging.WARNING)
    
    return _logger

def log_error(message, exception=None):
    """
    Log an error message.
    
    Args:
        message (str): Error message
        exception (Exception, optional): Exception object to log
    """
    logger = get_logger()
    if exception:
        logger.error(f"{message}: {exception}", exc_info=True)
    else:
        logger.error(message)

def log_warning(message):
    """
    Log a warning message.
    
    Args:
        message (str): Warning message
    """
    logger = get_logger()
    logger.warning(message)

def log_info(message):
    """
    Log an info message.
    
    Args:
        message (str): Info message
    """
    logger = get_logger()
    logger.info(message)

def log_debug(message):
    """
    Log a debug message.
    
    Args:
        message (str): Debug message
    """
    logger = get_logger()
    logger.debug(message)

