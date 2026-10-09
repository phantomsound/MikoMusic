process.env.DP_FORCE_YTDL_MOD = 'youtube-ext';

const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { Player, QueueRepeatMode } = require('discord-player');
const fs = require('fs');
const logger = require('./logger');

function getConfig() {
    try { return JSON.parse(fs.readFileSync('./config.json', 'utf-8')); } catch (e) { return {}; }
}

async function logNowPlaying(guild, track) {
    const config = getConfig();
    if (config.logChannelId) {
        try {
            const channel = guild.channels.cache.get(config.logChannelId);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor('#2b2d31').setAuthor({ name: '💿 Now Playing' })
                    .setTitle(track.title).setURL(track.url)
                    .setDescription(`${track.duration} - [${track.requestedBy ? track.requestedBy.toString() : 'Remote Dashboard'}]\nSong By: ${track.author}`)
                    .setThumbnail(track.thumbnail).setFooter({ text: `Volume 100% • MikoMusic` });
                await channel.send({ embeds: [embed] });
            }
        } catch(e) {}
    }
}

async function updatePanel(queue) {
    if (!queue || !queue.metadata || !queue.metadata.panelMessage) return;
    try {
        const current = queue.currentTrack;
        const upNext = queue.tracks.toArray().slice(0, 2);
        const embed = new EmbedBuilder().setColor('#89b4fa').setTitle('🎛️ Miko Music Control Panel');
        if (current) {
            embed.addFields({ name: '▶️ Now Playing', value: `[**${current.title}**](${current.url}) - \`${current.duration}\`` });
            const nextText = upNext.length > 0 ? upNext.map((t, i) => `**${i+1}.** ${t.title}`).join('\n') : 'Queue is empty.';
            embed.addFields({ name: '⏭️ Up Next', value: nextText });
            const mode = queue.repeatMode === QueueRepeatMode.TRACK ? 'Track' : queue.repeatMode === QueueRepeatMode.QUEUE ? 'Queue' : 'Off';
            embed.setFooter({ text: `Queue: ${queue.tracks.size} tracks | Loop: ${mode} | Vol: ${queue.node.volume}%` });
        } else {
            embed.setDescription('*Nothing is currently playing. Add a track or playlist below!*');
            embed.setFooter({ text: 'Queue is empty' });
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

        const messages = await channel.messages.fetch({ limit: 15 });
        const existing = messages.find(m => m.author.id === client.user.id && m.components.some(r => r.components.some(c => c.customId === 'btn_summon_standby')));
        
        if (!existing) {
            const embed = new EmbedBuilder()
                .setColor('#89b4fa')
                .setTitle('🎵 Miko Music Command Center')
                .setDescription('Click below to summon the music bot into your voice channel without typing any commands.');
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_summon_standby').setLabel('🔊 Summon to Voice Channel').setStyle(ButtonStyle.Success)
            );
            await channel.send({ embeds: [embed], components: [row] });
        }
    } catch(e) {}
}

