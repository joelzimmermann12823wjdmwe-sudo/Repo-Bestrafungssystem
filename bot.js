require('dotenv').config();
const { Client, GatewayIntentBits, Collection, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { createWriteStream } = require('fs');
const { join } = require('path');
const { mkdir, writeFile, readFile } = require('fs/promises');
const http = require('http');

// --- SETUP ---
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = parseInt(process.env.PORT) || 8080;
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '.';
const TALKS_DIR = join(DATA_DIR, 'talks');
const STRAFEN_FILE = join(DATA_DIR, 'strafen.json');

// Config aus .env
const PUNISHMENT_ROLE_ID = process.env.PUNISHMENT_ROLE_ID;
const ADMIN_ROLE_IDS = process.env.ADMIN_ROLE_IDS ? process.env.ADMIN_ROLE_IDS.split(',') : [];

// Sicherstellen dass Verzeichnisse existieren
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TALKS_DIR)) fs.mkdirSync(TALKS_DIR, { recursive: true });

// --- STRAFEN MANAGER ---
class PunishmentManager {
    constructor(filePath) {
        this.filePath = filePath;
        this.punishments = [];
        this.load();
    }

    async load() {
        try {
            const data = await readFile(this.filePath, 'utf-8');
            this.punishments = JSON.parse(data);
            console.log(`[Strafen] ${this.punishments.length} Einträge geladen`);
        } catch (err) {
            console.log('[Strafen] Keine bestehenden Strafen gefunden');
            this.punishments = [];
        }
    }

    async save() {
        await writeFile(this.filePath, JSON.stringify(this.punishments, null, 2), 'utf-8');
    }

    async addPunishment(userId, username, durationMs, reason, moderatorId, oldRoles) {
        const punishment = {
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

        this.punishments.push(punishment);
        await this.save();

        // Timer zum Wiederherstellen
        setTimeout(() => this.restoreUser(punishment), durationMs);

        return punishment;
    }

    async restoreUser(punishment) {
        if (!punishment.active) return;

        punishment.active = false;
        await this.save();

        try {
            const guild = client.guilds.cache.first();
            if (!guild) return;

            const member = await guild.members.fetch(punishment.userId);
            if (!member) return;

            // Bestrafungsrolle entfernen
            if (PUNISHMENT_ROLE_ID) {
                await member.roles.remove(PUNISHMENT_ROLE_ID).catch(() => {});
            }

            // Alte Rollen wiederherstellen
            const rolesToAdd = punishment.oldRoles.filter(
                roleId => guild.roles.cache.has(roleId) && !ADMIN_ROLE_IDS.includes(roleId)
            );
            if (rolesToAdd.length > 0) {
                await member.roles.add(rolesToAdd);
            }

            console.log(`[Strafen] ${punishment.username} wurde wiederhergestellt`);
        } catch (err) {
            console.error(`[Fehler] Wiederherstellung fehlgeschlagen: ${punishment.username}`, err);
        }
    }

    getActivePunishments() {
        return this.punishments.filter(p => p.active);
    }

    getUserPunishment(userId) {
        return this.punishments.find(p => p.userId === userId && p.active);
    }
}

let punishmentManager;

// --- WAV WRITER ---
class WavWriter {
    constructor(filePath, sampleRate = 48000, channels = 1, bitsPerSample = 16) {
        this.filePath = filePath;
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.bitsPerSample = bitsPerSample;
        this.samples = [];
    }

    addSample(pcmData) {
        if (pcmData && pcmData.length > 0) {
            this.samples.push(pcmData);
        }
    }

