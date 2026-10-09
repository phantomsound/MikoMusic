const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { Player } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const fs = require('fs');

const activeSyncs = new Map(); // Store playlist polling intervals by guild

function checkPermissions(interaction) {
    try {
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
        const roles = config.adminRoles || [];
        const users = config.adminUsers || [];
        if (roles.length === 0 && users.length === 0) return true; // Open to everyone if empty
        
        const hasRole = roles.some(roleId => interaction.member.roles.cache.has(roleId));
        const hasUser = users.includes(interaction.user.id);
        return hasRole || hasUser;
    } catch (e) {
        return true; 
    }
}

function startBot() {
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });

    const player = new Player(client);
    client.player = player;
    player.events.on('error', (queue, error) => console.error('[Player Error]', error.message));
    player.events.on('playerError', (queue, error) => console.error('[Audio Error]', error.message));
    
    client.once('clientReady', async () => {
        await player.extractors.loadDefault();
        console.log(`?? Discord Bot connected as ${client.user.tag}`);

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), [{
            name: 'summon',
            description: 'Summons the Miko Music Control Panel'
        }]);
    });

    // ?? The Dynamic Sync Engine
    async function handlePlaybackAndSync(channel, query, interaction) {
        const result = await player.search(query, { requestedBy: interaction.user });
        if (!result.hasTracks()) {
            await interaction.followUp(`? No tracks found for that query.`);
            return;
        }

        await player.play(channel, result, { nodeOptions: { metadata: interaction.channel } });
        
        if (result.hasPlaylist()) {
            await interaction.followUp(`? Queued Playlist: **${result.playlist.title}**`);
            
            const guildId = interaction.guildId;
            if (activeSyncs.has(guildId)) clearInterval(activeSyncs.get(guildId));
            
            const knownUrls = new Set(result.tracks.map(t => t.url));
            
            // Poll the playlist every 3 minutes for changes
            const interval = setInterval(async () => {
                const queue = player.nodes.get(guildId);
                if (!queue) {
                    clearInterval(interval);
                    activeSyncs.delete(guildId);
                    return;
                }
                
                try {
                    const freshResult = await player.search(query);
                    if (freshResult.hasPlaylist()) {
                        let added = 0;
                        for (const track of freshResult.tracks) {
                            if (!knownUrls.has(track.url)) {
                                knownUrls.add(track.url);
                                queue.addTrack(track);
                                added++;
                            }
                        }
                        if (added > 0) {
                            queue.metadata.send(`?? **Sync Engine:** Detected ${added} new track(s) added to the live playlist. Automatically queued!`);
                        }
                    }
                } catch (e) { console.error('Sync interval error:', e); }
            }, 3 * 60 * 1000); 
            
            activeSyncs.set(guildId, interval);
        } else {
            await interaction.followUp(`? Queued: **${result.tracks[0].title}**`);
        }
    }

    client.on('interactionCreate', async interaction => {
        if (interaction.isChatInputCommand() && interaction.commandName === 'summon') {
            const channel = interaction.member.voice.channel;
            if (!channel) return interaction.reply({ content: '? You must be in a voice channel!', ephemeral: true });

            await interaction.deferReply();
            const queue = player.nodes.create(interaction.guild, { metadata: interaction.channel, leaveOnEmpty: false });
            if (!queue.connection) await queue.connect(channel);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_add').setLabel('?? Add Song').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('btn_pause').setLabel('?? Play/Pause').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('btn_skip').setLabel('?? Skip').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('btn_playlists').setLabel('?? Saved Playlists').setStyle(ButtonStyle.Success)
            );

            await interaction.followUp({
                content: '??? **Miko Music Panel Active**\nUse the buttons below to control the queue.',
                components: [row]
            });
        }

        if (interaction.isButton()) {
            if (!checkPermissions(interaction)) return interaction.reply({ content: '?? You lack permissions to use this control.', ephemeral: true });
            
            const queue = player.nodes.get(interaction.guildId);

            if (interaction.customId === 'btn_add') {
                const modal = new ModalBuilder().setCustomId('modal_search').setTitle('Add a Song or Playlist');
                const searchInput = new TextInputBuilder().setCustomId('query').setLabel("URL or Song Name").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(searchInput));
                await interaction.showModal(modal);
            }

            if (interaction.customId === 'btn_pause') {
                if (!queue || !queue.currentTrack) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
                queue.node.setPaused(!queue.node.isPaused());
                await interaction.reply({ content: queue.node.isPaused() ? '?? Paused.' : '?? Resumed.', ephemeral: true });
            }

            if (interaction.customId === 'btn_skip') {
                if (!queue || !queue.currentTrack) return interaction.reply({ content: 'Nothing to skip.', ephemeral: true });
                queue.node.skip();
                await interaction.reply({ content: '?? Skipped track.', ephemeral: true });
            }

            if (interaction.customId === 'btn_playlists') {
                const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
                if (!config.savedPlaylists || !config.savedPlaylists.length) return interaction.reply({ content: 'No saved playlists found in notepad.', ephemeral: true });
                
                const menu = new StringSelectMenuBuilder().setCustomId('menu_playlist').setPlaceholder('Select a saved playlist');
                config.savedPlaylists.slice(0, 25).forEach(pl => { menu.addOptions({ label: pl.name, value: pl.url }); });

                await interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
            }
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_search') {
            if (!checkPermissions(interaction)) return interaction.reply({ content: '?? You lack permissions to add songs.', ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            await handlePlaybackAndSync(interaction.member.voice.channel, interaction.fields.getTextInputValue('query'), interaction);
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'menu_playlist') {
            if (!checkPermissions(interaction)) return interaction.reply({ content: '?? You lack permissions to load playlists.', ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            await handlePlaybackAndSync(interaction.member.voice.channel, interaction.values[0], interaction);
        }
    });

    client.login(process.env.DISCORD_TOKEN);
    return client;
}

module.exports = { startBot };



