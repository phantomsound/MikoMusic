const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const app = express();

app.use(express.json());
app.use(express.static('public'));

function logAudit(action, details = '') {
    const file = './audit.json';
    let logs = [];
    if (fs.existsSync(file)) {
        try { logs = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { logs = []; }
    }
    const entry = {
        timestamp: new Date().toLocaleString(),
        action,
        details
    };
    logs.unshift(entry);
    if (logs.length > 50) logs = logs.slice(0, 50); // Keep last 50 events
    fs.writeFileSync(file, JSON.stringify(logs, null, 2));
}

function startServer(discordClient) {
    app.get('/api/config', (req, res) => {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        res.json({
            ...config,
            clientId: process.env.CLIENT_ID
        });
    });

    app.get('/api/audit', (req, res) => {
        const file = './audit.json';
        if (fs.existsSync(file)) {
            try { return res.json(JSON.parse(fs.readFileSync(file, 'utf-8'))); } catch (e) {}
        }
        res.json([]);
    });

    app.post('/api/update', async (req, res) => {
        const { botName, newPlaylistName, newPlaylistUrl, adminUsers, adminRoles } = req.body;
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

        if (botName && botName !== config.botName) {
            try {
                await discordClient.user.setUsername(botName);
                logAudit("Bot Renamed", `Changed username to "${botName}"`);
                config.botName = botName;
            } catch (err) { console.error("Rate limited on username change."); }
        }

        if (newPlaylistName && newPlaylistUrl) {
            if (!config.savedPlaylists) config.savedPlaylists = [];
            config.savedPlaylists.push({ name: newPlaylistName, url: newPlaylistUrl });
            logAudit("Playlist Added", `"${newPlaylistName}"`);
        }
        
        if (adminUsers !== undefined && adminUsers !== (config.adminUsers || []).join(', ')) {
            config.adminUsers = adminUsers.split(',').map(s => s.trim()).filter(s => s);
            logAudit("Permissions Updated", `Admin Users updated`);
        }
        if (adminRoles !== undefined && adminRoles !== (config.adminRoles || []).join(', ')) {
            config.adminRoles = adminRoles.split(',').map(s => s.trim()).filter(s => s);
            logAudit("Permissions Updated", `Admin Roles updated`);
        }

        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        res.json({ success: true, config });
    });

    app.post('/api/control', (req, res) => {
        const { action } = req.body;
        const queue = discordClient.player?.nodes?.cache?.first();
        
        if (!queue) return res.json({ success: false, message: "No active music session in Discord." });

        if (action === 'pause') {
            queue.node.setPaused(!queue.node.isPaused());
            logAudit("Playback Override", queue.node.isPaused() ? "Paused audio" : "Resumed audio");
        }
        if (action === 'skip') {
            queue.node.skip();
            logAudit("Playback Override", "Skipped active track");
        }
        if (action === 'stop') {
            queue.delete();
            logAudit("Playback Override", "Disconnected bot and cleared queue");
        }
        
        res.json({ success: true });
    });

    app.post('/api/update-extractors', (req, res) => {
        logAudit("Maintenance", "Emergency YouTube extractor update triggered");
        exec('npm install discord-player-youtubei youtube-ext play-dl @distube/ytdl-core@latest', (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true });
            setTimeout(() => process.exit(0), 2000); 
        });
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🌐 Web UI running on http://localhost:${port}`));
}
module.exports = { startServer };
