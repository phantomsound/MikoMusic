const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { Player, QueueRepeatMode } = require('discord-player');
const fs = require('fs');

function getConfig() {
    try { return JSON.parse(fs.readFileSync('./config.json', 'utf-8')); } 
    catch (e) { return {}; }
}

async function logEvent(guild, message) {
    const config = getConfig();
    if (config.logChannelId) {
        try {
            const channel = guild.channels.cache.get(config.logChannelId);
            if (channel) await channel.send(message);
        } catch(e) {}
    }
}

function startBot() {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    const player = new Player(client);
    client.player = player;
    
    player.events.on('error', (queue, error) => console.error('[Player Error]', error.message));
    player.events.on('playerError', (queue, error) => console.error('[Audio Error]', error.message));
    
    // MatchBox-style automated event logging
    player.events.on('playerStart', (queue, track) => logEvent(queue.guild, `▶️ **Now Playing:** ${track.title}`));
    player.events.on('disconnect', (queue) => logEvent(queue.guild, `⏹️ Disconnected from voice channel.`));

    client.once('clientReady', async () => {
        await player.extractors.loadDefault();
        console.log(`🤖 Discord Bot connected as ${client.user.tag}`);
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const cmds = [
            { name: 'summon', description: 'Summons the Miko Music Control Panel' },
            { 
                name: 'move', 
                description: 'Move a track in the queue', 
                options: [
                    { name: 'track', description: 'Current track number', type: 4, required: true },
                    { name: 'position', description: 'New position number', type: 4, required: true }
                ]
            }
        ];
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
        client.guilds.cache.forEach(g => rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, g.id), { body: cmds }).catch(()=>{}));
    });

    async function handlePlayback(channel, query, interaction) {
        const result = await player.search(query, { requestedBy: interaction.user });
        if (!result.hasTracks()) return interaction.followUp(`❌ No tracks found.`);
        await player.play(channel, result, { nodeOptions: { metadata: interaction.channel } });
        
        const title = result.playlist ? result.playlist.title : result.tracks[0].title;
        await interaction.followUp({ content: `✅ Queued: **${title}**`, ephemeral: true });
        logEvent(interaction.guild, `📥 **Added to queue:** ${title}`);
    }

    client.on('interactionCreate', async interaction => {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'summon') {
                const channel = interaction.member.voice.channel;
                if (!channel) return interaction.reply({ content: '❌ You must be in a voice channel!', ephemeral: true });

                const config = getConfig();
                if (config.panelChannelId && interaction.channelId !== config.panelChannelId) {
                    return interaction.reply({ content: `❌ Please use the dedicated music panel channel.`, ephemeral: true });
                }

                await interaction.deferReply();
                // MatchBox styling: 24/7 playback, no leave on end
                const queue = player.nodes.create(interaction.guild, { metadata: interaction.channel, leaveOnEmpty: false, leaveOnEnd: false, leaveOnStop: false });
                if (!queue.connection) await queue.connect(channel);

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_back').setLabel('⏮️ Back').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('btn_pause').setLabel('⏯️ Play/Pause').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('btn_skip').setLabel('⏭️ Skip').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('btn_shuffle').setLabel('🔀 Shuffle').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('btn_loop').setLabel('🔁 Loop').setStyle(ButtonStyle.Danger)
                );
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_add').setLabel('🔍 Add Song').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('btn_playlists').setLabel('📂 Load Saved Playlist').setStyle(ButtonStyle.Secondary)
                );
                await interaction.followUp({ content: '🎛️ **Miko Music Panel Active**', components: [row1, row2] });
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
                
                await interaction.reply({ content: `✅ Moved **${track.title}** to position ${to + 1}.`, ephemeral: true });
                logEvent(interaction.guild, `↕️ **Track Moved:** ${track.title} is now at position ${to + 1}.`);
            }
        }

        if (interaction.isButton()) {
            const queue = player.nodes.get(interaction.guildId);

            if (interaction.customId === 'btn_add') {
                const modal = new ModalBuilder().setCustomId('modal_search').setTitle('Add Track/Playlist');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel("URL or Name").setStyle(TextInputStyle.Short).setRequired(true)));
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'btn_playlists') {
                const config = getConfig();
                if (!config.savedPlaylists || !config.savedPlaylists.length) return interaction.reply({ content: 'No saved playlists.', ephemeral: true });
                const menu = new StringSelectMenuBuilder().setCustomId('menu_playlist').setPlaceholder('Select playlist');
                config.savedPlaylists.slice(0, 25).forEach(pl => { menu.addOptions({ label: pl.name, value: pl.url }); });
                return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
            }

            if (!queue) return interaction.reply({ content: 'Nothing playing.', ephemeral: true });

            if (interaction.customId === 'btn_pause') {
                queue.node.setPaused(!queue.node.isPaused());
                await interaction.reply({ content: queue.node.isPaused() ? '⏸️ Paused.' : '▶️ Resumed.', ephemeral: true });
            }
            if (interaction.customId === 'btn_skip') {
                queue.node.skip();
                await interaction.reply({ content: '⏭️ Skipped.', ephemeral: true });
                logEvent(interaction.guild, `⏭️ Track skipped by ${interaction.user.username}.`);
            }
            if (interaction.customId === 'btn_back') {
                if (!queue.history.previousTrack) return interaction.reply({ content: 'No previous track.', ephemeral: true });
                await queue.history.previous();
                await interaction.reply({ content: '⏮️ Playing previous.', ephemeral: true });
            }
            if (interaction.customId === 'btn_shuffle') {
                queue.tracks.shuffle();
                await interaction.reply({ content: '🔀 Queue shuffled.', ephemeral: true });
            }
            if (interaction.customId === 'btn_loop') {
                const currentMode = queue.repeatMode;
                let newMode = QueueRepeatMode.OFF;
                let msg = '🔁 Loop OFF';
                if (currentMode === QueueRepeatMode.OFF) { newMode = QueueRepeatMode.TRACK; msg = '🔂 Looping TRACK'; }
                else if (currentMode === QueueRepeatMode.TRACK) { newMode = QueueRepeatMode.QUEUE; msg = '🔁 Looping QUEUE'; }
                queue.setRepeatMode(newMode);
                await interaction.reply({ content: msg, ephemeral: true });
            }
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_search') {
            await interaction.deferReply({ ephemeral: true });
            await handlePlayback(interaction.member.voice.channel, interaction.fields.getTextInputValue('query'), interaction);
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'menu_playlist') {
            await interaction.deferReply({ ephemeral: true });
            await handlePlayback(interaction.member.voice.channel, interaction.values[0], interaction);
        }
    });

    client.login(process.env.DISCORD_TOKEN);
    return client;
}
module.exports = { startBot };
