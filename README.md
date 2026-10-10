# 🎧 Miko Discord Music Bot & Web Dashboard

[![Node.js](https://img.shields.io/badge/Node.js-20+-68a063?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![Discord-Player](https://img.shields.io/badge/Discord--Player-v7-ff007f)](https://discord-player.js.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A high-performance, self-hosted Discord music bot with a rich real-time web dashboard. Designed with zero audio restrictions, multi-server isolation, smart voice channel auto-detection, persistent per-server volumes, and self-cleaning Discord notifications.

---

## 🌟 Key Features

* **🖥️ Real-Time Web Dashboard (`http://localhost:3000`)**
  * Live track playback status, queue view, and 10-track play history.
  * Drag-and-drop queue reordering and position index shifting.
  * Live search filter to find or remove tracks instantly.
  * Direct URL streaming and shortcode macros.
  * Instant token and configuration hot-reload directly from the UI without restarting.

* **🌐 Multi-Server Isolation**
  * Switch between connected Discord servers with a single dropdown click.
  * Independent audio queues, volume levels, history, and voice connection states for each guild.

* **🎯 Smart Voice Channel Auto-Detection**
  * Auto-scans channels and connects to where active listeners currently are (`🎯 Auto-Detect (Join Where People Are)`).
  * Real-time active member count indicators next to each voice channel option.
  * Save a preferred fallback voice channel per server with the **⭐ Set Default** button.
  * **Auto-Join on Play:** Playing music when the bot is disconnected automatically detects where listeners are and connects before starting audio.

* **🔊 Persistent Volume Controls**
  * Volume adjustments from the dashboard slider or mute button persist to `config.json` and are saved per server (`guildVolumes`).
  * Persists across track transitions, new queues, and bot reboots.
  * Real-time percentage display with debounced API sync.

* **⏱️ Configurable Auto-Dismiss & Wipe Schedules**
  * Keep Discord text channels clean with selectable notification dismissal:
    * **15 Seconds** (Quick Fade)
    * **30 Seconds**
    * **60 Seconds** (Default)
    * **Hourly Wipe** (Every 60 minutes)
    * **Daily Wipe** (Every 24 hours)
    * **Off** (Keep all messages)
  * **🧹 Wipe Now Button:** One-click manual sweep to clear temporary bot logs at any time.
  * **🛡️ Protected Embeds:** Automated wipes preserve the permanent Command Center and Standby Hub panels.

* **📂 Playlist Hot-Load Macros & Shortcodes**
  * Save Spotify and YouTube playlists with shortcodes (e.g. `fng` for Friday Night Gamers).
  * Direct **▶ Load** button instantly purges the active queue and streams the playlist.
  * Quick links to open and manage playlists directly on Spotify or YouTube.

* **🤖 Interactive Discord Command Center**
  * Discord control panel equipped with interactive buttons: Pause/Play, Skip, Back, Shuffle, Clear Queue, Loop 1, Loop All, and Queue Pagination.
  * Track Move modal allows Discord users to reorder songs without leaving the chat.
  * Summon Standby Banner for quick one-click voice channel summoning.

* **🛡️ Gateway Rate-Limit & Cache Resiliency**
  * Dynamic Gateway Identify session quota tracking with live countdown timer.
  * HTTP 304 cache bypass with strict `no-store` headers for reliable dashboard polling.

---

## 📋 Prerequisites

* **Node.js**: `20.x` or higher (LTS recommended)
* **FFmpeg**: Handled automatically via `ffmpeg-static` (or install system `ffmpeg`)
* **Discord Bot**: Application created in the [Discord Developer Portal](https://discord.com/developers/applications)

---

## 🚀 Quickstart (Local Machine)

### 1. Clone the Repository
```bash
git clone https://github.com/phantomsound/MikoMusic.git
cd MikoMusic
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Credentials
Copy the example environment file:
```bash
cp .env.example .env
```
Open `.env` and fill in your Discord credentials:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here
PORT=3000
```

> **Tip:** You can also launch the bot with an empty `.env` and configure your Bot Token directly from the **⚙️ System Tools** tab in the Web Dashboard!

### 4. Start the Application
```bash
npm start
```
Open your browser and navigate to:
```
http://localhost:3000
```

---

## 🤖 Discord Developer Portal Setup

To allow the bot to play audio, read commands, and connect to voice channels:

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Under **Bot**, click **Reset Token** and copy your token to `.env` as `DISCORD_TOKEN`.
3. Under **Privileged Gateway Intents**, enable:
   * ✅ **Server Members Intent**
   * ✅ **Message Content Intent**
4. Under **General Information**, copy your **Application ID** to `.env` as `CLIENT_ID`.
5. Under **OAuth2 > URL Generator**:
   * Scopes: `bot`, `applications.commands`
   * Bot Permissions: `Administrator` (or: `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `Manage Messages`, `Connect`, `Speak`, `Use Voice Activity`).
6. Open the generated invite link to authorize the bot into your Discord servers (or click **➕ Invite Bot** in the Web Dashboard).

---

## 🐳 Hosting Guide 1: Docker (Recommended for Servers)

Docker provides an isolated, reliable environment without installing Node.js or FFmpeg directly on your host.

### Using Docker Compose (Easiest)

1. Make sure [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/) are installed.
2. Clone the repo and configure `.env`:
   ```bash
   git clone https://github.com/phantomsound/MikoMusic.git
   cd MikoMusic
   cp .env.example .env
   nano .env
   ```
3. Start the container in detached mode:
   ```bash
   docker compose up -d
   ```
4. Check running status:
   ```bash
   docker compose ps
   docker compose logs -f
   ```
5. Access the dashboard at `http://your-server-ip:3000`.

### Manual Docker Build
```bash
# Build Docker image
docker build -t miko-music-bot .

# Run Docker container
docker run -d \
  --name miko-music \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v "$(pwd)/config.json:/usr/src/app/config.json" \
  -v "$(pwd)/logs:/usr/src/app/logs" \
  miko-music-bot
```

---

## ☁️ Hosting Guide 2: Linux VPS (Ubuntu / Debian)

If you have a cloud VPS (DigitalOcean, Linode, AWS EC2, Hetzner, Vultr):

### 1. Install Node.js & FFmpeg
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl ffmpeg git build-essential

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Clone and Setup
```bash
cd /opt
sudo git clone https://github.com/phantomsound/MikoMusic.git miko-music
cd miko-music
sudo npm install
sudo cp .env.example .env
sudo nano .env
```

### 3. Run 24/7 with PM2
[PM2](https://pm2.keymetrics.io/) keeps the bot running continuously and restarts it automatically after server reboots:

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start Miko Music
pm2 start index.js --name "miko-music"

# Save configuration and enable auto-start on boot
pm2 save
pm2 startup
```

Useful PM2 Commands:
```bash
pm2 status          # Check bot status
pm2 logs miko-music # View live bot logs
pm2 restart miko-music # Restart bot process
```

### 4. (Optional) Nginx Reverse Proxy with SSL (HTTPS)
If you want to access your dashboard securely via your own domain (e.g. `https://music.yourdomain.com`):

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/miko-music`:
```nginx
server {
    server_name music.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable site and acquire free SSL certificate:
```bash
sudo ln -s /etc/nginx/sites-available/miko-music /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d music.yourdomain.com
```

---

## 🌐 Hosting Guide 3: Cloud Platforms (Railway, Render, Fly.io)

### Railway (Recommended PaaS)
1. Fork or push this repository to your GitHub account.
2. Sign in to [Railway](https://railway.app/) and create a **New Project > Deploy from GitHub repo**.
3. Under **Variables**, add:
   * `DISCORD_TOKEN` = `your_token`
   * `CLIENT_ID` = `your_client_id`
   * `PORT` = `3000`
4. Railway will automatically detect the `Dockerfile` or `package.json` and deploy your bot.
5. In **Settings > Networking**, generate a public domain to access the web dashboard from anywhere.

### Render
1. Create a **New Web Service** on [Render](https://render.com/).
2. Connect your GitHub repository.
3. Runtime: **Node** or **Docker**.
4. Build Command: `npm install`
5. Start Command: `node index.js`
6. Add environment variables: `DISCORD_TOKEN`, `CLIENT_ID`, `PORT`.

---

## ⚙️ Configuration Reference

### `.env` File
| Variable | Description | Default |
| :--- | :--- | :--- |
| `DISCORD_TOKEN` | Bot authorization token from Discord Developer Portal | *Required* |
| `CLIENT_ID` | Application / Client ID for invite link generation | *Required* |
| `PORT` | Local port for Express Web UI | `3000` |
| `SPOTIFY_CLIENT_ID` | Spotify Client ID for metadata matching | Optional |
| `SPOTIFY_CLIENT_SECRET` | Spotify Client Secret | Optional |

### `config.json`
| Property | Description | Example |
| :--- | :--- | :--- |
| `defaultVolume` | Global fallback volume percentage (0–200) | `100` |
| `guildVolumes` | Map of persisted volumes per Discord server ID | `{"804535377062658059": 50}` |
| `autoDismiss` | Notification cleanup interval (`15s`, `30s`, `60s`, `hourly`, `daily`, `off`) | `"60s"` |
| `defaultVoiceChannels` | Map of saved default voice channel IDs per server | `{"804535377062658059": "1518424..."}` |
| `panelChannelId` | Text channel ID for the Discord Command Center embed | `""` |
| `logChannelId` | Text channel ID for "Now Streaming" notifications | `""` |
| `savedPlaylists` | Array of hot-load playlist objects `{ name, shortcode, url }` | `[...]` |
| `logRetentionDays` | Archive log file retention window in days | `7` |
| `logLevel` | Log verbosity (`normal`, `debug`, `verbose`) | `"normal"` |

---

## 🛠️ REST API Reference

The built-in web server exposes clean REST endpoints:

* `GET /api/server-info` - Retrieves host statistics, connected guilds, rate limit status, and bot identity.
* `GET /api/queue?guildId=<id>` - Returns active playback track, queued tracks, persisted volume, and history.
* `POST /api/play` - Streams track query or playlist URL `{ query, guildId }` (auto-joins active voice).
* `POST /api/control` - Triggers player actions `{ action: 'pause' | 'skip' | 'stop' | 'back' | 'shuffle' | 'loopTrack' | 'loopQueue' | 'loopOff' | 'remove' | 'move', guildId }`.
* `POST /api/volume` - Adjusts and persists volume `{ volume, guildId }`.
* `POST /api/voice` - Joins or disconnects voice channel `{ action: 'join' | 'disconnect', channelId: 'auto' | '<id>', guildId }`.
* `POST /api/voice/default` - Saves default voice channel for a guild `{ guildId, channelId }`.
* `POST /api/messages/wipe` - Instantly purges temporary bot notification logs from configured channels.
* `GET /api/config` - Fetches active application configuration.
* `POST /api/settings` - Updates tool configuration, channel routing, and credentials.
* `GET /api/logs` - Streams real-time service logs.
* `GET /api/logs/export` - Downloads consolidated logs as a text file.

---

## ❓ Troubleshooting

### 1. Bot connects but no audio plays
* Verify that `ffmpeg` is available or that the container installed `ffmpeg` correctly.
* In Discord Server Settings, ensure the bot role has the **Connect** and **Speak** permissions in the voice channel.

### 2. "Discord Login Failed: An invalid token was provided"
* Go to the [Discord Developer Portal](https://discord.com/developers/applications), reset the token, and paste the new token into the **⚙️ System Tools** tab in the dashboard or `.env`.

### 3. Rate-limited by Discord Gateway
* Discord limits bots to 1,000 identify sessions per 24 hours. The dashboard will automatically detect rate limits, display a countdown badge, and retry connection once the window clears without crashing.

---

## 📄 License

This project is open-source under the [MIT License](LICENSE).
Feel free to fork, customize, and self-host for your own Discord communities!
