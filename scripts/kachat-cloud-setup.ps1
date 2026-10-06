# === KaChat self-hosted cloud (Windows / PowerShell as Administrator) ===
$KC = "$HOME\kachat-cloud"; New-Item -ItemType Directory -Force -Path $KC | Out-Null; Set-Location $KC

# 1) Install Docker Desktop if missing
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
  Write-Host "Docker Desktop installed. Launch it from the Start Menu, finish first-run setup, then paste this block again." -ForegroundColor Yellow
  return
}
Write-Host "Waiting for the Docker engine to be ready..."
while (-not (docker info 2>$null)) { Start-Sleep 3 }

# 2) Secrets + LAN IP
# Secrets come from the OS crypto RNG (Get-Random is not meant for passwords).
function Gen { $b = New-Object byte[] 16; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { '{0:x2}' -f $_ }) }
$LAN = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
if (-not $LAN) { $LAN = "127.0.0.1" }
if (-not (Test-Path .env)) {
@"
DB_ROOT_PASSWORD=$(Gen)
DB_PASSWORD=$(Gen)
NC_ADMIN_USER=admin
NC_ADMIN_PASSWORD=$(Gen)
IMAGINARY_SECRET=$(Gen)
NC_TRUSTED_DOMAINS=localhost 127.0.0.1 $LAN
DUCKDNS_SUBDOMAIN=changeme
DUCKDNS_TOKEN=changeme
"@ | Set-Content -Encoding ASCII .env
}
# Nginx Proxy Manager's admin login, pre-seeded so the admin page is never left unclaimed.
# Added to an older .env too (NPM only uses it on its very first start).
if (-not (Select-String -Path .env -Pattern '^NPM_ADMIN_PASSWORD=' -Quiet)) {
  Add-Content -Encoding ASCII .env "NPM_ADMIN_EMAIL=admin@example.com"
  Add-Content -Encoding ASCII .env "NPM_ADMIN_PASSWORD=$(Gen)"
}
# Where plain-HTTP Nextcloud (port 8080) listens. 127.0.0.1 = this machine only. Set 0.0.0.0
# only for a home-network-only setup behind a router that does NOT forward port 8080.
if (-not (Select-String -Path .env -Pattern '^NC_HTTP_BIND=' -Quiet)) {
  Add-Content -Encoding ASCII .env "NC_HTTP_BIND=127.0.0.1"
}

# 3) Custom Nextcloud image with ffmpeg (needed for video thumbnails)
@'
FROM nextcloud:34.0.4-apache
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
'@ | Set-Content -Encoding ASCII Dockerfile.nextcloud

# 4) The stack
@'
name: kachat-cloud
services:
  npm:
    image: jc21/nginx-proxy-manager:2.16.0
    restart: unless-stopped
    # 80/443 are the public entrance. The admin page (81) listens on this machine only.
    ports: ["80:80", "443:443", "127.0.0.1:81:81"]
    environment:
      INITIAL_ADMIN_EMAIL: ${NPM_ADMIN_EMAIL}
      INITIAL_ADMIN_PASSWORD: ${NPM_ADMIN_PASSWORD}
    volumes:
      - npm_data:/data
      - npm_letsencrypt:/etc/letsencrypt
    networks: [cloud]
  portainer:
    image: portainer/portainer-ce:2.45.1
    restart: unless-stopped
    # Portainer holds the Docker socket (root on this machine): this machine only.
    ports: ["127.0.0.1:9443:9443"]
    volumes:
      - //var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data
    networks: [cloud]
  nextcloud-db:
    image: mariadb:10.11.19
    restart: unless-stopped
    command: --transaction-isolation=READ-COMMITTED --log-bin=binlog --binlog-format=ROW
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: ${DB_PASSWORD}
    volumes: ["nextcloud_db:/var/lib/mysql"]
    networks: [cloud]
  nextcloud-redis:
    image: redis:7.4.11-alpine
    restart: unless-stopped
    networks: [cloud]
  imaginary:
    image: nextcloud/aio-imaginary:20260929_105435
    restart: unless-stopped
    cap_add: ["SYS_NICE"]
    environment:
      IMAGINARY_SECRET: ${IMAGINARY_SECRET}
    networks: [cloud]
  nextcloud:
    build:
      context: .
      dockerfile: Dockerfile.nextcloud
    restart: unless-stopped
    # Plain HTTP: this machine only (NC_HTTP_BIND in .env). Other devices go through NPM.
    ports: ["${NC_HTTP_BIND:-127.0.0.1}:8080:80"]
    environment:
      MYSQL_HOST: nextcloud-db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: ${DB_PASSWORD}
      REDIS_HOST: nextcloud-redis
      NEXTCLOUD_ADMIN_USER: ${NC_ADMIN_USER}
      NEXTCLOUD_ADMIN_PASSWORD: ${NC_ADMIN_PASSWORD}
      NEXTCLOUD_TRUSTED_DOMAINS: ${NC_TRUSTED_DOMAINS}
      TRUSTED_PROXIES: 172.16.0.0/12
    depends_on: [nextcloud-db, nextcloud-redis, imaginary]
    volumes: ["nextcloud_data:/var/www/html"]
    networks: [cloud]
  duckdns:
    image: linuxserver/duckdns:d860cc34-ls92
    restart: unless-stopped
    profiles: [public]
    environment:
      SUBDOMAINS: ${DUCKDNS_SUBDOMAIN}
      TOKEN: ${DUCKDNS_TOKEN}
    networks: [cloud]
