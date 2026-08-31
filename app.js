/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Monolithic Express + Better-SQLite3 Application
 */

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

// Directory Initialization
const uploadsDir = path.join(__dirname, 'uploads');
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// Default photo generation fallback
const defaultAvatarPath = path.join(uploadsDir, 'default_avatar.png');
if (!fs.existsSync(defaultAvatarPath)) {
  const dummyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  fs.writeFileSync(defaultAvatarPath, Buffer.from(dummyPngBase64, 'base64'));
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image uploads are allowed'));
    }
  }
});

// Database Initialization
const db = new Database(path.join(__dirname, 'club_attendance.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema Creation
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL, -- 'ADMIN', 'SCANNER', 'STUDENT'
    student_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    hierarchy_order INTEGER DEFAULT 99
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
    membership_status TEXT DEFAULT 'Active', -- 'Active', 'Inactive', 'Suspended', 'Alumni'
    expiration_date TEXT,
    parent_name TEXT,
    parent_contact TEXT,
    qr_token TEXT UNIQUE NOT NULL,
    qr_status TEXT DEFAULT 'Active', -- 'Active', 'Disabled'
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
    type TEXT NOT NULL, -- 'Regular Meeting', 'Workshop', 'Assembly', 'Special Event'
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    location TEXT,
    organizer TEXT,
    target_audience TEXT DEFAULT 'ALL', -- 'ALL', 'OFFICERS', 'POSITIONS'
    target_positions TEXT, -- JSON Array of position IDs
    status TEXT DEFAULT 'Upcoming', -- 'Upcoming', 'Active', 'Completed', 'Cancelled'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    time_in TEXT,
    time_out TEXT,
    status TEXT NOT NULL, -- 'PRESENT', 'LATE', 'ABSENT', 'EXCUSED'
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

// Database Seeding Logic
function seedDatabaseDefaults() {
  const settingsCount = db.prepare("SELECT COUNT(*) as count FROM settings").get().count;
  if (settingsCount === 0) {
    const insertSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    insertSetting.run('school_name', 'ABC National High School');
    insertSetting.run('school_logo', '');
    insertSetting.run('club_name', 'Computer Club');
    insertSetting.run('org_name', 'Student Technology Association');
    insertSetting.run('club_adviser', 'Mr. Alex Mercer');
    insertSetting.run('school_address', '123 Academic Way, Innovation Campus');
    insertSetting.run('contact_info', 'computerclub@school.edu');
    insertSetting.run('school_year', '2026-2027');
    insertSetting.run('club_description', 'Official Student Club for Programming, Cybersecurity, and Hardware Innovation.');
    insertSetting.run('late_threshold_mins', '15');
    insertSetting.run('min_participation_pct', '75');
    insertSetting.run('voice_enabled', 'true');
  }

  const posCount = db.prepare("SELECT COUNT(*) as count FROM positions").get().count;
  if (posCount === 0) {
    const defaultPositions = [
      { name: 'President', order: 1 },
      { name: 'Vice President', order: 2 },
      { name: 'Secretary', order: 3 },
      { name: 'Treasurer', order: 4 },
      { name: 'Auditor', order: 5 },
      { name: 'Public Information Officer', order: 6 },
      { name: 'Technical Lead', order: 7 },
      { name: 'Representative', order: 8 },
      { name: 'Member', order: 99 }
    ];
    const insertPos = db.prepare("INSERT INTO positions (name, hierarchy_order) VALUES (?, ?)");
    defaultPositions.forEach(p => insertPos.run(p.name, p.order));
  }

  const adminUser = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  if (!adminUser) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('admin', hash, 'ADMIN');
  }

  const scannerUser = db.prepare("SELECT * FROM users WHERE username = 'scanner'").get();
  if (!scannerUser) {
    const hash = bcrypt.hashSync('scanner123', 10);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('scanner', hash, 'SCANNER');
  }
}
seedDatabaseDefaults();

// Audit Logging Function
function logAudit(user, action, details) {
  try {
    db.prepare("INSERT INTO audit_logs (user, action, details) VALUES (?, ?, ?)").run(user || 'System', action, details);
  } catch (err) {
    console.error("Audit log recording failed:", err);
  }
}

// Middleware Configuration
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(uploadsDir));

app.use(session({
  secret: 'school-club-qr-attendance-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Route Guard Middlewares
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized. Session expired or missing.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden. Access restricted to specific roles.' });
    }
    next();
  };
}

// ============================================================================
// API ENDPOINTS - AUTHENTICATION & PROFILE
// ============================================================================

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

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

  logAudit(user.username, 'LOGIN', `User logged in from IP ${req.ip}`);
  res.json({ success: true, role: user.role, username: user.username });
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
    return res.status(400).json({ error: 'All password fields are required.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New password and confirmation do not match.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password provided is incorrect.' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);

  logAudit(username, 'CHANGE_PASSWORD', 'User updated password successfully');
  res.json({ success: true, message: 'Password changed successfully.' });
});

