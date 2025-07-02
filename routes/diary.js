// my-backend/routes/diary.js

const express = require('express');
const router = express.Router();

// This function takes the database connection `db` as a parameter
// and returns the fully configured router. This is how we share the
// database connection with our route file.
module.exports = (db) => {

  /**
   * @route   GET /api/diary
   * @desc    Get all diary entries
   * @access  Public
   */
  router.get('/', (req, res) => {
    const sql = `SELECT * FROM DiaryEntries ORDER BY EntryDate DESC`;
    db.query(sql, (err, results) => {
      if (err) {
        console.error("❌ Error fetching diary entries:", err.message);
        return res.status(500).json({ message: "Failed to fetch entries", error: err.message });
      }
      const mapped = results.map(entry => ({ id: entry.Id, title: entry.Title, type: entry.Type, description: entry.Description, entryDate: entry.EntryDate, createdAt: entry.CreatedAt }));
      res.status(200).json(mapped);
    });
  });

  /**
   * @route   POST /api/diary
   * @desc    Create a new diary entry
   * @access  Public
   */
  router.post('/', (req, res) => {
    const { id, title, type, description, entryDate } = req.body;
    if (!id || !title || !type || !entryDate || !description) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      return res.status(400).json({ message: "Invalid entryDate format. Use YYYY-MM-DD." });
    }
    const sql = `INSERT INTO DiaryEntries (Id, Title, Type, Description, EntryDate) VALUES (?, ?, ?, ?, ?)`;
    db.query(sql, [id, title, type, description, entryDate], (err, result) => {
      if (err) return res.status(500).json({ message: "Failed to add entry", error: err.message });
      res.status(201).json({ message: "✅ Entry added successfully", id });
    });
  });

  /**
   * @route   PUT /api/diary/:id
   * @desc    Update an existing diary entry
   * @access  Public
   */
  router.put('/:id', (req, res) => {
    const { id } = req.params;
    const { title, type, description, entryDate } = req.body;
    if (!title || !type || !entryDate || !description) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      return res.status(400).json({ message: "Invalid entryDate format." });
    }
    const sql = `UPDATE DiaryEntries SET Title = ?, Type = ?, Description = ?, EntryDate = ? WHERE Id = ?`;
    db.query(sql, [title, type, description, entryDate, id], (err, result) => {
      if (err) return res.status(500).json({ message: "Update failed", error: err.message });
      if (result.affectedRows === 0) return res.status(404).json({ message: "Entry not found" });
      res.status(200).json({ message: "✅ Entry updated successfully" });
    });
  });

  /**
   * @route   DELETE /api/diary/:id
   * @desc    Delete a diary entry
   * @access  Public
   */
  router.delete('/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM DiaryEntries WHERE Id = ?', [id], (err, result) => {
      if (err) return res.status(500).json({ message: 'Delete failed', error: err.message });
      if (result.affectedRows === 0) return res.status(404).json({ message: 'Entry not found' });
      res.status(200).json({ message: '✅ Entry deleted successfully' });
    });
  });

  // Finally, return the configured router to be used by server.js
  return router;
};