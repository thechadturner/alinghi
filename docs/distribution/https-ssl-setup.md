# HTTPS/SSL Setup Guide

This guide explains how to set up HTTPS for the RaceSight application using Let's Encrypt certificates.

## Overview

- **Domain**: `racesight.cloud` and `www.racesight.cloud`
- **SSL Provider**: Let's Encrypt (via Certbot)
- **Web Server**: Nginx in Docker container
- **Deployment**: Azure Linux VM

## Prerequisites

1. Azure VM with Docker and Docker Compose installed
2. Domain DNS configured at Hostinger (see DNS Configuration below)
3. Ports 80 and 443 open in Azure Network Security Group (NSG)
4. Application running in Docker containers
5. Nginx configured for production (`NGINX_CONFIG=prod`)

## Step 1: DNS Configuration at Hostinger

Configure DNS records at Hostinger to point to your Azure VM:

1. Log in to Hostinger and navigate to DNS management
2. Add/update the following A records:
   - **Name**: `@` (or leave blank for root domain)
     - **Type**: A
     - **Value**: `<YOUR_AZURE_VM_PUBLIC_IP>`
     - **TTL**: 300-3600 seconds
   
   - **Name**: `www`
     - **Type**: A
     - **Value**: `<YOUR_AZURE_VM_PUBLIC_IP>`
     - **TTL**: 300-3600 seconds

3. Wait for DNS propagation (can take up to 48 hours, usually much faster)
4. Verify DNS resolution:
   ```bash
   dig racesight.cloud
   dig www.racesight.cloud
   ```

**Important**: Do NOT use Hostinger's SSL certificates. SSL will be obtained directly on the Azure VM using Let's Encrypt.

## Step 2: Azure Network Security Group Configuration

Ensure ports 80 and 443 are open:

1. In Azure Portal, navigate to your VM's Network Security Group
2. Add inbound rules if not already present:
   - **Port 80 (HTTP)**: Allow from `Internet` (source: `*`)
   - **Port 443 (HTTPS)**: Allow from `Internet` (source: `*`)

## Step 3: Initial HTTP Deployment

For the first deployment, the nginx configuration is set up to allow HTTP access. This is necessary for obtaining SSL certificates using Let's Encrypt.

1. Deploy the application using the deployment scripts
2. Ensure the application is accessible via HTTP (port 80)
3. Verify all services are running correctly

## Step 4: Install Certbot on Azure VM

SSH into your Azure VM and install Certbot:

```bash
# Update package list
sudo apt-get update

# Install Certbot and nginx plugin (for future use, though we use standalone mode)
sudo apt-get install -y certbot

# Verify installation
certbot --version
```

## Step 5: Prepare SSL Certificate Directory

Create the SSL directory structure that Docker nginx will use:

```bash
# Navigate to your project directory
cd /home/racesight/racesight

# Ensure SSL directory exists
mkdir -p servers/docker/nginx/ssl

# Set appropriate permissions
chmod 755 servers/docker/nginx/ssl
```

## Step 6: Obtain SSL Certificates (Initial Setup)

Since nginx is running in Docker, we'll use Certbot's standalone mode which temporarily binds to port 80.

### Option A: Using the Helper Script

```bash
cd servers/docker/nginx/scripts
chmod +x obtain-ssl-cert.sh
./obtain-ssl-cert.sh
```

### Option B: Manual Certificate Generation

1. **Temporarily stop nginx container** (Certbot needs port 80):
   ```bash
   cd /home/racesight/racesight
   docker-compose -f docker-compose.yml stop nginx
   ```

2. **Obtain certificates using Certbot standalone mode**:
   ```bash
   sudo certbot certonly --standalone \
     -d racesight.cloud \
     -d www.racesight.cloud \
     --email your-email@example.com \
     --agree-tos \
     --non-interactive
   ```

