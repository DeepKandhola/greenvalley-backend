// server.js
const express = require('express');
const cors = require('cors');
const path = require('path'); // For serving static files
const fs = require('fs'); // For file system operations (creating directories)
const multer = require('multer'); // For handling file uploads
const db = require('./dbconfig'); // Ensure your dbconfig.js uses a resilient pool (mysql2)

const { format, subDays } = require('date-fns');
const { toDate, zonedTimeToUtc } = require('date-fns-tz');

const app = express();
const PORT = process.env.PORT || 5000;

// ==== Middleware ====
app.use(cors());
app.use(express.json());

// --- Static File Serving for Attachments ---
// Create the attachments directory if it doesn't exist
const attachmentsDir = path.join(__dirname, 'public', 'attachments', 'tasks');
if (!fs.existsSync(attachmentsDir)) {
  fs.mkdirSync(attachmentsDir, { recursive: true });
  console.log(`✅ Created attachments directory: ${attachmentsDir}`);
}
// Serve static files from the 'public' directory
app.use('/public', express.static(path.join(__dirname, 'public')));


// ==== DB Connection Test ====
db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to MySQL Database Pool');
    connection.release();
  }
});


app.post('/api/login', async (req, res) => {
  const { username, password: providedPassword } = req.body;

  if (!username || !providedPassword) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  try {
    const [rows] = await db.promise().query(
      'SELECT Id, FullName, Username, Password, Role, ManagedClasses FROM Teachers WHERE Username = ?',
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const teacher = rows[0];
    const dbPassword = teacher.Password;
    let isMatch = false;

    if (dbPassword && dbPassword.trim() !== '') {
      isMatch = (providedPassword === dbPassword); // In production, use bcrypt.compare
    } else {
      isMatch = (providedPassword === 'password');
    }

    if (isMatch) {
      let managedClassesArray = [];
      if (teacher.ManagedClasses) {
        try {
          managedClassesArray = JSON.parse(teacher.ManagedClasses);
          if (!Array.isArray(managedClassesArray)) managedClassesArray = [];
        } catch (e) {
          console.error("Failed to parse ManagedClasses JSON for user:", teacher.Username, e);
          managedClassesArray = [];
        }
      }
      const userData = {
        id: teacher.Id,
        name: teacher.FullName,
        username: teacher.Username,
        role: teacher.Role,
        managedClasses: managedClassesArray,
      };
      res.status(200).json(userData);
    } else {
      res.status(401).json({ message: 'Invalid username or password.' });
    }
  } catch (error) {
    console.error('❌ Login API Error:', error);
    res.status(500).json({ message: 'An error occurred during the login process.' });
  }
});
app.get('/api/teacher/my-students', async (req, res) => {
    // We get the teacher's managed classes from a query parameter
    // e.g., /api/teacher/my-students?classes=9-A,Nursery-A
    const { classes } = req.query;

    if (!classes) {
        return res.status(400).json({ message: "Managed classes are required." });
    }

    try {
        const classList = classes.split(',');
        // This transforms ['9-A', 'Nursery-A'] into [['9', 'A'], ['Nursery', 'A']]
        // for a robust SQL query
        const classSectionPairs = classList.map(cls => cls.split('-'));

        const [students] = await db.promise().query(
            `SELECT * FROM Students WHERE (CurrentClass, Section) IN (?) ORDER BY FullName`,
            [classSectionPairs]
        );
        
        res.status(200).json(students);

    } catch (error) {
        console.error("Error fetching students for teacher:", error);
        res.status(500).json({ message: "Failed to fetch student data." });
    }
});
app.get('/api/teacher/dashboard-stats/:teacherId/:managedClasses', async (req, res) => {
  const { teacherId } = req.params;
  const decodedClassesString = decodeURIComponent(req.params.managedClasses);
  const classes = decodedClassesString.split(','); // e.g., ['9-A', 'Nursery-A']

  if (!teacherId || !classes || !classes.length) {
    return res.status(400).json({ message: "Teacher ID and managed classes are required." });
  }

  // Create placeholders '?,?' for the IN clause
  const classPlaceholders = classes.map(() => '?').join(',');

  try {
    // === Query 1: Get all student Admission Numbers for this teacher ===
    const [studentIdRows] = await db.promise().query(
      `SELECT AdmissionNo FROM Students WHERE CONCAT(CurrentClass, '-', Section) IN (${classPlaceholders})`,
      classes
    );
    
    // If no students are found, we can stop early
    if (studentIdRows.length === 0) {
        return res.json({ totalStudents: 0, totalTasks: 0, completedTasks: 0, pendingTasks: 0, inProgressOrOverdue: 0, presentStudents: 0, absentStudents: 0, onLeaveStudents: 0 });
    }

    const studentAdmissionNumbers = studentIdRows.map(row => row.AdmissionNo);
    const totalStudents = studentAdmissionNumbers.length;

    // === Query 2: Get Task Stats ===
    const [[taskStats]] = await db.promise().query(
      `SELECT
         COUNT(Id) as totalTasks,
         SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) as completedTasks,
         SUM(CASE WHEN Status IN ('Pending', 'Not Started') THEN 1 ELSE 0 END) as pendingTasks
       FROM Tasks WHERE AssignedTo REGEXP ?`,
      [`[[:<:]]${teacherId}[[:>:]]`]
    );

    // === Query 3: Find the latest attendance date for these specific students ===
    const [[latestDateData]] = await db.promise().query(
      'SELECT MAX(AttendanceDate) as latestDate FROM Attendance WHERE StudentAdmissionNo IN (?)',
      [studentAdmissionNumbers]
    );

    let attendanceData = { presentStudents: 0, absentStudents: 0, onLeaveStudents: 0 };
    if (latestDateData && latestDateData.latestDate) {
      const latestDate = latestDateData.latestDate;
      // === Query 4: Get attendance stats for that specific date and students ===
      const [[statsForDate]] = await db.promise().query(
        `SELECT
           SUM(CASE WHEN Status = 'Present' THEN 1 ELSE 0 END) as presentStudents,
           SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) as absentStudents,
           SUM(CASE WHEN Status = 'OnLeave' THEN 1 ELSE 0 END) as onLeaveStudents
         FROM Attendance
         WHERE AttendanceDate = ? AND StudentAdmissionNo IN (?)`,
        [latestDate, studentAdmissionNumbers]
      );
      attendanceData = statsForDate;
    }

    // --- Final Calculation & Response ---
    const totalTasks = taskStats.totalTasks || 0;
    const completedTasks = taskStats.completedTasks || 0;
    const pendingTasks = taskStats.pendingTasks || 0;
    const inProgressOrOverdue = totalTasks - completedTasks - pendingTasks;

    const finalStats = {
      totalStudents: totalStudents,
      totalTasks,
      completedTasks,
      pendingTasks,
      inProgressOrOverdue,
      presentStudents: attendanceData.presentStudents || 0,
      absentStudents: attendanceData.absentStudents || 0,
      onLeaveStudents: attendanceData.onLeaveStudents || 0
    };
    
    res.status(200).json(finalStats);

  } catch (err) {
    console.error(`❌ Error fetching dashboard stats for teacher ID ${teacherId}:`, err.message);
    res.status(500).json({ message: "Failed to fetch dashboard statistics." });
  }
});

app.get('/api/teacher/full-details/:teacherId', async (req, res) => {
  const { teacherId } = req.params;
  try {
    // Select all relevant fields, formatting dates for consistency
    const [rows] = await db.promise().query(
      `SELECT 
        FullName, FathersName, Qualification, 
        DATE_FORMAT(DateOfBirth, '%d-%m-%Y') as DateOfBirth, 
        DATE_FORMAT(DateOfJoining, '%d-%m-%Y') as DateOfJoining, 
        Phone, Whatsapp, Type, Username, ManagedClasses
       FROM Teachers 
       WHERE Id = ?`,
      [teacherId]
    );

    if (rows.length > 0) {
      // The DB stores ManagedClasses as a JSON string, so we parse it here
      const teacher = rows[0];
      try {
        teacher.ManagedClasses = JSON.parse(teacher.ManagedClasses || '[]');
      } catch (e) {
        teacher.ManagedClasses = []; // Default to empty array if parsing fails
      }
      res.status(200).json(teacher);
    } else {
      res.status(404).json({ message: 'Teacher not found.' });
    }
  } catch (error) {
    console.error(`Error fetching full details for teacher ${teacherId}:`, error);
    res.status(500).json({ message: 'Failed to fetch teacher details.' });
  }
});

// You also need an endpoint to change the password.
// This is a more secure example.
app.put('/api/teacher/change-password', async (req, res) => {
  // Now accepts an optional newUsername
  const { teacherId, currentPassword, newUsername, newPassword } = req.body;

  if (!teacherId || !currentPassword || !newPassword || !newUsername) {
      return res.status(400).json({ message: "All fields are required." });
  }

  try {
      // 1. Get the teacher's current stored password to verify
      const [rows] = await db.promise().query('SELECT Password FROM Teachers WHERE Id = ?', [teacherId]);
      if (rows.length === 0) {
          return res.status(404).json({ message: "User not found." });
      }
      
      const storedPassword = rows[0].Password;

      // 2. Verify the current password matches
      if (currentPassword !== storedPassword) {
          return res.status(401).json({ message: "Incorrect current password." });
      }

      // 3. Update BOTH the username and the new password
      await db.promise().query(
          'UPDATE Teachers SET Username = ?, Password = ? WHERE Id = ?', 
          [newUsername, newPassword, teacherId]
      );

      res.status(200).json({ message: "✅ Credentials updated successfully!" });

  } catch (error) {
      // Handle potential duplicate username error
      if (error.code === 'ER_DUP_ENTRY' && error.message.includes('Username')) {
          return res.status(409).json({ message: 'That username is already taken. Please choose another.' });
      }
      console.error(`Error changing credentials for teacher ${teacherId}:`, error);
      res.status(500).json({ message: "Failed to update credentials." });
  }
});

// =====================
// ATTENDANCE API
// =====================
app.post('/api/attendance', (req, res) => {
  const attendanceRecords = req.body.records;
  const teacherName = req.body.teacherName;

  if (!Array.isArray(attendanceRecords) || attendanceRecords.length === 0) {
    return res.status(400).json({ message: 'No attendance records provided.' });
  }

  const indiaTimeZone = 'Asia/Kolkata';
  const lockInDays = 3;
  const nowInIndia = toDate(new Date(), { timeZone: indiaTimeZone });
  const todayStr = format(nowInIndia, 'yyyy-MM-dd');
  const cutoffDate = subDays(nowInIndia, lockInDays);
  const cutoffDateStr = format(cutoffDate, 'yyyy-MM-dd');
  const attendanceDate = attendanceRecords[0].date;

  if (attendanceDate > todayStr) {
    return res.status(403).json({ message: `Cannot mark attendance for a future date.` });
  }
  if (attendanceDate < cutoffDateStr) {
    return res.status(403).json({ message: `Attendance for this date is locked. You can only edit records for the past ${lockInDays} days.` });
  }

  const sql = `
    INSERT INTO Attendance (StudentAdmissionNo, AttendanceDate, Status, MarkedByTeacher)
    VALUES ?
    ON DUPLICATE KEY UPDATE Status = VALUES(Status), MarkedByTeacher = VALUES(MarkedByTeacher)`;
  const values = attendanceRecords.map(rec => [rec.admissionNo, rec.date, rec.status, teacherName]);

  db.query(sql, [values], (err, result) => {
    if (err) {
      console.error('❌ Error saving attendance:', err.message);
      return res.status(500).json({ message: 'Failed to save attendance', error: err.message });
    }
    res.status(201).json({ message: '✅ Attendance saved successfully', affectedRows: result.affectedRows });
  });
});
app.get('/api/students-by-class/:classSection', (req, res) => {
  const { classSection } = req.params;
  if (!classSection || !classSection.includes('-')) {
    return res.status(400).json({ message: 'Invalid class-section format. Use format like "10-A".' });
  }
  const [currentClass, section] = classSection.split('-');
  const sql = 'SELECT AdmissionNo, FullName FROM Students WHERE CurrentClass = ? AND Section = ? ORDER BY FullName';
  db.query(sql, [currentClass, section], (err, results) => {
    if (err) {
      console.error(`❌ Error fetching students for class ${classSection}:`, err.message);
      return res.status(500).json({ message: 'Database query failed' });
    }
    res.status(200).json(results);
  });
});
app.get('/api/attendance-report', (req, res) => {
  const sql = `
    SELECT a.Id, a.AttendanceDate, a.Status, a.MarkedByTeacher, s.AdmissionNo, s.FullName, s.CurrentClass, s.Section
    FROM Attendance a JOIN Students s ON a.StudentAdmissionNo = s.AdmissionNo
    ORDER BY a.AttendanceDate DESC, s.CurrentClass, s.Section, s.FullName;`;
  db.query(sql, (err, results) => {
    if (err) {
      console.error('❌ Error fetching attendance report:', err.message);
      return res.status(500).json({ message: 'Failed to fetch report', error: err.message });
    }
    res.status(200).json(results);
  });
});
app.get('/api/attendance/:classSection/:date', (req, res) => {
  const { classSection, date } = req.params;
  const sql = "SELECT StudentAdmissionNo, Status FROM Attendance WHERE StudentAdmissionNo IN (SELECT AdmissionNo FROM Students WHERE CONCAT(CurrentClass, '-', Section) = ?) AND AttendanceDate = ?";
  db.query(sql, [classSection, date], (err, results) => {
    if (err) {
      console.error(`❌ Error fetching attendance for ${classSection} on ${date}:`, err.message);
      return res.status(500).json({ message: 'Database query failed' });
    }
    const attendanceMap = results.reduce((acc, record) => { acc[record.StudentAdmissionNo] = record.Status; return acc; }, {});
    res.status(200).json(attendanceMap);
  });
});
app.get('/api/get-classes', (req, res) => {
  const sql = `
    SELECT DISTINCT CONCAT(CurrentClass, '-', Section) AS ClassSection FROM Students
    WHERE CurrentClass IS NOT NULL AND CurrentClass != '' AND Section IS NOT NULL AND Section != ''
    ORDER BY CAST(REGEXP_SUBSTR(CurrentClass, '^[0-9]+') AS UNSIGNED) ASC, REGEXP_SUBSTR(CurrentClass, '[A-Za-z]+$') ASC, Section ASC;`;
  db.query(sql, (err, results) => {
    if (err) {
      console.error('❌ Error fetching distinct classes with sections:', err.message);
      return res.status(500).json({ message: 'Failed to fetch class list', error: err.message });
    }
    const classes = results.map(row => ({ value: row.ClassSection, label: row.ClassSection }));
    res.status(200).json(classes);
  });
});

app.get('/api/student/full-details/:admissionNo', async (req, res) => {
  const { admissionNo } = req.params;
  try {
    // Select all relevant fields, formatting dates for consistency
    const [rows] = await db.promise().query(
      `SELECT 
        FullName, AdmissionNo, FathersName, MothersName, 
        DATE_FORMAT(DOB, '%d-%m-%Y') as DOB, 
        Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section,
        Username
       FROM Students 
       WHERE AdmissionNo = ?`,
      [admissionNo]
    );

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).json({ message: 'Student not found.' });
    }
  } catch (error) {
    console.error(`Error fetching full details for student ${admissionNo}:`, error);
    res.status(500).json({ message: 'Failed to fetch student details.' });
  }
});

