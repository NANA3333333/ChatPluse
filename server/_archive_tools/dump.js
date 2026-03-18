const db = require('better-sqlite3')('../data/chatpulse_user_fuwbbtcqmm8osf5g.db');
const msgs = db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 10").all();
console.log(JSON.stringify(msgs, null, 2));
