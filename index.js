require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    StringSelectMenuBuilder, 
    EmbedBuilder 
} = require('discord.js');
const { Player, QueueRepeatMode } = require('discord-player');
const { DefaultExtractors, SpotifyExtractor } = require('@discord-player/extractor');
const { YoutubeExtractor } = require('discord-player-youtubei');
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const logger = require('./logger');

// Prevent unexpected unhandled errors from terminating Node
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason ? (reason.stack || reason.message || reason) : 'Unknown error'}`);
});
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err ? (err.stack || err.message) : 'Unknown error'}`);
});

function getConfig() {
    try {
        const p = path.join(__dirname, 'config.json');
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {}
    return { history: [], savedPlaylists: [] };
}

function saveConfig(cfg) {
    try {
        fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 2));
    } catch (e) {
        logger.error(`Failed to save config: ${e.message}`);
    }
}

function logHistory(songName) {
    if (!songName) return;
    const config = getConfig();
    if (!config.history) config.history = [];
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    config.history.unshift({ name: songName, time });
    if (config.history.length > 10) config.history.pop();
    saveConfig(config);
}

function sanitizeQuery(rawQuery, savedPlaylists = []) {
    if (!rawQuery) return '';
    const clean = rawQuery.toLowerCase().trim();
    const macro = (savedPlaylists || []).find(p => p.shortcode && p.shortcode.toLowerCase() === clean);
    let query = macro ? macro.url : rawQuery.trim();
    if (query.includes('music.youtube.com')) {
        query = query.replace('music.youtube.com', 'www.youtube.com');
    }
    try {
        const u = new URL(query);
        u.searchParams.delete('si');
        u.searchParams.delete('pi');
        query = u.toString();
    } catch (e) {}
    return query;
}

// Bot state tracking for the Web Dashboard & Gateway rate-limiting
let botStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'online' | 'rate_limited'
let rateLimitResetTimestamp = null;
let rateLimitRemainingSeconds = 0;
let rateLimitMessage = '';
let reconnectTimer = null;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});
const player = new Player(client);
client.player = player;
logger.initLogger(client);

// Extractors initialization helper
let extractorsLoaded = false;
async function registerExtractors() {
    if (extractorsLoaded) return;
    try {
        const config = getConfig();
        if (YoutubeExtractor) {
            if (!YoutubeExtractor.identifier) YoutubeExtractor.identifier = 'com.discord-player.youtubei';
            await player.extractors.register(YoutubeExtractor, {});
            const spotifyOpts = { bridgeProvider: YoutubeExtractor };
            if (config.spotifyClientId && config.spotifyClientSecret) {
                spotifyOpts.clientId = config.spotifyClientId;
                spotifyOpts.clientSecret = config.spotifyClientSecret;
            }
            await player.extractors.register(SpotifyExtractor, spotifyOpts);
        }
        const remaining = DefaultExtractors.filter(ext => ext.name !== 'SpotifyExtractor');
        await player.extractors.loadMulti(remaining);
        extractorsLoaded = true;
        logger.info(`✅ Audio extractors loaded successfully (${player.extractors.size} active)`);
    } catch (err) {
        logger.error(`Extractor registration failed: ${err.message}`);
    }
}

async function cleanChannel(channel, dClient, type = 'both') {
    if (!channel || !channel.isTextBased()) return;
    try {
        const msgs = await channel.messages.fetch({ limit: 50 });
        for (const [id, m] of msgs) {
            if (m.author.id === dClient.user?.id) {
                const isStandby = m.embeds[0]?.title?.includes('Standby') || m.embeds[0]?.title?.includes('Hub');
                const isCommand = m.embeds[0]?.title?.includes('Command Center') || m.embeds[0]?.title?.includes('Control Panel');
                if (type === 'standby' && isStandby) await m.delete().catch(() => {});
                if (type === 'command' && isCommand) await m.delete().catch(() => {});
                if (type === 'both' && (isStandby || isCommand)) await m.delete().catch(() => {});
            }
        }
    } catch (e) {}
}