    async save() {
        if (this.samples.length === 0) {
            console.log(`[Audio] Keine Daten für ${this.filePath}`);
            return;
        }

        const rawData = Buffer.concat(this.samples);
        const numChannels = this.channels;
        const byteRate = (this.sampleRate * numChannels * this.bitsPerSample) / 8;
        const blockAlign = (numChannels * this.bitsPerSample) / 8;

        const header = Buffer.alloc(44);

        header.write('RIFF', 0);
        header.writeUInt32LE(36 + rawData.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(this.sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(this.bitsPerSample, 34);
        header.write('data', 36);
        header.writeUInt32LE(rawData.length, 40);

        const ws = createWriteStream(this.filePath);
        ws.write(header);
        ws.write(rawData);
        ws.end();

        return new Promise((resolve, reject) => {
            ws.on('finish', () => {
                console.log(`[Audio] Gespeichert: ${this.filePath} (${rawData.length} bytes)`);
                resolve(this.filePath);
            });
            ws.on('error', reject);
        });
    }
}

// --- VOICE RECORDER ---
class VoiceRecorder {
    constructor(outputDir) {
        this.outputDir = outputDir;
        this.userRecorders = new Map();
        this.totalRecorder = null;
        this.startTime = Date.now();
        this.sampleRate = 48000;
        this.activeStreams = new Map();
    }

    async getUserRecorder(userId, username) {
        if (!this.userRecorders.has(userId)) {
            const safeName = username.replace(/[<>:"/\\|?*]+/g, '_').substring(0, 80);
            const filePath = join(this.outputDir, `USER_${safeName}.wav`);
            const writer = new WavWriter(filePath, this.sampleRate);
            this.userRecorders.set(userId, { writer, username });
            console.log(`[Audio] Neuer User: ${username} -> ${filePath}`);
        }
        return this.userRecorders.get(userId);
    }

    getTotalRecorder() {
        if (!this.totalRecorder) {
            const filePath = join(this.outputDir, 'GESAMT_TALK.wav');
            this.totalRecorder = new WavWriter(filePath, this.sampleRate);
        }
        return this.totalRecorder;
    }

    async saveAll() {
        console.log(`[Audio] Speichere ${this.userRecorders.size} User-Aufnahmen...`);

        const promises = [];
        for (const [userId, { writer }] of this.userRecorders) {
            promises.push(writer.save());
        }

        if (this.totalRecorder) {
            promises.push(this.totalRecorder.save());
        }

        await Promise.all(promises);
        console.log(`[Audio] Alle Dateien gespeichert!`);
    }

    stop() {
        for (const [userId, stream] of this.activeStreams) {
            stream.removeAllListeners();
        }
        this.userRecorders.clear();
        this.totalRecorder = null;
        this.activeStreams.clear();
    }
}

// --- STEREO TO MONO ---
function stereoToMono(stereoBuffer) {
    const monoLength = stereoBuffer.length / 2;
    const monoBuffer = Buffer.alloc(monoLength);

    for (let i = 0; i < stereoBuffer.length; i += 4) {
        monoBuffer[i / 2] = stereoBuffer[i];
        monoBuffer[i / 2 + 1] = stereoBuffer[i + 1];
    }

    return monoBuffer;
}

// --- ACTIVE RECORDINGS ---
const activeRecordings = new Map();

// --- COMMANDS ---
const talkStartCommand = new SlashCommandBuilder()
    .setName('talk_start')
    .setDescription('Startet die Voice-Aufnahme');

const talkStopCommand = new SlashCommandBuilder()
    .setName('talk_stop')
    .setDescription('Stoppt die Voice-Aufnahme');

const talkStatusCommand = new SlashCommandBuilder()
    .setName('talk_status')
    .setDescription('Zeigt den aktuellen Aufnahme-Status');

const bestrafungCommand = new SlashCommandBuilder()
    .setName('bestrafung')
    .setDescription('Bestraft einen User mit Rollenentzug')
    .addUserOption(option =>
        option.setName('user')
            .setDescription('Der zu bestrafende User')
            .setRequired(true)
    )
    .addIntegerOption(option =>
        option.setName('dauer')
            .setDescription('Dauer in Minuten')
            .setRequired(true)
            .setMinValue(1)
    )
    .addStringOption(option =>
        option.setName('grund')
            .setDescription('Grund für die Bestrafung')
            .setRequired(true)
    );

const strafenCommand = new SlashCommandBuilder()
    .setName('strafen')
    .setDescription('Zeigt alle aktiven Bestrafungen');

// --- CLIENT ---
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

// --- COMMAND HANDLER ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId } = interaction;

    // === TALK_START ===
    if (commandName === 'talk_start') {
        const member = interaction.member;

        if (!member.voice?.channelId) {
            return interaction.reply({ content: '❌ Du bist in keinem Voice-Channel!', ephemeral: true });
        }

        if (activeRecordings.has(guildId)) {
            return interaction.reply({ content: '❌ Es läuft bereits eine Aufnahme!', ephemeral: true });
        }

        await interaction.deferReply();

        const channel = member.voice.channel;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const outputDir = join(TALKS_DIR, timestamp);
        await mkdir(outputDir, { recursive: true });

        try {
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false,
            });

            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 10000);
                console.log(`[Voice] Connected to ${channel.name}`);
            } catch (err) {
                console.error('[Fehler] Connection timeout:', err);
                connection.destroy();
                return interaction.editReply('❌ Konnte nicht dem Channel beitreten!');
            }

            const recorder = new VoiceRecorder(outputDir);

            // Receiver direkt von der Connection
            const receiver = connection.receiver;

            // Speaking Events
            receiver.speaking.on('start', async (userId) => {
                console.log(`[Audio] User ${userId} beginnt zu sprechen`);

                try {
                    const member = await interaction.guild.members.fetch(userId);
                    const username = member?.user.username || `user_${userId}`;

                    const { writer } = await recorder.getUserRecorder(userId, username);

                    const stream = receiver.subscribe(userId);
                    if (stream) {
                        recorder.activeStreams.set(userId, stream);

                        stream.on('data', (data) => {
                            const monoData = stereoToMono(data);
                            writer.addSample(monoData);
                            const total = recorder.getTotalRecorder();
                            if (total) total.addSample(monoData);
                        });
                    }
                } catch (err) {
                    console.error(`[Fehler] User ${userId}:`, err);
                }
            });

            activeRecordings.set(guildId, {
                connection,
                recorder,
                startTime: Date.now()
            });

            await interaction.editReply(
                `🔴 Aufnahme in **${channel.name}** gestartet!\n` +
                `📁 Ordner: \`${timestamp}\``
            );
            console.log(`[System] Aufnahme gestartet: ${outputDir}`);

        } catch (error) {
            console.error('[Fehler] Aufnahme Start:', error);
            await interaction.editReply(`❌ Fehler: ${error.message}`);
        }
    }

