/**
 * School Student Club QR Code Attendance Management System
 * Single-file Express Application (Backend API + Database + Frontend Single-Page Interface)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Persistent SQLite Database
const dbPath = process.env.DB_PATH || path.join(__dirname, 'school_club_attendance.db');
const db = new Database(dbPath);

// Enable SQLite WAL mode for performance & concurrency
db.pragma('journal_mode = WAL');

// Body Parsing & Session Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'school-club-qr-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 Hours
  })
);

// Database Initialization & Migrations
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL, -- 'ADMIN', 'SCANNER', 'STUDENT'
      student_id TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT UNIQUE NOT NULL,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      contact_number TEXT,
      position TEXT NOT NULL,
      student_club TEXT NOT NULL,
      school_year TEXT NOT NULL,
      status TEXT DEFAULT 'Pending', -- 'Pending', 'Active', 'Inactive', 'Suspended', 'Alumni', 'Resigned', 'Rejected'
      qr_token TEXT UNIQUE,
      qr_enabled INTEGER DEFAULT 1,
      photo_url TEXT,
      date_joined TEXT,
      expiration_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS position_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      position TEXT NOT NULL,
      school_year TEXT NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      event_type TEXT,
      event_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      late_threshold_minutes INTEGER DEFAULT 15,
      location TEXT,
      organizer TEXT,
      allowed_positions TEXT DEFAULT 'ALL',
      status TEXT DEFAULT 'Upcoming', -- 'Upcoming', 'Active', 'Completed', 'Cancelled'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      time_in TEXT,
      time_out TEXT,
      status TEXT NOT NULL, -- 'Present', 'Late', 'Absent', 'Excused'
      excuse_reason TEXT,
      recorded_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Default School & Club Settings
  const defaultSettings = [
    ['school_name', 'ABC National High School'],
    ['school_logo', ''],
    ['school_address', '123 Education Ave, Knowledge City'],
    ['school_contact', '+1 800-555-0199'],
    ['school_email', 'info@abchigh.edu'],
    ['school_year', '2026-2027'],
    ['student_club_name', 'Computer Club'],
    ['organization_name', 'Student Technology Association'],
    ['club_adviser', 'Mr. John Doe'],
    ['registration_open', '1'],
    ['low_participation_threshold', '60']
  ];

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  defaultSettings.forEach(([key, value]) => insertSetting.run(key, value));

  // Default Positions
  const defaultPositions = [
    'President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor',
    'Public Information Officer', 'Peace Officer', 'Sergeant-at-Arms', 'Representative', 'Member'
  ];
  const insertPos = db.prepare('INSERT OR IGNORE INTO positions (title) VALUES (?)');
  defaultPositions.forEach(pos => insertPos.run(pos));

  // Seed Admin Account (Username: admin, Password: adminpassword)
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('adminpassword', 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hash, 'ADMIN');
  }

  // Seed Scanner Account (Username: scanner, Password: scannerpassword)
  const scannerExists = db.prepare('SELECT id FROM users WHERE username = ?').get('scanner');
  if (!scannerExists) {
    const hash = bcrypt.hashSync('scannerpassword', 10);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('scanner', hash, 'SCANNER');
  }
}

initDatabase();

// Audit Logger Helper
function logAudit(req, action, details) {
  try {
    const username = req.session?.user?.username || 'SYSTEM';
    const userId = req.session?.user?.id || '0';
    const ip = req.ip || req.connection.remoteAddress;
    db.prepare('INSERT INTO audit_logs (user_id, username, action, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(
      String(userId), username, action, details, String(ip)
    );
  } catch (err) {
    console.error('Audit Log Error:', err);
  }
}

// Authentication & Authorization Middlewares
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden. Access denied.' });
    }
    next();
  };
}

// ==========================================
// API ROUTES
// ==========================================

// --- AUTHENTICATION API ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.user = { id: user.id, username: user.username, role: user.role, student_id: user.student_id };
  logAudit(req, 'LOGIN', `User ${username} logged in successfully as ${user.role}.`);
  return res.json({ message: 'Login successful', user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session?.user) {
    logAudit(req, 'LOGOUT', `User ${req.session.user.username} logged out.`);
  }
  req.session.destroy();
  res.json({ message: 'Logged out successfully' });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.session.user });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'All password fields are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  logAudit(req, 'CHANGE_PASSWORD', `User ${user.username} changed password.`);
  res.json({ message: 'Password changed successfully.' });
});

// --- SETTINGS API ---
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.post('/api/settings', requireAuth, requireRole('ADMIN'), (req, res) => {
  const settings = req.body;
  const updateStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const transaction = db.transaction((data) => {
    for (const [key, value] of Object.entries(data)) {
      updateStmt.run(key, String(value));
    }
  });
  transaction(settings);
  logAudit(req, 'UPDATE_SETTINGS', 'School and Club settings updated.');
  res.json({ message: 'Settings saved successfully.' });
});

// --- POSITIONS API ---
app.get('/api/positions', (req, res) => {
  const rows = db.prepare('SELECT * FROM positions ORDER BY title ASC').all();
  res.json(rows);
});

app.post('/api/positions', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Position title is required.' });
  try {
    db.prepare('INSERT INTO positions (title) VALUES (?)').run(title.trim());
    logAudit(req, 'CREATE_POSITION', `Created position: ${title.trim()}`);
    res.json({ message: 'Position created successfully.' });
  } catch (e) {
    res.status(400).json({ error: 'Position already exists.' });
  }
});

app.put('/api/positions/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { title } = req.body;
  const { id } = req.params;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Position title is required.' });
  try {
    const oldPos = db.prepare('SELECT title FROM positions WHERE id = ?').get(id);
    db.prepare('UPDATE positions SET title = ? WHERE id = ?').run(title.trim(), id);
    if (oldPos) {
      db.prepare('UPDATE students SET position = ? WHERE position = ?').run(title.trim(), oldPos.title);
    }
    logAudit(req, 'UPDATE_POSITION', `Updated position ID ${id} to ${title.trim()}`);
    res.json({ message: 'Position updated.' });
  } catch (e) {
    res.status(400).json({ error: 'Failed to update position. Title may be duplicate.' });
  }
});

app.delete('/api/positions/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const pos = db.prepare('SELECT title FROM positions WHERE id = ?').get(id);
  db.prepare('DELETE FROM positions WHERE id = ?').run(id);
  logAudit(req, 'DELETE_POSITION', `Deleted position: ${pos ? pos.title : id}`);
  res.json({ message: 'Position deleted.' });
});

// --- STUDENT PUBLIC REGISTRATION API ---
app.post('/api/public/register', (req, res) => {
  const isRegOpen = db.prepare("SELECT value FROM settings WHERE key = 'registration_open'").get();
  if (isRegOpen && isRegOpen.value === '0') {
    return res.status(400).json({ error: 'Registration is currently closed by the administrator.' });
  }

  const { student_id, first_name, middle_name, last_name, email, contact_number, position, photo_url } = req.body;

  if (!student_id || !first_name || !last_name || !email || !position) {
    return res.status(400).json({ error: 'Please fill in all required fields.' });
  }

  const existingId = db.prepare('SELECT id FROM students WHERE student_id = ?').get(student_id);
  if (existingId) {
    return res.status(400).json({ error: 'Student ID already registered. Please contact your Club Adviser if you believe this is an error.' });
  }

  const existingEmail = db.prepare('SELECT id FROM students WHERE email = ?').get(email);
  if (existingEmail) {
    return res.status(400).json({ error: 'School Email is already in use.' });
  }

  const clubName = db.prepare("SELECT value FROM settings WHERE key = 'student_club_name'").get()?.value || 'Computer Club';
  const schoolYear = db.prepare("SELECT value FROM settings WHERE key = 'school_year'").get()?.value || '2026-2027';

  const qrToken = 'QR-' + student_id + '-' + Math.random().toString(36).substring(2, 9).toUpperCase();

  db.prepare(`
    INSERT INTO students (student_id, first_name, middle_name, last_name, email, contact_number, position, student_club, school_year, status, qr_token, photo_url, date_joined)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, DATE('now'))
  `).run(student_id, first_name, middle_name || '', last_name, email, contact_number || '', position, clubName, schoolYear, qrToken, photo_url || '');

  logAudit(req, 'PUBLIC_REGISTER', `New registration submitted for Student ID: ${student_id}`);
  res.json({ message: 'Registration submitted successfully. Waiting for Adviser approval.' });
});

// --- STUDENT MANAGEMENT API (ADMIN) ---
app.get('/api/students', requireAuth, (req, res) => {
  const { status, position, search } = req.query;
  let query = 'SELECT * FROM students WHERE 1=1';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  if (position) {
    query += ' AND position = ?';
    params.push(position);
  }
  if (search) {
    query += ' AND (student_id LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  query += ' ORDER BY last_name ASC';
  const students = db.prepare(query).all(...params);
  res.json(students);
});

app.post('/api/students/approve/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  // Update status to Active
  db.prepare("UPDATE students SET status = 'Active' WHERE id = ?").run(id);

  // Add position history
  db.prepare('INSERT INTO position_history (student_id, position, school_year) VALUES (?, ?, ?)').run(student.student_id, student.position, student.school_year);

  // Create Student User Account if not exists
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(student.student_id);
  if (!existingUser) {
    const defaultPasswordHash = bcrypt.hashSync(student.student_id, 10); // Default password is Student ID
    db.prepare('INSERT INTO users (username, password, role, student_id) VALUES (?, ?, ?, ?)').run(student.student_id, defaultPasswordHash, 'STUDENT', student.student_id);
  }

  logAudit(req, 'APPROVE_STUDENT', `Approved student registration: ${student.student_id}`);
  res.json({ message: 'Student approved successfully.' });
});

app.post('/api/students/reject/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  db.prepare("UPDATE students SET status = 'Rejected' WHERE id = ?").run(id);
  logAudit(req, 'REJECT_STUDENT', `Rejected student registration ID: ${id}`);
  res.json({ message: 'Student registration rejected.' });
});

app.put('/api/students/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const { first_name, middle_name, last_name, email, contact_number, position, status, expiration_date, photo_url } = req.body;

  const currentStudent = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!currentStudent) return res.status(404).json({ error: 'Student not found.' });

  if (currentStudent.position !== position) {
    db.prepare('INSERT INTO position_history (student_id, position, school_year) VALUES (?, ?, ?)').run(
      currentStudent.student_id, position, currentStudent.school_year
    );
  }

  db.prepare(`
    UPDATE students 
    SET first_name = ?, middle_name = ?, last_name = ?, email = ?, contact_number = ?, position = ?, status = ?, expiration_date = ?, photo_url = ?
    WHERE id = ?
  `).run(first_name, middle_name, last_name, email, contact_number, position, status, expiration_date, photo_url, id);

  logAudit(req, 'UPDATE_STUDENT', `Updated student profile: ${currentStudent.student_id}`);
  res.json({ message: 'Student updated successfully.' });
});

app.delete('/api/students/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const student = db.prepare('SELECT student_id FROM students WHERE id = ?').get(id);
  if (student) {
    db.prepare('DELETE FROM users WHERE student_id = ?').run(student.student_id);
    db.prepare('DELETE FROM attendance WHERE student_id = ?').run(student.student_id);
    db.prepare('DELETE FROM position_history WHERE student_id = ?').run(student.student_id);
    db.prepare('DELETE FROM students WHERE id = ?').run(id);
    logAudit(req, 'DELETE_STUDENT', `Deleted student: ${student.student_id}`);
  }
  res.json({ message: 'Student deleted permanently.' });
});

app.post('/api/students/:id/regenerate-qr', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const student = db.prepare('SELECT student_id FROM students WHERE id = ?').get(id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const newQrToken = 'QR-' + student.student_id + '-' + Math.random().toString(36).substring(2, 9).toUpperCase();
  db.prepare('UPDATE students SET qr_token = ?, qr_enabled = 1 WHERE id = ?').run(newQrToken, id);

  logAudit(req, 'REGENERATE_QR', `Regenerated QR Code for student: ${student.student_id}`);
  res.json({ message: 'QR Code regenerated successfully.', qr_token: newQrToken });
});

app.post('/api/students/:id/toggle-qr', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const student = db.prepare('SELECT qr_enabled FROM students WHERE id = ?').get(id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const newStatus = student.qr_enabled ? 0 : 1;
  db.prepare('UPDATE students SET qr_enabled = ? WHERE id = ?').run(newStatus, id);

  logAudit(req, 'TOGGLE_QR', `Toggled QR Status for ID ${id} to ${newStatus}`);
  res.json({ message: `QR Code ${newStatus ? 'enabled' : 'disabled'}.`, qr_enabled: newStatus });
});

// Position history lookup
app.get('/api/students/:student_id/position-history', requireAuth, (req, res) => {
  const { student_id } = req.params;
  const history = db.prepare('SELECT * FROM position_history WHERE student_id = ? ORDER BY assigned_at DESC').all(student_id);
  res.json(history);
});

// --- EVENTS API ---
app.get('/api/events', requireAuth, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY event_date DESC, start_time DESC').all();
  res.json(events);
});

app.post('/api/events', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { title, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, allowed_positions } = req.body;
  if (!title || !event_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Title, Date, Start Time, and End Time are required.' });
  }

  const allowed = Array.isArray(allowed_positions) ? allowed_positions.join(',') : (allowed_positions || 'ALL');

  db.prepare(`
    INSERT INTO events (title, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, allowed_positions, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Upcoming')
  `).run(title, description || '', event_type || 'General', event_date, start_time, end_time, late_threshold_minutes || 15, location || '', organizer || '', allowed);

  logAudit(req, 'CREATE_EVENT', `Created Event: ${title}`);
  res.json({ message: 'Event created successfully.' });
});

app.put('/api/events/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const { title, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, allowed_positions, status } = req.body;

  const allowed = Array.isArray(allowed_positions) ? allowed_positions.join(',') : (allowed_positions || 'ALL');

  db.prepare(`
    UPDATE events
    SET title = ?, description = ?, event_type = ?, event_date = ?, start_time = ?, end_time = ?, late_threshold_minutes = ?, location = ?, organizer = ?, allowed_positions = ?, status = ?
    WHERE id = ?
  `).run(title, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, allowed, status, id);

  // If set to Completed, mark unrecorded expected students as Absent
  if (status === 'Completed') {
    markAbsentsForEvent(id);
  }

  logAudit(req, 'UPDATE_EVENT', `Updated Event ID: ${id}`);
  res.json({ message: 'Event updated.' });
});

app.delete('/api/events/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM attendance WHERE event_id = ?').run(id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  logAudit(req, 'DELETE_EVENT', `Deleted Event ID: ${id}`);
  res.json({ message: 'Event deleted.' });
});

function markAbsentsForEvent(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return;

  let activeStudents = db.prepare("SELECT student_id, position FROM students WHERE status = 'Active'").all();
  
  if (event.allowed_positions !== 'ALL') {
    const allowedArr = event.allowed_positions.split(',');
    activeStudents = activeStudents.filter(s => allowedArr.includes(s.position));
  }

  const existingAttendance = db.prepare('SELECT student_id FROM attendance WHERE event_id = ?').all(eventId);
  const recordedIds = new Set(existingAttendance.map(a => a.student_id));

  const markAbsentStmt = db.prepare("INSERT OR IGNORE INTO attendance (event_id, student_id, status, recorded_by) VALUES (?, ?, 'Absent', 'SYSTEM')");
  activeStudents.forEach(student => {
    if (!recordedIds.has(student.student_id)) {
      markAbsentStmt.run(eventId, student.student_id);
    }
  });
}

// --- SCANNER & ATTENDANCE API ---
app.post('/api/attendance/scan', requireAuth, requireRole('ADMIN', 'SCANNER'), (req, res) => {
  const { qr_token, event_id, scan_type } = req.body; // scan_type: 'TIME_IN' or 'TIME_OUT'

  if (!qr_token || !event_id) {
    return res.status(400).json({ status: 'INVALID', message: 'Missing QR Token or Event selection.' });
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(event_id);
  if (!event) {
    return res.status(400).json({ status: 'INVALID', message: 'Selected event not found.' });
  }

  const student = db.prepare('SELECT * FROM students WHERE qr_token = ?').get(qr_token);

  if (!student) {
    return res.status(400).json({ status: 'INVALID', message: 'Invalid QR Code. Student not found.' });
  }

  if (student.status !== 'Active') {
    return res.status(400).json({ status: 'INVALID', message: `Student status is ${student.status}. Attendance denied.` });
  }

  if (student.qr_enabled === 0) {
    return res.status(400).json({ status: 'INVALID', message: 'This QR Code has been disabled.' });
  }

  // Position eligibility check
  if (event.allowed_positions !== 'ALL') {
    const allowed = event.allowed_positions.split(',');
    if (!allowed.includes(student.position)) {
      return res.status(400).json({ status: 'INVALID', message: `Position '${student.position}' is not required for this event.` });
    }
  }

  const now = new Date();
  const timeString = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const existingRecord = db.prepare('SELECT * FROM attendance WHERE event_id = ? AND student_id = ?').get(event_id, student.student_id);

  if (scan_type === 'TIME_OUT') {
    if (!existingRecord) {
      return res.status(400).json({ status: 'WARNING', message: 'No Time In record found for this student today.' });
    }
    db.prepare('UPDATE attendance SET time_out = ? WHERE id = ?').run(timeString, existingRecord.id);
    logAudit(req, 'TIME_OUT', `Time Out recorded for ${student.student_id} in event ${event.title}`);
    return res.json({
      status: 'SUCCESS',
      type: 'TIME_OUT',
      message: 'Time Out recorded.',
      student: {
        student_id: student.student_id,
        name: `${student.first_name} ${student.last_name}`,
        position: student.position,
        photo_url: student.photo_url,
        time_out: timeString
      }
    });
  } else {
    // TIME_IN Mode
    if (existingRecord && existingRecord.time_in) {
      return res.status(400).json({
        status: 'DUPLICATE',
        message: 'Already recorded for this event.',
        student: { name: `${student.first_name} ${student.last_name}` }
      });
    }

    // Determine Late status
    const [startHours, startMinutes] = event.start_time.split(':').map(Number);
    const eventStartTime = new Date();
    eventStartTime.setHours(startHours, startMinutes, 0, 0);

    const lateThresholdTime = new Date(eventStartTime.getTime() + (event.late_threshold_minutes || 15) * 60000);
    const attendanceStatus = now > lateThresholdTime ? 'Late' : 'Present';

    if (existingRecord) {
      db.prepare('UPDATE attendance SET time_in = ?, status = ?, recorded_by = ? WHERE id = ?').run(
        timeString, attendanceStatus, req.session.user.username, existingRecord.id
      );
    } else {
      db.prepare('INSERT INTO attendance (event_id, student_id, time_in, status, recorded_by) VALUES (?, ?, ?, ?, ?)').run(
        event_id, student.student_id, timeString, attendanceStatus, req.session.user.username
      );
    }

    logAudit(req, 'TIME_IN', `Time In recorded for ${student.student_id} as ${attendanceStatus}`);

    return res.json({
      status: 'SUCCESS',
      type: 'TIME_IN',
      attendance_status: attendanceStatus,
      message: `Time In recorded (${attendanceStatus}).`,
      student: {
        student_id: student.student_id,
        name: `${student.first_name} ${student.last_name}`,
        position: student.position,
        photo_url: student.photo_url,
        time_in: timeString
      }
    });
  }
});

// Update attendance record manually (Admin)
app.put('/api/attendance/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const { status, time_in, time_out, excuse_reason } = req.body;

  db.prepare(`
    UPDATE attendance
    SET status = ?, time_in = ?, time_out = ?, excuse_reason = ?
    WHERE id = ?
  `).run(status, time_in, time_out, excuse_reason || '', id);

  logAudit(req, 'MANUAL_ATTENDANCE_UPDATE', `Updated attendance record ID ${id} to ${status}`);
  res.json({ message: 'Attendance updated.' });
});

// Attendance listing & filtering
app.get('/api/attendance', requireAuth, (req, res) => {
  const { event_id, student_id, date, status, position } = req.query;
  let query = `
    SELECT a.*, s.first_name, s.last_name, s.position, e.title as event_title, e.event_date
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (event_id) {
    query += ' AND a.event_id = ?';
    params.push(event_id);
  }
  if (student_id) {
    query += ' AND a.student_id = ?';
    params.push(student_id);
  }
  if (date) {
    query += ' AND e.event_date = ?';
    params.push(date);
  }
  if (status) {
    query += ' AND a.status = ?';
    params.push(status);
  }
  if (position) {
    query += ' AND s.position = ?';
    params.push(position);
  }

  query += ' ORDER BY a.created_at DESC';
  const records = db.prepare(query).all(...params);
  res.json(records);
});

// --- ANALYTICS & DASHBOARD API ---
app.get('/api/analytics/dashboard', requireAuth, (req, res) => {
  const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students WHERE status != "Rejected"').get().count;
  const activeStudents = db.prepare('SELECT COUNT(*) as count FROM students WHERE status = "Active"').get().count;
  const inactiveStudents = db.prepare('SELECT COUNT(*) as count FROM students WHERE status = "Inactive"').get().count;
  const pendingRegistrations = db.prepare('SELECT COUNT(*) as count FROM students WHERE status = "Pending"').get().count;
  const totalOfficers = db.prepare('SELECT COUNT(*) as count FROM students WHERE status = "Active" AND position != "Member"').get().count;

  const today = new Date().toISOString().split('T')[0];
  const todayScans = db.prepare(`
    SELECT 
      SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) as present,
      SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) as late,
      SUM(CASE WHEN a.status = 'Absent' THEN 1 ELSE 0 END) as absent,
      SUM(CASE WHEN a.status = 'Excused' THEN 1 ELSE 0 END) as excused
    FROM attendance a
    JOIN events e ON a.event_id = e.id
    WHERE e.event_date = ?
  `).get(today) || { present: 0, late: 0, absent: 0, excused: 0 };

  const totalAttended = (todayScans.present || 0) + (todayScans.late || 0);
  const totalExpected = totalAttended + (todayScans.absent || 0) + (todayScans.excused || 0);
  const attendanceRate = totalExpected > 0 ? Math.round((totalAttended / totalExpected) * 100) : 0;

  const activeEvent = db.prepare("SELECT * FROM events WHERE status = 'Active' LIMIT 1").get();
  const recentScans = db.prepare(`
    SELECT a.*, s.first_name, s.last_name, s.position, e.title as event_title
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.created_at DESC LIMIT 10
  `).all();

  // Low participation warning
  const thresholdSetting = db.prepare("SELECT value FROM settings WHERE key = 'low_participation_threshold'").get()?.value || '60';
  const threshold = parseFloat(thresholdSetting);

  const studentStats = db.prepare(`
    SELECT s.student_id, s.first_name, s.last_name, s.position,
      COUNT(a.id) as total_events,
      SUM(CASE WHEN a.status IN ('Present', 'Late') THEN 1 ELSE 0 END) as attended,
      SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) as late_count
    FROM students s
    LEFT JOIN attendance a ON s.student_id = a.student_id
    WHERE s.status = 'Active'
    GROUP BY s.student_id
  `).all();

  const lowParticipation = [];
  const frequentlyLate = [];

  studentStats.forEach(st => {
    const rate = st.total_events > 0 ? (st.attended / st.total_events) * 100 : 100;
    if (st.total_events >= 3 && rate < threshold) {
      lowParticipation.push({ ...st, rate: Math.round(rate) });
    }
    if (st.late_count >= 2) {
      frequentlyLate.push(st);
    }
  });

  res.json({
    metrics: {
      totalStudents,
      activeStudents,
      inactiveStudents,
      pendingRegistrations,
      totalOfficers,
      presentToday: todayScans.present || 0,
      lateToday: todayScans.late || 0,
      absentToday: todayScans.absent || 0,
      excusedToday: todayScans.excused || 0,
      attendanceRate
    },
    activeEvent,
    recentScans,
    alerts: {
      lowParticipation,
      frequentlyLate
    }
  });
});

// --- STUDENT PORTAL API ---
app.get('/api/student/me', requireAuth, requireRole('STUDENT'), (req, res) => {
  const studentId = req.session.user.student_id;
  const student = db.prepare('SELECT * FROM students WHERE student_id = ?').get(studentId);
  if (!student) return res.status(404).json({ error: 'Student record not found.' });

  const attendanceHistory = db.prepare(`
    SELECT a.*, e.title as event_title, e.event_date, e.location
    FROM attendance a
    JOIN events e ON a.event_id = e.id
    WHERE a.student_id = ?
    ORDER BY e.event_date DESC
  `).all(studentId);

  const stats = db.prepare(`
    SELECT 
      COUNT(id) as total,
      SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) as present,
      SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) as late,
      SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) as absent,
      SUM(CASE WHEN status = 'Excused' THEN 1 ELSE 0 END) as excused
    FROM attendance
    WHERE student_id = ?
  `).get(studentId);

  const total = stats.total || 0;
  const attended = (stats.present || 0) + (stats.late || 0);
  const participationRate = total > 0 ? Math.round((attended / total) * 100) : 100;

  const upcomingEvents = db.prepare("SELECT * FROM events WHERE status IN ('Upcoming', 'Active') ORDER BY event_date ASC").all();

  res.json({
    profile: student,
    attendance: attendanceHistory,
    stats: {
      total,
      present: stats.present || 0,
      late: stats.late || 0,
      absent: stats.absent || 0,
      excused: stats.excused || 0,
      participationRate
    },
    upcomingEvents
  });
});

// --- AUDIT LOGS & BACKUP API ---
app.get('/api/admin/audit-logs', requireAuth, requireRole('ADMIN'), (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200').all();
  res.json(logs);
});

app.get('/api/admin/backup', requireAuth, requireRole('ADMIN'), (req, res) => {
  try {
    const backupData = {
      timestamp: new Date().toISOString(),
      settings: db.prepare('SELECT * FROM settings').all(),
      positions: db.prepare('SELECT * FROM positions').all(),
      students: db.prepare('SELECT * FROM students').all(),
      position_history: db.prepare('SELECT * FROM position_history').all(),
      events: db.prepare('SELECT * FROM events').all(),
      attendance: db.prepare('SELECT * FROM attendance').all(),
      users: db.prepare('SELECT id, username, password, role, student_id, created_at FROM users').all()
    };
    logAudit(req, 'CREATE_BACKUP', 'System JSON backup created and downloaded.');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=school_club_backup_${Date.now()}.json`);
    res.send(JSON.stringify(backupData, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Failed to create backup.' });
  }
});

app.post('/api/admin/restore', requireAuth, requireRole('ADMIN'), (req, res) => {
  const backup = req.body;
  if (!backup || !backup.students || !backup.events) {
    return res.status(400).json({ error: 'Invalid backup file payload.' });
  }

  try {
    const restoreTx = db.transaction(() => {
      db.prepare('DELETE FROM attendance').run();
      db.prepare('DELETE FROM events').run();
      db.prepare('DELETE FROM position_history').run();
      db.prepare('DELETE FROM students').run();
      db.prepare('DELETE FROM positions').run();
      db.prepare('DELETE FROM settings').run();
      db.prepare('DELETE FROM users').run();

      const insSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      (backup.settings || []).forEach(s => insSetting.run(s.key, s.value));

      const insPos = db.prepare('INSERT INTO positions (id, title, created_at) VALUES (?, ?, ?)');
      (backup.positions || []).forEach(p => insPos.run(p.id, p.title, p.created_at));

      const insStu = db.prepare(`
        INSERT INTO students (id, student_id, first_name, middle_name, last_name, email, contact_number, position, student_club, school_year, status, qr_token, qr_enabled, photo_url, date_joined, expiration_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      (backup.students || []).forEach(s => insStu.run(s.id, s.student_id, s.first_name, s.middle_name, s.last_name, s.email, s.contact_number, s.position, s.student_club, s.school_year, s.status, s.qr_token, s.qr_enabled, s.photo_url, s.date_joined, s.expiration_date, s.created_at));

      const insHis = db.prepare('INSERT INTO position_history (id, student_id, position, school_year, assigned_at) VALUES (?, ?, ?, ?, ?)');
      (backup.position_history || []).forEach(h => insHis.run(h.id, h.student_id, h.position, h.school_year, h.assigned_at));

      const insEve = db.prepare(`
        INSERT INTO events (id, title, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, allowed_positions, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      (backup.events || []).forEach(e => insEve.run(e.id, e.title, e.description, e.event_type, e.event_date, e.start_time, e.end_time, e.late_threshold_minutes, e.location, e.organizer, e.allowed_positions, e.status, e.created_at));

      const insAtt = db.prepare(`
        INSERT INTO attendance (id, event_id, student_id, time_in, time_out, status, excuse_reason, recorded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      (backup.attendance || []).forEach(a => insAtt.run(a.id, a.event_id, a.student_id, a.time_in, a.time_out, a.status, a.excuse_reason, a.recorded_by, a.created_at));

      const insUser = db.prepare('INSERT INTO users (id, username, password, role, student_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      (backup.users || []).forEach(u => insUser.run(u.id, u.username, u.password, u.role, u.student_id, u.created_at));
    });

    restoreTx();
    logAudit(req, 'RESTORE_BACKUP', 'System restored from backup JSON successfully.');
    res.json({ message: 'Database restored successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to restore database: ' + err.message });
  }
});

// Helper route to render QR Data URL images on the fly
app.get('/api/qr/generate', async (req, res) => {
  const { text } = req.query;
  if (!text) return res.status(400).send('Text query required');
  try {
    const url = await QRCode.toDataURL(text, { margin: 1, width: 250 });
    res.json({ dataUrl: url });
  } catch (e) {
    res.status(500).json({ error: 'QR Generation failed' });
  }
});

// CSV Export Endpoint
app.get('/api/export/attendance/csv', requireAuth, (req, res) => {
  const { event_id } = req.query;
  let query = `
    SELECT a.id, a.student_id, s.first_name, s.last_name, s.position, e.title as event_title, e.event_date, a.time_in, a.time_out, a.status, a.excuse_reason
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN events e ON a.event_id = e.id
  `;
  const params = [];
  if (event_id) {
    query += ' WHERE a.event_id = ?';
    params.push(event_id);
  }
  query += ' ORDER BY a.created_at DESC';

  const rows = db.prepare(query).all(...params);
  let csv = 'ID,Student ID,First Name,Last Name,Position,Event Title,Event Date,Time In,Time Out,Status,Excuse Reason\n';

  rows.forEach(r => {
    csv += `"${r.id}","${r.student_id}","${r.first_name}","${r.last_name}","${r.position}","${r.event_title}","${r.event_date}","${r.time_in || ''}","${r.time_out || ''}","${r.status}","${r.excuse_reason || ''}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=attendance_export_${Date.now()}.csv`);
  res.send(csv);
});

// ==========================================
// FRONTEND WEB APPLICATION (SINGLE PAGE APP)
// ==========================================

app.get('*', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Student Club QR Attendance Management System</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <style>
    :root {
      --primary-color: #1e3a8a;
      --secondary-color: #0d9488;
      --accent-color: #f59e0b;
      --bg-light: #f8fafc;
      --text-dark: #0f172a;
    }
    body {
      background-color: var(--bg-light);
      color: var(--text-dark);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    .sidebar {
      min-height: 100vh;
      background-color: var(--primary-color);
      color: white;
    }
    .sidebar .nav-link {
      color: #cbd5e1;
      padding: 0.8rem 1rem;
      border-radius: 0.375rem;
      margin-bottom: 0.25rem;
    }
    .sidebar .nav-link:hover, .sidebar .nav-link.active {
      color: white;
      background-color: rgba(255, 255, 255, 0.15);
    }
    .card-dashboard {
      border: none;
      border-radius: 0.75rem;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      transition: transform 0.2s;
    }
    .card-dashboard:hover {
      transform: translateY(-2px);
    }
    /* ID Card Standard Dimensions for A4 Layout (8 per page) */
    .id-card-printable {
      width: 85.6mm;
      height: 53.98mm;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 6px;
      box-sizing: border-box;
      background: #ffffff;
      display: inline-flex;
      flex-direction: column;
      justify-content: space-between;
      margin: 4mm;
      position: relative;
      page-break-inside: avoid;
    }
    @media print {
      body * {
        visibility: hidden;
      }
      #printContainer, #printContainer * {
        visibility: visible;
      }
      #printContainer {
        position: absolute;
        left: 0;
        top: 0;
        width: 210mm;
      }
      .no-print {
        display: none !important;
      }
    }
  </style>
