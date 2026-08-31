const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup directories
const uploadsDir = path.join(__dirname, 'uploads');
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// Setup Storage for Photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`);
  }
});
const upload = multer({ storage });

// Database Initialization
const db = new Database(path.join(__dirname, 'club_attendance.db'));
db.pragma('journal_mode = WAL');

// Initialize Database Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL, -- ADMIN, SCANNER, STUDENT
    student_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    position_id INTEGER NOT NULL,
    club TEXT NOT NULL,
    school_year TEXT NOT NULL,
    gender TEXT,
    date_of_birth TEXT,
    contact_number TEXT,
    school_email TEXT,
    address TEXT,
    photo_path TEXT,
    date_joined TEXT,
    membership_status TEXT DEFAULT 'Active', -- Active, Inactive, Suspended, Alumni, Resigned
    expiration_date TEXT,
    parent_name TEXT,
    parent_contact TEXT,
    qr_token TEXT UNIQUE NOT NULL,
    qr_status TEXT DEFAULT 'Active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(position_id) REFERENCES positions(id)
  );

  CREATE TABLE IF NOT EXISTS officer_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    position_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    status TEXT DEFAULT 'Active'
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    location TEXT,
    organizer TEXT,
    target_audience TEXT DEFAULT 'ALL', -- ALL, OFFICERS, POSITIONS, SPECIFIC
    target_positions TEXT, -- JSON array of position IDs if target_audience is POSITIONS
    status TEXT DEFAULT 'Upcoming', -- Upcoming, Active, Completed, Cancelled
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS event_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    time_in TEXT,
    time_out TEXT,
    status TEXT NOT NULL, -- PRESENT, LATE, ABSENT, EXCUSED
    recorded_by TEXT,
    date TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT NOT NULL,
    date TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed Initial Settings & Admin
function seedDefaults() {
  const settingsCount = db.prepare("SELECT COUNT(*) as count FROM settings").get().count;
  if (settingsCount === 0) {
    const insertSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    insertSetting.run('school_name', 'ABC National High School');
    insertSetting.run('school_logo', '');
    insertSetting.run('club_name', 'Computer Club');
    insertSetting.run('org_name', 'Student Organization');
    insertSetting.run('club_adviser', 'Mr. John Doe');
    insertSetting.run('school_address', '123 School Lane, City');
    insertSetting.run('contact_info', 'contact@school.edu');
    insertSetting.run('school_year', '2026-2027');
    insertSetting.run('club_description', 'Official Club for Computer Science and Technology Enthusiasts');
    insertSetting.run('late_threshold_mins', '15');
    insertSetting.run('min_participation_pct', '75');
    insertSetting.run('voice_enabled', 'true');
  }

  // Seed Default Positions
  const posCount = db.prepare("SELECT COUNT(*) as count FROM positions").get().count;
  if (posCount === 0) {
    const defaultPositions = [
      'President', 'Vice President', 'Secretary', 'Treasurer', 
      'Auditor', 'Public Information Officer', 'Representative', 'Member'
    ];
    const insertPos = db.prepare("INSERT INTO positions (name) VALUES (?)");
    defaultPositions.forEach(p => insertPos.run(p));
  }

  // Seed Default Users
  const adminExists = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('admin', hash, 'ADMIN');
  }

  const scannerExists = db.prepare("SELECT * FROM users WHERE username = 'scanner'").get();
  if (!scannerExists) {
    const hash = bcrypt.hashSync('scanner123', 10);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('scanner', hash, 'SCANNER');
  }
}
seedDefaults();

// Audit Logger Helper
function logAudit(user, action, details) {
  try {
    db.prepare("INSERT INTO audit_logs (user, action, details) VALUES (?, ?, ?)").run(user || 'System', action, details);
  } catch (e) {
    console.error("Audit log error:", e);
  }
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

app.use(session({
  secret: 'school-club-qr-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Auth Middlewares
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden. Access denied.' });
    }
    next();
  };
}

// ==========================================
// API ROUTES
// ==========================================

// AUTHENTICATION
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    student_id: user.student_id
  };

  logAudit(user.username, 'LOGIN', 'User logged into system');
  res.json({ success: true, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.user) {
    logAudit(req.session.user.username, 'LOGOUT', 'User logged out');
  }
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const username = req.session.user.username;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New password and confirmation do not match.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);

  logAudit(username, 'CHANGE_PASSWORD', 'User updated password');
  res.json({ success: true, message: 'Password changed successfully.' });
});

