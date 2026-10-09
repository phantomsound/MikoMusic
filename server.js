const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const { QueueRepeatMode } = require('discord-player');
const app = express();

process.on('unhandledRejection', error => console.error('Unhandled Rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught Exception:', error));

app.use(express.json());
app.use(express.static('public'));

function startServer(discordClient) {
    app.get('/api/config', (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
            res.json({ ...config, clientId: process.env.CLIENT_ID });
        } catch (e) { res.json({ clientId: process.env.CLIENT_ID, savedPlaylists: [] }); }
    });

    app.get('/api/channels', (req, res) => {
        try {
            const guild = discordClient.guilds.cache.first();
            if (!guild) return res.json([]);
            res.json(guild.channels.cache.filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name })));
        } catch (e) { res.json([]); }
    });

    // NEW: Fetch Voice Channels for Mobile UI
    app.get('/api/voice-channels', (req, res) => {
        try {
            const guild = discordClient.guilds.cache.first();
            if (!guild) return res.json([]);
            res.json(guild.channels.cache.filter(c => c.isVoiceBased()).map(c => ({ id: c.id, name: c.name })));
        } catch (e) { res.json([]); }
    });

    app.get('/api/queue', (req, res) => {
        try {
            const queue = discordClient.player?.nodes?.cache?.first();
            if (!queue) return res.json({ current: null, tracks: [] });
            res.json({
                current: queue.currentTrack ? queue.currentTrack.title : null,
                tracks: queue.tracks.map((t, i) => ({ index: i + 1, title: t.title }))
            });
        } catch (e) { res.json({ current: null, tracks: [] }); }
    });

    app.post('/api/update-channels', (req, res) => {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        config.panelChannelId = req.body.panelChannelId;
        config.logChannelId = req.body.logChannelId;
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        res.json({ success: true });
    });

    app.post('/api/playlists', (req, res) => {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        config.savedPlaylists = req.body.playlists;
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        res.json({ success: true });
    });

    // NEW: Handle Remote Voice Join & Disconnect
    app.post('/api/voice', async (req, res) => {
        try {
            const { action, channelId } = req.body;
            const guild = discordClient.guilds.cache.first();
            if (!guild) return res.json({ success: false, message: "No active Discord server found." });

            if (action === 'join') {
                if (!channelId) return res.json({ success: false, message: "Please select a Voice Channel." });
                const queue = discordClient.player.nodes.create(guild, { 
                    metadata: { channel: guild.channels.cache.get(channelId), panelMessage: null }, 
                    leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false 
                });
                if (!queue.connection) await queue.connect(channelId);
                return res.json({ success: true });
            }
            if (action === 'disconnect') {
                const queue = discordClient.player.nodes.get(guild.id);
                if (queue) queue.delete();
                return res.json({ success: true });
            }
        } catch (e) { res.json({ success: false, message: e.message }); }
    });

    app.post('/api/control', async (req, res) => {
        try {
            const { action, from, to } = req.body;
            const queue = discordClient.player?.nodes?.cache?.first();
            if (!queue) return res.json({ success: false, message: "No active music session." });

            if (action === 'pause') queue.node.setPaused(!queue.node.isPaused());
            if (action === 'skip') queue.node.skip();
            if (action === 'stop') queue.delete();
            if (action === 'back' && queue.history.previousTrack) await queue.history.previous();
            if (action === 'shuffle') queue.tracks.shuffle();
            if (action === 'loopTrack') queue.setRepeatMode(QueueRepeatMode.TRACK);
            if (action === 'loopQueue') queue.setRepeatMode(QueueRepeatMode.QUEUE);
            if (action === 'loopOff') queue.setRepeatMode(QueueRepeatMode.OFF);
            if (action === 'move') {
                const tracks = queue.tracks.toArray();
                if (from < 1 || from > tracks.length || to < 1) return res.json({ success: false, message: "Invalid index" });
                const track = tracks[from - 1];
                queue.node.remove(track);
                queue.node.insert(track, to - 1);
            }
            res.json({ success: true });
        } catch (e) { res.json({ success: false, message: e.message }); }
    });

    app.post('/api/update-extractors', (req, res) => {
        exec('npm install discord-player-youtubei youtube-ext play-dl @distube/ytdl-core@latest', () => {
            res.json({ success: true });
            setTimeout(() => process.exit(0), 2000); 
        });
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🌐 Web UI running on port ${port}`));
}
module.exports = { startServer };
