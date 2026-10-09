# MikoMusic

A self-hosted, unrestrictive Discord Music Bot heavily inspired by MatchBox Bot. 

## V7 Architecture & Features
- **Discord Player v7 Engine**: Fully integrated with the `discord-player-youtubei` API to completely bypass Google IP blocks and natively stream Spotify and YouTube.
- **MatchBox UI**: Persistent, auto-updating `/summon` panels and ephemeral `/queue` logs that dynamically track your server state.
- **Remote Mobile Dashboard**: 
  - Manage bot voice connections directly from your phone.
  - Queue URLs or Shortcodes instantly from the UI without using Discord commands.
  - Full volume control, queue movement, and audio overrides.
- **Zero Restrictions**: No voting locks, no paywalls, no queue caps.
- **Notepad Playlists**: Save and hot-load playlists securely via assigned Shortcodes (e.g. type `fng` to queue Friday Night Gamers).

## Local Hosting
1. Setup your credentials in `config.json` and `.env` (Requires `DISCORD_TOKEN` and `CLIENT_ID`).
2. The UI is hosted natively on Port 3000 (`http://localhost:3000`).

## Built With
- Discord.js v14
- Discord-Player v7 & YoutubeiExtractor
- Express Web Dashboard