3. **Copy certificates to Docker nginx SSL directory**:
   ```bash
   # Certificates are stored in /etc/letsencrypt/live/racesight.cloud/
   sudo cp /etc/letsencrypt/live/racesight.cloud/fullchain.pem servers/docker/nginx/ssl/
   sudo cp /etc/letsencrypt/live/racesight.cloud/privkey.pem servers/docker/nginx/ssl/
   
   # Set appropriate permissions
   sudo chmod 644 servers/docker/nginx/ssl/fullchain.pem
   sudo chmod 600 servers/docker/nginx/ssl/privkey.pem
   sudo chown $USER:$USER servers/docker/nginx/ssl/*.pem
   ```

4. **Restart nginx container**:
   ```bash
   docker-compose -f docker-compose.yml start nginx
   ```

5. **Verify HTTPS is working**:
   ```bash
   curl -I https://racesight.cloud
   curl -I https://www.racesight.cloud
   ```

### Option C: Using Existing Certificates

If you already have SSL certificates:

1. Copy your certificates to the VM:
   ```bash
   scp -i <your-key> fullchain.pem racesight@20.224.64.96:/home/racesight/racesight/servers/docker/nginx/ssl/
   scp -i <your-key> privkey.pem racesight@20.224.64.96:/home/racesight/racesight/servers/docker/nginx/ssl/
   ```

2. Set proper permissions on the VM:
   ```bash
   ssh -i <your-key> racesight@20.224.64.96
   chmod 644 /home/racesight/racesight/servers/docker/nginx/ssl/fullchain.pem
   chmod 600 /home/racesight/racesight/servers/docker/nginx/ssl/privkey.pem
   ```

## Step 7: Enable HTTPS Redirect

After certificates are in place, enable the HTTP to HTTPS redirect:

1. SSH to the VM:
   ```bash
   ssh -i <your-key> racesight@20.224.64.96
   ```

2. Edit the nginx configuration:
   ```bash
   cd /home/racesight/racesight
   nano servers/docker/nginx/nginx-prod.conf
   ```

3. Find the HTTP server block (around line 53) and ensure the redirect is uncommented:
   ```nginx
   server {
       listen 80;
       listen [::]:80;
       server_name racesight.cloud www.racesight.cloud;
       
       # Redirect all HTTP traffic to HTTPS
       return 301 https://$host$request_uri;
   }
   ```

4. Restart nginx to apply changes:
   ```bash
   docker-compose -f docker-compose.yml restart nginx
   ```

## Step 8: Verify HTTPS

1. Test HTTPS access:
   ```bash
   curl -I https://racesight.cloud
   ```

2. Verify certificate:
   ```bash
   openssl s_client -connect racesight.cloud:443 -servername racesight.cloud
   ```

3. Test in browser:
   - Navigate to `https://racesight.cloud`
   - Check that the padlock icon appears
   - Verify no certificate warnings

## Step 9: Set Up SSL Auto-Renewal

Let's Encrypt certificates expire after 90 days. Set up automatic renewal:

### Option A: Using the Renewal Script

The renewal script handles Docker nginx reload automatically:

```bash
# Add to crontab (runs twice daily)
sudo crontab -e

# Add this line:
0 0,12 * * * /home/racesight/racesight/servers/docker/nginx/scripts/renew-ssl-cert.sh >> /var/log/certbot-renewal.log 2>&1
```

### Option B: Manual Renewal Setup

1. **Create renewal script** (see `servers/docker/nginx/scripts/renew-ssl-cert.sh`)

2. **Add to crontab**:
   ```bash
   sudo crontab -e
   # Add: 0 0,12 * * * /path/to/renew-ssl-cert.sh
   ```

3. **Test renewal** (dry run):
   ```bash
   sudo certbot renew --dry-run
   ```

## Certificate Renewal (Let's Encrypt)

Let's Encrypt certificates expire every 90 days. Set up automatic renewal:

1. Create a renewal script on the VM:
   ```bash
   nano /home/racesight/racesight/renew-ssl.sh
   ```