volumes:
  npm_data:
  npm_letsencrypt:
  portainer_data:
  nextcloud_db:
  nextcloud_data:
networks:
  cloud:
'@ | Set-Content -Encoding ASCII docker-compose.yml

# 5) Build and start (only continue to preview setup if this succeeds)
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
  Write-Host "!! Build or start failed — scroll up to read the error, fix it, then paste this block again." -ForegroundColor Yellow
} else {

# 6) Wait for setup, then switch on photo/video previews
Write-Host "Waiting for Nextcloud to finish first-time setup (can take a few minutes)..."
$tries = 0
do { Start-Sleep 5; $tries++; $st = docker compose exec -T -u www-data nextcloud php occ status 2>$null } until ($st -match "installed: true" -or $tries -gt 120)
$SECRET = (Select-String -Path .env -Pattern 'IMAGINARY_SECRET=(.*)').Matches.Groups[1].Value
function occ { docker compose exec -T -u www-data nextcloud php occ @args }
occ config:system:set enable_previews --value=true --type=boolean
occ config:system:set preview_max_x --value=2048
occ config:system:set preview_max_y --value=2048
occ config:system:set preview_imaginary_url --value=http://imaginary:9000
occ config:system:set preview_imaginary_key --value="$SECRET"
occ config:system:delete enabledPreviewProviders 2>$null
occ config:system:set enabledPreviewProviders 0 --value='OC\Preview\Imaginary'
occ config:system:set enabledPreviewProviders 1 --value='OC\Preview\Movie'
occ config:system:set enabledPreviewProviders 2 --value='OC\Preview\MP4'
occ config:system:set enabledPreviewProviders 3 --value='OC\Preview\MOV'
occ config:system:set enabledPreviewProviders 4 --value='OC\Preview\MKV'
occ config:system:set enabledPreviewProviders 5 --value='OC\Preview\AVI'
occ app:install previewgenerator 2>$null

Write-Host ""
Write-Host "================ KaChat cloud is ready ================"
$NPM_EMAIL = (Select-String -Path .env -Pattern '^NPM_ADMIN_EMAIL=(.*)').Matches.Groups[1].Value
Write-Host "On THIS machine:"
Write-Host "  Nextcloud            ->  http://127.0.0.1:8080"
Write-Host "  Nginx Proxy Manager  ->  http://127.0.0.1:81   (login: $NPM_EMAIL + NPM_ADMIN_PASSWORD from .env)"
Write-Host "  Portainer            ->  https://127.0.0.1:9443 (create your admin user within 5 min)"
Write-Host ""
Write-Host "The admin pages only listen on this machine. From another computer, use an SSH tunnel"
Write-Host "(needs the Windows OpenSSH server), or open them on this PC:"
Write-Host "  ssh -L 8081:127.0.0.1:81 -L 9443:127.0.0.1:9443 -L 8080:127.0.0.1:8080 $env:USERNAME@$LAN"
Write-Host "Other devices reach Nextcloud through Nginx Proxy Manager on 80/443 (README: Step 3b)."
Write-Host ""
Write-Host "Your Nextcloud and Nginx Proxy Manager logins are saved in:  $KC\.env"
Write-Host "(If Nginx Proxy Manager was already set up before, its existing login still applies.)"
Write-Host "======================================================"
}
