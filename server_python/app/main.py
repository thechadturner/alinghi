import logging
from fastapi import FastAPI, BackgroundTasks, Depends, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import subprocess
import json
import os
import sys
import uuid
import traceback
from dotenv import load_dotenv
from app.dependencies.auth import authenticate
from app.exceptions import register_exception_handlers
from app.utils.response import send_response
from typing import Dict, List
import asyncio
from datetime import datetime
from contextlib import asynccontextmanager

# Define ScriptExecuteRequest model
class ScriptExecuteRequest(BaseModel):
    class_name: str
    script_name: str
    parameters: dict

# Constants for script execution
SCRIPT_TIMEOUT_SECONDS = 3600  # 1 hour timeout
MAX_LOOP_ITERATIONS = 1000000  # Safety limit to prevent infinite loops
READ_LOOP_SLEEP_SECONDS = 0.05  # Sleep between output reads
PROGRESS_LOG_INTERVAL_SECONDS = 30  # Log progress every 30 seconds
KEEPALIVE_INTERVAL_SECONDS = 30  # SSE keepalive interval
GRACEFUL_SHUTDOWN_WAIT_SECONDS = 2  # Wait time for graceful process shutdown
PROCESS_WAIT_TIMEOUT_SECONDS = 5  # Timeout for process.wait()
CONNECTION_TIMEOUT_SECONDS = 3600  # 1 hour timeout for stale SSE connections
HEARTBEAT_TIMEOUT_SECONDS = 300  # 5 minutes without activity = dead connection
CLEANUP_INTERVAL_SECONDS = 60  # Run cleanup every 60 seconds

# Error/Warning detection keywords
ERROR_KEYWORDS = ['error', 'exception', 'traceback', 'failed']
WARNING_KEYWORDS = ['warning', 'warn', 'deprecated']

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Verbose logging control
VITE_VERBOSE = os.getenv("VITE_VERBOSE", "false").lower() == "true"

def log_verbose(message: str, level: str = "info"):
    """Log message only if verbose mode is enabled"""
    if VITE_VERBOSE:
        if level == "info":
            logger.info(message)
        elif level == "warning":
            logger.warning(message)
        elif level == "error":
            logger.error(message)
        elif level == "debug":
            logger.debug(message)
        else:
            logger.info(message)

# 🔐 Load secrets from .env files
# Determine environment mode
is_production = os.getenv("NODE_ENV") == "production"

# Get project root (three levels up from server_python/app/)
project_root = Path(__file__).parent.parent.parent

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
SYSTEM_KEY = os.getenv("SYSTEM_KEY")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:3001")

# Log the values being used (masked for security) - helps debug which source provided the values
logger.info(f"🔐 JWT Config loaded: ISSUER={'SET' if JWT_ISSUER else 'NOT SET'}, AUDIENCE={'SET' if JWT_AUDIENCE else 'NOT SET'}, SECRET={'SET' if JWT_SECRET else 'NOT SET'}")

