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

    app.get('/api/channels', (req, res) => {
        const guild = discordClient.guilds.cache.first();
        if (!guild) return res.json([]);
        const channels = guild.channels.cache.filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name }));
        res.json(channels);
    });

    app.get('/api/queue', (req, res) => {
        const queue = discordClient.player?.nodes?.cache?.first();
        if (!queue) return res.json({ current: null, tracks: [] });
        res.json({
            current: queue.currentTrack ? queue.currentTrack.title : null,
            tracks: queue.tracks.map((t, i) => ({ index: i + 1, title: t.title }))
        });
    });

    app.post('/api/update-channels', (req, res) => {
        const { panelChannelId, logChannelId } = req.body;
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        config.panelChannelId = panelChannelId;
        config.logChannelId = logChannelId;
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        res.json({ success: true });
    });

    app.post('/api/playlists', (req, res) => {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        config.savedPlaylists = req.body.playlists;
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        res.json({ success: true });
    });

    app.post('/api/control', async (req, res) => {
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
        
        // Force Panel Update if it exists
        if (queue.metadata && queue.metadata.panelMessage) {
            try {
                const { EmbedBuilder } = require('discord.js');
                const current = queue.currentTrack;
                const upNext = queue.tracks.toArray().slice(0, 2);
                const embed = new EmbedBuilder().setColor('#89b4fa').setTitle('🎛️ Miko Music Control Panel');
                if (current) {
                    embed.addFields({ name: '▶️ Now Playing', value: `[**${current.title}**](${current.url}) - \`${current.duration}\`` });
                    const nextText = upNext.length > 0 ? upNext.map((t, i) => `**${i+1}.** ${t.title}`).join('\n') : 'Queue is empty.';
                    embed.addFields({ name: '⏭️ Up Next', value: nextText });
                    const mode = queue.repeatMode === QueueRepeatMode.TRACK ? 'Track' : queue.repeatMode === QueueRepeatMode.QUEUE ? 'Queue' : 'Off';
                    embed.setFooter({ text: `Queue: ${queue.tracks.size} tracks | Loop: ${mode}` });
                } else {
                    embed.setDescription('*Nothing is currently playing.*');
                    embed.setFooter({ text: 'Queue is empty' });
                }
                await queue.metadata.panelMessage.edit({ embeds: [embed] });
            } catch(e){}
        }
        
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