2. Add this content:
   ```bash
   #!/bin/bash
   # Stop nginx
   cd /home/racesight/racesight
   docker-compose -f docker-compose.yml stop nginx
   
   # Renew certificate
   sudo certbot renew
   
   # Copy renewed certificates
   sudo cp /etc/letsencrypt/live/racesight.cloud/fullchain.pem /home/racesight/racesight/servers/docker/nginx/ssl/
   sudo cp /etc/letsencrypt/live/racesight.cloud/privkey.pem /home/racesight/racesight/servers/docker/nginx/ssl/
   sudo chmod 644 /home/racesight/racesight/servers/docker/nginx/ssl/fullchain.pem
   sudo chmod 600 /home/racesight/racesight/servers/docker/nginx/ssl/privkey.pem
   
   # Restart nginx
   docker-compose -f docker-compose.yml start nginx
   ```

3. Make it executable:
   ```bash
   chmod +x /home/racesight/racesight/renew-ssl.sh
   ```

4. Add to crontab (runs monthly):
   ```bash
   crontab -e
   # Add this line:
   0 2 1 * * /home/racesight/racesight/renew-ssl.sh >> /var/log/ssl-renewal.log 2>&1
   ```

## Verify SSL Configuration

1. **Check certificate expiration**:
   ```bash
   sudo certbot certificates
   ```

2. **Test SSL configuration**:
   - Visit `https://racesight.cloud` in a browser
   - Check SSL Labs: https://www.ssllabs.com/ssltest/analyze.html?d=racesight.cloud

3. **Verify HTTP to HTTPS redirect**:
   ```bash
   curl -I http://racesight.cloud
   # Should return 301 redirect to https://
   ```

## Troubleshooting

### Certificate Not Found Error

If nginx fails to start with "certificate not found":
- Verify certificates exist: `ls -la /home/racesight/racesight/servers/docker/nginx/ssl/`
- Check file permissions
- Verify certificate paths in nginx-prod.conf match the actual file locations

### Certificate Generation Fails

- **DNS not propagated**: Wait longer or check DNS resolution
- **Port 80 blocked**: Verify Azure NSG rules
- **Nginx still running**: Ensure nginx container is stopped during certificate generation

### Certificates Not Loading in Docker

- **File permissions**: Ensure certificates are readable by Docker
- **File paths**: Verify certificates are in `servers/docker/nginx/ssl/`
- **Nginx config**: Check that SSL paths in `nginx-prod.conf` match mounted volume

### Mixed Content Warnings

If you see mixed content warnings:
- Ensure all API calls use HTTPS
- Check CORS_ORIGINS includes HTTPS URLs
- Verify VITE_API_HOST is set correctly

### Certificate Expired

If certificate expires:
- Run the renewal script manually
- Check Let's Encrypt rate limits: `certbot certificates`
- Verify DNS records still point to your server

### Renewal Fails

- **Port 80 in use**: Ensure nginx is stopped during renewal (handled by renewal script)
- **DNS issues**: Verify DNS records are still correct
- **Check logs**: Review `/var/log/letsencrypt/letsencrypt.log`

## Maintenance

### Manual Certificate Renewal

If auto-renewal fails, manually renew:

```bash
cd servers/docker/nginx/scripts
./renew-ssl-cert.sh
```

### Certificate Expiration Check

```bash
# Check expiration dates
sudo certbot certificates

# Check specific certificate
openssl x509 -in servers/docker/nginx/ssl/fullchain.pem -noout -dates
```

## Security Notes

- Keep private keys secure (600 permissions)
- Never commit certificates to git
- Set up automatic renewal to prevent expiration
- Monitor certificate expiration dates
- Use strong SSL/TLS protocols (TLS 1.2+)
- Private key protection: The `privkey.pem` file should have permissions `600` (owner read/write only)
- Certificate location: Certificates are stored in `servers/docker/nginx/ssl/` which is mounted as read-only in Docker
- Auto-renewal: Certificates are automatically renewed before expiration (30 days before expiry)
- HSTS: HTTP Strict Transport Security is enabled in the nginx configuration

## Additional Resources

- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [Certbot User Guide](https://eff-certbot.readthedocs.io/)
- [Nginx SSL Configuration](https://nginx.org/en/docs/http/configuring_https_servers.html)

