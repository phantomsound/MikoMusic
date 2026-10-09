const express = require('express');
const fs = require('fs');
const { QueueRepeatMode } = require('discord-player');
const app = express();

process.on('unhandledRejection', error => console.error('Unhandled Rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught Exception:', error));

app.use(express.json());
app.use(express.static('public'));

function updateConfig(newValues) {
    let config = {};
    try { config = JSON.parse(fs.readFileSync('./config.json', 'utf-8')); } catch (e) {}
    config = { ...config, ...newValues };
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
}

function startServer(discordClient) {
    app.get('/api/config', (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
            res.json({ ...config, clientId: process.env.CLIENT_ID });
        } catch (e) { res.json({ clientId: process.env.CLIENT_ID, savedPlaylists: [] }); }
    });

    app.get('/api/server-info', (req, res) => {
        const guild = discordClient.guilds.cache.first();
        res.json({ serverName: guild ? guild.name : "Not Connected" });
    });

    app.get('/api/channels', (req, res) => {
        try {
            const guild = discordClient.guilds.cache.first();
            if (!guild) return res.json([]);
            res.json(guild.channels.cache.filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name })));
        } catch (e) { res.json([]); }
    });

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
            if (!queue) return res.json({ current: null, tracks: [], volume: 100 });
            res.json({
                current: queue.currentTrack ? queue.currentTrack.title : null,
                tracks: queue.tracks.map((t, i) => ({ index: i + 1, title: t.title })),
                volume: queue.node.volume
            });
        } catch (e) { res.json({ current: null, tracks: [], volume: 100 }); }
    });

    app.post('/api/settings', (req, res) => {
        updateConfig(req.body);
        res.json({ success: true });
    });

    app.post('/api/playlists', (req, res) => {
        updateConfig({ savedPlaylists: req.body.playlists });
        res.json({ success: true });
    });

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

    app.post('/api/volume', (req, res) => {
        try {
            const queue = discordClient.player?.nodes?.cache?.first();
            if (!queue) return res.json({ success: false, message: "Nothing playing." });
            queue.node.setVolume(Number(req.body.volume));
            res.json({ success: true });
        } catch (e) { res.json({ success: false, message: e.message }); }
    });

    // Remote Dashboard Play/Queue Integration
    app.post('/api/play', async (req, res) => {
        try {
            const { query } = req.body;
            const guild = discordClient.guilds.cache.first();
            if (!guild) return res.json({ success: false, message: "No server connected." });

            const queue = discordClient.player.nodes.get(guild.id);
            const vChannel = queue?.channel;
            if (!vChannel) return res.json({ success: false, message: "Bot is not in a voice channel. Use the Remote Voice Connection to join a channel first!" });

            const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8') || '{}');
            const playlists = config.savedPlaylists || [];
            const cleanQuery = query.toLowerCase().trim();
            const matchedMacro = playlists.find(pl => pl.shortcode && pl.shortcode.toLowerCase() === cleanQuery);
            let safeQuery = matchedMacro ? matchedMacro.url : query;
            if (safeQuery.includes('music.youtube.com')) safeQuery = safeQuery.replace('music.youtube.com', 'www.youtube.com');

            const { track } = await discordClient.player.play(vChannel, safeQuery, {
                nodeOptions: {
                    metadata: { channel: vChannel, panelMessage: queue.metadata?.panelMessage },
                    leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false
                }
            });
            res.json({ success: true, title: track.playlist ? track.playlist.title : track.title });
        } catch(e) {
            res.json({ success: false, message: e.message });
        }
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

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🌐 Web UI running on port ${port}`));
}
module.exports = { startServer };
