/**
 * ClubTrack QR Attendance System
 * Complete Organization & Club Management System in ONE file (app.js)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Database Connection Setup
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'club_attendance',
        password: process.env.PGPASSWORD || 'postgres',
        port: process.env.PGPORT || 5432
      }
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day session
  })
);

// --- DATABASE MIGRATION & INITIALIZATION ---
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name TEXT DEFAULT 'ABC High School',
        org_name TEXT DEFAULT 'Supreme Student Council',
        school_year TEXT DEFAULT '2026–2027',
        org_desc TEXT DEFAULT 'Official Student Leadership Organization',
        theme_color TEXT DEFAULT '#4f46e5',
        member_id_prefix TEXT DEFAULT 'SSC'
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'scanner', 'member')),
        name TEXT NOT NULL,
        must_change_password BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id TEXT UNIQUE NOT NULL,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        gender TEXT,
        grade_level TEXT NOT NULL,
        section TEXT NOT NULL,
        position TEXT DEFAULT 'Member',
        contact TEXT,
        email TEXT,
        qr_token TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
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
        status TEXT DEFAULT 'Present',
        scan_method TEXT DEFAULT 'QR',
        manual_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        posted_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_date DATE
      );

      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        username TEXT,
        role TEXT,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        scanner_user TEXT,
        event_id INT,
        scan_type TEXT,
        qr_value TEXT,
        result TEXT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Default Settings
    const settingsCheck = await client.query('SELECT COUNT(*) FROM organization_settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_desc, theme_color, member_id_prefix)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official Student Leadership Organization', '#4f46e5', 'SSC');
      `);
    }

    // Default Admin Account
    const adminCheck = await client.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
    if (parseInt(adminCheck.rows[0].count) === 0) {
      const hashedPass = await bcrypt.hash('admin123', 10);
      await client.query(
        'INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, $3, $4, $5)',
        ['admin', hashedPass, 'admin', 'System Administrator', true]
      );
      console.log('-> Default admin account created: admin / admin123');
    }
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

initDB();

// Helper Logger
async function logAction(username, role, action, details) {
  try {
    await pool.query(
      'INSERT INTO system_logs (username, role, action, details) VALUES ($1, $2, $3, $4)',
      [username || 'System', role || 'System', action, details]
    );
  } catch (e) {
    console.error('Log error:', e);
  }
}

// Middleware Guards
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
      return res.redirect('/login');
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'admin') {
      return res.status(403).send('Forbidden Access');
    }
    if (req.session.user.mustChangePassword && req.path !== '/change-password' && !req.path.startsWith('/api/')) {
      return res.redirect('/change-password');
    }
    next();
  };
}

// --- HTML TEMPLATE LAYOUT HELPER ---
async function renderLayout(title, content, user, activeTab = '') {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const s = settingsRes.rows[0] || {
    school_name: 'ABC High School',
    org_name: 'ClubTrack',
    theme_color: '#4f46e5'
  };

  let navLinks = '';
  if (user.role === 'admin') {
    navLinks = `
      <a href="/admin" class="${activeTab === 'dashboard' ? 'active' : ''}">📊 Dashboard</a>
      <a href="/admin/members" class="${activeTab === 'members' ? 'active' : ''}">👥 Members</a>
      <a href="/admin/attendance" class="${activeTab === 'attendance' ? 'active' : ''}">📋 Attendance</a>
      <a href="/admin/events" class="${activeTab === 'events' ? 'active' : ''}">📅 Events</a>
      <a href="/admin/scanners" class="${activeTab === 'scanners' ? 'active' : ''}">📱 Scanners</a>
      <a href="/admin/announcements" class="${activeTab === 'announcements' ? 'active' : ''}">📢 Announcements</a>
      <a href="/admin/reports" class="${activeTab === 'reports' ? 'active' : ''}">📈 Reports</a>
      <a href="/admin/logs" class="${activeTab === 'logs' ? 'active' : ''}">🛡️ System Logs</a>
      <a href="/admin/settings" class="${activeTab === 'settings' ? 'active' : ''}">⚙️ Settings</a>
    `;
  } else if (user.role === 'scanner') {
    navLinks = `
      <a href="/scanner" class="active">📷 Live QR Scanner</a>
    `;
  } else if (user.role === 'member') {
    navLinks = `
      <a href="/member-portal" class="${activeTab === 'portal' ? 'active' : ''}">🏠 My Portal & ID</a>
      <a href="/member-portal/attendance" class="${activeTab === 'portal-attendance' ? 'active' : ''}">📊 My Attendance</a>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ${s.org_name}</title>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
  <style>
    :root { --primary: ${s.theme_color}; --primary-hover: #3730a3; --bg: #f8fafc; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    body { background: var(--bg); color: var(--text); display: flex; min-height: 100vh; }
    aside { width: 260px; background: #0f172a; color: #fff; display: flex; flex-direction: column; position: fixed; height: 100vh; overflow-y: auto; z-index: 10; }
    aside .brand { padding: 20px; font-size: 1.1rem; font-weight: bold; border-bottom: 1px solid #1e293b; background: #020617; text-align: center; }
    aside nav { padding: 15px 10px; display: flex; flex-direction: column; gap: 5px; }
    aside nav a { color: #94a3b8; text-decoration: none; padding: 10px 15px; border-radius: 6px; font-size: 0.95rem; transition: 0.2s; }
    aside nav a:hover, aside nav a.active { background: var(--primary); color: #fff; }
    main { margin-left: 260px; flex: 1; display: flex; flex-direction: column; min-width: 0; }
    header { background: var(--card); padding: 15px 30px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .user-info { display: flex; align-items: center; gap: 15px; }
    .content { padding: 30px; flex: 1; max-width: 1400px; width: 100%; margin: 0 auto; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; border-left: 4px solid var(--primary); }
    .stat-card h3 { font-size: 0.85rem; color: #64748b; text-transform: uppercase; margin-bottom: 5px; }
    .stat-card .val { font-size: 1.8rem; font-weight: bold; color: var(--text); }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.9rem; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: #f1f5f9; color: #475569; font-weight: 600; }
    .btn { background: var(--primary); color: #white; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: 0.2s; }
    .btn:hover { opacity: 0.9; }
    .btn-danger { background: #ef4444; }
    .btn-success { background: #22c55e; }
    .btn-secondary { background: #64748b; }
    input, select, textarea { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.95rem; margin-top: 5px; margin-bottom: 15px; }
    label { font-weight: 500; font-size: 0.9rem; color: #475569; }
    .badge { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; display: inline-block; }
    .badge-active, .badge-present, .badge-completed { background: #dcfce7; color: #166534; }
    .badge-late { background: #fef9c3; color: #854d0e; }
    .badge-inactive, .badge-absent { background: #fee2e2; color: #991b1b; }
    
    /* ID Card Standard Layout */
    .id-card { width: 340px; background: #fff; border: 2px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin: 20px auto; text-align: center; position: relative; }
    .id-header { background: var(--primary); color: #fff; padding: 15px; }
    .id-header h4 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; }
    .id-header h2 { font-size: 1.1rem; margin-top: 2px; }
    .id-body { padding: 20px; }
    .id-photo { width: 100px; height: 100px; border-radius: 50%; border: 3px solid var(--primary); object-fit: cover; background: #e2e8f0; margin: 0 auto 10px auto; display: flex; align-items: center; justify-content: center; font-size: 2rem; color: #64748b; }
    .id-name { font-size: 1.2rem; font-weight: bold; color: var(--text); }
    .id-meta { font-size: 0.85rem; color: #64748b; margin: 5px 0 15px 0; }
    .id-qr { width: 130px; height: 130px; margin: 10px auto; }
    .id-footer { background: #f1f5f9; padding: 8px; font-size: 0.65rem; color: #94a3b8; border-top: 1px solid var(--border); }

    @media print {
      body * { visibility: hidden; }
      .printable-card, .printable-card * { visibility: visible; }
      .printable-card { position: absolute; left: 0; top: 0; width: 100%; margin: 0; border: none; box-shadow: none; }
      aside, header, .no-print { display: none !important; }
    }
    @media(max-width: 768px) {
      aside { width: 70px; }
      aside .brand span, aside nav a span { display: none; }
      main { margin-left: 70px; }
      .content { padding: 15px; }
    }
  </style>
</head>
<body>
  <aside>
    <div class="brand"><span>🛡️ ${s.org_name}</span></div>
    <nav>${navLinks}</nav>
  </aside>
  <main>
    <header>
      <h2>${s.school_name} - ${s.org_name}</h2>
      <div class="user-info">
        <span>👤 <b>${user.name}</b> (${user.role.toUpperCase()})</span>
        <a href="/logout" class="btn btn-danger" style="padding: 5px 10px; font-size: 0.8rem;">Logout</a>
      </div>
    </header>
    <div class="content">
      ${content}
    </div>
  </main>
</body>
</html>`;
}

// --- AUTH ROUTES ---
app.get('/login', async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const s = settingsRes.rows[0] || { school_name: 'ABC High School', org_name: 'ClubTrack', theme_color: '#4f46e5' };
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Login - ${s.org_name}</title>
  <style>
    :root { --primary: ${s.theme_color}; }
    body { background: #0f172a; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Segoe UI', sans-serif; }
    .login-card { background: #fff; padding: 40px; border-radius: 12px; width: 100%; max-width: 400px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
    h2 { color: #1e293b; margin-bottom: 5px; text-align: center; }
    p { color: #64748b; font-size: 0.9rem; text-align: center; margin-bottom: 25px; }
    input { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 1rem; }
    button { width: 100%; padding: 12px; background: var(--primary); color: #fff; border: none; border-radius: 6px; font-size: 1rem; font-weight: bold; cursor: pointer; }
    button:hover { opacity: 0.9; }
    .error { background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 6px; margin-bottom: 15px; font-size: 0.85rem; text-align: center; }
    .links { margin-top: 15px; text-align: center; font-size: 0.85rem; }
    .links a { color: var(--primary); text-decoration: none; }
  </style>
</head>
<body>
  <div class="login-card">
    <h2>${s.org_name}</h2>
    <p>${s.school_name}</p>
    ${req.query.error ? `<div class="error">${req.query.error}</div>` : ''}
    <form action="/login" method="POST">
      <label>Username</label>
      <input type="text" name="username" required autofocus>
      <label>Password</label>
      <input type="password" name="password" required>
      <button type="submit">Sign In</button>
    </form>
    <div class="links">
      <a href="/scanner-login">📱 Open Standalone QR Scanner Portal</a>
    </div>
  </div>
</body>
</html>`);
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.redirect('/login?error=Invalid+Username+or+Password');
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.redirect('/login?error=Invalid+Username+or+Password');

    req.session.user = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      mustChangePassword: user.must_change_password
    };

    await logAction(user.username, user.role, 'LOGIN', `${user.username} logged into the system.`);

    if (user.must_change_password) return res.redirect('/change-password');
    if (user.role === 'admin') return res.redirect('/admin');
    if (user.role === 'scanner') return res.redirect('/scanner');
    return res.redirect('/member-portal');
  } catch (err) {
    console.error(err);
    res.redirect('/login?error=Database+Error');
  }
});

