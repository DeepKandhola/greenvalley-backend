// routes/TeachersAPI.js

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Helper function to format dates for MySQL.
const formatDateForDB = (dateStr) => {
    if (!dateStr || dateStr === "0000-00-00" || dateStr === "") return null;
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return null;
        return date.toISOString().split('T')[0];
    } catch (e) {
        return null;
    }
};

module.exports = function(db) {
    const router = express.Router();

    const logActivity = async (actionType, performedBy, targetId, targetName, details = '') => {
        const sql = `INSERT INTO ActivityLogs (ActionType, PerformedBy, TargetID, TargetName, Details) VALUES (?, ?, ?, ?, ?)`;
        try {
            await db.promise().query(sql, [actionType, performedBy, targetId, targetName, details]);
        } catch (error) {
            console.error('❌ Failed to log activity:', error.message);
        }
    };

    const teachersPhotosDir = path.join(__dirname, '..', 'public', 'uploads', 'teachers');
    if (!fs.existsSync(teachersPhotosDir)) {
        fs.mkdirSync(teachersPhotosDir, { recursive: true });
    }
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, teachersPhotosDir),
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, `teacher-photo-${uniqueSuffix}${path.extname(file.originalname)}`);
        }
    });
    const upload = multer({ storage: storage });

    // --- FIXED: GET all active teachers for the attendance modal ---
    // Now returns 'Id' as 'TeacherID' to match the frontend config.
    router.get('/teachers', async (req, res) => {
        const sql = `SELECT Id AS TeacherID, FullName, Designation 
                     FROM Teachers 
                     WHERE Status = 'Active' 
                     ORDER BY FullName ASC`; // Simplified ordering
        try {
            const [results] = await db.promise().query(sql);
            res.status(200).json(results); // Send the flat list directly
        } catch (err) {
            console.error('❌ Error fetching teacher list:', err.message);
            res.status(500).json({ message: 'Failed to fetch teacher list', error: err.message });
        }
    });

    // GET all teachers with full details for the management table
    router.get('/get-teachers', async (req, res) => {
        const sql = `
            SELECT 
                Id, FullName, FathersName, Qualification, DATE_FORMAT(DateOfBirth, "%Y-%m-%d") as DateOfBirth, 
                DATE_FORMAT(DateOfJoining, "%Y-%m-%d") as DateOfJoining, Phone, Whatsapp, Designation, Status, 
                Username, Gender, EmailAddress, ManagedClasses, PhotoUrl, DATE_FORMAT(DateOfInactive, "%Y-%m-%d") as DateOfInactive
            FROM Teachers 
            ORDER BY FullName ASC`;
        try {
            const [results] = await db.promise().query(sql);
            res.status(200).json(results);
        } catch (err) {
            console.error('❌ Error fetching teachers:', err.message);
            res.status(500).json({ message: 'Teacher fetch failed', error: err.message });
        }
    });

    // ADD a new teacher
    router.post('/add-teacher', upload.single('photo'), async (req, res) => {
        const t = req.body;
        if (!t.fullName || !t.username || !t.designation) {
            return res.status(400).json({ message: 'Full Name, Username, and Designation are required.' });
        }
        
        const photoUrl = req.file ? path.join('/public/uploads/teachers', req.file.filename).replace(/\\/g, '/') : null;
        const password = (t.password && t.password.trim() !== "") ? t.password.trim() : 'password';
        const role = (t.designation === 'Principal' || t.designation === 'Admin') ? 'admin' : 'teacher';
        const managedClassesJson = t.assignedClasses ? t.assignedClasses : '[]';

        const sql = `INSERT INTO Teachers (FullName, FathersName, Qualification, DateOfBirth, DateOfJoining, Phone, Whatsapp, Designation, Status, Username, Password, Gender, EmailAddress, ManagedClasses, PhotoUrl, Role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [t.fullName, t.fathersName || null, t.qualification || null, formatDateForDB(t.dateOfBirth), formatDateForDB(t.dateOfJoining), t.phone || null, t.whatsapp || t.phone || null, t.designation, t.status || 'Active', t.username, password, t.gender || null, t.email || null, managedClassesJson, photoUrl, role];

        try {
            const [result] = await db.promise().query(sql, values);
            await logActivity('CREATE', 'Admin', result.insertId, t.fullName, 'New staff member was created.');
            res.status(201).json({ message: '✅ Teacher added successfully', teacherId: result.insertId });
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'This username or phone number is already taken.' });
            res.status(500).json({ message: 'Teacher insert failed', error: err.message });
        }
    });

    // --- FIXED: UPDATE an existing teacher ---
    // This logic was already good, but now it will be part of the fully corrected file.
    router.put('/update-teacher', upload.single('photo'), async (req, res) => {
        const t = req.body;
        const teacherId = t.id;
        if (!teacherId) return res.status(400).json({ message: 'Teacher ID is required.' });

        try {
            const [[oldTeacher]] = await db.promise().query('SELECT * FROM Teachers WHERE Id = ?', [teacherId]);
            if (!oldTeacher) return res.status(404).json({ message: 'Teacher not found.' });

            const fieldsToUpdate = [];
            const sqlValues = [];
            const changes = [];
            
            const compareAndPush = (fieldName, dbColumn, newValue, oldValue, isDate = false) => {
                const formattedNew = isDate ? formatDateForDB(newValue) : (newValue || null);
                const formattedOld = isDate ? formatDateForDB(oldValue) : (oldValue || null);
                if (String(formattedNew) !== String(formattedOld) && newValue !== undefined) {
                    fieldsToUpdate.push(`${dbColumn} = ?`);
                    sqlValues.push(formattedNew);
                    changes.push(`${fieldName} changed from "${formattedOld || 'empty'}" to "${formattedNew || 'empty'}"`);
                }
            };
            
            compareAndPush('Full Name', 'FullName', t.fullName, oldTeacher.FullName);
            compareAndPush('Father\'s Name', 'FathersName', t.fathersName, oldTeacher.FathersName);
            compareAndPush('Qualification', 'Qualification', t.qualification, oldTeacher.Qualification);
            compareAndPush('Phone', 'Phone', t.phone, oldTeacher.Phone);
            compareAndPush('WhatsApp', 'Whatsapp', t.whatsapp, oldTeacher.Whatsapp);
            compareAndPush('Designation', 'Designation', t.designation, oldTeacher.Designation);
            compareAndPush('Username', 'Username', t.username, oldTeacher.Username);
            compareAndPush('Gender', 'Gender', t.gender, oldTeacher.Gender);
            compareAndPush('Email', 'EmailAddress', t.email, oldTeacher.EmailAddress);
            compareAndPush('Date of Birth', 'DateOfBirth', t.dateOfBirth, oldTeacher.DateOfBirth, true);
            compareAndPush('Date of Joining', 'DateOfJoining', t.dateOfJoining, oldTeacher.DateOfJoining, true);

            if (t.status !== undefined && t.status !== oldTeacher.Status) {
                fieldsToUpdate.push('Status = ?');
                sqlValues.push(t.status);
                changes.push(`Status changed to "${t.status}"`);
                if (t.status === 'Inactive' && !oldTeacher.DateOfInactive) { 
                    fieldsToUpdate.push('DateOfInactive = CURDATE()');
                } else if (t.status === 'Active') {
                    fieldsToUpdate.push('DateOfInactive = NULL');
                }
            }

            if (t.password && t.password.trim() !== "") {
                fieldsToUpdate.push('Password = ?');
                sqlValues.push(t.password.trim());
                changes.push('Password was updated');
            }
            
            const oldClasses = JSON.stringify(JSON.parse(oldTeacher.ManagedClasses || '[]'));
            const newClasses = t.assignedClasses || '[]';
            if (newClasses !== oldClasses) {
                fieldsToUpdate.push('ManagedClasses = ?');
                sqlValues.push(newClasses);
                changes.push('Assigned classes were updated');
            }

            if (req.file) {
                const newPhotoUrl = path.join('/public/uploads/teachers', req.file.filename).replace(/\\/g, '/');
                fieldsToUpdate.push('PhotoUrl = ?');
                sqlValues.push(newPhotoUrl);
                changes.push('Profile photo was updated');
                if (oldTeacher.PhotoUrl) {
                    const oldPhotoPath = path.join(__dirname, '..', 'public', oldTeacher.PhotoUrl.substring(7));
                    fs.unlink(oldPhotoPath, (err) => {
                        if (err) console.error("Could not delete old photo:", oldPhotoPath, err.message);
                    });
                }
            }
            
            // --- NEW: Added Note field handling ---
            compareAndPush('Note', 'Note', t.note, oldTeacher.Note);


            if (fieldsToUpdate.length === 0) return res.status(200).json({ message: 'No changes detected.' });

            sqlValues.push(teacherId);
            const sql = `UPDATE Teachers SET ${fieldsToUpdate.join(', ')} WHERE Id = ?`;
            await db.promise().query(sql, sqlValues);
            
            await logActivity('UPDATE', 'Admin', teacherId, t.fullName || oldTeacher.FullName, changes.join('; '));
            res.status(200).json({ message: '✅ Teacher updated successfully.' });

        } catch (err) {
            res.status(500).json({ message: 'Teacher update failed', error: err.message });
        }
    });

    // DELETE a teacher
    router.delete('/delete-teacher/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const [[teacher]] = await db.promise().query('SELECT FullName, PhotoUrl FROM Teachers WHERE Id = ?', [id]);
            if (!teacher) return res.status(404).json({ message: 'Teacher not found.' });

            await db.promise().query('DELETE FROM Teachers WHERE Id = ?', [id]);
            await logActivity('DELETE', 'Admin', id, teacher.FullName, 'Staff member record was permanently deleted.');
            
            if (teacher.PhotoUrl) {
                const photoPath = path.join(__dirname, '..', 'public', teacher.PhotoUrl.substring(7));
                fs.unlink(photoPath, (err) => {
                    if (err) console.error(`Failed to delete photo file: ${photoPath}`, err.message);
                });
            }
            res.status(200).json({ message: '✅ Teacher deleted successfully.' });
        } catch (err) {
            res.status(500).json({ message: 'Teacher delete failed', error: err.message });
        }
    });

    return router;
};