app.get('/api/student/details/:admissionNo', async (req, res) => {
  const { admissionNo } = req.params;
  try {
    const [rows] = await db.promise().query(
      'SELECT CurrentClass, Section FROM Students WHERE AdmissionNo = ?',
      [admissionNo]
    );
    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).json({ message: 'Student not found.' });
    }
  } catch (error) {
    console.error(`Error fetching details for student ${admissionNo}:`, error);
    res.status(500).json({ message: 'Failed to fetch student details.' });
  }
});

app.get('/api/student/today-attendance/:admissionNo', async (req, res) => {
  const { admissionNo } = req.params;
  const today = format(new Date(), 'yyyy-MM-dd'); // Get today's date

  try {
    const [rows] = await db.promise().query(
      'SELECT Status FROM Attendance WHERE StudentAdmissionNo = ? AND AttendanceDate = ?',
      [admissionNo, today]
    );

    if (rows.length > 0) {
      res.status(200).json({ status: rows[0].Status });
    } else {
      // If no record, it could mean attendance not taken yet, or they were absent by default
      res.status(200).json({ status: 'Not Marked' });
    }
  } catch (error) {
    console.error(`Error fetching today's attendance for ${admissionNo}:`, error);
    res.status(500).json({ message: "Failed to fetch today's attendance" });
  }
});

