require('dotenv').config();
const { Client, GatewayIntentBits, Collection, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState, EndBehaviorType } = require('@discordjs/voice');
const { mkdir, writeFile, readFile, stat } = require('fs/promises');
const fs = require('fs');
const { join } = require('path');
const Opus = require('opusscript');
const startWebServer = require('./server');
const { uploadToGoogleDrive, syncStrafen } = require('./gdrive');
const http = require('http');

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
const MAX_RECORDING_BYTES = 460 * 1024 * 1024; // 460 MB → automatische Rotation

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
        syncStrafen(this.filePath);
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
        this._decodedPcm = new Map();
    }

    // Geschätzte PCM-Größe aller gesammelten Opus-Pakete (in Bytes)
    getEstimatedPcmBytes() {
        let totalPackets = 0;
        const pcmBytesPerPacket = this.FRAME_SIZE * this.CHANNELS * 2; // 3840
        for (const [, data] of this.userRecordings) {
            totalPackets += data.opusPackets.length;
        }
        return totalPackets * pcmBytesPerPacket;
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

        // Create combined talk file
        await this._saveCombinedTalk();

        this.userRecordings.clear();
        this._decodedPcm.clear();
        console.log(`[Audio] ${success} Aufnahmen gespeichert.`);
        return success;
    }

    async _saveCombinedTalk() {
        if (this._decodedPcm.size === 0) return;

        // Find max length to interleave
        let maxLen = 0;
        const buffers = [];
        for (const [, pcm] of this._decodedPcm) {
            buffers.push(pcm);
            if (pcm.length > maxLen) maxLen = pcm.length;
        }

        // Interleave: mix all PCM samples together
        const mixed = Buffer.alloc(maxLen);
        for (let i = 0; i < maxLen; i += 2) {
            let sum = 0;
            let count = 0;
            for (const buf of buffers) {
                if (i < buf.length) {
                    sum += buf.readInt16LE(i);
                    count++;
                }
            }
            const avg = count > 0 ? Math.round(sum / count) : 0;
            mixed.writeInt16LE(Math.max(-32768, Math.min(32767, avg)), i);
        }

        const normalized = this._normalizeAudio(mixed);
        const wav = this._buildWav(normalized);
        const combinedPath = join(this.outputDir, 'TALK_GESAMT.wav');
        fs.writeFileSync(combinedPath, wav);

        const s = await stat(combinedPath);
        console.log(`[Audio] Gesamt-Talk: ${(s.size / 1024).toFixed(1)} KB`);
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
                this._decodedPcm.set(data.username, pcmBuffer);

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

// Active recordings by channel ID (allows direct lookup)
const activeRecordings = new Map();
// Map: channelId -> { connection, recorder, startTime, guildId, channelName, folderName, autoManaged }
const speakingListeners = new Map();

const RECORD_CHANNELS_FILE = join(DATA_DIR, 'record_channels.json');
let recordChannelConfig = { channels: [], recordAll: false };

function loadRecordChannels() {
    try {
        if (fs.existsSync(RECORD_CHANNELS_FILE)) {
            recordChannelConfig = JSON.parse(fs.readFileSync(RECORD_CHANNELS_FILE, 'utf-8'));
        }
    } catch {}
    console.log(`[Record] ${recordChannelConfig.recordAll ? 'Alle Channels' : recordChannelConfig.channels.length + ' Channels'} konfiguriert`);
}

function saveRecordChannels() {
    try {
        fs.writeFileSync(RECORD_CHANNELS_FILE, JSON.stringify(recordChannelConfig, null, 2));
    } catch {}
}

loadRecordChannels();

// Track which users are in which channels for auto-leave detection
const channelUsers = new Map(); // channelId -> Set<userId>

let addLog; // wird von startWebServer gesetzt
const PORTAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://repo-bestrafungssystem-abe9.onrender.com';

// DM an ALLE User im Channel: Aufzeichnung läuft
async function notifyRecordingStart(channel) {
    for (const [, member] of channel.members) {
        if (member.user.bot) continue;
        try {
            const embed = new EmbedBuilder()
                .setTitle('🔴 Aufzeichnung aktiv')
                .setDescription(
                    `In **#${channel.name}** läuft eine Aufzeichnung.\n\n` +
                    'Moderatoren haben Zugriff auf die Aufnahmen.\n\n' +
                    'Du kannst die Aufnahmen im Portal anhören und herunterladen:'
                )
                .addFields({ name: '🔗 Portal', value: PORTAL_URL })
                .setColor(0xED4245);
            await member.send({ embeds: [embed] });
            console.log(`[DM] Aufzeichnungs-Hinweis an ${member.user.tag} gesendet`);
        } catch (err) {
            if (err.code === 50007) {
                console.log(`[DM] Kann ${member.user.tag} keine DM senden (geschlossene DMs)`);
            } else {
                console.error(`[DM] Fehler bei ${member.user.tag}:`, err.message);
            }
        }
    }
}

// DM an einzelnen User: Aufzeichnung läuft (z.B. nach Join)
async function sendRecordingDM(userId, guild, channelName) {
    try {
        const user = await client.users.fetch(userId);
        const embed = new EmbedBuilder()
            .setTitle('🔴 Aufzeichnung aktiv')
            .setDescription(
                `In **#${channelName || 'einem Voice-Channel'}** läuft eine Aufzeichnung.\n\n` +
                'Moderatoren haben Zugriff auf die Aufnahmen.\n\n' +
                'Du kannst die Aufnahmen im Portal anhören und herunterladen:'
            )
            .addFields({ name: '🔗 Portal', value: PORTAL_URL })
            .setColor(0xED4245);
        await user.send({ embeds: [embed] });
        console.log(`[DM] Aufzeichnungs-Hinweis an ${user.tag} gesendet`);
    } catch (err) {
        if (err.code === 50007) {
            console.log(`[DM] Kann ${userId} keine DM senden (gechlossene DMs)`);
        } else {
            console.error(`[DM] Fehler bei ${userId}:`, err.message);
        }
    }
}

// DM an alle Admins nach Neustart (Login-Daten + Anleitung + Commands)
async function notifyAdminsOnRestart(guild) {
    if (!guild) return;
    const webUsername = process.env.WEB_USERNAME || 'admin';
    const webPassword = process.env.WEB_PASSWORD || 'admin123';
    const hasCustomCredentials = webUsername !== 'admin' || webPassword !== 'admin123';

    for (const [, member] of guild.members.cache) {
        const isAdmin = member.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
        if (!isAdmin) continue;

        try {
            const embed = new EmbedBuilder()
                .setTitle('🤖 Bot neu gestartet')
                .setDescription('Der Bot wurde neu gestartet. Hier sind alle wichtigen Informationen:')
                .addFields(
                    { name: '🔗 Dashboard', value: PORTAL_URL },
                    { name: '📋 Verfügbare Commands', value:
                        '`/record channel` - Channel zur Aufnahme hinzufügen\n' +
                        '`/record all` - Alle Voice-Channels aufnehmen\n' +
                        '`/record stop` - Aufnahme stoppen\n' +
                        '`/record status` - Status anzeigen\n' +
                        '`/bestrafung` - User bestrafen (Rolle entziehen)\n' +
                        '`/strafen` - Aktive Bestrafungen anzeigen'
                    }
                )
                .setColor(0x5865F2)
                .setTimestamp();

            if (hasCustomCredentials) {
                embed.addFields(
                    { name: '👤 Dashboard-Login', value: `\`${webUsername}\` / \`${webPassword}\``, inline: false }
                );
            }

            await member.send({ embeds: [embed] });
            console.log(`[DM] Restart-Anleitung an Admin ${member.user.tag} gesendet`);
        } catch (err) {
            if (err.code === 50007) {
                console.log(`[DM] Kann Admin ${member.user.tag} keine DM senden (geschlossene DMs)`);
            } else {
                console.error(`[DM] Admin-Restart-DM Fehler:`, err.message);
            }
        }
    }
}

function shouldRecordChannel(channelId) {
    if (recordChannelConfig.recordAll) return true;
    return recordChannelConfig.channels.includes(channelId);
}

async function startRecordingForChannel(channel, guild, autoManaged = true) {
    if (activeRecordings.has(channel.id)) return 'already_active';

    if (activeRecordings.size >= MAX_RECORDINGS) {
        console.log(`[Record] Max recordings reached (${MAX_RECORDINGS})`);
        return 'max_reached';
    }

    const folderName = getNextFolderName();
    const outputDir = join(TALKS_DIR, folderName);

    try {
        await mkdir(outputDir, { recursive: true });
    } catch (e) {
        console.error(`[Fehler] Ordner erstellen: ${e.message}`);
        return 'error';
    }

    try {
        console.log(`[Voice] Versuche zu joinen: ${channel.name}`);
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: true,
        });
        
        await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        console.log(`[Voice] Verbunden: ${channel.name} (${folderName})`);

        const recorder = new VoiceRecorder(outputDir);
        const receiver = connection.receiver;
        const speakingHandler = async (userId) => {
            if (recorder.userRecordings.has(userId)) return;
            try {
                const m = await guild.members.fetch(userId).catch(() => null);
                const username = m?.user.username || `user_${userId}`;
                recorder.startUserStream(receiver, userId, username);
            } catch (err) {
                console.error(`[Fehler] ${userId}:`, err.message);
            }
        };
        receiver.speaking.on('start', speakingHandler);

        speakingListeners.set(channel.id, { receiver, handler: speakingHandler });
        const sizeCheckInterval = setInterval(() => {
            const est = recorder.getEstimatedPcmBytes();
            if (est > MAX_RECORDING_BYTES) {
                console.log(`[Record] ${channel.name}: ${(est / 1024 / 1024).toFixed(0)} MB geschätzt → Rotation`);
                stopRecordingForChannel(channel.id).then(() => {
                    startRecordingForChannel(channel, guild, autoManaged);
                });
            }
        }, 30000); // alle 30s prüfen

        activeRecordings.set(channel.id, {
            connection,
            recorder,
            startTime: Date.now(),
            guildId: guild.id,
            channelName: channel.name,
            folderName,
            outputDir,
            autoManaged,
            sizeCheckInterval
        });

        console.log(`[Record] Started in ${channel.name}`);

        // Alle User im Channel benachrichtigen
        notifyRecordingStart(channel);

        // Log: Aufnahme gestartet
        if (addLog) addLog('recording_start', 'system', `Aufnahme gestartet in #${channel.name} (${folderName})`);
        return 'started';
    } catch (error) {
        console.error(`[Fehler] Start ${channel.name}:`, error.message);
        // Cleanup if connection was partially created
        try {
            const conn = activeRecordings.get(channel.id);
            if (conn && conn.connection) conn.connection.destroy();
        } catch {}
        return 'error';
    }
}

