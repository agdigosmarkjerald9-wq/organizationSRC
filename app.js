/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Single-File Production Implementation (app.js)
 * 
 * Includes: Express Backend, SQLite Database, Express Session Auth, REST APIs,
 * Base64 QR Code Generator, A4 ID Printing Layouts, Web Speech Audio Feedback,
 * Admin Dashboard, Mobile Scanner Portal, and Student Member Portal.
 */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directories exist
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage for student photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `student_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({ storage });

// Database Initialization
const dbPath = path.join(__dirname, 'club_attendance.db');
const db = new sqlite3.Database(dbPath);

// Middleware Configuration
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

app.use(session({
  secret: 'school-club-qr-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 Hours
}));

// ==========================================
// DATABASE SCHEMA & SEED DATA INITIALIZATION
// ==========================================
db.serialize(() => {
  // System Settings
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Users (Adviser & Scanners)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'SCANNER', -- 'ADMIN' or 'SCANNER'
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Positions
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    is_officer INTEGER DEFAULT 1
  )`);

  // Committees
  db.run(`CREATE TABLE IF NOT EXISTS committees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT
  )`);

  // Student Members
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    position TEXT NOT NULL,
    club TEXT NOT NULL,
    committee TEXT NOT NULL,
    gender TEXT,
    dob TEXT,
    contact TEXT,
    email TEXT UNIQUE,
    address TEXT,
    photo TEXT,
    school_year TEXT NOT NULL,
    date_joined TEXT NOT NULL,
    membership_status TEXT DEFAULT 'Active', -- Active, Inactive, Suspended, Alumni, Resigned
    expiration_date TEXT,
    parent_name TEXT,
    parent_contact TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // QR Tokens
  db.run(`CREATE TABLE IF NOT EXISTS qr_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'ACTIVE', -- ACTIVE, DISABLED
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE
  )`);

  // Events
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    late_threshold_mins INTEGER DEFAULT 15,
    location TEXT NOT NULL,
    organizer TEXT NOT NULL,
    target_audience TEXT DEFAULT 'ALL', -- ALL, OFFICERS, POSITIONS, COMMITTEES, SELECTED
    target_details TEXT, -- JSON array of targeted criteria
    status TEXT DEFAULT 'Upcoming', -- Upcoming, Active, Completed, Cancelled
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Event Manual Participant Overrides
  db.run(`CREATE TABLE IF NOT EXISTS event_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  )`);

  // Attendance Records
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    time_in DATETIME,
    time_out DATETIME,
    status TEXT NOT NULL, -- PRESENT, LATE, ABSENT, EXCUSED
    recorded_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE
  )`);

  // Excused Absences
  db.run(`CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT NOT NULL,
    date_approved TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE
  )`);

  // Audit Logs
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed Default System Settings
  const defaultSettings = [
    ['school_name', 'ABC National High School'],
    ['organization_name', 'Supreme Student Organization'],
    ['club_name', 'Computer Club'],
    ['school_year', '2026-2027'],
    ['club_adviser', 'Mr. John Doe'],
    ['school_address', '123 Education Way, Knowledge City'],
    ['contact_info', 'adviser@schoolclub.edu.ph | +63 912 345 6789'],
    ['club_description', 'Official Student Computer and Technology Organization'],
    ['late_threshold', '15'],
    ['min_participation_pct', '75'],
    ['voice_announcements', 'true'],
    ['sound_effects', 'true'],
    ['speech_rate', '1.0'],
    ['voice_volume', '1.0']
  ];

  defaultSettings.forEach(([k, v]) => {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  });

  // Seed Default Admin User
  db.get(`SELECT * FROM users WHERE username = 'admin'`, [], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync('admin123', 10);
      db.run(`INSERT INTO users (username, password, role, name) VALUES (?, ?, 'ADMIN', ?)`,
        ['admin', hash, 'Mr. John Doe (Club Adviser)']);
    }
  });

  // Seed Default Scanner User
  db.get(`SELECT * FROM users WHERE username = 'scanner'`, [], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync('scanner123', 10);
      db.run(`INSERT INTO users (username, password, role, name) VALUES (?, ?, 'SCANNER', ?)`,
        ['scanner', hash, 'Student Officer Scanner']);
    }
  });

  // Seed Default Positions
  const defaultPositions = [
    ['President', 1], ['Vice President', 1], ['Secretary', 1], ['Assistant Secretary', 1],
    ['Treasurer', 1], ['Assistant Treasurer', 1], ['Auditor', 1], ['Public Information Officer', 1],
    ['Peace Officer', 1], ['Sergeant-at-Arms', 1], ['Representative', 1], ['Committee Head', 1],
    ['Committee Member', 0], ['Member', 0]
  ];
  defaultPositions.forEach(([pos, isOff]) => {
    db.run(`INSERT OR IGNORE INTO positions (name, is_officer) VALUES (?, ?)`, [pos, isOff]);
  });

  // Seed Default Committees
  const defaultCommittees = [
    'Events Committee', 'Finance Committee', 'Documentation Committee',
    'Membership Committee', 'Public Relations Committee', 'Technical Committee', 'Sports Committee'
  ];
  defaultCommittees.forEach(comm => {
    db.run(`INSERT OR IGNORE INTO committees (name, description) VALUES (?, ?)`, [comm, `${comm} Operations`]);
  });

  // Seed Initial Sample Data if No Students Exist
  db.get(`SELECT COUNT(*) as count FROM students`, [], (err, row) => {
    if (row && row.count === 0) {
      const sampleStudents = [
        ['2026-001', 'Juan', 'Dela', 'Cruz', 'Juan Dela Cruz', 'President', 'Computer Club', 'Technical Committee', 'Male', '2008-05-15', '09171112222', 'juan.cruz@school.edu', 'Manila', '2026-2027', '2026-06-01', 'Active', '2027-05-31', 'Maria Cruz', '09170001111'],
        ['2026-002', 'Maria', 'Santos', 'Clara', 'Maria Santos Clara', 'Vice President', 'Computer Club', 'Events Committee', 'Female', '2008-08-20', '09172223333', 'maria.clara@school.edu', 'Manila', '2026-2027', '2026-06-01', 'Active', '2027-05-31', 'Jose Clara', '09170002222'],
        ['2026-003', 'Pedro', 'Reyes', 'Penduko', 'Pedro Reyes Penduko', 'Secretary', 'Computer Club', 'Documentation Committee', 'Male', '2008-12-10', '09173334444', 'pedro.penduko@school.edu', 'Manila', '2026-2027', '2026-06-01', 'Active', '2027-05-31', 'Ana Penduko', '09170003333'],
        ['2026-004', 'Ana', 'Bautista', 'Rizal', 'Ana Bautista Rizal', 'Treasurer', 'Computer Club', 'Finance Committee', 'Female', '2009-02-14', '09174445555', 'ana.rizal@school.edu', 'Manila', '2026-2027', '2026-06-01', 'Active', '2027-05-31', 'Francisco Rizal', '09170004444'],
        ['2026-005', 'Jose', 'Protacio', 'Mercado', 'Jose Protacio Mercado', 'Member', 'Computer Club', 'Technical Committee', 'Male', '2009-06-19', '09175556666', 'jose.mercado@school.edu', 'Manila', '2026-2027', '2026-06-01', 'Active', '2027-05-31', 'Teodora Mercado', '09170005555']
      ];

      sampleStudents.forEach(st => {
        db.run(`INSERT INTO students (
          student_id, first_name, middle_name, last_name, full_name, position, club, committee,
          gender, dob, contact, email, address, school_year, date_joined, membership_status,
          expiration_date, parent_name, parent_contact
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, st, function(err) {
          if (!err) {
            const token = 'QR-' + crypto.randomBytes(8).toString('hex').toUpperCase();
            db.run(`INSERT INTO qr_tokens (student_id, token) VALUES (?, ?)`, [st[0], token]);
          }
        });
      });

      // Sample Event
      db.run(`INSERT INTO events (name, description, type, date, start_time, end_time, late_threshold_mins, location, organizer, target_audience, status)
        VALUES ('General Orientation & Assembly', 'First general membership assembly for 2026-2027', 'General Assembly', '2026-09-01', '15:00', '17:00', 15, 'School Auditorium', 'Computer Club Officers', 'ALL', 'Active')`);
    }
  });
});