// --- Get a specific student's full attendance history ---
app.get('/api/student/attendance/:admissionNo', async (req, res) => {
  const { admissionNo } = req.params;
  try {
    const [attendanceRows] = await db.promise().query(
      // The DATE_FORMAT in MySQL is the most reliable way to get the correct string
      'SELECT DATE_FORMAT(AttendanceDate, "%Y-%m-%d") as AttendanceDate, Status FROM Attendance WHERE StudentAdmissionNo = ?',
      [admissionNo]
    );

    const attendanceMap = attendanceRows.reduce((acc, row) => {
      // The key is now guaranteed to be the correct YYYY-MM-DD string from the DB
      acc[row.AttendanceDate] = row.Status;
      return acc;
    }, {});

    res.status(200).json({ attendance: attendanceMap, holidays: {} });

  } catch (error) {
    console.error(`Error fetching attendance history for ${admissionNo}:`, error);
    res.status(500).json({ message: 'Failed to fetch attendance history' });
  }
});
app.get('/api/day-status/:date', async (req, res) => {
  const { date } = req.params;
  try {
    // Check for Sunday (Day 0)
    const dayOfWeek = new Date(date).getUTCDay();
    if (dayOfWeek === 0) {
      return res.status(200).json({ isSchoolOff: true, reason: 'Weekly Off' });
    }

    // Check the Holidays table
    const [rows] = await db.promise().query(
      'SELECT Description FROM Holidays WHERE HolidayDate = ?',
      [date]
    );

    if (rows.length > 0) {
      res.status(200).json({ isSchoolOff: true, reason: rows[0].Description });
    } else {
      res.status(200).json({ isSchoolOff: false, reason: 'Working Day' });
    }
  } catch (error) {
    console.error(`Error checking status for date ${date}:`, error);
    res.status(500).json({ message: 'Failed to check day status.' });
  }
});
// --- Allow a student to update their own credentials ---
app.put('/api/student/settings/update-credentials', async (req, res) => {
  const { admissionNo, newUsername, newPassword } = req.body;

  // Basic validation
  if (!admissionNo || !newUsername || !newPassword) {
    return res.status(400).json({ message: 'Admission number, new username, and new password are required.' });
  }
  
  try {
    const [result] = await db.promise().query(
      'UPDATE Students SET Username = ?, Password = ? WHERE AdmissionNo = ?',
      [newUsername, newPassword, admissionNo]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    res.status(200).json({ message: '✅ Credentials updated successfully!' });

  } catch (error) {
    // Handle potential duplicate username error
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'That username is already taken. Please choose another.' });
    }
    console.error(`Error updating credentials for ${admissionNo}:`, error);
    res.status(500).json({ message: 'Failed to update credentials.' });
  }
});

