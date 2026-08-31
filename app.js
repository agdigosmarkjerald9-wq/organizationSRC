/**
 * ====================================================================================
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Primary File: app.js
 * Architecture: Node.js / Express.js / SQLite3 / Embedded EJS Engine / HTML5 Web APIs
 * ====================================================================================
 */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'photo-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only images (jpeg, jpg, png, webp) are allowed!'));
  }
});

// Database Initialization
const dbPath = path.join(__dirname, 'attendance_system.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database Connection Error:', err);
  else console.log('SQLite Database Connected Successfully.');
});

// Enable PRAGMA foreign keys
db.run('PRAGMA foreign_keys = ON');

// App Middleware Configuration
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: 'club_qr_attendance_secret_key_2026_x90a1',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 Hours
}));

/**
 * ====================================================================================
 * DATABASE SCHEMA SETUP
 * Strictly NO Committee, Grade Level, Year Level, or Section fields.
 * ====================================================================================
 */
db.serialize(() => {
  // Users Table (Admin, Scanner, Student)
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ADMIN', 'SCANNER', 'STUDENT')),
    student_id TEXT UNIQUE,
    full_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Positions Table
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Students Table
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    position_id INTEGER NOT NULL,
    student_club TEXT NOT NULL,
    school_year TEXT NOT NULL,
    gender TEXT,
    date_of_birth TEXT,
    contact_number TEXT,
    school_email TEXT,
    address TEXT,
    photo_url TEXT,
    date_joined TEXT NOT NULL,
    membership_status TEXT NOT NULL DEFAULT 'Active' CHECK(membership_status IN ('Active', 'Inactive', 'Suspended', 'Alumni', 'Resigned')),
    membership_expiration_date TEXT,
    parent_name TEXT,
    parent_contact TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(position_id) REFERENCES positions(id)
  )`);

  // Position History Table
  db.run(`CREATE TABLE IF NOT EXISTS position_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    position_id INTEGER NOT NULL,
    school_year TEXT NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(position_id) REFERENCES positions(id)
  )`);

  // QR Codes Table
  db.run(`CREATE TABLE IF NOT EXISTS qr_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    qr_token TEXT UNIQUE NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Events Table
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    description TEXT,
    event_type TEXT NOT NULL,
    event_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    location TEXT NOT NULL,
    organizer TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Upcoming' CHECK(status IN ('Upcoming', 'Active', 'Completed', 'Cancelled')),
    target_audience TEXT NOT NULL DEFAULT 'ALL', -- ALL, OFFICERS_ONLY, SPECIFIC_POSITIONS
    allowed_positions TEXT, -- Comma-separated position IDs if target_audience == SPECIFIC_POSITIONS
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Attendance Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_id TEXT NOT NULL,
    time_in DATETIME,
    time_out DATETIME,
    status TEXT NOT NULL CHECK(status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
    scanned_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, student_id),
    FOREIGN KEY(event_id) REFERENCES events(id)
  )`);

  // Excuses Table
  db.run(`CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attendance_id INTEGER UNIQUE NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT NOT NULL,
    date_approved DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(attendance_id) REFERENCES attendance(id)
  )`);

  // System Settings Table
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed Initial Default Data
  seedInitialData();
});

function seedInitialData() {
  // Default Settings
  const defaults = {
    school_name: 'ABC National High School',
    school_logo: '/images/default_school_logo.png',
    club_name: 'Computer Club',
    organization_name: 'Student Tech Association',
    club_adviser: 'Mr. John Doe',
    school_year: '2026–2027',
    late_threshold_minutes: '15',
    participation_threshold_pct: '75',
    scanner_sound: 'true',
    voice_announcement: 'true',
    voice_volume: '1.0',
    voice_rate: '1.0'
  };

  for (const [key, val] of Object.entries(defaults)) {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, val]);
  }

  // Default Positions
  const positions = [
    'President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor',
    'Public Information Officer', 'Peace Officer', 'Sergeant-at-Arms',
    'Representative', 'Event Coordinator', 'Technical Head', 'Documentation Officer', 'Member'
  ];

  positions.forEach(pos => {
    db.run(`INSERT OR IGNORE INTO positions (title, description) VALUES (?, ?)`, [pos, `Default role: ${pos}`]);
  });

  // Default Admin User (admin / admin123)
  db.get(`SELECT * FROM users WHERE username = 'admin'`, async (err, user) => {
    if (!user) {
      const hashed = await bcrypt.hash('admin123', 10);
      db.run(`INSERT INTO users (username, password, role, full_name) VALUES (?, ?, 'ADMIN', 'System Administrator')`, ['admin', hashed]);
      console.log('Seeded Default Admin Account: admin / admin123');
    }
  });

  // Default Scanner User (scanner / scanner123)
  db.get(`SELECT * FROM users WHERE username = 'scanner'`, async (err, user) => {
    if (!user) {
      const hashed = await bcrypt.hash('scanner123', 10);
      db.run(`INSERT INTO users (username, password, role, full_name) VALUES (?, ?, 'SCANNER', 'Officer Scanner Account')`, ['scanner', hashed]);
      console.log('Seeded Default Scanner Account: scanner / scanner123');
    }
  });
}

/**
 * ====================================================================================
 * HELPER FUNCTIONS & MIDDLEWARE
 * ====================================================================================
 */
function logAudit(req, action, details) {
  const username = req.session.user ? req.session.user.username : 'SYSTEM';
  const role = req.session.user ? req.session.user.role : 'ANONYMOUS';
  const userId = req.session.user ? req.session.user.id : null;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  db.run(
    `INSERT INTO audit_logs (user_id, username, role, action, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, username, role, action, details, ip]
  );
}

function requireAuth(roles = []) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (roles.length > 0 && !roles.includes(req.session.user.role)) {
      return res.status(403).send('Forbidden: Insufficient privileges.');
    }
    next();
  };
}

async function getSettingsMap() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT key, value FROM settings`, [], (err, rows) => {
      if (err) return reject(err);
      const map = {};
      rows.forEach(r => map[r.key] = r.value);
      resolve(map);
    });
  });
}

/**
 * ====================================================================================
 * AUTHENTICATION & PROFILE ROUTES
 * ====================================================================================
 */
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'ADMIN') return res.redirect('/admin/dashboard');
    if (req.session.user.role === 'SCANNER') return res.redirect('/scanner');
    if (req.session.user.role === 'STUDENT') return res.redirect('/member');
  }
  res.send(renderLoginPage(null));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.send(renderLoginPage('Username and password are required.'));
  }

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) {
      return res.send(renderLoginPage('Invalid username or password.'));
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.send(renderLoginPage('Invalid username or password.'));
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      student_id: user.student_id,
      full_name: user.full_name
    };

    logAudit(req, 'LOGIN', `User ${user.username} logged in successfully as ${user.role}`);

    if (user.role === 'ADMIN') return res.redirect('/admin/dashboard');
    if (user.role === 'SCANNER') return res.redirect('/scanner');
    if (user.role === 'STUDENT') return res.redirect('/member');
  });
});

app.get('/logout', (req, res) => {
  if (req.session.user) {
    logAudit(req, 'LOGOUT', `User ${req.session.user.username} logged out`);
  }
  req.session.destroy(() => res.redirect('/login'));
});

app.post('/api/change-password', requireAuth(), async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ success: false, message: 'New passwords do not match.' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
  }

  db.get(`SELECT password FROM users WHERE id = ?`, [req.session.user.id], async (err, user) => {
    if (err || !user) return res.status(500).json({ success: false, message: 'Database error.' });

    const match = await bcrypt.compare(current_password, user.password);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Incorrect current password.' });
    }

    const newHashed = await bcrypt.hash(new_password, 10);
    db.run(`UPDATE users SET password = ? WHERE id = ?`, [newHashed, req.session.user.id], (err2) => {
      if (err2) return res.status(500).json({ success: false, message: 'Failed to update password.' });
      logAudit(req, 'CHANGE_PASSWORD', 'Successfully updated account password');
      return res.json({ success: true, message: 'Password changed successfully!' });
    });
  });
});

/**
 * ====================================================================================
 * ADMIN DASHBOARD & ANALYTICS
 * ====================================================================================
 */
app.get('/admin/dashboard', requireAuth(['ADMIN']), async (req, res) => {
  const settings = await getSettingsMap();

  db.all(`SELECT 
    (SELECT COUNT(*) FROM students) as total_students,
    (SELECT COUNT(*) FROM students WHERE membership_status = 'Active') as active_students,
    (SELECT COUNT(*) FROM students WHERE membership_status != 'Active') as inactive_students,
    (SELECT COUNT(*) FROM students s JOIN positions p ON s.position_id = p.id WHERE p.title != 'Member') as total_officers,
    (SELECT COUNT(*) FROM events WHERE status = 'Active') as active_events_count
  `, [], (err, counts) => {
    const stats = counts[0] || {};

    // Get Active Event Details & Attendance Summary
    db.get(`SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1`, [], (err, activeEvent) => {
      let activeEventData = activeEvent || null;

      db.all(`
        SELECT a.*, s.full_name, s.student_id as sid, p.title as position_title, e.event_name 
        FROM attendance a 
        JOIN students s ON a.student_id = s.student_id 
        JOIN positions p ON s.position_id = p.id
        JOIN events e ON a.event_id = e.id
        ORDER BY a.created_at DESC LIMIT 10
      `, [], (err, recentScans) => {

        res.send(renderAdminDashboard({
          user: req.session.user,
          settings,
          stats,
          activeEvent: activeEventData,
          recentScans: recentScans || []
        }));
      });
    });
  });
});

app.get('/api/analytics/summary', requireAuth(['ADMIN']), (req, res) => {
  db.all(`
    SELECT status, COUNT(*) as count 
    FROM attendance 
    GROUP BY status
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

/**
 * ====================================================================================
 * POSITION MANAGEMENT ROUTES
 * ====================================================================================
 */
