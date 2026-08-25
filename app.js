/**
 * School Club QR Code Attendance Management System
 * Consolidated single-file Node.js/Express/PostgreSQL application.
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Connection Configuration (PostgreSQL)
// Supports Render's DATABASE_URL or local fallback connection string
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/club_attendance',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware Setup
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// Initialize PostgreSQL Database Schema & Default Admin Account
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Settings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        organization_name VARCHAR(255) DEFAULT 'School Club Organization',
        school_name VARCHAR(255) DEFAULT 'My Institution',
        logo TEXT DEFAULT '',
        school_year VARCHAR(50) DEFAULT '2025-2026',
        attendance_start VARCHAR(10) DEFAULT '08:00',
        grace_period INT DEFAULT 15,
        scanner_pin VARCHAR(50) DEFAULT '1234'
      );
    `);

    // 2. Admins Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Members Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        club VARCHAR(100) DEFAULT 'General Club',
        year_level VARCHAR(50),
        course VARCHAR(100),
        section VARCHAR(50),
        contact VARCHAR(50),
        email VARCHAR(100),
        photo TEXT,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        temporary_password_status BOOLEAN DEFAULT TRUE,
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        date_joined DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Attendance Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(50) NOT NULL,
        date DATE DEFAULT CURRENT_DATE,
        time_in TIME,
        time_out TIME,
        status VARCHAR(20) DEFAULT 'Present',
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Announcements Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. Audit Logs Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        actor VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed Default Settings if empty
    const settingsRes = await client.query('SELECT * FROM settings WHERE id = 1');
    if (settingsRes.rows.length === 0) {
      await client.query('INSERT INTO settings (id, organization_name, school_name) VALUES (1, $1, $2)', [
        'Supreme Student Council & Clubs',
        'National Technological University'
      ]);
    }

    // Seed Default Admin Account if none exists
    const adminRes = await client.query('SELECT * FROM admins');
    if (adminRes.rows.length === 0) {
      const defaultUser = 'admin';
      const defaultPass = Math.random().toString(36).substring(2, 10).toUpperCase() + '9!';
      const hash = await bcrypt.hash(defaultPass, 10);
      await client.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [defaultUser, hash]);
      
      console.log('\n============================================================');
      console.log(' DEFAULT ADMINISTRATOR ACCOUNT CREATED SUCCESSFULLY');
      console.log('============================================================');
      console.log(` Username: ${defaultUser}`);
      console.log(` Password: ${defaultPass}`);
      console.log(' IMPORTANT: Change this password immediately after login!');
      console.log('============================================================\n');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

initializeDatabase();

// --- AUTHENTICATION MIDDLEWARES ---
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

function requireMember(req, res, next) {
  if (req.session && req.session.isMember) return next();
  res.redirect('/member/login');
}

// --- SHARED HTML STYLES & LAYOUT COMPONENTS ---
const globalCSS = `
  :root {
    --primary: #4f46e5;
    --primary-hover: #4338ca;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
    --bg-color: #f8fafc;
    --card-bg: #ffffff;
    --text-main: #1e293b;
    --text-muted: #64748b;
    --border: #e2e8f0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
  body { background-color: var(--bg-color); color: var(--text-main); min-height: 100vh; display: flex; flex-direction: column; }
  .navbar { background: var(--card-bg); border-bottom: 1px solid var(--border); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  .navbar h1 { font-size: 1.25rem; color: var(--primary); display: flex; align-items: center; gap: 0.5rem; }
  .container { max-width: 1200px; margin: 2rem auto; padding: 0 1rem; width: 100%; flex: 1; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 1.5rem; }
  .btn { background: var(--primary); color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 8px; font-weight: 600; cursor: pointer; transition: background 0.2s; text-decoration: none; display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; }
  .btn:hover { background: var(--primary-hover); }
  .btn-danger { background: var(--danger); }
  .btn-danger:hover { background: #dc2626; }
  .btn-success { background: var(--success); }
  .btn-success:hover { background: #059669; }
  .form-group { margin-bottom: 1rem; }
  .form-group label { display: block; font-weight: 600; margin-bottom: 0.4rem; font-size: 0.9rem; }
  .form-control { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; font-size: 1rem; }
  .form-control:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1); }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }
  .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
  .stats-card { background: linear-gradient(135deg, #ffffff 0%, #f8fafc 100%); border-left: 4px solid var(--primary); padding: 1.25rem; border-radius: 8px; border: 1px solid var(--border); }
  .stats-card h3 { color: var(--text-muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .stats-card .value { font-size: 1.8rem; font-weight: 700; color: var(--text-main); }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.95rem; }
  th { background: #f8fafc; font-weight: 600; color: var(--text-muted); }
  .badge { padding: 0.25rem 0.75rem; border-radius: 50px; font-size: 0.8rem; font-weight: 600; display: inline-block; }
  .badge-active, .badge-Present { background: #d1fae5; color: #065f46; }
  .badge-inactive, .badge-Absent { background: #fee2e2; color: #991b1b; }
  .badge-Late { background: #fef3c7; color: #92400e; }
  .alert { padding: 1rem; border-radius: 8px; margin-bottom: 1rem; font-weight: 500; }
  .alert-error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .alert-success { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
`;

// --- PORTAL 1: ADMIN PORTAL ROUTES ---
app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Admin Login - Club System</title>
      <style>${globalCSS}</style>
    </head>
    <body style="display:flex; align-items:center; justify-content:center;">
      <div class="card" style="width: 100%; max-width: 400px; margin-top: 5rem;">
        <div style="text-align: center; margin-bottom: 1.5rem;">
          <h2>Admin Portal Login</h2>
          <p style="color: var(--text-muted);">School Club Attendance System</p>
        </div>
        ${req.query.error ? '<div class="alert alert-error">Invalid username or password.</div>' : ''}
        <form action="/admin/login" method="POST">
          <div class="form-group">
            <label>Username</label>
            <input type="text" name="username" class="form-control" required autofocus>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" name="password" class="form-control" required>
          </div>
          <button type="submit" class="btn" style="width: 100%; justify-content: center;">Login to Admin</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      const admin = result.rows.length > 0 ? result.rows[0] : null;
      const match = await bcrypt.compare(password, admin.password_hash);
      if (match) {
        req.session.isAdmin = true;
        req.session.adminUser = admin.username;
        return res.redirect('/admin/dashboard');
      }
    }
    res.redirect('/admin/login?error=1');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Admin Dashboard
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const totalMem = (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count;
    const activeMem = (await pool.query("SELECT COUNT(*) FROM members WHERE status='Active'")).rows[0].count;
    const inactiveMem = (await pool.query("SELECT COUNT(*) FROM members WHERE status='Inactive'")).rows[0].count;
    const presentToday = (await pool.query("SELECT COUNT(*) FROM attendance WHERE date=CURRENT_DATE AND status IN ('Present','Late')")).rows[0].count;
    const absentToday = totalMem - presentToday;
    const lateToday = (await pool.query("SELECT COUNT(*) FROM attendance WHERE date=CURRENT_DATE AND status='Late'")).rows[0].count;
    
    const recentScans = (await pool.query("SELECT a.*, m.full_name, m.position FROM attendance a JOIN members m ON a.member_id = m.member_id ORDER BY a.created_at DESC LIMIT 5")).rows;
    const recentMembers = (await pool.query("SELECT * FROM members ORDER BY created_at DESC LIMIT 5")).rows;
    const settings = (await pool.query("SELECT * FROM settings WHERE id=1")).rows[0];

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><title>Admin Dashboard</title>
        <style>${globalCSS}</style>
      </head>
      <body>
        <nav class="navbar">
          <h1>🛡️ ${settings.organization_name} - Admin Portal</h1>
          <div>
            <a href="/admin/dashboard" class="btn" style="background:transparent; color:var(--primary);">Dashboard</a>
            <a href="/admin/members" class="btn" style="background:transparent; color:var(--text-main);">Members</a>
            <a href="/admin/attendance" class="btn" style="background:transparent; color:var(--text-main);">Attendance</a>
            <a href="/admin/announcements" class="btn" style="background:transparent; color:var(--text-main);">Announcements</a>
            <a href="/admin/settings" class="btn" style="background:transparent; color:var(--text-main);">Settings</a>
            <a href="/admin/logout" class="btn btn-danger">Logout</a>
          </div>
        </nav>
        <div class="container">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
            <h2>Dashboard Overview</h2>
            <a href="/admin/members/new" class="btn btn-success">+ Add New Member</a>
          </div>

          <div class="grid-4" style="margin-bottom: 2rem;">
            <div class="stats-card"><h3>Total Members</h3><div class="value">${totalMem}</div></div>
            <div class="stats-card" style="border-left-color: var(--success);"><h3>Active Members</h3><div class="value">${activeMem}</div></div>
            <div class="stats-card" style="border-left-color: var(--warning);"><h3>Present Today</h3><div class="value">${presentToday}</div></div>
            <div class="stats-card" style="border-left-color: var(--danger);"><h3>Late Today</h3><div class="value">${lateToday}</div></div>
          </div>

          <div class="grid-2">
            <div class="card">
              <h3>Recent Scans</h3>
              <table>
                <tr><th>Name</th><th>Time</th><th>Status</th></tr>
                ${recentScans.map(s => `<tr><td>${s.full_name}</td><td>${s.time_in || s.time_out}</td><td><span class="badge badge-${s.status}">${s.status}</span></td></tr>`).join('')}
              </table>
            </div>
            <div class="card">
              <h3>Recent Registrations</h3>
              <table>
                <tr><th>Member ID</th><th>Name</th><th>Position</th></tr>
                ${recentMembers.map(m => `<tr><td>${m.member_id}</td><td>${m.full_name}</td><td>${m.position}</td></tr>`).join('')}
              </table>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Member Management & Registration Route
app.get('/admin/members', requireAdmin, async (req, res) => {
  const search = req.query.search || '';
  const queryText = search 
    ? `SELECT * FROM members WHERE full_name ILIKE $1 OR member_id ILIKE $1 OR username ILIKE $1 ORDER BY created_at DESC`
    : `SELECT * FROM members ORDER BY created_at DESC`;
  const members = (await pool.query(queryText, search ? [`%${search}%`] : [])).rows;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Member Management</title><style>${globalCSS}</style></head>
    <body>
      <nav class="navbar">
        <h1>🛡️ Admin Portal - Members</h1>
        <div>
          <a href="/admin/dashboard" class="btn" style="background:transparent; color:var(--text-main);">Dashboard</a>
          <a href="/admin/members" class="btn" style="background:transparent; color:var(--primary);">Members</a>
          <a href="/admin/attendance" class="btn" style="background:transparent; color:var(--text-main);">Attendance</a>
          <a href="/admin/settings" class="btn" style="background:transparent; color:var(--text-main);">Settings</a>
          <a href="/admin/logout" class="btn btn-danger">Logout</a>
        </div>
      </nav>
      <div class="container">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem;">
          <form method="GET" style="display:flex; gap:0.5rem;">
            <input type="text" name="search" placeholder="Search name or ID..." value="${search}" class="form-control" style="width:300px;">
            <button type="submit" class="btn">Search</button>
          </form>
          <a href="/admin/members/new" class="btn btn-success">+ Add Member</a>
        </div>
        <div class="card">
          <table>
            <tr><th>Member ID</th><th>Full Name</th><th>Position</th><th>Username</th><th>Status</th><th>Actions</th></tr>
            ${members.map(m => `
              <tr>
                <td>${m.member_id}</td>
                <td><strong>${m.full_name}</strong></td>
                <td>${m.position}</td>
                <td><code>${m.username}</code></td>
                <td><span class="badge badge-${m.status}">${m.status}</span></td>
                <td>
                  <a href="/admin/members/id/${m.id}" class="btn" style="padding:0.3rem 0.6rem; font-size:0.8rem;">View ID</a>
                  <a href="/admin/members/edit/${m.id}" class="btn" style="padding:0.3rem 0.6rem; font-size:0.8rem; background:var(--warning);">Edit</a>
                  <a href="/admin/members/reset/${m.id}" class="btn" style="padding:0.3rem 0.6rem; font-size:0.8rem; background:var(--danger);" onclick="return confirm('Reset password & QR?')">Reset</a>
                </td>
              </tr>
            `).join('')}
          </table>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Add Member Form
app.get('/admin/members/new', requireAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Add New Member</title><style>${globalCSS}</style></head>
    <body>
      <nav class="navbar"><h1>🛡️ Register New Member</h1><a href="/admin/members" class="btn" style="background:transparent; color:var(--text-main);">Back</a></nav>
      <div class="container" style="max-width: 700px;">
        <div class="card">
          <form action="/admin/members/new" method="POST">
            <div class="form-group"><label>Full Name</label><input type="text" name="full_name" class="form-control" required></div>
            <div class="grid-2">
              <div class="form-group"><label>Position</label><input type="text" name="position" class="form-control" value="Member" required></div>
              <div class="form-group"><label>Club / Organization</label><input type="text" name="club" class="form-control" value="Student Council"></div>
            </div>
            <div class="grid-3" style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:1rem;">
              <div class="form-group"><label>Year Level</label><input type="text" name="year_level" class="form-control" placeholder="e.g., 3rd Year"></div>
              <div class="form-group"><label>Course</label><input type="text" name="course" class="form-control" placeholder="BSIT"></div>
              <div class="form-group"><label>Section</label><input type="text" name="section" class="form-control" placeholder="3A"></div>
            </div>
            <div class="grid-2">
              <div class="form-group"><label>Contact Number</label><input type="text" name="contact" class="form-control"></div>
              <div class="form-group"><label>Email Address</label><input type="email" name="email" class="form-control"></div>
            </div>
            <button type="submit" class="btn btn-success" style="width:100%; justify-content:center; margin-top:1rem;">Generate Credentials & ID Card</button>
          </form>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Process Member Creation
app.post('/admin/members/new', requireAdmin, async (req, res) => {
  const { full_name, position, club, year_level, course, section, contact, email } = req.body;
  
  // Automatically generate Member ID, Username, Password, and QR Token
  const countRes = await pool.query('SELECT COUNT(*) FROM members');
  const nextNum = parseInt(countRes.rows[0].count) + 1;
  const member_id = `CLUB-2026-${String(nextNum).padStart(3, '0')}`;
  const username = `u_${member_id.toLowerCase()}`;
  const tempPassword = Math.random().toString(36).substring(2, 10).toUpperCase();
  const password_hash = await bcrypt.hash(tempPassword, 10);
  const qr_token = crypto.randomBytes(16).toString('hex');

  await pool.query(`
    INSERT INTO members (member_id, full_name, position, club, year_level, course, section, contact, email, username, password_hash, qr_token)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [member_id, full_name, position, club, year_level, course, section, contact, email, username, password_hash, qr_token]);

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Member Created</title><style>${globalCSS}</style></head>
    <body style="display:flex; align-items:center; justify-content:center;">
      <div class="card" style="max-width: 500px; width:100%; text-align:center;">
        <h2 style="color:var(--success); margin-bottom:1rem;">✓ Member Created Successfully!</h2>
        <p>Give these temporary credentials to the member:</p>
        <div style="background:#f1f5f9; padding:1rem; border-radius:8px; margin:1rem 0; text-align:left;">
          <p><strong>Member ID:</strong> ${member_id}</p>
          <p><strong>Temporary Username:</strong> <code>${username}</code></p>
          <p><strong>Temporary Password:</strong> <code style="color:var(--danger);">${tempPassword}</code></p>
          <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">* Member must change password upon first login.</p>
        </div>
        <div style="display:flex; gap:1rem; justify-content:center;">
          <a href="/admin/members/id/${(await pool.query('SELECT id FROM members WHERE member_id=$1', [member_id])).rows[0].id}" class="btn">View & Print ID Card</a>
          <a href="/admin/members" class="btn" style="background:var(--text-muted);">Back to Members</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Printable CR80 Member ID Card View
app.get('/admin/members/id/:id', requireAdmin, async (req, res) => {
  const member = (await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id])).rows[0];
  const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
  if (!member) return res.status(404).send("Member not found");

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>ID Card - ${member.full_name}</title>
      <style>
        ${globalCSS}
        @media print {
          body * { visibility: hidden; }
          #id-card-print, #id-card-print * { visibility: visible; }
          #id-card-print { position: absolute; left: 0; top: 0; box-shadow: none !important; border: none !important; }
          .no-print { display: none !important; }
        }
        .id-card {
          width: 340px; height: 215px; background: white; border: 2px solid #cbd5e1; border-radius: 12px;
          padding: 15px; position: relative; box-shadow: 0 10px 15px rgba(0,0,0,0.1); margin: 2rem auto;
          display: flex; flex-direction: column; justify-content: space-between; font-family: sans-serif;
        }
        .id-header { display: flex; align-items: center; gap: 10px; border-bottom: 2px solid var(--primary); padding-bottom: 8px; }
        .id-body { display: flex; gap: 12px; align-items: center; margin-top: 10px; }
        .avatar-placeholder { width: 65px; height: 75px; background: #e2e8f0; border-radius: 6px; display: flex; align-items: center; justify-content:center; font-weight:bold; color:#64748b; font-size:1.2rem;}
      </style>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    </head>
    <body style="background:#e2e8f0;">
      <div class="no-print" style="text-align:center; margin-top:1.5rem;">
        <button onclick="window.print()" class="btn btn-success">🖨️ Print ID Card</button>
        <a href="/admin/members" class="btn">Back to Members</a>
      </div>

      <div id="id-card-print" class="id-card">
        <div class="id-header">
          <div style="font-size:1.2rem;">🛡️</div>
          <div>
            <div style="font-size: 0.7rem; color: #64748b; text-transform:uppercase;">${settings.school_name}</div>
            <div style="font-size: 0.9rem; font-weight: bold; color: var(--primary);">${settings.organization_name}</div>
          </div>
        </div>
        <div class="id-body">
          <div class="avatar-placeholder">${member.full_name.charAt(0)}</div>
          <div>
            <div style="font-size: 1rem; font-weight: bold; line-height:1.1;">${member.full_name}</div>
            <div style="font-size: 0.75rem; color: var(--primary); font-weight:600; margin-bottom:4px;">${member.position}</div>
            <div style="font-size: 0.7rem; color: #64748b;">ID: ${member.member_id}</div>
            <div style="font-size: 0.7rem; color: #64748b;">Course: ${member.course || 'N/A'} ${member.section || ''}</div>
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:flex-end; border-top: 1px dashed #cbd5e1; padding-top:6px;">
          <div style="font-size: 0.6rem; color:#475569;">
            <div>User: <b>${member.username}</b></div>
            <div>Pass: <b>[Temporary]</b></div>
          </div>
          <div id="qrcode" style="width:50px; height:50px;"></div>
        </div>
      </div>

      <script>
        new QRCode(document.getElementById("qrcode"), {
          text: "${member.qr_token}",
          width: 50,
          height: 50
        });
      </script>
    </body>
    </html>
  `);
});

// Admin Attendance Log View
app.get('/admin/attendance', requireAdmin, async (req, res) => {
  const records = (await pool.query(`
    SELECT a.*, m.full_name, m.position FROM attendance a 
    JOIN members m ON a.member_id = m.member_id 
    ORDER BY a.date DESC, a.time_in DESC LIMIT 100
  `)).rows;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Attendance Records</title><style>${globalCSS}</style></head>
    <body>
      <nav class="navbar">
        <h1>🛡️ Attendance Logs</h1>
        <a href="/admin/dashboard" class="btn" style="background:transparent; color:var(--text-main);">Dashboard</a>
      </nav>
      <div class="container">
        <div class="card">
          <h3>Recent Attendance History</h3>
          <table>
            <tr><th>Date</th><th>Member ID</th><th>Name</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
            ${records.map(r => `
              <tr>
                <td>${r.date.toISOString().split('T')[0]}</td>
                <td>${r.member_id}</td>
                <td><b>${r.full_name}</b></td>
                <td>${r.time_in || '-'}</td>
                <td>${r.time_out || '-'}</td>
                <td><span class="badge badge-${r.status}">${r.status}</span></td>
              </tr>
            `).join('')}
          </table>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Admin Announcements
app.get('/admin/announcements', requireAdmin, async (req, res) => {
  const announcements = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC')).rows;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Announcements</title><style>${globalCSS}</style></head>
    <body>
      <nav class="navbar"><h1>🛡️ Manage Announcements</h1><a href="/admin/dashboard" class="btn" style="background:transparent; color:var(--text-main);">Dashboard</a></nav>
      <div class="container">
        <div class="card">
          <form action="/admin/announcements" method="POST">
            <div class="form-group"><label>Title</label><input type="text" name="title" class="form-control" required></div>
            <div class="form-group"><label>Message</label><textarea name="message" class="form-control" rows="3" required></textarea></div>
            <button type="submit" class="btn">Post Announcement</button>
          </form>
        </div>
        <div class="card">
          <h3>Published Announcements</h3>
          ${announcements.map(a => `<div style="border-bottom:1px solid var(--border); padding:0.75rem 0;"><h4>${a.title}</h4><p>${a.message}</p><small style="color:var(--text-muted);">${a.created_at}</small></div>`).join('')}
        </div>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/announcements', requireAdmin, async (req, res) => {
  const { title, message } = req.body;
  await pool.query('INSERT INTO announcements (title, message) VALUES ($1, $2)', [title, message]);
  res.redirect('/admin/announcements');
});

// Admin Settings
app.get('/admin/settings', requireAdmin, async (req, res) => {
  const settings = (await pool.query('SELECT * FROM settings WHERE id=1')).rows[0];
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Settings</title><style>${globalCSS}</style></head>
    <body>
      <nav class="navbar"><h1>🛡️ System Settings</h1><a href="/admin/dashboard" class="btn" style="background:transparent; color:var(--text-main);">Dashboard</a></nav>
      <div class="container" style="max-width:700px;">
        <div class="card">
          <form action="/admin/settings" method="POST">
            <div class="form-group"><label>Organization Name</label><input type="text" name="organization_name" class="form-control" value="${settings.organization_name}" required></div>
            <div class="form-group"><label>School Name</label><input type="text" name="school_name" class="form-control" value="${settings.school_name}" required></div>
            <div class="form-group"><label>School Year</label><input type="text" name="school_year" class="form-control" value="${settings.school_year}"></div>
            <div class="form-group"><label>Scanner PIN (for scanner security)</label><input type="text" name="scanner_pin" class="form-control" value="${settings.scanner_pin}"></div>
            <button type="submit" class="btn">Save Settings</button>
          </form>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  const { organization_name, school_name, school_year, scanner_pin } = req.body;
  await pool.query('UPDATE settings SET organization_name=$1, school_name=$2, school_year=$3, scanner_pin=$4 WHERE id=1', [organization_name, school_name, school_year, scanner_pin]);
  res.redirect('/admin/settings');
});


// --- PORTAL 2: SCANNER PORTAL ROUTES ---
app.get('/scanner', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Scanner Portal</title>
      <style>${globalCSS}</style>
      <script src="https://unpkg.com/html5-qrcode"></script>
    </head>
    <body style="background:#0f172a; color:white;">
      <div style="text-align:center; padding: 1.5rem;">
        <h2>📷 Smart Attendance Scanner</h2>
        <div id="mode-selector" style="margin: 1rem 0;">
          <button onclick="setMode('IN')" id="btn-in" class="btn btn-success" style="font-size:1.2rem; padding:0.8rem 1.5rem;">TIME IN</button>
          <button onclick="setMode('OUT')" id="btn-out" class="btn" style="font-size:1.2rem; padding:0.8rem 1.5rem; background:#334155;">TIME OUT</button>
        </div>
      </div>
      <div class="container" style="max-width:500px;">
        <div style="background:white; border-radius:12px; padding:1rem; color:black;">
          <div id="reader" style="width:100%;"></div>
          <div id="scan-result" style="margin-top:1rem; text-align:center; font-weight:bold; font-size:1.1rem;"></div>
        </div>
      </div>
      <script>
        let currentMode = 'IN';
        function setMode(mode) {
          currentMode = mode;
          document.getElementById('btn-in').style.background = mode === 'IN' ? 'var(--success)' : '#334155';
          document.getElementById('btn-out').style.background = mode === 'OUT' ? 'var(--danger)' : '#334155';
        }

        function onScanSuccess(decodedText) {
          fetch('/scanner/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: decodedText, mode: currentMode })
          })
          .then(res => res.json())
          .then(data => {
            const resBox = document.getElementById('scan-result');
            if(data.success) {
              resBox.innerHTML = \`<div class="alert alert-success">✓ \${data.message} (<br>\${data.name})</div>\`;
              new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3').play().catch(e=>{});
            } else {
              resBox.innerHTML = \`<div class="alert alert-error">✕ \${data.message}</div>\`;
              new Audio('https://assets.mixkit.co/active_storage/sfx/2873/2873-preview.mp3').play().catch(e=>{});
            }
            setTimeout(() => { resBox.innerHTML = ''; }, 3500);
          })
          .catch(err => console.error(err));
        }

        const html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess);
      </script>
    </body>
    </html>
  `);
});

// Scanner API Processing Engine
app.post('/scanner/process', async (req, res) => {
  const { token, mode } = req.body;
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [token]);
    if (memberRes.rows.length === 0) {
      return res.json({ success: false, message: 'Invalid QR Code Not Registered' });
    }
    const member = memberRes.rows[0];
    if (member.status !== 'Active') {
      return res.json({ success: false, message: 'Member Account Inactive' });
    }

    const today = new Date().toISOString().split('T')[0];
    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND date = $2', [member.member_id, today]);

    if (mode === 'IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({ success: false, message: 'Already Timed In Today' });
      }
      const nowTime = new Date().toTimeString().split(' ')[0];
      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1 WHERE member_id = $2 AND date = $3', [nowTime, member.member_id, today]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, date, time_in, status) VALUES ($1, $2, $3, $4)', [member.member_id, today, nowTime, 'Present']);
      }
      return res.json({ success: true, message: 'Time In Successful', name: member.full_name });
    } else {
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ success: false, message: 'No Time-In Record Found' });
      }
      if (attRes.rows[0].time_out) {
        return res.json({ success: false, message: 'Already Timed Out Today' });
      }
      const nowTime = new Date().toTimeString().split(' ')[0];
      await pool.query('UPDATE attendance SET time_out = $1 WHERE member_id = $2 AND date = $3', [nowTime, member.member_id, today]);
      return res.json({ success: true, message: 'Time Out Successful', name: member.full_name });
    }
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'System Scanning Error' });
  }
});


// --- PORTAL 3: MEMBER PORTAL ROUTES ---
app.get('/member/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Member Portal Login</title><style>${globalCSS}</style></head>
    <body style="display:flex; align-items:center; justify-content:center;">
      <div class="card" style="width:100%; max-width:450px;">
        <h2>Member Portal</h2>
        <p style="color:var(--text-muted); margin-bottom:1rem;">Access your attendance and membership ID</p>
        ${req.query.error ? '<div class="alert alert-error">Invalid username or password.</div>' : ''}
        <form action="/member/login" method="POST">
          <div class="form-group"><label>Username</label><input type="text" name="username" class="form-control" required autofocus></div>
          <div class="form-group"><label>Password</label><input type="password" name="password" class="form-control" required></div>
          <button type="submit" class="btn" style="width:100%; justify-content:center;">Login</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/member/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM members WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      const member = result.rows[0];
      const match = await bcrypt.compare(password, member.password_hash);
      if (match) {
        req.session.isMember = true;
        req.session.memberId = member.member_id;
        if (member.temporary_password_status) {
          return res.redirect('/member/change-password');
        }
        return res.redirect('/member/dashboard');
      }
    }
    res.redirect('/member/login?error=1');
  } catch (err) {
    console.error(err);
    res.redirect('/member/login?error=1');
  }
});

// Force Password Change Route for First Login
app.get('/member/change-password', requireMember, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Change Temporary Password</title><style>${globalCSS}</style></head>
    <body style="display:flex; align-items:center; justify-content:center;">
      <div class="card" style="width:100%; max-width:450px;">
        <h2>Security Update Required</h2>
        <p class="alert alert-error" style="margin-top:1rem;">Your account is using a temporary password. Please create a new secure password before continuing.</p>
        <form action="/member/change-password" method="POST">
          <div class="form-group"><label>New Password</label><input type="password" name="new_password" class="form-control" required minlength="6"></div>
          <button type="submit" class="btn" style="width:100%; justify-content:center;">Update Password & Continue</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/member/change-password', requireMember, async (req, res) => {
  const { new_password } = req.body;
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = FALSE WHERE member_id = $2', [hash, req.session.memberId]);
  res.redirect('/member/dashboard');
});

// Member Dashboard
app.get('/member/dashboard', requireMember, async (req, res) => {
  const member = (await pool.query('SELECT * FROM members WHERE member_id = $1', [req.session.memberId])).rows[0];
  const attendance = (await pool.query('SELECT * FROM attendance WHERE member_id = $1 ORDER BY date DESC LIMIT 10', [member.member_id])).rows;
  const announcements = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 3')).rows;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Member Dashboard</title><style>${globalCSS}</style></head>
    <body>
      <nav class="navbar">
        <h1>👋 Welcome, ${member.full_name}</h1>
        <a href="/admin/logout" class="btn btn-danger">Logout</a>
      </nav>
      <div class="container">
        <div class="grid-2">
          <div class="card">
            <h3>My Profile</h3>
            <p><strong>Member ID:</strong> ${member.member_id}</p>
            <p><strong>Position:</strong> ${member.position}</p>
            <p><strong>Course / Section:</strong> ${member.course || 'N/A'} ${member.section || ''}</p>
            <p><strong>Status:</strong> <span class="badge badge-${member.status}">${member.status}</span></p>
          </div>
          <div class="card" style="text-align:center;">
            <h3>My QR Code Token</h3>
            <div id="qrcode" style="display:inline-block; margin:1rem 0;"></div>
            <p style="font-size:0.8rem; color:var(--text-muted);">Show this at the attendance scanner portal.</p>
          </div>
        </div>
        <div class="card">
          <h3>Attendance History</h3>
          <table>
            <tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
            ${attendance.map(a => `<tr><td>${a.date.toISOString().split('T')[0]}</td><td>${a.time_in || '-'}</td><td>${a.time_out || '-'}</td><td><span class="badge badge-${a.status}">${a.status}</span></td></tr>`).join('')}
          </table>
        </div>
      </div>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      <script>
        new QRCode(document.getElementById("qrcode"), { text: "${member.qr_token}", width: 120, height: 120 });
      </script>
    </body>
    </html>
  `);
});

// Root Redirect Landing Page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>School Club Attendance System</title><style>${globalCSS}</style></head>
    <body style="display:flex; align-items:center; justify-content:center;">
      <div class="card" style="text-align:center; max-width:500px; width:100%;">
        <h2>School Club QR Attendance System</h2>
        <p style="color:var(--text-muted); margin:1rem 0;">Select your portal below to get started:</p>
        <div style="display:flex; flex-direction:column; gap:1rem; margin-top:1.5rem;">
          <a href="/admin/login" class="btn" style="justify-content:center;">🛡️ Admin Portal</a>
          <a href="/scanner" class="btn btn-success" style="justify-content:center;">📷 Smartphone Scanner Portal</a>
          <a href="/member/login" class="btn" style="justify-content:center; background:#334155;">👤 Member Portal</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`Server is running live on port ${PORT}`);
});
