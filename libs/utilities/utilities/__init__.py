from .math_utils import *
from .string_utils import *
from .datetime_utils import *
from .geo_utils import *
from .weather_utils import *
from .api_utils import *
from .race_utils import *
from .wind_utils import *
from .interp_utils import *
from .ai_utils import *
from .localstorage import *
from .logging_utils import log_error, log_warning, log_info, log_debug

# Backward compatibility: ensure removeGaps alias is available
from .race_utils import removeGaps

# Explicitly export ewm360 to ensure it's available
from .math_utils import ewm360

# Explicitly export vectorized functions to ensure they're available
from .wind_utils import computeStw_vectorized, computeTrueWind_vectorized