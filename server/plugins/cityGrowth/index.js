const initCityGrowthDb = require('./growthDb');
const schoolLogic = require('./schoolLogic');

module.exports = function initCityGrowthPlugin(app, context) {
    const { authMiddleware } = context;

    function ensureCityGrowthDb(db) {
        if (!db.cityGrowth) {
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
            db.cityGrowth = initCityGrowthDb(rawDb);
        }
        return db.cityGrowth;
    }

    app.get('/api/city-growth/courses', authMiddleware, (req, res) => {
        try {
            const growthDb = ensureCityGrowthDb(req.db);
            res.json({
                success: true,
                courses: growthDb.getSchoolCourses()
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/city-growth/courses', authMiddleware, (req, res) => {
        try {
            const growthDb = ensureCityGrowthDb(req.db);
            const payload = req.body || {};
            const id = String(payload.id || '').trim().toLowerCase().replace(/\s+/g, '_');
            const name = String(payload.name || '').trim();
            if (!id || !name) {
                return res.status(400).json({ success: false, error: '课程 id 和名称不能为空' });
            }
            growthDb.upsertSchoolCourse({
                id,
                name,
                emoji: String(payload.emoji || '📘').trim() || '📘',
                description: String(payload.description || '').trim(),
                category: String(payload.category || 'general').trim() || 'general',
                prompt_effect_basic: String(payload.prompt_effect_basic || '').trim(),
                prompt_effect_advanced: String(payload.prompt_effect_advanced || '').trim(),
                sort_order: Number(payload.sort_order || 0) || 0,
                is_enabled: Number(payload.is_enabled ?? 1) === 1 ? 1 : 0,
            });
            res.json({ success: true, course: growthDb.getSchoolCourse(id) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.patch('/api/city-growth/courses/:id/toggle', authMiddleware, (req, res) => {
        try {
            const growthDb = ensureCityGrowthDb(req.db);
            const course = growthDb.toggleSchoolCourse(req.params.id);
            if (!course) {
                return res.status(404).json({ success: false, error: '课程不存在' });
            }
            res.json({ success: true, course });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/city-growth/characters', authMiddleware, (req, res) => {
        try {
            const growthDb = ensureCityGrowthDb(req.db);
            const characters = req.db.getCharacters().map(char => ({
                id: char.id,
                name: char.name,
                avatar: char.avatar,
                school_progress: growthDb.getCharacterCourseProgress(char.id).map((row) => ({
                    ...row,
                    mastery: Number(row.mastery || 0),
                    tier: schoolLogic.getSchoolTier(row.mastery || 0),
                    last_studied_at: Number(row.last_studied_at || 0),
                })),
                school_summary: schoolLogic.buildCharacterSchoolSummary(growthDb, char.id)
            }));
            res.json({ success: true, characters });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
