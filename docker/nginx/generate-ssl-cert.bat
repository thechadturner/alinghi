@echo off
REM Generate self-signed SSL certificate for development
REM This allows HTTPS access to 192.168.0.18, making it a trustworthy origin for COOP/COEP headers

set SSL_DIR=%~dp0ssl
if not exist "%SSL_DIR%" mkdir "%SSL_DIR%"

REM Check if OpenSSL is available
where openssl >nul 2>&1
if errorlevel 1 (
    echo [ERROR] OpenSSL not found in PATH.
    echo [INFO] Please install OpenSSL or use Git Bash which includes OpenSSL.
    echo [INFO] You can download OpenSSL from: https://slproweb.com/products/Win32OpenSSL.html
    pause
    exit /b 1
)

REM Generate private key
openssl genrsa -out "%SSL_DIR%\key.pem" 2048
if errorlevel 1 (
    echo [ERROR] Failed to generate private key
    pause
    exit /b 1
)

REM Generate certificate (valid for 365 days)
openssl req -new -x509 -key "%SSL_DIR%\key.pem" -out "%SSL_DIR%\cert.pem" -days 365 ^
    -subj "/C=US/ST=State/L=City/O=Development/CN=192.168.0.18" ^
    -addext "subjectAltName=IP:192.168.0.18,DNS:192.168.0.18,DNS:localhost,IP:127.0.0.1"
if errorlevel 1 (
    echo [ERROR] Failed to generate certificate
    pause
    exit /b 1
)

echo [SUCCESS] SSL certificates generated in %SSL_DIR%\
echo Certificate: %SSL_DIR%\cert.pem
echo Private key: %SSL_DIR%\key.pem
echo.
echo [INFO] To use HTTPS, uncomment the HTTPS server block in nginx-dev.conf
echo [INFO] Then restart nginx: docker-compose -f docker/compose/nginx.yml restart
echo.
pause