// Standalone Scanner Login Route
app.get('/scanner-login', async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Scanner Login</title>
<style>
  body { background: #0f172a; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; }
  .box { background: #fff; padding: 30px; border-radius: 10px; width: 350px; }
  input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; border-radius: 5px; }
  button { width: 100%; padding: 10px; background: #22c55e; color: #fff; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; }
</style></head>
<body>
<div class="box">
  <h3>📱 Scanner Portal Login</h3>
  <form action="/login" method="POST">
    <input type="text" name="username" placeholder="Scanner Username" required>
    <input type="password" name="password" placeholder="Password" required>
    <button type="submit">Access Scanner Portal</button>
  </form>
</div></body></html>`);
});

// Member Direct Portal Login Link Route
app.get('/member-login', (req, res) => {
  res.redirect('/login');
});

app.get('/logout', (req, res) => {
  if (req.session.user) {
    logAction(req.session.user.username, req.session.user.role, 'LOGOUT', 'User logged out.');
  }
  req.session.destroy(() => res.redirect('/login'));
});

// Mandatory Password Change
app.get('/change-password', requireAuth(), async (req, res) => {
  const content = `
    <div class="card" style="max-width: 500px; margin: 40px auto;">
      <h3>🔒 Security Notice: Change Temporary Password</h3>
      <p style="margin: 15px 0; color: #64748b;">You are logging in with a temporary password. Please create a secure private password to proceed.</p>
      ${req.query.error ? `<div style="background:#fee2e2; color:#991b1b; padding:10px; border-radius:6px; margin-bottom:15px;">${req.query.error}</div>` : ''}
      <form action="/change-password" method="POST">
        <label>New Password (Min 8 characters)</label>
        <input type="password" name="new_password" minlength="8" required>
        <label>Confirm New Password</label>
        <input type="password" name="confirm_password" minlength="8" required>
        <button type="submit" class="btn" style="width:100%; margin-top:10px;">Update Password & Secure Account</button>
      </form>
    </div>
  `;
  res.send(await renderLayout('Change Password', content, req.session.user));
});

app.post('/change-password', requireAuth(), async (req, res) => {
  const { new_password, confirm_password } = req.body;
  if (new_password !== confirm_password || new_password.length < 8) {
    return res.redirect('/change-password?error=Passwords+must+match+and+be+at+least+8+characters.');
  }
  try {
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, req.session.user.id]);
    req.session.user.mustChangePassword = false;
    await logAction(req.session.user.username, req.session.user.role, 'PASSWORD_CHANGE', 'User updated temporary password successfully.');
    
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    if (req.session.user.role === 'scanner') return res.redirect('/scanner');
    return res.redirect('/member-portal');
  } catch (err) {
    res.redirect('/change-password?error=Database+Error');
  }
});

// --- ADMIN PORTAL ROUTES ---
app.get('/admin', requireAuth('admin'), async (req, res) => {
  const counts = await Promise.all([
    pool.query('SELECT COUNT(*) FROM members'),
    pool.query("SELECT COUNT(*) FROM members WHERE status = 'Active'"),
    pool.query("SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date = CURRENT_DATE"),
    pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result = 'Invalid QR' AND DATE(created_at) = CURRENT_DATE")
  ]);

  const liveAttendance = await pool.query(`
    -SELECT a.*, m.first_name, m.last_name, m.grade_level, m.section, e.name as event_name
    FROM attendance a
    JOIN members m ON a.member_id = m.id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.created_at DESC LIMIT 10
  `).catch(() => ({ rows: [] }));

  const content = `
    <h2>Dashboard Overview</h2>
    <div class="grid-4">
      <div class="stat-card"><h3>Total Members</h3><div class="val">${counts[0].rows[0].count}</div></div>
      <div class="stat-card"><h3>Active Members</h3><div class="val">${counts[1].rows[0].count}</div></div>
      <div class="stat-card"><h3>Present Today</h3><div class="val">${counts[2].rows[0].count}</div></div>
      <div class="stat-card"><h3>Invalid Scans Today</h3><div class="val" style="color:#ef4444">${counts[3].rows[0].count}</div></div>
    </div>
    <div class="card">
      <h3>🔴 Live Attendance Feed (Auto-Refreshes)</h3>
      <table>
        <thead><tr><th>Time</th><th>Member</th><th>Grade & Section</th><th>Event</th><th>Scan Type</th><th>Status</th></tr></thead>
        <tbody id="live-feed">
          ${liveAttendance.rows.map(r => `
            <tr>
              <td>${r.time_in || r.time_out || 'N/A'}</td>
              <td><b>${r.first_name} ${r.last_name}</b></td>
              <td>${r.grade_level} - ${r.section}</td>
              <td>${r.event_name}</td>
              <td><span class="badge" style="background:#e0f2fe;color:#0369a1">${r.scan_method}</span></td>
              <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <script>
      setInterval(() => {
        fetch('/api/live-feed').then(res => res.json()).then(data => {
          const tbody = document.getElementById('live-feed');
          tbody.innerHTML = data.map(r => \`
            <tr>
              <td>\${r.time_in || r.time_out || 'N/A'}</td>
              <td><b>\${r.first_name} \${r.last_name}</b></td>
              <td>\${r.grade_level} - \${r.section}</td>
              <td>\${r.event_name}</td>
              <td><span class="badge" style="background:#e0f2fe;color:#0369a1">\${r.scan_method}</span></td>
              <td><span class="badge badge-\${r.status.toLowerCase()}">\${r.status}</span></td>
            </tr>
          \`).join('');
        });
      }, 5000);
    </script>
  `;
  res.send(await renderLayout('Admin Dashboard', content, req.session.user, 'dashboard'));
});

// Live feed JSON api
app.get('/api/live-feed', requireAuth('admin'), async (req, res) => {
  const r = await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.grade_level, m.section, e.name as event_name
    FROM attendance a
    JOIN members m ON a.member_id = m.id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.created_at DESC LIMIT 10
  `);
  res.json(r.rows);
});

// MEMBERS MANAGEMENT
app.get('/admin/members', requireAuth('admin'), async (req, res) => {
  const search = req.query.search || '';
  const queryText = search 
    ? `SELECT * FROM members WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR member_id ILIKE $1 ORDER BY last_name ASC`
    : `SELECT * FROM members ORDER BY last_name ASC`;
  const members = await pool.query(queryText, search ? [`%${search}%`] : []);
  const settings = await pool.query('SELECT member_id_prefix FROM organization_settings LIMIT 1');
  const prefix = settings.rows[0]?.member_id_prefix || 'SSC';

  const content = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
      <h2>Member Directory & Management</h2>
      <button class="btn" onclick="document.getElementById('addModal').style.display='block'">+ Register New Member</button>
    </div>
    <div class="card">
      <form method="GET" style="display:flex; gap:10px; margin-bottom:15px;">
        <input type="text" name="search" placeholder="Search by name or Member ID..." value="${search}" style="margin:0;">
        <button type="submit" class="btn" style="width:auto;">Search</button>
      </form>
      <table>
        <thead><tr><th>Member ID</th><th>Full Name</th><th>Grade & Section</th><th>Position</th><th>Username</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${members.rows.map(m => `
            <tr>
              <td><b>${m.member_id}</b></td>
              <td>${m.first_name} ${m.middle_name || ''} ${m.last_name}</td>
              <td>${m.grade_level} - ${m.section}</td>
              <td>${m.position}</td>
              <td>${m.user_id ? 'Linked' : 'No User'}</td>
              <td><span class="badge badge-${m.status.toLowerCase()}">${m.status}</span></td>
              <td>
                <a href="/admin/member/${m.id}/id" class="btn" style="padding:4px 8px; font-size:0.75rem;">View ID</a>
                <form action="/admin/member/${m.id}/delete" method="POST" style="display:inline;" onsubmit="return confirm('Delete this member and associated records?')">
                  <button type="submit" class="btn btn-danger" style="padding:4px 8px; font-size:0.75rem;">Delete</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Add Member Modal -->
    <div id="addModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:100; overflow-y:auto;">
      <div style="background:#fff; width:90%; max-width:600px; margin:40px auto; padding:30px; border-radius:10px;">
        <h3>Register New Member</h3>
        <form action="/admin/members/add" method="POST">
          <label>First Name</label><input type="text" name="first_name" required>
          <label>Middle Name</label><input type="text" name="middle_name">
          <label>Last Name</label><input type="text" name="last_name" required>
          <label>Grade Level</label><input type="text" name="grade_level" placeholder="Grade 10" required>
          <label>Section</label><input type="text" name="section" placeholder="Rizal" required>
          <label>Position</label><input type="text" name="position" value="Member">
          <label>Contact Number</label><input type="text" name="contact">
          <label>Email</label><input type="email" name="email">
          <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
            <button type="button" class="btn btn-secondary" onclick="document.getElementById('addModal').style.display='none'">Cancel</button>
            <button type="submit" class="btn">Register & Generate ID</button>
          </div>
        </form>
      </div>
    </div>
  `;
  res.send(await renderLayout('Members Management', content, req.session.user, 'members'));
});

// ADD MEMBER POST
app.post('/admin/members/add', requireAuth('admin'), async (req, res) => {
  const { first_name, middle_name, last_name, grade_level, section, position, contact, email } = req.body;
  try {
    const settings = await pool.query('SELECT member_id_prefix FROM organization_settings LIMIT 1');
    const prefix = settings.rows[0]?.member_id_prefix || 'SSC';
    const year = new Date().getFullYear();
    
    // Generate Unique ID
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seq = parseInt(countRes.rows[0].count) + 1;
    const member_id = `${prefix}-${year}-${String(seq).padStart(4, '0')}`;

    // Generate unique username
    let username = (first_name + '.' + last_name).toLowerCase().replace(/[^a-z0-9]/g, '');
    const userCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length > 0) username += seq;

    // Generate random temporary password
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hashed = await bcrypt.hash(tempPassword, 10);

    const userRes = await pool.query(
      'INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [username, hashed, 'member', `${first_name} ${last_name}`, true]
    );
    const userId = userRes.rows[0].id;

    const qrToken = `CLUBTRACK:MEMBER:${crypto.randomUUID()}`;
    const memberRes = await pool.query(
      'INSERT INTO members (member_id, user_id, first_name, middle_name, last_name, grade_level, section, position, contact, email, qr_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
      [member_id, userId, first_name, middle_name, last_name, grade_level, section, position, contact, email, qrToken]
    );

    await logAction(req.session.user.username, req.session.user.role, 'REGISTER_MEMBER', `Registered member ${member_id} - ${first_name} ${last_name}`);

    // Show credential modal confirmation page
    const content = `
      <div class="card" style="max-width:600px; margin:20px auto; text-align:center;">
        <h2 style="color:#22c55e;">🎉 Member Successfully Registered</h2>
        <p style="margin:10px 0;">Give these credentials securely to the member. The temporary password must be changed upon first login.</p>
        <div style="background:#f8fafc; padding:20px; border-radius:8px; text-align:left; margin:20px 0;">
          <p><b>Full Name:</b> ${first_name} ${last_name}</p>
          <p><b>Member ID:</b> ${member_id}</p>
          <p><b>Username:</b> ${username}</p>
          <p><b>Temporary Password:</b> <code style="background:#e2e8f0; padding:4px 8px; border-radius:4px; font-size:1.1rem; color:#b91c1c;">${tempPassword}</code></p>
        </div>
        <div style="display:flex; justify-content:center; gap:15px;">
          <a href="/admin/member/${memberRes.rows[0].id}/id" class="btn">View & Print Digital ID Card</a>
          <a href="/admin/members" class="btn btn-secondary">Back to Members</a>
        </div>
      </div>
    `;
    res.send(await renderLayout('Registration Success', content, req.session.user, 'members'));
  } catch (err) {
    console.error(err);
    res.redirect('/admin/members?error=Failed+to+register+member');
  }
});

// DELETE MEMBER
app.post('/admin/member/:id/delete', requireAuth('admin'), async (req, res) => {
  try {
    const mem = await pool.query('SELECT user_id, member_id FROM members WHERE id = $1', [req.params.id]);
    if (mem.rows.length > 0) {
      await pool.query('DELETE FROM users WHERE id = $1', [mem.rows[0].user_id]);
      await logAction(req.session.user.username, req.session.user.role, 'DELETE_MEMBER', `Deleted member ${mem.rows[0].member_id}`);
    }
    res.redirect('/admin/members');
  } catch (e) {
    res.redirect('/admin/members?error=Delete+failed');
  }
});

// VIEW MEMBER DIGITAL ID CARD (Standardized Size with Print / Save buttons)
app.get('/admin/member/:id/id', requireAuth(), async (req, res) => {
  const mRes = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
  if (mRes.rows.length === 0) return res.status(404).send('Member not found');
  const m = mRes.rows[0];

  const sRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const s = sRes.rows[0];

  const content = `
    <div style="text-align:center;" class="no-print">
      <button class="btn" onclick="window.print()">🖨️ Print ID Card</button>
      <a href="/admin/members" class="btn btn-secondary">Back</a>
    </div>
    <div class="printable-card">
      <div class="id-card">
        <div class="id-header">
          <h4>${s.school_name}</h4>
          <h2>${s.org_name}</h2>
        </div>
        <div class="id-body">
          <div class="id-photo">👤</div>
          <div class="id-name">${m.first_name} ${m.last_name}</div>
          <div class="id-meta">${m.position} | ${m.grade_level} - ${m.section}</div>
          <p style="font-size:0.8rem; color:#64748b; margin-bottom:10px;">ID: <b>${m.member_id}</b></p>
          <div id="qrcode" class="id-qr"></div>
        </div>
        <div class="id-footer">
          Official Digital Organization Identification Card
        </div>
      </div>
    </div>
    <script>
      QRCode.toCanvas(document.getElementById('qrcode'), '${m.qr_token}', { width: 130 }, function (error) {
        if (error) console.error(error);
      });
    </script>
  `;
  res.send(await renderLayout('Member ID Card', content, req.session.user, 'members'));
});

// EVENTS MANAGEMENT
app.get('/admin/events', requireAuth('admin'), async (req, res) => {
  const events = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
  const content = `
    <h2>Events Management</h2>
    <div class="card">
      <h3>Create Attendance Event</h3>
      <form action="/admin/events/add" method="POST">
        <label>Event Name</label><input type="text" name="name" required placeholder="Monthly Assembly">
        <label>Description</label><textarea name="description"></textarea>
        <label>Event Date</label><input type="date" name="event_date" required>
        <div style="display:flex; gap:15px;">
          <div style="flex:1;"><label>Start Time</label><input type="time" name="start_time" required></div>
          <div style="flex:1;"><label>Late Cutoff Time</label><input type="time" name="late_cutoff" required></div>
        </div>
        <button type="submit" class="btn" style="margin-top:10px;">Create Event</button>
      </form>
    </div>
    <div class="card">
      <h3>Scheduled Events</h3>
      <table>
        <thead><tr><th>Event Name</th><th>Date</th><th>Start Time</th><th>Late Cutoff</th><th>Action</th></tr></thead>
        <tbody>
          ${events.rows.map(e => `
            <tr>
              <td><b>${e.name}</b><br><small>${e.description || ''}</small></td>
              <td>${e.event_date}</td>
              <td>${e.start_time}</td>
              <td>${e.late_cutoff}</td>
              <td>
                <form action="/admin/events/${e.id}/delete" method="POST" onsubmit="return confirm('Delete event?')">
                  <button type="submit" class="btn btn-danger" style="padding:4px 8px; font-size:0.75rem;">Delete</button>
                </form>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderLayout('Events', content, req.session.user, 'events'));
});

app.post('/admin/events/add', requireAuth('admin'), async (req, res) => {
  const { name, description, event_date, start_time, late_cutoff } = req.body;
  await pool.query('INSERT INTO events (name, description, event_date, start_time, late_cutoff) VALUES ($1, $2, $3, $4, $5)', [name, description, event_date, start_time, late_cutoff]);
  await logAction(req.session.user.username, req.session.user.role, 'CREATE_EVENT', `Created event: ${name}`);
  res.redirect('/admin/events');
});

app.post('/admin/events/:id/delete', requireAuth('admin'), async (req, res) => {
  await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
  res.redirect('/admin/events');
});

// ATTENDANCE MANAGEMENT & REPORTS
app.get('/admin/attendance', requireAuth('admin'), async (req, res) => {
  const records = await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.member_id, e.name as event_name
    FROM attendance a
    JOIN members m ON a.member_id = m.id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.created_at DESC LIMIT 50
  `);
  const content = `
    <h2>Attendance Records</h2>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th>Member ID</th><th>Member Name</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th><th>Method</th></tr></thead>
        <tbody>
          ${records.rows.map(r => `
            <tr>
              <td>${r.attendance_date}</td>
              <td>${r.member_id}</td>
              <td><b>${r.first_name} ${r.last_name}</b></td>
              <td>${r.event_name}</td>
              <td>${r.time_in || '-'}</td>
              <td>${r.time_out || '-'}</td>
              <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
              <td>${r.scan_method}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderLayout('Attendance', content, req.session.user, 'attendance'));
});

app.get('/admin/reports', requireAuth('admin'), async (req, res) => {
  const events = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
  const content = `
    <h2>Reports & CSV Exports</h2>
    <div class="card">
      <h3>Generate Event Report</h3>
      <form action="/admin/reports/export" method="GET">
        <label>Select Event</label>
        <select name="event_id">
          ${events.rows.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('')}
        </select>
        <button type="submit" class="btn" style="margin-top:10px;">Download CSV Report</button>
      </form>
    </div>
  `;
  res.send(await renderLayout('Reports', content, req.session.user, 'reports'));
});

app.get('/admin/reports/export', requireAuth('admin'), async (req, res) => {
  const { event_id } = req.query;
  const records = await pool.query(`
    SELECT m.member_id, m.first_name, m.last_name, m.grade_level, m.section, e.name as event_name, a.attendance_date, a.time_in, a.time_out, a.status
    FROM attendance a
    JOIN members m ON a.member_id = m.id
    JOIN events e ON a.event_id = e.id
    WHERE a.event_id = $1
  `, [event_id]);

  let csv = 'Member ID,First Name,Last Name,Grade,Section,Event,Date,Time In,Time Out,Status\n';
  records.rows.forEach(r => {
    csv += `"${r.member_id}","${r.first_name}","${r.last_name}","${r.grade_level}","${r.section}","${r.event_name}","${r.attendance_date}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
  });

  res.header('Content-Type', 'text/csv');
  res.attachment(`attendance_report_${event_id}.csv`);
  res.send(csv);
});

// SCANNERS & LOGS MANAGEMENT
app.get('/admin/scanners', requireAuth('admin'), async (req, res) => {
  const scanners = await pool.query("SELECT * FROM users WHERE role = 'scanner'");
  const content = `
    <h2>Scanner Accounts Management</h2>
    <div class="card">
      <h3>Create Scanner Account</h3>
      <form action="/admin/scanners/add" method="POST">
        <label>Full Name</label><input type="text" name="name" required placeholder="Officer Name">
        <label>Username</label><input type="text" name="username" required placeholder="scanner_user">
        <label>Password</label><input type="password" name="password" required>
        <button type="submit" class="btn" style="margin-top:10px;">Create Scanner Account</button>
      </form>
    </div>
    <div class="card">
      <h3>Authorized Scanner Accounts</h3>
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Created</th></tr></thead>
        <tbody>
          ${scanners.rows.map(s => `<tr><td><b>${s.name}</b></td><td>${s.username}</td><td>${s.created_at}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderLayout('Scanners', content, req.session.user, 'scanners'));
});

app.post('/admin/scanners/add', requireAuth('admin'), async (req, res) => {
  const { name, username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (username, password, role, name) VALUES ($1, $2, $3, $4)', [username, hashed, 'scanner', name]);
  res.redirect('/admin/scanners');
});

app.get('/admin/logs', requireAuth('admin'), async (req, res) => {
  const logs = await pool.query('SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 100');
  const content = `
    <h2>System Audit & Security Logs</h2>
    <div class="card">
      <table>
        <thead><tr><th>Timestamp</th><th>User</th><th>Role</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>
          ${logs.rows.rows || logs.rows.map(l => `
            <tr>
              <td><small>${l.created_at}</small></td>
              <td><b>${l.username}</b></td>
              <td><span class="badge" style="background:#e2e8f0;">${l.role}</span></td>
              <td><b>${l.action}</b></td>
              <td>${l.details}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderLayout('System Logs', content, req.session.user, 'logs'));
});

app.get('/admin/announcements', requireAuth('admin'), async (req, res) => {
  const anns = await pool.query('SELECT * FROM announcements ORDER BY posted_date DESC');
  const content = `
    <h2>Announcements Management</h2>
    <div class="card">
      <h3>Post Announcement</h3>
      <form action="/admin/announcements/add" method="POST">
        <label>Title</label><input type="text" name="title" required>
        <label>Message</label><textarea name="message" rows="4" required></textarea>
        <button type="submit" class="btn" style="margin-top:10px;">Post Announcement</button>
      </form>
    </div>
    <div class="card">
      <h3>Active Announcements</h3>
      ${anns.rows.map(a => `<div style="border-bottom:1px solid #e2e8f0; padding:10px 0;"><h4>${a.title}</h4><p>${a.message}</p><small>${a.posted_date}</small></div>`).join('')}
    </div>
  `;
  res.send(await renderLayout('Announcements', content, req.session.user, 'announcements'));
});

app.post('/admin/announcements/add', requireAuth('admin'), async (req, res) => {
  const { title, message } = req.body;
  await pool.query('INSERT INTO announcements (title, message) VALUES ($1, $2)', [title, message]);
  res.redirect('/admin/announcements');
});

app.get('/admin/settings', requireAuth('admin'), async (req, res) => {
  const sRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const s = sRes.rows[0];
  const content = `
    <h2>Organization & System Settings</h2>
    <div class="card" style="max-width:600px;">
      <form action="/admin/settings/update" method="POST">
        <label>School Name</label><input type="text" name="school_name" value="${s.school_name}" required>
        <label>Organization Name</label><input type="text" name="org_name" value="${s.org_name}" required>
        <label>School Year</label><input type="text" name="school_year" value="${s.school_year}" required>
        <label>Organization Description</label><textarea name="org_desc">${s.org_desc || ''}</textarea>
        <label>Theme / Accent Color</label><input type="color" name="theme_color" value="${s.theme_color}" style="height:40px; padding:2px;">
        <label>Member ID Prefix</label><input type="text" name="member_id_prefix" value="${s.member_id_prefix}" required>
        <button type="submit" class="btn" style="margin-top:15px;">Save Settings</button>
      </form>
    </div>
  `;
  res.send(await renderLayout('Settings', content, req.session.user, 'settings'));
});

app.post('/admin/settings/update', requireAuth('admin'), async (req, res) => {
  const { school_name, org_name, school_year, org_desc, theme_color, member_id_prefix } = req.body;
  await pool.query('UPDATE organization_settings SET school_name=$1, org_name=$2, school_year=$3, org_desc=$4, theme_color=$5, member_id_prefix=$6', [school_name, org_name, school_year, org_desc, theme_color, member_id_prefix]);
  res.redirect('/admin/settings');
});

// --- DEDICATED SCANNER PORTAL & LINK (`/scanner`) ---
app.get('/scanner', requireAuth(), async (req, res) => {
  if (req.session.user.role !== 'admin' && req.session.user.role !== 'scanner') {
    return res.status(403).send('Unauthorized Scanner Access');
  }
  const events = await pool.query('SELECT * FROM events WHERE event_date = CURRENT_DATE OR event_date >= CURRENT_DATE ORDER BY event_date ASC');
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Scanner Portal - ClubTrack</title>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <style>
    body { background: #0f172a; color: #fff; font-family: sans-serif; padding: 20px; text-align: center; }
    .scanner-container { max-width: 500px; margin: 0 auto; background: #1e293b; padding: 20px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    select, button { width: 100%; padding: 14px; margin: 10px 0; border-radius: 8px; font-size: 1rem; border: none; }
    select { background: #334155; color: #fff; }
    .mode-buttons { display: flex; gap: 10px; margin: 15px 0; }
    .mode-btn { flex: 1; padding: 15px; font-weight: bold; cursor: pointer; border-radius: 8px; background: #334155; color: #fff; border: 2px solid transparent; }
    .mode-btn.active-in { background: #166534; border-color: #22c55e; }
    .mode-btn.active-out { background: #991b1b; border-color: #ef4444; }
    #reader { width: 100%; border-radius: 8px; overflow: hidden; margin-top: 15px; background: #000; }
    .result-box { margin-top: 20px; padding: 15px; border-radius: 8px; font-size: 1.1rem; font-weight: bold; display: none; }
    .success-box { background: #166534; color: #dcfce7; }
    .error-box { background: #991b1b; color: #fee2e2; }
    .audio-toggle { margin-bottom: 10px; font-size: 0.9rem; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="scanner-container">
    <h2>📱 QR Code Attendance Scanner</h2>
    <p style="color:#94a3b8; font-size:0.85rem; margin-bottom:15px;">Logged in as: ${req.session.user.name}</p>
    
    <div class="audio-toggle">
      <label><input type="checkbox" id="soundToggle" checked> 🔊 Enable Sound Feedback</label>
    </div>

    <label style="text-align:left; display:block; color:#cbd5e1;">Select Attendance Event</label>
    <select id="eventSelect">
      ${events.rows.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('')}
    </select>

    <label style="text-align:left; display:block; color:#cbd5e1; margin-top:10px;">Select Scan Mode</label>
    <div class="mode-buttons">
      <button type="button" class="mode-btn active-in" id="btnIn" onclick="setMode('TIME_IN')">TIME IN</button>
      <button type="button" class="mode-btn" id="btnOut" onclick="setMode('TIME_OUT')">TIME OUT</button>
    </div>

    <button onclick="startScanner()" style="background:#4f46e5; color:#fff; font-weight:bold; cursor:pointer;">▶ Start Camera</button>
    
    <div id="reader"></div>
    <div id="resultBox" class="result-box"></div>
    
    <div style="margin-top:20px;">
      <a href="/admin" style="color:#94a3b8; text-decoration:none; font-size:0.85rem;">Back to Dashboard</a>
    </div>
  </div>

  <script>
    let currentMode = 'TIME_IN';
    let html5QrCode = null;
    let isProcessing = false;

    function setMode(mode) {
      currentMode = mode;
      document.getElementById('btnIn').className = mode === 'TIME_IN' ? 'mode-btn active-in' : 'mode-btn';
      document.getElementById('btnOut').className = mode === 'TIME_OUT' ? 'mode-btn active-out' : 'mode-btn';
    }

    // Web Audio API feedback sounds
    function playSound(type) {
      if (!document.getElementById('soundToggle').checked) return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      if (type === 'success') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else {
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      }
    }

    function startScanner() {
      if (html5QrCode) return;
      html5QrCode = new Html5Qrcode("reader");
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
          if (isProcessing) return;
          isProcessing = true;
          
          const eventId = document.getElementById('eventSelect').value;
          try {
            const res = await fetch('/api/scan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: currentMode })
            });
            const data = await res.json();
            const box = document.getElementById('resultBox');
            box.style.display = 'block';
            
            if (data.success) {
              playSound('success');
              box.className = 'result-box success-box';
              box.innerHTML = \`✓ \${data.message}<br><small>\${data.member.first_name} \${data.member.last_name} (\${data.member.member_id})</small>\`;
            } else {
              playSound('error');
              box.className = 'result-box error-box';
              box.innerHTML = \`⚠ \${data.error}\`;
            }
          } catch(e) {
            console.error(e);
          }
          setTimeout(() => { isProcessing = false; }, 3000);
        }
      ).catch(err => {
        alert('Camera error or permission denied: ' + err);
      });
    }
  </script>
</body>
</html>`);
});

// Scan Processing API endpoint
app.post('/api/scan', requireAuth(), async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  try {
    const memRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memRes.rows.length === 0) {
      await pool.query('INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.user.username, event_id, scan_type, qr_token, 'Invalid QR', 'QR Code not registered']);
      return res.json({ success: false, error: 'INVALID QR CODE: Not Registered' });
    }

    const member = memRes.rows[0];
    if (member.status !== 'Active') {
      return res.json({ success: false, error: 'MEMBER INACTIVE: Access Denied' });
    }

    const today = new Date().toISOString().split('T')[0];
    const existingAtt = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, today]);

    const currentTime = new Date().toTimeString().split(' ')[0];

    if (scan_type === 'TIME_IN') {
      if (existingAtt.rows.length > 0 && existingAtt.rows[0].time_in) {
        return res.json({ success: false, error: `Already Timed In at ${existingAtt.rows[0].time_in}` });
      }

      // Check event cutoff for Late status
      const evRes = await pool.query('SELECT late_cutoff FROM events WHERE id = $1', [event_id]);
      const cutoff = evRes.rows[0]?.late_cutoff || '08:00:00';
      const status = currentTime > cutoff ? 'Late' : 'Present';

      if (existingAtt.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [currentTime, status, existingAtt.rows[0].id]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, $6)',
          [member.id, event_id, today, currentTime, status, 'QR']);
      }
      return res.json({ success: true, message: 'TIME IN RECORDED', member });
    } else {
      if (existingAtt.rows.length === 0 || !existingAtt.rows[0].time_in) {
        return res.json({ success: false, error: 'No Time In record found for today.' });
      }
      if (existingAtt.rows[0].time_out) {
        return res.json({ success: false, error: `Already Timed Out at ${existingAtt.rows[0].time_out}` });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [currentTime, existingAtt.rows[0].id]);
      return res.json({ success: true, message: 'TIME OUT RECORDED', member });
    }
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Server Processing Error' });
  }
});

// --- DEDICATED MEMBER PORTAL & LINK (`/member-portal`) ---
app.get('/member-portal', requireAuth('member'), async (req, res) => {
  const memRes = await pool.query('SELECT m.* FROM members m JOIN users u ON m.user_id = u.id WHERE u.id = $1', [req.session.user.id]);
  if (memRes.rows.length === 0) return res.status(404).send('Member profile not found.');
  const m = memRes.rows[0];

  const sRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const s = sRes.rows[0];

  const anns = await pool.query('SELECT * FROM announcements ORDER BY posted_date DESC LIMIT 3');

  const content = `
    <h2>Welcome, ${m.first_name} (${m.member_id})</h2>
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
      <div class="card">
        <h3>👤 My Member Profile</h3>
        <p><b>Full Name:</b> ${m.first_name} ${m.middle_name || ''} ${m.last_name}</p>
        <p><b>Member ID:</b> ${m.member_id}</p>
        <p><b>Grade & Section:</b> ${m.grade_level} - ${m.section}</p>
        <p><b>Position:</b> ${m.position}</p>
        <p><b>Organization:</b> ${s.org_name}</p>
        <p><b>Status:</b> <span class="badge badge-${m.status.toLowerCase()}">${m.status}</span></p>
      </div>
      
      <div class="card" style="text-align:center;">
        <h3>🆔 Digital QR ID Card</h3>
        <div class="id-card" style="margin:10px auto; transform:scale(0.9);">
          <div class="id-header">
            <h4>${s.school_name}</h4>
            <h2>${s.org_name}</h2>
          </div>
          <div class="id-body">
            <div class="id-photo">👤</div>
            <div class="id-name">${m.first_name} ${m.last_name}</div>
            <div class="id-meta">${m.position} | ${m.grade_level} - ${m.section}</div>
            <p style="font-size:0.8rem; color:#64748b; margin-bottom:10px;">ID: <b>${m.member_id}</b></p>
            <div id="qrcode" class="id-qr"></div>
          </div>
          <div class="id-footer">Official Student ID</div>
        </div>
        <button class="btn" onclick="window.print()">🖨️ Print ID Card</button>
      </div>
    </div>

    <div class="card" style="margin-top:20px;">
      <h3>📢 Organization Announcements</h3>
      ${anns.rows.map(a => `<div style="border-bottom:1px solid #e2e8f0; padding:10px 0;"><h4>${a.title}</h4><p>${a.message}</p><small>${a.posted_date}</small></div>`).join('')}
    </div>

    <script>
      QRCode.toCanvas(document.getElementById('qrcode'), '${m.qr_token}', { width: 130 }, function (error) {
        if (error) console.error(error);
      });
    </script>
  `;
  res.send(await renderLayout('Member Portal', content, req.session.user, 'portal'));
});

app.get('/member-portal/attendance', requireAuth('member'), async (req, res) => {
  const memRes = await pool.query('SELECT id FROM members WHERE user_id = $1', [req.session.user.id]);
  if (memRes.rows.length === 0) return res.status(404).send('Member not found');
  const memberId = memRes.rows[0].id;

  const att = await pool.query(`
    SELECT a.*, e.name as event_name FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.member_id = $1 ORDER BY a.attendance_date DESC
  `, [memberId]);

  const content = `
    <h2>My Attendance History</h2>
    <div class="card">
      <table>
        <thead><tr><th>Date</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
        <tbody>
          ${att.rows.map(r => `
            <tr>
              <td>${r.attendance_date}</td>
              <td><b>${r.event_name}</b></td>
              <td>${r.time_in || '-'}</td>
              <td>${r.time_out || '-'}</td>
              <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(await renderLayout('My Attendance', content, req.session.user, 'portal-attendance'));
});

// Root route redirect
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'admin') return res.redirect('/admin');
  if (req.session.user.role === 'scanner') return res.redirect('/scanner');
  return res.redirect('/member-portal');
});

// Start Server listening on 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running and listening on port ${PORT}`);
});