async function logNowPlaying(guild, track, queue) {
    const config = getConfig();
    if (!config.logChannelId) return;
    try {
        const channel = guild.channels.cache.get(config.logChannelId);
        if (channel && channel.isTextBased()) {
            const sourceTag = track.url?.includes('spotify') ? '🟢 Spotify' : '🔴 YouTube';
            const embed = new EmbedBuilder()
                .setColor('#89b4fa')
                .setAuthor({ name: '💿 Now Streaming' })
                .setTitle(track.title || 'Unknown Title')
                .setURL(track.url || 'https://discord.com')
                .setDescription(`**Artist:** ${track.author || 'Unknown'}\n**Duration:** \`${track.duration || '0:00'}\` | **Source:** ${sourceTag}\n**Requested By:** ${track.requestedBy ? track.requestedBy.toString() : 'Remote Dashboard'}`)
                .setThumbnail(track.thumbnail || null)
                .setFooter({ text: `Queue Remaining: ${queue.tracks.size} tracks • Vol: ${queue.node.volume}%` })
                .setTimestamp();
            const msg = await channel.send({ embeds: [embed] });
            if (config.autoHideMessages) {
                setTimeout(() => { msg.delete().catch(() => {}); }, 60000);
            }
        }
    } catch (e) {}
}

async function updatePanel(queue) {
    if (!queue || !queue.metadata || !queue.metadata.panelMessage) return;
    try {
        const current = queue.currentTrack;
        const upNext = queue.tracks.toArray().slice(0, 3);
        const embed = new EmbedBuilder().setColor('#89b4fa').setTitle('🎛️ Miko Music Command Center');
        if (current) {
            embed.addFields({ name: '▶️ Currently Playing', value: `[**${current.title}**](${current.url}) - \`${current.duration}\`` });
            const nextText = upNext.length > 0
                ? upNext.map((t, i) => `**${i + 1}.** ${t.title} (\`${t.duration}\`)`).join('\n')
                : 'Queue is currently empty.';
            embed.addFields({ name: '⏭️ Up Next in Queue', value: nextText });
            const mode = queue.repeatMode === QueueRepeatMode.TRACK ? 'Track 🔂' : queue.repeatMode === QueueRepeatMode.QUEUE ? 'Queue 🔁' : 'Off ❌';
            embed.setFooter({ text: `Queue Length: ${queue.tracks.size} | Repeat: ${mode} | Vol: ${queue.node.volume}%` });
        } else {
            embed.setDescription('*Nothing is currently playing. Load a playlist or use the dashboard to start!*');
            embed.setFooter({ text: 'Bot Idle • Ready for Audio' });
        }
        await queue.metadata.panelMessage.edit({ embeds: [embed] });
    } catch (e) {}
}

