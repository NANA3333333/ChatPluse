const Database = require('better-sqlite3');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const masterDb = new Database(path.join(dataDir, 'master.db'));

const nana = masterDb.prepare("SELECT id FROM users WHERE username = 'Nana'").get();
if (!nana) {
    console.log('Nana not found');
    process.exit(1);
}

const userDbPath = path.join(dataDir, `chatpulse_user_${nana.id}.db`);
const db = new Database(userDbPath);

console.log('=== All Available Schedule Dates ===');
const stats = db.prepare("SELECT plan_date, count(*) as count FROM city_schedules GROUP BY plan_date ORDER BY plan_date DESC").all();
stats.forEach(s => {
    console.log(`${s.plan_date}: ${s.count} schedules`);
});

const march11 = db.prepare("SELECT * FROM city_schedules WHERE plan_date = '2026-03-11'").all();
if (march11.length > 0) {
    const chars = db.prepare("SELECT id, name FROM characters").all();
    const charMap = Object.fromEntries(chars.map(c => [c.id, c.name]));
    console.log('\n=== Details for March 11 ===');
    march11.forEach(s => {
        const name = charMap[s.character_id] || s.character_id;
        console.log(`\nCharacter: ${name}`);
        const plan = JSON.parse(s.schedule_json);
        plan.forEach(p => {
            console.log(`  ${String(p.hour).padStart(2, '0')}:00 -> ${p.action} (${p.reason})`);
        });
    });
} else {
    console.log('\nNo specific schedules found for 2026-03-11.');
}
