import math as m
from .logging_utils import log_error
from typing import List

earth_radius = 3442 * 1852

def latlng_to_meters(Lat0: float, Lng0: float, Lat: float, Lng: float) -> List[float]:
    """
    Convert latitude and longitude to meters.

    Args:
        Lat0 (float): The reference latitude.
        Lng0 (float): The reference longitude.
        Lat (float): The latitude to convert.
        Lng (float): The longitude to convert.

    Returns:
        list: The converted coordinates in meters [x, y].
    """
    try:
        m_per_deg_lat = 111132.954 - 559.822 * m.cos(2 * m.radians(Lat)) + 1.175 * m.cos(4 * m.radians(Lat))
        m_per_deg_lng = 111132.954 * m.cos(m.radians(Lat))
        
        x = (Lng - Lng0) * m_per_deg_lng
        y = (Lat - Lat0) * m_per_deg_lat
        
        return [x, y]
    except Exception as e:
        log_error("Error in latlng_to_meters", e)
        return []

def meters_to_latlng(Lat0: float, Lng0: float, x: float, y: float) -> List[float]:
    """
    Convert meters to latitude and longitude.

    Args:
        Lat0 (float): The reference latitude.
        Lng0 (float): The reference longitude.
        x (float): The x coordinate in meters.
        y (float): The y coordinate in meters.

    Returns:
        list: The converted coordinates in latitude and longitude [Lat, Lng].
    """
    try:
        m_per_deg_lat = 111132.954 - 559.822 * m.cos(2 * m.radians(Lng0)) + 1.175 * m.cos(4 * m.radians(Lat0))
        m_per_deg_lng = 111132.954 * m.cos(m.radians(Lat0))
        
        deltaLat = x / m_per_deg_lat
        deltaLng = y / m_per_deg_lng

        # deltaLat = y / m_per_deg_lat
        # deltaLng = x / m_per_deg_lng
        
        Lat = Lat0 + deltaLat
        Lng = Lng0 + deltaLng
        
        return [Lat, Lng]
    except Exception as e:
        log_error("Error in meters_to_latlng", e)
        return []

def latlng_from_rangebearing(Lat: float, Lng: float, Rng: float, Brg: float) -> List[float]:
    """
    Calculate latitude and longitude from range and bearing.

    Args:
        Lat (float): The starting latitude.
        Lng (float): The starting longitude.
        Rng (float): The range in meters.
        Brg (float): The bearing in degrees.

    Returns:
        list: The calculated coordinates [Latout, Lngout].
    """
    try:
        dLat = m.degrees(m.asin(m.cos(m.radians(Brg)) * Rng / earth_radius))
        dLng = m.degrees(m.asin(m.sin(m.radians(Brg)) * (Rng / m.cos(m.radians(Lat))) / earth_radius))
        Latout = Lat + dLat
        Lngout = Lng + dLng
        return [Latout, Lngout]
    except Exception as e:
        log_error("Error in latlng_from_rangebearing", e)
        return []

def range_from_latlng(LatA: float, LngA: float, LatB: float, LngB: float) -> float:
    """
    Calculate the range between two latitude and longitude points.

    Args:
        LatA (float): The latitude of the first point.
        LngA (float): The longitude of the first point.
        LatB (float): The latitude of the second point.
        LngB (float): The longitude of the second point.

    Returns:
        float: The range in meters.
    """
    try:
        dlat = LatB - LatA
        dlon = LngB - LngA

        distlat = earth_radius * m.sin(m.radians(dlat))
        distlon = earth_radius * m.sin(m.radians(dlon)) * m.cos(m.radians(LatA))

        dist = m.sqrt(distlat * distlat + distlon * distlon)
        
        return dist
    except Exception as e:
        log_error("Error in range_from_latlng", e)
        return 0

def bearing_from_latlng(LatA: float, LngA: float, LatB: float, LngB: float) -> float:
    """
    Calculate the bearing between two latitude and longitude points.

    Args:
        LatA (float): The latitude of the first point.
        LonA (float): The longitude of the first point.
        LatB (float): The latitude of the second point.
        LonB (float): The longitude of the second point.

    Returns:
        float: The bearing in degrees.
    """
    try:
        dlat = LatB - LatA
        dlon = LngB - LngA
        
        distlat = earth_radius * m.sin(m.radians(dlat))
        distlon = earth_radius * m.sin(m.radians(dlon)) * m.cos(m.radians(LatA))

        ang = m.atan2(distlon, distlat) / (m.pi / 180)
                                                              
        if ang < 0:  
            ang += 360
                                                              
        return ang
    except Exception as e:
        log_error("Error in bearing_from_latlng", e)
        return 0