app.get('/admin/positions', requireAuth(['ADMIN']), async (req, res) => {
  const settings = await getSettingsMap();
  db.all(`
    SELECT p.*, COUNT(s.id) as student_count 
    FROM positions p 
    LEFT JOIN students s ON p.id = s.position_id 
    GROUP BY p.id 
    ORDER BY p.title ASC
  `, [], (err, positions) => {
    res.send(renderPositionManagementPage({ user: req.session.user, settings, positions: positions || [] }));
  });
});

app.post('/admin/positions/add', requireAuth(['ADMIN']), (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'Position title required.' });

  db.run(`INSERT INTO positions (title, description) VALUES (?, ?)`, [title.trim(), description], function (err) {
    if (err) return res.status(400).json({ success: false, message: 'Position title already exists.' });
    logAudit(req, 'CREATE_POSITION', `Created position: ${title}`);
    res.json({ success: true, message: 'Position created successfully.' });
  });
});

app.post('/admin/positions/edit', requireAuth(['ADMIN']), (req, res) => {
  const { id, title, description } = req.body;
  if (!id || !title) return res.status(400).json({ success: false, message: 'Invalid payload.' });

  db.run(`UPDATE positions SET title = ?, description = ? WHERE id = ?`, [title.trim(), description, id], function (err) {
    if (err) return res.status(400).json({ success: false, message: 'Position title conflict or error.' });
    logAudit(req, 'EDIT_POSITION', `Updated position ID ${id} to ${title}`);
    res.json({ success: true, message: 'Position updated successfully.' });
  });
});

app.post('/admin/positions/delete', requireAuth(['ADMIN']), (req, res) => {
  const { id } = req.body;
  db.get(`SELECT COUNT(*) as count FROM students WHERE position_id = ?`, [id], (err, row) => {
    if (row && row.count > 0) {
      return res.status(400).json({ success: false, message: 'Cannot delete position assigned to active students.' });
    }
    db.run(`DELETE FROM positions WHERE id = ?`, [id], (err2) => {
      if (err2) return res.status(500).json({ success: false, message: 'Deletion failed.' });
      logAudit(req, 'DELETE_POSITION', `Deleted position ID ${id}`);
      res.json({ success: true, message: 'Position deleted successfully.' });
    });
  });
});

/**
 * ====================================================================================
 * STUDENT MANAGEMENT & REGISTRATION ROUTES
 * ====================================================================================
 */
app.get('/admin/students', requireAuth(['ADMIN']), async (req, res) => {
  const settings = await getSettingsMap();
  db.all(`
    SELECT s.*, p.title as position_title, q.qr_token, q.is_active as qr_active 
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    LEFT JOIN qr_codes q ON s.student_id = q.student_id 
    ORDER BY s.last_name ASC
  `, [], (err, students) => {
    db.all(`SELECT * FROM positions ORDER BY title ASC`, [], (err2, positions) => {
      res.send(renderStudentManagementPage({ user: req.session.user, settings, students: students || [], positions: positions || [] }));
    });
  });
});

