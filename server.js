const express = require('express');
const cors = require('cors');
const db = require('./dbconfig'); // Your MySQL pool export
const cron = require('node-cron');

const app = express();
const PORT = 5000;

// ==== Middleware ====
app.use(cors());
app.use(express.json());

// SQL Table Definition (for reference)
// CREATE TABLE Tasks (
//   Id VARCHAR(100) PRIMARY KEY,
//   Title VARCHAR(255) NOT NULL,
//   Description TEXT,
//   DueDate DATE,
//   DueTime TIME DEFAULT '23:59:00',
//   Priority ENUM('Low', 'Medium', 'High') DEFAULT 'Medium',
//   `Repeat` ENUM('None', 'Daily', 'Weekly', 'Monthly', 'Yearly') DEFAULT 'None', // Note backticks for Repeat
//   Status ENUM('Pending', 'In Progress', 'Completed', 'Overdue') DEFAULT 'Pending',
//   CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
//   _LastGenerated DATETIME DEFAULT NULL,
//   AttachmentRequired BOOLEAN DEFAULT FALSE,
//   AssignedTo JSON,
//   TaggedMembers JSON
// );
// Other tables ...

cron.schedule("*/1 * * * *", () => { // Run every 1 minute for quicker testing
  const now = new Date(); 
  const currentYear = now.getFullYear();
  const currentMonth = ('0' + (now.getMonth() + 1)).slice(-2);
  const currentDay = ('0' + (now.getDate())).slice(-2);
  const currentHour = ('0' + (now.getHours())).slice(-2);
  const currentMinute = ('0' + (now.getMinutes())).slice(-2);
  const currentLocalDTString = `${currentYear}-${currentMonth}-${currentDay}T${currentHour}:${currentMinute}`;

  // Ensure you are using the correct column name for 'Repeat' if it's a reserved keyword
  // For example, if your column is named `Repeat_` or `TaskRepeat`
  const sql = `
    UPDATE Tasks
    SET Status = 'Overdue'
    WHERE Status != 'Completed'
      AND Status != 'Overdue'
      AND DueDate IS NOT NULL 
      AND CONCAT(DueDate, 'T', IFNULL(TIME_FORMAT(DueTime, '%H:%i'), '23:59')) < ?
  `;

  db.query(sql, [currentLocalDTString], (err, result) => {
    if (err) {
      console.error("⛔ CRON: Failed to update overdue tasks", err.message);
      console.error("CRON DEBUG: Compared against currentLocalDTString =", currentLocalDTString);
    } else {
      if (result.affectedRows > 0) {
        console.log(`🔁 CRON: Marked ${result.affectedRows} tasks as Overdue. Compared against ${currentLocalDTString}`);
      } else {
        // console.log(`🔁 CRON: No new tasks to mark Overdue. Compared against ${currentLocalDTString}`);
      }
    }
  });
});

// ==== DB Connection Test ====
db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to MySQL Database');
    connection.release();
  }
});

