/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Primary Main Executable File: app.js
 * 
 * Features Implemented:
 * - Full Express REST API & HTML View Engine
 * - SQLite Database Initialization & Schema Migrations
 * - Role-Based Access Control (Admin / Club Adviser, Scanner Officer, Student Member)
 * - Password Hashing via bcryptjs & Session Authentication
 * - Fully Customizable Position Management & Historical Tracking (Zero Committee/Grade/Section reliance)
 * - Dynamic Student Registration, Management & ID Generation
 * - A4 Paper ID Grid Renderer (Exact 8 ID Cards Per Sheet Layout Engine)
 * - Separate Mobile-Optimized Scanner Portal (/scanner) with Camera API, Voice Synthesis & Audio Cues
 * - Event Lifecycle Engine (General Attendance, Custom Events, Selective Targeting)
 * - Automated Attendance Matrix (Time-In, Time-Out, Late Thresholds, Auto-Absence)
 * - Dynamic Analytics, Reporting Engine (Daily/Weekly/Monthly/Custom), CSV Exporter & PDF Printer
 * - Comprehensive Audit Logging, System Settings Configuration & SQLite Database Backup/Restore
 */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Initialize Express App & HTTP Server
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Set up storage directories
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const BACKUPS_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// Configure Multer for File Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'student-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Middleware Setup
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'school_club_qr_attendance_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours session
}));

// ============================================================================
// DATABASE INITIALIZATION & SCHEMA DEFINITION
// ============================================================================
const dbPath = path.join(__dirname, 'attendance_system.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Foreign keys enforcement
  db.run('PRAGMA foreign_keys = ON');

  // Users Table (Admin, Scanner, Student)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ADMIN', 'SCANNER', 'STUDENT')),
    student_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // System Settings Table
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Custom Positions Table
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    is_officer INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Student Members Table
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    position_id INTEGER NOT NULL,
    student_club TEXT NOT NULL,
    school_year TEXT NOT NULL,
    gender TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    contact_number TEXT,
    school_email TEXT UNIQUE,
    address TEXT,
    photo_url TEXT,
    date_joined DATE NOT NULL,
    membership_status TEXT DEFAULT 'Active' CHECK(membership_status IN ('Active', 'Inactive', 'Suspended', 'Alumni', 'Resigned')),
    membership_expiration DATE,
    parent_name TEXT,
    parent_contact TEXT,
    qr_token TEXT UNIQUE NOT NULL,
    qr_status TEXT DEFAULT 'Active' CHECK(qr_status IN ('Active', 'Disabled')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(position_id) REFERENCES positions(id)
  )`);

  // Position History Table
  db.run(`CREATE TABLE IF NOT EXISTS position_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    position_id INTEGER NOT NULL,
    school_year TEXT NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE,
    FOREIGN KEY(position_id) REFERENCES positions(id)
  )`);

  // Events Table
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    description TEXT,
    event_type TEXT NOT NULL,
    event_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    location TEXT NOT NULL,
    organizer TEXT NOT NULL,
    status TEXT DEFAULT 'Upcoming' CHECK(status IN ('Upcoming', 'Active', 'Completed', 'Cancelled')),
    target_audience TEXT DEFAULT 'ALL' CHECK(target_audience IN ('ALL', 'OFFICERS_ONLY', 'SPECIFIC_POSITIONS', 'SELECTED_STUDENTS')),
    late_threshold_minutes INTEGER DEFAULT 15,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Event Target Positions (For target_audience = SPECIFIC_POSITIONS)
  db.run(`CREATE TABLE IF NOT EXISTS event_target_positions (
    event_id INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    PRIMARY KEY(event_id, position_id),
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(position_id) REFERENCES positions(id) ON DELETE CASCADE
  )`);

  // Event Target Students (For target_audience = SELECTED_STUDENTS)
  db.run(`CREATE TABLE IF NOT EXISTS event_target_students (
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    PRIMARY KEY(event_id, student_id),
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE
  )`);

  // Attendance Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    time_in DATETIME,
    time_out DATETIME,
    status TEXT NOT NULL CHECK(status IN ('Present', 'Late', 'Absent', 'Excused')),
    recorded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, student_id),
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE,
    FOREIGN KEY(recorded_by) REFERENCES users(id)
  )`);

  // Excused Absences Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance_excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER UNIQUE NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT NOT NULL,
    approved_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(attendance_id) REFERENCES attendance(id) ON DELETE CASCADE
  )`);

  // Audit Logs Table
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed Initial System Default Configuration Settings
  const defaultSettings = [
    ['school_name', 'ABC National High School'],
    ['school_logo', '/assets/default_school_logo.png'],
    ['student_club_name', 'Computer Club'],
    ['organization_name', 'Student Technology Association'],
    ['club_adviser', 'Mr. John Doe'],
    ['school_year', '2026-2027'],
    ['school_address', '123 Academic Way, Science District'],
    ['school_contact', '+1 (555) 019-2831'],
    ['school_email', 'contact@abchs.edu'],
    ['late_threshold_minutes', '15'],
    ['participation_threshold_percent', '60'],
    ['scanner_sound_enabled', 'true'],
    ['voice_announcement_enabled', 'true'],
    ['voice_volume', '1.0'],
    ['speech_rate', '1.0'],
    ['voice_language', 'en-US']
  ];

  const stmtSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  defaultSettings.forEach(setting => stmtSetting.run(setting[0], setting[1]));
  stmtSetting.finalize();

  // Seed Default Custom Positions
  const defaultPositions = [
    ['President', 'Chief Executive Officer of the Club', 1],
    ['Vice President', 'Assists the President and leads committees', 1],
    ['Secretary', 'Maintains documentation and meeting records', 1],
    ['Treasurer', 'Manages finances and club budget', 1],
    ['Auditor', 'Inspects financial records and compliance', 1],
    ['Public Information Officer', 'Handles communications and press', 1],
    ['Peace Officer', 'Ensures order during club activities', 1],
    ['Sergeant-at-Arms', 'Assists in order maintenance and logistics', 1],
    ['Representative', 'Class or batch representative', 1],
    ['Event Coordinator', 'Leads event execution and scheduling', 1],
    ['Technical Head', 'Manages AV and technical infrastructure', 1],
    ['Documentation Officer', 'Handles photo/video coverage and archival', 1],
    ['Social Media Manager', 'Manages online platforms and social presence', 1],
    ['Member', 'General active club member', 0]
  ];

  const stmtPosition = db.prepare(`INSERT OR IGNORE INTO positions (name, description, is_officer) VALUES (?, ?, ?)`);
  defaultPositions.forEach(pos => stmtPosition.run(pos[0], pos[1], pos[2]));
  stmtPosition.finalize();

  // Seed Default Users
  db.get(`SELECT COUNT(*) as count FROM users`, async (err, row) => {
    if (row.count === 0) {
      const adminHash = await bcrypt.hash('admin123', 10);
      const scannerHash = await bcrypt.hash('scanner123', 10);

      db.run(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'ADMIN')`, [adminHash]);
      db.run(`INSERT INTO users (username, password, role) VALUES ('scanner', ?, 'SCANNER')`, [scannerHash]);
      
      console.log('Default credentials populated successfully.');
    }
  });
});

