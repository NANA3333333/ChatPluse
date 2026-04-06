const MAX_GLOBAL_CONCURRENCY = Math.max(1, parseInt(process.env.CP_BG_GLOBAL_CONCURRENCY || '2', 10) || 2);
const TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_TASKS = Math.max(50, parseInt(process.env.CP_BG_HISTORY_LIMIT || '300', 10) || 300);

const keyQueues = new Map();
const activeDedupeKeys = new Set();
let globalActiveCount = 0;
let taskSequence = 0;
const recentTasks = [];

function cleanupRecentTasks() {
    const cutoff = Date.now() - TASK_RETENTION_MS;
    for (let i = recentTasks.length - 1; i >= 0; i -= 1) {
        const task = recentTasks[i];
        const lastTouchedAt = Number(task?.finishedAt || task?.startedAt || task?.queuedAt || 0);
        if (lastTouchedAt < cutoff) {
            recentTasks.splice(i, 1);
        }
    }
    if (recentTasks.length > MAX_RECENT_TASKS) {
        recentTasks.splice(0, recentTasks.length - MAX_RECENT_TASKS);
    }
}

function createTaskRecord(key) {
    cleanupRecentTasks();
    const record = {
        id: `bg-${Date.now()}-${taskSequence += 1}`,
        key: String(key || 'global'),
        status: 'queued',
        queuedAt: Date.now(),
        startedAt: 0,
        finishedAt: 0,
        error: ''
    };
    recentTasks.push(record);
    return record;
}

function getQueue(key) {
    const normalizedKey = String(key || 'global');
    if (!keyQueues.has(normalizedKey)) {
        keyQueues.set(normalizedKey, {
            running: false,
            items: []
        });
    }
    return keyQueues.get(normalizedKey);
}

function releaseDedupeKey(item) {
    if (item?.dedupeKey) activeDedupeKeys.delete(item.dedupeKey);
}

function pumpQueue(key) {
    const queue = getQueue(key);
    if (queue.running || globalActiveCount >= MAX_GLOBAL_CONCURRENCY) return;
    const nextItem = queue.items.shift();
    if (!nextItem) return;

    queue.running = true;
    globalActiveCount += 1;
    if (nextItem.record) {
        nextItem.record.status = 'running';
        nextItem.record.startedAt = Date.now();
    }

    Promise.resolve()
        .then(() => nextItem.task())
        .then(
            (result) => {
                if (nextItem.record) {
                    nextItem.record.status = 'completed';
                    nextItem.record.finishedAt = Date.now();
                }
                nextItem.resolve(result);
            },
            (error) => {
                if (nextItem.record) {
                    nextItem.record.status = 'failed';
                    nextItem.record.finishedAt = Date.now();
                    nextItem.record.error = String(error?.message || error || '').slice(0, 500);
                }
                nextItem.reject(error);
            }
        )
        .finally(() => {
            queue.running = false;
            globalActiveCount = Math.max(0, globalActiveCount - 1);
            releaseDedupeKey(nextItem);
            cleanupRecentTasks();
            if (queue.items.length === 0 && !queue.running) {
                keyQueues.delete(String(key || 'global'));
            }
            pumpAllQueues();
        });
}

function pumpAllQueues() {
    for (const key of [...keyQueues.keys()]) {
        if (globalActiveCount >= MAX_GLOBAL_CONCURRENCY) break;
        pumpQueue(key);
    }
}

function enqueueBackgroundTask({ key, dedupeKey, maxPending = 1, task }) {
    if (typeof task !== 'function') {
        return Promise.reject(new Error('enqueueBackgroundTask requires a task function'));
    }

    const normalizedKey = String(key || 'global');
    const normalizedDedupeKey = dedupeKey ? String(dedupeKey) : '';
    if (normalizedDedupeKey && activeDedupeKeys.has(normalizedDedupeKey)) {
        return Promise.resolve({ skipped: true, reason: 'duplicate' });
    }

    const queue = getQueue(normalizedKey);
    if (queue.items.length >= Math.max(0, Number(maxPending || 0))) {
        return Promise.resolve({ skipped: true, reason: 'queue_full' });
    }

    if (normalizedDedupeKey) activeDedupeKeys.add(normalizedDedupeKey);
    const record = createTaskRecord(normalizedKey);

    return new Promise((resolve, reject) => {
        queue.items.push({
            task,
            resolve,
            reject,
            dedupeKey: normalizedDedupeKey,
            record
        });
        pumpAllQueues();
    });
}

function getBackgroundQueueStats() {
    cleanupRecentTasks();
    const queues = [];
    for (const [key, queue] of keyQueues.entries()) {
        queues.push({
            key,
            running: !!queue.running,
            pending: Array.isArray(queue.items) ? queue.items.length : 0
        });
    }
    queues.sort((a, b) => {
        if (b.pending !== a.pending) return b.pending - a.pending;
        return a.key.localeCompare(b.key);
    });
    return {
        globalConcurrency: MAX_GLOBAL_CONCURRENCY,
        activeWorkers: globalActiveCount,
        activeDedupeKeys: activeDedupeKeys.size,
        queueCount: queues.length,
        pendingTasks: queues.reduce((sum, queue) => sum + queue.pending, 0),
        queues,
        recentTasks: [...recentTasks]
            .sort((a, b) => {
                const aTime = Number(a?.finishedAt || a?.startedAt || a?.queuedAt || 0);
                const bTime = Number(b?.finishedAt || b?.startedAt || b?.queuedAt || 0);
                return bTime - aTime;
            })
            .slice(0, MAX_RECENT_TASKS)
    };
}

module.exports = {
    enqueueBackgroundTask,
    getBackgroundQueueStats
};
