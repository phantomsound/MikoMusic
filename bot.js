const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { Player, QueueRepeatMode } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const fs = require('fs');

const activeSyncs = new Map();

function checkPermissions(interaction) {
    try {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        const roles = config.adminRoles || [];
        const users = config.adminUsers || [];
        if (roles.length === 0 && users.length === 0) return true; 
        const hasRole = roles.some(roleId => interaction.member.roles.cache.has(roleId));
        const hasUser = users.includes(interaction.user.id);
        return hasRole || hasUser;
    } catch (e) { return true; }
}

function startBot() {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    const player = new Player(client);
    client.player = player;
    
    player.events.on('error', (queue, error) => console.error('[Player Error]', error.message));
    player.events.on('playerError', (queue, error) => console.error('[Audio Error]', error.message));

    client.once('clientReady', async () => {
        await player.extractors.loadDefault();
        console.log(`🤖 Discord Bot connected as ${client.user.tag}`);
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const cmds = [{ name: 'summon', description: 'Summons the Miko Music Control Panel' }];
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
        client.guilds.cache.forEach(g => rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, g.id), { body: cmds }).catch(()=>{}));
    });

    async function handlePlaybackAndSync(channel, query, interaction) {
        const result = await player.search(query, { requestedBy: interaction.user });
        if (!result.hasTracks()) return interaction.followUp(`❌ No tracks found.`);
        await player.play(channel, result, { nodeOptions: { metadata: interaction.channel } });
        await interaction.followUp(`✅ Queued: **${result.playlist ? result.playlist.title : result.tracks[0].title}**`);
    }

    client.on('interactionCreate', async interaction => {
        if (interaction.isChatInputCommand() && interaction.commandName === 'summon') {
            const channel = interaction.member.voice.channel;
            if (!channel) return interaction.reply({ content: '❌ You must be in a voice channel!', ephemeral: true });

            await interaction.deferReply();
            const queue = player.nodes.create(interaction.guild, { metadata: interaction.channel, leaveOnEmpty: false });
            if (!queue.connection) await queue.connect(channel);

            // Row 1: Core Playback
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_back').setLabel('⏮️ Back').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('btn_pause').setLabel('⏯️ Play/Pause').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_skip').setLabel('⏭️ Skip').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('btn_shuffle').setLabel('🔀 Shuffle').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('btn_loop').setLabel('🔁 Loop').setStyle(ButtonStyle.Danger)
            );
            // Row 2: Playlist & Adding
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_add').setLabel('🔍 Add Song').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_playlists').setLabel('📂 Load Saved Playlist').setStyle(ButtonStyle.Secondary)
            );

            await interaction.followUp({ content: '🎛️ **Miko Music Panel Active**', components: [row1, row2] });
        }

        if (interaction.isButton()) {
            if (!checkPermissions(interaction)) return interaction.reply({ content: '🚫 Permission denied.', ephemeral: true });
            const queue = player.nodes.get(interaction.guildId);

            if (interaction.customId === 'btn_add') {
                const modal = new ModalBuilder().setCustomId('modal_search').setTitle('Add Track/Playlist');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel("URL or Name").setStyle(TextInputStyle.Short).setRequired(true)));
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'btn_playlists') {
                const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
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
            if (!checkPermissions(interaction)) return interaction.reply({ content: '🚫 Denied.', ephemeral: true });
            await interaction.deferReply();
            await handlePlaybackAndSync(interaction.member.voice.channel, interaction.fields.getTextInputValue('query'), interaction);
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'menu_playlist') {
            if (!checkPermissions(interaction)) return interaction.reply({ content: '🚫 Denied.', ephemeral: true });
            await interaction.deferReply();
            await handlePlaybackAndSync(interaction.member.voice.channel, interaction.values[0], interaction);
        }
    });

    client.login(process.env.DISCORD_TOKEN);
    return client;
}
module.exports = { startBot };

