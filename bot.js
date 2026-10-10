const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { Player, QueueRepeatMode } = require('discord-player');
const fs = require('fs');
const logger = require('./logger');

function getConfig() { try { return JSON.parse(fs.readFileSync('./config.json', 'utf-8')); } catch (e) { return {}; } }

async function cleanChannel(channel, client, type) {
    try {
        const msgs = await channel.messages.fetch({ limit: 50 });
        for (const [id, m] of msgs) { 
            if (m.author.id === client.user.id) {
                const isStandby = m.embeds[0]?.title?.includes('Standby');
                const isCommand = m.embeds[0]?.title?.includes('Command Center');
                if (type === 'standby' && isStandby) await m.delete().catch(()=>{});
                if (type === 'command' && isCommand) await m.delete().catch(()=>{});
                if (type === 'both' && (isStandby || isCommand)) await m.delete().catch(()=>{});
            }
        }
    } catch(e) {}
}
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
            const nextText = upNext.length > 0 ? upNext.map((t, i) => `**${i+1}.** ${t.title} (\`${t.duration}\`)`).join('\n') : 'Queue is currently empty.';
            embed.addFields({ name: '⏭️ Up Next in Queue', value: nextText });
            const mode = queue.repeatMode === QueueRepeatMode.TRACK ? 'Track 🔂' : queue.repeatMode === QueueRepeatMode.QUEUE ? 'Queue 🔁' : 'Off ❌';
            embed.setFooter({ text: `Queue Length: ${queue.tracks.size} | Repeat: ${mode} | Vol: ${queue.node.volume}%` });
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
            .setTitle('🎵 Miko Music Standby Hub')
            .setDescription('Click below to summon the music bot into your active voice channel.');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_summon_standby').setLabel('🔊 Summon to Voice Channel').setStyle(ButtonStyle.Success)
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
        .setTitle(`📋 Live Music Queue (Page ${currPage} of ${totalPages})`)
        .setDescription(`**Now Playing:** ${queue.currentTrack ? queue.currentTrack.title : 'Nothing'}\n\n` + 
            (pageTracks.length > 0 ? pageTracks.map((t, i) => `**${start + i + 1}.** ${t.title} - \`${t.duration}\``).join('\n') : '*No upcoming tracks.*')
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

function startBot() {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    const player = new Player(client);
    client.player = player;
    
    logger.initLogger(client);

    player.events.on('error', (q, e) => console.log('❌ Player Error:', e.message));
    player.events.on('playerError', (q, e) => console.log('❌ Stream Blocked:', e.message));
    
    player.events.on('debug', (q, m) => {
        const config = getConfig();
        const level = config.logLevel || 'normal';
        if (level === 'verbose') console.log('🔍 [VERBOSE]', m);
        else if (level === 'debug' && (m.toLowerCase().includes('bridge') || m.toLowerCase().includes('spotify') || m.toLowerCase().includes('extract') || m.toLowerCase().includes('search'))) console.log('🔍 [DEBUG]', m);
    });

    player.events.on('playerStart', (queue, track) => { logNowPlaying(queue.guild, track, queue); updatePanel(queue); });
    player.events.on('audioTrackAdd', (queue) => updatePanel(queue));
    player.events.on('audioTracksAdd', (queue) => updatePanel(queue));
    player.events.on('audioTrackRemove', (queue) => updatePanel(queue));
    
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
        console.log(`🤖 Discord Bot connected as ${client.user.tag}`);
        await ensureStandbyBanner(client);
    });

    async function deployControlPanel(guild, channel, targetTextChannel, interaction = null) {
        const queue = player.nodes.create(guild, { metadata: { channel: targetTextChannel, panelMessage: null }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false, bufferingTimeout: 0 });
        if (!queue.connection) await queue.connect(channel);
        
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

    async function handlePlayback(channel, rawQuery, interaction) {
        try {
            const playlists = getConfig().savedPlaylists || [];
            const cleanQuery = rawQuery.toLowerCase().trim();
            const matchedMacro = playlists.find(pl => pl.shortcode && pl.shortcode.toLowerCase() === cleanQuery);
            let safeQuery = matchedMacro ? matchedMacro.url : rawQuery;
            if (safeQuery.includes('music.youtube.com')) safeQuery = safeQuery.replace('music.youtube.com', 'www.youtube.com');
            try { const u = new URL(safeQuery); u.searchParams.delete('si'); u.searchParams.delete('pi'); safeQuery = u.toString(); } catch(e) {}
            
            const existingQueue = player.nodes.get(interaction.guild.id);
            const panelMsg = existingQueue ? existingQueue.metadata.panelMessage : null;

            const { track, queue } = await player.play(channel, safeQuery, { 
                nodeOptions: { metadata: { channel: interaction.channel, panelMessage: panelMsg }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false, bufferingTimeout: 0 }, 
                requestedBy: interaction.user 
            });
            updatePanel(queue);
            const title = track.playlist ? track.playlist.title : track.title;
            const aliasTag = matchedMacro ? ` *(shortcode: ${matchedMacro.shortcode})*` : '';
            await interaction.followUp({ content: `✅ Loaded: **${title}**${aliasTag}`, flags: [ 64 ] });
        } catch (err) { await interaction.followUp({ content: `❌ Error: ${err.message}`, flags: [ 64 ] }); }
    }

    client.on('interactionCreate', async interaction => {
        try {
            if (interaction.isButton()) {
                if (interaction.customId === 'btn_summon_standby') {
                    const channel = interaction.member?.voice?.channel;
                    if (!channel) return interaction.reply({ content: '❌ You must be in a Voice Channel to summon the bot!', flags: [ 64 ] });
                    await interaction.deferReply({ flags: [ 64 ] });
                    await deployControlPanel(interaction.guild, channel, interaction.channel, null);
                    return interaction.followUp({ content: `✅ Connected to **${channel.name}**!`, flags: [ 64 ] });
                }

                const queue = player.nodes.get(interaction.guildId);

                // Queue Pagination
                if (interaction.customId.startsWith('btn_qp_')) {
                    if (!queue) return interaction.reply({ content: 'Queue is empty.', flags: [ 64 ] });
                    const parts = interaction.customId.split('_');
                    const dir = parts[2];
                    const page = parseInt(parts[3]);
                    const totalPages = Math.ceil(queue.tracks.size / 5) || 1;
                    let targetPage = page;
                    if (dir === 'first') targetPage = 1;
                    if (dir === 'prev') targetPage = page - 1;
                    if (dir === 'next') targetPage = page + 1;
                    if (dir === 'last') targetPage = totalPages;
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
                    const menu = new StringSelectMenuBuilder().setCustomId('menu_playlist').setPlaceholder('Select a playlist (clears active queue)');
                    config.savedPlaylists.slice(0, 25).forEach((pl, index) => { 
                        const tag = pl.url.includes('spotify') ? '🟢' : '🔴';
                        const codeStr = pl.shortcode ? ` [${pl.shortcode}]` : '';
                        menu.addOptions({ label: `${tag} ${(pl.name || 'Unnamed') + codeStr}`.substring(0, 95), value: index.toString() }); 
                    });
                    return await interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], flags: [ 64 ] });
                }

                if (!queue) return interaction.reply({ content: 'Nothing playing.', flags: [ 64 ] });

                if (interaction.customId === 'btn_pause') { queue.node.setPaused(!queue.node.isPaused()); await interaction.reply({ content: '⏯️ Toggled playback.', flags: [ 64 ] }); updatePanel(queue); }
                if (interaction.customId === 'btn_skip') { queue.node.skip(); await interaction.reply({ content: '⏭️ Skipped track.', flags: [ 64 ] }); }
                if (interaction.customId === 'btn_stop') { queue.node.setPaused(false); queue.tracks.clear(); queue.node.skip(); await interaction.reply({ content: '⏹️ Cleared queue without disconnecting.', flags: [ 64 ] }); updatePanel(queue); }
                if (interaction.customId === 'btn_back' && queue.history.previousTrack) { await queue.history.previous(); await interaction.reply({ content: '⏮️ Returning to previous track.', flags: [ 64 ] }); }
                if (interaction.customId === 'btn_shuffle') { queue.tracks.shuffle(); await interaction.reply({ content: '🔀 Queue shuffled.', flags: [ 64 ] }); updatePanel(queue); }
                if (interaction.customId === 'btn_loop_track') { queue.setRepeatMode(QueueRepeatMode.TRACK); await interaction.reply({ content: '🔂 Looping single track.', flags: [ 64 ] }); updatePanel(queue); }
                if (interaction.customId === 'btn_loop_queue') { queue.setRepeatMode(QueueRepeatMode.QUEUE); await interaction.reply({ content: '🔁 Looping full queue.', flags: [ 64 ] }); updatePanel(queue); }
                if (interaction.customId === 'btn_loop_off') { queue.setRepeatMode(QueueRepeatMode.OFF); await interaction.reply({ content: '❌ Loop disabled.', flags: [ 64 ] }); updatePanel(queue); }
            }

            if (interaction.isModalSubmit() && interaction.customId === 'modal_move_track') {
                const queue = player.nodes.get(interaction.guildId);
                if (!queue) return interaction.reply({ content: 'Nothing in queue.', flags: [ 64 ] });
                const fromIdx = parseInt(interaction.fields.getTextInputValue('move_from')) - 1;
                const toIdx = parseInt(interaction.fields.getTextInputValue('move_to')) - 1;
                const tracks = queue.tracks.toArray();
                if (fromIdx >= 0 && toIdx >= 0 && fromIdx < tracks.length && toIdx < tracks.length) {
                    const t = tracks[fromIdx];
                    queue.node.remove(t);
                    queue.node.insert(t, toIdx);
                    await interaction.reply({ content: `✅ Moved **${t.title}** to #${toIdx + 1}`, flags: [ 64 ] });
                    updatePanel(queue);
                } else {
                    await interaction.reply({ content: '❌ Invalid track numbers.', flags: [ 64 ] });
                }
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'menu_playlist') {
                await interaction.deferReply({ flags: [ 64 ] });
                const queue = player.nodes.get(interaction.guildId);
                if (queue) { queue.tracks.clear(); queue.node.skip(); }
                const url = getConfig().savedPlaylists[parseInt(interaction.values[0])]?.url;
                if (!url) return interaction.followUp({ content: '❌ Playlist URL not found.', flags: [ 64 ] });
                await handlePlayback(interaction.member.voice.channel, url, interaction);
            }
        } catch (err) { try { await interaction.reply({ content: '❌ Action error.', flags: [ 64 ] }); } catch(e){} }
    });

    client.login(process.env.DISCORD_TOKEN);
    return client;
}
module.exports = { startBot };

