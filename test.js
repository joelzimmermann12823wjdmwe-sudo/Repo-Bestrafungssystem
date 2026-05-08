const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Opus = require('opusscript');

const DATA_DIR = path.join(__dirname, 'test-data');
const TALKS_DIR = path.join(DATA_DIR, 'talks');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TALKS_DIR)) fs.mkdirSync(TALKS_DIR, { recursive: true });

let passed = 0;
let failed = 0;

function test(name, fn) {
    try { fn(); console.log(`  PASS: ${name}`); passed++; }
    catch (err) { console.log(`  FAIL: ${name} -> ${err.message}`); failed++; }
}

async function asyncTest(name, fn) {
    try { await fn(); console.log(`  PASS: ${name}`); passed++; }
    catch (err) { console.log(`  FAIL: ${name} -> ${err.message}`); failed++; }
}

function buildWav(pcm) {
    const CHANNELS = 2;
    const SAMPLE_RATE = 48000;
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);
    hdr.writeUInt32LE(36 + pcm.length, 4);
    hdr.write('WAVE', 8);
    hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(CHANNELS, 22);
    hdr.writeUInt32LE(SAMPLE_RATE, 24);
    hdr.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
    hdr.writeUInt16LE(CHANNELS * 2, 32);
    hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36);
    hdr.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([hdr, pcm]);
}

function normalizeAudio(pcmBuffer) {
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

class MockOpusStream {
    constructor() { this.listeners = {}; this.destroyed = false; this._closed = false; }
    on(event, fn) { if (!this.listeners[event]) this.listeners[event] = []; this.listeners[event].push(fn); }
    push(val) {
        if (val === null) {
            this._closed = true;
            if (this.listeners['close']) this.listeners['close'].forEach(fn => fn());
        }
    }
    destroy() { this.destroyed = true; }
    emit(event, data) { if (this.listeners[event]) this.listeners[event].forEach(fn => fn(data)); }
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
        const wavPath = path.join(this.outputDir, `USER_${safeName}.wav`);
        const opusStream = receiver.subscribe(userId, { end: { behavior: 'manual' } });
        const opusPackets = [];
        opusStream.on('data', (packet) => {
            if (packet && packet.length > 0) {
                opusPackets.push(Buffer.from(packet));
            }
        });
        this.userRecordings.set(userId, { opusStream, opusPackets, wavPath, username });
    }
    async saveAll() {
        const promises = [];
        for (const [, data] of this.userRecordings) {
            data.opusStream.push(null);
            promises.push(this._waitForCloseAndDecode(data));
        }
        const results = await Promise.allSettled(promises);
        const success = results.filter(r => r.status === 'fulfilled' && r.value).length;
        this.userRecordings.clear();
        return success;
    }
    _waitForCloseAndDecode(data) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                data.opusStream.destroy();
                resolve(this._decodeAndSave(data));
            }, 100);
            data.opusStream.on('close', () => {
                clearTimeout(timeout);
                resolve(this._decodeAndSave(data));
            });
        });
    }
    _decodeAndSave(data) {
        return new Promise((resolve) => {
            if (data.opusPackets.length === 0) return resolve(false);
            try {
                const decoder = new Opus(this.SAMPLE_RATE, this.CHANNELS, Opus.Application.AUDIO);
                const pcmFrames = [];
                for (const packet of data.opusPackets) {
                    const decoded = decoder.decode(packet, this.FRAME_SIZE);
                    pcmFrames.push(Buffer.from(decoded));
                }
                decoder.delete();
                const pcmBuffer = Buffer.concat(pcmFrames);
                const normalized = normalizeAudio(pcmBuffer);
                const wav = buildWav(normalized);
                fs.writeFileSync(data.wavPath, wav);
                resolve(true);
            } catch {
                resolve(false);
            }
        });
    }
    getUserCount() { return this.userRecordings.size; }
}

