require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { Player, QueueRepeatMode } = require('discord-player');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const logger = require('./logger');

function getConfig() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')); } catch (e) { return { history: [] }; } }
function saveConfig(cfg) { fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 2)); }

function logHistory(songName) {
    const config = getConfig();
    if (!config.history) config.history = [];
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    config.history.unshift({ name: songName, time });
    if (config.history.length > 10) config.history.pop();
    saveConfig(config);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const player = new Player(client);
client.player = player;
logger.initLogger(client);

async function cleanChannel(channel, client, type = 'both') {
    try {
        const msgs = await channel.messages.fetch({ limit: 50 });
        for (const [id, m] of msgs) { 
            if (m.author.id === client.user.id) {
                const isStandby = m.embeds[0]?.title?.includes('Standby') || m.embeds[0]?.title?.includes('Hub');
                const isCommand = m.embeds[0]?.title?.includes('Command Center') || m.embeds[0]?.title?.includes('Control Panel');
                if (type === 'standby' && isStandby) await m.delete().catch(()=>{});
                if (type === 'command' && isCommand) await m.delete().catch(()=>{});
                if (type === 'both' && (isStandby || isCommand)) await m.delete().catch(()=>{});
            }
        }
    } catch(e) {}
}

async function logNowPlaying(guild, track, queue) {
    const config = getConfig();
    if (config.logChannelId) {
        try {
            const channel = guild.channels.cache.get(config.logChannelId);
            if (channel) {
                const sourceTag = track.url.includes('spotify') ? '🟢 Spotify' : '🔴 YouTube';
                const embed = new EmbedBuilder()
                    .setColor('#89b4fa')
                    .setAuthor({ name: '💿 Now Streaming' })
                    .setTitle(track.title)
                    .setURL(track.url)
                    .setDescription(`**Artist:** ${track.author}\n**Duration:** \`${track.duration}\` | **Source:** ${sourceTag}\n**Requested By:** ${track.requestedBy ? track.requestedBy.toString() : 'Remote Dashboard'}`)
                    .setThumbnail(track.thumbnail)
                    .setFooter({ text: `Queue Remaining: ${queue.tracks.size} tracks • Vol: ${queue.node.volume}%` })
                    .setTimestamp();
                const msg = await channel.send({ embeds: [embed] });
                if (config.autoHideMessages) setTimeout(() => { msg.delete().catch(()=>{}); }, 60000);
            }
        } catch(e) {}
    }
}

async function updatePanel(queue) {
    if (!queue || !queue.metadata || !queue.metadata.panelMessage) return;
    try {
        const current = queue.currentTrack;
        const upNext = queue.tracks.toArray().slice(0, 3);
        const embed = new EmbedBuilder().setColor('#89b4fa').setTitle('🎛️ Miko Music Command Center');
        if (current) {
            embed.addFields({ name: '▶️ Currently Playing', value: `[**${current.title}**](${current.url}) - \`${current.duration}\`` });
            const nextText = upNext.length > 0 ? upNext.map((t, i) => `**${i+1}.**${t.title} (\`${t.duration}\`)`).join('\n') : 'Queue is currently empty.';
            embed.addFields({ name: '⏭️ Up Next in Queue', value: nextText });
            const mode = queue.repeatMode === QueueRepeatMode.TRACK ? 'Track 🔂' : queue.repeatMode === QueueRepeatMode.QUEUE ? 'Queue 🔁' : 'Off ❌';
            embed.setFooter({ text: `Queue Length: ${queue.tracks.size} | Repeat: ${mode} \vert{} Vol:${queue.node.volume}%` });
        } else {
            embed.setDescription('*Nothing is currently playing. Load a playlist or use the dashboard to start!*');
            embed.setFooter({ text: 'Bot Idle • Ready for Audio' });
        }
        await queue.metadata.panelMessage.edit({ embeds: [embed] });
    } catch(e) { }
}

async function ensureStandbyBanner(client) {
    const config = getConfig();
    if (!config.panelChannelId) return;
    try {
        const channel = client.channels.cache.get(config.panelChannelId);
        if (!channel || !channel.isTextBased()) return;
        await cleanChannel(channel, client, 'both');
        const embed = new EmbedBuilder()
            .setColor('#89b4fa')
            .setTitle('🎵 Miko Command Hub')
            .setDescription('Click below to summon the active engines into your voice channel.');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_summon_standby').setLabel('🔊 Summon Music Engine').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_sfx_summon').setLabel('🎙️ Summon SFX Engine').setStyle(ButtonStyle.Success)
        );
        await channel.send({ embeds: [embed], components: [row] });
    } catch(e) {}
}