app.post('/api/admin/reset-password', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { targetUsername, newPassword } = req.body;
  if (!targetUsername || !newPassword) return res.status(400).json({ error: 'Fields required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const target = db.prepare("SELECT * FROM users WHERE username = ?").get(targetUsername);
  if (!target) return res.status(404).json({ error: 'Target user not found.' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, targetUsername);

  logAudit(req.session.user.username, 'RESET_PASSWORD', `Reset password for user: ${targetUsername}`);
  res.json({ success: true, message: `Password reset successfully for ${targetUsername}` });
});

// SETTINGS
app.get('/api/settings', (req, res) => {
  const rows = db.prepare("SELECT * FROM settings").all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.post('/api/settings', requireAuth, requireRole('ADMIN'), (req, res) => {
  const updateSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  Object.keys(req.body).forEach(key => {
    updateSetting.run(key, String(req.body[key]));
  });
  logAudit(req.session.user.username, 'UPDATE_SETTINGS', 'Updated system settings');
  res.json({ success: true, message: 'Settings saved successfully.' });
});

// POSITIONS
app.get('/api/positions', (req, res) => {
  const positions = db.prepare("SELECT * FROM positions ORDER BY name ASC").all();
  res.json(positions);
});

app.post('/api/positions', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Position name required.' });

  try {
    const info = db.prepare("INSERT INTO positions (name) VALUES (?)").run(name.trim());
    logAudit(req.session.user.username, 'CREATE_POSITION', `Created position: ${name.trim()}`);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: 'Position already exists.' });
  }
});

app.put('/api/positions/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name } = req.body;
  const { id } = req.params;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Position name required.' });

  try {
    db.prepare("UPDATE positions SET name = ? WHERE id = ?").run(name.trim(), id);
    logAudit(req.session.user.username, 'UPDATE_POSITION', `Renamed position ID ${id} to ${name.trim()}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Position name already exists or update failed.' });
  }
});

app.delete('/api/positions/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const assigned = db.prepare("SELECT COUNT(*) as count FROM students WHERE position_id = ?").get(id).count;
  if (assigned > 0) {
    return res.status(400).json({ error: `Cannot delete position. It is currently assigned to ${assigned} student(s).` });
  }

  db.prepare("DELETE FROM positions WHERE id = ?").run(id);
  logAudit(req.session.user.username, 'DELETE_POSITION', `Deleted position ID ${id}`);
  res.json({ success: true });
});

// STUDENTS
app.get('/api/students', requireAuth, (req, res) => {
  const { position, status, search } = req.query;
  let query = `
    SELECT s.*, p.name as position_name 
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    WHERE 1=1
  `;
  const params = [];

  if (position) {
    query += " AND s.position_id = ?";
    params.push(position);
  }
  if (status) {
    query += " AND s.membership_status = ?";
    params.push(status);
  }
  if (search) {
    query += " AND (s.student_id LIKE ? OR s.full_name LIKE ? OR s.school_email LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  query += " ORDER BY s.full_name ASC";
  const students = db.prepare(query).all(...params);
  res.json(students);
});

app.get('/api/students/:student_id', requireAuth, (req, res) => {
  const student = db.prepare(`
    SELECT s.*, p.name as position_name 
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    WHERE s.student_id = ?
  `).get(req.params.student_id);

  if (!student) return res.status(404).json({ error: 'Student not found.' });

  // Add Attendance Stats
  const totalEvents = db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'Completed' OR status = 'Active'").get().count;
  const attendanceRecords = db.prepare("SELECT * FROM attendance WHERE student_id = ?").all(student.student_id);
  
  const presentCount = attendanceRecords.filter(a => a.status === 'PRESENT').length;
  const lateCount = attendanceRecords.filter(a => a.status === 'LATE').length;
  const excusedCount = attendanceRecords.filter(a => a.status === 'EXCUSED').length;
  const attendedCount = presentCount + lateCount + excusedCount;
  const absentCount = Math.max(0, totalEvents - attendedCount);

  const pct = totalEvents > 0 ? Math.round((attendedCount / totalEvents) * 100) : 100;

  res.json({
    ...student,
    stats: {
      totalEvents,
      attendedCount,
      presentCount,
      lateCount,
      absentCount,
      excusedCount,
      participationPct: pct
    }
  });
});

app.post('/api/students', requireAuth, requireRole('ADMIN'), upload.single('photo'), (req, res) => {
  const {
    student_id, first_name, middle_name, last_name, position_id, club, school_year,
    gender, date_of_birth, contact_number, school_email, address, date_joined,
    membership_status, expiration_date, parent_name, parent_contact
  } = req.body;

  if (!student_id || !first_name || !last_name || !position_id || !club || !school_year) {
    return res.status(400).json({ error: 'Required fields missing.' });
  }

  // Check unique ID
  const existing = db.prepare("SELECT id FROM students WHERE student_id = ?").get(student_id);
  if (existing) {
    return res.status(400).json({ error: 'Student ID already exists.' });
  }

  const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`.trim();
  const photo_path = req.file ? `/uploads/${req.file.filename}` : '/uploads/default_avatar.png';
  const qr_token = crypto.randomBytes(16).toString('hex');

  const stmt = db.prepare(`
    INSERT INTO students (
      student_id, first_name, middle_name, last_name, full_name, position_id, club,
      school_year, gender, date_of_birth, contact_number, school_email, address, photo_path,
      date_joined, membership_status, expiration_date, parent_name, parent_contact, qr_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    student_id, first_name, middle_name || '', last_name, full_name, position_id, club,
    school_year, gender || '', date_of_birth || '', contact_number || '', school_email || '', address || '',
    photo_path, date_joined || new Date().toISOString().split('T')[0], membership_status || 'Active',
    expiration_date || '', parent_name || '', parent_contact || '', qr_token
  );

  // Auto-create Student Portal Login User
  const defaultPasswordHash = bcrypt.hashSync(student_id, 10);
  try {
    db.prepare("INSERT INTO users (username, password_hash, role, student_id) VALUES (?, ?, ?, ?)")
      .run(student_id, defaultPasswordHash, 'STUDENT', student_id);
  } catch(e) {}

  // Log Officer History
  const posObj = db.prepare("SELECT name FROM positions WHERE id = ?").get(position_id);
  db.prepare("INSERT INTO officer_history (student_id, position_name, start_date) VALUES (?, ?, ?)")
    .run(student_id, posObj ? posObj.name : 'Member', new Date().toISOString().split('T')[0]);

  logAudit(req.session.user.username, 'REGISTER_STUDENT', `Registered student: ${full_name} (${student_id})`);
  res.json({ success: true, message: 'Student registered successfully.' });
});

app.put('/api/students/:student_id', requireAuth, requireRole('ADMIN'), upload.single('photo'), (req, res) => {
  const { student_id } = req.params;
  const current = db.prepare("SELECT * FROM students WHERE student_id = ?").get(student_id);
  if (!current) return res.status(404).json({ error: 'Student not found.' });

  const {
    first_name, middle_name, last_name, position_id, club, school_year,
    gender, date_of_birth, contact_number, school_email, address, date_joined,
    membership_status, expiration_date, parent_name, parent_contact
  } = req.body;

  const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`.trim();
  const photo_path = req.file ? `/uploads/${req.file.filename}` : current.photo_path;

  // Track position change
  if (current.position_id != position_id) {
    const oldPos = db.prepare("SELECT name FROM positions WHERE id = ?").get(current.position_id);
    const newPos = db.prepare("SELECT name FROM positions WHERE id = ?").get(position_id);
    
    // Close previous record
    db.prepare("UPDATE officer_history SET end_date = ?, status = 'Former' WHERE student_id = ? AND status = 'Active'")
      .run(new Date().toISOString().split('T')[0], student_id);
    // Add new record
    db.prepare("INSERT INTO officer_history (student_id, position_name, start_date) VALUES (?, ?, ?)")
      .run(student_id, newPos ? newPos.name : 'Member', new Date().toISOString().split('T')[0]);
  }

  const stmt = db.prepare(`
    UPDATE students SET 
      first_name = ?, middle_name = ?, last_name = ?, full_name = ?, position_id = ?,
      club = ?, school_year = ?, gender = ?, date_of_birth = ?, contact_number = ?,
      school_email = ?, address = ?, photo_path = ?, date_joined = ?, membership_status = ?,
      expiration_date = ?, parent_name = ?, parent_contact = ?
    WHERE student_id = ?
  `);

  stmt.run(
    first_name, middle_name || '', last_name, full_name, position_id, club, school_year,
    gender || '', date_of_birth || '', contact_number || '', school_email || '', address || '',
    photo_path, date_joined, membership_status, expiration_date || '', parent_name || '',
    parent_contact || '', student_id
  );

  logAudit(req.session.user.username, 'UPDATE_STUDENT', `Updated student record for ${full_name}`);
  res.json({ success: true, message: 'Student updated successfully.' });
});

app.post('/api/students/:student_id/regenerate-qr', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { student_id } = req.params;
  const newToken = crypto.randomBytes(16).toString('hex');

  db.prepare("UPDATE students SET qr_token = ?, qr_status = 'Active' WHERE student_id = ?").run(newToken, student_id);
  logAudit(req.session.user.username, 'REGENERATE_QR', `Regenerated QR code for student ID: ${student_id}`);
  res.json({ success: true, qr_token: newToken });
});

app.post('/api/students/:student_id/toggle-qr', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { student_id } = req.params;
  const { status } = req.body; // Active or Disabled
  
  db.prepare("UPDATE students SET qr_status = ? WHERE student_id = ?").run(status, student_id);
  logAudit(req.session.user.username, 'TOGGLE_QR', `Set QR status to ${status} for student ID: ${student_id}`);
  res.json({ success: true });
});

// EVENTS
app.get('/api/events', requireAuth, (req, res) => {
  const events = db.prepare("SELECT * FROM events ORDER BY date DESC, start_time DESC").all();
  res.json(events);
});

app.post('/api/events', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name, description, type, date, start_time, end_time, location, organizer, target_audience, target_positions, status } = req.body;
  if (!name || !type || !date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Required fields missing.' });
  }

  const stmt = db.prepare(`
    INSERT INTO events (name, description, type, date, start_time, end_time, location, organizer, target_audience, target_positions, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    name, description || '', type, date, start_time, end_time, location || '', organizer || '',
    target_audience || 'ALL', JSON.stringify(target_positions || []), status || 'Upcoming'
  );

  logAudit(req.session.user.username, 'CREATE_EVENT', `Created event: ${name}`);
  res.json({ success: true, id: info.lastInsertRowid });
});

app.put('/api/events/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name, description, type, date, start_time, end_time, location, organizer, target_audience, target_positions, status } = req.body;
  const { id } = req.params;

  db.prepare(`
    UPDATE events SET name = ?, description = ?, type = ?, date = ?, start_time = ?, end_time = ?,
    location = ?, organizer = ?, target_audience = ?, target_positions = ?, status = ?
    WHERE id = ?
  `).run(
    name, description, type, date, start_time, end_time, location, organizer,
    target_audience, JSON.stringify(target_positions || []), status, id
  );

  logAudit(req.session.user.username, 'UPDATE_EVENT', `Updated event ID ${id}`);
  res.json({ success: true });
});

// ATTENDANCE & SCANNER API
app.post('/api/attendance/scan', requireAuth, requireRole('ADMIN', 'SCANNER'), (req, res) => {
  const { event_id, qr_token, scan_type } = req.body; // scan_type = 'IN' or 'OUT'

  if (!event_id || !qr_token || !scan_type) {
    return res.status(400).json({ error: 'Event ID, QR Token, and Scan Type required.' });
  }

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found.', code: 'INVALID_EVENT' });

  const student = db.prepare("SELECT s.*, p.name as position_name FROM students s JOIN positions p ON s.position_id = p.id WHERE s.qr_token = ?").get(qr_token);
  if (!student) {
    return res.status(400).json({ error: 'Invalid or unknown QR code.', code: 'INVALID_QR' });
  }

  if (student.qr_status !== 'Active') {
    return res.status(400).json({ error: 'This QR Code is disabled.', code: 'DISABLED_QR' });
  }

  if (student.membership_status !== 'Active') {
    return res.status(400).json({ error: `Student membership is ${student.membership_status}.`, code: 'INACTIVE_MEMBER' });
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const currentTimeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

  let existing = db.prepare("SELECT * FROM attendance WHERE event_id = ? AND student_id = ?").get(event_id, student.student_id);

  if (scan_type === 'IN') {
    if (existing && existing.time_in) {
      return res.status(400).json({ 
        error: 'Already recorded Time In for this event.', 
        code: 'DUPLICATE',
        student_name: student.full_name 
      });
    }

    // Determine status: Present vs Late
    const lateMinsSetting = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'late_threshold_mins'").get().value || '15', 10);
    const eventStartTime = event.start_time; // HH:MM format
    
    let status = 'PRESENT';
    if (eventStartTime) {
      const [eHours, eMins] = eventStartTime.split(':').map(Number);
      const now = new Date();
      const eventStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eHours, eMins);
      const thresholdTime = new Date(eventStart.getTime() + lateMinsSetting * 60000);

      if (now > thresholdTime) {
        status = 'LATE';
      }
    }

    if (existing) {
      db.prepare("UPDATE attendance SET time_in = ?, status = ?, recorded_by = ? WHERE id = ?")
        .run(currentTimeStr, status, req.session.user.username, existing.id);
    } else {
      db.prepare("INSERT INTO attendance (event_id, student_id, time_in, status, recorded_by, date) VALUES (?, ?, ?, ?, ?, ?)")
        .run(event_id, student.student_id, currentTimeStr, status, req.session.user.username, todayStr);
    }

    logAudit(req.session.user.username, 'SCAN_TIME_IN', `Recorded Time In for ${student.full_name} in event ${event.name}`);

    return res.json({
      success: true,
      action: 'TIME_IN',
      status,
      student: {
        student_id: student.student_id,
        full_name: student.full_name,
        position_name: student.position_name,
        club: student.club,
        photo_path: student.photo_path
      },
      time: currentTimeStr
    });
  } else if (scan_type === 'OUT') {
    if (!existing || !existing.time_in) {
      return res.status(400).json({ error: 'Cannot record Time Out. Student has no Time In record for this event.', code: 'NO_TIME_IN' });
    }
    if (existing.time_out) {
      return res.status(400).json({ error: 'Already recorded Time Out for this event.', code: 'DUPLICATE', student_name: student.full_name });
    }

    db.prepare("UPDATE attendance SET time_out = ? WHERE id = ?").run(currentTimeStr, existing.id);

    logAudit(req.session.user.username, 'SCAN_TIME_OUT', `Recorded Time Out for ${student.full_name} in event ${event.name}`);

    return res.json({
      success: true,
      action: 'TIME_OUT',
      status: existing.status,
      student: {
        student_id: student.student_id,
        full_name: student.full_name,
        position_name: student.position_name,
        club: student.club,
        photo_path: student.photo_path
      },
      time: currentTimeStr
    });
  }
});

app.get('/api/attendance/records', requireAuth, (req, res) => {
  const { event_id, date, status, position_id } = req.query;
  let query = `
    SELECT a.*, s.full_name, s.photo_path, p.name as position_name, e.name as event_name
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN positions p ON s.position_id = p.id
    JOIN events e ON a.event_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (event_id) { query += " AND a.event_id = ?"; params.push(event_id); }
  if (date) { query += " AND a.date = ?"; params.push(date); }
  if (status) { query += " AND a.status = ?"; params.push(status); }
  if (position_id) { query += " AND s.position_id = ?"; params.push(position_id); }

  query += " ORDER BY a.id DESC LIMIT 200";
  const records = db.prepare(query).all(...params);
  res.json(records);
});