async function stopRecordingForChannel(channelId) {
    const session = activeRecordings.get(channelId);
    if (!session) return 0;

    const listener = speakingListeners.get(channelId);
    if (listener) {
        listener.receiver.speaking.removeListener('start', listener.handler);
        speakingListeners.delete(channelId);
    }

    if (session.sizeCheckInterval) {
        clearInterval(session.sizeCheckInterval);
    }

    session.connection.destroy();
    const count = await session.recorder.saveAll();
    activeRecordings.delete(channelId);
    channelUsers.delete(channelId);
    console.log(`[Record] Stopped ${session.folderName} (${count} speakers)`);

    // Upload to Google Drive
    if (count > 0) {
        const uploaded = await uploadToGoogleDrive(session.outputDir, session.folderName);
        if (uploaded) {
            console.log(`[Drive] Upload complete: ${session.folderName}`);
        }
    }

    return count;
}

const commands = [
    new SlashCommandBuilder()
        .setName('record')
        .setDescription('Wähle Channels zum Aufnehmen')
        .addSubcommand(sub =>
            sub.setName('channel')
                .setDescription('Wähle einen Channel zum Aufnehmen')
                .addStringOption(opt =>
                    opt.setName('channel')
                        .setDescription('Voice-Channel')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('all')
                .setDescription('Nimmt alle Voice-Channels auf')
        )
        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('Stoppt die Aufnahme in einem Channel')
                .addStringOption(opt =>
                    opt.setName('channel')
                        .setDescription('Channel-Name oder ID')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Zeigt Aufnahme-Status')
        ),
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

// Autocomplete for channel selection
client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'channel') {
            const guild = interaction.guild;
            if (!guild) return interaction.respond([]);

            const channels = guild.channels.cache
                .filter(ch => ch.type === 2)
                .map(ch => ({ name: `${ch.name}`, value: ch.id }));

            const query = focused.value.toLowerCase();
            const filtered = query ? channels.filter(ch => ch.name.toLowerCase().includes(query) || ch.value.includes(query)) : channels;

            try {
                await interaction.respond(filtered.slice(0, 25));
            } catch (e) {
                console.log('[Autocomplete] Error:', e.message);
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'record') {
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        if (!guild) {
            return interaction.reply({ content: 'Nur in einem Server verfügbar!', ephemeral: true });
        }

        const isAdmin = interaction.member.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
        if (!isAdmin && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Keine Berechtigung!', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: subcommand === 'stop' });

        if (subcommand === 'channel') {
            const channelId = interaction.options.getString('channel');
            const channel = guild.channels.cache.get(channelId);

            if (!channel || channel.type !== 2) {
                return interaction.editReply({ content: 'Ungültiger Voice-Channel!' });
            }

            if (!recordChannelConfig.channels.includes(channelId)) {
                recordChannelConfig.channels.push(channelId);
                saveRecordChannels();
            }

            const humanCount = channel.members.filter(m => !m.user.bot).size;
            if (humanCount > 0 && !activeRecordings.has(channelId)) {
                const result = await startRecordingForChannel(channel, guild, true);
                if (result === 'started') {
                    await interaction.editReply({ content: `Aufnahme für **${channel.name}** gestartet! (${humanCount} User)` });
                } else if (result === 'already_active') {
                    await interaction.editReply({ content: `Aufnahme für **${channel.name}** ist bereits aktiv.` });
                } else {
                    await interaction.editReply({ content: `Fehler beim Starten in **${channel.name}**!` });
                }
            } else {
                await interaction.editReply({ content: `Channel **${channel.name}** zur Aufnahme-Liste hinzugefügt.\nBot joint automatisch wenn User den Channel betreten.` });
            }
        }

        if (subcommand === 'all') {
            recordChannelConfig.recordAll = true;
            recordChannelConfig.channels = [];
            saveRecordChannels();

            const voiceChannels = guild.channels.cache.filter(ch => ch.type === 2);
            let count = 0;
            let waiting = 0;
            for (const [, channel] of voiceChannels) {
                const humanCount = channel.members.filter(m => !m.user.bot).size;
                if (humanCount > 0) {
                    const res = await startRecordingForChannel(channel, guild, true);
                    if (res === 'started') count++;
                } else {
                    waiting++;
                }
            }

            let msg = `Aufnahme für **alle Voice-Channels** aktiviert!`;
            if (count > 0) msg += `\nBot in ${count} Channels gestartet.`;
            if (waiting > 0) msg += `\n${waiting} Channels warten auf User.`;
            await interaction.editReply({ content: msg });
        }

        if (subcommand === 'stop') {
            const channelId = interaction.options.getString('channel');
            const channel = guild.channels.cache.get(channelId);

            if (!channel || channel.type !== 2) {
                return interaction.editReply({ content: 'Ungültiger Voice-Channel!' });
            }

            // Remove from config
            recordChannelConfig.channels = recordChannelConfig.channels.filter(id => id !== channelId);
            saveRecordChannels();

            // Stop recording if active
            if (activeRecordings.has(channelId)) {
                const count = await stopRecordingForChannel(channelId);
                await interaction.editReply({ content: `Aufnahme in **${channel.name}** gestoppt!\n${count} Sprecher gespeichert.` });
            } else {
                await interaction.editReply({ content: `Keine aktive Aufnahme in **${channel.name}**.` });
            }
        }

        if (subcommand === 'status') {
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('Aufnahme-Status')
                .setDescription(recordChannelConfig.recordAll ? 'Modus: **Alle Channels**' : `Modus: **${recordChannelConfig.channels.length} Channels**`);

            if (activeRecordings.size > 0) {
                let desc = '';
                for (const [, session] of activeRecordings) {
                    const dur = Math.floor((Date.now() - session.startTime) / 1000);
                    const mins = Math.floor(dur / 60);
                    const secs = dur % 60;
                    const users = channelUsers.get(session.channelId)?.size || 0;
                    desc += `\n**${session.channelName}** - ${mins}m ${secs}s - ${users} User - \`${session.folderName}\``;
                }
                embed.addFields({ name: `Aktiv (${activeRecordings.size})`, value: desc, inline: false });
            } else {
                embed.addFields({ name: 'Aktiv', value: 'Keine Aufnahme', inline: false });
            }

            await interaction.editReply({ embeds: [embed] });
        }
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

// Voice state updates - auto join/leave
client.on('voiceStateUpdate', async (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    if (GUILD_ID && guild.id !== GUILD_ID) return;

    const userId = newState.id || oldState.id;
    if (userId === client.user.id) return;

    // User ermitteln für Logs
    let userTag = userId;
    try {
        const user = await client.users.fetch(userId);
        userTag = user.tag;
    } catch {}

    // User joined a channel
    if (newState.channelId && !oldState.channelId) {
        const channelId = newState.channelId;
        const channelName = newState.channel?.name || channelId;
        addLog('voice_join', userTag, `Beigetreten: #${channelName}`, { channelId });

        if (!shouldRecordChannel(channelId)) return;

        if (!channelUsers.has(channelId)) {
            channelUsers.set(channelId, new Set());
        }
        channelUsers.get(channelId).add(userId);

        // Falls Channel bereits aufgenommen wird, DM an den neuen User
        if (activeRecordings.has(channelId)) {
            sendRecordingDM(userId, guild, newState.channel?.name);
        }

        // Start recording if not already recording
        if (!activeRecordings.has(channelId)) {
            const channel = newState.channel;
            if (channel) {
                startRecordingForChannel(channel, guild, true).catch(e => console.error('[Voice] Auto-Start Error:', e));
            }
        }
    }

    // User left a channel
    if (oldState.channelId && !newState.channelId) {
        const channelId = oldState.channelId;
        const channelName = oldState.channel?.name || channelId;
        addLog('voice_leave', userTag, `Verlassen: #${channelName}`, { channelId });

        const users = channelUsers.get(channelId);
        if (users) {
            users.delete(userId);
        }

        // Check if channel is empty (no humans)
        const channel = guild.channels.cache.get(channelId);
        const humanCount = channel ? channel.members.filter(m => !m.user.bot).size : 0;
        
        if (humanCount === 0 && activeRecordings.has(channelId)) {
            console.log(`[Voice] Channel ${channel?.name || channelId} leer - stoppe in 10s...`);
            setTimeout(async () => {
                const ch = guild.channels.cache.get(channelId);
                const count = ch ? ch.members.filter(m => !m.user.bot).size : 0;
                if (count === 0 && activeRecordings.has(channelId)) {
                    await stopRecordingForChannel(channelId);
                    console.log(`[Voice] Aufnahme gestoppt (Channel leer)`);
                }
            }, 10000);
        }
    }

    // User switched channels
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        const oldName = oldState.channel?.name || oldState.channelId;
        const newName = newState.channel?.name || newState.channelId;
        addLog('voice_move', userTag, `Gewechselt: #${oldName} → #${newName}`, { oldChannel: oldState.channelId, newChannel: newState.channelId });

        // Handle leaving old channel
        const oldChannelUsers = channelUsers.get(oldState.channelId);
        if (oldChannelUsers) {
            oldChannelUsers.delete(userId);
        }

        const oldChannel = guild.channels.cache.get(oldState.channelId);
        const oldHumanCount = oldChannel ? oldChannel.members.filter(m => !m.user.bot).size : 0;
        if (oldHumanCount === 0 && activeRecordings.has(oldState.channelId)) {
            console.log(`[Voice] Channel ${oldChannel?.name || oldState.channelId} leer - stoppe in 10s...`);
            setTimeout(async () => {
                const ch = guild.channels.cache.get(oldState.channelId);
                const count = ch ? ch.members.filter(m => !m.user.bot).size : 0;
                if (count === 0 && activeRecordings.has(oldState.channelId)) {
                    await stopRecordingForChannel(oldState.channelId);
                    console.log(`[Voice] Aufnahme gestoppt (Channel leer)`);
                }
            }, 10000);
        }

        // Handle joining new channel
        if (shouldRecordChannel(newState.channelId)) {
            if (!channelUsers.has(newState.channelId)) {
                channelUsers.set(newState.channelId, new Set());
            }
            channelUsers.get(newState.channelId).add(userId);

            // Falls Channel bereits aufgenommen wird, DM an den neuen User
            if (activeRecordings.has(newState.channelId)) {
                sendRecordingDM(userId, guild, newState.channel?.name);
            }

            if (!activeRecordings.has(newState.channelId)) {
                const newChannel = newState.channel;
                if (newChannel) {
                    startRecordingForChannel(newChannel, guild, true).catch(e => console.error('[Voice] Auto-Start Error:', e));
                }
            }
        }
    }
});

// Helper: Decode Client ID from Token to sync commands immediately
function getClientIdFromToken(token) {
    return Buffer.from(token.split('.')[0], 'base64').toString('ascii');
}

async function registerCommands(clientId) {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const guildRoute = Routes.applicationGuildCommands(clientId, GUILD_ID);
    const globalRoute = Routes.applicationCommands(clientId);

    try {
        if (GUILD_ID) {
            await rest.put(guildRoute, { body: commands.map(c => c.toJSON()) });
            console.log('[Commands] Guild-Commands synchronisiert!');
            await rest.put(globalRoute, { body: [] });
            console.log('[Commands] Alte Global-Commands entfernt!');
        } else {
            await rest.put(globalRoute, { body: commands.map(c => c.toJSON()) });
            console.log('[Commands] Global-Commands synchronisiert!');
        }
    } catch (err) {
        console.error('[Fehler] Commands:', err.message);
    }
}

// Sync commands immediately
registerCommands(getClientIdFromToken(TOKEN));

client.once('clientReady', async () => {
    console.log(`Bot online: ${client.user.tag}`);
    console.log('═══════════════════════════════════════════════');
    console.log('  WICHTIG: Render Free schläft nach 15 Min ein.');
    console.log(`  Richte UptimeRobot ein: https://uptimerobot.com`);
    console.log(`  Monitor auf: ${PORTAL_URL}/health (5 Min Intervall)`);
    console.log('═══════════════════════════════════════════════');
    punishmentManager = new PunishmentManager(STRAFEN_FILE);
    await punishmentManager.load();
    const guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : client.guilds.cache.first();
    for (const p of punishmentManager.getActivePunishments()) {
        punishmentManager.scheduleRestore(p, guild);
    }

    // Resume recordings for configured channels (only where humans are)
    if (guild && (recordChannelConfig.channels.length > 0 || recordChannelConfig.recordAll)) {
        const voiceChannels = guild.channels.cache.filter(ch => ch.type === 2);
        for (const [, channel] of voiceChannels) {
            const humanCount = channel.members.filter(m => !m.user.bot).size;
            if (humanCount > 0 && shouldRecordChannel(channel.id)) {
                await startRecordingForChannel(channel, guild, true);
            }
        }
    }

    // Admin-DM nach Neustart (Login-Daten + Anleitung)
    await notifyAdminsOnRestart(guild);

    if (addLog) addLog('bot_restart', 'system', 'Bot neu gestartet');
});

addLog = startWebServer(client, activeRecordings, TALKS_DIR).addLog;

// === Discord Ereignis-Logging ===

// Nachrichten
client.on('messageDelete', (message) => {
    if (message.author?.bot) return;
    addLog('msg_delete', message.author?.tag || 'unknown', `Nachricht gelöscht in #${message.channel?.name || 'unbekannt'}: "${message.content?.slice(0, 100) || 'kein Inhalt'}"`);
});
client.on('messageUpdate', (oldMsg, newMsg) => {
    if (newMsg.author?.bot || !oldMsg.content || !newMsg.content) return;
    if (oldMsg.content === newMsg.content) return;
    addLog('msg_edit', newMsg.author?.tag || 'unknown', `Nachricht bearbeitet in #${newMsg.channel?.name || 'unbekannt'}`);
});

// Ban / Unban
client.on('guildBanAdd', (guild, user) => {
    if (GUILD_ID && guild.id !== GUILD_ID) return;
    addLog('ban', user.tag, `${user.tag} wurde gebannt`);
});
client.on('guildBanRemove', (guild, user) => {
    if (GUILD_ID && guild.id !== GUILD_ID) return;
    addLog('unban', user.tag, `${user.tag} wurde entbannt`);
});

// Member kickt / verlässt
client.on('guildMemberRemove', (member) => {
    if (GUILD_ID && member.guild?.id !== GUILD_ID) return;
    const auditLog = member.guild ? ' (möglicher Kick)' : '';
    addLog('member_remove', member.user?.tag || 'unknown', `${member.user?.tag || 'Unbekannt'} hat den Server verlassen${auditLog}`);
});

// Timeout / Rolle / Member-Update
client.on('guildMemberUpdate', (oldMember, newMember) => {
    if (GUILD_ID && newMember.guild?.id !== GUILD_ID) return;
    const tag = newMember.user?.tag || 'unknown';

    // Timeout gesetzt
    if (!oldMember.communicationDisabledUntil && newMember.communicationDisabledUntil) {
        const until = new Date(newMember.communicationDisabledUntil).toLocaleString('de-DE');
        addLog('timeout', 'system', `${tag} wurde bis ${until} stummgeschaltet`);
    }
    // Timeout entfernt
    if (oldMember.communicationDisabledUntil && !newMember.communicationDisabledUntil) {
        addLog('untimeout', 'system', `${tag} wurde entstummt`);
    }

    // Rollen geändert
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;
    const added = newRoles.filter(r => !oldRoles.has(r.id) && r.id !== newMember.guild?.id);
    const removed = oldRoles.filter(r => !newRoles.has(r.id) && r.id !== newMember.guild?.id);
    for (const [, role] of added) {
        addLog('role_add', 'system', `${tag} hat Rolle @${role.name} erhalten`);
    }
    for (const [, role] of removed) {
        addLog('role_remove', 'system', `${tag} hat Rolle @${role.name} verloren`);
    }
});

// Channel geändert
client.on('channelUpdate', (oldChannel, newChannel) => {
    if (!oldChannel.name || !newChannel.name) return;
    if (GUILD_ID && oldChannel.guild?.id !== GUILD_ID) return;
    if (oldChannel.name !== newChannel.name) {
        addLog('channel_rename', 'system', `Channel #${oldChannel.name} umbenannt in #${newChannel.name}`);
    }
    if (oldChannel.type !== newChannel.type) {
        addLog('channel_change', 'system', `Channel #${newChannel.name} (Typ geändert)`);
    }
});
client.on('channelCreate', (channel) => {
    if (GUILD_ID && channel.guild?.id !== GUILD_ID) return;
    addLog('channel_create', 'system', `Channel #${channel.name} erstellt (${channel.type === 2 ? 'Voice' : channel.type === 0 ? 'Text' : '?'})`);
});
client.on('channelDelete', (channel) => {
    if (GUILD_ID && channel.guild?.id !== GUILD_ID) return;
    addLog('channel_delete', 'system', `Channel #${channel.name} gelöscht`);
});

// Rolle erstellt / gelöscht
client.on('roleCreate', (role) => {
    if (GUILD_ID && role.guild?.id !== GUILD_ID) return;
    addLog('role_create', 'system', `Rolle @${role.name} erstellt`);
});
client.on('roleDelete', (role) => {
    if (GUILD_ID && role.guild?.id !== GUILD_ID) return;
    addLog('role_delete', 'system', `Rolle @${role.name} gelöscht`);
});

// Alle Slash-Commands loggen
client.on('interactionCreate', (interaction) => {
    if (!interaction.isCommand()) return;
    if (GUILD_ID && interaction.guild?.id !== GUILD_ID) return;
    addLog('command', interaction.user?.tag || 'unknown', `/${interaction.commandName} ausgeführt`);
});

// Absturz-Sicherheit: Unbehandelte Fehler abfangen
process.on('unhandledRejection', (reason, p) => {
    console.error('[CRASH] Unhandled Rejection at:', p, 'reason:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('[CRASH] Uncaught Exception:', err.message, err.stack);
});

// Discord-Event: Verbindungsabbrüche loggen
client.on('shardDisconnect', (event, shardId) => {
    console.log(`[Discord] Shard ${shardId} disconnected (code: ${event?.code}), reconnecting...`);
});
client.on('shardReconnecting', (shardId) => {
    console.log(`[Discord] Shard ${shardId} reconnecting...`);
});
client.on('shardResume', (shardId, replayed) => {
    console.log(`[Discord] Shard ${shardId} resumed (${replayed} events replayed)`);
});

// =====================================================================
// KEEP-ALIVE: Verhindert Render-Sleep
// =====================================================================
// WICHTIG: Render Free schläft nach 15 Min ohne externen Traffic ein.
// Die Self-Pings unten können helfen, aber sind nicht 100% zuverlässig.
// Für 24/7 Betrieb: https://uptimerobot.com → Monitor auf
//   https://repo-bestrafungssystem-abe9.onrender.com/health (5 Min)
// =====================================================================

const SELF_URL = `http://localhost:${PORT}`;

function ping(url, label, retries = 2) {
    const req = http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.log(`[Keep-Alive] ⚠ ${label} Status ${res.statusCode}`);
            }
        });
    });
    req.on('error', (e) => {
        console.log(`[Keep-Alive] ✗ ${label} Fehler: ${e.message}`);
        if (retries > 0) {
            setTimeout(() => ping(url, label, retries - 1), 5000);
        }
    });
    req.setTimeout(8000, () => { req.destroy(); ping(url, label + ' (retry)', retries - 1); });
}

// Lokal alle 30s
setInterval(() => ping(`${SELF_URL}/health`, 'Health'), 30 * 1000);

// Extern alle 60s (wirklich alle Endpunkte im Wechsel)
let extPingIdx = 0;
const extEndpoints = [
    `${PORTAL_URL}/`,
    `${PORTAL_URL}/health`,
    `${PORTAL_URL}/api/status`,
];
setInterval(() => {
    const ep = extEndpoints[extPingIdx % extEndpoints.length];
    ping(ep, 'External#' + (extPingIdx % extEndpoints.length));
    extPingIdx++;
}, 60 * 1000);

// Zusätzlich: Runden-Ping (alle 5 Min auf alle)
setInterval(() => {
    for (let i = 0; i < extEndpoints.length; i++) {
        ping(extEndpoints[i], `FullCycle#${i}`);
    }
}, 5 * 60 * 1000);

client.login(TOKEN).catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
});

module.exports = { client, activeRecordings, TALKS_DIR };