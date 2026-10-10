const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, 'logs');
const logFile = path.join(logDir, 'bot.log');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

let pendingRotation = false;
let activeClient = null;

function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function writeToLog(level, message) {
    const entry = `[${getTimestamp()}] [${level}] ${typeof message === 'object' ? JSON.stringify(message) : message}\n`;
    try {
        fs.appendFileSync(logFile, entry, 'utf8');
    } catch (e) {}
}

// Intercept all native console methods
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
    originalLog(...args);
    writeToLog('INFO', args.join(' '));
};
console.warn = (...args) => {
    originalWarn(...args);
    writeToLog('WARN', args.join(' '));
};
console.error = (...args) => {
    originalError(...args);
    writeToLog('ERROR', args.join(' '));
};

function isBotInVoice() {
    if (!activeClient || !activeClient.player) return false;
    const queues = activeClient.player.nodes.cache;
    return queues.some(q => q.connection && (q.isPlaying() || q.tracks.size > 0));
}

function executeRotation(maxDays = 7) {
    if (isBotInVoice()) {
        console.log("⏳ Log rotation scheduled, but bot is active in voice. Deferring until disconnect...");
        pendingRotation = true;
        return;
    }

    try {
        if (fs.existsSync(logFile)) {
            const stat = fs.statSync(logFile);
            if (stat.size > 1024 * 50) { // Only rotate if > 50KB
                const archiveName = `bot-${new Date().toISOString().slice(0, 10)}-${Date.now()}.log`;
                fs.renameSync(logFile, path.join(logDir, archiveName));
                console.log(`📁 Archived active log to ${archiveName}`);
            }
        }

        // Clean up archives older than retention period
        const files = fs.readdirSync(logDir);
        const cutoffTime = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
        files.forEach(file => {
            if (file.startsWith('bot-') && file.endsWith('.log')) {
                const filePath = path.join(logDir, file);
                const fileStat = fs.statSync(filePath);
                if (fileStat.mtimeMs < cutoffTime) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Pruned old log archive: ${file}`);
                }
            }
        });
        pendingRotation = false;
    } catch (e) {
        console.error("Log Rotation Error:", e.message);
    }
}

function checkDeferredRotation() {
    if (pendingRotation && !isBotInVoice()) {
        console.log("🔊 Bot left voice channel. Executing deferred log rotation now...");
        executeRotation();
    }
}

module.exports = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    initLogger: (client) => {
        activeClient = client;
        // Schedule daily check (every 24 hours)
        setInterval(() => {
            let retention = 7;
            try {
                const cfgPath = path.join(__dirname, 'config.json');
                if (fs.existsSync(cfgPath)) {
                    const config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
                    if (config.logRetentionDays) retention = config.logRetentionDays;
                }
            } catch (e) {}
            executeRotation(retention);
        }, 1000 * 60 * 60 * 24);
    },
    checkDeferredRotation,
    getLogFile: () => logFile,
    getLogDir: () => logDir
};
