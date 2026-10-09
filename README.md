# MikoDiscordMusicBot

A highly customized, self-hosted Discord Music Bot built with Discord.js v14 and Discord-Player. Includes an interactive Discord UI panel (`/summon`) and a local Web Dashboard for admin overrides.

## Features
- **Control Panel Dashboard**: Type `/summon` in Discord to spawn an interactive UI with buttons and dropdowns.
- **Dynamic Playlist Sync**: Automatically detects and queues new songs added to your live Spotify/YouTube playlists while playing.
- **Web Admin Interface**: Local Web UI (Port 3000) to adjust permissions, manage saved playlists, override live playback, and force-update extractors.

## Running Locally (Windows via NSSM)
1. Clone this repository.
2. Run `npm install`.
3. Rename `.env.example` to `.env` and add your `DISCORD_TOKEN` and `CLIENT_ID`.
4. Run `node index.js`. (To run as a background service, use NSSM).

## Running via Docker (Hosted on Linux/VPS)
1. Ensure Docker and docker-compose are installed.
2. Add your `.env` file to the root directory.
3. Run `docker-compose up -d`.
4. Access the Web UI at `http://YOUR_SERVER_IP:3000`.

*Note: Ensure `config.json` has read/write permissions so the Web UI can save your settings.*
