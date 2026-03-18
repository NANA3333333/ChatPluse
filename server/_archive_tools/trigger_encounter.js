const { getUserDb } = require('./db');
const initCityDb = require('./plugins/city/cityDb');

// Mock context because runSocialEncounter expects it
const contextWrapper = { getUserDb, getMemory: require('./memory').getMemory };

// We need to trigger checkSocialCollisions manually
async function forceEncounter() {
    const db = getUserDb('fuwbbtcqmm8osf5g');
    db.city = initCityDb(db);

    // Move 3 characters to the 'park'
    const chars = db.getCharacters().slice(0, 3);
    for (const c of chars) {
        db.updateCharacter(c.id, { location: 'park', city_status: 'idle' });
    }

    // Now require city index and trigger collision
    const cityPlugin = require('./plugins/city/index');

    // We mock the interval logic to run it right now
    // Actually cityPlugin doesn't export checkSocialCollisions...
    // But we can trigger it via the engine action 'city_walk' maybe?

}
forceEncounter();
