const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const { QueueRepeatMode } = require('discord-player');
const app = express();

app.use(express.json());
app.use(express.static('public'));

function startServer(discordClient) {
    app.get('/api/config', (req, res) => {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        res.json({ ...config, clientId: process.env.CLIENT_ID });
    });

    // Update Core Config
    app.post('/api/update', async (req, res) => {
        const { adminUsers, adminRoles } = req.body;
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        
        if (adminUsers !== undefined) config.adminUsers = adminUsers.split(',').map(s => s.trim()).filter(s => s);
        if (adminRoles !== undefined) config.adminRoles = adminRoles.split(',').map(s => s.trim()).filter(s => s);

        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        res.json({ success: true, config });
    });

    // Full Array Replacement for Playlist Editing
    app.post('/api/playlists', (req, res) => {
        const { playlists } = req.body;
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        config.savedPlaylists = playlists;
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        res.json({ success: true });
    });

    // Extended Playback Controls
    app.post('/api/control', async (req, res) => {
        const { action } = req.body;
        const queue = discordClient.player?.nodes?.cache?.first();
        if (!queue) return res.json({ success: false, message: "No active music session." });

        if (action === 'pause') queue.node.setPaused(!queue.node.isPaused());
        if (action === 'skip') queue.node.skip();
        if (action === 'stop') queue.delete();
        if (action === 'back') await queue.history.previous();
        if (action === 'shuffle') queue.tracks.shuffle();
        if (action === 'loopTrack') queue.setRepeatMode(QueueRepeatMode.TRACK);
        if (action === 'loopQueue') queue.setRepeatMode(QueueRepeatMode.QUEUE);
        if (action === 'loopOff') queue.setRepeatMode(QueueRepeatMode.OFF);
        
        res.json({ success: true });
    });

    app.post('/api/update-extractors', (req, res) => {
        exec('npm install discord-player-youtubei youtube-ext play-dl @distube/ytdl-core@latest', (err) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true });
            setTimeout(() => process.exit(0), 2000); 
        });
    });

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🌐 Web UI running on port ${port}`));
}
module.exports = { startServer };