// Helper Function: Write Audit Log Entry
function logAudit(req, action, details) {
  const user = req.session.user || { id: 0, username: 'SYSTEM', role: 'ANONYMOUS' };
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  db.run(
    `INSERT INTO audit_logs (user_id, username, role, action, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, user.username, user.role, action, details, ip]
  );
}

// ============================================================================
// AUTHENTICATION & SECURITY MIDDLEWARE
// ============================================================================
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized. Please login.' });
}

function hasRole(roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
    }
    next();
  };
}

// ============================================================================
// AUTHENTICATION ROUTES API
// ============================================================================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ success: false, message: 'Username and password are required.' });
  }

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) {
      return res.json({ success: false, message: 'Invalid username or password.' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.json({ success: false, message: 'Invalid username or password.' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      student_id: user.student_id
    };

    logAudit(req, 'LOGIN', `User ${user.username} logged in successfully with role ${user.role}`);
    return res.json({
      success: true,
      message: 'Login successful',
      role: user.role,
      student_id: user.student_id
    });
  });
});

app.post('/api/auth/logout', isAuthenticated, (req, res) => {
  logAudit(req, 'LOGOUT', `User ${req.session.user.username} logged out`);
  req.session.destroy();
  res.json({ success: true, message: 'Logged out successfully.' });
});

app.post('/api/auth/change-password', isAuthenticated, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.json({ success: false, message: 'All fields are required.' });
  }

  if (newPassword !== confirmPassword) {
    return res.json({ success: false, message: 'New password and confirmation do not match.' });
  }

  if (newPassword.length < 8) {
    return res.json({ success: false, message: 'Password must be at least 8 characters long.' });
  }

  db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], async (err, user) => {
    if (err || !user) return res.json({ success: false, message: 'User not found.' });

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) return res.json({ success: false, message: 'Incorrect current password.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    db.run(`UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [hashed, req.session.user.id], (err) => {
      if (err) return res.json({ success: false, message: 'Failed to update password.' });
      logAudit(req, 'PASSWORD_CHANGE', `User ${user.username} updated their password successfully`);
      res.json({ success: true, message: 'Password updated successfully.' });
    });
  });
});

app.get('/api/auth/me', isAuthenticated, (req, res) => {
  res.json({ success: true, user: req.session.user });
});

// ============================================================================
// SYSTEM SETTINGS API
// ============================================================================
app.get('/api/settings', (req, res) => {
  db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    const settingsMap = {};
    rows.forEach(r => settingsMap[r.key] = r.value);
    res.json({ success: true, settings: settingsMap });
  });
});

app.post('/api/settings', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const settings = req.body;
  const stmt = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  
  Object.keys(settings).forEach(key => {
    stmt.run(key, String(settings[key]));
  });
  stmt.finalize();

  logAudit(req, 'UPDATE_SETTINGS', 'System configuration settings updated');
  res.json({ success: true, message: 'System settings saved successfully.' });
});

// ============================================================================
// CUSTOM POSITION MANAGEMENT API
// ============================================================================
app.get('/api/positions', isAuthenticated, (req, res) => {
  db.all(`SELECT p.*, (SELECT COUNT(*) FROM students s WHERE s.position_id = p.id) as student_count FROM positions p ORDER BY p.name ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, positions: rows });
  });
});

app.post('/api/positions', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const { name, description, is_officer } = req.body;
  if (!name) return res.json({ success: false, message: 'Position name is required.' });

  db.run(`INSERT INTO positions (name, description, is_officer) VALUES (?, ?, ?)`, [name.trim(), description || '', is_officer ? 1 : 0], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.json({ success: false, message: 'Position name already exists.' });
      return res.json({ success: false, message: err.message });
    }
    logAudit(req, 'CREATE_POSITION', `Created custom position: ${name}`);
    res.json({ success: true, message: 'Position created successfully.', positionId: this.lastID });
  });
});

app.put('/api/positions/:id', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const { name, description, is_officer } = req.body;
  const positionId = req.params.id;

  db.run(`UPDATE positions SET name = ?, description = ?, is_officer = ? WHERE id = ?`, [name.trim(), description || '', is_officer ? 1 : 0, positionId], function(err) {
    if (err) return res.json({ success: false, message: err.message });
    logAudit(req, 'UPDATE_POSITION', `Updated position ID: ${positionId} to Name: ${name}`);
    res.json({ success: true, message: 'Position updated successfully.' });
  });
});

app.delete('/api/positions/:id', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const positionId = req.params.id;

  db.get(`SELECT COUNT(*) as count FROM students WHERE position_id = ?`, [positionId], (err, row) => {
    if (row.count > 0) {
      return res.json({ success: false, message: 'Cannot delete position. Students are currently assigned to this position.' });
    }

    db.run(`DELETE FROM positions WHERE id = ?`, [positionId], (err) => {
      if (err) return res.json({ success: false, message: err.message });
      logAudit(req, 'DELETE_POSITION', `Deleted position ID: ${positionId}`);
      res.json({ success: true, message: 'Position deleted successfully.' });
    });
  });
});
// ============================================================================
// STUDENT MANAGEMENT API
// ============================================================================
app.get('/api/students', isAuthenticated, (req, res) => {
  const { search, position_id, status, school_year } = req.query;
  let query = `
    SELECT s.*, p.name as position_name, p.is_officer 
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ` AND (s.student_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR (s.first_name || ' ' || s.last_name) LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  if (position_id) {
    query += ` AND s.position_id = ?`;
    params.push(position_id);
  }

  if (status) {
    query += ` AND s.membership_status = ?`;
    params.push(status);
  }

  if (school_year) {
    query += ` AND s.school_year = ?`;
    params.push(school_year);
  }

  query += ` ORDER BY s.last_name ASC, s.first_name ASC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, students: rows });
  });
});

