const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mysql = require('mysql2');
require('dotenv').config();


const { format, subDays } = require('date-fns');
const { toDate, zonedTimeToUtc } = require('date-fns-tz');

// 1. Create the Express App FIRST
const app = express();
const PORT = process.env.PORT || 5000;

// 2. Import local modules & routers
const db = require('./dbconfig.js');
const diaryRoutes = require('./routes/diary.js')(db);
const { registerTaskRoutes } = require('./routes/TasksAPI.js');
const { initializeDynamicScheduler } = require('./routes/dynamicTaskScheduler');
const dashboardRoutes = require('./routes/DashboardAPI.js')(db);
const teacherRoutes = require('./routes/TeachersAPI.js')(db);

// 3. Use Middleware & Mount Routers
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount all your API routers together for clarity
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/diary', diaryRoutes);
app.use('/api', teacherRoutes);

const publicDir = path.join(__dirname, 'public');
const attachmentsDir = path.join(publicDir, 'attachments', 'tasks');
const studentPhotosDir = path.join(publicDir, 'uploads', 'students');

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
  console.log(`✅ Created public directory: ${publicDir}`);
}
if (!fs.existsSync(attachmentsDir)) {
  fs.mkdirSync(attachmentsDir, { recursive: true });
  console.log(`✅ Created attachments directory: ${attachmentsDir}`);
}
if (!fs.existsSync(studentPhotosDir)) {
  fs.mkdirSync(studentPhotosDir, { recursive: true });
  console.log(`✅ Created student photos directory: ${studentPhotosDir}`);
}

app.use('/public', express.static(publicDir));

db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to MySQL Database Pool');
    connection.release();
  }
});

app.get('/api/get-activity-logs', async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const offset = (page - 1) * limit;

  try {
      // Query to get the total number of logs for pagination
      const [[{ totalItems }]] = await db.promise().query('SELECT COUNT(*) as totalItems FROM ActivityLogs');
      
      // Query to get the logs for the current page
      const [logs] = await db.promise().query('SELECT * FROM ActivityLogs ORDER BY Timestamp DESC LIMIT ? OFFSET ?', [limit, offset]);
      
      res.status(200).json({
          logs,
          totalPages: Math.ceil(totalItems / limit),
          currentPage: page
      });
  } catch (error) {
      console.error('❌ Error fetching activity logs:', error.message);
      res.status(500).json({ message: 'Failed to fetch activity logs', error: error.message });
  }
});


const logStudentActivity = async (actionType, performedBy, targetAdmissionNo, targetName, details = '') => {
  const sql = `
    INSERT INTO StudentActivityLogs (ActionType, PerformedBy, TargetAdmissionNo, TargetName, Details) 
    VALUES (?, ?, ?, ?, ?)`;
  try {
    await db.promise().query(sql, [actionType, performedBy, targetAdmissionNo, targetName, details]);
  } catch (error) {
    console.error('❌ Failed to log student activity:', error.message);
  }
};

const studentPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, studentPhotosDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `student-photo-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const studentPhotoUpload = multer({ storage: studentPhotoStorage });
app.post('/api/upload-photo', studentPhotoUpload.single('profilePhoto'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const filePath = path.join('/public/uploads/students', req.file.filename).replace(/\\/g, '/');
  res.status(200).json({ filePath: filePath });
});


app.post('/api/upload-photo', studentPhotoUpload.single('profilePhoto'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }

  const filePath = path.join('/public/uploads/students', req.file.filename).replace(/\\/g, '/');

  res.status(200).json({ filePath: filePath });
});

app.post('/api/student-login', async (req, res) => {
  const { username, password: providedPassword } = req.body;

  if (!username || !providedPassword) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  try {
    // Query the Students table for a matching username
    const [rows] = await db.promise().query(
      'SELECT AdmissionNo, FullName, Username, Password FROM Students WHERE Username = ?',
      [username]
    );

    // If no student with that username is found, return an error
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const student = rows[0];
    const dbPassword = student.Password;

    // Compare the provided password with the one from the database
    if (providedPassword === dbPassword) {
      // If passwords match, create the user data object for the frontend
      const userData = {
        id: student.AdmissionNo, // Use AdmissionNo as the unique ID for students
        name: student.FullName,
        username: student.Username,
        role: 'student', // Hardcode the role as 'student'
        managedClasses: [], // Students do not manage classes
      };
      // Send a success response with the user data
      res.status(200).json(userData);
    } else {
      // If passwords do not match, return an error
      res.status(401).json({ message: 'Invalid username or password.' });
    }
  } catch (error) {
    console.error('❌ Student Login API Error:', error);
    res.status(500).json({ message: 'An error occurred during the login process.' });
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
      isMatch = (providedPassword === dbPassword); 
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
    const { classes } = req.query;

    if (!classes) {
        return res.status(400).json({ message: "Managed classes are required." });
    }

    try {
        const classList = classes.split(',');
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
  const classes = decodedClassesString.split(',');

  if (!teacherId || !classes || !classes.length) {
    return res.status(400).json({ message: "Teacher ID and managed classes are required." });
  }

  const classPlaceholders = classes.map(() => '?').join(',');

  try {
    const [studentIdRows] = await db.promise().query(
      `SELECT AdmissionNo FROM Students WHERE CONCAT(CurrentClass, '-', Section) IN (${classPlaceholders})`,
      classes
    );
    
    if (studentIdRows.length === 0) {
        return res.json({ totalStudents: 0, totalTasks: 0, completedTasks: 0, pendingTasks: 0, inProgressOrOverdue: 0, presentStudents: 0, absentStudents: 0, onLeaveStudents: 0 });
    }

    const studentAdmissionNumbers = studentIdRows.map(row => row.AdmissionNo);
    const totalStudents = studentAdmissionNumbers.length;

    const [[taskStats]] = await db.promise().query(
      `SELECT
         COUNT(Id) as totalTasks,
         SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) as completedTasks,
         SUM(CASE WHEN Status IN ('Pending', 'Not Started') THEN 1 ELSE 0 END) as pendingTasks
       FROM Tasks WHERE AssignedTo REGEXP ?`,
      [`[[:<:]]${teacherId}[[:>:]]`]
    );

    const [[latestDateData]] = await db.promise().query(
      'SELECT MAX(AttendanceDate) as latestDate FROM Attendance WHERE StudentAdmissionNo IN (?)',
      [studentAdmissionNumbers]
    );

    let attendanceData = { presentStudents: 0, absentStudents: 0, onLeaveStudents: 0 };
    if (latestDateData && latestDateData.latestDate) {
      const latestDate = latestDateData.latestDate;
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
      const teacher = rows[0];
      try {
        teacher.ManagedClasses = JSON.parse(teacher.ManagedClasses || '[]');
      } catch (e) {
        teacher.ManagedClasses = [];
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

app.put('/api/teacher/change-password', async (req, res) => {
  const { teacherId, currentPassword, newUsername, newPassword } = req.body;

  if (!teacherId || !currentPassword || !newPassword || !newUsername) {
      return res.status(400).json({ message: "All fields are required." });
  }

  try {
      const [rows] = await db.promise().query('SELECT Password FROM Teachers WHERE Id = ?', [teacherId]);
      if (rows.length === 0) {
          return res.status(404).json({ message: "User not found." });
      }
      
      const storedPassword = rows[0].Password;

      if (currentPassword !== storedPassword) {
          return res.status(401).json({ message: "Incorrect current password." });
      }

      await db.promise().query(
          'UPDATE Teachers SET Username = ?, Password = ? WHERE Id = ?', 
          [newUsername, newPassword, teacherId]
      );

      res.status(200).json({ message: "✅ Credentials updated successfully!" });

  } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' && error.message.includes('Username')) {
          return res.status(409).json({ message: 'That username is already taken. Please choose another.' });
      }
      console.error(`Error changing credentials for teacher ${teacherId}:`, error);
      res.status(500).json({ message: "Failed to update credentials." });
  }
});

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
  const today = format(new Date(), 'yyyy-MM-dd');

  try {
    const [rows] = await db.promise().query(
      'SELECT Status FROM Attendance WHERE StudentAdmissionNo = ? AND AttendanceDate = ?',
      [admissionNo, today]
    );

    if (rows.length > 0) {
      res.status(200).json({ status: rows[0].Status });
    } else {
      res.status(200).json({ status: 'Not Marked' });
    }
  } catch (error) {
    console.error(`Error fetching today's attendance for ${admissionNo}:`, error);
    res.status(500).json({ message: "Failed to fetch today's attendance" });
  }
});

