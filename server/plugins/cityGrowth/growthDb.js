module.exports = function initCityGrowthDb(rawDb) {
    const db = rawDb?.prepare ? rawDb : (typeof rawDb?.getRawDb === 'function' ? rawDb.getRawDb() : rawDb);
    const builtInPromptEffects = {
        psychology: {
            basic: '在难受、烦躁或委屈时，更容易先找能让自己缓下来的做法。',
            advanced: '在难受、烦躁或委屈时，更会主动安抚自己、换环境、休息，先把情绪稳住。'
        },
        vocational: {
            basic: '工作时更有流程感和把握感，不容易因为一点压力就乱掉。',
            advanced: '做事更稳，工作时更敢接活，也更容易给人靠谱的感觉。'
        },
        social: {
            basic: '更会读空气，知道什么时候该靠近、什么时候该收一点。',
            advanced: '更会读空气，也更知道什么时候该接住场面。'
        },
        life_management: {
            basic: '更会照顾身体节奏和消费，不容易把自己搞得太糟。',
            advanced: '更会自然安排吃饭、休息和花钱，不容易把自己拖垮。'
        }
    };

    db.exec(`
        CREATE TABLE IF NOT EXISTS city_school_courses (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            emoji TEXT DEFAULT '📘',
            description TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            prompt_effect_basic TEXT DEFAULT '',
            prompt_effect_advanced TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            is_enabled INTEGER DEFAULT 1
        );
    `);
    try { db.exec("ALTER TABLE city_school_courses ADD COLUMN prompt_effect_basic TEXT DEFAULT '';"); } catch (e) { }
    try { db.exec("ALTER TABLE city_school_courses ADD COLUMN prompt_effect_advanced TEXT DEFAULT '';"); } catch (e) { }

    db.exec(`
        CREATE TABLE IF NOT EXISTS city_character_courses (
            character_id TEXT NOT NULL,
            course_id TEXT NOT NULL,
            mastery INTEGER DEFAULT 0,
            last_studied_at INTEGER DEFAULT 0,
            PRIMARY KEY (character_id, course_id),
            FOREIGN KEY (course_id) REFERENCES city_school_courses(id) ON DELETE CASCADE
        );
    `);

    const courseCount = db.prepare('SELECT COUNT(*) as c FROM city_school_courses').get().c;
    if (courseCount === 0) {
        const courses = [
            { id: 'psychology', name: '心理课', emoji: '🧠', category: 'emotion', description: '学习识别情绪、缓解压力和自我安抚。', sort: 1 },
            { id: 'vocational', name: '职业课', emoji: '🛠️', category: 'work', description: '学习工作流程、执行力和职业自信。', sort: 2 },
            { id: 'social', name: '社交课', emoji: '🗣️', category: 'social', description: '学习沟通分寸、读空气和关系经营。', sort: 3 },
            { id: 'life_management', name: '生活管理课', emoji: '🏡', category: 'life', description: '学习作息、消费、饮食和自我照顾。', sort: 4 }
        ];
        const stmt = db.prepare(`
            INSERT INTO city_school_courses (
                id,
                name,
                emoji,
                description,
                category,
                prompt_effect_basic,
                prompt_effect_advanced,
                sort_order,
                is_enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        for (const course of courses) {
            stmt.run(
                course.id,
                course.name,
                course.emoji,
                course.description,
                course.category,
                course.prompt_effect_basic || '',
                course.prompt_effect_advanced || '',
                course.sort
            );
        }
    }

    for (const [courseId, effect] of Object.entries(builtInPromptEffects)) {
        db.prepare(`
            UPDATE city_school_courses
            SET
                prompt_effect_basic = CASE
                    WHEN TRIM(COALESCE(prompt_effect_basic, '')) = '' THEN ?
                    ELSE prompt_effect_basic
                END,
                prompt_effect_advanced = CASE
                    WHEN TRIM(COALESCE(prompt_effect_advanced, '')) = '' THEN ?
                    ELSE prompt_effect_advanced
                END
            WHERE id = ?
        `).run(effect.basic, effect.advanced, courseId);
    }

    function getSchoolCourses() {
        return db.prepare('SELECT * FROM city_school_courses ORDER BY sort_order ASC, id ASC').all();
    }

    function getEnabledSchoolCourses() {
        return db.prepare('SELECT * FROM city_school_courses WHERE is_enabled = 1 ORDER BY sort_order ASC, id ASC').all();
    }

    function getSchoolCourse(id) {
        return db.prepare('SELECT * FROM city_school_courses WHERE id = ?').get(id);
    }

    function upsertSchoolCourse(data) {
        db.prepare(`
            INSERT OR REPLACE INTO city_school_courses
            (id, name, emoji, description, category, prompt_effect_basic, prompt_effect_advanced, sort_order, is_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            data.id,
            data.name,
            data.emoji || '📘',
            data.description || '',
            data.category || 'general',
            data.prompt_effect_basic || '',
            data.prompt_effect_advanced || '',
            data.sort_order ?? 0,
            data.is_enabled ?? 1
        );
    }

    function toggleSchoolCourse(id) {
        const row = getSchoolCourse(id);
        if (!row) return null;
        const next = Number(row.is_enabled || 0) === 1 ? 0 : 1;
        db.prepare(`
            UPDATE city_school_courses
            SET is_enabled = ?
            WHERE id = ?
        `).run(next, id);
        return getSchoolCourse(id);
    }

    function getCharacterCourseProgress(charId) {
        return db.prepare(`
            SELECT p.character_id, p.course_id, p.mastery, p.last_studied_at,
                   c.name, c.emoji, c.description, c.category, c.prompt_effect_basic, c.prompt_effect_advanced, c.sort_order, c.is_enabled
            FROM city_character_courses p
            JOIN city_school_courses c ON p.course_id = c.id
            WHERE p.character_id = ?
            ORDER BY c.sort_order ASC, c.id ASC
        `).all(charId);
    }

    function getCharacterCourseMap(charId) {
        return Object.fromEntries(
            getCharacterCourseProgress(charId).map(row => [row.course_id, row])
        );
    }

    function addCharacterCourseMastery(charId, courseId, delta = 0) {
        const gain = Math.max(0, Number(delta || 0));
        const now = Date.now();
        const existing = db.prepare(`
            SELECT * FROM city_character_courses WHERE character_id = ? AND course_id = ?
        `).get(charId, courseId);
        if (existing) {
            const nextMastery = Math.max(0, Math.min(100, Number(existing.mastery || 0) + gain));
            db.prepare(`
                UPDATE city_character_courses
                SET mastery = ?, last_studied_at = ?
                WHERE character_id = ? AND course_id = ?
            `).run(nextMastery, now, charId, courseId);
        } else {
            db.prepare(`
                INSERT INTO city_character_courses (character_id, course_id, mastery, last_studied_at)
                VALUES (?, ?, ?, ?)
            `).run(charId, courseId, Math.max(0, Math.min(100, gain)), now);
        }
        return db.prepare(`
            SELECT p.character_id, p.course_id, p.mastery, p.last_studied_at,
                   c.name, c.emoji, c.description, c.category, c.prompt_effect_basic, c.prompt_effect_advanced, c.sort_order, c.is_enabled
            FROM city_character_courses p
            JOIN city_school_courses c ON p.course_id = c.id
            WHERE p.character_id = ? AND p.course_id = ?
        `).get(charId, courseId);
    }

    return {
        getSchoolCourses,
        getEnabledSchoolCourses,
        getSchoolCourse,
        upsertSchoolCourse,
        toggleSchoolCourse,
        getCharacterCourseProgress,
        getCharacterCourseMap,
        addCharacterCourseMastery,
        db
    };
};