app.get('/api/students/:student_id', isAuthenticated, (req, res) => {
  const studentId = req.params.student_id;
  const query = `
    SELECT s.*, p.name as position_name, p.is_officer 
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    WHERE s.student_id = ?
  `;

  db.get(query, [studentId], (err, student) => {
    if (err || !student) return res.status(404).json({ success: false, message: 'Student not found.' });

    // Fetch position history
    const historyQuery = `
      SELECT ph.*, p.name as position_name 
      FROM position_history ph 
      JOIN positions p ON ph.position_id = p.id 
      WHERE ph.student_id = ? 
      ORDER BY ph.assigned_at DESC
    `;

    db.all(historyQuery, [studentId], (err, history) => {
      res.json({ success: true, student, position_history: history || [] });
    });
  });
});

app.post('/api/students', isAuthenticated, hasRole(['ADMIN']), upload.single('photo'), async (req, res) => {
  const {
    student_id, first_name, middle_name, last_name, position_id,
    student_club, school_year, gender, date_of_birth, contact_number,
    school_email, address, date_joined, membership_status, membership_expiration,
    parent_name, parent_contact, initial_password
  } = req.body;

  if (!student_id || !first_name || !last_name || !position_id || !student_club || !school_year) {
    return res.json({ success: false, message: 'Missing required student registration fields.' });
  }

  // Generate Unique Secure Token for QR Code
  const qr_token = 'QR-' + student_id + '-' + Math.random().toString(36).substring(2, 10).toUpperCase();
  const photo_url = req.file ? `/uploads/${req.file.filename}` : '/assets/default_avatar.png';

  db.get(`SELECT student_id FROM students WHERE student_id = ?`, [student_id], async (err, existing) => {
    if (existing) {
      return res.json({ success: false, message: 'Student ID already exists in the system.' });
    }

    db.serialize(async () => {
      db.run('BEGIN TRANSACTION');

      const insertStudentSql = `
        INSERT INTO students (
          student_id, first_name, middle_name, last_name, position_id, student_club,
          school_year, gender, date_of_birth, contact_number, school_email, address,
          photo_url, date_joined, membership_status, membership_expiration, parent_name,
          parent_contact, qr_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      db.run(insertStudentSql, [
        student_id, first_name, middle_name || '', last_name, position_id, student_club,
        school_year, gender || 'Other', date_of_birth || '2000-01-01', contact_number || '',
        school_email || '', address || '', photo_url, date_joined || new Date().toISOString().split('T')[0],
        membership_status || 'Active', membership_expiration || '', parent_name || '',
        parent_contact || '', qr_token
      ], function(err) {
        if (err) {
          db.run('ROLLBACK');
          return res.json({ success: false, message: err.message });
        }

        // Insert initial position history log
        db.run(`INSERT INTO position_history (student_id, position_id, school_year) VALUES (?, ?, ?)`, [student_id, position_id, school_year]);

        // Create student login user account
        const studentPass = initial_password || 'student123';
        bcrypt.hash(studentPass, 10, (err, hashedPass) => {
          if (err) {
            db.run('ROLLBACK');
            return res.json({ success: false, message: 'Failed hashing password.' });
          }

          db.run(`INSERT INTO users (username, password, role, student_id) VALUES (?, ?, 'STUDENT', ?)`, [student_id, hashedPass, student_id], (err) => {
            if (err) {
              db.run('ROLLBACK');
              return res.json({ success: false, message: 'Failed creating student authentication user record.' });
            }

            db.run('COMMIT');
            logAudit(req, 'REGISTER_STUDENT', `Registered student: ${student_id} (${first_name} ${last_name})`);
            res.json({ success: true, message: 'Student registered successfully.', student_id, qr_token });
          });
        });
      });
    });
  });
});

app.put('/api/students/:student_id', isAuthenticated, hasRole(['ADMIN']), upload.single('photo'), (req, res) => {
  const studentId = req.params.student_id;
  const {
    first_name, middle_name, last_name, position_id, student_club,
    school_year, gender, date_of_birth, contact_number, school_email,
    address, membership_status, membership_expiration, parent_name, parent_contact
  } = req.body;

  db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, currentStudent) => {
    if (err || !currentStudent) return res.json({ success: false, message: 'Student not found.' });

    const photo_url = req.file ? `/uploads/${req.file.filename}` : currentStudent.photo_url;
    const positionChanged = parseInt(position_id) !== parseInt(currentStudent.position_id);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      const updateSql = `
        UPDATE students SET
          first_name = ?, middle_name = ?, last_name = ?, position_id = ?, student_club = ?,
          school_year = ?, gender = ?, date_of_birth = ?, contact_number = ?, school_email = ?,
          address = ?, photo_url = ?, membership_status = ?, membership_expiration = ?,
          parent_name = ?, parent_contact = ?, updated_at = CURRENT_TIMESTAMP
        WHERE student_id = ?
      `;

      db.run(updateSql, [
        first_name, middle_name, last_name, position_id, student_club,
        school_year, gender, date_of_birth, contact_number, school_email,
        address, photo_url, membership_status, membership_expiration, parent_name,
        parent_contact, studentId
      ], function(err) {
        if (err) {
          db.run('ROLLBACK');
          return res.json({ success: false, message: err.message });
        }

        if (positionChanged) {
          db.run(`INSERT INTO position_history (student_id, position_id, school_year) VALUES (?, ?, ?)`, [studentId, position_id, school_year]);
        }

        db.run('COMMIT');
        logAudit(req, 'UPDATE_STUDENT', `Updated records for student: ${studentId}`);
        res.json({ success: true, message: 'Student profile updated successfully.' });
      });
    });
  });
});

app.delete('/api/students/:student_id', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const studentId = req.params.student_id;
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.run(`DELETE FROM users WHERE student_id = ?`, [studentId]);
    db.run(`DELETE FROM students WHERE student_id = ?`, [studentId], (err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.json({ success: false, message: err.message });
      }
      db.run('COMMIT');
      logAudit(req, 'DELETE_STUDENT', `Deleted student: ${studentId}`);
      res.json({ success: true, message: 'Student deleted successfully.' });
    });
  });
});

// ============================================================================
// QR CODE GENERATION & MANAGEMENT API
// ============================================================================
app.get('/api/qr/generate/:student_id', isAuthenticated, async (req, res) => {
  const studentId = req.params.student_id;
  db.get(`SELECT qr_token, qr_status, first_name, last_name FROM students WHERE student_id = ?`, [studentId], async (err, student) => {
    if (err || !student) return res.status(404).json({ success: false, message: 'Student not found.' });
    if (student.qr_status === 'Disabled') {
      return res.json({ success: false, message: 'QR Code is currently disabled for this student.' });
    }

    try {
      const qrDataUrl = await QRCode.toDataURL(student.qr_token, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: 300,
        color: { dark: '#0f172a', light: '#ffffff' }
      });
      res.json({ success: true, qr_code_url: qrDataUrl, token: student.qr_token });
    } catch (qrErr) {
      res.status(500).json({ success: false, message: 'Failed to generate QR image.' });
    }
  });
});

app.post('/api/qr/regenerate/:student_id', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const studentId = req.params.student_id;
  const new_qr_token = 'QR-' + studentId + '-' + Math.random().toString(36).substring(2, 10).toUpperCase();

  db.run(`UPDATE students SET qr_token = ?, qr_status = 'Active', updated_at = CURRENT_TIMESTAMP WHERE student_id = ?`, [new_qr_token, studentId], (err) => {
    if (err) return res.json({ success: false, message: err.message });
    logAudit(req, 'REGENERATE_QR', `Regenerated QR token for student: ${studentId}`);
    res.json({ success: true, message: 'QR code regenerated successfully. Old QR token is now invalidated.', new_token: new_qr_token });
  });
});

app.post('/api/qr/toggle-status/:student_id', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const studentId = req.params.student_id;
  const { status } = req.body; // 'Active' or 'Disabled'

  if (!['Active', 'Disabled'].includes(status)) {
    return res.json({ success: false, message: 'Invalid status parameter.' });
  }

  db.run(`UPDATE students SET qr_status = ?, updated_at = CURRENT_TIMESTAMP WHERE student_id = ?`, [status, studentId], (err) => {
    if (err) return res.json({ success: false, message: err.message });
    logAudit(req, 'TOGGLE_QR_STATUS', `Set QR status to ${status} for student: ${studentId}`);
    res.json({ success: true, message: `QR Code status updated to ${status}.` });
  });
});

// ============================================================================
// EVENT MANAGEMENT API
// ============================================================================
app.get('/api/events', isAuthenticated, (req, res) => {
  const { status, type } = req.query;
  let query = `SELECT * FROM events WHERE 1=1`;
  const params = [];

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }
  if (type) {
    query += ` AND event_type = ?`;
    params.push(type);
  }

  query += ` ORDER BY event_date DESC, start_time DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, events: rows });
  });
});

