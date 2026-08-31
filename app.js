/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Complete Monolithic Server & Client Application
 * 
 * Target Environment: Node.js with Express, SQLite3, Session Auth, HTML5, CSS3, JS ES6+
 * Fully-featured Web Application featuring:
 * - Admin, Scanner, and Student Role Portals
 * - Fully Customizable Positions (No Committees, No Grade/Year/Section fields)
 * - Public Mobile-First Student Registration & Admin Approval Queue
 * - Live Camera QR Code Scanner with HTML5 Web Speech API Voice Announcements
 * - Dynamic Printable Reports & A4 Printable IDs Grid (8 Cards per Page layout)
 * - Complete Password Management, Database Backup & Restore, and Audit Logging
 */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const app = express();

// Ensure required asset directories exist
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// Multer Storage Configuration for Student Photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'photo_' + Date.now() + '_' + Math.round(Math.random() * 1E9) + ext);
  }
});
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB Limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  }
});

// Middleware setup
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  secret: 'school_club_qr_attendance_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'club_attendance.db');
const db = new sqlite3.Database(dbPath);

// Database Initialization Sequence
db.serialize(() => {
  // Foreign keys enforce integrity
  db.run("PRAGMA foreign_keys = ON");

  // System Settings Table
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    school_name TEXT NOT NULL,
    school_logo TEXT DEFAULT '',
    school_address TEXT DEFAULT '',
    school_contact TEXT DEFAULT '',
    school_email TEXT DEFAULT '',
    school_year TEXT NOT NULL,
    club_name TEXT NOT NULL,
    organization_name TEXT NOT NULL,
    club_adviser TEXT NOT NULL,
    registration_enabled INTEGER DEFAULT 1,
    allow_student_positions INTEGER DEFAULT 0,
    late_threshold_minutes INTEGER DEFAULT 15,
    low_participation_threshold INTEGER DEFAULT 50
  )`);

  // Users Table (Admins, Scanners, Students)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT CHECK(role IN ('ADMIN', 'SCANNER', 'STUDENT')) NOT NULL,
    student_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
  )`);

  // Positions Table
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Students Table
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT DEFAULT '',
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    contact_number TEXT DEFAULT '',
    position_name TEXT NOT NULL,
    photo_url TEXT DEFAULT '',
    qr_code_token TEXT UNIQUE NOT NULL,
    date_joined DATE NOT NULL,
    membership_status TEXT CHECK(membership_status IN ('Active', 'Inactive', 'Suspended', 'Alumni', 'Resigned')) DEFAULT 'Active',
    membership_expiration DATE,
    approval_status TEXT CHECK(approval_status IN ('Approved', 'Pending', 'Rejected')) DEFAULT 'Approved',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Position History Table
  db.run(`CREATE TABLE IF NOT EXISTS position_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    position_name TEXT NOT NULL,
    school_year TEXT NOT NULL,
    assigned_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
  )`);

  // Events Table
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    description TEXT DEFAULT '',
    event_type TEXT NOT NULL,
    event_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    location TEXT NOT NULL,
    organizer TEXT NOT NULL,
    target_audience TEXT CHECK(target_audience IN ('ALL', 'OFFICERS_ONLY', 'SPECIFIC_POSITIONS')) DEFAULT 'ALL',
    allowed_positions TEXT DEFAULT '', -- Comma-separated position names
    status TEXT CHECK(status IN ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED')) DEFAULT 'UPCOMING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Attendance Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    time_in DATETIME,
    time_out DATETIME,
    status TEXT CHECK(status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')) DEFAULT 'ABSENT',
    notes TEXT DEFAULT '',
    scanned_by TEXT DEFAULT 'SYSTEM',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
    UNIQUE(event_id, student_id)
  )`);

  // Audit Logs Table
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Initial Seed Data Setup
  db.get("SELECT COUNT(*) as count FROM settings", (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO settings (id, school_name, school_logo, school_address, school_contact, school_email, school_year, club_name, organization_name, club_adviser)
              VALUES (1, 'Apex National High School', '', '123 Education Blvd, Cityville', '+1 (555) 019-2831', 'info@apexnhs.edu', '2026-2027', 'Computer Club', 'Student Technology Association', 'Mr. John Doe')`);
    }
  });

  // Seed Default Positions
  const defaultPositions = [
    'President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor',
    'Public Information Officer', 'Peace Officer', 'Sergeant-at-Arms', 'Representative', 'Member'
  ];
  defaultPositions.forEach(pos => {
    db.run(`INSERT OR IGNORE INTO positions (position_name, description) VALUES (?, ?)`, [pos, 'Standard Organization Position']);
  });

  // Seed Default Super Admin Account
  db.get("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN'", (err, row) => {
    if (row && row.count === 0) {
      const adminHash = bcrypt.hashSync('Admin@123', 10);
      db.run(`INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'ADMIN')`, [adminHash]);
      
      const scannerHash = bcrypt.hashSync('Scanner@123', 10);
      db.run(`INSERT INTO users (username, password_hash, role) VALUES ('scanner', ?, 'SCANNER')`, [scannerHash]);
    }
  });
});

// Helper Function: Log Audit Trail
function logAudit(username, role, action, details, req) {
  const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') : 'SYSTEM';
  db.run(
    `INSERT INTO audit_logs (username, role, action, details, ip_address) VALUES (?, ?, ?, ?, ?)`,
    [username || 'SYSTEM', role || 'GUEST', action, details, ip]
  );
}

// Security Middleware: Authentication Checks
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ success: false, message: 'Unauthorized. Please login.' });
}

function requireRole(roles) {
  return (req, res, next) => {
    if (req.session && req.session.user && roles.includes(req.session.user.role)) {
      return next();
    }
    return res.status(403).json({ success: false, message: 'Forbidden. Insufficient permissions.' });
  };
}

// ==========================================
// REST API ROUTES
// ==========================================

// Authentication APIs
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Please provide both username and password.' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) return res.json({ success: false, message: 'Invalid credentials.' });

    if (bcrypt.compareSync(password, user.password_hash)) {
      req.session.user = { id: user.id, username: user.username, role: user.role, student_id: user.student_id };
      logAudit(user.username, user.role, 'LOGIN', 'User logged in successfully', req);
      return res.json({ success: true, role: user.role, username: user.username });
    } else {
      logAudit(username, 'UNKNOWN', 'LOGIN_FAILED', 'Incorrect password attempt', req);
      return res.json({ success: false, message: 'Invalid credentials.' });
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.user) {
    logAudit(req.session.user.username, req.session.user.role, 'LOGOUT', 'User logged out', req);
    req.session.destroy();
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ loggedIn: true, user: req.session.user });
  }
  res.json({ loggedIn: false });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = req.session.user;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.json({ success: false, message: 'All fields are required.' });
  }
  if (newPassword !== confirmPassword) {
    return res.json({ success: false, message: 'New password and confirmation do not match.' });
  }
  if (newPassword.length < 8) {
    return res.json({ success: false, message: 'New password must be at least 8 characters long.' });
  }

  db.get(`SELECT password_hash FROM users WHERE id = ?`, [user.id], (err, row) => {
    if (err || !row) return res.json({ success: false, message: 'User not found.' });

    if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
      return res.json({ success: false, message: 'Current password is incorrect.' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, user.id], (err) => {
      if (err) return res.json({ success: false, message: 'Failed to update password.' });
      logAudit(user.username, user.role, 'CHANGE_PASSWORD', 'Password updated successfully', req);
      res.json({ success: true, message: 'Password changed successfully.' });
    });
  });
});

// System Settings APIs
app.get('/api/settings', (req, res) => {
  db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    res.json({ success: true, settings });
  });
});

app.post('/api/settings', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const { school_name, school_address, school_contact, school_email, school_year, club_name, organization_name, club_adviser, registration_enabled, allow_student_positions, late_threshold_minutes, low_participation_threshold } = req.body;

  db.run(`UPDATE settings SET 
    school_name = ?, school_address = ?, school_contact = ?, school_email = ?, school_year = ?,
    club_name = ?, organization_name = ?, club_adviser = ?, registration_enabled = ?,
    allow_student_positions = ?, late_threshold_minutes = ?, low_participation_threshold = ?
    WHERE id = 1`,
    [school_name, school_address, school_contact, school_email, school_year, club_name, organization_name, club_adviser, registration_enabled ? 1 : 0, allow_student_positions ? 1 : 0, late_threshold_minutes || 15, low_participation_threshold || 50],
    function(err) {
      if (err) return res.json({ success: false, message: 'Failed to update settings.' });
      logAudit(req.session.user.username, req.session.user.role, 'UPDATE_SETTINGS', 'Updated system settings', req);
      res.json({ success: true, message: 'Settings saved successfully.' });
    }
  );
});