app.post('/api/holidays', (req, res) => {
  const { date, description, holidayType, adminName } = req.body;
  if (!date || !description || !holidayType) {
    return res.status(400).json({ message: 'Date, description, and holiday type are required.' });
  }
  const sql = "INSERT INTO Holidays (HolidayDate, Description, HolidayType, AddedBy) VALUES (?, ?, ?, ?)";
  db.query(sql, [date, description, holidayType, adminName], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: `The date ${date} is already marked.` });
      console.error('❌ Error adding holiday:', err.message);
      return res.status(500).json({ message: 'Failed to add holiday.' });
    }
    res.status(201).json({ message: '✅ Day marked successfully!' });
  });
});
app.get('/api/holidays/check/:date', (req, res) => {
  const { date } = req.params;
  const dayOfWeek = new Date(date).getUTCDay();
  if (dayOfWeek === 0) { return res.status(200).json({ isHoliday: true, description: 'Weekly Off', type: 'Holiday' }); }
  const sql = "SELECT Description, HolidayType FROM Holidays WHERE HolidayDate = ?";
  db.query(sql, [date], (err, results) => {
    if (err) {
      console.error('❌ Error checking holiday status:', err.message);
      return res.status(500).json({ message: 'Database query failed.' });
    }
    if (results.length > 0) { res.status(200).json({ isHoliday: true, description: results[0].Description, type: results[0].HolidayType }); }
    else { res.status(200).json({ isHoliday: false }); }
  });
});

app.get('/api/diary', (req, res) => {
  const sql = `SELECT * FROM DiaryEntries ORDER BY EntryDate DESC`;
  db.query(sql, (err, results) => {
    if (err) { console.error("❌ Error fetching diary entries:", err.message); return res.status(500).json({ message: "Failed to fetch entries", error: err.message }); }
    const mapped = results.map(entry => ({ id: entry.Id, title: entry.Title, type: entry.Type, description: entry.Description, entryDate: entry.EntryDate, createdAt: entry.CreatedAt }));
    res.status(200).json(mapped);
  });
});
app.post('/api/diary', (req, res) => {
  const { id, title, type, description, entryDate } = req.body;
  if (!id || !title || !entryDate || !description) return res.status(400).json({ message: "Missing required fields" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return res.status(400).json({ message: "Invalid entryDate format. Use YYYY-MM-DD." });
  const sql = `INSERT INTO DiaryEntries (Id, Title, Type, Description, EntryDate) VALUES (?, ?, ?, ?, ?)`;
  db.query(sql, [id, title, type || "Other", description, entryDate], (err, result) => {
    if (err) return res.status(500).json({ message: "Failed to add entry", error: err.message });
    res.status(201).json({ message: "✅ Entry added successfully", id });
  });
});
app.put('/api/diary/:id', (req, res) => {
  const { id } = req.params; const { title, type, description, entryDate } = req.body;
  if (!title || !entryDate || !description) return res.status(400).json({ message: "Missing required fields" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return res.status(400).json({ message: "Invalid entryDate format." });
  const sql = `UPDATE DiaryEntries SET Title = ?, Type = ?, Description = ?, EntryDate = ? WHERE Id = ?`;
  db.query(sql, [title, type || "Other", description, entryDate, id], (err, result) => {
    if (err) return res.status(500).json({ message: "Update failed", error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: "Entry not found" });
    res.status(200).json({ message: "✅ Entry updated successfully" });
  });
});
app.delete('/api/diary/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM DiaryEntries WHERE Id = ?', [id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Delete failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Entry not found' });
    res.status(200).json({ message: '✅ Entry deleted successfully' });
  });
});


// =====================
// TASKS API
// =====================

// --- Multer Configuration for Task Attachments ---
const taskAttachmentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, attachmentsDir); // Use the globally defined attachmentsDir
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, 'task-' + req.params.taskId + '-' + uniqueSuffix + extension);
  }
});

const taskAttachmentUpload = multer({
  storage: taskAttachmentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /pdf|doc|docx|jpg|jpeg|png|txt|zip/;
    const mimetype = allowedTypes.test(file.mimetype);
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('File upload only supports the following filetypes: ' + allowedTypes));
  }
}).single('attachment'); // 'attachment' is the field name in FormData


