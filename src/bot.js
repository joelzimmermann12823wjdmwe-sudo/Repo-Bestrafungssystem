require('dotenv').config();
const { Client, GatewayIntentBits, Collection, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState, EndBehaviorType } = require('@discordjs/voice');
const { mkdir, writeFile, readFile, stat } = require('fs/promises');
const fs = require('fs');
const { join } = require('path');
const Opus = require('opusscript');
const startWebServer = require('./server');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
    console.error('[FATAL] DISCORD_TOKEN is not set in .env');
    process.exit(1);
}

const PORT = parseInt(process.env.PORT) || 8080;
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '.';
const TALKS_DIR = join(DATA_DIR, 'talks');
const STRAFEN_FILE = join(DATA_DIR, 'strafen.json');
const PUNISHMENT_ROLE_ID = process.env.PUNISHMENT_ROLE_ID;
const ADMIN_ROLE_IDS = process.env.ADMIN_ROLE_IDS ? process.env.ADMIN_ROLE_IDS.split(',').map(s => s.trim()) : [];
const GUILD_ID = process.env.GUILD_ID;
const MAX_RECORDINGS = parseInt(process.env.MAX_RECORDINGS) || 10;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TALKS_DIR)) fs.mkdirSync(TALKS_DIR, { recursive: true });

// Recording counter file: tracks daily counters for folder naming
const COUNTER_FILE = join(DATA_DIR, 'counter.json');
let recordingCounter = {};

function loadCounter() {
    try {
        if (fs.existsSync(COUNTER_FILE)) {
            recordingCounter = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf-8'));
        }
    } catch {
        recordingCounter = {};
    }
}

function saveCounter() {
    try {
        fs.writeFileSync(COUNTER_FILE, JSON.stringify(recordingCounter, null, 2));
    } catch {}
}

loadCounter();

function getNextFolderName() {
    const now = new Date();
    const day = now.getDate();
    const month = now.getMonth() + 1;
    const year = now.getFullYear() % 100;
    const dateKey = `${day}.${month}.${year}`;

    if (!recordingCounter[dateKey]) {
        recordingCounter[dateKey] = 0;
    }
    recordingCounter[dateKey]++;
    saveCounter();

    return `${dateKey}-${recordingCounter[dateKey]}`;
}

class PunishmentManager {
    constructor(filePath) {
        this.filePath = filePath;
        this.punishments = [];
        this._timeouts = new Map();
    }

    async load() {
        try {
            const data = await readFile(this.filePath, 'utf-8');
            this.punishments = JSON.parse(data);
            console.log(`[Strafen] ${this.punishments.length} Eintrage geladen`);
        } catch {
            this.punishments = [];
        }
    }

    async save() {
        await writeFile(this.filePath, JSON.stringify(this.punishments, null, 2), 'utf-8');
    }

    scheduleRestore(punishment, guild) {
        const existing = this._timeouts.get(punishment.id);
        if (existing) clearTimeout(existing);
        const rem = punishment.endTime - Date.now();
        if (rem > 0) {
            const t = setTimeout(() => this.restoreUser(punishment, guild), rem);
            this._timeouts.set(punishment.id, t);
        } else {
            this.restoreUser(punishment, guild);
        }
    }

    async addPunishment(userId, username, durationMs, reason, moderatorId, oldRoles) {
        const p = {
            id: Date.now().toString(),
            userId,
            username,
            reason,
            durationMs,
            startTime: Date.now(),
            endTime: Date.now() + durationMs,
            moderatorId,
            oldRoles,
            active: true
        };
        this.punishments.push(p);
        await this.save();
        return p;
    }

    async restoreUser(punishment, guild) {
        if (!punishment.active) return;
        punishment.active = false;
        this._timeouts.delete(punishment.id);
        await this.save();
        try {
            if (!guild) {
                guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : client.guilds.cache.first();
            }
            if (!guild) return;
            const member = await guild.members.fetch(punishment.userId).catch(() => null);
            if (!member) return;
            if (PUNISHMENT_ROLE_ID) await member.roles.remove(PUNISHMENT_ROLE_ID).catch(() => {});
            const rolesToAdd = punishment.oldRoles.filter(
                r => guild.roles.cache.has(r) && !ADMIN_ROLE_IDS.includes(r)
            );
            if (rolesToAdd.length > 0) await member.roles.add(rolesToAdd);
            console.log(`[Strafen] ${punishment.username} wiederhergestellt`);
        } catch (err) {
            console.error(`[Fehler] Wiederherstellung:`, err.message);
        }
    }

    cleanup() {
        for (const [, t] of this._timeouts) clearTimeout(t);
        this._timeouts.clear();
    }

    getActivePunishments() { return this.punishments.filter(p => p.active); }
    getUserPunishment(userId) { return this.punishments.find(p => p.userId === userId && p.active); }
}

