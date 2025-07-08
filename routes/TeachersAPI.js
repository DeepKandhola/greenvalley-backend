// routes/TeachersAPI.js

const express = require('express');
const multer = require('multer');
const path =require('path');
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

    // --- REFINED: Activity Logging Helper ---
    // Now creates more specific log details.
    const logActivity = async (actionType, performedBy, targetId, targetName, details = '') => {
        const sql = `
            INSERT INTO ActivityLogs (ActionType, PerformedBy, TargetID, TargetName, Details) 
            VALUES (?, ?, ?, ?, ?)`;
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
            const extension = path.extname(file.originalname);
            cb(null, `teacher-photo-${uniqueSuffix}${extension}`);
        }
    });
    const upload = multer({ storage: storage });
    router.get('/teachers', async (req, res) => {
        const sql = `SELECT Id AS TeacherID, FullName, Designation 
                     FROM Teachers 
                     WHERE Status = 'Active' 
                     ORDER BY Designation, FullName ASC`;
        try {
            const [results] = await db.promise().query(sql);

            // Group the flat list of teachers into a structured object
            const groupedTeachers = results.reduce((acc, teacher) => {
                const group = teacher.Designation || 'Other'; // Group by Designation
                if (!acc[group]) {
                    acc[group] = []; // Create the group if it doesn't exist
                }
                acc[group].push(teacher);
                return acc;
            }, {});

            res.status(200).json(groupedTeachers);
        } catch (err) {
            console.error('❌ Error fetching and grouping teacher list:', err.message);
            res.status(500).json({ message: 'Failed to fetch teacher list', error: err.message });
        }
    });
    router.get('/get-teachers', async (req, res) => {
        const sql = `
            SELECT 
                Id, FullName, FathersName, Qualification, DateOfBirth, 
                DateOfJoining, Phone, Whatsapp, Designation, Status, 
                Username, Gender, EmailAddress, ManagedClasses, PhotoUrl, DateOfInactive
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

    // ADD a new teacher (no changes needed here)
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
            console.error('❌ Error adding teacher:', err.message);
            res.status(500).json({ message: 'Teacher insert failed', error: err.message });
        }
    });

    // --- REFINED: UPDATE an existing teacher ---
    router.put('/update-teacher', upload.single('photo'), async (req, res) => {
        const t = req.body;
        const teacherId = t.id;

        if (!teacherId) {
            return res.status(400).json({ message: 'Teacher ID is required for an update.' });
        }

        try {
            // Get the full original record for comparison
            const [[oldTeacher]] = await db.promise().query('SELECT * FROM Teachers WHERE Id = ?', [teacherId]);
            if (!oldTeacher) {
                return res.status(404).json({ message: 'Teacher not found.' });
            }

            const fieldsToUpdate = [];
            const sqlValues = [];
            const changes = []; // Array to track specific changes for the log
            
            // --- Helper to compare and track changes ---
            const compareAndPush = (fieldName, dbColumn, newValue, oldValue, isDate = false) => {
                const formattedNew = isDate ? formatDateForDB(newValue) : newValue;
                const formattedOld = isDate ? formatDateForDB(oldValue) : oldValue;
                
                if (formattedNew !== formattedOld && newValue !== undefined) {
                    fieldsToUpdate.push(`${dbColumn} = ?`);
                    sqlValues.push(formattedNew);
                    changes.push(`${fieldName} changed from "${formattedOld || 'empty'}" to "${formattedNew}"`);
                }
            };
            
            // Compare each field
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

            // Special handling for Status and Inactive Date
            if (t.status !== undefined && t.status !== oldTeacher.Status) {
                fieldsToUpdate.push('Status = ?');
                sqlValues.push(t.status);
                changes.push(`Status changed from "${oldTeacher.Status}" to "${t.status}"`);
                
                if (t.status === 'Inactive') {
                    // Only update the inactive date if it's not already set
                    // This preserves the original inactive date if a user is toggled multiple times
                    if (!oldTeacher.DateOfInactive) { 
                        fieldsToUpdate.push('DateOfInactive = CURDATE()');
                        changes.push(`Marked as inactive on ${new Date().toLocaleDateString('en-GB')}`);
                    }
                } else if (t.status === 'Active') {
                    // When reactivating, clear the inactive date.
                    fieldsToUpdate.push('DateOfInactive = NULL');
                }
            }

            // Special handling for Password (only update if provided)
            if (t.password && t.password.trim() !== "") {
                fieldsToUpdate.push('Password = ?');
                sqlValues.push(t.password.trim());
                changes.push('Password was updated');
            }

            // Special handling for Assigned Classes
            const oldClasses = JSON.stringify(JSON.parse(oldTeacher.ManagedClasses || '[]'));
            const newClasses = t.assignedClasses ? t.assignedClasses : '[]';
            if (newClasses !== oldClasses) {
                fieldsToUpdate.push('ManagedClasses = ?');
                sqlValues.push(newClasses);
                changes.push('Assigned classes were updated');
            }

            // Photo update
            if (req.file) {
                const newPhotoUrl = path.join('/public/uploads/teachers', req.file.filename).replace(/\\/g, '/');
                fieldsToUpdate.push('PhotoUrl = ?');
                sqlValues.push(newPhotoUrl);
                changes.push('Profile photo was updated');
                if (oldTeacher.PhotoUrl) {
                    const oldPhotoPath = path.join(__dirname, '..', oldTeacher.PhotoUrl.replace('/public', 'public'));
                    fs.unlink(oldPhotoPath, (err) => {
                        if (err) console.error("Error deleting old photo:", oldPhotoPath, err.message);
                    });
                }
            }

            if (fieldsToUpdate.length === 0) {
                return res.status(200).json({ message: 'No changes detected.' });
            }

            sqlValues.push(teacherId);
            const sql = `UPDATE Teachers SET ${fieldsToUpdate.join(', ')} WHERE Id = ?`;
            
            await db.promise().query(sql, sqlValues);
            
            // --- Log the detailed changes ---
            const logDetails = changes.join('; ');
            await logActivity('UPDATE', 'Admin', teacherId, t.fullName, logDetails);
            
            res.status(200).json({ message: '✅ Teacher updated successfully.' });

        } catch (err) {
            console.error('❌ Error updating teacher:', err.message);
            res.status(500).json({ message: 'Teacher update failed', error: err.message });
        }
    });

    // --- REFINED: DELETE a teacher ---
    router.delete('/delete-teacher/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const [[teacher]] = await db.promise().query('SELECT FullName, PhotoUrl FROM Teachers WHERE Id = ?', [id]);
            if (!teacher) {
                return res.status(404).json({ message: 'Teacher not found.' });
            }

            await db.promise().query('DELETE FROM Teachers WHERE Id = ?', [id]);
            
            // Log with specific name
            await logActivity('DELETE', 'Admin', id, teacher.FullName, 'Staff member record was permanently deleted.');
            
            if (teacher.PhotoUrl) {
                const photoPath = path.join(__dirname, '..', teacher.PhotoUrl.replace('/public', 'public'));
                fs.unlink(photoPath, (err) => {
                    if (err) console.error(`Failed to delete photo file: ${photoPath}`, err.message);
                });
            }
            res.status(200).json({ message: '✅ Teacher deleted successfully.' });
        } catch (err) {
            console.error(`❌ Error deleting teacher with ID ${id}:`, err.message);
            res.status(500).json({ message: 'Teacher delete failed', error: err.message });
        }
    });

    return router;
};