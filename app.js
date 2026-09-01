/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Complete, Monolithic, Production-Ready Express Application
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'school-club-qr-secret-key-2026';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Manila';

// Ensure required local directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const photosDir = path.join(uploadsDir, 'photos');
const logosDir = path.join(uploadsDir, 'logos');
const backupsDir = path.join(__dirname, 'backups');
const dataDir = path.join(__dirname, 'data');

[uploadsDir, photosDir, logosDir, backupsDir, dataDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Configure Multer for File Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'student_photo') cb(null, photosDir);
    else cb(null, logosDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Invalid file type. Only JPG, JPEG, PNG, and WEBP images are allowed.'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Database Abstraction Layer supporting SQLite and PostgreSQL
let dbDriver = 'sqlite';
let sqliteDb = null;
let pgPool = null;

if (DATABASE_URL) {
  dbDriver = 'pg';
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
  console.log('🔗 Configured PostgreSQL Production Database Pool.');
} else {
  dbDriver = 'sqlite';
  const dbPath = path.join(dataDir, 'attendance.db');
  sqliteDb = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('❌ Error opening SQLite database:', err.message);
    else console.log('🔗 Connected to local SQLite database at', dbPath);
  });
}

// Unified Database Query Wrapper
function queryDB(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (dbDriver === 'pg') {
      let paramCounter = 1;
      const pgSql = sql.replace(/\?/g, () => `$${paramCounter++}`);
      pgPool.query(pgSql, params, (err, res) => {
        if (err) return reject(err);
        resolve(res.rows);
      });
    } else {
      const isSelect = sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('PRAGMA');
      if (isSelect) {
        sqliteDb.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        });
      } else {
        sqliteDb.run(sql, params, function (err) {
          if (err) return reject(err);
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      }
    }
  });
}

function runDB(sql, params = []) {
  return queryDB(sql, params);
}

// Database Initialization & Table Migration Engine
async function initDatabase() {
  try {
    const isPg = dbDriver === 'pg';
    const autoInc = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const textType = 'TEXT';
    const intType = 'INTEGER';
    const timestampType = isPg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

    await runDB(`CREATE TABLE IF NOT EXISTS settings (
      id ${autoInc},
      school_name ${textType} DEFAULT 'Central High School',
      school_address ${textType} DEFAULT '123 Academic Way, Education City',
      school_contact ${textType} DEFAULT '(555) 019-2831',
      school_email ${textType} DEFAULT 'info@centralhigh.edu',
      school_year ${textType} DEFAULT '2026-2027',
      student_club_name ${textType} DEFAULT 'Computer Science Club',
      club_adviser ${textType} DEFAULT 'Prof. Alexander Wright',
      organization_name ${textType} DEFAULT 'Student Organizations Council',
      school_logo ${textType} DEFAULT '',
      club_logo ${textType} DEFAULT '',
      registration_open ${intType} DEFAULT 1,
      student_number_prefix ${textType} DEFAULT 'SC-2026-',
      student_number_starting ${intType} DEFAULT 1,
      student_number_length ${intType} DEFAULT 6,
      min_participation_threshold ${intType} DEFAULT 70,
      updated_at ${timestampType}
    )`);

    // Ensure default settings exist
    const settings = await queryDB('SELECT * FROM settings LIMIT 1');
    if (settings.length === 0) {
      await runDB(`INSERT INTO settings (school_name, student_club_name) VALUES ('Central High School', 'Computer Science Club')`);
    }

    await runDB(`CREATE TABLE IF NOT EXISTS users (
      id ${autoInc},
      name ${textType} NOT NULL,
      email ${textType} UNIQUE NOT NULL,
      password ${textType} NOT NULL,
      role ${textType} NOT NULL, -- 'ADMIN', 'SCANNER', 'STUDENT'
      student_id ${intType} DEFAULT NULL,
      created_at ${timestampType}
    )`);

    await runDB(`CREATE TABLE IF NOT EXISTS positions (
      id ${autoInc},
      name ${textType} UNIQUE NOT NULL,
      description ${textType} DEFAULT '',
      created_at ${timestampType}
    )`);

    // Default positions
    const defaultPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor', 'PIO', 'Peace Officer', 'Member'];
    for (const pos of defaultPositions) {
      await runDB(`INSERT INTO positions (name) VALUES (?) ON CONFLICT DO NOTHING`, [pos]);
    }

    await runDB(`CREATE TABLE IF NOT EXISTS students (
      id ${autoInc},
      student_number ${textType} UNIQUE NOT NULL,
      first_name ${textType} NOT NULL,
      middle_name ${textType} DEFAULT '',
      last_name ${textType} NOT NULL,
      email ${textType} UNIQUE NOT NULL,
      contact_number ${textType} DEFAULT '',
      position_id ${intType} REFERENCES positions(id),
      photo ${textType} NOT NULL,
      qr_token ${textType} UNIQUE NOT NULL,
      qr_status ${intType} DEFAULT 1,
      status ${textType} DEFAULT 'PENDING', -- 'PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'ALUMNI', 'RESIGNED'
      membership_date ${textType} DEFAULT CURRENT_DATE,
      expiration_date ${textType} DEFAULT '',
      created_at ${timestampType}
    )`);

    await runDB(`CREATE TABLE IF NOT EXISTS position_history (
      id ${autoInc},
      student_id ${intType} NOT NULL,
      position_name ${textType} NOT NULL,
      school_year ${textType} NOT NULL,
      assigned_at ${timestampType}
    )`);

    await runDB(`CREATE TABLE IF NOT EXISTS events (
      id ${autoInc},
      name ${textType} NOT NULL,
      description ${textType} DEFAULT '',
      event_type ${textType} DEFAULT 'General Club Attendance',
      event_date ${textType} NOT NULL,
      start_time ${textType} NOT NULL,
      end_time ${textType} NOT NULL,
      location ${textType} DEFAULT '',
      organizer ${textType} DEFAULT '',
      late_threshold_minutes ${intType} DEFAULT 15,
      target_participants ${textType} DEFAULT 'ALL', -- 'ALL', 'OFFICERS', 'CUSTOM'
      target_position_ids ${textType} DEFAULT '',
      status ${textType} DEFAULT 'UPCOMING', -- 'UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED'
      created_at ${timestampType}
    )`);

    await runDB(`CREATE TABLE IF NOT EXISTS attendance (
      id ${autoInc},
      event_id ${intType} NOT NULL,
      student_id ${intType} NOT NULL,
      time_in ${textType} DEFAULT NULL,
      time_out ${textType} DEFAULT NULL,
      status ${textType} NOT NULL, -- 'PRESENT', 'LATE', 'ABSENT', 'EXCUSED'
      scan_by ${intType} DEFAULT NULL,
      created_at ${timestampType},
      UNIQUE(event_id, student_id)
    )`);

    await runDB(`CREATE TABLE IF NOT EXISTS excused_absences (
      id ${autoInc},
      event_id ${intType} NOT NULL,
      student_id ${intType} NOT NULL,
      reason ${textType} NOT NULL,
      approved_by ${textType} NOT NULL,
      notes ${textType} DEFAULT '',
      created_at ${timestampType}
    )`);

    await runDB(`CREATE TABLE IF NOT EXISTS audit_logs (
      id ${autoInc},
      user_id ${intType} DEFAULT NULL,
      user_name ${textType} DEFAULT 'System',
      action ${textType} NOT NULL,
      details ${textType} NOT NULL,
      ip_address ${textType} DEFAULT '',
      created_at ${timestampType}
    )`);

    // Ensure initial Admin Account
    const adminCheck = await queryDB("SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1");
    if (adminCheck.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await runDB(
        "INSERT INTO users (name, email, password, role) VALUES ('Club Adviser Admin', 'admin@school.edu', ?, 'ADMIN')",
        [hashedPassword]
      );
      console.log('✅ Default Admin user created: admin@school.edu / admin123');
    }

    // Ensure initial Scanner Account
    const scannerCheck = await queryDB("SELECT * FROM users WHERE role = 'SCANNER' LIMIT 1");
    if (scannerCheck.length === 0) {
      const hashedScannerPassword = await bcrypt.hash('scanner123', 10);
      await runDB(
        "INSERT INTO users (name, email, password, role) VALUES ('Official Scanner Operator', 'scanner@school.edu', ?, 'SCANNER')",
        [hashedScannerPassword]
      );
      console.log('✅ Default Scanner user created: scanner@school.edu / scanner123');
    }

    console.log('⚡ Database schema verification & migrations completed successfully.');
  } catch (err) {
    console.error('❌ Critical Database Initialization Error:', err);
  }
}

initDatabase();

// Audit Logger Helper
async function logAudit(req, action, details) {
  try {
    const userId = req.session && req.session.user ? req.session.user.id : null;
    const userName = req.session && req.session.user ? req.session.user.name : 'System/Guest';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    await runDB(
      'INSERT INTO audit_logs (user_id, user_name, action, details, ip_address) VALUES (?, ?, ?, ?, ?)',
      [userId, userName, action, details, ip]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

// Student Number Generator Service
async function generateStudentNumber() {
  const settingsRows = await queryDB('SELECT * FROM settings LIMIT 1');
  const settings = settingsRows[0] || {};
  const prefix = settings.student_number_prefix || 'SC-2026-';
  const startNum = settings.student_number_starting || 1;
  const padLen = settings.student_number_length || 6;

  const countRows = await queryDB('SELECT COUNT(*) as total FROM students');
  const total = parseInt(countRows[0].total || 0, 10);
  const nextVal = startNum + total;

  let seq = nextVal.toString().padStart(padLen, '0');
  let candidate = `${prefix}${seq}`;

  // Collision Check
  let exists = await queryDB('SELECT id FROM students WHERE student_number = ?', [candidate]);
  let offset = 1;
  while (exists.length > 0) {
    seq = (nextVal + offset).toString().padStart(padLen, '0');
    candidate = `${prefix}${seq}`;
    exists = await queryDB('SELECT id FROM students WHERE student_number = ?', [candidate]);
    offset++;
  }
  return candidate;
}

// Express App Configuration
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 Hours
}));

// Static Asset Express Routing
app.use('/uploads', express.static(uploadsDir));

// Authentication Middlewares
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login?error=Please%20log%20in%20to%20access%20the%20system');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login?error=Session%20expired');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).send('<h1>403 Forbidden: Insufficient Permissions</h1><a href="/login">Return to Login</a>');
    }
    next();
  };
}