async function ensureStandbyBanner(dClient) {
    const config = getConfig();
    if (!config.panelChannelId) return;
    try {
        const channel = dClient.channels.cache.get(config.panelChannelId);
        if (!channel || !channel.isTextBased()) return;
        await cleanChannel(channel, dClient, 'both');
        const embed = new EmbedBuilder()
            .setColor('#89b4fa')
            .setTitle('🎵 Miko Command Hub')
            .setDescription('Click below to summon the active engines into your voice channel.');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_summon_standby').setLabel('🔊 Summon Music Engine').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_sfx_summon').setLabel('🎙️ Summon SFX Engine').setStyle(ButtonStyle.Success)
        );
        await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {}
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
        .setTitle(`📋 Live Music Queue (Page ${currPage} of ${totalPages})`)
        .setDescription(`**Now Playing:** ${queue.currentTrack ? queue.currentTrack.title : 'Nothing'}\n\n` + 
            (pageTracks.length > 0 
                ? pageTracks.map((t, i) => `\`${start + i + 1}.\` **${t.title}** - \`${t.duration}\``).join('\n') 
                : '*No upcoming tracks.*')
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

function resolveTargetVoiceChannel(guild, preferredChannelId = null) {
    if (!guild) return null;
    const config = getConfig();

    // 1. Explicit channel requested (and not 'auto')
    if (preferredChannelId && preferredChannelId !== 'auto') {
        const c = guild.channels.cache.get(preferredChannelId);
        if (c && c.isVoiceBased()) return c;
    }

    // 2. Scan voice channels in this guild with human members (sorted by most users)
    const voiceChannels = guild.channels.cache.filter(c => c.isVoiceBased());
    const channelsWithUsers = voiceChannels
        .map(c => ({ channel: c, users: c.members.filter(m => !m.user.bot).size }))
        .filter(x => x.users > 0)
        .sort((a, b) => b.users - a.users);

    if (channelsWithUsers.length > 0) {
        logger.info(`🎯 Auto-detected active voice channel with ${channelsWithUsers[0].users} user(s): ${channelsWithUsers[0].channel.name}`);
        return channelsWithUsers[0].channel;
    }

    // 3. Fall back to per-guild default voice channel
    const guildDefault = config.defaultVoiceChannels && config.defaultVoiceChannels[guild.id];
    if (guildDefault && guild.channels.cache.has(guildDefault)) {
        const c = guild.channels.cache.get(guildDefault);
        if (c && c.isVoiceBased()) return c;
    }

    // 4. Fall back to global defaultVoiceChannelId or lastVoiceChannelId
    const fallbackId = config.defaultVoiceChannelId || config.lastVoiceChannelId;
    if (fallbackId && guild.channels.cache.has(fallbackId)) {
        const c = guild.channels.cache.get(fallbackId);
        if (c && c.isVoiceBased()) return c;
    }

    // 5. Fall back to first available voice channel
    return voiceChannels.first() || null;
}

async function deployControlPanel(guild, voiceChannel, targetTextChannel, interaction = null) {
    const config = getConfig();
    let queue = player.nodes.get(guild.id);
    if (!queue) {
        queue = player.nodes.create(guild, { 
            metadata: { channel: targetTextChannel, panelMessage: null }, 
            leaveOnEmpty: false, 
            leaveOnEnd: false, 
            leaveOnStop: false, 
            bufferingTimeout: 0 
        });
    }
    if (!queue.connection || queue.connection.channel.id !== voiceChannel.id) {
        await queue.connect(voiceChannel);
    }
    if (config.defaultVolume !== undefined) queue.node.setVolume(config.defaultVolume);

    await cleanChannel(targetTextChannel, client, 'both');

    const embed = new EmbedBuilder()
        .setColor('#89b4fa')
        .setTitle('🎛️ Miko Music Command Center')
        .setDescription('*Nothing is currently playing. Load a playlist below to begin!*');

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

    const msg = await targetTextChannel.send({ embeds: [embed], components: [row1, row2, row3] });
    queue.metadata.panelMessage = msg;
    updatePanel(queue);
    if (interaction && !interaction.replied) {
        await interaction.followUp({ content: '✅ Command Center activated.', flags: [64] }).catch(() => {});
    }
}

async function handlePlayback(voiceChannel, rawQuery, interaction = null, textChannel = null, requestedBy = null) {
    try {
        const config = getConfig();
        const safeQuery = sanitizeQuery(rawQuery, config.savedPlaylists);
        if (!safeQuery) throw new Error('Query cannot be empty');

        let targetText = textChannel;
        if (!targetText && interaction) targetText = interaction.channel;
        if (!targetText && config.panelChannelId) targetText = voiceChannel.guild.channels.cache.get(config.panelChannelId);
        if (!targetText) targetText = voiceChannel.guild.channels.cache.filter(c => c.isTextBased()).first();

        const existingQueue = player.nodes.get(voiceChannel.guild.id);
        const panelMsg = existingQueue && existingQueue.metadata ? existingQueue.metadata.panelMessage : null;

        const reqUser = requestedBy || (interaction ? interaction.user : null);
        const { track, queue } = await player.play(voiceChannel, safeQuery, {
            nodeOptions: {
                metadata: { channel: targetText, panelMessage: panelMsg },
                leaveOnEmpty: false,
                leaveOnEnd: false,
                leaveOnStop: false,
                bufferingTimeout: 0
            },
            requestedBy: reqUser
        });

        updatePanel(queue);
        const title = track.playlist ? track.playlist.title : track.title;
        if (interaction) {
            await interaction.followUp({ content: `✅ Loaded: **${title}**`, flags: [64] }).catch(() => {});
        }
        return { success: true, title };
    } catch (err) {
        logger.error(`Playback Error: ${err.message}`);
        if (interaction) {
            await interaction.followUp({ content: `❌ Playback Error: ${err.message}`, flags: [64] }).catch(() => {});
        }
        throw err;
    }
}

// Player Events
player.events.on('error', (q, e) => logger.error(`Player Error: ${e.message}`));
player.events.on('playerError', (q, e) => logger.error(`Stream Blocked: ${e.message}`));
player.events.on('playerStart', (queue, track) => {
    logNowPlaying(queue.guild, track, queue);
    updatePanel(queue);
    logHistory(track.title);
});
player.events.on('audioTrackAdd', (queue) => updatePanel(queue));
player.events.on('audioTracksAdd', (queue) => updatePanel(queue));
player.events.on('audioTrackRemove', (queue) => updatePanel(queue));
player.events.on('emptyQueue', (queue) => {
    updatePanel(queue);
    logger.checkDeferredRotation();
});
player.events.on('disconnect', (queue) => {
    updatePanel(queue);
    ensureStandbyBanner(client);
    logger.checkDeferredRotation();
});
player.events.on('volumeChange', (queue) => updatePanel(queue));

// Client Ready Event
client.once('clientReady', async () => {
    botStatus = 'online';
    rateLimitResetTimestamp = null;
    rateLimitRemainingSeconds = 0;
    rateLimitMessage = '';
    logger.info(`🤖 Miko Music Bot online and ready as ${client.user.tag}`);
    await registerExtractors();
    await ensureStandbyBanner(client);
});

// Client Interactions
client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton()) {
            if (interaction.customId === 'btn_sfx_summon') {
                return interaction.deferUpdate().catch(() => {});
            }

            if (interaction.customId === 'btn_summon_standby') {
                const channel = interaction.member?.voice?.channel;
                if (!channel) {
                    return interaction.reply({ content: '❌ You must be in a Voice Channel to summon the bot!', flags: [64] });
                }
                await interaction.deferReply({ flags: [64] });
                await deployControlPanel(interaction.guild, channel, interaction.channel, interaction);
                return interaction.followUp({ content: `✅ Connected to **${channel.name}**!`, flags: [64] });
            }

            const queue = player.nodes.get(interaction.guildId);

            if (interaction.customId.startsWith('btn_qp_')) {
                if (!queue) return interaction.reply({ content: 'Queue is empty.', flags: [64] });
                const parts = interaction.customId.split('_');
                const page = parseInt(parts[3]) || 1;
                const totalPages = Math.ceil(queue.tracks.size / 5) || 1;
                let targetPage = page;
                if (parts[2] === 'first') targetPage = 1;
                if (parts[2] === 'prev') targetPage = Math.max(1, page - 1);
                if (parts[2] === 'next') targetPage = Math.min(totalPages, page + 1);
                if (parts[2] === 'last') targetPage = totalPages;
                return await interaction.update(renderQueueEmbed(queue, targetPage));
            }

            if (interaction.customId === 'btn_queue') {
                if (!queue || (!queue.currentTrack && queue.isEmpty())) {
                    return interaction.reply({ content: 'Queue is empty.', flags: [64] });
                }
                return interaction.reply({ ...renderQueueEmbed(queue, 1), flags: [64] });
            }

            if (interaction.customId === 'btn_move_modal') {
                const modal = new ModalBuilder().setCustomId('modal_move_track').setTitle('Move Track Position');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('move_from').setLabel('Current Track Number (#)').setStyle(TextInputStyle.Short).setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('move_to').setLabel('New Target Position (#)').setStyle(TextInputStyle.Short).setRequired(true)
                    )
                );
                return await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_playlists') {
                const config = getConfig();
                if (!config.savedPlaylists || !config.savedPlaylists.length) {
                    return interaction.reply({ content: 'No playlists configured.', flags: [64] });
                }
                const menu = new StringSelectMenuBuilder().setCustomId('menu_playlist').setPlaceholder('Select a playlist');
                config.savedPlaylists.slice(0, 25).forEach((pl, index) => {
                    menu.addOptions({ 
                        label: `${pl.name || 'Unnamed'}`.substring(0, 95), 
                        value: index.toString(),
                        description: (pl.shortcode ? `Shortcode: ${pl.shortcode}` : '').substring(0, 50) || undefined
                    });
                });
                return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], flags: [64] });
            }

            if (!queue) return interaction.reply({ content: 'Nothing playing.', flags: [64] });

            if (interaction.customId === 'btn_pause') {
                queue.node.setPaused(!queue.node.isPaused());
                await interaction.reply({ content: '⏯️ Toggled playback.', flags: [64] });
                updatePanel(queue);
            }
            if (interaction.customId === 'btn_skip') {
                queue.node.skip();
                await interaction.reply({ content: '⏭️ Skipped track.', flags: [64] });
            }
            if (interaction.customId === 'btn_stop') {
                queue.node.setPaused(false);
                queue.tracks.clear();
                queue.node.skip();
                await interaction.reply({ content: '⏹️ Cleared queue.', flags: [64] });
                updatePanel(queue);
            }
            if (interaction.customId === 'btn_back') {
                if (queue.history && queue.history.previousTrack) {
                    await queue.history.previous();
                    await interaction.reply({ content: '⏮️ Returning to previous track.', flags: [64] });
                } else {
                    await interaction.reply({ content: '⏮️ No previous track history.', flags: [64] });
                }
            }
            if (interaction.customId === 'btn_shuffle') {
                queue.tracks.shuffle();
                await interaction.reply({ content: '🔀 Queue shuffled.', flags: [64] });
                updatePanel(queue);
            }
            if (interaction.customId === 'btn_loop_track') {
                queue.setRepeatMode(QueueRepeatMode.TRACK);
                await interaction.reply({ content: '🔂 Looping single track.', flags: [64] });
                updatePanel(queue);
            }
            if (interaction.customId === 'btn_loop_queue') {
                queue.setRepeatMode(QueueRepeatMode.QUEUE);
                await interaction.reply({ content: '🔁 Looping full queue.', flags: [64] });
                updatePanel(queue);
            }
            if (interaction.customId === 'btn_loop_off') {
                queue.setRepeatMode(QueueRepeatMode.OFF);
                await interaction.reply({ content: '❌ Loop disabled.', flags: [64] });
                updatePanel(queue);
            }
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_move_track') {
            const queue = player.nodes.get(interaction.guildId);
            if (!queue) return interaction.reply({ content: 'Nothing in queue.', flags: [64] });
            const fromIdx = parseInt(interaction.fields.getTextInputValue('move_from')) - 1;
            const toIdx = parseInt(interaction.fields.getTextInputValue('move_to')) - 1;
            const tracks = queue.tracks.toArray();
            if (fromIdx >= 0 && toIdx >= 0 && fromIdx < tracks.length && toIdx < tracks.length) {
                const t = tracks[fromIdx];
                queue.node.remove(t);
                queue.node.insert(t, toIdx);
                await interaction.reply({ content: `✅ Moved **${t.title}** to #${toIdx + 1}`, flags: [64] });
                updatePanel(queue);
            } else {
                await interaction.reply({ content: '❌ Invalid track numbers.', flags: [64] });
            }
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'menu_playlist') {
            await interaction.deferReply({ flags: [64] });
            const selectedIdx = parseInt(interaction.values[0]);
            const config = getConfig();
            const playlist = config.savedPlaylists[selectedIdx];
            if (!playlist || !playlist.url) {
                return interaction.followUp({ content: '❌ Playlist URL not found.', flags: [64] });
            }

            let voiceChannel = interaction.member?.voice?.channel;
            if (!voiceChannel) {
                const botMember = interaction.guild?.members?.cache?.get(client.user?.id);
                if (botMember && botMember.voice?.channel) {
                    voiceChannel = botMember.voice.channel;
                }
            }

            if (!voiceChannel) {
                return interaction.followUp({ content: '❌ You must be in a Voice Channel to start playback.', flags: [64] });
            }

            const queue = player.nodes.get(interaction.guildId);
            if (queue) {
                queue.tracks.clear();
                queue.node.skip();
            }

            await handlePlayback(voiceChannel, playlist.url, interaction, interaction.channel, interaction.user);
        }
    } catch (err) {
        logger.error(`Interaction error: ${err.message}`);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Action error.', flags: [64] });
            }
        } catch (e) {}
    }
});

