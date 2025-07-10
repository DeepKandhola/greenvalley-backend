// server.js
const express=require('express');
const cors=require('cors');
const path=require('path');
const fs=require('fs');
const multer=require('multer');
const mysql=require('mysql2');
require('dotenv').config();
const {format,subDays}=require('date-fns');
const {toDate,zonedTimeToUtc}=require('date-fns-tz');
const app=express();
const PORT=process.env.PORT||5000;
const db=require('./dbconfig.js');
const diaryRoutes=require('./routes/diary.js')(db);
const {registerTaskRoutes}=require('./routes/TasksAPI.js');
const {initializeDynamicScheduler}=require('./routes/dynamicTaskScheduler');
const dashboardRoutes=require('./routes/DashboardAPI.js')(db);
const teacherRoutes=require('./routes/TeachersAPI.js')(db);
const XLSX=require('xlsx');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use('/api/dashboard',dashboardRoutes);
app.use('/api/diary',diaryRoutes);
app.use('/api',teacherRoutes);
const publicDir=path.join(__dirname,'public');
const attachmentsDir=path.join(publicDir,'attachments','tasks');
const studentPhotosDir=path.join(publicDir,'uploads','students');
if(!fs.existsSync(publicDir)){
fs.mkdirSync(publicDir,{recursive:true});
console.log(`✅ Created public directory: ${publicDir}`);
}
if(!fs.existsSync(attachmentsDir)){
fs.mkdirSync(attachmentsDir,{recursive:true});
console.log(`✅ Created attachments directory: ${attachmentsDir}`);
}
if(!fs.existsSync(studentPhotosDir)){
fs.mkdirSync(studentPhotosDir,{recursive:true});
console.log(`✅ Created student photos directory: ${studentPhotosDir}`);
}
app.use('/public',express.static(publicDir));
db.getConnection((err,connection)=>{
if(err){
console.error('❌ Database connection failed:',err.message);
}else{
console.log('✅ Connected to MySQL Database Pool');
connection.release();
}
});
app.get('/api/get-activity-logs',async (req,res)=>{
const page=parseInt(req.query.page,10)||1;
const limit=parseInt(req.query.limit,10)||10;
const offset=(page-1)*limit;
try{
const [[{totalItems}]]=await db.promise().query('SELECT COUNT(*) as totalItems FROM ActivityLogs');
const [logs]=await db.promise().query('SELECT * FROM ActivityLogs ORDER BY Timestamp DESC LIMIT ? OFFSET ?',[limit,offset]);
res.status(200).json({
logs,
totalPages:Math.ceil(totalItems/limit),
currentPage:page
});
}catch(error){
console.error('❌ Error fetching activity logs:',error.message);
res.status(500).json({message:'Failed to fetch activity logs',error:error.message});
}
});
const logStudentActivity=async (actionType,performedBy,targetAdmissionNo,targetName,details='')=>{
const sql=`
    INSERT INTO StudentActivityLogs (ActionType, PerformedBy, TargetAdmissionNo, TargetName, Details) 
    VALUES (?, ?, ?, ?, ?)`;
try{
await db.promise().query(sql,[actionType,performedBy,targetAdmissionNo,targetName,details]);
}catch(error){
console.error('❌ Failed to log student activity:',error.message);
}
};
const studentPhotoStorage=multer.diskStorage({
destination:(req,file,cb)=>cb(null,studentPhotosDir),
filename:(req,file,cb)=>{
const uniqueSuffix=Date.now()+'-'+Math.round(Math.random()*1E9);
cb(null,`student-photo-${uniqueSuffix}${path.extname(file.originalname)}`);
}
});
const studentPhotoUpload=multer({storage:studentPhotoStorage});
app.post('/api/upload-photo',studentPhotoUpload.single('profilePhoto'),(req,res)=>{
if(!req.file)return res.status(400).json({message:'No file uploaded.'});
const filePath=path.join('/public/uploads/students',req.file.filename).replace(/\\/g,'/');
res.status(200).json({filePath:filePath});
});
app.post('/api/login',async (req,res)=>{
const {username,password:providedPassword}=req.body;
if(!username||!providedPassword){
return res.status(400).json({message:'Username and password are required.'});
}
try{
const [rows]=await db.promise().query(
'SELECT Id, FullName, Username, Password, Role, ManagedClasses, Status FROM Teachers WHERE Username = ?',
[username]
);
if(rows.length===0){
return res.status(401).json({message:'Invalid username or password.'});
}
const teacher=rows[0];
if(teacher.Status!=='Active'){
return res.status(403).json({
message:'Your account is inactive.',
reason:'INACTIVE_ACCOUNT'
});
}
const dbPassword=teacher.Password;
let isMatch=false;
if(dbPassword&&dbPassword.trim()!==''){
isMatch=(providedPassword===dbPassword);
}else{
isMatch=(providedPassword==='password');
}
if(isMatch){
let managedClassesArray=[];
if(teacher.ManagedClasses){
try{
managedClassesArray=JSON.parse(teacher.ManagedClasses);
if(!Array.isArray(managedClassesArray))managedClassesArray=[];
}catch(e){
console.error("Failed to parse ManagedClasses JSON for user:",teacher.Username,e);
managedClassesArray=[];
}
}
const userData={
id:teacher.Id,
name:teacher.FullName,
username:teacher.Username,
role:teacher.Role,
managedClasses:managedClassesArray,
};
res.status(200).json(userData);
}else{
res.status(401).json({message:'Invalid username or password.'});
}
}catch(error){
console.error('❌ Login API Error:',error);
res.status(500).json({message:'An error occurred during the login process.'});
}
});
app.post('/api/student-login',async (req,res)=>{
const {username,password:providedPassword}=req.body;
if(!username||!providedPassword){
return res.status(400).json({message:'Username and password are required.'});
}
try{
const [rows]=await db.promise().query(
'SELECT AdmissionNo, FullName, Username, Password, IsActive FROM Students WHERE Username = ?',
[username]
);
if(rows.length===0){
return res.status(401).json({message:'Invalid username or password.'});
}
const student=rows[0];
if(student.IsActive!==1){
return res.status(403).json({
message:'Your account is inactive.',
reason:'INACTIVE_ACCOUNT'
});
}
const dbPassword=student.Password;
if(providedPassword===dbPassword){
const userData={
id:student.AdmissionNo,
name:student.FullName,
username:student.Username,
role:'student',
managedClasses:[],
};
res.status(200).json(userData);
}else{
res.status(401).json({message:'Invalid username or password.'});
}
}catch(error){
console.error('❌ Student Login API Error:',error);
res.status(500).json({message:'An error occurred during the login process.'});
}
});
app.get('/api/teacher/my-students',async (req,res)=>{
const {classes}=req.query;
if(!classes){
return res.status(400).json({message:"Managed classes are required."});
}
try{
const classList=classes.split(',');
const classSectionPairs=classList.map(cls=>cls.split('-'));
const [students]=await db.promise().query(
`SELECT * FROM Students WHERE (CurrentClass, Section) IN (?) ORDER BY FullName`,
[classSectionPairs]
);
res.status(200).json(students);
}catch(error){
console.error("Error fetching students for teacher:",error);
res.status(500).json({message:"Failed to fetch student data."});
}
});
app.get('/api/teacher/dashboard-stats/:teacherId/:managedClasses',async (req,res)=>{
const {teacherId}=req.params;
const decodedClassesString=decodeURIComponent(req.params.managedClasses);
const classes=decodedClassesString.split(',');
if(!teacherId||!classes||!classes.length){
return res.status(400).json({message:"Teacher ID and managed classes are required."});
}
const classPlaceholders=classes.map(()=>'?').join(',');
try{
const [studentIdRows]=await db.promise().query(
`SELECT AdmissionNo FROM Students WHERE CONCAT(CurrentClass, '-', Section) IN (${classPlaceholders})`,
classes
);
if(studentIdRows.length===0){
return res.json({totalStudents:0,totalTasks:0,completedTasks:0,pendingTasks:0,inProgressOrOverdue:0,presentStudents:0,absentStudents:0,onLeaveStudents:0});
}
const studentAdmissionNumbers=studentIdRows.map(row=>row.AdmissionNo);
const totalStudents=studentAdmissionNumbers.length;
const [[taskStats]]=await db.promise().query(
`SELECT
         COUNT(Id) as totalTasks,
         SUM(CASE WHEN Status = 'Completed' THEN 1 ELSE 0 END) as completedTasks,
         SUM(CASE WHEN Status IN ('Pending', 'Not Started') THEN 1 ELSE 0 END) as pendingTasks
       FROM Tasks WHERE AssignedTo REGEXP ?`,
[`[[:<:]]${teacherId}[[:>:]]`]
);
const [[latestDateData]]=await db.promise().query(
'SELECT MAX(AttendanceDate) as latestDate FROM Attendance WHERE StudentAdmissionNo IN (?)',
[studentAdmissionNumbers]
);
let attendanceData={presentStudents:0,absentStudents:0,onLeaveStudents:0};
if(latestDateData&&latestDateData.latestDate){
const latestDate=latestDateData.latestDate;
const [[statsForDate]]=await db.promise().query(
`SELECT
           SUM(CASE WHEN Status = 'Present' THEN 1 ELSE 0 END) as presentStudents,
           SUM(CASE WHEN Status = 'Absent' THEN 1 ELSE 0 END) as absentStudents,
           SUM(CASE WHEN Status = 'OnLeave' THEN 1 ELSE 0 END) as onLeaveStudents
         FROM Attendance
         WHERE AttendanceDate = ? AND StudentAdmissionNo IN (?)`,
[latestDate,studentAdmissionNumbers]
);
attendanceData=statsForDate;
}
const totalTasks=taskStats.totalTasks||0;
const completedTasks=taskStats.completedTasks||0;
const pendingTasks=taskStats.pendingTasks||0;
const inProgressOrOverdue=totalTasks-completedTasks-pendingTasks;
const finalStats={
totalStudents:totalStudents,
totalTasks,
completedTasks,
pendingTasks,
inProgressOrOverdue,
presentStudents:attendanceData.presentStudents||0,
absentStudents:attendanceData.absentStudents||0,
onLeaveStudents:attendanceData.onLeaveStudents||0
};
res.status(200).json(finalStats);
}catch(err){
console.error(`❌ Error fetching dashboard stats for teacher ID ${teacherId}:`,err.message);
res.status(500).json({message:"Failed to fetch dashboard statistics."});
}
});
app.get('/api/teacher/full-details/:teacherId',async (req,res)=>{
const {teacherId}=req.params;
try{
const [rows]=await db.promise().query(
`SELECT 
        FullName, FathersName, Qualification, 
        DATE_FORMAT(DateOfBirth, '%d-%m-%Y') as DateOfBirth, 
        DATE_FORMAT(DateOfJoining, '%d-%m-%Y') as DateOfJoining, 
        Phone, Whatsapp, Type, Username, ManagedClasses
       FROM Teachers 
       WHERE Id = ?`,
[teacherId]
);
if(rows.length>0){
const teacher=rows[0];
try{
teacher.ManagedClasses=JSON.parse(teacher.ManagedClasses||'[]');
}catch(e){
teacher.ManagedClasses=[];
}
res.status(200).json(teacher);
}else{
res.status(404).json({message:'Teacher not found.'});
}
}catch(error){
console.error(`Error fetching full details for teacher ${teacherId}:`,error);
res.status(500).json({message:'Failed to fetch teacher details.'});
}
});
app.put('/api/teacher/change-password',async (req,res)=>{
const {teacherId,currentPassword,newUsername,newPassword}=req.body;
if(!teacherId||!currentPassword||!newPassword||!newUsername){
return res.status(400).json({message:"All fields are required."});
}
try{
const [rows]=await db.promise().query('SELECT Password FROM Teachers WHERE Id = ?',[teacherId]);
if(rows.length===0){
return res.status(404).json({message:"User not found."});
}
const storedPassword=rows[0].Password;
if(currentPassword!==storedPassword){
return res.status(401).json({message:"Incorrect current password."});
}
await db.promise().query(
'UPDATE Teachers SET Username = ?, Password = ? WHERE Id = ?',
[newUsername,newPassword,teacherId]
);
res.status(200).json({message:"✅ Credentials updated successfully!"});
}catch(error){
if(error.code==='ER_DUP_ENTRY'&&error.message.includes('Username')){
return res.status(409).json({message:'That username is already taken. Please choose another.'});
}
console.error(`Error changing credentials for teacher ${teacherId}:`,error);
res.status(500).json({message:"Failed to update credentials."});
}
});
app.post('/api/attendance',(req,res)=>{
const attendanceRecords=req.body.records;
const teacherName=req.body.teacherName;
if(!Array.isArray(attendanceRecords)||attendanceRecords.length===0){
return res.status(400).json({message:'No attendance records provided.'});
}
const indiaTimeZone='Asia/Kolkata';
const lockInDays=3;
const nowInIndia=toDate(new Date(),{timeZone:indiaTimeZone});
const todayStr=format(nowInIndia,'yyyy-MM-dd');
const cutoffDate=subDays(nowInIndia,lockInDays);
const cutoffDateStr=format(cutoffDate,'yyyy-MM-dd');
const attendanceDate=attendanceRecords[0].date;
if(attendanceDate>todayStr){
return res.status(403).json({message:`Cannot mark attendance for a future date.`});
}
if(attendanceDate<cutoffDateStr){
return res.status(403).json({message:`Attendance for this date is locked. You can only edit records for the past ${lockInDays} days.`});
}
const sql=`
    INSERT INTO Attendance (StudentAdmissionNo, AttendanceDate, Status, MarkedByTeacher)
    VALUES ?
    ON DUPLICATE KEY UPDATE Status = VALUES(Status), MarkedByTeacher = VALUES(MarkedByTeacher)`;
const values=attendanceRecords.map(rec=>[rec.admissionNo,rec.date,rec.status,teacherName]);
db.query(sql,[values],(err,result)=>{
if(err){
console.error('❌ Error saving attendance:',err.message);
return res.status(500).json({message:'Failed to save attendance',error:err.message});
}
res.status(201).json({message:'✅ Attendance saved successfully',affectedRows:result.affectedRows});
});
});
app.get('/api/students-by-class/:classSection',(req,res)=>{
const {classSection}=req.params;
if(!classSection||!classSection.includes('-')){
return res.status(400).json({message:'Invalid class-section format. Use format like "10-A".'});
}
const [currentClass,section]=classSection.split('-');
const sql='SELECT AdmissionNo, FullName FROM Students WHERE CurrentClass = ? AND Section = ? ORDER BY FullName';
db.query(sql,[currentClass,section],(err,results)=>{
if(err){
console.error(`❌ Error fetching students for class ${classSection}:`,err.message);
return res.status(500).json({message:'Database query failed'});
}
res.status(200).json(results);
});
});
app.get('/api/attendance-report',(req,res)=>{
const sql=`
    SELECT a.Id, a.AttendanceDate, a.Status, a.MarkedByTeacher, s.AdmissionNo, s.FullName, s.CurrentClass, s.Section
    FROM Attendance a JOIN Students s ON a.StudentAdmissionNo = s.AdmissionNo
    ORDER BY a.AttendanceDate DESC, s.CurrentClass, s.Section, s.FullName;`;
db.query(sql,(err,results)=>{
if(err){
console.error('❌ Error fetching attendance report:',err.message);
return res.status(500).json({message:'Failed to fetch report',error:err.message});
}
res.status(200).json(results);
});
});
app.get('/api/attendance/:classSection/:date',(req,res)=>{
const {classSection,date}=req.params;
const sql="SELECT StudentAdmissionNo, Status FROM Attendance WHERE StudentAdmissionNo IN (SELECT AdmissionNo FROM Students WHERE CONCAT(CurrentClass, '-', Section) = ?) AND AttendanceDate = ?";
db.query(sql,[classSection,date],(err,results)=>{
if(err){
console.error(`❌ Error fetching attendance for ${classSection} on ${date}:`,err.message);
return res.status(500).json({message:'Database query failed'});
}
const attendanceMap=results.reduce((acc,record)=>{acc[record.StudentAdmissionNo]=record.Status;return acc;},{});
res.status(200).json(attendanceMap);
});
});
app.get('/api/get-classes',(req,res)=>{
const sql=`
    SELECT DISTINCT CONCAT(CurrentClass, '-', Section) AS ClassSection FROM Students
    WHERE CurrentClass IS NOT NULL AND CurrentClass != '' AND Section IS NOT NULL AND Section != ''
    ORDER BY CAST(REGEXP_SUBSTR(CurrentClass, '^[0-9]+') AS UNSIGNED) ASC, REGEXP_SUBSTR(CurrentClass, '[A-Za-z]+$') ASC, Section ASC;`;
db.query(sql,(err,results)=>{
if(err){
console.error('❌ Error fetching distinct classes with sections:',err.message);
return res.status(500).json({message:'Failed to fetch class list',error:err.message});
}
const classes=results.map(row=>({value:row.ClassSection,label:row.ClassSection}));
res.status(200).json(classes);
});
});
app.get('/api/student/full-details/:admissionNo',async (req,res)=>{
const {admissionNo}=req.params;
try{
const [rows]=await db.promise().query(
`SELECT 
        FullName, AdmissionNo, FathersName, MothersName, 
        DATE_FORMAT(DOB, '%d-%m-%Y') as DOB, 
        Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section,
        Username
       FROM Students 
       WHERE AdmissionNo = ?`,
[admissionNo]
);
if(rows.length>0){
res.status(200).json(rows[0]);
}else{
res.status(404).json({message:'Student not found.'});
}
}catch(error){
console.error(`Error fetching full details for student ${admissionNo}:`,error);
res.status(500).json({message:'Failed to fetch student details.'});
}
});
app.get('/api/student/details/:admissionNo',async (req,res)=>{
const {admissionNo}=req.params;
try{
const [rows]=await db.promise().query(
'SELECT CurrentClass, Section FROM Students WHERE AdmissionNo = ?',
[admissionNo]
);
if(rows.length>0){
res.status(200).json(rows[0]);
}else{
res.status(404).json({message:'Student not found.'});
}
}catch(error){
console.error(`Error fetching details for student ${admissionNo}:`,error);
res.status(500).json({message:'Failed to fetch student details.'});
}
});
app.get('/api/student/today-attendance/:admissionNo',async (req,res)=>{
const {admissionNo}=req.params;
const today=format(new Date(),'yyyy-MM-dd');
try{
const [rows]=await db.promise().query(
'SELECT Status FROM Attendance WHERE StudentAdmissionNo = ? AND AttendanceDate = ?',
[admissionNo,today]
);
if(rows.length>0){
res.status(200).json({status:rows[0].Status});
}else{
res.status(200).json({status:'Not Marked'});
}
}catch(error){
console.error(`Error fetching today's attendance for ${admissionNo}:`,error);
res.status(500).json({message:"Failed to fetch today's attendance"});
}
});
app.get('/api/student/attendance/:admissionNo',async (req,res)=>{
const {admissionNo}=req.params;
try{
const [attendanceRows]=await db.promise().query(
'SELECT DATE_FORMAT(AttendanceDate, "%Y-%m-%d") as AttendanceDate, Status FROM Attendance WHERE StudentAdmissionNo = ?',
[admissionNo]
);
const attendanceMap=attendanceRows.reduce((acc,row)=>{
acc[row.AttendanceDate]=row.Status;
return acc;
},{});
res.status(200).json({attendance:attendanceMap,holidays:{}});
}catch(error){
console.error(`Error fetching attendance history for ${admissionNo}:`,error);
res.status(500).json({message:'Failed to fetch attendance history'});
}
});
app.get('/api/day-status/:date',async (req,res)=>{
const {date}=req.params;
try{
const dayOfWeek=new Date(date).getUTCDay();
if(dayOfWeek===0){
return res.status(200).json({isSchoolOff:true,reason:'Weekly Off'});
}
const [rows]=await db.promise().query(
'SELECT Description FROM Holidays WHERE HolidayDate = ?',
[date]
);
if(rows.length>0){
res.status(200).json({isSchoolOff:true,reason:rows[0].Description});
}else{
res.status(200).json({isSchoolOff:false,reason:'Working Day'});
}
}catch(error){
console.error(`Error checking status for date ${date}:`,error);
res.status(500).json({message:'Failed to check day status.'});
}
});
app.put('/api/student/settings/update-credentials',async (req,res)=>{
const {admissionNo,newUsername,newPassword}=req.body;
if(!admissionNo||!newUsername||!newPassword){
return res.status(400).json({message:'Admission number, new username, and new password are required.'});
}
try{
const [result]=await db.promise().query(
'UPDATE Students SET Username = ?, Password = ? WHERE AdmissionNo = ?',
[newUsername,newPassword,admissionNo]
);
if(result.affectedRows===0){
return res.status(404).json({message:'Student not found.'});
}
res.status(200).json({message:'✅ Credentials updated successfully!'});
}catch(error){
if(error.code==='ER_DUP_ENTRY'){
return res.status(409).json({message:'That username is already taken. Please choose another.'});
}
console.error(`Error updating credentials for ${admissionNo}:`,error);
res.status(500).json({message:'Failed to update credentials.'});
}
});
app.post('/api/holidays',(req,res)=>{
const {date,description,holidayType,adminName}=req.body;
if(!date||!description||!holidayType){
return res.status(400).json({message:'Date, description, and holiday type are required.'});
}
const sql="INSERT INTO Holidays (HolidayDate, Description, HolidayType, AddedBy) VALUES (?, ?, ?, ?)";
db.query(sql,[date,description,holidayType,adminName],(err,result)=>{
if(err){
if(err.code==='ER_DUP_ENTRY')return res.status(409).json({message:`The date ${date} is already marked.`});
console.error('❌ Error adding holiday:',err.message);
return res.status(500).json({message:'Failed to add holiday.'});
}
res.status(201).json({message:'✅ Day marked successfully!'});
});
});
app.get('/api/holidays/check/:date',(req,res)=>{
const {date}=req.params;
const dayOfWeek=new Date(date).getUTCDay();
if(dayOfWeek===0){return res.status(200).json({isHoliday:true,description:'Weekly Off',type:'Holiday'});}
const sql="SELECT Description, HolidayType FROM Holidays WHERE HolidayDate = ?";
db.query(sql,[date],(err,results)=>{
if(err){
console.error('❌ Error checking holiday status:',err.message);
return res.status(500).json({message:'Database query failed.'});
}
if(results.length>0){res.status(200).json({isHoliday:true,description:results[0].Description,type:results[0].HolidayType});}
else{res.status(200).json({isHoliday:false});}
});
});
registerTaskRoutes(app,db);
initializeDynamicScheduler(db);
const formatDateForDB=(dateStr)=>{
if(!dateStr||dateStr==="0000-00-00"||dateStr==="")return null;
try{
const date=new Date(dateStr);
if(isNaN(date.getTime())){
if(typeof dateStr==='number'&&dateStr>25568&&dateStr<50000){
const excelEpoch=new Date(1899,11,30);
const correctDate=new Date(excelEpoch.getTime()+(dateStr-1)*24*60*60*1000);
if(!isNaN(correctDate.getTime()))return correctDate.toISOString().split('T')[0];
}
return null;
}
return date.toISOString().split('T')[0];
}catch(e){return null;}
};
app.put('/api/students/bulk-promote',async (req,res)=>{
const {studentIds,targetClass,targetSection}=req.body;
if(!Array.isArray(studentIds)||studentIds.length===0||!targetClass){
return res.status(400).json({message:'Student IDs and a target class are required.'});
}
try{
const updateSql='UPDATE Students SET CurrentClass = ?, Section = ? WHERE AdmissionNo IN (?)';
const [result]=await db.promise().query(updateSql,[targetClass,targetSection||null,studentIds]);
const logDetails=`Promoted ${result.affectedRows} students to Class: ${targetClass}${targetSection?`-${targetSection}`:''}.`;
await logStudentActivity('BULK_PROMOTE','Admin',studentIds.join(', '),'Multiple Students',logDetails);
res.status(200).json({message:`✅ Successfully promoted ${result.affectedRows} students.`});
}catch(error){
console.error('❌ Error during bulk promotion:',error);
res.status(500).json({message:'Failed to promote students.',error:error.message});
}
});
app.put('/api/students/bulk-deactivate',async (req,res)=>{
const {studentIds,reason}=req.body;
if(!Array.isArray(studentIds)||studentIds.length===0){
return res.status(400).json({message:'Student IDs are required.'});
}
try{
const updateSql='UPDATE Students SET IsActive = 0, DateOfInactive = CURDATE() WHERE AdmissionNo IN (?)';
const [result]=await db.promise().query(updateSql,[studentIds]);
const logDetails=`Deactivated ${result.affectedRows} students. Reason: ${reason||'Not specified'}.`;
await logStudentActivity('BULK_DEACTIVATE','Admin',studentIds.join(', '),'Multiple Students',logDetails);
res.status(200).json({message:`✅ Successfully deactivated ${result.affectedRows} students.`});
}catch(error){
console.error('❌ Error during bulk deactivation:',error);
res.status(500).json({message:'Failed to deactivate students.',error:error.message});
}
});
app.put('/api/teachers/bulk-deactivate',async (req,res)=>{
const {teacherIds,reason}=req.body;
if(!Array.isArray(teacherIds)||teacherIds.length===0){
return res.status(400).json({message:'Teacher IDs are required.'});
}
try{
const updateSql="UPDATE Teachers SET Status = 'Inactive', DateOfInactive = CURDATE() WHERE Id IN (?)";
const [result]=await db.promise().query(updateSql,[teacherIds]);
const logDetails=`Bulk deactivated ${result.affectedRows} staff members. Reason: ${reason||'Not specified'}.`;
await db.promise().query('INSERT INTO ActivityLogs (ActionType, PerformedBy, TargetID, TargetName, Details) VALUES (?, ?, ?, ?, ?)',['BULK_DEACTIVATE','Admin',teacherIds.join(','),'Multiple Staff',logDetails]);
res.status(200).json({message:`✅ Successfully deactivated ${result.affectedRows} staff members.`});
}catch(error){
console.error('❌ Error during bulk deactivation of teachers:',error);
res.status(500).json({message:'Failed to deactivate staff.',error:error.message});
}
});
app.post('/api/add-student',async (req,res)=>{
const s=req.body;
const finalUsername=(s.username&&s.username.trim()!=='')
?s.username.trim()
:(s.phone&&s.phone.trim()!=='')?s.phone.trim():s.admissionNo;
let finalPassword=(s.password&&s.password.trim()!=='')?s.password.trim():null;
if(!finalPassword&&s.dob){
try{
const dobDate=new Date(s.dob);
if(!isNaN(dobDate.getTime())){
const day=String(dobDate.getDate()).padStart(2,'0');
const month=String(dobDate.getMonth()+1).padStart(2,'0');
const year=dobDate.getFullYear();
finalPassword=`${day}${month}${year}`;
}
}catch(e){
console.warn('Could not parse DOB for default password:',s.dob,e);
}
}
if(!s.admissionNo||!s.fullName||!finalUsername||finalUsername.trim()===''){
return res.status(400).json({message:"Admission No., Full Name, and a valid Username (or Phone/AdmissionNo for default) are required."});
}
const sql=`INSERT INTO Students (SrNo, AdmissionDate, AdmissionNo, FullName, FathersName, MothersName, DOB, Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section, Username, Password, ProfilePhotoUrl, IsActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const values=[
s.srNo||null,
formatDateForDB(s.admissionDate),
s.admissionNo,
s.fullName,
s.fathersName||null,
s.mothersName||null,
formatDateForDB(s.dob),
s.address||null,
s.phone||null,
s.whatsapp||s.phone||null,
s.classAdmitted||null,
s.currentClass||null,
s.section||null,
finalUsername,
finalPassword,
s.profilePhotoUrl||null,
(s.isActive==='true'||s.isActive===true)?1:0
];
try{
const [result]=await db.promise().query(sql,values);
const newStudent={...s,id:result.insertId};
await logStudentActivity('CREATE','Admin',s.admissionNo,s.fullName,'New student record created.');
res.status(201).json({message:'✅ Student added successfully!',student:newStudent});
}catch(err){
console.error("Error adding student:",err.message);
if(err.code==='ER_DUP_ENTRY'){
if(err.message.includes('AdmissionNo')){
return res.status(409).json({message:'Admission Number already exists.'});
}
if(err.message.includes('Username')){
return res.status(409).json({message:'That username is already taken. Please choose another.'});
}
return res.status(409).json({message:'A duplicate entry was detected.'});
}
return res.status(500).json({message:'Add student failed',error:err.message});
}
});
app.get('/api/get-students',(req,res)=>{
const sql=`
    SELECT *, 
           ProfilePhotoUrl, 
           DATE_FORMAT(AdmissionDate, "%Y-%m-%d") as AdmissionDate, 
           DATE_FORMAT(DOB, "%Y-%m-%d") as DOB, 
           DATE_FORMAT(DateOfInactive, "%Y-%m-%d") as DateOfInactive,
           DATE_FORMAT(CreatedAt, "%Y-%m-%d %H:%i:%s") as CreatedAt
    FROM Students 
    ORDER BY SrNo ASC`;
db.query(sql,(err,results)=>{
if(err)return res.status(500).json({message:'Student fetch failed',error:err.message});
res.status(200).json(results);
});
});
app.put('/api/update-student',studentPhotoUpload.single('photo'),async (req,res)=>{
const {admissionNo,...updatedFieldsRaw}=req.body;
if(!admissionNo){
return res.status(400).json({message:"Admission number is required for update."});
}
try{
const profilePhotoUrl=req.file
?path.join('/public/uploads/students',req.file.filename).replace(/\\/g,'/')
:(updatedFieldsRaw.profilePhotoUrl||null);
const [[oldStudent]]=await db.promise().query(
`SELECT *, DATE_FORMAT(AdmissionDate, "%Y-%m-%d") as AdmissionDate, DATE_FORMAT(DOB, "%Y-%m-%d") as DOB, DATE_FORMAT(DateOfInactive, "%Y-%m-%d") as DateOfInactive FROM Students WHERE AdmissionNo = ?`,
[admissionNo]
);
if(!oldStudent){
return res.status(404).json({message:"Student not found."});
}
const changes=[];
const setClauses=[];
const queryValues=[];
const updatedFields={...updatedFieldsRaw,profilePhotoUrl};
const compareAndAdd=(fieldName,dbColumn,label,isDate=false)=>{
if(updatedFields[fieldName]!==undefined){
let newValue=updatedFields[fieldName];
let oldValue=oldStudent[dbColumn];
if(dbColumn==='Username'&&typeof newValue==='string'&&newValue.trim()===''){
throw new Error('Username cannot be empty. Please provide a valid username.');
}
if(dbColumn==='Password'){
if(typeof newValue==='string'&&newValue.trim()==='')return;
if(newValue!==oldValue){
changes.push('Password updated');
setClauses.push('Password = ?');
queryValues.push(newValue);
}
return;
}
const finalNewValue=isDate?formatDateForDB(newValue):newValue;
const finalOldValue=isDate?formatDateForDB(oldValue):oldValue;
if(String(finalNewValue||'')!==String(finalOldValue||'')){
changes.push(`${label} changed from "${finalOldValue||'empty'}" to "${finalNewValue||'empty'}"`);
setClauses.push(`${dbColumn} = ?`);
queryValues.push(finalNewValue);
}
}
};
compareAndAdd('fullName','FullName','Full Name');
compareAndAdd('fathersName','FathersName',"Father's Name");
compareAndAdd('mothersName','MothersName',"Mother's Name");
compareAndAdd('phone','Phone','Phone');
compareAndAdd('whatsapp','Whatsapp','WhatsApp');
compareAndAdd('address','Address','Address');
compareAndAdd('currentClass','CurrentClass','Current Class');
compareAndAdd('section','Section','Section');
compareAndAdd('username','Username','Username');
compareAndAdd('password','Password','Password');
compareAndAdd('profilePhotoUrl','ProfilePhotoUrl','Profile Photo');
compareAndAdd('srNo','SrNo','Sr. No.');
compareAndAdd('admissionDate','AdmissionDate','Admission Date',true);
compareAndAdd('dob','DOB','Date of Birth',true);
compareAndAdd('classAdmitted','ClassAdmitted','Class Admitted');
const newIsActive=(updatedFieldsRaw.isActive==='true'||updatedFieldsRaw.isActive===true)?1:0;
if(newIsActive!==oldStudent.IsActive){
changes.push(`Status changed to ${newIsActive===1?'Active':'Inactive'}`);
setClauses.push('IsActive = ?');
queryValues.push(newIsActive);
if(newIsActive===0&&!oldStudent.DateOfInactive){
setClauses.push('DateOfInactive = CURDATE()');
changes.push(`Marked inactive on current date.`);
}else if(newIsActive===1&&oldStudent.DateOfInactive){
setClauses.push('DateOfInactive = NULL');
changes.push(`Reactivated, cleared inactive date.`);
}
}
if(setClauses.length===0){
return res.status(200).json({message:"No changes detected.",student:oldStudent});
}
queryValues.push(admissionNo);
const sql=`UPDATE Students SET ${setClauses.join(', ')} WHERE AdmissionNo = ?`;
await db.promise().query(sql,queryValues);
const [updatedStudentRows]=await db.promise().query(`SELECT * FROM Students WHERE AdmissionNo = ?`,[admissionNo]);
const logDetails=changes.length>0?changes.join('; '):'Student record updated.';
await logStudentActivity('UPDATE','Admin',admissionNo,updatedFields.fullName||oldStudent.FullName,logDetails);
res.status(200).json({message:"✅ Student updated successfully!",student:updatedStudentRows[0]});
}catch(error){
console.error("❌ Error updating student:",error);
if(error.message.includes('Username cannot be empty')){
return res.status(400).json({message:error.message});
}
if(error.code==='ER_DUP_ENTRY'){
return res.status(409).json({message:'That username is already taken. Please choose another.'});
}
res.status(500).json({message:"Failed to update student data.",error:error.message});
}
});
app.post('/api/students/batch-import',async (req,res)=>{
const studentsToImport=req.body;
if(!Array.isArray(studentsToImport)||studentsToImport.length===0){
return res.status(400).json({message:'No student data provided.'});
}
let successCount=0;
const errors=[];
for(const s of studentsToImport){
const sql=`INSERT INTO Students (SrNo, AdmissionDate, AdmissionNo, FullName, FathersName, MothersName, DOB, Address, Phone, Whatsapp, ClassAdmitted, CurrentClass, Section, Username, Password, IsActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const values=[
s['SrNo']||null,formatDateForDB(s['AdmissionDate']),s['AdmissionNo'],s['FullName'],
s['FathersName']||null,s['MothersName']||null,formatDateForDB(s['DOB']),
s['Address']||null,s['Phone']||null,s['Whatsapp']||s['Phone']||null,
s['ClassAdmitted']||null,s['CurrentClass']||null,s['Section']||null,
s['Username']||s['Phone']||s['AdmissionNo'],s['Password']||null,
(s['IsActive']===0||String(s['IsActive']).toLowerCase()==='false')?0:1,
];
try{
await db.promise().query(sql,values);
await logStudentActivity('CREATE','Admin (Batch)',s.AdmissionNo,s.FullName,'Student record created via Excel import.');
successCount++;
}catch(err){
errors.push(`Admission No ${s.AdmissionNo||'(missing)'}: ${err.code==='ER_DUP_ENTRY'?'Already exists.':err.message}`);
}
}
res.status(201).json({
message:`Import complete. ${successCount} added, ${errors.length} failed.`,
errors
});
});
app.get('/api/student-activity-logs',async (req,res)=>{
const page=parseInt(req.query.page,10)||1;
const limit=parseInt(req.query.limit,10)||15;
const offset=(page-1)*limit;
try{
const [[{totalItems}]]=await db.promise().query('SELECT COUNT(*) as totalItems FROM StudentActivityLogs');
const [logs]=await db.promise().query('SELECT * FROM StudentActivityLogs ORDER BY Timestamp DESC LIMIT ? OFFSET ?',[limit,offset]);
res.status(200).json({
logs,
totalPages:Math.ceil(totalItems/limit),
currentPage:page
});
}catch(error){
console.error('❌ Error fetching student activity logs:',error.message);
res.status(500).json({message:'Failed to fetch student activity logs'});
}
});
app.delete('/api/delete-student/:admissionNo',(req,res)=>{
const {admissionNo}=req.params;
db.query('DELETE FROM Students WHERE AdmissionNo = ?',[admissionNo],(err,result)=>{
if(err)return res.status(500).json({message:'Student delete failed',error:err.message});
if(result.affectedRows===0)return res.status(404).json({message:'Student not found'});
res.status(200).json({message:'✅ Student deleted'});
});
});
app.post('/api/teacher-attendance',(req,res)=>{
const {records,teacherName}=req.body;
if(!Array.isArray(records)||records.length===0){
return res.status(400).json({message:'No attendance records provided.'});
}
const sql=`
    INSERT INTO TeacherAttendance (TeacherID, AttendanceDate, Status, MarkedBy, Note)
    VALUES ?
    ON DUPLICATE KEY UPDATE Status = VALUES(Status), MarkedBy = VALUES(MarkedBy), Note = VALUES(Note)`;
const values=records.map(rec=>[rec.teacherId,rec.date,rec.status,teacherName||'Admin',rec.note||null]);
db.query(sql,[values],(err,result)=>{
if(err){
console.error('❌ Error saving teacher attendance:',err.message);
return res.status(500).json({message:'Failed to save teacher attendance',error:err.message});
}
res.status(201).json({message:'✅ Teacher attendance saved successfully',affectedRows:result.affectedRows});
});
});
app.get('/api/teacher-attendance-report',(req,res)=>{
const sql=`
    SELECT a.Id, a.AttendanceDate, a.Status, a.MarkedBy, a.Note, t.Id AS TeacherID, t.FullName
    FROM TeacherAttendance a 
    JOIN Teachers t ON a.TeacherID = t.Id
    ORDER BY a.AttendanceDate DESC, t.FullName;`;
db.query(sql,(err,results)=>{
if(err){
console.error('❌ Error fetching teacher attendance report:',err.message);
return res.status(500).json({message:'Failed to fetch report',error:err.message});
}
res.status(200).json(results);
});
});
app.get('/api/teacher-attendance/:date',(req,res)=>{
const {date}=req.params;
const sql="SELECT TeacherID, Status, Note FROM TeacherAttendance WHERE AttendanceDate = ?";
db.query(sql,[date],(err,results)=>{
if(err){
console.error(`❌ Error fetching teacher attendance for ${date}:`,err.message);
return res.status(500).json({message:'Database query failed'});
}
const attendanceMap=results.reduce((acc,record)=>{
acc[record.TeacherID]={status:record.Status,note:record.Note};
return acc;
},{});
res.status(200).json(attendanceMap);
});
});
app.post('/api/export-attendance',async (req,res)=>{
try{
const {type,startDate,endDate,scopes,statuses}=req.body;
if(!type||!startDate||!endDate){
return res.status(400).json({message:'Type, Start Date, and End Date are required.'});
}
let queryParams=[startDate,endDate];
let baseQuery,whereClauses=["a.AttendanceDate BETWEEN ? AND ?"];
let headers;
if(type==='student'){
baseQuery=`
              SELECT 
                  DATE_FORMAT(a.AttendanceDate, '%d-%m-%Y') as Date,
                  s.AdmissionNo as 'Admission No',
                  s.FullName as 'Student Name',
                  s.CurrentClass as 'Class',
                  s.Section,
                  a.Status,
                  a.Note,
                  a.MarkedByTeacher as 'Marked By'
              FROM Attendance a
              JOIN Students s ON a.StudentAdmissionNo = s.AdmissionNo
          `;
headers=['Date','Admission No','Student Name','Class','Section','Status','Note','Marked By'];
if(scopes&&scopes.length>0){
whereClauses.push(`CONCAT(s.CurrentClass, '-', s.Section) IN (?)`);
queryParams.push(scopes);
}
}else if(type==='teacher'){
baseQuery=`
              SELECT 
                  DATE_FORMAT(a.AttendanceDate, '%d-%m-%Y') as Date,
                  t.Id as 'Teacher ID',
                  t.FullName as 'Teacher Name',
                  a.Status,
                  a.Note,
                  a.MarkedBy as 'Marked By'
              FROM TeacherAttendance a
              JOIN Teachers t ON a.TeacherID = t.Id
          `;
headers=['Date','Teacher ID','Teacher Name','Status','Note','Marked By'];
}else{
return res.status(400).json({message:'Invalid entity type specified.'});
}
if(statuses&&statuses.length>0){
whereClauses.push(`a.Status IN (?)`);
queryParams.push(statuses);
}
const finalQuery=`${baseQuery} WHERE ${whereClauses.join(' AND ')} ORDER BY a.AttendanceDate, FullName;`;
const [results]=await db.promise().query(finalQuery,queryParams);
if(results.length===0){
return res.status(404).json({message:'No records found for the selected criteria.'});
}
const worksheet=XLSX.utils.json_to_sheet(results);
const workbook=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook,worksheet,'Attendance Report');
const columnWidths=headers.map(header=>({
wch:Math.max(header.length,...results.map(row=>row[header]?row[header].toString().length:0))+2
}));
worksheet['!cols']=columnWidths;
const buffer=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
const fileName=`${type}_attendance_${startDate}_to_${endDate}.xlsx`;
res.setHeader('Content-Disposition',`attachment; filename="${fileName}"`);
res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.send(buffer);
}catch(error){
console.error('❌ Error generating attendance export:',error.message);
res.status(500).json({message:'Failed to generate the report.'});
}
});
app.use((req,res)=>{res.status(404).json({message:`❌ Route not found: ${req.method} ${req.originalUrl}`});});
app.use((err,req,res,next)=>{console.error("💥 GLOBAL ERROR HANDLER:",err.stack);res.status(500).json({message:"❌ An unexpected server error occurred."});});
app.listen(PORT,()=>{console.log(`🚀 Server running on http://localhost:${PORT}`);});