app.get('/api/tasks', (req, res) => {
  const selectQuery = `
    SELECT
      Id, Title, Description, DueDate, DueTime, Priority, \`Repeat\`, Status,
      CreatedAt, _LastGenerated, AttachmentRequired, AssignedTo, TaggedMembers,
      AttachmentName, AttachmentPath, SubmissionText, TextSubmissionRequired
    FROM Tasks
    ORDER BY CreatedAt DESC, DueDate ASC, DueTime ASC 
  `; // Added new fields

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
                finalDueDateString = format(dateObj, 'yyyy-MM-dd'); // Use date-fns for consistent formatting
            }
        } catch (e) { console.warn(`Could not parse date for task ${row.Id}:`, row.DueDate); }
      }
      return {
        id: row.Id, title: row.Title, description: row.Description,
        dueDate: finalDueDateString, dueTime: row.DueTime ? String(row.DueTime).slice(0, 5) : "23:59",
        priority: row.Priority, repeat: row['Repeat'], status: row.Status || 'Pending',
        createdAt: row.CreatedAt, _lastGenerated: row._LastGenerated,
        attachmentRequired: !!row.AttachmentRequired,
        assignedTo: JSON.parse(row.AssignedTo || "[]"), taggedMembers: JSON.parse(row.TaggedMembers || "[]"),
        attachmentName: row.AttachmentName || null, // NEW
        attachmentPath: row.AttachmentPath || null, // NEW
        submissionText: row.SubmissionText || "",   // NEW
        textSubmissionRequired: !!row.TextSubmissionRequired //NEW
      };
    });
    res.status(200).json(mappedTasks);
  });
});

