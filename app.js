/**
 * COMPLETE QR CODE SCHOOL ATTENDANCE MANAGEMENT SYSTEM
 * Express.js + SQLite3 + Embedded Native SPA Client (Admin, Scanner, Student)
 */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Setup
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'qr_school_attendance_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Initialize SQLite Database
const dbFile = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbFile);

// Database Initialization & Migrations
db.serialize(() => {
  // Users Table (Admin, Scanner User, Student)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT CHECK(role IN ('admin', 'scanner', 'student')),
    student_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Students Table
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    grade_level TEXT NOT NULL,
    section TEXT NOT NULL,
    gender TEXT,
    dob TEXT,
    contact TEXT,
    email TEXT,
    address TEXT,
    guardian_name TEXT,
    guardian_contact TEXT,
    profile_picture TEXT,
    school_year TEXT DEFAULT '2026-2027',
    status TEXT DEFAULT 'Active',
    qr_token TEXT UNIQUE NOT NULL,
    qr_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Events Table
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    event_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    location TEXT,
    organizer TEXT,
    attendance_type TEXT DEFAULT 'General',
    status TEXT DEFAULT 'Upcoming',
    allowed_grade TEXT DEFAULT 'All',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Attendance Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    scan_date TEXT NOT NULL,
    time_in TEXT,
    time_out TEXT,
    status TEXT NOT NULL CHECK(status IN ('Present', 'Late', 'Absent', 'Excused')),
    scanned_by TEXT DEFAULT 'Scanner Portal',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, event_id, scan_date)
  )`);

  // Excuses Table
  db.run(`CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // System Settings Table
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Audit Logs Table
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    action TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Insert Default System Settings if not exists
  const defaultSettings = [
    ['school_name', 'Global Academy Institute of Technology'],
    ['school_address', '123 Academic Way, Knowledge City'],
    ['school_contact', '(02) 8800-1234 | info@globalacademy.edu'],
    ['current_school_year', '2026-2027'],
    ['late_threshold_mins', '15'],
    ['low_attendance_threshold', '75'],
    ['auto_backup_enabled', '1']
  ];
  defaultSettings.forEach(([k, v]) => {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  });

  // Seed Default Super Admin Account
  const defaultPasswordHash = bcrypt.hashSync('admin123', 10);
  db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)`, 
    ['admin', defaultPasswordHash, 'admin']
  );

  // Seed Default Scanner User
  const defaultScannerHash = bcrypt.hashSync('scanner123', 10);
  db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)`, 
    ['scanner', defaultScannerHash, 'scanner']
  );

  // Seed Initial Default General Attendance Event
  const today = new Date().toISOString().split('T')[0];
  db.run(`INSERT OR IGNORE INTO events (id, name, description, event_date, start_time, end_time, location, organizer, status) 
    VALUES (1, 'Daily General Attendance', 'Standard Daily School Check-In', ?, '07:30', '17:00', 'Main Campus Gate', 'Administration', 'Active')`, [today]);
});

// Helper Function for Audit Logging
function logAudit(username, action, details = '') {
  db.run(`INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)`, [username || 'System', action, details]);
}

// Authentication Middleware
function requireAuth(roles = []) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Unauthorized. Please log in.' });
    }
    if (roles.length > 0 && !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden. Access denied.' });
    }
    next();
  };
}

// ==========================================
// API REST ENDPOINTS
// ==========================================

