/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Consolidated Single-File Architecture (Node.js + Express + SQLite + Web Speech API + HTML5 QR Code Scanner)
 */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Storage setup for student photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'photo-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Database Initialization
const DB_PATH = path.join(__dirname, 'attendance_system.db');
const db = new sqlite3.Database(DB_PATH);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(session({
  secret: 'school-club-attendance-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize SQLite Schema & Seed Data
db.serialize(() => {
  // Users (Admins, Officers, Students)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL, -- 'admin', 'scanner', 'student'
    student_id TEXT UNIQUE
  )`);

  // Settings
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Positions
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT UNIQUE NOT NULL
  )`);

  // Committees
  db.run(`CREATE TABLE IF NOT EXISTS committees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
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
    email TEXT,
    address TEXT,
    photo_url TEXT,
    school_year TEXT NOT NULL,
    date_joined TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Active', -- Active, Inactive, Suspended, Alumni
    expiration_date TEXT,
    parent_name TEXT,
    parent_contact TEXT,
    qr_token TEXT UNIQUE NOT NULL,
    qr_status TEXT NOT NULL DEFAULT 'Active'
  )`);

  // Officer History
  db.run(`CREATE TABLE IF NOT EXISTS officer_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    position TEXT NOT NULL,
    committee TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'Active'
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
    location TEXT NOT NULL,
    organizer TEXT NOT NULL,
    allowed_participants TEXT NOT NULL DEFAULT 'ALL', -- ALL, OFFICERS, POSITIONS, COMMITTEES, SELECTED
    participant_filter TEXT, -- JSON string or comma-separated list
    status TEXT NOT NULL DEFAULT 'Active' -- Upcoming, Active, Completed, Cancelled
  )`);

  // Attendance Records
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time_in TEXT NOT NULL,
    time_out TEXT,
    status TEXT NOT NULL, -- Present, Late, Absent, Excused
    FOREIGN KEY(event_id) REFERENCES events(id),
    FOREIGN KEY(student_id) REFERENCES students(student_id),
    UNIQUE(event_id, student_id)
  )`);

  // Excused Absences
  db.run(`CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT NOT NULL,
    date TEXT NOT NULL
  )`);

  // Audit Logs
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Default Settings Seed
  const defaultSettings = [
    ['school_name', 'ABC National High School'],
    ['school_logo', 'https://via.placeholder.com/100?text=School+Logo'],
    ['organization_name', 'Supreme Student Government'],
    ['club_name', 'Computer Club'],
    ['club_adviser', 'Mr. John Doe'],
    ['school_address', '123 Education Way, Knowledge City'],
    ['contact_info', 'adviser@school.edu.ph | (02) 8911-2345'],
    ['school_year', '2026–2027'],
    ['club_description', 'Empowering students through technology and innovation.'],
    ['late_threshold_mins', '15'],
    ['min_participation_pct', '75']
  ];
  defaultSettings.forEach(([k, v]) => {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  });

  // Default Positions Seed
  const defaultPositions = [
    'President', 'Vice President', 'Secretary', 'Assistant Secretary',
    'Treasurer', 'Assistant Treasurer', 'Auditor', 'Public Information Officer',
    'Peace Officer', 'Sergeant-at-Arms', 'Representative', 'Committee Head',
    'Committee Member', 'Member'
  ];
  defaultPositions.forEach(pos => {
    db.run(`INSERT OR IGNORE INTO positions (title) VALUES (?)`, [pos]);
  });

  // Default Committees Seed
  const defaultCommittees = [
    'Events Committee', 'Finance Committee', 'Documentation Committee',
    'Membership Committee', 'Public Relations Committee', 'Technical Committee', 'Sports Committee'
  ];
  defaultCommittees.forEach(com => {
    db.run(`INSERT OR IGNORE INTO committees (name) VALUES (?)`, [com]);
  });

  // Default Admin User Seed
  db.get(`SELECT * FROM users WHERE username = 'admin'`, [], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync('admin123', 10);
      db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, ['admin', hash, 'admin']);
    }
  });

  // Default Scanner User Seed
  db.get(`SELECT * FROM users WHERE username = 'scanner'`, [], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync('scanner123', 10);
      db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, ['scanner', hash, 'scanner']);
    }
  });

  // Seed Initial Sample Student & Event Data if Empty
  db.get(`SELECT COUNT(*) as count FROM students`, [], (err, row) => {
    if (row && row.count === 0) {
      const token1 = 'QR-2026-001-' + Date.now();
      const token2 = 'QR-2026-002-' + Date.now();
      
      db.run(`INSERT INTO students (
        student_id, first_name, middle_name, last_name, full_name, position, club, committee,
        gender, dob, contact, email, address, photo_url, school_year, date_joined, status,
        expiration_date, parent_name, parent_contact, qr_token, qr_status
      ) VALUES 
      ('2026-001', 'Juan', 'M', 'Dela Cruz', 'Juan Dela Cruz', 'President', 'Computer Club', 'Technical Committee',
       'Male', '2008-05-15', '09171234567', 'juan@school.edu', 'Manila', '', '2026–2027', '2026-01-10', 'Active',
       '2027-03-30', 'Pedro Dela Cruz', '09170000001', ?, 'Active'),
      ('2026-002', 'Maria', 'Clara', 'Santos', 'Maria Clara Santos', 'Vice President', 'Computer Club', 'Events Committee',
       'Female', '2008-08-20', '09181234568', 'maria@school.edu', 'Quezon City', '', '2026–2027', '2026-01-10', 'Active',
       '2027-03-30', 'Rosa Santos', '09170000002', ?, 'Active')`, [token1, token2], () => {

        // Create initial logins for sample students
        const stuHash = bcrypt.hashSync('student123', 10);
        db.run(`INSERT INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)`, ['2026-001', stuHash, '2026-001']);
        db.run(`INSERT INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)`, ['2026-002', stuHash, '2026-002']);

        // Record Officer History
        db.run(`INSERT INTO officer_history (student_id, position, committee, start_date) VALUES 
          ('2026-001', 'President', 'Technical Committee', '2026-01-10'),
          ('2026-002', 'Vice President', 'Events Committee', '2026-01-10')`);

        // Sample Event
        db.run(`INSERT INTO events (name, description, type, date, start_time, end_time, location, organizer, allowed_participants, status)
          VALUES ('General Club Meeting', 'First semester kickoff meeting', 'Club Meeting', '2026-08-31', '15:00', '17:00', 'Computer Lab 1', 'Computer Club Officers', 'ALL', 'Active')`, function() {
            
            // Sample Attendance Record
            db.run(`INSERT INTO attendance (event_id, student_id, date, time_in, status) VALUES 
              (?, '2026-001', '2026-08-31', '14:55:00', 'Present')`, [this.lastID]);
          });
      });
    }
  });
});

// Helper Function: Write Audit Log
function logAudit(username, action, details) {
  db.run(`INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)`, [username || 'System', action, details || '']);
}

// Authentication Middleware
function requireAuth(role = null) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Unauthorized. Please login.' });
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden. Higher privilege required.' });
    }
    next();
  };
}

/* ==========================================================================
   API ROUTES
   ========================================================================== */

// Auth Endpoints
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Invalid username or password' });

    if (bcrypt.compareSync(password, user.password)) {
      req.session.user = { id: user.id, username: user.username, role: user.role, student_id: user.student_id };
      logAudit(user.username, 'LOGIN', `Logged in as ${user.role}`);
      return res.json({ success: true, user: req.session.user });
    }
    res.status(400).json({ error: 'Invalid username or password' });
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) logAudit(req.session.user.username, 'LOGOUT', 'User logged out');
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (req.session.user) return res.json({ user: req.session.user });
  res.status(401).json({ error: 'Not authenticated' });
});

app.post('/api/change-password', requireAuth(), (req, res) => {
  const { current_password, new_password } = req.body;
  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, user) => {
    if (!bcrypt.compareSync(current_password, user.password)) {
      return res.status(400).json({ error: 'Incorrect current password' });
    }
    const hash = bcrypt.hashSync(new_password, 10);
    db.run(`UPDATE users SET password = ? WHERE id = ?`, [hash, req.session.user.id], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update password' });
      logAudit(req.session.user.username, 'CHANGE_PASSWORD', 'Password successfully updated');
      res.json({ success: true, message: 'Password updated successfully' });
    });
  });
});

// Settings API
app.get('/api/settings', (req, res) => {
  db.all(`SELECT * FROM settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  });
});

app.post('/api/settings', requireAuth('admin'), (req, res) => {
  const updates = req.body;
  const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  Object.keys(updates).forEach(key => {
    stmt.run(key, String(updates[key]));
  });
  stmt.finalize();
  logAudit(req.session.user.username, 'UPDATE_SETTINGS', 'Updated system configurations');
  res.json({ success: true });
});