app.post('/api/attendance/excuse', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { event_id, student_id, reason, notes } = req.body;
  if (!event_id || !student_id || !reason) return res.status(400).json({ error: 'Fields required.' });

  const todayStr = new Date().toISOString().split('T')[0];
  let existing = db.prepare("SELECT * FROM attendance WHERE event_id = ? AND student_id = ?").get(event_id, student_id);

  if (existing) {
    db.prepare("UPDATE attendance SET status = 'EXCUSED' WHERE id = ?").run(existing.id);
  } else {
    db.prepare("INSERT INTO attendance (event_id, student_id, status, recorded_by, date) VALUES (?, ?, 'EXCUSED', ?, ?)")
      .run(event_id, student_id, req.session.user.username, todayStr);
  }

  db.prepare("INSERT INTO excuses (event_id, student_id, reason, notes, approved_by) VALUES (?, ?, ?, ?, ?)")
    .run(event_id, student_id, reason, notes || '', req.session.user.username);

  logAudit(req.session.user.username, 'MARK_EXCUSED', `Marked ${student_id} excused for event ID ${event_id}`);
  res.json({ success: true });
});

// REPORTS & ANALYTICS
app.get('/api/analytics/dashboard', requireAuth, (req, res) => {
  const totalMembers = db.prepare("SELECT COUNT(*) as count FROM students").get().count;
  const activeMembers = db.prepare("SELECT COUNT(*) as count FROM students WHERE membership_status = 'Active'").get().count;
  const totalOfficers = db.prepare(`
    SELECT COUNT(*) as count FROM students s 
    JOIN positions p ON s.position_id = p.id 
    WHERE LOWER(p.name) != 'member'
  `).get().count;

  const todayStr = new Date().toISOString().split('T')[0];
  const presentToday = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE date = ? AND status = 'PRESENT'").get(todayStr).count;
  const lateToday = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE date = ? AND status = 'LATE'").get(todayStr).count;
  const excusedToday = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE date = ? AND status = 'EXCUSED'").get(todayStr).count;

  const activeEvent = db.prepare("SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1").get() || null;
  const upcomingEvents = db.prepare("SELECT * FROM events WHERE status = 'Upcoming' ORDER BY date ASC LIMIT 5").all();

  // Position breakdown
  const positionStats = db.prepare(`
    SELECT p.name, COUNT(s.id) as count 
    FROM positions p 
    LEFT JOIN students s ON s.position_id = p.id 
    GROUP BY p.id
  `).all();

  res.json({
    totalMembers,
    activeMembers,
    totalOfficers,
    presentToday,
    lateToday,
    excusedToday,
    activeEvent,
    upcomingEvents,
    positionStats
  });
});