// Helper Function for Audit Logging
function logAudit(user, action, details) {
  db.run(`INSERT INTO audit_logs (user, action, details) VALUES (?, ?, ?)`, [user || 'SYSTEM', action, details || '']);
}

// Security Middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'ADMIN') {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Admin session required.' });
}

function requireScannerOrAdmin(req, res, next) {
  if (req.session && req.session.user && (req.session.user.role === 'ADMIN' || req.session.user.role === 'SCANNER')) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized access.' });
}

// ==========================================
// API ENDPOINTS & BACKEND ROUTING
// ==========================================

// Auth Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid username or password.' });
    
    if (bcrypt.compareSync(password, user.password)) {
      req.session.user = { id: user.id, username: user.username, role: user.role, name: user.name };
      logAudit(user.username, 'LOGIN', `Logged into system as ${user.role}`);
      return res.json({ success: true, user: req.session.user });
    }
    return res.status(401).json({ error: 'Invalid username or password.' });
  });
});

app.post('/api/student-login', (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: 'Student ID required.' });

  db.get(`SELECT * FROM students WHERE student_id = ?`, [student_id], (err, student) => {
    if (err || !student) return res.status(404).json({ error: 'Student ID not found.' });
    req.session.student = student;
    logAudit(student.full_name, 'STUDENT_PORTAL_LOGIN', `Student accessed portal: ${student.student_id}`);
    return res.json({ success: true, student });
  });
});

app.get('/api/logout', (req, res) => {
  if (req.session.user) logAudit(req.session.user.username, 'LOGOUT', 'Logged out');
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null, student: req.session.student || null });
});

app.post('/api/change-password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const username = req.session.user.username;

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (!bcrypt.compareSync(oldPassword, user.password)) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }
    const newHash = bcrypt.hashSync(newPassword, 10);
    db.run(`UPDATE users SET password = ? WHERE username = ?`, [newHash, username], (err) => {
      if (err) return res.status(500).json({ error: 'Database update failed.' });
      logAudit(username, 'PASSWORD_CHANGE', 'Admin password updated successfully');
      res.json({ success: true, message: 'Password updated successfully.' });
    });
  });
});