// Positions & Committees API
app.get('/api/positions', (req, res) => {
  db.all(`SELECT * FROM positions ORDER BY id ASC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/positions', requireAuth('admin'), (req, res) => {
  const { title } = req.body;
  db.run(`INSERT INTO positions (title) VALUES (?)`, [title], function(err) {
    if (err) return res.status(400).json({ error: 'Position already exists' });
    logAudit(req.session.user.username, 'ADD_POSITION', `Added position ${title}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/positions/:id', requireAuth('admin'), (req, res) => {
  db.run(`DELETE FROM positions WHERE id = ?`, [req.params.id], function(err) {
    logAudit(req.session.user.username, 'DELETE_POSITION', `Deleted position ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.get('/api/committees', (req, res) => {
  db.all(`SELECT * FROM committees ORDER BY id ASC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/committees', requireAuth('admin'), (req, res) => {
  const { name } = req.body;
  db.run(`INSERT INTO committees (name) VALUES (?)`, [name], function(err) {
    if (err) return res.status(400).json({ error: 'Committee already exists' });
    logAudit(req.session.user.username, 'ADD_COMMITTEE', `Added committee ${name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/committees/:id', requireAuth('admin'), (req, res) => {
  db.run(`DELETE FROM committees WHERE id = ?`, [req.params.id], function(err) {
    logAudit(req.session.user.username, 'DELETE_COMMITTEE', `Deleted committee ID ${req.params.id}`);
    res.json({ success: true });
  });
});

// Student Management API
app.get('/api/students', requireAuth(), (req, res) => {
  db.all(`SELECT * FROM students ORDER BY full_name ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/students/:student_id', requireAuth(), (req, res) => {
  db.get(`SELECT * FROM students WHERE student_id = ?`, [req.params.student_id], (err, student) => {
    if (err || !student) return res.status(404).json({ error: 'Student not found' });
    res.json(student);
  });
});

app.post('/api/students', requireAuth('admin'), upload.single('photo'), async (req, res) => {
  const b = req.body;
  
  // Check student_id uniqueness
  db.get(`SELECT student_id FROM students WHERE student_id = ?`, [b.student_id], (err, row) => {
    if (row) return res.status(400).json({ error: 'Student ID already exists.' });

    const fullName = `${b.first_name} ${b.middle_name ? b.middle_name + ' ' : ''}${b.last_name}`;
    const qrToken = 'QR-' + b.student_id + '-' + Date.now();
    const photoUrl = req.file ? '/uploads/' + req.file.filename : '';

    const sql = `INSERT INTO students (
      student_id, first_name, middle_name, last_name, full_name, position, club, committee,
      gender, dob, contact, email, address, photo_url, school_year, date_joined, status,
      expiration_date, parent_name, parent_contact, qr_token, qr_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`;

    const params = [
      b.student_id, b.first_name, b.middle_name, b.last_name, fullName, b.position, b.club, b.committee,
      b.gender, b.dob, b.contact, b.email, b.address, photoUrl, b.school_year, b.date_joined, b.status || 'Active',
      b.expiration_date, b.parent_name, b.parent_contact, qrToken
    ];

    db.run(sql, params, function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Auto-create student portal login credentials
      const studentPass = bcrypt.hashSync(b.student_id, 10);
      db.run(`INSERT OR REPLACE INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)`, [b.student_id, studentPass, b.student_id]);

      // Record Officer History
      db.run(`INSERT INTO officer_history (student_id, position, committee, start_date) VALUES (?, ?, ?, ?)`,
        [b.student_id, b.position, b.committee, b.date_joined]);

      logAudit(req.session.user.username, 'CREATE_STUDENT', `Created student ${b.student_id} - ${fullName}`);
      res.json({ success: true, student_id: b.student_id, qr_token: qrToken });
    });
  });
});

app.put('/api/students/:student_id', requireAuth('admin'), upload.single('photo'), (req, res) => {
  const b = req.body;
  const sid = req.params.student_id;
  
  db.get(`SELECT * FROM students WHERE student_id = ?`, [sid], (err, existing) => {
    if (!existing) return res.status(404).json({ error: 'Student not found' });

    const fullName = `${b.first_name} ${b.middle_name ? b.middle_name + ' ' : ''}${b.last_name}`;
    const photoUrl = req.file ? '/uploads/' + req.file.filename : existing.photo_url;

    const sql = `UPDATE students SET
      first_name=?, middle_name=?, last_name=?, full_name=?, position=?, club=?, committee=?,
      gender=?, dob=?, contact=?, email=?, address=?, photo_url=?, school_year=?, status=?,
      expiration_date=?, parent_name=?, parent_contact=?
      WHERE student_id=?`;

    const params = [
      b.first_name, b.middle_name, b.last_name, fullName, b.position, b.club, b.committee,
      b.gender, b.dob, b.contact, b.email, b.address, photoUrl, b.school_year, b.status,
      b.expiration_date, b.parent_name, b.parent_contact, sid
    ];

    db.run(sql, params, function(err) {
      if (err) return res.status(500).json({ error: err.message });

      // Track officer history if position changed
      if (existing.position !== b.position || existing.committee !== b.committee) {
        const today = new Date().toISOString().split('T')[0];
        db.run(`UPDATE officer_history SET end_date = ?, status = 'Transferred' WHERE student_id = ? AND status = 'Active'`, [today, sid]);
        db.run(`INSERT INTO officer_history (student_id, position, committee, start_date) VALUES (?, ?, ?, ?)`, [sid, b.position, b.committee, today]);
      }

      logAudit(req.session.user.username, 'UPDATE_STUDENT', `Updated student ${sid}`);
      res.json({ success: true });
    });
  });
});

app.delete('/api/students/:student_id', requireAuth('admin'), (req, res) => {
  const sid = req.params.student_id;
  db.run(`DELETE FROM students WHERE student_id = ?`, [sid], (err) => {
    db.run(`DELETE FROM users WHERE student_id = ?`, [sid]);
    logAudit(req.session.user.username, 'DELETE_STUDENT', `Deleted student ${sid}`);
    res.json({ success: true });
  });
});

// QR Code API
app.get('/api/qr/image/:token', async (req, res) => {
  try {
    const qrDataUrl = await QRCode.toDataURL(req.params.token, { margin: 1, width: 250 });
    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    const img = Buffer.from(base64Data, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
    res.end(img);
  } catch (err) {
    res.status(500).send('Error generating QR image');
  }
});

app.post('/api/students/:student_id/regenerate-qr', requireAuth('admin'), (req, res) => {
  const sid = req.params.student_id;
  const newToken = 'QR-' + sid + '-' + Date.now();
  db.run(`UPDATE students SET qr_token = ?, qr_status = 'Active' WHERE student_id = ?`, [newToken, sid], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to regenerate QR' });
    logAudit(req.session.user.username, 'REGENERATE_QR', `Regenerated QR token for ${sid}`);
    res.json({ success: true, qr_token: newToken });
  });
});

app.post('/api/students/:student_id/toggle-qr', requireAuth('admin'), (req, res) => {
  const sid = req.params.student_id;
  const { status } = req.body; // Active or Disabled
  db.run(`UPDATE students SET qr_status = ? WHERE student_id = ?`, [status, sid], (err) => {
    logAudit(req.session.user.username, 'TOGGLE_QR', `Set QR status for ${sid} to ${status}`);
    res.json({ success: true });
  });
});

// Event Management API
app.get('/api/events', requireAuth(), (req, res) => {
  db.all(`SELECT * FROM events ORDER BY date DESC, start_time DESC`, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/events', requireAuth('admin'), (req, res) => {
  const b = req.body;
  const sql = `INSERT INTO events (name, description, type, date, start_time, end_time, location, organizer, allowed_participants, participant_filter, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const filterStr = typeof b.participant_filter === 'object' ? JSON.stringify(b.participant_filter) : b.participant_filter;
  db.run(sql, [b.name, b.description, b.type, b.date, b.start_time, b.end_time, b.location, b.organizer, b.allowed_participants || 'ALL', filterStr, b.status || 'Active'], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'CREATE_EVENT', `Created event: ${b.name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/events/:id', requireAuth('admin'), (req, res) => {
  const b = req.body;
  const filterStr = typeof b.participant_filter === 'object' ? JSON.stringify(b.participant_filter) : b.participant_filter;
  const sql = `UPDATE events SET name=?, description=?, type=?, date=?, start_time=?, end_time=?, location=?, organizer=?, allowed_participants=?, participant_filter=?, status=? WHERE id=?`;
  db.run(sql, [b.name, b.description, b.type, b.date, b.start_time, b.end_time, b.location, b.organizer, b.allowed_participants, filterStr, b.status, req.params.id], (err) => {
    logAudit(req.session.user.username, 'UPDATE_EVENT', `Updated event ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/events/:id', requireAuth('admin'), (req, res) => {
  db.run(`DELETE FROM events WHERE id = ?`, [req.params.id], (err) => {
    db.run(`DELETE FROM attendance WHERE event_id = ?`, [req.params.id]);
    logAudit(req.session.user.username, 'DELETE_EVENT', `Deleted event ID ${req.params.id}`);
    res.json({ success: true });
  });
});

// Attendance & Scanner Engine Endpoint
app.post('/api/scan', requireAuth(), (req, res) => {
  const { qr_token, event_id, scan_mode } = req.body; // scan_mode = 'IN' or 'OUT'

  if (!qr_token || !event_id) {
    return res.status(400).json({ status: 'INVALID', message: 'Invalid payload.' });
  }

  // Verify Event
  db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
    if (!event || event.status === 'Cancelled') {
      return res.status(400).json({ status: 'INVALID', message: 'Event inactive or not found.' });
    }

    // Verify QR & Student
    db.get(`SELECT * FROM students WHERE qr_token = ?`, [qr_token], (err, student) => {
      if (err || !student) {
        return res.json({ status: 'INVALID', message: 'Invalid QR code.' });
      }

      if (student.qr_status !== 'Active' || student.status !== 'Active') {
        return res.json({ status: 'DISABLED', message: 'Student ID or QR Code is disabled/inactive.', student });
      }

      // Check Allowed Participants
      let isAllowed = true;
      if (event.allowed_participants === 'OFFICERS') {
        const officerPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor', 'Public Information Officer', 'Peace Officer', 'Committee Head'];
        if (!officerPositions.includes(student.position)) isAllowed = false;
      } else if (event.allowed_participants === 'POSITIONS' && event.participant_filter) {
        const allowed = event.participant_filter.split(',');
        if (!allowed.includes(student.position)) isAllowed = false;
      } else if (event.allowed_participants === 'COMMITTEES' && event.participant_filter) {
        const allowed = event.participant_filter.split(',');
        if (!allowed.includes(student.committee)) isAllowed = false;
      } else if (event.allowed_participants === 'SELECTED' && event.participant_filter) {
        const allowed = event.participant_filter.split(',');
        if (!allowed.includes(student.student_id)) isAllowed = false;
      }

      if (!isAllowed) {
        return res.json({ status: 'NOT_ALLOWED', message: 'Student not eligible for this event.', student });
      }

      // Check Existing Attendance
      db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student.student_id], (err, record) => {
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        const dateStr = now.toISOString().split('T')[0];

        if (scan_mode === 'IN') {
          if (record) {
            return res.json({ status: 'DUPLICATE', message: `${student.full_name}, you are already recorded.`, student, record });
          }

          // Calculate Present vs Late
          db.get(`SELECT value FROM settings WHERE key = 'late_threshold_mins'`, [], (err, settingRow) => {
            const thresholdMins = parseInt(settingRow ? settingRow.value : '15');
            const [eHour, eMin] = event.start_time.split(':').map(Number);
            const eventStartTime = new Date();
            eventStartTime.setHours(eHour, eMin, 0, 0);

            const lateTimeThreshold = new Date(eventStartTime.getTime() + thresholdMins * 60000);
            const status = now > lateTimeThreshold ? 'Late' : 'Present';

            db.run(`INSERT INTO attendance (event_id, student_id, date, time_in, status) VALUES (?, ?, ?, ?, ?)`,
              [event_id, student.student_id, dateStr, timeStr, status], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                logAudit(req.session.user.username, 'ATTENDANCE_IN', `Scanned IN: ${student.student_id} for Event ${event_id}`);
                return res.json({
                  status: 'SUCCESS',
                  mode: 'IN',
                  attendance_status: status,
                  message: `${student.full_name}, attendance recorded.`,
                  student,
                  time: timeStr
                });
              });
          });

        } else if (scan_mode === 'OUT') {
          if (!record) {
            return res.json({ status: 'NO_IN', message: `${student.full_name} has not scanned TIME IN yet.`, student });
          }
          if (record.time_out) {
            return res.json({ status: 'DUPLICATE_OUT', message: `${student.full_name}, time out already recorded.`, student, record });
          }

          db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [timeStr, record.id], (err) => {
            logAudit(req.session.user.username, 'ATTENDANCE_OUT', `Scanned OUT: ${student.student_id} for Event ${event_id}`);
            return res.json({
              status: 'SUCCESS',
              mode: 'OUT',
              attendance_status: record.status,
              message: `${student.full_name}, time out recorded.`,
              student,
              time: timeStr
            });
          });
        }
      });
    });
  });
});

// Attendance Records Management Endpoints
app.get('/api/attendance', requireAuth(), (req, res) => {
  const sql = `
    SELECT a.*, s.full_name, s.position, s.club, s.committee, s.photo_url, e.name as event_name 
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.id DESC`;
  db.all(sql, [], (err, rows) => res.json(rows || []));
});

app.put('/api/attendance/:id', requireAuth('admin'), (req, res) => {
  const { status, time_in, time_out } = req.body;
  db.run(`UPDATE attendance SET status = ?, time_in = ?, time_out = ? WHERE id = ?`, [status, time_in, time_out, req.params.id], (err) => {
    logAudit(req.session.user.username, 'EDIT_ATTENDANCE', `Edited attendance record ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/attendance/:id', requireAuth('admin'), (req, res) => {
  db.run(`DELETE FROM attendance WHERE id = ?`, [req.params.id], (err) => {
    logAudit(req.session.user.username, 'DELETE_ATTENDANCE', `Deleted attendance record ID ${req.params.id}`);
    res.json({ success: true });
  });
});

// Excused Absences Endpoints
app.post('/api/excuses', requireAuth('admin'), (req, res) => {
  const { event_id, student_id, reason, notes } = req.body;
  const dateStr = new Date().toISOString().split('T')[0];
  const approved_by = req.session.user.username;

  db.run(`INSERT OR REPLACE INTO attendance (event_id, student_id, date, time_in, status) VALUES (?, ?, ?, 'EXCUSED', 'Excused')`, [event_id, student_id, dateStr]);
  db.run(`INSERT INTO excuses (event_id, student_id, reason, notes, approved_by, date) VALUES (?, ?, ?, ?, ?, ?)`,
    [event_id, student_id, reason, notes, approved_by, dateStr], (err) => {
      logAudit(approved_by, 'EXCUSE_STUDENT', `Excused student ${student_id} for event ${event_id}`);
      res.json({ success: true });
    });
});

// Dashboard & Analytics Endpoints
app.get('/api/dashboard/stats', requireAuth(), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  
  const stats = {
    total_members: 0,
    active_members: 0,
    total_officers: 0,
    present_today: 0,
    late_today: 0,
    absent_today: 0,
    excused_today: 0,
    attendance_rate: '0%',
    active_event: null,
    upcoming_events: [],
    recent_scans: []
  };

  db.get(`SELECT COUNT(*) as cnt FROM students`, [], (e, r) => {
    stats.total_members = r ? r.cnt : 0;
    db.get(`SELECT COUNT(*) as cnt FROM students WHERE status = 'Active'`, [], (e, r2) => {
      stats.active_members = r2 ? r2.cnt : 0;
      db.get(`SELECT COUNT(*) as cnt FROM students WHERE position != 'Member'`, [], (e, r3) => {
        stats.total_officers = r3 ? r3.cnt : 0;

        db.get(`SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1`, [], (e, activeEv) => {
          stats.active_event = activeEv || null;

          const activeEvId = activeEv ? activeEv.id : 0;
          db.all(`SELECT status, COUNT(*) as cnt FROM attendance WHERE event_id = ? GROUP BY status`, [activeEvId], (e, attCounts) => {
            if (attCounts) {
              attCounts.forEach(c => {
                if (c.status === 'Present') stats.present_today = c.cnt;
                if (c.status === 'Late') stats.late_today = c.cnt;
                if (c.status === 'Absent') stats.absent_today = c.cnt;
                if (c.status === 'Excused') stats.excused_today = c.cnt;
              });
            }

            const totalRecorded = stats.present_today + stats.late_today + stats.absent_today + stats.excused_today;
            const positiveAtt = stats.present_today + stats.late_today;
            stats.attendance_rate = totalRecorded > 0 ? Math.round((positiveAtt / totalRecorded) * 100) + '%' : '0%';

            db.all(`SELECT * FROM events WHERE date >= ? ORDER BY date ASC LIMIT 5`, [today], (e, upEv) => {
              stats.upcoming_events = upEv || [];

              const recentSql = `
                SELECT a.*, s.full_name, s.position, s.photo_url 
                FROM attendance a 
                JOIN students s ON a.student_id = s.student_id 
                ORDER BY a.id DESC LIMIT 8`;
              db.all(recentSql, [], (e, recScans) => {
                stats.recent_scans = recScans || [];
                res.json(stats);
              });
            });
          });
        });
      });
    });
  });
});

app.get('/api/analytics', requireAuth(), (req, res) => {
  db.get(`SELECT value FROM settings WHERE key = 'min_participation_pct'`, [], (err, settingRow) => {
    const minParticipation = parseFloat(settingRow ? settingRow.value : '75');

    const sql = `
      SELECT 
        s.student_id, s.full_name, s.position, s.committee, s.photo_url,
        COUNT(a.id) as total_scans,
        SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) as present_count,
        SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) as late_count,
        SUM(CASE WHEN a.status = 'Excused' THEN 1 ELSE 0 END) as excused_count
      FROM students s
      LEFT JOIN attendance a ON s.student_id = a.student_id
      GROUP BY s.student_id`;

    db.all(sql, [], (err, rows) => {
      db.get(`SELECT COUNT(*) as total_events FROM events WHERE status != 'Cancelled'`, [], (err, evRow) => {
        const totalEvents = evRow ? evRow.total_events || 1 : 1;

        const memberAnalytics = (rows || []).map(m => {
          const attended = (m.present_count || 0) + (m.late_count || 0) + (m.excused_count || 0);
          const pct = Math.round((attended / (totalEvents || 1)) * 100);
          return {
            ...m,
            total_events: totalEvents,
            attended,
            absent_count: Math.max(0, totalEvents - attended),
            participation_pct: Math.min(100, pct)
          };
        });

        const lowParticipation = memberAnalytics.filter(m => m.participation_pct < minParticipation);
        const frequentlyLate = memberAnalytics.filter(m => (m.late_count || 0) >= 2);
        const topActive = [...memberAnalytics].sort((a, b) => b.participation_pct - a.participation_pct).slice(0, 5);

        res.json({
          all: memberAnalytics,
          low_participation: lowParticipation,
          frequently_late: frequentlyLate,
          top_active: topActive
        });
      });
    });
  });
});

// Audit Logs & System Maintenance Endpoints
app.get('/api/audit-logs', requireAuth('admin'), (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200`, [], (err, rows) => res.json(rows || []));
});

app.get('/api/backup', requireAuth('admin'), (req, res) => {
  db.all(`SELECT name FROM sqlite_master WHERE type='table'`, [], (err, tables) => {
    const backupData = {};
    let completed = 0;
    tables.forEach(t => {
      const tableName = t.name;
      if (tableName === 'sqlite_sequence') {
        completed++;
        return;
      }
      db.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
        backupData[tableName] = rows;
        completed++;
        if (completed >= tables.length) {
          res.setHeader('Content-disposition', 'attachment; filename=club_attendance_backup_' + Date.now() + '.json');
          res.setHeader('Content-type', 'application/json');
          res.send(JSON.stringify(backupData, null, 2));
        }
      });
    });
  });
});

app.post('/api/restore', requireAuth('admin'), (req, res) => {
  const backupData = req.body;
  if (!backupData || typeof backupData !== 'object') {
    return res.status(400).json({ error: 'Invalid backup format' });
  }

  db.serialize(() => {
    Object.keys(backupData).forEach(tableName => {
      db.run(`DELETE FROM ${tableName}`);
      const rows = backupData[tableName];
      if (rows && rows.length > 0) {
        const keys = Object.keys(rows[0]);
        const placeholders = keys.map(() => '?').join(',');
        const stmt = db.prepare(`INSERT INTO ${tableName} (${keys.join(',')}) VALUES (${placeholders})`);
        rows.forEach(r => stmt.run(Object.values(r)));
        stmt.finalize();
      }
    });
    logAudit(req.session.user.username, 'RESTORE_DATABASE', 'Restored system database from JSON file');
    res.json({ success: true });
  });
});

/* ==========================================================================
   MONOLITHIC SINGLE-PAGE APPLICATION FRONTEND (HTML + CSS + JS)
   ========================================================================== */

app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Club QR Attendance System</title>
  <!-- Tailwind CSS & FontAwesome CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <!-- HTML5-QRCode Scanner Library -->
  <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <style>
    @media print {
      body * { visibility: hidden; }
      #printable-area, #printable-area * { visibility: visible; }
      #printable-area { position: absolute; left: 0; top: 0; width: 100%; }
      .no-print { display: none !important; }
    }
    .a4-page {
      width: 210mm;
      min-height: 297mm;
      padding: 10mm;
      margin: 0 auto;
      background: white;
      box-sizing: border-box;
    }
    .id-card-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      grid-gap: 8mm;
    }
    .id-card {
      width: 85.6mm;
      height: 54mm;
      border: 1px dashed #999;
      border-radius: 8px;
      padding: 6px;
      position: relative;
      box-sizing: border-box;
      background: linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%);
    }
  </style>
</head>
<body class="bg-gray-100 font-sans text-gray-800">

  <!-- TOP NAVIGATION BAR -->
  <nav class="bg-indigo-900 text-white shadow-md no-print">
    <div class="max-w-7xl mx-auto px-4 flex justify-between items-center h-16">
      <div class="flex items-center space-x-3 cursor-pointer" onclick="navTo('dashboard')">
        <i class="fa-solid fa-qrcode text-yellow-400 text-2xl"></i>
        <span class="font-bold text-lg tracking-wide" id="nav-brand">Club QR Attendance</span>
      </div>
      <div id="nav-user-menu" class="flex items-center space-x-4 text-sm">
        <!-- Dynamic Menu Injected Here -->
      </div>
    </div>
  </nav>

  <!-- MAIN CONTAINER -->
  <main class="max-w-7xl mx-auto p-4 sm:p-6">

    <!-- LOGIN SECTION -->
    <div id="view-login" class="max-w-md mx-auto my-12 bg-white p-8 rounded-xl shadow-lg border border-gray-200">
      <div class="text-center mb-6">
        <i class="fa-solid fa-graduation-cap text-indigo-700 text-5xl mb-2"></i>
        <h2 class="text-2xl font-bold text-gray-800" id="login-school-title">School Club Portal</h2>
        <p class="text-gray-500 text-sm">QR Code Attendance Management System</p>
      </div>
      <form id="form-login" onsubmit="handleLogin(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Username / Student ID</label>
          <input type="text" id="login-username" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none">
        </div>
        <div>
          <label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Password</label>
          <input type="password" id="login-password" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none">
        </div>
        <button type="submit" class="w-full bg-indigo-700 hover:bg-indigo-800 text-white py-2.5 rounded-lg font-bold transition">Login to System</button>
      </form>
      <div class="mt-6 p-4 bg-indigo-50 rounded-lg text-xs text-gray-600 border border-indigo-100">
        <p class="font-bold text-indigo-900 mb-1">Default Demo Credentials:</p>
        <p><strong>Admin:</strong> admin / admin123</p>
        <p><strong>Scanner:</strong> scanner / scanner123</p>
        <p><strong>Student:</strong> 2026-001 / student123</p>
      </div>
    </div>

    <!-- ADMIN DASHBOARD VIEW -->
    <div id="view-dashboard" class="hidden space-y-6">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-800" id="dash-club-title">Dashboard</h1>
          <p class="text-gray-500 text-sm" id="dash-school-sub">Overview of club participation & events</p>
        </div>
        <div class="flex space-x-2">
          <button onclick="navTo('scanner')" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2">
            <i class="fa-solid fa-camera"></i> Open Scanner
          </button>
          <button onclick="navTo('id-print')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2">
            <i class="fa-solid fa-print"></i> Print ID Cards
          </button>
        </div>
      </div>

      <!-- KPI Metrics Row -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-indigo-600">
          <p class="text-xs text-gray-500 uppercase font-semibold">Total Members</p>
          <h3 class="text-2xl font-extrabold text-indigo-900" id="stat-members">0</h3>
        </div>
        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-green-500">
          <p class="text-xs text-gray-500 uppercase font-semibold">Active Members</p>
          <h3 class="text-2xl font-extrabold text-green-700" id="stat-active">0</h3>
        </div>
        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-yellow-500">
          <p class="text-xs text-gray-500 uppercase font-semibold">Club Officers</p>
          <h3 class="text-2xl font-extrabold text-yellow-700" id="stat-officers">0</h3>
        </div>
        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-blue-500">
          <p class="text-xs text-gray-500 uppercase font-semibold">Attendance Rate</p>
          <h3 class="text-2xl font-extrabold text-blue-700" id="stat-rate">0%</h3>
        </div>
      </div>

      <!-- Active Event Metrics -->
      <div class="bg-gradient-to-r from-indigo-800 to-indigo-900 text-white p-6 rounded-xl shadow">
        <div class="flex justify-between items-center mb-4">
          <div>
            <span class="bg-yellow-400 text-indigo-950 font-bold px-2 py-0.5 rounded text-xs">CURRENT ACTIVE EVENT</span>
            <h2 class="text-xl font-bold mt-1" id="dash-active-event-name">No Active Event</h2>
          </div>
          <span class="text-sm bg-indigo-700 px-3 py-1 rounded-full" id="dash-active-event-loc">--</span>
        </div>
        <div class="grid grid-cols-4 gap-2 text-center border-t border-indigo-700/50 pt-4">
          <div><p class="text-xs opacity-75">Present</p><p class="text-xl font-bold text-green-400" id="dash-pres">0</p></div>
          <div><p class="text-xs opacity-75">Late</p><p class="text-xl font-bold text-yellow-300" id="dash-late">0</p></div>
          <div><p class="text-xs opacity-75">Absent</p><p class="text-xl font-bold text-red-300" id="dash-abs">0</p></div>
          <div><p class="text-xs opacity-75">Excused</p><p class="text-xl font-bold text-blue-300" id="dash-exc">0</p></div>
        </div>
      </div>

      <!-- Live Feed & Upcoming Events Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-white p-5 rounded-xl shadow">
          <h3 class="font-bold text-gray-800 mb-4 flex items-center gap-2"><i class="fa-solid fa-bolt text-yellow-500"></i> Live Attendance Feed</h3>
          <div class="space-y-3 overflow-y-auto max-h-80" id="dash-live-feed">
            <p class="text-gray-400 text-sm">No recent scans recorded today.</p>
          </div>
        </div>

        <div class="bg-white p-5 rounded-xl shadow">
          <h3 class="font-bold text-gray-800 mb-4 flex items-center gap-2"><i class="fa-solid fa-calendar-day text-indigo-600"></i> Upcoming Club Events</h3>
          <div class="space-y-3" id="dash-upcoming-events">
            <p class="text-gray-400 text-sm">No upcoming events scheduled.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- MEMBERS MANAGEMENT VIEW -->
    <div id="view-members" class="hidden space-y-4">
      <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold text-gray-800">Student Club Members</h1>
        <button onclick="openStudentModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2">
          <i class="fa-solid fa-user-plus"></i> Add Member
        </button>
      </div>

      <!-- Search & Filters -->
      <div class="bg-white p-4 rounded-xl shadow flex flex-wrap gap-3">
        <input type="text" id="filter-search" oninput="renderMembersTable()" placeholder="Search Student ID or Name..." class="px-3 py-2 border rounded-lg text-sm flex-1 min-w-[200px]">
        <select id="filter-position" onchange="renderMembersTable()" class="px-3 py-2 border rounded-lg text-sm"><option value="">All Positions</option></select>
        <select id="filter-committee" onchange="renderMembersTable()" class="px-3 py-2 border rounded-lg text-sm"><option value="">All Committees</option></select>
        <select id="filter-status" onchange="renderMembersTable()" class="px-3 py-2 border rounded-lg text-sm">
          <option value="">All Statuses</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="Suspended">Suspended</option>
          <option value="Alumni">Alumni</option>
        </select>
      </div>

      <!-- Members Data Table -->
      <div class="bg-white rounded-xl shadow overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-gray-100 border-b text-xs font-semibold text-gray-600 uppercase">
              <th class="p-3">Student</th>
              <th class="p-3">Student ID</th>
              <th class="p-3">Position</th>
              <th class="p-3">Committee</th>
              <th class="p-3">Status</th>
              <th class="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody id="members-table-body" class="divide-y text-sm">
            <!-- Dynamic Member Rows -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- EVENTS MANAGEMENT VIEW -->
    <div id="view-events" class="hidden space-y-4">
      <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold text-gray-800">Club Event Management</h1>
        <button onclick="openEventModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2">
          <i class="fa-solid fa-calendar-plus"></i> Create Event
        </button>
      </div>

      <div class="bg-white rounded-xl shadow overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-gray-100 border-b text-xs font-semibold text-gray-600 uppercase">
              <th class="p-3">Event Name</th>
              <th class="p-3">Type</th>
              <th class="p-3">Date & Time</th>
              <th class="p-3">Location</th>
              <th class="p-3">Participants</th>
              <th class="p-3">Status</th>
              <th class="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody id="events-table-body" class="divide-y text-sm">
            <!-- Dynamic Events Rows -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- ATTENDANCE RECORDS VIEW -->
    <div id="view-attendance" class="hidden space-y-4">
      <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold text-gray-800">Attendance Log Records</h1>
        <div class="flex space-x-2">
          <button onclick="openExcuseModal()" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-sm font-semibold">
            <i class="fa-solid fa-file-signature"></i> Add Excuse
          </button>
          <button onclick="exportAttendanceCSV()" class="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded-lg text-sm font-semibold">
            <i class="fa-solid fa-file-csv"></i> Export CSV
          </button>
        </div>
      </div>

      <div class="bg-white rounded-xl shadow overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-gray-100 border-b text-xs font-semibold text-gray-600 uppercase">
              <th class="p-3">Student Name</th>
              <th class="p-3">Position</th>
              <th class="p-3">Event</th>
              <th class="p-3">Date</th>
              <th class="p-3">Time In</th>
              <th class="p-3">Time Out</th>
              <th class="p-3">Status</th>
              <th class="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody id="attendance-table-body" class="divide-y text-sm">
            <!-- Dynamic Attendance Rows -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- REPORTS & ANALYTICS VIEW -->
    <div id="view-reports" class="hidden space-y-6">
      <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold text-gray-800">Participation Reports & Analytics</h1>
        <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2">
          <i class="fa-solid fa-print"></i> Print Full Summary Report
        </button>
      </div>

      <!-- Printable Report Container -->
      <div id="printable-area" class="space-y-6">
        <div class="hidden print:block text-center border-b pb-4 mb-4">
          <h1 id="rep-print-school" class="text-xl font-bold">School Name</h1>
          <h2 id="rep-print-club" class="text-lg font-semibold text-indigo-900">Club Name</h2>
          <p class="text-xs text-gray-500">Official Club Attendance & Member Participation Summary Report</p>
        </div>

        <!-- Ranking & Alerts Grid -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <!-- Top Active Members -->
          <div class="bg-white p-5 rounded-xl shadow">
            <h3 class="font-bold text-green-700 mb-3 flex items-center gap-2"><i class="fa-solid fa-trophy"></i> Most Active Members</h3>
            <div id="rep-top-active" class="space-y-2 text-sm"></div>
          </div>
          <!-- Low Participation Alert -->
          <div class="bg-white p-5 rounded-xl shadow">
            <h3 class="font-bold text-red-600 mb-3 flex items-center gap-2"><i class="fa-solid fa-triangle-exclamation"></i> Low Participation Alert</h3>
            <div id="rep-low-part" class="space-y-2 text-sm"></div>
          </div>
          <!-- Frequently Late -->
          <div class="bg-white p-5 rounded-xl shadow">
            <h3 class="font-bold text-yellow-600 mb-3 flex items-center gap-2"><i class="fa-solid fa-clock"></i> Frequently Late Members</h3>
            <div id="rep-freq-late" class="space-y-2 text-sm"></div>
          </div>
        </div>

        <!-- Full Participation Table -->
        <div class="bg-white rounded-xl shadow p-5">
          <h3 class="font-bold text-gray-800 mb-4">Complete Member Attendance Participation Matrix</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="bg-gray-100 border-b text-xs font-semibold text-gray-600 uppercase">
                  <th class="p-3">Student Name</th>
                  <th class="p-3">Position</th>
                  <th class="p-3">Committee</th>
                  <th class="p-3">Attended</th>
                  <th class="p-3">Late</th>
                  <th class="p-3">Absent</th>
                  <th class="p-3">Excused</th>
                  <th class="p-3">Rate %</th>
                </tr>
              </thead>
              <tbody id="rep-matrix-body" class="divide-y text-sm"></tbody>
            </table>
          </div>
          <div class="hidden print:block mt-8 pt-8 flex justify-between text-xs">
            <div><p class="font-bold">Prepared By:</p><p class="mt-8 border-t w-48 border-gray-400">Club Secretary / Officer</p></div>
            <div><p class="font-bold">Approved By:</p><p class="mt-8 border-t w-48 border-gray-400" id="rep-print-adviser">Club Adviser</p></div>
          </div>
        </div>
      </div>
    </div>

    <!-- SEPARATE QR SCANNER PORTAL VIEW -->
    <div id="view-scanner" class="hidden space-y-4 max-w-xl mx-auto">
      <div class="bg-white p-5 rounded-xl shadow text-center space-y-4">
        <h2 class="text-xl font-bold text-indigo-900 flex items-center justify-center gap-2">
          <i class="fa-solid fa-qrcode"></i> Mobile Scanner Portal
        </h2>

        <!-- Event & Mode Controls -->
        <div class="space-y-3 text-left">
          <div>
            <label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Select Event for Scanning</label>
            <select id="scan-event-select" class="w-full p-2.5 border rounded-lg bg-gray-50 font-semibold text-gray-800">
              <!-- Dynamic Events -->
            </select>
          </div>
          
          <div class="grid grid-cols-2 gap-3">
            <button id="btn-mode-in" onclick="setScanMode('IN')" class="py-3 rounded-lg font-bold border-2 border-green-600 bg-green-600 text-white text-center">
              TIME IN
            </button>
            <button id="btn-mode-out" onclick="setScanMode('OUT')" class="py-3 rounded-lg font-bold border-2 border-indigo-600 bg-white text-indigo-600 text-center">
              TIME OUT
            </button>
          </div>
        </div>

        <!-- Camera Scanner Region -->
        <div class="relative bg-black rounded-lg overflow-hidden min-h-[250px] flex items-center justify-center">
          <div id="reader" class="w-full"></div>
        </div>

        <div class="flex justify-between items-center text-xs text-gray-500">
          <button onclick="toggleScanner()" id="btn-toggle-cam" class="bg-gray-200 hover:bg-gray-300 px-3 py-1.5 rounded font-semibold text-gray-700">Stop Camera</button>
          <div class="flex items-center gap-1">
            <input type="checkbox" id="voice-enable" checked>
            <label for="voice-enable" class="font-semibold">Voice Announcement</label>
          </div>
        </div>
      </div>

      <!-- Scan Result Alert Box -->
      <div id="scan-result-card" class="hidden bg-white p-5 rounded-xl shadow text-center space-y-3 border-2">
        <div id="scan-status-badge" class="inline-block px-3 py-1 rounded-full text-xs font-bold uppercase"></div>
        <img id="scan-student-photo" class="w-24 h-24 rounded-full mx-auto object-cover border-2 border-indigo-500" src="" alt="Student Photo">
        <div>
          <h3 id="scan-student-name" class="text-lg font-bold text-gray-900"></h3>
          <p id="scan-student-id" class="text-sm font-semibold text-indigo-700"></p>
          <p id="scan-student-pos" class="text-xs text-gray-500"></p>
        </div>
        <div id="scan-message" class="text-sm font-semibold text-gray-700"></div>
      </div>
    </div>

    <!-- STUDENT PORTAL VIEW -->
    <div id="view-student" class="hidden space-y-6 max-w-3xl mx-auto">
      <div class="bg-indigo-900 text-white p-6 rounded-xl shadow flex flex-col md:flex-row items-center gap-6">
        <img id="stu-portal-photo" class="w-28 h-28 rounded-full border-4 border-white object-cover shadow" src="" alt="Profile">
        <div class="text-center md:text-left space-y-1">
          <h1 id="stu-portal-name" class="text-2xl font-bold">Student Name</h1>
          <p id="stu-portal-id" class="text-yellow-400 font-semibold">Student ID</p>
          <p id="stu-portal-role" class="text-sm text-indigo-200">Position | Committee</p>
        </div>
      </div>

      <!-- Digital ID & Attendance Summary Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- Digital ID Card Container -->
        <div class="bg-white p-5 rounded-xl shadow text-center space-y-3">
          <h3 class="font-bold text-gray-800 text-sm uppercase tracking-wider">Official Digital Club ID</h3>
          <div id="stu-digital-id-card" class="border-2 border-indigo-800 rounded-xl p-4 bg-gradient-to-b from-white to-indigo-50 shadow-inner">
            <p id="stu-card-school" class="text-xs font-bold text-gray-700 uppercase">School Name</p>
            <p id="stu-card-club" class="text-sm font-extrabold text-indigo-900">Computer Club</p>
            <div class="my-3 flex justify-center">
              <img id="stu-card-qr" class="w-36 h-36 border p-1 bg-white rounded shadow-sm" src="" alt="QR Token">
            </div>
            <p id="stu-card-name" class="font-bold text-gray-900">Student Name</p>
            <p id="stu-card-pos" class="text-xs font-semibold text-indigo-700">Position</p>
          </div>
          <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-bold">Print Digital ID</button>
        </div>

        <!-- Student Attendance Stats -->
        <div class="bg-white p-5 rounded-xl shadow space-y-4">
          <h3 class="font-bold text-gray-800 text-sm uppercase tracking-wider">Attendance Performance</h3>
          <div class="grid grid-cols-2 gap-3 text-center">
            <div class="bg-indigo-50 p-3 rounded-lg"><p class="text-xs text-indigo-700 font-semibold">Participation Rate</p><h4 id="stu-stat-pct" class="text-xl font-black text-indigo-900">0%</h4></div>
            <div class="bg-green-50 p-3 rounded-lg"><p class="text-xs text-green-700 font-semibold">Attended Events</p><h4 id="stu-stat-att" class="text-xl font-black text-green-900">0</h4></div>
            <div class="bg-yellow-50 p-3 rounded-lg"><p class="text-xs text-yellow-700 font-semibold">Late Scans</p><h4 id="stu-stat-late" class="text-xl font-black text-yellow-900">0</h4></div>
            <div class="bg-red-50 p-3 rounded-lg"><p class="text-xs text-red-700 font-semibold">Absences</p><h4 id="stu-stat-abs" class="text-xl font-black text-red-900">0</h4></div>
          </div>
          <div>
            <h4 class="font-bold text-xs text-gray-600 uppercase mb-2">My Attendance Logs</h4>
            <div id="stu-attendance-logs" class="space-y-2 max-h-48 overflow-y-auto text-xs"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- A4 8-ID PRINT MATRIX VIEW -->
    <div id="view-id-print" class="hidden space-y-4 no-print">
      <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold text-gray-800">Batch Printable Student Club IDs</h1>
        <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2">
          <i class="fa-solid fa-print"></i> Print A4 Pages (8 IDs / Page)
        </button>
      </div>

      <!-- Printable A4 Container Engine -->
      <div id="printable-area">
        <div id="a4-pages-container" class="space-y-8">
          <!-- Dynamic A4 Pages populated with 8 IDs each -->
        </div>
      </div>
    </div>

    <!-- SYSTEM SETTINGS VIEW -->
    <div id="view-settings" class="hidden space-y-6 max-w-3xl mx-auto">
      <h1 class="text-2xl font-bold text-gray-800">System & School Settings</h1>

      <form id="form-settings" onsubmit="saveSettings(event)" class="bg-white p-6 rounded-xl shadow space-y-4">
        <h3 class="font-bold text-indigo-900 border-b pb-2">School & Club Branding</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label class="block text-xs font-semibold uppercase text-gray-600 mb-1">School Name</label><input type="text" id="set-school_name" class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Organization Name</label><input type="text" id="set-organization_name" class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Club Name</label><input type="text" id="set-club_name" class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Club Adviser</label><input type="text" id="set-club_adviser" class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold uppercase text-gray-600 mb-1">School Year</label><input type="text" id="set-school_year" class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold uppercase text-gray-600 mb-1">Late Threshold (Mins)</label><input type="number" id="set-late_threshold_mins" class="w-full p-2 border rounded"></div>
        </div>
        <button type="submit" class="bg-indigo-600 text-white px-6 py-2 rounded-lg font-bold">Save System Settings</button>
      </form>

      <!-- Backup & Restore Panel -->
      <div class="bg-white p-6 rounded-xl shadow space-y-4">
        <h3 class="font-bold text-indigo-900 border-b pb-2">Database Maintenance</h3>
        <div class="flex gap-4">
          <a href="/api/backup" download class="bg-green-600 text-white px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2">
            <i class="fa-solid fa-download"></i> Download Database Backup
          </a>
          <label class="bg-blue-600 text-white px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 cursor-pointer">
            <i class="fa-solid fa-upload"></i> Restore Database
            <input type="file" onchange="restoreBackup(event)" class="hidden" accept=".json">
          </label>
        </div>
      </div>
    </div>

  </main>

  <!-- STUDENT MODAL -->
  <div id="modal-student" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
    <div class="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4">
      <h2 id="modal-student-title" class="text-xl font-bold text-indigo-900">Register Student Member</h2>
      <form id="form-student" onsubmit="saveStudent(event)" class="space-y-4">
        <input type="hidden" id="stu-edit-id">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div><label class="block text-xs font-semibold text-gray-600">Student ID *</label><input type="text" id="form-stu-id" required class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold text-gray-600">First Name *</label><input type="text" id="form-stu-fname" required class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold text-gray-600">Last Name *</label><input type="text" id="form-stu-lname" required class="w-full p-2 border rounded"></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label class="block text-xs font-semibold text-gray-600">Position *</label>
            <select id="form-stu-position" required class="w-full p-2 border rounded"></select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600">Committee *</label>
            <select id="form-stu-committee" required class="w-full p-2 border rounded"></select>
          </div>
          <div><label class="block text-xs font-semibold text-gray-600">School Year *</label><input type="text" id="form-stu-sy" value="2026–2027" required class="w-full p-2 border rounded"></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label class="block text-xs font-semibold text-gray-600">Student Photo</label><input type="file" id="form-stu-photo" accept="image/*" class="w-full p-1 border rounded text-xs"></div>
          <div><label class="block text-xs font-semibold text-gray-600">Date Joined *</label><input type="date" id="form-stu-joined" required class="w-full p-2 border rounded"></div>
        </div>
        <div class="flex justify-end space-x-2 pt-4 border-t">
          <button type="button" onclick="closeStudentModal()" class="px-4 py-2 border rounded text-sm font-semibold">Cancel</button>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm font-bold">Save Student</button>
        </div>
      </form>
    </div>
  </div>

  <!-- EVENT MODAL -->
  <div id="modal-event" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
    <div class="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
      <h2 id="modal-event-title" class="text-xl font-bold text-indigo-900">Create Club Event</h2>
      <form id="form-event" onsubmit="saveEvent(event)" class="space-y-3">
        <input type="hidden" id="event-edit-id">
        <div><label class="block text-xs font-semibold text-gray-600">Event Name *</label><input type="text" id="form-ev-name" required class="w-full p-2 border rounded"></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block text-xs font-semibold text-gray-600">Event Type *</label><input type="text" id="form-ev-type" placeholder="e.g., General Meeting" required class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold text-gray-600">Date *</label><input type="date" id="form-ev-date" required class="w-full p-2 border rounded"></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block text-xs font-semibold text-gray-600">Start Time *</label><input type="time" id="form-ev-start" required class="w-full p-2 border rounded"></div>
          <div><label class="block text-xs font-semibold text-gray-600">End Time *</label><input type="time" id="form-ev-end" required class="w-full p-2 border rounded"></div>
        </div>
        <div><label class="block text-xs font-semibold text-gray-600">Location *</label><input type="text" id="form-ev-loc" required class="w-full p-2 border rounded"></div>
        <div class="flex justify-end space-x-2 pt-4 border-t">
          <button type="button" onclick="closeEventModal()" class="px-4 py-2 border rounded text-sm font-semibold">Cancel</button>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm font-bold">Save Event</button>
        </div>
      </form>
    </div>
  </div>

  <!-- CLIENT-SIDE MONOLITHIC LOGIC ENGINE -->
  <script>
    let currentUser = null;
    let systemSettings = {};
    let globalStudents = [];
    let globalEvents = [];
    let html5QrScanner = null;
    let currentScanMode = 'IN';

    // App Initialization
    window.addEventListener('DOMContentLoaded', async () => {
      await loadSettings();
      await checkAuth();
    });

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        systemSettings = await res.json();
        document.getElementById('login-school-title').innerText = systemSettings.club_name || 'School Club Portal';
        document.getElementById('nav-brand').innerText = systemSettings.club_name || 'Club QR Attendance';
      } catch (err) { console.error(err); }
    }

    async function checkAuth() {
      try {
        const res = await fetch('/api/me');
        if (res.ok) {
          const data = await res.json();
          currentUser = data.user;
          renderNav();
          if (currentUser.role === 'student') {
            navTo('student');
          } else if (currentUser.role === 'scanner') {
            navTo('scanner');
          } else {
            navTo('dashboard');
          }
        } else {
          renderNav();
          navTo('login');
        }
      } catch (err) {
        navTo('login');
      }
    }

    function renderNav() {
      const container = document.getElementById('nav-user-menu');
      if (!currentUser) {
        container.innerHTML = \`<span class="text-xs text-indigo-200">Please Login</span>\`;
        return;
      }

      let links = '';
      if (currentUser.role === 'admin') {
        links = \`
          <button onclick="navTo('dashboard')" class="hover:text-yellow-300">Dashboard</button>
          <button onclick="navTo('members')" class="hover:text-yellow-300">Members</button>
          <button onclick="navTo('events')" class="hover:text-yellow-300">Events</button>
          <button onclick="navTo('attendance')" class="hover:text-yellow-300">Logs</button>
          <button onclick="navTo('reports')" class="hover:text-yellow-300">Reports</button>
          <button onclick="navTo('settings')" class="hover:text-yellow-300">Settings</button>
        \`;
      }
      
      links += \`
        <span class="bg-indigo-800 px-2 py-1 rounded text-xs font-semibold">\${currentUser.username} (\${currentUser.role})</span>
        <button onclick="handleLogout()" class="text-red-300 hover:text-red-100 font-bold"><i class="fa-solid fa-right-from-bracket"></i></button>
      \`;
      container.innerHTML = links;
    }

    function navTo(viewId) {
      const views = ['login', 'dashboard', 'members', 'events', 'attendance', 'reports', 'scanner', 'student', 'id-print', 'settings'];
      views.forEach(v => {
        const el = document.getElementById('view-' + v);
        if (el) el.classList.add('hidden');
      });

      const target = document.getElementById('view-' + viewId);
      if (target) target.classList.remove('hidden');

      if (viewId === 'dashboard') loadDashboardData();
      if (viewId === 'members') loadMembersData();
      if (viewId === 'events') loadEventsData();
      if (viewId === 'attendance') loadAttendanceData();
      if (viewId === 'reports') loadReportsData();
      if (viewId === 'scanner') initScannerView();
      if (viewId === 'student') loadStudentPortalData();
      if (viewId === 'id-print') generateA4IDCards();
      if (viewId === 'settings') loadSettingsView();
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
      if (res.ok) {
        currentUser = data.user;
        renderNav();
        if (currentUser.role === 'student') navTo('student');
        else if (currentUser.role === 'scanner') navTo('scanner');
        else navTo('dashboard');
      } else {
        alert(data.error || 'Login failed');
      }
    }

    async function handleLogout() {
      await fetch('/api/logout', { method: 'POST' });
      currentUser = null;
      renderNav();
      navTo('login');
    }

    // Dashboard Data Loader
    async function loadDashboardData() {
      document.getElementById('dash-club-title').innerText = systemSettings.club_name || 'Club Dashboard';
      document.getElementById('dash-school-sub').innerText = \`\${systemSettings.school_name || 'School'} | S.Y. \${systemSettings.school_year || '2026-2027'}\`;

      const res = await fetch('/api/dashboard/stats');
      const stats = await res.json();

      document.getElementById('stat-members').innerText = stats.total_members;
      document.getElementById('stat-active').innerText = stats.active_members;
      document.getElementById('stat-officers').innerText = stats.total_officers;
      document.getElementById('stat-rate').innerText = stats.attendance_rate;

      if (stats.active_event) {
        document.getElementById('dash-active-event-name').innerText = stats.active_event.name;
        document.getElementById('dash-active-event-loc').innerText = stats.active_event.location;
      } else {
        document.getElementById('dash-active-event-name').innerText = 'No Active Event';
        document.getElementById('dash-active-event-loc').innerText = '--';
      }

      document.getElementById('dash-pres').innerText = stats.present_today;
      document.getElementById('dash-late').innerText = stats.late_today;
      document.getElementById('dash-abs').innerText = stats.absent_today;
      document.getElementById('dash-exc').innerText = stats.excused_today;

      // Render Live Feed
      const feedBox = document.getElementById('dash-live-feed');
      if (stats.recent_scans.length === 0) {
        feedBox.innerHTML = \`<p class="text-gray-400 text-sm">No recent scans recorded today.</p>\`;
      } else {
        feedBox.innerHTML = stats.recent_scans.map(s => \`
          <div class="flex items-center justify-between p-2 bg-gray-50 rounded border">
            <div class="flex items-center space-x-3">
              <div class="w-8 h-8 rounded-full bg-indigo-100 text-indigo-800 font-bold flex items-center justify-center text-xs">
                \${s.full_name.charAt(0)}
              </div>
              <div>
                <p class="font-bold text-xs text-gray-800">\${s.full_name}</p>
                <p class="text-[10px] text-gray-500">\${s.position}</p>
              </div>
            </div>
            <div class="text-right">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold \${s.status==='Present'?'bg-green-100 text-green-800':'bg-yellow-100 text-yellow-800'}">\${s.status}</span>
              <p class="text-[10px] text-gray-400">\${s.time_in}</p>
            </div>
          </div>
        \`).join('');
      }
    }

    // Members Data Loader
    async function loadMembersData() {
      const res = await fetch('/api/students');
      globalStudents = await res.json();

      // Populate position & committee dropdown filters
      const posRes = await fetch('/api/positions');
      const positions = await posRes.json();
      const comRes = await fetch('/api/committees');
      const committees = await comRes.json();

      const posFilter = document.getElementById('filter-position');
      posFilter.innerHTML = '<option value="">All Positions</option>' + positions.map(p => \`<option value="\${p.title}">\${p.title}</option>\`).join('');

      const comFilter = document.getElementById('filter-committee');
      comFilter.innerHTML = '<option value="">All Committees</option>' + committees.map(c => \`<option value="\${c.name}">\${c.name}</option>\`).join('');

      renderMembersTable();
    }

    function renderMembersTable() {
      const search = document.getElementById('filter-search').value.toLowerCase();
      const pos = document.getElementById('filter-position').value;
      const com = document.getElementById('filter-committee').value;
      const stat = document.getElementById('filter-status').value;

      const filtered = globalStudents.filter(s => {
        const matchSearch = s.full_name.toLowerCase().includes(search) || s.student_id.toLowerCase().includes(search);
        const matchPos = !pos || s.position === pos;
        const matchCom = !com || s.committee === com;
        const matchStat = !stat || s.status === stat;
        return matchSearch && matchPos && matchCom && matchStat;
      });

      const body = document.getElementById('members-table-body');
      body.innerHTML = filtered.map(s => \`
        <tr class="hover:bg-gray-50">
          <td class="p-3 font-semibold text-gray-800 flex items-center gap-2">
            <img class="w-8 h-8 rounded-full object-cover border" src="\${s.photo_url || 'https://via.placeholder.com/50'}" alt="">
            \${s.full_name}
          </td>
          <td class="p-3 font-mono text-xs">\${s.student_id}</td>
          <td class="p-3">\${s.position}</td>
          <td class="p-3 text-xs text-gray-600">\${s.committee}</td>
          <td class="p-3"><span class="px-2 py-0.5 rounded text-xs font-bold \${s.status==='Active'?'bg-green-100 text-green-800':'bg-red-100 text-red-800'}">\${s.status}</span></td>
          <td class="p-3 text-right space-x-1">
            <button onclick="regenerateQR('\${s.student_id}')" title="Regenerate QR" class="p-1.5 bg-yellow-100 text-yellow-800 rounded hover:bg-yellow-200 text-xs"><i class="fa-solid fa-sync"></i></button>
            <button onclick="deleteStudent('\${s.student_id}')" title="Delete" class="p-1.5 bg-red-100 text-red-800 rounded hover:bg-red-200 text-xs"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>
      \`).join('');
    }

    async function openStudentModal() {
      document.getElementById('modal-student').classList.remove('hidden');
      document.getElementById('form-student').reset();

      const posRes = await fetch('/api/positions');
      const positions = await posRes.json();
      document.getElementById('form-stu-position').innerHTML = positions.map(p => \`<option value="\${p.title}">\${p.title}</option>\`).join('');

      const comRes = await fetch('/api/committees');
      const committees = await comRes.json();
      document.getElementById('form-stu-committee').innerHTML = committees.map(c => \`<option value="\${c.name}">\${c.name}</option>\`).join('');
    }

    function closeStudentModal() {
      document.getElementById('modal-student').classList.add('hidden');
    }

    async function saveStudent(e) {
      e.preventDefault();
      const formData = new FormData();
      formData.append('student_id', document.getElementById('form-stu-id').value);
      formData.append('first_name', document.getElementById('form-stu-fname').value);
      formData.append('last_name', document.getElementById('form-stu-lname').value);
      formData.append('position', document.getElementById('form-stu-position').value);
      formData.append('committee', document.getElementById('form-stu-committee').value);
      formData.append('club', systemSettings.club_name || 'Computer Club');
      formData.append('school_year', document.getElementById('form-stu-sy').value);
      formData.append('date_joined', document.getElementById('form-stu-joined').value);

      const fileInput = document.getElementById('form-stu-photo');
      if (fileInput.files[0]) formData.append('photo', fileInput.files[0]);

      const res = await fetch('/api/students', { method: 'POST', body: formData });
      if (res.ok) {
        closeStudentModal();
        loadMembersData();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to save student');
      }
    }

    async function regenerateQR(studentId) {
      if (!confirm('Regenerating QR code will invalidate the previous code. Proceed?')) return;
      await fetch(\`/api/students/\${studentId}/regenerate-qr\`, { method: 'POST' });
      alert('QR code regenerated successfully');
      loadMembersData();
    }

    async function deleteStudent(studentId) {
      if (!confirm('Are you sure you want to delete this student member?')) return;
      await fetch(\`/api/students/\${studentId}\`, { method: 'DELETE' });
      loadMembersData();
    }

    // Events Loader & Modal
    async function loadEventsData() {
      const res = await fetch('/api/events');
      globalEvents = await res.json();

      const body = document.getElementById('events-table-body');
      body.innerHTML = globalEvents.map(e => \`
        <tr class="hover:bg-gray-50">
          <td class="p-3 font-bold text-gray-800">\${e.name}</td>
          <td class="p-3 text-xs">\${e.type}</td>
          <td class="p-3 text-xs font-mono">\${e.date} (\${e.start_time} - \${e.end_time})</td>
          <td class="p-3 text-xs">\${e.location}</td>
          <td class="p-3 text-xs font-semibold text-indigo-700">\${e.allowed_participants}</td>
          <td class="p-3"><span class="px-2 py-0.5 rounded text-xs font-bold \${e.status==='Active'?'bg-green-100 text-green-800':'bg-gray-100 text-gray-800'}">\${e.status}</span></td>
          <td class="p-3 text-right">
            <button onclick="deleteEvent(\${e.id})" class="p-1.5 bg-red-100 text-red-800 rounded hover:bg-red-200 text-xs"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>
      \`).join('');
    }

    function openEventModal() {
      document.getElementById('modal-event').classList.remove('hidden');
      document.getElementById('form-event').reset();
    }

    function closeEventModal() {
      document.getElementById('modal-event').classList.add('hidden');
    }

    async function saveEvent(e) {
      e.preventDefault();
      const payload = {
        name: document.getElementById('form-ev-name').value,
        type: document.getElementById('form-ev-type').value,
        date: document.getElementById('form-ev-date').value,
        start_time: document.getElementById('form-ev-start').value,
        end_time: document.getElementById('form-ev-end').value,
        location: document.getElementById('form-ev-loc').value,
        organizer: systemSettings.club_name || 'Club Officers',
        allowed_participants: 'ALL',
        status: 'Active'
      };

      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        closeEventModal();
        loadEventsData();
      }
    }

    async function deleteEvent(id) {
      if (!confirm('Delete this event?')) return;
      await fetch(\`/api/events/\${id}\`, { method: 'DELETE' });
      loadEventsData();
    }

    // Attendance Log Loader
    async function loadAttendanceData() {
      const res = await fetch('/api/attendance');
      const rows = await res.json();

      const body = document.getElementById('attendance-table-body');
      body.innerHTML = rows.map(r => \`
        <tr class="hover:bg-gray-50">
          <td class="p-3 font-semibold text-gray-800">\${r.full_name}</td>
          <td class="p-3 text-xs text-gray-500">\${r.position}</td>
          <td class="p-3 font-bold text-indigo-900 text-xs">\${r.event_name}</td>
          <td class="p-3 text-xs font-mono">\${r.date}</td>
          <td class="p-3 text-xs font-mono">\${r.time_in || '--'}</td>
          <td class="p-3 text-xs font-mono">\${r.time_out || '--'}</td>
          <td class="p-3"><span class="px-2 py-0.5 rounded text-xs font-bold \${r.status==='Present'?'bg-green-100 text-green-800':'bg-yellow-100 text-yellow-800'}">\${r.status}</span></td>
          <td class="p-3 text-right">
            <button onclick="deleteAttendance(\${r.id})" class="p-1 bg-red-100 text-red-800 rounded hover:bg-red-200 text-xs"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>
      \`).join('');
    }

    async function deleteAttendance(id) {
      if (!confirm('Delete this attendance log record?')) return;
      await fetch(\`/api/attendance/\${id}\`, { method: 'DELETE' });
      loadAttendanceData();
    }

    // Reports Engine
    async function loadReportsData() {
      const res = await fetch('/api/analytics');
      const data = await res.json();

      document.getElementById('rep-print-school').innerText = systemSettings.school_name || 'School Name';
      document.getElementById('rep-print-club').innerText = systemSettings.club_name || 'Club Name';
      document.getElementById('rep-print-adviser').innerText = systemSettings.club_adviser || 'Club Adviser';

      // Render Top Active
      document.getElementById('rep-top-active').innerHTML = data.top_active.map((m, i) => \`
        <div class="flex justify-between items-center p-2 bg-green-50 rounded">
          <span><strong>\${i+1}.</strong> \${m.full_name}</span>
          <span class="font-bold text-green-800">\${m.participation_pct}%</span>
        </div>
      \`).join('');

      // Render Low Participation
      document.getElementById('rep-low-part').innerHTML = data.low_participation.length ? data.low_participation.map(m => \`
        <div class="flex justify-between items-center p-2 bg-red-50 rounded text-red-900">
          <span>\${m.full_name}</span>
          <span class="font-bold text-red-700">\${m.participation_pct}%</span>
        </div>
      \`).join('') : '<p class="text-xs text-gray-400">No low participation alerts.</p>';

      // Render Frequently Late
      document.getElementById('rep-freq-late').innerHTML = data.frequently_late.length ? data.frequently_late.map(m => \`
        <div class="flex justify-between items-center p-2 bg-yellow-50 rounded text-yellow-900">
          <span>\${m.full_name}</span>
          <span class="font-bold text-yellow-700">\${m.late_count} Times Late</span>
        </div>
      \`).join('') : '<p class="text-xs text-gray-400">No late warnings.</p>';

      // Full Matrix
      document.getElementById('rep-matrix-body').innerHTML = data.all.map(m => \`
        <tr>
          <td class="p-3 font-semibold text-gray-800">\${m.full_name}</td>
          <td class="p-3">\${m.position}</td>
          <td class="p-3">\${m.committee}</td>
          <td class="p-3 text-green-700 font-bold">\${m.attended}</td>
          <td class="p-3 text-yellow-600 font-bold">\${m.late_count || 0}</td>
          <td class="p-3 text-red-600 font-bold">\${m.absent_count}</td>
          <td class="p-3 text-blue-600 font-bold">\${m.excused_count || 0}</td>
          <td class="p-3 font-black text-indigo-900">\${m.participation_pct}%</td>
        </tr>
      \`).join('');
    }

    // Scanner View Engine & Web Speech API Voice synthesis
    async function initScannerView() {
      const res = await fetch('/api/events');
      const events = await res.json();
      const select = document.getElementById('scan-event-select');

      select.innerHTML = events.map(e => \`<option value="\${e.id}">\${e.name} (\${e.date})</option>\`).join('');

      startScanner();
    }

    function setScanMode(mode) {
      currentScanMode = mode;
      const btnIn = document.getElementById('btn-mode-in');
      const btnOut = document.getElementById('btn-mode-out');

      if (mode === 'IN') {
        btnIn.className = "py-3 rounded-lg font-bold border-2 border-green-600 bg-green-600 text-white text-center";
        btnOut.className = "py-3 rounded-lg font-bold border-2 border-indigo-600 bg-white text-indigo-600 text-center";
      } else {
        btnOut.className = "py-3 rounded-lg font-bold border-2 border-green-600 bg-green-600 text-white text-center";
        btnIn.className = "py-3 rounded-lg font-bold border-2 border-indigo-600 bg-white text-indigo-600 text-center";
      }
    }

    function startScanner() {
      if (html5QrScanner) return;

      html5QrScanner = new Html5Qrcode("reader");
      html5QrScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        onScanSuccess
      ).catch(err => console.error("Camera error:", err));
    }

    function toggleScanner() {
      if (html5QrScanner) {
        html5QrScanner.stop().then(() => {
          html5QrScanner = null;
          document.getElementById('btn-toggle-cam').innerText = "Start Camera";
        });
      } else {
        startScanner();
        document.getElementById('btn-toggle-cam').innerText = "Stop Camera";
      }
    }

    async function onScanSuccess(decodedText) {
      const eventId = document.getElementById('scan-event-select').value;
      if (!eventId) {
        alert("Please select an event before scanning.");
        return;
      }

      // Temporarily pause scanner processing
      if (html5QrScanner) html5QrScanner.pause();

      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_mode: currentScanMode })
      });

      const data = await res.json();
      showScanResult(data);

      // Voice Speech Synthesis
      if (document.getElementById('voice-enable').checked && 'speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(data.message);
        utterance.rate = 0.95;
        window.speechSynthesis.speak(utterance);
      }

      setTimeout(() => {
        if (html5QrScanner) html5QrScanner.resume();
      }, 3000);
    }

    function showScanResult(data) {
      const card = document.getElementById('scan-result-card');
      const badge = document.getElementById('scan-status-badge');
      card.classList.remove('hidden');

      if (data.status === 'SUCCESS') {
        card.className = "bg-white p-5 rounded-xl shadow text-center space-y-3 border-2 border-green-500";
        badge.className = "inline-block px-3 py-1 rounded-full text-xs font-bold uppercase bg-green-100 text-green-800";
        badge.innerText = "ATTENDANCE RECORDED - " + data.attendance_status;
      } else if (data.status === 'DUPLICATE' || data.status === 'DUPLICATE_OUT') {
        card.className = "bg-white p-5 rounded-xl shadow text-center space-y-3 border-2 border-yellow-500";
        badge.className = "inline-block px-3 py-1 rounded-full text-xs font-bold uppercase bg-yellow-100 text-yellow-800";
        badge.innerText = "ALREADY RECORDED";
      } else {
        card.className = "bg-white p-5 rounded-xl shadow text-center space-y-3 border-2 border-red-500";
        badge.className = "inline-block px-3 py-1 rounded-full text-xs font-bold uppercase bg-red-100 text-red-800";
        badge.innerText = "INVALID SCAN";
      }

      if (data.student) {
        document.getElementById('scan-student-photo').src = data.student.photo_url || 'https://via.placeholder.com/100';
        document.getElementById('scan-student-name').innerText = data.student.full_name;
        document.getElementById('scan-student-id').innerText = data.student.student_id;
        document.getElementById('scan-student-pos').innerText = data.student.position + ' | ' + data.student.committee;
      } else {
        document.getElementById('scan-student-name').innerText = "Unknown Student";
        document.getElementById('scan-student-id').innerText = "";
        document.getElementById('scan-student-pos').innerText = "";
      }

      document.getElementById('scan-message').innerText = data.message;
    }

    // Student Portal View Engine
    async function loadStudentPortalData() {
      const res = await fetch('/api/students/' + currentUser.student_id);
      const student = await res.json();

      document.getElementById('stu-portal-photo').src = student.photo_url || 'https://via.placeholder.com/100';
      document.getElementById('stu-portal-name').innerText = student.full_name;
      document.getElementById('stu-portal-id').innerText = 'ID: ' + student.student_id;
      document.getElementById('stu-portal-role').innerText = student.position + ' | ' + student.committee;

      // Digital Card Setup
      document.getElementById('stu-card-school').innerText = systemSettings.school_name || 'School Name';
      document.getElementById('stu-card-club').innerText = systemSettings.club_name || 'Club Name';
      document.getElementById('stu-card-qr').src = '/api/qr/image/' + student.qr_token;
      document.getElementById('stu-card-name').innerText = student.full_name;
      document.getElementById('stu-card-pos').innerText = student.position;

      // Analytics
      const anRes = await fetch('/api/analytics');
      const analytics = await anRes.json();
      const myStats = analytics.all.find(m => m.student_id === student.student_id);

      if (myStats) {
        document.getElementById('stu-stat-pct').innerText = myStats.participation_pct + '%';
        document.getElementById('stu-stat-att').innerText = myStats.attended;
        document.getElementById('stu-stat-late').innerText = myStats.late_count || 0;
        document.getElementById('stu-stat-abs').innerText = myStats.absent_count;
      }
    }

    // A4 8-ID Card Matrix Generator
    async function generateA4IDCards() {
      const res = await fetch('/api/students');
      const students = await res.json();
      const container = document.getElementById('a4-pages-container');

      const pageSize = 8;
      const totalPages = Math.ceil(students.length / pageSize);
      let html = '';

      for (let p = 0; p < totalPages; p++) {
        const pageStudents = students.slice(p * pageSize, (p + 1) * pageSize);
        html += \`
          <div class="a4-page shadow-lg">
            <div class="id-card-grid">
              \${pageStudents.map(s => \`
                <div class="id-card flex flex-col justify-between">
                  <div class="flex items-center justify-between border-b pb-1">
                    <div>
                      <p class="text-[9px] font-bold text-gray-700 uppercase leading-none">\${systemSettings.school_name || 'School'}</p>
                      <p class="text-[11px] font-extrabold text-indigo-900 leading-none">\${systemSettings.club_name || 'Club'}</p>
                    </div>
                    <span class="text-[8px] bg-indigo-100 text-indigo-800 px-1 font-bold rounded">S.Y. \${s.school_year}</span>
                  </div>
                  <div class="flex items-center space-x-2 my-1">
                    <img class="w-12 h-12 rounded-full border object-cover" src="\${s.photo_url || 'https://via.placeholder.com/50'}">
                    <div class="overflow-hidden">
                      <p class="text-[11px] font-extrabold text-gray-900 truncate leading-tight">\${s.full_name}</p>
                      <p class="text-[9px] font-bold text-indigo-700 leading-tight">\${s.position}</p>
                      <p class="text-[8px] text-gray-500 leading-tight">\${s.committee}</p>
                      <p class="text-[8px] font-mono text-gray-600 mt-0.5">ID: \${s.student_id}</p>
                    </div>
                  </div>
                  <div class="flex items-center justify-between border-t pt-1">
                    <div class="text-[7px] text-gray-400">Official Student ID</div>
                    <img class="w-8 h-8" src="/api/qr/image/\${s.qr_token}">
                  </div>
                </div>
              \`).join('')}
            </div>
          </div>
        \`;
      }
      container.innerHTML = html;
    }

    // Settings & Maintenance
    async function loadSettingsView() {
      const res = await fetch('/api/settings');
      const data = await res.json();
      Object.keys(data).forEach(k => {
        const input = document.getElementById('set-' + k);
        if (input) input.value = data[k];
      });
    }

    async function saveSettings(e) {
      e.preventDefault();
      const payload = {
        school_name: document.getElementById('set-school_name').value,
        organization_name: document.getElementById('set-organization_name').value,
        club_name: document.getElementById('set-club_name').value,
        club_adviser: document.getElementById('set-club_adviser').value,
        school_year: document.getElementById('set-school_year').value,
        late_threshold_mins: document.getElementById('set-late_threshold_mins').value
      };

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        alert('Settings saved successfully');
        loadSettings();
      }
    }

    async function restoreBackup(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const backupData = JSON.parse(evt.target.result);
        const res = await fetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backupData)
        });
        if (res.ok) {
          alert('Database restored successfully');
          window.location.reload();
        }
      };
      reader.readAsText(file);
    }

    function exportAttendanceCSV() {
      window.open('/api/attendance', '_blank');
    }
  </script>
</body>
</html>`);
});

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`School Club QR Attendance System running on port ${PORT}`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