app.post('/api/admin/reset-password', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { targetUsername, newPassword } = req.body;
  if (!targetUsername || !newPassword) return res.status(400).json({ error: 'Target user and new password required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const target = db.prepare("SELECT * FROM users WHERE username = ?").get(targetUsername);
  if (!target) return res.status(404).json({ error: 'Target account not found.' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, targetUsername);

  logAudit(req.session.user.username, 'RESET_PASSWORD', `Reset password for user: ${targetUsername}`);
  res.json({ success: true, message: `Password reset successfully for ${targetUsername}` });
});

// ============================================================================
// API ENDPOINTS - SETTINGS
// ============================================================================

app.get('/api/settings', (req, res) => {
  const rows = db.prepare("SELECT * FROM settings").all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

app.post('/api/settings', requireAuth, requireRole('ADMIN'), (req, res) => {
  const updateSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  
  const transaction = db.transaction((data) => {
    Object.keys(data).forEach(key => {
      updateSetting.run(key, String(data[key]));
    });
  });

  try {
    transaction(req.body);
    logAudit(req.session.user.username, 'UPDATE_SETTINGS', 'Updated system settings configuration');
    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
});

// ============================================================================
// API ENDPOINTS - POSITIONS
// ============================================================================

app.get('/api/positions', (req, res) => {
  const positions = db.prepare("SELECT * FROM positions ORDER BY hierarchy_order ASC, name ASC").all();
  res.json(positions);
});

app.post('/api/positions', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name, hierarchy_order } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Position name is required.' });

  try {
    const order = hierarchy_order ? parseInt(hierarchy_order, 10) : 99;
    const info = db.prepare("INSERT INTO positions (name, hierarchy_order) VALUES (?, ?)").run(name.trim(), order);
    logAudit(req.session.user.username, 'CREATE_POSITION', `Created position: ${name.trim()}`);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: 'Position name already exists or invalid data.' });
  }
});

app.put('/api/positions/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name, hierarchy_order } = req.body;
  const { id } = req.params;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Position name required.' });

  try {
    const order = hierarchy_order ? parseInt(hierarchy_order, 10) : 99;
    db.prepare("UPDATE positions SET name = ?, hierarchy_order = ? WHERE id = ?").run(name.trim(), order, id);
    logAudit(req.session.user.username, 'UPDATE_POSITION', `Updated position ID ${id} to ${name.trim()}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Position update failed or name conflict.' });
  }
});

app.delete('/api/positions/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  const assigned = db.prepare("SELECT COUNT(*) as count FROM students WHERE position_id = ?").get(id).count;
  if (assigned > 0) {
    return res.status(400).json({ error: `Cannot delete position. It is currently assigned to ${assigned} member(s).` });
  }

  db.prepare("DELETE FROM positions WHERE id = ?").run(id);
  logAudit(req.session.user.username, 'DELETE_POSITION', `Deleted position ID ${id}`);
  res.json({ success: true });
});
// ============================================================================
// API ENDPOINTS - STUDENTS & MEMBERSHIP MANAGEMENT
// ============================================================================

app.get('/api/students', requireAuth, (req, res) => {
  const { position, status, search } = req.query;
  let query = `
    SELECT s.*, p.name as position_name, p.hierarchy_order 
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

  query += " ORDER BY p.hierarchy_order ASC, s.full_name ASC";
  const students = db.prepare(query).all(...params);
  res.json(students);
});

app.get('/api/students/:student_id', requireAuth, (req, res) => {
  const student = db.prepare(`
    SELECT s.*, p.name as position_name, p.hierarchy_order
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    WHERE s.student_id = ?
  `).get(req.params.student_id);

  if (!student) return res.status(404).json({ error: 'Student record not found.' });

  const totalEvents = db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'Completed' OR status = 'Active'").get().count;
  const attendanceRecords = db.prepare(`
    SELECT a.*, e.name as event_name, e.date as event_date, e.type as event_type 
    FROM attendance a 
    JOIN events e ON a.event_id = e.id 
    WHERE a.student_id = ? 
    ORDER BY e.date DESC
  `).all(student.student_id);

  const officerHistory = db.prepare("SELECT * FROM officer_history WHERE student_id = ? ORDER BY id DESC").all(student.student_id);

  const presentCount = attendanceRecords.filter(a => a.status === 'PRESENT').length;
  const lateCount = attendanceRecords.filter(a => a.status === 'LATE').length;
  const excusedCount = attendanceRecords.filter(a => a.status === 'EXCUSED').length;
  const attendedCount = presentCount + lateCount + excusedCount;
  const absentCount = Math.max(0, totalEvents - attendedCount);

  const participationPct = totalEvents > 0 ? Math.round((attendedCount / totalEvents) * 100) : 100;

  res.json({
    ...student,
    attendanceRecords,
    officerHistory,
    stats: {
      totalEvents,
      attendedCount,
      presentCount,
      lateCount,
      absentCount,
      excusedCount,
      participationPct
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
    return res.status(400).json({ error: 'Required student fields are missing.' });
  }

  const existing = db.prepare("SELECT id FROM students WHERE student_id = ?").get(student_id);
  if (existing) {
    return res.status(400).json({ error: 'Student ID already registered.' });
  }

  const full_name = `${first_name} ${middle_name ? middle_name.trim() + ' ' : ''}${last_name}`.trim();
  const photo_path = req.file ? `/uploads/${req.file.filename}` : '/uploads/default_avatar.png';
  const qr_token = crypto.randomBytes(16).toString('hex');

  const stmt = db.prepare(`
    INSERT INTO students (
      student_id, first_name, middle_name, last_name, full_name, position_id, club,
      school_year, gender, date_of_birth, contact_number, school_email, address, photo_path,
      date_joined, membership_status, expiration_date, parent_name, parent_contact, qr_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    stmt.run(
      student_id.trim(), first_name.trim(), middle_name ? middle_name.trim() : '', last_name.trim(), full_name,
      position_id, club.trim(), school_year.trim(), gender || '', date_of_birth || '',
      contact_number || '', school_email || '', address || '', photo_path,
      date_joined || new Date().toISOString().split('T')[0], membership_status || 'Active',
      expiration_date || '', parent_name || '', parent_contact || '', qr_token
    );

    // Auto-generate student portal user
    const defaultPasswordHash = bcrypt.hashSync(student_id.trim(), 10);
    db.prepare("INSERT INTO users (username, password_hash, role, student_id) VALUES (?, ?, ?, ?)")
      .run(student_id.trim(), defaultPasswordHash, 'STUDENT', student_id.trim());

    // Officer history tracking
    const posObj = db.prepare("SELECT name FROM positions WHERE id = ?").get(position_id);
    db.prepare("INSERT INTO officer_history (student_id, position_name, start_date) VALUES (?, ?, ?)")
      .run(student_id.trim(), posObj ? posObj.name : 'Member', new Date().toISOString().split('T')[0]);

    logAudit(req.session.user.username, 'REGISTER_STUDENT', `Registered student: ${full_name} (${student_id})`);
    res.json({ success: true, message: 'Student member registered successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Database error during registration: ' + err.message });
  }
});

app.put('/api/students/:student_id', requireAuth, requireRole('ADMIN'), upload.single('photo'), (req, res) => {
  const { student_id } = req.params;
  const current = db.prepare("SELECT * FROM students WHERE student_id = ?").get(student_id);
  if (!current) return res.status(404).json({ error: 'Student record not found.' });

  const {
    first_name, middle_name, last_name, position_id, club, school_year,
    gender, date_of_birth, contact_number, school_email, address, date_joined,
    membership_status, expiration_date, parent_name, parent_contact
  } = req.body;

  const full_name = `${first_name} ${middle_name ? middle_name.trim() + ' ' : ''}${last_name}`.trim();
  const photo_path = req.file ? `/uploads/${req.file.filename}` : current.photo_path;

  if (current.position_id != position_id) {
    const newPos = db.prepare("SELECT name FROM positions WHERE id = ?").get(position_id);
    db.prepare("UPDATE officer_history SET end_date = ?, status = 'Former' WHERE student_id = ? AND status = 'Active'")
      .run(new Date().toISOString().split('T')[0], student_id);
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

  try {
    stmt.run(
      first_name.trim(), middle_name ? middle_name.trim() : '', last_name.trim(), full_name, position_id,
      club.trim(), school_year.trim(), gender || '', date_of_birth || '', contact_number || '',
      school_email || '', address || '', photo_path, date_joined, membership_status,
      expiration_date || '', parent_name || '', parent_contact || '', student_id
    );

    logAudit(req.session.user.username, 'UPDATE_STUDENT', `Updated student details for ${full_name}`);
    res.json({ success: true, message: 'Student updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update student: ' + err.message });
  }
});

app.post('/api/students/:student_id/regenerate-qr', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { student_id } = req.params;
  const newToken = crypto.randomBytes(16).toString('hex');

  db.prepare("UPDATE students SET qr_token = ?, qr_status = 'Active' WHERE student_id = ?").run(newToken, student_id);
  logAudit(req.session.user.username, 'REGENERATE_QR', `Regenerated QR token for student ID: ${student_id}`);
  res.json({ success: true, qr_token: newToken });
});

app.post('/api/students/:student_id/toggle-qr', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { student_id } = req.params;
  const { status } = req.body; // 'Active' or 'Disabled'
  
  db.prepare("UPDATE students SET qr_status = ? WHERE student_id = ?").run(status, student_id);
  logAudit(req.session.user.username, 'TOGGLE_QR', `Updated QR status to ${status} for student ID: ${student_id}`);
  res.json({ success: true });
});

// ============================================================================
// API ENDPOINTS - CLUB EVENTS
// ============================================================================

app.get('/api/events', requireAuth, (req, res) => {
  const events = db.prepare("SELECT * FROM events ORDER BY date DESC, start_time DESC").all();
  res.json(events);
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  res.json(event);
});

app.post('/api/events', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name, description, type, date, start_time, end_time, location, organizer, target_audience, target_positions, status } = req.body;
  if (!name || !type || !date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Required event details missing.' });
  }

  const stmt = db.prepare(`
    INSERT INTO events (name, description, type, date, start_time, end_time, location, organizer, target_audience, target_positions, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    const info = stmt.run(
      name.trim(), description || '', type, date, start_time, end_time, location || '', organizer || '',
      target_audience || 'ALL', JSON.stringify(target_positions || []), status || 'Upcoming'
    );

    logAudit(req.session.user.username, 'CREATE_EVENT', `Created event: ${name.trim()}`);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create event: ' + err.message });
  }
});

app.put('/api/events/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { name, description, type, date, start_time, end_time, location, organizer, target_audience, target_positions, status } = req.body;
  const { id } = req.params;

  try {
    db.prepare(`
      UPDATE events SET name = ?, description = ?, type = ?, date = ?, start_time = ?, end_time = ?,
      location = ?, organizer = ?, target_audience = ?, target_positions = ?, status = ?
      WHERE id = ?
    `).run(
      name.trim(), description || '', type, date, start_time, end_time, location || '', organizer || '',
      target_audience, JSON.stringify(target_positions || []), status, id
    );

    logAudit(req.session.user.username, 'UPDATE_EVENT', `Updated event ID ${id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update event: ' + err.message });
  }
});

app.delete('/api/events/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { id } = req.params;
  db.prepare("DELETE FROM events WHERE id = ?").run(id);
  logAudit(req.session.user.username, 'DELETE_EVENT', `Deleted event ID ${id}`);
  res.json({ success: true });
});

// ============================================================================
// API ENDPOINTS - ATTENDANCE & SCANNING ENGINE
// ============================================================================

app.post('/api/attendance/scan', requireAuth, requireRole('ADMIN', 'SCANNER'), (req, res) => {
  const { event_id, qr_token, scan_type } = req.body; // scan_type = 'IN' or 'OUT'

  if (!event_id || !qr_token || !scan_type) {
    return res.status(400).json({ error: 'Event ID, QR Token, and Scan Type are required.' });
  }

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(event_id);
  if (!event) return res.status(404).json({ error: 'Event not found.', code: 'INVALID_EVENT' });

  const student = db.prepare("SELECT s.*, p.name as position_name FROM students s JOIN positions p ON s.position_id = p.id WHERE s.qr_token = ?").get(qr_token);
  if (!student) {
    return res.status(400).json({ error: 'Invalid or unknown QR code scanned.', code: 'INVALID_QR' });
  }

  if (student.qr_status !== 'Active') {
    return res.status(400).json({ error: 'This student QR Code has been disabled.', code: 'DISABLED_QR' });
  }

  if (student.membership_status !== 'Active') {
    return res.status(400).json({ error: `Student membership status is ${student.membership_status}.`, code: 'INACTIVE_MEMBER' });
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

    const lateThreshold = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'late_threshold_mins'").get()?.value || '15', 10);
    let status = 'PRESENT';

    if (event.start_time) {
      const [eHours, eMins] = event.start_time.split(':').map(Number);
      const now = new Date();
      const eventStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eHours, eMins);
      const thresholdTime = new Date(eventStart.getTime() + lateThreshold * 60000);

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

    logAudit(req.session.user.username, 'SCAN_TIME_IN', `Recorded Time In for ${student.full_name} (${student.student_id})`);

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
      return res.status(400).json({ error: 'Cannot record Time Out without prior Time In.', code: 'NO_TIME_IN' });
    }
    if (existing.time_out) {
      return res.status(400).json({ error: 'Already recorded Time Out for this event.', code: 'DUPLICATE', student_name: student.full_name });
    }

    db.prepare("UPDATE attendance SET time_out = ? WHERE id = ?").run(currentTimeStr, existing.id);

    logAudit(req.session.user.username, 'SCAN_TIME_OUT', `Recorded Time Out for ${student.full_name} (${student.student_id})`);

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

  query += " ORDER BY a.id DESC LIMIT 300";
  const records = db.prepare(query).all(...params);
  res.json(records);
});

app.post('/api/attendance/excuse', requireAuth, requireRole('ADMIN'), (req, res) => {
  const { event_id, student_id, reason, notes } = req.body;
  if (!event_id || !student_id || !reason) return res.status(400).json({ error: 'Event, student, and reason are required.' });

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

  logAudit(req.session.user.username, 'MARK_EXCUSED', `Excused student ${student_id} for event ID ${event_id}`);
  res.json({ success: true });
});

// ============================================================================
// API ENDPOINTS - ANALYTICS, REPORTS & SYSTEM ADMIN
// ============================================================================

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

  const positionStats = db.prepare(`
    SELECT p.name, COUNT(s.id) as count 
    FROM positions p 
    LEFT JOIN students s ON s.position_id = p.id 
    GROUP BY p.id
    ORDER BY p.hierarchy_order ASC
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

app.get('/api/admin/audit-logs', requireAuth, requireRole('ADMIN'), (req, res) => {
  const logs = db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 250").all();
  res.json(logs);
});

app.get('/api/admin/backup', requireAuth, requireRole('ADMIN'), (req, res) => {
  const backupFileName = `backup-${Date.now()}.db`;
  const backupPath = path.join(backupsDir, backupFileName);

  db.backup(backupPath).then(() => {
    logAudit(req.session.user.username, 'CREATE_BACKUP', `Database backup created: ${backupFileName}`);
    res.download(backupPath);
  }).catch(err => {
    res.status(500).json({ error: 'Database backup failed: ' + err.message });
  });
});
// ============================================================================
// SINGLE-PAGE FRONTEND INTEGRATED ENGINE
// ============================================================================

const CLIENT_APP_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Student Club QR Attendance System</title>
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
    
    /* Printable ID Card Standard CSS Grid */
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
  <!-- Dynamic JS SPA Mount Point -->
</div>

<!-- Dynamic Modals Container -->
<div id="modal-container"></div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
<script>
  let currentUser = null;
  let systemSettings = {};

  async function initApp() {
    try {
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
    } catch (err) {
      console.error("System Initialization Failure:", err);
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
          <!-- Main Content Pane -->
        </div>
      </div>
    \`;
    loadAdminTab('dashboard');
  }

  async function loadAdminTab(tab) {
    const main = document.getElementById('admin-main-content');
    
    // Active navigation state highlight
    document.querySelectorAll('.sidebar .nav-link').forEach(el => el.classList.remove('active'));
    event?.target?.classList?.add('active');

    if (tab === 'dashboard') {
      const res = await fetch('/api/analytics/dashboard');
      const data = await res.json();
      main.innerHTML = \`
        <h3 class="fw-bold mb-4">School Club Overview</h3>
        <div class="row g-3 mb-4">
          <div class="col-md-3">
            <div class="card card-stat bg-primary text-white p-3">
              <h6>Total Registered Members</h6>
              <h2 class="fw-bold m-0">\${data.totalMembers}</h2>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-stat bg-success text-white p-3">
              <h6>Active Status Members</h6>
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
              <h5 class="fw-bold mb-3">Active Event Scanner Status</h5>
              \${data.activeEvent ? \`
                <div class="alert alert-success">
                  <h6 class="fw-bold m-0">\${data.activeEvent.name}</h6>
                  <small>Date: \${data.activeEvent.date} | Schedule: \${data.activeEvent.start_time} - \${data.activeEvent.end_time}</small>
                </div>
              \` : '<p class="text-muted">No active club event currently ongoing.</p>'}
            </div>
          </div>
          <div class="col-md-6">
            <div class="card p-3 shadow-sm">
              <h5 class="fw-bold mb-3">Upcoming Club Schedules</h5>
              <ul class="list-group list-group-flush">
                \${data.upcomingEvents.map(e => \`
                  <li class="list-group-item d-flex justify-content-between align-items-center">
                    <div>
                      <strong>\${e.name}</strong><br>
                      <small class="text-muted">\${e.date} @ \${e.location || 'School Campus'}</small>
                    </div>
                    <span class="badge bg-primary">\${e.status}</span>
                  </li>
                \`).join('') || '<p class="text-muted">No upcoming events scheduled.</p>'}
              </ul>
            </div>
          </div>
        </div>
      \`;
    } else if (tab === 'positions') {
      renderPositionsTab();
    } else if (tab === 'students') {
      renderStudentsTab();
    } else if (tab === 'events') {
      renderEventsTab();
    } else if (tab === 'attendance') {
      renderAttendanceLogsTab();
    } else if (tab === 'printing') {
      renderPrintingTab();
    } else if (tab === 'reports') {
      renderReportsTab();
    } else if (tab === 'settings') {
      renderSettingsTab();
    } else if (tab === 'account') {
      renderChangePasswordTab();
    }
  }
  // Position Management Tab UI
  async function renderPositionsTab() {
    const res = await fetch('/api/positions');
    const positions = await res.json();
    const main = document.getElementById('admin-main-content');

    main.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Customizable Position Hierarchy</h3>
        <button class="btn btn-primary" onclick="showAddPositionModal()"><i class="bi bi-plus-circle me-1"></i>Add New Position</button>
      </div>
      <div class="card p-3 shadow-sm">
        <table class="table table-hover align-middle">
          <thead>
            <tr><th>Order</th><th>Position Name</th><th>Actions</th></tr>
          </thead>
          <tbody>
            \${positions.map(p => \`
              <tr>
                <td><span class="badge bg-secondary">\${p.hierarchy_order}</span></td>
                <td><strong>\${p.name}</strong></td>
                <td>
                  <button class="btn btn-sm btn-outline-primary me-1" onclick="editPosition(\${p.id}, '\${p.name}', \${p.hierarchy_order})">Edit</button>
                  <button class="btn btn-sm btn-outline-danger" onclick="deletePosition(\${p.id})">Delete</button>
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  function showAddPositionModal() {
    const modalHtml = \`
      <div class="modal fade" id="posModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title fw-bold">Add Position</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
              <div class="mb-3">
                <label class="form-label">Position Name</label>
                <input type="text" id="pos-name" class="form-control" required placeholder="e.g. Activity Coordinator">
              </div>
              <div class="mb-3">
                <label class="form-label">Hierarchy Rank Order</label>
                <input type="number" id="pos-order" class="form-control" value="10" placeholder="Lower number = higher rank">
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" onclick="submitPosition()">Save Position</button>
            </div>
          </div>
        </div>
      </div>
    \`;
    document.getElementById('modal-container').innerHTML = modalHtml;
    const modal = new bootstrap.Modal(document.getElementById('posModal'));
    modal.show();
  }

  async function submitPosition() {
    const name = document.getElementById('pos-name').value;
    const hierarchy_order = document.getElementById('pos-order').value;

    const res = await fetch('/api/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hierarchy_order })
    });

    if (res.ok) {
      bootstrap.Modal.getInstance(document.getElementById('posModal')).hide();
      renderPositionsTab();
    } else {
      const data = await res.json();
      alert('Error: ' + data.error);
    }
  }

  async function editPosition(id, currentName, currentOrder) {
    const newName = prompt("Enter updated position name:", currentName);
    if (!newName) return;
    const newOrder = prompt("Enter position rank order:", currentOrder);

    const res = await fetch(\`/api/positions/\${id}\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, hierarchy_order: newOrder })
    });

    if (res.ok) renderPositionsTab();
    else alert('Failed to update position');
  }

  async function deletePosition(id) {
    if (!confirm("Are you sure you want to delete this position?")) return;
    const res = await fetch(\`/api/positions/\${id}\`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) renderPositionsTab();
    else alert('Error: ' + data.error);
  }

  // Student Members Management Tab UI
  async function renderStudentsTab() {
    const res = await fetch('/api/students');
    const students = await res.json();
    const posRes = await fetch('/api/positions');
    const positions = await posRes.json();

    const main = document.getElementById('admin-main-content');
    main.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Student Membership Registry</h3>
        <button class="btn btn-primary" onclick="showStudentModal()"><i class="bi bi-person-plus me-1"></i>Register New Student</button>
      </div>
      <div class="card p-3 shadow-sm mb-3">
        <div class="row g-2">
          <div class="col-md-5">
            <input type="text" id="search-student" class="form-control" placeholder="Search by ID, Name, or Email..." onkeyup="filterStudentsTable()">
          </div>
          <div class="col-md-4">
            <select id="filter-position" class="form-select" onchange="filterStudentsTable()">
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
                  <button class="btn btn-sm btn-info text-white me-1" onclick="viewStudentDetails('\${s.student_id}')"><i class="bi bi-eye"></i> View</button>
                  <button class="btn btn-sm btn-outline-secondary me-1" onclick="showStudentModal('\${s.student_id}')"><i class="bi bi-pencil"></i> Edit</button>
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  async function showStudentModal(studentId = null) {
    const posRes = await fetch('/api/positions');
    const positions = await posRes.json();
    let student = null;

    if (studentId) {
      const res = await fetch(\`/api/students/\${studentId}\`);
      student = await res.json();
    }

    const modalHtml = \`
      <div class="modal fade" id="studentModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title fw-bold">\${student ? 'Edit Member Profile' : 'Register New Student Member'}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <form id="student-form" enctype="multipart/form-data">
              <div class="modal-body row g-3">
                <div class="col-md-4">
                  <label class="form-label">Student ID</label>
                  <input type="text" name="student_id" class="form-control" required \${student ? 'readonly' : ''} value="\${student ? student.student_id : ''}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">First Name</label>
                  <input type="text" name="first_name" class="form-control" required value="\${student ? student.first_name : ''}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Last Name</label>
                  <input type="text" name="last_name" class="form-control" required value="\${student ? student.last_name : ''}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Middle Name</label>
                  <input type="text" name="middle_name" class="form-control" value="\${student ? student.middle_name || '' : ''}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Position</label>
                  <select name="position_id" class="form-select" required>
                    \${positions.map(p => \`<option value="\${p.id}" \${student && student.position_id == p.id ? 'selected' : ''}>\${p.name}</option>\`).join('')}
                  </select>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Club Name</label>
                  <input type="text" name="club" class="form-control" required value="\${student ? student.club : systemSettings.club_name || 'Computer Club'}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">School Year</label>
                  <input type="text" name="school_year" class="form-control" required value="\${student ? student.school_year : systemSettings.school_year || '2026-2027'}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">School Email</label>
                  <input type="email" name="school_email" class="form-control" value="\${student ? student.school_email || '' : ''}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Contact Number</label>
                  <input type="text" name="contact_number" class="form-control" value="\${student ? student.contact_number || '' : ''}">
                </div>
                <div class="col-md-6">
                  <label class="form-label">Membership Status</label>
                  <select name="membership_status" class="form-select">
                    <option value="Active" \${student && student.membership_status === 'Active' ? 'selected' : ''}>Active</option>
                    <option value="Inactive" \${student && student.membership_status === 'Inactive' ? 'selected' : ''}>Inactive</option>
                    <option value="Suspended" \${student && student.membership_status === 'Suspended' ? 'selected' : ''}>Suspended</option>
                    <option value="Alumni" \${student && student.membership_status === 'Alumni' ? 'selected' : ''}>Alumni</option>
                  </select>
                </div>
                <div class="col-md-6">
                  <label class="form-label">Profile Photo</label>
                  <input type="file" name="photo" class="form-control" accept="image/*">
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
    \`;

    document.getElementById('modal-container').innerHTML = modalHtml;
    const modal = new bootstrap.Modal(document.getElementById('studentModal'));
    modal.show();

    document.getElementById('student-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const url = student ? \`/api/students/\${student.student_id}\` : '/api/students';
      const method = student ? 'PUT' : 'POST';

      const res = await fetch(url, { method, body: formData });
      if (res.ok) {
        modal.hide();
        renderStudentsTab();
      } else {
        const data = await res.json();
        alert('Error: ' + data.error);
      }
    });
  }

  async function viewStudentDetails(studentId) {
    const res = await fetch(\`/api/students/\${studentId}\`);
    const student = await res.json();

    const modalHtml = \`
      <div class="modal fade" id="viewStudentModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title fw-bold">Student Profile & QR Token</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="row align-items-center mb-4">
                <div class="col-md-3 text-center">
                  <img src="\${student.photo_path}" style="width: 120px; height: 120px; object-fit: cover; border-radius: 8px; border: 2px solid #cbd5e1;">
                </div>
                <div class="col-md-6">
                  <h4 class="fw-bold m-0">\${student.full_name}</h4>
                  <p class="text-primary fw-semibold m-0">\${student.position_name}</p>
                  <p class="text-muted small">Student ID: \${student.student_id} | S.Y.: \${student.school_year}</p>
                  <span class="badge bg-\${student.membership_status === 'Active' ? 'success' : 'danger'}">\${student.membership_status} Member</span>
                </div>
                <div class="col-md-3 text-center">
                  <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=\${student.qr_token}" style="width: 100px; height: 100px;">
                  <small class="d-block text-muted mt-1">Token Active</small>
                </div>
              </div>

              <div class="row g-3">
                <div class="col-md-3">
                  <div class="p-2 border rounded text-center">
                    <small class="text-muted d-block">Participation</small>
                    <strong class="fs-5 text-primary">\${student.stats.participationPct}%</strong>
                  </div>
                </div>
                <div class="col-md-3">
                  <div class="p-2 border rounded text-center">
                    <small class="text-muted d-block">Attended</small>
                    <strong class="fs-5 text-success">\${student.stats.attendedCount}</strong>
                  </div>
                </div>
                <div class="col-md-3">
                  <div class="p-2 border rounded text-center">
                    <small class="text-muted d-block">Late</small>
                    <strong class="fs-5 text-warning">\${student.stats.lateCount}</strong>
                  </div>
                </div>
                <div class="col-md-3">
                  <div class="p-2 border rounded text-center">
                    <small class="text-muted d-block">Excused</small>
                    <strong class="fs-5 text-info">\${student.stats.excusedCount}</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('modal-container').innerHTML = modalHtml;
    const modal = new bootstrap.Modal(document.getElementById('viewStudentModal'));
    modal.show();
  }

  // Event Management Tab UI
  async function renderEventsTab() {
    const res = await fetch('/api/events');
    const events = await res.json();
    const main = document.getElementById('admin-main-content');

    main.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h3 class="fw-bold">Club Activities & Meetings</h3>
        <button class="btn btn-primary" onclick="showEventModal()"><i class="bi bi-calendar-plus me-1"></i>Create New Event</button>
      </div>
      <div class="card p-3 shadow-sm">
        <table class="table table-hover align-middle">
          <thead>
            <tr><th>Event Name</th><th>Type</th><th>Date</th><th>Schedule</th><th>Location</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            \${events.map(e => \`
              <tr>
                <td><strong>\${e.name}</strong></td>
                <td><span class="badge bg-outline-secondary">\${e.type}</span></td>
                <td>\${e.date}</td>
                <td>\${e.start_time} - \${e.end_time}</td>
                <td>\${e.location || 'Campus'}</td>
                <td><span class="badge bg-\${e.status === 'Active' ? 'success' : e.status === 'Upcoming' ? 'primary' : 'secondary'}">\${e.status}</span></td>
                <td>
                  <button class="btn btn-sm btn-outline-primary me-1" onclick="showEventModal(\${e.id})">Edit</button>
                  <button class="btn btn-sm btn-outline-danger" onclick="deleteEvent(\${e.id})">Delete</button>
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  async function showEventModal(eventId = null) {
    let eventData = null;
    if (eventId) {
      const res = await fetch(\`/api/events/\${eventId}\`);
      eventData = await res.json();
    }

    const modalHtml = \`
      <div class="modal fade" id="eventModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title fw-bold">\${eventData ? 'Edit Activity Schedule' : 'Create New Activity'}</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <form id="event-form">
              <div class="modal-body row g-3">
                <div class="col-md-6">
                  <label class="form-label">Event Title</label>
                  <input type="text" id="ev-name" class="form-control" required value="\${eventData ? eventData.name : ''}">
                </div>
                <div class="col-md-6">
                  <label class="form-label">Event Type</label>
                  <select id="ev-type" class="form-select">
                    <option value="Regular Meeting" \${eventData && eventData.type === 'Regular Meeting' ? 'selected' : ''}>Regular Meeting</option>
                    <option value="Workshop" \${eventData && eventData.type === 'Workshop' ? 'selected' : ''}>Workshop</option>
                    <option value="Assembly" \${eventData && eventData.type === 'Assembly' ? 'selected' : ''}>Assembly</option>
                    <option value="Special Event" \${eventData && eventData.type === 'Special Event' ? 'selected' : ''}>Special Event</option>
                  </select>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Date</label>
                  <input type="date" id="ev-date" class="form-control" required value="\${eventData ? eventData.date : new Date().toISOString().split('T')[0]}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Start Time</label>
                  <input type="time" id="ev-start" class="form-control" required value="\${eventData ? eventData.start_time : '09:00'}">
                </div>
                <div class="col-md-4">
                  <label class="form-label">End Time</label>
                  <input type="time" id="ev-end" class="form-control" required value="\${eventData ? eventData.end_time : '11:00'}">
                </div>
                <div class="col-md-6">
                  <label class="form-label">Location / Venue</label>
                  <input type="text" id="ev-location" class="form-control" value="\${eventData ? eventData.location || '' : 'School AVR'}">
                </div>
                <div class="col-md-6">
                  <label class="form-label">Status</label>
                  <select id="ev-status" class="form-select">
                    <option value="Upcoming" \${eventData && eventData.status === 'Upcoming' ? 'selected' : ''}>Upcoming</option>
                    <option value="Active" \${eventData && eventData.status === 'Active' ? 'selected' : ''}>Active (Open Scanning)</option>
                    <option value="Completed" \${eventData && eventData.status === 'Completed' ? 'selected' : ''}>Completed</option>
                    <option value="Cancelled" \${eventData && eventData.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                  </select>
                </div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                <button type="submit" class="btn btn-primary">Save Activity</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    \`;

    document.getElementById('modal-container').innerHTML = modalHtml;
    const modal = new bootstrap.Modal(document.getElementById('eventModal'));
    modal.show();

    document.getElementById('event-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('ev-name').value,
        type: document.getElementById('ev-type').value,
        date: document.getElementById('ev-date').value,
        start_time: document.getElementById('ev-start').value,
        end_time: document.getElementById('ev-end').value,
        location: document.getElementById('ev-location').value,
        status: document.getElementById('ev-status').value
      };

      const url = eventData ? \`/api/events/\${eventData.id}\` : '/api/events';
      const method = eventData ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        modal.hide();
        renderEventsTab();
      } else {
        alert('Failed to save event schedule.');
      }
    });
  }

  async function deleteEvent(id) {
    if (!confirm("Are you sure you want to remove this activity schedule?")) return;
    const res = await fetch(\`/api/events/\${id}\`, { method: 'DELETE' });
    if (res.ok) renderEventsTab();
  }

  // Attendance Logs Tab UI
  async function renderAttendanceLogsTab() {
    const res = await fetch('/api/attendance/records');
    const records = await res.json();
    const main = document.getElementById('admin-main-content');

    main.innerHTML = \`
      <h3 class="fw-bold mb-3">Live Attendance System Audit Logs</h3>
      <div class="card p-3 shadow-sm">
        <table class="table table-hover align-middle">
          <thead>
            <tr><th>Student Name</th><th>Position</th><th>Event Title</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
          </thead>
          <tbody>
            \${records.map(r => \`
              <tr>
                <td><strong>\${r.full_name}</strong></td>
                <td><span class="badge bg-secondary">\${r.position_name}</span></td>
                <td>\${r.event_name}</td>
                <td>\${r.time_in || '--'}</td>
                <td>\${r.time_out || '--'}</td>
                <td><span class="badge bg-\${r.status === 'PRESENT' ? 'success' : r.status === 'LATE' ? 'warning' : 'info'}">\${r.status}</span></td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  // Printable A4 ID Layout Tab UI
  async function renderPrintingTab() {
    const res = await fetch('/api/students');
    const students = await res.json();
    const main = document.getElementById('admin-main-content');

    main.innerHTML = \`
      <div class="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h3 class="fw-bold m-0">A4 Bond Paper ID Layout Printing</h3>
          <p class="text-muted small m-0">Arranges 8 Official Student Club IDs per A4 Sheet for batch printing.</p>
        </div>
        <button class="btn btn-success" onclick="window.print()"><i class="bi bi-printer me-1"></i>Print ID Batch</button>
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

    // Render QR Images onto layout elements
    students.slice(0, 8).forEach(s => {
      const el = document.getElementById(\`qr-id-\${s.student_id}\`);
      if (el) {
        el.innerHTML = \`<img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=\${s.qr_token}" style="width:100%;height:100%;">\`;
      }
    });
  }

  // Reports & Analytics Tab UI
  async function renderReportsTab() {
    const res = await fetch('/api/reports/participation');
    const report = await res.json();
    const main = document.getElementById('admin-main-content');

    main.innerHTML = \`
      <h3 class="fw-bold mb-3">Participation & Attendance Analytics Report</h3>
      <div class="card p-3 shadow-sm">
        <table class="table table-hover align-middle">
          <thead>
            <tr><th>Student ID</th><th>Full Name</th><th>Position</th><th>Total Events</th><th>Attended</th><th>Lates</th><th>Participation Rate</th></tr>
          </thead>
          <tbody>
            \${report.map(r => \`
              <tr class="\${r.isLow ? 'table-warning' : ''}">
                <td><strong>\${r.student_id}</strong></td>
                <td>\${r.full_name}</td>
                <td><span class="badge bg-secondary">\${r.position_name}</span></td>
                <td>\${r.totalEvents}</td>
                <td>\${r.attended}</td>
                <td>\${r.lates}</td>
                <td>
                  <strong class="\${r.isLow ? 'text-danger' : 'text-success'}">\${r.pct}%</strong>
                  \${r.isLow ? '<span class="badge bg-danger ms-1">Low</span>' : ''}
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      </div>
    \`;
  }

  // System Settings Tab UI
  async function renderSettingsTab() {
    const main = document.getElementById('admin-main-content');
    main.innerHTML = \`
      <h3 class="fw-bold mb-4">Club System Settings</h3>
      <div class="card p-4 shadow-sm" style="max-width: 700px;">
        <form id="settings-form">
          <div class="mb-3">
            <label class="form-label fw-bold">School Name</label>
            <input type="text" id="set-school-name" class="form-control" value="\${systemSettings.school_name || ''}">
          </div>
          <div class="mb-3">
            <label class="form-label fw-bold">Club / Organization Name</label>
            <input type="text" id="set-club-name" class="form-control" value="\${systemSettings.club_name || ''}">
          </div>
          <div class="mb-3">
            <label class="form-label fw-bold">Club Adviser</label>
            <input type="text" id="set-adviser" class="form-control" value="\${systemSettings.club_adviser || ''}">
          </div>
          <div class="mb-3">
            <label class="form-label fw-bold">School Year</label>
            <input type="text" id="set-sy" class="form-control" value="\${systemSettings.school_year || ''}">
          </div>
          <div class="mb-3">
            <label class="form-label fw-bold">Late Threshold (Minutes)</label>
            <input type="number" id="set-late" class="form-control" value="\${systemSettings.late_threshold_mins || '15'}">
          </div>
          <button type="submit" class="btn btn-primary fw-bold">Save System Settings</button>
        </form>
      </div>
    \`;

    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        school_name: document.getElementById('set-school-name').value,
        club_name: document.getElementById('set-club-name').value,
        club_adviser: document.getElementById('set-adviser').value,
        school_year: document.getElementById('set-sy').value,
        late_threshold_mins: document.getElementById('set-late').value
      };

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        alert('Settings updated successfully.');
        initApp();
      } else {
        alert('Failed to update settings.');
      }
    });
  }

  // Account Password Management Tab UI
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

  // Mobile QR Scanner Portal Interface
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
          <!-- Live Scan Display Card -->
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
    select.innerHTML = events.map(e => \`<option value="\${e.id}">\${e.name} (\${e.date})</option>\`).join('') || '<option value="">No Active Events Scheduled</option>';
  }

  function startCameraScanner() {
    html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess
    ).catch(err => {
      console.error("Camera permissions denied or device missing camera.", err);
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

// App Entry Endpoint Engine
app.get('*', (req, res) => {
  res.send(CLIENT_APP_HTML);
});

// Start Monolithic Express Application Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(` SCHOOL CLUB QR ATTENDANCE SYSTEM RUNNING ON PORT: ${PORT}`);
  console.log(` Local Admin Console: http://localhost:${PORT}`);
  console.log(` Mobile QR Scanner:  http://localhost:${PORT}/scanner`);
  console.log(`=======================================================`);
});
