const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { isUserDbDeleting } = require('../../db');

function normalizeDbTaskId(taskId) {
    const parsed = Number(taskId);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const userDbs = new Map();

function getSchedulerDb(userId) {
    if (isUserDbDeleting(userId)) {
        throw new Error(`Scheduler DB is being deleted: ${userId}`);
    }
    if (userDbs.has(userId)) return userDbs.get(userId);

    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, `chatpulse_user_${userId}.db`);
    const db = new Database(dbPath);

    db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            cron_expr TEXT NOT NULL,
            task_prompt TEXT,
            action_type TEXT NOT NULL,
            is_enabled INTEGER DEFAULT 1,
            batch_size INTEGER DEFAULT 80
        )
    `);

    const taskColumns = db.prepare("PRAGMA table_info(scheduled_tasks)").all();
    const hasBatchSize = taskColumns.some((col) => col.name === 'batch_size');
    if (!hasBatchSize) {
        db.exec("ALTER TABLE scheduled_tasks ADD COLUMN batch_size INTEGER DEFAULT 80");
    }

    const instance = {
        dbInstance: db,
        getTasks: (charId) => {
            if (charId) {
                const stmt = db.prepare("SELECT * FROM scheduled_tasks WHERE character_id = ?");
                return stmt.all(charId);
            }
            const stmt = db.prepare("SELECT * FROM scheduled_tasks");
            return stmt.all();
        },
        getActiveTasks: () => {
            const stmt = db.prepare("SELECT * FROM scheduled_tasks WHERE is_enabled = 1");
            return stmt.all();
        },
        addTask: (taskOrCharId, cronExpr, taskPrompt, actionType, isEnabled = 1, batchSize = 80) => {
            const task = typeof taskOrCharId === 'object'
                ? taskOrCharId
                : { character_id: taskOrCharId, cron_expr: cronExpr, task_prompt: taskPrompt, action_type: actionType, is_enabled: isEnabled, batch_size: batchSize };
            const stmt = db.prepare("INSERT INTO scheduled_tasks (character_id, cron_expr, task_prompt, action_type, is_enabled, batch_size) VALUES (?, ?, ?, ?, ?, ?)");
            const info = stmt.run(task.character_id, task.cron_expr, task.task_prompt, task.action_type, task.is_enabled === 1 ? 1 : 0, task.batch_size);
            return info.lastInsertRowid;
        },
        updateTask: (taskId, taskOrCharId, cronExpr, taskPrompt, actionType, isEnabled, batchSize = 80) => {
            const id = normalizeDbTaskId(taskId);
            if (!id) return false;
            const task = typeof taskOrCharId === 'object'
                ? taskOrCharId
                : { character_id: taskOrCharId, cron_expr: cronExpr, task_prompt: taskPrompt, action_type: actionType, is_enabled: isEnabled, batch_size: batchSize };
            const stmt = db.prepare("UPDATE scheduled_tasks SET character_id = ?, cron_expr = ?, task_prompt = ?, action_type = ?, is_enabled = ?, batch_size = ? WHERE id = ?");
            const info = stmt.run(task.character_id, task.cron_expr, task.task_prompt, task.action_type, task.is_enabled === 1 ? 1 : 0, task.batch_size, id);
            return (info.changes || 0) > 0;
        },
        deleteTask: (taskId) => {
            const id = normalizeDbTaskId(taskId);
            if (!id) return false;
            const stmt = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?");
            const info = stmt.run(id);
            return (info.changes || 0) > 0;
        },
        deleteTasksForCharacter: (charId) => {
            const stmt = db.prepare("DELETE FROM scheduled_tasks WHERE character_id = ?");
            stmt.run(charId);
            return true;
        }
    };

    userDbs.set(userId, instance);
    return instance;
}

function closeSchedulerDb(userId) {
    const key = String(userId);
    const instance = userDbs.get(key);
    if (!instance) return;
    try {
        instance.dbInstance.close();
    } catch (e) { }
    userDbs.delete(key);
}

module.exports = { getSchedulerDb, closeSchedulerDb };
