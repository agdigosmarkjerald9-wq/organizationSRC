/**
 * SCHOOL CLUB ID & ATTENDANCE SYSTEM - MONOLITHIC ENTERPRISE ENGINE
 * Strictly Database-Driven | Persistent Photo Storage | Large Scannable QR ID Cards (8/A4)
 */

const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_club_key_2026';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'database.sqlite');

[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let db;

// -----------------------------------------------------------------------------
// DATABASE INITIALIZATION & MIGRATION ENGINE
// -----------------------------------------------------------------------------
async function initDB() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  await db.exec('PRAGMA foreign_keys = ON;');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_number TEXT UNIQUE NOT NULL,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      contact_number TEXT,
      position_id INTEGER,
      photo_path TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, INACTIVE
      qr_token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL, -- ADMIN, STUDENT
      student_id INTEGER UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      event_type TEXT DEFAULT 'Club Meeting',
      event_date DATE NOT NULL,
      start_time TIME NOT NULL,
      late_threshold_minutes INTEGER DEFAULT 10,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      scan_type TEXT NOT NULL, -- IN, OUT
      status TEXT NOT NULL, -- PRESENT, LATE, EXCUSED, ABSENT
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      UNIQUE(event_id, student_id, scan_type)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Default System Settings Seed
  const defaultSettings = [
    ['sn_prefix', 'SC-'],
    ['sn_year', '2026'],
    ['sn_starting_number', '000001'],
    ['sn_length', '6'],
    ['school_name', 'Metropolitan Science Academy'],
    ['club_name', 'Robotics & AI Guild'],
    ['school_year', '2026-2027'],
    ['timezone', 'Asia/Manila'],
    ['school_logo', ''],
    ['club_logo', '']
  ];

  for (const [key, val] of defaultSettings) {
    await db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, val]);
  }

  // Default Positions Seed
  const defaultPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Member'];
  for (const pos of defaultPositions) {
    await db.run('INSERT OR IGNORE INTO positions (name) VALUES (?)', [pos]);
  }

  // Default System Administrator
  const adminExists = await db.get('SELECT id FROM users WHERE role = "ADMIN"');
  if (!adminExists) {
    const hash = await bcrypt.hash('Admin@123', 10);
    await db.run('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)', ['admin@school.edu', hash, 'ADMIN']);
    console.log('[SECURITY] Default Administrator Account Initialized: admin@school.edu / Admin@123');
  }

  // Default Event
  const eventExists = await db.get('SELECT id FROM events WHERE is_active = 1');
  if (!eventExists) {
    const today = new Date().toISOString().split('T')[0];
    await db.run(
      'INSERT INTO events (title, description, event_type, event_date, start_time, late_threshold_minutes) VALUES (?, ?, ?, ?, ?, ?)',
      ['General Club Assembly', 'Mandatory orientation and team sync.', 'General Attendance', today, '08:00', 15]
    );
  }
}

// -----------------------------------------------------------------------------
// MULTER FILE UPLOADER CONFIGURATION & VALIDATION
// -----------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedMime = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedMime.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid image format. Only PNG, JPG, JPEG, and WEBP files are allowed.'), false);
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB Limit
  fileFilter
});

// -----------------------------------------------------------------------------
// EXPRESS MIDDLEWARES & AUTHENTICATION
// -----------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token is invalid or expired' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Helper: Automatic Sequential Student Number Generator
async function generateStudentNumber() {
  const settingsRows = await db.all('SELECT key, value FROM settings WHERE key LIKE "sn_%"');
  const cfg = {};
  settingsRows.forEach(r => cfg[r.key] = r.value);

  const prefix = cfg.sn_prefix || 'SC-';
  const year = cfg.sn_year || '2026';
  const startingNum = parseInt(cfg.sn_starting_number || '1', 10);
  const padLength = parseInt(cfg.sn_length || '6', 10);

  const lastStudent = await db.get(
    'SELECT student_number FROM students WHERE student_number LIKE ? ORDER BY id DESC LIMIT 1',
    [`${prefix}${year}-%`]
  );

  let nextSequence = startingNum;
  if (lastStudent && lastStudent.student_number) {
    const parts = lastStudent.student_number.split('-');
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) nextSequence = lastSeq + 1;
  }

  const paddedSeq = String(nextSequence).padStart(padLength, '0');
  return `${prefix}${year}-${paddedSeq}`;
}

// Audit Logger Helper
async function logAudit(userId, action, oldValue, newValue, reason) {
  await db.run(
    'INSERT INTO audit_logs (user_id, action, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?)',
    [userId, action, JSON.stringify(oldValue), JSON.stringify(newValue), reason]
  );
}

// -----------------------------------------------------------------------------
// REST API ENDPOINTS
// -----------------------------------------------------------------------------

