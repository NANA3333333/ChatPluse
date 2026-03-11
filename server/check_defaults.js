const Database = require('better-sqlite3');
const initCityDb = require('./plugins/city/cityDb');

try { require('fs').unlinkSync('./fresh_test.db'); } catch (e) { }

console.log("Creating fresh DB...");
const db = new Database('./fresh_test.db');
db.exec(`
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY);
`); // mock User DB base tables

console.log("Initializing City DB...");
const cityDb = initCityDb(db);

console.log("Configurations:");
console.log(cityDb.getConfig());

console.log("Items:");
console.log(cityDb.getItems().filter(i => i.stock !== undefined).length + " items have stock field");
