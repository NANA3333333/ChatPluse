const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = 'c:/Users/Administrator/.gemini/antigravity/scratch/no_Next/server/data';
const files = fs.readdirSync(dataDir).filter(f => f.startsWith('chatpulse_user_') && f.endsWith('.db'));

files.forEach(file => {
    const dbPath = path.join(dataDir, file);
    try {
        const db = new Database(dbPath);
        const hasLogsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='city_logs'").get();
        if (hasLogsTable) {
            console.log(`--- DB: ${file} ---`);
            const logs = db.prepare('SELECT * FROM city_logs ORDER BY timestamp DESC LIMIT 5').all();
            console.log('Recent Logs:', JSON.stringify(logs, null, 2));
            const config = db.prepare('SELECT * FROM city_config').all();
            console.log('Config:', JSON.stringify(config, null, 2));

            // Also check for character status
            const chars = db.prepare('SELECT id, name, location, city_status, wallet, calories FROM characters').all();
            console.log('Characters:', JSON.stringify(chars, null, 2));
        }
    } catch (e) {
        console.error(`Error processing ${file}: ${e.message}`);
    }
});