app.post('/admin/students/add', requireAuth(['ADMIN']), upload.single('photo'), async (req, res) => {
  const {
    student_id, first_name, middle_name, last_name, position_id,
    gender, date_of_birth, contact_number, school_email, address,
    date_joined, membership_status, membership_expiration_date,
    parent_name, parent_contact, password
  } = req.body;

  if (!student_id || !first_name || !last_name || !position_id || !date_joined) {
    return res.status(400).json({ success: false, message: 'Missing mandatory fields.' });
  }

  const settings = await getSettingsMap();
  const fullName = `${last_name}, ${first_name} ${middle_name ? middle_name[0] + '.' : ''}`.trim();
  const photoUrl = req.file ? `/uploads/${req.file.filename}` : '/images/default_avatar.png';

  // Check unique student ID
  db.get(`SELECT student_id FROM students WHERE student_id = ?`, [student_id], async (err, existing) => {
    if (existing) {
      return res.status(400).json({ success: false, message: 'Student ID already exists in the system.' });
    }

    db.run(`
      INSERT INTO students (
        student_id, first_name, middle_name, last_name, full_name, position_id,
        student_club, school_year, gender, date_of_birth, contact_number, school_email,
        address, photo_url, date_joined, membership_status, membership_expiration_date,
        parent_name, parent_contact
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      student_id.trim(), first_name.trim(), middle_name ? middle_name.trim() : '', last_name.trim(), fullName, position_id,
      settings.club_name, settings.school_year, gender, date_of_birth, contact_number, school_email,
      address, photoUrl, date_joined, membership_status || 'Active', membership_expiration_date,
      parent_name, parent_contact
    ], async function (err2) {
      if (err2) return res.status(500).json({ success: false, message: 'Failed to insert student record: ' + err2.message });

      // Record Position History
      db.run(`INSERT INTO position_history (student_id, position_id, school_year) VALUES (?, ?, ?)`,
        [student_id.trim(), position_id, settings.school_year]);

      // Generate Secure QR Code Token
      const qrToken = 'QR-' + crypto.randomBytes(16).toString('hex').toUpperCase();
      db.run(`INSERT INTO qr_codes (student_id, qr_token, is_active) VALUES (?, ?, 1)`, [student_id.trim(), qrToken]);

      // Create Student Login Credentials
      const userPass = password && password.length >= 8 ? password : 'Student@' + student_id.trim();
      const hashedPass = await bcrypt.hash(userPass, 10);
      db.run(`INSERT INTO users (username, password, role, student_id, full_name) VALUES (?, ?, 'STUDENT', ?, ?)`,
        [student_id.trim(), hashedPass, student_id.trim(), fullName]);

      logAudit(req, 'REGISTER_STUDENT', `Registered student: ${fullName} (${student_id})`);
      res.json({ success: true, message: 'Student registered successfully!' });
    });
  });
});

app.post('/admin/students/edit', requireAuth(['ADMIN']), upload.single('photo'), async (req, res) => {
  const {
    id, student_id, first_name, middle_name, last_name, position_id,
    gender, date_of_birth, contact_number, school_email, address,
    membership_status, membership_expiration_date, parent_name, parent_contact
  } = req.body;

  const settings = await getSettingsMap();
  const fullName = `${last_name}, ${first_name} ${middle_name ? middle_name[0] + '.' : ''}`.trim();

  db.get(`SELECT position_id, photo_url FROM students WHERE id = ?`, [id], (err, currentStudent) => {
    if (!currentStudent) return res.status(404).json({ success: false, message: 'Student not found.' });

    const photoUrl = req.file ? `/uploads/${req.file.filename}` : currentStudent.photo_url;

    db.run(`
      UPDATE students SET 
        first_name = ?, middle_name = ?, last_name = ?, full_name = ?, position_id = ?,
        gender = ?, date_of_birth = ?, contact_number = ?, school_email = ?, address = ?,
        photo_url = ?, membership_status = ?, membership_expiration_date = ?,
        parent_name = ?, parent_contact = ?
      WHERE id = ?
    `, [
      first_name, middle_name, last_name, fullName, position_id,
      gender, date_of_birth, contact_number, school_email, address,
      photoUrl, membership_status, membership_expiration_date, parent_name, parent_contact, id
    ], (err2) => {
      if (err2) return res.status(500).json({ success: false, message: 'Update failed.' });

      // Track Position Change in History if modified
      if (parseInt(currentStudent.position_id) !== parseInt(position_id)) {
        db.run(`INSERT INTO position_history (student_id, position_id, school_year) VALUES (?, ?, ?)`,
          [student_id, position_id, settings.school_year]);
      }

      // Update Full Name in Users table
      db.run(`UPDATE users SET full_name = ? WHERE student_id = ?`, [fullName, student_id]);

      logAudit(req, 'EDIT_STUDENT', `Updated student details: ${student_id}`);
      res.json({ success: true, message: 'Student information updated.' });
    });
  });
});

app.post('/admin/students/delete', requireAuth(['ADMIN']), (req, res) => {
  const { student_id } = req.body;
  db.run(`DELETE FROM students WHERE student_id = ?`, [student_id], (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Deletion failed.' });
    db.run(`DELETE FROM qr_codes WHERE student_id = ?`, [student_id]);
    db.run(`DELETE FROM users WHERE student_id = ?`, [student_id]);
    db.run(`DELETE FROM attendance WHERE student_id = ?`, [student_id]);
    logAudit(req, 'DELETE_STUDENT', `Deleted student & linked data: ${student_id}`);
    res.json({ success: true, message: 'Student and related records deleted.' });
  });
});

/**
 * ====================================================================================
 * QR CODE & PRINTING MANAGEMENT (A4 - EXACT 8 CARDS PER SHEET)
 * ====================================================================================
 */
app.post('/admin/qr/regenerate', requireAuth(['ADMIN']), (req, res) => {
  const { student_id } = req.body;
  const newToken = 'QR-' + crypto.randomBytes(16).toString('hex').toUpperCase();

  db.run(`UPDATE qr_codes SET qr_token = ?, is_active = 1, generated_at = CURRENT_TIMESTAMP WHERE student_id = ?`,
    [newToken, student_id], (err) => {
      if (err) return res.status(500).json({ success: false, message: 'Failed to regenerate QR.' });
      logAudit(req, 'REGENERATE_QR', `Regenerated QR token for ${student_id}`);
      res.json({ success: true, token: newToken, message: 'QR Code regenerated successfully.' });
    });
});

app.post('/admin/qr/toggle', requireAuth(['ADMIN']), (req, res) => {
  const { student_id, is_active } = req.body;
  db.run(`UPDATE qr_codes SET is_active = ? WHERE student_id = ?`, [is_active ? 1 : 0, student_id], (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Failed to toggle status.' });
    logAudit(req, 'TOGGLE_QR', `Toggled QR active state to ${is_active} for ${student_id}`);
    res.json({ success: true, message: `QR status updated.` });
  });
});

// A4 Printing Portal Route (Exactly 8 Cards arranged on A4 sheets)
app.get('/admin/print-ids', requireAuth(['ADMIN']), async (req, res) => {
  const settings = await getSettingsMap();
  const selectedIds = req.query.ids ? req.query.ids.split(',') : null;

  let query = `
    SELECT s.*, p.title as position_title, q.qr_token 
    FROM students s 
    JOIN positions p ON s.position_id = p.id 
    JOIN qr_codes q ON s.student_id = q.student_id 
    WHERE q.is_active = 1
  `;
  const params = [];

  if (selectedIds && selectedIds.length > 0) {
    query += ` AND s.student_id IN (${selectedIds.map(() => '?').join(',')})`;
    params.push(...selectedIds);
  }

  query += ` ORDER BY s.last_name ASC`;

  db.all(query, params, async (err, students) => {
    if (err) return res.status(500).send('Error fetching ID records.');

    // Pre-render QR Code Data URLs for print view
    const cardDataList = await Promise.all(students.map(async (st) => {
      const qrDataUrl = await QRCode.toDataURL(st.qr_token, { margin: 1, width: 150 });
      return { ...st, qrDataUrl };
    }));

    res.send(renderA4PrintLayout({ settings, cards: cardDataList }));
  });
});

/**
 * ====================================================================================
 * EVENT MANAGEMENT ROUTES
 * ====================================================================================
 */
app.get('/admin/events', requireAuth(['ADMIN']), async (req, res) => {
  const settings = await getSettingsMap();
  db.all(`SELECT * FROM events ORDER BY event_date DESC, start_time DESC`, [], (err, events) => {
    db.all(`SELECT * FROM positions ORDER BY title ASC`, [], (err2, positions) => {
      res.send(renderEventManagementPage({ user: req.session.user, settings, events: events || [], positions: positions || [] }));
    });
  });
});

app.post('/admin/events/add', requireAuth(['ADMIN']), (req, res) => {
  const { event_name, description, event_type, event_date, start_time, end_time, location, organizer, target_audience, allowed_positions } = req.body;

  if (!event_name || !event_date || !start_time || !end_time || !location) {
    return res.status(400).json({ success: false, message: 'All mandatory fields required.' });
  }

  const allowedPosStr = Array.isArray(allowed_positions) ? allowed_positions.join(',') : allowed_positions || '';

  db.run(`
    INSERT INTO events (event_name, description, event_type, event_date, start_time, end_time, location, organizer, status, target_audience, allowed_positions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Upcoming', ?, ?)
  `, [event_name, description, event_type, event_date, start_time, end_time, location, organizer, target_audience || 'ALL', allowedPosStr], function (err) {
    if (err) return res.status(500).json({ success: false, message: 'Event creation failed.' });
    logAudit(req, 'CREATE_EVENT', `Created event: ${event_name}`);
    res.json({ success: true, message: 'Event scheduled successfully.' });
  });
});

app.post('/admin/events/update-status', requireAuth(['ADMIN']), (req, res) => {
  const { event_id, status } = req.body;

  // Ensure only one event is Active at a time if status is set to Active
  if (status === 'Active') {
    db.run(`UPDATE events SET status = 'Completed' WHERE status = 'Active'`, () => {
      setEventStatus(event_id, status, req, res);
    });
  } else {
    setEventStatus(event_id, status, req, res);
  }
});

function setEventStatus(eventId, status, req, res) {
  db.run(`UPDATE events SET status = ? WHERE id = ?`, [status, eventId], (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Status update failed.' });

    // Auto-mark Absent students when an Event is set to Completed
    if (status === 'Completed') {
      finalizeEventAbsentees(eventId);
    }

    logAudit(req, 'UPDATE_EVENT_STATUS', `Set event ID ${eventId} to ${status}`);
    res.json({ success: true, message: `Event status changed to ${status}.` });
  });
}

function finalizeEventAbsentees(eventId) {
  db.get(`SELECT * FROM events WHERE id = ?`, [eventId], (err, ev) => {
    if (!ev) return;

    let studentQuery = `SELECT student_id FROM students WHERE membership_status = 'Active'`;
    let params = [];

    if (ev.target_audience === 'OFFICERS_ONLY') {
      studentQuery += ` AND position_id IN (SELECT id FROM positions WHERE title != 'Member')`;
    } else if (ev.target_audience === 'SPECIFIC_POSITIONS' && ev.allowed_positions) {
      const pIds = ev.allowed_positions.split(',');
      studentQuery += ` AND position_id IN (${pIds.map(() => '?').join(',')})`;
      params.push(...pIds);
    }

    db.all(studentQuery, params, (err2, expectedStudents) => {
      if (!expectedStudents) return;

      expectedStudents.forEach(st => {
        db.run(`
          INSERT OR IGNORE INTO attendance (event_id, student_id, status, time_in)
          VALUES (?, ?, 'ABSENT', NULL)
        `, [eventId, st.student_id]);
      });
    });
  });
}

/**
 * ====================================================================================
 * SCANNER PORTAL & REAL-TIME QR PROCESSING ENGINE
 * Separate Route: /scanner with WebCam API, Chimes, and Voice Speech Synthesis
 * ====================================================================================
 */
app.get('/scanner', requireAuth(['ADMIN', 'SCANNER']), async (req, res) => {
  const settings = await getSettingsMap();
  db.all(`SELECT * FROM events WHERE status IN ('Active', 'Upcoming') ORDER BY status ASC, event_date ASC`, [], (err, events) => {
    res.send(renderScannerPortalPage({ user: req.session.user, settings, events: events || [] }));
  });
});

// Process Scanning Endpoint
app.post('/api/scanner/scan', requireAuth(['ADMIN', 'SCANNER']), async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body; // scan_type: 'TIME_IN' or 'TIME_OUT'

  if (!qr_token || !event_id) {
    return res.json({ result: 'INVALID', message: 'Invalid scan request.' });
  }

  const settings = await getSettingsMap();

  // 1. Verify Event
  db.get(`SELECT * FROM events WHERE id = ? AND status = 'Active'`, [event_id], (err, ev) => {
    if (err || !ev) {
      return res.json({ result: 'INVALID', message: 'Selected event is not currently Active.' });
    }

    // 2. Validate QR Code & Token
    db.get(`SELECT q.*, s.student_id, s.full_name, s.photo_url, s.position_id, p.title as position_title 
            FROM qr_codes q 
            JOIN students s ON q.student_id = s.student_id 
            JOIN positions p ON s.position_id = p.id
            WHERE q.qr_token = ?`, [qr_token], (err2, student) => {

      if (err2 || !student) {
        return res.json({ result: 'INVALID', message: 'Invalid QR Code token.' });
      }

      if (student.is_active !== 1) {
        return res.json({ result: 'DISABLED', message: 'This QR Code has been disabled by management.', student_name: student.full_name });
      }

      const now = new Date();
      const timeStr = now.toTimeString().split(' ')[0];

      // Check Existing Attendance
      db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student.student_id], (err3, att) => {

        if (scan_type === 'TIME_IN') {
          if (att && att.time_in) {
            return res.json({
              result: 'DUPLICATE',
              message: 'Already recorded for this event.',
              student: {
                full_name: student.full_name,
                student_id: student.student_id,
                position_title: student.position_title,
                photo_url: student.photo_url,
                time_in: att.time_in,
                status: att.status
              }
            });
          }

          // Calculate Late Status based on Event Start Time and Late Threshold
          const eventStart = new Date(`${ev.event_date}T${ev.start_time}`);
          const lateThresholdMins = parseInt(settings.late_threshold_minutes || '15', 10);
          const lateCutoff = new Date(eventStart.getTime() + lateThresholdMins * 60000);

          const computedStatus = now > lateCutoff ? 'LATE' : 'PRESENT';

          db.run(`
            INSERT INTO attendance (event_id, student_id, time_in, status, scanned_by)
            VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)
            ON CONFLICT(event_id, student_id) DO UPDATE SET
              time_in = CURRENT_TIMESTAMP,
              status = excluded.status,
              scanned_by = excluded.scanned_by
          `, [event_id, student.student_id, computedStatus, req.session.user.username], function (err4) {
            if (err4) return res.json({ result: 'ERROR', message: 'Database writing failure.' });

            logAudit(req, 'SCAN_TIME_IN', `Time In scanned for ${student.full_name} (${student.student_id}) - ${computedStatus}`);

            return res.json({
              result: 'SUCCESS',
              message: `Time In Recorded (${computedStatus})`,
              status: computedStatus,
              student: {
                full_name: student.full_name,
                student_id: student.student_id,
                position_title: student.position_title,
                photo_url: student.photo_url,
                time_in: timeStr
              }
            });
          });

        } else if (scan_type === 'TIME_OUT') {
          if (!att || !att.time_in) {
            return res.json({ result: 'ERROR', message: 'Cannot Time Out without an initial Time In record.' });
          }
          if (att.time_out) {
            return res.json({
              result: 'DUPLICATE',
              message: 'Time Out already recorded previously.',
              student: {
                full_name: student.full_name,
                student_id: student.student_id,
                position_title: student.position_title,
                photo_url: student.photo_url,
                time_in: att.time_in,
                time_out: att.time_out,
                status: att.status
              }
            });
          }

          db.run(`UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = ?`, [att.id], (err4) => {
            if (err4) return res.json({ result: 'ERROR', message: 'Failed to update Time Out.' });

            logAudit(req, 'SCAN_TIME_OUT', `Time Out scanned for ${student.full_name} (${student.student_id})`);

            return res.json({
              result: 'SUCCESS_TIMEOUT',
              message: 'Time Out Recorded Successfully',
              status: att.status,
              student: {
                full_name: student.full_name,
                student_id: student.student_id,
                position_title: student.position_title,
                photo_url: student.photo_url,
                time_out: timeStr
              }
            });
          });
        }
      });
    });
  });
});

/**
 * ====================================================================================
 * REPORTS & ANALYTICS MODULE
 * Printable, Filterable, Exportable (CSV/Print)
 * ====================================================================================
 */
app.get('/admin/reports', requireAuth(['ADMIN']), async (req, res) => {
  const settings = await getSettingsMap();
  const { event_id, position_id, status, date_from, date_to } = req.query;

  let query = `
    SELECT a.*, s.full_name, s.student_id as sid, p.title as position_title, e.event_name, e.event_date, ex.reason as excuse_reason
    FROM attendance a
    JOIN students s ON a.student_id = s.student_id
    JOIN positions p ON s.position_id = p.id
    JOIN events e ON a.event_id = e.id
    LEFT JOIN excuses ex ON a.id = ex.attendance_id
    WHERE 1=1
  `;
  const params = [];

  if (event_id) { query += ` AND a.event_id = ?`; params.push(event_id); }
  if (position_id) { query += ` AND s.position_id = ?`; params.push(position_id); }
  if (status) { query += ` AND a.status = ?`; params.push(status); }
  if (date_from) { query += ` AND e.event_date >= ?`; params.push(date_from); }
  if (date_to) { query += ` AND e.event_date <= ?`; params.push(date_to); }

  query += ` ORDER BY a.created_at DESC`;

  db.all(query, params, (err, records) => {
    db.all(`SELECT * FROM events ORDER BY event_date DESC`, [], (err2, events) => {
      db.all(`SELECT * FROM positions ORDER BY title ASC`, [], (err3, positions) => {
        res.send(renderReportsPage({
          user: req.session.user,
          settings,
          records: records || [],
          events: events || [],
          positions: positions || [],
          filters: req.query
        }));
      });
    });
  });
});

app.post('/admin/attendance/excuse', requireAuth(['ADMIN']), (req, res) => {
  const { attendance_id, reason, notes } = req.body;
  if (!attendance_id || !reason) {
    return res.status(400).json({ success: false, message: 'Reason is required.' });
  }

  db.run(`UPDATE attendance SET status = 'EXCUSED' WHERE id = ?`, [attendance_id], (err) => {
    if (err) return res.status(500).json({ success: false, message: 'Update failed.' });

    db.run(`INSERT OR REPLACE INTO excuses (attendance_id, reason, notes, approved_by) VALUES (?, ?, ?, ?)`,
      [attendance_id, reason, notes, req.session.user.full_name], (err2) => {
        logAudit(req, 'EXCUSE_ABSENCE', `Marked attendance record ${attendance_id} as EXCUSED`);
        res.json({ success: true, message: 'Absence excuse approved.' });
      });
  });
});

/**
 * ====================================================================================
 * STUDENT PORTAL MODULE (/member)
 * Digital ID, QR Code Display, Personal Attendance History, Participation Rate
 * ====================================================================================
 */
app.get('/member', requireAuth(['STUDENT']), async (req, res) => {
  const settings = await getSettingsMap();
  const studentId = req.session.user.student_id;

  db.get(`
    SELECT s.*, p.title as position_title, q.qr_token, q.is_active as qr_active
    FROM students s
    JOIN positions p ON s.position_id = p.id
    LEFT JOIN qr_codes q ON s.student_id = q.student_id
    WHERE s.student_id = ?
  `, [studentId], async (err, student) => {
    if (err || !student) return res.status(404).send('Student profile not found.');

    const qrDataUrl = await QRCode.toDataURL(student.qr_token || 'INVALID', { width: 220, margin: 1 });

    // Attendance History & Participation Rate Statistics
    db.all(`
      SELECT a.*, e.event_name, e.event_date, e.location, ex.reason as excuse_reason
      FROM attendance a
      JOIN events e ON a.event_id = e.id
      LEFT JOIN excuses ex ON a.id = ex.attendance_id
      WHERE a.student_id = ?
      ORDER BY e.event_date DESC
    `, [studentId], (err2, history) => {

      db.get(`SELECT COUNT(*) as total_events FROM events WHERE status = 'Completed'`, [], (err3, totalEv) => {
        const total = totalEv ? totalEv.total_events : 0;
        const attended = history.filter(h => h.status === 'PRESENT' || h.status === 'LATE').length;
        const rate = total > 0 ? Math.round((attended / total) * 100) : 100;

        res.send(renderStudentPortalPage({
          user: req.session.user,
          settings,
          student,
          qrDataUrl,
          history: history || [],
          stats: { total, attended, rate }
        }));
      });
    });
  });
});

/**
 * ====================================================================================
 * SYSTEM SETTINGS, BACKUP & RESTORE MODULE
 * ====================================================================================
 */
app.get('/admin/settings', requireAuth(['ADMIN']), async (req, res) => {
  const settings = await getSettingsMap();
  res.send(renderSettingsPage({ user: req.session.user, settings }));
});

app.post('/admin/settings/save', requireAuth(['ADMIN']), upload.single('school_logo'), async (req, res) => {
  const fields = [
    'school_name', 'club_name', 'organization_name', 'club_adviser',
    'school_year', 'late_threshold_minutes', 'participation_threshold_pct',
    'voice_announcement', 'voice_volume', 'voice_rate'
  ];

  for (field of fields) {
    if (req.body[field] !== undefined) {
      db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [field, req.body[field]]);
    }
  }

  if (req.file) {
    const logoUrl = `/uploads/${req.file.filename}`;
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('school_logo', ?)`, [logoUrl]);
  }

  logAudit(req, 'UPDATE_SETTINGS', 'Updated system configuration parameters');
  res.redirect('/admin/settings');
});

app.get('/admin/backup/download', requireAuth(['ADMIN']), (req, res) => {
  logAudit(req, 'BACKUP_DB', 'Downloaded SQLite database backup');
  res.download(dbPath, `backup_attendance_${Date.now()}.sqlite`);
});

/**
 * ====================================================================================
 * HTML UI TEMPLATE RENDERERS (EMBEDDED VIEWS & COMPONENT ENGINE)
 * Completely Responsive, Standard Modern CSS Framework
 * ====================================================================================
 */

function getCommonHead(title) {
  return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css" rel="stylesheet">
    <style>
      :root { --sidebar-width: 260px; --primary-color: #1e3a8a; }
      body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background-color: #f8fafc; color: #334155; }
      .wrapper { display: flex; width: 100%; align-items: stretch; }
      #sidebar { min-width: var(--sidebar-width); max-width: var(--sidebar-width); background: #0f172a; color: #fff; min-height: 100vh; transition: all 0.3s; }
      #sidebar .sidebar-header { padding: 20px; background: #1e293b; border-bottom: 1px solid #334155; }
      #sidebar ul.components { padding: 20px 0; }
      #sidebar ul li a { padding: 12px 25px; font-size: 0.95rem; display: block; color: #94a3b8; text-decoration: none; border-left: 4px solid transparent; }
      #sidebar ul li a:hover, #sidebar ul li a.active { color: #fff; background: #1e293b; border-left-color: #3b82f6; }
      #content { width: 100%; padding: 25px; min-height: 100vh; }
      .card-custom { border: none; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03); background: #fff; margin-bottom: 24px; }
      .card-header-custom { background: #fff; border-bottom: 1px solid #f1f5f9; padding: 18px 24px; border-top-left-radius: 12px !important; border-top-right-radius: 12px !important; font-weight: 600; font-size: 1.1rem; }
      .stat-card { padding: 20px; border-radius: 12px; color: #fff; }
      .bg-gradient-blue { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
      .bg-gradient-green { background: linear-gradient(135deg, #16a34a, #15803d); }
      .bg-gradient-orange { background: linear-gradient(135deg, #ea580c, #c2410c); }
      .bg-gradient-purple { background: linear-gradient(135deg, #9333ea, #7e22ce); }
      .btn-primary { background-color: #2563eb; border-color: #2563eb; }
      .btn-primary:hover { background-color: #1d4ed8; }
      .table > :not(caption) > * > * { padding: 12px 16px; }
      @media (max-width: 768px) {
        .wrapper { flex-direction: column; }
        #sidebar { min-width: 100%; max-width: 100%; min-height: auto; }
      }
    </style>
  `;
}

function getNavigationSidebar(user, settings, activeTab) {
  return `
    <nav id="sidebar">
      <div class="sidebar-header d-flex align-items-center">
        <img src="${settings.school_logo}" alt="Logo" class="rounded-circle me-2" width="40" height="40" onerror="this.src='/images/default_school_logo.png'">
        <div>
          <h6 class="mb-0 text-white">${settings.club_name}</h6>
          <small class="text-muted">${settings.school_name}</small>
        </div>
      </div>
      <ul class="list-unstyled components">
        ${user.role === 'ADMIN' ? `
          <li><a href="/admin/dashboard" class="${activeTab==='dashboard'?'active':''}"><i class="bi bi-speedometer2 me-2"></i> Dashboard</a></li>
          <li><a href="/admin/students" class="${activeTab==='students'?'active':''}"><i class="bi bi-people me-2"></i> Students & IDs</a></li>
          <li><a href="/admin/positions" class="${activeTab==='positions'?'active':''}"><i class="bi bi-award me-2"></i> Custom Positions</a></li>
          <li><a href="/admin/events" class="${activeTab==='events'?'active':''}"><i class="bi bi-calendar-event me-2"></i> Event Management</a></li>
          <li><a href="/scanner" target="_blank"><i class="bi bi-qr-code-scan me-2"></i> Open Scanner Portal <i class="bi bi-box-arrow-up-right ms-1"></i></a></li>
          <li><a href="/admin/reports" class="${activeTab==='reports'?'active':''}"><i class="bi bi-file-earmark-bar-graph me-2"></i> Attendance Reports</a></li>
          <li><a href="/admin/settings" class="${activeTab==='settings'?'active':''}"><i class="bi bi-gear me-2"></i> System Settings</a></li>
        ` : ''}
        ${user.role === 'STUDENT' ? `
          <li><a href="/member" class="active"><i class="bi bi-person-badge me-2"></i> My Digital ID & Portal</a></li>
        ` : ''}
        ${user.role === 'SCANNER' ? `
          <li><a href="/scanner" class="active"><i class="bi bi-qr-code-scan me-2"></i> Mobile QR Scanner</a></li>
        ` : ''}
        <li class="mt-4"><a href="#" data-bs-toggle="modal" data-bs-target="#changePasswordModal"><i class="bi bi-key me-2"></i> Change Password</a></li>
        <li><a href="/logout" class="text-danger"><i class="bi bi-box-arrow-right me-2"></i> Logout</a></li>
      </ul>
    </nav>
  `;
}

function getPasswordModal() {
  return `
    <div class="modal fade" id="changePasswordModal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title"><i class="bi bi-key me-2"></i>Change Password</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <form id="changePasswordForm">
            <div class="modal-body">
              <div class="mb-3">
                <label class="form-label">Current Password</label>
                <input type="password" name="current_password" class="form-control" required>
              </div>
              <div class="mb-3">
                <label class="form-label">New Password (Min 8 chars)</label>
                <input type="password" name="new_password" class="form-control" minlength="8" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Confirm New Password</label>
                <input type="password" name="confirm_password" class="form-control" minlength="8" required>
              </div>
              <div id="passAlert" class="alert alert-danger d-none"></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="submit" class="btn btn-primary">Update Password</button>
            </div>
          </form>
        </div>
      </div>
    </div>
    <script>
      document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const alertBox = document.getElementById('passAlert');
        alertBox.classList.add('d-none');
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData.entries());

        const res = await fetch('/api/change-password', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(data)
        });
        const result = await res.json();
        if(result.success) {
          alert('Password updated successfully! Please use your new password next time.');
          bootstrap.Modal.getInstance(document.getElementById('changePasswordModal')).hide();
          e.target.reset();
        } else {
          alertBox.textContent = result.message;
          alertBox.classList.remove('d-none');
        }
      });
    </script>
  `;
}

// 1. LOGIN PAGE RENDERER
function renderLoginPage(errorMessage) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('System Login - School Student Club QR Attendance')}
      <style>
        body { background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .login-card { width: 100%; max-width: 420px; background: #fff; border-radius: 16px; padding: 35px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.3); }
      </style>
    </head>
    <body>
      <div class="login-card">
        <div class="text-center mb-4">
          <i class="bi bi-qr-code-scan text-primary display-4"></i>
          <h4 class="fw-bold mt-2 mb-1">Club Attendance</h4>
          <p class="text-muted small">School QR Code Management System</p>
        </div>
        ${errorMessage ? `<div class="alert alert-danger py-2 small">${errorMessage}</div>` : ''}
        <form action="/login" method="POST">
          <div class="mb-3">
            <label class="form-label small fw-semibold">Username / Student ID</label>
            <div class="input-group">
              <span class="input-group-text"><i class="bi bi-person"></i></span>
              <input type="text" name="username" class="form-control" placeholder="Enter username or ID" required autofocus>
            </div>
          </div>
          <div class="mb-4">
            <label class="form-label small fw-semibold">Password</label>
            <div class="input-group">
              <span class="input-group-text"><i class="bi bi-lock"></i></span>
              <input type="password" name="password" class="form-control" placeholder="Enter password" required>
            </div>
          </div>
          <button type="submit" class="btn btn-primary w-100 py-2 fw-semibold"><i class="bi bi-box-arrow-in-right me-2"></i> Sign In</button>
        </form>
        <div class="mt-4 pt-3 border-top text-center text-muted small">
          Default Admin: <b>admin</b> / <b>admin123</b><br>
          Default Scanner: <b>scanner</b> / <b>scanner123</b>
        </div>
      </div>
    </body>
    </html>
  `;
}

// 2. ADMIN DASHBOARD RENDERER
function renderAdminDashboard({ user, settings, stats, activeEvent, recentScans }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('Dashboard - Admin Portal')}
    </head>
    <body>
      <div class="wrapper">
        ${getNavigationSidebar(user, settings, 'dashboard')}
        <div id="content">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <div>
              <h3 class="fw-bold mb-0">${settings.club_name} Dashboard</h3>
              <p class="text-muted small mb-0">${settings.school_name} | School Year ${settings.school_year}</p>
            </div>
            <div>
              <span class="badge bg-primary px-3 py-2"><i class="bi bi-person-circle me-1"></i> ${user.full_name} (${user.role})</span>
            </div>
          </div>

          <!-- Stats Row -->
          <div class="row g-3 mb-4">
            <div class="col-md-3">
              <div class="stat-card bg-gradient-blue">
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <h6 class="text-white-50 text-uppercase small fw-bold">Total Students</h6>
                    <h2 class="fw-bold mb-0">${stats.total_students || 0}</h2>
                  </div>
                  <i class="bi bi-people fs-1 text-white-50"></i>
                </div>
              </div>
            </div>
            <div class="col-md-3">
              <div class="stat-card bg-gradient-green">
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <h6 class="text-white-50 text-uppercase small fw-bold">Active Members</h6>
                    <h2 class="fw-bold mb-0">${stats.active_students || 0}</h2>
                  </div>
                  <i class="bi bi-person-check fs-1 text-white-50"></i>
                </div>
              </div>
            </div>
            <div class="col-md-3">
              <div class="stat-card bg-gradient-purple">
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <h6 class="text-white-50 text-uppercase small fw-bold">Club Officers</h6>
                    <h2 class="fw-bold mb-0">${stats.total_officers || 0}</h2>
                  </div>
                  <i class="bi bi-award fs-1 text-white-50"></i>
                </div>
              </div>
            </div>
            <div class="col-md-3">
              <div class="stat-card bg-gradient-orange">
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <h6 class="text-white-50 text-uppercase small fw-bold">Active Events</h6>
                    <h2 class="fw-bold mb-0">${stats.active_events_count || 0}</h2>
                  </div>
                  <i class="bi bi-calendar-event fs-1 text-white-50"></i>
                </div>
              </div>
            </div>
          </div>

          <!-- Active Event & Live Monitor Section -->
          <div class="row g-4">
            <div class="col-md-5">
              <div class="card card-custom h-100">
                <div class="card-header-custom d-flex justify-content-between align-items-center">
                  <span><i class="bi bi-broadcast text-danger me-2"></i> Currently Active Event</span>
                  <a href="/admin/events" class="btn btn-sm btn-outline-primary">Manage</a>
                </div>
                <div class="card-body">
                  ${activeEvent ? `
                    <h4 class="fw-bold text-primary mb-1">${activeEvent.event_name}</h4>
                    <p class="text-muted small mb-3">${activeEvent.description || 'No description provided.'}</p>
                    <ul class="list-group list-group-flush mb-3 small">
                      <li class="list-group-item d-flex justify-content-between bg-transparent px-0">
                        <span class="text-muted">Date:</span> <b>${activeEvent.event_date}</b>
                      </li>
                      <li class="list-group-item d-flex justify-content-between bg-transparent px-0">
                        <span class="text-muted">Time Schedule:</span> <b>${activeEvent.start_time} - ${activeEvent.end_time}</b>
                      </li>
                      <li class="list-group-item d-flex justify-content-between bg-transparent px-0">
                        <span class="text-muted">Location:</span> <b>${activeEvent.location}</b>
                      </li>
                      <li class="list-group-item d-flex justify-content-between bg-transparent px-0">
                        <span class="text-muted">Organizer:</span> <b>${activeEvent.organizer}</b>
                      </li>
                    </ul>
                    <a href="/scanner" target="_blank" class="btn btn-success w-100 py-2"><i class="bi bi-qr-code-scan me-2"></i> Launch Live Scanner</a>
                  ` : `
                    <div class="text-center py-5">
                      <i class="bi bi-calendar-x text-muted display-4"></i>
                      <p class="mt-2 text-muted">No event is currently active.</p>
                      <a href="/admin/events" class="btn btn-primary btn-sm">Activate an Event</a>
                    </div>
                  `}
                </div>
              </div>
            </div>

            <div class="col-md-7">
              <div class="card card-custom h-100">
                <div class="card-header-custom">
                  <i class="bi bi-clock-history me-2 text-primary"></i> Live Attendance Feed
                </div>
                <div class="card-body p-0">
                  <div class="table-responsive">
                    <table class="table table-hover align-middle mb-0">
                      <thead class="table-light">
                        <tr>
                          <th>Student</th>
                          <th>Position</th>
                          <th>Event</th>
                          <th>Time In</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${recentScans.length > 0 ? recentScans.map(s => `
                          <tr>
                            <td>
                              <div class="fw-bold">${s.full_name}</div>
                              <small class="text-muted">${s.sid}</small>
                            </td>
                            <td><span class="badge bg-secondary">${s.position_title}</span></td>
                            <td class="small">${s.event_name}</td>
                            <td class="small">${s.time_in ? new Date(s.time_in).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '-'}</td>
                            <td>
                              <span class="badge ${s.status==='PRESENT'?'bg-success':s.status==='LATE'?'bg-warning text-dark':'bg-danger'}">${s.status}</span>
                            </td>
                          </tr>
                        `).join('') : `
                          <tr><td colspan="5" class="text-center py-4 text-muted">No attendance activity recorded yet today.</td></tr>
                        `}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${getPasswordModal()}
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    </body>
    </html>
  `;
}

// 3. CUSTOM POSITION MANAGEMENT RENDERER
function renderPositionManagementPage({ user, settings, positions }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('Position Management - School Club System')}
    </head>
    <body>
      <div class="wrapper">
        ${getNavigationSidebar(user, settings, 'positions')}
        <div id="content">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <div>
              <h3 class="fw-bold mb-0">Custom Position Management</h3>
              <p class="text-muted small mb-0">Configure, customize, and assign organizational roles for ${settings.club_name}</p>
            </div>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addPositionModal"><i class="bi bi-plus-lg me-1"></i> Add Custom Position</button>
          </div>

          <div class="card card-custom">
            <div class="card-body p-0">
              <div class="table-responsive">
                <table class="table table-hover align-middle mb-0">
                  <thead class="table-light">
                    <tr>
                      <th>Position Title</th>
                      <th>Description</th>
                      <th>Assigned Members</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${positions.map(p => `
                      <tr>
                        <td><b class="text-primary">${p.title}</b></td>
                        <td class="text-muted small">${p.description || 'No description'}</td>
                        <td><span class="badge bg-info text-dark">${p.student_count} Students</span></td>
                        <td>
                          <button class="btn btn-sm btn-outline-secondary me-1" onclick="editPos(${p.id}, '${p.title}', '${p.description||''}')"><i class="bi bi-pencil"></i> Edit</button>
                          <button class="btn btn-sm btn-outline-danger" onclick="deletePos(${p.id})"><i class="bi bi-trash"></i></button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Add Position Modal -->
      <div class="modal fade" id="addPositionModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Create Custom Position</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <form id="addPosForm">
              <div class="modal-body">
                <div class="mb-3">
                  <label class="form-label">Position Title</label>
                  <input type="text" name="title" class="form-control" placeholder="e.g. Event Coordinator, Technical Officer" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">Description</label>
                  <textarea name="description" class="form-control" rows="3"></textarea>
                </div>
              </div>
              <div class="modal-footer">
                <button type="submit" class="btn btn-primary">Save Position</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      ${getPasswordModal()}
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
      <script>
        document.getElementById('addPosForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = Object.fromEntries(new FormData(e.target).entries());
          const res = await fetch('/admin/positions/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
          });
          const result = await res.json();
          if(result.success) location.reload();
          else alert(result.message);
        });

        async function deletePos(id) {
          if(!confirm('Are you sure you want to delete this position?')) return;
          const res = await fetch('/admin/positions/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ id })
          });
          const result = await res.json();
          if(result.success) location.reload();
          else alert(result.message);
        }
      </script>
    </body>
    </html>
  `;
}

// 4. STUDENT MANAGEMENT PAGE RENDERER
function renderStudentManagementPage({ user, settings, students, positions }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('Student Registration & Management')}
    </head>
    <body>
      <div class="wrapper">
        ${getNavigationSidebar(user, settings, 'students')}
        <div id="content">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <div>
              <h3 class="fw-bold mb-0">Student Members & Digital IDs</h3>
              <p class="text-muted small mb-0">Manage student profiles, assign custom positions, and print ID cards</p>
            </div>
            <div>
              <button class="btn btn-success me-2" onclick="printSelected()"><i class="bi bi-printer me-1"></i> Print Selected IDs (A4)</button>
              <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addStudentModal"><i class="bi bi-person-plus me-1"></i> Register Student</button>
            </div>
          </div>

          <div class="card card-custom">
            <div class="card-body p-0">
              <div class="table-responsive">
                <table class="table table-hover align-middle mb-0">
                  <thead class="table-light">
                    <tr>
                      <th><input type="checkbox" id="selectAll" onclick="toggleSelectAll(this)"></th>
                      <th>Photo</th>
                      <th>Student ID</th>
                      <th>Full Name</th>
                      <th>Position</th>
                      <th>Status</th>
                      <th>QR Token</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${students.map(s => `
                      <tr>
                        <td><input type="checkbox" class="st-select" value="${s.student_id}"></td>
                        <td>
                          <img src="${s.photo_url}" width="40" height="40" class="rounded-circle object-fit-cover" onerror="this.src='/images/default_avatar.png'">
                        </td>
                        <td><b>${s.student_id}</b></td>
                        <td>${s.full_name}</td>
                        <td><span class="badge bg-primary">${s.position_title}</span></td>
                        <td>
                          <span class="badge ${s.membership_status==='Active'?'bg-success':'bg-secondary'}">${s.membership_status}</span>
                        </td>
                        <td>
                          <span class="badge ${s.qr_active?'bg-success':'bg-danger'}">${s.qr_active?'ACTIVE':'DISABLED'}</span>
                        </td>
                        <td>
                          <button class="btn btn-sm btn-outline-info me-1" onclick="regenerateQR('${s.student_id}')" title="Regenerate QR Code"><i class="bi bi-arrow-repeat"></i></button>
                          <a href="/admin/print-ids?ids=${s.student_id}" target="_blank" class="btn btn-sm btn-outline-secondary me-1" title="Print ID"><i class="bi bi-printer"></i></a>
                          <button class="btn btn-sm btn-outline-danger" onclick="deleteStudent('${s.student_id}')"><i class="bi bi-trash"></i></button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Add Student Modal -->
      <div class="modal fade" id="addStudentModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Register New Student Member</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <form id="addStudentForm" enctype="multipart/form-data">
              <div class="modal-body row g-3">
                <div class="col-md-4">
                  <label class="form-label">Student ID (Unique)</label>
                  <input type="text" name="student_id" class="form-control" placeholder="2026-0001" required>
                </div>
                <div class="col-md-4">
                  <label class="form-label">First Name</label>
                  <input type="text" name="first_name" class="form-control" required>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Middle Name</label>
                  <input type="text" name="middle_name" class="form-control">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Last Name</label>
                  <input type="text" name="last_name" class="form-control" required>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Custom Position</label>
                  <select name="position_id" class="form-select" required>
                    ${positions.map(p => `<option value="${p.id}">${p.title}</option>`).join('')}
                  </select>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Date Joined</label>
                  <input type="date" name="date_joined" class="form-control" value="${new Date().toISOString().split('T')[0]}" required>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Gender</label>
                  <select name="gender" class="form-select">
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Contact Number</label>
                  <input type="text" name="contact_number" class="form-control">
                </div>
                <div class="col-md-4">
                  <label class="form-label">School Email</label>
                  <input type="email" name="school_email" class="form-control">
                </div>
                <div class="col-md-6">
                  <label class="form-label">Student Photo</label>
                  <input type="file" name="photo" class="form-control" accept="image/*">
                </div>
                <div class="col-md-6">
                  <label class="form-label">Login Password (Default: Student@ID)</label>
                  <input type="password" name="password" class="form-control" placeholder="Min 8 characters">
                </div>
              </div>
              <div class="modal-footer">
                <button type="submit" class="btn btn-primary">Save & Generate QR Code</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      ${getPasswordModal()}
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
      <script>
        document.getElementById('addStudentForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const res = await fetch('/admin/students/add', { method: 'POST', body: formData });
          const result = await res.json();
          if(result.success) location.reload();
          else alert(result.message);
        });

        async function regenerateQR(student_id) {
          if(!confirm('Regenerating will invalidate the old QR Code. Continue?')) return;
          const res = await fetch('/admin/qr/regenerate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ student_id })
          });
          const result = await res.json();
          if(result.success) alert('New QR Code Token Generated.');
          else alert(result.message);
        }

        async function deleteStudent(student_id) {
          if(!confirm('Are you sure? This will delete all attendance records for this student.')) return;
          const res = await fetch('/admin/students/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ student_id })
          });
          const result = await res.json();
          if(result.success) location.reload();
          else alert(result.message);
        }

        function toggleSelectAll(master) {
          document.querySelectorAll('.st-select').forEach(cb => cb.checked = master.checked);
        }

        function printSelected() {
          const selected = Array.from(document.querySelectorAll('.st-select:checked')).map(cb => cb.value);
          if(selected.length === 0) return alert('Select at least one student to print IDs.');
          window.open('/admin/print-ids?ids=' + selected.join(','), '_blank');
        }
      </script>
    </body>
    </html>
  `;
}

// 5. A4 PRINT LAYOUT RENDERER (EXACT 8 IDs PER A4 PAGE)
function renderA4PrintLayout({ settings, cards }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Print Student IDs - Exactly 8 Per A4 Page</title>
      <style>
        @page { size: A4 portrait; margin: 10mm; }
        body { font-family: Arial, sans-serif; background: #e2e8f0; margin: 0; padding: 20px; }
        .page { width: 210mm; min-height: 297mm; padding: 5mm; background: #fff; margin: 0 auto 20px auto; box-shadow: 0 0 10px rgba(0,0,0,0.1); box-sizing: border-box; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8mm 6mm; }
        
        /* Standard ID Card Dimensions (CR80 proportions fitted 8 per A4) */
        .id-card { width: 88mm; height: 56mm; border: 1px dashed #cbd5e1; border-radius: 6mm; padding: 3mm; box-sizing: border-box; position: relative; background: #fff; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; }
        .card-header { text-align: center; border-bottom: 2px solid #1e3a8a; padding-bottom: 2px; }
        .school-title { font-size: 8pt; font-weight: bold; color: #1e3a8a; margin: 0; text-transform: uppercase; }
        .club-title { font-size: 7pt; color: #475569; margin: 0; }
        .card-body { display: flex; align-items: center; justify-content: space-between; margin-top: 2mm; }
        .photo-box { width: 22mm; height: 26mm; border-radius: 2mm; object-fit: cover; border: 1px solid #94a3b8; }
        .info-box { flex: 1; padding-left: 3mm; font-size: 7.5pt; }
        .st-name { font-size: 8.5pt; font-weight: bold; color: #0f172a; margin-bottom: 1mm; }
        .pos-badge { display: inline-block; background: #2563eb; color: #fff; padding: 1px 4px; border-radius: 2px; font-size: 6.5pt; font-weight: bold; }
        .qr-box { width: 20mm; height: 20mm; }
        .cut-guide { position: absolute; border: 1px solid #94a3b8; }
        
        @media print {
          body { background: none; padding: 0; }
          .page { box-shadow: none; margin: 0; page-break-after: always; }
          .no-print { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="no-print" style="text-align: center; margin-bottom: 20px;">
        <button onclick="window.print()" style="padding: 10px 20px; font-size: 16px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer;">
          🖨️ Print ID Cards (A4 Format)
        </button>
      </div>

      <!-- Paginate cards automatically 8 per page -->
      ${chunkArray(cards, 8).map(pageCards => `
        <div class="page">
          ${pageCards.map(c => `
            <div class="id-card">
              <div class="card-header">
                <div class="school-title">${settings.school_name}</div>
                <div class="club-title">${settings.club_name} • SY ${settings.school_year}</div>
              </div>
              <div class="card-body">
                <img src="${c.photo_url}" class="photo-box" onerror="this.src='/images/default_avatar.png'">
                <div class="info-box">
                  <div class="st-name">${c.full_name}</div>
                  <div>ID: <b>${c.student_id}</b></div>
                  <div class="mt-1"><span class="pos-badge">${c.position_title}</span></div>
                </div>
                <img src="${c.qrDataUrl}" class="qr-box">
              </div>
              <div style="font-size: 6pt; text-align: center; color: #64748b; border-top: 1px solid #e2e8f0; pt: 1mm;">
                Official Student Club ID • Non-Transferable
              </div>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </body>
    </html>
  `;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// 6. SEPARATE SCANNER PORTAL RENDERER (WebCam API, SpeechSynthesis Voice, Chimes)
function renderScannerPortalPage({ user, settings, events }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('Mobile QR Scanner Portal - Club Attendance')}
      <script src="https://unpkg.com/html5-qrcode"></script>
      <style>
        body { background-color: #0f172a; color: #fff; }
        .scanner-card { background: #1e293b; border-radius: 16px; padding: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        #reader { width: 100%; border-radius: 12px; overflow: hidden; background: #000; }
        .scan-result-card { border-radius: 12px; transition: all 0.3s; }
      </style>
    </head>
    <body>
      <div class="container py-4" style="max-width: 600px;">
        <div class="text-center mb-3">
          <h4 class="fw-bold mb-0 text-white"><i class="bi bi-qr-code-scan text-primary me-2"></i>Scanner Portal</h4>
          <p class="text-white-50 small">${settings.club_name} • ${settings.school_name}</p>
        </div>

        <div class="scanner-card mb-3">
          <div class="mb-3">
            <label class="form-label text-white-50 small fw-bold">1. Select Target Event</label>
            <select id="eventSelect" class="form-select bg-dark text-white border-secondary">
              ${events.map(e => `<option value="${e.id}" ${e.status==='Active'?'selected':''}>${e.event_name} (${e.status})</option>`).join('')}
            </select>
          </div>

          <div class="mb-3">
            <label class="form-label text-white-50 small fw-bold">2. Mode</label>
            <div class="btn-group w-100" role="group">
              <input type="radio" class="btn-check" name="scanType" id="typeIn" value="TIME_IN" checked>
              <label class="btn btn-outline-success" for="typeIn"><i class="bi bi-box-arrow-in-right me-1"></i> TIME IN</label>
              
              <input type="radio" class="btn-check" name="scanType" id="typeOut" value="TIME_OUT">
              <label class="btn btn-outline-warning" for="typeOut"><i class="bi bi-box-arrow-right me-1"></i> TIME OUT</label>
            </div>
          </div>

          <div id="reader"></div>
        </div>

        <!-- Live Result Box -->
        <div id="resultBox" class="card scan-result-card bg-secondary text-white d-none">
          <div class="card-body text-center py-4">
            <img id="resPhoto" width="80" height="80" class="rounded-circle mb-2 object-fit-cover border border-3 border-white">
            <h4 id="resName" class="fw-bold mb-0">---</h4>
            <p id="resPosition" class="badge bg-primary mb-2">---</p>
            <div id="resStatus" class="fs-5 fw-bold text-uppercase">---</div>
            <p id="resTime" class="small mb-0 text-white-50">---</p>
          </div>
        </div>
      </div>

      <script>
        const voiceEnabled = ${settings.voice_announcement === 'true'};
        const voiceVol = ${parseFloat(settings.voice_volume || '1.0')};
        const voiceRate = ${parseFloat(settings.voice_rate || '1.0')};
        let html5QrcodeScanner = null;
        let isProcessing = false;

        function speakText(text) {
          if (!voiceEnabled || !('speechSynthesis' in window)) return;
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.volume = voiceVol;
          utterance.rate = voiceRate;
          window.speechSynthesis.speak(utterance);
        }

        async function onScanSuccess(decodedText, decodedResult) {
          if (isProcessing) return;
          isProcessing = true;

          const eventId = document.getElementById('eventSelect').value;
          const scanType = document.querySelector('input[name="scanType"]:checked').value;

          if(!eventId) {
            alert('Please select an active event first.');
            isProcessing = false;
            return;
          }

          try {
            const res = await fetch('/api/scanner/scan', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: scanType })
            });
            const data = await res.json();
            displayScanResult(data, scanType);
          } catch(e) {
            console.error(e);
          }

          setTimeout(() => { isProcessing = false; }, 2500);
        }

        function displayScanResult(data, scanType) {
          const resBox = document.getElementById('resultBox');
          resBox.classList.remove('d-none', 'bg-success', 'bg-danger', 'bg-warning', 'bg-secondary');

          if(data.result === 'SUCCESS') {
            resBox.classList.add('bg-success');
            document.getElementById('resName').textContent = data.student.full_name;
            document.getElementById('resPosition').textContent = data.student.position_title;
            document.getElementById('resStatus').textContent = '✓ TIME IN RECORDED (' + data.status + ')';
            document.getElementById('resTime').textContent = 'Time: ' + data.student.time_in;
            document.getElementById('resPhoto').src = data.student.photo_url;
            speakText(data.student.full_name + ', attendance recorded.');
          } 
          else if(data.result === 'SUCCESS_TIMEOUT') {
            resBox.classList.add('bg-info');
            document.getElementById('resName').textContent = data.student.full_name;
            document.getElementById('resPosition').textContent = data.student.position_title;
            document.getElementById('resStatus').textContent = '✓ TIME OUT RECORDED';
            document.getElementById('resTime').textContent = 'Time Out: ' + data.student.time_out;
            document.getElementById('resPhoto').src = data.student.photo_url;
            speakText(data.student.full_name + ', time out recorded.');
          }
          else if(data.result === 'DUPLICATE') {
            resBox.classList.add('bg-warning', 'text-dark');
            document.getElementById('resName').textContent = data.student.full_name;
            document.getElementById('resPosition').textContent = data.student.position_title;
            document.getElementById('resStatus').textContent = '⚠️ ALREADY RECORDED';
            document.getElementById('resTime').textContent = data.message;
            document.getElementById('resPhoto').src = data.student.photo_url;
            speakText(data.student.full_name + ', you are already recorded.');
          } 
          else {
            resBox.classList.add('bg-danger');
            document.getElementById('resName').textContent = 'INVALID SCAN';
            document.getElementById('resPosition').textContent = 'N/A';
            document.getElementById('resStatus').textContent = '❌ ' + data.message;
            document.getElementById('resTime').textContent = '';
            document.getElementById('resPhoto').src = '/images/default_avatar.png';
            speakText('Invalid QR Code.');
          }
        }

        window.addEventListener('load', () => {
          html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
          html5QrcodeScanner.render(onScanSuccess, (err) => {});
        });
      </script>
    </body>
    </html>
  `;
}

// 7. EVENT MANAGEMENT PAGE RENDERER
function renderEventManagementPage({ user, settings, events, positions }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('Event Management')}
    </head>
    <body>
      <div class="wrapper">
        ${getNavigationSidebar(user, settings, 'events')}
        <div id="content">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <div>
              <h3 class="fw-bold mb-0">Club Events & Assemblies</h3>
              <p class="text-muted small mb-0">Schedule meetings, track participants, and activate attendance sessions</p>
            </div>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addEventModal"><i class="bi bi-calendar-plus me-1"></i> Schedule Event</button>
          </div>

          <div class="card card-custom">
            <div class="card-body p-0">
              <div class="table-responsive">
                <table class="table table-hover align-middle mb-0">
                  <thead class="table-light">
                    <tr>
                      <th>Event Name</th>
                      <th>Date & Schedule</th>
                      <th>Location</th>
                      <th>Target Audience</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${events.map(e => `
                      <tr>
                        <td>
                          <b>${e.event_name}</b>
                          <div class="text-muted small">${e.event_type}</div>
                        </td>
                        <td class="small">
                          <div><i class="bi bi-calendar me-1"></i> ${e.event_date}</div>
                          <div class="text-muted"><i class="bi bi-clock me-1"></i> ${e.start_time} - ${e.end_time}</div>
                        </td>
                        <td class="small">${e.location}</td>
                        <td><span class="badge bg-secondary">${e.target_audience}</span></td>
                        <td>
                          <span class="badge ${e.status==='Active'?'bg-success':e.status==='Upcoming'?'bg-primary':'bg-dark'}">${e.status}</span>
                        </td>
                        <td>
                          ${e.status !== 'Active' ? `
                            <button class="btn btn-sm btn-outline-success me-1" onclick="updateEventStatus(${e.id}, 'Active')">Set Active</button>
                          ` : `
                            <button class="btn btn-sm btn-outline-danger me-1" onclick="updateEventStatus(${e.id}, 'Completed')">Complete</button>
                          `}
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Add Event Modal -->
      <div class="modal fade" id="addEventModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Schedule New Event</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <form id="addEventForm">
              <div class="modal-body row g-3">
                <div class="col-md-6">
                  <label class="form-label">Event Name</label>
                  <input type="text" name="event_name" class="form-control" placeholder="e.g. General Assembly" required>
                </div>
                <div class="col-md-6">
                  <label class="form-label">Event Type</label>
                  <select name="event_type" class="form-select">
                    <option value="General Assembly">General Assembly</option>
                    <option value="Officer Meeting">Officer Meeting</option>
                    <option value="Workshop">Workshop</option>
                    <option value="Special Event">Special Event</option>
                  </select>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Event Date</label>
                  <input type="date" name="event_date" class="form-control" required>
                </div>
                <div class="col-md-4">
                  <label class="form-label">Start Time</label>
                  <input type="time" name="start_time" class="form-control" required>
                </div>
                <div class="col-md-4">
                  <label class="form-label">End Time</label>
                  <input type="time" name="end_time" class="form-control" required>
                </div>
                <div class="col-md-6">
                  <label class="form-label">Location</label>
                  <input type="text" name="location" class="form-control" placeholder="Audio Visual Room" required>
                </div>
                <div class="col-md-6">
                  <label class="form-label">Organizer</label>
                  <input type="text" name="organizer" class="form-control" value="${settings.club_name}" required>
                </div>
                <div class="col-md-12">
                  <label class="form-label">Target Audience</label>
                  <select name="target_audience" class="form-select">
                    <option value="ALL">ALL STUDENT MEMBERS</option>
                    <option value="OFFICERS_ONLY">OFFICERS ONLY</option>
                  </select>
                </div>
              </div>
              <div class="modal-footer">
                <button type="submit" class="btn btn-primary">Schedule Event</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      ${getPasswordModal()}
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
      <script>
        document.getElementById('addEventForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = Object.fromEntries(new FormData(e.target).entries());
          const res = await fetch('/admin/events/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
          });
          const result = await res.json();
          if(result.success) location.reload();
          else alert(result.message);
        });

        async function updateEventStatus(event_id, status) {
          const res = await fetch('/admin/events/update-status', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ event_id, status })
          });
          const result = await res.json();
          if(result.success) location.reload();
          else alert(result.message);
        }
      </script>
    </body>
    </html>
  `;
}

// 8. REPORTS & EXPORTS RENDERER
function renderReportsPage({ user, settings, records, events, positions, filters }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('Attendance Reports')}
    </head>
    <body>
      <div class="wrapper">
        ${getNavigationSidebar(user, settings, 'reports')}
        <div id="content">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <div>
              <h3 class="fw-bold mb-0">Attendance Reports & Logs</h3>
              <p class="text-muted small mb-0">Generate, filter, print, and export attendance records</p>
            </div>
            <button class="btn btn-outline-secondary" onclick="window.print()"><i class="bi bi-printer me-1"></i> Print Report</button>
          </div>

          <!-- Filter Bar -->
          <div class="card card-custom mb-4">
            <div class="card-body">
              <form method="GET" class="row g-2">
                <div class="col-md-3">
                  <select name="event_id" class="form-select">
                    <option value="">All Events</option>
                    ${events.map(e => `<option value="${e.id}" ${filters.event_id==e.id?'selected':''}>${e.event_name}</option>`).join('')}
                  </select>
                </div>
                <div class="col-md-3">
                  <select name="position_id" class="form-select">
                    <option value="">All Positions</option>
                    ${positions.map(p => `<option value="${p.id}" ${filters.position_id==p.id?'selected':''}>${p.title}</option>`).join('')}
                  </select>
                </div>
                <div class="col-md-3">
                  <select name="status" class="form-select">
                    <option value="">All Statuses</option>
                    <option value="PRESENT" ${filters.status==='PRESENT'?'selected':''}>PRESENT</option>
                    <option value="LATE" ${filters.status==='LATE'?'selected':''}>LATE</option>
                    <option value="ABSENT" ${filters.status==='ABSENT'?'selected':''}>ABSENT</option>
                    <option value="EXCUSED" ${filters.status==='EXCUSED'?'selected':''}>EXCUSED</option>
                  </select>
                </div>
                <div class="col-md-3">
                  <button type="submit" class="btn btn-primary w-100"><i class="bi bi-filter me-1"></i> Apply Filters</button>
                </div>
              </form>
            </div>
          </div>

          <div class="card card-custom">
            <div class="card-body p-0">
              <div class="table-responsive">
                <table class="table table-hover align-middle mb-0">
                  <thead class="table-light">
                    <tr>
                      <th>Student ID</th>
                      <th>Student Name</th>
                      <th>Position</th>
                      <th>Event Name</th>
                      <th>Time In</th>
                      <th>Time Out</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${records.map(r => `
                      <tr>
                        <td><b>${r.sid}</b></td>
                        <td>${r.full_name}</td>
                        <td><span class="badge bg-secondary">${r.position_title}</span></td>
                        <td>${r.event_name}</td>
                        <td class="small">${r.time_in ? new Date(r.time_in).toLocaleTimeString() : '-'}</td>
                        <td class="small">${r.time_out ? new Date(r.time_out).toLocaleTimeString() : '-'}</td>
                        <td>
                          <span class="badge ${r.status==='PRESENT'?'bg-success':r.status==='LATE'?'bg-warning text-dark':r.status==='EXCUSED'?'bg-info':'bg-danger'}">${r.status}</span>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${getPasswordModal()}
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    </body>
    </html>
  `;
}

// 9. STUDENT PORTAL PAGE RENDERER (/member)
function renderStudentPortalPage({ user, settings, student, qrDataUrl, history, stats }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('Student Portal - My Digital ID')}
      <style>
        .id-card-view { max-width: 380px; margin: 0 auto; background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 10px 20px rgba(0,0,0,0.2); }
      </style>
    </head>
    <body>
      <div class="wrapper">
        ${getNavigationSidebar(user, settings, 'member')}
        <div id="content">
          <div class="row g-4">
            <div class="col-md-5">
              <!-- Digital ID Card Display -->
              <div class="id-card-view text-center mb-4">
                <div class="fw-bold text-uppercase small text-white-50">${settings.school_name}</div>
                <div class="fw-bold mb-3">${settings.club_name}</div>
                <img src="${student.photo_url}" width="100" height="100" class="rounded-circle object-fit-cover border border-3 border-white mb-2" onerror="this.src='/images/default_avatar.png'">
                <h4 class="fw-bold mb-0">${student.full_name}</h4>
                <div class="badge bg-light text-primary mb-3">${student.position_title}</div>
                
                <div class="bg-white p-2 rounded-3 d-inline-block mb-3">
                  <img src="${qrDataUrl}" width="180" height="180">
                </div>
                <div class="small text-white-50">Student ID: <b>${student.student_id}</b></div>
                <div class="small text-white-50">School Year: <b>${settings.school_year}</b></div>
              </div>
            </div>

            <div class="col-md-7">
              <div class="card card-custom mb-4">
                <div class="card-header-custom">
                  <i class="bi bi-graph-up me-2 text-primary"></i> Participation Summary
                </div>
                <div class="card-body">
                  <div class="row text-center">
                    <div class="col-4">
                      <h3 class="fw-bold text-primary mb-0">${stats.attended} / ${stats.total}</h3>
                      <small class="text-muted">Events Attended</small>
                    </div>
                    <div class="col-8">
                      <h3 class="fw-bold text-success mb-0">${stats.rate}%</h3>
                      <small class="text-muted">Overall Attendance Rate</small>
                    </div>
                  </div>
                </div>
              </div>

              <div class="card card-custom">
                <div class="card-header-custom">
                  <i class="bi bi-clock-history me-2 text-primary"></i> Personal Attendance History
                </div>
                <div class="card-body p-0">
                  <div class="table-responsive">
                    <table class="table table-hover align-middle mb-0">
                      <thead class="table-light">
                        <tr>
                          <th>Event</th>
                          <th>Date</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${history.map(h => `
                          <tr>
                            <td><b>${h.event_name}</b></td>
                            <td class="small">${h.event_date}</td>
                            <td>
                              <span class="badge ${h.status==='PRESENT'?'bg-success':h.status==='LATE'?'bg-warning text-dark':'bg-danger'}">${h.status}</span>
                            </td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${getPasswordModal()}
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    </body>
    </html>
  `;
}

// 10. SYSTEM SETTINGS PAGE RENDERER
function renderSettingsPage({ user, settings }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      ${getCommonHead('System Settings')}
    </head>
    <body>
      <div class="wrapper">
        ${getNavigationSidebar(user, settings, 'settings')}
        <div id="content">
          <h3 class="fw-bold mb-4">System Configuration & Backup</h3>

          <div class="row g-4">
            <div class="col-md-8">
              <div class="card card-custom">
                <div class="card-header-custom">School & Club Branding</div>
                <div class="card-body">
                  <form action="/admin/settings/save" method="POST" enctype="multipart/form-data" class="row g-3">
                    <div class="col-md-6">
                      <label class="form-label">School Name</label>
                      <input type="text" name="school_name" class="form-control" value="${settings.school_name}" required>
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">Student Club Name</label>
                      <input type="text" name="club_name" class="form-control" value="${settings.club_name}" required>
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">Club Adviser</label>
                      <input type="text" name="club_adviser" class="form-control" value="${settings.club_adviser}">
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">School Year</label>
                      <input type="text" name="school_year" class="form-control" value="${settings.school_year}">
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">Late Threshold (Minutes)</label>
                      <input type="number" name="late_threshold_minutes" class="form-control" value="${settings.late_threshold_minutes}">
                    </div>
                    <div class="col-md-6">
                      <label class="form-label">School Logo</label>
                      <input type="file" name="school_logo" class="form-control" accept="image/*">
                    </div>
                    <div class="col-md-12">
                      <button type="submit" class="btn btn-primary">Save Changes</button>
                    </div>
                  </form>
                </div>
              </div>
            </div>

            <div class="col-md-4">
              <div class="card card-custom">
                <div class="card-header-custom">Database Backup</div>
                <div class="card-body">
                  <p class="text-muted small">Download a complete copy of the SQLite database file for safety and records.</p>
                  <a href="/admin/backup/download" class="btn btn-outline-success w-100"><i class="bi bi-download me-2"></i> Download DB Backup</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${getPasswordModal()}
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    </body>
    </html>
  `;
}

/**
 * ====================================================================================
 * BOOTSTRAP SERVER LISTEN
 * ====================================================================================
 */
app.listen(PORT, () => {
  console.log(`
  ===================================================================
  🚀 SCHOOL STUDENT CLUB QR ATTENDANCE MANAGEMENT SYSTEM RUNNING
  -------------------------------------------------------------------
  • Primary Application URL: http://localhost:${PORT}
  • Admin Login Portal:      http://localhost:${PORT}/login
  • Mobile Scanner Portal:   http://localhost:${PORT}/scanner
  • Student Portal:          http://localhost:${PORT}/member
  ===================================================================
  `);
});
