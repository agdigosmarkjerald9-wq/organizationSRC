/**
 * QR CODE SCHOOL ATTENDANCE MANAGEMENT SYSTEM
 * Complete Single-File Solution (Server, Database, API, Client SPA, Printing, Scanning)
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Uploads Directory
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, 'student_' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Middleware Setup
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'qr_school_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize SQLite Database
const dbPath = process.env.DB_PATH || path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Users Table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT,
    full_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Students Table
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE,
    first_name TEXT,
    middle_name TEXT,
    last_name TEXT,
    full_name TEXT,
    grade_level TEXT,
    section TEXT,
    gender TEXT,
    dob TEXT,
    contact_number TEXT,
    email TEXT,
    address TEXT,
    guardian_name TEXT,
    guardian_contact TEXT,
    photo TEXT,
    school_year TEXT,
    status TEXT DEFAULT 'Active',
    qr_token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Events Table
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    event_date TEXT,
    start_time TEXT,
    end_time TEXT,
    location TEXT,
    organizer TEXT,
    attendance_type TEXT,
    status TEXT DEFAULT 'Upcoming',
    target_grade TEXT DEFAULT 'All',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Attendance Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT,
    event_id INTEGER,
    date TEXT,
    time_in TEXT,
    time_out TEXT,
    status TEXT,
    scanned_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(event_id) REFERENCES events(id)
  )`);

  // Excuses Table
  db.run(`CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT,
    event_id INTEGER,
    date TEXT,
    reason TEXT,
    notes TEXT,
    approved_by TEXT,
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
    user TEXT,
    action TEXT,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed Default Data
  db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
    if (row && row.count === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      db.run("INSERT INTO users (username, password, role, full_name) VALUES ('admin', ?, 'Administrator', 'System Administrator')", [hash]);
      const scannerHash = bcrypt.hashSync('scanner123', 10);
      db.run("INSERT INTO users (username, password, role, full_name) VALUES ('scanner', ?, 'Scanner', 'Scanner User')", [scannerHash]);
    }
  });

  db.get("SELECT COUNT(*) as count FROM settings", (err, row) => {
    if (row && row.count === 0) {
      const defaults = [
        ['school_name', 'St. Jude Academy'],
        ['school_address', '123 Academic Way, Education City'],
        ['school_year', '2026-2027'],
        ['late_threshold', '07:30'],
        ['min_attendance_pct', '75']
      ];
      defaults.forEach(([k, v]) => db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [k, v]));
    }
  });

  db.get("SELECT COUNT(*) as count FROM events", (err, row) => {
    if (row && row.count === 0) {
      const today = new Date().toISOString().split('T')[0];
      db.run("INSERT INTO events (name, description, event_date, start_time, end_time, location, status) VALUES ('General Attendance', 'Daily General Attendance', ?, '07:00', '17:00', 'Main Campus', 'Active')", [today]);
    }
  });

  db.get("SELECT COUNT(*) as count FROM students", (err, row) => {
    if (row && row.count === 0) {
      const sampleStudents = [
        ['2026-001', 'Juan', 'A.', 'Dela Cruz', 'Juan A. Dela Cruz', 'Grade 11', 'STEM A', 'Male', '2008-05-15', '09123456781', 'juan@school.edu', 'Manila', 'Maria Dela Cruz', '09123456782', '2026-2027', crypto.randomBytes(16).toString('hex')],
        ['2026-002', 'Maria', 'B.', 'Santos', 'Maria B. Santos', 'Grade 11', 'STEM A', 'Female', '2008-08-20', '09123456783', 'maria@school.edu', 'Quezon City', 'Jose Santos', '09123456784', '2026-2027', crypto.randomBytes(16).toString('hex')],
        ['2026-003', 'Mark', 'C.', 'Reyes', 'Mark C. Reyes', 'Grade 12', 'ABM B', 'Male', '2007-02-10', '09123456785', 'mark@school.edu', 'Pasig', 'Elena Reyes', '09123456786', '2026-2027', crypto.randomBytes(16).toString('hex')]
      ];
      sampleStudents.forEach(s => {
        db.run(`INSERT INTO students (student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact_number, email, address, guardian_name, guardian_contact, school_year, qr_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, s);
      });
    }
  });
});

// Audit Logging Utility
function logAction(user, action, details) {
  db.run("INSERT INTO audit_logs (user, action, details) VALUES (?, ?, ?)", [user || 'System', action, details]);
}

// Authentication Helpers
function authRequired(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized access. Please log in.' });
}

function adminOnly(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'Administrator') return next();
  res.status(403).json({ error: 'Forbidden. Administrator privileges required.' });
}

// ---------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------

// Auth APIs
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Invalid username or password' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Invalid username or password' });
    
    req.session.user = { id: user.id, username: user.username, role: user.role, full_name: user.full_name };
    logAction(user.username, 'Login', 'User logged into system');
    res.json({ success: true, user: req.session.user });
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.user) logAction(req.session.user.username, 'Logout', 'User logged out');
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Dashboard Analytics API
app.get('/api/admin/dashboard', authRequired, adminOnly, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const query = `
    SELECT 
      (SELECT COUNT(*) FROM students WHERE status='Active') as total_students,
      (SELECT COUNT(DISTINCT student_id) FROM attendance WHERE date=? AND status='PRESENT') as present_today,
      (SELECT COUNT(DISTINCT student_id) FROM attendance WHERE date=? AND status='LATE') as late_today,
      (SELECT COUNT(*) FROM events WHERE status='Active') as active_events,
      (SELECT COUNT(*) FROM events) as total_events
  `;
  db.get(query, [today, today], (err, counts) => {
    if (err) return res.status(500).json({ error: err.message });
    const absent_today = Math.max(0, counts.total_students - (counts.present_today + counts.late_today));
    const att_pct = counts.total_students > 0 ? (((counts.present_today + counts.late_today) / counts.total_students) * 100).toFixed(1) : 0;
    
    db.all("SELECT a.*, s.full_name, s.grade_level, s.section, e.name as event_name FROM attendance a LEFT JOIN students s ON a.student_id = s.student_id LEFT JOIN events e ON a.event_id = e.id ORDER BY a.id DESC LIMIT 10", (err, recents) => {
      res.json({
        summary: { ...counts, absent_today, attendance_pct: att_pct },
        recentScans: recents || []
      });
    });
  });
});

// Students API
app.get('/api/students', authRequired, (req, res) => {
  db.all("SELECT * FROM students ORDER BY id DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/students', authRequired, adminOnly, upload.single('photo'), (req, res) => {
  const data = req.body;
  const photoPath = req.file ? `/public/uploads/${req.file.filename}` : '/public/uploads/default.png';
  const fullName = `${data.first_name} ${data.middle_name ? data.middle_name + ' ' : ''}${data.last_name}`;
  const qrToken = crypto.randomBytes(16).toString('hex');

  const sql = `INSERT INTO students (student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact_number, email, address, guardian_name, guardian_contact, photo, school_year, qr_token)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const params = [data.student_id, data.first_name, data.middle_name, data.last_name, fullName, data.grade_level, data.section, data.gender, data.dob, data.contact_number, data.email, data.address, data.guardian_name, data.guardian_contact, photoPath, data.school_year || '2026-2027', qrToken];

  db.run(sql, params, function(err) {
    if (err) return res.status(400).json({ error: 'Student ID or QR code already exists' });
    logAction(req.session.user.username, 'Create Student', `Registered student ${fullName} (${data.student_id})`);
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/students/:id', authRequired, adminOnly, upload.single('photo'), (req, res) => {
  const data = req.body;
  const fullName = `${data.first_name} ${data.middle_name ? data.middle_name + ' ' : ''}${data.last_name}`;
  let sql = `UPDATE students SET first_name=?, middle_name=?, last_name=?, full_name=?, grade_level=?, section=?, gender=?, dob=?, contact_number=?, email=?, address=?, guardian_name=?, guardian_contact=?, school_year=?, status=?`;
  let params = [data.first_name, data.middle_name, data.last_name, fullName, data.grade_level, data.section, data.gender, data.dob, data.contact_number, data.email, data.address, data.guardian_name, data.guardian_contact, data.school_year, data.status];
  
  if (req.file) {
    sql += `, photo=?`;
    params.push(`/public/uploads/${req.file.filename}`);
  }
  sql += ` WHERE id=?`;
  params.push(req.params.id);

  db.run(sql, params, function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAction(req.session.user.username, 'Update Student', `Updated student ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.post('/api/students/:id/regenerate-qr', authRequired, adminOnly, (req, res) => {
  const newToken = crypto.randomBytes(16).toString('hex');
  db.run("UPDATE students SET qr_token=? WHERE id=?", [newToken, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAction(req.session.user.username, 'Regenerate QR', `Regenerated QR token for student database key ${req.params.id}`);
    res.json({ success: true, qr_token: newToken });
  });
});

// QR Image Generation API Endpoint
app.get('/api/qr/:token', (req, res) => {
  QRCode.toDataURL(req.params.token, { margin: 1, width: 250 }, (err, url) => {
    if (err) return res.status(500).send('Error generating QR');
    const base64Data = url.replace(/^data:image\/png;base64,/, "");
    const img = Buffer.from(base64Data, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
    res.end(img);
  });
});

// Events API
app.get('/api/events', authRequired, (req, res) => {
  db.all("SELECT * FROM events ORDER BY id DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/events', authRequired, adminOnly, (req, res) => {
  const d = req.body;
  const sql = `INSERT INTO events (name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, target_grade, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
  const params = [d.name, d.description, d.event_date, d.start_time, d.end_time, d.location, d.organizer, d.attendance_type, d.status || 'Active', d.target_grade || 'All', req.session.user.username];
  db.run(sql, params, function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAction(req.session.user.username, 'Create Event', `Created event ${d.name}`);
    res.json({ success: true, id: this.lastID });
  });
});

// SCANNER CORE ROUTE (TIME IN / TIME OUT)
app.post('/api/scan', (req, res) => {
  const { qr_token, event_id, scan_mode } = req.body; // scan_mode = 'IN' or 'OUT'
  const today = new Date().toISOString().split('T')[0];
  const nowTime = new Date().toTimeString().split(' ')[0].substring(0, 5);

  db.get("SELECT * FROM students WHERE qr_token = ? AND status = 'Active'", [qr_token], (err, student) => {
    if (err || !student) {
      return res.status(404).json({ success: false, code: 'INVALID_QR', message: 'Invalid or deactivated QR Code.' });
    }

    db.get("SELECT * FROM events WHERE id = ?", [event_id], (err, event) => {
      if (err || !event) {
        return res.status(404).json({ success: false, code: 'INVALID_EVENT', message: 'Selected event not active or valid.' });
      }

      // Check Target Grade restriction
      if (event.target_grade !== 'All' && event.target_grade !== student.grade_level) {
        return res.status(403).json({ success: false, code: 'NOT_ELIGIBLE', message: `Student is not eligible for this event.` });
      }

      // Check Existing Attendance
      db.get("SELECT * FROM attendance WHERE student_id = ? AND event_id = ? AND date = ?", [student.student_id, event_id, today], (err, record) => {
        if (scan_mode === 'IN') {
          if (record && record.time_in) {
            return res.json({ success: false, code: 'DUPLICATE_IN', message: `${student.full_name} is already recorded for Time In.`, student });
          }

          // Fetch late threshold
          db.get("SELECT value FROM settings WHERE key='late_threshold'", (err, setting) => {
            const threshold = (setting && setting.value) || event.start_time || '07:30';
            const status = nowTime > threshold ? 'LATE' : 'PRESENT';

            if (record) {
              db.run("UPDATE attendance SET time_in = ?, status = ? WHERE id = ?", [nowTime, status, record.id]);
            } else {
              db.run("INSERT INTO attendance (student_id, event_id, date, time_in, status, scanned_by) VALUES (?,?,?,?,?,?)",
                     [student.student_id, event_id, today, nowTime, status, 'Scanner Portal']);
            }
            logAction('Scanner', 'Time In', `${student.full_name} scanned IN for ${event.name}`);
            res.json({ success: true, type: 'IN', status, student, time: nowTime, event_name: event.name });
          });

        } else if (scan_mode === 'OUT') {
          if (!record) {
            return res.json({ success: false, code: 'NO_IN_RECORD', message: `${student.full_name} has no Time In record yet.`, student });
          }
          if (record.time_out) {
            return res.json({ success: false, code: 'DUPLICATE_OUT', message: `${student.full_name} is already recorded for Time Out.`, student });
          }

          db.run("UPDATE attendance SET time_out = ? WHERE id = ?", [nowTime, record.id]);
          logAction('Scanner', 'Time Out', `${student.full_name} scanned OUT for ${event.name}`);
          res.json({ success: true, type: 'OUT', status: record.status, student, time: nowTime, event_name: event.name });
        }
      });
    });
  });
});

// Attendance Records & Reports APIs
app.get('/api/attendance', authRequired, (req, res) => {
  const { date, event_id, grade_level, section } = req.query;
  let sql = `SELECT a.*, s.full_name, s.grade_level, s.section, e.name as event_name 
             FROM attendance a 
             JOIN students s ON a.student_id = s.student_id 
             JOIN events e ON a.event_id = e.id WHERE 1=1`;
  let params = [];
  if (date) { sql += ` AND a.date = ?`; params.push(date); }
  if (event_id) { sql += ` AND a.event_id = ?`; params.push(event_id); }
  if (grade_level) { sql += ` AND s.grade_level = ?`; params.push(grade_level); }
  if (section) { sql += ` AND s.section = ?`; params.push(section); }
  sql += ` ORDER BY a.id DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Settings API
app.get('/api/settings', (req, res) => {
  db.all("SELECT * FROM settings", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const obj = {};
    rows.forEach(r => obj[r.key] = r.value);
    res.json(obj);
  });
});

app.post('/api/settings', authRequired, adminOnly, (req, res) => {
  const settings = req.body;
  db.serialize(() => {
    Object.keys(settings).forEach(k => {
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [k, settings[k]]);
    });
    logAction(req.session.user.username, 'Update Settings', 'Updated application settings');
    res.json({ success: true });
  });
});

// Audit Logs API
app.get('/api/audit-logs', authRequired, adminOnly, (req, res) => {
  db.all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100", (err, rows) => {
    res.json(rows || []);
  });
});

// Data Backup & Restore API
app.get('/api/admin/backup', authRequired, adminOnly, (req, res) => {
  res.download(dbPath, `backup_attendance_${new Date().toISOString().split('T')[0]}.db`);
});

// ---------------------------------------------------------
// HTML CLIENT INTERFACE (ADMIN SPA & SCANNER PORTAL)
// ---------------------------------------------------------

app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Code School Attendance Management System</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <style>
    :root { --primary-color: #1e3a8a; --secondary-color: #0d9488; }
    body { background-color: #f8fafc; font-family: 'Segoe UI', system-ui, sans-serif; }
    .sidebar { min-height: 100vh; background: var(--primary-color); color: white; }
    .sidebar .nav-link { color: #cbd5e1; padding: 12px 20px; font-weight: 500; }
    .sidebar .nav-link:hover, .sidebar .nav-link.active { color: white; background: rgba(255,255,255,0.1); border-left: 4px solid var(--secondary-color); }
    .stat-card { border: none; border-radius: 12px; transition: transform 0.2s; }
    .stat-card:hover { transform: translateY(-3px); }
    
    /* Printable ID Card Styling (A4 8-IDs Layout) */
    @media print {
      body * { visibility: hidden; }
      #print-area, #print-area * { visibility: visible; }
      #print-area { position: absolute; left: 0; top: 0; width: 100%; }
      .page-break { page-break-after: always; }
      .no-print { display: none !important; }
    }
    .id-card-grid { display: grid; grid-template-columns: repeat(2, 3.375in); grid-gap: 0.2in; justify-content: center; padding: 0.3in; }
    .id-card { width: 3.375in; height: 2.125in; border: 1.5px solid #000; border-radius: 8px; position: relative; background: #fff; overflow: hidden; box-sizing: border-box; font-size: 10px; display: flex; flex-direction: column; }
    .id-card-header { background: #1e3a8a; color: white; padding: 4px; text-align: center; font-size: 9px; font-weight: bold; }
    .id-card-body { display: flex; padding: 6px; gap: 8px; flex-grow: 1; }
    .id-card-photo { width: 0.9in; height: 1.0in; object-fit: cover; border: 1px solid #ccc; border-radius: 4px; }
    .id-card-details { flex-grow: 1; }
    .id-card-qr { width: 0.8in; height: 0.8in; float: right; }
    .scanner-container { max-width: 600px; margin: 0 auto; }
    #reader video { border-radius: 12px; }
  </style>
</head>
<body>

<div id="app"></div>

<script>
  // Global Application State
  const state = {
    user: null,
    settings: {},
    events: [],
    students: [],
    scanner: { activeEvent: null, mode: 'IN', sound: true, voice: true, volume: 1.0 }
  };

  // --- Router & View Renderer ---
  function navigate() {
    const hash = window.location.hash || '#/scanner';
    fetch('/api/auth/me').then(r => r.json()).then(data => {
      state.user = data.user;
      if (hash.startsWith('#/admin') && (!state.user || state.user.role !== 'Administrator')) {
        renderLogin();
      } else if (hash === '#/scanner') {
        renderScannerPortal();
      } else if (hash === '#/admin/dashboard') {
        renderAdminLayout(renderDashboardContent);
      } else if (hash === '#/admin/students') {
        renderAdminLayout(renderStudentsContent);
      } else if (hash === '#/admin/print-ids') {
        renderAdminLayout(renderPrintIDsContent);
      } else if (hash === '#/admin/events') {
        renderAdminLayout(renderEventsContent);
      } else if (hash === '#/admin/attendance') {
        renderAdminLayout(renderAttendanceContent);
      } else if (hash === '#/admin/reports') {
        renderAdminLayout(renderReportsContent);
      } else if (hash === '#/admin/settings') {
        renderAdminLayout(renderSettingsContent);
      } else {
        renderScannerPortal();
      }
    });
  }
  window.addEventListener('hashchange', navigate);
  window.addEventListener('DOMContentLoaded', () => {
    fetch('/api/settings').then(r => r.json()).then(s => state.settings = s);
    navigate();
  });

  // --- Voice Announcement Utility ---
  function announceVoice(text) {
    if (!state.scanner.voice || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.volume = parseFloat(state.scanner.volume || 1.0);
    window.speechSynthesis.speak(utter);
  }

  // --- LOGIN VIEW ---
  function renderLogin() {
    document.getElementById('app').innerHTML = \`
      <div class="container d-flex justify-content-center align-items-center vh-100">
        <div class="card shadow-lg p-4" style="width: 400px; border-radius: 16px;">
          <div class="text-center mb-4">
            <i class="bi bi-qr-code-scan text-primary display-4"></i>
            <h4 class="mt-2 fw-bold">Admin Portal Login</h4>
            <p class="text-muted fs-7">School Attendance Management System</p>
          </div>
          <form id="loginForm">
            <div class="mb-3">
              <label class="form-label">Username</label>
              <input type="text" id="loginUser" class="form-control" required value="admin">
            </div>
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" id="loginPass" class="form-control" required value="admin123">
            </div>
            <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Login to Admin</button>
          </form>
          <div class="mt-3 text-center">
            <a href="#/scanner" class="text-decoration-none text-secondary"><i class="bi bi-camera"></i> Open Scanner Portal API</a>
          </div>
        </div>
      </div>
    \`;
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: loginUser.value, password: loginPass.value })
      });
      const data = await res.json();
      if (data.success) {
        window.location.hash = '#/admin/dashboard';
      } else {
        alert(data.error);
      }
    };
  }

  // --- SCANNER PORTAL VIEW (Standalone & Mobile Optimized) ---
  let html5QrcodeScanner = null;
  async function renderScannerPortal() {
    const eventsRes = await fetch('/api/events');
    const events = await eventsRes.json();
    const activeEvents = events.filter(e => e.status === 'Active');

    document.getElementById('app').innerHTML = \`
      <nav class="navbar navbar-dark bg-dark px-3">
        <span class="navbar-brand fw-bold"><i class="bi bi-qr-code-scan me-2"></i> Attendance Scanner Portal</span>
        <div>
          \${state.user ? '<a href="#/admin/dashboard" class="btn btn-outline-light btn-sm">Admin Dashboard</a>' : '<a href="#/admin/dashboard" class="btn btn-outline-light btn-sm">Admin Login</a>'}
        </div>
      </nav>

      <div class="container py-4 scanner-container">
        <div class="card shadow-sm border-0 mb-3">
          <div class="card-body">
            <div class="mb-3">
              <label class="form-label fw-bold">Select Active Event</label>
              <select id="scannerEventSelect" class="form-select form-select-lg">
                \${activeEvents.map(e => \`<option value="\${e.id}">\${e.name} (\${e.event_date})</option>\`).join('')}
              </select>
            </div>

            <div class="d-flex justify-content-center gap-2 mb-3">
              <button id="btnModeIn" class="btn btn-success btn-lg flex-fill fw-bold active">TIME IN</button>
              <button id="btnModeOut" class="btn btn-warning btn-lg flex-fill fw-bold">TIME OUT</button>
            </div>

            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" id="voiceToggle" checked>
              <label class="form-check-label fw-bold" for="voiceToggle">Enable Voice Announcement</label>
            </div>

            <div id="reader" style="width: 100%;"></div>

            <!-- Scan Result Display Card -->
            <div id="scanResultCard" class="mt-3 d-none"></div>
          </div>
        </div>
      </div>
    \`;

    // Toggle Modes
    const btnIn = document.getElementById('btnModeIn');
    const btnOut = document.getElementById('btnModeOut');
    btnIn.onclick = () => { state.scanner.mode = 'IN'; btnIn.classList.add('active'); btnOut.classList.remove('active'); };
    btnOut.onclick = () => { state.scanner.mode = 'OUT'; btnOut.classList.add('active'); btnIn.classList.remove('active'); };

    document.getElementById('voiceToggle').onchange = (e) => state.scanner.voice = e.target.checked;

    // Initialize QR Camera Scanner
    if (html5QrcodeScanner) html5QrcodeScanner.clear();
    html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: { width: 250, height: 250 } }, false);
    
    let isProcessing = false;
    html5QrcodeScanner.render(async (qrCodeMessage) => {
      if (isProcessing) return;
      isProcessing = true;
      const eventId = document.getElementById('scannerEventSelect').value;
      
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr_token: qrCodeMessage, event_id: eventId, scan_mode: state.scanner.mode })
        });
        const data = await res.json();
        const card = document.getElementById('scanResultCard');
        card.classList.remove('d-none');

        if (data.success) {
          const msg = \`\${data.student.full_name}, \${data.type === 'IN' ? 'Time In' : 'Time Out'} recorded.\`;
          card.className = "card border-success bg-success-subtle p-3 text-center";
          card.innerHTML = \`
            <h3 class="text-success fw-bold">✓ \${data.type} SUCCESSFUL</h3>
            <img src="\${data.student.photo}" class="rounded-circle my-2" style="width:100px; height:100px; object-fit:cover;">
            <h4>\${data.student.full_name}</h4>
            <p class="mb-0">\${data.student.grade_level} - \${data.student.section} | Status: <strong>\${data.status}</strong></p>
            <p class="text-muted fs-7">Time: \${data.time}</p>
          \`;
          announceVoice(msg);
        } else {
          card.className = "card border-danger bg-danger-subtle p-3 text-center";
          card.innerHTML = \`<h4 class="text-danger fw-bold"><i class="bi bi-x-circle"></i> \${data.message}</h4>\`;
          announceVoice(data.code === 'INVALID_QR' ? "Invalid QR code" : data.message);
        }
      } catch (e) {
        console.error(e);
      }
      setTimeout(() => { isProcessing = false; }, 3000); // 3-Second delay before next auto-scan
    });
  }

  // --- ADMIN LAYOUT SCAFFOLD ---
  function renderAdminLayout(contentFn) {
    document.getElementById('app').innerHTML = \`
      <div class="d-flex">
        <div class="sidebar d-flex flex-column flex-shrink-0 p-3" style="width: 250px;">
          <a href="#/admin/dashboard" class="d-flex align-items-center mb-3 mb-md-0 me-md-auto color-white text-white text-decoration-none">
            <i class="bi bi-shield-check fs-4 me-2"></i>
            <span class="fs-5 fw-bold">Admin Portal</span>
          </a>
          <hr>
          <ul class="nav nav-pills flex-column mb-auto">
            <li><a href="#/admin/dashboard" class="nav-link"><i class="bi bi-speedometer2 me-2"></i> Dashboard</a></li>
            <li><a href="#/admin/students" class="nav-link"><i class="bi bi-people me-2"></i> Students</a></li>
            <li><a href="#/admin/print-ids" class="nav-link"><i class="bi bi-card-heading me-2"></i> Print Student IDs</a></li>
            <li><a href="#/admin/events" class="nav-link"><i class="bi bi-calendar-event me-2"></i> Events</a></li>
            <li><a href="#/admin/attendance" class="nav-link"><i class="bi bi-clock-history me-2"></i> Attendance Log</a></li>
            <li><a href="#/admin/reports" class="nav-link"><i class="bi bi-file-earmark-bar-graph me-2"></i> Reports</a></li>
            <li><a href="#/admin/settings" class="nav-link"><i class="bi bi-gear me-2"></i> Settings</a></li>
          </ul>
          <hr>
          <div class="dropdown">
            <button class="btn btn-outline-light w-100 btn-sm" id="btnLogout"><i class="bi bi-box-arrow-right"></i> Logout</button>
          </div>
        </div>
        <div class="flex-grow-1 p-4" style="height: 100vh; overflow-y: auto;">
          <div id="admin-content"></div>
        </div>
      </div>
    \`;
    document.getElementById('btnLogout').onclick = () => {
      fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location.hash = '#/scanner');
    };
    contentFn();
  }

  // --- ADMIN DASHBOARD VIEW ---
  async function renderDashboardContent() {
    const res = await fetch('/api/admin/dashboard');
    const data = await res.json();
    const s = data.summary;

    document.getElementById('admin-content').innerHTML = \`
      <h3 class="fw-bold mb-4">Dashboard Overview</h3>
      <div class="row g-3 mb-4">
        <div class="col-md-3">
          <div class="card stat-card bg-primary text-white p-3">
            <h6>Total Active Students</h6>
            <h2 class="fw-bold">\${s.total_students}</h2>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card stat-card bg-success text-white p-3">
            <h6>Present Today</h6>
            <h2 class="fw-bold">\${s.present_today}</h2>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card stat-card bg-warning text-dark p-3">
            <h6>Late Today</h6>
            <h2 class="fw-bold">\${s.late_today}</h2>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card stat-card bg-danger text-white p-3">
            <h6>Absent Today</h6>
            <h2 class="fw-bold">\${s.absent_today}</h2>
          </div>
        </div>
      </div>

      <div class="row g-3 mb-4">
        <div class="col-md-8">
          <div class="card border-0 shadow-sm p-3">
            <h5>Attendance Analytics</h5>
            <canvas id="dashboardChart" style="max-height: 250px;"></canvas>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card border-0 shadow-sm p-3">
            <h5>Quick Actions</h5>
            <div class="d-grid gap-2 mt-3">
              <a href="#/admin/students" class="btn btn-outline-primary"><i class="bi bi-person-plus"></i> Register Student</a>
              <a href="#/admin/print-ids" class="btn btn-outline-secondary"><i class="bi bi-printer"></i> Print 8-ID Layout</a>
              <a href="#/scanner" target="_blank" class="btn btn-success"><i class="bi bi-camera"></i> Launch Live Scanner</a>
            </div>
          </div>
        </div>
      </div>
    \`;

    // Render Chart
    const ctx = document.getElementById('dashboardChart').getContext('2d');
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Present', 'Late', 'Absent'],
        datasets: [{
          data: [s.present_today, s.late_today, s.absent_today],
          backgroundColor: ['#10b981', '#f59e0b', '#ef4444']
        }]
      }
    });
  }

  // --- STUDENTS MANAGEMENT VIEW ---
  async function renderStudentsContent() {
    const res = await fetch('/api/students');
    const students = await res.json();
    state.students = students;

    document.getElementById('admin-content').innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold">Student Directory</h3>
        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#studentModal"><i class="bi bi-plus-lg"></i> Register New Student</button>
      </div>

      <div class="card border-0 shadow-sm p-3">
        <table class="table table-hover align-middle">
          <thead>
            <tr>
              <th>ID</th>
              <th>Photo</th>
              <th>Name</th>
              <th>Grade Level & Section</th>
              <th>Gender</th>
              <th>QR Code</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            \${students.map(s => \`
              <tr>
                <td><strong>\${s.student_id}</strong></td>
                <td><img src="\${s.photo || '/public/uploads/default.png'}" style="width:40px;height:40px;object-fit:cover;" class="rounded-circle"></td>
                <td>\${s.full_name}</td>
                <td>\${s.grade_level} - \${s.section}</td>
                <td>\${s.gender}</td>
                <td><img src="/api/qr/\${s.qr_token}" style="width:40px;height:40px;"></td>
                <td>
                  <button class="btn btn-sm btn-outline-info me-1" onclick="viewStudentQR('\${s.qr_token}', '\${s.full_name}')"><i class="bi bi-qr-code"></i></button>
                  <button class="btn btn-sm btn-outline-warning" onclick="regenQR(\${s.id})"><i class="bi bi-arrow-repeat"></i></button>
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>

      <!-- Registration Modal -->
      <div class="modal fade" id="studentModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <form id="studentForm">
              <div class="modal-header">
                <h5 class="modal-title">Register Student</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body row g-3">
                <div class="col-md-4"><label class="form-label">Student ID</label><input type="text" name="student_id" class="form-control" required></div>
                <div class="col-md-4"><label class="form-label">First Name</label><input type="text" name="first_name" class="form-control" required></div>
                <div class="col-md-4"><label class="form-label">Last Name</label><input type="text" name="last_name" class="form-control" required></div>
                <div class="col-md-6">
                  <label class="form-label">Grade Level</label>
                  <select name="grade_level" class="form-select" required>
                    <option>Grade 7</option><option>Grade 8</option><option>Grade 9</option>
                    <option>Grade 10</option><option>Grade 11</option><option>Grade 12</option>
                  </select>
                </div>
                <div class="col-md-6"><label class="form-label">Section</label><input type="text" name="section" class="form-control" required></div>
                <div class="col-md-6"><label class="form-label">Gender</label><select name="gender" class="form-select"><option>Male</option><option>Female</option></select></div>
                <div class="col-md-6"><label class="form-label">Photo Upload</label><input type="file" name="photo" class="form-control"></div>
              </div>
              <div class="modal-footer">
                <button type="submit" class="btn btn-primary">Save Student</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('studentForm').onsubmit = async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const res = await fetch('/api/students', { method: 'POST', body: formData });
      if (res.ok) { alert('Student Registered Successfully!'); renderStudentsContent(); }
    };
  }

  window.viewStudentQR = (token, name) => {
    alert(\`Showing QR Token: \${token} for \${name}\`);
  };

  window.regenQR = async (id) => {
    if (confirm('Regenerate QR Token? The existing physical card QR will stop working.')) {
      await fetch(\`/api/students/\${id}/regenerate-qr\`, { method: 'POST' });
      renderStudentsContent();
    }
  };

  // --- PRINTABLE A4 ID CARDS VIEW (8 IDs PER A4 PAGE) ---
  async function renderPrintIDsContent() {
    const res = await fetch('/api/students');
    const students = await res.json();

    document.getElementById('admin-content').innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3 no-print">
        <h3 class="fw-bold">Printable ID Cards (8 IDs / A4 Page)</h3>
        <button class="btn btn-success" onclick="window.print()"><i class="bi bi-printer"></i> Print A4 Pages</button>
      </div>

      <div id="print-area">
        \${renderA4Pages(students)}
      </div>
    \`;
  }

  function renderA4Pages(students) {
    let pagesHTML = '';
    for (let i = 0; i < students.length; i += 8) {
      const pageStudents = students.slice(i, i + 8);
      pagesHTML += \`
        <div class="page-break">
          <div class="id-card-grid">
            \${pageStudents.map(s => \`
              <div class="id-card">
                <div class="id-card-header">\${state.settings.school_name || 'ST. JUDE ACADEMY'}</div>
                <div class="id-card-body">
                  <img src="\${s.photo || '/public/uploads/default.png'}" class="id-card-photo">
                  <div class="id-card-details">
                    <img src="/api/qr/\${s.qr_token}" class="id-card-qr">
                    <div style="font-weight:bold; font-size:11px;">\${s.full_name}</div>
                    <div class="text-muted">ID: \${s.student_id}</div>
                    <div>\${s.grade_level} - \${s.section}</div>
                    <div style="font-size:8px; margin-top:4px;">SY: \${s.school_year}</div>
                  </div>
                </div>
              </div>
            \`).join('')}
          </div>
        </div>
      \`;
    }
    return pagesHTML;
  }

  // --- EVENTS MANAGEMENT VIEW ---
  async function renderEventsContent() {
    const res = await fetch('/api/events');
    const events = await res.json();

    document.getElementById('admin-content').innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold">Event Management</h3>
        <button class="btn btn-primary" onclick="showCreateEventModal()"><i class="bi bi-plus-lg"></i> Create Event</button>
      </div>
      <div class="card border-0 shadow-sm p-3">
        <table class="table table-hover">
          <thead><tr><th>Event Name</th><th>Date</th><th>Time</th><th>Target Grade</th><th>Status</th></tr></thead>
          <tbody>
            \${events.map(e => \`
              <tr>
                <td><strong>\${e.name}</strong></td>
                <td>\${e.event_date}</td>
                <td>\${e.start_time} - \${e.end_time}</td>
                <td>\${e.target_grade}</td>
                <td><span class="badge bg-success">\${e.status}</span></td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  // --- ATTENDANCE LOG VIEW ---
  async function renderAttendanceContent() {
    const res = await fetch('/api/attendance');
    const logs = await res.json();

    document.getElementById('admin-content').innerHTML = \`
      <h3 class="fw-bold mb-4">Live Attendance Logs</h3>
      <div class="card border-0 shadow-sm p-3">
        <table class="table table-striped align-middle">
          <thead><tr><th>Date</th><th>Student ID</th><th>Name</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
          <tbody>
            \${logs.map(l => \`
              <tr>
                <td>\${l.date}</td>
                <td>\${l.student_id}</td>
                <td>\${l.full_name}</td>
                <td>\${l.event_name}</td>
                <td><span class="badge bg-info">\${l.time_in || '--'}</span></td>
                <td><span class="badge bg-secondary">\${l.time_out || '--'}</span></td>
                <td><span class="badge bg-\${l.status === 'PRESENT' ? 'success' : 'warning'}">\${l.status}</span></td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  // --- REPORTS VIEW ---
  function renderReportsContent() {
    document.getElementById('admin-content').innerHTML = \`
      <h3 class="fw-bold mb-4">System Reports</h3>
      <div class="card border-0 shadow-sm p-4">
        <p>Export options and automated daily, weekly, and monthly attendance reports.</p>
        <button class="btn btn-outline-primary" onclick="alert('Exporting CSV...')"><i class="bi bi-file-earmark-spreadsheet"></i> Export Attendance Log to CSV</button>
      </div>
    \`;
  }

  // --- SETTINGS VIEW ---
  function renderSettingsContent() {
    document.getElementById('admin-content').innerHTML = \`
      <h3 class="fw-bold mb-4">System Configurations</h3>
      <div class="card border-0 shadow-sm p-4" style="max-width: 600px;">
        <form id="settingsForm">
          <div class="mb-3">
            <label class="form-label">School / Institution Name</label>
            <input type="text" id="setSchoolName" class="form-control" value="\${state.settings.school_name || ''}">
          </div>
          <div class="mb-3">
            <label class="form-label">Late Time Threshold (HH:MM)</label>
            <input type="time" id="setLate" class="form-control" value="\${state.settings.late_threshold || '07:30'}">
          </div>
          <button type="submit" class="btn btn-primary">Save Settings</button>
        </form>
      </div>
    \`;
    document.getElementById('settingsForm').onsubmit = async (e) => {
      e.preventDefault();
      await fetch('/api/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ school_name: setSchoolName.value, late_threshold: setLate.value })
      });
      alert('Settings Saved!');
    };
  }

</script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`);
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` SCHOOL QR ATTENDANCE SYSTEM IS RUNNING ON PORT: ${PORT}`);
  console.log(` Admin Portal:    http://localhost:${PORT}/#/admin/dashboard`);
  console.log(` Scanner Portal:  http://localhost:${PORT}/#/scanner`);
  console.log(`=======================================================`);
});