    // === TALK_STOP ===
    if (commandName === 'talk_stop') {
        const session = activeRecordings.get(guildId);

        if (!session) {
            return interaction.reply({ content: '❌ Keine aktive Aufnahme!', ephemeral: true });
        }

        await interaction.deferReply();

        try {
            console.log(`[System] Stoppe Aufnahme...`);

            session.connection.destroy();
            await session.recorder.saveAll();
            session.recorder.stop();

            activeRecordings.delete(guildId);

            const userCount = session.recorder.userRecorders.size;
            await interaction.editReply(
                `✅ Aufnahme beendet!\n` +
                `📊 ${userCount} Sprecher aufgenommen.`
            );
            console.log(`[System] Aufnahme gestoppt. ${userCount} User.`);

        } catch (error) {
            console.error('[Fehler] Aufnahme Stop:', error);
            await interaction.editReply(`❌ Fehler beim Stoppen: ${error.message}`);
        }
    }

    // === TALK_STATUS ===
    if (commandName === 'talk_status') {
        const session = activeRecordings.get(guildId);

        if (session) {
            const duration = Math.floor((Date.now() - session.startTime) / 1000);
            const users = session.recorder.userRecorders.size;

            return interaction.reply(
                `🔴 Aufnahme läuft seit **${duration}s**\n` +
                `👥 ${users} User erkannt`
            );
        }

        return interaction.reply('⚪ Keine Aufnahme aktiv');
    }

