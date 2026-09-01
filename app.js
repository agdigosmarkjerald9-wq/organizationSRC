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
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
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
    secure: false, // Set to true if running strictly behind HTTPS/TLS proxy
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
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// =======================================================================================
// 2. UNIVERSAL DATABASE ABSTRACTION LAYER (SQLite3 + PostgreSQL Engine Support)
// =======================================================================================
let dbInstance = null;
let dbType = 'sqlite'; // 'sqlite' or 'pg'

class DatabaseAdapter {
  constructor() {
    this.type = dbType;
  }

  async query(sql, params = []) {
    if (this.type === 'sqlite') {
      let sqliteSql = sql;
      // Convert PostgreSQL positional parameters ($1, $2...) to SQLite standard '?'
      sqliteSql = sqliteSql.replace(/\$(\d+)/g, '?');

      const trimmedSql = sqliteSql.trim().toUpperCase();
      const isSelect = trimmedSql.startsWith('SELECT') || trimmedSql.startsWith('PRAGMA');
      
      if (isSelect) {
        return await dbInstance.all(sqliteSql, params);
      } else {
        const result = await dbInstance.run(sqliteSql, params);
        return { rows: [], insertId: result.lastID, rowCount: result.changes };
      }
    } else {
      // PostgreSQL Driver Execution
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

  // Auto-migration helper: Automatic column rename from email to username if present
  try {
    if (dbType === 'sqlite') {
      const userCols = await DB.getAll("PRAGMA table_info(users)");
      if (userCols.some(col => col.name === 'email')) {
        await DB.query("ALTER TABLE users RENAME COLUMN email TO username");
      }
      const studentCols = await DB.getAll("PRAGMA table_info(students)");
      if (studentCols.some(col => col.name === 'email')) {
        await DB.query("ALTER TABLE students RENAME COLUMN email TO username");
      }
    } else if (dbType === 'pg') {
      await DB.query("ALTER TABLE users RENAME COLUMN email TO username").catch(() => {});
      await DB.query("ALTER TABLE students RENAME COLUMN email TO username").catch(() => {});
    }
  } catch (e) {
    // Column might already be renamed or tables not yet created
  }

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

  // 2. Users Table (Updated: username)
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

  // 4. Students Table (Updated: username)
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

  const adminCount = await DB.getOne('SELECT COUNT(*) as cnt FROM users WHERE role = $1', ['ADMIN']);
  if (parseInt(adminCount.cnt) === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await DB.query(`
      INSERT INTO users (username, password, role, full_name)
      VALUES ($1, $2, $3, $4)
    `, ['admin', hashedPassword, 'ADMIN', 'Club Adviser Admin']);
    console.log('🔑 Initial Admin Created: Username: admin | Password: admin123');
  }

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
      return res.status(403).json({ success: false, message: 'Registration is currently closed by the Club Adviser.' });
    }

    const { first_name, middle_name, last_name, username, contact_number, position_id } = req.body;

    if (!first_name || !last_name || !username || !position_id || !req.file) {
      return res.status(400).json({ success: false, message: 'Missing mandatory fields or photo upload.' });
    }

    const existingStudent = await DB.getOne('SELECT id FROM students WHERE username = $1', [username.toLowerCase().trim()]);
    if (existingStudent) {
      return res.status(400).json({ success: false, message: 'An account with this username already exists.' });
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

app.put('/api/positions/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description } = req.body;
    await DB.query('UPDATE positions SET title = $1, description = $2 WHERE id = $3', [title.trim(), (description || '').trim(), id]);
    await logAudit(req, 'POSITION_UPDATE', `Updated position ID ${id} to ${title}`);
    return res.json({ success: true, message: 'Position updated successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/positions/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { id } = req.params;
    const assigned = await DB.getOne('SELECT COUNT(*) as cnt FROM students WHERE position_id = $1', [id]);
    if (parseInt(assigned.cnt) > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete position assigned to ${assigned.cnt} student(s).` });
    }
    await DB.query('DELETE FROM positions WHERE id = $1', [id]);
    await logAudit(req, 'POSITION_DELETE', `Deleted position ID ${id}`);
    return res.json({ success: true, message: 'Position removed successfully.' });
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

app.get('/api/students/:id', requireAuth, async (req, res) => {
  try {
    const student = await DB.getOne(`
      SELECT s.*, p.title as position_title 
      FROM students s
      JOIN positions p ON s.position_id = p.id
      WHERE s.id = $1
    `, [req.params.id]);

    if (!student) return res.status(404).json({ success: false, message: 'Student not found.' });

    const history = await DB.getAll('SELECT * FROM position_history WHERE student_id = $1 ORDER BY id DESC', [req.params.id]);
    return res.json({ success: true, student, position_history: history });
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
    return res.json({ success: true, message: 'Student approved successfully. User account created.' });
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

    if (parseInt(position_id) !== parseInt(currentStudent.position_id)) {
      const settings = await DB.getOne('SELECT school_year FROM system_settings LIMIT 1');
      const newPos = await DB.getOne('SELECT title FROM positions WHERE id = $1', [position_id]);
      await DB.query(`
        INSERT INTO position_history (student_id, position_title, school_year)
        VALUES ($1, $2, $3)
      `, [studentId, newPos ? newPos.title : 'Updated Position', settings?.school_year || '2026-2027']);
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

app.post('/api/students/:id/regenerate-qr', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const newToken = generateSecureToken();
    await DB.query('UPDATE students SET qr_token = $1 WHERE id = $2', [newToken, req.params.id]);
    await logAudit(req, 'QR_REGENERATE', `Regenerated QR token for student ID ${req.params.id}`);
    return res.json({ success: true, message: 'QR Code regenerated successfully.', qr_token: newToken });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/students/:id/toggle-qr', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { enabled } = req.body;
    await DB.query('UPDATE students SET qr_enabled = $1 WHERE id = $2', [enabled ? 1 : 0, req.params.id]);
    await logAudit(req, 'QR_TOGGLE', `Set QR state to ${enabled} for student ID ${req.params.id}`);
    return res.json({ success: true, message: `QR status updated.` });
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

app.put('/api/events/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { event_name, description, event_type, event_date, start_time, end_time, location, organizer, late_threshold_minutes, participant_scope, allowed_position_ids, status } = req.body;

    await DB.query(`
      UPDATE events SET
        event_name = $1, description = $2, event_type = $3, event_date = $4,
        start_time = $5, end_time = $6, location = $7, organizer = $8,
        late_threshold_minutes = $9, participant_scope = $10, allowed_position_ids = $11, status = $12
      WHERE id = $13
    `, [
      event_name, description, event_type, event_date, start_time, end_time,
      location, organizer, parseInt(late_threshold_minutes), participant_scope,
      allowed_position_ids, status, req.params.id
    ]);

    if (status === 'COMPLETED') {
      await autoProcessAbsentStudents(req.params.id);
    }

    await logAudit(req, 'EVENT_UPDATE', `Updated event ID ${req.params.id}`);
    return res.json({ success: true, message: 'Event updated successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/events/:eventId/excuse', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { student_id, reason, notes } = req.body;
    const { eventId } = req.params;

    if (!student_id || !reason) {
      return res.status(400).json({ success: false, message: 'Student and reason are required.' });
    }

    await DB.query(`
      INSERT INTO excused_absences (event_id, student_id, reason, notes, approved_by, approved_date)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    `, [eventId, student_id, reason, notes || '', req.session.user.full_name]);

    const existing = await DB.getOne('SELECT id FROM attendance WHERE event_id = $1 AND student_id = $2', [eventId, student_id]);
    if (existing) {
      await DB.query('UPDATE attendance SET status = $1 WHERE id = $2', ['EXCUSED', existing.id]);
    } else {
      await DB.query(`
        INSERT INTO attendance (event_id, student_id, status, scanned_by)
        VALUES ($1, $2, 'EXCUSED', $3)
      `, [eventId, student_id, req.session.user.full_name]);
    }

    await logAudit(req, 'STUDENT_EXCUSED', `Excused student ID ${student_id} for event ID ${eventId}`);
    return res.json({ success: true, message: 'Student excused successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- ATTENDANCE SCANNER ---
app.post('/api/attendance/scan', requireAuth, requireRole(['ADMIN', 'SCANNER']), async (req, res) => {
  try {
    const { qr_token, event_id, scan_type } = req.body;

    if (!qr_token || !event_id) {
      return res.status(400).json({ success: false, result_code: 'INVALID_PARAMETERS', message: 'QR Token and Event ID required.' });
    }

    const event = await DB.getOne('SELECT * FROM events WHERE id = $1', [event_id]);
    if (!event) {
      return res.status(404).json({ success: false, result_code: 'EVENT_NOT_FOUND', message: 'Event not found.' });
    }

    const student = await DB.getOne(`
      SELECT s.*, p.title as position_title 
      FROM students s
      JOIN positions p ON s.position_id = p.id
      WHERE s.qr_token = $1
    `, [qr_token.trim()]);

    if (!student) {
      return res.status(400).json({ success: false, result_code: 'INVALID_QR', message: 'INVALID QR CODE. Unrecognized token.' });
    }

    if (parseInt(student.qr_enabled) !== 1) {
      return res.status(400).json({ success: false, result_code: 'QR_DISABLED', message: 'STUDENT QR CODE IS DISABLED.' });
    }

    if (student.registration_status !== 'APPROVED') {
      return res.status(400).json({ success: false, result_code: 'PENDING_APPROVAL', message: 'REGISTRATION IS NOT APPROVED.' });
    }

    const studentFullName = `${student.first_name} ${student.last_name}`;
    const existingAttendance = await DB.getOne('SELECT * FROM attendance WHERE event_id = $1 AND student_id = $2', [event_id, student.id]);
    const currentTime = new Date();

    if (scan_type === 'TIME_OUT') {
      if (!existingAttendance) {
        return res.status(400).json({
          success: false, result_code: 'NO_TIME_IN', student_name: studentFullName,
          message: `${studentFullName} has not timed in for this event yet.`
        });
      }
      if (existingAttendance.time_out) {
        return res.status(400).json({
          success: false, result_code: 'DUPLICATE_TIME_OUT', student_name: studentFullName,
          message: `${studentFullName}, already timed out.`
        });
      }

      await DB.query('UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = $1', [existingAttendance.id]);
      await logAudit(req, 'ATTENDANCE_TIME_OUT', `${studentFullName} timed out.`);

      return res.json({
        success: true,
        result_code: 'TIME_OUT_SUCCESS',
        student: { id: student.id, student_number: student.student_number, full_name: studentFullName, position: student.position_title, photo_path: student.photo_path },
        time: currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: existingAttendance.status,
        message: `${studentFullName}, time out recorded.`
      });
    } else {
      if (existingAttendance && existingAttendance.time_in) {
        return res.status(400).json({
          success: false, result_code: 'ALREADY_RECORDED', student_name: studentFullName,
          student: { student_number: student.student_number, full_name: studentFullName, position: student.position_title, photo_path: student.photo_path },
          message: `${studentFullName}, attendance already recorded.`
        });
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
        result_code: 'TIME_IN_SUCCESS',
        student: { id: student.id, student_number: student.student_number, full_name: studentFullName, position: student.position_title, photo_path: student.photo_path },
        time: currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status,
        message: `${studentFullName}, attendance recorded.`
      });
    }
  } catch (err) {
    return res.status(500).json({ success: false, result_code: 'SERVER_ERROR', message: err.message });
  }
});

// --- DASHBOARD & REPORTS ---
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const { event_id } = req.query;

    const totalStudentsRes = await DB.getOne("SELECT COUNT(*) as cnt FROM students WHERE registration_status = 'APPROVED'");
    const activeStudentsRes = await DB.getOne("SELECT COUNT(*) as cnt FROM students WHERE registration_status = 'APPROVED' AND membership_status = 'ACTIVE'");
    const pendingRegistrationsRes = await DB.getOne("SELECT COUNT(*) as cnt FROM students WHERE registration_status = 'PENDING'");

    let attendanceWhere = 'WHERE 1=1';
    const params = [];

    if (event_id && event_id !== 'ALL') {
      params.push(event_id);
      attendanceWhere += ` AND a.event_id = $${params.length}`;
    } else {
      attendanceWhere += ` AND (a.time_in >= CURRENT_DATE OR a.created_at >= CURRENT_DATE)`;
    }

    const attendanceCounts = await DB.getOne(`
      SELECT 
        COUNT(DISTINCT CASE WHEN a.status = 'PRESENT' THEN a.student_id END) as present_count,
        COUNT(DISTINCT CASE WHEN a.status = 'LATE' THEN a.student_id END) as late_count,
        COUNT(DISTINCT CASE WHEN a.status = 'ABSENT' THEN a.student_id END) as absent_count,
        COUNT(DISTINCT CASE WHEN a.status = 'EXCUSED' THEN a.student_id END) as excused_count
      FROM attendance a
      ${attendanceWhere}
    `, params);

    const presentCount = parseInt(attendanceCounts?.present_count || 0);
    const lateCount = parseInt(attendanceCounts?.late_count || 0);
    const absentCount = parseInt(attendanceCounts?.absent_count || 0);
    const excusedCount = parseInt(attendanceCounts?.excused_count || 0);

    const validAttendees = presentCount + lateCount;
    const activeStudents = parseInt(activeStudentsRes?.cnt || 0);
    const expectedParticipants = event_id && event_id !== 'ALL' ? (validAttendees + absentCount + excusedCount || activeStudents) : activeStudents;
    const attendanceRate = expectedParticipants > 0 ? ((validAttendees / expectedParticipants) * 100).toFixed(1) : '0.0';

    const recentScans = await DB.getAll(`
      SELECT a.*, s.student_number, s.first_name, s.last_name, s.photo_path, p.title as position_title, e.event_name
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN positions p ON s.position_id = p.id
      JOIN events e ON a.event_id = e.id
      ORDER BY a.id DESC LIMIT 10
    `);

    return res.json({
      success: true,
      stats: {
        total_students: parseInt(totalStudentsRes?.cnt || 0),
        active_students: activeStudents,
        pending_registrations: parseInt(pendingRegistrationsRes?.cnt || 0),
        present_today: presentCount,
        late_today: lateCount,
        absent_today: absentCount,
        excused_today: excusedCount,
        attendance_rate: `${attendanceRate}%`
      },
      recent_scans: recentScans
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/reports/attendance', requireAuth, async (req, res) => {
  try {
    const { event_id, position_id, status } = req.query;
    let sql = `
      SELECT a.*, s.student_number, s.first_name, s.last_name, s.username, p.title as position_title, e.event_name, e.event_date
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN positions p ON s.position_id = p.id
      JOIN events e ON a.event_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (event_id) {
      params.push(event_id);
      sql += ` AND a.event_id = $${params.length}`;
    }
    if (position_id) {
      params.push(position_id);
      sql += ` AND s.position_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      sql += ` AND a.status = $${params.length}`;
    }

    sql += ' ORDER BY a.id DESC';
    const records = await DB.getAll(sql, params);
    return res.json({ success: true, records });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/export/attendance/csv', requireAuth, async (req, res) => {
  try {
    const records = await DB.getAll(`
      SELECT s.student_number, s.first_name, s.last_name, p.title as position, e.event_name, e.event_date, a.time_in, a.time_out, a.status
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN positions p ON s.position_id = p.id
      JOIN events e ON a.event_id = e.id
      ORDER BY a.id DESC
    `);

    let csvContent = 'Student Number,First Name,Last Name,Position,Event Name,Event Date,Time In,Time Out,Status\n';
    records.forEach(r => {
      const timeInStr = r.time_in ? new Date(r.time_in).toLocaleTimeString() : 'N/A';
      const timeOutStr = r.time_out ? new Date(r.time_out).toLocaleTimeString() : 'N/A';
      csvContent += `"${r.student_number}","${r.first_name}","${r.last_name}","${r.position}","${r.event_name}","${r.event_date}","${timeInStr}","${timeOutStr}","${r.status}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=Club_Attendance_Report_${Date.now()}.csv`);
    return res.status(200).send(csvContent);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

// --- BACKUP & RESTORE ---
app.post('/api/system/backup', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const backupFileName = `backup-${Date.now()}.json`;
    const backupFilePath = path.join(BACKUPS_DIR, backupFileName);
    const tables = ['system_settings', 'positions', 'students', 'position_history', 'events', 'attendance', 'excused_absences', 'users', 'audit_logs'];
    const backupData = {};

    for (const tbl of tables) {
      backupData[tbl] = await DB.getAll(`SELECT * FROM ${tbl}`);
    }

    fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2));
    await logAudit(req, 'DATABASE_BACKUP', `Saved: ${backupFileName}`);
    return res.json({ success: true, message: 'Backup created.', filename: backupFileName });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/system/backups', requireAuth, requireRole(['ADMIN']), (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.json'));
    return res.json({ success: true, backups: files });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/audit-logs', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const logs = await DB.getAll('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100');
    return res.json({ success: true, logs });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/system/health', async (req, res) => {
  try {
    await DB.query('SELECT 1');
    return res.json({ success: true, status: 'CONNECTED', db_type: dbType, timestamp: new Date() });
  } catch (err) {
    return res.status(500).json({ success: false, status: 'DISCONNECTED', error: err.message });
  }
});

// =======================================================================================
// 7. PRINTING ENGINE (A4 ID CARDS)
// =======================================================================================
function generateA4PagesHTML(students, settings) {
  let pagesHTML = '';
  const pageSize = 8;

  for (let i = 0; i < students.length; i += pageSize) {
    const chunk = students.slice(i, i + pageSize);
    pagesHTML += `<div class="a4-page">`;

    chunk.forEach(student => {
      const schoolLogo = settings.school_logo || 'https://via.placeholder.com/50?text=School';
      const clubLogo = settings.club_logo || 'https://via.placeholder.com/50?text=Club';

      pagesHTML += `
        <div class="id-card">
          <div class="card-header">
            <img src="${schoolLogo}" class="card-logo" alt="School Logo" />
            <div class="card-header-text">
              <div class="school-title">${settings.school_name || 'School Name'}</div>
              <div class="club-title">${settings.club_name || 'Student Club'}</div>
            </div>
            <img src="${clubLogo}" class="card-logo" alt="Club Logo" />
          </div>
          <div class="card-body">
            <img src="${student.photo_path}" class="student-photo" alt="Student Photo" />
            <div class="student-info">
              <div class="info-label">Name</div>
              <div class="info-value">${student.first_name} ${student.last_name}</div>
              <div class="info-label">Student No.</div>
              <div class="info-value">${student.student_number}</div>
              <div class="info-label">Position</div>
              <div class="info-value" style="color: #2563eb;">${student.position_title}</div>
            </div>
            <div class="qr-container">
              <img src="${student.qrDataUrl}" class="large-qr" alt="QR Code" />
            </div>
          </div>
          <div class="card-footer">
            OFFICIAL MEMBER ID • S.Y. ${settings.school_year || '2026-2027'}
          </div>
        </div>
      `;
    });

    pagesHTML += `</div>`;
  }
  return pagesHTML;
}

app.get('/print/student-ids', requireAuth, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { position_id, student_ids } = req.query;
    const settings = await DB.getOne('SELECT * FROM system_settings LIMIT 1');

    let sql = `
      SELECT s.*, p.title as position_title 
      FROM students s
      JOIN positions p ON s.position_id = p.id
      WHERE s.registration_status = 'APPROVED'
    `;
    const params = [];

    if (student_ids) {
      const idsArray = student_ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
      if (idsArray.length > 0) {
        sql += ` AND s.id IN (${idsArray.join(',')})`;
      }
    } else if (position_id) {
      params.push(position_id);
      sql += ` AND s.position_id = $${params.length}`;
    }

    sql += ' ORDER BY s.last_name ASC';
    const students = await DB.getAll(sql, params);

    for (const student of students) {
      student.qrDataUrl = await QRCode.toDataURL(student.qr_token, {
        width: 300,
        margin: 1,
        color: { dark: '#000000', light: '#FFFFFF' }
      });
    }

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Print Student Club IDs</title>
        <style>
          @page { size: A4 portrait; margin: 10mm; }
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; }
          body { background: #f0f2f5; padding: 20px; }
          .no-print-bar { background: #1e293b; color: white; padding: 15px 20px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
          .btn-print { background: #2563eb; color: white; border: none; padding: 10px 20px; font-weight: bold; border-radius: 6px; cursor: pointer; }
          .a4-page { width: 190mm; min-height: 277mm; background: white; margin: 0 auto 20px auto; padding: 5mm; display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(4, 1fr); gap: 6mm; page-break-after: always; }
          .id-card { width: 88mm; height: 60mm; border: 1.5px solid #0f172a; border-radius: 8px; padding: 6px; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; background: #ffffff; }
          .card-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #2563eb; padding-bottom: 4px; }
          .card-logo { width: 28px; height: 28px; object-fit: contain; }
          .card-header-text { text-align: center; flex: 1; }
          .school-title { font-size: 8px; font-weight: bold; color: #1e293b; text-transform: uppercase; }
          .club-title { font-size: 7.5px; font-weight: 800; color: #2563eb; }
          .card-body { display: flex; gap: 6px; align-items: center; margin-top: 4px; flex: 1; }
          .student-photo { width: 32mm; height: 38mm; object-fit: cover; border-radius: 4px; border: 1px solid #cbd5e1; }
          .student-info { flex: 1; font-size: 8px; color: #334155; }
          .info-label { font-weight: bold; color: #64748b; font-size: 6.5px; text-transform: uppercase; }
          .info-value { font-weight: 700; color: #0f172a; margin-bottom: 3px; font-size: 8.5px; }
          .qr-container { display: flex; align-items: center; justify-content: center; }
          .large-qr { width: 26mm; height: 26mm; }
          .card-footer { background: #0f172a; color: white; text-align: center; font-size: 7px; padding: 2px 0; font-weight: 600; border-radius: 0 0 4px 4px; }
          @media print { .no-print-bar { display: none !important; } body { background: white; padding: 0; } .a4-page { margin: 0; width: 100%; height: 100%; } }
        </style>
      </head>
      <body>
        <div class="no-print-bar">
          <div>
            <h2>Student Club ID Printing Engine</h2>
            <p>Layout: 8 IDs per Page | Total Cards: ${students.length}</p>
          </div>
          <button class="btn-print" onclick="window.print()">🖨️ Print ID Cards</button>
        </div>
        ${generateA4PagesHTML(students, settings || {})}
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
      <title>School Student Club QR Attendance Management System</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css">
      <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
      <style>
        :root { --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; }
        .wrapper { display: flex; width: 100%; min-height: 100vh; }
        #sidebar { width: var(--sidebar-width); background: #0f172a; color: white; flex-shrink: 0; }
        #sidebar .sidebar-header { padding: 20px; background: #1e293b; border-bottom: 1px solid #334155; }
        #sidebar ul.components { padding: 15px 0; list-style: none; margin: 0; }
        #sidebar ul li a { padding: 12px 20px; display: flex; align-items: center; gap: 12px; color: #94a3b8; text-decoration: none; font-size: 15px; font-weight: 500; }
        #sidebar ul li a:hover, #sidebar ul li.active > a { color: white; background: #2563eb; }
        #content { flex-grow: 1; padding: 25px; background: #f8fafc; overflow-y: auto; }
        .card-stat { border: none; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .qr-scanner-viewport { width: 100%; max-width: 500px; height: 350px; background: #000; border-radius: 12px; overflow: hidden; margin: 0 auto; }
        .live-scan-card { border-left: 5px solid #10b981; }
      </style>
    </head>
    <body>
      <div id="app"></div>

      <script>
        const state = { user: null, settings: null };

        function navigateTo(url) {
          window.history.pushState({}, '', url);
          router();
        }

        window.addEventListener('popstate', router);

        async function initApp() {
          try {
            const setRes = await fetch('/api/settings');
            const setData = await setRes.json();
            if (setData.success) state.settings = setData.settings;

            const authRes = await fetch('/api/auth/me');
            const authData = await authRes.json();
            if (authData.authenticated) state.user = authData.user;
          } catch(e) { console.error(e); }
          router();
        }

        function router() {
          const path = window.location.pathname;
          const appDiv = document.getElementById('app');

          if (path === '/register') { renderPublicRegistration(appDiv); return; }
          if (!state.user) { renderLogin(appDiv); return; }

          appDiv.innerHTML = \`
            <div class="wrapper">
              <nav id="sidebar">
                <div class="sidebar-header text-center">
                  <img src="\${state.settings?.club_logo || 'https://via.placeholder.com/60'}" style="width:50px;height:50px;object-fit:contain;" class="mb-2">
                  <h6 class="mb-0 text-white">\${state.settings?.club_name || 'Student Club'}</h6>
                  <small class="text-muted">\${state.settings?.school_name || 'School'}</small>
                </div>
                <ul class="components">
                  \${state.user.role === 'ADMIN' ? \`
                    <li class="\${path === '/' || path === '/dashboard' ? 'active' : ''}"><a href="#" onclick="navigateTo('/dashboard')"><i class="bi bi-speedometer2"></i> Dashboard</a></li>
                    <li class="\${path === '/students' ? 'active' : ''}"><a href="#" onclick="navigateTo('/students')"><i class="bi bi-people"></i> Student Registry</a></li>
                    <li class="\${path === '/positions' ? 'active' : ''}"><a href="#" onclick="navigateTo('/positions')"><i class="bi bi-briefcase"></i> Positions</a></li>
                    <li class="\${path === '/events' ? 'active' : ''}"><a href="#" onclick="navigateTo('/events')"><i class="bi bi-calendar-event"></i> Events</a></li>
                    <li class="\${path === '/scanner' ? 'active' : ''}"><a href="#" onclick="navigateTo('/scanner')"><i class="bi bi-qr-code-scan"></i> QR Scanner</a></li>
                    <li class="\${path === '/reports' ? 'active' : ''}"><a href="#" onclick="navigateTo('/reports')"><i class="bi bi-file-earmark-bar-graph"></i> Reports</a></li>
                    <li class="\${path === '/settings' ? 'active' : ''}"><a href="#" onclick="navigateTo('/settings')"><i class="bi bi-gear"></i> Settings</a></li>
                  \` : ''}
                  \${state.user.role === 'SCANNER' ? \`
                    <li class="\${path === '/scanner' ? 'active' : ''}"><a href="#" onclick="navigateTo('/scanner')"><i class="bi bi-qr-code-scan"></i> Scanner Portal</a></li>
                  \` : ''}
                  \${state.user.role === 'STUDENT' ? \`
                    <li class="\${path === '/member' ? 'active' : ''}"><a href="#" onclick="navigateTo('/member')"><i class="bi bi-person-badge"></i> My Student ID</a></li>
                  \` : ''}
                  <li><a href="#" onclick="handleLogout()"><i class="bi bi-box-arrow-right"></i> Logout (\${state.user.full_name})</a></li>
                </ul>
              </nav>
              <main id="content"><div id="page-container"></div></main>
            </div>
          \`;

          const container = document.getElementById('page-container');
          if (path === '/' || path === '/dashboard') renderDashboard(container);
          else if (path === '/students') renderStudents(container);
          else if (path === '/positions') renderPositions(container);
          else if (path === '/events') renderEvents(container);
          else if (path === '/scanner') renderScanner(container);
          else if (path === '/reports') renderReports(container);
          else if (path === '/settings') renderSettings(container);
          else if (path === '/member') renderStudentPortal(container);
          else renderDashboard(container);
        }

        async function renderPublicRegistration(container) {
          const posRes = await fetch('/api/positions');
          const posData = await posRes.json();
          const positions = posData.positions || [];

          container.innerHTML = \`
            <div class="container py-5">
              <div class="row justify-content-center">
                <div class="col-md-6">
                  <div class="card shadow-lg border-0 rounded-4 p-4">
                    <h4 class="fw-bold text-center mb-3">Registration Form</h4>
                    <form id="publicRegForm" onsubmit="handlePublicRegister(event)">
                      <div class="mb-3"><label class="form-label">First Name *</label><input type="text" class="form-control" name="first_name" required></div>
                      <div class="mb-3"><label class="form-label">Last Name *</label><input type="text" class="form-control" name="last_name" required></div>
                      <div class="mb-3"><label class="form-label">Username *</label><input type="text" class="form-control" name="username" required></div>
                      <div class="mb-3">
                        <label class="form-label">Position *</label>
                        <select class="form-select" name="position_id" required>
                          <option value="">-- Select --</option>
                          \${positions.map(p => \`<option value="\${p.id}">\${p.title}</option>\`).join('')}
                        </select>
                      </div>
                      <div class="mb-4"><label class="form-label">Photo Upload *</label><input type="file" class="form-control" name="student_photo" accept="image/*" required></div>
                      <button type="submit" class="btn btn-primary w-100 font-weight-bold py-2">Submit Application</button>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          \`;
        }

        async function handlePublicRegister(e) {
          e.preventDefault();
          const res = await fetch('/api/public/register', { method: 'POST', body: new FormData(e.target) });
          const data = await res.json();
          if (data.success) { alert(\`\${data.message}\\nAssigned No: \${data.student_number}\`); window.location.href = '/'; }
          else alert(data.message);
        }

        function renderLogin(container) {
          container.innerHTML = \`
            <div class="container vh-100 d-flex align-items-center justify-content-center">
              <div class="card shadow-lg border-0 rounded-4 p-4" style="max-width: 400px; width:100%;">
                <h4 class="fw-bold text-center mb-3">System Login</h4>
                <form onsubmit="handleLogin(event)">
                  <div class="mb-3"><label class="form-label">Username</label><input type="text" id="loginUsername" class="form-control" required placeholder="admin"></div>
                  <div class="mb-3"><label class="form-label">Password</label><input type="password" id="loginPassword" class="form-control" required placeholder="••••••••"></div>
                  <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Login</button>
                </form>
              </div>
            </div>
          \`;
        }

        async function handleLogin(e) {
          e.preventDefault();
          const username = document.getElementById('loginUsername').value;
          const password = document.getElementById('loginPassword').value;
          const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
          const data = await res.json();
          if (data.success) { state.user = data.user; router(); } else alert(data.message);
        }

        async function handleLogout() {
          await fetch('/api/auth/logout', { method: 'POST' });
          state.user = null;
          router();
        }

        async function renderDashboard(container) {
          const res = await fetch('/api/dashboard/stats');
          const data = await res.json();
          const stats = data.stats || {};

          container.innerHTML = \`
            <h3 class="fw-bold mb-4">Executive Dashboard</h3>
            <div class="row g-3 mb-4">
              <div class="col-md-3"><div class="card card-stat bg-primary text-white p-3"><small>Active Members</small><h2 class="fw-bold mt-1 mb-0">\${stats.active_students || 0}</h2></div></div>
              <div class="col-md-3"><div class="card card-stat bg-success text-white p-3"><small>Present Today</small><h2 class="fw-bold mt-1 mb-0">\${stats.present_today || 0}</h2></div></div>
              <div class="col-md-3"><div class="card card-stat bg-warning text-dark p-3"><small>Late Today</small><h2 class="fw-bold mt-1 mb-0">\${stats.late_today || 0}</h2></div></div>
              <div class="col-md-3"><div class="card card-stat bg-danger text-white p-3"><small>Absent Today</small><h2 class="fw-bold mt-1 mb-0">\${stats.absent_today || 0}</h2></div></div>
            </div>
          \`;
        }

        async function renderScanner(container) {
          const eventsRes = await fetch('/api/events');
          const eventsData = await eventsRes.json();
          const activeEvents = (eventsData.events || []).filter(e => e.status !== 'COMPLETED');

          container.innerHTML = \`
            <div class="row justify-content-center">
              <div class="col-md-8 text-center">
                <h3 class="fw-bold mb-3">QR Scanner</h3>
                <div class="mb-3 text-start">
                  <label class="form-label fw-bold">Select Active Event *</label>
                  <select class="form-select" id="scannerEventSelect">
                    \${activeEvents.map(e => \`<option value="\${e.id}">\${e.event_name} (\${e.event_date})</option>\`).join('')}
                  </select>
                </div>
                <div class="btn-group w-100 mb-3" role="group">
                  <input type="radio" class="btn-check" name="scanType" id="typeIn" value="TIME_IN" checked>
                  <label class="btn btn-outline-success" for="typeIn">Time In</label>
                  <input type="radio" class="btn-check" name="scanType" id="typeOut" value="TIME_OUT">
                  <label class="btn btn-outline-danger" for="typeOut">Time Out</label>
                </div>
                <div id="reader" class="qr-scanner-viewport mb-4"></div>
                <div id="liveScanResult"></div>
              </div>
            </div>
          \`;

          const html5QrCode = new Html5Qrcode("reader");
          html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            async (decodedText) => {
              html5QrCode.pause();
              await processScan(decodedText);
              setTimeout(() => html5QrCode.resume(), 2500);
            },
            () => {}
          );
        }

        async function processScan(qrToken) {
          const eventId = document.getElementById('scannerEventSelect').value;
          const scanType = document.querySelector('input[name="scanType"]:checked').value;

          const res = await fetch('/api/attendance/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: qrToken, event_id: eventId, scan_type: scanType })
          });
          const data = await res.json();
          const resultDiv = document.getElementById('liveScanResult');

          speakText(data.message || (data.success ? 'Scan recorded' : 'Error'));

          if (data.success) {
            resultDiv.innerHTML = \`
              <div class="card live-scan-card p-3 text-start shadow-sm">
                <div class="d-flex align-items-center gap-3">
                  <img src="\${data.student.photo_path}" style="width:60px;height:60px;object-fit:cover;" class="rounded-circle">
                  <div>
                    <h5 class="fw-bold mb-0">\${data.student.full_name}</h5>
                    <span class="badge bg-primary">\${data.student.position}</span>
                    <div class="small text-muted mt-1">Status: <strong>\${data.status}</strong></div>
                  </div>
                </div>
              </div>
            \`;
          } else {
            resultDiv.innerHTML = \`<div class="alert alert-danger font-weight-bold">\${data.message}</div>\`;
          }
        }

        function speakText(text) {
          if ('speechSynthesis' in window) {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 1.0;
            window.speechSynthesis.speak(utterance);
          }
        }

        async function renderStudents(c) {
          const res = await fetch('/api/students');
          const data = await res.json();
          const list = data.students || [];
          c.innerHTML = \`
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h3>Student Registry</h3>
              <a href="/print/student-ids" target="_blank" class="btn btn-primary"><i class="bi bi-printer"></i> Print All IDs</a>
            </div>
            <table class="table table-striped table-hover bg-white rounded shadow-sm">
              <thead><tr><th>Student No</th><th>Name</th><th>Username</th><th>Position</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                \${list.map(s => \`
                  <tr>
                    <td>\${s.student_number}</td>
                    <td>\${s.first_name} \${s.last_name}</td>
                    <td>\${s.username}</td>
                    <td>\${s.position_title}</td>
                    <td><span class="badge bg-\${s.registration_status === 'APPROVED' ? 'success' : 'warning'}">\${s.registration_status}</span></td>
                    <td>
                      \${s.registration_status === 'PENDING' ? \`
                        <button class="btn btn-sm btn-success" onclick="approveStudent(\${s.id})">Approve</button>
                        <button class="btn btn-sm btn-danger" onclick="rejectStudent(\${s.id})">Reject</button>
                      \` : '<span class="text-muted">Approved</span>'}
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          \`;
        }

        async function approveStudent(id) {
          const res = await fetch(\`/api/students/\${id}/approve\`, { method: 'POST' });
          const data = await res.json();
          alert(data.message);
          renderStudents(document.getElementById('page-container'));
        }

        async function rejectStudent(id) {
          const res = await fetch(\`/api/students/\${id}/reject\`, { method: 'POST' });
          const data = await res.json();
          alert(data.message);
          renderStudents(document.getElementById('page-container'));
        }

        async function renderPositions(c) {
          const res = await fetch('/api/positions');
          const data = await res.json();
          const list = data.positions || [];
          c.innerHTML = \`
            <h3>Positions Manager</h3>
            <ul class="list-group mt-3">
              \${list.map(p => \`<li class="list-group-item d-flex justify-content-between align-items-center">\${p.title} <small class="text-muted">\${p.description}</small></li>\`).join('')}
            </ul>
          \`;
        }

        async function renderEvents(c) {
          const res = await fetch('/api/events');
          const data = await res.json();
          const list = data.events || [];
          c.innerHTML = \`
            <h3>Events</h3>
            <table class="table table-bordered bg-white mt-3">
              <thead><tr><th>Event Name</th><th>Type</th><th>Date</th><th>Status</th></tr></thead>
              <tbody>
                \${list.map(e => \`<tr><td>\${e.event_name}</td><td>\${e.event_type}</td><td>\${e.event_date}</td><td>\${e.status}</td></tr>\`).join('')}
              </tbody>
            </table>
          \`;
        }

        async function renderReports(c) {
          const res = await fetch('/api/reports/attendance');
          const data = await res.json();
          const list = data.records || [];
          c.innerHTML = \`
            <div class="d-flex justify-content-between align-items-center mb-3">
              <h3>Reports & Export</h3>
              <a href="/api/export/attendance/csv" class="btn btn-success"><i class="bi bi-file-earmark-excel"></i> Export CSV</a>
            </div>
            <table class="table table-hover bg-white rounded shadow-sm">
              <thead><tr><th>Student</th><th>Event</th><th>Date</th><th>Time In</th><th>Status</th></tr></thead>
              <tbody>
                \${list.map(r => \`
                  <tr>
                    <td>\${r.first_name} \${r.last_name}</td>
                    <td>\${r.event_name}</td>
                    <td>\${r.event_date}</td>
                    <td>\${r.time_in ? new Date(r.time_in).toLocaleTimeString() : 'N/A'}</td>
                    <td><span class="badge bg-secondary">\${r.status}</span></td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          \`;
        }

        function renderSettings(c) { c.innerHTML = '<h3>Settings</h3><p>Manage configurations and execute database snapshots via <code>/api/system/backup</code>.</p>'; }
        function renderStudentPortal(c) { c.innerHTML = '<h3>Digital Student Portal</h3><p>Welcome! View active event participation and present your assigned ID QR for rapid check-in.</p>'; }

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