// =====================
// DIARY ENTRIES API (Keep as is from your previous full file if working)
// ...
// =====================
app.get('/api/diary', (req, res) => {
  const sql = `SELECT * FROM DiaryEntries ORDER BY EntryDate DESC`;
  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ Error fetching diary entries:", err.message);
      return res.status(500).json({ message: "Failed to fetch entries", error: err.message });
    }
    const mapped = results.map(entry => ({
        id: entry.Id,
        title: entry.Title,
        type: entry.Type,
        description: entry.Description,
        entryDate: entry.EntryDate,
        createdAt: entry.CreatedAt
      }));
    res.status(200).json(mapped);
  });
});
app.post('/api/diary', (req, res) => {
  const { id, title, type, description, entryDate } = req.body;
  if (!id || !title || !entryDate || !description) return res.status(400).json({ message: "Missing required fields" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return res.status(400).json({ message: "Invalid entryDate format. Use YYYY-MM-DD." });
  const sql = `INSERT INTO DiaryEntries (Id, Title, Type, Description, EntryDate) VALUES (?, ?, ?, ?, ?)`;
  const params = [id, title, type || "Other", description, entryDate];
  db.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ message: "Failed to add entry", error: err.message });
    res.status(201).json({ message: "✅ Entry added successfully", id });
  });
});
app.put('/api/diary/:id', (req, res) => {
  const id = req.params.id;
  const { title, type, description, entryDate } = req.body;
  if (!title || !entryDate || !description) return res.status(400).json({ message: "Missing required fields" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return res.status(400).json({ message: "Invalid entryDate format." });
  const sql = `UPDATE DiaryEntries SET Title = ?, Type = ?, Description = ?, EntryDate = ? WHERE Id = ?`;
  const params = [title, type || "Other", description, entryDate, id];
  db.query(sql, params, (err, result) => {
    if (err) return res.status(500).json({ message: "Update failed", error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: "Entry not found" });
    res.status(200).json({ message: "✅ Entry updated successfully" });
  });
});
app.delete('/api/diary/:id', (req, res) => {
  const id = req.params.id;
  db.query('DELETE FROM DiaryEntries WHERE Id = ?', [id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Delete failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Entry not found' });
    res.status(200).json({ message: '✅ Entry deleted successfully' });
  });
});


// ===== GET All Tasks =====
app.get('/api/tasks', (req, res) => {
  const selectQuery = `
    SELECT 
      Id, Title, Description, DueDate, DueTime, Priority, \`Repeat\`, Status, 
      CreatedAt, _LastGenerated, AttachmentRequired, AssignedTo, TaggedMembers 
    FROM Tasks 
    ORDER BY DueDate ASC, DueTime ASC
  `;

  db.query(selectQuery, (err, results) => {
    if (err) {
      console.error('❌ Fetch error on /api/tasks:', err.message);
      return res.status(500).json({ message: 'Failed to fetch tasks', error: err.message });
    }

    // console.log("\n------- RAW TASKS FROM DB (GET /api/tasks) -------");
    // results.forEach(row => {
    //   console.log(`DB Row: ID=${row.Id}, Raw DueDate Type=${typeof row.DueDate}, DueDate Val=${row.DueDate}, DueTime=${row.DueTime}, Status=${row.Status}, Repeat=${row['Repeat']}`);
    // });
    // console.log("--------------------------------------------------");

    const mapped = results.map((row) => {
      let finalDueDateString = null; // Default to null

      if (row.DueDate) { // Check if DueDate is not null or undefined
        let dateObj;
        if (row.DueDate instanceof Date) { // If it's already a Date object
          dateObj = row.DueDate;
        } else if (typeof row.DueDate === 'string') { // If it's a string, try to parse it
                                                      // This handles cases where dateStrings:true might be set
                                                      // or if it's somehow already a parsable string.
            if (row.DueDate === "0000-00-00") {
                dateObj = null;
            } else {
                dateObj = new Date(row.DueDate); // Attempt to parse the string
            }
        }
        // else: row.DueDate is some other type or still null/undefined, will remain null

        if (dateObj && !isNaN(dateObj.getTime())) { // If we have a valid Date object
          const year = dateObj.getFullYear();
          const month = ('0' + (dateObj.getMonth() + 1)).slice(-2); // JS months are 0-indexed
          const day = ('0' + (dateObj.getDate())).slice(-2);
          finalDueDateString = `${year}-${month}-${day}`;
        } else if (row.DueDate !== "0000-00-00" && row.DueDate) { // If parsing failed but it wasn't "0000-00-00"
            console.warn(`[SERVER GET /api/tasks] Could not parse DueDate '${row.DueDate}' for task ID ${row.Id}. Sending null for dueDate.`);
        }
      }
      // If row.DueDate was null, "0000-00-00", or unparsable, finalDueDateString remains null.


      let displayDueTime = row.DueTime ? String(row.DueTime).slice(0, 5) : "23:59"; // HH:MM

      const taskForClient = {
        id: row.Id,
        title: row.Title,
        description: row.Description,
        dueDate: finalDueDateString, // ***** THIS IS THE KEY FIX *****
        dueTime: displayDueTime,
        priority: row.Priority,
        repeat: row['Repeat'],
        status: row.Status,
        createdAt: row.CreatedAt, // Consider formatting this to ISO string too if not already
        _lastGenerated: row._LastGenerated, // Same for this
        attachmentRequired: !!row.AttachmentRequired,
        assignedTo: JSON.parse(row.AssignedTo || "[]"),
        taggedMembers: JSON.parse(row.TaggedMembers || "[]")
      };
      return taskForClient;
    });

    console.log("\n------- MAPPED TASKS SENT TO CLIENT (GET /api/tasks) (Corrected) -------");
    mapped.forEach(task => {
        console.log(`Client Task: ID=${task.id}, dueDate=${task.dueDate}, dueTime=${task.dueTime}, Status=${task.status}, Repeat=${task.repeat}`);
    });
    console.log("-----------------------------------------------------------------------");

    res.status(200).json(mapped);
  });
});

// ===== POST New Task =====
app.post('/api/tasks', (req, res) => {
  const t = req.body;

  let finalDueDate = t.dueDate || null;
  if (finalDueDate === "" || finalDueDate === "0000-00-00") finalDueDate = null;
  if (finalDueDate && !/^\d{4}-\d{2}-\d{2}$/.test(finalDueDate)) {
     return res.status(400).json({ message: "Invalid dueDate format. Use YYYY-MM-DD or null."});
  }

  let finalDueTime = t.dueTime || '23:59:00';
  if (finalDueTime.match(/^\d{2}:\d{2}$/)) {
    finalDueTime += ':00';
  } else if (!finalDueTime.match(/^\d{2}:\d{2}:\d{2}$/)) {
    return res.status(400).json({ message: "Invalid dueTime format. Use HH:MM or HH:MM:SS."});
  }

  const createdAt = t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lastGenerated = t._lastGenerated ? new Date(t._lastGenerated).toISOString().slice(0, 19).replace('T', ' ') : null;

  console.log(`POST /api/tasks - Received for ID ${t.id}: dueDate=${finalDueDate}, dueTime=${finalDueTime}, repeat=${t.repeat || 'None'}`);

  const sql = `
    INSERT INTO Tasks (
      Id, Title, Description, DueDate, DueTime,
      Priority, \`Repeat\`, Status, CreatedAt, _LastGenerated,
      AttachmentRequired, AssignedTo, TaggedMembers
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const values = [
    t.id, t.title || "Untitled Task", t.description || "", finalDueDate, finalDueTime,
    t.priority || 'Medium', t.repeat || 'None', t.status || 'Pending',
    createdAt, lastGenerated,
    !!t.attachmentRequired,
    JSON.stringify(t.assignedTo || []),
    JSON.stringify(t.taggedMembers || [])
  ];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ Insert error on /api/tasks:', err.message, "Values:", values);
      return res.status(500).json({ message: 'Failed to add task', error: err.message });
    }
    const createdTask = {
      id: t.id, title: values[1], description: values[2], dueDate: finalDueDate, dueTime: finalDueTime.slice(0,5),
      priority: values[5], repeat: values[6], status: values[7], createdAt: values[8], _lastGenerated: values[9],
      attachmentRequired: values[10], assignedTo: t.assignedTo || [], taggedMembers: t.taggedMembers || []
    };
    console.log(`POST /api/tasks - Successfully added task ID ${t.id}`);
    res.status(201).json({ message: '✅ Task added successfully', task: createdTask });
  });
});

// ===== PUT (Update) Task =====
app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const t = req.body;

  console.log(`\n--- PUT /api/tasks/${id} ---`);
  console.log("Received raw body from client:", JSON.stringify(t, null, 2));

  let newDueDate = undefined; // Undefined means don't update it
  let newDueTime = undefined; // Undefined means don't update it

  if (t.hasOwnProperty('dueDate')) {
    if (t.dueDate === null || t.dueDate === "" || t.dueDate === "0000-00-00") {
      newDueDate = null;
      console.log(`DueDate will be set to NULL in DB.`);
    } else if (typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)) {
      newDueDate = t.dueDate;
      console.log(`DueDate will be set to '${newDueDate}' in DB.`);
    } else {
      console.error(`Invalid 'dueDate' format received: '${t.dueDate}'. DueDate will NOT be updated. Send YYYY-MM-DD or null.`);
      // NOT returning error, just skipping update of this field for now to see if other fields update
    }
  } else {
    console.log("'dueDate' field not present in request body. DueDate will not be changed in DB.");
  }

  // Simplified: Only try to update DueDate for now to isolate the problem
  // We will build a more complete SET clause later
  let sqlSetParts = [];
  let sqlValues = [];

  if (newDueDate !== undefined) { // Only add to SQL if it was processed
    sqlSetParts.push("DueDate = ?");
    sqlValues.push(newDueDate);
  }

  // --- TEMPORARILY ADD A DUMMY UPDATE TO CHECK IF ANY UPDATE WORKS ---
  // This helps confirm if the basic UPDATE mechanism is working at all.
  const dummyTitleSuffix = ` (Updated: ${new Date().toLocaleTimeString()})`;
  if (t.title) { // Assuming title is always sent or exists
      sqlSetParts.push("Title = CONCAT(IFNULL(Title, ''), ?)"); // Append to existing title
      sqlValues.push(dummyTitleSuffix);
      console.log(`Will attempt to update Title by appending: '${dummyTitleSuffix}'`);
  } else if (!t.title && sqlSetParts.length === 0) { // If only a title clear is attempted with no other fields
      sqlSetParts.push("Title = ?");
      sqlValues.push(null); // Or some default like "Untitled"
      console.log("Attempting to set title to NULL or default");
  }
  // --- END DUMMY UPDATE ---


  if (sqlSetParts.length === 0) {
    console.log("No valid fields (including dummy title update) found to update. Sending 200 with no change message.");
    return res.status(200).json({ message: 'No fields provided for update or relevant fields were invalid.' });
  }

  sqlValues.push(id); // For WHERE Id = ?
  const sql = `UPDATE Tasks SET ${sqlSetParts.join(', ')} WHERE Id = ?`;

  console.log("Simplified SQL for update:", sql);
  console.log("SQL Values:", JSON.stringify(sqlValues));

  db.query(sql, sqlValues, (err, result) => {
    if (err) {
      console.error(`❌ SQL Update error (Simplified) on /api/tasks/${id}:`, err.message);
      return res.status(500).json({ message: 'Failed to update task in database', error: err.message });
    }
    if (result.affectedRows === 0) {
      console.warn(`❌ Task with ID ${id} not found for update (Simplified).`);
      return res.status(404).json({ message: '❌ Task not found' });
    }
    console.log(`✅ Task ID ${id} update attempt (Simplified). Affected rows: ${result.affectedRows}, ChangedRows: ${result.changedRows}`);
    // For UPDATE, result.changedRows is more informative than affectedRows if no actual values changed.
    if (result.changedRows > 0) {
        console.log("SUCCESS: Database indicates rows were actually changed.");
    } else if (result.affectedRows > 0 && result.changedRows === 0) {
        console.log("NOTE: Database indicates row was matched (affected) but no values were different from existing ones.");
    }
    res.status(200).json({ message: '✅ Task update attempt processed (Simplified)' });
  });
});

// ===== DELETE Task =====
app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM Tasks WHERE Id = ?', [id], (err, result) => {
    if (err) {
      console.error(`❌ Delete error on /api/tasks/${id}:`, err.message);
      return res.status(500).json({ message: 'Failed to delete task', error: err.message });
    }
    if (result.affectedRows === 0) return res.status(404).json({ message: '❌ Task not found' });
    console.log(`DELETE /api/tasks/${id} - Successfully deleted.`);
    res.status(200).json({ message: '🗑️ Task deleted successfully' });
  });
});

// ===== STUDENTS API (Keep as is from your previous full file if working) =====
const formatDateForDB = (dateStr) => {
  if (!dateStr || dateStr === "0000-00-00" || dateStr === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      console.warn(`Invalid date format for DB: ${dateStr}. Returning null.`);
      return null;
  }
  return dateStr;
};
app.post('/api/add-student', (req, res) => {
  const s = req.body;
  const sql = `INSERT INTO Students (SrNo, AdmissionDate, AdmissionNo, FullName, FathersName, MothersName, DOB, Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [s.srNo, formatDateForDB(s.admissionDate), s.admissionNo, s.fullName, s.fathersName, s.mothersName, formatDateForDB(s.dob), s.address, s.phone, s.whatsapp || s.phone, s.classAdmitted, s.currentClass, s.section];
  db.query(sql, values, (err, result) => {
    if (err) return res.status(500).json({ message: 'Add student failed', error: err.message });
    res.status(201).json({ message: '✅ Student added', id: s.admissionNo });
  });
});
app.get('/api/get-students', (req, res) => {
  db.query('SELECT * FROM Students ORDER BY AdmissionDate DESC', (err, results) => {
    if (err) return res.status(500).json({ message: 'Student fetch failed', error: err.message });
    res.status(200).json(results);
  });
});
app.post('/api/update-student', (req, res) => {
  const s = req.body; if (!s.admissionNo) return res.status(400).json({ message: 'AdmissionNo is required.' });
  const sql = `UPDATE Students SET SrNo = ?, AdmissionDate = ?, FullName = ?, FathersName = ?, MothersName = ?, DOB = ?, Address = ?, Phone = ?, Whatsapp = ?, ClassAdmitted = ?, CurrentClass = ?, Section = ? WHERE AdmissionNo = ?`;
  const values = [s.srNo, formatDateForDB(s.admissionDate), s.fullName, s.fathersName, s.mothersName, formatDateForDB(s.dob), s.address, s.phone, s.whatsapp || s.phone, s.classAdmitted, s.currentClass, s.section, s.admissionNo];
  db.query(sql, values, (err, result) => {
    if (err) return res.status(500).json({ message: 'Student update failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Student not found.' });
    res.status(200).json({ message: '✅ Student updated successfully' });
  });
});
app.delete('/api/delete-student/:admissionNo', (req, res) => {
  const { admissionNo } = req.params;
  db.query('DELETE FROM Students WHERE AdmissionNo = ?', [admissionNo], (err, result) => {
    if (err) return res.status(500).json({ message: 'Student delete failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Student not found' });
    res.status(200).json({ message: '✅ Student deleted' });
  });
});

// ===== TEACHERS API (Keep as is from your previous full file if working) =====
app.post('/api/add-teacher', (req, res) => {
  const t = req.body; const fullName = (t.fullName || '').trim().toLowerCase(); const fathersName = (t.fathersName || '').trim().toLowerCase(); const phone = (t.phone || '').trim();
  if (!t.fullName || !fathersName) return res.status(400).json({ message: 'FullName and FathersName are required' });
  const checkQuery = `SELECT * FROM Teachers WHERE (LOWER(FullName) = ? AND LOWER(FathersName) = ?) ${phone ? 'OR Phone = ?' : ''}`;
  const checkParams = [fullName, fathersName]; if (phone) checkParams.push(phone);
  db.query(checkQuery, checkParams, (err, results) => {
    if (err) return res.status(500).json({ message: 'Duplication check failed', error: err.message });
    if (results.length > 0) return res.status(409).json({ message: 'Teacher already exists' });
    const insertSql = `INSERT INTO Teachers (FullName, FathersName, Qualification, DateOfBirth, DateOfJoining, Phone, Whatsapp, Type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const values = [t.fullName, t.fathersName, t.qualification, formatDateForDB(t.dateOfBirth), formatDateForDB(t.dateOfJoining), phone, t.whatsapp || phone, t.type || 'Teaching'];
    db.query(insertSql, values, (err, result) => {
      if (err) return res.status(500).json({ message: 'Teacher insert failed', error: err.message });
      const insertedTeacher = { Id: result.insertId, ...t, dateOfBirth: values[3], dateOfJoining: values[4], phone: values[5], whatsapp: values[6], type: values[7] };
      res.status(201).json({ message: '✅ Teacher added', teacher: insertedTeacher });
    });
  });
});
app.get('/api/get-teachers', (req, res) => {
  db.query('SELECT * FROM Teachers ORDER BY DateOfJoining DESC', (err, results) => {
    if (err) return res.status(500).json({ message: 'Teacher fetch failed', error: err.message });
    res.status(200).json(results);
  });
});
app.put('/api/update-teacher', (req, res) => {
  const t = req.body; const teacherId = t.id || t.Id; if (!teacherId) return res.status(400).json({ message: 'Teacher ID is required.' });
  const sql = `UPDATE Teachers SET FullName = ?, FathersName = ?, Qualification = ?, DateOfBirth = ?, DateOfJoining = ?, Phone = ?, Whatsapp = ?, Type = ? WHERE Id = ?`;
  const values = [t.fullName, t.fathersName, t.qualification, formatDateForDB(t.dateOfBirth), formatDateForDB(t.dateOfJoining), t.phone, t.whatsapp || t.phone, t.type || 'Teaching', teacherId];
  db.query(sql, values, (err, result) => {
    if (err) return res.status(500).json({ message: 'Teacher update failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Teacher not found.' });
    res.status(200).json({ message: '✅ Teacher updated successfully.' });
  });
});
app.delete('/api/delete-teacher/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM Teachers WHERE Id = ?', [id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Teacher delete failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Teacher not found.' });
    res.status(200).json({ message: '✅ Teacher deleted successfully.' });
  });
});

// ==== 404 Catch All ====
app.use((req, res) => {
  res.status(404).json({ message: `❌ Route not found: ${req.method} ${req.originalUrl}`});
});
// ==== Global Error Handler ====
app.use((err, req, res, next) => {
    console.error("💥 GLOBAL ERROR HANDLER:", err.stack);
    res.status(500).json({ message: "❌ An unexpected server error occurred." });
});
// ==== Start Server ====
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});