</head>
<body>

<div id="app">
  <!-- Dynamic Application Interface Rendered via JS -->
</div>

<script>
  // App State Manager
  const state = {
    user: null,
    settings: {},
    positions: [],
    currentView: 'login',
    scanner: null,
    activeEventId: null,
    scanMode: 'TIME_IN',
    voiceEnabled: true
  };

  // API Call Helper
  async function api(url, options = {}) {
    options.headers = options.headers || {};
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || data.message || 'API Error');
    }
    return data;
  }

  // Audio & Speech Feedback
  function speak(text) {
    if (!state.voiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  function playSound(type) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'success') {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } else if (type === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, ctx.currentTime);
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.setValueAtTime(300, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    }
  }

  // App Initialization
  async function init() {
    try {
      state.settings = await api('/api/settings');
      state.positions = await api('/api/positions');
      
      // Check current route hash
      const path = window.location.hash.replace('#', '');
      if (path === 'register') {
        renderPublicRegister();
        return;
      }

      const auth = await api('/api/auth/me');
      state.user = auth.user;
      
      if (state.user.role === 'ADMIN') renderAdminLayout('dashboard');
      else if (state.user.role === 'SCANNER') renderScannerPortal();
      else if (state.user.role === 'STUDENT') renderStudentPortal();
    } catch (e) {
      if (window.location.hash === '#register') {
        renderPublicRegister();
      } else {
        renderLogin();
      }
    }
  }

  // --- VIEWS ---

  // LOGIN VIEW
  function renderLogin() {
    document.getElementById('app').innerHTML = \`
      <div class="container d-flex justify-content-center align-items-center vh-100">
        <div class="card p-4 shadow-lg" style="max-width: 420px; width: 100%; border-radius: 1rem;">
          <div class="text-center mb-4">
            <i class="fa-solid fa-qrcode fa-3x text-primary mb-2"></i>
            <h4 class="fw-bold">\${state.settings.school_name || 'School System'}</h4>
            <p class="text-muted small">\${state.settings.student_club_name || 'Club'} Attendance Management</p>
          </div>
          <div id="loginAlert"></div>
          <form id="loginForm">
            <div class="mb-3">
              <label class="form-label font-weight-bold">Username / Student ID</label>
              <input type="text" id="loginUsername" class="form-control" required placeholder="Enter username">
            </div>
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" id="loginPassword" class="form-control" required placeholder="Enter password">
            </div>
            <button type="submit" class="btn btn-primary w-100 py-2">Sign In</button>
          </form>
          <div class="text-center mt-3">
            <a href="#register" onclick="renderPublicRegister();" class="text-decoration-none small">Student Self-Registration Link</a>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const user = await api('/api/auth/login', {
          method: 'POST',
          body: {
            username: document.getElementById('loginUsername').value,
            password: document.getElementById('loginPassword').value
          }
        });
        state.user = user.user;
        if (state.user.role === 'ADMIN') renderAdminLayout('dashboard');
        else if (state.user.role === 'SCANNER') renderScannerPortal();
        else if (state.user.role === 'STUDENT') renderStudentPortal();
      } catch (err) {
        document.getElementById('loginAlert').innerHTML = \`<div class="alert alert-danger p-2 small">\${err.message}</div>\`;
      }
    };
  }

  // PUBLIC STUDENT REGISTRATION VIEW
  function renderPublicRegister() {
    window.location.hash = 'register';
    document.getElementById('app').innerHTML = \`
      <div class="container py-5">
        <div class="row justify-content-center">
          <div class="col-md-8 col-lg-6">
            <div class="card shadow-sm border-0">
              <div class="card-body p-4">
                <div class="text-center mb-4">
                  <h3 class="fw-bold text-primary">\${state.settings.student_club_name || 'Student Club'} Registration</h3>
                  <p class="text-muted small">\${state.settings.school_name || 'School Attendance Portal'} (\${state.settings.school_year || '2026-2027'})</p>
                </div>
                <div id="regAlert"></div>
                <form id="publicRegForm">
                  <div class="mb-3">
                    <label class="form-label">Student ID *</label>
                    <input type="text" id="regStudentId" class="form-control" required placeholder="e.g. 2026-0001">
                  </div>
                  <div class="row">
                    <div class="col-md-5 mb-3">
                      <label class="form-label">First Name *</label>
                      <input type="text" id="regFirstName" class="form-control" required>
                    </div>
                    <div class="col-md-2 mb-3">
                      <label class="form-label">M.I.</label>
                      <input type="text" id="regMiddleName" class="form-control" maxlength="1">
                    </div>
                    <div class="col-md-5 mb-3">
                      <label class="form-label">Last Name *</label>
                      <input type="text" id="regLastName" class="form-control" required>
                    </div>
                  </div>
                  <div class="mb-3">
                    <label class="form-label">School Email *</label>
                    <input type="email" id="regEmail" class="form-control" required placeholder="student@school.edu">
                  </div>
                  <div class="mb-3">
                    <label class="form-label">Contact Number</label>
                    <input type="text" id="regContact" class="form-control">
                  </div>
                  <div class="mb-3">
                    <label class="form-label">Requested Position *</label>
                    <select id="regPosition" class="form-select" required>
                      \${state.positions.map(p => \`<option value="\${p.title}">\${p.title}</option>\`).join('')}
                    </select>
                  </div>
                  <button type="submit" class="btn btn-success w-100 py-2">Submit Registration</button>
                  <div class="text-center mt-3">
                    <a href="#" onclick="renderLogin();" class="text-decoration-none small">Already have an account? Login</a>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('publicRegForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const payload = {
          student_id: document.getElementById('regStudentId').value,
          first_name: document.getElementById('regFirstName').value,
          middle_name: document.getElementById('regMiddleName').value,
          last_name: document.getElementById('regLastName').value,
          email: document.getElementById('regEmail').value,
          contact_number: document.getElementById('regContact').value,
          position: document.getElementById('regPosition').value
        };

        const res = await api('/api/public/register', { method: 'POST', body: payload });
        document.getElementById('app').innerHTML = \`
          <div class="container py-5 text-center">
            <div class="card p-5 shadow-sm mx-auto" style="max-width: 500px;">
              <i class="fa-solid fa-circle-check fa-4x text-success mb-3"></i>
              <h3 class="fw-bold">REGISTRATION SUCCESSFUL</h3>
              <p class="text-muted">\${res.message}</p>
              <div class="alert alert-warning py-2 mt-2">Status: <strong>Pending Approval</strong></div>
              <p class="small text-muted">Please wait for your Club Adviser (\${state.settings.club_adviser || 'Adviser'}) to approve your account.</p>
              <button onclick="renderLogin()" class="btn btn-primary mt-3">Return to Login</button>
            </div>
          </div>
        \`;
      } catch (err) {
        document.getElementById('regAlert').innerHTML = \`<div class="alert alert-danger p-2 small">\${err.message}</div>\`;
      }
    };
  }

  // --- ADMIN MAIN LAYOUT & NAVIGATION ---
  function renderAdminLayout(activeTab) {
    document.getElementById('app').innerHTML = \`
      <div class="d-flex">
        <!-- Sidebar -->
        <div class="sidebar p-3 d-flex flex-column" style="width: 260px;">
          <div class="d-flex align-items-center mb-4">
            <i class="fa-solid fa-graduation-cap fa-2x me-2 text-warning"></i>
            <div>
              <div class="fw-bold leading-tight">\${state.settings.student_club_name || 'Club'} Portal</div>
              <div class="small text-slate-400 opacity-75">\${state.settings.school_name || 'School'}</div>
            </div>
          </div>
          <nav class="nav flex-column mb-auto">
            <a class="nav-link \${activeTab==='dashboard'?'active':''}" href="#" onclick="renderAdminLayout('dashboard')"><i class="fa-solid fa-chart-line me-2"></i> Dashboard</a>
            <a class="nav-link \${activeTab==='registrations'?'active':''}" href="#" onclick="renderAdminLayout('registrations')"><i class="fa-solid fa-user-clock me-2"></i> Registrations</a>
            <a class="nav-link \${activeTab==='students'?'active':''}" href="#" onclick="renderAdminLayout('students')"><i class="fa-solid fa-users me-2"></i> Students & IDs</a>
            <a class="nav-link \${activeTab==='positions'?'active':''}" href="#" onclick="renderAdminLayout('positions')"><i class="fa-solid fa-id-badge me-2"></i> Custom Positions</a>
            <a class="nav-link \${activeTab==='events'?'active':''}" href="#" onclick="renderAdminLayout('events')"><i class="fa-solid fa-calendar-days me-2"></i> Event Manager</a>
            <a class="nav-link \${activeTab==='attendance'?'active':''}" href="#" onclick="renderAdminLayout('attendance')"><i class="fa-solid fa-clipboard-user me-2"></i> Attendance Logs</a>
            <a class="nav-link \${activeTab==='scanner'?'active':''}" href="#" onclick="renderScannerPortal()"><i class="fa-solid fa-qrcode me-2"></i> Open QR Scanner</a>
            <a class="nav-link \${activeTab==='reports'?'active':''}" href="#" onclick="renderAdminLayout('reports')"><i class="fa-solid fa-file-invoice me-2"></i> Reports & Export</a>
            <a class="nav-link \${activeTab==='settings'?'active':''}" href="#" onclick="renderAdminLayout('settings')"><i class="fa-solid fa-gears me-2"></i> Settings & Backup</a>
          </nav>
          <hr class="text-light">
          <div class="dropdown">
            <a href="#" class="d-flex align-items-center text-white text-decoration-none dropdown-toggle" data-bs-toggle="dropdown">
              <i class="fa-solid fa-user-shield me-2"></i>
              <strong>\${state.user.username}</strong>
            </a>
            <ul class="dropdown-menu dropdown-menu-dark text-small shadow">
              <li><a class="dropdown-item" href="#" onclick="showChangePasswordModal()">Change Password</a></li>
              <li><hr class="dropdown-divider"></li>
              <li><a class="dropdown-item" href="#" onclick="logout()">Sign out</a></li>
            </ul>
          </div>
        </div>

        <!-- Main Content Body -->
        <div class="flex-grow-1 p-4" style="overflow-y: auto; max-height: 100vh;">
          <div id="adminContent"></div>
        </div>
      </div>
    \`;

    if (activeTab === 'dashboard') loadAdminDashboard();
    else if (activeTab === 'registrations') loadAdminRegistrations();
    else if (activeTab === 'students') loadAdminStudents();
    else if (activeTab === 'positions') loadAdminPositions();
    else if (activeTab === 'events') loadAdminEvents();
    else if (activeTab === 'attendance') loadAdminAttendance();
    else if (activeTab === 'reports') loadAdminReports();
    else if (activeTab === 'settings') loadAdminSettings();
  }

  // DASHBOARD VIEW
  async function loadAdminDashboard() {
    const data = await api('/api/analytics/dashboard');
    const container = document.getElementById('adminContent');
    container.innerHTML = \`
      <h3 class="fw-bold mb-4">Adviser Analytics Dashboard</h3>
      <div class="row g-3 mb-4">
        <div class="col-md-3">
          <div class="card card-dashboard p-3 bg-primary text-white">
            <div class="small opacity-75">Total Active Students</div>
            <div class="display-6 fw-bold">\${data.metrics.activeStudents}</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-dashboard p-3 bg-warning text-dark">
            <div class="small opacity-75">Pending Registrations</div>
            <div class="display-6 fw-bold">\${data.metrics.pendingRegistrations}</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-dashboard p-3 bg-success text-white">
            <div class="small opacity-75">Present Today</div>
            <div class="display-6 fw-bold">\${data.metrics.presentToday}</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-dashboard p-3 bg-info text-white">
            <div class="small opacity-75">Attendance Rate</div>
            <div class="display-6 fw-bold">\${data.metrics.attendanceRate}%</div>
          </div>
        </div>
      </div>

      <div class="row g-3">
        <div class="col-md-8">
          <div class="card shadow-sm border-0 p-3 mb-4">
            <h5 class="fw-bold mb-3">Recent Scans</h5>
            <table class="table table-hover table-sm">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Position</th>
                  <th>Event</th>
                  <th>Time In</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                \${data.recentScans.map(s => \`
                  <tr>
                    <td>\${s.first_name} \${s.last_name}</td>
                    <td><span class="badge bg-secondary">\${s.position}</span></td>
                    <td>\${s.event_title}</td>
                    <td>\${s.time_in || '-'}</td>
                    <td><span class="badge bg-\${s.status==='Present'?'success':s.status==='Late'?'warning':'danger'}">\${s.status}</span></td>
                  </tr>
                \`).join('') || '<tr><td colspan="5" class="text-center text-muted">No attendance activity today</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card shadow-sm border-0 p-3 mb-3">
            <h5 class="fw-bold text-danger"><i class="fa-solid fa-triangle-exclamation me-1"></i> Low Participation Alert</h5>
            <ul class="list-group list-group-flush small">
              \${data.alerts.lowParticipation.map(st => \`
                <li class="list-group-item d-flex justify-between align-items-center">
                  \${st.first_name} \${st.last_name}
                  <span class="badge bg-danger ms-auto">\${st.rate}% Rate</span>
                </li>
              \`).join('') || '<li class="list-group-item text-muted">All active students meet criteria</li>'}
            </ul>
          </div>
          <div class="card shadow-sm border-0 p-3">
            <h5 class="fw-bold text-warning"><i class="fa-solid fa-clock me-1"></i> Frequently Late Students</h5>
            <ul class="list-group list-group-flush small">
              \${data.alerts.frequentlyLate.map(st => \`
                <li class="list-group-item d-flex justify-between align-items-center">
                  \${st.first_name} \${st.last_name}
                  <span class="badge bg-warning text-dark ms-auto">\${st.late_count} Times</span>
                </li>
              \`).join('') || '<li class="list-group-item text-muted">No tardiness warnings</li>'}
            </ul>
          </div>
        </div>
      </div>
    \`;
  }

  // REGISTRATIONS MANAGEMENT
  async function loadAdminRegistrations() {
    const pending = await api('/api/students?status=Pending');
    const container = document.getElementById('adminContent');
    
    const regUrl = window.location.origin + '/#register';

    container.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Pending Student Registrations</h3>
        <div>
          <button class="btn btn-outline-primary btn-sm me-2" onclick="navigator.clipboard.writeText('\${regUrl}'); alert('Registration link copied!');">
            <i class="fa-solid fa-copy me-1"></i> Copy Public Link
          </button>
          <button class="btn btn-outline-secondary btn-sm" onclick="showRegistrationQRModal('\${regUrl}')">
            <i class="fa-solid fa-qrcode me-1"></i> Display Registration QR
          </button>
        </div>
      </div>
      <div class="card shadow-sm border-0 p-3">
        <table class="table table-hover">
          <thead>
            <tr>
              <th>Student ID</th>
              <th>Name</th>
              <th>Email</th>
              <th>Requested Position</th>
              <th>Date</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            \${pending.map(s => \`
              <tr>
                <td><strong>\${s.student_id}</strong></td>
                <td>\${s.first_name} \${s.last_name}</td>
                <td>\${s.email}</td>
                <td><span class="badge bg-info text-dark">\${s.position}</span></td>
                <td>\${s.date_joined || '-'}</td>
                <td>
                  <button class="btn btn-success btn-sm me-1" onclick="approveStudent(\${s.id})"><i class="fa-solid fa-check"></i> Approve</button>
                  <button class="btn btn-danger btn-sm" onclick="rejectStudent(\${s.id})"><i class="fa-solid fa-xmark"></i> Reject</button>
                </td>
              </tr>
            \`).join('') || '<tr><td colspan="6" class="text-center text-muted">No pending student registrations</td></tr>'}
          </tbody>
        </table>
      </div>
    \`;
  }

  async function approveStudent(id) {
    await api('/api/students/approve/' + id, { method: 'POST' });
    loadAdminRegistrations();
  }

  async function rejectStudent(id) {
    if (confirm('Are you sure you want to reject this registration?')) {
      await api('/api/students/reject/' + id, { method: 'POST' });
      loadAdminRegistrations();
    }
  }

  function showRegistrationQRModal(url) {
    api('/api/qr/generate?text=' + encodeURIComponent(url)).then(res => {
      const modal = document.createElement('div');
      modal.className = 'modal fade show d-block';
      modal.style.background = 'rgba(0,0,0,0.5)';
      modal.innerHTML = \`
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content text-center p-4">
            <h4 class="fw-bold">Student Registration QR Code</h4>
            <p class="text-muted small">Scan this QR code using a mobile phone to access the self-registration page.</p>
            <img src="\${res.dataUrl}" class="mx-auto my-3" style="width: 200px;">
            <button class="btn btn-secondary w-100" onclick="this.closest('.modal').remove()">Close</button>
          </div>
        </div>
      \`;
      document.body.appendChild(modal);
    });
  }

  // STUDENTS & ID MANAGEMENT
  async function loadAdminStudents() {
    const students = await api('/api/students?status=Active');
    const container = document.getElementById('adminContent');
    
    container.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Active Student Directory</h3>
        <div>
          <button class="btn btn-primary btn-sm me-2" onclick="printA4IDs()"><i class="fa-solid fa-print me-1"></i> Print Batch IDs (8 per A4)</button>
        </div>
      </div>
      <div class="card shadow-sm border-0 p-3">
        <table class="table table-hover">
          <thead>
            <tr>
              <th>Student ID</th>
              <th>Full Name</th>
              <th>Position</th>
              <th>School Email</th>
              <th>QR Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            \${students.map(s => \`
              <tr>
                <td><strong>\${s.student_id}</strong></td>
                <td>\${s.first_name} \${s.last_name}</td>
                <td><span class="badge bg-primary">\${s.position}</span></td>
                <td>\${s.email}</td>
                <td><span class="badge bg-\${s.qr_enabled?'success':'danger'}">\${s.qr_enabled?'Enabled':'Disabled'}</span></td>
                <td>
                  <button class="btn btn-outline-info btn-sm" onclick="showStudentCardModal(\${s.id})"><i class="fa-solid fa-id-card"></i> View ID</button>
                  <button class="btn btn-outline-warning btn-sm" onclick="regenerateQR(\${s.id})"><i class="fa-solid fa-arrows-rotate"></i> Reset QR</button>
                  <button class="btn btn-outline-danger btn-sm" onclick="deleteStudent(\${s.id})"><i class="fa-solid fa-trash"></i> Delete</button>
                </td>
              </tr>
            \`).join('') || '<tr><td colspan="6" class="text-center text-muted">No active student members registered</td></tr>'}
          </tbody>
        </table>
      </div>
    \`;
  }

  async function regenerateQR(id) {
    if (confirm('Regenerating QR will invalidate the old student QR Code. Continue?')) {
      await api('/api/students/' + id + '/regenerate-qr', { method: 'POST' });
      alert('QR Code successfully regenerated!');
      loadAdminStudents();
    }
  }

  async function deleteStudent(id) {
    if (confirm('Are you sure you want to permanently delete this student record?')) {
      await api('/api/students/' + id, { method: 'DELETE' });
      loadAdminStudents();
    }
  }

  // PRINTING 8 IDS PER A4 SHEET
  async function printA4IDs() {
    const students = await api('/api/students?status=Active');
    if (!students.length) return alert('No active students available to print.');

    const printContainer = document.createElement('div');
    printContainer.id = 'printContainer';

    for (let s of students) {
      const qrRes = await api('/api/qr/generate?text=' + encodeURIComponent(s.qr_token));
      printContainer.innerHTML += \`
        <div class="id-card-printable">
          <div class="d-flex align-items-center mb-1">
            <i class="fa-solid fa-graduation-cap fa-lg me-1 text-primary"></i>
            <div>
              <div style="font-size: 8px; font-weight: bold; line-height: 1;">\${state.settings.school_name || 'School Name'}</div>
              <div style="font-size: 7px; color: #555;">\${state.settings.student_club_name || 'Club'}</div>
            </div>
          </div>
          <div class="d-flex align-items-center my-1">
            <div style="width: 38px; height: 38px; background: #e2e8f0; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 18px; margin-right: 6px;">
              <i class="fa-solid fa-user text-secondary"></i>
            </div>
            <div>
              <div style="font-size: 10px; font-weight: bold;">\${s.first_name} \${s.last_name}</div>
              <div style="font-size: 8px; color: #0284c7; font-weight: 600;">\${s.position}</div>
              <div style="font-size: 7px; color: #64748b;">ID: \${s.student_id}</div>
            </div>
          </div>
          <div class="d-flex justify-content-between align-items-end mt-1">
            <div style="font-size: 6px; color: #94a3b8;">SY \${s.school_year}</div>
            <img src="\${qrRes.dataUrl}" style="width: 32px; height: 32px;">
          </div>
        </div>
      \`;
    }

    document.body.appendChild(printContainer);
    window.print();
    printContainer.remove();
  }

  // POSITIONS MANAGEMENT
  async function loadAdminPositions() {
    const positions = await api('/api/positions');
    const container = document.getElementById('adminContent');

    container.innerHTML = \`
      <h3 class="fw-bold mb-3">Custom Club Positions</h3>
      <div class="row">
        <div class="col-md-4">
          <div class="card p-3 shadow-sm border-0 mb-3">
            <h5 class="fw-bold">Add Custom Position</h5>
            <form id="addPosForm">
              <div class="mb-3">
                <input type="text" id="newPosTitle" class="form-control" placeholder="e.g. Technical Officer" required>
              </div>
              <button class="btn btn-primary w-100">Add Position</button>
            </form>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card p-3 shadow-sm border-0">
            <table class="table table-hover">
              <thead>
                <tr>
                  <th>Position Title</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${positions.map(p => \`
                  <tr>
                    <td><strong>\${p.title}</strong></td>
                    <td>
                      <button class="btn btn-sm btn-outline-danger" onclick="deletePosition(\${p.id})"><i class="fa-solid fa-trash"></i></button>
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('addPosForm').onsubmit = async (e) => {
      e.preventDefault();
      await api('/api/positions', { method: 'POST', body: { title: document.getElementById('newPosTitle').value } });
      state.positions = await api('/api/positions');
      loadAdminPositions();
    };
  }

  async function deletePosition(id) {
    if (confirm('Delete this custom position?')) {
      await api('/api/positions/' + id, { method: 'DELETE' });
      state.positions = await api('/api/positions');
      loadAdminPositions();
    }
  }

  // EVENT MANAGEMENT
  async function loadAdminEvents() {
    const events = await api('/api/events');
    const container = document.getElementById('adminContent');

    container.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Club Events & Meetings</h3>
        <button class="btn btn-primary btn-sm" onclick="showCreateEventModal()"><i class="fa-solid fa-plus me-1"></i> Create Event</button>
      </div>
      <div class="card p-3 shadow-sm border-0">
        <table class="table table-hover">
          <thead>
            <tr>
              <th>Title</th>
              <th>Date & Time</th>
              <th>Location</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            \${events.map(e => \`
              <tr>
                <td><strong>\${e.title}</strong></td>
                <td>\${e.event_date} (\${e.start_time} - \${e.end_time})</td>
                <td>\${e.location || 'N/A'}</td>
                <td><span class="badge bg-\${e.status==='Active'?'success':e.status==='Completed'?'secondary':'primary'}">\${e.status}</span></td>
                <td>
                  \${e.status !== 'Completed' ? \`<button class="btn btn-sm btn-outline-success me-1" onclick="setEventStatus(\${e.id}, 'Active')">Activate</button>\` : ''}
                  \${e.status === 'Active' ? \`<button class="btn btn-sm btn-outline-secondary me-1" onclick="setEventStatus(\${e.id}, 'Completed')">Complete</button>\` : ''}
                  <button class="btn btn-sm btn-outline-danger" onclick="deleteEvent(\${e.id})"><i class="fa-solid fa-trash"></i></button>
                </td>
              </tr>
            \`).join('') || '<tr><td colspan="5" class="text-center text-muted">No events recorded</td></tr>'}
          </tbody>
        </table>
      </div>
    \`;
  }

  function showCreateEventModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade show d-block';
    modal.style.background = 'rgba(0,0,0,0.5)';
    modal.innerHTML = \`
      <div class="modal-dialog">
        <div class="modal-content p-4">
          <h4 class="fw-bold mb-3">Create Event</h4>
          <form id="createEventForm">
            <div class="mb-2"><label class="form-label">Event Title</label><input type="text" id="evTitle" class="form-control" required></div>
            <div class="mb-2"><label class="form-label">Date</label><input type="date" id="evDate" class="form-control" required></div>
            <div class="row">
              <div class="col-md-6 mb-2"><label class="form-label">Start Time</label><input type="time" id="evStart" class="form-control" required></div>
              <div class="col-md-6 mb-2"><label class="form-label">End Time</label><input type="time" id="evEnd" class="form-control" required></div>
            </div>
            <div class="mb-2"><label class="form-label">Late Threshold (Mins)</label><input type="number" id="evLate" class="form-control" value="15"></div>
            <div class="mb-3"><label class="form-label">Location</label><input type="text" id="evLoc" class="form-control"></div>
            <button class="btn btn-primary w-100">Save Event</button>
            <button type="button" class="btn btn-link w-100 text-muted mt-1" onclick="this.closest('.modal').remove()">Cancel</button>
          </form>
        </div>
      </div>
    \`;
    document.body.appendChild(modal);

    document.getElementById('createEventForm').onsubmit = async (e) => {
      e.preventDefault();
      await api('/api/events', {
        method: 'POST',
        body: {
          title: document.getElementById('evTitle').value,
          event_date: document.getElementById('evDate').value,
          start_time: document.getElementById('evStart').value,
          end_time: document.getElementById('evEnd').value,
          late_threshold_minutes: document.getElementById('evLate').value,
          location: document.getElementById('evLoc').value
        }
      });
      modal.remove();
      loadAdminEvents();
    };
  }

  async function setEventStatus(id, status) {
    const events = await api('/api/events');
    const ev = events.find(e => e.id === id);
    if (!ev) return;
    ev.status = status;
    await api('/api/events/' + id, { method: 'PUT', body: ev });
    loadAdminEvents();
  }

  async function deleteEvent(id) {
    if (confirm('Delete event and associated attendance records?')) {
      await api('/api/events/' + id, { method: 'DELETE' });
      loadAdminEvents();
    }
  }

  // SCANNER PORTAL
  async function renderScannerPortal() {
    const events = await api('/api/events');
    const activeEvents = events.filter(e => e.status === 'Active' || e.status === 'Upcoming');

    document.getElementById('app').innerHTML = \`
      <div class="container py-4">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h3 class="fw-bold"><i class="fa-solid fa-qrcode text-primary me-2"></i> Attendance Scanner</h3>
          \${state.user.role === 'ADMIN' ? '<button class="btn btn-outline-secondary btn-sm" onclick="renderAdminLayout(\\'dashboard\\')">Exit to Admin</button>' : '<button class="btn btn-outline-danger btn-sm" onclick="logout()">Logout</button>'}
        </div>

        <div class="row g-3">
          <div class="col-md-6">
            <div class="card p-3 shadow-sm border-0 mb-3">
              <div class="mb-3">
                <label class="form-label fw-bold">Select Active Event</label>
                <select id="scannerEventId" class="form-select">
                  \${activeEvents.map(e => \`<option value="\${e.id}">\${e.title} (\${e.event_date})</option>\`).join('') || '<option value="">No Active/Upcoming Events</option>'}
                </select>
              </div>

              <div class="d-flex gap-2 mb-3">
                <button class="btn \${state.scanMode==='TIME_IN'?'btn-primary':'btn-outline-primary'} flex-grow-1" onclick="setScanMode('TIME_IN')">TIME IN Mode</button>
                <button class="btn \${state.scanMode==='TIME_OUT'?'btn-warning':'btn-outline-warning'} flex-grow-1" onclick="setScanMode('TIME_OUT')">TIME OUT Mode</button>
              </div>

              <div id="reader" style="width: 100%; border-radius: 8px; overflow: hidden; background: #000;"></div>
              
              <div class="mt-3 text-center">
                <button id="btnStartScan" class="btn btn-success" onclick="startCamera()"><i class="fa-solid fa-camera me-1"></i> Start Camera</button>
                <button id="btnStopScan" class="btn btn-danger d-none" onclick="stopCamera()"><i class="fa-solid fa-stop me-1"></i> Stop Camera</button>
              </div>
            </div>
          </div>

          <div class="col-md-6">
            <div id="scanFeedback" class="card p-4 text-center shadow-sm border-0 mb-3" style="min-height: 200px; display: flex; align-items: center; justify-content: center;">
              <i class="fa-solid fa-qrcode fa-4x text-muted mb-2"></i>
              <p class="text-muted">Awaiting QR scan...</p>
            </div>
          </div>
        </div>
      </div>
    \`;
  }

  function setScanMode(mode) {
    state.scanMode = mode;
    renderScannerPortal();
  }

  function startCamera() {
    state.scanner = new Html5Qrcode("reader");
    state.scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess
    ).then(() => {
      document.getElementById('btnStartScan').classList.add('d-none');
      document.getElementById('btnStopScan').classList.remove('d-none');
    }).catch(err => {
      alert("Unable to access camera: " + err);
    });
  }

  function stopCamera() {
    if (state.scanner) {
      state.scanner.stop().then(() => {
        document.getElementById('btnStartScan').classList.remove('d-none');
        document.getElementById('btnStopScan').classList.add('d-none');
      });
    }
  }

  async function onScanSuccess(decodedText) {
    const eventId = document.getElementById('scannerEventId').value;
    if (!eventId) {
      playSound('error');
      speak('Please select an active event');
      return;
    }

    try {
      const res = await api('/api/attendance/scan', {
        method: 'POST',
        body: { qr_token: decodedText, event_id: eventId, scan_type: state.scanMode }
      });

      playSound('success');
      speak(\`\${res.student.name}, \${state.scanMode === 'TIME_IN' ? 'Time in recorded' : 'Time out recorded'}\`);

      document.getElementById('scanFeedback').innerHTML = \`
        <div class="text-center">
          <i class="fa-solid fa-circle-check fa-4x text-success mb-2"></i>
          <h4 class="fw-bold text-success">\${res.message}</h4>
          <h5 class="fw-bold mt-2">\${res.student.name}</h5>
          <p class="text-muted mb-0">ID: \${res.student.student_id} | \${res.student.position}</p>
        </div>
      \`;
    } catch (err) {
      playSound('error');
      speak('Scan failed. ' + err.message);

      document.getElementById('scanFeedback').innerHTML = \`
        <div class="text-center">
          <i class="fa-solid fa-circle-xmark fa-4x text-danger mb-2"></i>
          <h4 class="fw-bold text-danger">SCAN ERROR</h4>
          <p class="text-muted">\${err.message}</p>
        </div>
      \`;
    }
  }

  // ATTENDANCE LOGS & REPORTS
  async function loadAdminAttendance() {
    const logs = await api('/api/attendance');
    const container = document.getElementById('adminContent');

    container.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Attendance Records</h3>
        <a href="/api/export/attendance/csv" class="btn btn-outline-success btn-sm"><i class="fa-solid fa-file-csv me-1"></i> Export CSV</a>
      </div>
      <div class="card p-3 shadow-sm border-0">
        <table class="table table-hover">
          <thead>
            <tr>
              <th>Student</th>
              <th>Position</th>
              <th>Event</th>
              <th>Date</th>
              <th>Time In</th>
              <th>Time Out</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            \${logs.map(l => \`
              <tr>
                <td>\${l.first_name} \${l.last_name}</td>
                <td><span class="badge bg-secondary">\${l.position}</span></td>
                <td>\${l.event_title}</td>
                <td>\${l.event_date}</td>
                <td>\${l.time_in || '-'}</td>
                <td>\${l.time_out || '-'}</td>
                <td><span class="badge bg-\${l.status==='Present'?'success':l.status==='Late'?'warning':'danger'}">\${l.status}</span></td>
              </tr>
            \`).join('') || '<tr><td colspan="7" class="text-center text-muted">No attendance data logged</td></tr>'}
          </tbody>
        </table>
      </div>
    \`;
  }

  function loadAdminReports() {
    loadAdminAttendance();
  }

  // SETTINGS & BACKUP VIEW
  async function loadAdminSettings() {
    const container = document.getElementById('adminContent');
    container.innerHTML = \`
      <h3 class="fw-bold mb-3">System Settings & Data Management</h3>
      <div class="row g-3">
        <div class="col-md-6">
          <div class="card p-3 shadow-sm border-0">
            <h5 class="fw-bold mb-3">School & Club Information</h5>
            <form id="settingsForm">
              <div class="mb-2"><label class="form-label">School Name</label><input type="text" id="setSchoolName" class="form-control" value="\${state.settings.school_name || ''}"></div>
              <div class="mb-2"><label class="form-label">Student Club Name</label><input type="text" id="setClubName" class="form-control" value="\${state.settings.student_club_name || ''}"></div>
              <div class="mb-2"><label class="form-label">School Year</label><input type="text" id="setSchoolYear" class="form-control" value="\${state.settings.school_year || ''}"></div>
              <div class="mb-2"><label class="form-label">Club Adviser</label><input type="text" id="setAdviser" class="form-control" value="\${state.settings.club_adviser || ''}"></div>
              <button class="btn btn-primary mt-2">Save Settings</button>
            </form>
          </div>
        </div>

        <div class="col-md-6">
          <div class="card p-3 shadow-sm border-0 mb-3">
            <h5 class="fw-bold mb-3">Backup & Data Restore</h5>
            <p class="text-muted small">Download a persistent JSON backup of all database contents or restore an existing backup file.</p>
            <a href="/api/admin/backup" class="btn btn-outline-primary mb-3"><i class="fa-solid fa-download me-1"></i> Download Backup JSON</a>
            <hr>
            <h6>Restore Database</h6>
            <input type="file" id="restoreFile" class="form-control mb-2" accept=".json">
            <button class="btn btn-danger w-100" onclick="restoreDatabase()"><i class="fa-solid fa-upload me-1"></i> Restore from JSON</button>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('settingsForm').onsubmit = async (e) => {
      e.preventDefault();
      await api('/api/settings', {
        method: 'POST',
        body: {
          school_name: document.getElementById('setSchoolName').value,
          student_club_name: document.getElementById('setClubName').value,
          school_year: document.getElementById('setSchoolYear').value,
          club_adviser: document.getElementById('setAdviser').value
        }
      });
      alert('Settings updated successfully!');
      state.settings = await api('/api/settings');
    };
  }

  async function restoreDatabase() {
    const fileInput = document.getElementById('restoreFile');
    if (!fileInput.files.length) return alert('Please select a JSON backup file.');
    
    if (confirm('WARNING: Restoring will overwrite all current database tables. Continue?')) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const payload = JSON.parse(e.target.result);
          await api('/api/admin/restore', { method: 'POST', body: payload });
          alert('Database restored successfully! The page will reload.');
          window.location.reload();
        } catch (err) {
          alert('Failed to restore: ' + err.message);
        }
      };
      reader.readAsText(fileInput.files[0]);
    }
  }

  // STUDENT PORTAL VIEW
  async function renderStudentPortal() {
    const data = await api('/api/student/me');
    const student = data.profile;

    const qrRes = await api('/api/qr/generate?text=' + encodeURIComponent(student.qr_token));

    document.getElementById('app').innerHTML = \`
      <div class="container py-4" style="max-width: 800px;">
        <div class="d-flex justify-content-between align-items-center mb-4">
          <div>
            <h3 class="fw-bold mb-0">Student Portal</h3>
            <p class="text-muted small">\${state.settings.student_club_name || 'Club'} Member Dashboard</p>
          </div>
          <button class="btn btn-outline-danger btn-sm" onclick="logout()">Logout</button>
        </div>

        <div class="row g-3">
          <div class="col-md-5">
            <div class="card p-4 text-center shadow-sm border-0">
              <h5 class="fw-bold">\${student.first_name} \${student.last_name}</h5>
              <p class="badge bg-primary mx-auto mb-2">\${student.position}</p>
              <p class="small text-muted mb-3">ID: \${student.student_id}</p>
              
              <img src="\${qrRes.dataUrl}" class="mx-auto my-2" style="width: 180px;">
              <p class="small text-muted">Show this Digital QR Code at event entry</p>
            </div>
          </div>

          <div class="col-md-7">
            <div class="card p-3 shadow-sm border-0 mb-3">
              <h6 class="fw-bold">My Participation Summary</h6>
              <div class="d-flex justify-content-around text-center my-2">
                <div><div class="h4 mb-0 text-success">\${data.stats.present}</div><div class="small text-muted">Present</div></div>
                <div><div class="h4 mb-0 text-warning">\${data.stats.late}</div><div class="small text-muted">Late</div></div>
                <div><div class="h4 mb-0 text-danger">\${data.stats.absent}</div><div class="small text-muted">Absent</div></div>
                <div><div class="h4 mb-0 text-primary">\${data.stats.participationRate}%</div><div class="small text-muted">Rate</div></div>
              </div>
            </div>

            <div class="card p-3 shadow-sm border-0">
              <h6 class="fw-bold">Attendance History</h6>
              <table class="table table-sm text-center">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date</th>
                    <th>Time In</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  \${data.attendance.map(a => \`
                    <tr>
                      <td class="text-start">\${a.event_title}</td>
                      <td>\${a.event_date}</td>
                      <td>\${a.time_in || '-'}</td>
                      <td><span class="badge bg-\${a.status==='Present'?'success':a.status==='Late'?'warning':'danger'}">\${a.status}</span></td>
                    </tr>
                  \`).join('') || '<tr><td colspan="4" class="text-muted">No attendance logs found</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    \`;
  }

  // CHANGE PASSWORD MODAL
  function showChangePasswordModal() {
    const modal = document.createElement('div');
    modal.className = 'modal fade show d-block';
    modal.style.background = 'rgba(0,0,0,0.5)';
    modal.innerHTML = \`
      <div class="modal-dialog">
        <div class="modal-content p-4">
          <h4 class="fw-bold mb-3">Change Password</h4>
          <div id="passAlert"></div>
          <form id="changePassForm">
            <div class="mb-2"><label class="form-label">Current Password</label><input type="password" id="currPass" class="form-control" required></div>
            <div class="mb-2"><label class="form-label">New Password (min 8 chars)</label><input type="password" id="newPass" class="form-control" required></div>
            <div class="mb-3"><label class="form-label">Confirm New Password</label><input type="password" id="confPass" class="form-control" required></div>
            <button class="btn btn-primary w-100">Update Password</button>
            <button type="button" class="btn btn-link w-100 text-muted mt-1" onclick="this.closest('.modal').remove()">Cancel</button>
          </form>
        </div>
      </div>
    \`;
    document.body.appendChild(modal);

    document.getElementById('changePassForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/auth/change-password', {
          method: 'POST',
          body: {
            currentPassword: document.getElementById('currPass').value,
            newPassword: document.getElementById('newPass').value,
            confirmPassword: document.getElementById('confPass').value
          }
        });
        alert('Password updated successfully!');
        modal.remove();
      } catch (err) {
        document.getElementById('passAlert').innerHTML = \`<div class="alert alert-danger p-2 small">\${err.message}</div>\`;
      }
    };
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    renderLogin();
  }

  // Start initialization
  init();
</script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>
  `);
});

// Start Server
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`School Club Attendance System Running`);
  console.log(`Server listening on port: ${PORT}`);
  console.log(`Local Database File: ${dbPath}`);
  console.log(`===================================================`);
});
