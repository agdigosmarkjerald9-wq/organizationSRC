/**
 * ClubTrack QR Attendance System
 * Complete single-file Express application backed by PostgreSQL
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool Setup supporting standard connection strings or individual parameters
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'clubtrack_db',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        port: process.env.PGPORT || 5432
      }
);

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'clubtrack-secure-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // set secure: true if using HTTPS production
  })
);

// --- DATABASE INITIALIZATION ---
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name VARCHAR(255) DEFAULT 'ABC High School',
        org_name VARCHAR(255) DEFAULT 'Supreme Student Council',
        school_year VARCHAR(50) DEFAULT '2026–2027',
        org_description VARCHAR(500) DEFAULT 'Official student organization governance system.',
        theme_color VARCHAR(50) DEFAULT '#4f46e5',
        org_logo TEXT DEFAULT '',
        id_prefix VARCHAR(50) DEFAULT 'SSC'
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL, -- 'admin', 'scanner', 'member'
        full_name VARCHAR(255) NOT NULL,
        must_change_password BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        member_id VARCHAR(100) UNIQUE NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        middle_name VARCHAR(100),
        last_name VARCHAR(100) NOT NULL,
        gender VARCHAR(20),
        grade_level VARCHAR(50) NOT NULL,
        section VARCHAR(50) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        contact_info VARCHAR(100),
        email VARCHAR(150),
        profile_photo TEXT,
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
        end_time TIME NOT NULL,
        late_cutoff TIME NOT NULL,
        status VARCHAR(20) DEFAULT 'upcoming'
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL,
        time_in TIME,
        time_out TIME,
        status VARCHAR(50) DEFAULT 'Present', -- Present, Late, Missing Time Out
        scan_method VARCHAR(20) DEFAULT 'QR', -- QR, MANUAL
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        date_posted TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expiration_date DATE
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_identifier VARCHAR(150),
        role VARCHAR(50),
        action VARCHAR(150),
        details TEXT
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        scanner_user VARCHAR(100),
        event_id INTEGER,
        scan_type VARCHAR(20),
        qr_value TEXT,
        result_status VARCHAR(50),
        message TEXT
      );
    `);

    // Seed default settings if empty
    const settingsCheck = await client.query('SELECT COUNT(*) FROM organization_settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_description, theme_color, id_prefix)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official Student Organization', '#4f46e5', 'SSC');
      `);
    }

    // Seed default admin if empty
    const adminCheck = await client.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
    if (parseInt(adminCheck.rows[0].count) === 0) {
      const hashedPass = await bcrypt.hash('admin123', 10);
      await client.query(
        `INSERT INTO users (username, password_hash, role, full_name, must_change_password) VALUES ($1, $2, $3, $4, $5)`,
        ['admin', hashedPass, 'admin', 'System Administrator', false]
      );
      console.log('Default admin account created: admin / admin123');
    }
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}
initializeDatabase();

// --- AUDIT LOGGER ---
async function logAction(req, action, details) {
  try {
    const userIdentifier = req.session.user ? req.session.user.username : 'Guest';
    const role = req.session.user ? req.session.user.role : 'unauthenticated';
    await pool.query(
      `INSERT INTO audit_logs (user_identifier, role, action, details) VALUES ($1, $2, $3, $4)`,
      [userIdentifier, role, action, details]
    );
  } catch (err) {
    console.error('Logging error:', err);
  }
}

// --- SHARED DESIGN LAYOUT & STYLES ---
function renderLayout(title, content, userRole, customStyles = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ClubTrack QR</title>
  <script src="https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
  <style>
    :root {
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --bg-main: #f8fafc;
      --card-bg: #ffffff;
      --text-main: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    body { background-color: var(--bg-main); color: var(--text-main); display: flex; min-height: 100vh; }
    
    /* Sidebar */
    aside { width: 260px; background: #0f172a; color: #fff; display: flex; flex-direction: column; position: fixed; height: 100vh; overflow-y: auto; z-index: 100; }
    .brand { padding: 20px; font-size: 1.2rem; font-weight: bold; border-bottom: 1px solid #1e293b; display: flex; align-items: center; gap: 10px; color: #818cf8; }
    .nav-links { list-style: none; padding: 20px 10px; flex: 1; }
    .nav-links li { margin-bottom: 8px; }
    .nav-links a { display: flex; align-items: center; gap: 12px; padding: 12px 16px; color: #94a3b8; text-decoration: none; border-radius: 8px; transition: 0.2s; font-size: 0.95rem; }
    .nav-links a:hover, .nav-links a.active { background: #1e293b; color: #fff; }
    
    /* Main Content Wrapper */
    .main-content { margin-left: 260px; flex: 1; display: flex; flex-direction: column; }
    header { background: #fff; padding: 15px 30px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .user-badge { font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: 10px; }
    
    .container { padding: 30px; flex: 1; max-width: 1400px; width: 100%; margin: 0 auto; }
    
    /* Cards & Grids */
    .card { background: var(--card-bg); border-radius: 12px; border: 1px solid var(--border); padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-bottom: 24px; }
    .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 24px; }
    .stat-card { background: #fff; border-radius: 12px; padding: 20px; border: 1px solid var(--border); box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
    .stat-card h3 { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .stat-card .value { font-size: 1.8rem; font-weight: bold; color: var(--text-main); }
    
    /* Tables & Forms */
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.95rem; }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: #f8fafc; font-weight: 600; color: var(--text-muted); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.5px; }
    
    .btn { background: var(--primary); color: #white; padding: 10px 18px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-size: 0.9rem; transition: background 0.2s; }
    .btn:hover { background: var(--primary-hover); }
    .btn-danger { background: var(--danger); }
    .btn-danger:hover { background: #dc2626; }
    .btn-success { background: var(--success); }
    .btn-success:hover { background: #059669; }
    .btn-secondary { background: #e2e8f0; color: #334155; }
    .btn-secondary:hover { background: #cbd5e1; }
    
    input, select, textarea { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; outline: none; margin-top: 6px; margin-bottom: 16px; }
    input:focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1); }
    
    label { font-weight: 600; font-size: 0.9rem; color: var(--text-main); display: block; }
    .badge { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; display: inline-block; }
    .badge-active, .badge-Present { background: #d1fae5; color: #065f46; }
    .badge-Late { background: #fef3c7; color: #92400e; }
    .badge-inactive, .badge-Missing { background: #fee2e2; color: #991b1b; }

    /* Print styles */
    @media print {
      aside, header, .no-print { display: none !important; }
      .main-content { margin: 0 !important; }
      body { background: #fff !important; }
      .card { border: none !important; box-shadow: none !important; padding: 0 !important; }
    }
    ${customStyles}
  </style>
</head>
<body>
  ${userRole ? renderSidebar(userRole) : ''}
  <div class="main-content" ${!userRole ? 'style="margin-left:0;"' : ''}>
    ${userRole ? `<header><div class="user-badge"><span>ClubTrack System</span></div><div><a href="/logout" class="btn btn-secondary" style="padding:6px 12px; font-size:0.85rem;">Logout</a></div></header>` : ''}
    <div class="container">
      ${content}
    </div>
  </div>
</body>
</html>`;
}

function renderSidebar(role) {
  let links = '';
  if (role === 'admin') {
    links = `
      <li><a href="/admin/dashboard">Dashboard</a></li>
      <li><a href="/admin/members">Manage Members</a></li>
      <li><a href="/admin/scanner-portal" target="_blank">QR Scanner Terminal ↗</a></li>
      <li><a href="/admin/attendance">Live Attendance</a></li>
      <li><a href="/admin/events">Events Management</a></li>
      <li><a href="/admin/announcements">Announcements</a></li>
      <li><a href="/admin/reports">Reports & Export</a></li>
      <li><a href="/admin/scanners">Scanner Accounts</a></li>
      <li><a href="/admin/settings">Org Settings</a></li>
      <li><a href="/admin/logs">System Audit Logs</a></li>
    `;
  } else if (role === 'scanner') {
    links = `
      <li><a href="/scanner/terminal" class="active">Scanner Portal</a></li>
      <li><a href="/scanner/activity">Today's Activity</a></li>
    `;
  } else if (role === 'member') {
    links = `
      <li><a href="/member/portal">My Profile & ID</a></li>
      <li><a href="/member/attendance">My Attendance Record</a></li>
      <li><a href="/member/announcements">Announcements</a></li>
      <li><a href="/member/settings">Account Security</a></li>
    `;
  }
  return `
    <aside class="no-print">
      <div class="brand">
        <span>🛡️ ClubTrack QR</span>
      </div>
      <ul class="nav-links">
        ${links}
      </ul>
    </aside>
  `;
}

// --- AUTHENTICATION & SECURITY MIDDLEWARES ---
function requireAuth(roleRequired) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (roleRequired && req.session.user.role !== roleRequired && req.session.user.role !== 'admin') {
      return res.status(403).send('Access Denied: Insufficient Privileges.');
    }
    // Check if member must change password
    if (req.session.user.must_change_password && req.path !== '/member/force-password-change') {
      return res.redirect('/member/force-password-change');
    }
    next();
  };
}

// --- ROUTES: AUTHENTICATION ---
app.get('/login', (req, res) => {
  res.send(renderLayout('Login', `
    <div style="max-width: 400px; margin: 60px auto;">
      <div class="card">
        <h2 style="margin-bottom: 6px; color: var(--primary);">ClubTrack Login</h2>
        <p style="color: var(--text-muted); margin-bottom: 24px; font-size: 0.9rem;">Organization & Club Attendance Management</p>
        <form action="/login" method="POST">
          <label>Username</label>
          <input type="text" name="username" required placeholder="Enter username">
          <label>Password</label>
          <input type="password" name="password" required placeholder="Enter password">
          <button type="submit" class="btn" style="width:100%; margin-top: 10px;">Sign In</button>
        </form>
      </div>
    </div>
  `, null));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.redirect('/login?error=InvalidCredentials');
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.redirect('/login?error=InvalidCredentials');

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      must_change_password: user.must_change_password
    };

    await logAction(req, 'User Login', `Successfully logged in as ${user.role}`);

    if (user.role === 'admin') res.redirect('/admin/dashboard');
    else if (user.role === 'scanner') res.redirect('/scanner/terminal');
    else if (user.role === 'member') {
      if (user.must_change_password) res.redirect('/member/force-password-change');
      else res.redirect('/member/portal');
    } else {
      res.redirect('/login');
    }
  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/login?error=Server');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', (req, res) => {
  res.redirect('/login');
});

// --- ROUTES: ADMIN PORTAL ---
app.get('/admin/dashboard', requireAuth('admin'), async (req, res) => {
  try {
    const counts = await Promise.all([
      pool.query('SELECT COUNT(*) FROM members'),
      pool.query("SELECT COUNT(*) FROM members WHERE status = 'active'"),
      pool.query('SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date = CURRENT_DATE'),
      pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = CURRENT_DATE AND time_in IS NOT NULL'),
      pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = CURRENT_DATE AND time_out IS NOT NULL'),
      pool.query("SELECT COUNT(*) FROM attendance WHERE attendance_date = CURRENT_DATE AND status = 'Late'"),
      pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result_status = 'INVALID'")
    ]);

    const stats = {
      totalMembers: counts[0].rows[0].count,
      activeMembers: counts[1].rows[0].count,
      presentToday: counts[2].rows[0].count,
      timeInToday: counts[3].rows[0].count,
      timeOutToday: counts[4].rows[0].count,
      lateToday: counts[5].rows[0].count,
      invalidScans: counts[6].rows[0].count
    };

    const recentAttendance = await pool.query(`
      fn => SELECT a.*, m.first_name, m.last_name, m.member_id AS m_code, e.event_name 
      FROM attendance a 
      JOIN members m ON a.member_id = m.id 
      JOIN events e ON a.event_id = e.id 
      ORDER BY a.created_at DESC LIMIT 10
    `).catch(() => pool.query(`
      SELECT a.*, m.first_name, m.last_name, m.member_id AS m_code, e.event_name 
      FROM attendance a 
      JOIN members m ON a.member_id = m.id 
      JOIN events e ON a.event_id = e.id 
      ORDER BY a.created_at DESC LIMIT 10
    `));

    let html = `
      <h1 style="margin-bottom: 24px;">Admin Dashboard</h1>
      <div class="grid-4">
        <div class="stat-card"><h3>Total Members</h3><div class="value">${stats.totalMembers}</div></div>
        <div class="stat-card"><h3>Active Members</h3><div class="value" style="color:var(--success);">${stats.activeMembers}</div></div>
        <div class="stat-card"><h3>Present Today</h3><div class="value" style="color:var(--primary);">${stats.presentToday}</div></div>
        <div class="stat-card"><h3>Time-Ins Today</h3><div class="value">${stats.timeInToday}</div></div>
        <div class="stat-card"><h3>Time-Outs Today</h3><div class="value">${stats.timeOutToday}</div></div>
        <div class="stat-card"><h3>Late Today</h3><div class="value" style="color:var(--warning);">${stats.lateToday}</div></div>
        <div class="stat-card"><h3>Invalid QR Scans</h3><div class="value" style="color:var(--danger);">${stats.invalidScans}</div></div>
      </div>

      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3>Live Attendance Stream (Today)</h3>
          <a href="/admin/scanner-portal" target="_blank" class="btn">Launch QR Scanner Terminal</a>
        </div>
        <table>
          <thead>
            <tr>
              <th>Member ID</th>
              <th>Full Name</th>
              <th>Event</th>
              <th>Time In</th>
              <th>Time Out</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${recentAttendance.rows.length === 0 ? '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No attendance recorded for today yet.</td></tr>' : 
              recentAttendance.rows.map(r => `
                <tr>
                  <td>${r.m_code}</td>
                  <td>${r.first_name} ${r.last_name}</td>
                  <td>${r.event_name}</td>
                  <td>${r.time_in || '-'}</td>
                  <td>${r.time_out || '-'}</td>
                  <td><span class="badge badge-${r.status}">${r.status}</span></td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
    res.send(renderLayout('Admin Dashboard', html, 'admin'));
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

// MEMBERS MANAGEMENT
app.get('/admin/members', requireAuth('admin'), async (req, res) => {
  try {
    const search = req.query.search || '';
    const queryStr = search 
      ? `SELECT * FROM members WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR member_id ILIKE $1 ORDER BY last_name ASC`
      : `SELECT * FROM members ORDER BY last_name ASC`;
    const members = await pool.query(queryStr, search ? [`%${search}%`] : []);

    let html = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
        <h1>Manage Members</h1>
        <div style="display:flex; gap:10px;">
          <a href="/admin/members/add" class="btn">+ Register New Member</a>
        </div>
      </div>

      <div class="card">
        <form method="GET" style="display:flex; gap:10px; margin-bottom:20px;">
          <input type="text" name="search" value="${search}" placeholder="Search by name or ID..." style="margin:0;">
          <button type="submit" class="btn">Search</button>
          ${search ? '<a href="/admin/members" class="btn btn-secondary">Reset</a>' : ''}
        </form>

        <table>
          <thead>
            <tr>
              <th>Member ID</th>
              <th>Name</th>
              <th>Grade & Section</th>
              <th>Position</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${members.rows.length === 0 ? '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No members found.</td></tr>' :
              members.rows.map(m => `
                <tr>
                  <td><strong>${m.member_id}</strong></td>
                  <td>${m.first_name} ${m.last_name}</td>
                  <td>${m.grade_level} - ${m.section}</td>
                  <td>${m.position}</td>
                  <td><span class="badge badge-${m.status}">${m.status}</span></td>
                  <td>
                    <a href="/admin/members/id/${m.id}" class="btn" style="padding:6px 10px; font-size:0.8rem;" target="_blank">View ID</a>
                    <a href="/admin/members/edit/${m.id}" class="btn btn-secondary" style="padding:6px 10px; font-size:0.8rem;">Edit</a>
                    <form action="/admin/members/delete/${m.id}" method="POST" style="display:inline;" onsubmit="return confirm('Are you sure you want to delete this member?');">
                      <button type="submit" class="btn btn-danger" style="padding:6px 10px; font-size:0.8rem;">Delete</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `;
    res.send(renderLayout('Manage Members', html, 'admin'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading members');
  }
});

// ADD MEMBER FORM
app.get('/admin/members/add', requireAuth('admin'), async (req, res) => {
  const settings = await pool.query('SELECT id_prefix FROM organization_settings LIMIT 1');
  const prefix = settings.rows[0]?.id_prefix || 'SSC';
  
  let html = `
    <h1>Register New Member</h1>
    <div class="card" style="max-width: 800px; margin-top:20px;">
      <form action="/admin/members/add" method="POST">
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
          <div>
            <label>First Name</label>
            <input type="text" name="first_name" required>
          </div>
          <div>
            <label>Middle Name (Optional)</label>
            <input type="text" name="middle_name">
          </div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
          <div>
            <label>Last Name</label>
            <input type="text" name="last_name" required>
          </div>
          <div>
            <label>Gender</label>
            <select name="gender">
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
          <div>
            <label>Grade Level</label>
            <input type="text" name="grade_level" placeholder="e.g. Grade 10" required>
          </div>
          <div>
            <label>Section</label>
            <input type="text" name="section" placeholder="e.g. Rizal" required>
          </div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
          <div>
            <label>Position</label>
            <input type="text" name="position" value="Member" required>
          </div>
          <div>
            <label>Contact Number / Email</label>
            <input type="text" name="contact_info" placeholder="Optional">
          </div>
        </div>
        <button type="submit" class="btn" style="margin-top:20px;">Register Member & Generate Credentials</button>
      </form>
    </div>
  `;
  res.send(renderLayout('Add Member', html, 'admin'));
});

app.post('/admin/members/add', requireAuth('admin'), async (req, res) => {
  const { first_name, middle_name, last_name, gender, grade_level, section, position, contact_info } = req.body;
  try {
    const settings = await pool.query('SELECT id_prefix FROM organization_settings LIMIT 1');
    const prefix = settings.rows[0]?.id_prefix || 'SSC';
    const year = new Date().getFullYear();

    // Generate unique Member ID
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seq = parseInt(countRes.rows[0].count) + 1;
    const member_id = `${prefix}-${year}-${String(seq).padStart(4, '0')}`;

    // Generate unique Username
    let baseUsername = (first_name + last_name).toLowerCase().replace(/[^a-z0-9]/g, '');
    let username = baseUsername;
    let uCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    let suffix = 1;
    while (uCheck.rows.length > 0) {
      username = `${baseUsername}${suffix}`;
      uCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      suffix++;
    }

    // Generate Temporary Password
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    // Create User account
    const userResult = await pool.query(
      `INSERT INTO users (username, password_hash, role, full_name, must_change_password) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [username, passwordHash, 'member', `${first_name} ${last_name}`, true]
    );
    const userId = userResult.rows[0].id;

    // Create QR Token
    const qrToken = `CLUBTRACK:MEMBER:${crypto.randomUUID()}`;

    await pool.query(
      `INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, qr_token, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')`,
      [userId, member_id, first_name, middle_name || '', last_name, gender, grade_level, section, position, contact_info, qrToken]
    );

    await logAction(req, 'Member Registration', `Registered member ${member_id} - ${first_name} ${last_name}`);

    // Show secure temporary credentials page
    let html = `
      <div class="card" style="max-width: 600px; margin: 40px auto; border-left: 6px solid var(--success);">
        <h2 style="color: var(--success); margin-bottom: 10px;">✓ Member Successfully Registered</h2>
        <p style="color: var(--text-muted); margin-bottom: 20px;">Please give these credentials securely to the member. The temporary password will not be shown again.</p>
        
        <div style="background:#f8fafc; padding:20px; border-radius:8px; margin-bottom:20px;">
          <p><strong>Full Name:</strong> ${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}</p>
          <p><strong>Member ID:</strong> ${member_id}</p>
          <p><strong>Username:</strong> <code>${username}</code></p>
          <p><strong>Temporary Password:</strong> <code style="font-size:1.2rem; color:var(--danger);">${tempPassword}</code></p>
        </div>

        <div style="display:flex; gap:10px;">
          <a href="/admin/members" class="btn">Back to Members</a>
          <button onclick="window.print();" class="btn btn-secondary">Print Credentials</button>
        </div>
      </div>
    `;
    res.send(renderLayout('Registration Successful', html, 'admin'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error registering member: ' + err.message);
  }
});

// VIEW MEMBER ID CARD
app.get('/admin/members/id/:id', requireAuth('admin'), async (req, res) => {
  try {
    const memberRes = await pool.query(`
      SELECT m.*, o.* FROM members m 
      CROSS JOIN organization_settings o 
      WHERE m.id = $1
    `, [req.params.id]);

    if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
    const m = memberRes.rows[0];

    const qrDataUrl = await QRCode.toDataURL(m.qr_token, { width: 250 });

    let html = `
      <div style="display:flex; justify-content:space-between; margin-bottom:20px;" class="no-print">
        <h1>Member Digital ID Card</h1>
        <button onclick="window.print();" class="btn">Print ID Card</button>
      </div>

      <div style="display:flex; justify-content:center;">
        <div style="width: 360px; background: #fff; border: 2px solid #cbd5e1; border-radius: 16px; padding: 24px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.1); position:relative;">
          <h4 style="font-size: 0.85rem; color: #64748b; text-transform: uppercase;">${m.school_name}</h4>
          <h3 style="font-size: 1.1rem; color: var(--primary); margin-bottom: 12px;">${m.org_name}</h3>
          
          <div style="background: #f1f5f9; width: 100px; height: 100px; border-radius: 50%; margin: 0 auto 12px auto; display: flex; align-items: center; justify-content: center; font-size: 2.5rem; color: #94a3b8; border: 2px solid #e2e8f0;">
            👤
          </div>

          <h2 style="font-size: 1.3rem; margin-bottom: 4px;">${m.first_name} ${m.last_name}</h2>
          <p style="font-size: 0.9rem; font-weight: bold; color: var(--text-muted); margin-bottom: 16px;">${m.position}</p>

          <div style="text-align: left; background: #f8fafc; padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; margin-bottom: 16px; border: 1px solid #e2e8f0;">
            <p><strong>ID Number:</strong> ${m.member_id}</p>
            <p><strong>Grade/Sec:</strong> ${m.grade_level} - ${m.section}</p>
            <p><strong>Username:</strong> ${m.user_id ? 'Active' : '-'}</p>
          </div>

          <img src="${qrDataUrl}" alt="QR Code" style="width: 140px; height: 140px; margin-bottom: 8px;">
          <p style="font-size: 0.7rem; color: #94a3b8;">Official Organization Identification Card</p>
        </div>
      </div>
    `;
    res.send(renderLayout('Member ID Card', html, 'admin'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating ID card');
  }
});

// DELETE MEMBER
app.post('/admin/members/delete/:id', requireAuth('admin'), async (req, res) => {
  try {
    const member = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (member.rows.length > 0) {
      await pool.query('DELETE FROM users WHERE id = $1', [member.rows[0].user_id]);
      await logAction(req, 'Member Deletion', `Deleted member ${member.rows[0].member_id}`);
    }
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting member');
  }
});

// EVENTS MANAGEMENT
app.get('/admin/events', requireAuth('admin'), async (req, res) => {
  const events = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
  let html = `
    <h1>Events Management</h1>
    <div class="card" style="margin-top:20px;">
      <h3>Create New Attendance Event</h3>
      <form action="/admin/events" method="POST" style="margin-top:15px;">
        <label>Event Name</label>
        <input type="text" name="event_name" required placeholder="e.g. Monthly General Assembly">
        <label>Description</label>
        <textarea name="description" rows="2"></textarea>
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:15px;">
          <div><label>Date</label><input type="date" name="event_date" required></div>
          <div><label>Start Time</label><input type="time" name="start_time" required></div>
          <div><label>Late Cutoff Time</label><input type="time" name="late_cutoff" required></div>
        </div>
        <button type="submit" class="btn" style="margin-top:15px;">Create Event</button>
      </form>
    </div>

    <div class="card">
      <h3>Existing Events</h3>
      <table>
        <thead>
          <tr>
            <th>Event Name</th>
            <th>Date</th>
            <th>Start Time</th>
            <th>Late Cutoff</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${events.rows.length === 0 ? '<tr><td colspan="5" style="text-align:center;">No events created yet.</td></tr>' :
            events.rows.map(e => `
              <tr>
                <td><strong>${e.event_name}</strong></td>
                <td>${e.event_date}</td>
                <td>${e.start_time}</td>
                <td>${e.late_cutoff}</td>
                <td><span class="badge badge-active">${e.status}</span></td>
              </tr>
            `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(renderLayout('Events Management', html, 'admin'));
});

app.post('/admin/events', requireAuth('admin'), async (req, res) => {
  const { event_name, description, event_date, start_time, late_cutoff } = req.body;
  try {
    await pool.query(
      `INSERT INTO events (event_name, description, event_date, start_time, end_time, late_cutoff, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [event_name, description, event_date, start_time, '17:00:00', late_cutoff, 'upcoming']
    );
    await logAction(req, 'Event Creation', `Created event: ${event_name}`);
    res.redirect('/admin/events');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating event');
  }
});

// ANNOUNCEMENTS
app.get('/admin/announcements', requireAuth('admin'), async (req, res) => {
  const announcements = await pool.query('SELECT * FROM announcements ORDER BY date_posted DESC');
  let html = `
    <h1>Announcement System</h1>
    <div class="card" style="margin-top:20px;">
      <form action="/admin/announcements" method="POST">
        <label>Title</label>
        <input type="text" name="title" required>
        <label>Message</label>
        <textarea name="message" rows="4" required></textarea>
        <button type="submit" class="btn">Post Announcement</button>
      </form>
    </div>

    <div class="card">
      <h3>Posted Announcements</h3>
      ${announcements.rows.map(a => `
        <div style="border-bottom:1px solid var(--border); padding:15px 0;">
          <h4 style="color:var(--primary);">${a.title}</h4>
          <p style="margin:6px 0;">${a.message}</p>
          <small style="color:var(--text-muted);">Posted on: ${a.date_posted}</small>
        </div>
      `).join('')}
    </div>
  `;
  res.send(renderLayout('Announcements', html, 'admin'));
});

app.post('/admin/announcements', requireAuth('admin'), async (req, res) => {
  const { title, message } = req.body;
  await pool.query('INSERT INTO announcements (title, message) VALUES ($1, $2)', [title, message]);
  await logAction(req, 'Announcement', `Posted announcement: ${title}`);
  res.redirect('/admin/announcements');
});

// SYSTEM SETTINGS
app.get('/admin/settings', requireAuth('admin'), async (req, res) => {
  const settings = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const s = settings.rows[0] || {};
  let html = `
    <h1>Organization Settings</h1>
    <div class="card" style="max-width:700px; margin-top:20px;">
      <form action="/admin/settings" method="POST">
        <label>School Name</label>
        <input type="text" name="school_name" value="${s.school_name || ''}" required>
        <label>Organization Name</label>
        <input type="text" name="org_name" value="${s.org_name || ''}" required>
        <label>School Year</label>
        <input type="text" name="school_year" value="${s.school_year || ''}" required>
        <label>Member ID Prefix</label>
        <input type="text" name="id_prefix" value="${s.id_prefix || 'SSC'}" required>
        <label>Organization Description</label>
        <textarea name="org_description" rows="3">${s.org_description || ''}</textarea>
        <button type="submit" class="btn">Save Settings</button>
      </form>
    </div>
  `;
  res.send(renderLayout('Settings', html, 'admin'));
});

app.post('/admin/settings', requireAuth('admin'), async (req, res) => {
  const { school_name, org_name, school_year, id_prefix, org_description } = req.body;
  await pool.query(
    `UPDATE organization_settings SET school_name = $1, org_name = $2, school_year = $3, id_prefix = $4, org_description = $5`,
    [school_name, org_name, school_year, id_prefix, org_description]
  );
  await logAction(req, 'Settings Update', 'Updated organization settings');
  res.redirect('/admin/settings');
});

// REPORTS & CSV EXPORT
app.get('/admin/reports', requireAuth('admin'), async (req, res) => {
  const format = req.query.format;
  if (format === 'csv') {
    const reportData = await pool.query(`
      SELECT m.member_id, m.first_name, m.last_name, m.grade_level, m.section, e.event_name, a.attendance_date, a.time_in, a.time_out, a.status
      FROM attendance a
      JOIN members m ON a.member_id = m.id
      JOIN events e ON a.event_id = e.id
      ORDER BY a.attendance_date DESC
    `);
    let csv = 'Member ID,First Name,Last Name,Grade,Section,Event,Date,Time In,Time Out,Status\n';
    reportData.rows.forEach(r => {
      csv += `"${r.member_id}","${r.first_name}","${r.last_name}","${r.grade_level}","${r.section}","${r.event_name}","${r.attendance_date}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.csv"');
    return res.send(csv);
  }

  let html = `
    <h1>Attendance Reports & Export</h1>
    <div class="card" style="margin-top:20px;">
      <h3>Export Data</h3>
      <p style="color:var(--text-muted); margin: 10px 0 20px 0;">Download full system attendance logs in CSV format for spreadsheet processing.</p>
      <a href="/admin/reports?format=csv" class="btn">Download Full CSV Report</a>
    </div>
  `;
  res.send(renderLayout('Reports', html, 'admin'));
});

// AUDIT LOGS
app.get('/admin/logs', requireAuth('admin'), async (req, res) => {
  const logs = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 50');
  let html = `
    <h1>System Audit Logs</h1>
    <div class="card" style="margin-top:20px;">
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>User</th>
            <th>Role</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          ${logs.rows.map(l => `
            <tr>
              <td>${l.timestamp}</td>
              <td><strong>${l.user_identifier}</strong></td>
              <td><span class="badge badge-active">${l.role}</span></td>
              <td>${l.action}</td>
              <td>${l.details}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(renderLayout('Audit Logs', html, 'admin'));
});

// SCANNER MANAGEMENT FOR ADMIN
app.get('/admin/scanners', requireAuth('admin'), async (req, res) => {
  const scanners = await pool.query("SELECT * FROM users WHERE role = 'scanner'");
  let html = `
    <h1>Scanner Accounts Management</h1>
    <div class="card" style="margin-top:20px;">
      <h3>Create Scanner Account</h3>
      <form action="/admin/scanners" method="POST" style="margin-top:15px;">
        <label>Full Name / Identifier</label>
        <input type="text" name="full_name" required placeholder="e.g. Officer Maria Santos">
        <label>Username</label>
        <input type="text" name="username" required placeholder="e.g. scanner_maria">
        <label>Password</label>
        <input type="password" name="password" required>
        <button type="submit" class="btn">Create Scanner Account</button>
      </form>
    </div>

    <div class="card">
      <h3>Active Scanner Accounts</h3>
      <table>
        <thead>
          <tr><th>Username</th><th>Name</th><th>Created</th></tr>
        </thead>
        <tbody>
          ${scanners.rows.map(s => `<tr><td><strong>${s.username}</strong></td><td>${s.full_name}</td><td>${s.created_at}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(renderLayout('Scanner Accounts', html, 'admin'));
});

app.post('/admin/scanners', requireAuth('admin'), async (req, res) => {
  const { username, password, full_name } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (username, password_hash, role, full_name) VALUES ($1, $2, $3, $4)', [username, hash, 'scanner', full_name]);
  await logAction(req, 'Scanner Account Created', `Created scanner account: ${username}`);
  res.redirect('/admin/scanners');
});


// --- ROUTES: SCANNER PORTAL (Dedicated Standalone Terminal) ---
app.get('/admin/scanner-portal', requireAuth(), async (req, res) => {
  res.redirect('/scanner/terminal');
});

app.get('/scanner/terminal', requireAuth(), async (req, res) => {
  const events = await pool.query("SELECT * FROM events ORDER BY event_date DESC");
  let html = `
    <div style="max-width: 600px; margin: 0 auto; text-align: center;">
      <h2 style="color:var(--primary); margin-bottom: 5px;">📱 ClubTrack QR Terminal</h2>
      <p style="color:var(--text-muted); margin-bottom: 20px;">Dedicated Attendance Scanning Portal</p>

      <div class="card" style="text-align: left;">
        <label>1. Select Attendance Event</label>
        <select id="eventSelect" style="font-size: 1.1rem; padding: 12px;">
          ${events.rows.map(e => `<option value="${e.id}">${e.event_name} (${e.event_date})</option>`).join('')}
        </select>

        <label style="margin-top: 15px;">2. Select Scan Type</label>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px;">
          <button type="button" id="btnTimeIn" class="btn btn-success" onclick="setScanType('TIME_IN')" style="padding: 16px; font-size: 1.1rem;">TIME IN</button>
          <button type="button" id="btnTimeOut" class="btn btn-secondary" onclick="setScanType('TIME_OUT')" style="padding: 16px; font-size: 1.1rem;">TIME OUT</button>
        </div>

        <label style="margin-top: 15px;">Audio Feedback</label>
        <button type="button" id="audioToggle" onclick="toggleAudio()" class="btn btn-secondary" style="width: 100%;">🔊 Sound: ON</button>

        <button type="button" class="btn" onclick="startScanner()" style="width: 100%; margin-top: 20px; padding: 14px; font-size: 1.1rem;">START CAMERA SCANNER</button>
      </div>

      <div id="scannerContainer" style="display: none;" class="card">
        <div id="reader" style="width: 100%;"></div>
        <button onclick="stopScanner()" class="btn btn-danger" style="margin-top: 15px; width: 100%;">Stop Camera</button>
      </div>

      <div id="scanResult" style="margin-top: 20px;"></div>
    </div>

    <audio id="successSound" src="https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3" preload="auto"></audio>
    <audio id="errorSound" src="https://assets.mixkit.co/active_storage/sfx/2870/2870-preview.mp3" preload="auto"></audio>

    <script>
      let currentScanType = 'TIME_IN';
      let html5QrCode = null;
      let soundEnabled = true;

      function setScanType(type) {
        currentScanType = type;
        if(type === 'TIME_IN') {
          document.getElementById('btnTimeIn').className = 'btn btn-success';
          document.getElementById('btnTimeOut').className = 'btn btn-secondary';
        } else {
          document.getElementById('btnTimeIn').className = 'btn btn-secondary';
          document.getElementById('btnTimeOut').className = 'btn btn-success';
        }
      }

      function toggleAudio() {
        soundEnabled = !soundEnabled;
        document.getElementById('audioToggle').innerText = soundEnabled ? '🔊 Sound: ON' : '🔇 Sound: OFF';
      }

      function playSound(type) {
        if (!soundEnabled) return;
        try {
          if (type === 'success') document.getElementById('successSound').play();
          else document.getElementById('errorSound').play();
        } catch(e) { console.log(e); }
      }

      function startScanner() {
        document.getElementById('scannerContainer').style.display = 'block';
        html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          async (decodedText) => {
            await handleScan(decodedText);
          },
          (error) => {}
        ).catch(err => {
          alert("Camera initialization error: " + err);
        });
      }

      function stopScanner() {
        if(html5QrCode) {
          html5QrCode.stop().then(() => {
            document.getElementById('scannerContainer').style.display = 'none';
          }).catch(err => console.log(err));
        }
      }

      async function handleScan(qrToken) {
        const eventId = document.getElementById('eventSelect').value;
        try {
          const res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: qrToken, event_id: eventId, scan_type: currentScanType })
          });
          const data = await res.json();
          const resBox = document.getElementById('scanResult');
          
          if(data.success) {
            playSound('success');
            resBox.innerHTML = \`<div class="card" style="border-left: 6px solid var(--success); background:#f0fdf4; text-align:left;">
              <h3 style="color:var(--success);">✓ \${data.message}</h3>
              <p style="font-size:1.2rem; font-weight:bold; margin-top:10px;">\${data.member.name}</p>
              <p>ID: \${data.member.member_id} | \${data.member.grade} - \${data.member.section}</p>
              <p style="margin-top:8px; font-weight:bold; color:var(--primary);">Time: \${data.time}</p>
            </div>\`;
          } else {
            playSound('error');
            resBox.innerHTML = \`<div class="card" style="border-left: 6px solid var(--danger); background:#fef2f2; text-align:left;">
              <h3 style="color:var(--danger);">⚠️ \${data.message}</h3>
              <p style="margin-top:6px;">\${data.details || ''}</p>
            </div>\`;
          }
        } catch(err) {
          console.error(err);
        }
      }
    </script>
  `;
  res.send(renderLayout('Scanner Terminal', html, req.session.user.role));
});

// SCAN API ENDPOINT
app.post('/api/scan', async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const currentTime = new Date().toTimeString().split(' ')[0];

  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      await pool.query('INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.user.username, event_id, scan_type, qr_token, 'INVALID', 'QR Code not registered']);
      return res.json({ success: false, message: 'QR CODE NOT REGISTERED', details: 'This QR code does not belong to any active member.' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'active') {
      return res.json({ success: false, message: 'ACCOUNT INACTIVE', details: 'Member account has been deactivated.' });
    }

    // Check existing attendance for event & date
    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, today]);

    if (scan_type === 'TIME_IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({ success: false, message: 'ALREADY TIMED IN', details: `${member.first_name} already recorded a Time In for this event.` });
      }

      // Check late cutoff against event
      const eventRes = await pool.query('SELECT late_cutoff FROM events WHERE id = $1', [event_id]);
      const cutoff = eventRes.rows[0]?.late_cutoff || '08:00:00';
      const status = currentTime > cutoff ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [currentTime, status, attRes.rows[0].id]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, $6)',
          [member.id, event_id, today, currentTime, status, 'QR']);
      }

      return res.json({
        success: true,
        message: 'TIME IN RECORDED',
        time: currentTime,
        member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id, grade: member.grade_level, section: member.section }
      });
    } else {
      // TIME OUT
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ success: false, message: 'MISSING TIME IN', details: 'Cannot record Time Out without a prior Time In.' });
      }
      if (attRes.rows.rows?.[0]?.time_out || attRes.rows[0].time_out) {
        return res.json({ success: false, message: 'ALREADY TIMED OUT', details: 'Time Out was already recorded for this member.' });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [currentTime, attRes.rows[0].id]);
      return res.json({
        success: true,
        message: 'TIME OUT RECORDED',
        time: currentTime,
        member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id, grade: member.grade_level, section: member.section }
      });
    }
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ success: false, message: 'Server Error during scan processing.' });
  }
});

app.get('/scanner/activity', requireAuth(), async (req, res) => {
  const activity = await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.member_id AS m_code, e.event_name 
    FROM attendance a 
    JOIN members m ON a.member_id = m.id 
    JOIN events e ON a.event_id = e.id 
    WHERE a.attendance_date = CURRENT_DATE 
    ORDER BY a.created_at DESC
  `);
  let html = `
    <h1>Today's Scanning Activity</h1>
    <div class="card" style="margin-top:20px;">
      <table>
        <thead>
          <tr><th>Member ID</th><th>Name</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${activity.rows.map(r => `<tr><td>${r.m_code}</td><td>${r.first_name} ${r.last_name}</td><td>${r.event_name}</td><td>${r.time_in || '-'}</td><td>${r.time_out || '-'}</td><td><span class="badge badge-${r.status}">${r.status}</span></td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(renderLayout("Today's Activity", html, req.session.user.role));
});


// --- ROUTES: MEMBER PORTAL ---
app.get('/member/force-password-change', requireAuth(), (req, res) => {
  let html = `
    <div style="max-width: 500px; margin: 40px auto;">
      <div class="card" style="border-left: 6px solid var(--warning);">
        <h2 style="color: var(--warning); margin-bottom: 10px;">⚠️ Security Password Reset Required</h2>
        <p style="color: var(--text-muted); margin-bottom: 20px;">Your account is currently using a temporary password provided by the administrator. Please update your password to continue.</p>
        
        <form action="/member/force-password-change" method="POST">
          <label>Current Temporary Password</label>
          <input type="password" name="current_password" required>
          <label>New Private Password</label>
          <input type="password" name="new_password" required placeholder="At least 8 characters">
          <label>Confirm New Password</label>
          <input type="password" name="confirm_password" required>
          <button type="submit" class="btn" style="width:100%; margin-top:10px;">Update Password & Secure Account</button>
        </form>
      </div>
    </div>
  `;
  res.send(renderLayout('Password Change Required', html, null));
});

app.post('/member/force-password-change', requireAuth(), async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (new_password !== confirm_password || new_password.length < 8) {
    return res.send('Passwords must match and be at least 8 characters long. <a href="/member/force-password-change">Back</a>');
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows[0];
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.send('Incorrect temporary password. <a href="/member/force-password-change">Back</a>');

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [newHash, user.id]);
    req.session.user.must_change_password = false;

    await logAction(req, 'Password Changed', 'Member updated temporary password successfully');
    res.redirect('/member/portal');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.get('/member/portal', requireAuth('member'), async (req, res) => {
  try {
    const memberRes = await pool.query(`
      SELECT m.*, o.* FROM members m 
      CROSS JOIN organization_settings o 
      WHERE m.user_id = $1
    `, [req.session.user.id]);

    if (memberRes.rows.length === 0) return res.status(404).send('Member record not found.');
    const m = memberRes.rows[0];
    const qrDataUrl = await QRCode.toDataURL(m.qr_token, { width: 220 });

    let html = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
        <h1>Member Portal</h1>
        <button onclick="window.print();" class="btn no-print">Print Digital ID Card</button>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 24px;">
        <div class="card" style="text-align:center;">
          <div style="background:#f1f5f9; width: 90px; height: 90px; border-radius: 50%; margin: 0 auto 12px auto; display:flex; align-items:center; justify-content:center; font-size: 2.2rem;">👤</div>
          <h3>${m.first_name} ${m.last_name}</h3>
          <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:15px;">${m.position}</p>
          <img src="${qrDataUrl}" alt="QR Code" style="width: 180px; height: 180px; margin-bottom: 10px;">
          <p style="font-size:0.8rem; color:var(--text-muted);">Unique Secure QR Token</p>
        </div>

        <div class="card">
          <h3>Profile & Membership Details</h3>
          <table style="margin-top:15px;">
            <tr><td><strong>Member ID:</strong></td><td>${m.member_id}</td></tr>
            <tr><td><strong>School Name:</strong></td><td>${m.school_name}</td></tr>
            <tr><td><strong>Organization:</strong></td><td>${m.org_name} (${m.school_year})</td></tr>
            <tr><td><strong>Grade & Section:</strong></td><td>${m.grade_level} - ${m.section}</td></tr>
            <tr><td><strong>Gender:</strong></td><td>${m.gender}</td></tr>
            <tr><td><strong>Contact Info:</strong></td><td>${m.contact_info || 'Not provided'}</td></tr>
            <tr><td><strong>Account Status:</strong></td><td><span class="badge badge-${m.status}">${m.status}</span></td></tr>
          </table>
        </div>
      </div>
    `;
    res.send(renderLayout('Member Portal', html, 'member'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading member portal');
  }
});

app.get('/member/attendance', requireAuth('member'), async (req, res) => {
  const memberRes = await pool.query('SELECT id FROM members WHERE user_id = $1', [req.session.user.id]);
  if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
  const memberId = memberRes.rows[0].id;

  const attendance = await pool.query(`
    SELECT a.*, e.event_name FROM attendance a 
    JOIN events e ON a.event_id = e.id 
    WHERE a.member_id = $1 
    ORDER BY a.attendance_date DESC
  `, [memberId]);

  let html = `
    <h1>My Attendance Records</h1>
    <div class="card" style="margin-top:20px;">
      <table>
        <thead>
          <tr><th>Date</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${attendance.rows.length === 0 ? '<tr><td colspan="5" style="text-align:center;">No attendance records found.</td></tr>' :
            attendance.rows.map(a => `<tr><td>${a.attendance_date}</td><td>${a.event_name}</td><td>${a.time_in || '-'}</td><td>${a.time_out || '-'}</td><td><span class="badge badge-${a.status}">${a.status}</span></td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(renderLayout('My Attendance', html, 'member'));
});

app.get('/member/announcements', requireAuth('member'), async (req, res) => {
  const announcements = await pool.query('SELECT * FROM announcements ORDER BY date_posted DESC');
  let html = `
    <h1>Announcements</h1>
    <div class="card" style="margin-top:20px;">
      ${announcements.rows.map(a => `
        <div style="border-bottom:1px solid var(--border); padding:15px 0;">
          <h3 style="color:var(--primary);">${a.title}</h3>
          <p style="margin:8px 0;">${a.message}</p>
          <small style="color:var(--text-muted);">Posted on: ${a.date_posted}</small>
        </div>
      `).join('')}
    </div>
  `;
  res.send(renderLayout('Announcements', html, 'member'));
});

app.get('/member/settings', requireAuth('member'), async (req, res) => {
  let html = `
    <h1>Account Security</h1>
    <div class="card" style="max-width:500px; margin-top:20px;">
      <form action="/member/settings" method="POST">
        <label>Current Password</label>
        <input type="password" name="current_password" required>
        <label>New Password</label>
        <input type="password" name="new_password" required>
        <label>Confirm New Password</label>
        <input type="password" name="confirm_password" required>
        <button type="submit" class="btn" style="margin-top:10px;">Change Password</button>
      </form>
    </div>
  `;
  res.send(renderLayout('Account Settings', html, 'member'));
});

app.post('/member/settings', requireAuth('member'), async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (new_password !== confirm_password || new_password.length < 8) {
    return res.send('Passwords do not match or are too short. <a href="/member/settings">Back</a>');
  }

  const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
  const user = userRes.rows[0];
  const match = await bcrypt.compare(current_password, user.password_hash);
  if (!match) return res.send('Incorrect current password. <a href="/member/settings">Back</a>');

  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
  await logAction(req, 'Password Update', 'Member changed account password');
  res.redirect('/member/portal');
});

// --- SERVER START ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
});