// --- PUBLIC AUTHENTICATION & REGISTRATION ---
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(400).json({ error: 'Invalid credentials' });

  let student = null;
  if (user.student_id) {
    student = await db.get(
      'SELECT s.*, p.name as position_name FROM students s LEFT JOIN positions p ON s.position_id = p.id WHERE s.id = ?',
      [user.student_id]
    );
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, student_id: user.student_id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role }, student });
});

app.post('/api/public/register', upload.single('photo'), async (req, res) => {
  try {
    const { first_name, middle_name, last_name, email, contact_number, position_id, password } = req.body;

    if (!first_name || !last_name || !email || !position_id || !password) {
      return res.status(400).json({ error: 'Required fields missing: First Name, Last Name, Email, Position, and Password.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Student photo upload is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await db.get('SELECT id FROM students WHERE email = ?', [cleanEmail]);
    if (existing) return res.status(400).json({ error: 'This email address is already registered.' });

    const pos = await db.get('SELECT id FROM positions WHERE id = ?', [position_id]);
    if (!pos) return res.status(400).json({ error: 'Selected position is invalid.' });

    const studentNumber = await generateStudentNumber();
    const qrToken = `QR-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const photoPath = `/uploads/${req.file.filename}`;

    await db.run('BEGIN TRANSACTION');

    const result = await db.run(
      `INSERT INTO students (student_number, first_name, middle_name, last_name, email, contact_number, position_id, photo_path, status, qr_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [studentNumber, first_name.trim(), middle_name?.trim() || '', last_name.trim(), cleanEmail, contact_number?.trim() || '', position_id, photoPath, qrToken]
    );

    const studentId = result.lastID;
    const passwordHash = await bcrypt.hash(password, 10);

    await db.run(
      'INSERT INTO users (email, password_hash, role, student_id) VALUES (?, ?, "STUDENT", ?)',
      [cleanEmail, passwordHash, studentId]
    );

    await db.run('COMMIT');

    res.status(201).json({
      message: 'Registration successful! Your account is pending administrator approval.',
      student_number: studentNumber
    });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message || 'Internal server error during registration.' });
  }
});

app.get('/api/public/positions', async (req, res) => {
  const positions = await db.all('SELECT * FROM positions ORDER BY id ASC');
  res.json(positions);
});

app.get('/api/public/settings', async (req, res) => {
  const settings = await db.all('SELECT key, value FROM settings');
  const map = {};
  settings.forEach(s => map[s.key] = s.value);
  res.json(map);
});

// --- ADMIN MANAGEMENT ENDPOINTS ---
app.get('/api/admin/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  const { date_range, event_id, position_id } = req.query;

  let eventWhere = 'WHERE is_active = 1';
  if (event_id && event_id !== 'ALL') eventWhere = `WHERE id = ${parseInt(event_id)}`;
  const activeEvent = await db.get(`SELECT * FROM events ${eventWhere} ORDER BY event_date DESC, start_time DESC LIMIT 1`);

  const totalStudents = (await db.get('SELECT COUNT(*) as count FROM students')).count;
  const activeStudents = (await db.get('SELECT COUNT(*) as count FROM students WHERE status = "APPROVED"')).count;
  const inactiveStudents = (await db.get('SELECT COUNT(*) as count FROM students WHERE status = "INACTIVE"')).count;
  const pendingRegistrations = (await db.get('SELECT COUNT(*) as count FROM students WHERE status = "PENDING"')).count;

  let presentCount = 0, lateCount = 0, excusedCount = 0, absentCount = 0, attendanceRate = 0;

  if (activeEvent) {
    let posFilter = '';
    if (position_id && position_id !== 'ALL') posFilter = ` AND s.position_id = ${parseInt(position_id)}`;

    const presentRes = await db.get(
      `SELECT COUNT(DISTINCT a.student_id) as count FROM attendance a JOIN students s ON a.student_id = s.id WHERE a.event_id = ? AND a.scan_type = 'IN' AND a.status = 'PRESENT'${posFilter}`,
      [activeEvent.id]
    );
    presentCount = presentRes.count;

    const lateRes = await db.get(
      `SELECT COUNT(DISTINCT a.student_id) as count FROM attendance a JOIN students s ON a.student_id = s.id WHERE a.event_id = ? AND a.scan_type = 'IN' AND a.status = 'LATE'${posFilter}`,
      [activeEvent.id]
    );
    lateCount = lateRes.count;

    const excusedRes = await db.get(
      `SELECT COUNT(DISTINCT a.student_id) as count FROM attendance a JOIN students s ON a.student_id = s.id WHERE a.event_id = ? AND a.scan_type = 'IN' AND a.status = 'EXCUSED'${posFilter}`,
      [activeEvent.id]
    );
    excusedCount = excusedRes.count;

    const totalEligible = (await db.get(`SELECT COUNT(*) as count FROM students s WHERE status = 'APPROVED'${posFilter}`)).count;
    const totalScannedOrExcused = presentCount + lateCount + excusedCount;
    absentCount = Math.max(0, totalEligible - totalScannedOrExcused);

    if (totalEligible > 0) {
      attendanceRate = Math.round(((presentCount + lateCount) / totalEligible) * 100);
    }
  }

  const recentScans = await db.all(
    `SELECT a.id, a.scan_type, a.status, a.timestamp, s.first_name, s.last_name, s.student_number, p.name as position_name, e.title as event_title
     FROM attendance a
     JOIN students s ON a.student_id = s.id
     LEFT JOIN positions p ON s.position_id = p.id
     JOIN events e ON a.event_id = e.id
     ORDER BY a.timestamp DESC LIMIT 10`
  );

  res.json({
    metrics: {
      totalStudents,
      activeStudents,
      inactiveStudents,
      pendingRegistrations,
      presentToday: presentCount,
      lateToday: lateCount,
      absentToday: absentCount,
      excusedToday: excusedCount,
      attendanceRate,
      activeEvent: activeEvent ? activeEvent.title : 'None Selected'
    },
    recentScans
  });
});

