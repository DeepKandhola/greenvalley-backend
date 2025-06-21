const express = require('express');
const cors = require('cors');
const db = require('./dbconfig'); // Your MySQL pool export

const app = express();
const PORT = 5000;

// ==== Middleware ====
app.use(cors());
app.use(express.json());

// ==== DB Connection Test ====
db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to MySQL Database');
    connection.release();
  }
});
// ===== GET All Tasks =====
app.get('/api/tasks', (req, res) => {
  db.query('SELECT * FROM Tasks ORDER BY DueDate ASC', (err, results) => {
    if (err) {
      console.error('❌ Fetch error:', err.message);
      return res.status(500).json({ message: 'Failed to fetch tasks', error: err.message });
    }
    res.status(200).json(results);
  });
});

// ===== POST New Task =====
app.post('/api/tasks', (req, res) => {
  const t = req.body;

  const sql = `
    INSERT INTO Tasks (
      Id, Title, Description, DueDate, DueTime,
      Priority, \`Repeat\`, Status, CreatedAt, _LastGenerated,
      AttachmentRequired, AssignedTo, TaggedMembers
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const values = [
    t.id,
    t.title,
    t.description,
    t.dueDate,
    t.dueTime,
    t.priority,
    t.repeat,
    t.status || 'Pending',
    t.createdAt || new Date(),
    t._lastGenerated || null,
    t.attachmentRequired || null,
    Array.isArray(t.assignedTo) ? JSON.stringify(t.assignedTo) : JSON.stringify([]),
    JSON.stringify(t.taggedMembers || [])
  ];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ Insert error:', err.message);
      return res.status(500).json({ message: 'Failed to add task', error: err.message });
    }

    res.status(200).json({ message: '✅ Task added successfully', task: t });
  });
});

// ===== PUT (Update) Task =====
app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const t = req.body;

  const sql = `
  UPDATE Tasks SET
    Title = ?, Description = ?, DueDate = ?, DueTime = ?,
    Priority = ?, \`Repeat\` = ?, Status = ?, _LastGenerated = ?,
    Attachment = ?, AssignedTo = ?, TaggedMembers = ?
  WHERE Id = ?
`;

const values = [
  t.title,
  t.description,
  t.dueDate,
  t.dueTime,
  t.priority,
  t.repeat,
  t.status,
  t._lastGenerated || null,
  t.attachment || null,
  t.assignedTo || null,
  JSON.stringify(t.taggedMembers || []),
  id
];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ Update error:', err.message);
      return res.status(500).json({ message: 'Failed to update task', error: err.message });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '❌ Task not found' });
    }

    res.status(200).json({ message: '✅ Task updated successfully' });
  });
});

// ===== DELETE Task =====
app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM Tasks WHERE Id = ?', [id], (err, result) => {
    if (err) {
      console.error('❌ Delete error:', err.message);
      return res.status(500).json({ message: 'Failed to delete task', error: err.message });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '❌ Task not found' });
    }

    res.status(200).json({ message: '🗑️ Task deleted successfully' });
  });
});