class VoiceRecorder {
    constructor(outputDir) {
        this.outputDir = outputDir;
        this.userRecordings = new Map();
        this.SAMPLE_RATE = 48000;
        this.CHANNELS = 2;
        this.FRAME_SIZE = this.SAMPLE_RATE / 50;
    }

    startUserStream(receiver, userId, username) {
        if (this.userRecordings.has(userId)) return;

        const safeName = username.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 80);
        const wavPath = join(this.outputDir, `USER_${safeName}.wav`);

        const opusStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.Manual }
        });

        const opusPackets = [];
        opusStream.on('data', (packet) => {
            if (packet && packet.length > 0) {
                opusPackets.push(Buffer.from(packet));
            }
        });

        opusStream.on('error', (err) => {
            console.error(`[Audio] Stream Error ${username}:`, err.message);
        });

        this.userRecordings.set(userId, {
            opusStream, opusPackets, wavPath, username
        });

        console.log(`[Audio] Recording: ${username}`);
    }

    async saveAll() {
        const count = this.userRecordings.size;
        console.log(`[Audio] Stoppe ${count} Aufnahmen...`);

        const promises = [];
        for (const [, data] of this.userRecordings) {
            data.opusStream.push(null);
            promises.push(this._waitForCloseAndDecode(data));
        }

        const results = await Promise.allSettled(promises);
        const success = results.filter(r => r.status === 'fulfilled' && r.value).length;
        this.userRecordings.clear();
        console.log(`[Audio] ${success} Aufnahmen gespeichert.`);
        return success;
    }

    _waitForCloseAndDecode(data) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                data.opusStream.destroy();
                resolve(this._decodeAndSave(data));
            }, 1000);

            data.opusStream.on('close', () => {
                clearTimeout(timeout);
                resolve(this._decodeAndSave(data));
            });
        });
    }

    _decodeAndSave(data) {
        return new Promise((resolve) => {
            if (data.opusPackets.length === 0) {
                console.log(`[Audio] ${data.username}: keine Pakete`);
                return resolve(false);
            }

            try {
                const decoder = new Opus(this.SAMPLE_RATE, this.CHANNELS, Opus.Application.AUDIO);
                const pcmFrames = [];

                for (const packet of data.opusPackets) {
                    const decoded = decoder.decode(packet, this.FRAME_SIZE);
                    pcmFrames.push(Buffer.from(decoded));
                }

                decoder.delete();

                const pcmBuffer = Buffer.concat(pcmFrames);
                const normalized = this._normalizeAudio(pcmBuffer);
                const wav = this._buildWav(normalized);

                fs.writeFileSync(data.wavPath, wav);

                stat(data.wavPath).then((s) => {
                    if (s.size > 44) {
                        console.log(`[Audio] ${data.username}: ${(s.size / 1024).toFixed(1)} KB WAV (${data.opusPackets.length} Pakete)`);
                        resolve(true);
                    } else {
                        console.error(`[Audio] ${data.username}: WAV leer`);
                        resolve(false);
                    }
                }).catch(() => resolve(false));
            } catch (err) {
                console.error(`[Audio] Decode Error ${data.username}:`, err.message);
                resolve(false);
            }
        });
    }

    _normalizeAudio(pcmBuffer) {
        const normalized = Buffer.alloc(pcmBuffer.length);
        let maxVal = 0;

        for (let i = 0; i < pcmBuffer.length; i += 2) {
            const val = Math.abs(pcmBuffer.readInt16LE(i));
            if (val > maxVal) maxVal = val;
        }

        if (maxVal === 0) return pcmBuffer;

        const targetMax = 28000;
        const gain = targetMax / maxVal;

        for (let i = 0; i < pcmBuffer.length; i += 2) {
            const val = pcmBuffer.readInt16LE(i);
            const amplified = Math.max(-32768, Math.min(32767, Math.round(val * gain)));
            normalized.writeInt16LE(amplified, i);
        }

        return normalized;
    }

    _buildWav(pcmBuffer) {
        const header = Buffer.alloc(44);
        const dataSize = pcmBuffer.length;

        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(this.CHANNELS, 22);
        header.writeUInt32LE(this.SAMPLE_RATE, 24);
        header.writeUInt32LE(this.SAMPLE_RATE * this.CHANNELS * 2, 28);
        header.writeUInt16LE(this.CHANNELS * 2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, pcmBuffer]);
    }

    getUserCount() { return this.userRecordings.size; }
}

// Multi-channel support: key is sessionId (not guildId)
const activeRecordings = new Map();
const speakingListeners = new Map();
let sessionIdCounter = 0;

