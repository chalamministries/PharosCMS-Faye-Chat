# PharosCMS Faye Chat Server

A real-time WebSocket chat server for PharosCMS, built with [Faye](https://faye.jcoglan.com/) and Node.js.

## ✅ Purpose

- Serves `/chat` WebSocket endpoint for direct client connections
- Exposes `/api/send-message` HTTP endpoint for PHP backend to push messages
- Relays Faye pub/sub events (e.g., `/cases/{id}/messages`) into chat rooms
- Auto-reloads Let's Encrypt certificates on renewal — **no restart required**

## 🚀 Deployment

### Prerequisites
- Node.js 18+
- Let's Encrypt certs installed at `/home/admin/conf/web/api.pharoscms.com/ssl/`
- nginx proxy configured (see below)

### Install on Hestia
```bash
cd /home/admin/web/api.pharoscms.com/
git clone https://github.com/chalamministries/PharosCMS-Faye-Chat.git faye-chat
cd faye-chat
npm install
```

### systemd
Enable auto-start:
```bash
sudo cp faye-chat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now faye-chat.service
```

### nginx Proxy (add to `/home/admin/conf/web/api.pharoscms.com/nginx.conf`)
```nginx
location /chat {
    proxy_pass https://127.0.0.1:2096;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_ssl_verify off;
}

location /faye {
    proxy_pass https://127.0.0.1:2096;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_ssl_verify off;
}
```
Then reload: `sudo nginx -t && sudo systemctl reload nginx`

## 🔐 Security
- Certificates auto-reloaded via `SNICallback` — no manual restarts
- Runs as `admin` user, isolated from web root (`public_html/`)
- `node_modules/` not committed — installed at deploy time

## 📡 Ports
- `2096/tcp` (HTTPS) — main service port (exposed only to nginx, not public)

## 📜 License
MIT