function startBot() {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    const player = new Player(client);
    client.player = player;
    
    logger.initLogger(client);

    player.events.on('error', (q, e) => console.log('❌ Player Error:', e.message));
    player.events.on('playerError', (q, e) => console.log('❌ Stream Blocked (403):', e.message));
    player.events.on('playerSkip', (q, track) => console.log(`⚠️ Skipped Track: ${track.title}`));
    
    player.events.on('playerStart', (queue, track) => { logNowPlaying(queue.guild, track); updatePanel(queue); });
    player.events.on('audioTrackAdd', (queue) => updatePanel(queue));
    player.events.on('audioTracksAdd', (queue) => updatePanel(queue));
    player.events.on('audioTrackRemove', (queue) => updatePanel(queue));
    player.events.on('emptyQueue', (queue) => { updatePanel(queue); logger.checkDeferredRotation(); });
    player.events.on('disconnect', (queue) => { updatePanel(queue); logger.checkDeferredRotation(); });
    player.events.on('volumeChange', (queue) => updatePanel(queue));

    client.once('clientReady', async () => {
        try {
            // THE FIX: Officially using loadMulti with DefaultExtractors
            const { DefaultExtractors } = require('@discord-player/extractor');
            await player.extractors.loadMulti(DefaultExtractors);
            console.log(`✅ Extractors Active: ${player.extractors.store.map(e => e.identifier).join(', ')}`);
        } catch (e) {
            console.error("❌ Extractor Load Error:", e.message);
        }
        
        console.log(`🤖 Discord Bot connected as ${client.user.tag}`);
        await ensureStandbyBanner(client);

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const cmds = [
            { name: 'summon', description: 'Summons the Miko Music Control Panel' },
            { name: 'queue', description: 'Displays the current music queue' },
            { name: 'move', description: 'Move a track in queue', options: [ { name: 'track', description: 'Current position (#)', type: 4, required: true }, { name: 'position', description: 'New position (#)', type: 4, required: true } ] }
        ];
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
        client.guilds.cache.forEach(g => rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, g.id), { body: cmds }).catch(()=>{}));
    });

    async function deployControlPanel(guild, channel, targetTextChannel, interaction = null) {
        const queue = player.nodes.create(guild, { 
            metadata: { channel: targetTextChannel, panelMessage: null }, 
            leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false 
        });
        
        if (!queue.connection) await queue.connect(channel);

        if (queue.metadata.panelMessage && queue.metadata.panelMessage.id) {
            try { await queue.metadata.panelMessage.delete(); } catch(e) {}
        }

        const embed = new EmbedBuilder().setColor('#89b4fa').setTitle('🎛️ Miko Music Control Panel').setDescription('*Nothing is currently playing. Add a track to begin!*');
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_queue').setLabel('Queue').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_pause').setLabel('Play/Pause').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_stop').setLabel('Stop').setStyle(ButtonStyle.Danger)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_loop').setLabel('Loop').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_add').setLabel('🔍 Add Song').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_playlists').setLabel('📂 Load Playlist').setStyle(ButtonStyle.Secondary)
        );

        let msg;
        if (interaction) {
            msg = await interaction.followUp({ embeds: [embed], components: [row1, row2], fetchReply: true });
        } else {
            msg = await targetTextChannel.send({ embeds: [embed], components: [row1, row2] });
        }

        queue.metadata.panelMessage = msg;
        updatePanel(queue);
    }

    async function handlePlayback(channel, rawQuery, interaction) {
        try {
            const playlists = getConfig().savedPlaylists || [];
            const cleanQuery = rawQuery.toLowerCase().trim();
            const matchedMacro = playlists.find(pl => pl.shortcode && pl.shortcode.toLowerCase() === cleanQuery);
            let safeQuery = matchedMacro ? matchedMacro.url : rawQuery;
            
            if (safeQuery.includes('music.youtube.com')) safeQuery = safeQuery.replace('music.youtube.com', 'www.youtube.com');
            try { const u = new URL(safeQuery); u.searchParams.delete('si'); safeQuery = u.toString(); } catch(e) {}
            
            const existingQueue = player.nodes.get(interaction.guild.id);
            const panelMsg = existingQueue ? existingQueue.metadata.panelMessage : null;

            const { track, queue } = await player.play(channel, safeQuery, {
                nodeOptions: {
                    metadata: { channel: interaction.channel, panelMessage: panelMsg },
                    leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false
                },
                requestedBy: interaction.user
            });
            
            updatePanel(queue);
            const title = track.playlist ? track.playlist.title : track.title;
            const aliasTag = matchedMacro ? ` *(shortcode: ${matchedMacro.shortcode})*` : '';
            await interaction.followUp({ content: `✅ Queued: **${title}**${aliasTag}`, ephemeral: true });
        } catch (err) {
            console.error("Playback Error:", err.message);
            await interaction.followUp(`❌ Failed to play track. Error: ${err.message}`);
        }
    }

    client.on('interactionCreate', async interaction => {
        try {
            if (interaction.isChatInputCommand()) {
                if (interaction.commandName === 'summon') {
                    const channel = interaction.member.voice.channel;
                    if (!channel) return interaction.reply({ content: '❌ You must be in a voice channel!', ephemeral: true });
                    const config = getConfig();
                    if (config.panelChannelId && interaction.channelId !== config.panelChannelId) {
                        return interaction.reply({ content: `❌ Please use the dedicated music panel channel.`, ephemeral: true });
                    }
                    await interaction.deferReply();
                    await deployControlPanel(interaction.guild, channel, interaction.channel, interaction);
                }
                if (interaction.commandName === 'queue') {
                    const queue = player.nodes.get(interaction.guildId);
                    if (!queue) return interaction.reply({ content: 'Nothing playing.', ephemeral: true });
                    const tracks = queue.tracks.toArray().slice(0, 10);
                    const embed = new EmbedBuilder().setColor('#2b2d31').setTitle(`Music Queue`).setDescription(`**Now Playing**\n${queue.currentTrack?.title}\n\n**Up Next**\n${tracks.map((t,i)=>`**${i+1}.**${t.title}`).join('\n')}`);
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }
                if (interaction.commandName === 'move') {
                    const queue = player.nodes.get(interaction.guildId);
                    if (!queue || queue.isEmpty()) return interaction.reply({ content: 'Queue is empty.', ephemeral: true });
                    const from = interaction.options.getInteger('track') - 1;
                    const to = interaction.options.getInteger('position') - 1;
                    const tracks = queue.tracks.toArray();
                    if (from < 0 || from >= tracks.length || to < 0 || to >= tracks.length) return interaction.reply({ content: 'Invalid track numbers.', ephemeral: true });
                    
                    try { queue.node.move(from, to); } catch(e) {
                        const track = tracks[from];
                        queue.node.remove(track);
                        queue.node.insert(track, to);
                    }
                    
                    await interaction.reply({ content: `✅ Track moved successfully!`, ephemeral: true });
                    updatePanel(queue);
                }
            }
            if (interaction.isButton()) {
                if (interaction.customId === 'btn_summon_standby') {
                    const channel = interaction.member?.voice?.channel;
                    if (!channel) return interaction.reply({ content: '❌ You must be inside a Voice Channel to summon the bot!', ephemeral: true });
                    await interaction.deferReply({ ephemeral: true });
                    await deployControlPanel(interaction.guild, channel, interaction.channel, null);
                    return interaction.followUp({ content: `✅ Bot connected to **${channel.name}** and panel ready!`, ephemeral: true });
                }

                const queue = player.nodes.get(interaction.guildId);
                if (interaction.customId === 'btn_queue') {
                    if (!queue) return interaction.reply({ content: 'Nothing playing.', ephemeral: true });
                    const tracks = queue.tracks.toArray().slice(0, 10);
                    const embed = new EmbedBuilder().setColor('#2b2d31').setTitle(`Music Queue`).setDescription(`**Now Playing**\n${queue.currentTrack?.title}\n\n**Up Next**\n${tracks.map((t,i)=>`**${i+1}.**${t.title}`).join('\n')}`);
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }
                if (interaction.customId === 'btn_add') {
                    const modal = new ModalBuilder().setCustomId('modal_search').setTitle('Add Track, URL, or Shortcode');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel("Search query or shortcode").setStyle(TextInputStyle.Short).setRequired(true)));
                    return await interaction.showModal(modal);
                }
                if (interaction.customId === 'btn_playlists') {
                    const config = getConfig();
                    if (!config.savedPlaylists || !config.savedPlaylists.length) return interaction.reply({ content: 'No playlists saved in dashboard.', ephemeral: true });
                    const menu = new StringSelectMenuBuilder().setCustomId('menu_playlist').setPlaceholder('Select playlist to play');
                    config.savedPlaylists.slice(0, 25).forEach((pl, index) => { 
                        const codeStr = pl.shortcode ? ` [${pl.shortcode}]` : '';
                        menu.addOptions({ label: ((pl.name || 'Unnamed') + codeStr).substring(0, 95), value: index.toString() }); 
                    });
                    return await interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
                }
                if (!queue) return interaction.reply({ content: 'Nothing playing.', ephemeral: true });

                if (interaction.customId === 'btn_pause') { queue.node.setPaused(!queue.node.isPaused()); await interaction.reply({ content: '⏯️ Toggled.', ephemeral: true }); updatePanel(queue); }
                if (interaction.customId === 'btn_skip') { queue.node.skip(); await interaction.reply({ content: '⏭️ Skipped.', ephemeral: true }); }
                if (interaction.customId === 'btn_stop') { queue.delete(); await interaction.reply({ content: '⏹️ Stopped.', ephemeral: true }); }
                if (interaction.customId === 'btn_back' && queue.history.previousTrack) { await queue.history.previous(); await interaction.reply({ content: '⏮️ Back.', ephemeral: true }); }
                if (interaction.customId === 'btn_shuffle') { queue.tracks.shuffle(); await interaction.reply({ content: '🔀 Shuffled.', ephemeral: true }); updatePanel(queue); }
                if (interaction.customId === 'btn_loop') {
                    const m = queue.repeatMode === QueueRepeatMode.OFF ? QueueRepeatMode.TRACK : queue.repeatMode === QueueRepeatMode.TRACK ? QueueRepeatMode.QUEUE : QueueRepeatMode.OFF;
                    queue.setRepeatMode(m);
                    await interaction.reply({ content: '🔁 Loop toggled.', ephemeral: true });
                    updatePanel(queue);
                }
            }
            if (interaction.isModalSubmit() && interaction.customId === 'modal_search') {
                await interaction.deferReply({ ephemeral: true });
                await handlePlayback(interaction.member.voice.channel, interaction.fields.getTextInputValue('query'), interaction);
            }
            if (interaction.isStringSelectMenu() && interaction.customId === 'menu_playlist') {
                await interaction.deferReply({ ephemeral: true });
                const url = getConfig().savedPlaylists[parseInt(interaction.values[0])]?.url;
                if (!url) return interaction.followUp('❌ Could not find playlist URL.');
                await handlePlayback(interaction.member.voice.channel, url, interaction);
            }
        } catch (err) { try { await interaction.reply({ content: '❌ An error occurred.', ephemeral: true }); } catch(e){} }
    });

    client.login(process.env.DISCORD_TOKEN);
    return client;
}
module.exports = { startBot };