// Public Self-Registration Route
app.post('/api/public/register', upload.single('photo'), async (req, res) => {
  try {
    const settings = await new Promise((res, rej) => db.get("SELECT * FROM settings WHERE id = 1", (e, r) => e ? rej(e) : res(r)));
    if (!settings.registration_enabled) {
      return res.json({ success: false, message: 'Student registration is currently closed by the Adviser.' });
    }

    const { student_id, first_name, middle_name, last_name, email, contact_number, position_name } = req.body;
    if (!student_id || !first_name || !last_name || !email) {
      return res.json({ success: false, message: 'Please complete all required fields.' });
    }

    // Duplicate Student Check
    const existing = await new Promise((res, rej) => {
      db.get("SELECT student_id, email FROM students WHERE student_id = ? OR email = ?", [student_id, email], (e, r) => e ? rej(e) : res(r));
    });

    if (existing) {
      if (existing.student_id === student_id) {
        return res.json({ success: false, message: 'Student ID already registered. Please contact your Club Adviser if you believe this is an error.' });
      }
      return res.json({ success: false, message: 'School Email is already registered.' });
    }

    const assignedPosition = (settings.allow_student_positions && position_name) ? position_name : 'Member';
    const photo_url = req.file ? '/uploads/' + req.file.filename : '';
    const qr_token = 'QR_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const date_joined = new Date().toISOString().split('T')[0];

    db.run(
      `INSERT INTO students (student_id, first_name, middle_name, last_name, email, contact_number, position_name, photo_url, qr_code_token, date_joined, membership_status, approval_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 'Pending')`,
      [student_id, first_name, middle_name || '', last_name, email, contact_number || '', assignedPosition, photo_url, qr_token, date_joined],
      function(err) {
        if (err) return res.json({ success: false, message: 'Registration failed due to database error.' });
        
        logAudit('PUBLIC_USER', 'GUEST', 'REGISTER_SUBMIT', `Registration submitted for Student ID ${student_id}`, req);
        return res.json({
          success: true,
          message: 'Registration submitted successfully!',
          student: { student_id, first_name, last_name, position_name: assignedPosition }
        });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

// Position Management APIs
app.get('/api/positions', (req, res) => {
  db.all(`SELECT * FROM positions ORDER BY position_name ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    res.json({ success: true, positions: rows });
  });
});

app.post('/api/positions', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const { position_name, description } = req.body;
  if (!position_name) return res.json({ success: false, message: 'Position name is required.' });

  db.run(`INSERT INTO positions (position_name, description) VALUES (?, ?)`, [position_name.trim(), description || ''], function(err) {
    if (err) return res.json({ success: false, message: 'Position already exists or invalid data.' });
    logAudit(req.session.user.username, req.session.user.role, 'CREATE_POSITION', `Created position ${position_name}`, req);
    res.json({ success: true, message: 'Position added successfully.' });
  });
});

app.put('/api/positions/:id', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const { position_name, description } = req.body;
  const id = req.params.id;

  db.get(`SELECT position_name FROM positions WHERE id = ?`, [id], (err, oldPos) => {
    if (err || !oldPos) return res.json({ success: false, message: 'Position not found.' });

    const oldName = oldPos.position_name;
    const newName = position_name.trim();

    db.run(`UPDATE positions SET position_name = ?, description = ? WHERE id = ?`, [newName, description || '', id], function(err) {
      if (err) return res.json({ success: false, message: 'Failed to update position name.' });
      
      // Cascade position rename to students and position history
      db.run(`UPDATE students SET position_name = ? WHERE position_name = ?`, [newName, oldName]);
      db.run(`UPDATE position_history SET position_name = ? WHERE position_name = ?`, [newName, oldName]);

      logAudit(req.session.user.username, req.session.user.role, 'UPDATE_POSITION', `Renamed position ${oldName} to ${newName}`, req);
      res.json({ success: true, message: 'Position updated across system.' });
    });
  });
});

app.delete('/api/positions/:id', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const id = req.params.id;
  db.get(`SELECT position_name FROM positions WHERE id = ?`, [id], (err, pos) => {
    if (err || !pos) return res.json({ success: false, message: 'Position not found.' });
    
    db.run(`DELETE FROM positions WHERE id = ?`, [id], function(err) {
      if (err) return res.json({ success: false, message: 'Failed to delete position.' });
      logAudit(req.session.user.username, req.session.user.role, 'DELETE_POSITION', `Deleted position ${pos.position_name}`, req);
      res.json({ success: true, message: 'Position deleted successfully.' });
    });
  });
});

// Student Management APIs
app.get('/api/students', requireAuth, (req, res) => {
  const { search, position, status, approval } = req.query;
  let query = `SELECT s.*, (s.first_name || ' ' || s.last_name) as full_name FROM students s WHERE 1=1`;
  const params = [];

  if (approval) {
    query += ` AND s.approval_status = ?`;
    params.push(approval);
  } else {
    query += ` AND s.approval_status = 'Approved'`;
  }

  if (position) {
    query += ` AND s.position_name = ?`;
    params.push(position);
  }
  if (status) {
    query += ` AND s.membership_status = ?`;
    params.push(status);
  }
  if (search) {
    query += ` AND (s.student_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ?)`;
    const sTerm = `%${search}%`;
    params.push(sTerm, sTerm, sTerm, sTerm);
  }

  query += ` ORDER BY s.last_name ASC, s.first_name ASC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    res.json({ success: true, students: rows });
  });
});

app.post('/api/students', requireAuth, requireRole(['ADMIN']), upload.single('photo'), async (req, res) => {
  try {
    const { student_id, first_name, middle_name, last_name, email, contact_number, position_name, date_joined, membership_status, membership_expiration } = req.body;
    if (!student_id || !first_name || !last_name || !email || !position_name) {
      return res.json({ success: false, message: 'Missing required student details.' });
    }

    const photo_url = req.file ? '/uploads/' + req.file.filename : '';
    const qr_token = 'QR_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const joinDate = date_joined || new Date().toISOString().split('T')[0];

    db.run(
      `INSERT INTO students (student_id, first_name, middle_name, last_name, email, contact_number, position_name, photo_url, qr_code_token, date_joined, membership_status, membership_expiration, approval_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Approved')`,
      [student_id, first_name, middle_name || '', last_name, email, contact_number || '', position_name, photo_url, qr_token, joinDate, membership_status || 'Active', membership_expiration || null],
      function(err) {
        if (err) return res.json({ success: false, message: 'Student ID or Email already exists.' });

        // Default Student User Account Creation (Default password: Student ID)
        const passwordHash = bcrypt.hashSync(student_id, 10);
        db.run(`INSERT INTO users (username, password_hash, role, student_id) VALUES (?, ?, 'STUDENT', ?)`, [student_id, passwordHash, student_id]);

        // Record Position History
        db.get(`SELECT school_year FROM settings WHERE id = 1`, (e, s) => {
          const sy = s ? s.school_year : '2026-2027';
          db.run(`INSERT INTO position_history (student_id, position_name, school_year) VALUES (?, ?, ?)`, [student_id, position_name, sy]);
        });

        logAudit(req.session.user.username, req.session.user.role, 'ADD_STUDENT', `Added student ${student_id} (${first_name} ${last_name})`, req);
        res.json({ success: true, message: 'Student created successfully.' });
      }
    );
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error adding student.' });
  }
});

app.put('/api/students/:student_id', requireAuth, requireRole(['ADMIN']), upload.single('photo'), (req, res) => {
  const targetId = req.params.student_id;
  const { first_name, middle_name, last_name, email, contact_number, position_name, membership_status, membership_expiration } = req.body;

  db.get(`SELECT * FROM students WHERE student_id = ?`, [targetId], (err, oldStudent) => {
    if (err || !oldStudent) return res.json({ success: false, message: 'Student record not found.' });

    const photo_url = req.file ? '/uploads/' + req.file.filename : oldStudent.photo_url;

    db.run(
      `UPDATE students SET first_name = ?, middle_name = ?, last_name = ?, email = ?, contact_number = ?, position_name = ?, photo_url = ?, membership_status = ?, membership_expiration = ?
       WHERE student_id = ?`,
      [first_name, middle_name || '', last_name, email, contact_number || '', position_name, photo_url, membership_status, membership_expiration || null, targetId],
      function(err) {
        if (err) return res.json({ success: false, message: 'Failed to update student profile.' });

        // Record Position History if Position Changed
        if (oldStudent.position_name !== position_name) {
          db.get(`SELECT school_year FROM settings WHERE id = 1`, (e, s) => {
            const sy = s ? s.school_year : '2026-2027';
            db.run(`INSERT INTO position_history (student_id, position_name, school_year) VALUES (?, ?, ?)`, [targetId, position_name, sy]);
          });
        }

        logAudit(req.session.user.username, req.session.user.role, 'UPDATE_STUDENT', `Updated student ${targetId}`, req);
        res.json({ success: true, message: 'Student details updated.' });
      }
    );
  });
});

app.post('/api/students/:student_id/approve', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const student_id = req.params.student_id;
  db.get(`SELECT * FROM students WHERE student_id = ?`, [student_id], (err, student) => {
    if (err || !student) return res.json({ success: false, message: 'Registration record not found.' });

    db.run(`UPDATE students SET approval_status = 'Approved' WHERE student_id = ?`, [student_id], function(err) {
      if (err) return res.json({ success: false, message: 'Approval failed.' });

      // Create Student Account Login
      const defaultHash = bcrypt.hashSync(student_id, 10);
      db.run(`INSERT OR IGNORE INTO users (username, password_hash, role, student_id) VALUES (?, ?, 'STUDENT', ?)`, [student_id, defaultHash, student_id]);

      // Record Position History
      db.get(`SELECT school_year FROM settings WHERE id = 1`, (e, s) => {
        const sy = s ? s.school_year : '2026-2027';
        db.run(`INSERT INTO position_history (student_id, position_name, school_year) VALUES (?, ?, ?)`, [student_id, student.position_name, sy]);
      });

      logAudit(req.session.user.username, req.session.user.role, 'APPROVE_STUDENT', `Approved student registration ${student_id}`, req);
      res.json({ success: true, message: 'Student registration approved successfully.' });
    });
  });
});

app.post('/api/students/:student_id/reject', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const student_id = req.params.student_id;
  db.run(`UPDATE students SET approval_status = 'Rejected' WHERE student_id = ?`, [student_id], function(err) {
    if (err) return res.json({ success: false, message: 'Rejection failed.' });
    logAudit(req.session.user.username, req.session.user.role, 'REJECT_STUDENT', `Rejected student registration ${student_id}`, req);
    res.json({ success: true, message: 'Registration rejected.' });
  });
});

app.post('/api/students/:student_id/regenerate-qr', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const student_id = req.params.student_id;
  const new_token = 'QR_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

  db.run(`UPDATE students SET qr_code_token = ? WHERE student_id = ?`, [new_token, student_id], function(err) {
    if (err) return res.json({ success: false, message: 'Failed to regenerate QR code token.' });
    logAudit(req.session.user.username, req.session.user.role, 'REGENERATE_QR', `Regenerated QR Token for student ${student_id}`, req);
    res.json({ success: true, message: 'QR Code regenerated successfully.', token: new_token });
  });
});

app.delete('/api/students/:student_id', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const student_id = req.params.student_id;
  db.run(`DELETE FROM students WHERE student_id = ?`, [student_id], function(err) {
    if (err) return res.json({ success: false, message: 'Failed to delete student.' });
    db.run(`DELETE FROM users WHERE student_id = ?`, [student_id]);
    logAudit(req.session.user.username, req.session.user.role, 'DELETE_STUDENT', `Deleted student ${student_id}`, req);
    res.json({ success: true, message: 'Student deleted successfully.' });
  });
});

app.get('/api/students/:student_id/history', requireAuth, (req, res) => {
  const student_id = req.params.student_id;
  db.all(`SELECT * FROM position_history WHERE student_id = ? ORDER BY assigned_date DESC`, [student_id], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    res.json({ success: true, history: rows });
  });
});

// Event Management APIs
app.get('/api/events', requireAuth, (req, res) => {
  db.all(`SELECT * FROM events ORDER BY event_date DESC, start_time DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    res.json({ success: true, events: rows });
  });
});

app.post('/api/events', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const { event_name, description, event_type, event_date, start_time, end_time, location, organizer, target_audience, allowed_positions } = req.body;
  if (!event_name || !event_date || !start_time || !end_time || !location) {
    return res.json({ success: false, message: 'Please complete required event parameters.' });
  }

  const positionsStr = Array.isArray(allowed_positions) ? allowed_positions.join(',') : (allowed_positions || '');

  db.run(
    `INSERT INTO events (event_name, description, event_type, event_date, start_time, end_time, location, organizer, target_audience, allowed_positions, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPCOMING')`,
    [event_name, description || '', event_type || 'General Club Attendance', event_date, start_time, end_time, location, organizer || 'Club Adviser', target_audience || 'ALL', positionsStr],
    function(err) {
      if (err) return res.json({ success: false, message: 'Failed to create event.' });
      logAudit(req.session.user.username, req.session.user.role, 'CREATE_EVENT', `Created event ${event_name}`, req);
      res.json({ success: true, message: 'Event created successfully.' });
    }
  );
});

app.put('/api/events/:id', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const id = req.params.id;
  const { event_name, description, event_type, event_date, start_time, end_time, location, organizer, target_audience, allowed_positions, status } = req.body;
  const positionsStr = Array.isArray(allowed_positions) ? allowed_positions.join(',') : (allowed_positions || '');

  db.run(
    `UPDATE events SET event_name = ?, description = ?, event_type = ?, event_date = ?, start_time = ?, end_time = ?, location = ?, organizer = ?, target_audience = ?, allowed_positions = ?, status = ?
     WHERE id = ?`,
    [event_name, description || '', event_type, event_date, start_time, end_time, location, organizer, target_audience, positionsStr, status, id],
    function(err) {
      if (err) return res.json({ success: false, message: 'Failed to update event.' });
      logAudit(req.session.user.username, req.session.user.role, 'UPDATE_EVENT', `Updated event ID ${id}`, req);
      res.json({ success: true, message: 'Event updated.' });
    }
  );
});