app.get('/api/reports/participation', requireAuth, (req, res) => {
  const minPct = parseInt(req.query.min_pct || '75', 10);
  const totalEvents = db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'Completed'").get().count;
  const students = db.prepare("SELECT s.student_id, s.full_name, p.name as position_name FROM students s JOIN positions p ON s.position_id = p.id").all();

  const report = students.map(st => {
    const records = db.prepare("SELECT status FROM attendance WHERE student_id = ?").all(st.student_id);
    const attended = records.filter(r => r.status === 'PRESENT' || r.status === 'LATE' || r.status === 'EXCUSED').length;
    const lates = records.filter(r => r.status === 'LATE').length;
    const pct = totalEvents > 0 ? Math.round((attended / totalEvents) * 100) : 100;
    
    return {
      student_id: st.student_id,
      full_name: st.full_name,
      position_name: st.position_name,
      totalEvents,
      attended,
      lates,
      pct,
      isLow: pct < minPct
    };
  });

  res.json(report);
});

// AUDIT LOGS & BACKUP
app.get('/api/admin/audit-logs', requireAuth, requireRole('ADMIN'), (req, res) => {
  const logs = db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200").all();
  res.json(logs);
});

app.get('/api/admin/backup', requireAuth, requireRole('ADMIN'), (req, res) => {
  const backupFileName = `backup-${Date.now()}.db`;
  const backupPath = path.join(backupsDir, backupFileName);

  db.backup(backupPath).then(() => {
    logAudit(req.session.user.username, 'CREATE_BACKUP', `Created database backup: ${backupFileName}`);
    res.download(backupPath);
  }).catch(err => {
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  });
});

