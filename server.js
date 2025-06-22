const express = require('express');
const cors = require('cors');
const db = require('./dbconfig'); // Ensure your dbconfig.js uses a resilient pool (mysql2)

const app = express();
const PORT = process.env.PORT || 5000;

// ==== Middleware ====
app.use(cors());
app.use(express.json());

// ==== DB Connection Test (from your dbconfig.js, so this can be removed if it's there) ====
// This is just to confirm the pool connects on startup.
db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to MySQL Database Pool');
    connection.release();
  }
});

// =====================
// DIARY ENTRIES API
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


// =====================
// TASKS API
// =====================

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

    const mappedTasks = results.map((row) => {
      let finalDueDateString = null;
      if (row.DueDate) {
        try {
            const dateObj = new Date(row.DueDate);
            if (!isNaN(dateObj.getTime())) {
                const year = dateObj.getFullYear();
                const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                const day = String(dateObj.getDate()).padStart(2, '0');
                finalDueDateString = `${year}-${month}-${day}`;
            }
        } catch (e) {
            console.warn(`Could not parse date for task ${row.Id}:`, row.DueDate);
        }
      }

      const finalStatus = row.Status || 'Pending'; // Default to 'Pending' if NULL/empty

      return {
        id: row.Id,
        title: row.Title,
        description: row.Description,
        dueDate: finalDueDateString,
        dueTime: row.DueTime ? String(row.DueTime).slice(0, 5) : "23:59",
        priority: row.Priority,
        repeat: row['Repeat'],
        status: finalStatus,
        createdAt: row.CreatedAt,
        _lastGenerated: row._LastGenerated,
        attachmentRequired: !!row.AttachmentRequired,
        assignedTo: JSON.parse(row.AssignedTo || "[]"),
        taggedMembers: JSON.parse(row.TaggedMembers || "[]")
      };
    });
    res.status(200).json(mappedTasks);
  });
});

// ===== POST New Task =====
app.post('/api/tasks', (req, res) => {
  const t = req.body;
  let finalDueDate = t.dueDate || null;
  if (finalDueDate === "") finalDueDate = null;
  let finalDueTime = t.dueTime || '23:59:00';
  if (finalDueTime.match(/^\d{2}:\d{2}$/)) finalDueTime += ':00';
  const createdAt = t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lastGenerated = t._lastGenerated ? new Date(t._lastGenerated).toISOString().slice(0, 19).replace('T', ' ') : null;

  const sql = `
    INSERT INTO Tasks (
      Id, Title, Description, DueDate, DueTime, Priority, \`Repeat\`, Status, CreatedAt, _LastGenerated,
      AttachmentRequired, AssignedTo, TaggedMembers
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [
    t.id, t.title || "Untitled Task", t.description || "", finalDueDate, finalDueTime,
    t.priority || 'Medium', t.repeat || 'None', t.status || 'Pending',
    createdAt, lastGenerated, !!t.attachmentRequired,
    JSON.stringify(t.assignedTo || []), JSON.stringify(t.taggedMembers || [])
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
    res.status(201).json({ message: '✅ Task added successfully', task: createdTask });
  });
});

// ===== PUT (Update) Task =====
app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const t = req.body;

  console.log(`\n--- PUT /api/tasks/${id} ---`);
  console.log("Received body from client:", JSON.stringify(t, null, 2));

  const sqlSetParts = [];
  const sqlValues = [];
  const fieldMap = {
      title: 'Title', description: 'Description', dueDate: 'DueDate', dueTime: 'DueTime',
      priority: 'Priority', repeat: '`Repeat`', status: 'Status', _lastGenerated: '_LastGenerated',
      attachmentRequired: 'AttachmentRequired', assignedTo: 'AssignedTo', taggedMembers: 'TaggedMembers'
  };

  for (const key in t) {
      if (t.hasOwnProperty(key) && fieldMap[key]) {
          const dbColumn = fieldMap[key];
          let value = t[key];

          if (key === 'dueDate' && (value === '' || value === '0000-00-00')) value = null;
          if (key === 'dueTime' && value && value.match(/^\d{2}:\d{2}$/)) value += ':00';
          if (key === 'assignedTo' || key === 'taggedMembers') value = JSON.stringify(value || []);
          if (key === 'attachmentRequired') value = !!value;
          if (key === '_lastGenerated' && value) value = new Date(value).toISOString().slice(0, 19).replace('T', ' ');
          
          sqlSetParts.push(`${dbColumn} = ?`);
          sqlValues.push(value);
      }
  }

  if (sqlSetParts.length === 0) {
    return res.status(200).json({ message: 'No valid fields provided for update.' });
  }

  sqlValues.push(id); 
  const sql = `UPDATE Tasks SET ${sqlSetParts.join(', ')} WHERE Id = ?`;

  db.query(sql, sqlValues, (err, result) => {
    if (err) {
      console.error(`❌ SQL Update error on /api/tasks/${id}:`, err.message);
      return res.status(500).json({ message: 'Failed to update task in database', error: err.message });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.status(200).json({ message: 'Task updated successfully' });
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
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Task not found' });
    res.status(200).json({ message: '🗑️ Task deleted successfully' });
  });
});

// Helper function for date formatting in other APIs
const formatDateForDB = (dateStr) => {
  if (!dateStr || dateStr === "0000-00-00" || dateStr === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return dateStr;
};

// ===== STUDENTS API =====
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
app.put('/api/update-student', (req, res) => { // Changed from POST to PUT for semantic correctness
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


// ===== TEACHERS API =====
app.post('/api/add-teacher', (req, res) => {
  const t = req.body;
  const sql = `INSERT INTO Teachers (FullName, FathersName, Qualification, DateOfBirth, DateOfJoining, Phone, Whatsapp, Type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [t.fullName, t.fathersName, t.qualification, formatDateForDB(t.dateOfBirth), formatDateForDB(t.dateOfJoining), t.phone, t.whatsapp || t.phone, t.type || 'Teaching'];
  db.query(sql, values, (err, result) => {
    if (err) return res.status(500).json({ message: 'Teacher insert failed', error: err.message });
    const insertedTeacher = { Id: result.insertId, ...t, dateOfBirth: values[3], dateOfJoining: values[4], phone: values[5], whatsapp: values[6], type: values[7] };
    res.status(201).json({ message: '✅ Teacher added', teacher: insertedTeacher });
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