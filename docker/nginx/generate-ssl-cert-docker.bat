@echo off
REM Generate self-signed SSL certificate using Docker (no OpenSSL installation needed)
REM This allows HTTPS access to 192.168.0.18, making it a trustworthy origin for COOP/COEP headers

set SSL_DIR=%~dp0ssl
if not exist "%SSL_DIR%" mkdir "%SSL_DIR%"

echo [INFO] Generating SSL certificate using Docker...
echo.

REM Use Alpine Linux container with OpenSSL to generate certificates
docker run --rm -v "%SSL_DIR%:/certs" alpine sh -c "apk add --no-cache openssl >nul 2>&1 && cd /certs && openssl genrsa -out key.pem 2048 && openssl req -new -x509 -key key.pem -out cert.pem -days 365 -subj '/C=US/ST=State/L=City/O=Development/CN=192.168.0.18' -addext 'subjectAltName=IP:192.168.0.18,DNS:192.168.0.18,DNS:localhost,IP:127.0.0.1'"

if errorlevel 1 (
    echo [ERROR] Failed to generate certificates using Docker
    echo [INFO] Make sure Docker is running
    pause
    exit /b 1
)

echo.
echo [SUCCESS] SSL certificates generated in %SSL_DIR%\
echo Certificate: %SSL_DIR%\cert.pem
echo Private key: %SSL_DIR%\key.pem
echo.
echo [INFO] Next steps:
echo   1. Uncomment the HTTPS server block in nginx-dev.conf
echo   2. Restart nginx: docker-compose -f docker/compose/nginx.yml restart
echo   3. Access via https://192.168.0.18 (accept the self-signed certificate warning)
echo.
pause

