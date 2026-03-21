from fastapi.responses import JSONResponse
from typing import Any, Optional

def send_response(
    success: bool,
    message: str,
    data: Optional[Any] = None,
    status_code: int = 200
) -> JSONResponse:
    """
    Standardized response format for the API
    """
    response_data = {
        "success": success,
        "message": message,
        "data": data
    }
    
    return JSONResponse(
        content=response_data,
        status_code=status_code
    )
