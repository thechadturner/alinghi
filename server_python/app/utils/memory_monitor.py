"""
Memory monitoring utilities for detecting memory leaks

This module provides utilities to monitor memory usage and detect potential leaks
in long-running processes.
"""
import psutil
import os
import logging
from typing import Dict, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class MemoryMonitor:
    """Monitor memory usage and detect potential leaks"""
    
    def __init__(self, process_id: Optional[int] = None):
        """
        Initialize memory monitor
        
        Args:
            process_id: Process ID to monitor (defaults to current process)
        """
        self.process_id = process_id or os.getpid()
        self.process = psutil.Process(self.process_id)
        self.baseline_memory: Optional[float] = None
        self.peak_memory: float = 0.0
        self.memory_samples: list = []
        self.max_samples: int = 1000  # Keep last 1000 samples
    
    def get_memory_info(self) -> Dict:
        """
        Get current memory information
        
        Returns:
            Dictionary with memory statistics
        """
        try:
            memory_info = self.process.memory_info()
            memory_percent = self.process.memory_percent()
            
            # Get system memory info
            system_memory = psutil.virtual_memory()
            
            return {
                "rss": memory_info.rss,  # Resident Set Size (physical memory)
                "vms": memory_info.vms,  # Virtual Memory Size
                "percent": memory_percent,
                "available_system_memory": system_memory.available,
                "total_system_memory": system_memory.total,
                "system_memory_percent": system_memory.percent,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error getting memory info: {str(e)}")
            return {
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }
    
    def set_baseline(self):
        """Set current memory usage as baseline"""
        memory_info = self.get_memory_info()
        self.baseline_memory = memory_info.get("rss", 0)
        logger.info(f"Memory baseline set: {self.baseline_memory / 1024 / 1024:.2f} MB")
    
    def sample_memory(self) -> Dict:
        """
        Take a memory sample and store it
        
        Returns:
            Current memory information
        """
        memory_info = self.get_memory_info()
        rss = memory_info.get("rss", 0)
        
        # Track peak memory
        if rss > self.peak_memory:
            self.peak_memory = rss
        
        # Store sample
        self.memory_samples.append({
            "rss": rss,
            "timestamp": datetime.now().isoformat()
        })
        
        # Limit sample history
        if len(self.memory_samples) > self.max_samples:
            self.memory_samples.pop(0)
        
        return memory_info
    
    def check_for_leak(self, threshold_mb: float = 100.0) -> Dict:
        """
        Check if memory usage indicates a potential leak
        
        Args:
            threshold_mb: Memory increase threshold in MB to flag as potential leak
            
        Returns:
            Dictionary with leak detection results
        """
        if self.baseline_memory is None:
            return {
                "leak_detected": False,
                "message": "No baseline set. Call set_baseline() first.",
                "current_memory_mb": 0,
                "baseline_memory_mb": 0,
                "increase_mb": 0
            }
        
        current_info = self.get_memory_info()
        current_rss = current_info.get("rss", 0)
        increase_bytes = current_rss - self.baseline_memory
        increase_mb = increase_bytes / 1024 / 1024
        
        leak_detected = increase_mb > threshold_mb
        
        result = {
            "leak_detected": leak_detected,
            "current_memory_mb": current_rss / 1024 / 1024,
            "baseline_memory_mb": self.baseline_memory / 1024 / 1024,
            "increase_mb": increase_mb,
            "peak_memory_mb": self.peak_memory / 1024 / 1024,
            "threshold_mb": threshold_mb,
            "timestamp": datetime.now().isoformat()
        }
        
        if leak_detected:
            result["message"] = f"Potential memory leak detected: {increase_mb:.2f} MB increase"
            logger.warning(result["message"])
        else:
            result["message"] = f"Memory usage normal: {increase_mb:.2f} MB increase"
        
        return result
    
    def get_memory_trend(self, samples: int = 10) -> Dict:
        """
        Get memory trend over recent samples
        
        Args:
            samples: Number of recent samples to analyze
            
        Returns:
            Dictionary with trend analysis
        """
        if len(self.memory_samples) < 2:
            return {
                "trend": "insufficient_data",
                "message": "Not enough samples to determine trend",
                "sample_count": len(self.memory_samples)
            }
        
        recent_samples = self.memory_samples[-samples:] if len(self.memory_samples) >= samples else self.memory_samples
        
        if len(recent_samples) < 2:
            return {
                "trend": "insufficient_data",
                "message": "Not enough samples to determine trend",
                "sample_count": len(recent_samples)
            }
        
        first_rss = recent_samples[0]["rss"]
        last_rss = recent_samples[-1]["rss"]
        change_bytes = last_rss - first_rss
        change_mb = change_bytes / 1024 / 1024
        change_percent = (change_bytes / first_rss * 100) if first_rss > 0 else 0
        
        # Determine trend
        if change_mb > 10:  # More than 10 MB increase
            trend = "increasing"
        elif change_mb < -10:  # More than 10 MB decrease
            trend = "decreasing"
        else:
            trend = "stable"
        
        return {
            "trend": trend,
            "change_mb": change_mb,
            "change_percent": change_percent,
            "first_sample_mb": first_rss / 1024 / 1024,
            "last_sample_mb": last_rss / 1024 / 1024,
            "samples_analyzed": len(recent_samples),
            "timestamp": datetime.now().isoformat()
        }
    
    def get_summary(self) -> Dict:
        """
        Get comprehensive memory monitoring summary
        
        Returns:
            Dictionary with all memory statistics
        """
        current_info = self.get_memory_info()
        leak_check = self.check_for_leak() if self.baseline_memory else None
        trend = self.get_memory_trend()
        
        return {
            "current": current_info,
            "baseline_mb": self.baseline_memory / 1024 / 1024 if self.baseline_memory else None,
            "peak_mb": self.peak_memory / 1024 / 1024,
            "leak_check": leak_check,
            "trend": trend,
            "sample_count": len(self.memory_samples),
            "process_id": self.process_id
        }


# Global memory monitor instance
_global_monitor: Optional[MemoryMonitor] = None


def get_memory_monitor() -> MemoryMonitor:
    """Get or create global memory monitor instance"""
    global _global_monitor
    if _global_monitor is None:
        _global_monitor = MemoryMonitor()
    return _global_monitor


def initialize_memory_monitoring():
    """Initialize memory monitoring with baseline"""
    monitor = get_memory_monitor()
    monitor.set_baseline()
    logger.info("Memory monitoring initialized")
    return monitor

