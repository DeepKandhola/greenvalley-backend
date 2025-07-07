// File: Test.js (or updateScript.js)

const db = require('./db');

// --- Main function to run our logic ---
async function updateRecord() {
    console.log("Starting the update process...");
    
    // --- Step 1: Define Table and Column Names ---
    const tableName = 'Test';
    const columnName = 'content1';
    const columnType = 'VARCHAR(255)'; // Define the type for the new column

    try {
        // --- Step 2: Check if the column exists ---
        console.log(`Checking if column '${columnName}' exists in table '${tableName}'...`);

        // This query checks the database's own records for the column.
        const checkColumnSql = `
            SELECT * 
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? 
              AND TABLE_NAME = ? 
              AND COLUMN_NAME = ?`;
        
        // We get the database name directly from the connection config to make it robust.
        const [columns] = await db.query(checkColumnSql, [db.pool.config.database, tableName, columnName]);

        // --- Step 3: If column doesn't exist, create it ---
        if (columns.length === 0) {
            console.log(`Column '${columnName}' does not exist. Creating it now...`);

            // The SQL command to add a new column to an existing table.
            const addColumnSql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`;
            
            await db.query(addColumnSql);
            console.log(`✅ Column '${columnName}' created successfully.`);
        } else {
            console.log(`Column '${columnName}' already exists. Skipping creation.`);
        }
        
        // --- Step 4: Proceed with the original update logic ---
        console.log("Proceeding to update the record...");

        const idToUpdate = 1; 
        const newContent = `Updated automatically at ${new Date().toLocaleString()}`;

        const updateSql = `UPDATE ${tableName} SET ${columnName} = ? WHERE ID = ?`;
        const [result] = await db.query(updateSql, [newContent, idToUpdate]);
        
        // --- Step 5: Report the result ---
        if (result.affectedRows > 0) {
            console.log(`✅ Success! Row with ID ${idToUpdate} was updated.`);
            console.log(`   New content is: "${newContent}"`);
        } else {
            // This could happen if the row with ID=1 doesn't exist.
            // Let's add it for completeness.
            console.log(`⚠️ Notice: Row with ID ${idToUpdate} not found. Let's insert it.`);
            const insertSql = `INSERT INTO ${tableName} (ID, ${columnName}) VALUES (?, ?)`;
            await db.query(insertSql, [idToUpdate, newContent]);
            console.log(`✅ Row with ID ${idToUpdate} has been inserted with the new content.`);
        }

    } catch (error) {
        console.error("❌ An error occurred during the script execution:", error);
    } finally {
        // --- Step 6: Close the connection ---
        console.log("Process finished. Closing database connection pool.");
        await db.end();
    }
}

// --- Run the main function ---
updateRecord();