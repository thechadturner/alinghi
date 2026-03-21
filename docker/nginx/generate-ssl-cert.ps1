# Generate self-signed SSL certificate for development using PowerShell
# This allows HTTPS access to 192.168.0.18, making it a trustworthy origin for COOP/COEP headers

$SSL_DIR = Join-Path $PSScriptRoot "ssl"
if (-not (Test-Path $SSL_DIR)) {
    New-Item -ItemType Directory -Path $SSL_DIR | Out-Null
}

# Check if we can use New-SelfSignedCertificate (Windows 10+)
try {
    $cert = New-SelfSignedCertificate `
        -DnsName "192.168.0.18", "localhost", "127.0.0.1" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -FriendlyName "Hunico Development Certificate" `
        -NotAfter (Get-Date).AddYears(1) `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -KeyExportPolicy Exportable `
        -KeyUsage DigitalSignature, KeyEncipherment `
        -Type SSLServerAuthentication `
        -ErrorAction Stop

    Write-Host "[SUCCESS] Certificate created in Windows certificate store" -ForegroundColor Green
    Write-Host "Certificate Thumbprint: $($cert.Thumbprint)" -ForegroundColor Cyan
    
    # Export certificate to PEM format
    $certPath = "Cert:\CurrentUser\My\$($cert.Thumbprint)"
    
    # Export private key (requires OpenSSL or we need to use certutil)
    # For now, we'll export the certificate and note that the user needs to export the key separately
    $certPem = [System.Convert]::ToBase64String($cert.RawData)
    $certPemFormatted = "-----BEGIN CERTIFICATE-----`n"
    for ($i = 0; $i -lt $certPem.Length; $i += 64) {
        $certPemFormatted += $certPem.Substring($i, [Math]::Min(64, $certPem.Length - $i)) + "`n"
    }
    $certPemFormatted += "-----END CERTIFICATE-----"
    
    Set-Content -Path "$SSL_DIR\cert.pem" -Value $certPemFormatted
    
    Write-Host "[INFO] Certificate exported to: $SSL_DIR\cert.pem" -ForegroundColor Yellow
    Write-Host "[WARNING] Private key export requires OpenSSL or certutil" -ForegroundColor Yellow
    Write-Host "[INFO] You can export the private key using:" -ForegroundColor Yellow
    Write-Host "  certutil -exportPFX -p <password> Cert:\CurrentUser\My\$($cert.Thumbprint) $SSL_DIR\cert.pfx" -ForegroundColor Cyan
    Write-Host "  Then convert PFX to PEM using OpenSSL: openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "[INFO] Alternatively, install OpenSSL and run generate-ssl-cert.bat" -ForegroundColor Yellow
    
} catch {
    Write-Host "[ERROR] Failed to create certificate: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[INFO] Please install OpenSSL from: https://slproweb.com/products/Win32OpenSSL.html" -ForegroundColor Yellow
    Write-Host "[INFO] Or use Git Bash which includes OpenSSL" -ForegroundColor Yellow
    exit 1
}