app.delete('/api/events/:id', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM events WHERE id = ?`, [id], function(err) {
    if (err) return res.json({ success: false, message: 'Failed to delete event.' });
    logAudit(req.session.user.username, req.session.user.role, 'DELETE_EVENT', `Deleted event ID ${id}`, req);
    res.json({ success: true, message: 'Event deleted.' });
  });
});

// Automatic Absent Detection Algorithm execution for completed events
app.post('/api/events/:id/close-and-mark-absent', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  const eventId = req.params.id;
  try {
    const event = await new Promise((res, rej) => db.get("SELECT * FROM events WHERE id = ?", [eventId], (e, r) => e ? rej(e) : res(r)));
    if (!event) return res.json({ success: false, message: 'Event not found' });

    // Fetch Eligible Students
    let eligibleQuery = `SELECT student_id FROM students WHERE approval_status = 'Approved' AND membership_status = 'Active'`;
    if (event.target_audience === 'OFFICERS_ONLY') {
      eligibleQuery += ` AND position_name != 'Member'`;
    } else if (event.target_audience === 'SPECIFIC_POSITIONS' && event.allowed_positions) {
      const allowedArr = event.allowed_positions.split(',').map(p => `'${p.trim()}'`).join(',');
      eligibleQuery += ` AND position_name IN (${allowedArr})`;
    }

    const eligibleStudents = await new Promise((res, rej) => db.all(eligibleQuery, [], (e, r) => e ? rej(e) : res(r)));
    const existingAttendance = await new Promise((res, rej) => db.all("SELECT student_id FROM attendance WHERE event_id = ?", [eventId], (e, r) => e ? rej(e) : res(r)));
    const attendedSet = new Set(existingAttendance.map(a => a.student_id));

    let absentCount = 0;
    for (const student of eligibleStudents) {
      if (!attendedSet.has(student.student_id)) {
        await new Promise((res, rej) => {
          db.run(`INSERT OR IGNORE INTO attendance (event_id, student_id, status, notes) VALUES (?, ?, 'ABSENT', 'Automated End-of-Event Record')`, [eventId, student.student_id], (e) => e ? rej(e) : res());
        });
        absentCount++;
      }
    }

    await new Promise((res, rej) => db.run("UPDATE events SET status = 'COMPLETED' WHERE id = ?", [eventId], (e) => e ? rej(e) : res()));
    logAudit(req.session.user.username, req.session.user.role, 'MARK_ABSENT', `Closed event ${eventId} and flagged ${absentCount} absent students`, req);

    res.json({ success: true, message: `Event marked as completed. ${absentCount} absent records finalized.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error closing event' });
  }
});