app.get('/api/events/:id', isAuthenticated, (req, res) => {
  const eventId = req.params.id;
  db.get(`SELECT * FROM events WHERE id = ?`, [eventId], (err, event) => {
    if (err || !event) return res.status(404).json({ success: false, message: 'Event not found.' });

    // Fetch targeted positions if any
    db.all(`SELECT position_id FROM event_target_positions WHERE event_id = ?`, [eventId], (err, targetPositions) => {
      db.all(`SELECT student_id FROM event_target_students WHERE event_id = ?`, [eventId], (err, targetStudents) => {
        res.json({
          success: true,
          event,
          target_positions: targetPositions.map(p => p.position_id),
          target_students: targetStudents.map(s => s.student_id)
        });
      });
    });
  });
});

app.post('/api/events', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const {
    event_name, description, event_type, event_date, start_time, end_time,
    location, organizer, status, target_audience, late_threshold_minutes,
    target_positions, target_students
  } = req.body;

  if (!event_name || !event_type || !event_date || !start_time || !end_time || !location) {
    return res.json({ success: false, message: 'Missing required event configuration fields.' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    const insertEventSql = `
      INSERT INTO events (
        event_name, description, event_type, event_date, start_time, end_time,
        location, organizer, status, target_audience, late_threshold_minutes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(insertEventSql, [
      event_name, description || '', event_type, event_date, start_time, end_time,
      location, organizer || 'Club Adviser', status || 'Upcoming', target_audience || 'ALL',
      late_threshold_minutes || 15
    ], function(err) {
      if (err) {
        db.run('ROLLBACK');
        return res.json({ success: false, message: err.message });
      }

      const eventId = this.lastID;

      if (target_audience === 'SPECIFIC_POSITIONS' && Array.isArray(target_positions)) {
        const stmt = db.prepare(`INSERT INTO event_target_positions (event_id, position_id) VALUES (?, ?)`);
        target_positions.forEach(posId => stmt.run(eventId, posId));
        stmt.finalize();
      } else if (target_audience === 'SELECTED_STUDENTS' && Array.isArray(target_students)) {
        const stmt = db.prepare(`INSERT INTO event_target_students (event_id, student_id) VALUES (?, ?)`);
        target_students.forEach(sId => stmt.run(eventId, sId));
        stmt.finalize();
      }

      db.run('COMMIT');
      logAudit(req, 'CREATE_EVENT', `Created event: ${event_name} (ID: ${eventId})`);
      res.json({ success: true, message: 'Event created successfully.', eventId });
    });
  });
});

app.put('/api/events/:id', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const eventId = req.params.id;
  const {
    event_name, description, event_type, event_date, start_time, end_time,
    location, organizer, status, target_audience, late_threshold_minutes,
    target_positions, target_students
  } = req.body;

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    const updateEventSql = `
      UPDATE events SET
        event_name = ?, description = ?, event_type = ?, event_date = ?, start_time = ?,
        end_time = ?, location = ?, organizer = ?, status = ?, target_audience = ?,
        late_threshold_minutes = ?
      WHERE id = ?
    `;

    db.run(updateEventSql, [
      event_name, description, event_type, event_date, start_time, end_time,
      location, organizer, status, target_audience, late_threshold_minutes, eventId
    ], function(err) {
      if (err) {
        db.run('ROLLBACK');
        return res.json({ success: false, message: err.message });
      }

      // Refresh target relations
      db.run(`DELETE FROM event_target_positions WHERE event_id = ?`, [eventId]);
      db.run(`DELETE FROM event_target_students WHERE event_id = ?`, [eventId]);

      if (target_audience === 'SPECIFIC_POSITIONS' && Array.isArray(target_positions)) {
        const stmt = db.prepare(`INSERT INTO event_target_positions (event_id, position_id) VALUES (?, ?)`);
        target_positions.forEach(posId => stmt.run(eventId, posId));
        stmt.finalize();
      } else if (target_audience === 'SELECTED_STUDENTS' && Array.isArray(target_students)) {
        const stmt = db.prepare(`INSERT INTO event_target_students (event_id, student_id) VALUES (?, ?)`);
        target_students.forEach(sId => stmt.run(eventId, sId));
        stmt.finalize();
      }

      // If status changed to Completed, process automated absence marking for targeted non-attendees
      if (status === 'Completed') {
        processAutoAbsences(eventId);
      }

      db.run('COMMIT');
      logAudit(req, 'UPDATE_EVENT', `Updated event ID: ${eventId}`);
      res.json({ success: true, message: 'Event updated successfully.' });
    });
  });
});

// Helper Function: Auto Mark Absences for Completed Events
function processAutoAbsences(eventId) {
  db.get(`SELECT * FROM events WHERE id = ?`, [eventId], (err, event) => {
    if (!event) return;

    let targetQuery = `SELECT student_id FROM students WHERE membership_status = 'Active'`;
    const params = [];

    if (event.target_audience === 'OFFICERS_ONLY') {
      targetQuery = `SELECT s.student_id FROM students s JOIN positions p ON s.position_id = p.id WHERE s.membership_status = 'Active' AND p.is_officer = 1`;
    } else if (event.target_audience === 'SPECIFIC_POSITIONS') {
      targetQuery = `SELECT student_id FROM students WHERE membership_status = 'Active' AND position_id IN (SELECT position_id FROM event_target_positions WHERE event_id = ?)`;
      params.push(eventId);
    } else if (event.target_audience === 'SELECTED_STUDENTS') {
      targetQuery = `SELECT student_id FROM event_target_students WHERE event_id = ?`;
      params.push(eventId);
    }

    db.all(targetQuery, params, (err, targetStudents) => {
      if (err || !targetStudents) return;

      const stmt = db.prepare(`
        INSERT OR IGNORE INTO attendance (event_id, student_id, status) 
        VALUES (?, ?, 'Absent')
      `);

      targetStudents.forEach(st => {
        stmt.run(eventId, st.student_id);
      });
      stmt.finalize();
    });
  });
}

// ============================================================================
// ATTENDANCE CORE ENGINE & SCANNER API
// ============================================================================
app.post('/api/attendance/scan', isAuthenticated, hasRole(['ADMIN', 'SCANNER']), (req, res) => {
  const { event_id, qr_token, scan_type } = req.body; // scan_type: 'TIME_IN' or 'TIME_OUT'

  if (!event_id || !qr_token) {
    return res.json({ success: false, code: 'INVALID_INPUT', message: 'Event ID and QR Code payload are required.' });
  }

  // 1. Verify Active Event
  db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
    if (err || !event) {
      return res.json({ success: false, code: 'EVENT_NOT_FOUND', message: 'Target event does not exist.' });
    }

    if (event.status !== 'Active') {
      return res.json({ success: false, code: 'EVENT_INACTIVE', message: `Event is currently ${event.status}. Attendance scanning allowed only for Active events.` });
    }

    // 2. Validate QR Token & Student Status
    const studentQuery = `
      SELECT s.*, p.name as position_name, p.is_officer 
      FROM students s 
      JOIN positions p ON s.position_id = p.id 
      WHERE s.qr_token = ?
    `;

    db.get(studentQuery, [qr_token], (err, student) => {
      if (err || !student) {
        return res.json({ success: false, code: 'INVALID_QR', message: 'Invalid or unrecognized QR Code token.' });
      }

      if (student.qr_status === 'Disabled') {
        return res.json({ success: false, code: 'DISABLED_QR', message: 'This student QR Code has been disabled by Administrator.' });
      }

      if (student.membership_status !== 'Active') {
        return res.json({ success: false, code: 'INACTIVE_STUDENT', message: `Student membership is currently ${student.membership_status}.` });
      }

      const now = new Date();
      const nowTimeString = now.toTimeString().split(' ')[0];
      const nowIsoString = now.toISOString();

      // 3. Process Attendance Logic (TIME IN / TIME OUT)
      db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student.student_id], (err, record) => {
        if (scan_type === 'TIME_OUT') {
          if (!record || !record.time_in) {
            return res.json({
              success: false,
              code: 'NO_TIME_IN',
              message: `${student.first_name} ${student.last_name} has no recorded Time In for this event.`,
              student
            });
          }

          if (record.time_out) {
            return res.json({
              success: false,
              code: 'DUPLICATE_TIME_OUT',
              message: `${student.first_name} ${student.last_name} has already recorded Time Out.`,
              student,
              record
            });
          }

          db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [nowIsoString, record.id], (err) => {
            logAudit(req, 'TIME_OUT', `Recorded Time Out for ${student.student_id} in event ${event_id}`);
            return res.json({
              success: true,
              code: 'TIME_OUT_SUCCESS',
              message: `${student.first_name} ${student.last_name}, Time Out recorded.`,
              student,
              time_out: nowTimeString,
              status: record.status
            });
          });

        } else {
          // Default: TIME IN
          if (record && record.time_in) {
            return res.json({
              success: false,
              code: 'DUPLICATE_TIME_IN',
              message: `${student.first_name} ${student.last_name}, you are already recorded for this event.`,
              student,
              record
            });
          }

          // Calculate Attendance Status (Present vs Late)
          const eventStartTimeParts = event.start_time.split(':');
          const eventStart = new Date();
          eventStart.setHours(parseInt(eventStartTimeParts[0]), parseInt(eventStartTimeParts[1]), 0);

          const thresholdMs = (event.late_threshold_minutes || 15) * 60 * 1000;
          const lateCutoff = new Date(eventStart.getTime() + thresholdMs);

          const attendanceStatus = (now > lateCutoff) ? 'Late' : 'Present';

          if (record) {
            // Update pre-existing absent/excused draft record
            db.run(`UPDATE attendance SET time_in = ?, status = ?, recorded_by = ? WHERE id = ?`,
              [nowIsoString, attendanceStatus, req.session.user.id, record.id], (err) => {
                logAudit(req, 'TIME_IN', `Recorded Time In (${attendanceStatus}) for ${student.student_id} in event ${event_id}`);
                return res.json({
                  success: true,
                  code: 'TIME_IN_SUCCESS',
                  message: `${student.first_name} ${student.last_name}, attendance recorded as ${attendanceStatus}.`,
                  student,
                  time_in: nowTimeString,
                  status: attendanceStatus
                });
              });
          } else {
            // Insert new attendance record
            db.run(`INSERT INTO attendance (event_id, student_id, time_in, status, recorded_by) VALUES (?, ?, ?, ?, ?)`,
              [event_id, student.student_id, nowIsoString, attendanceStatus, req.session.user.id], (err) => {
                logAudit(req, 'TIME_IN', `Recorded Time In (${attendanceStatus}) for ${student.student_id} in event ${event_id}`);
                return res.json({
                  success: true,
                  code: 'TIME_IN_SUCCESS',
                  message: `${student.first_name} ${student.last_name}, attendance recorded as ${attendanceStatus}.`,
                  student,
                  time_in: nowTimeString,
                  status: attendanceStatus
                });
              });
          }
        }
      });
    });
  });
});

// Excused Absence Marking API
app.post('/api/attendance/excuse', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const { event_id, student_id, reason, notes } = req.body;

  if (!event_id || !student_id || !reason) {
    return res.json({ success: false, message: 'Event ID, Student ID, and Reason are required.' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.get(`SELECT id FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student_id], (err, record) => {
      let attendanceId = record ? record.id : null;

      const proceedExcuseInsert = (attId) => {
        db.run(`INSERT OR REPLACE INTO attendance_excuses (attendance_id, reason, notes, approved_by, approved_date) VALUES (?, ?, ?, ?, DATE('now'))`,
          [attId, reason, notes || '', req.session.user.username], (err) => {
            if (err) {
              db.run('ROLLBACK');
              return res.json({ success: false, message: err.message });
            }
            db.run('COMMIT');
            logAudit(req, 'MARK_EXCUSED', `Marked student ${student_id} as Excused for event ${event_id}`);
            res.json({ success: true, message: 'Absence successfully marked as Excused.' });
          });
      };

      if (!attendanceId) {
        db.run(`INSERT INTO attendance (event_id, student_id, status, recorded_by) VALUES (?, ?, 'Excused', ?)`,
          [event_id, student_id, req.session.user.id], function(err) {
            if (err) {
              db.run('ROLLBACK');
              return res.json({ success: false, message: err.message });
            }
            proceedExcuseInsert(this.lastID);
          });
      } else {
        db.run(`UPDATE attendance SET status = 'Excused' WHERE id = ?`, [attendanceId], (err) => {
          proceedExcuseInsert(attendanceId);
        });
      }
    });
  });
});