// Universal UI Layout & Page Templating Engine
async function renderPage(title, contentHtml, req, activeNav = 'dashboard') {
  const settingsRows = await queryDB('SELECT * FROM settings LIMIT 1');
  const sys = settingsRows[0] || {};
  const user = req.session ? req.session.user : null;

  const schoolLogoSrc = sys.school_logo ? `/uploads/logos/${sys.school_logo}` : '';
  const clubLogoSrc = sys.club_logo ? `/uploads/logos/${sys.club_logo}` : '';

  let navItems = '';
  if (user) {
    if (user.role === 'ADMIN') {
      navItems = `
        <a href="/admin/dashboard" class="${activeNav === 'dashboard' ? 'active' : ''}">📊 Dashboard</a>
        <a href="/admin/students" class="${activeNav === 'students' ? 'active' : ''}">🎓 Students</a>
        <a href="/admin/registrations" class="${activeNav === 'registrations' ? 'active' : ''}">📝 Pending Reg</a>
        <a href="/admin/positions" class="${activeNav === 'positions' ? 'active' : ''}">🎖️ Positions</a>
        <a href="/admin/events" class="${activeNav === 'events' ? 'active' : ''}">📅 Events</a>
        <a href="/admin/attendance" class="${activeNav === 'attendance' ? 'active' : ''}">⏱️ Attendance</a>
        <a href="/admin/reports" class="${activeNav === 'reports' ? 'active' : ''}">📈 Reports</a>
        <a href="/admin/id-cards" class="${activeNav === 'id-cards' ? 'active' : ''}">🪪 Print Student IDs</a>
        <a href="/scanner" target="_blank">📱 Scanner Portal</a>
        <a href="/admin/settings" class="${activeNav === 'settings' ? 'active' : ''}">⚙️ Settings</a>
        <a href="/admin/audit" class="${activeNav === 'audit' ? 'active' : ''}">📜 Audit Logs</a>
        <a href="/admin/backup" class="${activeNav === 'backup' ? 'active' : ''}">💾 Backup & Restore</a>
      `;
    } else if (user.role === 'SCANNER') {
      navItems = `
        <a href="/scanner" class="${activeNav === 'scanner' ? 'active' : ''}">📱 Scanner Portal</a>
        <a href="/change-password">🔒 Change Password</a>
      `;
    } else if (user.role === 'STUDENT') {
      navItems = `
        <a href="/member" class="${activeNav === 'member' ? 'active' : ''}">👤 Student ID & Portal</a>
        <a href="/change-password">🔒 Change Password</a>
      `;
    }
  }

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ${sys.student_club_name || 'Club Attendance System'}</title>
    <style>
      :root {
        --primary: #1e3a8a;
        --primary-dark: #1e293b;
        --secondary: #0284c7;
        --accent: #f59e0b;
        --bg: #f8fafc;
        --surface: #ffffff;
        --text: #0f172a;
        --text-muted: #64748b;
        --border: #e2e8f0;
        --success: #16a34a;
        --danger: #dc2626;
        --warning: #d97706;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      body { background-color: var(--bg); color: var(--text); display: flex; flex-direction: column; min-height: 100vh; }
      header { background: var(--primary-dark); color: white; padding: 0.75rem 1.5rem; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      .header-brand { display: flex; align-items: center; gap: 0.75rem; }
      .header-brand img { height: 42px; width: 42px; object-fit: contain; border-radius: 6px; background: white; padding: 2px; }
      .header-title h1 { font-size: 1.15rem; font-weight: 700; line-height: 1.2; }
      .header-title p { font-size: 0.75rem; color: #94a3b8; }
      .user-badge { display: flex; align-items: center; gap: 1rem; font-size: 0.875rem; }
      .user-badge a { color: #f1f5f9; text-decoration: none; padding: 0.35rem 0.75rem; background: rgba(255,255,255,0.15); border-radius: 4px; font-weight: 500; transition: background 0.2s; }
      .user-badge a:hover { background: rgba(255,255,255,0.3); }
      .app-layout { display: flex; flex: 1; }
      aside { width: 250px; background: var(--surface); border-right: 1px solid var(--border); padding: 1rem 0; flex-shrink: 0; }
      aside nav { display: flex; flex-direction: column; }
      aside nav a { padding: 0.75rem 1.25rem; color: var(--text); text-decoration: none; font-size: 0.9rem; font-weight: 500; display: flex; align-items: center; gap: 0.6rem; border-left: 4px solid transparent; transition: all 0.2s; }
      aside nav a:hover, aside nav a.active { background: #eff6ff; color: var(--secondary); border-left-color: var(--secondary); }
      main { flex: 1; padding: 1.5rem; overflow-y: auto; max-width: 1400px; margin: 0 auto; width: 100%; }
      .card { background: var(--surface); border-radius: 8px; border: 1px solid var(--border); padding: 1.25rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
      .card-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 1rem; color: var(--primary-dark); display: flex; justify-content: space-between; align-items: center; }
      .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
      .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; border-top: 4px solid var(--secondary); }
      .stat-card.success { border-top-color: var(--success); }
      .stat-card.warning { border-top-color: var(--warning); }
      .stat-card.danger { border-top-color: var(--danger); }
      .stat-val { font-size: 1.8rem; font-weight: 800; color: var(--primary-dark); margin-top: 0.25rem; }
      .stat-lbl { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600; }
      table { width: 100%; border-collapse: collapse; font-size: 0.875rem; text-align: left; }
      th, td { padding: 0.75rem 0.85rem; border-bottom: 1px solid var(--border); }
      th { background: #f1f5f9; font-weight: 600; color: var(--text-muted); }
      tr:hover { background: #f8fafc; }
      .badge { display: inline-block; padding: 0.2rem 0.55rem; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; }
      .badge-success { background: #dcfce7; color: #15803d; }
      .badge-warning { background: #fef3c7; color: #b45309; }
      .badge-danger { background: #fee2e2; color: #b91c1c; }
      .badge-info { background: #e0f2fe; color: #0369a1; }
      .btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1rem; font-size: 0.875rem; font-weight: 600; border-radius: 6px; border: none; cursor: pointer; text-decoration: none; transition: background 0.2s; }
      .btn-primary { background: var(--secondary); color: white; }
      .btn-primary:hover { background: #0284c7; }
      .btn-success { background: var(--success); color: white; }
      .btn-danger { background: var(--danger); color: white; }
      .btn-secondary { background: #64748b; color: white; }
      .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
      .btn-sm { padding: 0.25rem 0.5rem; font-size: 0.75rem; }
      .form-group { margin-bottom: 1rem; }
      .form-group label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem; color: var(--text); }
      .form-control { width: 100%; padding: 0.55rem 0.75rem; font-size: 0.9rem; border: 1px solid var(--border); border-radius: 6px; outline: none; }
      .form-control:focus { border-color: var(--secondary); box-shadow: 0 0 0 3px rgba(2,132,199,0.15); }
      .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
      .alert { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.875rem; }
      .alert-success { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
      .alert-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
      .alert-warning { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }
      .student-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border); }
      .toolbar { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
      .toolbar-group { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
      @media (max-width: 768px) {
        .app-layout { flex-direction: column; }
        aside { width: 100%; border-right: none; border-bottom: 1px solid var(--border); }
        aside nav { flex-direction: row; overflow-x: auto; padding: 0.5rem; }
        aside nav a { padding: 0.5rem 0.75rem; white-space: nowrap; border-left: none; border-bottom: 3px solid transparent; }
        aside nav a.active { border-bottom-color: var(--secondary); }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-brand">
        ${schoolLogoSrc ? `<img src="${schoolLogoSrc}" alt="School Logo">` : ''}
        ${clubLogoSrc ? `<img src="${clubLogoSrc}" alt="Club Logo">` : ''}
        <div class="header-title">
          <h1>${sys.student_club_name || 'Club Attendance System'}</h1>
          <p>${sys.school_name || 'Central School'} • S.Y. ${sys.school_year || '2026-2027'}</p>
        </div>
      </div>
      <div class="user-badge">
        ${user ? `<span>👤 <strong>${user.name}</strong> (${user.role})</span><a href="/logout">Logout</a>` : '<a href="/login">Login</a>'}
      </div>
    </header>
    <div class="app-layout">
      ${user ? `<aside><nav>${navItems}</nav></aside>` : ''}
      <main>
        ${contentHtml}
      </main>
    </div>
  </body>
  </html>
  `;
}

// Global System API Status / Health Check Endpoint
app.get('/api/health', async (req, res) => {
  try {
    const test = await queryDB('SELECT COUNT(*) as count FROM settings');
    res.json({ status: 'Connected', driver: dbDriver, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'Connection Error', error: err.message });
  }
});

/* ==========================================================================
   PUBLIC AUTHENTICATION & REGISTRATION ROUTES
   ========================================================================== */

app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    if (req.session.user.role === 'ADMIN') return res.redirect('/admin/dashboard');
    if (req.session.user.role === 'SCANNER') return res.redirect('/scanner');
    if (req.session.user.role === 'STUDENT') return res.redirect('/member');
  }
  res.redirect('/login');
});

app.get('/login', async (req, res) => {
  const error = req.query.error ? decodeURIComponent(req.query.error) : '';
  const success = req.query.success ? decodeURIComponent(req.query.success) : '';

  const content = `
    <div style="max-width: 400px; margin: 3rem auto;" class="card">
      <div style="text-align: center; margin-bottom: 1.5rem;">
        <h2 style="color: var(--primary-dark);">System Login</h2>
        <p style="color: var(--text-muted); font-size: 0.85rem;">Enter your account credentials to continue</p>
      </div>
      ${error ? `<div class="alert alert-danger">${error}</div>` : ''}
      ${success ? `<div class="alert alert-success">${success}</div>` : ''}
      <form action="/login" method="POST">
        <div class="form-group">
          <label>Email Address</label>
          <input type="email" name="email" class="form-control" placeholder="user@school.edu" required autofocus>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" name="password" class="form-control" placeholder="••••••••" required>
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%; justify-content: center; padding: 0.75rem;">Sign In</button>
      </form>
      <div style="margin-top: 1.5rem; text-align: center; font-size: 0.85rem;">
        <a href="/register" style="color: var(--secondary); text-decoration: none; font-weight: 600;">Need to register as a student? Click here</a>
      </div>
    </div>
  `;
  res.send(await renderPage('Login', content, req));
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const users = await queryDB('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email.trim()]);
    if (users.length === 0) {
      return res.redirect('/login?error=Invalid%20email%20address%20or%20password');
    }
    const user = users[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.redirect('/login?error=Invalid%20email%20address%20or%20password');
    }

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, student_id: user.student_id };
    await logAudit(req, 'LOGIN', `User ${user.email} logged in successfully.`);

    if (user.role === 'ADMIN') return res.redirect('/admin/dashboard');
    if (user.role === 'SCANNER') return res.redirect('/scanner');
    if (user.role === 'STUDENT') return res.redirect('/member');
    res.redirect('/');
  } catch (err) {
    console.error('Login Error:', err);
    res.redirect('/login?error=Server%20error%20during%20login');
  }
});

app.get('/logout', async (req, res) => {
  if (req.session.user) {
    await logAudit(req, 'LOGOUT', `User ${req.session.user.email} logged out.`);
  }
  req.session.destroy(() => {
    res.redirect('/login?success=You%20have%20been%20logged%20out');
  });
});

app.get('/change-password', requireAuth, async (req, res) => {
  const content = `
    <div style="max-width: 480px; margin: 2rem auto;" class="card">
      <div class="card-title">🔐 Change Password</div>
      <form action="/change-password" method="POST">
        <div class="form-group">
          <label>Current Password</label>
          <input type="password" name="current_password" class="form-control" required>
        </div>
        <div class="form-group">
          <label>New Password (min 8 characters)</label>
          <input type="password" name="new_password" class="form-control" minlength="8" required>
        </div>
        <div class="form-group">
          <label>Confirm New Password</label>
          <input type="password" name="confirm_password" class="form-control" minlength="8" required>
        </div>
        <button type="submit" class="btn btn-primary">Update Password</button>
      </form>
    </div>
  `;
  res.send(await renderPage('Change Password', content, req));
});

app.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (new_password !== confirm_password) {
    return res.send(await renderPage('Change Password', `<div class="alert alert-danger">New passwords do not match.</div>`, req));
  }
  try {
    const users = await queryDB('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const user = users[0];
    const match = await bcrypt.compare(current_password, user.password);
    if (!match) {
      return res.send(await renderPage('Change Password', `<div class="alert alert-danger">Incorrect current password.</div>`, req));
    }
    const hashed = await bcrypt.hash(new_password, 10);
    await runDB('UPDATE users SET password = ? WHERE id = ?', [hashed, user.id]);
    await logAudit(req, 'PASSWORD_CHANGE', `User ${user.email} updated their password.`);
    res.send(await renderPage('Change Password', `<div class="alert alert-success">Password updated successfully!</div>`, req));
  } catch (err) {
    res.send(await renderPage('Change Password', `<div class="alert alert-danger">Error: ${err.message}</div>`, req));
  }
});

// Student Self Registration Link
app.get('/register', async (req, res) => {
  const settingsRows = await queryDB('SELECT * FROM settings LIMIT 1');
  const sys = settingsRows[0] || {};

  if (!sys.registration_open) {
    const closedHtml = `
      <div style="max-width: 500px; margin: 3rem auto; text-align: center;" class="card">
        <h2 style="color: var(--danger); margin-bottom: 0.5rem;">🔒 Registration Closed</h2>
        <p style="color: var(--text-muted); font-size: 0.95rem;">Student registration is currently disabled by the administrator or Club Adviser.</p>
        <p style="margin-top: 1rem; font-size: 0.85rem; color: var(--text-muted);">Please contact <strong>${sys.club_adviser || 'Club Adviser'}</strong> for assistance.</p>
        <div style="margin-top: 1.5rem;"><a href="/login" class="btn btn-primary">Back to Login</a></div>
      </div>
    `;
    return res.send(await renderPage('Registration Closed', closedHtml, req));
  }

  const positions = await queryDB('SELECT * FROM positions ORDER BY name ASC');
  const posOptions = positions.map(p => `<option value="${p.id}">${p.name}</option>`).join('');

  const content = `
    <div style="max-width: 650px; margin: 1.5rem auto;" class="card">
      <div style="text-align: center; margin-bottom: 1.5rem;">
        <h2 style="color: var(--primary-dark);">${sys.student_club_name}</h2>
        <p style="color: var(--text-muted); font-size: 0.9rem;">Official Student Club Registration Form (${sys.school_year})</p>
      </div>

      <form action="/register" method="POST" enctype="multipart/form-data" id="regForm">
        <div class="form-row">
          <div class="form-group">
            <label>First Name *</label>
            <input type="text" name="first_name" class="form-control" placeholder="Juan" required>
          </div>
          <div class="form-group">
            <label>Middle Name (Optional)</label>
            <input type="text" name="middle_name" class="form-control" placeholder="Dela">
          </div>
          <div class="form-group">
            <label>Last Name *</label>
            <input type="text" name="last_name" class="form-control" placeholder="Cruz" required>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Email Address *</label>
            <input type="email" name="email" class="form-control" placeholder="juan.cruz@example.com" required>
          </div>
          <div class="form-group">
            <label>Contact Number (Optional)</label>
            <input type="text" name="contact_number" class="form-control" placeholder="09123456789">
          </div>
        </div>

        <div class="form-group">
          <label>Club Position *</label>
          <select name="position_id" class="form-control" required>
            <option value="">-- Select Position --</option>
            ${posOptions}
          </select>
        </div>

        <div class="form-group">
          <label>Student Photo (JPG, PNG, WEBP max 5MB) *</label>
          <input type="file" name="student_photo" class="form-control" accept="image/jpeg,image/png,image/webp" required onchange="previewPhoto(event)">
          <div style="margin-top: 0.75rem; text-align: center;">
            <img id="photoPreview" style="max-width: 150px; max-height: 150px; border-radius: 8px; display: none; border: 2px solid var(--border); margin: 0 auto;">
          </div>
        </div>

        <button type="submit" class="btn btn-success" style="width: 100%; justify-content: center; padding: 0.75rem; font-size: 1rem; margin-top: 1rem;">
          Submit Registration Application
        </button>
      </form>
    </div>

    <script>
      function previewPhoto(event) {
        const input = event.target;
        const preview = document.getElementById('photoPreview');
        if (input.files && input.files[0]) {
          const reader = new FileReader();
          reader.onload = function(e) {
            preview.src = e.target.result;
            preview.style.display = 'block';
          }
          reader.readAsDataURL(input.files[0]);
        }
      }
    </script>
  `;
  res.send(await renderPage('Student Registration', content, req));
});

app.post('/register', upload.single('student_photo'), async (req, res) => {
  try {
    const { first_name, middle_name, last_name, email, contact_number, position_id } = req.body;

    if (!req.file) {
      return res.send(await renderPage('Registration Error', `<div class="alert alert-danger">Please upload a valid student photo.</div>`, req));
    }

    const emailCheck = await queryDB('SELECT id FROM students WHERE LOWER(email) = LOWER(?)', [email.trim()]);
    if (emailCheck.length > 0) {
      return res.send(await renderPage('Registration Error', `<div class="alert alert-danger">An account with email <strong>${email}</strong> already exists.</div>`, req));
    }

    const tempStudentNumber = 'PENDING-' + Date.now();
    const qrToken = 'QR-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
    const photoFilename = req.file.filename;

    await runDB(
      `INSERT INTO students (student_number, first_name, middle_name, last_name, email, contact_number, position_id, photo, qr_token, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [tempStudentNumber, first_name.trim(), (middle_name || '').trim(), last_name.trim(), email.trim().toLowerCase(), (contact_number || '').trim(), position_id, photoFilename, qrToken]
    );

    await logAudit(req, 'REGISTRATION_SUBMITTED', `New registration submitted by ${first_name} ${last_name} (${email}).`);

    const successContent = `
      <div style="max-width: 550px; margin: 3rem auto; text-align: center;" class="card">
        <div style="font-size: 3rem; color: var(--success); margin-bottom: 0.5rem;">✓</div>
        <h2 style="color: var(--primary-dark); margin-bottom: 0.5rem;">REGISTRATION SUBMITTED</h2>
        <div class="alert alert-success" style="text-align: left; margin: 1rem 0;">
          Your registration details have been received successfully and are currently <strong>Pending Approval</strong>.
        </div>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;">
          Your Club Adviser will review and approve your application. Once approved, your official Student Number, Digital ID, and QR Code will be activated.
        </p>
        <a href="/login" class="btn btn-primary">Return to System Login</a>
      </div>
    `;
    res.send(await renderPage('Registration Submitted', successContent, req));
  } catch (err) {
    console.error('Registration Post Error:', err);
    res.send(await renderPage('Registration Error', `<div class="alert alert-danger">Error processing registration: ${err.message}</div>`, req));
  }
});
/* ==========================================================================
   MOBILE QR SCANNER ENGINE & VOICE ANNOUNCEMENTS PORTAL
   ========================================================================== */

app.get('/scanner', requireRole('ADMIN', 'SCANNER'), async (req, res) => {
  const activeEvents = await queryDB("SELECT * FROM events WHERE status = 'ACTIVE' ORDER BY event_date ASC");
  const upcomingEvents = await queryDB("SELECT * FROM events WHERE status = 'UPCOMING' ORDER BY event_date ASC");

  const eventOptions = [
    ...activeEvents.map(e => `<option value="${e.id}" selected>🔴 [ACTIVE] ${e.name} (${e.event_date})</option>`),
    ...upcomingEvents.map(e => `<option value="${e.id}">⏳ [UPCOMING] ${e.name} (${e.event_date})</option>`)
  ].join('');

  const content = `
    <div style="max-width: 800px; margin: 0 auto;">
      <div class="card">
        <div class="card-title">📱 Mobile QR Attendance Scanner Portal</div>

        <div class="form-row" style="margin-bottom: 1rem;">
          <div class="form-group">
            <label>Select Event *</label>
            <select id="eventSelect" class="form-control">
              <option value="">-- Choose Active or Upcoming Event --</option>
              ${eventOptions}
            </select>
          </div>
          <div class="form-group">
            <label>Scan Mode *</label>
            <select id="scanMode" class="form-control">
              <option value="TIME_IN">📥 TIME IN</option>
              <option value="TIME_OUT">📤 TIME OUT</option>
            </select>
          </div>
        </div>

        <div style="background: #000; border-radius: 8px; overflow: hidden; position: relative; min-height: 280px; text-align: center;">
          <video id="scannerVideo" style="width: 100%; max-height: 380px; object-fit: cover;" autoplay playsinline></video>
          <div id="videoOverlay" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); border: 3px dashed #0284c7; width: 220px; height: 220px; border-radius: 12px; pointer-events: none;"></div>
        </div>

        <div class="toolbar" style="margin-top: 1rem;">
          <div class="toolbar-group">
            <button id="btnStartCam" class="btn btn-primary" onclick="startCamera()">📷 Start Camera</button>
            <button id="btnStopCam" class="btn btn-secondary" onclick="stopCamera()">🛑 Stop Camera</button>
            <select id="cameraSource" class="form-control" style="width: auto;" onchange="switchCamera()"></select>
          </div>
          <div class="toolbar-group">
            <label style="font-size: 0.85rem; font-weight: 600;"><input type="checkbox" id="enableVoice" checked> 🔊 Voice Name Speech</label>
          </div>
        </div>
      </div>

      <!-- Live Scan Result Card -->
      <div id="scanResultCard" class="card" style="display: none; transition: all 0.3s;">
        <div id="scanResultHeader" class="card-title"></div>
        <div style="display: flex; gap: 1.25rem; align-items: center; flex-wrap: wrap;">
          <img id="scanStudentPhoto" src="" style="width: 110px; height: 110px; border-radius: 8px; object-fit: cover; border: 2px solid var(--border);">
          <div style="flex: 1;">
            <h3 id="scanStudentName" style="font-size: 1.3rem; color: var(--primary-dark);"></h3>
            <p id="scanStudentNum" style="font-weight: 700; color: var(--secondary);"></p>
            <p id="scanStudentPos" style="color: var(--text-muted); font-size: 0.9rem;"></p>
            <p id="scanTime" style="font-size: 0.85rem; margin-top: 0.25rem;"></p>
          </div>
        </div>
      </div>

      <!-- Recent Scans Stream -->
      <div class="card">
        <div class="card-title">📋 Recent Live Scans Session</div>
        <div style="overflow-x: auto;">
          <table id="recentScansTable">
            <thead>
              <tr>
                <th>Time</th>
                <th>Student Number</th>
                <th>Name</th>
                <th>Position</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="recentScansBody">
              <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No scans recorded in this session yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- HTML5 QR Code Library Inclusion -->
    <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>

    <script>
      let html5QrCode = null;
      let isProcessingScan = false;
      let lastScannedToken = '';
      let lastScanTime = 0;

      // Audio Synthesizer Context
      function playAudioTone(type) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);

          if (type === 'SUCCESS') {
            osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
            osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.25);
          } else if (type === 'WARNING') {
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
          } else { // ERROR
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(150, ctx.currentTime);
            gain.gain.setValueAtTime(0.4, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.35);
          }
        } catch(e) { console.error(e); }
      }

      function speakText(text) {
        if (!document.getElementById('enableVoice').checked) return;
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel(); // Clear queue
          const msg = new SpeechSynthesisUtterance(text);
          msg.rate = 1.0;
          msg.pitch = 1.0;
          msg.lang = 'en-US';
          window.speechSynthesis.speak(msg);
        }
      }

      async function initCameraDevices() {
        try {
          const devices = await Html5Qrcode.getCameras();
          const select = document.getElementById('cameraSource');
          select.innerHTML = '';
          if (devices && devices.length > 0) {
            devices.forEach((dev, idx) => {
              select.innerHTML += \`<option value="\${dev.id}">\${dev.label || 'Camera ' + (idx+1)}</option>\`;
            });
          }
        } catch(err) { console.error('Camera enumeration error:', err); }
      }

      async function startCamera() {
        const eventId = document.getElementById('eventSelect').value;
        if (!eventId) {
          alert('Please select an active or upcoming event first!');
          return;
        }

        if (!html5QrCode) html5QrCode = new Html5Qrcode("scannerVideo");
        const camId = document.getElementById('cameraSource').value;
        const config = { fps: 10, qrbox: { width: 220, height: 220 } };

        try {
          await html5QrCode.start(
            camId ? { rawId: camId } : { facingMode: "environment" },
            config,
            onQrCodeScanned
          );
        } catch (err) {
          alert('Failed to start camera: ' + err);
        }
      }

      async function stopCamera() {
        if (html5QrCode && html5QrCode.isScanning) {
          await html5QrCode.stop();
        }
      }

      async function switchCamera() {
        if (html5QrCode && html5QrCode.isScanning) {
          await stopCamera();
          startCamera();
        }
      }

      async function onQrCodeScanned(decodedText) {
        const now = Date.now();
        if (decodedText === lastScannedToken && (now - lastScanTime) < 4000) return; // 4 second throttle for duplicate scans
        if (isProcessingScan) return;

        isProcessingScan = true;
        lastScannedToken = decodedText;
        lastScanTime = now;

        const eventId = document.getElementById('eventSelect').value;
        const scanMode = document.getElementById('scanMode').value;

        try {
          const res = await fetch('/api/scan-qr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_mode: scanMode })
          });
          const data = await res.json();

          const card = document.getElementById('scanResultCard');
          const header = document.getElementById('scanResultHeader');
          card.style.display = 'block';

          if (data.success) {
            playAudioTone('SUCCESS');
            speakText(data.student.first_name + ' ' + data.student.last_name + ', ' + (scanMode === 'TIME_IN' ? 'attendance recorded' : 'time out recorded'));

            header.innerHTML = \`<span style="color: var(--success)">✓ \${data.message}</span>\`;
            document.getElementById('scanStudentPhoto').src = '/uploads/photos/' + data.student.photo;
            document.getElementById('scanStudentName').innerText = data.student.first_name + ' ' + (data.student.middle_name ? data.student.middle_name + ' ' : '') + data.student.last_name;
            document.getElementById('scanStudentNum').innerText = 'Student No: ' + data.student.student_number;
            document.getElementById('scanStudentPos').innerText = 'Position: ' + data.student.position_name;
            document.getElementById('scanTime').innerText = 'Timestamp: ' + data.timestamp + ' (' + data.attendance_status + ')';

            addRecentScanRow(data.timestamp, data.student.student_number, data.student.first_name + ' ' + data.student.last_name, data.student.position_name, scanMode, data.attendance_status);
          } else if (data.duplicate) {
            playAudioTone('WARNING');
            speakText(data.student_name ? data.student_name + ', you are already recorded' : 'Already recorded');

            header.innerHTML = \`<span style="color: var(--warning)">⚠️ \${data.message}</span>\`;
            document.getElementById('scanStudentPhoto').src = data.student_photo ? '/uploads/photos/' + data.student_photo : '';
            document.getElementById('scanStudentName').innerText = data.student_name || 'Student';
            document.getElementById('scanStudentNum').innerText = 'Notice: Duplicate Scan Prevented';
            document.getElementById('scanStudentPos').innerText = '';
            document.getElementById('scanTime').innerText = '';
          } else {
            playAudioTone('ERROR');
            speakText('Invalid QR Code');

            header.innerHTML = \`<span style="color: var(--danger)">❌ INVALID QR CODE</span>\`;
            document.getElementById('scanStudentPhoto').src = '';
            document.getElementById('scanStudentName').innerText = 'Scan Rejected';
            document.getElementById('scanStudentNum').innerText = data.message;
            document.getElementById('scanStudentPos').innerText = '';
            document.getElementById('scanTime').innerText = '';
          }
        } catch(err) {
          console.error(err);
        } finally {
          setTimeout(() => { isProcessingScan = false; }, 1500);
        }
      }

      function addRecentScanRow(time, num, name, pos, type, status) {
        const body = document.getElementById('recentScansBody');
        if (body.children[0] && body.children[0].children.length === 1) body.innerHTML = '';
        const row = document.createElement('tr');
        row.innerHTML = \`
          <td>\${time}</td>
          <td><strong>\${num}</strong></td>
          <td>\${name}</td>
          <td>\${pos}</td>
          <td><span class="badge \${type === 'TIME_IN' ? 'badge-info' : 'badge-warning'}">\${type}</span></td>
          <td><span class="badge badge-success">\${status}</span></td>
        \`;
        body.insertBefore(row, body.firstChild);
      }

      window.addEventListener('DOMContentLoaded', initCameraDevices);
    </script>
  `;
  res.send(await renderPage('Scanner Portal', content, req, 'scanner'));
});

// Live QR Code Processing API Endpoint
app.post('/api/scan-qr', requireRole('ADMIN', 'SCANNER'), async (req, res) => {
  const { qr_token, event_id, scan_mode } = req.body;

  if (!event_id) return res.json({ success: false, message: 'No event selected' });

  try {
    // 1. Validate QR Token & Student
    const students = await queryDB(
      `SELECT s.*, p.name as position_name FROM students s
       LEFT JOIN positions p ON s.position_id = p.id
       WHERE s.qr_token = ? AND s.status = 'ACTIVE'`,
      [qr_token.trim()]
    );

    if (students.length === 0) {
      return res.json({ success: false, message: 'Student QR code is invalid, disabled, or pending approval.' });
    }

    const student = students[0];
    if (!student.qr_status) {
      return res.json({ success: false, message: 'This Student QR Code has been disabled by Admin.' });
    }

    // 2. Validate Event
    const events = await queryDB('SELECT * FROM events WHERE id = ?', [event_id]);
    if (events.length === 0) return res.json({ success: false, message: 'Target event not found.' });
    const event = events[0];

    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { hour12: true });
    const dateString = now.toISOString().split('T')[0];

    // 3. Duplicate & Scan Logic Execution
    const existingAtt = await queryDB('SELECT * FROM attendance WHERE event_id = ? AND student_id = ?', [event_id, student.id]);

    if (scan_mode === 'TIME_IN') {
      if (existingAtt.length > 0 && existingAtt[0].time_in) {
        return res.json({
          duplicate: true,
          message: 'ALREADY RECORDED: Student has already timed in for this event.',
          student_name: `${student.first_name} ${student.last_name}`,
          student_photo: student.photo
        });
      }

      // Calculate Late / Present Status
      let status = 'PRESENT';
      if (event.start_time) {
        const [eventHour, eventMin] = event.start_time.split(':').map(Number);
        const eventStart = new Date();
        eventStart.setHours(eventHour, eventMin, 0, 0);
        const lateThresholdMs = (event.late_threshold_minutes || 15) * 60 * 1000;

        if (now.getTime() > (eventStart.getTime() + lateThresholdMs)) {
          status = 'LATE';
        }
      }

      if (existingAtt.length > 0) {
        await runDB(
          `UPDATE attendance SET time_in = ?, status = ?, scan_by = ? WHERE id = ?`,
          [timeString, status, req.session.user.id, existingAtt[0].id]
        );
      } else {
        await runDB(
          `INSERT INTO attendance (event_id, student_id, time_in, status, scan_by) VALUES (?, ?, ?, ?, ?)`,
          [event_id, student.id, timeString, status, req.session.user.id]
        );
      }

      await logAudit(req, 'SCAN_TIME_IN', `Time In recorded for ${student.student_number} (${status})`);

      return res.json({
        success: true,
        message: 'ATTENDANCE RECORDED',
        student,
        attendance_status: status,
        timestamp: timeString
      });
    } else { // TIME_OUT Mode
      if (existingAtt.length === 0 || !existingAtt[0].time_in) {
        return res.json({
          success: false,
          message: 'Cannot Time Out: Student has no Time In record for this event.'
        });
      }
      if (existingAtt[0].time_out) {
        return res.json({
          duplicate: true,
          message: 'ALREADY RECORDED: Student has already timed out for this event.',
          student_name: `${student.first_name} ${student.last_name}`,
          student_photo: student.photo
        });
      }

      await runDB('UPDATE attendance SET time_out = ? WHERE id = ?', [timeString, existingAtt[0].id]);
      await logAudit(req, 'SCAN_TIME_OUT', `Time Out recorded for ${student.student_number}`);

      return res.json({
        success: true,
        message: 'TIME OUT RECORDED',
        student,
        attendance_status: existingAtt[0].status,
        timestamp: timeString
      });
    }
  } catch (err) {
    console.error('Scan Error:', err);
    res.status(500).json({ success: false, message: 'Server database error during scan.' });
  }
});

/* ==========================================================================
   STUDENT PORTAL & DIGITAL ID VIEW
   ========================================================================== */

app.get('/member', requireRole('STUDENT'), async (req, res) => {
  const students = await queryDB(
    `SELECT s.*, p.name as position_name FROM students s
     LEFT JOIN positions p ON s.position_id = p.id
     WHERE s.id = ?`,
    [req.session.user.student_id]
  );

  if (students.length === 0) {
    return res.send(await renderPage('Student Portal', `<div class="alert alert-danger">Student profile not found. Please contact Administrator.</div>`, req));
  }

  const student = students[0];
  const settingsRows = await queryDB('SELECT * FROM settings LIMIT 1');
  const sys = settingsRows[0] || {};

  // Generate Large Dynamic QR Code Data URL
  const qrDataUrl = await QRCode.toDataURL(student.qr_token, { width: 300, margin: 1, errorCorrectionLevel: 'H' });

  // Student Attendance Records
  const attendanceHistory = await queryDB(
    `SELECT a.*, e.name as event_name, e.event_date FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE a.student_id = ?
     ORDER BY e.event_date DESC`,
    [student.id]
  );

  const attRows = attendanceHistory.map(a => `
    <tr>
      <td>${a.event_date}</td>
      <td><strong>${a.event_name}</strong></td>
      <td>${a.time_in || '--'}</td>
      <td>${a.time_out || '--'}</td>
      <td>
        <span class="badge ${a.status === 'PRESENT' ? 'badge-success' : a.status === 'LATE' ? 'badge-warning' : a.status === 'EXCUSED' ? 'badge-info' : 'badge-danger'}">
          ${a.status}
        </span>
      </td>
    </tr>
  `).join('');

  // Position History
  const posHistory = await queryDB('SELECT * FROM position_history WHERE student_id = ? ORDER BY assigned_at DESC', [student.id]);
  const historyList = posHistory.map(h => `<li><strong>${h.school_year}</strong>: ${h.position_name}</li>`).join('');

  const content = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem;">

      <!-- Digital Student Club ID Card -->
      <div class="card" style="background: linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%); border: 2px solid var(--primary);">
        <div style="text-align: center; border-bottom: 2px solid var(--primary); padding-bottom: 0.75rem; margin-bottom: 1rem;">
          <h3 style="font-size: 1.1rem; color: var(--primary-dark); font-weight: 800; uppercase;">${sys.school_name}</h3>
          <p style="font-size: 0.85rem; color: var(--secondary); font-weight: 700;">${sys.student_club_name}</p>
          <span class="badge badge-info" style="margin-top: 0.25rem;">OFFICIAL STUDENT MEMBER ID</span>
        </div>

        <div style="text-align: center; margin-bottom: 1rem;">
          <img src="/uploads/photos/${student.photo}" style="width: 130px; height: 130px; border-radius: 8px; object-fit: cover; border: 3px solid var(--primary);">
          <h2 style="font-size: 1.35rem; color: var(--primary-dark); margin-top: 0.5rem;">${student.first_name} ${student.middle_name ? student.middle_name + ' ' : ''}${student.last_name}</h2>
          <p style="font-weight: 800; color: var(--secondary); font-size: 1.05rem;">${student.student_number}</p>
          <p style="font-size: 0.95rem; font-weight: 700; color: var(--text);">${student.position_name}</p>
          <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem;">S.Y. ${sys.school_year}</p>
        </div>

        <!-- Large QR Code Area -->
        <div style="text-align: center; background: white; padding: 1rem; border-radius: 8px; border: 1px solid var(--border);">
          <img src="${qrDataUrl}" style="width: 180px; height: 180px; display: block; margin: 0 auto;" alt="Student QR Code">
          <p style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.5rem; font-weight: 600;">PRESENT THIS LARGE QR CODE AT THE ATTENDANCE SCANNER</p>
        </div>
      </div>

      <!-- Profile Details & History -->
      <div>
        <div class="card">
          <div class="card-title">👤 Member Profile Information</div>
          <table style="font-size: 0.9rem;">
            <tr><th>Email Address</th><td>${student.email}</td></tr>
            <tr><th>Contact Number</th><td>${student.contact_number || 'N/A'}</td></tr>
            <tr><th>Membership Status</th><td><span class="badge badge-success">${student.status}</span></td></tr>
            <tr><th>Date Joined</th><td>${student.membership_date}</td></tr>
          </table>

          ${posHistory.length > 0 ? `
            <div style="margin-top: 1.25rem;">
              <h4 style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem;">🎖️ Position History</h4>
              <ul style="padding-left: 1.25rem; font-size: 0.85rem; color: var(--text);">${historyList}</ul>
            </div>
          ` : ''}
        </div>

        <div class="card">
          <div class="card-title">📅 My Attendance & Event History</div>
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event Name</th>
                  <th>Time In</th>
                  <th>Time Out</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${attRows.length > 0 ? attRows : '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No attendance records found yet.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  `;
  res.send(await renderPage('Student Portal', content, req, 'member'));
});

/* ==========================================================================
   ADMINISTRATOR DASHBOARD & SYSTEM CORE
   ========================================================================== */

app.get('/admin/dashboard', requireRole('ADMIN'), async (req, res) => {
  // Real Database Query Statistics (No Mock Data)
  const totalStudents = (await queryDB("SELECT COUNT(*) as c FROM students WHERE status != 'PENDING'"))[0].c;
  const activeStudents = (await queryDB("SELECT COUNT(*) as c FROM students WHERE status = 'ACTIVE'"))[0].c;
  const inactiveStudents = (await queryDB("SELECT COUNT(*) as c FROM students WHERE status IN ('INACTIVE', 'SUSPENDED', 'ALUMNI')"))[0].c;
  const pendingRegs = (await queryDB("SELECT COUNT(*) as c FROM students WHERE status = 'PENDING'"))[0].c;

  const todayStr = new Date().toISOString().split('T')[0];

  // Today's Real Attendance Counts across events today
  const attToday = await queryDB(
    `SELECT a.status, COUNT(a.id) as count FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE e.event_date = ?
     GROUP BY a.status`,
    [todayStr]
  );

  let presentToday = 0, lateToday = 0, absentToday = 0, excusedToday = 0;
  attToday.forEach(r => {
    if (r.status === 'PRESENT') presentToday = parseInt(r.count, 10);
    if (r.status === 'LATE') lateToday = parseInt(r.count, 10);
    if (r.status === 'ABSENT') absentToday = parseInt(r.count, 10);
    if (r.status === 'EXCUSED') excusedToday = parseInt(r.count, 10);
  });

  const totalAttendeesToday = presentToday + lateToday + absentToday + excusedToday;
  const attendanceRate = totalAttendeesToday > 0 ? Math.round(((presentToday + lateToday) / totalAttendeesToday) * 100) : 0;

  const activeEventsCount = (await queryDB("SELECT COUNT(*) as c FROM events WHERE status = 'ACTIVE'"))[0].c;
  const upcomingEventsCount = (await queryDB("SELECT COUNT(*) as c FROM events WHERE status = 'UPCOMING'"))[0].c;

  // Recent Live Scans
  const recentScans = await queryDB(
    `SELECT a.*, s.first_name, s.last_name, s.student_number, p.name as position_name, e.name as event_name
     FROM attendance a
     JOIN students s ON a.student_id = s.id
     LEFT JOIN positions p ON s.position_id = p.id
     JOIN events e ON a.event_id = e.id
     ORDER BY a.id DESC LIMIT 8`
  );

  const scanRows = recentScans.map(s => `
    <tr>
      <td>${s.time_in || s.time_out || '--'}</td>
      <td><strong>${s.student_number}</strong></td>
      <td>${s.first_name} ${s.last_name}</td>
      <td>${s.position_name}</td>
      <td>${s.event_name}</td>
      <td><span class="badge ${s.status === 'PRESENT' ? 'badge-success' : s.status === 'LATE' ? 'badge-warning' : 'badge-danger'}">${s.status}</span></td>
    </tr>
  `).join('');

  const content = `
    <div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem;">
        <h2 style="color: var(--primary-dark);">Administrator Dashboard</h2>
        <span class="badge badge-success" style="font-size: 0.85rem; padding: 0.4rem 0.8rem;">● Database Connected</span>
      </div>

      <!-- Real Database Statistics Grid -->
      <div class="grid-stats">
        <div class="stat-card">
          <div class="stat-lbl">Total Students</div>
          <div class="stat-val">${totalStudents}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-lbl">Active Members</div>
          <div class="stat-val">${activeStudents}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-lbl">Pending Applications</div>
          <div class="stat-val">${pendingRegs}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Present Today</div>
          <div class="stat-val" style="color: var(--success);">${presentToday}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-lbl">Late Today</div>
          <div class="stat-val" style="color: var(--warning);">${lateToday}</div>
        </div>
        <div class="stat-card danger">
          <div class="stat-lbl">Absent Today</div>
          <div class="stat-val" style="color: var(--danger);">${absentToday}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Attendance Rate</div>
          <div class="stat-val" style="color: var(--secondary);">${attendanceRate}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Active Events</div>
          <div class="stat-val">${activeEventsCount}</div>
        </div>
      </div>

      <!-- Recent Attendance Activity Table -->
      <div class="card">
        <div class="card-title">
          <span>⏱️ Live Recent Attendance Activity</span>
          <a href="/scanner" class="btn btn-primary btn-sm" target="_blank">Launch QR Scanner</a>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Student Number</th>
                <th>Student Name</th>
                <th>Position</th>
                <th>Event</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${scanRows.length > 0 ? scanRows : '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No attendance scans recorded today yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  res.send(await renderPage('Dashboard', content, req, 'dashboard'));
});
/* ==========================================================================
   STUDENT MANAGEMENT & REGISTRATION APPROVAL
   ========================================================================== */

app.get('/admin/students', requireRole('ADMIN'), async (req, res) => {
  const search = req.query.search ? req.query.search.trim() : '';
  const posFilter = req.query.position || '';
  const statusFilter = req.query.status || 'ACTIVE';

  let sql = `
    SELECT s.*, p.name as position_name FROM students s
    LEFT JOIN positions p ON s.position_id = p.id
    WHERE s.status != 'PENDING'
  `;
  const params = [];

  if (statusFilter) {
    sql += ` AND s.status = ?`;
    params.push(statusFilter);
  }
  if (posFilter) {
    sql += ` AND s.position_id = ?`;
    params.push(posFilter);
  }
  if (search) {
    sql += ` AND (s.student_number LIKE ? OR LOWER(s.first_name) LIKE ? OR LOWER(s.last_name) LIKE ? OR LOWER(s.email) LIKE ?)`;
    const term = `%${search.toLowerCase()}%`;
    params.push(term, term, term, term);
  }

  sql += ` ORDER BY s.student_number ASC`;
  const students = await queryDB(sql, params);

  const positions = await queryDB('SELECT * FROM positions ORDER BY name ASC');
  const posOptions = positions.map(p => `<option value="${p.id}" ${posFilter == p.id ? 'selected' : ''}>${p.name}</option>`).join('');

  const rows = students.map(s => `
    <tr>
      <td><img src="/uploads/photos/${s.photo}" class="student-avatar"></td>
      <td><strong>${s.student_number}</strong></td>
      <td>${s.first_name} ${s.middle_name ? s.middle_name + ' ' : ''}${s.last_name}</td>
      <td>${s.position_name || 'N/A'}</td>
      <td>${s.email}</td>
      <td><span class="badge ${s.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}">${s.status}</span></td>
      <td>
        <a href="/admin/students/edit/${s.id}" class="btn btn-outline btn-sm">✏️ Edit</a>
        <a href="/admin/students/qr/${s.id}" class="btn btn-primary btn-sm">🔍 QR Code</a>
      </td>
    </tr>
  `).join('');

  const content = `
    <div class="card">
      <div class="card-title">
        <span>🎓 Student Directory</span>
        <a href="/register" class="btn btn-success btn-sm" target="_blank">➕ Add / Register Student</a>
      </div>

      <form method="GET" action="/admin/students" class="toolbar">
        <div class="toolbar-group">
          <input type="text" name="search" class="form-control" placeholder="Search name, number, email..." value="${search}" style="width: 220px;">
          <select name="position" class="form-control" style="width: 160px;">
            <option value="">All Positions</option>
            ${posOptions}
          </select>
          <select name="status" class="form-control" style="width: 140px;">
            <option value="ACTIVE" ${statusFilter === 'ACTIVE' ? 'selected' : ''}>Active</option>
            <option value="INACTIVE" ${statusFilter === 'INACTIVE' ? 'selected' : ''}>Inactive</option>
            <option value="SUSPENDED" ${statusFilter === 'SUSPENDED' ? 'selected' : ''}>Suspended</option>
            <option value="ALUMNI" ${statusFilter === 'ALUMNI' ? 'selected' : ''}>Alumni</option>
          </select>
          <button type="submit" class="btn btn-primary">Filter</button>
        </div>
      </form>

      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Photo</th>
              <th>Student Number</th>
              <th>Full Name</th>
              <th>Position</th>
              <th>Email</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length > 0 ? rows : '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No students found matching filter criteria.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage('Students', content, req, 'students'));
});

// Pending Registration Approvals Page
app.get('/admin/registrations', requireRole('ADMIN'), async (req, res) => {
  const pending = await queryDB(
    `SELECT s.*, p.name as position_name FROM students s
     LEFT JOIN positions p ON s.position_id = p.id
     WHERE s.status = 'PENDING'
     ORDER BY s.id DESC`
  );

  const rows = pending.map(s => `
    <tr>
      <td><img src="/uploads/photos/${s.photo}" class="student-avatar"></td>
      <td><strong>${s.first_name} ${s.middle_name ? s.middle_name + ' ' : ''}${s.last_name}</strong></td>
      <td>${s.email}</td>
      <td>${s.position_name}</td>
      <td>${s.contact_number || 'N/A'}</td>
      <td>
        <a href="/admin/registrations/approve/${s.id}" class="btn btn-success btn-sm" onclick="return confirm('Approve this student application?')">✓ Approve</a>
        <a href="/admin/registrations/reject/${s.id}" class="btn btn-danger btn-sm" onclick="return confirm('Reject and delete this registration?')">✕ Reject</a>
      </td>
    </tr>
  `).join('');

  const content = `
    <div class="card">
      <div class="card-title">📝 Pending Student Registrations (${pending.length})</div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Photo</th>
              <th>Applicant Name</th>
              <th>Email</th>
              <th>Desired Position</th>
              <th>Contact</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length > 0 ? rows : '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No pending registration applications to review.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage('Pending Registrations', content, req, 'registrations'));
});

app.get('/admin/registrations/approve/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const studentId = req.params.id;
    const students = await queryDB('SELECT * FROM students WHERE id = ? AND status = \'PENDING\'', [studentId]);
    if (students.length === 0) return res.redirect('/admin/registrations');

    const student = students[0];
    const officialStudentNumber = await generateStudentNumber();

    // Generate Student Portal User Credentials
    const defaultPassword = 'student123';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    await runDB(
      `UPDATE students SET student_number = ?, status = 'ACTIVE' WHERE id = ?`,
      [officialStudentNumber, studentId]
    );

    // Create User Login Account
    const userInsert = await runDB(
      `INSERT INTO users (name, email, password, role, student_id) VALUES (?, ?, ?, 'STUDENT', ?)`,
      [`${student.first_name} ${student.last_name}`, student.email, hashedPassword, studentId]
    );

    // Track Position History
    const settings = (await queryDB('SELECT school_year FROM settings LIMIT 1'))[0] || {};
    const pos = (await queryDB('SELECT name FROM positions WHERE id = ?', [student.position_id]))[0] || {};
    await runDB(
      'INSERT INTO position_history (student_id, position_name, school_year) VALUES (?, ?, ?)',
      [studentId, pos.name || 'Member', settings.school_year || '2026-2027']
    );

    await logAudit(req, 'STUDENT_APPROVED', `Approved registration for ${student.email}. Generated Student Number: ${officialStudentNumber}`);

    res.redirect('/admin/registrations');
  } catch (err) {
    console.error('Approval error:', err);
    res.redirect('/admin/registrations');
  }
});

app.get('/admin/registrations/reject/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const studentId = req.params.id;
    await runDB("DELETE FROM students WHERE id = ? AND status = 'PENDING'", [studentId]);
    await logAudit(req, 'STUDENT_REJECTED', `Rejected pending registration ID: ${studentId}`);
    res.redirect('/admin/registrations');
  } catch (err) {
    res.redirect('/admin/registrations');
  }
});

// View Student QR & Enable/Disable
app.get('/admin/students/qr/:id', requireRole('ADMIN'), async (req, res) => {
  const students = await queryDB(
    `SELECT s.*, p.name as position_name FROM students s
     LEFT JOIN positions p ON s.position_id = p.id
     WHERE s.id = ?`,
    [req.params.id]
  );
  if (students.length === 0) return res.redirect('/admin/students');
  const student = students[0];

  const qrDataUrl = await QRCode.toDataURL(student.qr_token, { width: 320, margin: 1, errorCorrectionLevel: 'H' });

  const content = `
    <div style="max-width: 500px; margin: 0 auto;" class="card">
      <div class="card-title">🔍 Student QR Code Management</div>
      <div style="text-align: center;">
        <img src="/uploads/photos/${student.photo}" style="width: 100px; height: 100px; border-radius: 50%; object-fit: cover;" class="student-avatar">
        <h3 style="margin-top: 0.5rem; color: var(--primary-dark);">${student.first_name} ${student.last_name}</h3>
        <p style="font-weight: 700; color: var(--secondary);">${student.student_number}</p>
        <p style="color: var(--text-muted);">${student.position_name}</p>

        <div style="background: white; padding: 1.25rem; border-radius: 8px; border: 1px solid var(--border); margin: 1.25rem 0;">
          <img src="${qrDataUrl}" style="width: 220px; height: 220px;">
          <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.5rem;">Token: <code>${student.qr_token}</code></p>
        </div>

        <div style="display: flex; gap: 0.5rem; justify-content: center;">
          <a href="/admin/students/regenerate-qr/${student.id}" class="btn btn-warning" onclick="return confirm('Regenerate QR? The old QR code will become permanently invalid.')">🔄 Regenerate QR</a>
          ${student.qr_status ?
            `<a href="/admin/students/toggle-qr/${student.id}/0" class="btn btn-danger">🚫 Disable QR</a>` :
            `<a href="/admin/students/toggle-qr/${student.id}/1" class="btn btn-success">✅ Enable QR</a>`
          }
        </div>
      </div>
    </div>
  `;
  res.send(await renderPage('Student QR Code', content, req, 'students'));
});

app.get('/admin/students/regenerate-qr/:id', requireRole('ADMIN'), async (req, res) => {
  const newQrToken = 'QR-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
  await runDB('UPDATE students SET qr_token = ? WHERE id = ?', [newQrToken, req.params.id]);
  await logAudit(req, 'QR_REGENERATED', `Regenerated QR Token for student ID: ${req.params.id}`);
  res.redirect(`/admin/students/qr/${req.params.id}`);
});

app.get('/admin/students/toggle-qr/:id/:status', requireRole('ADMIN'), async (req, res) => {
  await runDB('UPDATE students SET qr_status = ? WHERE id = ?', [parseInt(req.params.status, 10), req.params.id]);
  await logAudit(req, 'QR_TOGGLED', `Updated QR Status to ${req.params.status} for student ID: ${req.params.id}`);
  res.redirect(`/admin/students/qr/${req.params.id}`);
});

/* ==========================================================================
   POSITION MANAGEMENT MODULE
   ========================================================================== */

app.get('/admin/positions', requireRole('ADMIN'), async (req, res) => {
  const positions = await queryDB('SELECT * FROM positions ORDER BY name ASC');

  const rows = positions.map(p => `
    <tr>
      <td><strong>${p.name}</strong></td>
      <td>${p.description || '--'}</td>
      <td>
        <a href="/admin/positions/delete/${p.id}" class="btn btn-danger btn-sm" onclick="return confirm('Delete this position?')">Delete</a>
      </td>
    </tr>
  `).join('');

  const content = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem;">
      <div class="card">
        <div class="card-title">➕ Add Custom Position</div>
        <form action="/admin/positions" method="POST">
          <div class="form-group">
            <label>Position Name *</label>
            <input type="text" name="name" class="form-control" placeholder="e.g., Event Coordinator" required>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea name="description" class="form-control" rows="3"></textarea>
          </div>
          <button type="submit" class="btn btn-primary">Save Position</button>
        </form>
      </div>

      <div class="card">
        <div class="card-title">🎖️ Active Positions Directory</div>
        <table>
          <thead>
            <tr><th>Position Name</th><th>Description</th><th>Action</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage('Positions', content, req, 'positions'));
});

app.post('/admin/positions', requireRole('ADMIN'), async (req, res) => {
  try {
    const { name, description } = req.body;
    await runDB('INSERT INTO positions (name, description) VALUES (?, ?)', [name.trim(), (description || '').trim()]);
    await logAudit(req, 'POSITION_CREATED', `Created position: ${name}`);
    res.redirect('/admin/positions');
  } catch (err) {
    res.redirect('/admin/positions');
  }
});

app.get('/admin/positions/delete/:id', requireRole('ADMIN'), async (req, res) => {
  await runDB('DELETE FROM positions WHERE id = ?', [req.params.id]);
  await logAudit(req, 'POSITION_DELETED', `Deleted position ID: ${req.params.id}`);
  res.redirect('/admin/positions');
});

/* ==========================================================================
   EVENT MANAGEMENT MODULE
   ========================================================================== */

app.get('/admin/events', requireRole('ADMIN'), async (req, res) => {
  const events = await queryDB('SELECT * FROM events ORDER BY event_date DESC, start_time ASC');

  const rows = events.map(e => `
    <tr>
      <td><strong>${e.name}</strong></td>
      <td>${e.event_type}</td>
      <td>${e.event_date} (${e.start_time} - ${e.end_time})</td>
      <td>${e.location || 'N/A'}</td>
      <td>
        <span class="badge ${e.status === 'ACTIVE' ? 'badge-success' : e.status === 'UPCOMING' ? 'badge-info' : 'badge-danger'}">
          ${e.status}
        </span>
      </td>
      <td>
        <a href="/admin/events/status/${e.id}/ACTIVE" class="btn btn-success btn-sm">Set Active</a>
        <a href="/admin/events/status/${e.id}/COMPLETED" class="btn btn-secondary btn-sm" onclick="return confirm('Complete event and auto-mark absent students?')">Complete</a>
      </td>
    </tr>
  `).join('');

  const content = `
    <div class="card">
      <div class="card-title">
        <span>📅 Event Management</span>
        <a href="/admin/events/create" class="btn btn-primary btn-sm">➕ Create New Event</a>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Event Name</th>
              <th>Type</th>
              <th>Date & Time</th>
              <th>Location</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length > 0 ? rows : '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No events scheduled yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage('Events', content, req, 'events'));
});

app.get('/admin/events/create', requireRole('ADMIN'), async (req, res) => {
  const content = `
    <div style="max-width: 650px; margin: 0 auto;" class="card">
      <div class="card-title">📅 Create New Club Event</div>
      <form action="/admin/events/create" method="POST">
        <div class="form-group">
          <label>Event Name *</label>
          <input type="text" name="name" class="form-control" placeholder="e.g., General Assembly 2026" required>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Event Type</label>
            <input type="text" name="event_type" class="form-control" value="General Club Attendance" required>
          </div>
          <div class="form-group">
            <label>Event Date *</label>
            <input type="date" name="event_date" class="form-control" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Start Time *</label>
            <input type="time" name="start_time" class="form-control" required>
          </div>
          <div class="form-group">
            <label>End Time *</label>
            <input type="time" name="end_time" class="form-control" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Late Threshold (Minutes)</label>
            <input type="number" name="late_threshold_minutes" class="form-control" value="15" required>
          </div>
          <div class="form-group">
            <label>Location</label>
            <input type="text" name="location" class="form-control" placeholder="School Auditorium">
          </div>
        </div>
        <button type="submit" class="btn btn-success" style="width: 100%; justify-content: center;">Save & Publish Event</button>
      </form>
    </div>
  `;
  res.send(await renderPage('Create Event', content, req, 'events'));
});

app.post('/admin/events/create', requireRole('ADMIN'), async (req, res) => {
  const { name, event_type, event_date, start_time, end_time, late_threshold_minutes, location } = req.body;
  await runDB(
    `INSERT INTO events (name, event_type, event_date, start_time, end_time, late_threshold_minutes, location, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UPCOMING')`,
    [name, event_type, event_date, start_time, end_time, late_threshold_minutes, location]
  );
  await logAudit(req, 'EVENT_CREATED', `Created event: ${name} on ${event_date}`);
  res.redirect('/admin/events');
});

// Complete Event & Run Automatic Absent Detection
app.get('/admin/events/status/:id/:status', requireRole('ADMIN'), async (req, res) => {
  const { id, status } = req.params;
  await runDB('UPDATE events SET status = ? WHERE id = ?', [status, id]);

  if (status === 'COMPLETED') {
    // Auto-Mark Absent Students who are ACTIVE and have no attendance or excused record
    const activeStudents = await queryDB("SELECT id FROM students WHERE status = 'ACTIVE'");
    for (const st of activeStudents) {
      const att = await queryDB('SELECT id FROM attendance WHERE event_id = ? AND student_id = ?', [id, st.id]);
      if (att.length === 0) {
        await runDB("INSERT INTO attendance (event_id, student_id, status) VALUES (?, ?, 'ABSENT')", [id, st.id]);
      }
    }
    await logAudit(req, 'EVENT_COMPLETED', `Completed event ID: ${id} and auto-marked missing students as ABSENT.`);
  }

  res.redirect('/admin/events');
});

/* ==========================================================================
   A4 BOND PAPER STUDENT ID PRINTING MODULE (8 IDs PER PAGE)
   ========================================================================== */

app.get('/admin/id-cards', requireRole('ADMIN'), async (req, res) => {
  const students = await queryDB(
    `SELECT s.*, p.name as position_name FROM students s
     LEFT JOIN positions p ON s.position_id = p.id
     WHERE s.status = 'ACTIVE'
     ORDER BY s.student_number ASC`
  );

  const settingsRows = await queryDB('SELECT * FROM settings LIMIT 1');
  const sys = settingsRows[0] || {};

  // Build ID Cards with Large QR Codes
  const cardItems = [];
  for (const s of students) {
    const qrDataUrl = await QRCode.toDataURL(s.qr_token, { width: 250, margin: 1, errorCorrectionLevel: 'H' });
    cardItems.push({ ...s, qrDataUrl });
  }

  const cardHtml = cardItems.map(s => `
    <div class="id-card">
      <div class="id-card-header">
        ${sys.school_logo ? `<img src="/uploads/logos/${sys.school_logo}" class="id-logo">` : ''}
        <div class="id-header-text">
          <div class="id-school-name">${sys.school_name}</div>
          <div class="id-club-name">${sys.student_club_name}</div>
        </div>
        ${sys.club_logo ? `<img src="/uploads/logos/${sys.club_logo}" class="id-logo">` : ''}
      </div>

      <div class="id-card-body">
        <img src="/uploads/photos/${s.photo}" class="id-photo">
        <div class="id-info">
          <div class="id-name">${s.first_name} ${s.last_name}</div>
          <div class="id-num">${s.student_number}</div>
          <div class="id-pos">${s.position_name}</div>
          <div class="id-sy">S.Y. ${sys.school_year}</div>
        </div>
      </div>

      <div class="id-qr-container">
        <img src="${s.qrDataUrl}" class="id-large-qr">
      </div>
    </div>
  `).join('');

  const printLayout = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Print Student ID Cards - 8 Per A4</title>
      <style>
        @page { size: A4 portrait; margin: 8mm; }
        body { font-family: Arial, sans-serif; background: #f1f5f9; margin: 0; padding: 10px; }
        .no-print { margin-bottom: 15px; background: white; padding: 12px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; }
        
        .a4-grid {
          display: grid;
          grid-template-columns: repeat(2, 85.6mm);
          grid-auto-rows: 53.98mm;
          gap: 6mm;
          justify-content: center;
        }

        .id-card {
          width: 85.6mm;
          height: 53.98mm;
          border: 1.5px solid #1e3a8a;
          border-radius: 6px;
          background: #ffffff;
          box-sizing: border-box;
          padding: 2.5mm;
          position: relative;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          page-break-inside: avoid;
        }

        .id-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid #1e3a8a;
          padding-bottom: 1mm;
        }

        .id-logo { width: 7mm; height: 7mm; object-fit: contain; }
        .id-header-text { text-align: center; flex: 1; }
        .id-school-name { font-size: 6.5pt; font-weight: bold; color: #1e3a8a; text-transform: uppercase; }
        .id-club-name { font-size: 5.5pt; font-weight: bold; color: #0284c7; }

        .id-card-body {
          display: flex;
          align-items: center;
          gap: 2.5mm;
          margin-top: 1mm;
        }

        .id-photo { width: 17mm; height: 17mm; object-fit: cover; border-radius: 3px; border: 1px solid #1e3a8a; }
        .id-info { flex: 1; }
        .id-name { font-size: 8.5pt; font-weight: bold; color: #0f172a; line-height: 1.1; }
        .id-num { font-size: 7.5pt; font-weight: bold; color: #0284c7; margin-top: 0.5mm; }
        .id-pos { font-size: 7pt; font-weight: bold; color: #334155; }
        .id-sy { font-size: 5.5pt; color: #64748b; }

        .id-qr-container {
          position: absolute;
          bottom: 2mm;
          right: 2.5mm;
          text-align: center;
        }

        .id-large-qr {
          width: 20mm;
          height: 20mm;
          display: block;
        }

        @media print {
          .no-print { display: none; }
          body { background: white; padding: 0; }
        }
      </style>
    </head>
    <body>
      <div class="no-print">
        <div><strong>📄 A4 Student ID Printing Studio</strong> (8 Cards Per Page)</div>
        <button onclick="window.print()" style="padding: 8px 16px; background: #0284c7; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">🖨️ Print Student IDs Now</button>
      </div>

      <div class="a4-grid">
        ${cardHtml}
      </div>
    </body>
    </html>
  `;
  res.send(printLayout);
});

/* ==========================================================================
   REPORTS & ANALYTICS MODULE
   ========================================================================== */

app.get('/admin/reports', requireRole('ADMIN'), async (req, res) => {
  const events = await queryDB('SELECT * FROM events ORDER BY event_date DESC');
  const selectedEventId = req.query.event_id || (events[0] ? events[0].id : null);

  let attRecords = [];
  let eventDetail = null;

  if (selectedEventId) {
    eventDetail = (await queryDB('SELECT * FROM events WHERE id = ?', [selectedEventId]))[0];
    attRecords = await queryDB(
      `SELECT a.*, s.student_number, s.first_name, s.last_name, p.name as position_name FROM attendance a
       JOIN students s ON a.student_id = s.id
       LEFT JOIN positions p ON s.position_id = p.id
       WHERE a.event_id = ?
       ORDER BY s.student_number ASC`,
      [selectedEventId]
    );
  }

  const eventOpts = events.map(e => `<option value="${e.id}" ${e.id == selectedEventId ? 'selected' : ''}>${e.name} (${e.event_date})</option>`).join('');

  const rows = attRecords.map(a => `
    <tr>
      <td><strong>${a.student_number}</strong></td>
      <td>${a.first_name} ${a.last_name}</td>
      <td>${a.position_name}</td>
      <td>${a.time_in || '--'}</td>
      <td>${a.time_out || '--'}</td>
      <td><span class="badge ${a.status === 'PRESENT' ? 'badge-success' : a.status === 'LATE' ? 'badge-warning' : 'badge-danger'}">${a.status}</span></td>
    </tr>
  `).join('');

  const content = `
    <div class="card">
      <div class="card-title">
        <span>📈 Event Attendance Reports & Analytics</span>
        ${selectedEventId ? `<button onclick="window.print()" class="btn btn-outline btn-sm">🖨️ Print Report</button>` : ''}
      </div>

      <form method="GET" action="/admin/reports" class="toolbar">
        <div class="toolbar-group">
          <label style="font-weight: 600; font-size: 0.85rem;">Select Event:</label>
          <select name="event_id" class="form-control" style="width: 280px;" onchange="this.form.submit()">
            ${eventOpts}
          </select>
        </div>
      </form>

      ${eventDetail ? `
        <div style="background: #f8fafc; padding: 1rem; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 1rem;">
          <h3>${eventDetail.name} Report</h3>
          <p style="font-size: 0.85rem; color: var(--text-muted);">Date: ${eventDetail.event_date} | Location: ${eventDetail.location || 'N/A'}</p>
        </div>
      ` : ''}

      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Student Number</th>
              <th>Student Name</th>
              <th>Position</th>
              <th>Time In</th>
              <th>Time Out</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length > 0 ? rows : '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No attendance records found for this event.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage('Reports', content, req, 'reports'));
});

/* ==========================================================================
   SYSTEM SETTINGS, LOGO UPLOAD, AUDIT & BACKUP
   ========================================================================== */

app.get('/admin/settings', requireRole('ADMIN'), async (req, res) => {
  const settings = (await queryDB('SELECT * FROM settings LIMIT 1'))[0] || {};

  const content = `
    <div style="max-width: 800px; margin: 0 auto;" class="card">
      <div class="card-title">⚙️ School & Student Club Configuration</div>
      <form action="/admin/settings" method="POST" enctype="multipart/form-data">
        
        <div class="form-row">
          <div class="form-group">
            <label>School Name *</label>
            <input type="text" name="school_name" class="form-control" value="${settings.school_name || ''}" required>
          </div>
          <div class="form-group">
            <label>Student Club Name *</label>
            <input type="text" name="student_club_name" class="form-control" value="${settings.student_club_name || ''}" required>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Club Adviser *</label>
            <input type="text" name="club_adviser" class="form-control" value="${settings.club_adviser || ''}" required>
          </div>
          <div class="form-group">
            <label>School Year *</label>
            <input type="text" name="school_year" class="form-control" value="${settings.school_year || '2026-2027'}" required>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Student Registration Control</label>
            <select name="registration_open" class="form-control">
              <option value="1" ${settings.registration_open ? 'selected' : ''}>🟢 Open / Enabled</option>
              <option value="0" ${!settings.registration_open ? 'selected' : ''}>🔴 Closed / Disabled</option>
            </select>
          </div>
          <div class="form-group">
            <label>Student Number Prefix</label>
            <input type="text" name="student_number_prefix" class="form-control" value="${settings.student_number_prefix || 'SC-2026-'}">
          </div>
        </div>

        <div class="form-row" style="margin-top: 1rem;">
          <div class="form-group">
            <label>Upload / Replace School Logo</label>
            <input type="file" name="school_logo" class="form-control" accept="image/*">
            ${settings.school_logo ? `<img src="/uploads/logos/${settings.school_logo}" style="height: 50px; margin-top: 0.5rem;">` : ''}
          </div>
          <div class="form-group">
            <label>Upload / Replace Club Logo</label>
            <input type="file" name="club_logo" class="form-control" accept="image/*">
            ${settings.club_logo ? `<img src="/uploads/logos/${settings.club_logo}" style="height: 50px; margin-top: 0.5rem;">` : ''}
          </div>
        </div>

        <button type="submit" class="btn btn-primary" style="margin-top: 1rem;">Save Settings</button>
      </form>
    </div>
  `;
  res.send(await renderPage('Settings', content, req, 'settings'));
});

app.post('/admin/settings', requireRole('ADMIN'), upload.fields([
  { name: 'school_logo', maxCount: 1 },
  { name: 'club_logo', maxCount: 1 }
]), async (req, res) => {
  const { school_name, student_club_name, club_adviser, school_year, registration_open, student_number_prefix } = req.body;

  let schoolLogo = undefined;
  let clubLogo = undefined;

  if (req.files && req.files['school_logo']) schoolLogo = req.files['school_logo'][0].filename;
  if (req.files && req.files['club_logo']) clubLogo = req.files['club_logo'][0].filename;

  let sql = `UPDATE settings SET school_name=?, student_club_name=?, club_adviser=?, school_year=?, registration_open=?, student_number_prefix=?`;
  const params = [school_name, student_club_name, club_adviser, school_year, parseInt(registration_open, 10), student_number_prefix];

  if (schoolLogo) {
    sql += `, school_logo=?`;
    params.push(schoolLogo);
  }
  if (clubLogo) {
    sql += `, club_logo=?`;
    params.push(clubLogo);
  }

  await runDB(sql, params);
  await logAudit(req, 'SETTINGS_UPDATED', 'Updated school and club settings.');
  res.redirect('/admin/settings');
});

// Audit Logs Route
app.get('/admin/audit', requireRole('ADMIN'), async (req, res) => {
  const logs = await queryDB('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100');

  const rows = logs.map(l => `
    <tr>
      <td>${l.created_at || '--'}</td>
      <td><strong>${l.user_name}</strong></td>
      <td><span class="badge badge-info">${l.action}</span></td>
      <td>${l.details}</td>
      <td><code>${l.ip_address}</code></td>
    </tr>
  `).join('');

  const content = `
    <div class="card">
      <div class="card-title">📜 System Security & Audit Logs</div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr><th>Timestamp</th><th>User</th><th>Action</th><th>Details</th><th>IP Address</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage('Audit Logs', content, req, 'audit'));
});

// Database Backup Route
app.get('/admin/backup', requireRole('ADMIN'), async (req, res) => {
  const content = `
    <div style="max-width: 600px; margin: 0 auto;" class="card">
      <div class="card-title">💾 Database Backup & Permanent Storage</div>
      <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;">
        Your system data is stored persistently in the database. You can trigger manual JSON database snapshots at any time for offline archival.
      </p>
      <a href="/admin/backup/download" class="btn btn-success">📥 Download Database JSON Snapshot</a>
    </div>
  `;
  res.send(await renderPage('Backup', content, req, 'backup'));
});

app.get('/admin/backup/download', requireRole('ADMIN'), async (req, res) => {
  const students = await queryDB('SELECT * FROM students');
  const events = await queryDB('SELECT * FROM events');
  const attendance = await queryDB('SELECT * FROM attendance');
  const settings = await queryDB('SELECT * FROM settings');

  const snapshot = {
    exported_at: new Date().toISOString(),
    settings,
    students,
    events,
    attendance
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=club_attendance_backup_${Date.now()}.json`);
  res.send(JSON.stringify(snapshot, null, 2));
});

/* ==========================================================================
   EXPRESS APPLICATION BOOTSTRAP
   ========================================================================== */

app.listen(PORT, () => {
  console.log(`
========================================================================
🚀 SCHOOL STUDENT CLUB QR CODE ATTENDANCE SYSTEM IS ONLINE!
========================================================================
📍 Local Access URL : http://localhost:${PORT}
📱 Mobile QR Scanner: http://localhost:${PORT}/scanner
🎓 Student Registration: http://localhost:${PORT}/register
👤 Default Admin    : admin@school.edu / admin123
========================================================================
  `);
});