// Gateway Session Check & Reconnect Logic
async function checkGatewaySessionLimit(token) {
    return new Promise((resolve) => {
        const req = https.request('https://discord.com/api/v10/gateway/bot', {
            method: 'GET',
            headers: {
                Authorization: `Bot ${token}`,
                'User-Agent': 'DiscordBot (https://github.com, 1.0.0)'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function startDiscordBot() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        logger.error('DISCORD_TOKEN is missing from .env');
        botStatus = 'disconnected';
        return;
    }

    botStatus = 'connecting';

    try {
        const gatewayInfo = await checkGatewaySessionLimit(token);
        if (gatewayInfo && gatewayInfo.session_start_limit) {
            const limit = gatewayInfo.session_start_limit;
            if (limit.remaining === 0) {
                botStatus = 'rate_limited';
                rateLimitResetTimestamp = Date.now() + limit.reset_after;
                rateLimitRemainingSeconds = Math.round(limit.reset_after / 1000);
                const hours = (limit.reset_after / (1000 * 60 * 60)).toFixed(2);
                rateLimitMessage = `Gateway identify rate limit reached (0 remaining). Reset in ~${hours} hours.`;
                logger.warn(`⚠️ ${rateLimitMessage}`);

                const retryDelay = Math.max(limit.reset_after + 5000, 30000);
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => {
                    logger.info('🔄 Session reset window reached. Retrying Discord connection...');
                    startDiscordBot();
                }, retryDelay);
                return;
            }
        }

        if (client.isReady()) {
            try { await client.destroy(); } catch (e) {}
        }
        await client.login(token);
    } catch (err) {
        logger.error(`Discord Login Failed: ${err.message}`);
        if (err.message && err.message.includes('sessions remaining')) {
            botStatus = 'rate_limited';
            rateLimitMessage = err.message;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(startDiscordBot, 60000 * 15); // Retry in 15 mins
        } else if (err.message && (err.message.includes('token') || err.message.includes('TOKEN'))) {
            botStatus = 'invalid_token';
            rateLimitMessage = 'Invalid Discord token. Please update the token in .env or the web dashboard.';
            if (reconnectTimer) clearTimeout(reconnectTimer);
        } else {
            botStatus = 'disconnected';
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(startDiscordBot, 30000); // Retry in 30s
        }
    }
}

// EXPRESS WEB API SERVER
const app = express();
app.set('etag', false);
app.use(express.json());
app.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    next();
});
app.use(express.static('public', { etag: false, lastModified: false }));

app.get('/api/server-info', (req, res) => {
    const guilds = client.guilds ? client.guilds.cache.map(g => ({ id: g.id, name: g.name })) : [];
    const remainingSec = rateLimitResetTimestamp ? Math.max(0, Math.round((rateLimitResetTimestamp - Date.now()) / 1000)) : 0;
    res.json({
        hostName: process.env.COMPUTERNAME || 'MIKOHOME',
        guilds,
        systemTime: new Date().toLocaleTimeString(),
        status: botStatus,
        botUser: client.user ? client.user.tag : null,
        rateLimitReset: rateLimitResetTimestamp,
        rateLimitRemaining: remainingSec,
        rateLimitMessage
    });
});

app.get('/api/config', (req, res) => {
    const config = getConfig();
    res.json({
        dashboardName: config.dashboardName || 'Miko Music Dashboard',
        panelChannelId: config.panelChannelId || '',
        logChannelId: config.logChannelId || '',
        defaultVoiceChannelId: config.defaultVoiceChannelId || '',
        defaultVoiceChannels: config.defaultVoiceChannels || {},
        logRetentionDays: config.logRetentionDays || 7,
        logLevel: config.logLevel || 'normal',
        logDirectory: config.logDirectory || path.join(__dirname, 'logs'),
        logBackupSchedule: config.logBackupSchedule || 'daily',
        autoHideMessages: config.autoHideMessages || false,
        savedPlaylists: config.savedPlaylists || [],
        clientId: process.env.CLIENT_ID || '',
        spotifyClientId: config.spotifyClientId || '',
        spotifyClientSecret: config.spotifyClientSecret || ''
    });
});

app.get('/api/channels', (req, res) => {
    if (!client.guilds) return res.json([]);
    const guildId = req.query.guildId;
    const targetGuilds = guildId ? client.guilds.cache.filter(g => g.id === guildId) : client.guilds.cache;
    const channels = [];
    targetGuilds.forEach(g => {
        g.channels.cache.filter(c => c.isTextBased()).forEach(c => {
            channels.push({ id: c.id, name: `${g.name} - #${c.name}` });
        });
    });
    res.json(channels);
});

app.get('/api/voice-channels', (req, res) => {
    if (!client.guilds) return res.json([]);
    const config = getConfig();
    const guildId = req.query.guildId;
    const targetGuilds = guildId ? client.guilds.cache.filter(g => g.id === guildId) : client.guilds.cache;
    const channels = [];
    targetGuilds.forEach(g => {
        const guildDefault = (config.defaultVoiceChannels && config.defaultVoiceChannels[g.id]) || config.defaultVoiceChannelId;
        g.channels.cache.filter(c => c.isVoiceBased()).forEach(c => {
            const humans = c.members.filter(m => !m.user.bot).size;
            channels.push({ 
                id: c.id, 
                name: c.name,
                fullName: `${g.name} - 🔊 ${c.name}`,
                guildId: g.id,
                userCount: humans,
                isDefault: (guildDefault === c.id)
            });
        });
    });
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

    if (req.body.discordToken !== undefined || req.body.clientId !== undefined) {
        try {
            const envPath = path.join(__dirname, '.env');
            let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
            if (req.body.discordToken) {
                const tok = req.body.discordToken.trim();
                if (envContent.includes('DISCORD_TOKEN=')) {
                    envContent = envContent.replace(/DISCORD_TOKEN=.*/, `DISCORD_TOKEN=${tok}`);
                } else {
                    envContent += `\nDISCORD_TOKEN=${tok}`;
                }
                process.env.DISCORD_TOKEN = tok;
            }
            if (req.body.clientId) {
                const cid = req.body.clientId.trim();
                if (envContent.includes('CLIENT_ID=')) {
                    envContent = envContent.replace(/CLIENT_ID=.*/, `CLIENT_ID=${cid}`);
                } else {
                    envContent += `\nCLIENT_ID=${cid}`;
                }
                process.env.CLIENT_ID = cid;
            }
            fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf-8');
            logger.info('Updated .env with new Discord credentials');
            startDiscordBot();
        } catch (e) {
            logger.error(`Failed to update .env: ${e.message}`);
        }
    }

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
    const queue = guildId ? client.player?.nodes?.get(guildId) : client.player?.nodes?.cache?.first();
    const config = getConfig();
    let vcId = null;
    let vcName = null;

    if (client.guilds) {
        const targetGuild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
        if (targetGuild) {
            const member = targetGuild.members.cache.get(client.user?.id);
            if (member && member.voice?.channel) {
                vcId = member.voice.channel.id;
                vcName = member.voice.channel.name;
            }
        }
    }

    const finalVcId = vcId || config.lastVoiceChannelId || '';
    const defVol = config.defaultVolume !== undefined ? config.defaultVolume : 100;
    const history = config.history || [];

    if (!queue) {
        return res.json({ current: null, tracks: [], volume: defVol, voiceChannelId: finalVcId, voiceChannelName: vcName, history });
    }

    const tracks = queue.tracks.toArray().map((t, i) => ({
        title: t.title,
        author: t.author,
        duration: t.duration,
        url: t.url,
        index: i + 1
    }));

    res.json({
        current: queue.currentTrack ? queue.currentTrack.title : null,
        tracks,
        volume: queue.node.volume,
        voiceChannelId: finalVcId,
        voiceChannelName: vcName,
        history
    });
});

app.post('/api/play', async (req, res) => {
    let { query, guildId } = req.body;
    if (!query) return res.json({ success: false, message: 'No query provided' });

    const config = getConfig();
    const safeQuery = sanitizeQuery(query, config.savedPlaylists);

    let vc = null, txt = null;
    const targetGuild = guildId ? client.guilds?.cache.get(guildId) : client.guilds?.cache.first();
    if (!targetGuild) return res.json({ success: false, message: 'Server not found' });

    const member = targetGuild.members.cache.get(client.user?.id);
    if (member && member.voice?.channel) {
        vc = member.voice.channel;
    } else {
        vc = resolveTargetVoiceChannel(targetGuild);
    }

    if (!vc) return res.json({ success: false, message: 'No voice channel found to join.' });

    if (config.panelChannelId && targetGuild.channels.cache.has(config.panelChannelId)) {
        txt = targetGuild.channels.cache.get(config.panelChannelId);
    }
    if (!txt) txt = targetGuild.channels.cache.filter(c => c.isTextBased()).first();

    try {
        const existingQueue = client.player.nodes.get(vc.guild.id);
        const panelMsg = existingQueue && existingQueue.metadata ? existingQueue.metadata.panelMessage : null;
        await client.player.play(vc, safeQuery, {
            nodeOptions: {
                metadata: { channel: txt, panelMessage: panelMsg },
                leaveOnEmpty: false,
                leaveOnEnd: false,
                leaveOnStop: false,
                bufferingTimeout: 0
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/control', (req, res) => {
    const queue = req.body.guildId ? client.player?.nodes?.get(req.body.guildId) : client.player?.nodes?.cache?.first();
    if (!queue) return res.json({ success: false, message: 'Nothing playing' });

    try {
        const act = req.body.action;
        if (act === 'pause') {
            queue.node.setPaused(!queue.node.isPaused());
        } else if (act === 'skip') {
            queue.node.skip();
        } else if (act === 'stop') {
            queue.node.setPaused(false);
            queue.tracks.clear();
            queue.node.skip();
        } else if (act === 'back') {
            if (queue.history && queue.history.previousTrack) queue.history.previous();
        } else if (act === 'shuffle') {
            queue.tracks.shuffle();
        } else if (act === 'loopTrack') {
            queue.setRepeatMode(QueueRepeatMode.TRACK);
        } else if (act === 'loopQueue') {
            queue.setRepeatMode(QueueRepeatMode.QUEUE);
        } else if (act === 'loopOff') {
            queue.setRepeatMode(QueueRepeatMode.OFF);
        } else if (act === 'remove') {
            const idx = parseInt(req.body.index) - 1;
            const tracks = queue.tracks.toArray();
            if (idx >= 0 && idx < tracks.length) queue.node.remove(tracks[idx]);
        } else if (act === 'move') {
            const fromIdx = parseInt(req.body.from) - 1;
            const toIdx = parseInt(req.body.to) - 1;
            const tracks = queue.tracks.toArray();
            if (fromIdx >= 0 && toIdx >= 0 && fromIdx < tracks.length && toIdx < tracks.length) {
                const t = tracks[fromIdx];
                queue.node.remove(t);
                queue.node.insert(t, toIdx);
            }
        }
        updatePanel(queue);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/volume', (req, res) => {
    const queue = req.body.guildId ? client.player?.nodes?.get(req.body.guildId) : client.player?.nodes?.cache?.first();
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
        const queue = guildId ? client.player?.nodes?.get(guildId) : client.player?.nodes?.cache?.first();
        if (queue) queue.delete();
        return res.json({ success: true });
    }

    if (action === 'join') {
        if (!client.guilds) return res.json({ success: false, message: 'Bot client not connected to Discord yet.' });
        const targetGuild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
        if (!targetGuild) return res.json({ success: false, message: 'Server not found.' });

        const vc = resolveTargetVoiceChannel(targetGuild, channelId);
        if (!vc) return res.json({ success: false, message: 'No voice channel available.' });

        const config = getConfig();
        config.lastVoiceChannelId = vc.id;
        saveConfig(config);

        const txt = config.panelChannelId && targetGuild.channels.cache.has(config.panelChannelId)
            ? targetGuild.channels.cache.get(config.panelChannelId)
            : targetGuild.channels.cache.filter(c => c.isTextBased()).first();

        try {
            let queue = client.player.nodes.get(targetGuild.id);
            if (!queue) {
                queue = client.player.nodes.create(targetGuild, {
                    metadata: { channel: txt, panelMessage: null },
                    leaveOnEmpty: false,
                    leaveOnEnd: false,
                    leaveOnStop: false,
                    bufferingTimeout: 0
                });
            }
            if (!queue.connection || queue.connection.channel.id !== vc.id) {
                await queue.connect(vc);
            }
            if (config.defaultVolume !== undefined) queue.node.setVolume(config.defaultVolume);
            return res.json({ success: true, channelName: vc.name, channelId: vc.id });
        } catch (err) {
            return res.json({ success: false, message: err.message });
        }
    }
    res.json({ success: false });
});

app.post('/api/voice/default', (req, res) => {
    const { guildId, channelId } = req.body;
    if (!guildId || !channelId) return res.json({ success: false, message: 'Missing parameters' });
    const config = getConfig();
    if (!config.defaultVoiceChannels) config.defaultVoiceChannels = {};
    config.defaultVoiceChannels[guildId] = channelId;
    config.defaultVoiceChannelId = channelId;
    saveConfig(config);
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    const config = getConfig();
    const logPath = path.join(config.logDirectory || path.join(__dirname, 'logs'), 'bot.log');
    if (fs.existsSync(logPath)) {
        res.json({ logs: fs.readFileSync(logPath, 'utf-8').split('\n').slice(-60).join('\n') });
    } else {
        res.json({ logs: 'Log file empty.' });
    }
});

app.get('/api/logs/export', (req, res) => {
    const config = getConfig();
    const logPath = path.join(config.logDirectory || path.join(__dirname, 'logs'), 'bot.log');
    if (fs.existsSync(logPath)) {
        res.download(logPath);
    } else {
        res.status(404).send('Log file not found.');
    }
});

app.post('/api/system/restart', (req, res) => {
    res.json({ success: true, message: 'Configuration reloaded. Reconnecting...' });
    try {
        require('dotenv').config({ override: true });
        logger.info('🔄 Restart/reload requested. Reconnecting Discord bot...');
        if (reconnectTimer) clearTimeout(reconnectTimer);
        startDiscordBot();
    } catch (e) {
        logger.error(`Restart failed: ${e.message}`);
    }
});

// START HTTP SERVER FIRST, THEN CONNECT DISCORD
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🎧 Miko Music Web UI active on http://localhost:${PORT}`);
    startDiscordBot();
});