// Auth Routes
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });

    if (bcrypt.compareSync(password, user.password)) {
      req.session.user = { id: user.id, username: user.username, role: user.role, student_id: user.student_id };
      logAudit(user.username, 'LOGIN', `User logged in with role: ${user.role}`);
      return res.json({ success: true, role: user.role, username: user.username, student_id: user.student_id });
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  const username = req.session.user ? req.session.user.username : 'User';
  logAudit(username, 'LOGOUT', 'User logged out');
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

app.post('/api/auth/change-password', requireAuth(['admin', 'student', 'scanner']), (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.session.user.id;

  db.get(`SELECT password FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'Database error' });
    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    const hashed = bcrypt.hashSync(newPassword, 10);
    db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, userId], (err2) => {
      if (err2) return res.status(500).json({ error: 'Failed to update password' });
      logAudit(req.session.user.username, 'CHANGE_PASSWORD', 'Password successfully changed');
      res.json({ success: true, message: 'Password updated successfully' });
    });
  });
});

// Dashboard Analytics API
app.get('/api/dashboard/stats', requireAuth(['admin']), (req, res) => {
  const { eventId, grade, section, date } = req.query;
  const filterDate = date || new Date().toISOString().split('T')[0];

  const queries = {
    totalStudents: `SELECT COUNT(*) as count FROM students WHERE status = 'Active'`,
    totalEvents: `SELECT COUNT(*) as count FROM events`,
    activeEvent: `SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1`
  };

  db.get(queries.totalStudents, [], (err, totalStuRow) => {
    db.get(queries.totalEvents, [], (err, totalEvtRow) => {
      db.get(queries.activeEvent, [], (err, activeEvt) => {
        let attSql = `
          SELECT a.status, COUNT(*) as count 
          FROM attendance a
          JOIN students s ON a.student_id = s.student_id
          WHERE a.scan_date = ?
        `;
        let params = [filterDate];

        if (eventId) { attSql += ` AND a.event_id = ?`; params.push(eventId); }
        if (grade) { attSql += ` AND s.grade_level = ?`; params.push(grade); }
        if (section) { attSql += ` AND s.section = ?`; params.push(section); }
        attSql += ` GROUP BY a.status`;

        db.all(attSql, params, (err, attRows) => {
          let stats = { Present: 0, Late: 0, Absent: 0, Excused: 0 };
          (attRows || []).forEach(r => stats[r.status] = r.count);

          const totalScanned = stats.Present + stats.Late + stats.Excused;
          const totalStudents = totalStuRow ? totalStuRow.count : 0;
          const calculatedAbsent = Math.max(0, totalStudents - totalScanned);
          const attPercentage = totalStudents > 0 ? (((stats.Present + stats.Late + stats.Excused) / totalStudents) * 100).toFixed(1) : 0;

          // Fetch Recent Scans
          db.all(`
            SELECT a.*, s.full_name, s.grade_level, s.section, s.profile_picture, e.name as event_name
            FROM attendance a
            JOIN students s ON a.student_id = s.student_id
            JOIN events e ON a.event_id = e.id
            ORDER BY a.id DESC LIMIT 10
          `, [], (err, recentScans) => {
            res.json({
              totalStudents,
              presentToday: stats.Present,
              lateToday: stats.Late,
              absentToday: calculatedAbsent,
              excusedToday: stats.Excused,
              attendancePercentage: attPercentage,
              totalEvents: totalEvtRow ? totalEvtRow.count : 0,
              activeEvent: activeEvt || null,
              recentScans: recentScans || []
            });
          });
        });
      });
    });
  });
});

// Analytics Chart Data Endpoint
app.get('/api/dashboard/charts', requireAuth(['admin']), (req, res) => {
  // By Grade Level
  db.all(`
    SELECT s.grade_level, COUNT(a.id) as count
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    WHERE a.status IN ('Present', 'Late')
    GROUP BY s.grade_level
  `, [], (err, gradeData) => {
    // Trends over time
    db.all(`
      SELECT scan_date, status, COUNT(*) as count 
      FROM attendance 
      GROUP BY scan_date, status 
      ORDER BY scan_date DESC LIMIT 30
    `, [], (err, trendData) => {
      res.json({
        byGrade: gradeData || [],
        trends: trendData || []
      });
    });
  });
});

// Student Management APIs
app.get('/api/students', requireAuth(['admin', 'scanner']), (req, res) => {
  const { search, grade, section, status } = req.query;
  let sql = `SELECT * FROM students WHERE 1=1`;
  let params = [];

  if (search) {
    sql += ` AND (student_id LIKE ? OR full_name LIKE ? OR first_name LIKE ? OR last_name LIKE ?)`;
    const query = `%${search}%`;
    params.push(query, query, query, query);
  }
  if (grade) { sql += ` AND grade_level = ?`; params.push(grade); }
  if (section) { sql += ` AND section = ?`; params.push(section); }
  if (status) { sql += ` AND status = ?`; params.push(status); }

  sql += ` ORDER BY full_name ASC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/students', requireAuth(['admin']), async (req, res) => {
  const data = req.body;
  if (!data.student_id || !data.first_name || !data.last_name || !data.grade_level || !data.section) {
    return res.status(400).json({ error: 'Missing required student details.' });
  }

  const fullName = `${data.last_name}, ${data.first_name} ${data.middle_name || ''}`.trim();
  const qrToken = 'QR-' + crypto.randomBytes(8).toString('hex').toUpperCase();

  const sql = `INSERT INTO students 
    (student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, profile_picture, school_year, status, qr_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
    data.student_id, data.first_name, data.middle_name, data.last_name, fullName,
    data.grade_level, data.section, data.gender, data.dob, data.contact, data.email,
    data.address, data.guardian_name, data.guardian_contact, data.profile_picture || '',
    data.school_year || '2026-2027', data.status || 'Active', qrToken
  ];

  db.run(sql, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Student ID or QR Code already exists.' });
      return res.status(500).json({ error: err.message });
    }
    
    // Auto Create Student Login Account
    const defaultStudentPass = bcrypt.hashSync(data.student_id, 10);
    db.run(`INSERT OR IGNORE INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)`, 
      [data.student_id, defaultStudentPass, data.student_id]
    );

    logAudit(req.session.user.username, 'CREATE_STUDENT', `Created student: ${fullName} (${data.student_id})`);
    res.json({ success: true, id: this.lastID, qr_token: qrToken });
  });
});

app.put('/api/students/:id', requireAuth(['admin']), (req, res) => {
  const data = req.body;
  const fullName = `${data.last_name}, ${data.first_name} ${data.middle_name || ''}`.trim();

  const sql = `UPDATE students SET 
    first_name = ?, middle_name = ?, last_name = ?, full_name = ?, grade_level = ?, section = ?,
    gender = ?, dob = ?, contact = ?, email = ?, address = ?, guardian_name = ?, guardian_contact = ?,
    profile_picture = ?, school_year = ?, status = ? WHERE id = ?`;

  const params = [
    data.first_name, data.middle_name, data.last_name, fullName, data.grade_level, data.section,
    data.gender, data.dob, data.contact, data.email, data.address, data.guardian_name,
    data.guardian_contact, data.profile_picture, data.school_year, data.status, req.params.id
  ];

  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'UPDATE_STUDENT', `Updated student ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/students/:id', requireAuth(['admin']), (req, res) => {
  db.get(`SELECT student_id, full_name FROM students WHERE id = ?`, [req.params.id], (err, row) => {
    if (row) {
      db.run(`DELETE FROM students WHERE id = ?`, [req.params.id]);
      db.run(`DELETE FROM users WHERE student_id = ?`, [row.student_id]);
      logAudit(req.session.user.username, 'DELETE_STUDENT', `Deleted student: ${row.full_name} (${row.student_id})`);
    }
    res.json({ success: true });
  });
});

// QR Code Actions Endpoint
app.post('/api/students/:id/regenerate-qr', requireAuth(['admin']), (req, res) => {
  const newQrToken = 'QR-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  db.run(`UPDATE students SET qr_token = ?, qr_active = 1 WHERE id = ?`, [newQrToken, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Failed to regenerate QR code' });
    logAudit(req.session.user.username, 'REGENERATE_QR', `Regenerated QR for student ID: ${req.params.id}`);
    res.json({ success: true, qr_token: newQrToken });
  });
});

