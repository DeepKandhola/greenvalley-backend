const mysql = require('mysql2/promise'); 

const db = mysql.createPool({
  host: 'srv1365.hstgr.io',
  user: 'u740019718_GVPS_Databa',
  password: '@Raymond1990',
  database: 'u740019718_SchoolSite',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true // <<<<<<<<<<< MAKE SURE THIS IS TRUE
});

module.exports = db;