// Attendance & Scanner Processing APIs
app.post('/api/attendance/scan', requireAuth, requireRole(['ADMIN', 'SCANNER']), async (req, res) => {
  const { event_id, qr_token, scan_mode } = req.body; // scan_mode: 'TIME_IN' or 'TIME_OUT'

  if (!event_id || !qr_token) {
    return res.json({ success: false, code: 'INVALID_DATA', message: 'Missing event identifier or QR token.' });
  }

  try {
    const event = await new Promise((res, rej) => db.get("SELECT * FROM events WHERE id = ?", [event_id], (e, r) => e ? rej(e) : res(r)));
    if (!event) return res.json({ success: false, code: 'EVENT_NOT_FOUND', message: 'Selected event does not exist.' });

    const student = await new Promise((res, rej) => db.get("SELECT * FROM students WHERE qr_code_token = ?", [qr_token], (e, r) => e ? rej(e) : res(r)));
    if (!student || student.approval_status !== 'Approved' || student.membership_status !== 'Active') {
      return res.json({ success: false, code: 'INVALID_QR', message: 'Invalid or Inactive QR Code.' });
    }

    // Target Audience Security Verification
    if (event.target_audience === 'OFFICERS_ONLY' && student.position_name === 'Member') {
      return res.json({ success: false, code: 'UNAUTHORIZED_EVENT', message: `${student.first_name} ${student.last_name} is not authorized for Officer-only events.` });
    }
    if (event.target_audience === 'SPECIFIC_POSITIONS' && event.allowed_positions) {
      const allowedArr = event.allowed_positions.split(',').map(p => p.trim());
      if (!allowedArr.includes(student.position_name)) {
        return res.json({ success: false, code: 'UNAUTHORIZED_EVENT', message: `Position '${student.position_name}' is not authorized for this event.` });
      }
    }

    const now = new Date();
    const timeStr = now.toISOString();

    const existingAtt = await new Promise((res, rej) => db.get("SELECT * FROM attendance WHERE event_id = ? AND student_id = ?", [event_id, student.student_id], (e, r) => e ? rej(e) : res(r)));

    if (scan_mode === 'TIME_OUT') {
      if (!existingAtt || !existingAtt.time_in) {
        return res.json({ success: false, code: 'NO_TIME_IN', message: `${student.first_name} ${student.last_name} has not timed in yet.` });
      }
      if (existingAtt.time_out) {
        return res.json({ success: false, code: 'DUPLICATE_SCAN', message: `${student.first_name} ${student.last_name} has already timed out.`, student });
      }

      await new Promise((res, rej) => {
        db.run("UPDATE attendance SET time_out = ? WHERE id = ?", [timeStr, existingAtt.id], (e) => e ? rej(e) : res());
      });

      logAudit(req.session.user.username, req.session.user.role, 'SCAN_TIME_OUT', `Time Out logged for ${student.student_id}`, req);
      return res.json({
        success: true,
        action: 'TIME_OUT',
        message: 'Time out recorded.',
        student: {
          student_id: student.student_id,
          full_name: `${student.first_name} ${student.last_name}`,
          position_name: student.position_name,
          photo_url: student.photo_url,
          time_out: now.toLocaleTimeString()
        }
      });
    } else {
      // DEFAULT: TIME_IN
      if (existingAtt && existingAtt.time_in) {
        return res.json({
          success: false,
          code: 'DUPLICATE_SCAN',
          message: `${student.first_name} ${student.last_name} is already recorded for this event.`,
          student: { full_name: `${student.first_name} ${student.last_name}` }
        });
      }

      // Late Calculation Threshold Logic
      const settings = await new Promise((res, rej) => db.get("SELECT late_threshold_minutes FROM settings WHERE id = 1", (e, r) => e ? rej(e) : res(r)));
      const lateMins = settings ? settings.late_threshold_minutes : 15;
      
      const eventStartDateTime = new Date(`${event.event_date}T${event.start_time}`);
      const lateCutoff = new Date(eventStartDateTime.getTime() + lateMins * 60000);

      let attStatus = 'PRESENT';
      if (now > lateCutoff) attStatus = 'LATE';

      if (existingAtt) {
        await new Promise((res, rej) => {
          db.run("UPDATE attendance SET time_in = ?, status = ?, scanned_by = ? WHERE id = ?", [timeStr, attStatus, req.session.user.username, existingAtt.id], (e) => e ? rej(e) : res());
        });
      } else {
        await new Promise((res, rej) => {
          db.run("INSERT INTO attendance (event_id, student_id, time_in, status, scanned_by) VALUES (?, ?, ?, ?, ?)", [event_id, student.student_id, timeStr, attStatus, req.session.user.username], (e) => e ? rej(e) : res());
        });
      }

      logAudit(req.session.user.username, req.session.user.role, 'SCAN_TIME_IN', `Time In (${attStatus}) logged for ${student.student_id}`, req);
      return res.json({
        success: true,
        action: 'TIME_IN',
        status: attStatus,
        message: `Attendance recorded as ${attStatus}.`,
        student: {
          student_id: student.student_id,
          full_name: `${student.first_name} ${student.last_name}`,
          position_name: student.position_name,
          photo_url: student.photo_url,
          time_in: now.toLocaleTimeString()
        }
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Error processing scanner API request.' });
  }
});

app.get('/api/attendance/event/:event_id', requireAuth, (req, res) => {
  const eventId = req.params.event_id;
  db.all(
    `SELECT a.*, s.first_name, s.last_name, (s.first_name || ' ' || s.last_name) as full_name, s.position_name, s.photo_url
     FROM attendance a
     JOIN students s ON a.student_id = s.student_id
     WHERE a.event_id = ?
     ORDER BY a.created_at DESC`,
    [eventId],
    (err, rows) => {
      if (err) return res.status(500).json({ success: false, message: 'Database error' });
      res.json({ success: true, attendance: rows });
    }
  );
});

app.put('/api/attendance/:id', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const { status, notes } = req.body;
  const id = req.params.id;

  db.run(`UPDATE attendance SET status = ?, notes = ? WHERE id = ?`, [status, notes || '', id], function(err) {
    if (err) return res.json({ success: false, message: 'Failed to adjust attendance record.' });
    logAudit(req.session.user.username, req.session.user.role, 'UPDATE_ATTENDANCE', `Updated attendance ID ${id} to ${status}`, req);
    res.json({ success: true, message: 'Attendance status adjusted successfully.' });
  });
});

// Analytics & Dashboard Summary APIs
app.get('/api/analytics/dashboard', requireAuth, async (req, res) => {
  try {
    const totalStudents = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM students WHERE approval_status = 'Approved'", (e, row) => e ? j(e) : r(row.cnt)));
    const activeStudents = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM students WHERE approval_status = 'Approved' AND membership_status = 'Active'", (e, row) => e ? j(e) : r(row.cnt)));
    const inactiveStudents = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM students WHERE approval_status = 'Approved' AND membership_status != 'Active'", (e, row) => e ? j(e) : r(row.cnt)));
    const totalOfficers = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM students WHERE approval_status = 'Approved' AND position_name != 'Member'", (e, row) => e ? j(e) : r(row.cnt)));
    const pendingRegistrations = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM students WHERE approval_status = 'Pending'", (e, row) => e ? j(e) : r(row.cnt)));

    const todayStr = new Date().toISOString().split('T')[0];
    const presentToday = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM attendance WHERE status = 'PRESENT' AND date(time_in) = ?", [todayStr], (e, row) => e ? j(e) : r(row.cnt)));
    const lateToday = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM attendance WHERE status = 'LATE' AND date(time_in) = ?", [todayStr], (e, row) => e ? j(e) : r(row.cnt)));
    const absentToday = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM attendance WHERE status = 'ABSENT' AND date(created_at) = ?", [todayStr], (e, row) => e ? j(e) : r(row.cnt)));

    // Position Distribution
    const positionStats = await new Promise((r, j) => db.all("SELECT position_name, COUNT(*) as count FROM students WHERE approval_status = 'Approved' GROUP BY position_name", [], (e, rows) => e ? j(e) : r(rows)));

    // Active Event
    const activeEvent = await new Promise((r, j) => db.get("SELECT * FROM events WHERE status = 'ACTIVE' ORDER BY id DESC LIMIT 1", [], (e, row) => e ? j(e) : r(row)));

    // Recent Scans
    const recentScans = await new Promise((r, j) => db.all(
      `SELECT a.*, (s.first_name || ' ' || s.last_name) as full_name, s.position_name, e.event_name
       FROM attendance a
       JOIN students s ON a.student_id = s.student_id
       JOIN events e ON a.event_id = e.id
       ORDER BY a.created_at DESC LIMIT 10`,
      [], (e, rows) => e ? j(e) : r(rows)
    ));

    res.json({
      success: true,
      stats: {
        totalStudents,
        activeStudents,
        inactiveStudents,
        totalOfficers,
        pendingRegistrations,
        presentToday,
        lateToday,
        absentToday,
        positionStats,
        activeEvent,
        recentScans
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Analytics aggregation error' });
  }
});

// Participation Analytics & Ranking APIs
app.get('/api/analytics/participation', requireAuth, async (req, res) => {
  try {
    const totalEvents = await new Promise((r, j) => db.get("SELECT COUNT(*) as cnt FROM events WHERE status = 'COMPLETED'", (e, row) => e ? j(e) : r(row.cnt)));
    
    const query = `
      SELECT s.student_id, (s.first_name || ' ' || s.last_name) as full_name, s.position_name, s.membership_status,
             COUNT(CASE WHEN a.status IN ('PRESENT', 'LATE') THEN 1 END) as attended_count,
             COUNT(CASE WHEN a.status = 'PRESENT' THEN 1 END) as present_count,
             COUNT(CASE WHEN a.status = 'LATE' THEN 1 END) as late_count,
             COUNT(CASE WHEN a.status = 'ABSENT' THEN 1 END) as absent_count,
             COUNT(CASE WHEN a.status = 'EXCUSED' THEN 1 END) as excused_count
      FROM students s
      LEFT JOIN attendance a ON s.student_id = a.student_id
      WHERE s.approval_status = 'Approved'
      GROUP BY s.student_id
      ORDER BY attended_count DESC, s.last_name ASC`;

    const stats = await new Promise((r, j) => db.all(query, [], (e, rows) => e ? j(e) : r(rows)));
    const totalVal = totalEvents || 1;

    const computed = stats.map(s => {
      const rate = Math.round((s.attended_count / totalVal) * 100);
      return { ...s, total_events: totalVal, participation_rate: Math.min(rate, 100) };
    });

    res.json({ success: true, total_events: totalEvents, participation: computed });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to calculate participation' });
  }
});

// Student Member Portal Data Route
app.get('/api/student/portal-data', requireAuth, requireRole(['STUDENT']), async (req, res) => {
  const student_id = req.session.user.student_id;
  try {
    const student = await new Promise((r, j) => db.get("SELECT * FROM students WHERE student_id = ?", [student_id], (e, row) => e ? j(e) : r(row)));
    const settings = await new Promise((r, j) => db.get("SELECT * FROM settings WHERE id = 1", (e, row) => e ? j(e) : r(row)));
    const attendance = await new Promise((r, j) => db.all(
      `SELECT a.*, e.event_name, e.event_date, e.event_type 
       FROM attendance a 
       JOIN events e ON a.event_id = e.id 
       WHERE a.student_id = ? 
       ORDER BY e.event_date DESC`,
      [student_id], (e, rows) => e ? j(e) : r(rows)
    ));
    const upcomingEvents = await new Promise((r, j) => db.all("SELECT * FROM events WHERE status = 'UPCOMING' ORDER BY event_date ASC", [], (e, rows) => e ? j(e) : r(rows)));

    // Generate Dynamic QR Data URL for Student Portal
    const qrDataUrl = await QRCode.toDataURL(student.qr_code_token, { width: 300, margin: 2 });

    res.json({
      success: true,
      student,
      settings,
      attendance,
      upcomingEvents,
      qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Portal load failure' });
  }
});

// Reports Generation & Printing Data Route
app.get('/api/reports/generate', requireAuth, async (req, res) => {
  const { report_type, event_id, position_name, start_date, end_date } = req.query;
  try {
    const settings = await new Promise((r, j) => db.get("SELECT * FROM settings WHERE id = 1", (e, row) => e ? j(e) : r(row)));
    let query = `
      SELECT a.*, s.first_name, s.last_name, (s.first_name || ' ' || s.last_name) as full_name, s.position_name, e.event_name, e.event_date, e.event_type
      FROM attendance a
      JOIN students s ON a.student_id = s.student_id
      JOIN events e ON a.event_id = e.id
      WHERE 1=1`;
    const params = [];

    if (event_id) { query += ` AND a.event_id = ?`; params.push(event_id); }
    if (position_name) { query += ` AND s.position_name = ?`; params.push(position_name); }
    if (start_date) { query += ` AND date(e.event_date) >= ?`; params.push(start_date); }
    if (end_date) { query += ` AND date(e.event_date) <= ?`; params.push(end_date); }

    query += ` ORDER BY e.event_date DESC, s.last_name ASC`;

    const reportData = await new Promise((r, j) => db.all(query, params, (e, rows) => e ? j(e) : r(rows)));

    res.json({
      success: true,
      settings,
      generated_at: new Date().toLocaleString(),
      report_type: report_type || 'General Attendance',
      records: reportData
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Report generation failed.' });
  }
});

// CSV Data Export API Route
app.get('/api/export/csv', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const { type } = req.query; // 'students' or 'attendance'

  if (type === 'students') {
    db.all(`SELECT student_id, first_name, middle_name, last_name, email, contact_number, position_name, date_joined, membership_status FROM students WHERE approval_status = 'Approved'`, [], (err, rows) => {
      if (err) return res.status(500).send('Database Error');
      let csv = 'Student ID,First Name,Middle Name,Last Name,Email,Contact,Position,Date Joined,Status\n';
      rows.forEach(r => {
        csv += `"${r.student_id}","${r.first_name}","${r.middle_name}","${r.last_name}","${r.email}","${r.contact_number}","${r.position_name}","${r.date_joined}","${r.membership_status}"\n`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="Students_List.csv"');
      res.status(200).send(csv);
    });
  } else {
    db.all(`SELECT a.id, a.student_id, (s.first_name || ' ' || s.last_name) as full_name, s.position_name, e.event_name, e.event_date, a.time_in, a.time_out, a.status, a.notes 
            FROM attendance a 
            JOIN students s ON a.student_id = s.student_id 
            JOIN events e ON a.event_id = e.id`, [], (err, rows) => {
      if (err) return res.status(500).send('Database Error');
      let csv = 'Record ID,Student ID,Student Name,Position,Event Name,Event Date,Time In,Time Out,Status,Notes\n';
      rows.forEach(r => {
        csv += `"${r.id}","${r.student_id}","${r.full_name}","${r.position_name}","${r.event_name}","${r.event_date}","${r.time_in || ''}","${r.time_out || ''}","${r.status}","${r.notes || ''}"\n`;
      });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="Attendance_Logs.csv"');
      res.status(200).send(csv);
    });
  }
});

// Audit Logs API Route
app.get('/api/audit-logs', requireAuth, requireRole(['ADMIN']), (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 200`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });
    res.json({ success: true, logs: rows });
  });
});

// Database Backup and Restore APIs
app.get('/api/system/backup', requireAuth, requireRole(['ADMIN']), (req, res) => {
  const backupFileName = `backup_club_attendance_${Date.now()}.db`;
  const destPath = path.join(backupsDir, backupFileName);

  fs.copyFile(dbPath, destPath, (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Backup creation failed.' });
    logAudit(req.session.user.username, req.session.user.role, 'BACKUP_DB', `Created backup ${backupFileName}`, req);
    res.download(destPath, backupFileName);
  });
});

app.post('/api/system/restore', requireAuth, requireRole(['ADMIN']), upload.single('backup_file'), (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'Please upload a valid SQLite backup file.' });

  const tempBackupPath = req.file.path;
  
  db.close((err) => {
    if (err) return res.json({ success: false, message: 'Failed to lock database for restore.' });

    fs.copyFile(tempBackupPath, dbPath, (err) => {
      // Re-open DB Connection
      global.db = new sqlite3.Database(dbPath);
      if (err) return res.json({ success: false, message: 'Failed to restore database file.' });

      logAudit(req.session.user.username, req.session.user.role, 'RESTORE_DB', 'Restored system database from backup upload', req);
      res.json({ success: true, message: 'Database restored successfully. System re-initialized.' });
    });
  });
});

// QR Code Rendering Batch API for Printing A4 Grid
app.get('/api/students/qr-batch', requireAuth, async (req, res) => {
  const { ids } = req.query; // Comma separated student IDs or empty for ALL
  let query = `SELECT * FROM students WHERE approval_status = 'Approved'`;
  const params = [];

  if (ids) {
    const idList = ids.split(',').map(i => `'${i.trim()}'`).join(',');
    query += ` AND student_id IN (${idList})`;
  }

  db.all(query, params, async (err, students) => {
    if (err) return res.status(500).json({ success: false, message: 'Database error' });

    try {
      const studentCards = await Promise.all(students.map(async (st) => {
        const qrDataUrl = await QRCode.toDataURL(st.qr_code_token, { width: 180, margin: 1 });
        return { ...st, qrDataUrl };
      }));
      res.json({ success: true, students: studentCards });
    } catch (e) {
      res.status(500).json({ success: false, message: 'QR Rendering failed' });
    }
  });
});


// ==========================================
// FULL EMBEDDED SINGLE-PAGE CLIENT WEB APP
// ==========================================
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Student Club QR Attendance System</title>
  <!-- CSS Framework & Font Icons -->
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css" rel="stylesheet">
  <!-- HTML5 QR Camera Scanner Library -->
  <script src="https://unpkg.com/html5-qrcode"></script>
  
  <style>
    :root {
      --primary-color: #1e3a8a;
      --secondary-color: #3b82f6;
      --accent-color: #06b6d4;
      --dark-bg: #0f172a;
      --light-bg: #f8fafc;
    }
    body {
      background-color: #f1f5f9;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    .sidebar {
      min-height: 100vh;
      background: var(--dark-bg);
      color: #fff;
    }
    .sidebar .nav-link {
      color: #94a3b8;
      padding: 0.75rem 1.25rem;
      font-weight: 500;
      border-radius: 6px;
      margin-bottom: 4px;
    }
    .sidebar .nav-link:hover, .sidebar .nav-link.active {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }
    .sidebar .nav-link i {
      margin-right: 10px;
    }
    .content-area {
      padding: 20px;
    }
    .card-stat {
      border: none;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
      transition: transform 0.2s;
    }
    .card-stat:hover {
      transform: translateY(-3px);
    }
    .id-card-a4 {
      width: 3.375in;
      height: 2.125in;
      border: 2px dashed #cbd5e1;
      border-radius: 8px;
      padding: 8px;
      background: #fff;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
      page-break-inside: avoid;
    }
    .id-card-header {
      background: var(--primary-color);
      color: white;
      text-align: center;
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
    }
    .id-card-body {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 4px;
    }
    .id-card-photo {
      width: 60px;
      height: 60px;
      border-radius: 4px;
      object-fit: cover;
      border: 1px solid #cbd5e1;
    }
    .id-card-qr {
      width: 65px;
      height: 65px;
    }
    .id-card-details {
      font-size: 9px;
      line-height: 1.2;
    }
    .a4-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 15px;
      padding: 20px;
      background: white;
    }
    @media print {
      body * { visibility: hidden; }
      #printableArea, #printableArea * { visibility: visible; }
      #printableArea { position: absolute; left: 0; top: 0; width: 100%; }
      .no-print { display: none !important; }
    }
    .scanner-preview {
      width: 100%;
      max-width: 500px;
      border-radius: 12px;
      overflow: hidden;
      border: 3px solid var(--secondary-color);
    }
  </style>
</head>
<body>

<div id="app">
  <!-- Dynamic Dynamic Navigation & View Rendering Root -->
  <div class="text-center p-5 mt-5">
    <div class="spinner-border text-primary" role="status"></div>
    <p class="mt-2 text-muted">Loading Student Club System...</p>
  </div>
</div>

<!-- Core Client-Side Logic -->
<script>
  // Global State Application Object
  const state = {
    user: null,
    settings: {},
    currentRoute: 'login',
    positions: [],
    scanner: null,
    voiceEnabled: true,
    scannerMode: 'TIME_IN'
  };

  // API Call Wrapper
  async function apiCall(url, method = 'GET', body = null, isFormData = false) {
    try {
      const options = { method, headers: {} };
      if (body) {
        if (isFormData) {
          options.body = body;
        } else {
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify(body);
        }
      }
      const res = await fetch(url, options);
      return await res.json();
    } catch (err) {
      console.error('API Error:', err);
      return { success: false, message: 'Network or server error.' };
    }
  }

  // Audio Speech Synthesis Voice Announcement
  function speak(text) {
    if (!state.voiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  // Sound Effect Audio Feedback
  function playAudioFeedback(type) {
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
    } else if (type === 'warning') {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } else { // Error
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      osc.frequency.setValueAtTime(110, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    }
  }

  // App Initialization Sequence
  async function initApp() {
    const setRes = await apiCall('/api/settings');
    if (setRes.success) state.settings = setRes.settings;

    const authRes = await apiCall('/api/auth/me');
    if (authRes.loggedIn) {
      state.user = authRes.user;
      if (window.location.pathname === '/register') {
        renderPublicRegistration();
      } else if (state.user.role === 'ADMIN') {
        navigate('dashboard');
      } else if (state.user.role === 'SCANNER') {
        navigate('scanner');
      } else {
        navigate('student-portal');
      }
    } else {
      if (window.location.pathname === '/register') {
        renderPublicRegistration();
      } else {
        renderLogin();
      }
    }
  }

  // Router Engine
  function navigate(route) {
    state.currentRoute = route;
    if (state.scanner) {
      try { state.scanner.clear(); } catch(e){}
    }
    
    switch (route) {
      case 'dashboard': renderAdminDashboard(); break;
      case 'students': renderStudentManagement(); break;
      case 'registrations': renderPendingRegistrations(); break;
      case 'positions': renderPositionManagement(); break;
      case 'events': renderEventManagement(); break;
      case 'scanner': renderScannerPortal(); break;
      case 'student-portal': renderStudentPortal(); break;
      case 'reports': renderReportsPage(); break;
      case 'id-printing': renderIDPrintingPage(); break;
      case 'audit-logs': renderAuditLogsPage(); break;
      case 'settings': renderSettingsPage(); break;
      default: renderLogin(); break;
    }
  }

  // UI Framework Shell Wrapper
  function renderAppShell(contentHtml, activeNav = '') {
    const appEl = document.getElementById('app');
    const u = state.user || {};

    appEl.innerHTML = \`
      <div class="container-fluid">
        <div class="row">
          <!-- Sidebar Navigation -->
          <div class="col-md-3 col-lg-2 sidebar d-flex flex-column justify-content-between p-3 no-print">
            <div>
              <div class="text-center mb-4">
                <i class="bi bi-qr-code-scan text-primary fs-1"></i>
                <h5 class="mt-2 mb-0 fw-bold text-white">\${state.settings.club_name || 'Student Club'}</h5>
                <small class="text-muted">\${state.settings.school_name || 'School Attendance'}</small>
              </div>
              <hr class="text-secondary">
              <ul class="nav nav-pills flex-column mb-auto">
                \${u.role === 'ADMIN' ? \`
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'dashboard' ? 'active' : ''}" onclick="navigate('dashboard')"><i class="bi bi-speedometer2"></i> Dashboard</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'registrations' ? 'active' : ''}" onclick="navigate('registrations')"><i class="bi bi-person-plus"></i> Registrations</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'students' ? 'active' : ''}" onclick="navigate('students')"><i class="bi bi-people"></i> Students</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'positions' ? 'active' : ''}" onclick="navigate('positions')"><i class="bi bi-award"></i> Positions</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'events' ? 'active' : ''}" onclick="navigate('events')"><i class="bi bi-calendar-event"></i> Events</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'id-printing' ? 'active' : ''}" onclick="navigate('id-printing')"><i class="bi bi-card-heading"></i> Print Club IDs</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'reports' ? 'active' : ''}" onclick="navigate('reports')"><i class="bi bi-bar-chart"></i> Reports</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'audit-logs' ? 'active' : ''}" onclick="navigate('audit-logs')"><i class="bi bi-shield-check"></i> Audit Logs</a></li>
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'settings' ? 'active' : ''}" onclick="navigate('settings')"><i class="bi bi-gear"></i> Settings</a></li>
                \` : ''}
                \${u.role === 'ADMIN' || u.role === 'SCANNER' ? \`
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'scanner' ? 'active' : ''}" onclick="navigate('scanner')"><i class="bi bi-qr-code-scan"></i> Scanner Portal</a></li>
                \` : ''}
                \${u.role === 'STUDENT' ? \`
                  <li class="nav-item"><a href="#" class="nav-link \${activeNav === 'student-portal' ? 'active' : ''}" onclick="navigate('student-portal')"><i class="bi bi-person-badge"></i> My Student Portal</a></li>
                \` : ''}
              </ul>
            </div>
            <div>
              <hr class="text-secondary">
              <div class="d-flex align-items-center justify-content-between">
                <div>
                  <strong class="d-block text-white">\${u.username || 'User'}</strong>
                  <small class="text-muted">\${u.role || ''}</small>
                </div>
                <button class="btn btn-sm btn-outline-danger" onclick="handleLogout()"><i class="bi bi-box-arrow-right"></i></button>
              </div>
              <button class="btn btn-sm btn-link text-white-50 p-0 mt-2 text-decoration-none" onclick="openPasswordModal()">Change Password</button>
            </div>
          </div>

          <!-- Main Content Area -->
          <div class="col-md-9 col-lg-10 content-area">
            \${contentHtml}
          </div>
        </div>
      </div>

      <!-- Change Password Modal -->
      <div class="modal fade" id="passwordModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Change Password</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <form id="changePasswordForm" onsubmit="handleChangePassword(event)">
                <div class="mb-3">
                  <label class="form-label">Current Password</label>
                  <input type="password" id="currPass" class="form-control" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">New Password (Min 8 chars)</label>
                  <input type="password" id="newPass" class="form-control" minlength="8" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">Confirm New Password</label>
                  <input type="password" id="confirmPass" class="form-control" minlength="8" required>
                </div>
                <button type="submit" class="btn btn-primary w-100">Update Password</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    \`;
  }

  // Authentication Handlers
  async function handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value;
    const p = document.getElementById('loginPassword').value;
    const res = await apiCall('/api/auth/login', 'POST', { username: u, password: p });
    if (res.success) {
      state.user = { username: u, role: res.role };
      if (res.role === 'ADMIN') navigate('dashboard');
      else if (res.role === 'SCANNER') navigate('scanner');
      else navigate('student-portal');
    } else {
      alert(res.message);
    }
  }

  async function handleLogout() {
    await apiCall('/api/auth/logout', 'POST');
    state.user = null;
    renderLogin();
  }

  function openPasswordModal() {
    const modal = new bootstrap.Modal(document.getElementById('passwordModal'));
    modal.show();
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    const currentPassword = document.getElementById('currPass').value;
    const newPassword = document.getElementById('newPass').value;
    const confirmPassword = document.getElementById('confirmPass').value;

    const res = await apiCall('/api/auth/change-password', 'POST', { currentPassword, newPassword, confirmPassword });
    alert(res.message);
    if (res.success) {
      bootstrap.Modal.getInstance(document.getElementById('passwordModal')).hide();
    }
  }

  // Views Renderers
  function renderLogin() {
    document.getElementById('app').innerHTML = \`
      <div class="container d-flex justify-content-center align-items-center vh-100">
        <div class="card shadow-lg p-4" style="max-width: 400px; width: 100%; border-radius: 16px;">
          <div class="text-center mb-4">
            <i class="bi bi-qr-code-scan text-primary fs-1"></i>
            <h4 class="fw-bold mt-2">\${state.settings.club_name || 'Student Club Attendance'}</h4>
            <p class="text-muted small">\${state.settings.school_name || 'Apex National High School'}</p>
          </div>
          <form onsubmit="handleLogin(event)">
            <div class="mb-3">
              <label class="form-label font-weight-bold">Username / Student ID</label>
              <input type="text" id="loginUsername" class="form-control" placeholder="Enter username" required>
            </div>
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" id="loginPassword" class="form-control" placeholder="Enter password" required>
            </div>
            <button type="submit" class="btn btn-primary w-100 py-2">Sign In</button>
          </form>
          <hr class="my-4">
          <div class="text-center">
            <small class="text-muted">Are you a new student member?</small><br>
            <a href="/register" class="btn btn-link btn-sm fw-bold">Open Public Self-Registration</a>
          </div>
        </div>
      </div>
    \`;
  }

  function renderPublicRegistration() {
    fetch('/api/positions').then(r => r.json()).then(posRes => {
      const positions = posRes.positions || [];
      const posOptions = positions.map(p => \`<option value="\${p.position_name}">\${p.position_name}</option>\`).join('');

      document.getElementById('app').innerHTML = \`
        <div class="container py-5" style="max-width: 600px;">
          <div class="card shadow border-0" style="border-radius: 16px;">
            <div class="card-body p-4">
              <div class="text-center mb-4">
                <i class="bi bi-person-plus-fill text-primary fs-1"></i>
                <h3 class="fw-bold mt-2">\${state.settings.club_name || 'Student Club'} Registration</h3>
                <p class="text-muted">\${state.settings.school_name || 'School Membership Form'}</p>
              </div>
              <div id="regSuccessAlert" class="d-none alert alert-success"></div>
              <form id="publicRegForm" onsubmit="handlePublicRegistration(event)">
                <div class="mb-3">
                  <label class="form-label fw-bold">Student ID *</label>
                  <input type="text" id="regStudentId" class="form-control" placeholder="e.g. 2026-001" required>
                </div>
                <div class="row">
                  <div class="col-md-5 mb-3">
                    <label class="form-label fw-bold">First Name *</label>
                    <input type="text" id="regFirstName" class="form-control" required>
                  </div>
                  <div class="col-md-2 mb-3">
                    <label class="form-label">M.I.</label>
                    <input type="text" id="regMiddleName" class="form-control" maxlength="2">
                  </div>
                  <div class="col-md-5 mb-3">
                    <label class="form-label fw-bold">Last Name *</label>
                    <input type="text" id="regLastName" class="form-control" required>
                  </div>
                </div>
                <div class="mb-3">
                  <label class="form-label fw-bold">School Email *</label>
                  <input type="email" id="regEmail" class="form-control" placeholder="student@school.edu" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">Contact Number (Optional)</label>
                  <input type="text" id="regContact" class="form-control">
                </div>
                \${state.settings.allow_student_positions ? \`
                  <div class="mb-3">
                    <label class="form-label fw-bold">Apply for Position</label>
                    <select id="regPosition" class="form-select">\${posOptions}</select>
                  </div>
                \` : \`
                  <input type="hidden" id="regPosition" value="Member">
                \`}
                <div class="mb-3">
                  <label class="form-label">Student Photo (Optional)</label>
                  <input type="file" id="regPhoto" class="form-control" accept="image/*">
                </div>
                <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Submit Registration</button>
              </form>
              <div class="text-center mt-3">
                <a href="/" class="text-decoration-none small">Return to Login Page</a>
              </div>
            </div>
          </div>
        </div>
      \`;
    });
  }

  async function handlePublicRegistration(e) {
    e.preventDefault();
    const formData = new FormData();
    formData.append('student_id', document.getElementById('regStudentId').value);
    formData.append('first_name', document.getElementById('regFirstName').value);
    formData.append('middle_name', document.getElementById('regMiddleName').value);
    formData.append('last_name', document.getElementById('regLastName').value);
    formData.append('email', document.getElementById('regEmail').value);
    formData.append('contact_number', document.getElementById('regContact').value);
    formData.append('position_name', document.getElementById('regPosition').value);

    const photoFile = document.getElementById('regPhoto').files[0];
    if (photoFile) formData.append('photo', photoFile);

    const res = await apiCall('/api/public/register', 'POST', formData, true);
    if (res.success) {
      document.getElementById('publicRegForm').reset();
      const alertEl = document.getElementById('regSuccessAlert');
      alertEl.classList.remove('d-none');
      alertEl.innerHTML = \`
        <h5><i class="bi bi-check-circle-fill"></i> REGISTRATION SUCCESSFUL</h5>
        <p class="mb-0">Welcome, <strong>\${res.student.first_name} \${res.student.last_name}</strong>!</p>
        <p class="small">Your registration has been submitted and is pending approval by Adviser <strong>\${state.settings.club_adviser}</strong>.</p>
      \`;
    } else {
      alert(res.message);
    }
  }

  async function renderAdminDashboard() {
    const res = await apiCall('/api/analytics/dashboard');
    if (!res.success) return;
    const s = res.stats;

    const html = \`
      <div class="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h3 class="fw-bold mb-0">Club Adviser Dashboard</h3>
          <p class="text-muted">\${state.settings.club_name} | School Year \${state.settings.school_year}</p>
        </div>
        <div>
          <button class="btn btn-outline-primary me-2" onclick="copyRegistrationLink()"><i class="bi bi-link-45deg"></i> Copy Self-Reg Link</button>
          <button class="btn btn-primary" onclick="navigate('events')"><i class="bi bi-calendar-plus"></i> Manage Events</button>
        </div>
      </div>

      <!-- Quick Metrics Grid -->
      <div class="row g-3 mb-4">
        <div class="col-md-3">
          <div class="card card-stat bg-primary text-white p-3">
            <small class="text-white-50">Total Active Members</small>
            <h2 class="fw-bold mb-0">\${s.activeStudents}</h2>
            <small>\${s.totalOfficers} Officers | \${s.inactiveStudents} Inactive</small>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-stat bg-success text-white p-3">
            <small class="text-white-50">Present Today</small>
            <h2 class="fw-bold mb-0">\${s.presentToday}</h2>
            <small>\${s.lateToday} Late | \${s.absentToday} Absent</small>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-stat bg-warning text-dark p-3">
            <small class="text-dark-50">Pending Registrations</small>
            <h2 class="fw-bold mb-0">\${s.pendingRegistrations}</h2>
            <small><a href="#" onclick="navigate('registrations')" class="text-dark font-weight-bold">Review Approval Queue &rarr;</a></small>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-stat bg-dark text-white p-3">
            <small class="text-white-50">Active Event</small>
            <h5 class="fw-bold mb-0 text-truncate">\${s.activeEvent ? s.activeEvent.event_name : 'No Active Event'}</h5>
            <small>\${s.activeEvent ? s.activeEvent.location : 'Scanner Idle'}</small>
          </div>
        </div>
      </div>

      <!-- Live Recent Scans & Position Breakdown -->
      <div class="row g-3">
        <div class="col-md-8">
          <div class="card border-0 shadow-sm p-3">
            <h5 class="fw-bold mb-3"><i class="bi bi-activity text-primary"></i> Live Attendance Activity Stream</h5>
            <div class="table-responsive">
              <table class="table table-hover align-middle">
                <thead>
                  <tr>
                    <th>Student Name</th>
                    <th>Position</th>
                    <th>Event</th>
                    <th>Time In</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  \${s.recentScans.length ? s.recentScans.map(r => \`
                    <tr>
                      <td class="fw-bold">\${r.full_name}</td>
                      <td><span class="badge bg-secondary">\${r.position_name}</span></td>
                      <td>\${r.event_name}</td>
                      <td>\${new Date(r.time_in).toLocaleTimeString()}</td>
                      <td><span class="badge bg-\${r.status === 'PRESENT' ? 'success' : r.status === 'LATE' ? 'warning' : 'danger'}">\${r.status}</span></td>
                    </tr>
                  \`).join('') : '<tr><td colspan="5" class="text-center text-muted">No attendance activity logged today.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card border-0 shadow-sm p-3">
            <h5 class="fw-bold mb-3"><i class="bi bi-pie-chart-fill text-primary"></i> Positions Distribution</h5>
            <ul class="list-group list-group-flush">
              \${s.positionStats.map(p => \`
                <li class="list-group-item d-flex justify-content-between align-items-center">
                  \${p.position_name}
                  <span class="badge bg-primary rounded-pill">\${p.count}</span>
                </li>
              \`).join('')}
            </ul>
          </div>
        </div>
      </div>
    \`;

    renderAppShell(html, 'dashboard');
  }

  function copyRegistrationLink() {
    const link = window.location.origin + '/register';
    navigator.clipboard.writeText(link);
    alert('Public Registration Link copied to clipboard:\n' + link);
  }

  async function renderPendingRegistrations() {
    const res = await apiCall('/api/students?approval=Pending');
    const students = res.students || [];

    const html = \`
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold">Pending Student Registrations</h3>
        <span class="badge bg-warning text-dark fs-6">\${students.length} Queue Total</span>
      </div>
      <div class="card border-0 shadow-sm p-3">
        <div class="table-responsive">
          <table class="table table-hover align-middle">
            <thead>
              <tr>
                <th>Student ID</th>
                <th>Full Name</th>
                <th>School Email</th>
                <th>Applied Position</th>
                <th>Date Submitted</th>
                <th class="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              \${students.length ? students.map(s => \`
                <tr>
                  <td class="fw-bold">\${s.student_id}</td>
                  <td>\${s.full_name}</td>
                  <td>\${s.email}</td>
                  <td><span class="badge bg-info text-dark">\${s.position_name}</span></td>
                  <td>\${s.date_joined}</td>
                  <td class="text-end">
                    <button class="btn btn-sm btn-success me-1" onclick="approveStudent('\${s.student_id}')"><i class="bi bi-check-lg"></i> Approve</button>
                    <button class="btn btn-sm btn-danger" onclick="rejectStudent('\${s.student_id}')"><i class="bi bi-x-lg"></i> Reject</button>
                  </td>
                </tr>
              \`).join('') : '<tr><td colspan="6" class="text-center text-muted p-4">No pending student self-registrations.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    \`;
    renderAppShell(html, 'registrations');
  }

  async function approveStudent(id) {
    if (!confirm(\`Approve registration for Student ID \${id}?\`)) return;
    const res = await apiCall(\`/api/students/\${id}/approve\`, 'POST');
    alert(res.message);
    renderPendingRegistrations();
  }

  async function rejectStudent(id) {
    if (!confirm(\`Reject registration for Student ID \${id}?\`)) return;
    const res = await apiCall(\`/api/students/\${id}/reject\`, 'POST');
    alert(res.message);
    renderPendingRegistrations();
  }

  async function renderStudentManagement() {
    const res = await apiCall('/api/students');
    const posRes = await apiCall('/api/positions');
    const students = res.students || [];
    const positions = posRes.positions || [];

    const html = \`
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold">Student Members Management</h3>
        <button class="btn btn-primary" onclick="openStudentModal()"><i class="bi bi-person-plus-fill"></i> Add Student Manually</button>
      </div>

      <div class="card border-0 shadow-sm p-3 mb-4">
        <div class="row g-2">
          <div class="col-md-4">
            <input type="text" id="studentSearch" class="form-control" placeholder="Search ID or Name..." onkeyup="filterStudentsTable()">
          </div>
          <div class="col-md-4">
            <select id="positionFilter" class="form-select" onchange="filterStudentsTable()">
              <option value="">All Positions</option>
              \${positions.map(p => \`<option value="\${p.position_name}">\${p.position_name}</option>\`).join('')}
            </select>
          </div>
          <div class="col-md-4 text-end">
            <a href="/api/export/csv?type=students" class="btn btn-outline-success"><i class="bi bi-file-earmark-excel"></i> Export CSV</a>
          </div>
        </div>
      </div>

      <div class="card border-0 shadow-sm p-3">
        <div class="table-responsive">
          <table class="table table-hover align-middle" id="studentsTable">
            <thead>
              <tr>
                <th>Photo</th>
                <th>Student ID</th>
                <th>Full Name</th>
                <th>Position</th>
                <th>Email</th>
                <th>Status</th>
                <th class="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              \${students.map(s => \`
                <tr>
                  <td><img src="\${s.photo_url || 'https://via.placeholder.com/40'}" class="rounded-circle" width="40" height="40"></td>
                  <td class="fw-bold">\${s.student_id}</td>
                  <td>\${s.full_name}</td>
                  <td><span class="badge bg-primary">\${s.position_name}</span></td>
                  <td>\${s.email}</td>
                  <td><span class="badge bg-\${s.membership_status === 'Active' ? 'success' : 'danger'}">\${s.membership_status}</span></td>
                  <td class="text-end">
                    <button class="btn btn-sm btn-outline-info me-1" onclick="viewStudentHistory('\${s.student_id}')"><i class="bi bi-clock-history"></i></button>
                    <button class="btn btn-sm btn-outline-warning me-1" onclick="regenerateQR('\${s.student_id}')"><i class="bi bi-qr-code"></i> Reset QR</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteStudent('\${s.student_id}')"><i class="bi bi-trash"></i></button>
                  </td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    \`;
    renderAppShell(html, 'students');
  }

  async function regenerateQR(student_id) {
    if (!confirm('Regenerating will invalidate the student\'s old QR code. Continue?')) return;
    const res = await apiCall(\`/api/students/\${student_id}/regenerate-qr\`, 'POST');
    alert(res.message);
  }

  async function deleteStudent(student_id) {
    if (!confirm(\`Delete student \${student_id} permanently?\`)) return;
    const res = await apiCall(\`/api/students/\${student_id}\`, 'DELETE');
    alert(res.message);
    renderStudentManagement();
  }

  async function viewStudentHistory(student_id) {
    const res = await apiCall(\`/api/students/\${student_id}/history\`);
    const history = res.history || [];
    let text = \`Position Audit History for ID \${student_id}:\n\n\`;
    history.forEach(h => {
      text += \`School Year: \${h.school_year} | Position: \${h.position_name} (\${new Date(h.assigned_date).toLocaleDateString()})\n\`;
    });
    alert(text || 'No history recorded.');
  }

  function filterStudentsTable() {
    const search = document.getElementById('studentSearch').value.toLowerCase();
    const pos = document.getElementById('positionFilter').value.toLowerCase();
    const rows = document.querySelectorAll('#studentsTable tbody tr');

    rows.forEach(r => {
      const text = r.innerText.toLowerCase();
      const matchesSearch = text.includes(search);
      const matchesPos = !pos || text.includes(pos);
      r.style.display = (matchesSearch && matchesPos) ? '' : 'none';
    });
  }

  async function renderPositionManagement() {
    const res = await apiCall('/api/positions');
    const positions = res.positions || [];

    const html = \`
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold">Customizable Position Management</h3>
        <button class="btn btn-primary" onclick="openAddPositionModal()"><i class="bi bi-plus-circle"></i> Create New Position</button>
      </div>
      <div class="card border-0 shadow-sm p-3">
        <div class="table-responsive">
          <table class="table table-hover align-middle">
            <thead>
              <tr>
                <th>ID</th>
                <th>Position Title</th>
                <th>Description</th>
                <th class="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              \${positions.map(p => \`
                <tr>
                  <td>\${p.id}</td>
                  <td class="fw-bold text-primary">\${p.position_name}</td>
                  <td>\${p.description || 'N/A'}</td>
                  <td class="text-end">
                    <button class="btn btn-sm btn-outline-danger" onclick="deletePosition(\${p.id})"><i class="bi bi-trash"></i> Delete</button>
                  </td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    \`;
    renderAppShell(html, 'positions');
  }

  async function openAddPositionModal() {
    const title = prompt('Enter New Custom Position Title:');
    if (!title) return;
    const desc = prompt('Enter Position Description (Optional):');
    const res = await apiCall('/api/positions', 'POST', { position_name: title, description: desc });
    alert(res.message);
    if (res.success) renderPositionManagement();
  }

  async function deletePosition(id) {
    if (!confirm('Are you sure? Deleting this position may affect filter categories.')) return;
    const res = await apiCall(\`/api/positions/\${id}\`, 'DELETE');
    alert(res.message);
    if (res.success) renderPositionManagement();
  }

  async function renderEventManagement() {
    const res = await apiCall('/api/events');
    const events = res.events || [];

    const html = \`
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold">Club Event Attendance Management</h3>
        <button class="btn btn-primary" onclick="openCreateEventModal()"><i class="bi bi-calendar-plus-fill"></i> Create Event</button>
      </div>

      <div class="row g-3">
        \${events.map(e => \`
          <div class="col-md-6">
            <div class="card border-0 shadow-sm p-3">
              <div class="d-flex justify-content-between align-items-start">
                <div>
                  <span class="badge bg-\${e.status === 'ACTIVE' ? 'success' : e.status === 'COMPLETED' ? 'secondary' : 'primary'} mb-2">\${e.status}</span>
                  <h4 class="fw-bold mb-1">\${e.event_name}</h4>
                  <p class="text-muted small mb-2"><i class="bi bi-geo-alt"></i> \${e.location} | \${e.event_date}</p>
                </div>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteEvent(\${e.id})"><i class="bi bi-trash"></i></button>
              </div>
              <p class="small text-secondary">\${e.description || 'No description provided.'}</p>
              <div class="d-flex justify-content-between align-items-center mt-3 pt-2 border-top">
                <small class="text-muted"><i class="bi bi-clock"></i> \${e.start_time} - \${e.end_time}</small>
                <div>
                  \${e.status !== 'COMPLETED' ? \`
                    <button class="btn btn-sm btn-warning text-dark me-1" onclick="closeEventMarkAbsent(\${e.id})">Mark Absentees & Close</button>
                  \` : ''}
                  <button class="btn btn-sm btn-primary" onclick="navigate('scanner')">Open Scanner</button>
                </div>
              </div>
            </div>
          </div>
        \`).join('')}
      </div>
    \`;
    renderAppShell(html, 'events');
  }

  async function openCreateEventModal() {
    const name = prompt('Event Name:');
    if (!name) return;
    const date = prompt('Event Date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
    const start = prompt('Start Time (HH:MM):', '09:00');
    const end = prompt('End Time (HH:MM):', '12:00');
    const location = prompt('Location/Venue:', 'School Auditorium');

    const res = await apiCall('/api/events', 'POST', {
      event_name: name,
      event_date: date,
      start_time: start,
      end_time: end,
      location: location,
      target_audience: 'ALL'
    });
    alert(res.message);
    if (res.success) renderEventManagement();
  }

  async function closeEventMarkAbsent(id) {
    if (!confirm('Mark all non-attending eligible students as ABSENT and complete event?')) return;
    const res = await apiCall(\`/api/events/\${id}/close-and-mark-absent\`, 'POST');
    alert(res.message);
    renderEventManagement();
  }

  async function deleteEvent(id) {
    if (!confirm('Delete event and associated logs?')) return;
    const res = await apiCall(\`/api/events/\${id}\`, 'DELETE');
    alert(res.message);
    renderEventManagement();
  }

  async function renderScannerPortal() {
    const eventsRes = await apiCall('/api/events');
    const activeEvents = (eventsRes.events || []).filter(e => e.status !== 'COMPLETED');

    const html = \`
      <div class="row justify-content-center">
        <div class="col-md-8 text-center">
          <h3 class="fw-bold mb-3"><i class="bi bi-qr-code-scan text-primary"></i> Live Attendance QR Scanner</h3>
          
          <div class="card border-0 shadow-sm p-4 mb-4">
            <div class="row g-3 align-items-center mb-3">
              <div class="col-md-6">
                <label class="form-label fw-bold">Select Active Event Target</label>
                <select id="scannerEventSelect" class="form-select">
                  \${activeEvents.map(e => \`<option value="\${e.id}">\${e.event_name} (\${e.event_date})</option>\`).join('')}
                </select>
              </div>
              <div class="col-md-6">
                <label class="form-label fw-bold">Scan Mode</label>
                <div class="btn-group w-100" role="group">
                  <input type="radio" class="btn-check" name="scanMode" id="modeIn" value="TIME_IN" checked onclick="state.scannerMode='TIME_IN'">
                  <label class="btn btn-outline-success" for="modeIn">TIME IN</label>
                  <input type="radio" class="btn-check" name="scanMode" id="modeOut" value="TIME_OUT" onclick="state.scannerMode='TIME_OUT'">
                  <label class="btn btn-outline-danger" for="modeOut">TIME OUT</label>
                </div>
              </div>
            </div>

            <!-- HTML5 Video Stream Holder -->
            <div class="d-flex justify-content-center my-3">
              <div id="reader" class="scanner-preview"></div>
            </div>

            <div class="d-flex justify-content-center gap-2">
              <button class="btn btn-success" onclick="startScanner()"><i class="bi bi-camera-fill"></i> Start Camera</button>
              <button class="btn btn-secondary" onclick="stopScanner()"><i class="bi bi-camera-video-off"></i> Stop Camera</button>
            </div>
          </div>

          <!-- Live Scan Alert Overlay Result Banner -->
          <div id="scanResultCard" class="card border-0 shadow p-4 d-none text-start">
            <div class="d-flex align-items-center gap-3">
              <img id="scanPhoto" src="" class="rounded" width="80" height="80" style="object-fit:cover;">
              <div>
                <span id="scanStatusBadge" class="badge bg-success mb-1">RECORDED</span>
                <h4 id="scanName" class="fw-bold mb-0">Juan Dela Cruz</h4>
                <p id="scanDetails" class="text-muted mb-0">Student ID: 2026-001 | Member</p>
                <small id="scanTime" class="text-primary fw-bold">Time In: 3:00 PM</small>
              </div>
            </div>
          </div>

        </div>
      </div>
    \`;
    renderAppShell(html, 'scanner');
  }

  function startScanner() {
    if (state.scanner) stopScanner();
    state.scanner = new Html5Qrcode("reader");
    state.scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        const eventId = document.getElementById('scannerEventSelect').value;
        if (!eventId) {
          alert('Please select an active event first!');
          return;
        }

        // Send API Scan
        const res = await apiCall('/api/attendance/scan', 'POST', {
          event_id: eventId,
          qr_token: decodedText,
          scan_mode: state.scannerMode
        });

        const card = document.getElementById('scanResultCard');
        card.classList.remove('d-none');

        if (res.success) {
          playAudioFeedback('success');
          speak(\`\${res.student.full_name}, \${res.action === 'TIME_IN' ? 'Time In Recorded' : 'Time Out Recorded'}\`);
          document.getElementById('scanStatusBadge').className = \`badge bg-\${res.status === 'LATE' ? 'warning' : 'success'}\`;
          document.getElementById('scanStatusBadge').innerText = res.status || 'RECORDED';
          document.getElementById('scanName').innerText = res.student.full_name;
          document.getElementById('scanDetails').innerText = \`Student ID: \${res.student.student_id} | \${res.student.position_name}\`;
          document.getElementById('scanPhoto').src = res.student.photo_url || 'https://via.placeholder.com/80';
          document.getElementById('scanTime').innerText = \`Time: \${res.student.time_in || res.student.time_out}\`;
        } else {
          if (res.code === 'DUPLICATE_SCAN') {
            playAudioFeedback('warning');
            speak(\`\${res.student.full_name}, you are already recorded.\`);
            document.getElementById('scanStatusBadge').className = 'badge bg-warning text-dark';
            document.getElementById('scanStatusBadge').innerText = 'ALREADY RECORDED';
            document.getElementById('scanName').innerText = res.student.full_name;
          } else {
            playAudioFeedback('error');
            speak('Invalid QR Code');
            document.getElementById('scanStatusBadge').className = 'badge bg-danger';
            document.getElementById('scanStatusBadge').innerText = 'INVALID QR';
            document.getElementById('scanName').innerText = 'Unrecognized Token';
          }
        }
      },
      (errorMessage) => { /* ignore minor frame parse failures */ }
    );
  }

  function stopScanner() {
    if (state.scanner) {
      state.scanner.stop().then(() => {
        state.scanner.clear();
        state.scanner = null;
      }).catch(err => console.error(err));
    }
  }

  async function renderIDPrintingPage() {
    const res = await apiCall('/api/students/qr-batch');
    const students = res.students || [];

    const html = \`
      <div class="d-flex justify-content-between align-items-center mb-4 no-print">
        <div>
          <h3 class="fw-bold">A4 Student ID Card Printing</h3>
          <p class="text-muted">Standard 8 Cards per A4 Sheet Print Layout</p>
        </div>
        <button class="btn btn-primary" onclick="window.print()"><i class="bi bi-printer-fill"></i> Print ID Sheet</button>
      </div>

      <div id="printableArea">
        <div class="a4-grid">
          \${students.map(s => \`
            <div class="id-card-a4">
              <div class="id-card-header">
                <div>\${state.settings.school_name}</div>
                <div style="font-size: 8px; opacity: 0.9;">\${state.settings.club_name}</div>
              </div>
              <div class="id-card-body">
                <img src="\${s.photo_url || 'https://via.placeholder.com/60'}" class="id-card-photo">
                <div class="id-card-details">
                  <div class="fw-bold text-dark" style="font-size: 11px;">\${s.first_name} \${s.last_name}</div>
                  <div class="text-primary fw-bold">\${s.position_name}</div>
                  <div>ID: \${s.student_id}</div>
                  <div>SY: \${state.settings.school_year}</div>
                </div>
                <img src="\${s.qrDataUrl}" class="id-card-qr ms-auto">
              </div>
            </div>
          \`).join('')}
        </div>
      </div>
    \`;
    renderAppShell(html, 'id-printing');
  }

  async function renderStudentPortal() {
    const res = await apiCall('/api/student/portal-data');
    if (!res.success) return;
    const st = res.student;
    const att = res.attendance || [];

    const html = \`
      <div class="row g-4">
        <div class="col-md-4">
          <div class="card border-0 shadow-sm text-center p-4">
            <img src="\${st.photo_url || 'https://via.placeholder.com/120'}" class="rounded-circle mx-auto mb-3" width="120" height="120" style="object-fit:cover;">
            <h4 class="fw-bold mb-0">\${st.first_name} \${st.last_name}</h4>
            <span class="badge bg-primary my-2">\${st.position_name}</span>
            <p class="text-muted small">Student ID: \${st.student_id}</p>
            <hr>
            <div class="p-2 bg-light rounded">
              <small class="text-muted d-block mb-2">My Digital QR Code Pass</small>
              <img src="\${res.qrDataUrl}" class="img-fluid" style="max-width:200px;">
            </div>
          </div>
        </div>

        <div class="col-md-8">
          <div class="card border-0 shadow-sm p-4">
            <h5 class="fw-bold mb-3"><i class="bi bi-clock-history text-primary"></i> My Attendance Record History</h5>
            <div class="table-responsive">
              <table class="table table-hover">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date</th>
                    <th>Time In</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  \${att.length ? att.map(a => \`
                    <tr>
                      <td class="fw-bold">\${a.event_name}</td>
                      <td>\${a.event_date}</td>
                      <td>\${a.time_in ? new Date(a.time_in).toLocaleTimeString() : 'N/A'}</td>
                      <td><span class="badge bg-\${a.status === 'PRESENT' ? 'success' : a.status === 'LATE' ? 'warning' : 'danger'}">\${a.status}</span></td>
                    </tr>
                  \`).join('') : '<tr><td colspan="4" class="text-center text-muted">No attendance records found.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    \`;
    renderAppShell(html, 'student-portal');
  }

  async function renderReportsPage() {
    const eventsRes = await apiCall('/api/events');
    const events = eventsRes.events || [];

    const html = \`
      <div class="d-flex justify-content-between align-items-center mb-4 no-print">
        <h3 class="fw-bold">Attendance & Participation Reports</h3>
        <button class="btn btn-primary" onclick="window.print()"><i class="bi bi-printer"></i> Print Report Sheet</button>
      </div>

      <div class="card border-0 shadow-sm p-3 mb-4 no-print">
        <div class="row g-2">
          <div class="col-md-4">
            <label class="form-label fw-bold">Filter by Event</label>
            <select id="reportEvent" class="form-select" onchange="loadReportData()">
              <option value="">All Events</option>
              \${events.map(e => \`<option value="\${e.id}">\${e.event_name}</option>\`).join('')}
            </select>
          </div>
          <div class="col-md-4">
            <label class="form-label fw-bold">Export Options</label><br>
            <a href="/api/export/csv?type=attendance" class="btn btn-outline-success"><i class="bi bi-file-earmark-excel"></i> Export Full Logs CSV</a>
          </div>
        </div>
      </div>

      <div id="printableArea" class="card border-0 shadow-sm p-4">
        <div class="text-center mb-4">
          <h4 class="fw-bold text-uppercase mb-0">\${state.settings.school_name}</h4>
          <h5 class="text-primary mb-1">\${state.settings.club_name}</h5>
          <p class="text-muted small">Official Event Attendance Report Summary</p>
        </div>

        <div class="table-responsive">
          <table class="table table-bordered align-middle" id="reportTable">
            <thead>
              <tr class="table-light">
                <th>Student ID</th>
                <th>Student Name</th>
                <th>Position</th>
                <th>Event Name</th>
                <th>Time In</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="reportTbody">
              <tr><td colspan="6" class="text-center">Loading Report...</td></tr>
            </tbody>
          </table>
        </div>

        <div class="row mt-5 pt-4">
          <div class="col-6 text-center">
            <p class="mb-5">Prepared By:</p>
            <p class="fw-bold mb-0">___________________________</p>
            <small class="text-muted">Club Secretary / Officer</small>
          </div>
          <div class="col-6 text-center">
            <p class="mb-5">Approved By:</p>
            <p class="fw-bold mb-0">\${state.settings.club_adviser}</p>
            <small class="text-muted">Club Adviser</small>
          </div>
        </div>
      </div>
    \`;
    renderAppShell(html, 'reports');
    loadReportData();
  }

  async function loadReportData() {
    const eventId = document.getElementById('reportEvent') ? document.getElementById('reportEvent').value : '';
    const res = await apiCall(\`/api/reports/generate?event_id=\${eventId}\`);
    const tbody = document.getElementById('reportTbody');
    if (!tbody) return;

    if (res.success && res.records.length) {
      tbody.innerHTML = res.records.map(r => \`
        <tr>
          <td>\${r.student_id}</td>
          <td class="fw-bold">\${r.full_name}</td>
          <td>\${r.position_name}</td>
          <td>\${r.event_name}</td>
          <td>\${r.time_in ? new Date(r.time_in).toLocaleTimeString() : 'N/A'}</td>
          <td><span class="badge bg-\${r.status === 'PRESENT' ? 'success' : r.status === 'LATE' ? 'warning' : 'danger'}">\${r.status}</span></td>
        </tr>
      \`).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No attendance data matching filter.</td></tr>';
    }
  }

  async function renderAuditLogsPage() {
    const res = await apiCall('/api/audit-logs');
    const logs = res.logs || [];

    const html = \`
      <h3 class="fw-bold mb-4">Security & Audit Logs</h3>
      <div class="card border-0 shadow-sm p-3">
        <div class="table-responsive">
          <table class="table table-hover align-middle small">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>Role</th>
                <th>Action</th>
                <th>Details</th>
                <th>IP Address</th>
              </tr>
            </thead>
            <tbody>
              \${logs.map(l => \`
                <tr>
                  <td>\${new Date(l.timestamp).toLocaleString()}</td>
                  <td class="fw-bold">\${l.username}</td>
                  <td><span class="badge bg-secondary">\${l.role}</span></td>
                  <td><span class="badge bg-primary">\${l.action}</span></td>
                  <td>\${l.details}</td>
                  <td>\${l.ip_address}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    \`;
    renderAppShell(html, 'audit-logs');
  }

  async function renderSettingsPage() {
    const set = state.settings;

    const html = \`
      <h3 class="fw-bold mb-4">School & System Settings</h3>
      <div class="row g-4">
        <div class="col-md-8">
          <div class="card border-0 shadow-sm p-4">
            <form onsubmit="handleSaveSettings(event)">
              <h5 class="fw-bold mb-3 text-primary">School & Club Profile</h5>
              <div class="mb-3">
                <label class="form-label">School Name</label>
                <input type="text" id="setSchoolName" class="form-control" value="\${set.school_name || ''}" required>
              </div>
              <div class="mb-3">
                <label class="form-label">School Year</label>
                <input type="text" id="setSchoolYear" class="form-control" value="\${set.school_year || ''}" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Club / Organization Name</label>
                <input type="text" id="setClubName" class="form-control" value="\${set.club_name || ''}" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Club Adviser Name</label>
                <input type="text" id="setAdviser" class="form-control" value="\${set.club_adviser || ''}" required>
              </div>
              <hr>
              <h5 class="fw-bold mb-3 text-primary">Registration Controls</h5>
              <div class="form-check form-switch mb-3">
                <input class="form-check-input" type="checkbox" id="setRegEnabled" \${set.registration_enabled ? 'checked' : ''}>
                <label class="form-check-label fw-bold">Enable Public Self-Registration</label>
              </div>
              <div class="form-check form-switch mb-3">
                <input class="form-check-input" type="checkbox" id="setAllowPositions" \${set.allow_student_positions ? 'checked' : ''}>
                <label class="form-check-label">Allow Students to Select Custom Position during Self-Registration</label>
              </div>
              <button type="submit" class="btn btn-primary fw-bold">Save Settings</button>
            </form>
          </div>
        </div>

        <div class="col-md-4">
          <div class="card border-0 shadow-sm p-4">
            <h5 class="fw-bold mb-3 text-danger">Database Backup & Restore</h5>
            <p class="small text-muted">Create a backup copy of SQLite database or restore from a previously saved file.</p>
            <a href="/api/system/backup" class="btn btn-outline-primary w-100 mb-3"><i class="bi bi-download"></i> Download Backup DB</a>
            
            <form onsubmit="handleRestoreDB(event)">
              <div class="mb-2">
                <label class="form-label small">Upload Backup File (.db)</label>
                <input type="file" id="restoreFile" class="form-control form-control-sm" accept=".db" required>
              </div>
              <button type="submit" class="btn btn-danger w-100"><i class="bi bi-upload"></i> Restore Database</button>
            </form>
          </div>
        </div>
      </div>
    \`;
    renderAppShell(html, 'settings');
  }

  async function handleSaveSettings(e) {
    e.preventDefault();
    const body = {
      school_name: document.getElementById('setSchoolName').value,
      school_year: document.getElementById('setSchoolYear').value,
      club_name: document.getElementById('setClubName').value,
      organization_name: document.getElementById('setClubName').value,
      club_adviser: document.getElementById('setAdviser').value,
      registration_enabled: document.getElementById('setRegEnabled').checked,
      allow_student_positions: document.getElementById('setAllowPositions').checked
    };

    const res = await apiCall('/api/settings', 'POST', body);
    alert(res.message);
    if (res.success) initApp();
  }

  async function handleRestoreDB(e) {
    e.preventDefault();
    if (!confirm('CRITICAL WARNING: Restoring database will overwrite all current system data. Proceed?')) return;
    const formData = new FormData();
    formData.append('backup_file', document.getElementById('restoreFile').files[0]);

    const res = await apiCall('/api/system/restore', 'POST', formData, true);
    alert(res.message);
    if (res.success) window.location.reload();
  }

  // Kickstart Web Application Initialization
  window.onload = initApp;
</script>
</body>
</html>
  `);
});

// Start Express Server Listener
app.listen(PORT, () => {
  console.log(`
====================================================================
 SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM RUNNING
====================================================================
 [Local Server]     : http://localhost:${PORT}
 [Public Reg Link]  : http://localhost:${PORT}/register
 [Scanner Portal]   : http://localhost:${PORT} (Login -> Scanner)
====================================================================
 Default Credentials:
  - Admin   : username: admin   | password: Admin@123
  - Scanner : username: scanner | password: Scanner@123
====================================================================
  `);
});