// ==========================================
// FRONTEND MONOLITH HTML RESPONSES
// ==========================================

const CLIENT_APP_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Student Club QR Code Attendance System</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css" rel="stylesheet">
  <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
  <style>
    :root {
      --primary-color: #1e3a8a;
      --secondary-color: #0d9488;
      --bg-light: #f8fafc;
    }
    body { background-color: var(--bg-light); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .sidebar { min-height: 100vh; background-color: #0f172a; color: #fff; }
    .sidebar .nav-link { color: #94a3b8; margin-bottom: 4px; border-radius: 6px; }
    .sidebar .nav-link:hover, .sidebar .nav-link.active { background-color: #1e293b; color: #fff; }
    .card-stat { border: none; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    
    /* Printable ID Card CSS */
    .id-card-grid {
      display: grid;
      grid-template-columns: repeat(2, 3.375in);
      grid-template-rows: repeat(4, 2.125in);
      gap: 0.1in 0.2in;
      justify-content: center;
      padding: 0.2in;
    }
    .club-id-card {
      width: 3.375in;
      height: 2.125in;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 8px;
      background: #fff;
      box-sizing: border-box;
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      page-break-inside: avoid;
    }
    .id-header { display: flex; align-items: center; border-bottom: 2px solid var(--primary-color); padding-bottom: 4px; }
    .id-header img { width: 32px; height: 32px; object-fit: contain; }
    .id-header-text { font-size: 8pt; font-weight: bold; line-height: 1; margin-left: 6px; }
    .id-body { display: flex; align-items: center; margin-top: 4px; gap: 8px; }
    .id-photo { width: 0.85in; height: 1.0in; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; }
    .id-details { font-size: 7.5pt; line-height: 1.2; flex-grow: 1; }
    .id-qr { width: 0.85in; height: 0.85in; }
    .id-footer { font-size: 6.5pt; text-align: center; background: var(--primary-color); color: #fff; border-radius: 3px; padding: 2px 0; }

    @media print {
      body * { visibility: hidden; }
      #printable-area, #printable-area * { visibility: visible; }
      #printable-area { position: absolute; left: 0; top: 0; width: 100%; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>

<div id="app">
  <!-- Dynamic Routing Rendered by JS -->
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
<script>
  let currentUser = null;
  let systemSettings = {};

  async function initApp() {
    const authRes = await fetch('/api/auth/me');
    const authData = await authRes.json();
    
    const setRes = await fetch('/api/settings');
    systemSettings = await setRes.json();

    if (!authData.loggedIn) {
      renderLogin();
    } else {
      currentUser = authData.user;
      if (window.location.pathname === '/scanner') {
        renderScannerPortal();
      } else if (currentUser.role === 'STUDENT') {
        renderStudentPortal();
      } else {
        renderAdminDashboard();
      }
    }
  }

  function renderLogin() {
    document.getElementById('app').innerHTML = \`
      <div class="container d-flex justify-content-center align-items-center vh-100">
        <div class="card p-4 shadow-lg" style="width: 400px; border-radius: 12px;">
          <div class="text-center mb-3">
            <i class="bi bi-qr-code-scan display-4 text-primary"></i>
            <h4 class="mt-2 text-primary fw-bold">\${systemSettings.club_name || 'School Club'}</h4>
            <p class="text-muted small">\${systemSettings.school_name || 'Attendance Portal'}</p>
          </div>
          <div id="login-error" class="alert alert-danger d-none"></div>
          <form id="login-form">
            <div class="mb-3">
              <label class="form-label fw-semibold">Username / Student ID</label>
              <input type="text" id="login-username" class="form-control" required placeholder="Enter username">
            </div>
            <div class="mb-3">
              <label class="form-label fw-semibold">Password</label>
              <input type="password" id="login-password" class="form-control" required placeholder="Enter password">
            </div>
            <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Login to Portal</button>
          </form>
          <div class="text-center mt-3">
            <a href="/scanner" onclick="event.preventDefault(); renderScannerPortal();" class="text-decoration-none text-secondary small"><i class="bi bi-camera"></i> Open Mobile QR Scanner Portal</a>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errDiv = document.getElementById('login-error');
      errDiv.classList.add('d-none');

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('login-username').value,
          password: document.getElementById('login-password').value
        })
      });
      const data = await res.json();
      if (!res.ok) {
        errDiv.textContent = data.error;
        errDiv.classList.remove('d-none');
      } else {
        initApp();
      }
    });
  }

  function renderAdminDashboard() {
    document.getElementById('app').innerHTML = \`
      <div class="d-flex">
        <div class="sidebar p-3 d-flex flex-column" style="width: 260px;">
          <h5 class="text-white fw-bold border-bottom pb-2 mb-3"><i class="bi bi-shield-check me-2"></i>Club Admin</h5>
          <ul class="nav flex-column mb-auto">
            <li class="nav-item"><a href="#" class="nav-link active" onclick="loadAdminTab('dashboard')"><i class="bi bi-speedometer2 me-2"></i>Dashboard</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('students')"><i class="bi bi-people me-2"></i>Student Members</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('positions')"><i class="bi bi-award me-2"></i>Position Manager</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('events')"><i class="bi bi-calendar-event me-2"></i>Club Events</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('attendance')"><i class="bi bi-journal-check me-2"></i>Attendance Log</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('printing')"><i class="bi bi-printer me-2"></i>Print A4 Club IDs</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('reports')"><i class="bi bi-bar-chart me-2"></i>Reports & Analytics</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('settings')"><i class="bi bi-gear me-2"></i>System Settings</a></li>
            <li class="nav-item"><a href="#" class="nav-link" onclick="loadAdminTab('account')"><i class="bi bi-lock me-2"></i>Change Password</a></li>
          </ul>
          <hr>
          <div class="dropdown">
            <a href="#" class="d-flex align-items-center text-white text-decoration-none dropdown-toggle" data-bs-toggle="dropdown">
              <i class="bi bi-person-circle fs-5 me-2"></i><strong>\${currentUser.username}</strong>
            </a>
            <ul class="dropdown-menu dropdown-menu-dark text-small shadow">
              <li><a class="dropdown-item" href="/scanner" onclick="event.preventDefault(); renderScannerPortal();">Open Scanner</a></li>
              <li><hr class="dropdown-divider"></li>
              <li><a class="dropdown-item" href="#" onclick="logout()">Sign out</a></li>
            </ul>
          </div>
        </div>
        <div class="flex-grow-1 p-4" id="admin-main-content">
          <!-- Main Content Injected Here -->
        </div>
      </div>
    \`;
    loadAdminTab('dashboard');
  }

  async function loadAdminTab(tab) {
    const main = document.getElementById('admin-main-content');
    if (tab === 'dashboard') {
      const res = await fetch('/api/analytics/dashboard');
      const data = await res.json();
      main.innerHTML = \`
        <h3 class="fw-bold mb-4">School Club Dashboard</h3>
        <div class="row g-3 mb-4">
          <div class="col-md-3">
            <div class="card card-stat bg-primary text-white p-3">
              <h6>Total Members</h6>
              <h2 class="fw-bold m-0">\${data.totalMembers}</h2>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-stat bg-success text-white p-3">
              <h6>Active Members</h6>
              <h2 class="fw-bold m-0">\${data.activeMembers}</h2>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-stat bg-warning text-dark p-3">
              <h6>Club Officers</h6>
              <h2 class="fw-bold m-0">\${data.totalOfficers}</h2>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-stat bg-info text-white p-3">
              <h6>Present Today</h6>
              <h2 class="fw-bold m-0">\${data.presentToday}</h2>
            </div>
          </div>
        </div>

        <div class="row g-4">
          <div class="col-md-6">
            <div class="card p-3 shadow-sm">
              <h5 class="fw-bold">Active Event</h5>
              \${data.activeEvent ? \`
                <div class="alert alert-success">
                  <h6 class="fw-bold m-0">\${data.activeEvent.name}</h6>
                  <small>Date: \${data.activeEvent.date} | Time: \${data.activeEvent.start_time} - \${data.activeEvent.end_time}</small>
                </div>
              \` : '<p class="text-muted">No active event ongoing right now.</p>'}
            </div>
          </div>
          <div class="col-md-6">
            <div class="card p-3 shadow-sm">
              <h5 class="fw-bold">Upcoming Club Events</h5>
              <ul class="list-group list-group-flush">
                \${data.upcomingEvents.map(e => \`
                  <li class="list-group-item d-flex justify-content-between align-items-center">
                    <div>
                      <strong>\${e.name}</strong><br>
                      <small class="text-muted">\${e.date} @ \${e.location || 'School Campus'}</small>
                    </div>
                    <span class="badge bg-primary">\${e.status}</span>
                  </li>
                \`).join('') || '<p class="text-muted">No upcoming events.</p>'}
              </ul>
            </div>
          </div>
        </div>
      \`;
    } else if (tab === 'positions') {
      renderPositionsTab();
    } else if (tab === 'students') {
      renderStudentsTab();
    } else if (tab === 'account') {
      renderChangePasswordTab();
    } else if (tab === 'printing') {
      renderPrintingTab();
    }
  }

  async function renderPositionsTab() {
    const res = await fetch('/api/positions');
    const positions = await res.json();
    const main = document.getElementById('admin-main-content');
    main.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Customizable Position Manager</h3>
        <button class="btn btn-primary" onclick="showAddPositionModal()"><i class="bi bi-plus-circle me-1"></i>Add New Position</button>
      </div>
      <div class="card p-3 shadow-sm">
        <table class="table table-hover">
          <thead><tr><th>ID</th><th>Position Name</th><th>Actions</th></tr></thead>
          <tbody>
            \${positions.map(p => \`
              <tr>
                <td>\${p.id}</td>
                <td><strong>\${p.name}</strong></td>
                <td>
                  <button class="btn btn-sm btn-outline-secondary me-1" onclick="renamePosition(\${p.id}, '\${p.name}')">Rename</button>
                  <button class="btn btn-sm btn-outline-danger" onclick="deletePosition(\${p.id})">Delete</button>
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  async function renderStudentsTab() {
    const res = await fetch('/api/students');
    const students = await res.json();
    const posRes = await fetch('/api/positions');
    const positions = await posRes.json();

    const main = document.getElementById('admin-main-content');
    main.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Student Members Management</h3>
        <button class="btn btn-primary" onclick="showStudentModal()"><i class="bi bi-person-plus me-1"></i>Register New Student</button>
      </div>
      <div class="card p-3 shadow-sm mb-3">
        <div class="row g-2">
          <div class="col-md-4">
            <input type="text" id="search-student" class="form-control" placeholder="Search by ID or Name..." onkeyup="filterStudents()">
          </div>
          <div class="col-md-4">
            <select id="filter-position" class="form-select" onchange="filterStudents()">
              <option value="">All Positions</option>
              \${positions.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="card p-3 shadow-sm">
        <table class="table table-hover align-middle">
          <thead>
            <tr><th>Photo</th><th>Student ID</th><th>Full Name</th><th>Position</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody id="students-table-body">
            \${students.map(s => \`
              <tr>
                <td><img src="\${s.photo_path}" style="width:40px;height:40px;object-fit:cover;border-radius:50%;"></td>
                <td><strong>\${s.student_id}</strong></td>
                <td>\${s.full_name}</td>
                <td><span class="badge bg-secondary">\${s.position_name}</span></td>
                <td><span class="badge bg-\${s.membership_status === 'Active' ? 'success' : 'danger'}">\${s.membership_status}</span></td>
                <td>
                  <button class="btn btn-sm btn-info text-white" onclick="viewStudentQR('\${s.student_id}', '\${s.full_name}', '\${s.qr_token}')"><i class="bi bi-qr-code"></i> QR Token</button>
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  async function renderPrintingTab() {
    const res = await fetch('/api/students');
    const students = await res.json();
    const main = document.getElementById('admin-main-content');

    main.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h3 class="fw-bold m-0">A4 Bond Paper ID Layout Printing</h3>
          <p class="text-muted small m-0">Automatically places 8 Student Club IDs per A4 Page for mass printing.</p>
        </div>
        <button class="btn btn-success" onclick="window.print()"><i class="bi bi-printer me-1"></i>Print ID Pages</button>
      </div>
      <div id="printable-area">
        <div class="id-card-grid">
          \${students.slice(0, 8).map(s => \`
            <div class="club-id-card">
              <div class="id-header">
                <i class="bi bi-mortarboard-fill text-primary fs-5"></i>
                <div class="id-header-text">
                  \${systemSettings.school_name || 'ABC High School'}<br>
                  <span class="text-primary">\${systemSettings.club_name || 'Computer Club'}</span>
                </div>
              </div>
              <div class="id-body">
                <img src="\${s.photo_path}" class="id-photo">
                <div class="id-details">
                  <strong style="font-size: 8.5pt;">\${s.full_name}</strong><br>
                  <span class="text-muted">ID:</span> \${s.student_id}<br>
                  <span class="text-muted">Position:</span> <strong>\${s.position_name}</strong><br>
                  <span class="text-muted">S.Y.:</span> \${s.school_year}
                </div>
                <div id="qr-id-\${s.student_id}" class="id-qr"></div>
              </div>
              <div class="id-footer">
                OFFICIAL MEMBER DIGITAL ID CARD
              </div>
            </div>
          \`).join('')}
        </div>
      </div>
    \`;

    // Render QRs dynamically
    students.slice(0, 8).forEach(s => {
      const el = document.getElementById(\`qr-id-\${s.student_id}\`);
      if (el) {
        el.innerHTML = \`<img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=\${s.qr_token}" style="width:100%;height:100%;">\`;
      }
    });
  }

  function renderChangePasswordTab() {
    const main = document.getElementById('admin-main-content');
    main.innerHTML = \`
      <h3 class="fw-bold mb-4">Account Password Settings</h3>
      <div class="card p-4 shadow-sm" style="max-width: 500px;">
        <div id="pwd-msg" class="alert d-none"></div>
        <form id="change-pwd-form">
          <div class="mb-3">
            <label class="form-label">Current Password</label>
            <input type="password" id="cp-current" class="form-control" required>
          </div>
          <div class="mb-3">
            <label class="form-label">New Password</label>
            <input type="password" id="cp-new" class="form-control" required minlength="6">
          </div>
          <div class="mb-3">
            <label class="form-label">Confirm New Password</label>
            <input type="password" id="cp-confirm" class="form-control" required minlength="6">
          </div>
          <button type="submit" class="btn btn-primary fw-bold">Update Password</button>
        </form>
      </div>
    \`;

    document.getElementById('change-pwd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('pwd-msg');
      msg.classList.add('d-none');

      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: document.getElementById('cp-current').value,
          newPassword: document.getElementById('cp-new').value,
          confirmPassword: document.getElementById('cp-confirm').value
        })
      });
      const data = await res.json();
      msg.classList.remove('d-none', 'alert-success', 'alert-danger');
      if (res.ok) {
        msg.classList.add('alert-success');
        msg.textContent = data.message;
        document.getElementById('change-pwd-form').reset();
      } else {
        msg.classList.add('alert-danger');
        msg.textContent = data.error;
      }
    });
  }

  function renderScannerPortal() {
    document.getElementById('app').innerHTML = \`
      <div class="container py-3" style="max-width: 600px;">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h4 class="fw-bold text-primary m-0"><i class="bi bi-qr-code-scan me-2"></i>Mobile QR Scanner</h4>
          <button class="btn btn-sm btn-outline-secondary" onclick="initApp()">Exit Portal</button>
        </div>

        <div class="card p-3 shadow-sm mb-3">
          <label class="form-label fw-bold">Select Active Club Event</label>
          <select id="scanner-event-select" class="form-select mb-3">
            <option value="">Loading events...</option>
          </select>

          <div class="d-flex gap-2 mb-3">
            <button id="btn-mode-in" class="btn btn-primary flex-fill fw-bold" onclick="setScanMode('IN')">TIME IN</button>
            <button id="btn-mode-out" class="btn btn-outline-secondary flex-fill fw-bold" onclick="setScanMode('OUT')">TIME OUT</button>
          </div>

          <div id="reader" style="width: 100%; border-radius: 8px; overflow: hidden;"></div>
        </div>

        <div id="scan-result-card" class="card p-3 shadow-sm text-center d-none">
          <!-- Live Scan Results Injected Here -->
        </div>
      </div>
    \`;

    loadScannerEvents();
    startCameraScanner();
  }

  let currentScanMode = 'IN';
  let html5QrCode = null;

  function setScanMode(mode) {
    currentScanMode = mode;
    document.getElementById('btn-mode-in').className = mode === 'IN' ? 'btn btn-primary flex-fill fw-bold' : 'btn btn-outline-primary flex-fill fw-bold';
    document.getElementById('btn-mode-out').className = mode === 'OUT' ? 'btn btn-secondary flex-fill fw-bold' : 'btn btn-outline-secondary flex-fill fw-bold';
  }

  async function loadScannerEvents() {
    const res = await fetch('/api/events');
    const events = await res.json();
    const select = document.getElementById('scanner-event-select');
    select.innerHTML = events.map(e => \`<option value="\${e.id}">\${e.name} (\${e.date})</option>\`).join('') || '<option value="">No Active Events</option>';
  }

  function startCameraScanner() {
    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess
    ).catch(err => {
      console.error("Camera access denied or missing.", err);
    });
  }

  function speakVoice(text) {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      speechSynthesis.speak(utterance);
    }
  }

  async function onScanSuccess(decodedText) {
    const eventId = document.getElementById('scanner-event-select').value;
    if (!eventId) {
      alert("Please select an active event first.");
      return;
    }

    const res = await fetch('/api/attendance/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: eventId,
        qr_token: decodedText,
        scan_type: currentScanMode
      })
    });

    const data = await res.json();
    const resultCard = document.getElementById('scan-result-card');
    resultCard.classList.remove('d-none', 'border-success', 'border-danger');

    if (res.ok) {
      resultCard.classList.add('border-success');
      resultCard.innerHTML = \`
        <div class="text-success mb-2"><i class="bi bi-check-circle-fill display-4"></i></div>
        <h5 class="fw-bold m-0">\${data.student.full_name}</h5>
        <p class="text-muted small mb-1">\${data.student.position_name} | \${data.student.student_id}</p>
        <span class="badge bg-success">\${data.action} RECORDED AT \${data.time}</span>
      \`;
      speakVoice(\`\${data.student.full_name}, attendance recorded.\`);
    } else {
      resultCard.classList.add('border-danger');
      resultCard.innerHTML = \`
        <div class="text-danger mb-2"><i class="bi bi-x-circle-fill display-4"></i></div>
        <h5 class="fw-bold text-danger m-0">\${data.error}</h5>
      \`;
      speakVoice(data.student_name ? \`\${data.student_name}, already recorded.\` : "Invalid QR Code.");
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    initApp();
  }

  window.onload = initApp;
</script>
</body>
</html>
`;

// Catch-All HTML Delivery
app.get('*', (req, res) => {
  res.send(CLIENT_APP_HTML);
});

// Start Node.js Application Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` SCHOOL CLUB QR ATTENDANCE SYSTEM RUNNING ON PORT: ${PORT}`);
  console.log(` Local URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