    // === BESTRAFUNG ===
    if (commandName === 'bestrafung') {
        const targetUser = interaction.options.getUser('user');
        const durationMinutes = interaction.options.getInteger('dauer');
        const reason = interaction.options.getString('grund');

        // Admin Check
        const isAdmin = interaction.member.roles.cache.some(role =>
            ADMIN_ROLE_IDS.includes(role.id)
        );
        if (!isAdmin && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Keine Berechtigung!', ephemeral: true });
        }

        if (!PUNISHMENT_ROLE_ID) {
            return interaction.reply({ content: '❌ PUNISHMENT_ROLE_ID nicht konfiguriert!', ephemeral: true });
        }

        const targetMember = await interaction.guild.members.fetch(targetUser.id);

        // Check if already punished
        const existingPunishment = punishmentManager.getUserPunishment(targetUser.id);
        if (existingPunishment) {
            return interaction.reply({ content: '❌ User ist bereits bestraft!', ephemeral: true });
        }

        // Alte Rollen speichern (außer Admin Rollen)
        const oldRoles = targetMember.roles.cache
            .filter(role => role.id !== interaction.guildId && !ADMIN_ROLE_IDS.includes(role.id))
            .map(role => role.id);

        // Alle Rollen entfernen
        await targetMember.roles.set([]);

        // Bestrafungsrolle geben
        await targetMember.roles.add(PUNISHMENT_ROLE_ID);

        // Strafe speichern
        await punishmentManager.addPunishment(
            targetUser.id,
            targetUser.username,
            durationMinutes * 60 * 1000,
            reason,
            interaction.user.id,
            oldRoles
        );

        const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('🔨 Bestrafung')
            .addFields(
                { name: 'User', value: `<@${targetUser.id}>`, inline: true },
                { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Dauer', value: `${durationMinutes} Minuten`, inline: true },
                { name: 'Grund', value: reason, inline: false }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        console.log(`[Strafen] ${targetUser.username} für ${durationMinutes} Minuten bestraft: ${reason}`);
    }

    // === STRAFEN ===
    if (commandName === 'strafen') {
        const active = punishmentManager.getActivePunishments();

        if (active.length === 0) {
            return interaction.reply('⚪ Keine aktiven Bestrafungen');
        }

        const embed = new EmbedBuilder()
            .setColor(0xffaa00)
            .setTitle('📋 Aktive Bestrafungen')
            .setDescription(`${active.length} User(s) aktuell bestraft`);

        for (const p of active) {
            const remaining = Math.max(0, Math.floor((p.endTime - Date.now()) / 1000));
            const minutes = Math.floor(remaining / 60);
            const seconds = remaining % 60;

            embed.addFields({
                name: p.username,
                value: `Grund: ${p.reason}\nVerbleibend: ${minutes}m ${seconds}s`,
                inline: false
            });
        }

        await interaction.reply({ embeds: [embed] });
    }
});

// --- HEALTH CHECK SERVER ---
function startHealthServer() {
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'healthy',
                bot: client.user?.tag || 'offline',
                guilds: client.guilds.cache.size,
                recordings: activeRecordings.size,
                punishments: punishmentManager.getActivePunishments().length,
                uptime: process.uptime()
            }));
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    server.listen(PORT, WEB_HOST, () => {
        console.log(`[Web] Health-Check: http://${WEB_HOST}:${PORT}/health`);
    });
}

// --- STARTUP ---
client.once('ready', async () => {
    console.log(`=================================`);
    console.log(`Bot ist online: ${client.user.tag}`);
    console.log(`Guilds: ${client.guilds.cache.size}`);
    console.log(`=================================`);

    punishmentManager = new PunishmentManager(STRAFEN_FILE);

    // Commands registrieren
    const commands = [
        talkStartCommand,
        talkStopCommand,
        talkStatusCommand,
        bestrafungCommand,
        strafenCommand
    ];

    for (const guild of client.guilds.cache.values()) {
        try {
            await guild.commands.set(commands);
            console.log(`[Commands] Registriert in: ${guild.name}`);
        } catch (err) {
            console.error(`[Fehler] Commands in ${guild.name}:`, err);
        }
    }

    // Bestehende Strafen wieder einplanen
    for (const p of punishmentManager.getActivePunishments()) {
        const remaining = p.endTime - Date.now();
        if (remaining > 0) {
            setTimeout(() => punishmentManager.restoreUser(p), remaining);
        } else {
            p.active = false;
            await punishmentManager.save();
        }
    }
});

// Start
startHealthServer();
client.login(TOKEN).catch(err => {
    console.error('[FATAL] Login fehlgeschlagen:', err.message);
    process.exit(1);
});