app.post('/api/students/:id/toggle-qr', requireAuth(['admin']), (req, res) => {
  const { active } = req.body;
  db.run(`UPDATE students SET qr_active = ? WHERE id = ?`, [active ? 1 : 0, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Failed to update QR state' });
    logAudit(req.session.user.username, 'TOGGLE_QR', `Set QR active = ${active} for student ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

// Generate Rendered Data URL QR Code
app.get('/api/qr/render/:token', async (req, res) => {
  try {
    const url = await QRCode.toDataURL(req.params.token, { margin: 1, width: 250 });
    const img = Buffer.from(url.split(',')[1], 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
    res.end(img);
  } catch (err) {
    res.status(500).send('Error generating QR code');
  }
});

// Event Management APIs
app.get('/api/events', requireAuth(['admin', 'scanner']), (req, res) => {
  db.all(`SELECT * FROM events ORDER BY id DESC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/events', requireAuth(['admin']), (req, res) => {
  const { name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade } = req.body;
  
  const sql = `INSERT INTO events (name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [name, description, event_date, start_time, end_time, location, organizer, attendance_type || 'General', status || 'Upcoming', allowed_grade || 'All', req.session.user.username];

  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'CREATE_EVENT', `Created event: ${name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/events/:id', requireAuth(['admin']), (req, res) => {
  const { name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade } = req.body;
  const sql = `UPDATE events SET name=?, description=?, event_date=?, start_time=?, end_time=?, location=?, organizer=?, attendance_type=?, status=?, allowed_grade=? WHERE id=?`;
  db.run(sql, [name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'UPDATE_EVENT', `Updated event ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/events/:id', requireAuth(['admin']), (req, res) => {
  db.run(`DELETE FROM events WHERE id = ?`, [req.params.id], (err) => {
    logAudit(req.session.user.username, 'DELETE_EVENT', `Deleted event ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

// ATTENDANCE SCANNER CORE ENGINE
app.post('/api/attendance/scan', requireAuth(['admin', 'scanner']), (req, res) => {
  const { qr_token, event_id, scan_type } = req.body; // scan_type = 'IN' or 'OUT'
  const today = new Date().toISOString().split('T')[0];
  const nowTime = new Date().toLocaleTimeString('en-US', { hour12: false });

  if (!qr_token || !event_id) {
    return res.status(400).json({ status: 'INVALID', message: 'Missing scan payload.' });
  }

  // 1. Validate Student QR Token
  db.get(`SELECT * FROM students WHERE qr_token = ?`, [qr_token], (err, student) => {
    if (err || !student) {
      return res.status(404).json({ status: 'INVALID', message: 'Invalid QR Code. Student record not found.' });
    }

    if (student.qr_active !== 1) {
      return res.status(403).json({ status: 'DISABLED', message: 'This QR Code has been disabled.' });
    }

    if (student.status !== 'Active') {
      return res.status(403).json({ status: 'INACTIVE', message: 'Student account is inactive.' });
    }

    // 2. Validate Event Restrictions
    db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
      if (err || !event) {
        return res.status(404).json({ status: 'INVALID_EVENT', message: 'Selected event not found.' });
      }

      if (event.allowed_grade !== 'All' && event.allowed_grade !== student.grade_level) {
        return res.status(403).json({ status: 'NOT_ELIGIBLE', message: `Student Grade (${student.grade_level}) not eligible for this event (${event.allowed_grade} required).` });
      }

      // 3. Check Duplicate or Update Time Out
      db.get(`SELECT * FROM attendance WHERE student_id = ? AND event_id = ? AND scan_date = ?`, 
        [student.student_id, event_id, today], (err, record) => {
        
        if (scan_type === 'OUT') {
          if (!record) {
            return res.status(400).json({ status: 'NO_TIME_IN', message: 'Cannot Time Out without an active Time In record.' });
          }
          if (record.time_out) {
            return res.status(409).json({ status: 'DUPLICATE', message: 'Time Out already recorded for this event.', student });
          }
          
          db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [nowTime, record.id], (err) => {
            logAudit(req.session.user.username, 'TIME_OUT', `${student.full_name} timed out for event ${event.name}`);
            return res.json({ status: 'SUCCESS_OUT', message: 'Time Out successfully recorded.', student, time_out: nowTime });
          });
        } else {
          // TIME IN Logic
          if (record) {
            return res.json({ status: 'DUPLICATE', message: 'Attendance already recorded for this event.', student, record });
          }

          // Determine Present vs Late based on threshold
          db.get(`SELECT value FROM settings WHERE key = 'late_threshold_mins'`, [], (err, setting) => {
            const thresholdMins = parseInt(setting ? setting.value : '15', 10);
            let attStatus = 'Present';

            if (event.start_time) {
              const [eHour, eMin] = event.start_time.split(':').map(Number);
              const eventStart = new Date();
              eventStart.setHours(eHour, eMin, 0);

              const lateCutoff = new Date(eventStart.getTime() + thresholdMins * 60000);
              const now = new Date();

              if (now > lateCutoff) {
                attStatus = 'Late';
              }
            }

            db.run(`INSERT INTO attendance (student_id, event_id, scan_date, time_in, status, scanned_by) VALUES (?, ?, ?, ?, ?, ?)`,
              [student.student_id, event_id, today, nowTime, attStatus, req.session.user.username],
              function(err) {
                if (err) return res.status(500).json({ status: 'ERROR', message: 'Failed to record attendance.' });
                
                logAudit(req.session.user.username, 'ATTENDANCE_IN', `${student.full_name} scanned IN as ${attStatus}`);
                return res.json({ 
                  status: 'SUCCESS_IN', 
                  message: `Attendance recorded: ${attStatus}`, 
                  student, 
                  att_status: attStatus,
                  time_in: nowTime 
                });
              }
            );
          });
        }
      });
    });
  });
});

// Get Detailed Attendance Records with Filters
app.get('/api/attendance/records', requireAuth(['admin']), (req, res) => {
  const { search, grade, section, event_id, date, status } = req.query;

  let sql = `
    SELECT a.*, s.full_name, s.grade_level, s.section, e.name as event_name
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
    WHERE 1=1
  `;
  let params = [];

  if (search) {
    sql += ` AND (s.student_id LIKE ? OR s.full_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  if (grade) { sql += ` AND s.grade_level = ?`; params.push(grade); }
  if (section) { sql += ` AND s.section = ?`; params.push(section); }
  if (event_id) { sql += ` AND a.event_id = ?`; params.push(event_id); }
  if (date) { sql += ` AND a.scan_date = ?`; params.push(date); }
  if (status) { sql += ` AND a.status = ?`; params.push(status); }

  sql += ` ORDER BY a.id DESC`;

  db.all(sql, params, (err, rows) => {
    res.json(rows || []);
  });
});

app.put('/api/attendance/:id', requireAuth(['admin']), (req, res) => {
  const { status, time_in, time_out } = req.body;
  db.run(`UPDATE attendance SET status = ?, time_in = ?, time_out = ? WHERE id = ?`, 
    [status, time_in, time_out, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'EDIT_ATTENDANCE', `Updated record ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/attendance/:id', requireAuth(['admin']), (req, res) => {
  db.run(`DELETE FROM attendance WHERE id = ?`, [req.params.id], (err) => {
    logAudit(req.session.user.username, 'DELETE_ATTENDANCE', `Deleted record ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

// Excuses Management API
app.post('/api/excuses', requireAuth(['admin']), (req, res) => {
  const { student_id, event_id, reason, notes, date } = req.body;
  db.run(`INSERT INTO excuses (student_id, event_id, reason, notes, approved_by, date) VALUES (?, ?, ?, ?, ?, ?)`,
    [student_id, event_id, reason, notes, req.session.user.username, date], function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Upsert Attendance as Excused
      db.run(`INSERT INTO attendance (student_id, event_id, scan_date, status, scanned_by) 
        VALUES (?, ?, ?, 'Excused', ?)
        ON CONFLICT(student_id, event_id, scan_date) DO UPDATE SET status = 'Excused'`,
        [student_id, event_id, date, req.session.user.username], (err2) => {
          logAudit(req.session.user.username, 'ADD_EXCUSE', `Added excuse for student ${student_id}`);
          res.json({ success: true });
        }
      );
    }
  );
});

// Reports Generation & Analytics API
app.get('/api/reports/summary', requireAuth(['admin']), (req, res) => {
  const { type, startDate, endDate, grade, section, event_id } = req.query;

  let sql = `
    SELECT 
      a.scan_date, a.status, COUNT(*) as count,
      s.grade_level, s.section, e.name as event_name
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
    WHERE 1=1
  `;
  let params = [];

  if (startDate && endDate) {
    sql += ` AND a.scan_date BETWEEN ? AND ?`;
    params.push(startDate, endDate);
  }
  if (grade) { sql += ` AND s.grade_level = ?`; params.push(grade); }
  if (section) { sql += ` AND s.section = ?`; params.push(section); }
  if (event_id) { sql += ` AND a.event_id = ?`; params.push(event_id); }

  sql += ` GROUP BY a.scan_date, a.status ORDER BY a.scan_date DESC`;

  db.all(sql, params, (err, rows) => {
    res.json(rows || []);
  });
});

// Low Attendance & Frequent Late Identification
app.get('/api/reports/insights', requireAuth(['admin']), (req, res) => {
  db.get(`SELECT value FROM settings WHERE key = 'low_attendance_threshold'`, [], (err, setting) => {
    const minPct = parseFloat(setting ? setting.value : '75');

    db.all(`
      SELECT 
        s.student_id, s.full_name, s.grade_level, s.section,
        COUNT(CASE WHEN a.status IN ('Present', 'Late', 'Excused') THEN 1 END) as attended,
        COUNT(a.id) as total_events,
        COUNT(CASE WHEN a.status = 'Late' THEN 1 END) as late_count
      FROM students s
      LEFT JOIN attendance a ON s.student_id = a.student_id
      WHERE s.status = 'Active'
      GROUP BY s.student_id
    `, [], (err, rows) => {
      const lowAttendance = [];
      const frequentLate = [];

      (rows || []).forEach(r => {
        const pct = r.total_events > 0 ? (r.attended / r.total_events) * 100 : 100;
        if (pct < minPct && r.total_events > 0) {
          lowAttendance.push({ ...r, percentage: pct.toFixed(1) });
        }
        if (r.late_count >= 3) {
          frequentLate.push(r);
        }
      });

      res.json({ lowAttendance, frequentLate });
    });
  });
});

// CSV Export Endpoint
app.get('/api/export/csv', requireAuth(['admin']), (req, res) => {
  const type = req.query.type || 'attendance';
  
  if (type === 'students') {
    db.all(`SELECT student_id, full_name, grade_level, section, gender, contact, email, status FROM students`, [], (err, rows) => {
      let csv = 'Student ID,Full Name,Grade Level,Section,Gender,Contact,Email,Status\n';
      (rows || []).forEach(r => {
        csv += `"${r.student_id}","${r.full_name}","${r.grade_level}","${r.section}","${r.gender}","${r.contact}","${r.email}","${r.status}"\n`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="Students_Export.csv"');
      res.send(csv);
    });
  } else {
    db.all(`
      SELECT a.scan_date, s.student_id, s.full_name, s.grade_level, s.section, e.name as event_name, a.time_in, a.time_out, a.status
      FROM attendance a
      JOIN students s ON a.student_id = s.student_id
      JOIN events e ON a.event_id = e.id
      ORDER BY a.scan_date DESC
    `, [], (err, rows) => {
      let csv = 'Date,Student ID,Full Name,Grade Level,Section,Event,Time In,Time Out,Status\n';
      (rows || []).forEach(r => {
        csv += `"${r.scan_date}","${r.student_id}","${r.full_name}","${r.grade_level}","${r.section}","${r.event_name}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="Attendance_Report.csv"');
      res.send(csv);
    });
  }
});

// Student Portal Profile API
app.get('/api/student/profile', requireAuth(['student']), (req, res) => {
  const studentId = req.session.user.student_id;

  db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, student) => {
    if (err || !student) return res.status(404).json({ error: 'Student record not found.' });

    db.all(`
      SELECT a.*, e.name as event_name, e.event_date
      FROM attendance a
      JOIN events e ON a.event_id = e.id
      WHERE a.student_id = ?
      ORDER BY a.scan_date DESC
    `, [studentId], (err, history) => {
      const records = history || [];
      const presentCount = records.filter(r => r.status === 'Present').length;
      const lateCount = records.filter(r => r.status === 'Late').length;
      const excusedCount = records.filter(r => r.status === 'Excused').length;
      const absentCount = records.filter(r => r.status === 'Absent').length;

      const totalEvents = records.length;
      const pct = totalEvents > 0 ? (((presentCount + lateCount + excusedCount) / totalEvents) * 100).toFixed(1) : 100;

      res.json({
        student,
        stats: { totalEvents, presentCount, lateCount, excusedCount, absentCount, percentage: pct },
        history: records
      });
    });
  });
});

// Settings & System Backup APIs
app.get('/api/settings', requireAuth(['admin']), (req, res) => {
  db.all(`SELECT * FROM settings`, [], (err, rows) => {
    let settingsObj = {};
    (rows || []).forEach(r => settingsObj[r.key] = r.value);
    res.json(settingsObj);
  });
});

app.post('/api/settings', requireAuth(['admin']), (req, res) => {
  const settings = req.body;
  db.serialize(() => {
    Object.keys(settings).forEach(key => {
      db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`, [key, settings[key], settings[key]]);
    });
    logAudit(req.session.user.username, 'UPDATE_SETTINGS', 'System settings updated');
    res.json({ success: true });
  });
});

app.get('/api/audit-logs', requireAuth(['admin']), (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/backup/download', requireAuth(['admin']), (req, res) => {
  logAudit(req.session.user.username, 'BACKUP_DB', 'Downloaded database backup');
  res.download(dbFile, `Attendance_DB_Backup_${new Date().toISOString().split('T')[0]}.sqlite`);
});

// ==========================================
// EMBEDDED FRONTEND APPLICATION ROUTER
// ==========================================

const CLIENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Code School Attendance System</title>
  <!-- Tailwind CSS & HTML5-QRCode Libraries -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <style>
    /* Printing Layout Specs: Exact 8 IDs per A4 Page */
    @media print {
      body * { visibility: hidden; }
      #print-section, #print-section * { visibility: visible; }
      #print-section { position: absolute; left: 0; top: 0; width: 100%; }
      .no-print { display: none !important; }
      .a4-page {
        width: 210mm;
        height: 297mm;
        padding: 8mm;
        margin: 0 auto;
        box-sizing: border-box;
        page-break-after: always;
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        grid-template-rows: repeat(4, 1fr);
        gap: 6mm;
      }
    }
    .id-card-border {
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
    }
  </style>
</head>
<body class="bg-slate-100 font-sans text-slate-800 antialiased min-h-screen">

  <div id="app" class="min-h-screen flex flex-col">
    <!-- TOP NAVBAR -->
    <header id="navbar" class="bg-indigo-900 text-white shadow-md no-print hidden">
      <div class="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
        <div class="flex items-center gap-3">
          <i class="fa-solid fa-qrcode text-2xl text-indigo-300"></i>
          <span class="font-bold text-lg tracking-wide" id="nav-school-name">Global Academy System</span>
        </div>
        <div id="user-menu" class="flex items-center gap-4 text-sm">
          <span id="user-badge" class="bg-indigo-800 px-3 py-1 rounded-full text-indigo-200"></span>
          <button onclick="logout()" class="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-white font-medium transition">
            <i class="fa-solid fa-right-from-bracket mr-1"></i> Logout
          </button>
        </div>
      </div>
    </header>

    <!-- CONTENT WRAPPER -->
    <main class="flex-grow flex flex-col">
      <!-- LOGIN VIEW -->
      <section id="view-login" class="flex-grow flex items-center justify-center p-4">
        <div class="bg-white p-8 rounded-xl shadow-xl max-w-md w-full border border-slate-200">
          <div class="text-center mb-6">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full mb-3">
              <i class="fa-solid fa-school text-3xl"></i>
            </div>
            <h2 class="text-2xl font-bold text-slate-900">Portal Login</h2>
            <p class="text-sm text-slate-500">Sign in to access Attendance Portal</p>
          </div>
          
          <div id="login-error" class="hidden mb-4 p-3 bg-red-100 text-red-700 text-sm rounded-lg"></div>

          <form onsubmit="handleLogin(event)" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Username / Student ID</label>
              <input type="text" id="login-username" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none">
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input type="password" id="login-password" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none">
            </div>
            <button type="submit" class="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow transition">
              Sign In
            </button>
          </form>

          <div class="mt-6 pt-4 border-t text-center text-xs text-slate-500">
            <p class="mb-2">Dedicated Portals:</p>
            <a href="/scanner" class="text-indigo-600 hover:underline font-semibold mx-2"><i class="fa-solid fa-camera"></i> Open Scanner Portal</a>
          </div>
        </div>
      </section>

      <!-- ADMIN DASHBOARD LAYOUT -->
      <section id="view-admin" class="hidden flex-grow flex flex-col md:flex-row">
        <!-- SIDEBAR -->
        <aside class="w-full md:w-64 bg-slate-900 text-slate-300 flex-shrink-0 no-print">
          <nav class="p-4 space-y-1">
            <button onclick="switchTab('dash')" class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-800 transition"><i class="fa-solid fa-chart-line w-5"></i> Dashboard</button>
            <button onclick="switchTab('students')" class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-800 transition"><i class="fa-solid fa-user-graduate w-5"></i> Students</button>
            <button onclick="switchTab('events')" class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-800 transition"><i class="fa-solid fa-calendar-check w-5"></i> Events</button>
            <button onclick="switchTab('attendance')" class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-800 transition"><i class="fa-solid fa-clock w-5"></i> Attendance Log</button>
            <button onclick="switchTab('reports')" class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-800 transition"><i class="fa-solid fa-file-invoice w-5"></i> Reports</button>
            <button onclick="switchTab('idcards')" class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-800 transition"><i class="fa-solid fa-address-card w-5"></i> Print ID Cards</button>
            <button onclick="switchTab('settings')" class="nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-800 transition"><i class="fa-solid fa-gear w-5"></i> System Settings</button>
            <a href="/scanner" target="_blank" class="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium mt-6 transition"><i class="fa-solid fa-expand w-5"></i> Open Scanner Window</a>
          </nav>
        </aside>

        <!-- MAIN DASHBOARD CONTENT AREA -->
        <div class="flex-grow p-6 overflow-y-auto no-print">
          
          <!-- TAB 1: DASHBOARD METRICS -->
          <div id="tab-dash" class="tab-content space-y-6">
            <div class="flex justify-between items-center">
              <h1 class="text-2xl font-bold text-slate-800">System Dashboard</h1>
              <div class="text-sm text-slate-500 font-medium" id="current-datetime"></div>
            </div>

            <!-- Dashboard Filters -->
            <div class="bg-white p-4 rounded-xl shadow-sm border flex flex-wrap gap-4 items-center">
              <span class="text-sm font-semibold text-slate-600">Filters:</span>
              <select id="dash-filter-grade" onchange="loadDashboardStats()" class="border px-3 py-1.5 rounded text-sm">
                <option value="">All Grade Levels</option>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="Grade 9">Grade 9</option>
                <option value="Grade 10">Grade 10</option>
                <option value="Grade 11">Grade 11</option>
                <option value="Grade 12">Grade 12</option>
              </select>
              <input type="date" id="dash-filter-date" onchange="loadDashboardStats()" class="border px-3 py-1.5 rounded text-sm">
            </div>

            <!-- KPI Cards -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
                <div class="text-xs text-slate-500 font-bold uppercase">Total Students</div>
                <div class="text-3xl font-extrabold text-slate-800 mt-2" id="kpi-total-students">0</div>
              </div>
              <div class="bg-white p-5 rounded-xl shadow-sm border border-emerald-200 bg-emerald-50/30">
                <div class="text-xs text-emerald-600 font-bold uppercase">Present Today</div>
                <div class="text-3xl font-extrabold text-emerald-600 mt-2" id="kpi-present">0</div>
              </div>
              <div class="bg-white p-5 rounded-xl shadow-sm border border-amber-200 bg-amber-50/30">
                <div class="text-xs text-amber-600 font-bold uppercase">Late Today</div>
                <div class="text-3xl font-extrabold text-amber-600 mt-2" id="kpi-late">0</div>
              </div>
              <div class="bg-white p-5 rounded-xl shadow-sm border border-rose-200 bg-rose-50/30">
                <div class="text-xs text-rose-600 font-bold uppercase">Absent Today</div>
                <div class="text-3xl font-extrabold text-rose-600 mt-2" id="kpi-absent">0</div>
              </div>
            </div>

            <!-- Live Monitor & Recent Scans -->
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div class="lg:col-span-2 bg-white p-5 rounded-xl shadow-sm border">
                <h3 class="font-bold text-slate-800 mb-4">Live Attendance Monitor</h3>
                <div class="overflow-x-auto">
                  <table class="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr class="border-b bg-slate-50 text-slate-600">
                        <th class="p-3">Student</th>
                        <th class="p-3">Grade & Section</th>
                        <th class="p-3">Time In</th>
                        <th class="p-3">Status</th>
                      </tr>
                    </thead>
                    <tbody id="recent-scans-tbody"></tbody>
                  </table>
                </div>
              </div>

              <div class="bg-white p-5 rounded-xl shadow-sm border space-y-4">
                <h3 class="font-bold text-slate-800">Active Event</h3>
                <div id="active-event-card" class="p-4 bg-indigo-50 border border-indigo-100 rounded-lg">
                  <div class="font-bold text-indigo-900" id="active-evt-title">None Active</div>
                  <div class="text-xs text-indigo-700 mt-1" id="active-evt-time">-</div>
                </div>

                <h3 class="font-bold text-slate-800 pt-2">Attendance Rate</h3>
                <div class="text-center p-4 bg-slate-50 rounded-lg">
                  <span class="text-4xl font-extrabold text-indigo-600" id="kpi-att-rate">0%</span>
                  <p class="text-xs text-slate-500 mt-1">Overall Participation</p>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB 2: STUDENT MANAGEMENT -->
          <div id="tab-students" class="tab-content hidden space-y-6">
            <div class="flex flex-wrap justify-between items-center gap-4">
              <h1 class="text-2xl font-bold text-slate-800">Student Directory</h1>
              <button onclick="openStudentModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium shadow flex items-center gap-2">
                <i class="fa-solid fa-plus"></i> Register Student
              </button>
            </div>

            <div class="bg-white p-4 rounded-xl shadow-sm border flex flex-wrap gap-4">
              <input type="text" id="stu-search" placeholder="Search ID or Name..." onkeyup="loadStudents()" class="border px-3 py-2 rounded text-sm w-64">
              <select id="stu-filter-grade" onchange="loadStudents()" class="border px-3 py-2 rounded text-sm">
                <option value="">All Grades</option>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="Grade 9">Grade 9</option>
                <option value="Grade 10">Grade 10</option>
                <option value="Grade 11">Grade 11</option>
                <option value="Grade 12">Grade 12</option>
              </select>
            </div>

            <div class="bg-white rounded-xl shadow-sm border overflow-x-auto">
              <table class="w-full text-left border-collapse text-sm">
                <thead>
                  <tr class="border-b bg-slate-50 text-slate-600">
                    <th class="p-3">Student ID</th>
                    <th class="p-3">Name</th>
                    <th class="p-3">Grade & Section</th>
                    <th class="p-3">Status</th>
                    <th class="p-3 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody id="students-table-body"></tbody>
              </table>
            </div>
          </div>

          <!-- TAB 3: EVENTS -->
          <div id="tab-events" class="tab-content hidden space-y-6">
            <div class="flex justify-between items-center">
              <h1 class="text-2xl font-bold text-slate-800">Event Management</h1>
              <button onclick="openEventModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium shadow">
                <i class="fa-solid fa-plus"></i> Create Event
              </button>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" id="events-grid"></div>
          </div>

          <!-- TAB 4: ATTENDANCE RECORDS -->
          <div id="tab-attendance" class="tab-content hidden space-y-6">
            <div class="flex justify-between items-center">
              <h1 class="text-2xl font-bold text-slate-800">Attendance Log</h1>
              <a href="/api/export/csv?type=attendance" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
                <i class="fa-solid fa-file-csv mr-1"></i> Export CSV
              </a>
            </div>

            <div class="bg-white rounded-xl shadow-sm border overflow-x-auto p-4">
              <table class="w-full text-left text-sm border-collapse">
                <thead>
                  <tr class="border-b bg-slate-50">
                    <th class="p-3">Date</th>
                    <th class="p-3">Student ID</th>
                    <th class="p-3">Name</th>
                    <th class="p-3">Event</th>
                    <th class="p-3">Time In</th>
                    <th class="p-3">Time Out</th>
                    <th class="p-3">Status</th>
                  </tr>
                </thead>
                <tbody id="attendance-log-tbody"></tbody>
              </table>
            </div>
          </div>

          <!-- TAB 5: REPORTS & ANALYTICS -->
          <div id="tab-reports" class="tab-content hidden space-y-6">
            <h1 class="text-2xl font-bold text-slate-800">Reports & Insights</h1>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div class="bg-white p-5 rounded-xl shadow-sm border">
                <h3 class="font-bold text-rose-600 mb-3"><i class="fa-solid fa-triangle-exclamation"></i> Low Attendance Alerts (&lt;75%)</h3>
                <ul id="low-att-list" class="divide-y text-sm"></ul>
              </div>
              <div class="bg-white p-5 rounded-xl shadow-sm border">
                <h3 class="font-bold text-amber-600 mb-3"><i class="fa-solid fa-user-clock"></i> Frequently Late Students</h3>
                <ul id="freq-late-list" class="divide-y text-sm"></ul>
              </div>
            </div>
          </div>

          <!-- TAB 6: ID CARDS PRINTING ENGINE -->
          <div id="tab-idcards" class="tab-content hidden space-y-6">
            <div class="flex justify-between items-center">
              <h1 class="text-2xl font-bold text-slate-800">A4 Student ID Printing (8/Page)</h1>
              <button onclick="window.print()" class="bg-indigo-600 text-white px-4 py-2 rounded-lg shadow">
                <i class="fa-solid fa-print"></i> Print ID Sheet
              </button>
            </div>

            <div class="bg-white p-4 rounded-xl shadow-sm border flex gap-4">
              <select id="id-print-grade" onchange="renderIDCardsForPrint()" class="border px-3 py-2 rounded text-sm">
                <option value="">All Grade Levels</option>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="Grade 9">Grade 9</option>
                <option value="Grade 10">Grade 10</option>
                <option value="Grade 11">Grade 11</option>
                <option value="Grade 12">Grade 12</option>
              </select>
            </div>

            <div id="id-cards-preview" class="space-y-8"></div>
          </div>

          <!-- TAB 7: SETTINGS -->
          <div id="tab-settings" class="tab-content hidden space-y-6">
            <h1 class="text-2xl font-bold text-slate-800">System Configuration</h1>
            <div class="bg-white p-6 rounded-xl shadow-sm border max-w-xl space-y-4">
              <div>
                <label class="block text-sm font-medium text-slate-700">School Name</label>
                <input type="text" id="set-school-name" class="w-full border px-3 py-2 rounded mt-1">
              </div>
              <div>
                <label class="block text-sm font-medium text-slate-700">Late Threshold (Minutes)</label>
                <input type="number" id="set-late-threshold" class="w-full border px-3 py-2 rounded mt-1">
              </div>
              <button onclick="saveSettings()" class="bg-indigo-600 text-white px-4 py-2 rounded shadow">Save Settings</button>
            </div>
          </div>

        </div>
      </section>

      <!-- DEDICATED MOBILE-FIRST SCANNER PORTAL VIEW -->
      <section id="view-scanner" class="hidden flex-grow flex flex-col bg-slate-900 text-white p-4">
        <div class="max-w-md mx-auto w-full flex-grow flex flex-col justify-between space-y-4">
          
          <!-- Scanner Header -->
          <div class="flex justify-between items-center bg-slate-800 p-4 rounded-xl border border-slate-700">
            <div>
              <h2 class="font-bold text-lg text-indigo-400">QR Scanner Portal</h2>
              <span id="scanner-status" class="text-xs text-emerald-400">● Scanner Ready</span>
            </div>
            <a href="/" class="text-xs bg-slate-700 px-3 py-1.5 rounded text-slate-300">Admin Portal</a>
          </div>

          <!-- Event & Mode Controls -->
          <div class="bg-slate-800 p-4 rounded-xl border border-slate-700 space-y-3">
            <div>
              <label class="block text-xs font-semibold text-slate-400 mb-1">Select Active Event</label>
              <select id="scanner-event-select" class="w-full bg-slate-900 border border-slate-700 text-white px-3 py-2 rounded-lg text-sm"></select>
            </div>
            <div class="flex gap-2">
              <button id="btn-mode-in" onclick="setScanMode('IN')" class="flex-1 py-2 bg-emerald-600 text-white font-bold rounded-lg shadow text-center">TIME IN</button>
              <button id="btn-mode-out" onclick="setScanMode('OUT')" class="flex-1 py-2 bg-slate-700 text-slate-300 font-bold rounded-lg text-center">TIME OUT</button>
            </div>
          </div>

          <!-- Live Camera Viewfinder -->
          <div class="relative bg-black rounded-xl overflow-hidden border-2 border-indigo-500 aspect-square flex items-center justify-center shadow-2xl">
            <div id="reader" class="w-full h-full"></div>
          </div>

          <!-- Real-Time Scan Result Popover Card -->
          <div id="scan-result-card" class="hidden bg-slate-800 border-2 p-4 rounded-xl text-center space-y-2">
            <div id="scan-result-icon" class="text-4xl"></div>
            <h3 id="scan-result-name" class="font-bold text-xl text-white"></h3>
            <p id="scan-result-details" class="text-xs text-slate-300"></p>
          </div>

          <!-- Audio Voice Announcement Toggle Controls -->
          <div class="flex items-center justify-between text-xs text-slate-400 px-2">
            <span>Voice Speech Announcement</span>
            <input type="checkbox" id="voice-toggle" checked class="w-4 h-4 accent-indigo-500">
          </div>

        </div>
      </section>

      <!-- STUDENT PORTAL VIEW -->
      <section id="view-student" class="hidden flex-grow p-6 bg-slate-50">
        <div class="max-w-4xl mx-auto space-y-6">
          <div class="bg-white p-6 rounded-xl shadow-sm border flex flex-col md:flex-row gap-6 items-center">
            <img id="stu-portal-img" class="w-32 h-32 rounded-xl object-cover bg-slate-100 border">
            <div class="space-y-1 text-center md:text-left">
              <h2 class="text-2xl font-bold text-slate-800" id="stu-portal-name"></h2>
              <p class="text-sm text-slate-500" id="stu-portal-id"></p>
              <p class="text-sm text-indigo-600 font-medium" id="stu-portal-class"></p>
            </div>
            <div class="ml-auto text-center p-4 bg-indigo-50 rounded-xl">
              <div class="text-3xl font-extrabold text-indigo-600" id="stu-portal-pct">0%</div>
              <div class="text-xs text-indigo-800 font-semibold">Attendance Rate</div>
            </div>
          </div>

          <!-- Digital ID & QR Display -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="bg-white p-6 rounded-xl shadow-sm border text-center space-y-4">
              <h3 class="font-bold text-slate-800">Your Digital Student QR</h3>
              <img id="stu-portal-qr" class="w-48 h-48 mx-auto border p-2 rounded-lg">
            </div>
            <div class="bg-white p-6 rounded-xl shadow-sm border space-y-3">
              <h3 class="font-bold text-slate-800 mb-2">Attendance Summary</h3>
              <div class="flex justify-between text-sm py-2 border-b"><span>Events Attended</span><span id="stu-stat-attended" class="font-bold">0</span></div>
              <div class="flex justify-between text-sm py-2 border-b"><span>Present</span><span id="stu-stat-present" class="font-bold text-emerald-600">0</span></div>
              <div class="flex justify-between text-sm py-2 border-b"><span>Late Arrived</span><span id="stu-stat-late" class="font-bold text-amber-600">0</span></div>
            </div>
          </div>
        </div>
      </section>

    </main>
  </div>

  <!-- PRINT CONTAINER FOR EXACT A4 PAGE LAYOUT -->
  <div id="print-section"></div>

  <!-- CLIENT APPLICATION ENGINE SCRIPT -->
  <script>
    let currentUser = null;
    let currentScanMode = 'IN';
    let html5QrCode = null;

    // Page Load Router
    window.addEventListener('DOMContentLoaded', async () => {
      const path = window.location.pathname;
      const res = await fetch('/api/auth/me');
      const auth = await res.json();

      if (path === '/scanner') {
        showView('view-scanner');
        initScannerPortal();
        return;
      }

      if (auth.authenticated) {
        currentUser = auth.user;
        setupUserSessionView();
      } else {
        showView('view-login');
      }
    });

    function showView(viewId) {
      ['view-login', 'view-admin', 'view-scanner', 'view-student'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
      });
      document.getElementById(viewId).classList.remove('hidden');
      document.getElementById('navbar').classList.toggle('hidden', viewId === 'view-login' || viewId === 'view-scanner');
    }

    function setupUserSessionView() {
      document.getElementById('user-badge').innerText = currentUser.username + ' (' + currentUser.role + ')';
      if (currentUser.role === 'admin') {
        showView('view-admin');
        switchTab('dash');
      } else if (currentUser.role === 'student') {
        showView('view-student');
        loadStudentPortalData();
      } else if (currentUser.role === 'scanner') {
        window.location.href = '/scanner';
      }
    }

    async function handleLogin(e) {
      e.preventDefault();
      const u = document.getElementById('login-username').value;
      const p = document.getElementById('login-password').value;

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();

      if (res.ok) {
        currentUser = data;
        setupUserSessionView();
      } else {
        const err = document.getElementById('login-error');
        err.innerText = data.error;
        err.classList.remove('hidden');
      }
    }

    async function logout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    }

    // TAB SWITCHING
    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
      document.getElementById('tab-' + tabId).classList.remove('hidden');

      if (tabId === 'dash') loadDashboardStats();
      if (tabId === 'students') loadStudents();
      if (tabId === 'events') loadEvents();
      if (tabId === 'attendance') loadAttendanceLog();
      if (tabId === 'reports') loadReports();
      if (tabId === 'idcards') renderIDCardsForPrint();
    }

    // DASHBOARD DATA FETCH
    async function loadDashboardStats() {
      const grade = document.getElementById('dash-filter-grade').value;
      const date = document.getElementById('dash-filter-date').value;
      const res = await fetch(\`/api/dashboard/stats?grade=\${grade}&date=\${date}\`);
      const data = await res.json();

      document.getElementById('kpi-total-students').innerText = data.totalStudents;
      document.getElementById('kpi-present').innerText = data.presentToday;
      document.getElementById('kpi-late').innerText = data.lateToday;
      document.getElementById('kpi-absent').innerText = data.absentToday;
      document.getElementById('kpi-att-rate').innerText = data.attendancePercentage + '%';

      if (data.activeEvent) {
        document.getElementById('active-evt-title').innerText = data.activeEvent.name;
        document.getElementById('active-evt-time').innerText = data.activeEvent.start_time + ' - ' + data.activeEvent.end_time;
      }

      const tbody = document.getElementById('recent-scans-tbody');
      tbody.innerHTML = data.recentScans.map(s => \`
        <tr class="border-b">
          <td class="p-3 font-semibold">\${s.full_name}</td>
          <td class="p-3 text-slate-500">\${s.grade_level} - \${s.section}</td>
          <td class="p-3">\${s.time_in || '-'}</td>
          <td class="p-3"><span class="px-2 py-1 rounded text-xs font-bold \${s.status==='Present'?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}">\${s.status}</span></td>
        </tr>
      \`).join('');
    }

    // STUDENTS MANAGEMENT ENGINE
    async function loadStudents() {
      const search = document.getElementById('stu-search').value;
      const grade = document.getElementById('stu-filter-grade').value;
      const res = await fetch(\`/api/students?search=\${search}&grade=\${grade}\`);
      const students = await res.json();

      const tbody = document.getElementById('students-table-body');
      tbody.innerHTML = students.map(s => \`
        <tr class="border-b">
          <td class="p-3 font-mono font-bold text-indigo-600">\${s.student_id}</td>
          <td class="p-3 font-medium">\${s.full_name}</td>
          <td class="p-3 text-slate-500">\${s.grade_level} - \${s.section}</td>
          <td class="p-3"><span class="px-2 py-0.5 text-xs rounded bg-slate-100">\${s.status}</span></td>
          <td class="p-3 text-center space-x-2">
            <button onclick="regenerateQR(\${s.id})" class="text-xs bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-semibold">Reset QR</button>
            <button onclick="deleteStudent(\${s.id})" class="text-xs bg-rose-50 text-rose-600 px-2 py-1 rounded font-semibold">Delete</button>
          </td>
        </tr>
      \`).join('');
    }

    async function regenerateQR(id) {
      if (confirm('Regenerate QR Code? The old QR code will immediately stop working.')) {
        await fetch(\`/api/students/\${id}/regenerate-qr\`, { method: 'POST' });
        alert('QR Code updated successfully.');
        loadStudents();
      }
    }

    async function deleteStudent(id) {
      if (confirm('Are you sure you want to delete this student?')) {
        await fetch(\`/api/students/\${id}\`, { method: 'DELETE' });
        loadStudents();
      }
    }

    // EVENT MANAGEMENT
    async function loadEvents() {
      const res = await fetch('/api/events');
      const events = await res.json();
      const grid = document.getElementById('events-grid');
      grid.innerHTML = events.map(e => \`
        <div class="bg-white p-5 rounded-xl shadow-sm border space-y-2">
          <div class="flex justify-between items-start">
            <h3 class="font-bold text-lg text-slate-800">\${e.name}</h3>
            <span class="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs font-bold rounded">\${e.status}</span>
          </div>
          <p class="text-xs text-slate-500">\${e.description || 'No description'}</p>
          <div class="text-xs text-slate-600 pt-2"><i class="fa-regular fa-calendar"></i> \${e.event_date} (\${e.start_time} - \${e.end_time})</div>
        </div>
      \`).join('');
    }

    // ATTENDANCE LOG
    async function loadAttendanceLog() {
      const res = await fetch('/api/attendance/records');
      const logs = await res.json();
      const tbody = document.getElementById('attendance-log-tbody');
      tbody.innerHTML = logs.map(l => \`
        <tr class="border-b">
          <td class="p-3">\${l.scan_date}</td>
          <td class="p-3 font-mono font-bold">\${l.student_id}</td>
          <td class="p-3">\${l.full_name}</td>
          <td class="p-3">\${l.event_name}</td>
          <td class="p-3 text-emerald-600 font-medium">\${l.time_in || '-'}</td>
          <td class="p-3 text-slate-500">\${l.time_out || '-'}</td>
          <td class="p-3"><span class="px-2 py-1 text-xs rounded font-bold bg-slate-100">\${l.status}</span></td>
        </tr>
      \`).join('');
    }

    // REPORTS & INSIGHTS
    async function loadReports() {
      const res = await fetch('/api/reports/insights');
      const data = await res.json();

      document.getElementById('low-att-list').innerHTML = data.lowAttendance.map(s => \`
        <li class="py-2 flex justify-between">
          <span>\${s.full_name} (\${s.grade_level})</span>
          <span class="font-bold text-rose-600">\${s.percentage}%</span>
        </li>
      \`).join('') || '<li class="py-2 text-slate-400">No low attendance alerts</li>';

      document.getElementById('freq-late-list').innerHTML = data.frequentLate.map(s => \`
        <li class="py-2 flex justify-between">
          <span>\${s.full_name} (\${s.section})</span>
          <span class="font-bold text-amber-600">\${s.late_count} Times Late</span>
        </li>
      \`).join('') || '<li class="py-2 text-slate-400">No late warnings</li>';
    }

    // PRINTING SYSTEM: Render Exactly 8 ID Cards Per A4 Page Sheet
    async function renderIDCardsForPrint() {
      const grade = document.getElementById('id-print-grade').value;
      const res = await fetch(\`/api/students?grade=\${grade}\`);
      const students = await res.json();

      const previewContainer = document.getElementById('id-cards-preview');
      const printSection = document.getElementById('print-section');
      
      previewContainer.innerHTML = '';
      printSection.innerHTML = '';

      // Chunk array into groups of 8
      for (let i = 0; i < students.length; i += 8) {
        const chunk = students.slice(i, i + 8);
        const pageElem = document.createElement('div');
        pageElem.className = 'a4-page bg-white shadow-lg border my-4';

        chunk.forEach(s => {
          pageElem.innerHTML += \`
            <div class="id-card-border p-3 flex flex-col justify-between bg-white relative overflow-hidden">
              <div class="text-center border-b pb-1">
                <div class="font-bold text-xs uppercase text-indigo-900 tracking-wider">Global Academy</div>
                <div class="text-[9px] text-slate-500">Official Student Identification</div>
              </div>
              <div class="flex gap-2 items-center my-2">
                <img src="\${s.profile_picture || 'https://via.placeholder.com/80'}" class="w-16 h-16 rounded object-cover border">
                <div class="text-left space-y-0.5">
                  <div class="font-bold text-xs text-slate-800 leading-tight">\${s.full_name}</div>
                  <div class="text-[10px] text-indigo-600 font-mono font-bold">\${s.student_id}</div>
                  <div class="text-[9px] text-slate-500">\${s.grade_level} - \${s.section}</div>
                </div>
              </div>
              <div class="flex justify-between items-end border-t pt-1">
                <img src="/api/qr/render/\${s.qr_token}" class="w-12 h-12">
                <span class="text-[8px] text-slate-400">SY 2026-2027</span>
              </div>
            </div>
          \`;
        });

        previewContainer.appendChild(pageElem.cloneNode(true));
        printSection.appendChild(pageElem);
      }
    }

    // SCANNER PORTAL CORE LOGIC
    async function initScannerPortal() {
      // Load Active Events into dropdown
      const res = await fetch('/api/events');
      const events = await res.json();
      const select = document.getElementById('scanner-event-select');
      select.innerHTML = events.map(e => \`<option value="\${e.id}">\${e.name} (\${e.event_date})</option>\`).join('');

      // Start HTML5 QR Reader
      html5QrCode = new Html5Qrcode("reader");
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        onScanSuccess
      ).catch(err => {
        document.getElementById('scanner-status').innerText = '● Camera Error / Denied';
      });
    }

    function setScanMode(mode) {
      currentScanMode = mode;
      document.getElementById('btn-mode-in').className = mode === 'IN' ? 'flex-1 py-2 bg-emerald-600 text-white font-bold rounded-lg shadow text-center' : 'flex-1 py-2 bg-slate-700 text-slate-300 font-bold rounded-lg text-center';
      document.getElementById('btn-mode-out').className = mode === 'OUT' ? 'flex-1 py-2 bg-emerald-600 text-white font-bold rounded-lg shadow text-center' : 'flex-1 py-2 bg-slate-700 text-slate-300 font-bold rounded-lg text-center';
    }

    let isProcessing = false;
    async function onScanSuccess(decodedText) {
      if (isProcessing) return;
      isProcessing = true;

      const eventId = document.getElementById('scanner-event-select').value;
      const res = await fetch('/api/attendance/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: currentScanMode })
      });
      const data = await res.json();

      const card = document.getElementById('scan-result-card');
      const icon = document.getElementById('scan-result-icon');
      const name = document.getElementById('scan-result-name');
      const details = document.getElementById('scan-result-details');

      card.classList.remove('hidden');

      if (res.ok && (data.status === 'SUCCESS_IN' || data.status === 'SUCCESS_OUT')) {
        card.className = "bg-emerald-900/80 border-2 border-emerald-500 p-4 rounded-xl text-center space-y-1";
        icon.innerHTML = '✓';
        name.innerText = data.student.full_name;
        details.innerText = \`\${data.student.student_id} | \${data.message}\`;
        speakName(\`\${data.student.first_name} \${data.student.last_name}, \${currentScanMode === 'IN' ? 'Attendance recorded' : 'Time out recorded'}\`);
      } else if (data.status === 'DUPLICATE') {
        card.className = "bg-amber-900/80 border-2 border-amber-500 p-4 rounded-xl text-center space-y-1";
        icon.innerHTML = '⚠️';
        name.innerText = data.student ? data.student.full_name : 'Already Recorded';
        details.innerText = data.message;
        speakName(\`\${data.student ? data.student.first_name : 'Student'}, you are already recorded.\`);
      } else {
        card.className = "bg-rose-900/80 border-2 border-rose-500 p-4 rounded-xl text-center space-y-1";
        icon.innerHTML = '✕';
        name.innerText = 'Invalid Scan';
        details.innerText = data.message;
        speakName('Invalid QR Code');
      }

      // Auto Reset Scanner View after 3.5 seconds
      setTimeout(() => {
        card.classList.add('hidden');
        isProcessing = false;
      }, 3500);
    }

    // Voice Announcement Engine
    function speakName(text) {
      if (!document.getElementById('voice-toggle').checked) return;
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        window.speechSynthesis.speak(utterance);
      }
    }

    // STUDENT PORTAL LOADER
    async function loadStudentPortalData() {
      const res = await fetch('/api/student/profile');
      const data = await res.json();

      document.getElementById('stu-portal-name').innerText = data.student.full_name;
      document.getElementById('stu-portal-id').innerText = 'ID: ' + data.student.student_id;
      document.getElementById('stu-portal-class').innerText = data.student.grade_level + ' - ' + data.student.section;
      document.getElementById('stu-portal-pct').innerText = data.stats.percentage + '%';
      document.getElementById('stu-portal-qr').src = '/api/qr/render/' + data.student.qr_token;
      document.getElementById('stu-portal-img').src = data.student.profile_picture || 'https://via.placeholder.com/150';

      document.getElementById('stu-stat-attended').innerText = data.stats.totalEvents;
      document.getElementById('stu-stat-present').innerText = data.stats.presentCount;
      document.getElementById('stu-stat-late').innerText = data.stats.lateCount;
    }
  </script>
</body>
</html>`;

// Serve Frontend SPA Application
app.get('*', (req, res) => {
  res.send(CLIENT_HTML);
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` QR Code School Attendance System Server Running`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(` Admin Portal: http://localhost:${PORT}`);
  console.log(` Scanner Portal: http://localhost:${PORT}/scanner`);
  console.log(` Default Admin User: admin | Pass: admin123`);
  console.log(`===================================================`);
});