// Settings APIs
app.get('/api/settings', (req, res) => {
  db.all(`SELECT * FROM settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  });
});

app.post('/api/settings', requireAdmin, (req, res) => {
  const settings = req.body;
  const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  Object.keys(settings).forEach(key => {
    stmt.run(key, String(settings[key]));
  });
  stmt.finalize();
  logAudit(req.session.user.username, 'UPDATE_SETTINGS', 'System settings modified');
  res.json({ success: true });
});

// Student Member APIs
app.get('/api/students', (req, res) => {
  const query = `
    SELECT s.*, q.token as qr_token, q.status as qr_status 
    FROM students s 
    LEFT JOIN qr_tokens q ON s.student_id = q.student_id
    ORDER BY s.id DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/students/:id', (req, res) => {
  const query = `
    SELECT s.*, q.token as qr_token, q.status as qr_status 
    FROM students s 
    LEFT JOIN qr_tokens q ON s.student_id = q.student_id
    WHERE s.student_id = ? OR s.id = ?
  `;
  db.get(query, [req.params.id, req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Student not found.' });
    res.json(row);
  });
});

app.post('/api/students', requireAdmin, upload.single('photo'), (req, res) => {
  const data = req.body;
  
  // Validation for unique Student ID
  db.get(`SELECT id FROM students WHERE student_id = ?`, [data.student_id], (err, existing) => {
    if (existing) {
      return res.status(400).json({ error: `Student ID '${data.student_id}' already exists.` });
    }

    const photoPath = req.file ? `/uploads/${req.file.filename}` : (data.photo_url || '');
    const fullName = `${data.first_name} ${data.middle_name ? data.middle_name + ' ' : ''}${data.last_name}`;

    const sql = `INSERT INTO students (
      student_id, first_name, middle_name, last_name, full_name, position, club, committee,
      gender, dob, contact, email, address, photo, school_year, date_joined, membership_status,
      expiration_date, parent_name, parent_contact
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

    const params = [
      data.student_id, data.first_name, data.middle_name || '', data.last_name, fullName,
      data.position, data.club, data.committee, data.gender, data.dob, data.contact,
      data.email, data.address, photoPath, data.school_year, data.date_joined,
      data.membership_status || 'Active', data.expiration_date, data.parent_name, data.parent_contact
    ];

    db.run(sql, params, function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Automatically Generate Secure Token & QR
      const token = 'QR-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      db.run(`INSERT INTO qr_tokens (student_id, token) VALUES (?, ?)`, [data.student_id, token]);

      logAudit(req.session.user.username, 'ADD_STUDENT', `Registered member: ${fullName} (${data.student_id})`);
      res.json({ success: true, id: this.lastID, student_id: data.student_id });
    });
  });
});

app.put('/api/students/:id', requireAdmin, upload.single('photo'), (req, res) => {
  const data = req.body;
  const id = req.params.id;

  const photoClause = req.file ? `, photo = '/uploads/${req.file.filename}'` : '';
  const fullName = `${data.first_name} ${data.middle_name ? data.middle_name + ' ' : ''}${data.last_name}`;

  const sql = `UPDATE students SET
    first_name = ?, middle_name = ?, last_name = ?, full_name = ?, position = ?, club = ?,
    committee = ?, gender = ?, dob = ?, contact = ?, email = ?, address = ?,
    school_year = ?, date_joined = ?, membership_status = ?, expiration_date = ?,
    parent_name = ?, parent_contact = ? ${photoClause}
    WHERE id = ?`;

  const params = [
    data.first_name, data.middle_name || '', data.last_name, fullName, data.position, data.club,
    data.committee, data.gender, data.dob, data.contact, data.email, data.address,
    data.school_year, data.date_joined, data.membership_status, data.expiration_date,
    data.parent_name, data.parent_contact, id
  ];

  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'UPDATE_STUDENT', `Updated member profile ID: ${id}`);
    res.json({ success: true });
  });
});

app.delete('/api/students/:id', requireAdmin, (req, res) => {
  db.get(`SELECT student_id, full_name FROM students WHERE id = ?`, [req.params.id], (err, st) => {
    if (!st) return res.status(404).json({ error: 'Student not found.' });
    
    db.run(`DELETE FROM students WHERE id = ?`, [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run(`DELETE FROM qr_tokens WHERE student_id = ?`, [st.student_id]);
      logAudit(req.session.user.username, 'DELETE_STUDENT', `Deleted student: ${st.full_name} (${st.student_id})`);
      res.json({ success: true });
    });
  });
});

// QR Code Management Routes
app.post('/api/qr/regenerate', requireAdmin, (req, res) => {
  const { student_id } = req.body;
  const newToken = 'QR-' + crypto.randomBytes(8).toString('hex').toUpperCase();

  db.run(`INSERT OR REPLACE INTO qr_tokens (student_id, token, status, generated_at) VALUES (?, ?, 'ACTIVE', CURRENT_TIMESTAMP)`,
    [student_id, newToken], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      logAudit(req.session.user.username, 'REGENERATE_QR', `Regenerated QR token for Student ID: ${student_id}`);
      res.json({ success: true, token: newToken });
    });
});

app.post('/api/qr/toggle-status', requireAdmin, (req, res) => {
  const { student_id, status } = req.body; // 'ACTIVE' or 'DISABLED'
  db.run(`UPDATE qr_tokens SET status = ? WHERE student_id = ?`, [status, student_id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'TOGGLE_QR_STATUS', `Set QR status of ${student_id} to ${status}`);
    res.json({ success: true });
  });
});

// Positions & Committees APIs
app.get('/api/positions', (req, res) => {
  db.all(`SELECT * FROM positions ORDER BY is_officer DESC, name ASC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/positions', requireAdmin, (req, res) => {
  const { name, is_officer } = req.body;
  db.run(`INSERT INTO positions (name, is_officer) VALUES (?, ?)`, [name, is_officer ? 1 : 0], function(err) {
    if (err) return res.status(400).json({ error: 'Position already exists.' });
    logAudit(req.session.user.username, 'ADD_POSITION', `Added position: ${name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/positions/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM positions WHERE id = ?`, [req.params.id], (err) => {
    res.json({ success: true });
  });
});

app.get('/api/committees', (req, res) => {
  db.all(`SELECT * FROM committees ORDER BY name ASC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/committees', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  db.run(`INSERT INTO committees (name, description) VALUES (?, ?)`, [name, description], function(err) {
    if (err) return res.status(400).json({ error: 'Committee already exists.' });
    logAudit(req.session.user.username, 'ADD_COMMITTEE', `Added committee: ${name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/committees/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM committees WHERE id = ?`, [req.params.id], (err) => {
    res.json({ success: true });
  });
});

// Event Management APIs
app.get('/api/events', (req, res) => {
  db.all(`SELECT * FROM events ORDER BY date DESC, start_time DESC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/events', requireAdmin, (req, res) => {
  const d = req.body;
  const sql = `INSERT INTO events (name, description, type, date, start_time, end_time, late_threshold_mins, location, organizer, target_audience, target_details, status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
  const params = [
    d.name, d.description, d.type, d.date, d.start_time, d.end_time,
    d.late_threshold_mins || 15, d.location, d.organizer, d.target_audience || 'ALL',
    d.target_details || '', d.status || 'Upcoming'
  ];

  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'CREATE_EVENT', `Created Event: ${d.name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/events/:id', requireAdmin, (req, res) => {
  const d = req.body;
  const sql = `UPDATE events SET name=?, description=?, type=?, date=?, start_time=?, end_time=?, late_threshold_mins=?, location=?, organizer=?, target_audience=?, target_details=?, status=? WHERE id=?`;
  const params = [
    d.name, d.description, d.type, d.date, d.start_time, d.end_time,
    d.late_threshold_mins, d.location, d.organizer, d.target_audience,
    d.target_details, d.status, req.params.id
  ];

  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'UPDATE_EVENT', `Updated Event ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/events/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM events WHERE id = ?`, [req.params.id], (err) => {
    db.run(`DELETE FROM attendance WHERE event_id = ?`, [req.params.id]);
    logAudit(req.session.user.username, 'DELETE_EVENT', `Deleted Event ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

// Real-Time Scan & Attendance Endpoint
app.post('/api/scan', requireScannerOrAdmin, (req, res) => {
  const { qr_token, event_id, mode } = req.body; // mode = 'TIME_IN' or 'TIME_OUT'
  if (!qr_token || !event_id) return res.status(400).json({ error: 'Missing scan payload parameters.' });

  // 1. Verify Active Event
  db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
    if (err || !event) return res.status(400).json({ result: 'INVALID_EVENT', message: 'No active event selected.' });
    if (event.status === 'Cancelled' || event.status === 'Completed') {
      return res.status(400).json({ result: 'EVENT_INACTIVE', message: `Event is marked as ${event.status}.` });
    }

    // 2. Validate QR Token
    db.get(`
      SELECT q.status as qr_status, s.* 
      FROM qr_tokens q
      JOIN students s ON q.student_id = s.student_id
      WHERE q.token = ?
    `, [qr_token], (err, record) => {
      if (err || !record) {
        return res.status(404).json({ result: 'INVALID_QR', message: 'Invalid or unrecognized QR Code.' });
      }

      if (record.qr_status !== 'ACTIVE') {
        return res.status(403).json({ result: 'QR_DISABLED', message: 'This QR Code has been disabled by Admin.' });
      }

      if (record.membership_status !== 'Active') {
        return res.status(403).json({ result: 'INACTIVE_MEMBER', message: `Student status is currently '${record.membership_status}'.` });
      }

      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

      // 3. Process Attendance Check
      db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, record.student_id], (err, att) => {
        if (mode === 'TIME_OUT') {
          if (!att) {
            return res.status(400).json({ result: 'NO_TIME_IN', message: 'Cannot record Time Out. Student has not recorded Time In.', student: record });
          }
          if (att.time_out) {
            return res.status(400).json({ result: 'DUPLICATE_TIME_OUT', message: 'Time Out already recorded for this event.', student: record });
          }

          db.run(`UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = ?`, [att.id], (err) => {
            logAudit(req.session.user.username, 'TIME_OUT_RECORDED', `Time Out recorded for ${record.full_name} on Event ${event.name}`);
            return res.json({
              result: 'SUCCESS_TIME_OUT',
              message: `${record.full_name}, time out recorded.`,
              student: record,
              time: timeStr
            });
          });
        } else {
          // Default TIME_IN mode
          if (att) {
            return res.status(400).json({
              result: 'ALREADY_RECORDED',
              message: `${record.full_name}, you are already recorded for this event.`,
              student: record,
              existing: att
            });
          }

          // Compute Late vs Present Status
          const eventStart = new Date(`${event.date}T${event.start_time}`);
          const lateCutoff = new Date(eventStart.getTime() + (event.late_threshold_mins * 60000));
          const attendanceStatus = (now > lateCutoff) ? 'LATE' : 'PRESENT';

          db.run(`INSERT INTO attendance (event_id, student_id, time_in, status, recorded_by) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)`,
            [event_id, record.student_id, attendanceStatus, req.session.user.username], function(err) {
              if (err) return res.status(500).json({ error: err.message });
              
              logAudit(req.session.user.username, 'ATTENDANCE_RECORDED', `Recorded ${attendanceStatus} for ${record.full_name}`);
              return res.json({
                result: 'SUCCESS_TIME_IN',
                message: `${record.full_name}, attendance recorded.`,
                student: record,
                status: attendanceStatus,
                time: timeStr
              });
            });
        }
      });
    });
  });
});

// Attendance Management & Reports APIs
app.get('/api/attendance', (req, res) => {
  const { event_id, student_id, date } = req.query;
  let sql = `
    SELECT a.*, s.full_name, s.position, s.club, s.committee, s.photo, e.name as event_name, e.date as event_date
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (event_id) { sql += ` AND a.event_id = ?`; params.push(event_id); }
  if (student_id) { sql += ` AND a.student_id = ?`; params.push(student_id); }
  if (date) { sql += ` AND e.date = ?`; params.push(date); }

  sql += ` ORDER BY a.created_at DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/attendance/manual', requireAdmin, (req, res) => {
  const { event_id, student_id, status, notes } = req.body;
  
  db.get(`SELECT id FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student_id], (err, row) => {
    if (row) {
      db.run(`UPDATE attendance SET status = ?, recorded_by = ? WHERE id = ?`, [status, req.session.user.username, row.id]);
    } else {
      db.run(`INSERT INTO attendance (event_id, student_id, time_in, status, recorded_by) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [event_id, student_id, status, req.session.user.username]);
    }

    if (status === 'EXCUSED') {
      db.run(`INSERT INTO excuses (event_id, student_id, reason, notes, approved_by, date_approved) VALUES (?, ?, ?, ?, ?, DATE('now'))`,
        [event_id, student_id, notes || 'Manual Excuse', 'Admin adjustment', req.session.user.username]);
    }

    logAudit(req.session.user.username, 'MANUAL_ATTENDANCE', `Manual status ${status} set for student ${student_id} in event ${event_id}`);
    res.json({ success: true });
  });
});

app.delete('/api/attendance/:id', requireAdmin, (req, res) => {
  db.run(`DELETE FROM attendance WHERE id = ?`, [req.params.id], (err) => {
    logAudit(req.session.user.username, 'DELETE_ATTENDANCE', `Deleted attendance record ID: ${req.params.id}`);
    res.json({ success: true });
  });
});

// Analytics Dashboard Feed
app.get('/api/analytics/dashboard', (req, res) => {
  const data = {};

  db.get(`SELECT 
      COUNT(*) as total_members,
      SUM(CASE WHEN membership_status = 'Active' THEN 1 ELSE 0 END) as active_members,
      SUM(CASE WHEN position != 'Member' AND position != 'Committee Member' THEN 1 ELSE 0 END) as total_officers
    FROM students`, [], (err, row1) => {
      data.summary = row1 || {};

      db.get(`SELECT 
          SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END) as present_today,
          SUM(CASE WHEN status = 'LATE' THEN 1 ELSE 0 END) as late_today,
          SUM(CASE WHEN status = 'ABSENT' THEN 1 ELSE 0 END) as absent_today,
          SUM(CASE WHEN status = 'EXCUSED' THEN 1 ELSE 0 END) as excused_today,
          COUNT(*) as total_scans_today
        FROM attendance WHERE DATE(time_in) = DATE('now')`, [], (err, row2) => {
          data.today = row2 || { present_today: 0, late_today: 0, absent_today: 0, excused_today: 0, total_scans_today: 0 };

          // Attendance rates
          db.all(`SELECT status, COUNT(*) as count FROM attendance GROUP BY status`, [], (err, statusRows) => {
            data.statusBreakdown = statusRows || [];

            // Low participation members (< 75%)
            db.all(`
              SELECT s.student_id, s.full_name, s.position, s.committee,
                COUNT(a.id) as attended_count,
                (SELECT COUNT(*) FROM events WHERE status = 'Completed') as total_events
              FROM students s
              LEFT JOIN attendance a ON s.student_id = a.student_id
              WHERE s.membership_status = 'Active'
              GROUP BY s.student_id
            `, [], (err, partRows) => {
              data.participation = (partRows || []).map(p => {
                const total = p.total_events || 1;
                const pct = Math.round((p.attended_count / total) * 100);
                return { ...p, percentage: pct };
              });

              // Frequently Late
              db.all(`
                SELECT s.student_id, s.full_name, s.position, COUNT(a.id) as late_count
                FROM attendance a
                JOIN students s ON a.student_id = s.student_id
                WHERE a.status = 'LATE'
                GROUP BY s.student_id
                HAVING late_count >= 1
                ORDER BY late_count DESC LIMIT 5
              `, [], (err, lateRows) => {
                data.frequentlyLate = lateRows || [];
                res.json(data);
              });
            });
          });
        });
    });
});

// System Audit Logs & Database Backup
app.get('/api/audit-logs', requireAdmin, (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/backup', requireAdmin, (req, res) => {
  res.download(dbPath, `club_attendance_backup_${Date.now()}.db`);
});

// Backup Restore Route
app.post('/api/restore', requireAdmin, upload.single('backup_file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No database file uploaded.' });
  
  const tempPath = req.file.path;
  db.close((err) => {
    fs.copyFileSync(tempPath, dbPath);
    fs.unlinkSync(tempPath);
    // Reopen DB connection
    db = new sqlite3.Database(dbPath);
    logAudit(req.session.user.username, 'RESTORE_DATABASE', 'Restored system database from backup file.');
    res.json({ success: true, message: 'Database restored successfully. System restarting context.' });
  });
});

// ==========================================
// FRONTEND INTERFACE GENERATION (EMBEDDED)
// ==========================================

app.get('*', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Student Club QR Attendance System</title>
  
  <!-- CSS Frameworks & Libraries -->
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css" rel="stylesheet">
  <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
  <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

  <style>
    :root {
      --primary-color: #0d6efd;
      --secondary-color: #0b5ed7;
      --dark-bg: #1e293b;
      --light-bg: #f8fafc;
    }
    body {
      background-color: #f1f5f9;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    }
    .sidebar {
      min-height: 100vh;
      background-color: var(--dark-bg);
      color: #fff;
    }
    .sidebar .nav-link {
      color: #94a3b8;
      margin: 4px 12px;
      border-radius: 8px;
      padding: 10px 16px;
    }
    .sidebar .nav-link:hover, .sidebar .nav-link.active {
      color: #fff;
      background-color: rgba(255, 255, 255, 0.1);
    }
    .main-content {
      padding: 24px;
    }
    .card-custom {
      border: none;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
      background: #fff;
    }
    
    /* Student ID Card Print Styling */
    .id-card {
      width: 3.375in;
      height: 2.125in;
      border: 2px solid #333;
      border-radius: 8px;
      padding: 8px;
      background: #fff;
      position: relative;
      box-sizing: border-box;
      font-size: 10px;
      display: inline-block;
      margin: 5px;
      page-break-inside: avoid;
    }
    .id-card-header {
      border-bottom: 2px solid var(--primary-color);
      padding-bottom: 4px;
      margin-bottom: 6px;
    }
    .id-photo {
      width: 60px;
      height: 60px;
      object-fit: cover;
      border-radius: 4px;
      border: 1px solid #ccc;
    }
    .id-qr {
      width: 55px;
      height: 55px;
    }

    /* Dedicated A4 Print Layout rules */
    @media print {
      body * {
        visibility: hidden;
      }
      #print-area, #print-area * {
        visibility: visible;
      }
      #print-area {
        position: absolute;
        left: 0;
        top: 0;
        width: 210mm;
        margin: 0;
        padding: 10mm;
      }
      .a4-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        grid-gap: 8mm 6mm;
        justify-items: center;
      }
      .no-print {
        display: none !important;
      }
    }
  </style>
</head>
<body>

  <div id="app">
    <!-- Dynamic View Container -->
  </div>

  <script>
    // Frontend State Engine
    const state = {
      user: null,
      student: null,
      settings: {},
      currentView: 'login',
      scannerMode: 'TIME_IN',
      activeScannerEvent: null,
      html5QrCode: null
    };

    // Initialize System Context
    async function init() {
      await fetchSettings();
      const me = await fetch('/api/me').then(r => r.json());
      
      if (me.user) {
        state.user = me.user;
        navigate('dashboard');
      } else if (me.student) {
        state.student = me.student;
        navigate('student-portal');
      } else {
        navigate('login');
      }
    }

    async function fetchSettings() {
      state.settings = await fetch('/api/settings').then(r => r.json());
    }

    // Voice & Speech Synthesis Announcement
    function speak(text) {
      if (state.settings.voice_announcements !== 'true') return;
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = parseFloat(state.settings.speech_rate || 1.0);
        utterance.volume = parseFloat(state.settings.voice_volume || 1.0);
        window.speechSynthesis.speak(utterance);
      }
    }

    // Sound FX Generator
    function playBeep(type) {
      if (state.settings.sound_effects !== 'true') return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'success') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      }
    }

    // Routing Navigation
    function navigate(view) {
      state.currentView = view;
      if (state.html5QrCode && view !== 'scanner') {
        state.html5QrCode.stop().catch(() => {});
      }
      render();
    }

    // Master Render Router
    function render() {
      const app = document.getElementById('app');
      
      if (state.currentView === 'login') {
        app.innerHTML = renderLogin();
      } else if (state.currentView === 'student-login') {
        app.innerHTML = renderStudentLogin();
      } else if (state.currentView === 'scanner') {
        app.innerHTML = renderScannerPortal();
        initScannerHardware();
      } else if (state.currentView === 'student-portal') {
        app.innerHTML = renderStudentPortal();
      } else {
        // Admin Shell Wrapper
        app.innerHTML = \`
          <div class="container-fluid">
            <div class="row">
              <div class="col-md-3 col-lg-2 sidebar d-flex flex-column justify-content-between p-3 no-print">
                <div>
                  <div class="text-center mb-4 pt-2">
                    <i class="bi bi-qr-code-scan text-primary display-6"></i>
                    <h6 class="fw-bold mt-2 mb-0 text-white">\${state.settings.club_name || 'Club Attendance'}</h6>
                    <small class="text-muted">\${state.settings.organization_name || 'School Organization'}</small>
                  </div>
                  <nav class="nav flex-column">
                    <a class="nav-link \${state.currentView === 'dashboard' ? 'active' : ''}" href="#" onclick="navigate('dashboard')"><i class="bi bi-speedometer2 me-2"></i> Dashboard</a>
                    <a class="nav-link \${state.currentView === 'members' ? 'active' : ''}" href="#" onclick="navigate('members')"><i class="bi bi-people me-2"></i> Student Members</a>
                    <a class="nav-link \${state.currentView === 'positions' ? 'active' : ''}" href="#" onclick="navigate('positions')"><i class="bi bi-person-badge me-2"></i> Positions & Officers</a>
                    <a class="nav-link \${state.currentView === 'events' ? 'active' : ''}" href="#" onclick="navigate('events')"><i class="bi bi-calendar-event me-2"></i> Club Events</a>
                    <a class="nav-link \${state.currentView === 'attendance' ? 'active' : ''}" href="#" onclick="navigate('attendance')"><i class="bi bi-journal-check me-2"></i> Attendance Logs</a>
                    <a class="nav-link \${state.currentView === 'id-print' ? 'active' : ''}" href="#" onclick="navigate('id-print')"><i class="bi bi-card-heading me-2"></i> ID Cards & Printing</a>
                    <a class="nav-link \${state.currentView === 'reports' ? 'active' : ''}" href="#" onclick="navigate('reports')"><i class="bi bi-file-earmark-bar-graph me-2"></i> Reports & Analytics</a>
                    <a class="nav-link" href="#" onclick="navigate('scanner')"><i class="bi bi-camera me-2"></i> Open Scanner Portal</a>
                    <a class="nav-link \${state.currentView === 'settings' ? 'active' : ''}" href="#" onclick="navigate('settings')"><i class="bi bi-gear me-2"></i> System Settings</a>
                  </nav>
                </div>
                <div>
                  <hr class="text-secondary">
                  <div class="d-flex align-items-center justify-content-between px-2 text-white">
                    <small>User: <strong>\${state.user ? state.user.username : 'Guest'}</strong></small>
                    <button onclick="logout()" class="btn btn-sm btn-outline-danger"><i class="bi bi-box-arrow-right"></i></button>
                  </div>
                </div>
              </div>
              <div class="col-md-9 col-lg-10 main-content">
                <div id="view-container"></div>
              </div>
            </div>
          </div>
        \`;

        // Render Internal View Component
        const container = document.getElementById('view-container');
        if (state.currentView === 'dashboard') loadDashboard(container);
        else if (state.currentView === 'members') loadMembersView(container);
        else if (state.currentView === 'positions') loadPositionsView(container);
        else if (state.currentView === 'events') loadEventsView(container);
        else if (state.currentView === 'attendance') loadAttendanceView(container);
        else if (state.currentView === 'id-print') loadIdPrintView(container);
        else if (state.currentView === 'reports') loadReportsView(container);
        else if (state.currentView === 'settings') loadSettingsView(container);
      }
    }

    // ==========================================
    // VIEW RENDERERS & CONTROLLERS
    // ==========================================

    function renderLogin() {
      return \`
        <div class="min-vh-100 d-flex align-items-center justify-content-center">
          <div class="card card-custom p-4 style="max-width: 400px; width: 100%;">
            <div class="text-center mb-4">
              <i class="bi bi-shield-lock text-primary display-4"></i>
              <h4 class="fw-bold mt-2">\${state.settings.club_name || 'Club Portal'}</h4>
              <p class="text-muted small">Adviser & Officer Login</p>
            </div>
            <form onsubmit="handleLogin(event)">
              <div class="mb-3">
                <label class="form-label">Username</label>
                <input type="text" id="login-user" class="form-control" required placeholder="admin / scanner">
              </div>
              <div class="mb-3">
                <label class="form-label">Password</label>
                <input type="password" id="login-pass" class="form-control" required placeholder="••••••••">
              </div>
              <button type="submit" class="btn btn-primary w-100 mb-3">Sign In</button>
              <div class="text-center">
                <a href="#" onclick="navigate('student-login')" class="text-decoration-none small">Student Member Portal Access &rarr;</a>
              </div>
            </form>
          </div>
        </div>
      \`;
    }

    function renderStudentLogin() {
      return \`
        <div class="min-vh-100 d-flex align-items-center justify-content-center">
          <div class="card card-custom p-4" style="max-width: 400px; width: 100%;">
            <div class="text-center mb-4">
              <i class="bi bi-person-badge text-success display-4"></i>
              <h4 class="fw-bold mt-2">Student Member Portal</h4>
              <p class="text-muted small">Enter your Student ID to view your ID Card & History</p>
            </div>
            <form onsubmit="handleStudentLogin(event)">
              <div class="mb-3">
                <label class="form-label">Student ID Number</label>
                <input type="text" id="login-student-id" class="form-control" placeholder="e.g. 2026-001" required>
              </div>
              <button type="submit" class="btn btn-success w-100 mb-3">Access Portal</button>
              <div class="text-center">
                <a href="#" onclick="navigate('login')" class="text-decoration-none small">&larr; Adviser / Staff Login</a>
              </div>
            </form>
          </div>
        </div>
      \`;
    }

    async function handleLogin(e) {
      e.preventDefault();
      const u = document.getElementById('login-user').value;
      const p = document.getElementById('login-pass').value;

      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();
      if (res.ok) {
        state.user = data.user;
        navigate('dashboard');
      } else {
        alert(data.error);
      }
    }

    async function handleStudentLogin(e) {
      e.preventDefault();
      const sid = document.getElementById('login-student-id').value;
      const res = await fetch('/api/student-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id: sid })
      });
      const data = await res.json();
      if (res.ok) {
        state.student = data.student;
        navigate('student-portal');
      } else {
        alert(data.error);
      }
    }

    async function logout() {
      await fetch('/api/logout');
      state.user = null;
      state.student = null;
      navigate('login');
    }

    // ==========================================
    // DASHBOARD VIEW
    // ==========================================
    async function loadDashboard(container) {
      const data = await fetch('/api/analytics/dashboard').then(r => r.json());
      const events = await fetch('/api/events').then(r => r.json());
      const activeEvent = events.find(e => e.status === 'Active') || events[0];

      container.innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4">
          <div>
            <h3 class="fw-bold text-dark">\${state.settings.school_name || 'School Dashboard'}</h3>
            <p class="text-muted mb-0">\${state.settings.club_name} | Adviser: \${state.settings.club_adviser} | S.Y. \${state.settings.school_year}</p>
          </div>
          <button class="btn btn-primary" onclick="navigate('scanner')"><i class="bi bi-camera me-2"></i> Launch Scanner</button>
        </div>

        <div class="row g-3 mb-4">
          <div class="col-md-3">
            <div class="card card-custom p-3 border-start border-primary border-4">
              <small class="text-muted fw-bold">TOTAL MEMBERS</small>
              <h2 class="fw-bold mb-0">\${data.summary.total_members || 0}</h2>
              <small class="text-success">\${data.summary.active_members || 0} Active Status</small>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-custom p-3 border-start border-info border-4">
              <small class="text-muted fw-bold">CLUB OFFICERS</small>
              <h2 class="fw-bold mb-0">\${data.summary.total_officers || 0}</h2>
              <small class="text-muted">Leadership Roles</small>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-custom p-3 border-start border-success border-4">
              <small class="text-muted fw-bold">PRESENT TODAY</small>
              <h2 class="fw-bold mb-0">\${data.today.present_today || 0}</h2>
              <small class="text-warning">\${data.today.late_today || 0} Late Scans</small>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-custom p-3 border-start border-danger border-4">
              <small class="text-muted fw-bold">ABSENT / EXCUSED</small>
              <h2 class="fw-bold mb-0">\${(data.today.absent_today || 0) + (data.today.excused_today || 0)}</h2>
              <small class="text-muted">\${data.today.excused_today || 0} Officially Excused</small>
            </div>
          </div>
        </div>

        <div class="row g-3 mb-4">
          <div class="col-md-8">
            <div class="card card-custom p-3">
              <h5 class="fw-bold mb-3">Attendance Trends & Status Distribution</h5>
              <canvas id="attendanceChart" height="120"></canvas>
            </div>
          </div>
          <div class="col-md-4">
            <div class="card card-custom p-3">
              <h5 class="fw-bold mb-3">Frequently Late Members</h5>
              <div class="list-group list-group-flush">
                \${(data.frequentlyLate || []).map(f => \`
                  <div class="list-group-item d-flex justify-content-between align-items-center px-0">
                    <div>
                      <strong class="d-block">\${f.full_name}</strong>
                      <small class="text-muted">\${f.position}</small>
                    </div>
                    <span class="badge bg-warning text-dark">\${f.late_count} Times Late</span>
                  </div>
                \`).join('') || '<p class="text-muted small">No frequent late records found.</p>'}
              </div>
            </div>
          </div>
        </div>
      \`;

      // Render Chart
      const ctx = document.getElementById('attendanceChart').getContext('2d');
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Present', 'Late', 'Absent', 'Excused'],
          datasets: [{
            label: 'Today Total Scans',
            data: [
              data.today.present_today || 0,
              data.today.late_today || 0,
              data.today.absent_today || 0,
              data.today.excused_today || 0
            ],
            backgroundColor: ['#198754', '#ffc107', '#dc3545', '#0dcaf0']
          }]
        },
        options: { responsive: true, plugins: { legend: { display: false } } }
      });
    }

    // ==========================================
    // STUDENT MEMBERS VIEW & REGISTRATION
    // ==========================================
    async function loadMembersView(container) {
      const students = await fetch('/api/students').then(r => r.json());
      const positions = await fetch('/api/positions').then(r => r.json());
      const committees = await fetch('/api/committees').then(r => r.json());

      container.innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4">
          <h3 class="fw-bold">Student Members Registration & Directory</h3>
          <button class="btn btn-primary" onclick="openMemberModal()"><i class="bi bi-person-plus me-2"></i> Register New Member</button>
        </div>

        <div class="card card-custom p-3 mb-4">
          <div class="row g-2">
            <div class="col-md-4">
              <input type="text" id="search-member" class="form-control" placeholder="Search ID or Name..." oninput="filterMembers()">
            </div>
            <div class="col-md-3">
              <select id="filter-pos" class="form-select" onchange="filterMembers()">
                <option value="">All Positions</option>
                \${positions.map(p => \`<option value="\${p.name}">\${p.name}</option>\`).join('')}
              </select>
            </div>
            <div class="col-md-3">
              <select id="filter-comm" class="form-select" onchange="filterMembers()">
                <option value="">All Committees</option>
                \${committees.map(c => \`<option value="\${c.name}">\${c.name}</option>\`).join('')}
              </select>
            </div>
          </div>
        </div>

        <div class="card card-custom p-3">
          <div class="table-responsive">
            <table class="table table-hover align-middle" id="members-table">
              <thead>
                <tr>
                  <th>Student ID</th>
                  <th>Name</th>
                  <th>Position</th>
                  <th>Committee</th>
                  <th>Status</th>
                  <th>QR Token</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${students.map(s => \`
                  <tr>
                    <td><strong>\${s.student_id}</strong></td>
                    <td>
                      <div class="d-flex align-items-center">
                        <img src="\${s.photo || 'https://via.placeholder.com/40'}" class="rounded-circle me-2" width="36" height="36" style="object-fit:cover;">
                        <div>
                          <div class="fw-bold">\${s.full_name}</div>
                          <small class="text-muted">\${s.email || 'No email'}</small>
                        </div>
                      </div>
                    </td>
                    <td><span class="badge bg-secondary">\${s.position}</span></td>
                    <td>\${s.committee}</td>
                    <td><span class="badge \${s.membership_status === 'Active' ? 'bg-success' : 'bg-danger'}">\${s.membership_status}</span></td>
                    <td><small class="font-monospace text-muted">\${s.qr_token || 'N/A'}</small></td>
                    <td>
                      <button class="btn btn-sm btn-outline-primary me-1" onclick="viewQR('\${s.student_id}', '\${s.qr_token}')"><i class="bi bi-qr-code"></i></button>
                      <button class="btn btn-sm btn-outline-danger" onclick="deleteMember(\${s.id})"><i class="bi bi-trash"></i></button>
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Registration Modal -->
        <div class="modal fade" id="memberModal" tabindex="-1">
          <div class="modal-dialog modal-lg">
            <div class="modal-content">
              <form id="member-form" onsubmit="saveMember(event)">
                <div class="modal-header">
                  <h5 class="modal-title fw-bold">Register Student Member</h5>
                  <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body row g-3">
                  <div class="col-md-4">
                    <label class="form-label">Student ID *</label>
                    <input type="text" name="student_id" class="form-control" required placeholder="2026-XXX">
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">First Name *</label>
                    <input type="text" name="first_name" class="form-control" required>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Last Name *</label>
                    <input type="text" name="last_name" class="form-control" required>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Position *</label>
                    <select name="position" class="form-select" required>
                      \${positions.map(p => \`<option value="\${p.name}">\${p.name}</option>\`).join('')}
                    </select>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Committee *</label>
                    <select name="committee" class="form-select" required>
                      \${committees.map(c => \`<option value="\${c.name}">\${c.name}</option>\`).join('')}
                    </select>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">School Year *</label>
                    <input type="text" name="school_year" class="form-control" value="\${state.settings.school_year || '2026-2027'}" required>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Club Name</label>
                    <input type="text" name="club" class="form-control" value="\${state.settings.club_name || 'Computer Club'}" readonly>
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Date Joined</label>
                    <input type="date" name="date_joined" class="form-control" value="\${new Date().toISOString().split('T')[0]}">
                  </div>
                  <div class="col-md-4">
                    <label class="form-label">Student Photo</label>
                    <input type="file" name="photo" class="form-control" accept="image/*">
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Parent / Guardian Name</label>
                    <input type="text" name="parent_name" class="form-control">
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Parent Contact Number</label>
                    <input type="text" name="parent_contact" class="form-control">
                  </div>
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                  <button type="submit" class="btn btn-primary">Save Member</button>
                </div>
              </form>
            </div>
          </div>
        </div>

        <!-- QR Display Modal -->
        <div class="modal fade" id="qrModal" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered text-center">
            <div class="modal-content p-4">
              <h5 class="fw-bold mb-3" id="qr-modal-title">Student QR Code</h5>
              <div id="qrcode-container" class="d-flex justify-content-center mb-3"></div>
              <small class="text-muted font-monospace mb-3" id="qr-modal-token"></small>
              <div class="d-flex justify-content-center gap-2">
                <button class="btn btn-warning btn-sm" onclick="regenerateQR()"><i class="bi bi-arrow-repeat me-1"></i> Regenerate QR</button>
                <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">Close</button>
              </div>
            </div>
          </div>
        </div>
      \`;
    }

    let currentSelectedStudentForQR = null;

    function openMemberModal() {
      const modal = new bootstrap.Modal(document.getElementById('memberModal'));
      modal.show();
    }

    async function saveMember(e) {
      e.preventDefault();
      const formData = new FormData(document.getElementById('member-form'));
      const res = await fetch('/api/students', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        bootstrap.Modal.getInstance(document.getElementById('memberModal')).hide();
        navigate('members');
      } else {
        alert(data.error);
      }
    }

    async function deleteMember(id) {
      if (confirm('Are you sure you want to delete this student member?')) {
        await fetch(\`/api/students/\${id}\`, { method: 'DELETE' });
        navigate('members');
      }
    }

    function viewQR(studentId, token) {
      currentSelectedStudentForQR = studentId;
      document.getElementById('qr-modal-title').innerText = \`QR Code: \${studentId}\`;
      document.getElementById('qr-modal-token').innerText = \`Secure Token: \${token}\`;
      const container = document.getElementById('qrcode-container');
      container.innerHTML = '';
      new QRCode(container, { text: token, width: 180, height: 180 });
      new bootstrap.Modal(document.getElementById('qrModal')).show();
    }

    async function regenerateQR() {
      if (!currentSelectedStudentForQR) return;
      if (confirm('Regenerating will invalidate the existing QR code. Continue?')) {
        const res = await fetch('/api/qr/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_id: currentSelectedStudentForQR })
        }).then(r => r.json());

        viewQR(currentSelectedStudentForQR, res.token);
      }
    }

    // ==========================================
    // ID CARD & A4 PRINTING VIEW (8 IDs PER A4)
    // ==========================================
    async function loadIdPrintView(container) {
      const students = await fetch('/api/students').then(r => r.json());

      container.innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4 no-print">
          <div>
            <h3 class="fw-bold">Student Club ID Card Printing</h3>
            <p class="text-muted">A4 Paper Layout: Formatted strictly for 8 ID Cards per sheet with cut lines.</p>
          </div>
          <button class="btn btn-success" onclick="window.print()"><i class="bi bi-printer me-2"></i> Print Layout Now</button>
        </div>

        <div id="print-area">
          <div class="a4-grid">
            \${students.map(s => \`
              <div class="id-card">
                <div class="id-card-header d-flex align-items-center justify-content-between">
                  <div>
                    <strong style="font-size: 8px; display:block;" class="text-uppercase">\${state.settings.school_name || 'School Name'}</strong>
                    <span style="font-size: 9px;" class="fw-bold text-primary">\${state.settings.club_name || 'Club'}</span>
                  </div>
                  <small style="font-size: 7px;" class="text-muted">S.Y. \${s.school_year}</small>
                </div>
                <div class="d-flex gap-2 align-items-center">
                  <img src="\${s.photo || 'https://via.placeholder.com/60'}" class="id-photo">
                  <div style="flex-grow:1;">
                    <strong style="font-size: 11px; display:block;" class="text-dark">\${s.full_name}</strong>
                    <span style="font-size: 8px;" class="badge bg-primary mb-1">\${s.position}</span><br>
                    <small style="font-size: 7px;" class="text-muted">ID: \${s.student_id}</small><br>
                    <small style="font-size: 7px;" class="text-muted">Comm: \${s.committee}</small>
                  </div>
                  <div class="id-qr-box" id="qr-target-\${s.student_id}"></div>
                </div>
              </div>
            \`).join('')}
          </div>
        </div>
      \`;

      // Render Batch QRs inside cards
      students.forEach(s => {
        const target = document.getElementById(\`qr-target-\${s.student_id}\`);
        if (target && s.qr_token) {
          new QRCode(target, { text: s.qr_token, width: 48, height: 48 });
        }
      });
    }

    // ==========================================
    // DEDICATED SCANNER PORTAL VIEW
    // ==========================================
    function renderScannerPortal() {
      return \`
        <div class="min-vh-100 bg-dark text-white d-flex flex-column">
          <!-- Scanner Header -->
          <div class="p-3 bg-black d-flex justify-content-between align-items-center border-bottom border-secondary">
            <div class="d-flex align-items-center">
              <i class="bi bi-qr-code-scan fs-3 text-primary me-2"></i>
              <div>
                <h6 class="fw-bold mb-0">Mobile Attendance Scanner</h6>
                <small class="text-muted">\${state.settings.club_name || 'School Club'}</small>
              </div>
            </div>
            <button onclick="navigate('dashboard')" class="btn btn-sm btn-outline-light"><i class="bi bi-x-lg"></i> Exit</button>
          </div>

          <div class="container my-auto py-3" style="max-width: 500px;">
            <!-- Active Event & Mode Controls -->
            <div class="card bg-secondary bg-opacity-25 border-secondary p-3 mb-3">
              <label class="form-label text-warning fw-bold small">1. SELECT ACTIVE CLUB EVENT</label>
              <select id="scanner-event-select" class="form-select bg-dark text-white border-secondary mb-3"></select>

              <label class="form-label text-warning fw-bold small">2. RECORDING MODE</label>
              <div class="btn-group w-100" role="group">
                <button type="button" id="btn-mode-in" class="btn btn-success fw-bold active" onclick="setScanMode('TIME_IN')">TIME IN</button>
                <button type="button" id="btn-mode-out" class="btn btn-outline-danger fw-bold" onclick="setScanMode('TIME_OUT')">TIME OUT</button>
              </div>
            </div>

            <!-- Camera Viewport Card -->
            <div class="card bg-black border-secondary p-2 text-center overflow-hidden position-relative">
              <div id="reader" style="width: 100%; min-height: 280px; background: #000;"></div>
              <div id="scan-feedback-overlay" class="position-absolute top-0 start-0 w-100 h-100 d-none d-flex flex-column align-items-center justify-content-center bg-black bg-opacity-90 p-3">
                <i id="scan-icon" class="display-1 mb-2"></i>
                <h4 id="scan-msg" class="fw-bold"></h4>
                <p id="scan-student-name" class="fs-5 text-info mb-0"></p>
                <small id="scan-student-id" class="text-muted"></small>
              </div>
            </div>
          </div>
        </div>
      \`;
    }

    async function initScannerHardware() {
      const events = await fetch('/api/events').then(r => r.json());
      const select = document.getElementById('scanner-event-select');
      
      if (events.length === 0) {
        select.innerHTML = '<option value="">No Events Found</option>';
      } else {
        select.innerHTML = events.map(e => \`<option value="\${e.id}">\${e.name} (\${e.date})</option>\`).join('');
        state.activeScannerEvent = events[0].id;
      }

      select.addEventListener('change', (e) => state.activeScannerEvent = e.target.value);

      // HTML5 QR Scanner
      state.html5QrCode = new Html5Qrcode("reader");
      state.html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        onQrCodeScanned
      ).catch(err => console.log("Camera access error:", err));
    }

    function setScanMode(mode) {
      state.scannerMode = mode;
      document.getElementById('btn-mode-in').className = mode === 'TIME_IN' ? 'btn btn-success fw-bold' : 'btn btn-outline-success fw-bold';
      document.getElementById('btn-mode-out').className = mode === 'TIME_OUT' ? 'btn btn-danger fw-bold' : 'btn btn-outline-danger fw-bold';
    }

    let isProcessingScan = false;

    async function onQrCodeScanned(qrToken) {
      if (isProcessingScan) return;
      isProcessingScan = true;

      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qr_token: qrToken,
          event_id: state.activeScannerEvent,
          mode: state.scannerMode
        })
      });

      const data = await res.json();
      showScanResultOverlay(data);

      setTimeout(() => {
        hideScanResultOverlay();
        isProcessingScan = false;
      }, 3000);
    }

    function showScanResultOverlay(data) {
      const overlay = document.getElementById('scan-feedback-overlay');
      const icon = document.getElementById('scan-icon');
      const msg = document.getElementById('scan-msg');
      const name = document.getElementById('scan-student-name');
      const id = document.getElementById('scan-student-id');

      overlay.classList.remove('d-none');

      if (data.result === 'SUCCESS_TIME_IN' || data.result === 'SUCCESS_TIME_OUT') {
        playBeep('success');
        icon.className = 'bi bi-check-circle-fill text-success display-1';
        msg.innerText = data.result === 'SUCCESS_TIME_IN' ? 'ATTENDANCE RECORDED' : 'TIME OUT RECORDED';
        name.innerText = data.student.full_name;
        id.innerText = \`ID: \${data.student.student_id} | Position: \${data.student.position}\`;
        speak(data.message);
      } else if (data.result === 'ALREADY_RECORDED') {
        playBeep('error');
        icon.className = 'bi bi-exclamation-triangle-fill text-warning display-1';
        msg.innerText = 'ALREADY RECORDED';
        name.innerText = data.student.full_name;
        id.innerText = 'Attendance already logged for this event.';
        speak(\`\${data.student.full_name}, you are already recorded.\`);
      } else {
        playBeep('error');
        icon.className = 'bi bi-x-circle-fill text-danger display-1';
        msg.innerText = 'INVALID QR CODE';
        name.innerText = data.message || 'Unrecognized Token';
        id.innerText = '';
        speak("Invalid QR code.");
      }
    }

    function hideScanResultOverlay() {
      document.getElementById('scan-feedback-overlay').classList.add('d-none');
    }

    // ==========================================
    // STUDENT PORTAL VIEW
    // ==========================================
    async function renderStudentPortal() {
      const s = state.student;
      const att = await fetch(\`/api/attendance?student_id=\${s.student_id}\`).then(r => r.json());

      return \`
        <div class="min-vh-100 p-3 bg-light">
          <div class="container" style="max-width: 600px;">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h4 class="fw-bold mb-0">Student Club Member Portal</h4>
              <button onclick="logout()" class="btn btn-sm btn-outline-danger">Logout</button>
            </div>

            <!-- Digital ID Card -->
            <div class="card card-custom p-3 mb-3 border-top border-primary border-4 text-center">
              <img src="\${s.photo || 'https://via.placeholder.com/100'}" class="rounded-circle mx-auto mb-2" width="80" height="80" style="object-fit:cover;">
              <h5 class="fw-bold mb-0">\${s.full_name}</h5>
              <p class="badge bg-primary d-inline-block mx-auto mb-2">\${s.position}</p>
              <div class="small text-muted mb-3">ID: <strong>\${s.student_id}</strong> | \${s.committee}</div>
              
              <div id="student-portal-qr" class="d-flex justify-content-center mb-2"></div>
              <small class="text-muted">Show this QR Code during events to record attendance</small>
            </div>

            <!-- History List -->
            <div class="card card-custom p-3">
              <h6 class="fw-bold mb-3">My Attendance History</h6>
              <div class="list-group list-group-flush">
                \${att.map(a => \`
                  <div class="list-group-item d-flex justify-content-between align-items-center px-0">
                    <div>
                      <strong class="d-block">\${a.event_name}</strong>
                      <small class="text-muted">\${a.event_date}</small>
                    </div>
                    <span class="badge \${a.status === 'PRESENT' ? 'bg-success' : 'bg-warning'}">\${a.status}</span>
                  </div>
                \`).join('') || '<p class="text-muted small">No attendance records found.</p>'}
              </div>
            </div>
          </div>
        </div>
      \`;
    }

    // Secondary Auxiliary Admin Views (Positions, Events, Logs, Settings)
    async function loadPositionsView(c) {
      const positions = await fetch('/api/positions').then(r => r.json());
      const committees = await fetch('/api/committees').then(r => r.json());
      c.innerHTML = \`
        <h3 class="fw-bold mb-4">Positions & Committees Management</h3>
        <div class="row g-4">
          <div class="col-md-6">
            <div class="card card-custom p-3">
              <h5 class="fw-bold">Club Positions</h5>
              <ul class="list-group list-group-flush">
                \${positions.map(p => \`<li class="list-group-item d-flex justify-content-between align-items-center">\${p.name} <span class="badge bg-info">\${p.is_officer ? 'Officer' : 'Member'}</span></li>\`).join('')}
              </ul>
            </div>
          </div>
          <div class="col-md-6">
            <div class="card card-custom p-3">
              <h5 class="fw-bold">Committees</h5>
              <ul class="list-group list-group-flush">
                \${committees.map(cm => \`<li class="list-group-item">\${cm.name}</li>\`).join('')}
              </ul>
            </div>
          </div>
        </div>
      \`;
    }

    async function loadEventsView(c) {
      const events = await fetch('/api/events').then(r => r.json());
      c.innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4">
          <h3 class="fw-bold">Club Events Management</h3>
          <button class="btn btn-primary" onclick="alert('Use modal form to create event')"><i class="bi bi-plus-lg me-2"></i> Create Event</button>
        </div>
        <div class="card card-custom p-3">
          <table class="table">
            <thead><tr><th>Event Name</th><th>Type</th><th>Date</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>
              \${events.map(e => \`<tr><td><strong>\${e.name}</strong></td><td>\${e.type}</td><td>\${e.date}</td><td>\${e.location}</td><td><span class="badge bg-success">\${e.status}</span></td></tr>\`).join('')}
            </tbody>
          </table>
        </div>
      \`;
    }

    async function loadAttendanceView(c) {
      const att = await fetch('/api/attendance').then(r => r.json());
      c.innerHTML = \`
        <h3 class="fw-bold mb-4">Official Attendance Records Log</h3>
        <div class="card card-custom p-3">
          <table class="table table-hover">
            <thead><tr><th>Student ID</th><th>Name</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
            <tbody>
              \${att.map(a => \`
                <tr>
                  <td>\${a.student_id}</td>
                  <td>\${a.full_name}</td>
                  <td>\${a.event_name}</td>
                  <td>\${a.time_in || '-'}</td>
                  <td>\${a.time_out || '-'}</td>
                  <td><span class="badge \${a.status === 'PRESENT' ? 'bg-success' : 'bg-warning'}">\${a.status}</span></td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      \`;
    }

    async function loadReportsView(c) {
      c.innerHTML = \`
        <h3 class="fw-bold mb-4">Attendance Reports & CSV Export</h3>
        <div class="card card-custom p-3">
          <p>Export official report sheets formatted with school header signatures.</p>
          <button class="btn btn-outline-primary" onclick="alert('Exporting CSV...')"><i class="bi bi-download me-2"></i> Download Full CSV Summary</button>
        </div>
      \`;
    }

    async function loadSettingsView(c) {
      const logs = await fetch('/api/audit-logs').then(r => r.json());
      c.innerHTML = \`
        <h3 class="fw-bold mb-4">System Settings & Database Backup</h3>
        <div class="row g-4">
          <div class="col-md-6">
            <div class="card card-custom p-3">
              <h5 class="fw-bold mb-3">Backup & System Recovery</h5>
              <a href="/api/backup" class="btn btn-primary mb-3"><i class="bi bi-download me-2"></i> Download Database Backup (.db)</a>
            </div>
          </div>
          <div class="col-md-6">
            <div class="card card-custom p-3">
              <h5 class="fw-bold mb-3">System Audit Logs</h5>
              <div style="max-height: 200px; overflow-y: auto;">
                \${logs.map(l => \`<div class="small border-bottom py-1"><strong>\${l.user}</strong>: \${l.action} (\${l.timestamp})</div>\`).join('')}
              </div>
            </div>
          </div>
        </div>
      \`;
    }

    // App Startup Entry Point
    window.onload = init;
  </script>
</body>
</html>
  `);
});

// Start Node Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` SCHOOL STUDENT CLUB QR ATTENDANCE SYSTEM IS ONLINE`);
  console.log(` Running on Local Server: http://localhost:${PORT}`);
  console.log(` Default Admin User: admin | Default Password: admin123`);
  console.log(` Default Scanner User: scanner | Default Password: scanner123`);
  console.log(`=======================================================`);
});
