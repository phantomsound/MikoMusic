const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { QueueRepeatMode } = require('discord-player');

function getConfig() { try { return JSON.parse(fs.readFileSync('./config.json', 'utf-8')); } catch (e) { return {}; } }
function saveConfig(cfg) { fs.writeFileSync('./config.json', JSON.stringify(cfg, null, 2)); }

function startServer(client) {
    const app = express();
    app.use(express.json());
    app.use(express.static('public'));

    app.get('/api/server-info', (req, res) => res.json({ serverName: process.env.COMPUTERNAME || 'MikoHome' }));

    app.get('/api/config', (req, res) => {
        const config = getConfig();
        res.json({ 
            dashboardName: config.dashboardName || 'Miko Music Dashboard',
            panelChannelId: config.panelChannelId || '',
            logChannelId: config.logChannelId || '',
            logRetentionDays: config.logRetentionDays || 7,
            logLevel: config.logLevel || 'normal',
            logDirectory: config.logDirectory || path.join(__dirname, 'logs'),
            logBackupSchedule: config.logBackupSchedule || 'daily',
            autoHideMessages: config.autoHideMessages || false,
            savedPlaylists: config.savedPlaylists || [],
            clientId: process.env.CLIENT_ID,
            spotifyClientId: config.spotifyClientId || '',
            spotifyClientSecret: config.spotifyClientSecret || ''
        });
    });

    app.get('/api/channels', (req, res) => {
        const channels = [];
        client.guilds.cache.forEach(g => g.channels.cache.filter(c => c.isTextBased()).forEach(c => channels.push({ id: c.id, name: `${g.name} - ${c.name}` })));
        res.json(channels);
    });

    app.get('/api/voice-channels', (req, res) => {
        const channels = [];
        client.guilds.cache.forEach(g => g.channels.cache.filter(c => c.isVoiceBased()).forEach(c => channels.push({ id: c.id, name: `${g.name} - ${c.name}` })));
        res.json(channels);
    });

    app.post('/api/settings', (req, res) => {
        const config = getConfig();
        if (req.body.panelChannelId !== undefined) config.panelChannelId = req.body.panelChannelId;
        if (req.body.logChannelId !== undefined) config.logChannelId = req.body.logChannelId;
        if (req.body.logRetentionDays !== undefined) config.logRetentionDays = parseInt(req.body.logRetentionDays);
        if (req.body.logLevel !== undefined) config.logLevel = req.body.logLevel;
        if (req.body.logDirectory !== undefined) config.logDirectory = req.body.logDirectory;
        if (req.body.logBackupSchedule !== undefined) config.logBackupSchedule = req.body.logBackupSchedule;
        if (req.body.autoHideMessages !== undefined) config.autoHideMessages = req.body.autoHideMessages;
        if (req.body.dashboardName !== undefined) config.dashboardName = req.body.dashboardName;
        if (req.body.spotifyClientId !== undefined) config.spotifyClientId = req.body.spotifyClientId;
        if (req.body.spotifyClientSecret !== undefined) config.spotifyClientSecret = req.body.spotifyClientSecret;
        saveConfig(config);
        res.json({ success: true });
    });

    app.post('/api/playlists', (req, res) => {
        const config = getConfig();
        config.savedPlaylists = req.body.playlists || [];
        saveConfig(config);
        res.json({ success: true });
    });

    app.get('/api/queue', (req, res) => {
        const queue = client.player.nodes.cache.first();
        if (!queue) return res.json({ current: null, tracks: [], volume: 100 });
        const tracks = queue.tracks.toArray().map((t, i) => ({ title: t.title, author: t.author, duration: t.duration, url: t.url, index: i + 1 }));
        res.json({ current: queue.currentTrack ? queue.currentTrack.title : null, tracks, volume: queue.node.volume });
    });

    app.post('/api/play', async (req, res) => {
        let { query } = req.body;
        if (!query) return res.json({ success: false, message: 'No query provided' });
        
        const config = getConfig();
        const playlists = config.savedPlaylists || [];
        const cleanQuery = query.toLowerCase().trim();
        const matchedMacro = playlists.find(pl => pl.shortcode && pl.shortcode.toLowerCase() === cleanQuery);
        if (matchedMacro) query = matchedMacro.url;

        let vc = null, txt = null;
        client.guilds.cache.forEach(g => {
            const member = g.members.cache.get(client.user.id);
            if (member && member.voice.channel) vc = member.voice.channel;
            if (config.panelChannelId && g.channels.cache.has(config.panelChannelId)) txt = g.channels.cache.get(config.panelChannelId);
        });

        if (!vc) return res.json({ success: false, message: 'Bot is not in a voice channel. Use the summon button first.' });
        if (!txt) txt = vc.guild.channels.cache.filter(c => c.isTextBased()).first();

        try {
            const existingQueue = client.player.nodes.get(vc.guild.id);
            const panelMsg = existingQueue && existingQueue.metadata ? existingQueue.metadata.panelMessage : null;
            await client.player.play(vc, query, { nodeOptions: { metadata: { channel: txt, panelMessage: panelMsg }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false, bufferingTimeout: 0 } });
            res.json({ success: true });
        } catch (e) { res.json({ success: false, message: e.message }); }
    });

    app.post('/api/control', (req, res) => {
        const queue = client.player.nodes.cache.first();
        if (!queue) return res.json({ success: false, message: 'Nothing playing' });
        
        try {
            const act = req.body.action;
            if (act === 'pause') queue.node.setPaused(!queue.node.isPaused());
            else if (act === 'skip') queue.node.skip();
            else if (act === 'stop') { queue.node.setPaused(false); queue.tracks.clear(); queue.node.skip(); }
            else if (act === 'back' && queue.history.previousTrack) queue.history.previous();
            else if (act === 'shuffle') queue.tracks.shuffle();
            else if (act === 'loopTrack') queue.setRepeatMode(QueueRepeatMode.TRACK);
            else if (act === 'loopQueue') queue.setRepeatMode(QueueRepeatMode.QUEUE);
            else if (act === 'loopOff') queue.setRepeatMode(QueueRepeatMode.OFF);
            else if (act === 'remove') {
                const idx = parseInt(req.body.index) - 1;
                const tracks = queue.tracks.toArray();
                if (idx >= 0 && idx < tracks.length) queue.node.remove(tracks[idx]);
            }
            else if (act === 'move') {
                const fromIdx = parseInt(req.body.from) - 1;
                const toIdx = parseInt(req.body.to) - 1;
                const tracks = queue.tracks.toArray();
                if (fromIdx >= 0 && toIdx >= 0 && fromIdx < tracks.length && toIdx < tracks.length) {
                    const t = tracks[fromIdx];
                    queue.node.remove(t);
                    queue.node.insert(t, toIdx);
                }
            }
            res.json({ success: true });
        } catch(e) { res.json({ success: false, message: e.message }); }
    });

    app.post('/api/volume', (req, res) => {
        const queue = client.player.nodes.cache.first();
        if (queue && req.body.volume !== undefined) queue.node.setVolume(parseInt(req.body.volume));
        res.json({ success: true });
    });

    app.post('/api/voice', async (req, res) => {
        const { action, channelId } = req.body;
        if (action === 'disconnect') {
            const queue = client.player.nodes.cache.first();
            if (queue) queue.delete();
            return res.json({ success: true });
        }
        if (action === 'join' && channelId) {
            let vc = null;
            client.guilds.cache.forEach(g => { if (g.channels.cache.has(channelId)) vc = g.channels.cache.get(channelId); });
            if (!vc) return res.json({ success: false, message: 'Voice channel not found.' });
            
            const config = getConfig();
            const txt = config.panelChannelId ? vc.guild.channels.cache.get(config.panelChannelId) : vc.guild.channels.cache.filter(c=>c.isTextBased()).first();
            const queue = client.player.nodes.create(vc.guild, { metadata: { channel: txt, panelMessage: null }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false, bufferingTimeout: 0 });
            await queue.connect(vc);
            return res.json({ success: true });
        }
        res.json({ success: false });
    });

    app.get('/api/logs', (req, res) => {
        const config = getConfig();
        const logPath = path.join(config.logDirectory || path.join(__dirname, 'logs'), 'bot.log');
        if (fs.existsSync(logPath)) {
            const logs = fs.readFileSync(logPath, 'utf-8').split('\n').slice(-60).join('\n');
            res.json({ logs });
        } else { res.json({ logs: 'Log file not found at: ' + logPath }); }
    });

    app.get('/api/logs/export', (req, res) => {
        const config = getConfig();
        const logPath = path.join(config.logDirectory || path.join(__dirname, 'logs'), 'bot.log');
        if (fs.existsSync(logPath)) res.download(logPath); else res.status(404).send('Log file not found.');
    });

    app.post('/api/system/restart', (req, res) => {
        res.json({ success: true, message: 'Restart command dispatched.' });
        setTimeout(() => { exec('powershell -Command "nssm restart MikoDiscordMusicBot"', (err) => { if (err) process.exit(0); }); }, 1000);
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🌐 Web UI running on port ${PORT}`));
}
module.exports = { startServer };