function renderQueueEmbed(queue, page = 1) {
    const tracks = queue.tracks.toArray();
    const pageSize = 5;
    const totalPages = Math.ceil(tracks.length / pageSize) || 1;
    const currPage = Math.min(Math.max(1, page), totalPages);
    const start = (currPage - 1) * pageSize;
    const end = start + pageSize;
    const pageTracks = tracks.slice(start, end);

    const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle(`📋 Live Music Queue (Page ${currPage} of${totalPages})`)
        .setDescription(`**Now Playing:** ${queue.currentTrack ? queue.currentTrack.title : 'Nothing'}\n\n` + 
            (pageTracks.length > 0 ? pageTracks.map((t, i) => `\`${start + i + 1}.\` **${t.title}** - \`${t.duration}\``).join('\n') : '*No upcoming tracks.*')
        )
        .setFooter({ text: `Total Queue: ${tracks.length} tracks` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`btn_qp_first_${currPage}`).setLabel('|◀').setStyle(ButtonStyle.Secondary).setDisabled(currPage === 1),
        new ButtonBuilder().setCustomId(`btn_qp_prev_${currPage}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(currPage === 1),
        new ButtonBuilder().setCustomId(`btn_qp_next_${currPage}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(currPage === totalPages),
        new ButtonBuilder().setCustomId(`btn_qp_last_${currPage}`).setLabel('▶|').setStyle(ButtonStyle.Secondary).setDisabled(currPage === totalPages)
    );
    return { embeds: [embed], components: [row] };
}

player.events.on('error', (q, e) => logger.error(`Player Error: ${e.message}`));
player.events.on('playerError', (q, e) => logger.error(`Stream Blocked: ${e.message}`));
player.events.on('playerStart', (queue, track) => { 
    logNowPlaying(queue.guild, track, queue); 
    updatePanel(queue); 
    logHistory(track.title); 
});
player.events.on('audioTrackAdd', (queue) => updatePanel(queue));
player.events.on('emptyQueue', (queue) => { updatePanel(queue); logger.checkDeferredRotation(); });
player.events.on('disconnect', (queue) => { updatePanel(queue); ensureStandbyBanner(client); logger.checkDeferredRotation(); });
player.events.on('volumeChange', (queue) => updatePanel(queue));

client.once('clientReady', async () => {
    try {
        const { DefaultExtractors, SpotifyExtractor } = require('@discord-player/extractor');
        const { YoutubeExtractor } = require('discord-player-youtubei');
        const config = getConfig();
        if (YoutubeExtractor) {
            if (!YoutubeExtractor.identifier) YoutubeExtractor.identifier = 'com.discord-player.youtubei';
            await player.extractors.register(YoutubeExtractor, {});
            const spotifyOpts = { bridgeProvider: YoutubeExtractor };
            if (config.spotifyClientId && config.spotifyClientSecret) { spotifyOpts.clientId = config.spotifyClientId; spotifyOpts.clientSecret = config.spotifyClientSecret; }
            await player.extractors.register(SpotifyExtractor, spotifyOpts);
        }
        const remaining = DefaultExtractors.filter(ext => ext.name !== 'SpotifyExtractor');
        await player.extractors.loadMulti(remaining);
    } catch (e) {}
    logger.info(`🤖 Miko Music Bot connected as ${client.user.tag}`);
    await ensureStandbyBanner(client);
});

async function deployControlPanel(guild, channel, targetTextChannel, interaction = null) {
    const config = getConfig();
    let queue = player.nodes.get(guild.id);
    if (!queue) {
        queue = player.nodes.create(guild, { metadata: { channel: targetTextChannel, panelMessage: null }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false, bufferingTimeout: 0 });
    }
    if (!queue.connection || queue.connection.channel.id !== channel.id) {
        await queue.connect(channel);
    }
    if (config.defaultVolume !== undefined) queue.node.setVolume(config.defaultVolume);
    
    await cleanChannel(targetTextChannel, client, 'both');
    
    const embed = new EmbedBuilder().setColor('#89b4fa').setTitle('🎛️ Miko Music Command Center').setDescription('*Nothing is currently playing. Load a playlist below to begin!*');
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_back').setLabel('⏮️ Back').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_pause').setLabel('⏯️ Pause / Play').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('btn_skip').setLabel('⏭️ Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_shuffle').setLabel('🔀 Shuffle').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_stop').setLabel('⏹️ Clear Queue').setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_loop_track').setLabel('🔂 Loop 1').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_loop_queue').setLabel('🔁 Loop All').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_loop_off').setLabel('❌ Loop Off').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('btn_queue').setLabel('📋 Queue').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_move_modal').setLabel('↕️ Move').setStyle(ButtonStyle.Secondary)
    );
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_playlists').setLabel('📂 Load Playlist').setStyle(ButtonStyle.Primary)
    );

    let msg = await targetTextChannel.send({ embeds: [embed], components: [row1, row2, row3] });
    queue.metadata.panelMessage = msg;
    updatePanel(queue);
    if (interaction) await interaction.followUp({ content: '✅ Command Center activated.', flags: [ 64 ] });
}

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton()) {
            if (interaction.customId === 'btn_sfx_summon') return interaction.deferUpdate().catch(()=>{});
            if (interaction.customId === 'btn_summon_standby') {
                const channel = interaction.member?.voice?.channel;
                if (!channel) return interaction.reply({ content: '❌ You must be in a Voice Channel!', flags: [ 64 ] });
                await interaction.deferReply({ flags: [ 64 ] });
                await deployControlPanel(interaction.guild, channel, interaction.channel, null);
                return interaction.followUp({ content: `✅ Connected to **${channel.name}**!`, flags: [ 64 ] });
            }

            const queue = player.nodes.get(interaction.guildId);
            if (interaction.customId.startsWith('btn_qp_')) {
                if (!queue) return interaction.reply({ content: 'Queue is empty.', flags: [ 64 ] });
                const parts = interaction.customId.split('_');
                const page = parseInt(parts[3]);
                const totalPages = Math.ceil(queue.tracks.size / 5) || 1;
                let targetPage = page;
                if (parts[2] === 'first') targetPage = 1;
                if (parts[2] === 'prev') targetPage = page - 1;
                if (parts[2] === 'next') targetPage = page + 1;
                if (parts[2] === 'last') targetPage = totalPages;
                return await interaction.update(renderQueueEmbed(queue, targetPage));
            }
            if (interaction.customId === 'btn_queue') {
                if (!queue || (!queue.currentTrack && queue.isEmpty())) return interaction.reply({ content: 'Queue is empty.', flags: [ 64 ] });
                return interaction.reply({ ...renderQueueEmbed(queue, 1), flags: [ 64 ] });
            }
            if (interaction.customId === 'btn_move_modal') {
                const modal = new ModalBuilder().setCustomId('modal_move_track').setTitle('Move Track Position');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('move_from').setLabel('Current Track Number (#)').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('move_to').setLabel('New Target Position (#)').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return await interaction.showModal(modal);
            }
            if (interaction.customId === 'btn_playlists') {
                const config = getConfig();
                if (!config.savedPlaylists || !config.savedPlaylists.length) return interaction.reply({ content: 'No playlists configured.', flags: [ 64 ] });
                const menu = new StringSelectMenuBuilder().setCustomId('menu_playlist').setPlaceholder('Select a playlist');
                config.savedPlaylists.slice(0, 25).forEach((pl, index) => { 
                    menu.addOptions({ label: `${pl.name || 'Unnamed'}`.substring(0, 95), value: index.toString() }); 
                });
                return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], flags: [ 64 ] });
            }
            if (!queue) return interaction.reply({ content: 'Nothing playing.', flags: [ 64 ] });
            if (interaction.customId === 'btn_pause') { queue.node.setPaused(!queue.node.isPaused()); await interaction.reply({ content: '⏯️ Toggled playback.', flags: [ 64 ] }); updatePanel(queue); }
            if (interaction.customId === 'btn_skip') { queue.node.skip(); await interaction.reply({ content: '⏭️ Skipped track.', flags: [ 64 ] }); }
            if (interaction.customId === 'btn_stop') { queue.node.setPaused(false); queue.tracks.clear(); queue.node.skip(); await interaction.reply({ content: '⏹️ Cleared queue.', flags: [ 64 ] }); updatePanel(queue); }
            if (interaction.customId === 'btn_back' && queue.history.previousTrack) { await queue.history.previous(); await interaction.reply({ content: '⏮️ Returning to previous track.', flags: [ 64 ] }); }
            if (interaction.customId === 'btn_shuffle') { queue.tracks.shuffle(); await interaction.reply({ content: '🔀 Queue shuffled.', flags: [ 64 ] }); updatePanel(queue); }
            if (interaction.customId === 'btn_loop_track') { queue.setRepeatMode(QueueRepeatMode.TRACK); await interaction.reply({ content: '🔂 Looping single track.', flags: [ 64 ] }); updatePanel(queue); }
            if (interaction.customId === 'btn_loop_queue') { queue.setRepeatMode(QueueRepeatMode.QUEUE); await interaction.reply({ content: '🔁 Looping full queue.', flags: [ 64 ] }); updatePanel(queue); }
            if (interaction.customId === 'btn_loop_off') { queue.setRepeatMode(QueueRepeatMode.OFF); await interaction.reply({ content: '❌ Loop disabled.', flags: [ 64 ] }); updatePanel(queue); }
        }
    } catch (e) {}
});

