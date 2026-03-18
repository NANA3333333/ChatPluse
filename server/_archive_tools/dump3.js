const db = require('better-sqlite3')('../data/chatpulse_user_fuwbbtcqmm8osf5g.db');
const msgs = db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 40").all();
require('fs').writeFileSync('db_dump3.json', JSON.stringify(msgs, null, 2));
console.log('Dumped to db_dump3.json');