// Admin Student Management
app.get('/api/admin/students', authenticateToken, requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  let query = `SELECT s.*, p.name as position_name FROM students s LEFT JOIN positions p ON s.position_id = p.id WHERE 1=1`;
  const params = [];

  if (status) {
    query += ` AND s.status = ?`;
    params.push(status);
  }
  if (search) {
    query += ` AND (s.first_name LIKE ? OR s.last_name LIKE ? OR s.student_number LIKE ? OR s.email LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  query += ` ORDER BY s.id DESC`;
  const students = await db.all(query, params);
  res.json(students);
});

app.post('/api/admin/students/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body;

  if (!['APPROVED', 'REJECTED', 'INACTIVE', 'PENDING'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  const current = await db.get('SELECT * FROM students WHERE id = ?', [id]);
  if (!current) return res.status(404).json({ error: 'Student not found' });

  await db.run('UPDATE students SET status = ? WHERE id = ?', [status, id]);
  await logAudit(req.user.id, 'CHANGE_STUDENT_STATUS', { status: current.status }, { status }, reason || 'Admin Status Override');

  res.json({ message: `Student status updated to ${status}` });
});

app.put('/api/admin/students/:id', authenticateToken, requireAdmin, upload.single('photo'), async (req, res) => {
  const { id } = req.params;
  const { first_name, middle_name, last_name, email, contact_number, position_id, student_number } = req.body;

  const current = await db.get('SELECT * FROM students WHERE id = ?', [id]);
  if (!current) return res.status(404).json({ error: 'Student not found' });

  let photoPath = current.photo_path;
  if (req.file) {
    photoPath = `/uploads/${req.file.filename}`;
  }

  let finalSN = current.student_number;
  if (student_number && student_number !== current.student_number) {
    const snCheck = await db.get('SELECT id FROM students WHERE student_number = ? AND id != ?', [student_number, id]);
    if (snCheck) return res.status(400).json({ error: 'Student number already in use by another student.' });
    finalSN = student_number;
  }

  await db.run(
    `UPDATE students SET first_name = ?, middle_name = ?, last_name = ?, email = ?, contact_number = ?, position_id = ?, photo_path = ?, student_number = ?
     WHERE id = ?`,
    [first_name, middle_name, last_name, email, contact_number, position_id, photoPath, finalSN, id]
  );

  await logAudit(req.user.id, 'UPDATE_STUDENT', current, { first_name, last_name, email, photoPath, finalSN }, 'Manual Admin Update');
  res.json({ message: 'Student record updated successfully.' });
});

// Settings & Logo Uploads
app.post('/api/admin/settings/logo', authenticateToken, requireAdmin, upload.single('logo'), async (req, res) => {
  const { logo_type } = req.body; // 'school' or 'club'
  if (!['school', 'club'].includes(logo_type)) return res.status(400).json({ error: 'Invalid logo type' });
  if (!req.file) return res.status(400).json({ error: 'Image file required' });

  const logoPath = `/uploads/${req.file.filename}`;
  const key = logo_type === 'school' ? 'school_logo' : 'club_logo';

  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, logoPath]);
  await logAudit(req.user.id, `UPDATE_${logo_type.toUpperCase()}_LOGO`, null, logoPath, 'Logo Upload');

  res.json({ message: 'Logo updated successfully', path: logoPath });
});

app.post('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  const { settings } = req.body; // Key-value map
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'Invalid payload' });

  for (const [k, v] of Object.entries(settings)) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(v)]);
  }

  await logAudit(req.user.id, 'UPDATE_SETTINGS', null, settings, 'System Config Update');
  res.json({ message: 'Settings saved successfully' });
});

// Event Management
app.get('/api/admin/events', authenticateToken, async (req, res) => {
  const events = await db.all('SELECT * FROM events ORDER BY event_date DESC, start_time DESC');
  res.json(events);
});

app.post('/api/admin/events', authenticateToken, requireAdmin, async (req, res) => {
  const { title, description, event_type, event_date, start_time, late_threshold_minutes } = req.body;
  if (!title || !event_date || !start_time) return res.status(400).json({ error: 'Title, Date, and Start Time are required.' });

  const result = await db.run(
    'INSERT INTO events (title, description, event_type, event_date, start_time, late_threshold_minutes) VALUES (?, ?, ?, ?, ?, ?)',
    [title, description || '', event_type || 'Club Meeting', event_date, start_time, late_threshold_minutes || 10]
  );

  res.status(201).json({ message: 'Event created successfully', id: result.lastID });
});

app.put('/api/admin/events/:id/activate', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  await db.run('UPDATE events SET is_active = 0');
  await db.run('UPDATE events SET is_active = 1 WHERE id = ?', [id]);
  res.json({ message: 'Active event switched successfully' });
});

// Manual Attendance Override with Audit Trail
app.post('/api/admin/attendance/override', authenticateToken, requireAdmin, async (req, res) => {
  const { event_id, student_id, scan_type, status, reason } = req.body;

  if (!event_id || !student_id || !scan_type || !status || !reason) {
    return res.status(400).json({ error: 'Event, Student, Scan Type, Status, and Reason are mandatory for manual overrides.' });
  }

  const existing = await db.get(
    'SELECT * FROM attendance WHERE event_id = ? AND student_id = ? AND scan_type = ?',
    [event_id, student_id, scan_type]
  );

  await db.run('BEGIN TRANSACTION');
  if (existing) {
    await db.run(
      'UPDATE attendance SET status = ?, timestamp = CURRENT_TIMESTAMP WHERE id = ?',
      [status, existing.id]
    );
  } else {
    await db.run(
      'INSERT INTO attendance (event_id, student_id, scan_type, status) VALUES (?, ?, ?, ?)',
      [event_id, student_id, scan_type, status]
    );
  }

  await logAudit(req.user.id, 'ATTENDANCE_OVERRIDE', existing || null, { event_id, student_id, scan_type, status }, reason);
  await db.run('COMMIT');

  res.json({ message: 'Attendance record updated successfully.' });
});

// --- SCANNER REAL-TIME ENGINE ---
app.post('/api/scanner/scan', authenticateToken, async (req, res) => {
  try {
    const { qr_token, scan_type = 'IN' } = req.body;
    if (!qr_token) return res.status(400).json({ success: false, message: 'QR Token is required.' });

    const student = await db.get(
      'SELECT s.*, p.name as position_name FROM students s LEFT JOIN positions p ON s.position_id = p.id WHERE s.qr_token = ?',
      [qr_token.trim()]
    );

    if (!student) {
      return res.status(404).json({ success: false, code: 'INVALID_QR', message: 'Unrecognized Student ID Card.' });
    }

    if (student.status !== 'APPROVED') {
      return res.status(403).json({ success: false, code: 'STUDENT_INACTIVE', message: `Access Denied. Student account is ${student.status}.` });
    }

    const activeEvent = await db.get('SELECT * FROM events WHERE is_active = 1 LIMIT 1');
    if (!activeEvent) {
      return res.status(400).json({ success: false, code: 'NO_EVENT', message: 'No active event found for attendance recording.' });
    }

    // Check Duplicate Scan
    const existingScan = await db.get(
      'SELECT * FROM attendance WHERE event_id = ? AND student_id = ? AND scan_type = ?',
      [activeEvent.id, student.id, scan_type]
    );

    if (existingScan) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_SCAN',
        message: `${student.first_name} ${student.last_name}, you are already recorded for ${scan_type === 'IN' ? 'Time In' : 'Time Out'}.`,
        student_name: `${student.first_name} ${student.last_name}`
      });
    }

    // Calculate Status (PRESENT vs LATE)
    let computedStatus = 'PRESENT';
    if (scan_type === 'IN') {
      const now = new Date();
      const [startHour, startMin] = activeEvent.start_time.split(':').map(Number);
      const eventStart = new Date();
      eventStart.setHours(startHour, startMin, 0, 0);

      const lateCutoff = new Date(eventStart.getTime() + activeEvent.late_threshold_minutes * 60000);
      if (now > lateCutoff) {
        computedStatus = 'LATE';
      }
    }

    await db.run('BEGIN TRANSACTION');
    await db.run(
      'INSERT INTO attendance (event_id, student_id, scan_type, status) VALUES (?, ?, ?, ?)',
      [activeEvent.id, student.id, scan_type, computedStatus]
    );
    await db.run('COMMIT');

    const announcementText = `${student.first_name} ${student.last_name}, ${scan_type === 'IN' ? (computedStatus === 'LATE' ? 'Late arrival recorded' : 'Time In recorded') : 'Time Out recorded'}.`;

    res.json({
      success: true,
      message: announcementText,
      student: {
        id: student.id,
        student_number: student.student_number,
        name: `${student.first_name} ${student.last_name}`,
        position: student.position_name,
        photo_path: student.photo_path,
        scan_type,
        status: computedStatus,
        event_title: activeEvent.title
      }
    });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ success: false, message: 'Server transaction failure during scan.' });
  }
});

// --- PDF ID GENERATION ENGINE (HIGH SCANNABILITY, 8/PAGE PRINT LAYOUT) ---
app.post('/api/admin/print-ids', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { student_ids } = req.body; // Array of IDs, or empty/null for ALL APPROVED
    let query = `SELECT s.*, p.name as position_name FROM students s LEFT JOIN positions p ON s.position_id = p.id WHERE s.status = 'APPROVED'`;
    const params = [];

    if (Array.isArray(student_ids) && student_ids.length > 0) {
      query += ` AND s.id IN (${student_ids.map(() => '?').join(',')})`;
      params.push(...student_ids);
    }

    const students = await db.all(query, params);
    if (students.length === 0) return res.status(404).json({ error: 'No valid approved students found to print.' });

    const settingsRows = await db.all('SELECT key, value FROM settings');
    const settings = {};
    settingsRows.forEach(r => settings[r.key] = r.value);

    // PDF Dimension Setup (Standard A4: 595.28 x 841.89 points)
    const doc = new PDFDocument({ size: 'A4', margin: 15 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Student_Club_IDs.pdf"');
    doc.pipe(res);

    // Grid Mechanics: 2 Columns x 4 Rows = 8 IDs per A4 page
    const cardWidth = 265;
    const cardHeight = 180;
    const marginX = 20;
    const marginY = 20;
    const gapX = 25;
    const gapY = 20;

    for (let i = 0; i < students.length; i++) {
      if (i > 0 && i % 8 === 0) {
        doc.addPage();
      }

      const col = i % 2;
      const row = Math.floor((i % 8) / 2);
      const x = marginX + col * (cardWidth + gapX);
      const y = marginY + row * (cardHeight + gapY);

      const student = students[i];

      // ID Background Card Frame
      doc.roundedRect(x, y, cardWidth, cardHeight, 6).lineWidth(1).strokeColor('#1E293B').stroke();
      doc.rect(x, y, cardWidth, 32).fill('#1E3A8A'); // Header bar

      // Header Texts
      doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold').text((settings.school_name || 'SCHOOL NAME').toUpperCase(), x + 5, y + 5, { width: cardWidth - 10, align: 'center' });
      doc.fontSize(7).font('Helvetica').text((settings.club_name || 'STUDENT CLUB ID').toUpperCase(), x + 5, y + 18, { width: cardWidth - 10, align: 'center' });

      // Student Photo
      const photoWidth = 55;
      const photoHeight = 65;
      const photoX = x + 12;
      const photoY = y + 42;

      const fullPhotoPath = path.join(__dirname, student.photo_path);
      if (fs.existsSync(fullPhotoPath)) {
        doc.image(fullPhotoPath, photoX, photoY, { width: photoWidth, height: photoHeight });
      } else {
        doc.rect(photoX, photoY, photoWidth, photoHeight).fillAndStroke('#E2E8F0', '#94A3B8');
        doc.fillColor('#64748B').fontSize(6).text('NO PHOTO', photoX, photoY + 25, { width: photoWidth, align: 'center' });
      }

      // Student Text Info
      const infoX = photoX + photoWidth + 10;
      let infoY = y + 42;

      doc.fillColor('#0F172A').fontSize(10).font('Helvetica-Bold').text(`${student.first_name} ${student.last_name}`, infoX, infoY, { width: 170 });
      infoY += 14;

      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#2563EB').text(`ID: ${student.student_number}`, infoX, infoY);
      infoY += 11;

      doc.fontSize(7.5).font('Helvetica').fillColor('#334155').text(`Pos: ${student.position_name || 'Member'}`, infoX, infoY);
      infoY += 11;

      doc.fontSize(6.5).font('Helvetica').fillColor('#64748B').text(`S.Y.: ${settings.school_year || '2026-2027'}`, infoX, infoY);

      // --- LARGE HIGH-CONTRAST QR CODE GENERATION ---
      // High Error Correction (H) guarantees scannability even with minor print wear
      const qrDataUrl = await QRCode.toDataURL(student.qr_token, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: 250
      });
      const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

      // Prominent QR Placement (Centered Bottom Layout)
      const qrSize = 65;
      const qrX = x + (cardWidth - qrSize) / 2;
      const qrY = y + 108;

      // QR White Quiet-Zone Backdrop
      doc.rect(qrX - 3, qrY - 3, qrSize + 6, qrSize + 6).fill('#FFFFFF');
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    }

    doc.end();
  } catch (err) {
    res.status(500).json({ error: 'PDF Generation Failure: ' + err.message });
  }
});

// --- SINGLE-PAGE APPLICATION FRONTEND BUILD ---
app.get('*', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Club ID & Attendance Portal</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css" rel="stylesheet">
  <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <style>
    :root { --primary-color: #1e3a8a; --accent-color: #2563eb; }
    body { background-color: #f8fafc; font-family: 'Segoe UI', system-ui, sans-serif; }
    .navbar-brand { font-weight: 700; color: var(--primary-color) !important; }
    .card { border: none; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .btn-primary { background-color: var(--accent-color); border: none; }
    .stat-card { border-left: 4px solid var(--accent-color); }
    .id-card-preview {
      width: 320px; height: 210px; border: 2px solid #1e293b; border-radius: 10px;
      background: white; position: relative; padding: 10px; box-shadow: 0 8px 16px rgba(0,0,0,0.1);
    }
    .id-header { background: var(--primary-color); color: white; margin: -10px -10px 10px -10px; padding: 6px; border-radius: 8px 8px 0 0; text-align: center; }
    .qr-large { width: 85px; height: 85px; }
  </style>
</head>
<body>

  <nav class="navbar navbar-expand-lg navbar-light bg-white border-bottom sticky-top">
    <div class="container">
      <a class="navbar-brand" href="#"><i class="bi-card-heading text-primary me-2"></i>CLUB ID & ATTENDANCE</a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navContent"><span class="navbar-toggler-icon"></span></button>
      <div class="collapse navbar-collapse" id="navContent">
        <ul class="navbar-nav me-auto mb-2 mb-lg-0" id="mainNav">
          <li class="nav-item"><a class="nav-link active" href="#" onclick="showSection('public-register')">Register</a></li>
          <li class="nav-item"><a class="nav-link" href="#" onclick="showSection('scanner-portal')">Kiosk Scanner</a></li>
          <li class="nav-item"><a class="nav-link" href="#" onclick="showSection('admin-login')">Admin Portal</a></li>
        </ul>
        <div class="d-flex" id="userNav"></div>
      </div>
    </div>
  </nav>

  <div class="container my-4">

    <!-- PUBLIC REGISTRATION SECTION -->
    <div id="public-register" class="app-section">
      <div class="row justify-content-center">
        <div class="col-md-8 col-lg-6">
          <div class="card p-4">
            <h4 class="card-title fw-bold text-center mb-3 text-primary">Student Registration</h4>
            <p class="text-muted text-center small mb-4">Complete basic details to request your official Student Club ID Card.</p>
            <div id="regAlert"></div>
            <form id="regForm" enctype="multipart/form-data">
              <div class="row g-2 mb-3">
                <div class="col-md-6">
                  <label class="form-label small fw-bold">First Name *</label>
                  <input type="text" class="form-control" name="first_name" required>
                </div>
                <div class="col-md-6">
                  <label class="form-label small fw-bold">Middle Name</label>
                  <input type="text" class="form-control" name="middle_name">
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label small fw-bold">Last Name *</label>
                <input type="text" class="form-control" name="last_name" required>
              </div>
              <div class="mb-3">
                <label class="form-label small fw-bold">Email Address *</label>
                <input type="email" class="form-control" name="email" required placeholder="name@example.com">
              </div>
              <div class="row g-2 mb-3">
                <div class="col-md-6">
                  <label class="form-label small fw-bold">Contact Number</label>
                  <input type="text" class="form-control" name="contact_number">
                </div>
                <div class="col-md-6">
                  <label class="form-label small fw-bold">Club Position *</label>
                  <select class="form-select" name="position_id" id="regPositionSelect" required></select>
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label small fw-bold">Password *</label>
                <input type="password" class="form-control" name="password" required>
              </div>
              <div class="mb-3">
                <label class="form-label small fw-bold">Upload Profile Photo *</label>
                <input type="file" class="form-control" name="photo" accept="image/png, image/jpeg, image/jpg, image/webp" required onchange="previewImage(this, 'photoPreview')">
                <div class="mt-2 text-center">
                  <img id="photoPreview" src="#" alt="Preview" class="rounded d-none border" style="max-height: 120px;">
                </div>
              </div>
              <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Submit Registration</button>
            </form>
          </div>
        </div>
      </div>
    </div>

    <!-- KIOSK SCANNER PORTAL -->
    <div id="scanner-portal" class="app-section d-none">
      <div class="row justify-content-center">
        <div class="col-md-8 text-center">
          <div class="card p-4">
            <h4 class="fw-bold mb-2">Live QR Attendance Kiosk</h4>
            <div class="btn-group mb-3 w-50 mx-auto" role="group">
              <input type="radio" class="btn-check" name="scanType" id="typeIn" value="IN" checked>
              <label class="btn btn-outline-primary" for="typeIn">TIME IN</label>
              <input type="radio" class="btn-check" name="scanType" id="typeOut" value="OUT">
              <label class="btn btn-outline-secondary" for="typeOut">TIME OUT</label>
            </div>
            <div id="reader" style="width: 100%; max-width: 450px; margin: 0 auto;" class="rounded border"></div>
            <div id="scanResult" class="mt-4"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ADMIN LOGIN -->
    <div id="admin-login" class="app-section d-none">
      <div class="row justify-content-center">
        <div class="col-md-5">
          <div class="card p-4">
            <h4 class="fw-bold text-center mb-3">Admin Portal Login</h4>
            <div id="loginAlert"></div>
            <form id="loginForm">
              <div class="mb-3">
                <label class="form-label small fw-bold">Email Address</label>
                <input type="email" class="form-control" id="loginEmail" required>
              </div>
              <div class="mb-3">
                <label class="form-label small fw-bold">Password</label>
                <input type="password" class="form-control" id="loginPassword" required>
              </div>
              <button type="submit" class="btn btn-primary w-100 fw-bold">Sign In</button>
            </form>
          </div>
        </div>
      </div>
    </div>

    <!-- ACCURATE ADMIN DASHBOARD -->
    <div id="admin-dashboard" class="app-section d-none">
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold text-dark">Real-Time Operations Dashboard</h3>
        <div>
          <button class="btn btn-outline-primary me-2" onclick="loadDashboard()"><i class="bi-arrow-clockwise"></i> Refresh</button>
          <button class="btn btn-primary" onclick="printAllIDs()"><i class="bi-printer"></i> Print All IDs (8/A4)</button>
        </div>
      </div>

      <!-- METRICS GRID -->
      <div class="row g-3 mb-4" id="metricsGrid"></div>

      <div class="row g-3">
        <div class="col-lg-8">
          <div class="card p-3 mb-4">
            <h5 class="fw-bold mb-3">Recent Real-Time Scans</h5>
            <div class="table-responsive">
              <table class="table table-hover align-middle small">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>ID Number</th>
                    <th>Position</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody id="recentScansTable"></tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="col-lg-4">
          <div class="card p-3 mb-4">
            <h5 class="fw-bold mb-3">System Settings & Branding</h5>
            <form id="brandingForm" enctype="multipart/form-data">
              <div class="mb-2">
                <label class="form-label small">School Logo</label>
                <input type="file" class="form-control form-control-sm" id="schoolLogoFile" accept="image/*">
              </div>
              <button type="button" class="btn btn-sm btn-secondary w-100 mb-3" onclick="uploadLogo('school')">Upload School Logo</button>
              <div class="mb-2">
                <label class="form-label small">Club Logo</label>
                <input type="file" class="form-control form-control-sm" id="clubLogoFile" accept="image/*">
              </div>
              <button type="button" class="btn btn-sm btn-secondary w-100" onclick="uploadLogo('club')">Upload Club Logo</button>
            </form>
          </div>
        </div>
      </div>
    </div>

  </div>

  <script>
    let authToken = localStorage.getItem('token');
    let html5QrcodeScanner = null;

    function showSection(id) {
      document.querySelectorAll('.app-section').forEach(s => s.classList.add('d-none'));
      document.getElementById(id).classList.remove('d-none');
      if (id === 'scanner-portal') initScanner();
      if (id === 'admin-dashboard') loadDashboard();
    }

    function previewImage(input, targetId) {
      if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = e => {
          const el = document.getElementById(targetId);
          el.src = e.target.result;
          el.classList.remove('d-none');
        };
        reader.readAsDataURL(input.files[0]);
      }
    }

    async function loadPositions() {
      const res = await fetch('/api/public/positions');
      const positions = await res.json();
      const sel = document.getElementById('regPositionSelect');
      sel.innerHTML = positions.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
    }

    document.getElementById('regForm').onsubmit = async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const res = await fetch('/api/public/register', { method: 'POST', body: formData });
      const data = await res.json();
      const alert = document.getElementById('regAlert');
      if (res.ok) {
        alert.innerHTML = \`<div class="alert alert-success">\${data.message} Assigned ID: <strong>\${data.student_number}</strong></div>\`;
        e.target.reset();
      } else {
        alert.innerHTML = \`<div class="alert alert-danger">\${data.error}</div>\`;
      }
    };

    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value;
      const password = document.getElementById('loginPassword').value;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok) {
        authToken = data.token;
        localStorage.setItem('token', authToken);
        showSection('admin-dashboard');
      } else {
        document.getElementById('loginAlert').innerHTML = \`<div class="alert alert-danger">\${data.error}</div>\`;
      }
    };

    async function loadDashboard() {
      if (!authToken) return showSection('admin-login');
      const res = await fetch('/api/admin/dashboard', { headers: { 'Authorization': \`Bearer \${authToken}\` } });
      const data = await res.json();

      const m = data.metrics;
      document.getElementById('metricsGrid').innerHTML = \`
        <div class="col-md-3"><div class="card p-3 stat-card"><div class="text-muted small">Total Students</div><div class="fs-4 fw-bold">\${m.totalStudents}</div></div></div>
        <div class="col-md-3"><div class="card p-3 stat-card"><div class="text-muted small">Active / Pending</div><div class="fs-4 fw-bold text-success">\${m.activeStudents} <span class="fs-6 text-warning">(\${m.pendingRegistrations} Pending)</span></div></div></div>
        <div class="col-md-3"><div class="card p-3 stat-card"><div class="text-muted small">Present / Late Today</div><div class="fs-4 fw-bold text-primary">\${m.presentToday} / \${m.lateToday}</div></div></div>
        <div class="col-md-3"><div class="card p-3 stat-card"><div class="text-muted small">Attendance Rate</div><div class="fs-4 fw-bold text-info">\${m.attendanceRate}%</div></div></div>
      \`;

      const scansTable = document.getElementById('recentScansTable');
      scansTable.innerHTML = data.recentScans.map(s => \`
        <tr>
          <td><strong>\${s.first_name} \${s.last_name}</strong></td>
          <td>\${s.student_number}</td>
          <td>\${s.position_name || 'Member'}</td>
          <td><span class="badge bg-secondary">\${s.scan_type}</span></td>
          <td><span class="badge bg-\${s.status === 'PRESENT' ? 'success' : 'warning'}">\${s.status}</span></td>
          <td>\${new Date(s.timestamp).toLocaleTimeString()}</td>
        </tr>
      \`).join('');
    }

    function initScanner() {
      if (html5QrcodeScanner) return;
      html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: {width: 250, height: 250} });
      html5QrcodeScanner.render(async (decodedText) => {
        const scanType = document.querySelector('input[name="scanType"]:checked').value;
        const res = await fetch('/api/scanner/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${authToken}\` },
          body: JSON.stringify({ qr_token: decodedText, scan_type: scanType })
        });
        const data = await res.json();
        const resultDiv = document.getElementById('scanResult');

        if (res.ok) {
          resultDiv.innerHTML = \`<div class="alert alert-success"><h5>\${data.message}</h5></div>\`;
          speak(data.message);
        } else {
          resultDiv.innerHTML = \`<div class="alert alert-danger"><h5>\${data.message}</h5></div>\`;
          speak(data.message);
        }
      });
    }

    function speak(text) {
      if ('speechSynthesis' in window) {
        const msg = new SpeechSynthesisUtterance(text);
        window.speechSynthesis.speak(msg);
      }
    }

    async function printAllIDs() {
      const res = await fetch('/api/admin/print-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${authToken}\` },
        body: JSON.stringify({ student_ids: [] })
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        window.open(url);
      }
    }

    async function uploadLogo(type) {
      const input = document.getElementById(type === 'school' ? 'schoolLogoFile' : 'clubLogoFile');
      if (!input.files[0]) return alert('Select a file first.');
      const fd = new FormData();
      fd.append('logo', input.files[0]);
      fd.append('logo_type', type);
      const res = await fetch('/api/admin/settings/logo', {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${authToken}\` },
        body: fd
      });
      if (res.ok) alert('Logo uploaded successfully');
    }

    loadPositions();
  </script>
</body>
</html>
  `);
});

// -----------------------------------------------------------------------------
// BOOTSTRAP SYSTEM & SERVER INITIALIZATION
// -----------------------------------------------------------------------------
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(` SCHOOL CLUB REAL-TIME ID & ATTENDANCE SYSTEM RUNNING ON PORT ${PORT}`);
    console.log(` Access Local Engine: http://localhost:${PORT}`);
    console.log(` Persistent Storage Directory: ${DATA_DIR}`);
    console.log(`================================================================`);
  });
}).catch(err => {
  console.error('Fatal Database Engine Error:', err);
});