const commands = [
    new SlashCommandBuilder().setName('talk_start').setDescription('Startet die Voice-Aufnahme'),
    new SlashCommandBuilder().setName('talk_stop').setDescription('Stoppt die Voice-Aufnahme'),
    new SlashCommandBuilder().setName('talk_status').setDescription('Zeigt Aufnahme-Status'),
    new SlashCommandBuilder()
        .setName('bestrafung')
        .setDescription('Bestraft einen User')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption(o => o.setName('dauer').setDescription('Minuten').setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName('grund').setDescription('Grund').setRequired(true)),
    new SlashCommandBuilder().setName('strafen').setDescription('Zeigt aktive Bestrafungen'),
];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

client.commands = new Collection();
let punishmentManager;

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guildId } = interaction;

    if (commandName === 'talk_start') {
        const member = interaction.member;
        if (!member.voice?.channelId) {
            return interaction.reply({ content: 'Du bist in keinem Voice-Channel!', ephemeral: true });
        }

        // Count active recordings in this guild
        let guildRecordings = 0;
        for (const [, session] of activeRecordings) {
            if (session.guildId === guildId) guildRecordings++;
        }
        if (guildRecordings >= MAX_RECORDINGS) {
            return interaction.reply({ content: `Maximal ${MAX_RECORDINGS} Aufnahmen gleichzeitig!`, ephemeral: true });
        }

        // Check if user is already in an active recording
        for (const [, session] of activeRecordings) {
            if (session.guildId === guildId && session.channelId === member.voice.channelId) {
                return interaction.reply({ content: 'Dieser Channel wird bereits aufgenommen!', ephemeral: true });
            }
        }

        await interaction.deferReply();
        const channel = member.voice.channel;
        const folderName = getNextFolderName();
        const outputDir = join(TALKS_DIR, folderName);

        try {
            await mkdir(outputDir, { recursive: true });
        } catch (err) {
            return interaction.editReply(`Fehler: Ordner erstellen fehlgeschlagen`);
        }

        try {
            const connection = joinVoiceChannel({
                channelId: channel.id, guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false, selfMute: true,
            });
            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
            console.log(`[Voice] ${channel.name} (${folderName})`);

            const sessionId = `session_${++sessionIdCounter}`;
            const recorder = new VoiceRecorder(outputDir);
            const receiver = connection.receiver;
            const speakingHandler = async (userId) => {
                if (recorder.userRecordings.has(userId)) return;
                try {
                    const m = await interaction.guild.members.fetch(userId).catch(() => null);
                    const username = m?.user.username || `user_${userId}`;
                    recorder.startUserStream(receiver, userId, username);
                } catch (err) {
                    console.error(`[Fehler] ${userId}:`, err.message);
                }
            };
            receiver.speaking.on('start', speakingHandler);

            speakingListeners.set(sessionId, { receiver, handler: speakingHandler });
            activeRecordings.set(sessionId, {
                connection, recorder, startTime: Date.now(),
                guildId, channelId: channel.id, channelName: channel.name, folderName
            });

            await interaction.editReply(
                `Aufnahme in **${channel.name}** gestartet!\nOrdner: \`${folderName}\``
            );
        } catch (error) {
            console.error('[Fehler] Start:', error);
            await interaction.editReply(`Fehler: ${error.message}`);
        }
    }

    if (commandName === 'talk_stop') {
        // Find all recordings in this guild
        const guildSessions = [];
        for (const [id, session] of activeRecordings) {
            if (session.guildId === guildId) {
                guildSessions.push({ id, ...session });
            }
        }

        if (guildSessions.length === 0) {
            return interaction.reply({ content: 'Keine Aufnahme in diesem Server!', ephemeral: true });
        }

        if (guildSessions.length === 1) {
            const session = guildSessions[0];
            await interaction.deferReply();
            try {
                const listener = speakingListeners.get(session.id);
                if (listener) {
                    listener.receiver.speaking.removeListener('start', listener.handler);
                    speakingListeners.delete(session.id);
                }
                session.connection.destroy();
                const count = await session.recorder.saveAll();
                activeRecordings.delete(session.id);
                await interaction.editReply(`Aufnahme **${session.folderName}** beendet!\n${count} Sprecher.`);
            } catch (error) {
                console.error('[Fehler] Stop:', error);
                await interaction.editReply(`Fehler: ${error.message}`);
            }
        } else {
            // Multiple recordings: let user choose which one to stop
            const channel = interaction.member.voice.channel;
            const matchingSession = guildSessions.find(s => s.channelId === channel?.id);

            if (matchingSession) {
                await interaction.deferReply();
                try {
                    const listener = speakingListeners.get(matchingSession.id);
                    if (listener) {
                        listener.receiver.speaking.removeListener('start', listener.handler);
                        speakingListeners.delete(matchingSession.id);
                    }
                    matchingSession.connection.destroy();
                    const count = await matchingSession.recorder.saveAll();
                    activeRecordings.delete(matchingSession.id);
                    await interaction.editReply(`Aufnahme **${matchingSession.folderName}** (${matchingSession.channelName}) beendet!\n${count} Sprecher.`);
                } catch (error) {
                    console.error('[Fehler] Stop:', error);
                    await interaction.editReply(`Fehler: ${error.message}`);
                }
            } else {
                // Stop all or show list
                const embed = new EmbedBuilder()
                    .setColor(0xffaa00).setTitle('Laufende Aufnahmen')
                    .setDescription(`Es laufen ${guildSessions.length} Aufnahmen. Gehe in den Channel den du stoppen willst, oder nutze \`/talk_stop_all\`.`);
                for (const s of guildSessions) {
                    const dur = Math.floor((Date.now() - s.startTime) / 1000);
                    embed.addFields({
                        name: s.folderName,
                        value: `Channel: ${s.channelName}\nDauer: ${dur}s | ${s.recorder.getUserCount()} User`,
                        inline: false
                    });
                }
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }
    }

    if (commandName === 'talk_status') {
        const allSessions = Array.from(activeRecordings.values());
        if (allSessions.length === 0) {
            return interaction.reply('Keine Aufnahme aktiv');
        }
        const embed = new EmbedBuilder()
            .setColor(0x00ff00).setTitle('Aktive Aufnahmen')
            .setDescription(`${allSessions.length} von ${MAX_RECORDINGS} Slots belegt`);
        for (const s of allSessions) {
            const dur = Math.floor((Date.now() - s.startTime) / 1000);
            embed.addFields({
                name: s.folderName,
                value: `Channel: ${s.channelName}\nDauer: ${dur}s | ${s.recorder.getUserCount()} User`,
                inline: false
            });
        }
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'bestrafung') {
        const targetUser = interaction.options.getUser('user');
        const durationMin = interaction.options.getInteger('dauer');
        const reason = interaction.options.getString('grund');
        const isAdmin = interaction.member.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
        if (!isAdmin && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Keine Berechtigung!', ephemeral: true });
        }
        if (!PUNISHMENT_ROLE_ID) {
            return interaction.reply({ content: 'PUNISHMENT_ROLE_ID fehlt!', ephemeral: true });
        }
        const targetMember = await interaction.guild.members.fetch(targetUser.id);
        if (punishmentManager.getUserPunishment(targetUser.id)) {
            return interaction.reply({ content: 'User bereits bestraft!', ephemeral: true });
        }
        const oldRoles = targetMember.roles.cache
            .filter(r => r.id !== interaction.guildId && !ADMIN_ROLE_IDS.includes(r.id))
            .map(r => r.id);
        await targetMember.roles.set([]);
        await targetMember.roles.add(PUNISHMENT_ROLE_ID);
        const punishment = await punishmentManager.addPunishment(
            targetUser.id, targetUser.username, durationMin * 60 * 1000,
            reason, interaction.user.id, oldRoles
        );
        const guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : interaction.guild;
        punishmentManager.scheduleRestore(punishment, guild);
        const embed = new EmbedBuilder()
            .setColor(0xff0000).setTitle('Bestrafung')
            .addFields(
                { name: 'User', value: `<@${targetUser.id}>`, inline: true },
                { name: 'Mod', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Dauer', value: `${durationMin} min`, inline: true },
                { name: 'Grund', value: reason, inline: false }
            ).setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'strafen') {
        const active = punishmentManager.getActivePunishments();
        if (active.length === 0) return interaction.reply('Keine Bestrafungen');
        const embed = new EmbedBuilder()
            .setColor(0xffaa00).setTitle('Bestrafungen')
            .setDescription(`${active.length} User`);
        for (const p of active) {
            const rem = Math.max(0, Math.floor((p.endTime - Date.now()) / 1000));
            embed.addFields({
                name: p.username,
                value: `${p.reason}\n${Math.floor(rem / 60)}m ${rem % 60}s`,
                inline: false
            });
        }
        await interaction.reply({ embeds: [embed] });
    }
});

client.once('clientReady', async () => {
    console.log(`Bot online: ${client.user.tag}`);
    punishmentManager = new PunishmentManager(STRAFEN_FILE);
    await punishmentManager.load();
    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        if (GUILD_ID) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands.map(c => c.toJSON()) });
        } else {
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) });
        }
        console.log('[Commands] OK');
    } catch (err) {
        console.error('[Fehler] Commands:', err.message);
    }
    const guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : client.guilds.cache.first();
    for (const p of punishmentManager.getActivePunishments()) {
        punishmentManager.scheduleRestore(p, guild);
    }
});

startWebServer(client, activeRecordings, TALKS_DIR);

client.login(TOKEN).catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
});

module.exports = { client, activeRecordings, TALKS_DIR };
