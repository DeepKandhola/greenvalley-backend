// src/TasksAPI.js

// Ensure you have these packages installed:
// npm install multer date-fns
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { format } = require('date-fns');
const { scheduleNextOccurrence, cancelJobForTask } = require('./dynamicTaskScheduler');

const ensureDirExists = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const attachmentsDir = path.join(__dirname, '..', 'public', 'attachments', 'tasks');
ensureDirExists(attachmentsDir);

const taskAttachmentStorage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, attachmentsDir); },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `task-${req.params.taskId}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});
const taskAttachmentUpload = multer({ storage: taskAttachmentStorage, limits: { fileSize: 15 * 1024 * 1024 } }).single('attachment');

function registerTaskRoutes(app, db) {
    
    app.get('/api/tasks', (req, res) => {
        const selectQuery = `SELECT Id, Title, Description, DueDate, DueTime, Priority, Status, CreatedAt, _LastGenerated, AttachmentRequired, AssignedTo, TaggedMembers, SubmissionText, TextSubmissionRequired, RepeatConfig, OccurrenceCount, Attachments, GeneratorTaskId FROM Tasks ORDER BY CreatedAt DESC, DueDate ASC`;
        db.query(selectQuery, (err, results) => {
            if (err) return res.status(500).json({ message: 'Failed to fetch tasks', error: err.message });
            const mappedTasks = results.map((row) => ({
                id: row.Id, title: row.Title, description: row.Description, dueDate: row.DueDate ? format(new Date(row.DueDate), 'yyyy-MM-dd') : null, dueTime: row.DueTime ? String(row.DueTime).slice(0, 5) : "23:59", priority: row.Priority, status: row.Status || 'Not Started', createdAt: row.CreatedAt, _lastGenerated: row._LastGenerated, attachmentRequired: !!row.AttachmentRequired, textSubmissionRequired: !!row.TextSubmissionRequired, submissionText: row.SubmissionText || "", assignedTo: JSON.parse(row.AssignedTo || "[]"), taggedMembers: JSON.parse(row.TaggedMembers || "[]"), repeatConfig: JSON.parse(row.RepeatConfig || '{"type":"None"}'), occurrenceCount: row.OccurrenceCount || 0, attachments: JSON.parse(row.Attachments || "[]"), generatorTaskId: row.GeneratorTaskId
            }));
            res.status(200).json(mappedTasks);
        });
    });

    app.post('/api/tasks', (req, res) => {
        const t = req.body;
        const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const sql = `INSERT INTO Tasks (Id, Title, Description, DueDate, DueTime, Priority, Status, CreatedAt, AttachmentRequired, TextSubmissionRequired, SubmissionText, AssignedTo, TaggedMembers, RepeatConfig, OccurrenceCount, Attachments, GeneratorTaskId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [t.id, t.title || "Untitled Task", t.description || "", t.dueDate || null, t.dueTime || "23:59", t.priority || 'Medium', t.status || 'Not Started', createdAt, !!t.attachmentRequired, !!t.textSubmissionRequired, t.submissionText || "", JSON.stringify(t.assignedTo || []), JSON.stringify(t.taggedMembers || []), JSON.stringify(t.repeatConfig || { type: 'None' }), t.occurrenceCount || 0, JSON.stringify(t.attachments || []), null];

        db.query(sql, values, (err) => {
            if (err) return res.status(500).json({ message: 'Failed to add task', error: err.message });
            
            // --- START OF FIX ---
        
            // The scheduler needs an object with PascalCase properties matching the DB columns.
            // The incoming request body 't' has camelCase properties, so we map them.
            if (t.repeatConfig?.type === 'Custom') {
                const taskForScheduler = {
                    Id: t.id,
                    Title: t.title || "Untitled Task",
                    Description: t.description || "",
                    DueDate: t.dueDate,
                    DueTime: t.dueTime || "23:59",
                    Priority: t.priority || 'Medium',
                    AttachmentRequired: !!t.attachmentRequired,
                    TextSubmissionRequired: !!t.textSubmissionRequired,
                    // The scheduler's INSERT query expects these to be pre-stringified
                    AssignedTo: JSON.stringify(t.assignedTo || []),
                    TaggedMembers: JSON.stringify(t.taggedMembers || []),
                    RepeatConfig: t.repeatConfig,
                    OccurrenceCount: t.occurrenceCount || 0,
                    GeneratorTaskId: null // For the first task, GeneratorTaskId is null
                };
                scheduleNextOccurrence(taskForScheduler, db);
            }
        
            // --- END OF FIX ---
        
            // The API response object can remain camelCase for the frontend.
            const createdTask = {
                id: t.id,
                title: t.title,
                description: t.description,
                dueDate: t.dueDate,
                dueTime: t.dueTime,
                priority: t.priority,
                status: t.status,
                createdAt,
                attachmentRequired: !!t.attachmentRequired,
                textSubmissionRequired: !!t.textSubmissionRequired,
                submissionText: t.submissionText,
                assignedTo: t.assignedTo || [],
                taggedMembers: t.taggedMembers || [],
                repeatConfig: t.repeatConfig || { type: 'None' },
                occurrenceCount: t.occurrenceCount || 0,
                attachments: t.attachments || [],
                generatorTaskId: null
            };
        
            // Note: The original call to the scheduler has been removed from here.
            res.status(201).json({ message: '✅ Task added successfully', task: createdTask });
        });
    });

    app.put('/api/tasks/:id', (req, res) => {
        const { id } = req.params;
        const updates = req.body;
        const fieldMap = { title: 'Title', description: 'Description', dueDate: 'DueDate', dueTime: 'DueTime', priority: 'Priority', status: 'Status', attachmentRequired: 'AttachmentRequired', textSubmissionRequired: 'TextSubmissionRequired', submissionText: 'SubmissionText', assignedTo: 'AssignedTo', taggedMembers: 'TaggedMembers', repeatConfig: 'RepeatConfig', occurrenceCount: 'OccurrenceCount', attachments: 'Attachments' };
        const setClauses = [];
        const sqlValues = [];

        for (const key in updates) {
            if (updates.hasOwnProperty(key) && fieldMap[key]) {
                let value = updates[key];
                if (['assignedTo', 'taggedMembers', 'repeatConfig', 'attachments'].includes(key)) {
                    value = JSON.stringify(value || (key === 'attachments' ? [] : {}));
                }
                setClauses.push(`${fieldMap[key]} = ?`);
                sqlValues.push(value);
            }
        }
        if (setClauses.length === 0) return res.status(400).json({ message: 'No valid fields provided for update.' });
        sqlValues.push(id);
        const sql = `UPDATE Tasks SET ${setClauses.join(', ')} WHERE Id = ?`;

        db.query(sql, sqlValues, (err, result) => {
            if (err) return res.status(500).json({ message: 'Failed to update task', error: err.message });
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Task not found' });
            
            cancelJobForTask(id);
            const repeatConfig = updates.repeatConfig;
            if (repeatConfig?.type === 'Custom') {
                 db.query('SELECT * FROM Tasks WHERE Id = ?', [id], (fetchErr, rows) => {
                     if (!fetchErr && rows.length > 0) {
                         const fullTask = rows[0];
                         fullTask.RepeatConfig = JSON.parse(fullTask.RepeatConfig || '{}');
                         scheduleNextOccurrence(fullTask, db);
                     }
                 });
            }
            res.status(200).json({ message: 'Task updated successfully' });
        });
    });
    
    app.delete('/api/tasks/:id', (req, res) => {
        const { id } = req.params;
        cancelJobForTask(id);
        db.query('SELECT Attachments FROM Tasks WHERE Id = ?', [id], (err, rows) => {
            if (err) return res.status(500).json({ message: 'Error fetching task for deletion.' });
            if (rows.length > 0) {
                const attachments = JSON.parse(rows[0].Attachments || '[]');
                if (Array.isArray(attachments)) {
                    attachments.forEach(att => {
                        if (att.path) {
                            const filePath = path.join(__dirname, '..', att.path);
                            fs.unlink(filePath, (unlinkErr) => { if (unlinkErr && unlinkErr.code !== 'ENOENT') console.warn(`Could not delete attachment file ${filePath}:`, unlinkErr); });
                        }
                    });
                }
            }
            db.query('DELETE FROM Tasks WHERE Id = ?', [id], (deleteErr, result) => {
                if (deleteErr) return res.status(500).json({ message: 'Failed to delete task from database.' });
                if (result.affectedRows === 0) return res.status(404).json({ message: 'Task not found.' });
                res.status(200).json({ message: '🗑️ Task deleted successfully' });
            });
        });
    });

    app.delete('/api/tasks/series/:id', async (req, res) => {
        const { id: generatorId } = req.params;
        const connection = await db.promise().getConnection();
        try {
            await connection.beginTransaction();
            const [tasksToDelete] = await connection.query('SELECT Id, Attachments FROM Tasks WHERE Id = ? OR GeneratorTaskId = ?', [generatorId, generatorId]);
            if (tasksToDelete.length === 0) {
                await connection.rollback(); return res.status(404).json({ message: 'Task series not found.' });
            }
            for (const task of tasksToDelete) {
                cancelJobForTask(task.Id);
                const attachments = JSON.parse(task.Attachments || '[]');
                if (Array.isArray(attachments)) {
                    attachments.forEach(att => {
                        if (att.path) {
                            const filePath = path.join(__dirname, '..', att.path);
                            fs.unlink(filePath, (unlinkErr) => { if (unlinkErr && unlinkErr.code !== 'ENOENT') console.warn(`Could not delete attachment file ${filePath}:`, unlinkErr); });
                        }
                    });
                }
            }
            const taskIdsToDelete = tasksToDelete.map(t => t.Id);
            await connection.query('DELETE FROM Tasks WHERE Id IN (?)', [taskIdsToDelete]);
            await connection.commit();
            res.status(200).json({ message: '🗑️ Entire task series deleted successfully' });
        } catch (err) {
            await connection.rollback();
            return res.status(500).json({ message: 'Failed to delete task series.', error: err.message });
        } finally {
            connection.release();
        }
    });

    app.post('/api/tasks/:taskId/upload-attachment', (req, res) => {
        const { taskId } = req.params;
        db.query("SELECT Attachments FROM Tasks WHERE Id = ?", [taskId], (fetchErr, results) => {
            if (fetchErr) return res.status(500).json({ message: "Database error." });
            if (results.length === 0) return res.status(404).json({ message: "Task not found." });
            taskAttachmentUpload(req, res, function (uploadErr) {
                if (uploadErr) return res.status(400).json({ message: `File upload error: ${uploadErr.message}` });
                if (!req.file) return res.status(400).json({ message: "No file was uploaded." });
                const currentAttachments = JSON.parse(results[0].Attachments || '[]');
                const newAttachment = { name: req.file.originalname, path: `/public/attachments/tasks/${req.file.filename}` };
                currentAttachments.push(newAttachment);
                db.query("UPDATE Tasks SET Attachments = ? WHERE Id = ?", [JSON.stringify(currentAttachments), taskId], (updateErr) => {
                    if (updateErr) {
                        fs.unlink(req.file.path, () => {});
                        return res.status(500).json({ message: 'Failed to save attachment details to database.' });
                    }
                    res.status(200).json({ message: 'Attachment uploaded successfully!', updatedAttachments: currentAttachments });
                });
            });
        });
    });
}

module.exports = { registerTaskRoutes };