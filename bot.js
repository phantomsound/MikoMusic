const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const { Player, QueueRepeatMode, Track, Playlist } = require('discord-player');
const playdl = require('play-dl');
const fs = require('fs');

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
                    .setDescription(`${track.duration} - [${track.requestedBy ? track.requestedBy.toString() : 'Auto'}]\nSong By: ${track.author}`)
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
            embed.setFooter({ text: `Queue: ${queue.tracks.size} tracks | Loop: ${mode}` });
        } else {
            embed.setDescription('*Nothing is currently playing. Add a song to get started!*');
            embed.setFooter({ text: 'Queue is empty' });
        }
        await queue.metadata.panelMessage.edit({ embeds: [embed] });
    } catch(e) { }
}

function startBot() {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    const player = new Player(client);
    client.player = player;
    
    player.events.on('error', () => {});
    player.events.on('playerError', () => {});
    player.events.on('playerStart', (queue, track) => { logNowPlaying(queue.guild, track); updatePanel(queue); });
    player.events.on('audioTrackAdd', (queue) => updatePanel(queue));
    player.events.on('audioTracksAdd', (queue) => updatePanel(queue));
    player.events.on('audioTrackRemove', (queue) => updatePanel(queue));
    player.events.on('emptyQueue', (queue) => updatePanel(queue));
    player.events.on('disconnect', (queue) => updatePanel(queue));

    client.once('clientReady', async () => {
        try {
            await player.extractors.loadDefault({
                youtube: { useClient: 'play-dl' }
            });
            console.log("✅ Play-DL Audio Stream Engine Loaded.");
        } catch (e) { console.error("Extractor Load Error:", e); }
        
        console.log(`🤖 Discord Bot connected as ${client.user.tag}`);
        
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const cmds = [
            { name: 'summon', description: 'Summons the Miko Music Control Panel' },
            { name: 'queue', description: 'Displays the current music queue' },
            { name: 'move', description: 'Move a track', options: [ { name: 'track', description: 'Current #', type: 4, required: true }, { name: 'position', description: 'New #', type: 4, required: true } ] }
        ];
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
        client.guilds.cache.forEach(g => rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, g.id), { body: cmds }).catch(()=>{}));
    });

    async function handlePlayback(channel, rawQuery, interaction) {
        try {
            const playlists = getConfig().savedPlaylists || [];
            const cleanQuery = rawQuery.toLowerCase().trim();
            const matchedMacro = playlists.find(pl => pl.shortcode && pl.shortcode.toLowerCase() === cleanQuery);
            let safeQuery = matchedMacro ? matchedMacro.url : rawQuery;
            
            let playTarget = null;
            let queryTitle = '';

            // ABSOLUTE BYPASS: Intercept YouTube links and manually construct metadata
            if (safeQuery.includes('youtube.com') || safeQuery.includes('youtu.be')) {
                safeQuery = safeQuery.replace('music.youtube.com', 'www.youtube.com');
                try { const u = new URL(safeQuery); u.searchParams.delete('si'); safeQuery = u.toString(); } catch(e) {}

                console.log(`[Bypass] Intercepting URL for direct play-dl extraction...`);
                try {
                    if (safeQuery.includes('list=')) {
                        const playlistData = await playdl.playlist_info(safeQuery, { incomplete: true });
                        const videos = await playlistData.all_videos();
                        
                        if (videos.length > 0) {
                            const customPlaylist = new Playlist(player, {
                                title: playlistData.title,
                                description: playlistData.title,
                                thumbnail: playlistData.thumbnail?.url || playlistData.thumbnail || '',
                                type: 'playlist',
                                source: 'youtube',
                                author: { name: playlistData.channel?.name || 'YouTube' },
                                tracks: [],
                                id: playlistData.id,
                                url: playlistData.url
                            });

                            const customTracks = videos.map(v => new Track(player, {
                                title: v.title,
                                author: v.channel?.name || 'Unknown',
                                url: v.url,
                                thumbnail: v.thumbnails?.[0]?.url || v.thumbnail || '',
                                duration: v.durationRaw,
                                views: v.views,
                                requestedBy: interaction.user,
                                source: 'youtube'
                            }));
                            
                            customPlaylist.tracks = customTracks;
                            customTracks.forEach(t => t.playlist = customPlaylist);
                            
                            playTarget = customPlaylist;
                            queryTitle = customPlaylist.title;
                        }
                    } else {
                        const videoData = (await playdl.video_info(safeQuery)).video_details;
                        playTarget = new Track(player, {
                            title: videoData.title,
                            author: videoData.channel?.name,
                            url: videoData.url,
                            thumbnail: videoData.thumbnails?.[0]?.url || videoData.thumbnail || '',
                            duration: videoData.durationRaw,
                            views: videoData.views,
                            requestedBy: interaction.user,
                            source: 'youtube'
                        });
                        queryTitle = playTarget.title;
                    }
                } catch (e) {
                    console.error("Play-DL Direct Extraction Error:", e.message);
                }
            }

            // Fallback to default discord-player engine if not YouTube, or if the bypass failed
            if (!playTarget) {
                const result = await player.search(safeQuery, { requestedBy: interaction.user });
                if (!result || !result.hasTracks()) {
                    return interaction.followUp(`❌ No tracks found for: ${safeQuery}\n*(YouTube IP Block active or Playlist is Private)*`);
                }
                playTarget = result;
                queryTitle = result.playlist ? result.playlist.title : result.tracks[0].title;
            }
            
            const queue = player.nodes.create(interaction.guild, { metadata: { channel: interaction.channel, panelMessage: null }, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false });
            if (!queue.connection) await queue.connect(channel);
            
            await player.play(channel, playTarget, { nodeOptions: { metadata: queue.metadata } });
            
            const aliasTag = matchedMacro ? ` *(shortcode: ${matchedMacro.shortcode})*` : '';
            await interaction.followUp({ content: `✅ Queued: **${queryTitle}**${aliasTag}`, ephemeral: true });
        } catch (err) {
            console.error("Playback Error:", err);
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
                    const queue = player.nodes.create(interaction.guild, { leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false });
                    if (!queue.connection) await queue.connect(channel);
                    const embed = new EmbedBuilder().setColor('#89b4fa').setTitle('🎛️ Miko Music Control Panel').setDescription('*Nothing is currently playing.*');
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
                    const msg = await interaction.followUp({ embeds: [embed], components: [row1, row2], fetchReply: true });
                    queue.metadata = { panelMessage: msg, channel: interaction.channel };
                    updatePanel(queue);
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
                    if (from < 0 || from >= tracks.length || to < 0) return interaction.reply({ content: 'Invalid track numbers.', ephemeral: true });
                    const track = tracks[from];
                    queue.node.remove(track);
                    queue.node.insert(track, to);
                    await interaction.reply({ content: `✅ Moved **${track.title}**`, ephemeral: true });
                    updatePanel(queue);
                }
            }
            if (interaction.isButton()) {
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
                    if (!config.savedPlaylists || !config.savedPlaylists.length) return interaction.reply({ content: 'No playlists.', ephemeral: true });
                    const menu = new StringSelectMenuBuilder().setCustomId('menu_playlist').setPlaceholder('Select playlist');
                    config.savedPlaylists.slice(0, 25).forEach((pl, index) => { 
                        const codeStr = pl.shortcode ? ` [${pl.shortcode}]` : '';
                        menu.addOptions({ label: ((pl.name || 'Unnamed') + codeStr).substring(0, 95), value: index.toString() }); 
                    });
                    return await interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
                }
                if (!queue) return interaction.reply({ content: 'Nothing playing.', ephemeral: true });

                if (interaction.customId === 'btn_pause') { queue.node.setPaused(!queue.node.isPaused()); await interaction.reply({ content: '⏯️ Toggled.', ephemeral: true }); }
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
