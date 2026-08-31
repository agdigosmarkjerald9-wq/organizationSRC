/**
 * QR Code School Attendance Management System
 * Complete Single-File Solution (Node.js + Express + SQLite + Web API)
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'attendance.db');

// --- MIDDLEWARE CONFIGURATION ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'qr_school_attendance_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// --- DATABASE INITIALIZATION ---
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite Database at:', DB_PATH);
});

db.serialize(() => {
  // Users Table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'scanner', 'student')),
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
    dob DATE,
    contact TEXT,
    email TEXT,
    address TEXT,
    guardian_name TEXT,
    guardian_contact TEXT,
    profile_pic TEXT,
    school_year TEXT NOT NULL,
    status TEXT DEFAULT 'Active',
    qr_token TEXT UNIQUE NOT NULL,
    qr_status TEXT DEFAULT 'Active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Events Table
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    event_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    location TEXT,
    organizer TEXT,
    attendance_type TEXT DEFAULT 'General',
    status TEXT DEFAULT 'Active',
    allowed_grades TEXT DEFAULT 'All',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Attendance Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    scan_date DATE NOT NULL,
    time_in TIME,
    time_out TIME,
    status TEXT NOT NULL,
    scanned_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(event_id) REFERENCES events(id)
  )`);

  // Excuses Table
  db.run(`CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT NOT NULL,
    date_excused DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // System Settings Table
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Audit Logs Table
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed Default System Settings
  const defaultSettings = [
    ['school_name', 'Global Academy High School'],
    ['school_address', '123 Education Blvd, Metro Campus'],
    ['school_year', '2025-2026'],
    ['late_threshold_mins', '15'],
    ['min_attendance_pct', '75'],
    ['voice_enabled', 'true'],
    ['voice_volume', '1.0']
  ];
  defaultSettings.forEach(([k, v]) => {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  });

  // Seed Default Admin Account
  db.get("SELECT * FROM users WHERE username = 'admin'", [], async (err, row) => {
    if (!row) {
      const hash = await bcrypt.hash('admin123', 10);
      db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['admin', hash, 'admin']);
      console.log('Seeded Default Admin: username=admin, password=admin123');
    }
  });

  // Seed Default General Attendance Event for Today
  const todayStr = new Date().toISOString().split('T')[0];
  db.get("SELECT * FROM events WHERE name = 'Daily General Attendance' AND event_date = ?", [todayStr], (err, row) => {
    if (!row) {
      db.run("INSERT INTO events (name, description, event_date, start_time, end_time, location, organizer, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ['Daily General Attendance', 'Standard Daily School Attendance', todayStr, '07:30', '17:00', 'Main Gate', 'Administration', 'Active']);
    }
  });
});

// --- HELPER FUNCTIONS & AUTH MIDDLEWARE ---
function logAudit(user, action, details) {
  db.run("INSERT INTO audit_logs (user, action, details) VALUES (?, ?, ?)", [user || 'System', action, details]);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.session && req.session.user && roles.includes(req.session.user.role)) {
      return next();
    }
    res.status(403).json({ error: 'Forbidden. Access restricted.' });
  };
}

// --- API ENDPOINTS ---

// Auth Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });

    req.session.user = { id: user.id, username: user.username, role: user.role, student_id: user.student_id };
    logAudit(user.username, 'User Login', `Role: ${user.role}`);
    res.json({ success: true, user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) logAudit(req.session.user.username, 'User Logout', '');
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) res.json({ loggedIn: true, user: req.session.user });
  else res.json({ loggedIn: false });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const username = req.session.user.username;
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (!await bcrypt.compare(oldPassword, user.password)) {
      return res.status(400).json({ error: 'Incorrect old password.' });
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    db.run("UPDATE users SET password = ? WHERE username = ?", [newHash, username], (err) => {
      logAudit(username, 'Password Change', 'Password updated successfully');
      res.json({ success: true, message: 'Password updated successfully.' });
    });
  });
});

// Student Management Routes
app.get('/api/students', requireAuth, (req, res) => {
  db.all("SELECT * FROM students ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/students', requireAuth, requireRole('admin'), async (req, res) => {
  const { student_id, first_name, middle_name, last_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, school_year, profile_pic } = req.body;
  if (!student_id || !first_name || !last_name || !grade_level || !section) {
    return res.status(400).json({ error: 'Missing required student fields.' });
  }

  const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;
  const qr_token = crypto.randomBytes(16).toString('hex');

  const query = `INSERT INTO students 
    (student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, profile_pic, school_year, qr_token) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(query, [student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, profile_pic || '', school_year || '2025-2026', qr_token], function(err) {
    if (err) return res.status(400).json({ error: 'Student ID already exists or DB error.' });

    // Auto-create Student portal user account
    bcrypt.hash(student_id, 10).then(hash => {
      db.run("INSERT OR IGNORE INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)", [student_id, hash, student_id]);
    });

    logAudit(req.session.user.username, 'Student Registered', `Student: ${full_name} (${student_id})`);
    res.json({ success: true, id: this.lastID, qr_token });
  });
});

app.put('/api/students/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { first_name, middle_name, last_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, school_year, status, profile_pic } = req.body;
  const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;

  const query = `UPDATE students SET 
    first_name=?, middle_name=?, last_name=?, full_name=?, grade_level=?, section=?, gender=?, dob=?, contact=?, email=?, address=?, guardian_name=?, guardian_contact=?, school_year=?, status=?, profile_pic=?
    WHERE id=?`;

  db.run(query, [first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, school_year, status, profile_pic, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'Student Updated', `Student ID database ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

app.post('/api/students/:id/regenerate-qr', requireAuth, requireRole('admin'), (req, res) => {
  const newToken = crypto.randomBytes(16).toString('hex');
  db.run("UPDATE students SET qr_token = ?, qr_status = 'Active' WHERE id = ?", [newToken, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'QR Regenerated', `Student DB ID: ${req.params.id}`);
    res.json({ success: true, qr_token: newToken });
  });
});

app.post('/api/students/:id/toggle-qr', requireAuth, requireRole('admin'), (req, res) => {
  const { status } = req.body; // 'Active' or 'Disabled'
  db.run("UPDATE students SET qr_status = ? WHERE id = ?", [status, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'QR Status Toggled', `Status: ${status} for Student DB ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

// Event Management
app.get('/api/events', requireAuth, (req, res) => {
  db.all("SELECT * FROM events ORDER BY event_date DESC, start_time ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/events', requireAuth, requireRole('admin'), (req, res) => {
  const { name, description, event_date, start_time, end_time, location, organizer, attendance_type, allowed_grades } = req.body;
  db.run(`INSERT INTO events (name, description, event_date, start_time, end_time, location, organizer, attendance_type, allowed_grades) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, description, event_date, start_time, end_time, location, organizer, attendance_type || 'General', allowed_grades || 'All'], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      logAudit(req.session.user.username, 'Event Created', `Event: ${name} on ${event_date}`);
      res.json({ success: true, id: this.lastID });
    });
});

// --- QR SCANNER CORE PROCESSOR ---
app.post('/api/scan', (req, res) => {
  const { qr_token, event_id, scan_type } = req.body; // scan_type = 'IN' or 'OUT'
  if (!qr_token || !event_id) return res.status(400).json({ success: false, code: 'INVALID', message: 'Missing token or event.' });

  // 1. Verify Student
  db.get("SELECT * FROM students WHERE qr_token = ?", [qr_token], (err, student) => {
    if (err || !student) {
      return res.json({ success: false, code: 'INVALID', message: 'Invalid QR Code. Student not found.' });
    }
    if (student.qr_status !== 'Active') {
      return res.json({ success: false, code: 'DISABLED', message: 'QR Code is disabled by Administrator.' });
    }
    if (student.status !== 'Active') {
      return res.json({ success: false, code: 'INACTIVE', message: 'Student status is inactive.' });
    }

    // 2. Verify Event
    db.get("SELECT * FROM events WHERE id = ?", [event_id], (err, event) => {
      if (err || !event) return res.json({ success: false, code: 'EVENT_ERROR', message: 'Active event not found.' });

      // Check Grade restriction
      if (event.allowed_grades !== 'All' && !event.allowed_grades.split(',').includes(student.grade_level)) {
        return res.json({ success: false, code: 'RESTRICTED', message: `Event restricted. ${student.grade_level} not allowed.` });
      }

      const todayStr = new Date().toISOString().split('T')[0];
      const nowTimeStr = new Date().toTimeString().split(' ')[0].substring(0, 5);

      // Check existing scan today for event
      db.get("SELECT * FROM attendance WHERE student_id = ? AND event_id = ? AND scan_date = ?", [student.student_id, event_id, todayStr], (err, record) => {
        if (scan_type === 'IN') {
          if (record && record.time_in) {
            return res.json({ success: false, code: 'ALREADY_RECORDED', message: `${student.full_name}, Time In already recorded.`, student });
          }

          // Compute Present vs Late
          let status = 'Present';
          db.get("SELECT value FROM settings WHERE key = 'late_threshold_mins'", [], (err, row) => {
            const graceMins = parseInt(row ? row.value : '15');
            const [evHours, evMins] = event.start_time.split(':').map(Number);
            const eventStartMins = evHours * 60 + evMins;
            const [nowHours, nowMins] = nowTimeStr.split(':').map(Number);
            const nowTotalMins = nowHours * 60 + nowMins;

            if (nowTotalMins > eventStartMins + graceMins) {
              status = 'Late';
            }

            if (record) {
              db.run("UPDATE attendance SET time_in = ?, status = ? WHERE id = ?", [nowTimeStr, status, record.id]);
            } else {
              db.run("INSERT INTO attendance (student_id, event_id, scan_date, time_in, status, scanned_by) VALUES (?, ?, ?, ?, ?, ?)",
                [student.student_id, event_id, todayStr, nowTimeStr, status, req.session.user ? req.session.user.username : 'Scanner']);
            }
            return res.json({ success: true, code: 'SUCCESS_IN', message: `${student.full_name}, Time In recorded as ${status}.`, student, time: nowTimeStr, status });
          });
        } else {
          // Time OUT logic
          if (!record) {
            return res.json({ success: false, code: 'NO_TIME_IN', message: `${student.full_name} has no Time In record today.`, student });
          }
          if (record.time_out) {
            return res.json({ success: false, code: 'ALREADY_RECORDED', message: `${student.full_name}, Time Out already recorded.`, student });
          }

          db.run("UPDATE attendance SET time_out = ? WHERE id = ?", [nowTimeStr, record.id], (err) => {
            return res.json({ success: true, code: 'SUCCESS_OUT', message: `${student.full_name}, Time Out recorded.`, student, time: nowTimeStr, status: record.status });
          });
        }
      });
    });
  });
});

// Attendance & Reports API
app.get('/api/attendance', requireAuth, (req, res) => {
  const { date, event_id, grade_level, section } = req.query;
  let sql = `SELECT a.*, s.full_name, s.grade_level, s.section, e.name as event_name 
             FROM attendance a 
             JOIN students s ON a.student_id = s.student_id 
             JOIN events e ON a.event_id = e.id WHERE 1=1`;
  const params = [];

  if (date) { sql += " AND a.scan_date = ?"; params.push(date); }
  if (event_id) { sql += " AND a.event_id = ?"; params.push(event_id); }
  if (grade_level) { sql += " AND s.grade_level = ?"; params.push(grade_level); }
  if (section) { sql += " AND s.section = ?"; params.push(section); }

  sql += " ORDER BY a.id DESC";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/excuses', requireAuth, requireRole('admin'), (req, res) => {
  const { student_id, event_id, reason, notes, date_excused } = req.body;
  db.run("INSERT INTO excuses (student_id, event_id, reason, notes, approved_by, date_excused) VALUES (?, ?, ?, ?, ?, ?)",
    [student_id, event_id, reason, notes, req.session.user.username, date_excused], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      // Update attendance status if present
      db.run("UPDATE attendance SET status = 'Excused' WHERE student_id = ? AND event_id = ? AND scan_date = ?", [student_id, event_id, date_excused]);
      logAudit(req.session.user.username, 'Excuse Added', `Student: ${student_id}, Reason: ${reason}`);
      res.json({ success: true });
    });
});

// Analytics & Dashboard Summary
app.get('/api/analytics/dashboard', requireAuth, (req, res) => {
  const todayStr = new Date().toISOString().split('T')[0];
  const summary = { totalStudents: 0, presentToday: 0, lateToday: 0, absentToday: 0, excusedToday: 0, attendancePct: 0 };

  db.get("SELECT COUNT(*) as count FROM students WHERE status = 'Active'", [], (err, row) => {
    summary.totalStudents = row.count || 0;

    db.all("SELECT status, COUNT(*) as count FROM attendance WHERE scan_date = ? GROUP BY status", [todayStr], (err, rows) => {
      rows.forEach(r => {
        if (r.status === 'Present') summary.presentToday = r.count;
        if (r.status === 'Late') summary.lateToday = r.count;
        if (r.status === 'Excused') summary.excusedToday = r.count;
      });

      const accounted = summary.presentToday + summary.lateToday + summary.excusedToday;
      summary.absentToday = Math.max(0, summary.totalStudents - accounted);
      summary.attendancePct = summary.totalStudents > 0 ? ((accounted / summary.totalStudents) * 100).toFixed(1) : 0;

      res.json(summary);
    });
  });
});

app.get('/api/analytics/frequent-lates', requireAuth, (req, res) => {
  const sql = `SELECT s.student_id, s.full_name, s.grade_level, s.section, COUNT(a.id) as late_count 
               FROM attendance a JOIN students s ON a.student_id = s.student_id 
               WHERE a.status = 'Late' GROUP BY s.student_id HAVING late_count >= 2 ORDER BY late_count DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/settings', requireAuth, (req, res) => {
  db.all("SELECT * FROM settings", [], (err, rows) => {
    const config = {};
    rows.forEach(r => config[r.key] = r.value);
    res.json(config);
  });
});

app.post('/api/settings', requireAuth, requireRole('admin'), (req, res) => {
  const settings = req.body;
  Object.keys(settings).forEach(key => {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, String(settings[key])]);
  });
  logAudit(req.session.user.username, 'System Settings Updated', '');
  res.json({ success: true });
});

app.get('/api/audit-logs', requireAuth, requireRole('admin'), (req, res) => {
  db.all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100", [], (err, rows) => {
    res.json(rows);
  });
});

// Database Backup / Restore API
app.get('/api/backup', requireAuth, requireRole('admin'), (req, res) => {
  res.download(DB_PATH, `backup-attendance-${new Date().toISOString().split('T')[0]}.db`);
});

// --- SINGLE-PAGE WEB INTERFACE GENERATOR ---
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Code School Attendance System</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
  <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

  <style>
    :root { --primary-color: #1e3a8a; --secondary-color: #0d9488; --dark-bg: #0f172a; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; color: #334155; }
    .sidebar { min-height: 100vh; background-color: var(--primary-color); color: white; }
    .sidebar .nav-link { color: #93c5fd; font-weight: 500; margin-bottom: 0.2rem; border-radius: 0.375rem; }
    .sidebar .nav-link:hover, .sidebar .nav-link.active { background-color: rgba(255,255,255,0.15); color: #ffffff; }
    .card-stat { border: none; border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); transition: transform 0.2s; }
    .card-stat:hover { transform: translateY(-3px); }
    
    /* ID Card Standard CSS Layout for Screen & Printing */
    .id-card {
      width: 3.375in; height: 2.125in; border: 1.5px solid #cbd5e1; border-radius: 8px;
      padding: 8px; background: white; box-sizing: border-box; display: flex; flex-direction: column;
      justify-content: space-between; position: relative; font-size: 10px; overflow: hidden; page-break-inside: avoid;
    }
    .id-card-header { background: var(--primary-color); color: white; padding: 4px; margin: -8px -8px 6px -8px; text-align: center; }
    .id-card-body { display: flex; gap: 8px; align-items: center; }
    .id-photo { width: 65px; height: 65px; object-fit: cover; border-radius: 4px; border: 1px solid #94a3b8; }
    .id-details { flex-grow: 1; line-height: 1.2; }
    .id-qr { width: 55px; height: 55px; }

    /* A4 Grid Layout: 8 IDs per A4 Page */
    @media print {
      body * { visibility: hidden; }
      #print-section, #print-section * { visibility: visible; }
      #print-section { position: absolute; left: 0; top: 0; width: 100%; }
      .a4-page {
        width: 210mm; height: 297mm; padding: 10mm; margin: 0 auto;
        display: grid; grid-template-columns: repeat(2, 3.375in); grid-template-rows: repeat(4, 2.125in);
        gap: 8mm 12mm; page-break-after: always; box-sizing: border-box;
      }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>

  <div id="app">
    <!-- Dynamic Single Page Application Container -->
  </div>

  <div id="print-section" class="d-none"></div>

  <script>
    // State Store
    const state = {
      user: null,
      currentView: 'dashboard',
      students: [],
      events: [],
      attendance: [],
      settings: {},
      scanner: null
    };

    // --- MAIN INITIALIZER ---
    async function initApp() {
      const res = await fetch('/api/me');
      const data = await res.json();
      if (data.loggedIn) {
        state.user = data.user;
        if (window.location.pathname === '/scanner') {
          renderScannerPortal();
        } else if (state.user.role === 'student') {
          renderStudentPortal();
        } else {
          renderAdminDashboard();
        }
      } else {
        if (window.location.pathname === '/scanner') {
          renderScannerPortal();
        } else {
          renderLoginForm();
        }
      }
    }

    // --- VOICE SYNTHESIS ENGINE (Web Speech API) ---
    function speakText(text) {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel(); // Reset queue
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.volume = parseFloat(state.settings.voice_volume || 1.0);
      window.speechSynthesis.speak(utterance);
    }

    // --- VIEWS & RENDERERS ---

    function renderLoginForm() {
      document.getElementById('app').innerHTML = \`
        <div class="container d-flex justify-content-center align-items-center vh-100">
          <div class="card shadow-lg p-4" style="max-width: 400px; width: 100%; border-radius: 1rem;">
            <div class="text-center mb-4">
              <i class="fa-solid fa-qrcode fa-3x text-primary mb-2"></i>
              <h4 class="fw-bold">School Attendance System</h4>
              <p class="text-muted small">Please sign in to access portal</p>
            </div>
            <form onsubmit="handleLogin(event)">
              <div class="mb-3">
                <label class="form-label font-weight-bold">Username</label>
                <input type="text" id="login-username" class="form-control" required placeholder="Enter username">
              </div>
              <div class="mb-3">
                <label class="form-label">Password</label>
                <input type="password" id="login-password" class="form-control" required placeholder="Enter password">
              </div>
              <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Sign In</button>
            </form>
            <div class="text-center mt-3">
              <a href="/scanner" class="text-decoration-none small text-secondary"><i class="fa-solid fa-camera me-1"></i> Open Scanner Portal</a>
            </div>
          </div>
        </div>
      \`;
    }

    async function handleLogin(e) {
      e.preventDefault();
      const u = document.getElementById('login-username').value;
      const p = document.getElementById('login-password').value;

      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();
      if (data.success) {
        state.user = data.user;
        if (state.user.role === 'student') renderStudentPortal();
        else renderAdminDashboard();
      } else {
        alert(data.error || 'Login failed');
      }
    }

    async function renderAdminDashboard() {
      // Load Settings & Summary Data
      const [sRes, aRes, eRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/analytics/dashboard'),
        fetch('/api/events')
      ]);
      state.settings = await sRes.json();
      const analytics = await aRes.json();
      state.events = await eRes.json();

      document.getElementById('app').innerHTML = \`
        <div class="d-flex">
          <!-- Sidebar -->
          <div class="sidebar p-3 d-flex flex-column" style="width: 260px;">
            <div class="d-flex align-items-center mb-4 px-2">
              <i class="fa-solid fa-school fa-2x me-2"></i>
              <span class="fs-5 fw-bold text-white">\${state.settings.school_name || 'Admin Portal'}</span>
            </div>
            <ul class="nav nav-pills flex-column mb-auto">
              <li class="nav-item"><a href="#" class="nav-link active" onclick="switchTab('dashboard')"><i class="fa-solid fa-chart-line me-2"></i>Dashboard</a></li>
              <li><a href="#" class="nav-link" onclick="switchTab('students')"><i class="fa-solid fa-user-graduate me-2"></i>Students</a></li>
              <li><a href="#" class="nav-link" onclick="switchTab('events')"><i class="fa-solid fa-calendar-days me-2"></i>Events</a></li>
              <li><a href="#" class="nav-link" onclick="switchTab('attendance')"><i class="fa-solid fa-clipboard-user me-2"></i>Attendance Logs</a></li>
              <li><a href="#" class="nav-link" onclick="switchTab('reports')"><i class="fa-solid fa-file-invoice me-2"></i>Reports</a></li>
              <li><a href="/scanner" target="_blank" class="nav-link"><i class="fa-solid fa-qrcode me-2"></i>Scanner Portal <i class="fa-solid fa-arrow-up-right-from-square ms-1 small"></i></a></li>
              <li><a href="#" class="nav-link" onclick="switchTab('settings')"><i class="fa-solid fa-gear me-2"></i>Settings</a></li>
            </ul>
            <hr class="text-white-50">
            <div class="dropdown">
              <a href="#" class="d-flex align-items-center text-white text-decoration-none dropdown-toggle" id="userDropdown" data-bs-toggle="dropdown">
                <i class="fa-solid fa-user-gear me-2"></i><strong>\${state.user.username}</strong>
              </a>
              <ul class="dropdown-menu dropdown-menu-dark text-small shadow">
                <li><a class="dropdown-item" href="#" onclick="showChangePasswordModal()">Change Password</a></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item" href="#" onclick="logout()">Sign out</a></li>
              </ul>
            </div>
          </div>

          <!-- Main Content -->
          <div class="flex-grow-1 p-4 overflow-auto" style="height: 100vh;">
            <div id="content-area">
              <!-- Dynamic Section Container -->
            </div>
          </div>
        </div>
      \`;

      loadDashboardView(analytics);
    }

    function switchTab(tab) {
      document.querySelectorAll('.sidebar .nav-link').forEach(el => el.classList.remove('active'));
      event.currentTarget.classList.add('active');
      state.currentView = tab;

      if (tab === 'dashboard') fetch('/api/analytics/dashboard').then(r=>r.json()).then(loadDashboardView);
      if (tab === 'students') loadStudentsView();
      if (tab === 'events') loadEventsView();
      if (tab === 'attendance') loadAttendanceView();
      if (tab === 'reports') loadReportsView();
      if (tab === 'settings') loadSettingsView();
    }

    function loadDashboardView(analytics) {
      const activeEvent = state.events.find(e => e.status === 'Active') || { name: 'None' };

      document.getElementById('content-area').innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4">
          <div>
            <h3 class="fw-bold mb-0">System Analytics Dashboard</h3>
            <p class="text-muted small mb-0">Real-time attendance statistics for today (\${new Date().toLocaleDateString()})</p>
          </div>
          <div>
            <button class="btn btn-primary" onclick="switchTab('students')"><i class="fa-solid fa-user-plus me-1"></i> Register Student</button>
            <a href="/scanner" target="_blank" class="btn btn-success ms-2"><i class="fa-solid fa-camera me-1"></i> Launch Scanner</a>
          </div>
        </div>

        <div class="row g-3 mb-4">
          <div class="col-md-2">
            <div class="card card-stat bg-white p-3 border-start border-primary border-4">
              <span class="text-muted small">Total Students</span>
              <h3 class="fw-bold text-primary mb-0">\${analytics.totalStudents}</h3>
            </div>
          </div>
          <div class="col-md-2">
            <div class="card card-stat bg-white p-3 border-start border-success border-4">
              <span class="text-muted small">Present Today</span>
              <h3 class="fw-bold text-success mb-0">\${analytics.presentToday}</h3>
            </div>
          </div>
          <div class="col-md-2">
            <div class="card card-stat bg-white p-3 border-start border-warning border-4">
              <span class="text-muted small">Late Today</span>
              <h3 class="fw-bold text-warning mb-0">\${analytics.lateToday}</h3>
            </div>
          </div>
          <div class="col-md-2">
            <div class="card card-stat bg-white p-3 border-start border-danger border-4">
              <span class="text-muted small">Absent Today</span>
              <h3 class="fw-bold text-danger mb-0">\${analytics.absentToday}</h3>
            </div>
          </div>
          <div class="col-md-2">
            <div class="card card-stat bg-white p-3 border-start border-info border-4">
              <span class="text-muted small">Attendance Rate</span>
              <h3 class="fw-bold text-info mb-0">\${analytics.attendancePct}%</h3>
            </div>
          </div>
          <div class="col-md-2">
            <div class="card card-stat bg-white p-3 border-start border-secondary border-4">
              <span class="text-muted small">Active Event</span>
              <h6 class="fw-bold text-dark mb-0 text-truncate">\${activeEvent.name}</h6>
            </div>
          </div>
        </div>

        <div class="row g-4">
          <div class="col-md-8">
            <div class="card border-0 shadow-sm p-3">
              <h5 class="fw-bold mb-3">Attendance Distribution Chart</h5>
              <canvas id="attendanceChart" height="140"></canvas>
            </div>
          </div>
          <div class="col-md-4">
            <div class="card border-0 shadow-sm p-3">
              <h5 class="fw-bold mb-3">Frequent Late Arrivals Alert</h5>
              <div id="frequent-lates-list" class="list-group list-group-flush">
                <p class="text-muted small">Loading alerts...</p>
              </div>
            </div>
          </div>
        </div>
      \`;

      // Render Chart.js Graph
      const ctx = document.getElementById('attendanceChart').getContext('2d');
      new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Present', 'Late', 'Absent', 'Excused'],
          datasets: [{
            data: [analytics.presentToday, analytics.lateToday, analytics.absentToday, analytics.excusedToday],
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444', '#06b6d4']
          }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
      });

      // Fetch Frequent Lates
      fetch('/api/analytics/frequent-lates').then(r=>r.json()).then(lates => {
        const container = document.getElementById('frequent-lates-list');
        if (lates.length === 0) {
          container.innerHTML = '<span class="text-success small">No frequent late records found.</span>';
          return;
        }
        container.innerHTML = lates.map(l => \`
          <div class="list-group-item px-0 d-flex justify-content-between align-items-center">
            <div>
              <strong class="d-block text-dark small">\${l.full_name}</strong>
              <span class="text-muted extra-small">\${l.grade_level} - \${l.section}</span>
            </div>
            <span class="badge bg-danger rounded-pill">\${l.late_count} Lates</span>
          </div>
        \`).join('');
      });
    }

    // --- STUDENT MANAGEMENT MODULE ---
    async function loadStudentsView() {
      const res = await fetch('/api/students');
      state.students = await res.json();

      document.getElementById('content-area').innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h4 class="fw-bold mb-0">Student Directory & ID Generator</h4>
          <div>
            <button class="btn btn-outline-secondary me-2" onclick="printA4IDs()"><i class="fa-solid fa-print me-1"></i> Print All IDs (8/A4)</button>
            <button class="btn btn-primary" onclick="showStudentModal()"><i class="fa-solid fa-plus me-1"></i> Add Student</button>
          </div>
        </div>

        <div class="card border-0 shadow-sm p-3 mb-3">
          <div class="row g-2">
            <div class="col-md-4">
              <input type="text" id="search-student" class="form-control" placeholder="Search by name, ID..." oninput="filterStudents()">
            </div>
            <div class="col-md-3">
              <select id="filter-grade" class="form-select" onchange="filterStudents()">
                <option value="">All Grade Levels</option>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="Grade 9">Grade 9</option>
                <option value="Grade 10">Grade 10</option>
                <option value="Grade 11">Grade 11</option>
                <option value="Grade 12">Grade 12</option>
              </select>
            </div>
            <div class="col-md-3">
              <input type="text" id="filter-section" class="form-control" placeholder="Filter by section..." oninput="filterStudents()">
            </div>
          </div>
        </div>

        <div class="table-responsive bg-white rounded shadow-sm">
          <table class="table table-hover align-middle mb-0">
            <thead class="table-light">
              <tr>
                <th>Student ID</th>
                <th>Full Name</th>
                <th>Grade Level</th>
                <th>Section</th>
                <th>QR Status</th>
                <th class="text-end">Actions</th>
              </tr>
            </thead>
            <tbody id="students-table-body">
              \${renderStudentRows(state.students)}
            </tbody>
          </table>
        </div>
      \`;
    }

    function renderStudentRows(list) {
      if (list.length === 0) return '<tr><td colspan="6" class="text-center text-muted p-4">No student records found.</td></tr>';
      return list.map(s => \`
        <tr>
          <td class="fw-bold text-primary">\${s.student_id}</td>
          <td>\${s.full_name}</td>
          <td>\${s.grade_level}</td>
          <td>\${s.section}</td>
          <td>
            <span class="badge \${s.qr_status === 'Active' ? 'bg-success' : 'bg-secondary'}">\${s.qr_status}</span>
          </td>
          <td class="text-end">
            <button class="btn btn-sm btn-outline-info me-1" onclick="viewDigitalID('\${s.student_id}')"><i class="fa-solid fa-id-card"></i> ID</button>
            <button class="btn btn-sm btn-outline-warning me-1" onclick="regenerateQR(\${s.id})"><i class="fa-solid fa-rotate"></i> QR</button>
            <button class="btn btn-sm btn-outline-primary" onclick="editStudent(\${s.id})"><i class="fa-solid fa-pen"></i></button>
          </td>
        </tr>
      \`).join('');
    }

    function filterStudents() {
      const q = document.getElementById('search-student').value.toLowerCase();
      const g = document.getElementById('filter-grade').value;
      const sec = document.getElementById('filter-section').value.toLowerCase();

      const filtered = state.students.filter(s => {
        const matchesQ = s.full_name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q);
        const matchesG = g === '' || s.grade_level === g;
        const matchesSec = sec === '' || s.section.toLowerCase().includes(sec);
        return matchesQ && matchesG && matchesSec;
      });

      document.getElementById('students-table-body').innerHTML = renderStudentRows(filtered);
    }

    // --- A4 PRINTING SYSTEM (8 IDs per Page) ---
    async function printA4IDs() {
      const printSection = document.getElementById('print-section');
      printSection.classList.remove('d-none');
      printSection.innerHTML = '';

      const chunkSize = 8;
      for (let i = 0; i < state.students.length; i += chunkSize) {
        const chunk = state.students.slice(i, i + chunkSize);
        const pageEl = document.createElement('div');
        pageEl.className = 'a4-page';

        for (const student of chunk) {
          const cardEl = document.createElement('div');
          cardEl.className = 'id-card';
          
          // Generate high quality QR canvas
          const qrCanvas = document.createElement('canvas');
          await QRCode.toCanvas(qrCanvas, student.qr_token, { width: 55, margin: 1 });

          cardEl.innerHTML = \`
            <div class="id-card-header fw-bold text-uppercase" style="font-size: 8px;">
              \${state.settings.school_name || 'SCHOOL ID'}
            </div>
            <div class="id-card-body">
              <img src="\${student.profile_pic || 'https://via.placeholder.com/65'}" class="id-photo">
              <div class="id-details">
                <div class="fw-bold text-primary" style="font-size: 11px;">\${student.full_name}</div>
                <div>ID: <strong>\${student.student_id}</strong></div>
                <div>\${student.grade_level} - \${student.section}</div>
                <div class="text-muted extra-small">SY: \${student.school_year}</div>
              </div>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-1 border-top pt-1">
              <span class="extra-small text-muted">Emergency: \${student.guardian_contact || 'N/A'}</span>
              <div class="qr-container"></div>
            </div>
          \`;
          cardEl.querySelector('.qr-container').appendChild(qrCanvas);
          pageEl.appendChild(cardEl);
        }
        printSection.appendChild(pageEl);
      }

      window.print();
      setTimeout(() => printSection.classList.add('d-none'), 1000);
    }

    // --- SEPARATE QR SCANNER PORTAL ---
    function renderScannerPortal() {
      document.getElementById('app').innerHTML = \`
        <div class="container-fluid vh-100 bg-dark text-white p-3 d-flex flex-column">
          <div class="d-flex justify-content-between align-items-center mb-2 border-bottom border-secondary pb-2">
            <h4 class="fw-bold mb-0 text-info"><i class="fa-solid fa-camera me-2"></i> Attendance Scanner Portal</h4>
            <div class="d-flex gap-2">
              <select id="scanner-event-select" class="form-select form-select-sm bg-secondary text-white border-0"></select>
              <div class="btn-group btn-group-sm" role="group">
                <input type="radio" class="btn-check" name="scanMode" id="modeIn" value="IN" checked>
                <label class="btn btn-outline-success" for="modeIn">TIME IN</label>
                <input type="radio" class="btn-check" name="scanMode" id="modeOut" value="OUT">
                <label class="btn btn-outline-warning" for="modeOut">TIME OUT</label>
              </div>
            </div>
          </div>

          <div class="row flex-grow-1 g-3">
            <div class="col-md-6 d-flex flex-column">
              <div class="bg-black rounded p-2 flex-grow-1 d-flex flex-column justify-content-center align-items-center position-relative">
                <div id="qr-reader" style="width: 100%; max-width: 450px;"></div>
                <div class="mt-2 text-center text-muted small">Point QR Code towards camera</div>
              </div>
            </div>

            <div class="col-md-6 d-flex flex-column">
              <div id="scan-result-card" class="card bg-secondary text-white p-4 flex-grow-1 d-flex flex-column justify-content-center align-items-center text-center">
                <i class="fa-solid fa-qrcode fa-5x mb-3 text-white-50"></i>
                <h3>Ready to Scan</h3>
                <p class="text-white-50">Waiting for QR Code input...</p>
              </div>
            </div>
          </div>
        </div>
      \`;

      // Load Events into Scanner Select
      fetch('/api/events').then(r=>r.json()).then(events => {
        const select = document.getElementById('scanner-event-select');
        select.innerHTML = events.map(e => \`<option value="\${e.id}">\${e.name} (\${e.event_date})</option>\`).join('');
      });

      // Initialize HTML5 QR Code Scanner
      const html5QrCode = new Html5Qrcode("qr-reader");
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        onScanSuccess
      );
    }

    let isProcessingScan = false;
    async function onScanSuccess(decodedText) {
      if (isProcessingScan) return;
      isProcessingScan = true;

      const eventId = document.getElementById('scanner-event-select').value;
      const scanType = document.querySelector('input[name="scanMode"]:checked').value;

      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: scanType })
      });
      const data = await res.json();

      const card = document.getElementById('scan-result-card');
      if (data.success) {
        card.className = "card bg-success text-white p-4 flex-grow-1 d-flex flex-column justify-content-center align-items-center text-center shadow-lg";
        card.innerHTML = \`
          <i class="fa-solid fa-circle-check fa-5x mb-3"></i>
          <h2>\${data.student.full_name}</h2>
          <h4>ID: \${data.student.student_id}</h4>
          <p class="fs-5 mb-0">\${data.student.grade_level} - \${data.student.section}</p>
          <span class="badge bg-light text-dark fs-6 mt-2">\${scanType} AT \${data.time} (\${data.status})</span>
        \`;
        speakText(\`\${data.student.full_name}, \${scanType === 'IN' ? 'Time in' : 'Time out'} recorded.\`);
      } else {
        card.className = "card bg-danger text-white p-4 flex-grow-1 d-flex flex-column justify-content-center align-items-center text-center shadow-lg";
        card.innerHTML = \`
          <i class="fa-solid fa-triangle-exclamation fa-5x mb-3"></i>
          <h2>\${data.code}</h2>
          <p class="fs-4">\${data.message}</p>
        \`;
        speakText(data.message);
      }

      setTimeout(() => {
        card.className = "card bg-secondary text-white p-4 flex-grow-1 d-flex flex-column justify-content-center align-items-center text-center";
        card.innerHTML = \`
          <i class="fa-solid fa-qrcode fa-5x mb-3 text-white-50"></i>
          <h3>Ready to Scan</h3>
          <p class="text-white-50">Waiting for QR Code input...</p>
        \`;
        isProcessingScan = false;
      }, 3500);
    }

    // Modal Helpers & API Handlers
    function showStudentModal() {
      alert("Registration Form Triggered. Use Admin Form Endpoint.");
    }

    async function regenerateQR(id) {
      if (!confirm("Regenerate QR code for this student? The old code will no longer work.")) return;
      await fetch(\`/api/students/\${id}/regenerate-qr\`, { method: 'POST' });
      loadStudentsView();
    }

    function logout() {
      fetch('/api/logout', { method: 'POST' }).then(() => window.location.reload());
    }

    window.onload = initApp;
  </script>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>
  `);
});

// --- SERVER INITIALIZATION ---
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`QR Attendance Management System running on port ${PORT}`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`Scanner Portal: http://localhost:${PORT}/scanner`);
  console.log(`Default Credentials: username=admin, password=admin123`);
  console.log(`====================================================`);
});
