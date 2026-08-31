const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'qr_attendance_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize SQLite Database
const db = new sqlite3.Database(':memory:', (err) => {
  if (err) console.error('Database connection error:', err.message);
  else console.log('Connected to SQLite in-memory database.');
});

// Database Initialization Schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  )`);

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
    contact TEXT,
    email TEXT,
    address TEXT,
    guardian_name TEXT,
    guardian_contact TEXT,
    school_year TEXT,
    status TEXT DEFAULT 'Active',
    qr_token TEXT UNIQUE,
    qr_status TEXT DEFAULT 'Active',
    photo TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    date TEXT,
    start_time TEXT,
    end_time TEXT,
    location TEXT,
    status TEXT DEFAULT 'Upcoming',
    allowed_grade TEXT DEFAULT 'All'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT,
    event_id INTEGER,
    date TEXT,
    time_in TEXT,
    time_out TEXT,
    status TEXT,
    scan_type TEXT,
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    FOREIGN KEY(event_id) REFERENCES events(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    action TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Seed Default Settings
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('school_name', 'Global Academy Institute of Technology')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('late_threshold', '07:30')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('min_attendance_pct', '75')`);

  // Seed Default Admin User
  const defaultHash = bcrypt.hashSync('admin123', 10);
  db.run(`INSERT OR IGNORE INTO users (username, password, role) VALUES ('admin', '${defaultHash}', 'admin')`);

  // Seed Initial General Event
  const today = new Date().toISOString().split('T')[0];
  db.run(`INSERT OR IGNORE INTO events (id, name, description, date, start_time, end_time, location, status) 
          VALUES (1, 'General Attendance', 'Daily Campus Entry', '${today}', '07:00', '17:00', 'Main Gate', 'Active')`);
});

// Authentication Middleware
const requireAuth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Unauthorized. Please log in.' });
};

// Helper: Log Actions
function logAction(user, action) {
  db.run(`INSERT INTO audit_logs (user, action) VALUES (?, ?)`, [user, action]);
}

// ================= API ENDPOINTS =================

// Auth Endpoints
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) return res.status(400).json({ success: false, message: 'Invalid credentials' });
    if (bcrypt.compareSync(password, user.password)) {
      req.session.user = { id: user.id, username: user.username, role: user.role };
      logAction(user.username, 'User logged in');
      return res.json({ success: true, role: user.role });
    }
    res.status(400).json({ success: false, message: 'Invalid credentials' });
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) logAction(req.session.user.username, 'User logged out');
  req.session.destroy();
  res.json({ success: true });
});

// Student Management
app.get('/api/students', requireAuth, (req, res) => {
  db.all(`SELECT * FROM students ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/students', requireAuth, async (req, res) => {
  const s = req.body;
  const fullName = `${s.first_name} ${s.middle_name ? s.middle_name + ' ' : ''}${s.last_name}`;
  const qrToken = 'QR_' + crypto.randomBytes(8).toString('hex').toUpperCase();

  const query = `INSERT INTO students 
    (student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, school_year, status, qr_token, photo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [s.student_id, s.first_name, s.middle_name, s.last_name, fullName, s.grade_level, s.section, s.gender, s.dob, s.contact, s.email, s.address, s.guardian_name, s.guardian_contact, s.school_year || '2026-2027', 'Active', qrToken, s.photo || ''];

  db.run(query, params, function(err) {
    if (err) return res.status(400).json({ success: false, message: err.message });
    logAction(req.session.user.username, `Registered student: ${s.student_id} (${fullName})`);
    res.json({ success: true, id: this.lastID, qr_token: qrToken });
  });
});

app.post('/api/students/regenerate-qr', requireAuth, (req, res) => {
  const { student_id } = req.body;
  const newToken = 'QR_' + crypto.randomBytes(8).toString('hex').toUpperCase();
  db.run(`UPDATE students SET qr_token = ?, qr_status = 'Active' WHERE student_id = ?`, [newToken, student_id], function(err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    logAction(req.session.user.username, `Regenerated QR code for: ${student_id}`);
    res.json({ success: true, qr_token: newToken });
  });
});

app.post('/api/students/toggle-qr', requireAuth, (req, res) => {
  const { student_id, qr_status } = req.body;
  db.run(`UPDATE students SET qr_status = ? WHERE student_id = ?`, [qr_status, student_id], function(err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    logAction(req.session.user.username, `Updated QR status to ${qr_status} for: ${student_id}`);
    res.json({ success: true });
  });
});

// Event Management
app.get('/api/events', (req, res) => {
  db.all(`SELECT * FROM events ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/events', requireAuth, (req, res) => {
  const e = req.body;
  db.run(`INSERT INTO events (name, description, date, start_time, end_time, location, status, allowed_grade) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.name, e.description, e.date, e.start_time, e.end_time, e.location, e.status || 'Active', e.allowed_grade || 'All'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      logAction(req.session.user.username, `Created Event: ${e.name}`);
      res.json({ success: true, id: this.lastID });
    });
});

// Public Scanner Validation and Recording API
app.post('/api/scan', (req, res) => {
  const { qr_token, event_id, scan_type } = req.body; // scan_type: 'IN' or 'OUT'
  const today = new Date().toISOString().split('T')[0];
  const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });

  db.get(`SELECT * FROM students WHERE qr_token = ?`, [qr_token], (err, student) => {
    if (err || !student) {
      return res.status(404).json({ success: false, message: 'Invalid QR Code.' });
    }
    if (student.qr_status !== 'Active' || student.status !== 'Active') {
      return res.status(403).json({ success: false, message: 'QR Code or Student Account is Disabled.' });
    }

    // Check Event Restrictions
    db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
      if (err || !event) return res.status(404).json({ success: false, message: 'Selected Event Not Found.' });

      if (event.allowed_grade !== 'All' && event.allowed_grade !== student.grade_level) {
        return res.status(403).json({ success: false, message: `Access restricted. Event allowed for ${event.allowed_grade} only.` });
      }

      // Check existing scan for today and event
      db.get(`SELECT * FROM attendance WHERE student_id = ? AND event_id = ? AND date = ?`, [student.student_id, event_id, today], (err, record) => {
        if (scan_type === 'IN') {
          if (record && record.time_in) {
            return res.json({ success: false, duplicate: true, message: `${student.full_name}, you are already recorded for Time In.`, student });
          }

          // Fetch Late Threshold
          db.get(`SELECT value FROM settings WHERE key = 'late_threshold'`, [], (err, setting) => {
            const threshold = setting ? setting.value : '07:30';
            const status = currentTime > threshold ? 'Late' : 'Present';

            if (record) {
              db.run(`UPDATE attendance SET time_in = ?, status = ? WHERE id = ?`, [currentTime, status, record.id]);
            } else {
              db.run(`INSERT INTO attendance (student_id, event_id, date, time_in, status, scan_type) VALUES (?, ?, ?, ?, ?, 'IN')`,
                [student.student_id, event_id, today, currentTime, status]);
            }
            return res.json({ success: true, message: `${student.full_name}, attendance recorded.`, student, status, time: currentTime, scan_type: 'IN' });
          });
        } else {
          // TIME OUT
          if (!record) {
            return res.status(400).json({ success: false, message: `No Time In record found for ${student.full_name} today.` });
          }
          if (record.time_out) {
            return res.json({ success: false, duplicate: true, message: `${student.full_name}, time out already recorded.`, student });
          }

          db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [currentTime, record.id], function(err) {
            return res.json({ success: true, message: `${student.full_name}, time out recorded.`, student, status: record.status, time: currentTime, scan_type: 'OUT' });
          });
        }
      });
    });
  });
});

// Analytics & Reports
app.get('/api/reports/dashboard', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const query = `
    SELECT 
      (SELECT COUNT(*) FROM students WHERE status='Active') as total_students,
      (SELECT COUNT(*) FROM attendance WHERE date='${today}' AND time_in IS NOT NULL) as present_today,
      (SELECT COUNT(*) FROM attendance WHERE date='${today}' AND status='Late') as late_today,
      (SELECT COUNT(*) FROM events WHERE status='Active') as active_events
  `;
  db.get(query, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

app.get('/api/attendance/logs', requireAuth, (req, res) => {
  const query = `
    SELECT a.*, s.full_name, s.grade_level, s.section, e.name as event_name 
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.id DESC LIMIT 100
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// System Settings
app.get('/api/settings', (req, res) => {
  db.all(`SELECT * FROM settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const settings = req.body;
  const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  Object.keys(settings).forEach(key => stmt.run(key, settings[key]));
  stmt.finalize();
  logAction(req.session.user.username, 'Updated System Settings');
  res.json({ success: true });
});

// Audit Logs
app.get('/api/audit', requireAuth, (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50`, [], (err, rows) => {
    res.json(rows);
  });
});

// ================= UI ROUTING AND HTML CLIENT GENERATION =================

const getHTMLHeader = (title) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <style>
    body { background-color: #f4f6f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .sidebar { min-height: 100vh; background: #1e293b; color: white; }
    .sidebar a { color: #94a3b8; text-decoration: none; padding: 12px 20px; display: block; border-radius: 6px; margin: 4px 10px; }
    .sidebar a:hover, .sidebar a.active { background: #0ea5e9; color: white; }
    .card-stat { border: none; border-radius: 10px; transition: transform 0.2s; }
    .card-stat:hover { transform: translateY(-3px); }
    /* A4 ID Card Printing Layout Requirements */
    @media print {
      body * { visibility: hidden; }
      .print-area, .print-area * { visibility: visible; }
      .print-area { position: absolute; left: 0; top: 0; width: 100%; }
      .a4-page { width: 210mm; height: 297mm; padding: 10mm; margin: 0 auto; page-break-after: always; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8mm; }
      .id-card { width: 85.6mm; height: 53.9mm; border: 1px dashed #666; border-radius: 6px; padding: 8px; box-sizing: border-box; background: white; display: flex; flex-direction: row; position: relative; }
      .no-print { display: none !important; }
    }
    .id-card-view { width: 85.6mm; height: 53.9mm; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; background: white; display: flex; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .id-card-header { font-size: 10px; font-weight: bold; color: #0f172a; border-bottom: 2px solid #0ea5e9; padding-bottom: 2px; margin-bottom: 4px; }
    .id-photo { width: 55px; height: 55px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; }
  </style>
</head>
<body>
`;

// Render Admin Dashboard
app.get('/admin', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  
  res.send(`
    ${getHTMLHeader('Admin Dashboard - Attendance System')}
    <div class="d-flex">
      <div class="sidebar p-3 style="width: 260px;">
        <h4 class="text-center text-info mb-4"><i class="bi bi-qr-code-scan"></i> EduScan Pro</h4>
        <small class="text-muted text-uppercase fw-bold px-3">Navigation</small>
        <a href="#" class="active" onclick="showTab('dashboard')"><i class="bi bi-speedometer2 me-2"></i> Dashboard</a>
        <a href="#" onclick="showTab('students')"><i class="bi bi-people me-2"></i> Students</a>
        <a href="#" onclick="showTab('events')"><i class="bi bi-calendar-event me-2"></i> Events</a>
        <a href="#" onclick="showTab('attendance')"><i class="bi bi-clipboard-check me-2"></i> Attendance Logs</a>
        <a href="#" onclick="showTab('id-print')"><i class="bi bi-printer me-2"></i> Print Student IDs</a>
        <a href="#" onclick="showTab('settings')"><i class="bi bi-gear me-2"></i> Settings & Logs</a>
        <a href="/scanner" target="_blank" class="text-warning mt-3"><i class="bi bi-box-arrow-up-right me-2"></i> Open Scanner Portal</a>
        <a href="#" onclick="logout()" class="text-danger mt-4"><i class="bi bi-box-arrow-right me-2"></i> Logout</a>
      </div>

      <div class="flex-grow-1 p-4" style="overflow-y: auto; height: 100vh;">
        <div id="tab-dashboard" class="tab-content">
          <h3 class="mb-4">System Overview</h3>
          <div class="row g-3 mb-4">
            <div class="col-md-3">
              <div class="card card-stat bg-primary text-white p-3">
                <h5>Total Active Students</h5>
                <h2 id="stat-students">0</h2>
              </div>
            </div>
            <div class="col-md-3">
              <div class="card card-stat bg-success text-white p-3">
                <h5>Present Today</h5>
                <h2 id="stat-present">0</h2>
              </div>
            </div>
            <div class="col-md-3">
              <div class="card card-stat bg-warning text-dark p-3">
                <h5>Late Arrived Today</h5>
                <h2 id="stat-late">0</h2>
              </div>
            </div>
            <div class="col-md-3">
              <div class="card card-stat bg-info text-white p-3">
                <h5>Active Events</h5>
                <h2 id="stat-events">0</h2>
              </div>
            </div>
          </div>

          <div class="row g-3">
            <div class="col-md-8">
              <div class="card p-3 shadow-sm">
                <h5>Weekly Attendance Trends</h5>
                <canvas id="chartAttendance" height="120"></canvas>
              </div>
            </div>
            <div class="col-md-4">
              <div class="card p-3 shadow-sm">
                <h5>Live Attendance Stream</h5>
                <div id="liveStream" style="max-height: 300px; overflow-y: auto;">
                  <small class="text-muted">Listening for live scans...</small>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="tab-students" class="tab-content d-none">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h3>Student Directory</h3>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#studentModal"><i class="bi bi-plus-lg"></i> Register Student</button>
          </div>
          <div class="card p-3 shadow-sm">
            <div class="row g-2 mb-3">
              <div class="col-md-4">
                <input type="text" id="searchStudent" class="form-control" placeholder="Search by name or ID..." onkeyup="filterStudents()">
              </div>
              <div class="col-md-3">
                <select id="filterGrade" class="form-select" onchange="filterStudents()">
                  <option value="">All Grade Levels</option>
                  <option value="Grade 7">Grade 7</option>
                  <option value="Grade 8">Grade 8</option>
                  <option value="Grade 9">Grade 9</option>
                  <option value="Grade 10">Grade 10</option>
                  <option value="Grade 11">Grade 11</option>
                  <option value="Grade 12">Grade 12</option>
                </select>
              </div>
            </div>
            <table class="table table-hover align-middle">
              <thead class="table-light">
                <tr>
                  <th>ID</th>
                  <th>Full Name</th>
                  <th>Grade & Section</th>
                  <th>QR Token</th>
                  <th>QR Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="studentTableBody"></tbody>
            </table>
          </div>
        </div>

        <div id="tab-id-print" class="tab-content d-none">
          <div class="d-flex justify-content-between align-items-center mb-3 no-print">
            <h3>A4 ID Card Generation (8 IDs per Page)</h3>
            <button class="btn btn-success" onclick="window.print()"><i class="bi bi-printer"></i> Print Batch Layout</button>
          </div>
          <div id="printContainer" class="print-area">
            </div>
        </div>

        <div id="tab-events" class="tab-content d-none">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h3>Event Management</h3>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#eventModal"><i class="bi bi-plus-lg"></i> Create Event</button>
          </div>
          <div class="card p-3 shadow-sm">
            <table class="table table-striped align-middle">
              <thead>
                <tr>
                  <th>Event Name</th>
                  <th>Date</th>
                  <th>Time Window</th>
                  <th>Target Grade</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="eventTableBody"></tbody>
            </table>
          </div>
        </div>

        <div id="tab-attendance" class="tab-content d-none">
          <h3>Attendance Records</h3>
          <div class="card p-3 shadow-sm">
            <table class="table table-bordered align-middle">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Student ID</th>
                  <th>Name</th>
                  <th>Event</th>
                  <th>Time In</th>
                  <th>Time Out</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="attendanceTableBody"></tbody>
            </table>
          </div>
        </div>

        <div id="tab-settings" class="tab-content d-none">
          <h3>System Settings & Security Audit</h3>
          <div class="row">
            <div class="col-md-6">
              <div class="card p-3 shadow-sm mb-4">
                <h5>Configuration</h5>
                <form id="settingsForm" onsubmit="saveSettings(event)">
                  <div class="mb-3">
                    <label class="form-label">School Name</label>
                    <input type="text" id="setSchoolName" class="form-control">
                  </div>
                  <div class="mb-3">
                    <label class="form-label">Late Entry Threshold (HH:MM)</label>
                    <input type="time" id="setLateThreshold" class="form-control">
                  </div>
                  <button type="submit" class="btn btn-primary">Save Settings</button>
                </form>
              </div>
            </div>
            <div class="col-md-6">
              <div class="card p-3 shadow-sm">
                <h5>Audit Trail</h5>
                <ul id="auditLogs" class="list-group list-group-flush small" style="max-height: 300px; overflow-y: auto;"></ul>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <div class="modal fade" id="studentModal" tabindex="-1">
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Register New Student</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <form id="studentForm" onsubmit="saveStudent(event)">
              <div class="row g-3">
                <div class="col-md-4">
                  <label class="form-label">Student ID</label>
                  <input type="text" id="regId" class="form-control" required placeholder="2026-0001">
                </div>
                <div class="col-md-4">
                  <label class="form-label">First Name</label>
                  <input type="text" id="regFn" class="form-control" required>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Last Name</label>
                  <input type="text" id="regLn" class="form-control" required>
                </div>
                <div class="col-md-6">
                  <label class="form-label">Grade Level</label>
                  <select id="regGrade" class="form-select" required>
                    <option value="Grade 7">Grade 7</option>
                    <option value="Grade 8">Grade 8</option>
                    <option value="Grade 9">Grade 9</option>
                    <option value="Grade 10">Grade 10</option>
                    <option value="Grade 11">Grade 11</option>
                    <option value="Grade 12">Grade 12</option>
                  </select>
                </div>
                <div class="col-md-6">
                  <label class="form-label">Section</label>
                  <input type="text" id="regSection" class="form-control" required placeholder="STEM-A">
                </div>
              </div>
              <div class="mt-3 text-end">
                <button type="submit" class="btn btn-success">Save & Generate QR</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>

    <div class="modal fade" id="eventModal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Create School Event</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <form id="eventForm" onsubmit="saveEvent(event)">
              <div class="mb-3">
                <label class="form-label">Event Title</label>
                <input type="text" id="evtName" class="form-control" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Date</label>
                <input type="date" id="evtDate" class="form-control" required>
              </div>
              <div class="row g-2 mb-3">
                <div class="col-md-6">
                  <label class="form-label">Start Time</label>
                  <input type="time" id="evtStart" class="form-control" required>
                </div>
                <div class="col-md-6">
                  <label class="form-label">End Time</label>
                  <input type="time" id="evtEnd" class="form-control" required>
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label">Target Audience</label>
                <select id="evtGrade" class="form-select">
                  <option value="All">All Grade Levels</option>
                  <option value="Grade 11">Grade 11 Only</option>
                  <option value="Grade 12">Grade 12 Only</option>
                </select>
              </div>
              <button type="submit" class="btn btn-primary w-100">Create Event</button>
            </form>
          </div>
        </div>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
      let studentsData = [];

      document.addEventListener('DOMContentLoaded', () => {
        loadDashboardStats();
        loadStudents();
        loadEvents();
        loadAttendance();
        loadSettings();
        initChart();
        setInterval(loadAttendance, 5000); // Polling live stream
      });

      function showTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.add('d-none'));
        document.querySelectorAll('.sidebar a').forEach(el => el.classList.remove('active'));
        document.getElementById('tab-' + tabId).classList.remove('d-none');
      }

      async function loadDashboardStats() {
        const res = await fetch('/api/reports/dashboard');
        const data = await res.json();
        document.getElementById('stat-students').innerText = data.total_students || 0;
        document.getElementById('stat-present').innerText = data.present_today || 0;
        document.getElementById('stat-late').innerText = data.late_today || 0;
        document.getElementById('stat-events').innerText = data.active_events || 0;
      }

      async function loadStudents() {
        const res = await fetch('/api/students');
        studentsData = await res.json();
        renderStudents(studentsData);
        renderA4IDCards(studentsData);
      }

      function renderStudents(data) {
        const tbody = document.getElementById('studentTableBody');
        tbody.innerHTML = data.map(s => \`
          <tr>
            <td>\${s.student_id}</td>
            <td>\${s.full_name}</td>
            <td>\${s.grade_level} - \${s.section}</td>
            <td><span class="badge bg-secondary">\${s.qr_token}</span></td>
            <td><span class="badge \${s.qr_status === 'Active' ? 'bg-success' : 'bg-danger'}">\${s.qr_status}</span></td>
            <td>
              <button class="btn btn-sm btn-outline-warning" onclick="regenerateQR('\${s.student_id}')">Revoke & Regenerate</button>
            </td>
          </tr>
        \`).join('');
      }

      function renderA4IDCards(data) {
        const container = document.getElementById('printContainer');
        container.innerHTML = '';
        const pageSize = 8;
        
        for (let i = 0; i < data.length; i += pageSize) {
          const pageStudents = data.slice(i, i + pageSize);
          const pageDiv = document.createElement('div');
          pageDiv.className = 'a4-page';
          
          pageStudents.forEach(s => {
            const qrCanvasId = 'qr-' + s.student_id.replace(/[^a-zA-Z0-9]/g, '');
            pageDiv.innerHTML += \`
              <div class="id-card">
                <div style="flex: 1;">
                  <div class="id-card-header">GLOBAL ACADEMY</div>
                  <div style="font-size: 11px; font-weight: bold;">\${s.full_name}</div>
                  <div style="font-size: 9px; color: #555;">ID: \${s.student_id}</div>
                  <div style="font-size: 9px; color: #555;">\${s.grade_level} - \${s.section}</div>
                </div>
                <div style="text-align: center;">
                  <canvas id="\${qrCanvasId}" style="width: 45px; height: 45px;"></canvas>
                </div>
              </div>
            \`;
          });
          container.appendChild(pageDiv);

          // Render QRs after DOM update
          setTimeout(() => {
            pageStudents.forEach(s => {
              const qrCanvasId = 'qr-' + s.student_id.replace(/[^a-zA-Z0-9]/g, '');
              const canvas = document.getElementById(qrCanvasId);
              if (canvas) QRCode.toCanvas(canvas, s.qr_token, { width: 45, margin: 1 });
            });
          }, 100);
        }
      }

      function filterStudents() {
        const q = document.getElementById('searchStudent').value.toLowerCase();
        const g = document.getElementById('filterGrade').value;
        const filtered = studentsData.filter(s => 
          (s.full_name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q)) &&
          (g === '' || s.grade_level === g)
        );
        renderStudents(filtered);
      }

      async function saveStudent(e) {
        e.preventDefault();
        const payload = {
          student_id: document.getElementById('regId').value,
          first_name: document.getElementById('regFn').value,
          last_name: document.getElementById('regLn').value,
          grade_level: document.getElementById('regGrade').value,
          section: document.getElementById('regSection').value
        };
        await fetch('/api/students', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
        });
        bootstrap.Modal.getInstance(document.getElementById('studentModal')).hide();
        loadStudents();
      }

      async function regenerateQR(studentId) {
        if (!confirm('This will invalidate the existing QR code immediately. Continue?')) return;
        await fetch('/api/students/regenerate-qr', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ student_id: studentId })
        });
        loadStudents();
      }

      async function loadEvents() {
        const res = await fetch('/api/events');
        const events = await res.json();
        document.getElementById('eventTableBody').innerHTML = events.map(e => \`
          <tr>
            <td><strong>\${e.name}</strong></td>
            <td>\${e.date}</td>
            <td>\${e.start_time} - \${e.end_time}</td>
            <td>\${e.allowed_grade}</td>
            <td><span class="badge bg-primary">\${e.status}</span></td>
          </tr>
        \`).join('');
      }

      async function saveEvent(e) {
        e.preventDefault();
        const payload = {
          name: document.getElementById('evtName').value,
          date: document.getElementById('evtDate').value,
          start_time: document.getElementById('evtStart').value,
          end_time: document.getElementById('evtEnd').value,
          allowed_grade: document.getElementById('evtGrade').value
        };
        await fetch('/api/events', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload)
        });
        bootstrap.Modal.getInstance(document.getElementById('eventModal')).hide();
        loadEvents();
      }

      async function loadAttendance() {
        const res = await fetch('/api/attendance/logs');
        const logs = await res.json();
        
        // Render Live Stream Widget
        document.getElementById('liveStream').innerHTML = logs.slice(0, 5).map(l => \`
          <div class="p-2 border-bottom">
            <div class="fw-bold">\${l.full_name}</div>
            <small class="text-muted">\${l.time_in} | <span class="badge \${l.status==='Late'?'bg-warning':'bg-success'}">\${l.status}</span></small>
          </div>
        \`).join('');

        // Render Logs Table
        document.getElementById('attendanceTableBody').innerHTML = logs.map(l => \`
          <tr>
            <td>\${l.date}</td>
            <td>\${l.student_id}</td>
            <td>\${l.full_name}</td>
            <td>\${l.event_name}</td>
            <td>\${l.time_in || '--'}</td>
            <td>\${l.time_out || '--'}</td>
            <td><span class="badge \${l.status==='Late'?'bg-warning':'bg-success'}">\${l.status}</span></td>
          </tr>
        \`).join('');
      }

      async function loadSettings() {
        const resSettings = await fetch('/api/settings');
        const settings = await resSettings.json();
        document.getElementById('setSchoolName').value = settings.school_name || '';
        document.getElementById('setLateThreshold').value = settings.late_threshold || '07:30';

        const resAudit = await fetch('/api/audit');
        const logs = await resAudit.json();
        document.getElementById('auditLogs').innerHTML = logs.map(a => \`
          <li class="list-group-item d-flex justify-content-between align-items-center">
            <span><strong>\${a.user}:</strong> \${a.action}</span>
            <small class="text-muted">\${a.timestamp}</small>
          </li>
        \`).join('');
      }

      async function saveSettings(e) {
        e.preventDefault();
        await fetch('/api/settings', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            school_name: document.getElementById('setSchoolName').value,
            late_threshold: document.getElementById('setLateThreshold').value
          })
        });
        alert('Settings updated successfully!');
      }

      function initChart() {
        const ctx = document.getElementById('chartAttendance').getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
            datasets: [{
              label: 'Attendance Count',
              data: [420, 450, 440, 460, 430],
              borderColor: '#0ea5e9',
              tension: 0.3
            }]
          }
        });
      }

      async function logout() {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login';
      }
    </script>
</body>
</html>
  `);
});

// Render Scanner Portal UI
app.get('/scanner', (req, res) => {
  res.send(`
    ${getHTMLHeader('Mobile QR Scanner Portal')}
    <div class="container py-4" style="max-width: 600px;">
      <div class="card shadow-lg border-0 rounded-4 overflow-hidden">
        <div class="card-header bg-dark text-white p-3 text-center">
          <h4 class="mb-0"><i class="bi bi-camera-fill me-2"></i> Attendance Scanner</h4>
          <span class="badge bg-success mt-1" id="cameraStatus">Camera Inactive</span>
        </div>
        <div class="card-body p-4 text-center">
          <div class="mb-3 text-start">
            <label class="form-label fw-bold">Active Event</label>
            <select id="eventSelect" class="form-select form-select-lg"></select>
          </div>

          <div class="btn-group w-100 mb-3" role="group">
            <input type="radio" class="btn-check" name="scanType" id="typeIn" value="IN" checked>
            <label class="btn btn-outline-success btn-lg" for="typeIn"><i class="bi bi-box-arrow-in-right"></i> TIME IN</label>

            <input type="radio" class="btn-check" name="scanType" id="typeOut" value="OUT">
            <label class="btn btn-outline-danger btn-lg" for="typeOut"><i class="bi bi-box-arrow-right"></i> TIME OUT</label>
          </div>

          <div id="reader" style="width: 100%; border-radius: 12px; overflow: hidden; background: #000; min-height: 250px;"></div>

          <div class="d-grid gap-2 mt-3">
            <button id="btnStart" class="btn btn-primary btn-lg" onclick="startScanner()"><i class="bi bi-play-circle"></i> Start Camera</button>
            <button id="btnStop" class="btn btn-secondary btn-lg d-none" onclick="stopScanner()"><i class="bi bi-stop-circle"></i> Stop Camera</button>
          </div>

          <div id="scanResultCard" class="card mt-4 d-none border-3">
            <div class="card-body">
              <h3 id="resTitle" class="fw-bold"></h3>
              <h2 id="resName" class="text-primary my-2"></h2>
              <p id="resDetails" class="mb-1 text-muted"></p>
              <span id="resBadge" class="badge p-2 fs-6"></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      let html5QrcodeScanner = null;
      let isProcessing = false;

      document.addEventListener('DOMContentLoaded', loadEvents);

      async function loadEvents() {
        const res = await fetch('/api/events');
        const events = await res.json();
        const select = document.getElementById('eventSelect');
        select.innerHTML = events.map(e => \`<option value="\${e.id}">\${e.name} (\${e.date})</option>\`).join('');
      }

      function speak(text) {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel(); // Stop prior audio
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 0.9;
          window.speechSynthesis.speak(utterance);
        }
      }

      function startScanner() {
        html5QrcodeScanner = new Html5Qrcode("reader");
        html5QrcodeScanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          onScanSuccess
        ).then(() => {
          document.getElementById('cameraStatus').innerText = "Scanner Active";
          document.getElementById('btnStart').classList.add('d-none');
          document.getElementById('btnStop').classList.remove('d-none');
        }).catch(err => {
          alert("Camera activation error: " + err);
        });
      }

      function stopScanner() {
        if (html5QrcodeScanner) {
          html5QrcodeScanner.stop().then(() => {
            document.getElementById('cameraStatus').innerText = "Scanner Inactive";
            document.getElementById('btnStart').classList.remove('d-none');
            document.getElementById('btnStop').classList.add('d-none');
          });
        }
      }

      async function onScanSuccess(decodedText) {
        if (isProcessing) return;
        isProcessing = true;

        const eventId = document.getElementById('eventSelect').value;
        const scanType = document.querySelector('input[name="scanType"]:checked').value;

        try {
          const response = await fetch('/api/scan', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: scanType })
          });

          const res = await response.json();
          displayResult(res);
        } catch (err) {
          speak("Error processing scan");
        }

        // Delay before processing next scan
        setTimeout(() => { isProcessing = false; }, 3000);
      }

      function displayResult(res) {
        const card = document.getElementById('scanResultCard');
        const resTitle = document.getElementById('resTitle');
        const resName = document.getElementById('resName');
        const resDetails = document.getElementById('resDetails');
        const resBadge = document.getElementById('resBadge');

        card.classList.remove('d-none', 'border-success', 'border-danger', 'border-warning');

        if (res.success) {
          card.classList.add('border-success');
          resTitle.innerText = "✓ ATTENDANCE RECORDED";
          resTitle.className = "fw-bold text-success";
          resName.innerText = res.student.full_name;
          resDetails.innerText = \`ID: \${res.student.student_id} | Grade: \${res.student.grade_level}\`;
          resBadge.className = "badge bg-success p-2 fs-6";
          resBadge.innerText = \`STATUS: \${res.status} (\${res.time})\`;

          speak(\`\${res.student.full_name}, \${res.scan_type === 'IN' ? 'time in' : 'time out'} recorded.\`);
        } else if (res.duplicate) {
          card.classList.add('border-warning');
          resTitle.innerText = "⚠ DUPLICATE SCAN";
          resTitle.className = "fw-bold text-warning";
          resName.innerText = res.student.full_name;
          resDetails.innerText = res.message;
          resBadge.className = "badge bg-warning text-dark p-2 fs-6";
          resBadge.innerText = "ALREADY RECORDED";

          speak(\`\${res.student.full_name}, you are already recorded.\`);
        } else {
          card.classList.add('border-danger');
          resTitle.innerText = "✗ INVALID SCAN";
          resTitle.className = "fw-bold text-danger";
          resName.innerText = "Access Denied";
          resDetails.innerText = res.message;
          resBadge.className = "badge bg-danger p-2 fs-6";
          resBadge.innerText = "ERROR";

          speak(res.message || "Invalid QR Code");
        }
      }
    </script>
</body>
</html>
  `);
});

// Admin Login Portal Page
app.get('/login', (req, res) => {
  res.send(`
    ${getHTMLHeader('Admin Login')}
    <div class="container d-flex justify-content-center align-items-center" style="min-height: 100vh;">
      <div class="card p-4 shadow-lg" style="width: 100%; max-width: 400px; border-radius: 12px;">
        <h3 class="text-center mb-4 text-primary fw-bold">Admin Portal</h3>
        <form onsubmit="handleLogin(event)">
          <div class="mb-3">
            <label class="form-label">Username</label>
            <input type="text" id="username" class="form-control" required value="admin">
          </div>
          <div class="mb-3">
            <label class="form-label">Password</label>
            <input type="password" id="password" class="form-control" required value="admin123">
          </div>
          <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Sign In</button>
        </form>
      </div>
    </div>
    <script>
      async function handleLogin(e) {
        e.preventDefault();
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        const data = await res.json();
        if (data.success) window.location.href = '/admin';
        else alert(data.message);
      }
    </script>
</body>
</html>
  `);
});

// Default Redirect
app.get('/', (req, res) => res.redirect('/admin'));

// Start Express Server
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`Server executing at: http://localhost:${PORT}`);
  console.log(`Admin Portal:        http://localhost:${PORT}/admin`);
  console.log(`Scanner Portal:      http://localhost:${PORT}/scanner`);
  console.log(`===================================================`);
});
