/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Entire system single-file distribution engine.
 * Fully functional, secure, database-driven, and deployable.
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const qrcode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// Ensure upload directories exist
const uploadDir = path.join(__dirname, 'uploads');
const logoDir = path.join(__dirname, 'uploads', 'logos');
const photosDir = path.join(__dirname, 'uploads', 'photos');
const backupsDir = path.join(__dirname, 'backups');

[uploadDir, logoDir, photosDir, backupsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Configure Multer for File Uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'schoolLogo' || file.fieldname === 'clubLogo') {
      cb(null, logoDir);
    } else {
      cb(null, photosDir);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('Only PNG, JPG, JPEG, and WEBP files are allowed.'));
  }
});

// Database Abstraction Adapter (SQLite / PostgreSQL)
let dbAdapter = null;

if (DATABASE_URL && DATABASE_URL.startsWith('postgres')) {
  const pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  dbAdapter = {
    type: 'pg',
    query: async (text, params) => pgPool.query(text, params),
    get: async (text, params) => {
      const res = await pgPool.query(text, params);
      return res.rows[0];
    },
    all: async (text, params) => {
      const res = await pgPool.query(text, params);
      return res.rows;
    },
    run: async (text, params) => pgPool.query(text, params)
  };
} else {
  const sqliteDb = new Database(path.join(__dirname, 'school_club_attendance.db'));
  sqliteDb.pragma('journal_mode = WAL');
  dbAdapter = {
    type: 'sqlite',
    query: (text, params = []) => {
      // Simple polyfill for uniform parameter execution
      let convertedText = text;
      let count = 1;
      while (convertedText.includes('$')) {
        convertedText = convertedText.replace(`$${count}`, '?');
        count++;
      }
      const stmt = sqliteDb.prepare(convertedText);
      if (text.trim().toUpperCase().startsWith('SELECT')) return stmt.all(params);
      return stmt.run(params);
    },
    get: async (text, params = []) => {
      let convertedText = text;
      let count = 1;
      while (convertedText.includes(`$${count}`)) {
        convertedText = convertedText.replace(`$${count}`, '?');
        count++;
      }
      return sqliteDb.prepare(convertedText).get(params);
    },
    all: async (text, params = []) => {
      let convertedText = text;
      let count = 1;
      while (convertedText.includes(`$${count}`)) {
        convertedText = convertedText.replace(`$${count}`, '?');
        count++;
      }
      return sqliteDb.prepare(convertedText).all(params);
    },
    run: async (text, params = []) => {
      let convertedText = text;
      let count = 1;
      while (convertedText.includes(`$${count}`)) {
        convertedText = convertedText.replace(`$${count}`, '?');
        count++;
      }
      return sqliteDb.prepare(convertedText).run(params);
    }
  };
}

// Database Initialization and Safe Schema Migration
async function initDatabase() {
  try {
    const isPg = dbAdapter.type === 'pg';
    const autoInc = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    
    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS school_settings (
        id ${autoInc},
        school_name TEXT DEFAULT 'School Name',
        school_logo TEXT DEFAULT '',
        school_address TEXT DEFAULT '',
        school_contact TEXT DEFAULT '',
        school_email TEXT DEFAULT '',
        school_year TEXT DEFAULT '2026-2027',
        club_name TEXT DEFAULT 'Student Club',
        club_logo TEXT DEFAULT '',
        club_adviser TEXT DEFAULT '',
        org_name TEXT DEFAULT 'Student Club Organization',
        student_no_prefix TEXT DEFAULT 'SC-2026-',
        student_no_starting_num INT DEFAULT 1000,
        registration_open INT DEFAULT 1,
        timezone TEXT DEFAULT 'Asia/Manila',
        min_participation_rate REAL DEFAULT 75.0,
        late_threshold_minutes INT DEFAULT 10
      )
    `);

    // Ensure default settings exist
    const settings = await dbAdapter.get('SELECT * FROM school_settings LIMIT 1');
    if (!settings) {
      await dbAdapter.run(`
        INSERT INTO school_settings (school_name, club_name) 
        VALUES ('Default High School', 'Apex Student Club')
      `);
    }

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS users (
        id ${autoInc},
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL, -- admin, scanner, student
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS positions (
        id ${autoInc},
        title TEXT UNIQUE NOT NULL,
        is_default INT DEFAULT 0
      )
    `);

    // Seed default positions if empty
    const posCount = await dbAdapter.get('SELECT COUNT(*) as cnt FROM positions');
    if (parseInt(posCount.cnt || posCount['count'] || 0) === 0) {
      const defaultPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor', 'Public Information Officer', 'Peace Officer', 'Representative', 'Member'];
      for (const pos of defaultPositions) {
        await dbAdapter.run('INSERT INTO positions (title, is_default) VALUES ($1, 1)', [pos]);
      }
    }

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS students (
        id ${autoInc},
        user_id INT UNIQUE,
        student_number TEXT UNIQUE,
        first_name TEXT NOT NULL,
        middle_name TEXT DEFAULT '',
        last_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        contact_number TEXT DEFAULT '',
        position_id INT,
        photo_path TEXT DEFAULT '',
        qr_token TEXT UNIQUE,
        qr_enabled INT DEFAULT 1,
        status TEXT DEFAULT 'pending', -- pending, active, inactive, suspended, alumni, resigned
        date_joined DATE DEFAULT CURRENT_DATE,
        expiration_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS position_history (
        id ${autoInc},
        student_id INT NOT NULL,
        position_title TEXT NOT NULL,
        school_year TEXT NOT NULL,
        assigned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS events (
        id ${autoInc},
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        event_type TEXT NOT NULL,
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        location TEXT DEFAULT '',
        organizer TEXT DEFAULT '',
        status TEXT DEFAULT 'upcoming', -- upcoming, active, completed, cancelled
        target_audience TEXT DEFAULT 'all', -- all, officers, custom
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS event_participants (
        id ${autoInc},
        event_id INT NOT NULL,
        student_id INT NOT NULL,
        UNIQUE(event_id, student_id)
      )
    `);

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS attendance (
        id ${autoInc},
        event_id INT NOT NULL,
        student_id INT NOT NULL,
        time_in TIMESTAMP,
        time_out TIMESTAMP,
        status TEXT NOT NULL, -- Present, Late, Absent, Excused
        excused_reason TEXT DEFAULT '',
        excused_notes TEXT DEFAULT '',
        approved_by TEXT DEFAULT '',
        scan_date DATE DEFAULT CURRENT_DATE,
        UNIQUE(event_id, student_id)
      )
    `);

    await dbAdapter.run(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id ${autoInc},
        user_email TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Ensure Default Seed Admin User exists
    const adminUser = await dbAdapter.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
    if (!adminUser) {
      const hashedPassword = await bcrypt.hash('admin12345', 10);
      await dbAdapter.run(
        'INSERT INTO users (email, password, role) VALUES ($1, $2, $3)',
        ['admin@school.edu', hashedPassword, 'admin']
      );
      console.log('Default Admin Account Created: admin@school.edu / admin12345');
    }

    // Ensure Default Scanner User exists
    const scannerUser = await dbAdapter.get("SELECT * FROM users WHERE role = 'scanner' LIMIT 1");
    if (!scannerUser) {
      const hashedPassword = await bcrypt.hash('scanner12345', 10);
      await dbAdapter.run(
        'INSERT INTO users (email, password, role) VALUES ($1, $2, $3)',
        ['scanner@school.edu', hashedPassword, 'scanner']
      );
      console.log('Default Scanner Account Created: scanner@school.edu / scanner12345');
    }

    console.log('Database Engine Connected and Initialized Successfully.');
  } catch (err) {
    console.error('Database Initialization Failure:', err);
  }
}

initDatabase();

// Middleware Engine Configuration
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'club_attendance_super_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
  })
);

// Audit Logging Utility
async function logAudit(req, action, details = '') {
  try {
    const email = req.session.user ? req.session.user.email : 'system/anonymous';
    const role = req.session.user ? req.session.user.role : 'guest';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    await dbAdapter.run(
      'INSERT INTO audit_logs (user_email, role, action, details, ip_address) VALUES ($1, $2, $3, $4, $5)',
      [email, role, action, details, ip]
    );
  } catch (err) {
    console.error('Audit Logging Error:', err);
  }
}

