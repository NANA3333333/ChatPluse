const db = require('better-sqlite3')('../data/chatpulse_user_fuwbbtcqmm8osf5g.db');
const msgs = db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 15").all();
require('fs').writeFileSync('db_dump.json', JSON.stringify(msgs, null, 2));
console.log('Dumped to db_dump.json');