app.post('/api/tasks', (req, res) => {
  const t = req.body;
  let finalDueDate = t.dueDate || null; if (finalDueDate === "") finalDueDate = null;
  let finalDueTime = t.dueTime || '23:59:00'; if (finalDueTime.match(/^\d{2}:\d{2}$/)) finalDueTime += ':00';
  const createdAt = t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lastGenerated = t._lastGenerated ? new Date(t._lastGenerated).toISOString().slice(0, 19).replace('T', ' ') : null;

  // Include new fields for text submission and attachment requirements
  const sql = `
    INSERT INTO Tasks (
      Id, Title, Description, DueDate, DueTime, Priority, \`Repeat\`, Status, CreatedAt, _LastGenerated,
      AttachmentRequired, AssignedTo, TaggedMembers, TextSubmissionRequired 
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; // Added TextSubmissionRequired
  const values = [
    t.id, t.title || "Untitled Task", t.description || "", finalDueDate, finalDueTime,
    t.priority || 'Medium', t.repeat || 'None', t.status || 'Pending',
    createdAt, lastGenerated, !!t.attachmentRequired,
    JSON.stringify(t.assignedTo || []), JSON.stringify(t.taggedMembers || []),
    !!t.textSubmissionRequired // NEW
  ];

  db.query(sql, values, (err, result) => {
    if (err) { console.error('❌ Insert error on /api/tasks:', err.message, "Values:", values); return res.status(500).json({ message: 'Failed to add task', error: err.message }); }
    const createdTask = {
      id: t.id, title: values[1], description: values[2], dueDate: finalDueDate, dueTime: finalDueTime.slice(0,5),
      priority: values[5], repeat: values[6], status: values[7], createdAt: values[8], _lastGenerated: values[9],
      attachmentRequired: values[10], assignedTo: t.assignedTo || [], taggedMembers: t.taggedMembers || [],
      textSubmissionRequired: !!t.textSubmissionRequired // NEW
    };
    res.status(201).json({ message: '✅ Task added successfully', task: createdTask });
  });
});

app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params; const t = req.body;
  const sqlSetParts = []; const sqlValues = [];
  const fieldMap = {
      title: 'Title', description: 'Description', dueDate: 'DueDate', dueTime: 'DueTime',
      priority: 'Priority', repeat: '`Repeat`', status: 'Status', _lastGenerated: '_LastGenerated',
      attachmentRequired: 'AttachmentRequired', assignedTo: 'AssignedTo', taggedMembers: 'TaggedMembers',
      attachmentName: 'AttachmentName', attachmentPath: 'AttachmentPath', // For direct updates if needed, though usually set by upload
      submissionText: 'SubmissionText', textSubmissionRequired: 'TextSubmissionRequired' // NEW
  };
  for (const key in t) {
      if (t.hasOwnProperty(key) && fieldMap[key]) {
          const dbColumn = fieldMap[key]; let value = t[key];
          if (key === 'dueDate' && (value === '' || value === '0000-00-00')) value = null;
          if (key === 'dueTime' && value && value.match(/^\d{2}:\d{2}$/)) value += ':00';
          if (key === 'assignedTo' || key === 'taggedMembers') value = JSON.stringify(value || []);
          if (key === 'attachmentRequired' || key === 'textSubmissionRequired') value = !!value;
          if (key === '_lastGenerated' && value) value = new Date(value).toISOString().slice(0, 19).replace('T', ' ');
          sqlSetParts.push(`${dbColumn} = ?`); sqlValues.push(value);
      }
  }
  if (sqlSetParts.length === 0) { return res.status(200).json({ message: 'No valid fields provided for update.' }); }
  sqlValues.push(id); const sql = `UPDATE Tasks SET ${sqlSetParts.join(', ')} WHERE Id = ?`;
  db.query(sql, sqlValues, (err, result) => {
    if (err) { console.error(`❌ SQL Update error on /api/tasks/${id}:`, err.message); return res.status(500).json({ message: 'Failed to update task in database', error: err.message }); }
    if (result.affectedRows === 0) { return res.status(404).json({ message: 'Task not found' }); }
    res.status(200).json({ message: 'Task updated successfully' });
  });
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  // Potentially delete associated attachment file from server here
  db.query('SELECT AttachmentPath FROM Tasks WHERE Id = ?', [id], (err, rows) => {
    if (err) { console.error('Error fetching task for deletion:', err); /* Continue to delete DB record */ }
    if (rows && rows.length > 0 && rows[0].AttachmentPath) {
        const filePath = path.join(__dirname, rows[0].AttachmentPath); // Assuming AttachmentPath is relative from server root
        fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.warn(`Could not delete attachment file ${filePath}:`, unlinkErr);
            else console.log(`Deleted attachment file ${filePath}`);
        });
    }
    db.query('DELETE FROM Tasks WHERE Id = ?', [id], (deleteErr, result) => {
        if (deleteErr) { console.error(`❌ Delete error on /api/tasks/${id}:`, deleteErr.message); return res.status(500).json({ message: 'Failed to delete task', error: deleteErr.message }); }
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Task not found' });
        res.status(200).json({ message: '🗑️ Task deleted successfully' });
    });
  });
});

// --- NEW: Endpoint for Task Attachment Upload ---
app.post('/api/tasks/:taskId/upload-attachment', (req, res) => {
  taskAttachmentUpload(req, res, function (err) {
    const taskId = req.params.taskId;
    if (err instanceof multer.MulterError) {
      console.error(`Multer error uploading for task ${taskId}:`, err);
      return res.status(400).json({ message: `File upload error: ${err.message}` });
    } else if (err) {
      console.error(`Unknown error uploading for task ${taskId}:`, err);
      return res.status(500).json({ message: `File upload failed: ${err.message}` });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No file was uploaded or file type is not allowed.' });
    }

    const fileName = req.file.filename;
    // Store path relative to the 'public' folder for client access
    const filePath = `/public/attachments/tasks/${fileName}`;

    // Update the task record in the database with attachment info
    const sql = "UPDATE Tasks SET AttachmentName = ?, AttachmentPath = ? WHERE Id = ?";
    db.query(sql, [req.file.originalname, filePath, taskId], (dbErr, result) => {
      if (dbErr) {
        console.error(`DB error updating task ${taskId} with attachment:`, dbErr);
        // Attempt to delete the uploaded file if DB update fails
        fs.unlink(req.file.path, (unlinkErr) => {
          if (unlinkErr) console.error("Error deleting orphaned attachment file:", unlinkErr);
        });
        return res.status(500).json({ message: 'Failed to save attachment details to database.' });
      }
      if (result.affectedRows === 0) {
        fs.unlink(req.file.path, (unlinkErr) => {
          if (unlinkErr) console.error("Error deleting orphaned attachment file for non-existent task:", unlinkErr);
        });
        return res.status(404).json({ message: 'Task not found to associate attachment with.' });
      }
      res.status(200).json({
        message: 'Attachment uploaded and linked successfully!',
        fileName: req.file.originalname, // Send original name for display
        filePath: filePath // Send server-relative path for client to construct URL
      });
    });
  });
});

// --- NEW: Endpoint for Task Text Submission ---
app.post('/api/tasks/:taskId/submit-text', (req, res) => {
  const { taskId } = req.params;
  const { submissionText } = req.body;

  if (submissionText === undefined || submissionText === null) {
    return res.status(400).json({ message: 'Submission text is required.' });
  }
  // Optional: Add validation for submissionText length, etc.

  const sql = "UPDATE Tasks SET SubmissionText = ? WHERE Id = ?";
  db.query(sql, [submissionText, taskId], (err, result) => {
    if (err) {
      console.error(`DB error updating task ${taskId} with text submission:`, err);
      return res.status(500).json({ message: 'Failed to save text submission.' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Task not found.' });
    }
    res.status(200).json({ message: 'Text submission saved successfully!' });
  });
});


const formatDateForDB = (dateStr) => {
  if (!dateStr || dateStr === "0000-00-00" || dateStr === "") return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      if (typeof dateStr === 'number' && dateStr > 25568 && dateStr < 50000) { // Excel date number check
        const excelEpoch = new Date(1899, 11, 30);
        const correctDate = new Date(excelEpoch.getTime() + (dateStr -1) * 24 * 60 * 60 * 1000);
        if(!isNaN(correctDate.getTime())) return correctDate.toISOString().split('T')[0];
      }
      return null;
    }
    return date.toISOString().split('T')[0];
  } catch (e) { return null; }
};

// ===== STUDENTS API =====
app.post('/api/student-login', async (req, res) => {
  const { username: providedUsername, password: providedPassword } = req.body;

  if (!providedUsername || !providedPassword) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  try {
    const [rows] = await db.promise().query(
      `SELECT AdmissionNo, FullName, Username, Password, Phone, DATE_FORMAT(DOB, '%d/%m/%Y') as FormattedDOB 
       FROM Students 
       WHERE Username = ? OR Phone = ?`,
      [providedUsername, providedUsername]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    let matchedStudent = null;
    for (const student of rows) {
      if (student.Username === providedUsername && student.Password === providedPassword) {
        matchedStudent = student;
        break;
      }
      if (student.Phone === providedUsername && student.FormattedDOB === providedPassword) {
        matchedStudent = student;
        break;
      }
    }

    if (matchedStudent) {
      res.status(200).json({
        id: matchedStudent.AdmissionNo,
        name: matchedStudent.FullName,
        username: matchedStudent.Username || matchedStudent.Phone,
        role: 'student',
        managedClasses: []
      });
    } else {
      res.status(401).json({ message: 'Invalid credentials.' });
    }
  } catch (error) {
    console.error('❌ Student Login API Error:', error);
    res.status(500).json({ message: 'An error occurred during student login.' });
  }
});
// --- Add a New Student ---
app.post('/api/add-student', (req, res) => {
  const s = req.body;

  // --- Logic for default credentials (this part is already correct) ---
  const finalUsername = (s.username && s.username.trim() !== '') ? s.username.trim() : s.phone;
  let finalPassword = (s.password && s.password.trim() !== '') ? s.password.trim() : null;
  if (!finalPassword && s.dob) {
    try {
      finalPassword = format(new Date(s.dob), 'dd/MM/yyyy');
    } catch (e) {
      console.error("Could not format DOB for default password:", e);
      finalPassword = null;
    }
  }

  const sql = `INSERT INTO Students (SrNo, AdmissionDate, AdmissionNo, FullName, FathersName, MothersName, DOB, Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section, Username, Password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [s.srNo, formatDateForDB(s.admissionDate), s.admissionNo, s.fullName, s.fathersName, s.mothersName, formatDateForDB(s.dob), s.address, s.phone, s.whatsapp || s.phone, s.classAdmitted, s.currentClass, s.section, finalUsername, finalPassword];
  
  db.query(sql, values, (err, result) => {
    if (err) {
      console.error("Error adding student:", err.message);
      return res.status(500).json({ message: 'Add student failed', error: err.message });
    }

    // --- THIS IS THE KEY CHANGE ---
    // Create the full student object to send back to the frontend.
    const newStudent = {
      ...s,
      SrNo: s.srNo,
      AdmissionDate: formatDateForDB(s.admissionDate),
      DOB: formatDateForDB(s.dob),
      Username: finalUsername, // Send back the generated or provided username
      Password: finalPassword, // Send back the generated or provided password
    };

    // Respond with a success message AND the complete student object.
    res.status(201).json({ message: '✅ Student added', student: newStudent });
  });
});
// --- Get All Students ---
app.get('/api/get-students', (req, res) => {
  db.query('SELECT *, DATE_FORMAT(AdmissionDate, "%Y-%m-%d") as AdmissionDate, DATE_FORMAT(DOB, "%Y-%m-%d") as DOB FROM Students ORDER BY SrNo ASC', (err, results) => {
    if (err) return res.status(500).json({ message: 'Student fetch failed', error: err.message });
    res.status(200).json(results);
  });
});
// --- Update a Student ---
app.put('/api/update-student', (req, res) => {
  const s = req.body;
  if (!s.admissionNo) {
    return res.status(400).json({ message: 'AdmissionNo is required.' });
  }
  
  const sql = `UPDATE Students SET 
    SrNo = ?, AdmissionDate = ?, FullName = ?, FathersName = ?, MothersName = ?, 
    DOB = ?, Address = ?, Phone = ?, Whatsapp = ?, ClassAdmitted = ?, CurrentClass = ?, Section = ?, 
    Username = ?, Password = ? 
    WHERE AdmissionNo = ?`;
    
  const values = [
    s.srNo, formatDateForDB(s.admissionDate), s.fullName, s.fathersName, s.mothersName, 
    formatDateForDB(s.dob), s.address, s.phone, s.whatsapp || s.phone, s.classAdmitted, s.currentClass, s.section,
    s.username, s.password, // The new fields
    s.admissionNo
  ];
  
  db.query(sql, values, (err, result) => {
    if (err) {
      console.error("Error updating student:", err.message);
      return res.status(500).json({ message: 'Student update failed', error: err.message });
    }
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Student not found.' });
    res.status(200).json({ message: '✅ Student updated successfully' });
  });
});
// --- Delete a Student ---
app.delete('/api/delete-student/:admissionNo', (req, res) => {
  const { admissionNo } = req.params;
  db.query('DELETE FROM Students WHERE AdmissionNo = ?', [admissionNo], (err, result) => {
    if (err) return res.status(500).json({ message: 'Student delete failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Student not found' });
    res.status(200).json({ message: '✅ Student deleted' });
  });
});

// ===== TEACHERS API =====
app.post('/api/import-teachers', async (req, res) => {
  const { teachers } = req.body;
  if (!Array.isArray(teachers) || teachers.length === 0) return res.status(400).json({ message: 'No teacher data provided or invalid format.' });
  let successfulInserts = 0, skippedExisting = 0, failedOperations = 0;
  const errors = [], infoMessages = [];
  for (const [index, teacherData] of teachers.entries()) {
    const { teacherID: excelTeacherID, fullName, fathersName, qualification, dateOfBirth, dateOfJoining, phone, whatsapp, type, username: usernameFromFile, password: passwordFromFile, assignedClasses } = teacherData;
    if (!fullName || !type) { errors.push(`Row ${index + 2}: Missing FullName or Type. Skipping.`); failedOperations++; continue; }
    const validTypes = ['Teaching', 'Non-Teaching', 'Admin', 'Principal']; let finalType = type;
    if (!validTypes.includes(type)) { infoMessages.push(`Row ${index + 2} (Name: ${fullName}): Invalid Type '${type}'. Defaulting to 'Teaching'.`); finalType = 'Teaching'; }
    const role = (finalType === 'Admin' || finalType === 'Principal') ? 'admin' : 'teacher';
    const dbPassword = (passwordFromFile && String(passwordFromFile).trim() !== "") ? String(passwordFromFile).trim() : null;
    const formattedDob = formatDateForDB(dateOfBirth), formattedDoj = formatDateForDB(dateOfJoining);
    try {
        let foundExistingTeacher = false, existingTeacherDetails = "";
        if (excelTeacherID) { const [rowsById] = await db.promise().query('SELECT Id FROM Teachers WHERE Id = ?', [excelTeacherID]); if (rowsById.length > 0) { foundExistingTeacher = true; existingTeacherDetails = `with matching ID: ${rowsById[0].Id}`; }}
        if (!foundExistingTeacher && usernameFromFile) { const [rowsByUsername] = await db.promise().query('SELECT Id, Username FROM Teachers WHERE Username = ?', [usernameFromFile]); if (rowsByUsername.length > 0) { foundExistingTeacher = true; existingTeacherDetails = `with matching Username: '${rowsByUsername[0].Username}'`; }}
        if (!foundExistingTeacher && fullName && formattedDob) { const [rowsByNameDob] = await db.promise().query('SELECT Id FROM Teachers WHERE FullName = ? AND DateOfBirth = ?', [fullName, formattedDob]); if (rowsByNameDob.length > 0) { foundExistingTeacher = true; existingTeacherDetails = `with matching Name and DOB`; }}
        if (foundExistingTeacher) { infoMessages.push(`Row ${index + 2} (Name: ${fullName}): Skipped. An existing teacher was found ${existingTeacherDetails}.`); skippedExisting++; continue; }
    } catch (findErr) { errors.push(`Row ${index + 2} (Name: ${fullName}): Error checking for existing teacher - ${findErr.message}`); failedOperations++; console.error("Error finding teacher:", findErr); continue; }
    try {
      const tempUsernameForInsert = `_new_${Date.now()}_${index}`;
      const insertSql = `INSERT INTO Teachers (FullName, FathersName, Qualification, DateOfBirth, DateOfJoining, Phone, Whatsapp, Type, Username, Password, Role, ManagedClasses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const [insertResult] = await db.promise().query(insertSql, [fullName, fathersName || null, qualification || null, formattedDob, formattedDoj, phone || null, whatsapp || phone || null, finalType, tempUsernameForInsert, dbPassword, role, JSON.stringify(assignedClasses || [])]);
      const newTeacherId = insertResult.insertId;
      if (newTeacherId) { const finalUsername = `teacher${newTeacherId}`; await db.promise().query('UPDATE Teachers SET Username = ? WHERE Id = ?', [finalUsername, newTeacherId]); infoMessages.push(`Row ${index + 2} (Name: ${fullName}): Added as new teacher (ID: ${newTeacherId}). Username set to ${finalUsername}.`); successfulInserts++; }
      else { throw new Error("Insert operation did not return a new ID."); }
    } catch (insertErr) { let errMsg = insertErr.message; if (insertErr.code === 'ER_DUP_ENTRY') errMsg = `Duplicate entry error during insert. ${insertErr.message}`; errors.push(`Row ${index + 2} (Name: ${fullName}): Error adding new teacher - ${errMsg}`); failedOperations++; console.error(`Error inserting new teacher ${fullName}:`, insertErr); }
  }
  res.status(200).json({ message: 'Import process completed.', successfulInserts, skippedExisting, failedOperations, errors, infoMessages });
});
app.get('/api/get-teachers', (req, res) => {
  const sql = `SELECT Id, FullName, FathersName, Qualification, DateOfBirth, DateOfJoining, Phone, Whatsapp, Type, Username, Role, ManagedClasses FROM Teachers ORDER BY DateOfJoining DESC`;
  db.query(sql, (err, results) => {
    if (err) { console.error('❌ Error fetching teachers:', err.message); return res.status(500).json({ message: 'Teacher fetch failed', error: err.message }); }
    res.status(200).json(results);
  });
});
app.post('/api/add-teacher', (req, res) => {
  const t = req.body; if (!t.fullName || !t.username || !t.password || !t.type) return res.status(400).json({ message: 'Full Name, Username, Password, and Type are required.' });
  const role = (t.type === 'Admin' || t.type === 'Principal') ? 'admin' : 'teacher';
  const sql = `INSERT INTO Teachers (FullName, FathersName, Qualification, DateOfBirth, DateOfJoining, Phone, Whatsapp, Type, Username, Password, Role, ManagedClasses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [t.fullName, t.fathersName || null, t.qualification || null, formatDateForDB(t.dateOfBirth), formatDateForDB(t.dateOfJoining), t.phone || null, t.whatsapp || t.phone || null, t.type, t.username, t.password, role, JSON.stringify(t.assignedClasses || [])];
  db.query(sql, values, (err, result) => {
    if (err) { if(err.code === 'ER_DUP_ENTRY'){ if (err.message.toLowerCase().includes('username')) return res.status(409).json({ message: 'This username is already taken.' }); return res.status(409).json({ message: 'Failed to add teacher. A similar record might already exist.' });} console.error('❌ Error adding teacher:', err.message, "Input:", t); return res.status(500).json({ message: 'Teacher insert failed', error: err.message }); }
    const insertedTeacherData = { id: result.insertId, fullName: t.fullName, fathersName: t.fathersName || null, qualification: t.qualification || null, dateOfBirth: formatDateForDB(t.dateOfBirth), dateOfJoining: formatDateForDB(t.dateOfJoining), phone: t.phone || null, whatsapp: t.whatsapp || t.phone || null, type: t.type, username: t.username, role: role, managedClasses: t.assignedClasses || [] };
    res.status(201).json({ message: '✅ Teacher added successfully', teacher: insertedTeacherData });
  });
});
app.put('/api/update-teacher', (req, res) => {
  const t = req.body; const teacherId = t.id; if (!teacherId) return res.status(400).json({ message: 'Teacher ID (as "id") is required for an update.' });
  const fieldsToUpdate = [], sqlValues = []; const fieldMap = { fullName: 'FullName', fathersName: 'FathersName', qualification: 'Qualification', dateOfBirth: 'DateOfBirth', dateOfJoining: 'DateOfJoining', phone: 'Phone', whatsapp: 'Whatsapp', type: 'Type', username: 'Username', password: 'Password', assignedClasses: 'ManagedClasses' };
  for (const key in t) {
    if (key === 'id') continue; if (t.hasOwnProperty(key) && fieldMap[key]) {
      let value = t[key]; const dbColumn = fieldMap[key]; if (key === 'password' && value === '') continue;
      if (key === 'type') { fieldsToUpdate.push('Role = ?'); sqlValues.push((value === 'Admin' || value === 'Principal') ? 'admin' : 'teacher'); }
      fieldsToUpdate.push(`${dbColumn} = ?`);
      if (key === 'dateOfBirth' || key === 'dateOfJoining') sqlValues.push(formatDateForDB(value));
      else if (key === 'whatsapp' && value === '') sqlValues.push(null);
      else if (key === 'whatsapp' && value === t.phone && key !== 'phone') sqlValues.push(t.phone || null);
      else if (key === 'assignedClasses') sqlValues.push(JSON.stringify(value || [])); else sqlValues.push(value);
    }
  }
  if (fieldsToUpdate.length === 0) return res.status(200).json({ message: 'No valid fields provided for update or only ID was sent.' });
  sqlValues.push(teacherId); const sql = `UPDATE Teachers SET ${fieldsToUpdate.join(', ')} WHERE Id = ?`;
  db.query(sql, sqlValues, (err, result) => {
    if (err) { if (err.code === 'ER_DUP_ENTRY') { if (err.message.toLowerCase().includes('username')) return res.status(409).json({ message: 'That username is already taken by another teacher.' }); return res.status(409).json({ message: 'Update failed. A unique field (e.g., username) might be duplicated.' });} console.error('❌ Error updating teacher:', err.message, "Input:", t, "SQL:", sql, "Values:", sqlValues); return res.status(500).json({ message: 'Teacher update failed', error: err.message }); }
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
app.use((req, res) => { res.status(404).json({ message: `❌ Route not found: ${req.method} ${req.originalUrl}`}); });
// ==== Global Error Handler ====
app.use((err, req, res, next) => { console.error("💥 GLOBAL ERROR HANDLER:", err.stack); res.status(500).json({ message: "❌ An unexpected server error occurred." }); });
// ==== Start Server ====
app.listen(PORT, () => { console.log(`🚀 Server running on http://localhost:${PORT}`); });