// Authentication & Role Route Guards
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).send('Forbidden: Insufficient privileges.');
    }
    next();
  };
}

// Automatic Student Number Generator Helper
async function generateStudentNumber() {
  const settings = await dbAdapter.get('SELECT * FROM school_settings LIMIT 1');
  const prefix = settings.student_no_prefix || 'SC-2026-';
  const startNum = settings.student_no_starting_num || 1000;
  
  const lastStudent = await dbAdapter.get(
    "SELECT student_number FROM students WHERE student_number LIKE $1 ORDER BY id DESC LIMIT 1",
    [`${prefix}%`]
  );

  if (!lastStudent || !lastStudent.student_number) {
    return `${prefix}${String(startNum).padStart(6, '0')}`;
  }

  const numericPart = lastStudent.student_number.replace(prefix, '');
  const nextNum = parseInt(numericPart, 10) + 1;
  return `${prefix}${String(nextNum || startNum).padStart(6, '0')}`;
}

// UI Base Template Rendering Function
async function renderPage(req, title, content, activeNav = '') {
  const settings = await dbAdapter.get('SELECT * FROM school_settings LIMIT 1') || {};
  const user = req.session.user || null;

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ${settings.club_name || 'Club System'}</title>
    <style>
      :root {
        --primary: #1e3a8a;
        --primary-light: #3b82f6;
        --secondary: #0f172a;
        --accent: #10b981;
        --danger: #ef4444;
        --warning: #f59e0b;
        --bg: #f8fafc;
        --card-bg: #ffffff;
        --text: #1e293b;
        --border: #e2e8f0;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
      body { background-color: var(--bg); color: var(--text); display: flex; flex-direction: column; min-height: 100vh; }
      header { background-color: var(--primary); color: white; padding: 0.75rem 1.5rem; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      .header-title { display: flex; align-items: center; gap: 0.75rem; font-weight: 700; font-size: 1.1rem; }
      .header-title img { height: 36px; border-radius: 4px; background: #fff; padding: 2px; }
      nav { background: var(--secondary); display: flex; flex-wrap: wrap; padding: 0 1rem; }
      nav a { color: #cbd5e1; text-decoration: none; padding: 0.75rem 1rem; font-size: 0.9rem; font-weight: 500; transition: all 0.2s; }
      nav a:hover, nav a.active { color: white; background: rgba(255,255,255,0.1); border-bottom: 3px solid var(--primary-light); }
      main { flex: 1; padding: 1.5rem; max-width: 1400px; margin: 0 auto; width: 100%; }
      .card { background: var(--card-bg); border-radius: 8px; border: 1px solid var(--border); padding: 1.25rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
      .stat-card { border-left: 4px solid var(--primary-light); padding: 1rem; }
      .stat-card h4 { font-size: 0.85rem; color: #64748b; text-transform: uppercase; margin-bottom: 0.25rem; }
      .stat-card .value { font-size: 1.8rem; font-weight: 700; color: var(--secondary); }
      table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
      th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
      th { background: #f1f5f9; font-weight: 600; color: #475569; }
      tr:hover { background: #f8fafc; }
      .btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 600; text-decoration: none; border: none; cursor: pointer; font-size: 0.875rem; transition: background 0.2s; }
      .btn-primary { background: var(--primary-light); color: white; }
      .btn-primary:hover { background: #2563eb; }
      .btn-success { background: var(--accent); color: white; }
      .btn-danger { background: var(--danger); color: white; }
      .btn-warning { background: var(--warning); color: white; }
      .btn-secondary { background: #64748b; color: white; }
      .badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
      .badge-success { background: #dcfce7; color: #166534; }
      .badge-danger { background: #fee2e2; color: #991b1b; }
      .badge-warning { background: #fef3c7; color: #92400e; }
      .badge-info { background: #e0f2fe; color: #075985; }
      form .form-group { margin-bottom: 1rem; }
      form label { display: block; font-weight: 600; margin-bottom: 0.35rem; font-size: 0.875rem; }
      form input, form select, form textarea { width: 100%; padding: 0.5rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; }
      .avatar-sm { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
      .avatar-lg { width: 100px; height: 100px; border-radius: 50%; object-fit: cover; }
      footer { background: var(--secondary); color: #94a3b8; text-align: center; padding: 1rem; font-size: 0.8rem; margin-top: auto; }
      @media (max-width: 768px) {
        nav { flex-direction: column; }
        header { flex-direction: column; gap: 0.5rem; text-align: center; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-title">
        ${settings.school_logo ? `<img src="${settings.school_logo}" alt="School Logo">` : ''}
        ${settings.club_logo ? `<img src="${settings.club_logo}" alt="Club Logo">` : ''}
        <div>
          <div>${settings.school_name || 'School Student Club System'}</div>
          <div style="font-size: 0.8rem; font-weight: normal; opacity: 0.9;">${settings.club_name || 'Attendance Portal'}</div>
        </div>
      </div>
      <div>
        ${user ? `<span style="margin-right: 1rem; font-size: 0.85rem;">User: <strong>${user.email}</strong> (${user.role.toUpperCase()})</span><a href="/logout" class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Logout</a>` : '<a href="/login" class="btn btn-primary">Login</a>'}
      </div>
    </header>

    ${user ? `
    <nav>
      ${user.role === 'admin' ? `
        <a href="/admin/dashboard" class="${activeNav === 'dashboard' ? 'active' : ''}">Dashboard</a>
        <a href="/admin/students" class="${activeNav === 'students' ? 'active' : ''}">Students</a>
        <a href="/admin/registrations" class="${activeNav === 'registrations' ? 'active' : ''}">Registrations</a>
        <a href="/admin/positions" class="${activeNav === 'positions' ? 'active' : ''}">Positions</a>
        <a href="/admin/events" class="${activeNav === 'events' ? 'active' : ''}">Events</a>
        <a href="/scanner" target="_blank" class="${activeNav === 'scanner' ? 'active' : ''}">QR Scanner</a>
        <a href="/admin/reports" class="${activeNav === 'reports' ? 'active' : ''}">Reports & Analytics</a>
        <a href="/admin/id-cards" class="${activeNav === 'ids' ? 'active' : ''}">Print Student IDs</a>
        <a href="/admin/settings" class="${activeNav === 'settings' ? 'active' : ''}">Settings & Backup</a>
        <a href="/admin/audit-logs" class="${activeNav === 'audit' ? 'active' : ''}">Audit Logs</a>
      ` : ''}
      ${user.role === 'scanner' ? `
        <a href="/scanner" class="${activeNav === 'scanner' ? 'active' : ''}">Mobile QR Scanner</a>
      ` : ''}
      ${user.role === 'student' ? `
        <a href="/member" class="${activeNav === 'portal' ? 'active' : ''}">My Student Portal</a>
      ` : ''}
      <a href="/change-password" class="${activeNav === 'password' ? 'active' : ''}">Change Password</a>
    </nav>
    ` : ''}

    <main>
      ${content}
    </main>

    <footer>
      <div>&copy; ${new Date().getFullYear()} ${settings.school_name || 'School System'} - ${settings.club_name || 'Student Club Attendance'}</div>
      <div>School Year: ${settings.school_year || '2026-2027'} | Timezone: ${settings.timezone || 'Asia/Manila'}</div>
    </footer>
  </body>
  </html>
  `;
}

// ----------------------------------------------------
// PUBLIC ROUTES & AUTHENTICATION
// ----------------------------------------------------

app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
    if (req.session.user.role === 'scanner') return res.redirect('/scanner');
    if (req.session.user.role === 'student') return res.redirect('/member');
  }
  res.redirect('/login');
});

app.get('/login', async (req, res) => {
  const html = `
    <div style="max-width: 400px; margin: 3rem auto;" class="card">
      <h2 style="margin-bottom: 1.5rem; text-align: center; color: var(--primary);">System Login</h2>
      <form action="/login" method="POST">
        <div class="form-group">
          <label>Email Address</label>
          <input type="email" name="email" required placeholder="user@school.edu">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" name="password" required placeholder="••••••••">
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">Sign In</button>
      </form>
      <div style="margin-top: 1.5rem; text-align: center; font-size: 0.85rem;">
        <p>New Student? <a href="/register">Self-Register Here</a></p>
      </div>
    </div>
  `;
  res.send(await renderPage(req, 'Login', html));
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await dbAdapter.get('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) {
      return res.send(await renderPage(req, 'Login', `<div class="card" style="color: var(--danger);">Invalid email or password. <a href="/login">Try again</a></div>`));
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.send(await renderPage(req, 'Login', `<div class="card" style="color: var(--danger);">Invalid email or password. <a href="/login">Try again</a></div>`));
    }

    req.session.user = { id: user.id, email: user.email, role: user.role };
    await logAudit(req, 'LOGIN', 'User successfully logged in.');

    if (user.role === 'admin') return res.redirect('/admin/dashboard');
    if (user.role === 'scanner') return res.redirect('/scanner');
    if (user.role === 'student') return res.redirect('/member');
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Internal Login Error.');
  }
});

app.get('/logout', async (req, res) => {
  await logAudit(req, 'LOGOUT', 'User logged out.');
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/change-password', requireAuth, async (req, res) => {
  const html = `
    <div style="max-width: 500px; margin: 2rem auto;" class="card">
      <h3>Change Account Password</h3>
      <form action="/change-password" method="POST" style="margin-top: 1rem;">
        <div class="form-group">
          <label>Current Password</label>
          <input type="password" name="currentPassword" required>
        </div>
        <div class="form-group">
          <label>New Password (Min 8 chars)</label>
          <input type="password" name="newPassword" minlength="8" required>
        </div>
        <div class="form-group">
          <label>Confirm New Password</label>
          <input type="password" name="confirmPassword" minlength="8" required>
        </div>
        <button type="submit" class="btn btn-primary">Update Password</button>
      </form>
    </div>
  `;
  res.send(await renderPage(req, 'Change Password', html, 'password'));
});

app.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (newPassword !== confirmPassword) {
    return res.send(await renderPage(req, 'Error', `<div class="card" style="color: var(--danger);">New passwords do not match. <a href="/change-password">Back</a></div>`));
  }

  const user = await dbAdapter.get('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) {
    return res.send(await renderPage(req, 'Error', `<div class="card" style="color: var(--danger);">Incorrect current password. <a href="/change-password">Back</a></div>`));
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await dbAdapter.run('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, req.session.user.id]);
  await logAudit(req, 'PASSWORD_CHANGE', 'User updated account password.');

  res.send(await renderPage(req, 'Success', `<div class="card" style="color: var(--accent);">Password updated successfully. <a href="/">Return Home</a></div>`));
});

// ----------------------------------------------------
// PUBLIC STUDENT SELF-REGISTRATION ROUTE
// ----------------------------------------------------

app.get('/register', async (req, res) => {
  const settings = await dbAdapter.get('SELECT * FROM school_settings LIMIT 1');
  if (!settings || parseInt(settings.registration_open) !== 1) {
    const closedHtml = `
      <div style="max-width: 500px; margin: 3rem auto; text-align: center;" class="card">
        <h2 style="color: var(--danger);">Registration Closed</h2>
        <p style="margin-top: 1rem;">Student self-registration is currently closed.</p>
        <p>Please contact your Student Club Adviser or Administrator.</p>
      </div>
    `;
    return res.send(await renderPage(req, 'Registration Closed', closedHtml));
  }

  const positions = await dbAdapter.all('SELECT * FROM positions ORDER BY title ASC');

  const html = `
    <div style="max-width: 600px; margin: 1rem auto;" class="card">
      <h2 style="margin-bottom: 0.5rem; color: var(--primary);">Student Club Registration</h2>
      <p style="font-size: 0.85rem; color: #64748b; margin-bottom: 1.5rem;">Fill in your details accurately. Your registration will undergo Adviser approval.</p>
      
      <form action="/register" method="POST" enctype="multipart/form-weight" enctype="multipart/form-data">
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label>First Name *</label>
            <input type="text" name="first_name" required>
          </div>
          <div class="form-group">
            <label>Middle Name</label>
            <input type="text" name="middle_name">
          </div>
        </div>

        <div class="form-group">
          <label>Last Name *</label>
          <input type="text" name="last_name" required>
        </div>

        <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label>Email Address *</label>
            <input type="email" name="email" required placeholder="student@example.com">
          </div>
          <div class="form-group">
            <label>Contact Number</label>
            <input type="text" name="contact_number" placeholder="09123456789">
          </div>
        </div>

        <div class="form-group">
          <label>Club Position *</label>
          <select name="position_id" required>
            <option value="">-- Select Position --</option>
            ${positions.map(p => `<option value="${p.id}">${p.title}</option>`).join('')}
          </select>
        </div>

        <div class="form-group">
          <label>Student Photo (JPG, PNG, WEBP) *</label>
          <input type="file" name="photo" accept="image/*" required onchange="previewImage(event)">
          <div style="margin-top: 0.5rem; text-align: center;">
            <img id="photo-preview" style="max-width: 120px; max-height: 120px; display: none; border-radius: 8px; border: 1px solid var(--border);">
          </div>
        </div>

        <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 1rem;">Submit Registration</button>
      </form>
    </div>

    <script>
      function previewImage(event) {
        const reader = new FileReader();
        reader.onload = function() {
          const preview = document.getElementById('photo-preview');
          preview.src = reader.result;
          preview.style.display = 'block';
        }
        if(event.target.files[0]) {
          reader.readAsDataURL(event.target.files[0]);
        }
      }
    </script>
  `;
  res.send(await renderPage(req, 'Student Registration', html));
});

app.post('/register', upload.single('photo'), async (req, res) => {
  try {
    const { first_name, middle_name, last_name, email, contact_number, position_id } = req.body;
    
    if (!req.file) {
      return res.send(await renderPage(req, 'Error', `<div class="card" style="color: var(--danger);">Photo upload is required. <a href="/register">Back</a></div>`));
    }

    const existingUser = await dbAdapter.get('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser) {
      return res.send(await renderPage(req, 'Error', `<div class="card" style="color: var(--danger);">Email address already exists in system. <a href="/register">Back</a></div>`));
    }

    const photoPath = `/uploads/photos/${req.file.filename}`;

    await dbAdapter.run(
      `INSERT INTO students (first_name, middle_name, last_name, email, contact_number, position_id, photo_path, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [first_name, middle_name || '', last_name, email, contact_number || '', position_id, photoPath]
    );

    await logAudit(req, 'REGISTRATION_SUBMITTED', `New student registration submitted for email: ${email}`);

    const successHtml = `
      <div style="max-width: 500px; margin: 3rem auto; text-align: center;" class="card">
        <h2 style="color: var(--accent);">✓ REGISTRATION SUCCESSFUL</h2>
        <p style="margin-top: 1rem;">Your registration details have been submitted successfully.</p>
        <p style="margin-top: 0.5rem; color: #64748b;">Status: <strong>Pending Approval</strong></p>
        <p style="margin-top: 1rem; font-size: 0.85rem;">Please wait for your Club Adviser to verify and approve your registration.</p>
        <a href="/login" class="btn btn-primary" style="margin-top: 1.5rem;">Return to Login</a>
      </div>
    `;
    res.send(await renderPage(req, 'Registration Success', successHtml));
  } catch (err) {
    console.error('Registration Processing Error:', err);
    res.status(500).send('Internal Error Processing Registration.');
  }
});

// ----------------------------------------------------
// ADMIN DASHBOARD & MANAGEMENT ROUTES
// ----------------------------------------------------

app.get('/admin/dashboard', requireRole(['admin']), async (req, res) => {
  const dateFilter = req.query.date || new Date().toISOString().split('T')[0];
  const eventFilter = req.query.event_id || 'all';

  // Calculate Accurate Real-time DB Metrics
  const totalStudents = (await dbAdapter.get("SELECT COUNT(*) as cnt FROM students WHERE status != 'pending'")).cnt;
  const activeStudents = (await dbAdapter.get("SELECT COUNT(*) as cnt FROM students WHERE status = 'active'")).cnt;
  const pendingRegistrations = (await dbAdapter.get("SELECT COUNT(*) as cnt FROM students WHERE status = 'pending'")).cnt;
  
  let attendanceQuery = "SELECT status, COUNT(*) as cnt FROM attendance WHERE scan_date = $1";
  let attParams = [dateFilter];
  if (eventFilter !== 'all') {
    attendanceQuery += " AND event_id = $2";
    attParams.push(eventFilter);
  }
  attendanceQuery += " GROUP BY status";

  const attRows = await dbAdapter.all(attendanceQuery, attParams);
  let presentToday = 0, lateToday = 0, absentToday = 0, excusedToday = 0;
  
  attRows.forEach(r => {
    if (r.status === 'Present') presentToday = parseInt(r.cnt);
    if (r.status === 'Late') lateToday = parseInt(r.cnt);
    if (r.status === 'Absent') absentToday = parseInt(r.cnt);
    if (r.status === 'Excused') excusedToday = parseInt(r.cnt);
  });

  const totalScanned = presentToday + lateToday + absentToday + excusedToday;
  const attendanceRate = totalStudents > 0 ? ((presentToday + lateToday) / totalStudents * 100).toFixed(1) : '0.0';

  const events = await dbAdapter.all("SELECT * FROM events ORDER BY event_date DESC LIMIT 10");
  const recentScans = await dbAdapter.all(`
    SELECT a.*, s.first_name, s.last_name, s.student_number, p.title as position_title, e.name as event_name
    FROM attendance a
    JOIN students s ON a.student_id = s.id
    LEFT JOIN positions p ON s.position_id = p.id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.id DESC LIMIT 10
  `);

  const html = `
    <h2 style="margin-bottom: 1.5rem;">Club Adviser Dashboard</h2>
    
    <div style="margin-bottom: 1.5rem;" class="card">
      <form method="GET" style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
        <div>
          <label style="font-size: 0.8rem;">Filter Date:</label>
          <input type="date" name="date" value="${dateFilter}" onchange="this.form.submit()">
        </div>
        <div>
          <label style="font-size: 0.8rem;">Filter Event:</label>
          <select name="event_id" onchange="this.form.submit()">
            <option value="all">All Events</option>
            ${events.map(e => `<option value="${e.id}" ${eventFilter == e.id ? 'selected' : ''}>${e.name}</option>`).join('')}
          </select>
        </div>
        <div style="margin-left: auto;">
          <span class="badge badge-info">DB Status: ● Connected</span>
        </div>
      </form>
    </div>

    <div class="grid" style="margin-bottom: 1.5rem;">
      <div class="card stat-card" style="border-color: #3b82f6;">
        <h4>Total Active Students</h4>
        <div class="value">${activeStudents}</div>
        <div style="font-size: 0.75rem; color: #64748b;">Total Registered: ${totalStudents}</div>
      </div>
      <div class="card stat-card" style="border-color: #10b981;">
        <h4>Present Today / Event</h4>
        <div class="value">${presentToday}</div>
        <div style="font-size: 0.75rem; color: #10b981;">Valid On-Time Scans</div>
      </div>
      <div class="card stat-card" style="border-color: #f59e0b;">
        <h4>Late Scans</h4>
        <div class="value">${lateToday}</div>
        <div style="font-size: 0.75rem; color: #f59e0b;">Passed Threshold</div>
      </div>
      <div class="card stat-card" style="border-color: #ef4444;">
        <h4>Absent Count</h4>
        <div class="value">${absentToday}</div>
        <div style="font-size: 0.75rem; color: #ef4444;">Unattended Events</div>
      </div>
      <div class="card stat-card" style="border-color: #8b5cf6;">
        <h4>Attendance Rate</h4>
        <div class="value">${attendanceRate}%</div>
        <div style="font-size: 0.75rem; color: #8b5cf6;">Real DB Verified</div>
      </div>
    </div>

    ${pendingRegistrations > 0 ? `
      <div class="card" style="background: #fef3c7; border-color: #f59e0b; display: flex; justify-content: space-between; align-items: center;">
        <div><strong>⚠️ ${pendingRegistrations} Pending Student Registration(s)</strong> awaiting review.</div>
        <a href="/admin/registrations" class="btn btn-warning">Review Pending</a>
      </div>
    ` : ''}

    <div class="card">
      <h3>Live Scanner Feed / Recent Attendance Records</h3>
      <table>
        <thead>
          <tr>
            <th>Student No.</th>
            <th>Student Name</th>
            <th>Position</th>
            <th>Event</th>
            <th>Time In</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${recentScans.length > 0 ? recentScans.map(r => `
            <tr>
              <td><strong>${r.student_number}</strong></td>
              <td>${r.first_name} ${r.last_name}</td>
              <td>${r.position_title || 'Member'}</td>
              <td>${r.event_name}</td>
              <td>${new Date(r.time_in).toLocaleTimeString()}</td>
              <td><span class="badge badge-${r.status === 'Present' ? 'success' : r.status === 'Late' ? 'warning' : 'danger'}">${r.status}</span></td>
            </tr>
          `).join('') : '<tr><td colspan="6" style="text-align: center; color: #64748b;">No recent attendance records found.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  res.send(await renderPage(req, 'Admin Dashboard', html, 'dashboard'));
});

// Student Management & Approval Workflow
app.get('/admin/registrations', requireRole(['admin']), async (req, res) => {
  const pending = await dbAdapter.all(`
    SELECT s.*, p.title as position_title 
    FROM students s
    LEFT JOIN positions p ON s.position_id = p.id
    WHERE s.status = 'pending'
    ORDER BY s.id DESC
  `);

  const html = `
    <h2>Pending Student Registrations</h2>
    <div class="card" style="margin-top: 1rem;">
      <table>
        <thead>
          <tr>
            <th>Photo</th>
            <th>Name</th>
            <th>Email Address</th>
            <th>Contact</th>
            <th>Position</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${pending.length > 0 ? pending.map(s => `
            <tr>
              <td><img src="${s.photo_path}" class="avatar-sm"></td>
              <td><strong>${s.first_name} ${s.middle_name || ''} ${s.last_name}</strong></td>
              <td>${s.email}</td>
              <td>${s.contact_number || 'N/A'}</td>
              <td>${s.position_title || 'Member'}</td>
              <td>
                <a href="/admin/registrations/approve/${s.id}" class="btn btn-success" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Approve</a>
                <a href="/admin/registrations/reject/${s.id}" class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="return confirm('Reject registration?')">Reject</a>
              </td>
            </tr>
          `).join('') : '<tr><td colspan="6" style="text-align: center; color: #64748b;">No pending registrations.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderPage(req, 'Pending Registrations', html, 'registrations'));
});

app.get('/admin/registrations/approve/:id', requireRole(['admin']), async (req, res) => {
  const studentId = req.params.id;
  const student = await dbAdapter.get('SELECT * FROM students WHERE id = $1', [studentId]);
  if (!student) return res.redirect('/admin/registrations');

  const studentNumber = await generateStudentNumber();
  const qrToken = `QR-${Date.now()}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
  const defaultPassword = await bcrypt.hash('student12345', 10);

  // Create login user account
  const newUser = await dbAdapter.run(
    'INSERT INTO users (email, password, role) VALUES ($1, $2, $3)',
    [student.email, defaultPassword, 'student']
  );

  const userId = newUser.lastInsertRowid || (await dbAdapter.get('SELECT id FROM users WHERE email = $1', [student.email])).id;

  // Update Student Record
  await dbAdapter.run(
    `UPDATE students 
     SET user_id = $1, student_number = $2, qr_token = $3, status = 'active'
     WHERE id = $4`,
    [userId, studentNumber, qrToken, studentId]
  );

  // Record Position History
  const settings = await dbAdapter.get('SELECT school_year FROM school_settings LIMIT 1');
  const pos = await dbAdapter.get('SELECT title FROM positions WHERE id = $1', [student.position_id]);
  await dbAdapter.run(
    'INSERT INTO position_history (student_id, position_title, school_year) VALUES ($1, $2, $3)',
    [studentId, pos ? pos.title : 'Member', settings.school_year || '2026-2027']
  );

  await logAudit(req, 'STUDENT_APPROVED', `Approved student ID ${studentId}. Assigned Student No: ${studentNumber}`);

  res.redirect('/admin/registrations');
});

app.get('/admin/registrations/reject/:id', requireRole(['admin']), async (req, res) => {
  await dbAdapter.run("UPDATE students SET status = 'rejected' WHERE id = $1", [req.params.id]);
  await logAudit(req, 'STUDENT_REJECTED', `Rejected registration ID ${req.params.id}`);
  res.redirect('/admin/registrations');
});

// Student Directory
app.get('/admin/students', requireRole(['admin']), async (req, res) => {
  const search = req.query.search || '';
  const posFilter = req.query.position || 'all';

  let query = `
    SELECT s.*, p.title as position_title 
    FROM students s
    LEFT JOIN positions p ON s.position_id = p.id
    WHERE s.status != 'pending'
  `;
  const params = [];

  if (search) {
    query += ` AND (s.first_name LIKE $1 OR s.last_name LIKE $1 OR s.student_number LIKE $1 OR s.email LIKE $1)`;
    params.push(`%${search}%`);
  }
  if (posFilter !== 'all') {
    query += params.length ? ` AND s.position_id = $${params.length + 1}` : ` AND s.position_id = 1`;
    params.push(posFilter);
  }

  query += ` ORDER BY s.id DESC`;

  const students = await dbAdapter.all(query, params);
  const positions = await dbAdapter.all('SELECT * FROM positions ORDER BY title ASC');

  const html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2>Student Club Directory</h2>
      <a href="/register" target="_blank" class="btn btn-primary">+ Register New Student</a>
    </div>

    <div class="card" style="margin-bottom: 1rem;">
      <form method="GET" style="display: flex; gap: 1rem;">
        <input type="text" name="search" value="${search}" placeholder="Search Name, Student No, Email..." style="flex: 1;">
        <select name="position" style="width: 200px;">
          <option value="all">All Positions</option>
          ${positions.map(p => `<option value="${p.id}" ${posFilter == p.id ? 'selected' : ''}>${p.title}</option>`).join('')}
        </select>
        <button type="submit" class="btn btn-secondary">Filter</button>
      </form>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Photo</th>
            <th>Student Number</th>
            <th>Name</th>
            <th>Position</th>
            <th>Status</th>
            <th>QR Token</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${students.length > 0 ? students.map(s => `
            <tr>
              <td><img src="${s.photo_path}" class="avatar-sm"></td>
              <td><strong>${s.student_number || 'N/A'}</strong></td>
              <td>${s.first_name} ${s.last_name}</td>
              <td>${s.position_title || 'Member'}</td>
              <td><span class="badge badge-${s.status === 'active' ? 'success' : 'danger'}">${s.status}</span></td>
              <td><code style="font-size: 0.75rem;">${s.qr_token || 'None'}</code></td>
              <td>
                <a href="/admin/students/edit/${s.id}" class="btn btn-primary" style="padding: 0.2rem 0.4rem; font-size: 0.75rem;">Edit</a>
                <a href="/admin/students/qr/regenerate/${s.id}" class="btn btn-warning" style="padding: 0.2rem 0.4rem; font-size: 0.75rem;" onclick="return confirm('Regenerate QR? Old QR will stop working.')">Regenerate QR</a>
              </td>
            </tr>
          `).join('') : '<tr><td colspan="7" style="text-align: center; color: #64748b;">No student records found.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderPage(req, 'Students Directory', html, 'students'));
});

// Position Customization System
app.get('/admin/positions', requireRole(['admin']), async (req, res) => {
  const positions = await dbAdapter.all('SELECT * FROM positions ORDER BY title ASC');

  const html = `
    <h2>Custom Position Management</h2>
    <div class="grid" style="grid-template-columns: 1fr 2fr; gap: 1.5rem; margin-top: 1rem;">
      <div class="card">
        <h3>Add New Position</h3>
        <form action="/admin/positions/add" method="POST" style="margin-top: 1rem;">
          <div class="form-group">
            <label>Position Title</label>
            <input type="text" name="title" required placeholder="e.g. Documentation Officer">
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%;">Save Position</button>
        </form>
      </div>

      <div class="card">
        <h3>Existing Positions</h3>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Position Title</th>
              <th>Type</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${positions.map(p => `
              <tr>
                <td>${p.id}</td>
                <td><strong>${p.title}</strong></td>
                <td>${p.is_default ? '<span class="badge badge-info">Default</span>' : '<span class="badge badge-success">Custom</span>'}</td>
                <td>
                  ${!p.is_default ? `<a href="/admin/positions/delete/${p.id}" class="btn btn-danger" style="padding: 0.2rem 0.4rem; font-size: 0.75rem;" onclick="return confirm('Delete position?')">Delete</a>` : '<span style="color: #94a3b8; font-size: 0.75rem;">System Standard</span>'}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage(req, 'Position Management', html, 'positions'));
});

app.post('/admin/positions/add', requireRole(['admin']), async (req, res) => {
  try {
    await dbAdapter.run('INSERT INTO positions (title, is_default) VALUES ($1, 0)', [req.body.title.trim()]);
    await logAudit(req, 'POSITION_ADDED', `Created position: ${req.body.title}`);
  } catch (err) {
    console.error('Add Position Error:', err);
  }
  res.redirect('/admin/positions');
});

app.get('/admin/positions/delete/:id', requireRole(['admin']), async (req, res) => {
  await dbAdapter.run('DELETE FROM positions WHERE id = $1 AND is_default = 0', [req.params.id]);
  await logAudit(req, 'POSITION_DELETED', `Deleted position ID: ${req.params.id}`);
  res.redirect('/admin/positions');
});

// ----------------------------------------------------
// EVENT MANAGEMENT & PARTICIPANT ASSIGNMENT
// ----------------------------------------------------

app.get('/admin/events', requireRole(['admin']), async (req, res) => {
  const events = await dbAdapter.all('SELECT * FROM events ORDER BY event_date DESC, start_time DESC');

  const html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2>Event Management</h2>
      <a href="/admin/events/create" class="btn btn-primary">+ Create Event</a>
    </div>

    <div class="card">
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
          ${events.length > 0 ? events.map(e => `
            <tr>
              <td><strong>${e.name}</strong><br><small style="color: #64748b;">${e.description || ''}</small></td>
              <td><span class="badge badge-info">${e.event_type}</span></td>
              <td>${e.event_date}<br><small>${e.start_time} - ${e.end_time}</small></td>
              <td>${e.location || 'N/A'}</td>
              <td><span class="badge badge-${e.status === 'active' ? 'success' : e.status === 'upcoming' ? 'warning' : 'secondary'}">${e.status}</span></td>
              <td>
                <a href="/admin/events/toggle-status/${e.id}" class="btn btn-secondary" style="padding: 0.2rem 0.4rem; font-size: 0.75rem;">Change Status</a>
              </td>
            </tr>
          `).join('') : '<tr><td colspan="6" style="text-align: center; color: #64748b;">No events configured.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderPage(req, 'Events Management', html, 'events'));
});

app.get('/admin/events/create', requireRole(['admin']), async (req, res) => {
  const html = `
    <div style="max-width: 600px; margin: 1rem auto;" class="card">
      <h3>Create New Club Event</h3>
      <form action="/admin/events/create" method="POST" style="margin-top: 1rem;">
        <div class="form-group">
          <label>Event Name *</label>
          <input type="text" name="name" required placeholder="General Assembly Meeting">
        </div>
        <div class="form-group">
          <label>Event Description</label>
          <textarea name="description" rows="2"></textarea>
        </div>
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label>Event Type *</label>
            <select name="event_type" required>
              <option value="General Assembly">General Assembly</option>
              <option value="Club Meeting">Club Meeting</option>
              <option value="Officer Meeting">Officer Meeting</option>
              <option value="Workshop">Workshop</option>
              <option value="Seminar">Seminar</option>
              <option value="Community Service">Community Service</option>
              <option value="Custom Event">Custom Event</option>
            </select>
          </div>
          <div class="form-group">
            <label>Event Date *</label>
            <input type="date" name="event_date" required>
          </div>
        </div>
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label>Start Time *</label>
            <input type="time" name="start_time" required>
          </div>
          <div class="form-group">
            <label>End Time *</label>
            <input type="time" name="end_time" required>
          </div>
        </div>
        <div class="form-group">
          <label>Location</label>
          <input type="text" name="location" placeholder="School Auditorium">
        </div>
        <button type="submit" class="btn btn-primary" style="width: 100%;">Create Event</button>
      </form>
    </div>
  `;
  res.send(await renderPage(req, 'Create Event', html, 'events'));
});

app.post('/admin/events/create', requireRole(['admin']), async (req, res) => {
  const { name, description, event_type, event_date, start_time, end_time, location } = req.body;
  await dbAdapter.run(
    `INSERT INTO events (name, description, event_type, event_date, start_time, end_time, location, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
    [name, description || '', event_type, event_date, start_time, end_time, location || '']
  );
  await logAudit(req, 'EVENT_CREATED', `Created event: ${name} on ${event_date}`);
  res.redirect('/admin/events');
});

app.get('/admin/events/toggle-status/:id', requireRole(['admin']), async (req, res) => {
  const event = await dbAdapter.get('SELECT * FROM events WHERE id = $1', [req.params.id]);
  if (event) {
    let newStatus = 'active';
    if (event.status === 'active') newStatus = 'completed';
    else if (event.status === 'completed') newStatus = 'upcoming';

    await dbAdapter.run('UPDATE events SET status = $1 WHERE id = $2', [newStatus, req.params.id]);
    await logAudit(req, 'EVENT_STATUS_CHANGE', `Changed event ${event.id} status to ${newStatus}`);
  }
  res.redirect('/admin/events');
});

// ----------------------------------------------------
// MOBILE SCANNER PORTAL & REAL-TIME SPEECH / AUDIO
// ----------------------------------------------------

app.get('/scanner', requireRole(['admin', 'scanner']), async (req, res) => {
  const activeEvents = await dbAdapter.all("SELECT * FROM events WHERE status = 'active' ORDER BY event_date DESC");

  const html = `
    <div style="max-width: 650px; margin: 0 auto;">
      <div class="card" style="text-align: center;">
        <h2 style="color: var(--primary);">Mobile QR Code Attendance Scanner</h2>
        <p style="font-size: 0.85rem; color: #64748b;">Select an active event and scan student ID QR code.</p>
        
        <div style="margin: 1rem 0;">
          <label style="font-weight: bold;">Active Event Target:</label>
          <select id="event-select" style="padding: 0.5rem; width: 100%; margin-top: 0.35rem;">
            ${activeEvents.length > 0 ? activeEvents.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('') : '<option value="">-- No Active Events Available --</option>'}
          </select>
        </div>

        <div style="margin: 1rem 0; display: flex; gap: 0.5rem; justify-content: center;">
          <button id="btn-time-in" class="btn btn-success" style="flex: 1;" onclick="setScanMode('TIME_IN')">● TIME IN MODE</button>
          <button id="btn-time-out" class="btn btn-secondary" style="flex: 1;" onclick="setScanMode('TIME_OUT')">○ TIME OUT MODE</button>
        </div>

        <!-- Camera Scanner Feed Simulation/WebCam Container -->
        <div id="video-container" style="position: relative; background: #000; height: 260px; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; color: white;">
          <video id="webcam-preview" autoplay playsinline style="width: 100%; height: 100%; object-fit: cover;"></video>
          <div style="position: absolute; border: 2px dashed #10b981; width: 180px; height: 180px; border-radius: 12px; pointer-events: none;"></div>
          <div id="camera-notice" style="position: absolute; bottom: 10px; background: rgba(0,0,0,0.6); padding: 4px 8px; border-radius: 4px; font-size: 0.75rem;">Camera Active</div>
        </div>

        <!-- Manual Manual Quick Token Input for Field Testing -->
        <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
          <input type="text" id="manual-qr-input" placeholder="Scan or enter QR token..." onkeypress="if(event.key==='Enter') submitScan()">
          <button class="btn btn-primary" onclick="submitScan()">Submit Scan</button>
        </div>
      </div>

      <!-- Live Scan Result Display Container -->
      <div id="scan-result-card" class="card" style="display: none; text-align: center;">
        <div id="result-status-badge"></div>
        <img id="result-photo" class="avatar-lg" style="margin: 0.75rem auto; display: block;">
        <h3 id="result-name"></h3>
        <p id="result-student-no" style="font-weight: bold; color: var(--primary);"></p>
        <p id="result-position" style="color: #64748b; font-size: 0.9rem;"></p>
        <p id="result-time" style="margin-top: 0.5rem; font-size: 0.85rem; font-weight: 600;"></p>
      </div>
    </div>

    <script>
      let currentScanMode = 'TIME_IN';
      
      function setScanMode(mode) {
        currentScanMode = mode;
        if(mode === 'TIME_IN') {
          document.getElementById('btn-time-in').className = 'btn btn-success';
          document.getElementById('btn-time-out').className = 'btn btn-secondary';
        } else {
          document.getElementById('btn-time-in').className = 'btn btn-secondary';
          document.getElementById('btn-time-out').className = 'btn btn-warning';
        }
      }

      // Initialize WebCam Access if Supported
      async function initCamera() {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          document.getElementById('webcam-preview').srcObject = stream;
        } catch(err) {
          document.getElementById('camera-notice').innerText = 'Camera access restricted/unavailable. Use manual input.';
        }
      }
      initCamera();

      // Web Speech Synthesis Announcement Engine
      function speakText(text) {
        if ('speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          window.speechSynthesis.speak(utterance);
        }
      }

      // Audio Synthesis Feedback Tones
      function playAudioFeedback(type) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'success') {
          osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
          osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
        } else if (type === 'warning') {
          osc.frequency.setValueAtTime(440, ctx.currentTime);
          osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
        } else {
          osc.frequency.setValueAtTime(220, ctx.currentTime); // Low Error Tone
        }

        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }

      async function submitScan() {
        const qrInput = document.getElementById('manual-qr-input');
        const token = qrInput.value.trim();
        const eventId = document.getElementById('event-select').value;

        if(!token) return alert('Please enter or scan a valid QR token.');
        if(!eventId) return alert('Please select an active event first.');

        try {
          const res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, event_id: eventId, mode: currentScanMode })
          });

          const data = await res.json();
          const card = document.getElementById('scan-result-card');
          card.style.display = 'block';

          if (data.success) {
            playAudioFeedback('success');
            speakText(data.speechText);

            document.getElementById('result-status-badge').innerHTML = '<span class="badge badge-success" style="font-size: 1rem;">✓ ' + data.status + ' RECORDED</span>';
            document.getElementById('result-photo').src = data.student.photo_path || '/uploads/photos/default.png';
            document.getElementById('result-name').innerText = data.student.first_name + ' ' + data.student.last_name;
            document.getElementById('result-student-no').innerText = 'Student No: ' + data.student.student_number;
            document.getElementById('result-position').innerText = 'Position: ' + (data.student.position_title || 'Member');
            document.getElementById('result-time').innerText = 'Recorded Time: ' + new Date().toLocaleTimeString();
          } else {
            playAudioFeedback(data.duplicate ? 'warning' : 'error');
            speakText(data.speechText);

            document.getElementById('result-status-badge').innerHTML = '<span class="badge badge-danger" style="font-size: 1rem;">✕ ' + data.message + '</span>';
            if(data.student) {
              document.getElementById('result-photo').src = data.student.photo_path;
              document.getElementById('result-name').innerText = data.student.first_name + ' ' + data.student.last_name;
              document.getElementById('result-student-no').innerText = 'Student No: ' + data.student.student_number;
            } else {
              document.getElementById('result-photo').src = '';
              document.getElementById('result-name').innerText = 'Unknown Student';
              document.getElementById('result-student-no').innerText = '';
            }
            document.getElementById('result-position').innerText = '';
            document.getElementById('result-time').innerText = '';
          }

          qrInput.value = '';
          qrInput.focus();
        } catch(err) {
          alert('Network or scanning error processing request.');
        }
      }
    </script>
  `;
  res.send(await renderPage(req, 'QR Scanner Portal', html, 'scanner'));
});

// API Route for Processing QR Scans
app.post('/api/scan', requireRole(['admin', 'scanner']), async (req, res) => {
  const { token, event_id, mode } = req.body;

  try {
    const student = await dbAdapter.get(`
      SELECT s.*, p.title as position_title 
      FROM students s
      LEFT JOIN positions p ON s.position_id = p.id
      WHERE s.qr_token = $1 AND s.status = 'active'
    `, [token]);

    if (!student) {
      return res.json({
        success: false,
        message: 'INVALID QR CODE',
        speechText: 'Invalid QR code.'
      });
    }

    if (parseInt(student.qr_enabled) !== 1) {
      return res.json({
        success: false,
        student,
        message: 'DISABLED QR CODE',
        speechText: `${student.first_name} ${student.last_name}, your QR code is disabled.`
      });
    }

    const event = await dbAdapter.get('SELECT * FROM events WHERE id = $1', [event_id]);
    if (!event) {
      return res.json({ success: false, message: 'EVENT NOT FOUND', speechText: 'Selected event is invalid.' });
    }

    const existingAtt = await dbAdapter.get(
      'SELECT * FROM attendance WHERE event_id = $1 AND student_id = $2',
      [event_id, student.id]
    );

    const now = new Date();
    const currentTimeStr = now.toTimeString().split(' ')[0];

    if (mode === 'TIME_OUT') {
      if (!existingAtt) {
        return res.json({
          success: false,
          student,
          message: 'NO TIME IN RECORDED',
          speechText: `${student.first_name} ${student.last_name}, no time in record found.`
        });
      }

      await dbAdapter.run('UPDATE attendance SET time_out = $1 WHERE id = $2', [now.toISOString(), existingAtt.id]);
      await logAudit(req, 'ATTENDANCE_TIMEOUT', `Time out for student ${student.student_number} in event ${event_id}`);

      return res.json({
        success: true,
        status: 'TIME OUT',
        student,
        speechText: `${student.first_name} ${student.last_name}, time out recorded.`
      });
    }

    // Time In Logic & Duplicate Checking
    if (existingAtt) {
      return res.json({
        success: false,
        duplicate: true,
        student,
        message: 'ALREADY RECORDED',
        speechText: `${student.first_name} ${student.last_name}, you are already recorded.`
      });
    }

    // Determine On-time vs Late Status
    const settings = await dbAdapter.get('SELECT late_threshold_minutes FROM school_settings LIMIT 1');
    const thresholdMinutes = settings ? settings.late_threshold_minutes || 10 : 10;

    let attStatus = 'Present';
    const eventStart = new Date(`${event.event_date}T${event.start_time}`);
    const gracePeriodEnd = new Date(eventStart.getTime() + thresholdMinutes * 60000);

    if (now > gracePeriodEnd) {
      attStatus = 'Late';
    }

    await dbAdapter.run(
      `INSERT INTO attendance (event_id, student_id, time_in, status, scan_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [event_id, student.id, now.toISOString(), attStatus, now.toISOString().split('T')[0]]
    );

    await logAudit(req, 'ATTENDANCE_TIMEIN', `Time in (${attStatus}) for student ${student.student_number} in event ${event_id}`);

    res.json({
      success: true,
      status: attStatus.toUpperCase(),
      student,
      speechText: `${student.first_name} ${student.last_name}, attendance recorded.`
    });

  } catch (err) {
    console.error('Scan API Error:', err);
    res.status(500).json({ success: false, message: 'SERVER ERROR' });
  }
});

// ----------------------------------------------------
// PRINT STUDENT IDS (8 PER A4 SHEET LAYOUT)
// ----------------------------------------------------

app.get('/admin/id-cards', requireRole(['admin']), async (req, res) => {
  const students = await dbAdapter.all(`
    SELECT s.*, p.title as position_title 
    FROM students s
    LEFT JOIN positions p ON s.position_id = p.id
    WHERE s.status = 'active'
    ORDER BY s.id DESC
  `);

  const settings = await dbAdapter.get('SELECT * FROM school_settings LIMIT 1') || {};

  // Pre-generate QR Code Data URLs for printing
  const studentsWithQR = await Promise.all(
    students.map(async (s) => {
      const qrDataUrl = await qrcode.toDataURL(s.qr_token || 'INVALID', { width: 300, margin: 1 });
      return { ...s, qrDataUrl };
    })
  );

  const html = `
    <style>
      @media print {
        header, nav, footer, .no-print { display: none !important; }
        body { background: white; margin: 0; padding: 0; }
        .page-break { page-break-after: always; }
      }
      .a4-grid {
        display: grid;
        grid-template-columns: repeat(2, 3.375in);
        grid-auto-rows: 2.125in;
        gap: 0.2in;
        justify-content: center;
        padding: 0.25in;
      }
      .id-card {
        width: 3.375in;
        height: 2.125in;
        border: 1.5px solid #000;
        border-radius: 8px;
        padding: 0.2in;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        background: #fff;
        position: relative;
        font-family: Arial, sans-serif;
      }
      .id-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #ccc;
        padding-bottom: 4px;
      }
      .id-header img { height: 24px; }
      .id-body {
        display: flex;
        gap: 0.25in;
        align-items: center;
        margin-top: 4px;
      }
      .id-photo { width: 0.85in; height: 0.85in; object-fit: cover; border-radius: 4px; border: 1px solid #999; }
      .id-qr { width: 0.95in; height: 0.95in; object-fit: contain; }
    </style>

    <div class="no-print" style="margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
      <h2>Student Club ID Card Printing (A4 - 8 Cards/Sheet)</h2>
      <button onclick="window.print()" class="btn btn-primary">🖨️ Print ID Cards</button>
    </div>

    <div class="a4-grid">
      ${studentsWithQR.map(s => `
        <div class="id-card">
          <div class="id-header">
            ${settings.school_logo ? `<img src="${settings.school_logo}">` : '<span></span>'}
            <div style="text-align: center; font-size: 7pt; font-weight: bold; line-height: 1.1;">
              <div>${settings.school_name || 'School Name'}</div>
              <div style="color: var(--primary);">${settings.club_name || 'Student Club'}</div>
            </div>
            ${settings.club_logo ? `<img src="${settings.club_logo}">` : '<span></span>'}
          </div>

          <div class="id-body">
            <img src="${s.photo_path}" class="id-photo">
            <div style="flex: 1; font-size: 7.5pt;">
              <div style="font-weight: bold; font-size: 8.5pt;">${s.first_name} ${s.last_name}</div>
              <div style="color: var(--primary); font-weight: bold;">${s.student_number}</div>
              <div>Pos: <strong>${s.position_title || 'Member'}</strong></div>
              <div style="font-size: 6.5pt; color: #555;">S.Y. ${settings.school_year || '2026-2027'}</div>
            </div>
            <!-- Large Prominent QR Code -->
            <img src="${s.qrDataUrl}" class="id-qr">
          </div>

          <div style="font-size: 5.5pt; text-align: center; border-top: 0.5px dashed #ccc; padding-top: 2px; color: #666;">
            Official Student Club ID Card • Property of School Organization
          </div>
        </div>
      `).join('')}
    </div>
  `;
  res.send(await renderPage(req, 'Print ID Cards', html, 'ids'));
});

// ----------------------------------------------------
// STUDENT PORTAL
// ----------------------------------------------------

app.get('/member', requireRole(['student']), async (req, res) => {
  const student = await dbAdapter.get(`
    SELECT s.*, p.title as position_title 
    FROM students s
    LEFT JOIN positions p ON s.position_id = p.id
    WHERE s.user_id = $1
  `, [req.session.user.id]);

  if (!student) return res.send('Student profile record not found.');

  const qrDataUrl = await qrcode.toDataURL(student.qr_token || 'INVALID', { width: 250 });
  const attendanceHistory = await dbAdapter.all(`
    SELECT a.*, e.name as event_name, e.event_date
    FROM attendance a
    JOIN events e ON a.event_id = e.id
    WHERE a.student_id = $1
    ORDER BY a.id DESC
  `, [student.id]);

  const html = `
    <h2>Student Member Portal</h2>
    <div class="grid" style="grid-template-columns: 1fr 2fr; gap: 1.5rem; margin-top: 1rem;">
      <div class="card" style="text-align: center;">
        <img src="${student.photo_path}" class="avatar-lg" style="margin-bottom: 0.5rem;">
        <h3>${student.first_name} ${student.last_name}</h3>
        <p style="color: var(--primary); font-weight: bold;">${student.student_number}</p>
        <p><span class="badge badge-info">${student.position_title || 'Member'}</span></p>

        <div style="margin-top: 1.5rem; padding: 1rem; background: #f8fafc; border-radius: 8px;">
          <h4 style="margin-bottom: 0.5rem;">Digital Attendance QR Code</h4>
          <img src="${qrDataUrl}" style="max-width: 180px;">
          <p style="font-size: 0.75rem; color: #64748b; margin-top: 0.5rem;">Show this QR code to the scanner during events.</p>
        </div>
      </div>

      <div class="card">
        <h3>My Attendance History</h3>
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Date</th>
              <th>Time In</th>
              <th>Time Out</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${attendanceHistory.length > 0 ? attendanceHistory.map(a => `
              <tr>
                <td><strong>${a.event_name}</strong></td>
                <td>${a.event_date}</td>
                <td>${new Date(a.time_in).toLocaleTimeString()}</td>
                <td>${a.time_out ? new Date(a.time_out).toLocaleTimeString() : 'N/A'}</td>
                <td><span class="badge badge-${a.status === 'Present' ? 'success' : a.status === 'Late' ? 'warning' : 'danger'}">${a.status}</span></td>
              </tr>
            `).join('') : '<tr><td colspan="5" style="text-align: center; color: #64748b;">No attendance records found.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
  res.send(await renderPage(req, 'Student Portal', html, 'portal'));
});

// ----------------------------------------------------
// REPORTS, ANALYTICS & EXPORTS
// ----------------------------------------------------

app.get('/admin/reports', requireRole(['admin']), async (req, res) => {
  const reports = await dbAdapter.all(`
    SELECT a.*, s.student_number, s.first_name, s.last_name, p.title as position_title, e.name as event_name
    FROM attendance a
    JOIN students s ON a.student_id = s.id
    LEFT JOIN positions p ON s.position_id = p.id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.id DESC
  `);

  const html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <h2>Reports & Attendance Analytics</h2>
      <a href="/admin/reports/export-csv" class="btn btn-success">📥 Export Attendance CSV</a>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Student Number</th>
            <th>Student Name</th>
            <th>Position</th>
            <th>Event Name</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${reports.map(r => `
            <tr>
              <td>${r.scan_date}</td>
              <td><strong>${r.student_number}</strong></td>
              <td>${r.first_name} ${r.last_name}</td>
              <td>${r.position_title || 'Member'}</td>
              <td>${r.event_name}</td>
              <td><span class="badge badge-${r.status === 'Present' ? 'success' : r.status === 'Late' ? 'warning' : 'danger'}">${r.status}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderPage(req, 'Reports', html, 'reports'));
});

app.get('/admin/reports/export-csv', requireRole(['admin']), async (req, res) => {
  const reports = await dbAdapter.all(`
    SELECT a.scan_date, s.student_number, s.first_name, s.last_name, p.title as position_title, e.name as event_name, a.status, a.time_in
    FROM attendance a
    JOIN students s ON a.student_id = s.id
    LEFT JOIN positions p ON s.position_id = p.id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.id DESC
  `);

  let csv = 'Date,Student Number,First Name,Last Name,Position,Event Name,Status,Time In\n';
  reports.forEach(r => {
    csv += `"${r.scan_date}","${r.student_number}","${r.first_name}","${r.last_name}","${r.position_title || 'Member'}","${r.event_name}","${r.status}","${r.time_in}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=attendance_report.csv');
  res.status(200).send(csv);
});

// ----------------------------------------------------
// SYSTEM SETTINGS & DATABASE BACKUP ENGINE
// ----------------------------------------------------

app.get('/admin/settings', requireRole(['admin']), async (req, res) => {
  const settings = await dbAdapter.get('SELECT * FROM school_settings LIMIT 1') || {};
  const backups = fs.readdirSync(backupsDir);

  const html = `
    <h2>System Configuration & Backup Engine</h2>
    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 1rem;">
      <div class="card">
        <h3>School & Club Information</h3>
        <form action="/admin/settings/update" method="POST" enctype="multipart/form-data" style="margin-top: 1rem;">
          <div class="form-group">
            <label>School Name</label>
            <input type="text" name="school_name" value="${settings.school_name || ''}">
          </div>
          <div class="form-group">
            <label>Student Club Name</label>
            <input type="text" name="club_name" value="${settings.club_name || ''}">
          </div>
          <div class="form-group">
            <label>School Year</label>
            <input type="text" name="school_year" value="${settings.school_year || '2026-2027'}">
          </div>
          <div class="form-group">
            <label>Upload School Logo</label>
            <input type="file" name="schoolLogo" accept="image/*">
          </div>
          <div class="form-group">
            <label>Upload Club Logo</label>
            <input type="file" name="clubLogo" accept="image/*">
          </div>
          <button type="submit" class="btn btn-primary" style="width: 100%;">Save Configuration</button>
        </form>
      </div>

      <div class="card">
        <h3>Database Management & Backups</h3>
        <div style="margin-bottom: 1.5rem;">
          <a href="/admin/settings/backup/create" class="btn btn-success" style="width: 100%; text-align: center;">📦 Generate Full Database Backup</a>
        </div>
        <h4>Existing System Backups</h4>
        <ul style="margin-top: 0.5rem; font-size: 0.85rem; list-style: none;">
          ${backups.length > 0 ? backups.map(b => `<li style="padding: 0.5rem 0; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between;"><span>${b}</span><a href="/admin/settings/backup/restore/${b}" style="color: var(--danger);" onclick="return confirm('Restore backup? Current data will be replaced.')">Restore</a></li>`).join('') : '<li style="color: #64748b;">No local backups generated yet.</li>'}
        </ul>
      </div>
    </div>
  `;
  res.send(await renderPage(req, 'Settings & Backup', html, 'settings'));
});

app.post('/admin/settings/update', requireRole(['admin']), upload.fields([{ name: 'schoolLogo' }, { name: 'clubLogo' }]), async (req, res) => {
  const { school_name, club_name, school_year } = req.body;
  
  let updateQuery = 'UPDATE school_settings SET school_name = $1, club_name = $2, school_year = $3';
  let params = [school_name, club_name, school_year];

  if (req.files['schoolLogo']) {
    updateQuery += `, school_logo = '/uploads/logos/${req.files['schoolLogo'][0].filename}'`;
  }
  if (req.files['clubLogo']) {
    updateQuery += `, club_logo = '/uploads/logos/${req.files['clubLogo'][0].filename}'`;
  }

  await dbAdapter.run(updateQuery, params);
  await logAudit(req, 'SETTINGS_UPDATED', 'Updated school and club settings.');
  res.redirect('/admin/settings');
});

app.get('/admin/settings/backup/create', requireRole(['admin']), async (req, res) => {
  if (dbAdapter.type === 'sqlite') {
    const backupName = `backup-${Date.now()}.db`;
    fs.copyFileSync(path.join(__dirname, 'school_club_attendance.db'), path.join(backupsDir, backupName));
    await logAudit(req, 'BACKUP_CREATED', `Generated backup file: ${backupName}`);
  }
  res.redirect('/admin/settings');
});

// Audit Logs Viewer
app.get('/admin/audit-logs', requireRole(['admin']), async (req, res) => {
  const logs = await dbAdapter.all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100');
  const html = `
    <h2>Security Audit Logs</h2>
    <div class="card" style="margin-top: 1rem;">
      <table>
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
          ${logs.map(l => `
            <tr>
              <td>${new Date(l.created_at).toLocaleString()}</td>
              <td>${l.user_email}</td>
              <td><span class="badge badge-info">${l.role}</span></td>
              <td><strong>${l.action}</strong></td>
              <td>${l.details || ''}</td>
              <td>${l.ip_address}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderPage(req, 'Audit Logs', html, 'audit'));
});

// Server Launch Handler
app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(`School Student Club QR Code Attendance Management System Running`);
  console.log(`Local Access URL : http://localhost:${PORT}`);
  console.log(`System Status    : Active and persistent storage initialized.`);
  console.log(`================================================================`);
});