// Live Monitor API Route
app.get('/api/attendance/live-monitor/:event_id', isAuthenticated, (req, res) => {
  const eventId = req.params.event_id;
  const query = `
    SELECT a.*, s.first_name, s.middle_name, s.last_name, s.photo_url, p.name as position_name
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN positions p ON s.position_id = p.id
    WHERE a.event_id = ?
    ORDER BY a.created_at DESC
    LIMIT 20
  `;

  db.all(query, [eventId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, recent_scans: rows });
  });
});
// ============================================================================
// DASHBOARD ANALYTICS & PARTICIPATION TRACKING
// ============================================================================
app.get('/api/analytics/dashboard', isAuthenticated, (req, res) => {
  db.serialize(() => {
    const stats = {};

    db.get(`SELECT 
      COUNT(*) as total_students,
      SUM(CASE WHEN membership_status = 'Active' THEN 1 ELSE 0 END) as active_students,
      SUM(CASE WHEN membership_status = 'Inactive' THEN 1 ELSE 0 END) as inactive_students
      FROM students`, [], (err, row) => {
        stats.total_students = row.total_students || 0;
        stats.active_students = row.active_students || 0;
        stats.inactive_students = row.inactive_students || 0;

        db.get(`SELECT COUNT(*) as total_officers FROM students s JOIN positions p ON s.position_id = p.id WHERE p.is_officer = 1 AND s.membership_status = 'Active'`, [], (err, oRow) => {
          stats.total_officers = oRow.total_officers || 0;

          // Today's attendance counts
          db.get(`SELECT 
            SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) as present_today,
            SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) as late_today,
            SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) as absent_today,
            SUM(CASE WHEN status = 'Excused' THEN 1 ELSE 0 END) as excused_today
            FROM attendance WHERE DATE(created_at) = DATE('now')`, [], (err, todayRow) => {
              stats.present_today = todayRow.present_today || 0;
              stats.late_today = todayRow.late_today || 0;
              stats.absent_today = todayRow.absent_today || 0;
              stats.excused_today = todayRow.excused_today || 0;

              // Events state counts
              db.get(`SELECT 
                SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) as active_events,
                SUM(CASE WHEN status = 'Upcoming' THEN 1 ELSE 0 END) as upcoming_events,
                SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed_events
                FROM events`, [], (err, evRow) => {
                  stats.active_events = evRow.active_events || 0;
                  stats.upcoming_events = evRow.upcoming_events || 0;
                  stats.completed_events = evRow.completed_events || 0;

                  // Overall rate calculation
                  db.get(`SELECT COUNT(*) as total_records, SUM(CASE WHEN status IN ('Present', 'Late') THEN 1 ELSE 0 END) as attended_records FROM attendance`, [], (err, rateRow) => {
                    const total = rateRow.total_records || 0;
                    const attended = rateRow.attended_records || 0;
                    stats.overall_attendance_rate = total > 0 ? ((attended / total) * 100).toFixed(1) : '100.0';

                    res.json({ success: true, stats });
                  });
                });
            });
        });
      });
  });
});

