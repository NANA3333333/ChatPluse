const initCityGrowthDb = require('./growthDb');
const schoolLogic = require('./schoolLogic');
const {
    isCityGrowthValidationError,
    normalizeCityGrowthCoursePayload
} = require('./inputGuards');

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
            const payload = normalizeCityGrowthCoursePayload(req.body || {});
            growthDb.upsertSchoolCourse(payload);
            res.json({ success: true, course: growthDb.getSchoolCourse(payload.id) });
        } catch (e) {
            res.status(isCityGrowthValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
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
            res.status(isCityGrowthValidationError(e) ? 400 : 500).json({ success: false, error: e.message });
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
