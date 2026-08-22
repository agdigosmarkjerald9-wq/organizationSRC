/**
 * ClubTrack QR Attendance System
 * Complete Organization & Club Management System for High School (PostgreSQL Backend)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/club_attendance',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'clubtrack_secure_random_session_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize Database Tables and Default Records
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL, -- 'admin', 'scanner', 'member'
        reference_id INT,
        must_change_password BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name VARCHAR(255) DEFAULT 'ABC High School',
        org_name VARCHAR(255) DEFAULT 'Supreme Student Council',
        school_year VARCHAR(50) DEFAULT '2026–2027',
        org_description VARCHAR(500) DEFAULT 'Official student leadership organization.',
        id_prefix VARCHAR(50) DEFAULT 'SSC',
        theme_color VARCHAR(50) DEFAULT '#4f46e5'
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(100) UNIQUE NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        middle_name VARCHAR(100),
        last_name VARCHAR(100) NOT NULL,
        gender VARCHAR(20),
        grade_level VARCHAR(50) NOT NULL,
        section VARCHAR(50) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        contact VARCHAR(50),
        email VARCHAR(150),
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME,
        late_cutoff TIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INT REFERENCES members(id) ON DELETE CASCADE,
        event_id INT REFERENCES events(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL,
        time_in TIME,
        time_out TIME,
        status VARCHAR(50) DEFAULT 'Present', -- Present, Late, Absent, Completed, Missing Time Out
        scan_method VARCHAR(50) DEFAULT 'QR', -- QR, MANUAL
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        expires_at DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        actor VARCHAR(150),
        role VARCHAR(50),
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        scanner_user VARCHAR(150),
        event_id INT,
        scan_type VARCHAR(20),
        qr_value TEXT,
        result_status VARCHAR(50),
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed default settings if empty
    const settingsCheck = await client.query('SELECT COUNT(*) FROM organization_settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_description, id_prefix, theme_color)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official student leadership organization.', 'SSC', '#4f46e5')
      `);
    }

    // Seed default Admin if empty
    const adminCheck = await client.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
    if (parseInt(adminCheck.rows[0].count) === 0) {
      const hashedPass = await bcrypt.hash('admin123', 10);
      await client.query(`
        INSERT INTO users (username, password, role, must_change_password)
        VALUES ('admin', $1, 'admin', false)
      `, [hashedPass]);
    }
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

initializeDatabase();

// Audit Logger Helper
async function logAudit(actor, role, action, details) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (actor, role, action, details) VALUES ($1, $2, $3, $4)',
      [actor, role, action, details]
    );
  } catch (err) {
    console.error('Audit logging failed:', err);
  }
}

// Authentication & Role Middleware
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    if (req.session.user.mustChangePassword && req.path !== '/change-password' && req.path !== '/api/change-password') {
      return res.redirect('/change-password');
    }
    return next();
  }
  res.redirect('/login');
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === role) {
      if (req.session.user.mustChangePassword && req.path !== '/change-password' && req.path !== '/api/change-password') {
        return res.redirect('/change-password');
      }
      return next();
    }
    res.status(403).send('Access Denied: Unauthorized role access.');
  };
}

// --- VIEWS & FRONTEND HTML GENERATOR ---
function renderLayout(title, content, user, settings) {
  const accent = settings ? settings.theme_color : '#4f46e5';
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | ClubTrack QR System</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/html5-qrcode"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
      :root { --theme-color: ${accent}; }
      .bg-theme { background-color: var(--theme-color); }
      .text-theme { color: var(--theme-color); }
      .border-theme { border-color: var(--theme-color); }
    </style>
  </head>
  <body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col font-sans">
    <header class="bg-slate-900 text-white shadow-md">
      <div class="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
        <div class="flex items-center space-x-3">
          <div class="bg-theme p-2 rounded-lg text-white font-bold"><i class="fa-solid fa-qrcode text-xl"></i></div>
          <div>
            <h1 class="font-bold text-lg leading-tight">${settings ? settings.org_name : 'ClubTrack'}</h1>
            <p class="text-xs text-slate-400">${settings ? settings.school_name : ''} (${settings ? settings.school_year : ''})</p>
          </div>
        </div>
        ${user ? `
          <div class="flex items-center space-x-4">
            <span class="text-sm bg-slate-800 px-3 py-1 rounded-full border border-slate-700">
              <i class="fa-solid fa-user-shield text-theme mr-1"></i> ${user.username} (${user.role.toUpperCase()})
            </span>
            <a href="/logout" class="bg-rose-600 hover:bg-rose-700 text-white px-3 py-1.5 rounded-lg text-sm transition">
              <i class="fa-solid fa-right-from-bracket mr-1"></i> Logout
            </a>
          </div>
        ` : ''}
      </div>
    </header>
    <main class="flex-grow max-w-7xl w-full mx-auto p-4 sm:p-6">
      ${content}
    </main>
    <footer class="bg-slate-900 text-slate-400 text-center py-4 text-xs">
      ClubTrack QR Attendance & Organization Management System &bull; High School Edition
    </footer>
  </body>
  </html>`;
}

// --- API & PAGE ROUTES ---

// Login Page
app.get('/login', async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];
  
  if (req.session && req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    if (req.session.user.role === 'scanner') return res.redirect('/scanner');
    if (req.session.user.role === 'member') return res.redirect('/member');
  }

  const html = `
    <div class="max-w-md mx-auto mt-12 bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-200">
      <div class="bg-theme p-6 text-white text-center">
        <h2 class="text-2xl font-black">${settings.org_name}</h2>
        <p class="text-sm opacity-90 mt-1">${settings.school_name}</p>
        <p class="text-xs uppercase tracking-wider mt-2 bg-black/20 py-1 rounded">QR Attendance System</p>
      </div>
      <form action="/login" method="POST" class="p-6 space-y-4">
        <div>
          <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Username</label>
          <input type="text" name="username" required class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
        </div>
        <div>
          <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Password</label>
          <input type="password" name="password" required class="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
        </div>
        <button type="submit" class="w-full bg-theme text-white py-2.5 rounded-lg font-bold hover:opacity-90 transition">
          Sign In to Portal
        </button>
      </form>
    </div>
  `;
  res.send(renderLayout('Login', html, null, settings));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) return res.send(renderLayout('Login', '<div class="p-4 bg-rose-100 text-rose-700 rounded text-center">Invalid username or password. <a href="/login">Back</a></div>', null));
    
    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.send(renderLayout('Login', '<div class="p-4 bg-rose-100 text-rose-700 rounded text-center">Invalid username or password. <a href="/login">Back</a></div>', null));

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      referenceId: user.reference_id,
      mustChangePassword: user.must_change_password
    };

    await logAudit(user.username, user.role, 'LOGIN', 'User logged into the system.');

    if (user.must_change_password) return res.redirect('/change-password');
    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error during login.');
  }
});

// Force Password Change View
app.get('/change-password', isAuthenticated, async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const html = `
    <div class="max-w-md mx-auto mt-12 bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-200 p-6">
      <div class="bg-amber-50 border-l-4 border-amber-500 p-4 mb-4">
        <h3 class="font-bold text-amber-800">Security Reminder</h3>
        <p class="text-xs text-amber-700 mt-1">You are using a temporary password. You must create a secure private password before accessing your portal.</p>
      </div>
      <form action="/change-password" method="POST" class="space-y-4">
        <div>
          <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Current Password / Temporary Password</label>
          <input type="password" name="current_password" required class="w-full px-4 py-2 border rounded-lg">
        </div>
        <div>
          <label class="block text-xs font-bold uppercase text-slate-600 mb-1">New Password (Min 8 Characters)</label>
          <input type="password" name="new_password" minlength="8" required class="w-full px-4 py-2 border rounded-lg">
        </div>
        <div>
          <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Confirm New Password</label>
          <input type="password" name="confirm_password" minlength="8" required class="w-full px-4 py-2 border rounded-lg">
        </div>
        <button type="submit" class="w-full bg-theme text-white py-2 rounded-lg font-bold">Update Password & Secure Account</button>
      </form>
    </div>
  `;
  res.send(renderLayout('Change Password', html, req.session.user, settingsRes.rows[0]));
});

app.post('/change-password', isAuthenticated, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (new_password !== confirm_password || new_password.length < 8) {
    return res.send('<script>alert("Passwords must match and be at least 8 characters."); window.history.back();</script>');
  }
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows[0];
    const match = await bcrypt.compare(current_password, user.password);
    if (!match) return res.send('<script>alert("Current password is incorrect."); window.history.back();</script>');

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = false WHERE id = $2', [hashed, user.id]);
    req.session.user.mustChangePassword = false;

    await logAudit(user.username, user.role, 'PASSWORD_CHANGE', 'User updated their password successfully.');
    res.redirect(user.role === 'admin' ? '/admin' : user.role === 'scanner' ? '/scanner' : '/member');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating password.');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// --- ADMIN PORTAL ---
app.get('/admin', isAuthenticated, requireRole('admin'), async (req, res) => {
  const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
  const statsMembers = (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count;
  const statsActive = (await pool.query("SELECT COUNT(*) FROM members WHERE status='active'")).rows[0].count;
  const today = new Date().toISOString().split('T')[0];
  const statsPresentToday = (await pool.query('SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date = $1', [today])).rows[0].count;
  const statsInvalid = (await pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result_status = 'INVALID'")).rows[0].count;

  const membersList = (await pool.query('SELECT * FROM members ORDER BY last_name ASC')).rows[0] ? (await pool.query('SELECT * FROM members ORDER BY last_name ASC')).rows : [];
  const eventsList = (await pool.query('SELECT * FROM events ORDER BY event_date DESC')).rows;
  const announcementsList = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC')).rows;
  const liveAttendance = (await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.grade_level, m.section, e.event_name 
    FROM attendance a 
    JOIN members m ON a.member_id = m.id 
    JOIN events e ON a.event_id = e.id 
    ORDER BY a.created_at DESC LIMIT 15
  `)).rows;

  const content = `
    <div class="space-y-6">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div>
          <h2 class="text-2xl font-black text-slate-900">Admin Command Center</h2>
          <p class="text-sm text-slate-500">Manage organization settings, members, live events, and attendance reports.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button onclick="openModal('addMemberModal')" class="bg-theme text-white px-4 py-2 rounded-xl text-sm font-bold shadow hover:opacity-90"><i class="fa-solid fa-user-plus mr-1"></i> Add Member</button>
          <button onclick="openModal('addEventModal')" class="bg-slate-800 text-white px-4 py-2 rounded-xl text-sm font-bold shadow hover:bg-slate-700"><i class="fa-solid fa-calendar-plus mr-1"></i> New Event</button>
          <button onclick="openModal('announcementModal')" class="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-bold shadow hover:bg-emerald-700"><i class="fa-solid fa-bullhorn mr-1"></i> Announcement</button>
        </div>
      </div>

      <!-- Stats Grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <p class="text-xs font-bold uppercase text-slate-400">Total Members</p>
          <h3 class="text-3xl font-black text-slate-900 mt-1">${statsMembers}</h3>
        </div>
        <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <p class="text-xs font-bold uppercase text-slate-400">Active Status</p>
          <h3 class="text-3xl font-black text-emerald-600 mt-1">${statsActive}</h3>
        </div>
        <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <p class="text-xs font-bold uppercase text-slate-400">Present Today</p>
          <h3 class="text-3xl font-black text-indigo-600 mt-1">${statsPresentToday}</h3>
        </div>
        <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <p class="text-xs font-bold uppercase text-slate-400">Invalid Scan Attempts</p>
          <h3 class="text-3xl font-black text-rose-600 mt-1">${statsInvalid}</h3>
        </div>
      </div>

      <!-- Tabs Navigation -->
      <div class="flex border-b border-slate-200 space-x-6 overflow-x-auto text-sm font-bold">
        <button onclick="switchTab('members')" id="tab-btn-members" class="py-3 border-b-2 border-theme text-theme pb-3 whitespace-nowrap">Members Directory</button>
        <button onclick="switchTab('attendance')" id="tab-btn-attendance" class="py-3 border-b-2 border-transparent text-slate-500 hover:text-slate-900 whitespace-nowrap">Live Attendance Monitor</button>
        <button onclick="switchTab('events')" id="tab-btn-events" class="py-3 border-b-2 border-transparent text-slate-500 hover:text-slate-900 whitespace-nowrap">Events & Cutoffs</button>
        <button onclick="switchTab('settings')" id="tab-btn-settings" class="py-3 border-b-2 border-transparent text-slate-500 hover:text-slate-900 whitespace-nowrap">Organization Settings</button>
      </div>

      <!-- TAB 1: MEMBERS -->
      <div id="tab-members" class="space-y-4">
        <div class="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex justify-between items-center">
          <input type="text" id="memberSearch" placeholder="Search member name or ID..." onkeyup="filterMembers()" class="px-4 py-2 border rounded-xl w-full max-w-sm text-sm">
        </div>
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-100 text-xs uppercase font-bold text-slate-600 border-b">
                <th class="p-4">Member ID</th>
                <th class="p-4">Full Name</th>
                <th class="p-4">Grade & Section</th>
                <th class="p-4">Position</th>
                <th class="p-4">Username</th>
                <th class="p-4">Status</th>
                <th class="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody id="membersTableBody" class="divide-y text-sm">
              ${membersList.map(m => `
                <tr class="hover:bg-slate-50">
                  <td class="p-4 font-mono font-bold text-xs">${m.member_id}</td>
                  <td class="p-4 font-semibold">${m.last_name}, ${m.first_name}</td>
                  <td class="p-4">${m.grade_level} - ${m.section}</td>
                  <td class="p-4"><span class="bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-md text-xs font-bold">${m.position}</span></td>
                  <td class="p-4 font-mono text-xs text-slate-600">${m.first_name.toLowerCase().replace(/\\s+/g,'')}</td>
                  <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-bold ${m.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${m.status}</span></td>
                  <td class="p-4 text-right space-x-2">
                    <button onclick="viewIDCard('${m.member_id}')" class="text-indigo-600 hover:text-indigo-900 font-bold text-xs"><i class="fa-solid fa-id-card"></i> ID</button>
                    <button onclick="resetPassword(${m.id})" class="text-amber-600 hover:text-amber-900 font-bold text-xs"><i class="fa-solid fa-key"></i> Reset</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- TAB 2: LIVE ATTENDANCE -->
      <div id="tab-attendance" class="hidden space-y-4">
        <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-100 text-xs uppercase font-bold text-slate-600 border-b">
                <th class="p-4">Time</th>
                <th class="p-4">Member</th>
                <th class="p-4">Event</th>
                <th class="p-4">Grade & Section</th>
                <th class="p-4">Status</th>
                <th class="p-4">Method</th>
              </tr>
            </thead>
            <tbody class="divide-y text-sm">
              ${liveAttendance.map(a => `
                <tr>
                  <td class="p-4 text-xs font-mono">${a.time_in || a.time_out || 'N/A'}</td>
                  <td class="p-4 font-bold">${a.last_name}, ${a.first_name}</td>
                  <td class="p-4">${a.event_name}</td>
                  <td class="p-4">${a.grade_level} - ${a.section}</td>
                  <td class="p-4"><span class="px-2 py-1 rounded text-xs font-bold ${a.status === 'Present' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${a.status}</span></td>
                  <td class="p-4"><span class="bg-slate-100 px-2 py-1 rounded text-xs font-mono">${a.scan_method}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- TAB 3: EVENTS -->
      <div id="tab-events" class="hidden space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          ${eventsList.map(e => `
            <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex flex-col justify-between">
              <div>
                <span class="text-xs bg-indigo-50 text-indigo-700 px-2 py-1 rounded font-bold">${e.event_date}</span>
                <h3 class="text-lg font-black mt-2 text-slate-900">${e.event_name}</h3>
                <p class="text-xs text-slate-500 mt-1">${e.description || 'No description provided.'}</p>
                <div class="mt-4 text-xs space-y-1 text-slate-600">
                  <p><i class="fa-solid fa-clock mr-1"></i> Start: ${e.start_time}</p>
                  <p><i class="fa-solid fa-triangle-exclamation text-amber-600 mr-1"></i> Late Cutoff: ${e.late_cutoff}</p>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- TAB 4: SETTINGS -->
      <div id="tab-settings" class="hidden bg-white p-6 rounded-2xl shadow-sm border border-slate-200 max-w-2xl">
        <h3 class="text-lg font-black mb-4">Organization & System Configuration</h3>
        <form action="/admin/settings" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-bold uppercase text-slate-600 mb-1">School Name</label>
            <input type="text" name="school_name" value="${settings.school_name}" required class="w-full px-4 py-2 border rounded-xl">
          </div>
          <div>
            <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Organization Name</label>
            <input type="text" name="org_name" value="${settings.org_name}" required class="w-full px-4 py-2 border rounded-xl">
          </div>
          <div>
            <label class="block text-xs font-bold uppercase text-slate-600 mb-1">School Year</label>
            <input type="text" name="school_year" value="${settings.school_year}" required class="w-full px-4 py-2 border rounded-xl">
          </div>
          <div>
            <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Member ID Prefix</label>
            <input type="text" name="id_prefix" value="${settings.id_prefix}" required class="w-full px-4 py-2 border rounded-xl">
          </div>
          <div>
            <label class="block text-xs font-bold uppercase text-slate-600 mb-1">Theme Accent Color</label>
            <input type="color" name="theme_color" value="${settings.theme_color}" class="w-full h-10 border rounded-xl p-1 cursor-pointer">
          </div>
          <button type="submit" class="bg-theme text-white px-6 py-2.5 rounded-xl font-bold shadow hover:opacity-90">Save Configuration</button>
        </form>
      </div>

    </div>

    <!-- ADD MEMBER MODAL -->
    <div id="addMemberModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
      <div class="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
        <div class="flex justify-between items-center mb-4">
          <h3 class="text-lg font-black">Register New Member</h3>
          <button onclick="closeModal('addMemberModal')" class="text-slate-400 hover:text-slate-700"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <form action="/admin/members/add" method="POST" class="space-y-3">
          <div class="grid grid-cols-2 gap-2">
            <input type="text" name="first_name" placeholder="First Name *" required class="px-3 py-2 border rounded-xl text-sm">
            <input type="text" name="last_name" placeholder="Last Name *" required class="px-3 py-2 border rounded-xl text-sm">
          </div>
          <div class="grid grid-cols-2 gap-2">
            <input type="text" name="grade_level" placeholder="Grade Level (e.g. Grade 10) *" required class="px-3 py-2 border rounded-xl text-sm">
            <input type="text" name="section" placeholder="Section (e.g. Rizal) *" required class="px-3 py-2 border rounded-xl text-sm">
          </div>
          <input type="text" name="position" placeholder="Position (e.g. Member / Officer)" value="Member" class="w-full px-3 py-2 border rounded-xl text-sm">
          <input type="text" name="contact" placeholder="Contact Number" class="w-full px-3 py-2 border rounded-xl text-sm">
          <input type="email" name="email" placeholder="Email Address (Optional)" class="w-full px-3 py-2 border rounded-xl text-sm">
          <button type="submit" class="w-full bg-theme text-white py-2.5 rounded-xl font-bold text-sm mt-4 shadow">Complete Registration & Generate Credentials</button>
        </form>
      </div>
    </div>

    <!-- ADD EVENT MODAL -->
    <div id="addEventModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
      <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
        <div class="flex justify-between items-center mb-4">
          <h3 class="text-lg font-black">Create Attendance Event</h3>
          <button onclick="closeModal('addEventModal')" class="text-slate-400 hover:text-slate-700"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <form action="/admin/events/add" method="POST" class="space-y-3">
          <input type="text" name="event_name" placeholder="Event Name *" required class="w-full px-3 py-2 border rounded-xl text-sm">
          <textarea name="description" placeholder="Description" class="w-full px-3 py-2 border rounded-xl text-sm"></textarea>
          <input type="date" name="event_date" required class="w-full px-3 py-2 border rounded-xl text-sm">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs font-bold text-slate-500">Start Time</label>
              <input type="time" name="start_time" required class="w-full px-3 py-2 border rounded-xl text-sm">
            </div>
            <div>
              <label class="text-xs font-bold text-slate-500">Late Cutoff Time</label>
              <input type="time" name="late_cutoff" required class="w-full px-3 py-2 border rounded-xl text-sm">
            </div>
          </div>
          <button type="submit" class="w-full bg-theme text-white py-2.5 rounded-xl font-bold text-sm mt-4">Save Event</button>
        </form>
      </div>
    </div>

    <!-- ANNOUNCEMENT MODAL -->
    <div id="announcementModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
      <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
        <div class="flex justify-between items-center mb-4">
          <h3 class="text-lg font-black">Post Announcement</h3>
          <button onclick="closeModal('announcementModal')" class="text-slate-400 hover:text-slate-700"><i class="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <form action="/admin/announcements/add" method="POST" class="space-y-3">
          <input type="text" name="title" placeholder="Announcement Title *" required class="w-full px-3 py-2 border rounded-xl text-sm">
          <textarea name="message" placeholder="Message content *" required class="w-full px-3 py-2 border rounded-xl text-sm h-28"></textarea>
          <button type="submit" class="w-full bg-emerald-600 text-white py-2.5 rounded-xl font-bold text-sm mt-4">Publish Announcement</button>
        </form>
      </div>
    </div>

    <script>
      function switchTab(tab) {
        ['members', 'attendance', 'events', 'settings'].forEach(t => {
          document.getElementById('tab-' + t).classList.add('hidden');
          document.getElementById('tab-btn-' + t).classList.remove('border-theme', 'text-theme');
          document.getElementById('tab-btn-' + t).classList.add('border-transparent', 'text-slate-500');
        });
        document.getElementById('tab-' + tab).classList.remove('hidden');
        document.getElementById('tab-btn-' + tab).classList.add('border-theme', 'text-theme');
        document.getElementById('tab-btn-' + tab).classList.remove('border-transparent', 'text-slate-500');
      }
      function openModal(id) { document.getElementById(id).classList.remove('hidden'); document.getElementById(id).classList.add('flex'); }
      function closeModal(id) { document.getElementById(id).classList.add('hidden'); document.getElementById(id).classList.remove('flex'); }
      function filterMembers() {
        let q = document.getElementById('memberSearch').value.toLowerCase();
        let rows = document.querySelectorAll('#membersTableBody tr');
        rows.forEach(r => {
          r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none';
        });
      }
      function viewIDCard(memberId) {
        window.open('/member/id-card/' + memberId, '_blank');
      }
      async function resetPassword(id) {
        if(confirm('Are you sure you want to reset this member password? A new temporary password will be generated.')) {
          let res = await fetch('/admin/members/reset-password/' + id, { method: 'POST' });
          let data = await res.json();
          if(data.success) {
            alert('Password reset successfully! New Temporary Password: ' + data.tempPassword);
          } else {
            alert('Failed to reset password.');
          }
        }
      }
    </script>
  `;
  res.send(renderLayout('Admin Dashboard', content, req.session.user, settings));
});

// Admin Actions
app.post('/admin/settings', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { school_name, org_name, school_year, id_prefix, theme_color } = req.body;
  await pool.query(
    'UPDATE organization_settings SET school_name = $1, org_name = $2, school_year = $3, id_prefix = $4, theme_color = $5',
    [school_name, org_name, school_year, id_prefix, theme_color]
  );
  await logAudit(req.session.user.username, 'admin', 'SETTINGS_UPDATE', 'Updated organization settings.');
  res.redirect('/admin');
});

app.post('/admin/members/add', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { first_name, last_name, grade_level, section, position, contact, email } = req.body;
  const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
  
  const countRes = await pool.query('SELECT COUNT(*) FROM members');
  const seq = parseInt(countRes.rows[0].count) + 1;
  const memberId = `${settings.id_prefix}-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
  
  let baseUsername = (first_name + last_name).toLowerCase().replace(/\\s+/g, '');
  let username = baseUsername;
  let userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (userCheck.rows.length > 0) username += seq;

  const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
  const hashedPass = await bcrypt.hash(tempPassword, 10);
  const qrToken = `CLUBTRACK:MEMBER:${crypto.randomUUID()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const memberRes = await client.query(
      `INSERT INTO members (member_id, first_name, last_name, grade_level, section, position, contact, email, qr_token) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [memberId, first_name, last_name, grade_level, section, position || 'Member', contact, email, qrToken]
    );
    const memberPk = memberRes.rows[0].id;

    await client.query(
      `INSERT INTO users (username, password, role, reference_id, must_change_password) VALUES ($1, $2, 'member', $3, true)`,
      [username, hashedPass, memberPk]
    );
    await client.query('COMMIT');

    await logAudit(req.session.user.username, 'admin', 'MEMBER_REGISTER', `Registered member ${memberId} - ${first_name} ${last_name}`);

    // Credentials Result Screen
    const credentialsHtml = `
      <div class="max-w-lg mx-auto mt-10 bg-white rounded-2xl shadow-xl p-8 border border-slate-200 text-center space-y-4">
        <div class="bg-emerald-100 text-emerald-800 p-3 rounded-full w-14 h-14 flex items-center justify-center mx-auto">
          <i class="fa-solid fa-check text-2xl"></i>
        </div>
        <h2 class="text-2xl font-black">Member Successfully Registered</h2>
        <div class="bg-slate-50 p-4 rounded-xl text-left space-y-2 border">
          <p><strong>Full Name:</strong> ${first_name} ${last_name}</p>
          <p><strong>Member ID:</strong> <span class="font-mono">${memberId}</span></p>
          <p><strong>Username:</strong> <span class="font-mono text-indigo-600">${username}</span></p>
          <p><strong>Temporary Password:</strong> <span class="font-mono bg-amber-100 px-2 py-0.5 rounded font-bold text-amber-900">${tempPassword}</span></p>
        </div>
        <p class="text-xs text-rose-600 font-bold">IMPORTANT: Copy these credentials securely. The temporary password will not be shown again.</p>
        <div class="pt-2 flex gap-3">
          <a href="/admin" class="flex-1 bg-theme text-white py-2.5 rounded-xl font-bold block">Back to Dashboard</a>
          <a href="/member/id-card/${memberId}" target="_blank" class="flex-1 bg-slate-800 text-white py-2.5 rounded-xl font-bold block">View Digital ID</a>
        </div>
      </div>
    `;
    res.send(renderLayout('Registration Success', credentialsHtml, req.session.user, settings));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Registration failed.');
  } finally {
    client.release();
  }
});

app.post('/admin/events/add', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { event_name, description, event_date, start_time, late_cutoff } = req.body;
  await pool.query(
    'INSERT INTO events (event_name, description, event_date, start_time, late_cutoff) VALUES ($1, $2, $3, $4, $5)',
    [event_name, description, event_date, start_time, late_cutoff]
  );
  await logAudit(req.session.user.username, 'admin', 'EVENT_CREATE', `Created event: ${event_name}`);
  res.redirect('/admin');
});

app.post('/admin/announcements/add', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { title, message } = req.body;
  await pool.query('INSERT INTO announcements (title, message) VALUES ($1, $2)', [title, message]);
  await logAudit(req.session.user.username, 'admin', 'ANNOUNCEMENT_CREATE', `Published announcement: ${title}`);
  res.redirect('/admin');
});

app.post('/admin/members/reset-password/:id', isAuthenticated, requireRole('admin'), async (req, res) => {
  const memberPk = req.params.id;
  const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
  const hashed = await bcrypt.hash(tempPassword, 10);
  await pool.query('UPDATE users SET password = $1, must_change_password = true WHERE reference_id = $2 AND role = \'member\'', [hashed, memberPk]);
  await logAudit(req.session.user.username, 'admin', 'PASSWORD_RESET', `Reset password for member internal ID ${memberPk}`);
  res.json({ success: true, tempPassword });
});


// --- SCANNER PORTAL ---
app.get('/scanner', isAuthenticated, requireRole('scanner'), async (req, res) => {
  const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
  const events = (await pool.query('SELECT * FROM events ORDER BY event_date DESC')).rows;

  const content = `
    <div class="max-w-2xl mx-auto space-y-6">
      <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 text-center space-y-4">
        <h2 class="text-2xl font-black">Attendance Scanner Terminal</h2>
        <p class="text-xs text-slate-500">Select active event, scan mode, and activate camera to record attendance.</p>
        
        <!-- STEP 1: SELECT EVENT -->
        <div class="text-left">
          <label class="block text-xs font-bold uppercase text-slate-600 mb-1">1. Select Attendance Event</label>
          <select id="scanEvent" class="w-full px-4 py-3 border-2 rounded-xl font-bold text-slate-800 bg-slate-50">
            ${events.map(e => `<option value="${e.id}">${e.event_name} (${e.event_date})</option>`).join('')}
          </select>
        </div>

        <!-- STEP 2: SELECT SCAN TYPE -->
        <div class="text-left">
          <label class="block text-xs font-bold uppercase text-slate-600 mb-1">2. Select Scan Mode</label>
          <div class="grid grid-cols-2 gap-3">
            <button onclick="setScanType('IN')" id="btnScanIn" class="py-4 rounded-xl font-black border-2 border-indigo-600 bg-indigo-600 text-white shadow transition">TIME IN</button>
            <button onclick="setScanType('OUT')" id="btnScanOut" class="py-4 rounded-xl font-black border-2 border-slate-200 bg-slate-100 text-slate-600 shadow transition">TIME OUT</button>
          </div>
        </div>

        <!-- AUDIO TOGGLE -->
        <div class="flex items-center justify-between bg-slate-50 p-3 rounded-xl border">
          <span class="text-xs font-bold text-slate-600"><i class="fa-solid fa-volume-high mr-1"></i> Audio Feedback</span>
          <button onclick="toggleSound()" id="soundToggleBtn" class="bg-emerald-600 text-white px-3 py-1 rounded text-xs font-bold">ON</button>
        </div>

        <!-- STEP 3: CAMERA CONTAINER -->
        <div>
          <button onclick="startScanner()" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-4 rounded-xl font-black text-lg shadow-lg transition flex items-center justify-center gap-2">
            <i class="fa-solid fa-camera"></i> START CAMERA SCANNER
          </button>
        </div>

        <div id="reader-container" class="hidden mt-4 border-4 border-indigo-600 rounded-2xl overflow-hidden relative">
          <div id="reader"></div>
          <button onclick="stopScanner()" class="absolute top-2 right-2 bg-rose-600 text-white px-3 py-1 rounded-lg font-bold text-xs z-10">Stop Camera</button>
        </div>
      </div>

      <!-- SCAN RESULT NOTIFICATION BOX -->
      <div id="scanResultBox" class="hidden bg-white p-6 rounded-2xl shadow-xl border-2 text-center space-y-3"></div>
    </div>

    <script>
      let currentScanType = 'IN';
      let soundEnabled = true;
      let html5QrCode = null;

      function setScanType(type) {
        currentScanType = type;
        if(type === 'IN') {
          document.getElementById('btnScanIn').className = 'py-4 rounded-xl font-black border-2 border-indigo-600 bg-indigo-600 text-white shadow';
          document.getElementById('btnScanOut').className = 'py-4 rounded-xl font-black border-2 border-slate-200 bg-slate-100 text-slate-600 shadow';
        } else {
          document.getElementById('btnScanOut').className = 'py-4 rounded-xl font-black border-2 border-indigo-600 bg-indigo-600 text-white shadow';
          document.getElementById('btnScanIn').className = 'py-4 rounded-xl font-black border-2 border-slate-200 bg-slate-100 text-slate-600 shadow';
        }
      }

      function toggleSound() {
        soundEnabled = !soundEnabled;
        document.getElementById('soundToggleBtn').innerText = soundEnabled ? 'ON' : 'OFF';
        document.getElementById('soundToggleBtn').className = soundEnabled ? 'bg-emerald-600 text-white px-3 py-1 rounded text-xs font-bold' : 'bg-slate-400 text-white px-3 py-1 rounded text-xs font-bold';
      }

      function playAudio(type) {
        if(!soundEnabled) return;
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        if(type === 'success') {
          osc.frequency.setValueAtTime(587.33, ctx.currentTime);
          osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.3);
        } else {
          osc.frequency.setValueAtTime(200, ctx.currentTime);
          gain.gain.setValueAtTime(0.2, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.4);
        }
      }

      async function startScanner() {
        document.getElementById('reader-container').classList.remove('hidden');
        html5QrCode = new Html5Qrcode("reader");
        try {
          await html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            onScanSuccess,
            onScanFailure
          );
        } catch(err) {
          alert('Unable to access camera. Please allow camera permissions.');
          console.error(err);
        }
      }

      async function stopScanner() {
        if(html5QrCode) {
          await html5QrCode.stop();
          html5QrCode = null;
        }
        document.getElementById('reader-container').classList.add('hidden');
      }

      let processingScan = false;
      async function onScanSuccess(decodedText) {
        if(processingScan) return;
        processingScan = true;

        const eventId = document.getElementById('scanEvent').value;
        try {
          let res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: currentScanType })
          });
          let data = await res.json();
          let box = document.getElementById('scanResultBox');
          box.classList.remove('hidden');

          if(data.status === 'success') {
            playAudio('success');
            box.className = 'bg-emerald-50 border-emerald-500 p-6 rounded-2xl shadow-xl border-2 text-center space-y-2';
            box.innerHTML = \`<div class="text-emerald-600 font-black text-lg">✓ QR CODE ACCEPTED</div>
              <h3 class="text-2xl font-black text-slate-900">\${data.member.name}</h3>
              <p class="text-sm text-slate-600">ID: <span class="font-mono">\${data.member.member_id}</span></p>
              <p class="text-sm text-slate-600">Grade: \${data.member.grade} - \${data.member.section}</p>
              <div class="bg-emerald-600 text-white py-2 rounded-xl font-bold uppercase text-sm">\${currentScanType === 'IN' ? 'TIME IN RECORDED' : 'TIME OUT RECORDED'} - \${data.time}</div>\`;
          } else if(data.status === 'duplicate') {
            playAudio('error');
            box.className = 'bg-amber-50 border-amber-500 p-6 rounded-2xl shadow-xl border-2 text-center space-y-2';
            box.innerHTML = \`<div class="text-amber-600 font-black text-lg">⚠ ALREADY RECORDED</div>
              <h3 class="text-xl font-black text-slate-900">\${data.member.name}</h3>
              <p class="text-sm text-amber-800">\${data.message}</p>\`;
          } else {
            playAudio('error');
            box.className = 'bg-rose-50 border-rose-500 p-6 rounded-2xl shadow-xl border-2 text-center space-y-2';
            box.innerHTML = \`<div class="text-rose-600 font-black text-lg">✕ QR CODE NOT REGISTERED</div>
              <p class="text-sm text-rose-800">This QR code is invalid or not recognized in the system.</p>\`;
          }
        } catch(err) {
          console.error(err);
        }

        setTimeout(() => { processingScan = false; }, 3000);
      }

      function onScanFailure(error) {}
    </script>
  `;
  res.send(renderLayout('Scanner Portal', content, req.session.user, settings));
});

// Scanner API Processing Route
app.post('/api/scan', isAuthenticated, async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const timeNow = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      await pool.query('INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.user.username, event_id, scan_type, qr_token, 'INVALID', 'Unregistered QR Code']);
      return res.json({ status: 'invalid' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'active') {
      return res.json({ status: 'invalid', message: 'Member account is inactive.' });
    }

    // Check existing attendance record for today & event
    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, today]);
    
    if (scan_type === 'IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          status: 'duplicate',
          member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id },
          message: `Already has Time In recorded at ${attRes.rows[0].time_in}`
        });
      }

      // Check event cutoff
      const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
      const event = eventRes.rows[0];
      const status = timeNow > event.late_cutoff ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [timeNow, status, attRes.rows[0].id]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, \'QR\')',
          [member.id, event_id, today, timeNow, status]);
      }

      await pool.query('INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.user.username, event_id, 'IN', qr_token, 'SUCCESS', 'Time In recorded']);

      return res.json({
        status: 'success',
        member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id, grade: member.grade_level, section: member.section },
        time: `${timeNow} (${status})`
      });

    } else { // TIME OUT
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ status: 'duplicate', member: { name: `${member.first_name} ${member.last_name}` }, message: 'Cannot Time Out without an initial Time In record.' });
      }
      if (attRes.rows[0].time_out) {
        return res.json({ status: 'duplicate', member: { name: `${member.first_name} ${member.last_name}` }, message: 'Time Out already recorded for today.' });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [timeNow, attRes.rows[0].id]);
      await pool.query('INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.user.username, event_id, 'OUT', qr_token, 'SUCCESS', 'Time Out recorded']);

      return res.json({
        status: 'success',
        member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id, grade: member.grade_level, section: member.section },
        time: timeNow
      });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Internal server error.' });
  }
});


// --- MEMBER PORTAL ---
app.get('/member', isAuthenticated, requireRole('member'), async (req, res) => {
  const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
  const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [req.session.user.referenceId]);
  if (memberRes.rows.length === 0) return res.send('Member profile reference missing.');
  const member = memberRes.rows[0];

  const qrCodeDataUrl = await QRCode.toDataURL(member.qr_token);
  const announcements = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5')).rows;
  const attendanceHistory = (await pool.query(`
    SELECT a.*, e.event_name FROM attendance a 
    JOIN events e ON a.event_id = e.id 
    WHERE a.member_id = $1 ORDER BY a.attendance_date DESC
  `, [member.id])).rows;

  const content = `
    <div class="space-y-6">
      <!-- Member Header Card -->
      <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col md:flex-row justify-between items-center gap-6">
        <div class="flex items-center space-x-4">
          <div class="bg-indigo-100 text-indigo-700 w-16 h-16 rounded-2xl flex items-center justify-center font-black text-2xl">
            ${member.first_name[0]}${member.last_name[0]}
          </div>
          <div>
            <span class="bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-md text-xs font-bold">${member.position}</span>
            <h2 class="text-2xl font-black text-slate-900 mt-1">${member.first_name} ${member.last_name}</h2>
            <p class="text-xs text-slate-500 font-mono">ID: ${member.member_id} &bull; Grade ${member.grade_level} - ${member.section}</p>
          </div>
        </div>
        <div class="bg-slate-50 p-4 rounded-xl border text-center">
          <p class="text-xs font-bold uppercase text-slate-400 mb-1">Digital QR ID Token</p>
          <img src="${qrCodeDataUrl}" alt="Member QR Code" class="w-32 h-32 mx-auto bg-white p-1 rounded-lg border">
          <a href="/member/id-card/${member.member_id}" target="_blank" class="mt-2 inline-block text-xs font-bold text-indigo-600 hover:underline"><i class="fa-solid fa-id-card"></i> View Printable ID Card</a>
        </div>
      </div>

      <!-- Tabs -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- Attendance Record -->
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
          <h3 class="text-lg font-black text-slate-900">My Attendance Logs</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="bg-slate-100 text-xs uppercase font-bold text-slate-600">
                  <th class="p-3">Event</th>
                  <th class="p-3">Date</th>
                  <th class="p-3">Time In / Out</th>
                  <th class="p-3">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                ${attendanceHistory.map(att => `
                  <tr>
                    <td class="p-3 font-semibold">${att.event_name}</td>
                    <td class="p-3 text-xs">${att.attendance_date}</td>
                    <td class="p-3 text-xs font-mono">${att.time_in || '--'} / ${att.time_out || '--'}</td>
                    <td class="p-3"><span class="px-2 py-0.5 rounded text-xs font-bold ${att.status === 'Present' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${att.status}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Announcements -->
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
          <h3 class="text-lg font-black text-slate-900">Organization Announcements</h3>
          <div class="space-y-3">
            ${announcements.map(ann => `
              <div class="bg-slate-50 p-4 rounded-xl border space-y-1">
                <h4 class="font-bold text-sm text-indigo-900">${ann.title}</h4>
                <p class="text-xs text-slate-600">${ann.message}</p>
                <span class="text-[10px] text-slate-400 block pt-1"><i class="fa-regular fa-clock"></i> ${ann.created_at}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
  res.send(renderLayout('Member Portal', content, req.session.user, settings));
});

// Printable ID Card Route
app.get('/member/id-card/:id', isAuthenticated, async (req, res) => {
  const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
  const memberRes = await pool.query('SELECT * FROM members WHERE member_id = $1 OR id::text = $1', [req.params.id]);
  if (memberRes.rows.length === 0) return res.status(404).send('Member not found.');
  const member = memberRes.rows[0];
  const qrCodeDataUrl = await QRCode.toDataURL(member.qr_token, { width: 300 });

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>ID Card - ${member.first_name} ${member.last_name}</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="bg-white w-[350px] rounded-3xl shadow-2xl overflow-hidden border-4 border-indigo-900 text-center p-6 space-y-4">
        <div class="bg-indigo-900 text-white p-4 -mx-6 -mt-6">
          <p class="text-xs font-bold uppercase tracking-wider">${settings.school_name}</p>
          <h2 class="text-lg font-black">${settings.org_name}</h2>
          <span class="text-[10px] bg-white/20 px-2 py-0.5 rounded-full uppercase">Official ID Card (${settings.school_year})</span>
        </div>
        
        <div class="w-28 h-28 bg-slate-200 mx-auto rounded-full border-4 border-white shadow-md flex items-center justify-center font-black text-3xl text-indigo-900">
          ${member.first_name[0]}${member.last_name[0]}
        </div>

        <div>
          <h3 class="text-xl font-black text-slate-900">${member.first_name} ${member.middle_name ? member.middle_name[0] + '.' : ''} ${member.last_name}</h3>
          <p class="text-xs font-bold text-indigo-600 uppercase mt-0.5">${member.position}</p>
        </div>

        <div class="bg-slate-50 p-3 rounded-2xl border text-xs space-y-1 text-left font-mono">
          <p><strong>ID:</strong> ${member.member_id}</p>
          <p><strong>Grade & Sec:</strong> Grade ${member.grade_level} - ${member.section}</p>
        </div>

        <div>
          <img src="${qrCodeDataUrl}" alt="QR Code" class="w-32 h-32 mx-auto bg-white p-1 rounded-xl border">
          <p class="text-[9px] text-slate-400 mt-1">Scan for attendance tracking</p>
        </div>

        <button onclick="window.print()" class="w-full bg-indigo-900 text-white py-2 rounded-xl text-xs font-bold shadow print:hidden">Print ID Card</button>
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

// Root Redirect
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    if (req.session.user.role === 'scanner') return res.redirect('/scanner');
    return res.redirect('/member');
  }
  res.redirect('/login');
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
});