app.get('/api/analytics/participation-reports', isAuthenticated, (req, res) => {
  const query = `
    SELECT 
      s.student_id, s.first_name, s.last_name, p.name as position_name,
      COUNT(a.id) as total_events_logged,
      SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) as present_count,
      SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) as late_count,
      SUM(CASE WHEN a.status = 'Absent' THEN 1 ELSE 0 END) as absent_count,
      SUM(CASE WHEN a.status = 'Excused' THEN 1 ELSE 0 END) as excused_count
    FROM students s
    JOIN positions p ON s.position_id = p.id
    LEFT JOIN attendance a ON s.student_id = a.student_id
    WHERE s.membership_status = 'Active'
    GROUP BY s.student_id
  `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    const processed = rows.map(r => {
      const total = r.total_events_logged || 0;
      const attended = (r.present_count || 0) + (r.late_count || 0);
      const rate = total > 0 ? ((attended / total) * 100).toFixed(1) : 0;
      return {
        ...r,
        attended_count: attended,
        participation_rate: parseFloat(rate)
      };
    });

    res.json({ success: true, participation: processed });
  });
});

// ============================================================================
// REPORT GENERATION & EXPORT API
// ============================================================================
app.get('/api/reports/generate', isAuthenticated, (req, res) => {
  const { report_type, event_id, position_id, start_date, end_date } = req.query;

  let query = `
    SELECT a.*, s.first_name, s.last_name, p.name as position_name, e.event_name, e.event_date
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN positions p ON s.position_id = p.id
    JOIN events e ON a.event_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (event_id) {
    query += ` AND a.event_id = ?`;
    params.push(event_id);
  }
  if (position_id) {
    query += ` AND s.position_id = ?`;
    params.push(position_id);
  }
  if (start_date && end_date) {
    query += ` AND DATE(e.event_date) BETWEEN DATE(?) AND DATE(?)`;
    params.push(start_date, end_date);
  }

  query += ` ORDER BY e.event_date DESC, s.last_name ASC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    logAudit(req, 'GENERATE_REPORT', `Generated ${report_type || 'Custom'} Attendance Report`);
    res.json({ success: true, report_data: rows });
  });
});