// ==== Add Student ====
app.post('/api/add-student', (req, res) => {
  const s = req.body;
  const sql = `
    INSERT INTO Students (
      SrNo, AdmissionDate, AdmissionNo, FullName,
      FathersName, MothersName, DOB, Address,
      Phone, Whatsapp, ClassAdmitted, CurrentClass, Section
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const values = [
    s.srNo, s.admissionDate, s.admissionNo, s.fullName,
    s.fathersName, s.mothersName, s.dob, s.address,
    s.phone, s.whatsapp || s.phone,
    s.classAdmitted, s.currentClass, s.section,
  ];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ Add error:', err.message);
      return res.status(500).json({ message: 'Add failed', error: err.message });
    }
    res.status(200).json({ message: '✅ Student added', id: result.insertId });
  });
});

// ==== Get All Students ====
app.get('/api/get-students', (req, res) => {
  const sql = 'SELECT * FROM Students ORDER BY AdmissionDate DESC';
  db.query(sql, (err, results) => {
    if (err) {
      console.error('❌ Fetch error:', err.message);
      return res.status(500).json({ message: 'Fetch failed', error: err.message });
    }
    res.status(200).json(results);
  });
});

// ==== Update Student ====
app.post('/api/update-student', (req, res) => {
  const s = req.body;

  if (!s.admissionNo) {
    return res.status(400).json({ message: 'AdmissionNo is required.' });
  }

  const sql = `
    UPDATE Students SET
      SrNo = ?, AdmissionDate = ?, FullName = ?, FathersName = ?,
      MothersName = ?, DOB = ?, Address = ?, Phone = ?, Whatsapp = ?,
      ClassAdmitted = ?, CurrentClass = ?, Section = ?
    WHERE AdmissionNo = ?
  `;

  const values = [
    s.srNo, s.admissionDate, s.fullName, s.fathersName, s.mothersName,
    s.dob, s.address, s.phone, s.whatsapp || s.phone,
    s.classAdmitted, s.currentClass, s.section,
    s.admissionNo
  ];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ Update error:', err.message);
      return res.status(500).json({ message: 'Update failed', error: err.message });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    res.status(200).json({ message: '✅ Student updated successfully' });
  });
});

// ==== DELETE Student ====
app.delete('/api/delete-student/:admissionNo', (req, res) => {
  const { admissionNo } = req.params;

  console.log('🔥 DELETE called for AdmissionNo:', admissionNo);

  const sql = 'DELETE FROM Students WHERE AdmissionNo = ?';

  db.query(sql, [admissionNo], (err, result) => {
    if (err) {
      console.error('❌ Delete error:', err.message);
      return res.status(500).json({ message: 'Delete failed', error: err.message });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Student not found' });
    }

    res.status(200).json({ message: '✅ Student deleted' });
  });
});


// ==== Add Teacher ====
// ==== Add Teacher with Duplicate Check ====
app.post('/api/add-teacher', (req, res) => {
  const t = req.body;

  const fullName = (t.fullName || '').trim().toLowerCase();
  const fathersName = (t.fathersName || '').trim().toLowerCase();
  const phone = (t.phone || '').trim();

  if (!fullName || !fathersName) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const checkQuery = `
    SELECT * FROM Teachers
    WHERE 
      (LOWER(FullName) = ? AND LOWER(FathersName) = ?)
      OR Phone = ?
  `;

  db.query(checkQuery, [fullName, fathersName, phone], (err, results) => {
    if (err) {
      console.error('❌ Duplication check error:', err.message);
      return res.status(500).json({ message: 'Duplication check failed' });
    }

    if (results.length > 0) {
      return res.status(409).json({ message: 'Teacher already exists' });
    }

    const insertSql = `
      INSERT INTO Teachers (
        FullName, FathersName, Qualification, DateOfBirth,
        DateOfJoining, Phone, Whatsapp, Type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      t.fullName, t.fathersName, t.qualification, t.dateOfBirth,
      t.dateOfJoining, phone, t.whatsapp || phone, t.type || 'Teaching'
    ];

    db.query(insertSql, values, (err, result) => {
      if (err) {
        console.error('❌ Insert error:', err.message);
        return res.status(500).json({ message: 'Insert failed' });
      }

      res.status(200).json({
        message: '✅ Teacher added',
        id: result.insertId,
        teacher: {
          ...t,
          id: result.insertId
        }
      });
    });
  });
});

// ==== Get All Teachers ====
app.get('/api/get-teachers', (req, res) => {
  db.query('SELECT * FROM Teachers ORDER BY DateOfJoining DESC', (err, results) => {
    if (err) {
      console.error('❌ Fetch error:', err.message);
      return res.status(500).json({ message: 'Fetch failed', error: err.message });
    }
    res.status(200).json(results);
  });
});

// ==== Update Teacher ====
app.put('/api/update-teacher', (req, res) => {
  const t = req.body;

  if (!t.id) {
    return res.status(400).json({ message: 'Teacher ID is required.' });
  }

  const sql = `
    UPDATE Teachers SET
      FullName = ?, FathersName = ?, Qualification = ?, DateOfBirth = ?,
      DateOfJoining = ?, Phone = ?, Whatsapp = ?, Type = ?
    WHERE Id = ?
  `;

  const values = [
    t.fullName, t.fathersName, t.qualification, t.dateOfBirth,
    t.dateOfJoining, t.phone, t.whatsapp || t.phone, t.type || 'Teaching',
    t.id
  ];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error('❌ Update error:', err.message);
      return res.status(500).json({ message: 'Update failed', error: err.message });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Teacher not found.' });
    }

    res.json({ message: '✅ Teacher updated successfully.' });
  });
});

// ==== Delete Teacher ====
app.delete('/api/delete-teacher/:id', (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM Teachers WHERE Id = ?', [id], (err, result) => {
    if (err) {
      console.error('❌ Delete error:', err.message);
      return res.status(500).json({ message: 'Delete failed', error: err.message });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Teacher not found.' });
    }

    res.json({ message: '✅ Teacher deleted successfully.' });
  });
});

// ==== 404 Catch All - MUST BE LAST! ====
app.use((req, res) => {
  res.status(404).json({
    message: `❌ Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ==== Start Server ====
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});