app.get('/api/student/attendance/:admissionNo', async (req, res) => {
  const { admissionNo } = req.params;
  try {
    const [attendanceRows] = await db.promise().query(
      'SELECT DATE_FORMAT(AttendanceDate, "%Y-%m-%d") as AttendanceDate, Status FROM Attendance WHERE StudentAdmissionNo = ?',
      [admissionNo]
    );

    const attendanceMap = attendanceRows.reduce((acc, row) => {
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
    const dayOfWeek = new Date(date).getUTCDay();
    if (dayOfWeek === 0) {
      return res.status(200).json({ isSchoolOff: true, reason: 'Weekly Off' });
    }

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
app.put('/api/student/settings/update-credentials', async (req, res) => {
  const { admissionNo, newUsername, newPassword } = req.body;

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


registerTaskRoutes(app, db);
initializeDynamicScheduler(db);


const formatDateForDB = (dateStr) => {
  if (!dateStr || dateStr === "0000-00-00" || dateStr === "") return null;
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      if (typeof dateStr === 'number' && dateStr > 25568 && dateStr < 50000) {
        const excelEpoch = new Date(1899, 11, 30);
        const correctDate = new Date(excelEpoch.getTime() + (dateStr - 1) * 24 * 60 * 60 * 1000);
        if(!isNaN(correctDate.getTime())) return correctDate.toISOString().split('T')[0];
      }
      return null;
    }
    return date.toISOString().split('T')[0];
  } catch (e) { return null; }
};

app.post('/api/add-student', async (req, res) => {
  const s = req.body;
  const sql = `INSERT INTO Students (SrNo, AdmissionDate, AdmissionNo, FullName, FathersName, MothersName, DOB, Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section, Username, Password, ProfilePhotoUrl, IsActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [
    s.srNo, formatDateForDB(s.admissionDate), s.admissionNo, s.fullName, s.fathersName,
    s.mothersName, formatDateForDB(s.dob), s.address, s.phone, s.whatsapp || s.phone,
    s.classAdmitted, s.currentClass, s.section, s.username || s.phone, s.password || null, s.profilePhotoUrl || null,
    (s.isActive === 'true' || s.isActive === true) ? 1 : 0
  ];

  try {
    const [result] = await db.promise().query(sql, values);
    const newStudent = { ...s, id: result.insertId };
    await logStudentActivity('CREATE', 'Admin', s.admissionNo, s.fullName, 'New student record created.');
    res.status(201).json({ message: '✅ Student added', student: newStudent });
  } catch (err) {
    console.error("Error adding student:", err.message);
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Admission Number or Username already exists.' });
    return res.status(500).json({ message: 'Add student failed', error: err.message });
  }
});

app.get('/api/get-students', (req, res) => {
  const sql = `SELECT *, ProfilePhotoUrl, DATE_FORMAT(AdmissionDate, "%Y-%m-%d") as AdmissionDate, DATE_FORMAT(DOB, "%Y-%m-%d") as DOB FROM Students ORDER BY SrNo ASC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: 'Student fetch failed', error: err.message });
    res.status(200).json(results);
  });
});

app.put('/api/update-student', async (req, res) => {
    const { admissionNo, ...updatedFields } = req.body;
    if (!admissionNo) return res.status(400).json({ message: "Admission number is required for update." });
  
    try {
      const [[oldStudent]] = await db.promise().query('SELECT * FROM Students WHERE AdmissionNo = ?', [admissionNo]);
      if (!oldStudent) return res.status(404).json({ message: "Student not found." });
  
      const changes = [];
      const setClauses = [];
      const queryValues = [];
      
      const compareAndUpdate = (fieldName, dbColumn, label, isDate = false) => {
        if (updatedFields[fieldName] !== undefined) {
          let newValue = isDate ? formatDateForDB(updatedFields[fieldName]) : updatedFields[fieldName];
          let oldValue = isDate ? formatDateForDB(oldStudent[dbColumn]) : oldStudent[dbColumn];
          if (String(newValue) !== String(oldValue)) {
            changes.push(`${label} updated`);
            setClauses.push(`${dbColumn} = ?`);
            queryValues.push(newValue);
          }
        }
      };

      compareAndUpdate('srNo', 'SrNo', 'Sr. No.');
      compareAndUpdate('admissionDate', 'AdmissionDate', 'Admission Date', true);
      compareAndUpdate('fullName', 'FullName', 'Full Name');
      compareAndUpdate('fathersName', 'FathersName', "Father's Name");
      compareAndUpdate('mothersName', 'MothersName', "Mother's Name");
      compareAndUpdate('dob', 'DOB', 'Date of Birth', true);
      compareAndUpdate('address', 'Address', 'Address');
      compareAndUpdate('phone', 'Phone', 'Phone');
      compareAndUpdate('whatsapp', 'Whatsapp', 'WhatsApp');
      compareAndUpdate('classAdmitted', 'ClassAdmitted', 'Class Admitted');
      compareAndUpdate('currentClass', 'CurrentClass', 'Current Class');
      compareAndUpdate('section', 'Section', 'Section');
      compareAndUpdate('username', 'Username', 'Username');
      compareAndUpdate('profilePhotoUrl', 'ProfilePhotoUrl', 'Profile Photo');
      
      if (updatedFields.password && updatedFields.password.trim() !== '') {
        changes.push('Password updated');
        setClauses.push('Password = ?');
        queryValues.push(updatedFields.password);
      }
      
      const newIsActive = (updatedFields.isActive === 'true' || updatedFields.isActive === true) ? 1 : 0;
      if (newIsActive !== oldStudent.IsActive) {
        changes.push(`Status changed to ${newIsActive ? 'Active' : 'Inactive'}`);
        setClauses.push('IsActive = ?');
        queryValues.push(newIsActive);
        if (newIsActive === 0 && !oldStudent.DateOfInactive) {
            setClauses.push('DateOfInactive = CURDATE()');
        } else if (newIsActive === 1) {
            setClauses.push('DateOfInactive = NULL');
        }
      }
  
      if (setClauses.length === 0) return res.status(200).json({ message: "No changes were made.", student: oldStudent });
  
      queryValues.push(admissionNo);
      const sql = `UPDATE Students SET ${setClauses.join(', ')} WHERE AdmissionNo = ?`;
      await db.promise().query(sql, queryValues);
  
      const [updatedStudentRows] = await db.promise().query(`SELECT * FROM Students WHERE AdmissionNo = ?`, [admissionNo]);
      await logStudentActivity('UPDATE', 'Admin', admissionNo, updatedFields.fullName || oldStudent.FullName, changes.join('; '));
  
      res.status(200).json({ message: "✅ Student updated successfully!", student: updatedStudentRows[0] });
  
    } catch (error) {
      console.error("Error updating student:", error);
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Username is already taken.' });
      res.status(500).json({ message: "Failed to update student data." });
    }
});

app.post('/api/students/batch-import', async (req, res) => {
    const studentsToImport = req.body;
    if (!Array.isArray(studentsToImport) || studentsToImport.length === 0) {
        return res.status(400).json({ message: 'No student data provided.' });
    }

    let successCount = 0;
    const errors = [];
    
    for (const s of studentsToImport) {
        const sql = `INSERT INTO Students (SrNo, AdmissionDate, AdmissionNo, FullName, FathersName, MothersName, DOB, Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section, Username, Password, IsActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [
            s['SrNo'] || null, formatDateForDB(s['AdmissionDate']), s['AdmissionNo'], s['FullName'],
            s['FathersName'] || null, s['MothersName'] || null, formatDateForDB(s['DOB']),
            s['Address'] || null, s['Phone'] || null, s['Whatsapp'] || s['Phone'] || null,
            s['ClassAdmitted'] || null, s['CurrentClass'] || null, s['Section'] || null,
            s['Username'] || s['Phone'] || s['AdmissionNo'], s['Password'] || null,
            (s['IsActive'] === 0 || String(s['IsActive']).toLowerCase() === 'false') ? 0 : 1,
        ];

        try {
            await db.promise().query(sql, values);
            await logStudentActivity('CREATE', 'Admin (Batch)', s.AdmissionNo, s.FullName, 'Student record created via Excel import.');
            successCount++;
        } catch (err) {
            errors.push(`Admission No ${s.AdmissionNo || '(missing)'}: ${err.code === 'ER_DUP_ENTRY' ? 'Already exists.' : err.message}`);
        }
    }

    res.status(201).json({
        message: `Import complete. ${successCount} added, ${errors.length} failed.`,
        errors
    });
});

app.get('/api/student-activity-logs', async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const offset = (page - 1) * limit;

    try {
        const [[{ totalItems }]] = await db.promise().query('SELECT COUNT(*) as totalItems FROM StudentActivityLogs');
        const [logs] = await db.promise().query('SELECT * FROM StudentActivityLogs ORDER BY Timestamp DESC LIMIT ? OFFSET ?', [limit, offset]);
        
        res.status(200).json({
            logs,
            totalPages: Math.ceil(totalItems / limit),
            currentPage: page
        });
    } catch (error) {
        console.error('❌ Error fetching student activity logs:', error.message);
        res.status(500).json({ message: 'Failed to fetch student activity logs' });
    }
});

app.delete('/api/delete-student/:admissionNo', (req, res) => {
  const { admissionNo } = req.params;
  db.query('DELETE FROM Students WHERE AdmissionNo = ?', [admissionNo], (err, result) => {
    if (err) return res.status(500).json({ message: 'Student delete failed', error: err.message });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Student not found' });
    res.status(200).json({ message: '✅ Student deleted' });
  });
});


app.use((req, res) => { res.status(404).json({ message: `❌ Route not found: ${req.method} ${req.originalUrl}`}); });
app.use((err, req, res, next) => { console.error("💥 GLOBAL ERROR HANDLER:", err.stack); res.status(500).json({ message: "❌ An unexpected server error occurred." }); });
app.listen(PORT, () => { console.log(`🚀 Server running on http://localhost:${PORT}`); });