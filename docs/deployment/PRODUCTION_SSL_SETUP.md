# Production SSL Setup Guide for racesight.cloud

This guide covers setting up SSL certificates for the production deployment of racesight.cloud using Let's Encrypt (Certbot) with Docker nginx.

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

## Step 3: Install Certbot on Azure VM

SSH into your Azure VM and install Certbot:

```bash
# Update package list
sudo apt-get update

# Install Certbot and nginx plugin (for future use, though we use standalone mode)
sudo apt-get install -y certbot

# Verify installation
certbot --version
```

## Step 4: Prepare SSL Certificate Directory

Create the SSL directory structure that Docker nginx will use:

```bash
# Navigate to your project directory
cd /path/to/RaceSight

# Ensure SSL directory exists
mkdir -p docker/nginx/ssl

# Set appropriate permissions
chmod 755 docker/nginx/ssl
```

## Step 5: Obtain SSL Certificates (Initial Setup)

Since nginx is running in Docker, we'll use Certbot's standalone mode which temporarily binds to port 80.

### Option A: Using the Helper Script

```bash
cd docker/nginx/scripts
chmod +x obtain-ssl-cert.sh
./obtain-ssl-cert.sh
```

### Option B: Manual Certificate Generation

1. **Temporarily stop nginx container** (Certbot needs port 80):
   ```bash
   cd docker/compose
   docker compose -f nginx.yml stop nginx
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
   sudo cp /etc/letsencrypt/live/racesight.cloud/fullchain.pem docker/nginx/ssl/
   sudo cp /etc/letsencrypt/live/racesight.cloud/privkey.pem docker/nginx/ssl/
   
   # Set appropriate permissions
   sudo chmod 644 docker/nginx/ssl/fullchain.pem
   sudo chmod 600 docker/nginx/ssl/privkey.pem
   sudo chown $USER:$USER docker/nginx/ssl/*.pem
   ```

4. **Restart nginx container**:
   ```bash
   cd docker/compose
   docker compose -f nginx.yml start nginx
   ```

5. **Verify HTTPS is working**:
   ```bash
   curl -I https://racesight.cloud
   curl -I https://www.racesight.cloud
   ```

## Step 6: Configure Production Environment

Ensure your production environment variables are set:

```bash
# In your .env.production or .env file
NGINX_CONFIG=prod
NODE_ENV=production
```

## Step 7: Set Up SSL Auto-Renewal

Let's Encrypt certificates expire after 90 days. Set up automatic renewal:

### Option A: Using the Renewal Script

The renewal script handles Docker nginx reload automatically:

```bash
# Add to crontab (runs twice daily)
sudo crontab -e

# Add this line:
0 0,12 * * * /path/to/RaceSight/docker/nginx/scripts/renew-ssl-cert.sh >> /var/log/certbot-renewal.log 2>&1
```

### Option B: Manual Renewal Setup

1. **Create renewal script** (see `docker/nginx/scripts/renew-ssl-cert.sh`)

2. **Add to crontab**:
   ```bash
   sudo crontab -e
   # Add: 0 0,12 * * * /path/to/renew-ssl-cert.sh
   ```

3. **Test renewal** (dry run):
   ```bash
   sudo certbot renew --dry-run
   ```

## Step 8: Verify SSL Configuration

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

### Certificate Generation Fails

- **DNS not propagated**: Wait longer or check DNS resolution
- **Port 80 blocked**: Verify Azure NSG rules
- **Nginx still running**: Ensure nginx container is stopped during certificate generation

### Certificates Not Loading in Docker

- **File permissions**: Ensure certificates are readable by Docker
- **File paths**: Verify certificates are in `docker/nginx/ssl/`
- **Nginx config**: Check that SSL paths in `nginx-prod.conf` match mounted volume

### Renewal Fails

- **Port 80 in use**: Ensure nginx is stopped during renewal (handled by renewal script)
- **DNS issues**: Verify DNS records are still correct
- **Check logs**: Review `/var/log/letsencrypt/letsencrypt.log`

## Maintenance

### Manual Certificate Renewal

If auto-renewal fails, manually renew:

```bash
cd docker/nginx/scripts
./renew-ssl-cert.sh
```

### Certificate Expiration Check

```bash
# Check expiration dates
sudo certbot certificates

# Check specific certificate
openssl x509 -in docker/nginx/ssl/fullchain.pem -noout -dates
```

## Security Notes

1. **Private key protection**: The `privkey.pem` file should have permissions `600` (owner read/write only)
2. **Certificate location**: Certificates are stored in `docker/nginx/ssl/` which is mounted as read-only in Docker
3. **Auto-renewal**: Certificates are automatically renewed before expiration (30 days before expiry)
4. **HSTS**: HTTP Strict Transport Security is enabled in the nginx configuration

## Additional Resources

- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [Certbot User Guide](https://eff-certbot.readthedocs.io/)
- [Nginx SSL Configuration](https://nginx.org/en/docs/http/configuring_https_servers.html)

