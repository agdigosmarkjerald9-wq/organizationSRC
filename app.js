/**
 * =======================================================================================
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Engine: Node.js / Express.js / Embedded Responsive Frontend / Universal SQL Persistence
 * Target Deployment: Local (SQLite3) / Production (Railway & Render PostgreSQL / Persistent Storage)
 * =======================================================================================
 */

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { Database } = require('sqlite3');
const { open } = require('sqlite');
const { Pool } = require('pg');

// =======================================================================================
// 1. SYSTEM INITIALIZATION & ENVIRONMENT CONFIGURATION
// =======================================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// Middleware Stack
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static Asset Directories Initialization
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LOGOS_DIR = path.join(UPLOADS_DIR, 'logos');
const PHOTOS_DIR = path.join(UPLOADS_DIR, 'photos');
const BACKUPS_DIR = path.join(__dirname, 'backups');

[UPLOADS_DIR, LOGOS_DIR, PHOTOS_DIR, BACKUPS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use('/uploads', express.static(UPLOADS_DIR));

// Session Engine Setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'sc-qr-attendance-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 24 Hours
  }
}));

// Storage Engine (Multer) Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'school_logo' || file.fieldname === 'club_logo') {
      cb(null, LOGOS_DIR);
    } else if (file.fieldname === 'student_photo') {
      cb(null, PHOTOS_DIR);
    } else {
      cb(null, UPLOADS_DIR);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPG, JPEG, PNG, and WEBP formats are accepted.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// =======================================================================================
// 2. UNIVERSAL DATABASE ABSTRACTION LAYER (SQLite3 + PostgreSQL Engine Support)
// =======================================================================================
let dbInstance = null;
let dbType = 'sqlite';

class DatabaseAdapter {
  constructor() {
    this.type = dbType;
  }

  async query(sql, params = []) {
    if (this.type === 'sqlite') {
      let sqliteSql = sql.replace(/\$(\d+)/g, '?');
      const trimmedSql = sqliteSql.trim().toUpperCase();
      const isSelect = trimmedSql.startsWith('SELECT') || trimmedSql.startsWith('PRAGMA');
      
      if (isSelect) {
        return await dbInstance.all(sqliteSql, params);
      } else {
        const result = await dbInstance.run(sqliteSql, params);
        return { rows: [], insertId: result.lastID, rowCount: result.changes };
      }
    } else {
      const res = await dbInstance.query(sql, params);
      return { rows: res.rows, insertId: res.rows[0]?.id, rowCount: res.rowCount };
    }
  }

  async getOne(sql, params = []) {
    const res = await this.query(sql, params);
    if (this.type === 'sqlite') {
      return Array.isArray(res) ? res[0] : null;
    }
    return res.rows[0] || null;
  }

  async getAll(sql, params = []) {
    const res = await this.query(sql, params);
    if (this.type === 'sqlite') {
      return Array.isArray(res) ? res : [];
    }
    return res.rows;
  }
}

const DB = new DatabaseAdapter();

async function initDatabase() {
  try {
    if (DATABASE_URL && DATABASE_URL.startsWith('postgres')) {
      dbType = 'pg';
      DB.type = 'pg';
      dbInstance = new Pool({
        connectionString: DATABASE_URL,
        ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false
      });
      await dbInstance.query('SELECT 1');
      console.log('✅ PostgreSQL Database connected successfully.');
    } else {
      dbType = 'sqlite';
      DB.type = 'sqlite';
      const dbPath = path.join(__dirname, 'school_club_attendance.db');
      dbInstance = await open({
        filename: dbPath,
        driver: Database
      });
      await dbInstance.run('PRAGMA foreign_keys = ON;');
      console.log(`✅ SQLite Database connected successfully: ${dbPath}`);
    }

    await runMigrations();
    await seedInitialData();
  } catch (err) {
    console.error('❌ Critical Database Connection Error:', err);
  }
}

// =======================================================================================
// 3. DATABASE MIGRATIONS & SCHEMA SPECIFICATION
// =======================================================================================
async function runMigrations() {
  const autoInc = dbType === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const textType = 'TEXT';
  const intType = 'INTEGER';
  const timeStampType = dbType === 'pg' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  // 1. Settings Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id ${autoInc},
      school_name ${textType} DEFAULT 'Central High School',
      school_address ${textType} DEFAULT '123 Academic Way, Education City',
      school_contact ${textType} DEFAULT '(555) 019-2831',
      school_email ${textType} DEFAULT 'contact@school.edu',
      school_year ${textType} DEFAULT '2026-2027',
      club_name ${textType} DEFAULT 'Computer & Robotics Society',
      club_adviser ${textType} DEFAULT 'Prof. Alex Mercer',
      organization_name ${textType} DEFAULT 'Student Activities Council',
      school_logo ${textType} DEFAULT '',
      club_logo ${textType} DEFAULT '',
      id_prefix ${textType} DEFAULT 'SC-2026-',
      id_starting_number ${intType} DEFAULT 1001,
      registration_enabled ${intType} DEFAULT 1,
      min_participation_threshold ${intType} DEFAULT 75,
      timezone ${textType} DEFAULT 'Asia/Manila',
      updated_at ${timeStampType}
    )
  `);

  // 2. Users Table (pinalitan ang email ng username)
  await DB.query(`
    CREATE TABLE IF NOT EXISTS users (
      id ${autoInc},
      username ${textType} UNIQUE NOT NULL,
      password ${textType} NOT NULL,
      role ${textType} NOT NULL,
      full_name ${textType} NOT NULL,
      student_id ${intType} DEFAULT NULL,
      created_at ${timeStampType}
    )
  `);

  // 3. Positions Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id ${autoInc},
      title ${textType} UNIQUE NOT NULL,
      description ${textType} DEFAULT '',
      created_at ${timeStampType}
    )
  `);

  // 4. Students Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS students (
      id ${autoInc},
      student_number ${textType} UNIQUE NOT NULL,
      first_name ${textType} NOT NULL,
      middle_name ${textType} DEFAULT '',
      last_name ${textType} NOT NULL,
      username ${textType} UNIQUE NOT NULL,
      contact_number ${textType} DEFAULT '',
      position_id ${intType} NOT NULL,
      photo_path ${textType} NOT NULL,
      qr_token ${textType} UNIQUE NOT NULL,
      qr_enabled ${intType} DEFAULT 1,
      registration_status ${textType} DEFAULT 'PENDING',
      membership_status ${textType} DEFAULT 'ACTIVE',
      date_joined ${textType} DEFAULT CURRENT_DATE,
      expiration_date ${textType} DEFAULT '',
      created_at ${timeStampType},
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE RESTRICT
    )
  `);

  // 5. Position History Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS position_history (
      id ${autoInc},
      student_id ${intType} NOT NULL,
      position_title ${textType} NOT NULL,
      school_year ${textType} NOT NULL,
      assigned_at ${timeStampType},
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )
  `);

  // 6. Events Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS events (
      id ${autoInc},
      event_name ${textType} NOT NULL,
      description ${textType} DEFAULT '',
      event_type ${textType} NOT NULL,
      event_date ${textType} NOT NULL,
      start_time ${textType} NOT NULL,
      end_time ${textType} NOT NULL,
      location ${textType} DEFAULT 'School Auditorium',
      organizer ${textType} DEFAULT 'Club Officers',
      late_threshold_minutes ${intType} DEFAULT 15,
      participant_scope ${textType} DEFAULT 'ALL',
      allowed_position_ids ${textType} DEFAULT '',
      status ${textType} DEFAULT 'UPCOMING',
      created_at ${timeStampType}
    )
  `);

  // 7. Attendance Records Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id ${autoInc},
      event_id ${intType} NOT NULL,
      student_id ${intType} NOT NULL,
      time_in ${timeStampType},
      time_out ${timeStampType} DEFAULT NULL,
      status ${textType} NOT NULL,
      scanned_by ${textType} DEFAULT 'SYSTEM',
      created_at ${timeStampType},
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      UNIQUE(event_id, student_id)
    )
  `);

  // 8. Excused Absences Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS excused_absences (
      id ${autoInc},
      event_id ${intType} NOT NULL,
      student_id ${intType} NOT NULL,
      reason ${textType} NOT NULL,
      notes ${textType} DEFAULT '',
      approved_by ${textType} NOT NULL,
      approved_date ${timeStampType},
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )
  `);

  // 9. Audit Logs Table
  await DB.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id ${autoInc},
      user_id ${intType} DEFAULT NULL,
      user_name ${textType} DEFAULT 'System',
      action ${textType} NOT NULL,
      details ${textType} NOT NULL,
      ip_address ${textType} DEFAULT '',
      created_at ${timeStampType}
    )
  `);
}