# Lifespan context manager for startup/shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle - startup and shutdown"""
    # Startup
    logger.info("Starting up Python Service...")
    
    # Start SSE cleanup task to prevent memory leaks
    await sse_manager.start_cleanup_task()
    
    # Create necessary directories
    scripts_dir = Path(__file__).parent.parent / "scripts"
    scripts_dir.mkdir(exist_ok=True)
    
    # Prewarm Python
    try:
        proc = subprocess.Popen(
            [sys.executable, "-c", "print('Prewarming complete')"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = proc.communicate()
        if stdout:
            logger.info(f"Prewarming Output: {stdout.decode()}")
        if stderr:
            logger.warning(f"Prewarming Error: {stderr.decode()}")
        logger.info(f"Prewarming finished with code {proc.returncode}")
    except Exception as e:
        logger.error(f"Prewarming failed: {str(e)}")
    
    yield  # Application runs here
    
    # Shutdown
    logger.info("Shutting down Python Service...")
    # Stop SSE cleanup task
    await sse_manager.stop_cleanup_task()
    # Clean up all remaining connections
    for user_id in list(sse_manager.user_queues.keys()):
        sse_manager.unsubscribe(user_id)
    logger.info("SSE connections cleaned up")

app = FastAPI(
    title="Python Service API",
    lifespan=lifespan,
    description="""
    ## Python Script Execution Service
    
    A FastAPI service for executing Python scripts with real-time progress monitoring via Server-Sent Events (SSE).
    
    ### Features
    - **Script Execution**: Execute Python scripts with real-time output streaming
    - **Progress Monitoring**: Real-time progress updates via SSE
    - **Authentication**: JWT and Personal Access Token (PAT) support
    - **CORS Support**: Configurable CORS origins for frontend integration
    - **Process Management**: Unique process IDs for tracking executions
    - **Error Handling**: Comprehensive error reporting and logging
    
    ### Authentication
    All endpoints (except health check) require authentication via:
    - **JWT Token**: Passed in `Authorization: Bearer <token>` header
    - **Personal Access Token**: Passed in `Authorization: Bearer <pat>` header
    
    ### Real-time Updates
    Use the `/api/sse` endpoint to receive real-time updates about script execution progress.
    """,
    version="1.0.0",
    contact={
        "name": "Python Service API",
        "email": "support@example.com",
    },
    license_info={
        "name": "MIT",
        "url": "https://opensource.org/licenses/MIT",
    },
    servers=[
        {
            "url": "http://localhost:8049",
            "description": "Development server"
        },
        {
            "url": "https://api.example.com",
            "description": "Production server"
        }
    ]
)

# Register exception handlers
register_exception_handlers(app)

# Global registry to track running processes by process_id
# Format: {process_id: {"proc": subprocess.Popen, "script_name": str, "class_name": str, "started_at": datetime}}
running_processes: Dict[str, dict] = {}

# 🌍 Allow CORS using CORS_ORIGINS from environment
# Example: CORS_ORIGINS="http://localhost:3000,https://app.example.com"
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
_parsed_origins = [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()] if CORS_ORIGINS else ["*"]

# If credentials are used, browsers require a specific origin (no '*').
# We'll honor provided origins; if '*' is provided, we'll allow all but SSE will echo request origin when possible.
allow_origins_cfg = ["*"] if _parsed_origins == ["*"] else _parsed_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins_cfg,
    allow_origin_regex=None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

def log_script_event(script_path, status, message, level="info"):
    dt = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    script = str(script_path)
    log_msg = f"[{dt}] [script: {script}] [status: {status}] {message}"
    if level == "info":
        logger.info(log_msg)
    elif level == "warning":
        logger.warning(log_msg)
    elif level == "error":
        logger.error(log_msg)
    else:
        logger.info(log_msg)

# =====================
# Helper Functions
# =====================
async def categorize_and_publish_output(
    line: str,
    user_id: str,
    process_id: str,
    script_path: Path,
    output_lines: list,
    error_lines: list,
    warning_lines: list,
    sse_manager
):
    """
    Categorize output line as error/warning/output and publish via SSE.
    
    Args:
        line: Output line to categorize
        user_id: User ID for SSE publishing
        process_id: Process ID for SSE event
        script_path: Path to script for logging
        output_lines: List to append regular output
        error_lines: List to append error lines
        warning_lines: List to append warning lines
        sse_manager: SSE manager instance for publishing
    """
    line_lower = line.lower()
    
    # Determine category
    if any(err_word in line_lower for err_word in ERROR_KEYWORDS):
        category = "ERROR"
        error_lines.append(line)
        log_level = "error"
    elif any(warn_word in line_lower for warn_word in WARNING_KEYWORDS):
        category = "WARNING"
        warning_lines.append(line)
        log_level = "warning"
    else:
        category = "OUTPUT"
        output_lines.append(line)
        log_level = "info"
    
    # Publish via SSE
    await sse_manager.publish(user_id, {
        "success": True,
        "event": {
            "process_id": process_id,
            "type": "script_execution",
            "event": "progress_event",
            "text": line,
            "now": int(datetime.now().timestamp() * 1000)
        },
        "data": {}
    })
    
    # Log the event
    log_script_event(script_path, category, line, level=log_level)

def terminate_process(proc, process_id: str):
    """
    Terminate a subprocess gracefully with fallback to force kill.
    
    Args:
        proc: subprocess.Popen instance
        process_id: Process ID for logging
    """
    try:
        logger.info(f"🛑 Terminating process {process_id}")
        if os.name == 'nt':
            proc.terminate()
        else:
            os.killpg(os.getpgid(proc.pid), subprocess.signal.SIGTERM)
    except Exception as term_error:
        logger.error(f"Error terminating process {process_id}: {str(term_error)}")

def force_kill_process(proc, process_id: str):
    """
    Force kill a subprocess that didn't terminate gracefully.
    
    Args:
        proc: subprocess.Popen instance
        process_id: Process ID for logging
    """
    try:
        logger.warning(f"⚠️ Process {process_id} didn't terminate, forcing kill")
        if os.name == 'nt':
            proc.kill()
        else:
            os.killpg(os.getpgid(proc.pid), subprocess.signal.SIGKILL)
    except Exception as kill_error:
        logger.error(f"Error killing process {process_id}: {str(kill_error)}")

# =====================
# SSE Event Management
# =====================
class SseEventManager:
    def __init__(self):
        self.user_queues: Dict[str, asyncio.Queue] = {}
        self.connection_timestamps: Dict[str, float] = {}  # Track when connections were established
        self.last_activity: Dict[str, float] = {}  # Track last activity (heartbeat or message)
        self.connection_timeout: int = CONNECTION_TIMEOUT_SECONDS
        self.heartbeat_timeout: int = HEARTBEAT_TIMEOUT_SECONDS
        self._cleanup_task: asyncio.Task = None
        self._cleanup_interval: int = CLEANUP_INTERVAL_SECONDS

    async def subscribe(self, user_id: str) -> asyncio.Queue:
        """Subscribe a user to SSE events and track connection"""
        current_time = asyncio.get_event_loop().time()
        
        if user_id not in self.user_queues:
            self.user_queues[user_id] = asyncio.Queue()
            self.connection_timestamps[user_id] = current_time
            log_verbose(f"📡 New SSE subscription for user {user_id}")
        
        # Update last activity
        self.last_activity[user_id] = current_time
        
        return self.user_queues[user_id]

    def unsubscribe(self, user_id: str):
        """Unsubscribe a user and clean up tracking data"""
        if user_id in self.user_queues:
            del self.user_queues[user_id]
            log_verbose(f"📡 SSE unsubscribed user {user_id}")
        
        # Clean up tracking data
        self.connection_timestamps.pop(user_id, None)
        self.last_activity.pop(user_id, None)

    def update_activity(self, user_id: str):
        """Update last activity timestamp for a user (heartbeat or message received)"""
        if user_id in self.last_activity:
            self.last_activity[user_id] = asyncio.get_event_loop().time()

    def is_user_connected(self, user_id: str) -> bool:
        """Check if a user has an active SSE connection"""
        return user_id in self.user_queues

    async def publish(self, user_id: str, message: dict):
        """Publish a message to a user's queue"""
        if user_id not in self.user_queues:
            log_verbose(f"📡 No active SSE subscribers for user {user_id}, skipping message", "debug")
            return
        
        try:
            # Update activity when publishing
            self.update_activity(user_id)
            
            await self.user_queues[user_id].put(message)
            # Extract meaningful info from the message for logging
            event_text = "unknown"
            if message.get('data', {}).get('items'):
                event_text = message['data']['items'][0].get('text', 'unknown')
            log_verbose(f"📡 SSE message published to user {user_id}: {event_text}")
        except (KeyError, AttributeError) as e:
            # Queue was deleted or doesn't exist - clean up tracking data
            logger.error(f"📡 Failed to publish SSE message to user {user_id}: {str(e)}")
            self.unsubscribe(user_id)
        except Exception as e:
            logger.error(f"📡 Failed to publish SSE message to user {user_id}: {str(e)}")
            # If publish fails, consider connection dead and cleanup
            self.unsubscribe(user_id)

    async def cleanup_stale_connections(self):
        """Periodically clean up stale connections that haven't had activity"""
        current_time = asyncio.get_event_loop().time()
        stale_users = []
        
        for user_id, last_activity_time in list(self.last_activity.items()):
            time_since_activity = current_time - last_activity_time
            connection_age = current_time - self.connection_timestamps.get(user_id, current_time)
            
            # Mark as stale if:
            # 1. No activity for heartbeat_timeout (5 minutes)
            # 2. Connection age exceeds connection_timeout (1 hour)
            if time_since_activity > self.heartbeat_timeout or connection_age > self.connection_timeout:
                stale_users.append(user_id)
        
        # Clean up stale connections
        for user_id in stale_users:
            logger.warning(f"🧹 Cleaning up stale SSE connection for user {user_id} (inactive for {current_time - self.last_activity.get(user_id, current_time):.1f}s")
            self.unsubscribe(user_id)
        
        if stale_users:
            logger.info(f"🧹 Cleaned up {len(stale_users)} stale SSE connection(s). Active connections: {len(self.user_queues)}")
        
        return len(stale_users)

    async def start_cleanup_task(self):
        """Start the periodic cleanup task"""
        if self._cleanup_task is None or self._cleanup_task.done():
            async def cleanup_loop():
                while True:
                    try:
                        await asyncio.sleep(self._cleanup_interval)
                        await self.cleanup_stale_connections()
                    except asyncio.CancelledError:
                        logger.info("🧹 SSE cleanup task cancelled")
                        break
                    except Exception as e:
                        logger.error(f"🧹 Error in SSE cleanup task: {str(e)}")
            
            self._cleanup_task = asyncio.create_task(cleanup_loop())
            logger.info("🧹 SSE cleanup task started")

    async def stop_cleanup_task(self):
        """Stop the periodic cleanup task"""
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            logger.info("🧹 SSE cleanup task stopped")

    def get_stats(self) -> dict:
        """Get statistics about current SSE connections"""
        current_time = asyncio.get_event_loop().time()
        active_connections = len(self.user_queues)
        
        connection_ages = []
        for user_id in self.user_queues.keys():
            age = current_time - self.connection_timestamps.get(user_id, current_time)
            connection_ages.append(age)
        
        return {
            "active_connections": active_connections,
            "oldest_connection_age": max(connection_ages) if connection_ages else 0,
            "newest_connection_age": min(connection_ages) if connection_ages else 0,
            "average_connection_age": sum(connection_ages) / len(connection_ages) if connection_ages else 0,
            "total_queues": len(self.user_queues),
            "total_tracked_users": len(self.connection_timestamps)
        }

sse_manager = SseEventManager()

async def sse_event_stream(user_id: str):
    """SSE event stream generator with heartbeat and activity tracking"""
    queue = await sse_manager.subscribe(user_id)
    keepalive_interval_seconds = KEEPALIVE_INTERVAL_SECONDS
    last_keepalive = asyncio.get_event_loop().time()
    last_heartbeat_update = asyncio.get_event_loop().time()
    
    try:
        # Send initial connection message
        yield f"data: {json.dumps({'type': 'connection', 'message': 'SSE connection established'})}\n\n"
        # Update activity on connection
        sse_manager.update_activity(user_id)
        
        while True:
            now_ts = asyncio.get_event_loop().time()
            timeout = max(0.1, keepalive_interval_seconds - (now_ts - last_keepalive))
            
            try:
                message = await asyncio.wait_for(queue.get(), timeout=timeout)
                yield f"data: {json.dumps(message)}\n\n"
                # Update activity when message is received
                sse_manager.update_activity(user_id)
            except asyncio.TimeoutError:
                # Send keepalive comment to keep connection open
                yield ": keepalive\n\n"
                last_keepalive = asyncio.get_event_loop().time()
                
                # Update activity every 30 seconds (on keepalive)
                if now_ts - last_heartbeat_update >= KEEPALIVE_INTERVAL_SECONDS:
                    sse_manager.update_activity(user_id)
                    last_heartbeat_update = now_ts
                
    except asyncio.CancelledError:
        # Client disconnected - this is normal and expected
        log_verbose(f"📡 SSE client disconnected for user {user_id}")
        raise
    except Exception as e:
        logger.error(f"📡 SSE stream error for user {user_id}: {str(e)}")
        raise
    finally:
        # Always cleanup on disconnect
        sse_manager.unsubscribe(user_id)

@app.get(
    "/api/sse",
    summary="Server-Sent Events Stream",
    description="Real-time event stream for script execution progress",
    response_description="Server-Sent Events stream with script progress updates",
    tags=["Real-time"]
)
async def sse_endpoint(request: Request, token: str = Query(None)):
    """
    ## Server-Sent Events Stream
    
    Establishes a real-time event stream for receiving script execution progress updates.
    
    ### Authentication
    Supports authentication via:
    1. **Query Parameter**: `?token=<jwt_or_pat_token>` (recommended for SSE)
    2. **Authorization Header**: `Authorization: Bearer <token>` (fallback)
    
    ### Event Format
    Events are sent in the following format:
    ```json
    {
      "success": true,
      "event": {
        "process_id": "uuid",
        "type": "script_execution",
        "event": "progress_event|process_complete|process_timeout",
        "text": "Human readable message",
        "now": 1730000000000
      },
      "data": {}
    }
    ```
    
    ### Event Types
    - **progress_event**: Real-time output/progress updates
    - **process_complete**: Script finished successfully
    - **process_timeout**: Script timed out
    
    ### Usage
    
    #### Query Parameter (Recommended for SSE)
    ```javascript
    const eventSource = new EventSource('/api/sse?token=your-jwt-or-pat-token');
    
    eventSource.onmessage = function(event) {
      const data = JSON.parse(event.data);
      console.log('Event:', data.event.event, data.event.text);
    };
    ```
    
    #### Authorization Header (Fallback)
    ```javascript
    const eventSource = new EventSource('/api/sse', {
      headers: { 'Authorization': 'Bearer your-token' }
    });
    ```
    
    ### Headers
    - **Accept**: `text/event-stream`
    - **Cache-Control**: `no-cache`
    
    ### CORS
    Supports CORS with configurable origins via `CORS_ORIGINS` environment variable.
    """
    # Handle authentication - try query parameter first, then header
    auth_token = None
    user = None
    
    if token:
        # Token provided via query parameter
        auth_token = token
        log_verbose(f"📡 SSE endpoint called with query token")
    else:
        # Try to get token from Authorization header
        auth_header = request.headers.get("authorization")
        if auth_header and auth_header.startswith("Bearer "):
            auth_token = auth_header[7:]  # Remove "Bearer " prefix
            log_verbose(f"📡 SSE endpoint called with header token")
        else:
            raise HTTPException(status_code=401, detail="No token provided. Use ?token=<jwt_or_pat> query parameter or Authorization header.")
    
    if not auth_token:
        raise HTTPException(status_code=401, detail="No token provided")
    
    # Authenticate the token using the existing auth logic
    try:
        from app.dependencies.auth import validate_pat_token, JWT_SECRET
        from jose import JWTError, jwt
        import json
        
        # Try PAT authentication first
        pat_user = validate_pat_token(auth_token)
        if pat_user:
            user = pat_user
            log_verbose(f"✅ PAT authentication successful for SSE")
        else:
            # Try JWT authentication
            try:
                # Try standard validation first (including audience and issuer)
                try:
                    decoded = jwt.decode(
                        auth_token, 
                        JWT_SECRET, 
                        algorithms=["HS256"],
                        audience=JWT_AUDIENCE,
                        issuer=JWT_ISSUER
                    )
                    log_verbose(f"🔓 JWT Token successfully decoded with standard validation")
                except JWTError as validation_error:
                    error_msg = str(validation_error).lower()
                    log_verbose(f"⚠️  Standard validation failed: {validation_error}")
                    
                    # Try with relaxed validation options
                    if any(keyword in error_msg for keyword in ["audience", "aud", "issuer", "iss", "expired", "exp"]):
                        log_verbose(f"🔄 Trying with relaxed validation options...")
                        decoded = jwt.decode(
                            auth_token, 
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
                        log_verbose(f"🔓 JWT Token successfully decoded with relaxed validation")
                    else:
                        raise validation_error
                
                log_verbose(f"📋 Decoded token payload: {json.dumps(decoded, indent=2, default=str)}")
                
                # Create user object from JWT payload
                user = {
                    "user_id": decoded.get("user_id", decoded.get("sub", "unknown")),
                    "username": decoded.get("username", decoded.get("preferred_username", "unknown")),
                    "email": decoded.get("email", "unknown@example.com"),
                    "role": decoded.get("role", "user"),
                    "permissions": decoded.get("permissions", []),
                    "auth_type": "jwt",
                    "iat": decoded.get("iat"),
                    "exp": decoded.get("exp")
                }
                log_verbose(f"✅ JWT authentication successful for SSE")
                
            except JWTError as e:
                log_verbose(f"❌ JWT Error: {str(e)}")
                raise HTTPException(status_code=401, detail="Invalid token")
        
        if not user:
            raise HTTPException(status_code=401, detail="Authentication failed")
            
    except Exception as e:
        log_verbose(f"❌ Authentication error: {str(e)}")
        raise HTTPException(status_code=401, detail="Authentication failed")
    
    user_id = str(user.get("user_id", "anonymous"))
    log_verbose(f"📡 SSE endpoint called - user: {user_id}")
    # Build SSE response headers. Rely on CORSMiddleware for most CORS,
    # but for some browsers/proxies, explicitly echo the Origin when allowed.
    request_origin = request.headers.get("origin")
    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    }
    if request_origin:
        # If a specific set of origins is configured, only echo when allowed.
        if allow_origins_cfg != ["*"]:
            if request_origin in allow_origins_cfg:
                headers["Access-Control-Allow-Origin"] = request_origin
                headers["Access-Control-Allow-Credentials"] = "true"
        else:
            # Echo back the origin if wildcard configured; browsers require specific value when credentials are used
            headers["Access-Control-Allow-Origin"] = request_origin
            headers["Access-Control-Allow-Credentials"] = "true"
    log_verbose("✅ SSE endpoint connection established")
    return StreamingResponse(
        sse_event_stream(user_id),
        media_type="text/event-stream",
        headers=headers
    )


# Health check endpoint
@app.get(
    "/api/health",
    summary="Health Check",
    description="Check if the service is running and healthy",
    response_description="Service health status",
    tags=["System"]
)
async def health_check():
    """
    ## Health Check Endpoint
    
    Returns the current health status of the Python Service API.
    
    ### Returns
    - **200 OK**: Service is healthy and running
    - **data.status**: Always "ok" when service is running
    
    ### Usage
    This endpoint does not require authentication and can be used for:
    - Load balancer health checks
    - Service monitoring
    - Basic connectivity testing
    """
    logger.info("🏥 Health check endpoint called")
    result = send_response(
        success=True,
        message="Service is healthy",
        data={"status": "ok"}
    )
    log_verbose("✅ Health check endpoint returned: 200 OK")
    return result

# SSE Statistics endpoint for monitoring
@app.get(
    "/api/sse/stats",
    summary="SSE Connection Statistics",
    description="Get statistics about current SSE connections for monitoring and debugging",
    response_description="SSE connection statistics",
    tags=["System"],
    dependencies=[Depends(authenticate)]
)
async def sse_stats():
    """
    ## SSE Connection Statistics
    
    Returns statistics about current SSE connections including:
    - Active connection count
    - Connection ages
    - Memory usage indicators
    
    ### Returns
    ```json
    {
      "success": true,
      "message": "SSE statistics",
      "data": {
        "active_connections": 5,
        "oldest_connection_age": 3600.5,
        "newest_connection_age": 10.2,
        "average_connection_age": 1800.3,
        "total_queues": 5,
        "total_tracked_users": 5
      }
    }
    ```
    
    ### Usage
    This endpoint requires authentication and can be used for:
    - Monitoring SSE connection health
    - Detecting potential memory leaks
    - Debugging connection issues
    """
    stats = sse_manager.get_stats()
    log_verbose(f"📊 SSE stats requested: {stats}")
    return send_response(
        success=True,
        message="SSE statistics",
        data=stats
    )

# Progress polling endpoint
@app.get(
    "/api/scripts/progress",
    summary="Get Script Progress",
    description="Polling endpoint for script progress updates",
    response_description="Recent progress events since timestamp",
    tags=["Scripts"]
)
async def get_script_progress(since: int = 0, user: dict = Depends(authenticate)):
    """
    ## Get Script Progress
    
    Polling endpoint that returns recent script progress events since a given timestamp.
    
    ### Parameters
    - **since** (int, optional): Unix timestamp in milliseconds. Default: 0
      - Only returns events newer than this timestamp
      - Use 0 to get all recent events
    
    ### Authentication
    Requires valid JWT or PAT token in Authorization header.
    
    ### Returns
    ```json
    {
      "success": true,
      "message": "Progress endpoint active",
      "data": {
        "user_id": "user-123",
        "current_time": 1730000000000,
        "since": 0,
        "status": "running",
        "events": []
      }
    }
    ```
    
    ### Usage
    This is an alternative to SSE for clients that cannot use Server-Sent Events.
    Poll this endpoint periodically to get progress updates.
    
    ### Note
    Currently returns basic status information. In a full implementation,
    this would return actual progress events stored since the timestamp.
    """
    logger.info(f"📊 Progress endpoint called - since: {since}, user: {user.get('user_id', 'anonymous')}")
    user_id = str(user.get("user_id", "anonymous"))
    
    # For now, return a simple response indicating the service is running
    # In a more sophisticated implementation, you might store progress events
    # and return only those newer than the 'since' parameter
    current_time = int(datetime.now().timestamp() * 1000)
    
    result = send_response(
        success=True,
        message="Progress endpoint active",
        data={
            "user_id": user_id,
            "current_time": current_time,
            "since": since,
            "status": "running",
            "events": []  # Could be populated with actual progress events
        }
    )
    log_verbose("✅ Progress endpoint returned: 200 OK")
    return result

async def monitor_script_execution(
    process_id: str,
    proc: subprocess.Popen,
    script_path: Path,
    user_id: str,
    script_name: str,
    class_name: str,
    parameters: dict
):
    """
    Background task to monitor script execution, capture output, and send SSE updates.
    """
    # Get the running event loop to schedule blocking I/O in a thread pool
    loop = asyncio.get_running_loop()
    
    try:
        output_lines = []
        error_lines = []
        warning_lines = []
        start_time = asyncio.get_event_loop().time()
        
        # Read output in real-time with timeout protection
        loop_count = 0
        last_log_time = start_time
        last_output_time = start_time  # Track when we last received output
        last_output_count = 0  # Track output line count to detect progress
        HUNG_PROCESS_WARNING_INTERVAL = 300  # Warn if no output for 5 minutes
        
        while loop_count < MAX_LOOP_ITERATIONS:
            loop_count += 1
            current_time = asyncio.get_event_loop().time()
            elapsed_time = current_time - start_time
            
            # Log progress periodically to help debug hangs
            if current_time - last_log_time > PROGRESS_LOG_INTERVAL_SECONDS:
                process_running = proc.poll() is None
                time_since_last_output = current_time - last_output_time
                output_received = len(output_lines) > last_output_count
                
                log_verbose(f"🔄 Script execution loop: {loop_count} iterations, {elapsed_time:.1f}s elapsed, process running: {process_running}, output lines: {len(output_lines)}, time since last output: {time_since_last_output:.1f}s")
                last_log_time = current_time
                
                # Detect hung processes: process is running but no output for a while
                if process_running and time_since_last_output > HUNG_PROCESS_WARNING_INTERVAL:
                    logger.warning(f"⚠️ Process {process_id} may be hung: no output for {time_since_last_output:.1f}s (elapsed: {elapsed_time:.1f}s, output lines: {len(output_lines)})")
                    # Send a warning via SSE if user is connected
                    try:
                        if sse_manager.is_user_connected(user_id):
                            await sse_manager.publish(user_id, {
                                "success": True,
                                "event": {
                                    "process_id": process_id,
                                    "type": "script_execution",
                                    "event": "progress_event",
                                    "text": f"Warning: Process may be hung - no output for {int(time_since_last_output)}s",
                                    "now": int(datetime.now().timestamp() * 1000)
                                },
                                "data": {
                                    "warning": True,
                                    "time_since_last_output": int(time_since_last_output),
                                    "elapsed_time": int(elapsed_time)
                                }
                            })
                    except Exception as sse_warn_err:
                        logger.warning(f"Failed to send hung process warning via SSE: {str(sse_warn_err)}")
                
                # Update last output count if we received new output
                if output_received:
                    last_output_count = len(output_lines)
                    last_output_time = current_time
            
            # Check for timeout
            if current_time - start_time > SCRIPT_TIMEOUT_SECONDS:
                logger.warning(f"Script timeout after {SCRIPT_TIMEOUT_SECONDS} seconds, terminating...")
                terminate_process(proc, process_id)
                await asyncio.sleep(GRACEFUL_SHUTDOWN_WAIT_SECONDS)
                if proc.poll() is None:
                    force_kill_process(proc, process_id)
                
                await sse_manager.publish(user_id, {
                    "success": True,
                    "event": {
                        "process_id": process_id,
                        "type": "script_execution",
                        "event": "process_timeout",
                        "text": f"Script timed out after {SCRIPT_TIMEOUT_SECONDS} seconds",
                        "now": int(datetime.now().timestamp() * 1000)
                    },
                    "data": {}
                })
                
                log_script_event(script_path, "TIMEOUT", f"Script timeout after {SCRIPT_TIMEOUT_SECONDS} seconds", level="warning")
                
                # Clean up process from registry
                if process_id in running_processes:
                    del running_processes[process_id]
                return
            
            # Check if process is still running
            if proc.poll() is not None:
                # Process finished, read any remaining output
                try:
                    # Use run_in_executor to avoid blocking the event loop with large reads
                    remaining_output = await loop.run_in_executor(None, proc.stdout.read)
                    if remaining_output:
                        for line in remaining_output.strip().split('\n'):
                            if line.strip():
                                await categorize_and_publish_output(
                                    line, user_id, process_id, script_path,
                                    output_lines, error_lines, warning_lines, sse_manager
                                )
                except Exception as read_error:
                    logger.error(f"Error reading final output: {str(read_error)}")
                break
            
            # Read stdout (merged with stderr)
            try:
                # Use run_in_executor to avoid blocking the event loop with synchronous I/O
                # This is CRITICAL for preventing server hangs during script execution
                output = await loop.run_in_executor(None, proc.stdout.readline)
                if output:
                    line = output.strip()
                    if line:
                        # Update last output time when we receive output
                        last_output_time = asyncio.get_event_loop().time()
                        last_output_count = len(output_lines)
                        
                        await categorize_and_publish_output(
                            line, user_id, process_id, script_path,
                            output_lines, error_lines, warning_lines, sse_manager
                        )
            except Exception as stdout_error:
                logger.error(f"Error reading stdout: {str(stdout_error)}")
            
            # Small sleep to prevent CPU spinning
            await asyncio.sleep(READ_LOOP_SLEEP_SECONDS)
            
            # Safety check - if we hit the loop limit, something is wrong (check inside loop)
            if loop_count >= MAX_LOOP_ITERATIONS:
                break  # Exit the while loop
        
        # Safety check - if we hit the loop limit, something is wrong
        return_code = 0
        if loop_count >= MAX_LOOP_ITERATIONS:
            logger.error(f"⚠️ Script execution loop hit safety limit ({MAX_LOOP_ITERATIONS} iterations), forcing exit")
            terminate_process(proc, process_id)
            return_code = -1
        else:
            # Wait for process to complete (with timeout)
            try:
                # Use run_in_executor to avoid blocking the event loop during wait
                return_code = await loop.run_in_executor(None, lambda: proc.wait(timeout=PROCESS_WAIT_TIMEOUT_SECONDS))
            except subprocess.TimeoutExpired:
                logger.warning("Process didn't exit cleanly, forcing termination")
                force_kill_process(proc, process_id)
                return_code = -1
            except Exception as e:
                logger.error(f"Error waiting for process: {str(e)}")
                # If we can't get return code, assume error or check poll
                return_code = proc.poll() if proc.poll() is not None else -1
        
        # Clean up process from registry
        if process_id in running_processes:
            del running_processes[process_id]
        
        # Prepare results - treat warnings as acceptable
        script_succeeded = return_code == 0 or (return_code != 0 and error_lines == [] and warning_lines)
        
        # Publish SSE completion event
        try:
            completion_data = {
                "return_code": return_code,
                "script_succeeded": script_succeeded,
                "error_lines": error_lines,
                "warning_lines": warning_lines
            }
            
            logger.info(f"📤 Preparing to send completion event for process {process_id} (return_code={return_code}, succeeded={script_succeeded})")
            
            # Check if user has active SSE connection
            if sse_manager.is_user_connected(user_id):
                # User is connected via SSE - send notification via SSE
                await sse_manager.publish(user_id, {
                    "success": True,
                    "event": {
                        "process_id": process_id,
                        "type": "script_execution",
                        "event": "process_complete",
                        "text": f"{script_name} done",
                        "now": int(datetime.now().timestamp() * 1000)
                    },
                    "data": completion_data
                })
                logger.info(f"✅ Process completion sent via SSE to user {user_id} for process {process_id}")
            else:
                # User not connected via SSE; email notifications disabled
                is_batch_process = parameters.get('batch', False) if parameters else False
                if is_batch_process:
                    logger.info(f"📧 User {user_id} not connected via SSE (batch process) for process {process_id}")
            
            if script_succeeded:
                log_script_event(script_path, "COMPLETE", f"Script completed successfully with code: {return_code}", level="info")
            else:
                log_script_event(script_path, "ERROR", f"Script failed with code: {return_code}", level="error")
        except Exception as sse_err:
            logger.error(f"❌ SSE/Email notification failed for process {process_id}: {str(sse_err)}")
    
    except Exception as e:
        error_msg = f"Script execution failed: {str(e)}"
        error_traceback = traceback.format_exc()
        logger.error(f"💥 Monitor script execution error: {error_msg}")
        logger.error(f"💥 Full traceback:\n{error_traceback}")
        
        # Try to log script event
        if script_path:
            try:
                log_script_event(script_path, "FAILED", error_msg, level="error")
            except Exception:
                pass
        
        # Ensure process is cleaned up
        try:
            if proc and proc.poll() is None:
                terminate_process(proc, process_id)
                await asyncio.sleep(1)
                if proc.poll() is None:
                    force_kill_process(proc, process_id)
        except Exception:
            pass
        
        # Clean up process from registry
        try:
            if process_id in running_processes:
                del running_processes[process_id]
        except Exception:
            pass
            
        # Publish SSE error event
        try:
            if sse_manager.is_user_connected(user_id):
                await sse_manager.publish(user_id, {
                    "success": True,
                    "event": {
                        "process_id": process_id,
                        "type": "script_execution",
                        "event": "process_complete",
                        "text": error_msg,
                        "now": int(datetime.now().timestamp() * 1000)
                    },
                    "data": {
                        "return_code": -1,
                        "script_succeeded": False,
                        "error_lines": [error_msg],
                        "warning_lines": []
                    }
                })
            else:
                # Email notifications disabled
                pass
        except Exception:
            pass

# ⚙️ Execute Python script with real-time progress
@app.post(
    "/api/execute_script/",
    summary="Execute Python Script",
    description="Execute a Python script with real-time progress monitoring",
    response_description="Script execution results with process ID",
    tags=["Scripts"]
)
async def execute_script(
    request: ScriptExecuteRequest,
    user: dict = Depends(authenticate)
):
    """
    ## Execute Python Script
    
    Executes a Python script with real-time progress monitoring via SSE.
    
    ### Request Body
    ```json
    {
      "class_name": "ac40",
      "script_name": "0_map.py",
      "parameters": {
        "param1": "value1",
        "param2": "value2"
      }
    }
    ```
    
    ### Parameters
    - **class_name** (string): Script category/class (e.g., "ac40")
    - **script_name** (string): Script filename (e.g., "0_map.py" or "0_map")
    - **parameters** (object): Parameters to pass to the script
    
    ### Authentication
    Requires valid JWT or PAT token in Authorization header.
    
    ### Real-time Updates
    Subscribe to `/api/sse` to receive real-time progress updates:
    - Script start notification
    - Real-time output streaming
    - Error and warning messages
    - Completion notification
    
    ### Response Format
    
    #### Success (200 OK)
    ```json
    {
      "success": true,
      "message": "Script executed successfully",
      "data": {
        "process_id": "uuid",
        "results": {...},
        "return_code": 0,
        "output_lines": [...],
        "warning_lines": [...],
        "error_lines": [...],
        "user_id": "user-123"
      }
    }
    ```
    
    #### Failure (500 Internal Server Error)
    ```json
    {
      "success": false,
      "message": "Script execution failed",
      "data": {
        "process_id": "uuid",
        "return_code": 1,
        "error_lines": ["Error message"],
        "warning_lines": [...],
        "output_lines": [...],
        "user_id": "user-123"
      }
    }
    ```
    
    #### Timeout (408 Request Timeout)
    ```json
    {
      "success": false,
      "message": "Script execution timed out",
      "data": {
        "process_id": "uuid",
        "return_code": -1,
        "timeout": true,
        "output_lines": [...],
        "error_lines": [...],
        "warning_lines": [...],
        "user_id": "user-123"
      }
    }
    ```
    
    ### Timeout
    Scripts have a 1-hour timeout limit. Longer-running scripts should use the background execution endpoint.
    
    ### Process ID
    Each execution gets a unique `process_id` that can be used to track events via SSE.
    """
    try:
        log_verbose(f"🚀 Execute script endpoint called - script: {request.class_name}/{request.script_name}, user: {user.get('user_id', 'anonymous')}")
    except Exception as log_err:
        logger.error(f"Error in initial logging: {str(log_err)}")
    
    # Initialize variables that might be needed in exception handler
    process_id = None
    script_path = None
    proc = None
    user_id = None
    
    try:
        user_id = str(user.get("user_id", "unknown"))
        
        # Handle script name - add .py extension only if not already present
        script_name = request.script_name
        if not script_name.endswith('.py'):
            script_name += '.py'
        
        # Build script directory path
        scripts_dir = Path(__file__).parent.parent / "scripts" / request.class_name.lower()
        
        # Check if scripts directory exists
        if not scripts_dir.exists() or not scripts_dir.is_dir():
            logger.error(f"❌ Script directory not found: {scripts_dir}")
            raise HTTPException(status_code=404, detail=f"Script directory not found: {scripts_dir}")
        
        # Case-insensitive file lookup (for cross-platform compatibility)
        # First try exact match, then try case-insensitive search
        script_path = scripts_dir / script_name
        
        if not script_path.exists():
            # Try case-insensitive search
            script_name_lower = script_name.lower()
            try:
                matching_files = [f for f in scripts_dir.iterdir() if f.is_file() and f.name.lower() == script_name_lower]
            except (FileNotFoundError, PermissionError) as e:
                logger.error(f"❌ Cannot access script directory: {scripts_dir} - {str(e)}")
                raise HTTPException(status_code=404, detail=f"Script directory not accessible: {scripts_dir}")
            
            if matching_files:
                script_path = matching_files[0]
                log_verbose(f"📝 Found script with case-insensitive match: {script_path.name} (requested: {script_name})")
            else:
                logger.error(f"❌ Script not found: {scripts_dir / script_name} (also tried case-insensitive search)")
                raise HTTPException(status_code=404, detail=f"Script not found: {scripts_dir / script_name}")
        
        json_params = json.dumps(request.parameters)
        
        # Generate unique process ID for this script execution
        # Check for running processes before starting a new one
        running_count = 0
        running_processes_list = []
        for proc_id, proc_info in list(running_processes.items()):
            # Handle both old format (subprocess.Popen) and new format (dict)
            proc = proc_info if isinstance(proc_info, subprocess.Popen) else proc_info.get("proc")
            if proc and proc.poll() is None:
                running_count += 1
                script_name = proc_info.get("script_name", "unknown") if isinstance(proc_info, dict) else "unknown"
                class_name = proc_info.get("class_name", "unknown") if isinstance(proc_info, dict) else "unknown"
                started_at = proc_info.get("started_at", "unknown") if isinstance(proc_info, dict) else "unknown"
                running_processes_list.append({
                    "process_id": proc_id,
                    "script_name": script_name,
                    "class_name": class_name,
                    "started_at": started_at
                })
            else:
                # Process completed, remove from registry
                if proc_id in running_processes:
                    del running_processes[proc_id]
        
        # If there are running processes, return a special status
        if running_count > 0:
            logger.info(f"⚠️ {running_count} process(es) already running. Returning status to client.")
            return send_response(
                success=False,
                message="Process already running",
                data={
                    "process_already_running": True,
                    "running_count": running_count,
                    "running_processes": running_processes_list,
                    "requested_script": request.script_name,
                    "requested_class": request.class_name
                },
                status_code=409  # Conflict status code
            )
        
        process_id = str(uuid.uuid4())
        log_verbose(f"🆔 Generated process_id: {process_id}")

        try:
            log_script_event(script_path, "START", f"Starting script: {request.class_name}/{request.script_name}")
            
            # Send start message via SSE (wrap in try/except to prevent SSE errors from failing the request)
            try:
                await sse_manager.publish(user_id, {
                    "success": True,
                    "event": {
                        "process_id": process_id,
                        "type": "script_execution",
                        "event": "progress_event",
                        "text": f"Starting script: {request.class_name}/{request.script_name}",
                        "now": int(datetime.now().timestamp() * 1000)
                    },
                    "data": {}
                })
            except Exception as sse_pub_err:
                logger.warning(f"SSE publish failed at start (non-fatal): {str(sse_pub_err)}")
            
            # Environment variables to ensure unbuffered output from nested processes
            env = os.environ.copy()
            env['PYTHONUNBUFFERED'] = '1'
            env['PYTHONIOENCODING'] = 'utf-8'
            
            # Use python3 explicitly (was working before)
            python_executable = "python3"
            logger.info(f"🐍 Using Python executable: {python_executable}")
            
            try:
                full_command = [python_executable, "-u", str(script_path), json_params]
                logger.info(f"🚀 Starting subprocess: command={full_command[:3]}, params_length={len(json_params)}, script_path={script_path}, script_exists={script_path.exists()}")
                proc = subprocess.Popen(
                    [python_executable, "-u", str(script_path), json_params],  # -u for unbuffered
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,  # Merge stderr into stdout to capture all output
                    text=True,
                    bufsize=0,  # Unbuffered
                    universal_newlines=True,
                    env=env,
                    preexec_fn=os.setsid if hasattr(os, 'setsid') else None,  # Create new process group on Unix
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0  # Windows equivalent
                )
            except FileNotFoundError:
                error_msg = f"Python executable not found: {python_executable}. Please ensure Python is installed and in PATH."
                logger.error(f"❌ {error_msg}")
                raise HTTPException(status_code=500, detail=error_msg)
            except Exception as subprocess_error:
                error_msg = f"Failed to start subprocess: {str(subprocess_error)}"
                logger.error(f"❌ {error_msg}\n{traceback.format_exc()}")
                raise HTTPException(status_code=500, detail=error_msg)
            
            # Register process for cancellation capability with metadata
            running_processes[process_id] = {
                "proc": proc,
                "script_name": request.script_name,
                "class_name": request.class_name,
                "started_at": datetime.now().isoformat(),
                "user_id": user_id
            }
            
            # Log that process was started - check if it's still running
            initial_poll = proc.poll()
            run_loop = asyncio.get_running_loop()  # For run_in_executor so blocking subprocess I/O doesn't freeze the server
            logger.info(f"🚀 Script process started: PID={proc.pid}, script={script_path.name}, process_id={process_id}, initial_poll={initial_poll}")
            
            # If process already exited, log warning and try to read output
            if initial_poll is not None:
                logger.warning(f"⚠️ Process exited immediately with return code {initial_poll}")
                # Try to read any output that might have been produced (run in executor to avoid blocking event loop)
                try:
                    immediate_output = await run_loop.run_in_executor(None, lambda: proc.stdout.read())
                    if immediate_output:
                        logger.warning(f"⚠️ Immediate output (first 1000 chars): {immediate_output[:1000]}")
                    else:
                        logger.warning(f"⚠️ No immediate output captured")
                except Exception as e:
                    logger.warning(f"⚠️ Could not read immediate output: {str(e)}")
            
            output_lines = []
            error_lines = []
            warning_lines = []
            start_time = asyncio.get_event_loop().time()
            
            # Read output in real-time with timeout protection
            loop_count = 0
            last_log_time = start_time
            last_output_time = start_time  # Track when we last received output
            last_output_count = 0  # Track output line count to detect progress
            HUNG_PROCESS_WARNING_INTERVAL = 300  # Warn if no output for 5 minutes
            HUNG_PROCESS_CHECK_INTERVAL = 60  # Check for hung process every minute
            
            while loop_count < MAX_LOOP_ITERATIONS:
                loop_count += 1
                current_time = asyncio.get_event_loop().time()
                elapsed_time = current_time - start_time
                
                # Log progress periodically to help debug hangs
                if current_time - last_log_time > PROGRESS_LOG_INTERVAL_SECONDS:
                    process_running = proc.poll() is None
                    time_since_last_output = current_time - last_output_time
                    output_received = len(output_lines) > last_output_count
                    
                    log_verbose(f"🔄 Script execution loop: {loop_count} iterations, {elapsed_time:.1f}s elapsed, process running: {process_running}, output lines: {len(output_lines)}, time since last output: {time_since_last_output:.1f}s")
                    last_log_time = current_time
                    
                    # Detect hung processes: process is running but no output for a while
                    if process_running and time_since_last_output > HUNG_PROCESS_WARNING_INTERVAL:
                        logger.warning(f"⚠️ Process {process_id} may be hung: no output for {time_since_last_output:.1f}s (elapsed: {elapsed_time:.1f}s, output lines: {len(output_lines)})")
                        # Send a warning via SSE if user is connected
                        try:
                            if sse_manager.is_user_connected(user_id):
                                await sse_manager.publish(user_id, {
                                    "success": True,
                                    "event": {
                                        "process_id": process_id,
                                        "type": "script_execution",
                                        "event": "progress_event",
                                        "text": f"Warning: Process may be hung - no output for {int(time_since_last_output)}s",
                                        "now": int(datetime.now().timestamp() * 1000)
                                    },
                                    "data": {
                                        "warning": True,
                                        "time_since_last_output": int(time_since_last_output),
                                        "elapsed_time": int(elapsed_time)
                                    }
                                })
                        except Exception as sse_warn_err:
                            logger.warning(f"Failed to send hung process warning via SSE: {str(sse_warn_err)}")
                    
                    # Update last output count if we received new output
                    if output_received:
                        last_output_count = len(output_lines)
                        last_output_time = current_time
                
                # Check for timeout
                if current_time - start_time > SCRIPT_TIMEOUT_SECONDS:
                    logger.warning(f"Script timeout after {SCRIPT_TIMEOUT_SECONDS} seconds, terminating...")
                    terminate_process(proc, process_id)
                    await asyncio.sleep(GRACEFUL_SHUTDOWN_WAIT_SECONDS)
                    if proc.poll() is None:
                        force_kill_process(proc, process_id)
                    
                    await sse_manager.publish(user_id, {
                        "success": True,
                        "event": {
                            "process_id": process_id,
                            "type": "script_execution",
                            "event": "process_timeout",
                            "text": f"Script timed out after {SCRIPT_TIMEOUT_SECONDS} seconds",
                            "now": int(datetime.now().timestamp() * 1000)
                        },
                        "data": {}
                    })
                    
                    log_script_event(script_path, "TIMEOUT", f"Script timeout after {SCRIPT_TIMEOUT_SECONDS} seconds", level="warning")
                    
                    logger.info(f"⏰ Execute script endpoint returned: 408 - Script execution timed out")
                    return send_response(
                        success=False,
                        message="Script execution timed out",
                        data={
                            "process_id": process_id,
                            "return_code": -1,
                            "timeout": True,
                            "output_lines": output_lines,
                            "error_lines": error_lines,
                            "warning_lines": warning_lines,
                            "user_id": user.get("user_id")
                        },
                        status_code=408
                    )
                
                # Check if process is still running
                if proc.poll() is not None:
                    # Process finished, read any remaining output (run in executor to avoid blocking event loop)
                    try:
                        remaining_output = await run_loop.run_in_executor(None, lambda: proc.stdout.read())
                        if remaining_output:
                            for line in remaining_output.strip().split('\n'):
                                if line.strip():
                                    await categorize_and_publish_output(
                                        line, user_id, process_id, script_path,
                                        output_lines, error_lines, warning_lines, sse_manager
                                    )
                    except Exception as read_error:
                        logger.error(f"Error reading final output: {str(read_error)}")
                    break
                
                # Read stdout (merged with stderr) - run in executor so readline() doesn't block the event loop
                try:
                    output = await run_loop.run_in_executor(None, proc.stdout.readline)
                    if output:
                        line = output.strip()
                        if line:
                            # Update last output time when we receive output
                            last_output_time = asyncio.get_event_loop().time()
                            last_output_count = len(output_lines)
                            
                            await categorize_and_publish_output(
                                line, user_id, process_id, script_path,
                                output_lines, error_lines, warning_lines, sse_manager
                            )
                except Exception as stdout_error:
                    logger.error(f"Error reading stdout: {str(stdout_error)}")
                
                # Small sleep to prevent CPU spinning
                await asyncio.sleep(READ_LOOP_SLEEP_SECONDS)
                
                # Safety check - if we hit the loop limit, something is wrong (check inside loop)
                if loop_count >= MAX_LOOP_ITERATIONS:
                    break  # Exit the while loop
            
            # Safety check - if we hit the loop limit, something is wrong
            if loop_count >= MAX_LOOP_ITERATIONS:
                logger.error(f"⚠️ Script execution loop hit safety limit ({MAX_LOOP_ITERATIONS} iterations), forcing exit")
                terminate_process(proc, process_id)
                return_code = -1
            else:
                # Wait for process to complete (with timeout) - run in executor to avoid blocking event loop
                try:
                    return_code = await run_loop.run_in_executor(None, lambda: proc.wait(timeout=PROCESS_WAIT_TIMEOUT_SECONDS))
                except subprocess.TimeoutExpired:
                    logger.warning("Process didn't exit cleanly, forcing termination")
                    force_kill_process(proc, process_id)
                    return_code = -1
            
            # Clean up process from registry
            if process_id in running_processes:
                del running_processes[process_id]
            
            # Prepare results - treat warnings as acceptable
            script_succeeded = return_code == 0 or (return_code != 0 and error_lines == [] and warning_lines)
            
            # Publish SSE completion event with requested payload format
            # Include return_code and error info in data so frontend can determine success/failure
            # CRITICAL: Always send completion event, even if there were errors reading output
            # This ensures the frontend knows the process has completed and can move to the next dataset
            completion_event_sent = False
            try:
                completion_data = {
                    "return_code": return_code,
                    "script_succeeded": script_succeeded,
                    "error_lines": error_lines,
                    "warning_lines": warning_lines
                }
                
                logger.info(f"📤 Preparing to send completion event for process {process_id} (return_code={return_code}, succeeded={script_succeeded})")
                
                # Check if user has active SSE connection
                if sse_manager.is_user_connected(user_id):
                    # User is connected via SSE - send notification via SSE
                    await sse_manager.publish(user_id, {
                        "success": True,
                        "event": {
                            "process_id": process_id,
                            "type": "script_execution",
                            "event": "process_complete",
                            "text": f"{request.script_name if request.script_name.endswith('.py') else request.script_name + '.py'} done",
                            "now": int(datetime.now().timestamp() * 1000)
                        },
                        "data": completion_data
                    })
                    completion_event_sent = True
                    logger.info(f"✅ Process completion sent via SSE to user {user_id} for process {process_id}")
                else:
                    # Skip email notification for batch processes (upload workflows)
                    # Email notifications should only be sent when all datasets have been uploaded
                    is_batch_process = request.parameters.get('batch', False) if request.parameters else False
                    if is_batch_process:
                        logger.info(f"📧 User {user_id} not connected via SSE (batch process) for process {process_id}")
                    # Email notifications disabled
                    completion_event_sent = True
                
                if script_succeeded:
                    log_script_event(script_path, "COMPLETE", f"Script completed successfully with code: {return_code}", level="info")
                else:
                    log_script_event(script_path, "ERROR", f"Script failed with code: {return_code}", level="error")
            except Exception as sse_err:
                logger.error(f"❌ SSE/Email notification failed for process {process_id}: {str(sse_err)}")
                logger.error(f"❌ This may cause the frontend to timeout waiting for completion. Process return_code was: {return_code}")
                # Don't re-raise - we still want to return the HTTP response with the results
                # The frontend fallback mechanism (checking running processes API) should handle this case
            
            if script_succeeded:
                # Try to parse the last output as JSON, fallback to all output
                try:
                    if output_lines:
                        results = json.loads(output_lines[-1])
                    else:
                        results = {"output": "No output"}
                except json.JSONDecodeError:
                    results = {"output": "\n".join(output_lines)}
                
                log_verbose(f"✅ Execute script endpoint returned: 200 OK - Script completed successfully")
                return send_response(
                    success=True,
                    message="Script executed successfully" + (f" with {len(warning_lines)} warnings" if warning_lines else ""),
                    data={
                        "process_id": process_id,
                        "results": results,
                        "return_code": return_code,
                        "script_succeeded": script_succeeded,
                        "output_lines": output_lines,
                        "warning_lines": warning_lines,
                        "error_lines": error_lines,
                        "user_id": user.get("user_id")
                    }
                )
            else:
                logger.info(f"❌ Execute script endpoint returned: 500 - Script execution failed")
                return send_response(
                    success=False,
                    message="Script execution failed",
                    data={
                        "process_id": process_id,
                        "return_code": return_code,
                        "error_lines": error_lines,
                        "warning_lines": warning_lines,
                        "output_lines": output_lines,
                        "user_id": user.get("user_id")
                    },
                    status_code=500
                )
        except HTTPException:
            # Re-raise HTTPExceptions from inner try block (like 404 for script not found)
            raise
        except Exception as inner_error:
            # If inner try block fails, let outer exception handler deal with it
            raise
            
    except HTTPException:
        # Re-raise HTTPExceptions (like 404 for script not found) as-is
        raise
    except Exception as e:
        error_msg = f"Script execution failed: {str(e)}"
        error_traceback = traceback.format_exc()
        
        # Log immediately - don't depend on script_path being set
        logger.error(f"💥 Execute script endpoint error: {error_msg}")
        logger.error(f"💥 Full traceback:\n{error_traceback}")
        
        # Try to log script event if script_path is available
        if script_path:
            try:
                log_script_event(script_path, "FAILED", error_msg, level="error")
            except Exception:
                pass  # Don't let logging errors mask the original error
        
        # Ensure process is cleaned up (wrap in try/except to prevent cleanup errors from masking original error)
        try:
            if 'proc' in locals() and proc and proc.poll() is None:
                terminate_process(proc, process_id if 'process_id' in locals() else 'unknown')
                await asyncio.sleep(1)
                if proc.poll() is None:
                    force_kill_process(proc, process_id if 'process_id' in locals() else 'unknown')
        except Exception as cleanup_error:
            logger.error(f"Error during process cleanup: {str(cleanup_error)}")
        
        # Clean up process from registry
        try:
            if 'process_id' in locals() and process_id in running_processes:
                del running_processes[process_id]
        except Exception:
            pass  # Ignore cleanup errors
        
        # Publish SSE error event for exception case (wrap in try/except to prevent SSE errors from masking original error)
        try:
            if 'process_id' in locals():
                # Check if user has active SSE connection
                if sse_manager.is_user_connected(user_id):
                    # User is connected via SSE - send notification via SSE
                    await sse_manager.publish(user_id, {
                        "success": True,
                        "event": {
                            "process_id": process_id,
                            "type": "script_execution",
                            "event": "process_complete",
                            "text": error_msg,
                            "now": int(datetime.now().timestamp() * 1000)
                        },
                        "data": {
                            "return_code": -1,
                            "script_succeeded": False,
                            "error_lines": [error_msg],
                            "warning_lines": []
                        }
                    })
                    logger.info(f"📧 Process error sent via SSE to user {user_id}")
                else:
                    # Skip email notification for batch processes (upload workflows)
                    # Email notifications should only be sent when all datasets have been uploaded
                    is_batch_process = False
                    if 'request' in locals() and request.parameters:
                        is_batch_process = request.parameters.get('batch', False)
                    
                    if is_batch_process:
                        logger.info(f"📧 User {user_id} not connected via SSE (batch process) for error")
                    # Email notifications disabled
        except Exception as sse_err:
            logger.warning(f"SSE publish failed: {str(sse_err)}")
        
        logger.error(f"💥 Execute script endpoint returned: 500 - Exception: {error_msg}")
        # Always raise HTTPException to ensure proper error handling (not caught by general exception handler)
        # Include error message so client can see what went wrong
        raise HTTPException(status_code=500, detail=error_msg)

# 📊 Check for running processes
@app.get(
    "/api/scripts/running",
    summary="Get Running Processes",
    description="Check if there are any running script processes",
    response_description="List of running processes with their details",
    tags=["Scripts"]
)
async def get_running_processes(
    script_name: str = None,
    class_name: str = None,
    user: dict = Depends(authenticate)
):
    """
    ## Get Running Processes
    
    Returns information about currently running script processes.
    Can filter by script_name and/or class_name.
    
    ### Query Parameters
    - **script_name** (optional): Filter by specific script name (e.g., "2_process_and_execute.py")
    - **class_name** (optional): Filter by class name (e.g., "ac40")
    
    ### Authentication
    Requires valid JWT or PAT token in Authorization header.
    
    ### Response Format
    
    #### Success (200 OK)
    ```json
    {
      "success": true,
      "data": {
        "running_count": 2,
        "processes": [
          {
            "process_id": "uuid",
            "script_name": "2_process_and_execute.py",
            "class_name": "ac40",
            "pid": 12345,
            "started_at": "2024-01-01T12:00:00Z"
          }
        ]
      }
    }
    ```
    """
    user_id = str(user.get("user_id"))
    
    # Get all running processes
    running_list = []
    current_time = datetime.now()
    
    for proc_id, proc_info in list(running_processes.items()):
        # Handle both old format (subprocess.Popen) and new format (dict)
        proc = proc_info if isinstance(proc_info, subprocess.Popen) else proc_info.get("proc")
        
        if proc is None:
            # Invalid entry, remove it
            if proc_id in running_processes:
                del running_processes[proc_id]
            continue
        
        # Check if process is still running
        if proc.poll() is None:
            # Process is still running
            script_name = proc_info.get("script_name", "unknown") if isinstance(proc_info, dict) else "unknown"
            class_name = proc_info.get("class_name", "unknown") if isinstance(proc_info, dict) else "unknown"
            started_at = proc_info.get("started_at", "unknown") if isinstance(proc_info, dict) else "unknown"
            
            running_list.append({
                "process_id": proc_id,
                "pid": proc.pid,
                "script_name": script_name,
                "class_name": class_name,
                "started_at": started_at,
                "status": "running"
            })
        else:
            # Process completed, remove from registry
            if proc_id in running_processes:
                del running_processes[proc_id]
    
    # Filter by script_name if provided
    if script_name:
        # Note: We don't currently store script_name in the process registry
        # This would require enhancing the registry to store metadata
        # For now, we'll return all running processes
        pass
    
    return send_response(
        success=True,
        message=f"Found {len(running_list)} running process(es)",
        data={
            "running_count": len(running_list),
            "processes": running_list
        }
    )

# ⚙️ Cancel a running script
@app.post(
    "/api/scripts/cancel/{process_id}",
    summary="Cancel Running Script",
    description="Cancel a running script execution by process_id",
    response_description="Confirmation that script cancellation was requested",
    tags=["Scripts"]
)
async def cancel_script(
    process_id: str,
    user: dict = Depends(authenticate)
):
    """
    ## Cancel Running Script
    
    Cancels a running script execution by terminating the associated subprocess.
    
    ### Parameters
    - **process_id** (string): The process ID of the script to cancel
    
    ### Authentication
    Requires valid JWT or PAT token in Authorization header.
    
    ### Response Format
    
    #### Success (200 OK)
    ```json
    {
      "success": true,
      "message": "Script cancellation requested",
      "data": {
        "process_id": "uuid",
        "cancelled": true
      }
    }
    ```
    
    #### Not Found (404)
    ```json
    {
      "success": false,
      "message": "Process not found or already completed",
      "data": {
        "process_id": "uuid",
        "cancelled": false
      }
    }
    ```
    """
    log_verbose(f"🛑 Cancel script endpoint called - process_id: {process_id}, user: {user.get('user_id', 'anonymous')}")
    
    user_id = str(user.get("user_id"))
    
    # Check if process exists in registry
    if process_id not in running_processes:
        logger.warning(f"❌ Process {process_id} not found in running processes registry")
        return send_response(
            success=False,
            message="Process not found or already completed",
            data={
                "process_id": process_id,
                "cancelled": False
            },
            status_code=404
        )
    
    proc_info = running_processes[process_id]
    proc = proc_info if isinstance(proc_info, subprocess.Popen) else proc_info.get("proc")
    
    if proc is None:
        logger.warning(f"❌ Process {process_id} has no process object")
        del running_processes[process_id]
        return send_response(
            success=False,
            message="Process not found or already completed",
            data={
                "process_id": process_id,
                "cancelled": False
            },
            status_code=404
        )
    
    # Check if process is still running
    if proc.poll() is not None:
        # Process already completed, remove from registry
        del running_processes[process_id]
        logger.info(f"ℹ️ Process {process_id} already completed")
        return send_response(
            success=False,
            message="Process already completed",
            data={
                "process_id": process_id,
                "cancelled": False
            },
            status_code=404
        )
    
    # Terminate the process
    try:
        terminate_process(proc, process_id)
        
        # Wait for graceful shutdown
        await asyncio.sleep(GRACEFUL_SHUTDOWN_WAIT_SECONDS)
        
        # Force kill if still running
        if proc.poll() is None:
            force_kill_process(proc, process_id)
        
        # Remove from registry (pop to avoid KeyError if already removed by completion handler)
        running_processes.pop(process_id, None)
        
        # Publish cancellation event via SSE
        try:
            await sse_manager.publish(user_id, {
                "success": True,
                "event": {
                    "process_id": process_id,
                    "type": "script_execution",
                    "event": "process_cancelled",
                    "text": "Script execution was cancelled by user",
                    "now": int(datetime.now().timestamp() * 1000)
                },
                "data": {}
            })
        except Exception as sse_err:
            logger.warning(f"SSE publish failed for cancellation: {str(sse_err)}")
        
        logger.info(f"✅ Process {process_id} cancelled successfully")
        return send_response(
            success=True,
            message="Script cancellation requested",
            data={
                "process_id": process_id,
                "cancelled": True
            }
        )
        
    except KeyError as e:
        # Process was already removed from registry (e.g. by completion handler); treat as cancelled
        logger.info(f"ℹ️ Process {process_id} already removed from registry (race with completion)")
        return send_response(
            success=True,
            message="Script cancellation requested",
            data={
                "process_id": process_id,
                "cancelled": True
            }
        )
    except Exception as e:
        error_msg = f"Error cancelling process: {str(e)}"
        logger.error(f"❌ {error_msg}")
        
        # Try to remove from registry even if termination failed
        running_processes.pop(process_id, None)
        
        return send_response(
            success=False,
            message=error_msg,
            data={
                "process_id": process_id,
                "cancelled": False
            },
            status_code=500
        )

# ⚙️ Execute Python script in background (if needed)
@app.post(
    "/api/execute_script_background/",
    summary="Execute Script in Background",
    description="Execute a Python script in the background without blocking",
    response_description="Confirmation that script was started in background",
    tags=["Scripts"]
)
async def execute_script_background(
    request: ScriptExecuteRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(authenticate)
):
    """
    ## Execute Script in Background
    
    Executes a Python script in the background without blocking the API response.
    Use this for long-running scripts that don't need real-time monitoring.
    
    ### Request Body
    Same as `/api/execute_script/`:
    ```json
    {
      "class_name": "ac40",
      "script_name": "long_running_script.py",
      "parameters": {
        "param1": "value1"
      }
    }
    ```
    
    ### Authentication
    Requires valid JWT or PAT token in Authorization header.
    
    ### Response
    ```json
    {
      "success": true,
      "message": "Script started in background",
      "data": {
        "user_id": "user-123",
        "script": "ac40/long_running_script.py"
      }
    }
    ```
    
    ### Use Cases
    - Long-running data processing scripts
    - Scripts that don't need real-time output
    - Batch operations
    - Scripts that run for hours or days
    
    ### Limitations
    - No real-time progress updates
    - No process ID tracking
    - No timeout protection
    - Results are not returned to the client
    
    ### Monitoring
    Check server logs to monitor background script execution.
    """
    logger.info(f"🔄 Background script endpoint called - script: {request.class_name}/{request.script_name}, user: {user.get('user_id', 'anonymous')}")
    
    # Handle script name - add .py extension only if not already present
    script_name = request.script_name
    if not script_name.endswith('.py'):
        script_name += '.py'
    
    # Build script directory path
    scripts_dir = Path(__file__).parent.parent / "scripts" / request.class_name.lower()
    
    # Check if scripts directory exists
    if not scripts_dir.exists() or not scripts_dir.is_dir():
        logger.error(f"❌ Script directory not found: {scripts_dir}")
        raise HTTPException(status_code=404, detail=f"Script directory not found: {scripts_dir}")
    
    # Case-insensitive file lookup (for cross-platform compatibility)
    # First try exact match, then try case-insensitive search
    script_path = scripts_dir / script_name
    
    if not script_path.exists():
        # Try case-insensitive search
        script_name_lower = script_name.lower()
        try:
            matching_files = [f for f in scripts_dir.iterdir() if f.is_file() and f.name.lower() == script_name_lower]
        except (FileNotFoundError, PermissionError) as e:
            logger.error(f"❌ Cannot access script directory: {scripts_dir} - {str(e)}")
            raise HTTPException(status_code=404, detail=f"Script directory not accessible: {scripts_dir}")
        
        if matching_files:
            script_path = matching_files[0]
            log_verbose(f"📝 Found background script with case-insensitive match: {script_path.name} (requested: {script_name})")
        else:
            logger.error(f"❌ Background script not found: {scripts_dir / script_name} (also tried case-insensitive search)")
            raise HTTPException(status_code=404, detail=f"Script not found: {scripts_dir / script_name}")
    
    json_params = json.dumps(request.parameters)
    user_id = str(user.get("user_id"))

    async def run_script():
        try:
            log_script_event(script_path, "START", f"Starting background script")
            
            # Use python3 explicitly (was working before)
            python_executable = "python3"
            
            try:
                proc = subprocess.Popen(
                    [python_executable, str(script_path), json_params],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True
                )
            except FileNotFoundError:
                error_msg = f"Python executable not found: {python_executable}"
                logger.error(f"❌ {error_msg}")
                log_script_event(script_path, "FAILED", error_msg, level="error")
                return
            except Exception as subprocess_error:
                error_msg = f"Failed to start background subprocess: {str(subprocess_error)}"
                logger.error(f"❌ {error_msg}\n{traceback.format_exc()}")
                log_script_event(script_path, "FAILED", error_msg, level="error")
                return
            
            stdout, stderr = proc.communicate()
            
            if proc.returncode == 0:
                log_script_event(script_path, "COMPLETE", f"Background script completed successfully", level="info")
            else:
                log_script_event(script_path, "FAILED", f"Background script failed: {stderr}", level="error")
                
        except Exception as e:
            error_msg = f"Background script execution failed: {str(e)}"
            log_script_event(script_path, "FAILED", error_msg, level="error")

    background_tasks.add_task(run_script)
    log_verbose(f"✅ Background script endpoint returned: 200 OK - Script started in background")
    return send_response(
        success=True,
        message="Script started in background",
        data={"user_id": user.get("user_id"), "script": f"{request.class_name}/{request.script_name}"}
    )