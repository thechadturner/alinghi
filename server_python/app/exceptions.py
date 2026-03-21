import logging
from fastapi import Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from app.utils.response import send_response

logger = logging.getLogger(__name__)

def register_exception_handlers(app):
    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        logger.warning(f"HTTP Exception: {exc.status_code} - {exc.detail} - {request.url}")
        return send_response(
            success=False,
            message=exc.detail,
            data=None,
            status_code=exc.status_code
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        logger.warning(f"Validation Error: {exc.errors()} - {request.url}")
        return send_response(
            success=False,
            message="Validation error",
            data={"errors": exc.errors()},
            status_code=422
        )

    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        logger.error(f"Unhandled Exception: {str(exc)} - {request.url}", exc_info=True)
        return send_response(
            success=False,
            message="Internal server error",
            data=None,
            status_code=500
        )