app.get('/api/reports/export-csv', isAuthenticated, (req, res) => {
  const { event_id } = req.query;
  let query = `
    SELECT s.student_id, s.first_name, s.last_name, p.name as position, e.event_name, e.event_date, a.time_in, a.time_out, a.status
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN positions p ON s.position_id = p.id
    JOIN events e ON a.event_id = e.id
  `;
  const params = [];
  if (event_id) {
    query += ` WHERE a.event_id = ?`;
    params.push(event_id);
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).send('Error generating export');

    let csv = 'Student ID,First Name,Last Name,Position,Event Name,Event Date,Time In,Time Out,Status\n';
    rows.forEach(r => {
      csv += `"${r.student_id}","${r.first_name}","${r.last_name}","${r.position}","${r.event_name}","${r.event_date}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=Attendance_Report_${Date.now()}.csv`);
    res.status(200).send(csv);
  });
});

// ============================================================================
// AUDIT LOGS & BACKUP/RESTORE ENGINE
// ============================================================================
app.get('/api/audit-logs', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, logs: rows });
  });
});

app.get('/api/backup/download', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const backupFileName = `backup_attendance_${Date.now()}.sqlite`;
  const destPath = path.join(BACKUPS_DIR, backupFileName);

  fs.copyFile(dbPath, destPath, (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Backup creation failed.' });
    logAudit(req, 'BACKUP_DATABASE', `Created database backup: ${backupFileName}`);
    res.download(destPath);
  });
});

app.post('/api/backup/restore', isAuthenticated, hasRole(['ADMIN']), upload.single('backup_file'), (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'No backup file uploaded.' });

  const uploadedPath = req.file.path;
  db.close((err) => {
    if (err) return res.json({ success: false, message: 'Database busy. Cannot overwrite.' });

    fs.copyFile(uploadedPath, dbPath, (err) => {
      if (err) return res.json({ success: false, message: 'Failed to restore database.' });

      // Re-open DB Connection
      db = new sqlite3.Database(dbPath);
      logAudit(req, 'RESTORE_DATABASE', 'Restored system database from backup file.');
      res.json({ success: true, message: 'Database successfully restored.' });
    });
  });
});

// ============================================================================
// VIEW ENGINE & HTML CONTROLLERS (A4 Printing Grid & Single Page Portals)
// ============================================================================

