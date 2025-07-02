const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mysql = require('mysql2');
const db = require('./dbconfig.js');
const diaryRoutes = require('./routes/diary.js')(db);
const { registerTaskRoutes } = require('./routes/TasksAPI.js');
const { initializeDynamicScheduler } = require('./routes/dynamicTaskScheduler');

require('dotenv').config();

const { format, subDays } = require('date-fns');
const { toDate, zonedTimeToUtc } = require('date-fns-tz');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const studentPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, studentPhotosDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, `student-photo-${uniqueSuffix}${extension}`);
  }
});

const studentPhotoUpload = multer({ storage: studentPhotoStorage });

app.post('/api/upload-photo', studentPhotoUpload.single('profilePhoto'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded.' });
  }

  const filePath = path.join('/public/uploads/students', req.file.filename).replace(/\\/g, '/');

  res.status(200).json({ filePath: filePath });
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
app.use('/api/diary', diaryRoutes);


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

app.post('/api/add-student', (req, res) => {
  const s = req.body;

  const finalUsername = (s.username && s.username.trim() !== '') ? s.username.trim() : s.phone;
  let finalPassword = (s.password && s.password.trim() !== '') ? s.password.trim() : null;
  if (!finalPassword && s.dob) {
    try { finalPassword = format(new Date(s.dob), 'dd/MM/yyyy'); }
    catch (e) { finalPassword = null; }
  }

  const sql = `INSERT INTO Students (SrNo, AdmissionDate, AdmissionNo, FullName, FathersName, MothersName, DOB, Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section, Username, Password, ProfilePhotoUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [s.srNo, formatDateForDB(s.admissionDate), s.admissionNo, s.fullName, s.fathersName, s.mothersName, formatDateForDB(s.dob), s.address, s.phone, s.whatsapp || s.phone, s.classAdmitted, s.currentClass, s.section, finalUsername, finalPassword, s.profilePhotoUrl || null];
  
  db.query(sql, values, (err, result) => {
    if (err) {
      console.error("Error adding student:", err.message);
      if (err.code === 'ER_DUP_ENTRY' && err.message.includes('AdmissionNo')) {
        return res.status(409).json({ message: 'Admission Number already exists. Please use a unique number.' });
      }
      if (err.code === 'ER_DUP_ENTRY' && err.message.includes('Username')) {
        return res.status(409).json({ message: 'The chosen username is already taken. Please choose a different one.' });
      }
      return res.status(500).json({ message: 'Add student failed', error: err.message });
    }

    const newStudent = {
      ...s,
      SrNo: s.srNo,
      AdmissionDate: formatDateForDB(s.admissionDate),
      DOB: formatDateForDB(s.dob),
      Username: finalUsername,
      Password: finalPassword,
      ProfilePhotoUrl: s.profilePhotoUrl || null,
    };

    res.status(201).json({ message: '✅ Student added', student: newStudent });
  });
});

app.get('/api/get-students', (req, res) => {
  const sql = `SELECT *, ProfilePhotoUrl, DATE_FORMAT(AdmissionDate, "%Y-%m-%d") as AdmissionDate, DATE_FORMAT(DOB, "%Y-%m-%d") as DOB FROM Students ORDER BY SrNo ASC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: 'Student fetch failed', error: err.message });
    res.status(200).json(results);
  });
});

app.put('/api/update-student', async (req, res) => {
  const { admissionNo } = req.body;

  if (!admissionNo) {
    return res.status(400).json({ message: "Admission number is required for update." });
  }

  try {
    // Step 1: Fetch the student's current data from the database. This is our trusted source.
    const [existingStudents] = await db.promise().query(
      'SELECT * FROM Students WHERE AdmissionNo = ?',
      [admissionNo]
    );

    if (existingStudents.length === 0) {
      return res.status(404).json({ message: "Student not found." });
    }

    const currentData = existingStudents[0];

    // Step 2: Prepare a new object for the update.
    // We start with the current data, ensuring no fields are accidentally erased.
    // The keys here should match your database column names (PascalCase).
    let dataToUpdate = {
      FullName: currentData.FullName,
      FathersName: currentData.FathersName,
      MothersName: currentData.MothersName,
      DOB: currentData.DOB,
      Phone: currentData.Phone,
      Whatsapp: currentData.Whatsapp,
      Address: currentData.Address,
      CurrentClass: currentData.CurrentClass,
      Section: currentData.Section,
      ProfilePhotoUrl: currentData.ProfilePhotoUrl // Start with the existing photo URL
    };

    // Step 3: Explicitly merge changes from the request body.
    // This is the most important part.
    // We check for the camelCase key from the frontend (`req.body.profilePhotoUrl`)
    // and assign its value to our PascalCase database key (`dataToUpdate.ProfilePhotoUrl`).
    
    if (req.body.profilePhotoUrl !== undefined) {
      dataToUpdate.ProfilePhotoUrl = req.body.profilePhotoUrl;
    }
    
    // (Optional but good practice) You can do the same for other fields if they are editable
    // if (req.body.FullName) dataToUpdate.FullName = req.body.FullName;
    // if (req.body.Phone) dataToUpdate.Phone = req.body.Phone;


    // Step 4: Execute the update with the complete, safe data.
    const sql = `
      UPDATE Students SET
        FullName = ?, FathersName = ?, MothersName = ?, DOB = ?,
        Phone = ?, Whatsapp = ?, Address = ?, CurrentClass = ?, Section = ?,
        ProfilePhotoUrl = ?
      WHERE AdmissionNo = ?`;

    const values = [
      dataToUpdate.FullName, dataToUpdate.FathersName, dataToUpdate.MothersName, new Date(dataToUpdate.DOB),
      dataToUpdate.Phone, dataToUpdate.Whatsapp, dataToUpdate.Address, dataToUpdate.CurrentClass, dataToUpdate.Section,
      dataToUpdate.ProfilePhotoUrl, // This now contains the correct new value
      admissionNo
    ];

    await db.promise().query(sql, values);

    res.status(200).json({ message: "Student updated successfully." });

  } catch (error) {
    console.error("Error updating student:", error);
    res.status(500).json({ message: "Failed to update student data." });
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

app.use((req, res) => { res.status(404).json({ message: `❌ Route not found: ${req.method} ${req.originalUrl}`}); });
app.use((err, req, res, next) => { console.error("💥 GLOBAL ERROR HANDLER:", err.stack); res.status(500).json({ message: "❌ An unexpected server error occurred." }); });
app.listen(PORT, () => { console.log(`🚀 Server running on http://localhost:${PORT}`); });