client.login(process.env.DISCORD_TOKEN);

// EXPRESS API SETUP
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/server-info', (req, res) => {
    const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
    res.json({ hostName: process.env.COMPUTERNAME || 'MIKOHOME', guilds: guilds, systemTime: new Date().toLocaleTimeString() });
});

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
    const guildId = req.query.guildId;
    const targetGuilds = guildId ? client.guilds.cache.filter(g => g.id === guildId) : client.guilds.cache;
    const channels = [];
    targetGuilds.forEach(g => { g.channels.cache.filter(c => c.isTextBased()).forEach(c => channels.push({ id: c.id, name: `${g.name} - #${c.name}` })); });
    res.json(channels);
});

app.get('/api/voice-channels', (req, res) => {
    const guildId = req.query.guildId;
    const targetGuilds = guildId ? client.guilds.cache.filter(g => g.id === guildId) : client.guilds.cache;
    const channels = [];
    targetGuilds.forEach(g => { g.channels.cache.filter(c => c.isVoiceBased()).forEach(c => channels.push({ id: c.id, name: `${g.name} - 🔊 ${c.name}` })); });
    res.json(channels);
});

app.post('/api/settings', (req, res) => {
    const config = getConfig();
    if (req.body.panelChannelId !== undefined) config.panelChannelId = req.body.panelChannelId;
    if (req.body.logChannelId !== undefined) config.logChannelId = req.body.logChannelId;
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
    const guildId = req.query.guildId;
    const queue = guildId ? client.player.nodes.get(guildId) : client.player.nodes.cache.first();
    const config = getConfig();
    let vcId = null;
    const targetGuild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
    if (targetGuild) {
        const member = targetGuild.members.cache.get(client.user.id);
        if (member && member.voice.channelId) vcId = member.voice.channelId;
    }
    const finalVcId = vcId || config.lastVoiceChannelId || '';
    const defVol = config.defaultVolume !== undefined ? config.defaultVolume : 100;
    const history = config.history || [];

    if (!queue) return res.json({ current: null, tracks: [], volume: defVol, voiceChannelId: finalVcId, history });
    const tracks = queue.tracks.toArray().map((t, i) => ({ title: t.title, duration: t.duration, index: i + 1 }));
    res.json({ current: queue.currentTrack ? queue.currentTrack.title : null, tracks, volume: queue.node.volume, voiceChannelId: finalVcId, history });
});