async function seedInitialData() {
  const settingsCount = await DB.getOne('SELECT COUNT(*) as cnt FROM system_settings');
  if (parseInt(settingsCount.cnt) === 0) {
    await DB.query(`
      INSERT INTO system_settings (
        school_name, school_address, school_contact, school_email, school_year,
        club_name, club_adviser, organization_name, id_prefix, id_starting_number
      ) VALUES (
        'Central High School', '123 Education Boulevard, Suite 100', '(02) 8800-1234',
        'info@centralhigh.edu.ph', '2026-2027', 'Robotics & Science Club',
        'Dr. Eleanor Vance', 'Supreme Student Government', 'SC-2026-', 1001
      )
    `);
  }

  const posCount = await DB.getOne('SELECT COUNT(*) as cnt FROM positions');
  if (parseInt(posCount.cnt) === 0) {
    const defaultPositions = [
      'President', 'Vice President', 'Secretary', 'Treasurer',
      'Auditor', 'Public Information Officer', 'Peace Officer',
      'Technical Officer', 'Event Coordinator', 'Member'
    ];
    for (const pos of defaultPositions) {
      await DB.query('INSERT INTO positions (title, description) VALUES ($1, $2)', [pos, `Official ${pos} of the student club`]);
    }
  }

  // Admin Account Seeding
  const adminCount = await DB.getOne('SELECT COUNT(*) as cnt FROM users WHERE role = $1', ['ADMIN']);
  if (parseInt(adminCount.cnt) === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await DB.query(`
      INSERT INTO users (username, password, role, full_name)
      VALUES ($1, $2, $3, $4)
    `, ['admin', hashedPassword, 'ADMIN', 'Club Adviser Admin']);
    console.log('🔑 Initial Admin Created: Username: admin | Password: admin123');
  }

  // Scanner Account Seeding
  const scannerCount = await DB.getOne('SELECT COUNT(*) as cnt FROM users WHERE role = $1', ['SCANNER']);
  if (parseInt(scannerCount.cnt) === 0) {
    const hashedPassword = await bcrypt.hash('scanner123', 10);
    await DB.query(`
      INSERT INTO users (username, password, role, full_name)
      VALUES ($1, $2, $3, $4)
    `, ['scanner', hashedPassword, 'SCANNER', 'Official Gate Scanner']);
    console.log('🔑 Initial Scanner User Created: Username: scanner | Password: scanner123');
  }
}