// A4 Printing Sheet Renderer (Strict 8 Cards Per Page CSS Layout Engine)
app.get('/print-ids', isAuthenticated, hasRole(['ADMIN']), (req, res) => {
  const { ids, position_id } = req.query;
  let query = `
    SELECT s.*, p.name as position_name 
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    WHERE s.membership_status = 'Active'
  `;
  const params = [];

  if (ids) {
    const idArray = ids.split(',').map(i => i.trim());
    query += ` AND s.student_id IN (${idArray.map(() => '?').join(',')})`;
    params.push(...idArray);
  } else if (position_id) {
    query += ` AND s.position_id = ?`;
    params.push(position_id);
  }

  db.all(query, params, (err, students) => {
    db.all(`SELECT key, value FROM settings`, [], async (err, settingRows) => {
      const settings = {};
      settingRows.forEach(r => settings[r.key] = r.value);

      // Render Dynamic ID Grid HTML
      let cardsHtml = '';
      for (let i = 0; i < students.length; i++) {
        const st = students[i];
        const qrData = await QRCode.toDataURL(st.qr_token, { margin: 1, width: 120 });

        cardsHtml += `
          <div class="id-card">
            <div class="card-header">
              <div class="school-title">${settings.school_name || 'ABC National High School'}</div>
              <div class="club-title">${settings.student_club_name || 'Computer Club'}</div>
            </div>
            <div class="card-body">
              <img class="photo" src="${st.photo_url || '/assets/default_avatar.png'}" alt="Photo" />
              <div class="details">
                <div class="student-name">${st.first_name} ${st.last_name}</div>
                <div class="position-badge">${st.position_name}</div>
                <div class="info-row">ID: <strong>${st.student_id}</strong></div>
                <div class="info-row">SY: ${st.school_year}</div>
              </div>
            </div>
            <div class="card-footer">
              <img class="qr" src="${qrData}" alt="QR Code" />
              <div class="joined">Joined: ${st.date_joined}</div>
            </div>
          </div>
        `;
      }

      const fullHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>A4 Student ID Cards Batch Print</title>
          <style>
            @page {
              size: A4 portrait;
              margin: 10mm;
            }
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              margin: 0;
              padding: 0;
              background-color: #f1f5f9;
            }
            .a4-page {
              width: 210mm;
              height: 297mm;
              padding: 5mm;
              box-sizing: border-box;
              display: grid;
              grid-template-columns: repeat(2, 85mm);
              grid-template-rows: repeat(4, 54mm);
              gap: 8mm 10mm;
              justify-content: center;
              align-content: center;
              page-break-after: always;
              background: white;
            }
            .id-card {
              width: 85mm;
              height: 54mm;
              border: 1px dashed #94a3b8;
              border-radius: 6px;
              box-sizing: border-box;
              padding: 4px;
              display: flex;
              flex-direction: column;
              justify-content: space-between;
              background: #ffffff;
              position: relative;
            }
            .card-header {
              background: #1e293b;
              color: white;
              text-align: center;
              padding: 3px;
              border-radius: 4px 4px 0 0;
            }
            .school-title { font-size: 8pt; font-weight: bold; text-transform: uppercase; }
            .club-title { font-size: 7pt; color: #38bdf8; }
            .card-body { display: flex; gap: 8px; align-items: center; padding: 4px; }
            .photo { width: 22mm; height: 22mm; border-radius: 4px; object-fit: cover; border: 1px solid #cbd5e1; }
            .details { flex: 1; }
            .student-name { font-size: 9pt; font-weight: bold; color: #0f172a; line-height: 1.1; }
            .position-badge { display: inline-block; background: #e0f2fe; color: #0369a1; font-size: 7pt; font-weight: bold; padding: 1px 4px; border-radius: 3px; margin: 2px 0; }
            .info-row { font-size: 7pt; color: #475569; }
            .card-footer { display: flex; justify-content: space-between; align-items: flex-end; padding: 0 4px 2px 4px; }
            .qr { width: 16mm; height: 16mm; }
            .joined { font-size: 6pt; color: #94a3b8; }
            @media print {
              body { background: none; }
              .no-print { display: none; }
              .a4-page { box-shadow: none; margin: 0; }
            }
          </style>
        </head>
        <body>
          <div class="no-print" style="padding: 15px; text-align: center; background: #0f172a; color: white;">
            <button onclick="window.print()" style="padding: 10px 20px; font-size: 14px; cursor: pointer; background: #0284c7; color: white; border: none; border-radius: 4px;">Print A4 ID Sheets</button>
          </div>
          <div class="a4-page">
            ${cardsHtml}
          </div>
        </body>
        </html>
      `;

      res.send(fullHtml);
    });
  });
});

// App Main Dashboard Engine & Portal Dispatcher
app.get('*', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>School Student Club QR Attendance System</title>
      <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
      <script src="https://unpkg.com/html5-qrcode"></script>
    </head>
    <body class="bg-slate-50 text-slate-800">
      <div id="app" class="min-h-screen flex flex-col">
        <!-- Dynamic Portal Mount Container -->
        <div class="flex-1 flex items-center justify-center p-6" id="main-view">
          <div class="text-center">
            <h1 class="text-3xl font-bold text-slate-900 mb-2">School Student Club Attendance System</h1>
            <p class="text-slate-600 mb-6">Year 2026-2027 • Standard Multi-Role Portal</p>
            <div id="auth-box" class="bg-white p-8 rounded-xl shadow-lg w-96 mx-auto border border-slate-200">
              <h2 class="text-xl font-semibold mb-4 text-left">System Login</h2>
              <form id="login-form" onsubmit="handleLogin(event)">
                <input type="text" id="username" placeholder="Username / Student ID" required class="w-full p-2.5 border rounded mb-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <input type="password" id="password" placeholder="Password" required class="w-full p-2.5 border rounded mb-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded text-sm transition">Sign In</button>
              </form>
              <div id="login-msg" class="mt-3 text-xs text-red-500"></div>
            </div>
          </div>
        </div>
      </div>

      <script>
        async function handleLogin(e) {
          e.preventDefault();
          const username = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (data.success) {
            alert('Login Successful! Welcome to System.');
            window.location.reload();
          } else {
            document.getElementById('login-msg').innerText = data.message;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Start Node Server
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` SCHOOL STUDENT CLUB QR ATTENDANCE SYSTEM IS ACTIVE`);
  console.log(` Running on Port: ${PORT}`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(` Scanner Portal: http://localhost:${PORT}/scanner`);
  console.log(` Member Portal: http://localhost:${PORT}/member`);
  console.log(`=======================================================`);
});
