
// ========================================================================
// === NODE.JS API ROUTER (Illustrative - Would be in a separate backend file)
// ========================================================================
const express = require('express');
const router = express.Router();

// This function will be exported and will receive the `db` connection pool
module.exports = (db) => {
  /**
   * @route   GET /api/dashboard/stats
   * @desc    Fetch all aggregated data needed for the main admin dashboard
   * @access  Private (should be protected by auth middleware in a real app)
   */
  router.get('/stats', async (req, res) => {
    try {
      // Prepare queries
      const studentsQuery = db.promise().query(
        // REPLACED 'ClassName' with 'CurrentClass, Section'
        'SELECT AdmissionNo, FullName, DATE_FORMAT(DOB, "%Y-%m-%d") as dateOfBirth, CurrentClass, Section FROM Students'
      );
      
      const teachersQuery = db.promise().query(
        'SELECT Id, FullName, Designation, DATE_FORMAT(DateOfBirth, "%Y-%m-%d") as dateOfBirth FROM Teachers'
      );

      const tasksQuery = db.promise().query(
        'SELECT status, dueDate FROM Tasks'
      );
      
      const diaryQuery = db.promise().query(
        'SELECT entryDate FROM DiaryEntries'
      );
      
      const attendanceQuery = db.promise().query(
        // This query fetches attendance for today, including 'On Leave' status if present
        'SELECT StudentAdmissionNo, Status, AttendanceDate FROM Attendance WHERE AttendanceDate = CURDATE()'
      );

      // Optional: Try to fetch events — fallback if table doesn't exist
      let events = [];
      try {
        const [eventRows] = await db.promise().query(
          "SELECT id, title, DATE_FORMAT(startDate, '%Y-%m-%dT%H:%i:%s.000Z') as startDate FROM Events ORDER BY startDate ASC"
        );
        events = eventRows;
      } catch (eventErr) {
        if (eventErr.code === 'ER_NO_SUCH_TABLE') {
          console.warn("⚠️ Events table does not exist — returning empty list.");
        } else {
          // If some other DB error occurs, you can still throw it
          throw eventErr;
        }
      }

      // Run all other queries in parallel
      const [
        [students],
        [teachers],
        [tasks],
        [diary],
        [attendanceToday]
      ] = await Promise.all([
        studentsQuery,
        teachersQuery,
        tasksQuery,
        diaryQuery,
        attendanceQuery
      ]);

      // Send aggregated data
      res.status(200).json({
        students,
        teachers,
        tasks,
        diary,
        attendanceToday,
        events // Always return this, even if empty
      });

    } catch (err) {
      console.error("❌ Error in /api/dashboard/stats endpoint:", err);
      res.status(500).json({ message: "Failed to load dashboard data." });
    }
  });

  return router;
};
