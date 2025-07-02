// src/dynamicTaskScheduler.js

// Ensure you have this package installed:
// npm install date-fns uuid
const { v4: uuidv4 } = require('uuid');
const { add, format, isFuture } = require('date-fns');

// In-memory store for our scheduled jobs. Key: taskId, Value: setTimeout_timer
const scheduledJobs = new Map();

// Helper to parse DB date/time into a JS Date object
function parseDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    try {
        // The 'Z' is crucial to prevent the local timezone from being applied.
        // We treat the stored time as the literal time.
        const dt = new Date(`${dateStr.split('T')[0]}T${timeStr}`);
        if (isNaN(dt.getTime())) return null;
        return dt;
    } catch (e) { return null; }
}

// Backend version of calculateNextDueDate. Calculates the due date of the *next* instance.
function calculateNextDueDateBackend(task) {
    if (!task || !task.RepeatConfig || task.RepeatConfig.type !== 'Custom') return null;
    const { interval, frequency, endCondition } = task.RepeatConfig;
    
    // Check end condition: After X occurrences
    if (endCondition?.type === 'After' && (task.OccurrenceCount || 0) >= (endCondition.value || Infinity)) {
        return null;
    }

    // The base for the NEXT task is the due date of the CURRENT task instance.
    const baseDate = parseDateTime(task.DueDate, task.DueTime);
    if (!baseDate) return null;

    let duration = {};
    const freqLower = (frequency || 'days').toLowerCase();
    duration[freqLower] = interval || 1;

    const nextDueDate = add(baseDate, duration);

    // Check end condition: On a Date
    if (endCondition?.type === 'OnDate' && endCondition.value) {
        const endDate = parseDateTime(endCondition.value, '23:59:59');
        if (endDate && nextDueDate > endDate) return null;
    }
    return nextDueDate;
}

/**
 * The core function. Schedules a single task to generate its next occurrence.
 * @param {object} task - The task object from the database.
 * @param {object} db - The database connection.
 */
function scheduleNextOccurrence(task, db) {
    // First, clear any existing timer for this task to prevent duplicates
    if (scheduledJobs.has(task.Id)) {
        clearTimeout(scheduledJobs.get(task.Id));
        scheduledJobs.delete(task.Id);
    }

    const triggerTime = parseDateTime(task.DueDate, task.DueTime);

    // Only schedule jobs that are in the future.
    if (!triggerTime || !isFuture(triggerTime)) {
        return;
    }

    const delay = triggerTime.getTime() - Date.now();
    
    // Safety check for extremely long delays that some JS environments dislike (max ~24.8 days)
    if (delay < 0 || delay > 2147483647) {
        return;
    }

    console.log(`   - Scheduling task "${task.Title}" (ID: ${task.Id}) to trigger in ${Math.round(delay/1000)} seconds.`);

    const timer = setTimeout(async () => {
        console.log(`\n🚀 TRIGGER: Generating next task for "${task.Title}" (ID: ${task.Id})`);

        const nextDueDate = calculateNextDueDateBackend(task);
        if (!nextDueDate) {
            console.log(`   - End condition met for "${task.Title}". Series concluded.`);
            scheduledJobs.delete(task.Id);
            return;
        }

        const newTaskId = uuidv4();
        const newOccurrenceCount = (task.OccurrenceCount || 0) + 1;
        const newDueDateStr = format(nextDueDate, 'yyyy-MM-dd');
        const newDueTimeStr = format(nextDueDate, 'HH:mm:ss');
        const connection = await db.promise().getConnection();
        
        try {
            await connection.beginTransaction();

            // 1. Create the new task instance (the next in the series)
            await connection.query(
                `INSERT INTO Tasks (Id, Title, Description, DueDate, DueTime, Priority, Status, CreatedAt, AttachmentRequired, TextSubmissionRequired, SubmissionText, AssignedTo, TaggedMembers, RepeatConfig, OccurrenceCount, Attachments, GeneratorTaskId) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [newTaskId, task.Title, task.Description, newDueDateStr, newDueTimeStr, task.Priority, 'Not Started', task.AttachmentRequired, task.TextSubmissionRequired, '', task.AssignedTo, task.TaggedMembers, JSON.stringify(task.RepeatConfig), newOccurrenceCount, '[]', task.GeneratorTaskId || task.Id]
            );

            // 2. Mark the task that just triggered as non-repeating. It's now just a historical record.
            await connection.query(`UPDATE Tasks SET RepeatConfig = JSON_SET(RepeatConfig, '$.type', 'None') WHERE Id = ?`, [task.Id]);

            await connection.commit();
            console.log(`   - ✅ SUCCESS: Created new task ${newTaskId}.`);
            
            // 3. IMPORTANT: Now we need to schedule the NEWLY created task.
            const [newlyCreatedTasks] = await connection.query('SELECT * FROM Tasks WHERE Id = ?', [newTaskId]);
            if (newlyCreatedTasks.length > 0) {
                 newlyCreatedTasks[0].RepeatConfig = JSON.parse(newlyCreatedTasks[0].RepeatConfig || '{}');
                 scheduleNextOccurrence(newlyCreatedTasks[0], db); // Recursive scheduling!
            }

        } catch (error) {
            await connection.rollback();
            console.error(`   - ❌ ROLLED BACK: DB error for task ID ${task.Id}:`, error.message);
        } finally {
            connection.release();
            scheduledJobs.delete(task.Id);
        }
    }, delay);

    scheduledJobs.set(task.Id, timer);
}

/**
 * Initializes the scheduler on server start.
 */
async function initializeDynamicScheduler(db) {
    console.log('--- Initializing Dynamic Task Scheduler ---');
    for (const timer of scheduledJobs.values()) clearTimeout(timer);
    scheduledJobs.clear();

    try {
        const [tasks] = await db.promise().query(`SELECT * FROM Tasks WHERE JSON_EXTRACT(RepeatConfig, '$.type') = 'Custom' AND DueDate >= CURDATE()`);
        console.log(`   - Found ${tasks.length} future repeating tasks to schedule.`);
        for (const task of tasks) {
            task.RepeatConfig = JSON.parse(task.RepeatConfig || '{}');
            scheduleNextOccurrence(task, db);
        }
    } catch (error) {
        console.error('❌ CRITICAL ERROR during scheduler initialization:', error.message);
    }
    console.log('--- Scheduler Initialized ---');
}

function cancelJobForTask(taskId) {
    if (scheduledJobs.has(taskId)) {
        console.log(`   - Cancelling scheduled job for task ID: ${taskId}`);
        clearTimeout(scheduledJobs.get(taskId));
        scheduledJobs.delete(taskId);
    }
}

module.exports = { initializeDynamicScheduler, scheduleNextOccurrence, cancelJobForTask };