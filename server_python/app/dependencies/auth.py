import logging
import json
from fastapi import Request, HTTPException, Depends
from jose import JWTError, jwt
import httpx
from dotenv import load_dotenv
from pathlib import Path
import os

# Initialize logger early so it can be used during environment loading
logger = logging.getLogger(__name__)

# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/app/dependencies/)
project_root = Path(__file__).parent.parent.parent.parent

# Load environment files based on mode
# Development: .env -> .env.local
# Production: .env.production -> .env.production.local
base_env_file = ".env.production" if is_production else ".env"
local_env_file = ".env.production.local" if is_production else ".env.local"

base_env_path = project_root / base_env_file
local_env_path = project_root / local_env_file

# Load environment files (matching Node.js server pattern)
# Priority: Docker env vars (set by Docker Compose) > .env.production.local > .env.production
# In Docker containers, files don't exist but Docker Compose sets env vars from env_file: entries
# In local development, files exist and are loaded as fallback

base_env_exists = base_env_path.exists()
local_env_exists = local_env_path.exists()

logger.info(f"🔐 Environment loading: NODE_ENV={os.getenv('NODE_ENV', 'undefined')}, is_production={is_production}")
logger.info(f"🔐 Environment files: base={base_env_file} (exists={base_env_exists}), local={local_env_file} (exists={local_env_exists})")

# Load base .env file first (defaults) - don't override existing env vars (Docker has priority)
if base_env_exists:
    load_dotenv(dotenv_path=base_env_path, override=False)
    logger.info(f"✅ Loaded base environment from {base_env_path}")
else:
    logger.debug(f"⚠️  Base environment file {base_env_path} not found (expected in Docker containers, Docker env vars will be used)")

# Load local .env file second (overrides base, gitignored secrets) - override to allow local secrets to override base
if local_env_exists:
    load_dotenv(dotenv_path=local_env_path, override=True)
    logger.info(f"✅ Loaded local environment from {local_env_path}")
else:
    logger.debug(f"⚠️  Local environment file {local_env_path} not found (expected in Docker containers, Docker env vars will be used)")

# Get environment variables
# Precedence: Docker env vars (highest) > .env.production.local > .env.production > defaults
# Docker Compose env_file: entries set these as environment variables before Python starts
JWT_SECRET = os.getenv("JWT_SECRET")
JWT_ISSUER = os.getenv("JWT_ISSUER", "racesight-auth")  # Default from .env.production
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "racesight-servers")  # Default from .env.production

# Log the values being used (masked for security) - helps debug which source provided the values
logger.info(f"🔐 JWT Config loaded: ISSUER={'SET' if JWT_ISSUER else 'NOT SET'}, AUDIENCE={'SET' if JWT_AUDIENCE else 'NOT SET'}, SECRET={'SET' if JWT_SECRET else 'NOT SET'}")
SYSTEM_KEY = os.getenv("SYSTEM_KEY")  # This will be used as PAT
PAT_TOKEN = os.getenv("PAT_TOKEN", SYSTEM_KEY)  # PAT token (fallback to SYSTEM_KEY for backward compatibility)
APP_PORT = os.getenv("APP_PORT", "8069")
# API_HOST should be just the hostname/IP, not include http:// or https://
api_host_raw = os.getenv("API_HOST", "host.docker.internal")
# Strip protocol if user included it
API_HOST = api_host_raw.replace("http://", "").replace("https://", "").strip()
# Read VALIDATE_WITH_EXTERNAL_SERVICE - explicitly check for "true" (case-insensitive)
# Any other value (false, empty, None) will result in False
validate_env = os.getenv("VALIDATE_WITH_EXTERNAL_SERVICE", "false")
VALIDATE_WITH_EXTERNAL_SERVICE = str(validate_env).strip().lower() == "true"

# Log the validation setting at startup for debugging
logger.info(f"🔐 Authentication config: VALIDATE_WITH_EXTERNAL_SERVICE={VALIDATE_WITH_EXTERNAL_SERVICE}, PAT_TOKEN={'configured' if PAT_TOKEN else 'not configured'}, SYSTEM_KEY={'configured' if SYSTEM_KEY else 'not configured'}")

def get_user_id(request: Request) -> str:
    """
    Helper function to get user_id from request (similar to Node.js req.user?.user_id)
    """
    if hasattr(request.state, 'user') and request.state.user:
        return request.state.user.get('user_id')
    return None

