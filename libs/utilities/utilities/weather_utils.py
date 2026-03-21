import math as m
from .logging_utils import log_error
from typing import Optional

def fahrenheit_to_celsius(fahrenheit: float) -> float:
    """
    Convert temperature from Fahrenheit to Celsius.

    Args:
        fahrenheit (float): Temperature in Fahrenheit.

    Returns:
        float: Temperature in Celsius.
    """
    return (fahrenheit - 32) * 5 / 9

def fahrenheit_to_kelvin(fahrenheit: float) -> float:
    """
    Convert temperature from Fahrenheit to Kelvin.

    Args:
        fahrenheit (float): Temperature in Fahrenheit.

    Returns:
        float: Temperature in Kelvin.
    """
    return (fahrenheit - 32) * 5 / 9 + 273.15

def saturation_vapor_pressure(T_kelvin: float) -> float:
    """
    Compute saturation vapor pressure in Pa given temperature in Kelvin using Magnus-Tetens formula.

    Args:
        T_kelvin (float): Temperature in Kelvin.

    Returns:
        float: Saturation vapor pressure in Pascals.
    """
    T_celsius = T_kelvin - 273.15
    return 610.94 * m.exp(17.625 * T_celsius / (T_celsius + 243.04))

def compute_air_density(temperature_F: float, dewpoint_F: float, pressure_inHg: float) -> Optional[float]:
    """
    Compute air density given temperature, dewpoint, and pressure.

    Args:
        temperature_F (float): Temperature in Fahrenheit.
        dewpoint_F (float): Dewpoint in Fahrenheit.
        pressure_inHg (float): Pressure in inches of mercury.

    Returns:
        float: Air density in kg/m^3.
    """
    # Constants
    R = 287.05  # Specific gas constant for dry air, J/(kg·K)
    mmHg_to_Pa = 133.322  # Conversion factor from mmHg to Pascal
    inHg_to_mmHg = 25.4  # Conversion factor from inHg to mmHg

    try:
        # Convert pressure to Pascals
        pressure_Pa = pressure_inHg * inHg_to_mmHg * mmHg_to_Pa

        # Convert temperatures to Kelvin
        temperature_K = fahrenheit_to_kelvin(temperature_F)
        dewpoint_K = fahrenheit_to_kelvin(dewpoint_F)

        # Calculate saturation vapor pressures
        e_sat_temperature = saturation_vapor_pressure(temperature_K)
        e_sat_dewpoint = saturation_vapor_pressure(dewpoint_K)

        # Relative humidity calculation
        relative_humidity = e_sat_dewpoint / e_sat_temperature

        # Virtual temperature adjustment
        virtual_temperature = temperature_K / (1 - (0.378 * relative_humidity * e_sat_dewpoint / pressure_Pa))

        # Air density calculation
        density = pressure_Pa / (R * virtual_temperature)
        
        return density
    except Exception as e:
        log_error("Error in compute_air_density", e)
        return None