# MikoMusic

A self-hosted, unrestrictive Discord Music Bot heavily inspired by MatchBox Bot. 

## Philosophy & Features
- **Zero Restrictions**: No voting locks, no paywalls, no queue caps.
- **24/7 Autoplay**: The bot will not leave when the queue ends unless you command it to.
- **Dedicated Channel Routing**: Set a specific channel for the `/summon` panel, and pipe all "Now Playing" logs to a separate notification channel.
- **Live Queue Editing**: Move tracks around the queue via Discord (`/move`) or via the Web Dashboard.
- **Notepad Playlists**: Save and hot-load playlists securely from your local UI.

## Local Hosting
1. Clone the repo and run `npm install`.
2. Setup your credentials in `.env` (Requires `DISCORD_TOKEN` and `CLIENT_ID`).
3. Run `node index.js` (Access the Web UI at Port 3000).

## Built With
- Discord.js v14
- Discord-Player v6
- Express Web Dashboard