def get_user(request: Request) -> dict:
    """
    Helper function to get full user object from request (similar to Node.js req.user)
    """
    if hasattr(request.state, 'user') and request.state.user:
        return request.state.user
    return None

def validate_pat_token(token: str) -> dict:
    """
    Validate Personal Access Token (PAT)
    Returns user info if valid, None if invalid
    """
    if not PAT_TOKEN:
        logger.warning("No PAT_TOKEN configured")
        return None
    
    if token == PAT_TOKEN:
        # PAT is valid - return a standard user object
        return {
            "user_id": "system",
            "username": "system",
            "email": "system@internal",
            "role": "system",
            "permissions": ["read", "write", "admin"],
            "auth_type": "pat",
            "iat": None,
            "exp": None
        }
    
    return None

async def authenticate(request: Request):
    try:
        # Authentication started - minimal logging
        
        # Get token from cookies first (matching Node.js behavior), then Authorization header
        token = None
        auth_source = None
        
        # Check cookies first (like Node.js req.cookies?.auth_token)
        if request.cookies and "auth_token" in request.cookies:
            token = request.cookies.get("auth_token")
            auth_source = "cookie"
            # Token found in cookies
        # Fall back to Authorization header
        elif "Authorization" in request.headers:
            auth_header = request.headers.get("Authorization")
            token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else auth_header
            auth_source = "header"
            # Token found in Authorization header
        else:
            # No token found in headers or cookies
            pass
        
        if not token:
            logger.warning(f"❌ No auth token provided for {request.url}")
            logger.warning(f"   Available headers: {list(request.headers.keys())}")
            logger.warning(f"   Available cookies: {list(request.cookies.keys()) if request.cookies else 'None'}")
            raise HTTPException(status_code=401, detail="Unauthorized: No token provided")
        
        # Try PAT authentication first (simpler and faster)
        # Attempting PAT authentication
        pat_user = validate_pat_token(token)
        if pat_user:
            # PAT authentication successful
            # Add client IP and store user info in request state
            client_ip = request.client.host if request.client else "unknown"
            pat_user["client_ip"] = client_ip
            pat_user["auth_source"] = auth_source
            request.state.user = pat_user
            return pat_user
        
        # Fall back to JWT authentication
        # PAT authentication failed, trying JWT
        
        # Check if JWT_SECRET is configured
        if not JWT_SECRET:
            logger.error("❌ JWT_SECRET not configured. Please set JWT_SECRET in your .env file")
            raise HTTPException(status_code=500, detail="Server configuration error: JWT_SECRET not set")
        else:
            # JWT_SECRET configured
            pass

        # Decode and validate JWT token
        try:
            # Try to decode with standard validation first (including audience and issuer)
            try:
                decoded = jwt.decode(
                    token, 
                    JWT_SECRET, 
                    algorithms=["HS256"],
                    audience=JWT_AUDIENCE,
                    issuer=JWT_ISSUER
                )
                # JWT Token successfully decoded with standard validation
            except JWTError as validation_error:
                error_msg = str(validation_error).lower()
                logger.warning(f"⚠️  Standard validation failed: {validation_error}")
                
                # Try with relaxed validation options
                if any(keyword in error_msg for keyword in ["audience", "aud", "issuer", "iss", "expired", "exp"]):
                    # Trying with relaxed validation options
                    decoded = jwt.decode(
                        token, 
                        JWT_SECRET, 
                        algorithms=["HS256"], 
                        options={
                            "verify_aud": False,  # Don't verify audience
                            "verify_iss": False,  # Don't verify issuer
                            "verify_exp": True,   # Still verify expiration
                            "verify_iat": False,  # Don't verify issued at
                            "verify_nbf": False   # Don't verify not before
                        }
                    )
                    # JWT Token successfully decoded with relaxed validation
                else:
                    raise validation_error
            
            # Token payload decoded
        except JWTError as e:
            logger.error(f"❌ JWT Error: {str(e)}")
            raise HTTPException(status_code=401, detail="Invalid token")
        
        # Extract user information from token
        user_id = decoded.get("user_id")
        # User ID extracted from token
        
        if not user_id:
            logger.error("❌ No user_id found in token payload")
            raise HTTPException(status_code=401, detail="Invalid token payload: missing user_id")
        
        # Add auth type to JWT user info
        decoded["auth_type"] = "jwt"

        # Optional: Validate user with external service (disabled by default)
        if VALIDATE_WITH_EXTERNAL_SERVICE:
            validation_url = f"http://{API_HOST}:{APP_PORT}/api/users/active?id={user_id}"
            logger.info(f"🔍 Validating user {user_id} with external service at {validation_url}")
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.get(
                        validation_url,
                        headers={"Authorization": f"Bearer {token}"}
                    )

                logger.debug(f"User service response: status={response.status_code}, headers={dict(response.headers)}")
                
                if response.status_code == 200:
                    try:
                        # Try to parse as JSON first
                        try:
                            data = response.json()
                            logger.debug(f"User service response data: {data}")
                            
                            # Handle different response formats:
                            # 1. {success: true/false} format
                            if "success" in data:
                                if data.get("success") is True:
                                    logger.info(f"✅ User {user_id} validated successfully")
                                else:
                                    logger.warning(f"❌ User validation failed for {user_id}: {data.get('message', 'User not active')}")
                                    raise HTTPException(status_code=401, detail=f"Unauthorized: {data.get('message', 'User not active')}")
                            # 2. {value: true/false} format (from isUserActive function)
                            elif "value" in data:
                                if data.get("value") is True:
                                    logger.info(f"✅ User {user_id} validated successfully (value=true)")
                                else:
                                    logger.warning(f"❌ User validation failed for {user_id}: User is not active")
                                    raise HTTPException(status_code=401, detail="Unauthorized: User is not active")
                            # 3. Direct boolean response
                            elif isinstance(data, bool):
                                if data is True:
                                    logger.info(f"✅ User {user_id} validated successfully (boolean=true)")
                                else:
                                    logger.warning(f"❌ User validation failed for {user_id}: User is not active")
                                    raise HTTPException(status_code=401, detail="Unauthorized: User is not active")
                            # 4. If no success/value field, assume valid if we got a response
                            else:
                                logger.info(f"✅ User {user_id} validated (no explicit success/value field, assuming valid)")
                        except ValueError:
                            # Response is not JSON, try to parse as plain text/boolean
                            response_text = response.text.strip().lower()
                            logger.debug(f"User service response (non-JSON): {response_text}")
                            if response_text in ["true", "1", "yes", "active"]:
                                logger.info(f"✅ User {user_id} validated successfully (text response)")
                            elif response_text in ["false", "0", "no", "inactive"]:
                                logger.warning(f"❌ User validation failed for {user_id}: User is not active")
                                raise HTTPException(status_code=401, detail="Unauthorized: User is not active")
                            else:
                                # Unknown format, assume valid
                                logger.info(f"✅ User {user_id} validated (unknown response format, assuming valid)")
                    except HTTPException:
                        # Re-raise HTTP exceptions
                        raise
                    except Exception as json_error:
                        logger.error(f"❌ Failed to parse user service response: {json_error}")
                        logger.error(f"   Response text: {response.text[:200]}")
                        raise HTTPException(status_code=503, detail="Authentication service returned invalid response")
                else:
                    response_text = response.text[:200] if hasattr(response, 'text') else "No response body"
                    logger.warning(f"❌ User validation failed for {user_id} - HTTP {response.status_code}: {response_text}")
                    raise HTTPException(status_code=401, detail=f"Unauthorized: User validation failed (HTTP {response.status_code})")
            except httpx.TimeoutException as e:
                logger.error(f"⏱️  User service connection timeout: {str(e)}")
                raise HTTPException(status_code=503, detail="Authentication service timeout")
            except httpx.RequestError as e:
                logger.error(f"🔌 User service connection error: {str(e)}")
                logger.error(f"   Attempted URL: {validation_url}")
                logger.error(f"   API_HOST={API_HOST}, APP_PORT={APP_PORT}")
                raise HTTPException(status_code=503, detail="Authentication service unavailable")
        else:
            # External user validation disabled - skip validation
            logger.debug(f"External user validation disabled, skipping validation for user {user_id}")
            pass

        # Add client IP and store user info in request state (matching Node.js req.user)
        client_ip = request.client.host if request.client else "unknown"
        decoded["client_ip"] = client_ip
        decoded["auth_source"] = auth_source
        
        # Store user info in request state (matching Node.js req.user pattern)
        request.state.user = decoded
        
        # JWT Authentication successful
        
        return decoded
        
    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        logger.error(f"Unexpected auth error: {str(e)}")
        raise HTTPException(status_code=500, detail="Authentication error")