app.post('/api/play', async (req, res) => {
    let { query, guildId } = req.body;
    if (!query) return res.json({ success: false, message: 'No query provided' });
    
    const config = getConfig();
    const playlists = config.savedPlaylists || [];
    const matchedMacro = playlists.find(pl => pl.shortcode && pl.shortcode.toLowerCase() === query.toLowerCase().trim());
    if (matchedMacro) query = matchedMacro.url;

    let vc = null, txt = null;
    const targetGuilds = guildId ? client.guilds.cache.filter(g => g.id === guildId) : client.guilds.cache;
    targetGuilds.forEach(g => {
        const member = g.members.cache.get(client.user.id);
        if (member && member.voice.channel) vc = member.voice.channel;
        if (config.panelChannelId && g.channels.cache.has(config.panelChannelId)) txt = g.channels.cache.get(config.panelChannelId);
    });

    if (!vc) return res.json({ success: false, message: 'Bot is not in a voice channel.' });
    if (!txt) txt = vc.guild.channels.cache.filter(c => c.isTextBased()).first();

    try {
        const existingQueue = client.player.nodes.get(vc.guild.id);
        const panelMsg = existingQueue && existingQueue.metadata ? existingQueue.metadata.panelMessage : null;
        await client.player.play(vc, query, { 
            nodeOptions: { metadata: { channel: txt, panelMessage: panelMsg }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false, bufferingTimeout: 0 } 
        });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/control', (req, res) => {
    const queue = req.body.guildId ? client.player.nodes.get(req.body.guildId) : client.player.nodes.cache.first();
    if (!queue) return res.json({ success: false, message: 'Nothing playing' });
    try {
        const act = req.body.action;
        if (act === 'pause') queue.node.setPaused(!queue.node.isPaused());
        else if (act === 'skip') queue.node.skip();
        else if (act === 'stop') { queue.node.setPaused(false); queue.tracks.clear(); queue.node.skip(); }
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/api/volume', (req, res) => {
    const queue = req.body.guildId ? client.player.nodes.get(req.body.guildId) : client.player.nodes.cache.first();
    const vol = parseInt(req.body.volume);
    if (queue && !isNaN(vol)) queue.node.setVolume(vol);
    const config = getConfig();
    config.defaultVolume = vol;
    saveConfig(config);
    res.json({ success: true });
});

app.post('/api/voice', async (req, res) => {
    const { action, channelId, guildId } = req.body;
    if (action === 'disconnect') {
        const queue = guildId ? client.player.nodes.get(guildId) : client.player.nodes.cache.first();
        if (queue) queue.delete();
        return res.json({ success: true });
    }
    if (action === 'join' && channelId) {
        let vc = null;
        client.guilds.cache.forEach(g => { if (g.channels.cache.has(channelId)) vc = g.channels.cache.get(channelId); });
        if (!vc) return res.json({ success: false, message: 'Voice channel not found.' });
        
        const config = getConfig();
        config.lastVoiceChannelId = channelId;
        saveConfig(config);

        const txt = config.panelChannelId ? vc.guild.channels.cache.get(config.panelChannelId) : vc.guild.channels.cache.filter(c=>c.isTextBased()).first();
        
        try {
            let queue = client.player.nodes.get(vc.guild.id);
            if (!queue) {
                queue = client.player.nodes.create(vc.guild, { metadata: { channel: txt, panelMessage: null }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false, bufferingTimeout: 0 });
            }
            if (!queue.connection || queue.connection.channel.id !== vc.id) {
                await queue.connect(vc);
            }
            if (config.defaultVolume !== undefined) queue.node.setVolume(config.defaultVolume);
            return res.json({ success: true });
        } catch (err) {
            return res.json({ success: false, message: err.message });
        }
    }
    res.json({ success: false });
});

app.get('/api/logs', (req, res) => {
    const config = getConfig();
    const logPath = path.join(config.logDirectory || path.join(__dirname, 'logs'), 'bot.log');
    if (fs.existsSync(logPath)) {
        res.json({ logs: fs.readFileSync(logPath, 'utf-8').split('\n').slice(-60).join('\n') });
    } else { res.json({ logs: 'Log file empty.' }); }
});

app.post('/api/system/restart', (req, res) => {
    res.json({ success: true, message: 'Restart command dispatched.' });
    setTimeout(() => { exec('powershell -Command "nssm restart MikoDiscordMusicBot"', (err) => { if (err) process.exit(0); }); }, 1000);
});

app.listen(3000, () => console.log('🎧 Miko Music Consolidated App running on port 3000'));