// =======================================================================================
// 4. SECURITY & AUTHORIZATION MIDDLEWARE
// =======================================================================================
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please login.' });
  }
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient permissions.' });
    }
    next();
  };
}

async function logAudit(req, action, details) {
  try {
    const userId = req.session?.user?.id || null;
    const userName = req.session?.user?.full_name || 'System Guest';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    await DB.query(`
      INSERT INTO audit_logs (user_id, user_name, action, details, ip_address)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, userName, action, details, ip]);
  } catch (err) {
    console.error('Audit Log Error:', err);
  }
}

// =======================================================================================
// 5. HELPER UTILITIES
// =======================================================================================
async function generateUniqueStudentNumber() {
  const settings = await DB.getOne('SELECT id_prefix, id_starting_number FROM system_settings LIMIT 1');
  const prefix = settings?.id_prefix || 'SC-2026-';
  const startNum = settings?.id_starting_number || 1001;

  const countRes = await DB.getOne('SELECT COUNT(*) as cnt FROM students');
  const nextSeq = startNum + parseInt(countRes.cnt || 0);
  let studentNum = `${prefix}${String(nextSeq).padStart(6, '0')}`;

  let exists = await DB.getOne('SELECT id FROM students WHERE student_number = $1', [studentNum]);
  let offset = 1;
  while (exists) {
    studentNum = `${prefix}${String(nextSeq + offset).padStart(6, '0')}`;
    exists = await DB.getOne('SELECT id FROM students WHERE student_number = $1', [studentNum]);
    offset++;
  }

  return studentNum;
}

function generateSecureToken() {
  return 'QR-' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

async function autoProcessAbsentStudents(eventId) {
  const event = await DB.getOne('SELECT * FROM events WHERE id = $1', [eventId]);
  if (!event) return;

  const eligibleStudents = await DB.getAll("SELECT id FROM students WHERE registration_status = 'APPROVED' AND membership_status = 'ACTIVE'");

  for (const student of eligibleStudents) {
    const existing = await DB.getOne('SELECT id FROM attendance WHERE event_id = $1 AND student_id = $2', [eventId, student.id]);
    const excused = await DB.getOne('SELECT id FROM excused_absences WHERE event_id = $1 AND student_id = $2', [eventId, student.id]);

    if (!existing && !excused) {
      await DB.query(`
        INSERT INTO attendance (event_id, student_id, status, scanned_by)
        VALUES ($1, $2, 'ABSENT', 'SYSTEM')
      `, [eventId, student.id]);
    } else if (excused && !existing) {
      await DB.query(`
        INSERT INTO attendance (event_id, student_id, status, scanned_by)
        VALUES ($1, $2, 'EXCUSED', 'SYSTEM')
      `, [eventId, student.id]);
    }
  }
}

// =======================================================================================
// 6. REST API ENDPOINTS
// =======================================================================================

// --- AUTHENTICATION ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    const user = await DB.getOne('SELECT * FROM users WHERE username = $1', [username.toLowerCase().trim()]);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      student_id: user.student_id
    };

    await logAudit(req, 'USER_LOGIN', `User ${user.username} logged in successfully.`);
    return res.json({ success: true, user: req.session.user });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.session?.user) {
    await logAudit(req, 'USER_LOGOUT', `User ${req.session.user.username} logged out.`);
  }
  req.session.destroy();
  return res.json({ success: true, message: 'Logged out successfully.' });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ success: false, authenticated: false });
  }
  return res.json({ success: true, authenticated: true, user: req.session.user });
});

// --- PUBLIC REGISTRATION ---
app.post('/api/public/register', upload.single('student_photo'), async (req, res) => {
  try {
    const settings = await DB.getOne('SELECT registration_enabled, school_year FROM system_settings LIMIT 1');
    if (!settings || parseInt(settings.registration_enabled) !== 1) {
      return res.status(403).json({ success: false, message: 'Registration is currently closed.' });
    }

    const { first_name, middle_name, last_name, username, contact_number, position_id } = req.body;

    if (!first_name || !last_name || !username || !position_id || !req.file) {
      return res.status(400).json({ success: false, message: 'Missing mandatory fields or photo upload.' });
    }

    const existingStudent = await DB.getOne('SELECT id FROM students WHERE username = $1', [username.toLowerCase().trim()]);
    if (existingStudent) {
      return res.status(400).json({ success: false, message: 'This username is already taken.' });
    }

    const photoPath = `/uploads/photos/${req.file.filename}`;
    const autoStudentNum = await generateUniqueStudentNumber();
    const qrToken = generateSecureToken();

    const insertResult = await DB.query(`
      INSERT INTO students (
        student_number, first_name, middle_name, last_name, username,
        contact_number, position_id, photo_path, qr_token, registration_status, membership_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', 'ACTIVE')
    `, [
      autoStudentNum, first_name.trim(), (middle_name || '').trim(), last_name.trim(),
      username.toLowerCase().trim(), (contact_number || '').trim(), parseInt(position_id), photoPath, qrToken
    ]);

    const pos = await DB.getOne('SELECT title FROM positions WHERE id = $1', [position_id]);
    await DB.query(`
      INSERT INTO position_history (student_id, position_title, school_year)
      VALUES ($1, $2, $3)
    `, [insertResult.insertId, pos ? pos.title : 'Member', settings.school_year || '2026-2027']);

    await logAudit(req, 'STUDENT_SELF_REGISTRATION', `Self registered: ${first_name} ${last_name} (${autoStudentNum})`);

    return res.json({
      success: true,
      message: 'Registration submitted successfully! Pending approval.',
      student_number: autoStudentNum
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- SETTINGS ---
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await DB.getOne('SELECT * FROM system_settings LIMIT 1');
    return res.json({ success: true, settings });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/settings', requireAuth, requireRole(['ADMIN']), upload.fields([
  { name: 'school_logo', maxCount: 1 },
  { name: 'club_logo', maxCount: 1 }
]), async (req, res) => {
  try {
    const {
      school_name, school_address, school_contact, school_email, school_year,
      club_name, club_adviser, organization_name, id_prefix, id_starting_number,
      registration_enabled, min_participation_threshold, timezone
    } = req.body;

    const currentSettings = await DB.getOne('SELECT * FROM system_settings LIMIT 1');
    let schoolLogoPath = currentSettings ? currentSettings.school_logo : '';
    let clubLogoPath = currentSettings ? currentSettings.club_logo : '';

    if (req.files && req.files['school_logo']) {
      schoolLogoPath = `/uploads/logos/${req.files['school_logo'][0].filename}`;
    }
    if (req.files && req.files['club_logo']) {
      clubLogoPath = `/uploads/logos/${req.files['club_logo'][0].filename}`;
    }

    await DB.query(`
      UPDATE system_settings SET
        school_name = $1, school_address = $2, school_contact = $3, school_email = $4,
        school_year = $5, club_name = $6, club_adviser = $7, organization_name = $8,
        id_prefix = $9, id_starting_number = $10, registration_enabled = $11,
        min_participation_threshold = $12, timezone = $13, school_logo = $14, club_logo = $15,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $16
    `, [
      school_name, school_address, school_contact, school_email, school_year,
      club_name, club_adviser, organization_name, id_prefix, parseInt(id_starting_number),
      parseInt(registration_enabled), parseInt(min_participation_threshold), timezone,
      schoolLogoPath, clubLogoPath, currentSettings.id
    ]);

    await logAudit(req, 'SETTINGS_UPDATE', 'System parameters updated.');
    return res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- POSITIONS ---
app.get('/api/positions', async (req, res) => {
  try {
    const positions = await DB.getAll('SELECT * FROM positions ORDER BY id ASC');
    return res.json({ success: true, positions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/positions', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Position title is required.' });

    await DB.query('INSERT INTO positions (title, description) VALUES ($1, $2)', [title.trim(), (description || '').trim()]);
    await logAudit(req, 'POSITION_CREATE', `Created position: ${title}`);
    return res.json({ success: true, message: 'Position added successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- STUDENTS ---
app.get('/api/students', requireAuth, async (req, res) => {
  try {
    const { search, position_id, registration_status, membership_status } = req.query;
    let sql = `
      SELECT s.*, p.title as position_title 
      FROM students s
      JOIN positions p ON s.position_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (s.student_number LIKE $${params.length} OR s.first_name LIKE $${params.length} OR s.last_name LIKE $${params.length} OR s.username LIKE $${params.length})`;
    }
    if (position_id) {
      params.push(position_id);
      sql += ` AND s.position_id = $${params.length}`;
    }
    if (registration_status) {
      params.push(registration_status);
      sql += ` AND s.registration_status = $${params.length}`;
    }
    if (membership_status) {
      params.push(membership_status);
      sql += ` AND s.membership_status = $${params.length}`;
    }

    sql += ' ORDER BY s.id DESC';
    const students = await DB.getAll(sql, params);
    return res.json({ success: true, students });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/students/:id/approve', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const student = await DB.getOne('SELECT * FROM students WHERE id = $1', [req.params.id]);
    if (!student) return res.status(404).json({ success: false, message: 'Student record not found.' });

    await DB.query("UPDATE students SET registration_status = 'APPROVED' WHERE id = $1", [req.params.id]);

    const existingUser = await DB.getOne('SELECT id FROM users WHERE username = $1', [student.username]);
    if (!existingUser) {
      const defaultPassword = await bcrypt.hash('student123', 10);
      await DB.query(`
        INSERT INTO users (username, password, role, full_name, student_id)
        VALUES ($1, $2, 'STUDENT', $3, $4)
      `, [student.username, defaultPassword, `${student.first_name} ${student.last_name}`, student.id]);
    }

    await logAudit(req, 'STUDENT_APPROVE', `Approved student: ${student.first_name} ${student.last_name}`);
    return res.json({ success: true, message: 'Student approved. Default student password: student123' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/students/:id/reject', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    await DB.query("UPDATE students SET registration_status = 'REJECTED' WHERE id = $1", [req.params.id]);
    await logAudit(req, 'STUDENT_REJECT', `Rejected student ID: ${req.params.id}`);
    return res.json({ success: true, message: 'Student registration rejected.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/students/:id', requireAuth, requireRole(['ADMIN']), upload.single('student_photo'), async (req, res) => {
  try {
    const studentId = req.params.id;
    const { first_name, middle_name, last_name, username, contact_number, position_id, membership_status } = req.body;

    const currentStudent = await DB.getOne('SELECT * FROM students WHERE id = $1', [studentId]);
    if (!currentStudent) return res.status(404).json({ success: false, message: 'Student not found.' });

    let photoPath = currentStudent.photo_path;
    if (req.file) {
      photoPath = `/uploads/photos/${req.file.filename}`;
    }

    await DB.query(`
      UPDATE students SET
        first_name = $1, middle_name = $2, last_name = $3, username = $4,
        contact_number = $5, position_id = $6, photo_path = $7, membership_status = $8
      WHERE id = $9
    `, [first_name, middle_name, last_name, username, contact_number, parseInt(position_id), photoPath, membership_status, studentId]);

    await DB.query('UPDATE users SET username = $1, full_name = $2 WHERE student_id = $3', [
      username, `${first_name} ${last_name}`, studentId
    ]);

    await logAudit(req, 'STUDENT_UPDATE', `Updated profile for ID: ${studentId}`);
    return res.json({ success: true, message: 'Student profile updated successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- EVENTS ---
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const events = await DB.getAll('SELECT * FROM events ORDER BY event_date DESC, start_time DESC');
    return res.json({ success: true, events });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/events', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { event_name, description, event_type, event_date, start_time, end_time, location, organizer, late_threshold_minutes, participant_scope, allowed_position_ids } = req.body;

    if (!event_name || !event_type || !event_date || !start_time || !end_time) {
      return res.status(400).json({ success: false, message: 'Required event fields are missing.' });
    }

    await DB.query(`
      INSERT INTO events (
        event_name, description, event_type, event_date, start_time, end_time,
        location, organizer, late_threshold_minutes, participant_scope, allowed_position_ids, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'UPCOMING')
    `, [
      event_name, description || '', event_type, event_date, start_time, end_time,
      location || 'School Auditorium', organizer || 'Club Officers', parseInt(late_threshold_minutes || 15),
      participant_scope || 'ALL', allowed_position_ids || ''
    ]);

    await logAudit(req, 'EVENT_CREATE', `Created event: ${event_name}`);
    return res.json({ success: true, message: 'Event created successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- ATTENDANCE SCANNER ---
app.post('/api/attendance/scan', requireAuth, requireRole(['ADMIN', 'SCANNER']), async (req, res) => {
  try {
    const { qr_token, event_id, scan_type } = req.body;

    if (!qr_token || !event_id) {
      return res.status(400).json({ success: false, message: 'QR Token and Event ID required.' });
    }

    const event = await DB.getOne('SELECT * FROM events WHERE id = $1', [event_id]);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    const student = await DB.getOne(`
      SELECT s.*, p.title as position_title 
      FROM students s
      JOIN positions p ON s.position_id = p.id
      WHERE s.qr_token = $1
    `, [qr_token.trim()]);

    if (!student) {
      return res.status(400).json({ success: false, message: 'INVALID QR CODE. Unrecognized token.' });
    }

    const studentFullName = `${student.first_name} ${student.last_name}`;
    const existingAttendance = await DB.getOne('SELECT * FROM attendance WHERE event_id = $1 AND student_id = $2', [event_id, student.id]);
    const currentTime = new Date();

    if (scan_type === 'TIME_OUT') {
      if (!existingAttendance) {
        return res.status(400).json({ success: false, message: `${studentFullName} has not timed in yet.` });
      }

      await DB.query('UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = $1', [existingAttendance.id]);
      await logAudit(req, 'ATTENDANCE_TIME_OUT', `${studentFullName} timed out.`);

      return res.json({
        success: true,
        student: { id: student.id, student_number: student.student_number, full_name: studentFullName, position: student.position_title, photo_path: student.photo_path },
        message: `${studentFullName}, time out recorded.`
      });
    } else {
      if (existingAttendance && existingAttendance.time_in) {
        return res.status(400).json({ success: false, message: `${studentFullName}, attendance already recorded.` });
      }

      let status = 'PRESENT';
      if (event.event_date && event.start_time) {
        const eventStartDateTime = new Date(`${event.event_date}T${event.start_time}`);
        const lateThresholdMs = (event.late_threshold_minutes || 15) * 60 * 1000;
        if (currentTime.getTime() > (eventStartDateTime.getTime() + lateThresholdMs)) {
          status = 'LATE';
        }
      }

      await DB.query(`
        INSERT INTO attendance (event_id, student_id, time_in, status, scanned_by)
        VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4)
      `, [event_id, student.id, status, req.session.user.full_name]);

      await logAudit(req, 'ATTENDANCE_TIME_IN', `${studentFullName} checked in as ${status}`);

      return res.json({
        success: true,
        student: { id: student.id, student_number: student.student_number, full_name: studentFullName, position: student.position_title, photo_path: student.photo_path },
        status,
        message: `${studentFullName}, attendance recorded.`
      });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- DASHBOARD & REPORTS ---
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const totalStudentsRes = await DB.getOne("SELECT COUNT(*) as cnt FROM students WHERE registration_status = 'APPROVED'");
    const activeStudentsRes = await DB.getOne("SELECT COUNT(*) as cnt FROM students WHERE registration_status = 'APPROVED' AND membership_status = 'ACTIVE'");

    const attendanceCounts = await DB.getOne(`
      SELECT 
        COUNT(DISTINCT CASE WHEN status = 'PRESENT' THEN student_id END) as present_count,
        COUNT(DISTINCT CASE WHEN status = 'LATE' THEN student_id END) as late_count,
        COUNT(DISTINCT CASE WHEN status = 'ABSENT' THEN student_id END) as absent_count
      FROM attendance
    `);

    return res.json({
      success: true,
      stats: {
        total_students: parseInt(totalStudentsRes?.cnt || 0),
        active_students: parseInt(activeStudentsRes?.cnt || 0),
        present_today: parseInt(attendanceCounts?.present_count || 0),
        late_today: parseInt(attendanceCounts?.late_count || 0),
        absent_today: parseInt(attendanceCounts?.absent_count || 0)
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/reports/attendance', requireAuth, async (req, res) => {
  try {
    const records = await DB.getAll(`
      SELECT a.*, s.student_number, s.first_name, s.last_name, s.username, p.title as position_title, e.event_name, e.event_date
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN positions p ON s.position_id = p.id
      JOIN events e ON a.event_id = e.id
      ORDER BY a.id DESC
    `);
    return res.json({ success: true, records });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// =======================================================================================
// 7. PRINTING ENGINE (A4 ID CARDS)
// =======================================================================================
app.get('/print/student-ids', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const settings = await DB.getOne('SELECT * FROM system_settings LIMIT 1');
    const students = await DB.getAll(`
      SELECT s.*, p.title as position_title 
      FROM students s
      JOIN positions p ON s.position_id = p.id
      WHERE s.registration_status = 'APPROVED'
      ORDER BY s.last_name ASC
    `);

    for (const student of students) {
      student.qrDataUrl = await QRCode.toDataURL(student.qr_token, { width: 300, margin: 1 });
    }

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Print ID Cards</title>
        <style>
          @page { size: A4 portrait; margin: 10mm; }
          body { font-family: sans-serif; background: #f0f2f5; padding: 20px; }
          .a4-page { width: 190mm; background: white; margin: 0 auto; padding: 5mm; display: grid; grid-template-columns: repeat(2, 1fr); gap: 6mm; }
          .id-card { width: 88mm; height: 60mm; border: 1px solid #000; border-radius: 6px; padding: 6px; display: flex; flex-direction: column; justify-content: space-between; }
          .card-header { display: flex; justify-content: space-between; border-bottom: 2px solid #2563eb; }
          .student-photo { width: 30mm; height: 35mm; object-fit: cover; }
          .qr-img { width: 25mm; height: 25mm; }
        </style>
      </head>
      <body>
        <div class="a4-page">
          ${students.map(s => `
            <div class="id-card">
              <div class="card-header">
                <strong>${settings?.club_name || 'Student Club'}</strong>
              </div>
              <div style="display:flex; gap:10px; align-items:center;">
                <img src="${s.photo_path}" class="student-photo">
                <div>
                  <h4>${s.first_name} ${s.last_name}</h4>
                  <p>${s.position_title}</p>
                  <small>${s.student_number}</small>
                </div>
                <img src="${s.qrDataUrl}" class="qr-img">
              </div>
            </div>
          `).join('')}
        </div>
      </body>
      </html>
    `;
    return res.send(html);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// =======================================================================================
// 8. FRONTEND SPA APPLICATION CLIENT
// =======================================================================================
app.get('*', (req, res) => {
  const spaHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QR Attendance Management System</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
      <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
    </head>
    <body class="bg-light">
      <div id="app"></div>

      <script>
        const state = { user: null };

        async function initApp() {
          try {
            const authRes = await fetch('/api/auth/me');
            const authData = await authRes.json();
            if (authData.authenticated) state.user = authData.user;
          } catch(e) {}
          render();
        }

        function render() {
          const app = document.getElementById('app');
          if (!state.user) {
            app.innerHTML = \`
              <div class="container vh-100 d-flex align-items-center justify-content-center">
                <div class="card p-4 shadow-sm" style="max-width:400px; width:100%;">
                  <h4 class="text-center mb-3">System Login</h4>
                  <form onsubmit="handleLogin(event)">
                    <div class="mb-3">
                      <label class="form-label">Username</label>
                      <input type="text" id="loginUsername" class="form-control" required placeholder="admin">
                    </div>
                    <div class="mb-3">
                      <label class="form-label">Password</label>
                      <input type="password" id="loginPassword" class="form-control" required placeholder="admin123">
                    </div>
                    <button class="btn btn-primary w-100">Login</button>
                  </form>
                </div>
              </div>
            \`;
          } else {
            app.innerHTML = \`
              <div class="container py-4">
                <div class="d-flex justify-content-between align-items-center mb-4">
                  <h3>Welcome, \${state.user.full_name} (\${state.user.role})</h3>
                  <button class="btn btn-outline-danger" onclick="handleLogout()">Logout</button>
                </div>
                <div class="alert alert-info">Naka-login ka na gamit ang username: <strong>\${state.user.username}</strong></div>
              </div>
            \`;
          }
        }

        async function handleLogin(e) {
          e.preventDefault();
          const username = document.getElementById('loginUsername').value;
          const password = document.getElementById('loginPassword').value;
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const data = await res.json();
          if (data.success) { state.user = data.user; render(); }
          else alert(data.message);
        }

        async function handleLogout() {
          await fetch('/api/auth/logout', { method: 'POST' });
          state.user = null;
          render();
        }

        initApp();
      </script>
    </body>
    </html>
  `;
  res.send(spaHtml);
});

// =======================================================================================
// 9. APPLICATION BOOTSTRAPPER
// =======================================================================================
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`
===================================================================
🚀 SCHOOL STUDENT CLUB QR ATTENDANCE SYSTEM READY
📡 Server Listening on Port: ${PORT}
🌐 Access URL: http://localhost:${PORT}
===================================================================
    `);
  });
}).catch(err => {
  console.error('Failed to initialize server application:', err);
});