(async () => {
    console.log('\n=== Audio Normalization Test ===\n');

    const SAMPLE_RATE = 48000;
    const CHANNELS = 2;
    const FRAME_SIZE = SAMPLE_RATE / 50;

    await asyncTest('Normalization amplifies very quiet audio to audible level', async () => {
        const SAMPLE_RATE = 48000;
        const CHANNELS = 2;
        const FRAME_SIZE = SAMPLE_RATE / 50;

        // Create synthetic quiet PCM data (sine wave at 440Hz, volume 0.01)
        const durationSec = 1;
        const totalSamples = SAMPLE_RATE * durationSec;
        const quietPcm = Buffer.alloc(totalSamples * CHANNELS * 2);
        for (let i = 0; i < totalSamples; i++) {
            const sample = Math.round(327 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE)); // ~1% volume (matched to old ffmpeg volume=0.01)
            quietPcm.writeInt16LE(sample, i * CHANNELS * 2);
            quietPcm.writeInt16LE(sample, i * CHANNELS * 2 + 2);
        }

        let quietMax = 0;
        for (let i = 0; i < quietPcm.length; i += 2) {
            const v = Math.abs(quietPcm.readInt16LE(i));
            if (v > quietMax) quietMax = v;
        }

        const encoder = new Opus(SAMPLE_RATE, CHANNELS, Opus.Application.AUDIO);
        const opusPackets = [];
        const frameBytes = FRAME_SIZE * CHANNELS * 2;
        for (let offset = 0; offset < quietPcm.length; offset += frameBytes) {
            const frame = quietPcm.slice(offset, offset + frameBytes);
            if (frame.length < frameBytes) break;
            opusPackets.push(encoder.encode(frame, FRAME_SIZE));
        }
        encoder.delete();

        const decoder = new Opus(SAMPLE_RATE, CHANNELS, Opus.Application.AUDIO);
        const pcmFrames = [];
        for (const packet of opusPackets) {
            const decoded = decoder.decode(packet, FRAME_SIZE);
            pcmFrames.push(Buffer.from(decoded));
        }
        decoder.delete();

        const pcmBuffer = Buffer.concat(pcmFrames);
        const normalized = normalizeAudio(pcmBuffer);

        let normMax = 0, normSum = 0;
        for (let i = 0; i < normalized.length; i += 2) {
            const v = Math.abs(normalized.readInt16LE(i));
            if (v > normMax) normMax = v;
            normSum += v;
        }
        const normAvg = normSum / (normalized.length / 2);

        assert.ok(normMax > quietMax * 50, 'Normalized max should be much higher than original');
        assert.ok(normMax > 25000, 'Normalized max should be near target');
        assert.ok(normAvg > 5000, 'Normalized avg should be clearly audible');
    });

    console.log('\n=== VoiceRecorder Tests ===\n');

    test('VoiceRecorder starts recording', () => {
        const recorder = new VoiceRecorder(TALKS_DIR);
        const mockStream = new MockOpusStream();
        const mockReceiver = { subscribe: () => mockStream };
        recorder.startUserStream(mockReceiver, '123', 'testUser');
        assert.strictEqual(recorder.userRecordings.size, 1);
        assert.strictEqual(recorder.getUserCount(), 1);
    });

    test('VoiceRecorder deduplicates subscriptions', () => {
        const recorder = new VoiceRecorder(TALKS_DIR);
        const mockStream = new MockOpusStream();
        const mockReceiver = { subscribe: () => mockStream };
        recorder.startUserStream(mockReceiver, '123', 'testUser');
        recorder.startUserStream(mockReceiver, '123', 'testUser');
        assert.strictEqual(recorder.userRecordings.size, 1);
    });

    test('VoiceRecorder collects Opus packets', () => {
        const recorder = new VoiceRecorder(TALKS_DIR);
        const mockStream = new MockOpusStream();
        const mockReceiver = { subscribe: () => mockStream };
        recorder.startUserStream(mockReceiver, '456', 'alice');
        mockStream.emit('data', Buffer.from([0x01, 0x02, 0x03]));
        mockStream.emit('data', Buffer.from([0x04, 0x05]));
        const data = recorder.userRecordings.get('456');
        assert.strictEqual(data.opusPackets.length, 2);
    });

    console.log('\n=== Full Pipeline: Quiet Opus -> Decode -> Normalize -> WAV ===\n');

    await asyncTest('Full pipeline: quiet audio normalized to audible level', async () => {
        const SAMPLE_RATE = 48000;
        const CHANNELS = 2;
        const FRAME_SIZE = SAMPLE_RATE / 50;

        const encoder = new Opus(SAMPLE_RATE, CHANNELS, Opus.Application.AUDIO);
        const durationSec = 1;
        const totalSamples = SAMPLE_RATE * durationSec;
        const quietPcm = Buffer.alloc(totalSamples * CHANNELS * 2);
        for (let i = 0; i < totalSamples; i++) {
            const sample = Math.round(327 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE)); // ~1% volume
            quietPcm.writeInt16LE(sample, i * CHANNELS * 2);
            quietPcm.writeInt16LE(sample, i * CHANNELS * 2 + 2);
        }

        const frameBytes = FRAME_SIZE * CHANNELS * 2;
        const opusPackets = [];
        for (let offset = 0; offset < quietPcm.length; offset += frameBytes) {
            const frame = quietPcm.slice(offset, offset + frameBytes);
            if (frame.length < frameBytes) break;
            opusPackets.push(encoder.encode(frame, FRAME_SIZE));
        }
        encoder.delete();

        const recorder = new VoiceRecorder(TALKS_DIR);
        const mockStream = new MockOpusStream();
        const mockReceiver = { subscribe: () => mockStream };
        recorder.startUserStream(mockReceiver, '789', 'bob');

        for (const pkt of opusPackets) {
            mockStream.emit('data', pkt);
        }

        const count = await recorder.saveAll();
        assert.strictEqual(count, 1);

        const wavPath = path.join(TALKS_DIR, 'USER_bob.wav');
        assert.ok(fs.existsSync(wavPath), 'WAV file should exist');

        const wavFile = fs.readFileSync(wavPath);
        const audio = wavFile.slice(44);
        let max = 0, sum = 0;
        for (let i = 0; i < audio.length; i += 2) {
            const v = Math.abs(audio.readInt16LE(i));
            if (v > max) max = v;
            sum += v;
        }
        const avg = sum / (audio.length / 2);
        assert.ok(max > 25000, 'Normalized audio should have high max');
        assert.ok(avg > 5000, 'Normalized audio should be clearly audible');
    });

    console.log('\n=== Server API Tests ===\n');

    await asyncTest('Login page exists', async () => {
        assert.ok(fs.existsSync(path.join(__dirname, 'public', 'login.html')));
    });

    await asyncTest('Main page exists', async () => {
        assert.ok(fs.existsSync(path.join(__dirname, 'public', 'index.html')));
    });

    console.log('\n=== File Structure Tests ===\n');

    const files = [
        ['package.json'], ['src', 'bot.js'], ['src', 'server.js'],
        ['public', 'index.html'], ['public', 'login.html'],
        ['public', 'css', 'style.css'], ['public', 'js', 'app.js'],
        ['.env.example'], ['render.yaml']
    ];
    for (const f of files) {
        test(`${f.join('/')} exists`, () => {
            assert.ok(fs.existsSync(path.join(__dirname, ...f)));
        });
    }

    console.log('\n=== Module Load Tests ===\n');

    test('discord.js loads', () => { const { Client } = require('discord.js'); assert.strictEqual(typeof Client, 'function'); });
    test('@discordjs/voice loads', () => { const { joinVoiceChannel } = require('@discordjs/voice'); assert.strictEqual(typeof joinVoiceChannel, 'function'); });
    test('opusscript loads', () => { const o = require('opusscript'); assert.strictEqual(typeof o, 'function'); });
    test('express loads', () => { const e = require('express'); assert.strictEqual(typeof e, 'function'); });
    test('cookie-parser loads', () => { const c = require('cookie-parser'); assert.strictEqual(typeof c, 'function'); });

    console.log('\n=== Cleanup ===\n');

    fs.rmSync(DATA_DIR, { recursive: true, force: true });

    console.log('\n=================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('=================================\n');

    if (failed > 0) process.exit(1);
})();
