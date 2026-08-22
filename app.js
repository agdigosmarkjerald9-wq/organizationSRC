const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/club_attendance',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'clubtrack-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if using HTTPS in production behind proxy
}));

// Initialize Database Tables & Default Admin
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL, -- admin, member, scanner
        must_change_password BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        member_id VARCHAR(50) UNIQUE NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        middle_name VARCHAR(100),
        last_name VARCHAR(100) NOT NULL,
        gender VARCHAR(20),
        grade_level VARCHAR(50) NOT NULL,
        section VARCHAR(50) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        contact_info VARCHAR(100),
        email VARCHAR(100),
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(200) NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        late_cutoff TIME NOT NULL,
        status VARCHAR(20) DEFAULT 'Active'
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL,
        time_in TIME,
        time_out TIME,
        status VARCHAR(50) DEFAULT 'Present', -- Present, Late, Completed, Missing Time Out
        scan_method VARCHAR(20) DEFAULT 'QR',
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name VARCHAR(200) DEFAULT 'ABC High School',
        org_name VARCHAR(200) DEFAULT 'Supreme Student Council',
        school_year VARCHAR(50) DEFAULT '2026-2027',
        org_prefix VARCHAR(50) DEFAULT 'SSC',
        description TEXT DEFAULT 'Official High School Organization'
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100),
        role VARCHAR(50),
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Default Settings
    const settingsRes = await client.query('SELECT * FROM organization_settings WHERE id = 1');
    if (settingsRes.rows.length === 0) {
      await client.query(`
        INSERT INTO organization_settings (id, school_name, org_name, school_year, org_prefix, description)
        VALUES (1, 'ABC High School', 'Supreme Student Council', '2026-2027', 'SSC', 'Official Student Leadership Organization')
      `);
    }

    // Default Admin Account
    const adminRes = await client.query("SELECT * FROM users WHERE username = 'admin'");
    if (adminRes.rows.length === 0) {
      const hashedPass = await bcrypt.hash('admin123', 10);
      await client.query(`
        INSERT INTO users (username, password, role, must_change_password)
        VALUES ('admin', $1, 'admin', FALSE)
      `, [hashedPass]);
      console.log('Default admin account created: admin / admin123');
    }
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

initDB();

// Audit Logger Helper
async function logAudit(username, role, action, details) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (username, role, action, details) VALUES ($1, $2, $3, $4)',
      [username || 'System', role || 'System', action, details]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

// Middleware for Authentication
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/');
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'admin') {
      return res.status(403).send('Access Denied');
    }
    next();
  };
}

// ==================== API & WEB ROUTES ====================

// Root / Login Page
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    if (req.session.user.role === 'member') return res.redirect('/member');
    if (req.session.user.role === 'scanner') return res.redirect('/scanner');
  }
  res.send(renderLoginPage());
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) {
      return res.json({ success: false, message: 'Invalid username or password.' });
    }
    const user = userRes.rows.shift();
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.json({ success: false, message: 'Invalid username or password.' });
    }

    req.session.user = { id: user.id, username: user.username, role: user.role, mustChange: user.must_change_password };
    await logAudit(user.username, user.role, 'Login', 'User logged in successfully');

    if (user.must_change_password) {
      return res.json({ success: true, redirect: '/change-password-required' });
    }

    let redirectUrl = '/admin';
    if (user.role === 'member') redirectUrl = '/member';
    if (user.role === 'scanner') redirectUrl = '/scanner';

    res.json({ success: true, redirect: redirectUrl });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get('/logout', (req, res) => {
  if (req.session.user) {
    logAudit(req.session.user.username, req.session.user.role, 'Logout', 'User logged out');
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Required Password Change Page
app.get('/change-password-required', (req, res) => {
  if (!req.session.user || !req.session.user.mustChange) return res.redirect('/');
  res.send(renderChangePasswordPage());
});

app.post('/api/change-password', requireAuth(), async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (newPassword !== confirmPassword || newPassword.length < 8) {
    return res.json({ success: false, message: 'Passwords must match and be at least 8 characters long.' });
  }
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows[0];
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.json({ success: false, message: 'Current password is incorrect.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, user.id]);
    req.session.user.mustChange = false;

    await logAudit(user.username, user.role, 'Password Change', 'User successfully changed password');
    res.json({ success: true, message: 'Password successfully changed!' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ==================== ADMIN PORTAL ====================
app.get('/admin', requireAuth('admin'), async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
    const members = (await pool.query('SELECT * FROM members ORDER BY id DESC')).rows;
    const events = (await pool.query('SELECT * FROM events ORDER BY event_date DESC')).rows;
    const announcements = (await pool.query('SELECT * FROM announcements ORDER BY id DESC')).rows;
    const stats = {
      totalMembers: (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count,
      activeMembers: (await pool.query("SELECT COUNT(*) FROM members WHERE status = 'Active'")).rows[0].count,
      presentToday: (await pool.query("SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date = CURRENT_DATE")).rows[0].count,
    };
    res.send(renderAdminDashboard(settings, members, events, announcements, stats));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Admin API: Add Member
app.post('/api/admin/members', requireAuth('admin'), async (req, res) => {
  const { first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email } = req.body;
  try {
    const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
    const prefix = settings.org_prefix || 'SSC';
    const year = new Date().getFullYear();
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seq = parseInt(countRes.rows[0].count) + 1;
    const member_id = `${prefix}-${year}-${String(seq).padStart(4, '0')}`;

    let username = `${first_name.toLowerCase().replace(/[^a-z]/g, '')}${last_name.toLowerCase().replace(/[^a-z]/g, '')}`;
    const checkUser = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (checkUser.rows.length > 0) username += seq;

    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hashed = await bcrypt.hash(tempPassword, 10);

    const userResult = await pool.query(
      'INSERT INTO users (username, password, role, must_change_password) VALUES ($1, $2, $3, TRUE) RETURNING id',
      [username, hashed, 'member']
    );
    const userId = userResult.rows[0].id;

    const qrToken = `CLUBTRACK:MEMBER:${crypto.randomUUID()}`;
    const qrCodeDataUrl = await QRCode.toDataURL(qrToken);

    await pool.query(
      `INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email, qr_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [userId, member_id, first_name, middle_name, last_name, gender, grade_level, section, position || 'Member', contact_info, email, qrToken]
    );

    await logAudit(req.session.user.username, 'admin', 'Register Member', `Registered member ${member_id} (${first_name} ${last_name})`);

    res.json({
      success: true,
      credentials: { member_id, username, tempPassword, qrCodeDataUrl, full_name: `${first_name} ${last_name}`, grade_section: `${grade_level} - ${section}`, position: position || 'Member' }
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Admin API: Delete Member
app.post('/api/admin/members/delete', requireAuth('admin'), async (req, res) => {
  const { id } = req.body;
  try {
    const memRes = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
    if (memRes.rows.length === 0) return res.json({ success: false, message: 'Member not found.' });
    const member = memRes.rows[0];

    await pool.query('DELETE FROM users WHERE id = $1', [member.user_id]);
    await logAudit(req.session.user.username, 'admin', 'Delete Member', `Deleted member ${member.member_id}`);
    res.json({ success: true, message: 'Member deleted successfully.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Admin API: Create Event
app.post('/api/admin/events', requireAuth('admin'), async (req, res) => {
  const { event_name, description, event_date, start_time, end_time, late_cutoff } = req.body;
  try {
    await pool.query(
      'INSERT INTO events (event_name, description, event_date, start_time, end_time, late_cutoff) VALUES ($1, $2, $3, $4, $5, $6)',
      [event_name, description, event_date, start_time, end_time, late_cutoff]
    );
    await logAudit(req.session.user.username, 'admin', 'Create Event', `Created event: ${event_name}`);
    res.json({ success: true, message: 'Event created successfully.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Admin API: Update Settings
app.post('/api/admin/settings', requireAuth('admin'), async (req, res) => {
  const { school_name, org_name, school_year, org_prefix, description } = req.body;
  try {
    await pool.query(
      'UPDATE organization_settings SET school_name = $1, org_name = $2, school_year = $3, org_prefix = $4, description = $5 WHERE id = 1',
      [school_name, org_name, school_year, org_prefix, description]
    );
    await logAudit(req.session.user.username, 'admin', 'Update Settings', 'Updated organization settings');
    res.json({ success: true, message: 'Settings updated successfully.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});


// ==================== MEMBER PORTAL (Dedicated Link: /member) ====================
app.get('/member', requireAuth('member'), async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE user_id = $1', [req.session.user.id]);
    if (memberRes.rows.length === 0) return res.send('Member profile not found.');
    const member = memberRes.rows[0];
    const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
    const qrCodeDataUrl = await QRCode.toDataURL(member.qr_token);
    const attendance = (await pool.query('SELECT a.*, e.event_name FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.member_id = $1 ORDER BY a.id DESC', [member.id])).rows;
    const announcements = (await pool.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 5')).rows;

    res.send(renderMemberPortal(member, settings, qrCodeDataUrl, attendance, announcements));
  } catch (err) {
    res.status(500).send(err.message);
  }
});


// ==================== SCANNER PORTAL (Dedicated Link: /scanner) ====================
app.get('/scanner', requireAuth(), async (req, res) => {
  if (req.session.user.role !== 'admin' && req.session.user.role !== 'scanner') {
    return res.status(403).send('Access Denied. Authorized scanner personnel only.');
  }
  try {
    const events = (await pool.query("SELECT * FROM events WHERE status = 'Active' ORDER BY event_date DESC")).rows;
    const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
    res.send(renderScannerPortal(events, settings));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Scanner API: Process QR Scan
app.post('/api/scanner/scan', requireAuth(), async (req, res) => {
  if (req.session.user.role !== 'admin' && req.session.user.role !== 'scanner') {
    return res.status(403).json({ success: false, message: 'Unauthorized scanner access.' });
  }

  const { qr_token, event_id, scan_type } = req.body; // scan_type: 'Time In' or 'Time Out'
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      await logAudit(req.session.user.username, req.session.user.role, 'Invalid QR Scan', `Scanned unknown token`);
      return res.json({ success: false, status: 'INVALID', message: 'QR Code not recognized or registered.' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'Active') {
      return res.json({ success: false, status: 'INACTIVE', message: 'Member account is inactive.' });
    }

    const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    if (eventRes.rows.length === 0) {
      return res.json({ success: false, status: 'NO_EVENT', message: 'Please select a valid attendance event.' });
    }
    const event = eventRes.rows[0];
    const today = new Date().toISOString().split('T')[0];
    const nowTime = new Date().toTimeString().split(' ')[0];

    // Check existing attendance for today/event
    let attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, today]);
    
    if (scan_type === 'Time In') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          success: false,
          status: 'DUPLICATE',
          message: `${member.first_name} ${member.last_name} already has a Time In record for this event.`,
          member: member,
          time: attRes.rows[0].time_in
        });
      }

      let status = 'Present';
      if (nowTime > event.late_cutoff) status = 'Late';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [nowTime, status, attRes.rows[0].id]);
      } else {
        await pool.query(
          'INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status) VALUES ($1, $2, $3, $4, $5)',
          [member.id, event_id, today, nowTime, status]
        );
      }

      await logAudit(req.session.user.username, req.session.user.role, 'Time In', `Recorded Time In for ${member.member_id}`);
      return res.json({ success: true, status: 'SUCCESS_IN', member, time: nowTime, event_name: event.event_name });
    } else {
      // Time Out
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ success: false, status: 'NO_TIME_IN', message: 'Cannot Time Out without an existing Time In record.' });
      }
      if (attRes.rows[0].time_out) {
        return res.json({ success: false, status: 'DUPLICATE', message: 'Member already recorded Time Out for this event.', member, time: attRes.rows[0].time_out });
      }

      await pool.query('UPDATE attendance SET time_out = $1, status = $2 WHERE id = $3', [nowTime, 'Completed', attRes.rows[0].id]);
      await logAudit(req.session.user.username, req.session.user.role, 'Time Out', `Recorded Time Out for ${member.member_id}`);
      return res.json({ success: true, status: 'SUCCESS_OUT', member, time: nowTime, event_name: event.event_name });
    }
  } catch (err) {
    res.json({ success: false, status: 'ERROR', message: err.message });
  }
});


// ==================== HTML TEMPLATES (Single File Architecture) ====================

function renderLoginPage() {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ClubTrack QR Attendance System - Login</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-gradient-to-br from-blue-900 to-indigo-800 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white w-full max-w-md rounded-2xl shadow-2xl p-8">
      <div class="text-center mb-6">
        <h1 class="text-2xl font-black text-blue-900">ClubTrack QR System</h1>
        <p class="text-sm text-gray-500">Organization & Club Attendance Management</p>
      </div>
      <form id="loginForm" class="space-y-4">
        <div>
          <label class="block text-sm font-semibold text-gray-700">Username</label>
          <input type="text" id="username" required class="w-full mt-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
        </div>
        <div>
          <label class="block text-sm font-semibold text-gray-700">Password</label>
          <input type="password" id="password" required class="w-full mt-1 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
        </div>
        <div id="errorMsg" class="text-red-500 text-sm hidden"></div>
        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition duration-200">Login</button>
      </form>
    </div>
    <script>
      document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        const data = await res.json();
        if(data.success) {
          window.location.href = data.redirect;
        } else {
          const err = document.getElementById('errorMsg');
          err.innerText = data.message;
          err.classList.remove('hidden');
        }
      });
    </script>
  </body>
  </html>`;
}

function renderChangePasswordPage() {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8"><title>Change Temporary Password</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-gray-100 min-h-screen flex items-center justify-center p-4">
    <div class="bg-white max-w-md w-full p-8 rounded-xl shadow-lg space-y-4">
      <h2 class="text-xl font-bold text-red-600">Security Requirement</h2>
      <p class="text-sm text-gray-600">You are using a temporary password. Please create a new secure password.</p>
      <form id="passForm" class="space-y-3">
        <input type="password" id="currentPassword" placeholder="Current Temporary Password" required class="w-full p-2 border rounded">
        <input type="password" id="newPassword" placeholder="New Password (min 8 chars)" required class="w-full p-2 border rounded">
        <input type="password" id="confirmPassword" placeholder="Confirm New Password" required class="w-full p-2 border rounded">
        <div id="msg" class="text-sm"></div>
        <button type="submit" class="w-full bg-blue-600 text-white py-2 rounded font-bold">Update Password</button>
      </form>
    </div>
    <script>
      document.getElementById('passForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentPassword: document.getElementById('currentPassword').value,
            newPassword: document.getElementById('newPassword').value,
            confirmPassword: document.getElementById('confirmPassword').value
          })
        });
        const data = await res.json();
        if(data.success) {
          alert(data.message);
          window.location.href = '/member';
        } else {
          document.getElementById('msg').innerText = data.message;
          document.getElementById('msg').className = 'text-red-500 text-sm';
        }
      });
    </script>
  </body></html>`;
}

function renderAdminDashboard(settings, members, events, announcements, stats) {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8"><title>Admin Portal - ${settings.org_name}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js"></script>
  </head>
  <body class="bg-gray-50 flex h-screen overflow-hidden">
    <!-- Sidebar -->
    <aside class="w-64 bg-blue-900 text-white flex flex-col justify-between hidden md:flex">
      <div>
        <div class="p-6 font-black text-lg border-b border-blue-800">${settings.org_name}</div>
        <nav class="p-4 space-y-2">
          <a href="/admin" class="block py-2.5 px-4 rounded bg-blue-800 font-semibold">Dashboard</a>
          <a href="/scanner" target="_blank" class="block py-2.5 px-4 rounded hover:bg-blue-800">Open Scanner Portal ↗</a>
          <a href="/member" target="_blank" class="block py-2.5 px-4 rounded hover:bg-blue-800">Member Portal ↗</a>
          <a href="/logout" class="block py-2.5 px-4 rounded text-red-300 hover:bg-blue-800">Logout</a>
        </nav>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 flex flex-col overflow-y-auto">
      <header class="bg-white shadow px-6 py-4 flex justify-between items-center">
        <h1 class="text-xl font-bold text-gray-800">Administrator Dashboard</h1>
        <div class="text-sm font-medium text-gray-600">${settings.school_name} (${settings.school_year})</div>
      </header>
      <div class="p-6 space-y-6">
        <!-- Stats -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="bg-white p-4 rounded-xl shadow border">
            <div class="text-gray-500 text-sm">Total Members</div>
            <div class="text-2xl font-bold text-blue-600">${stats.totalMembers}</div>
          </div>
          <div class="bg-white p-4 rounded-xl shadow border">
            <div class="text-gray-500 text-sm">Active Members</div>
            <div class="text-2xl font-bold text-green-600">${stats.activeMembers}</div>
          </div>
          <div class="bg-white p-4 rounded-xl shadow border">
            <div class="text-gray-500 text-sm">Present Today</div>
            <div class="text-2xl font-bold text-indigo-600">${stats.presentToday}</div>
          </div>
        </div>

        <!-- Register Member Form Section -->
        <div class="bg-white p-6 rounded-xl shadow border">
          <h2 class="text-lg font-bold mb-4 text-gray-800">Register New Member</h2>
          <form id="memberForm" class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input type="text" id="first_name" placeholder="First Name" required class="p-2 border rounded">
            <input type="text" id="middle_name" placeholder="Middle Name" class="p-2 border rounded">
            <input type="text" id="last_name" placeholder="Last Name" required class="p-2 border rounded">
            <select id="gender" class="p-2 border rounded"><option>Male</option><option>Female</option></select>
            <input type="text" id="grade_level" placeholder="Grade Level (e.g. Grade 10)" required class="p-2 border rounded">
            <input type="text" id="section" placeholder="Section (e.g. Rizal)" required class="p-2 border rounded">
            <input type="text" id="position" placeholder="Position (e.g. Member)" class="p-2 border rounded">
            <input type="text" id="contact_info" placeholder="Contact Info" class="p-2 border rounded">
            <input type="email" id="email" placeholder="Email Address" class="p-2 border rounded">
            <button type="submit" class="md:col-span-3 bg-blue-600 text-white py-2 rounded font-bold hover:bg-blue-700">Register Member & Generate Credentials</button>
          </form>
          <div id="credentialResult" class="mt-4 hidden p-4 bg-green-50 border border-green-200 rounded-lg"></div>
        </div>

        <!-- Members List -->
        <div class="bg-white p-6 rounded-xl shadow border overflow-x-auto">
          <h2 class="text-lg font-bold mb-4 text-gray-800">Registered Members</h2>
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b bg-gray-100 text-sm">
                <th class="p-3">Member ID</th>
                <th class="p-3">Full Name</th>
                <th class="p-3">Grade & Section</th>
                <th class="p-3">Position</th>
                <th class="p-3">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y text-sm">
              ${members.map(m => `
                <tr>
                  <td class="p-3 font-semibold">${m.member_id}</td>
                  <td class="p-3">${m.first_name} ${m.last_name}</td>
                  <td class="p-3">${m.grade_level} - ${m.section}</td>
                  <td class="p-3">${m.position}</td>
                  <td class="p-3 space-x-2">
                    <button onclick="deleteMember(${m.id})" class="text-red-600 hover:underline font-medium">Delete</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </main>

    <script>
      document.getElementById('memberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
          first_name: document.getElementById('first_name').value,
          middle_name: document.getElementById('middle_name').value,
          last_name: document.getElementById('last_name').value,
          gender: document.getElementById('gender').value,
          grade_level: document.getElementById('grade_level').value,
          section: document.getElementById('section').value,
          position: document.getElementById('position').value,
          contact_info: document.getElementById('contact_info').value,
          email: document.getElementById('email').value
        };
        const res = await fetch('/api/admin/members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if(data.success) {
          const c = data.credentials;
          document.getElementById('credentialResult').innerHTML = \`
            <h3 class="font-bold text-green-800 text-lg">Member Successfully Registered!</h3>
            <p><strong>ID:</strong> \${c.member_id}</p>
            <p><strong>Username:</strong> \${c.username}</p>
            <p><strong>Temporary Password:</strong> \${c.tempPassword}</p>
            <div class="mt-2"><img src="\${c.qrCodeDataUrl}" class="w-32 h-32"/></div>
            <button onclick="location.reload()" class="mt-3 bg-green-600 text-white px-4 py-1.5 rounded text-sm font-bold">Done / Refresh</button>
          \`;
          document.getElementById('credentialResult').classList.remove('hidden');
        } else {
          alert(data.message);
        }
      });

      async function deleteMember(id) {
        if(!confirm('Are you sure you want to delete this member?')) return;
        const res = await fetch('/api/admin/members/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const data = await res.json();
        if(data.success) location.reload();
        else alert(data.message);
      }
    </script>
  </body></html>`;
}

function renderMemberPortal(member, settings, qrCodeDataUrl, attendance, announcements) {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8"><title>Member Portal - ${settings.org_name}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      @media print {
        body * { visibility: hidden; }
        #printableIdCard, #printableIdCard * { visibility: visible; }
        #printableIdCard { position: absolute; left: 0; top: 0; width: 100%; }
      }
    </style>
  </head>
  <body class="bg-gray-100 min-h-screen p-6">
    <div class="max-w-4xl mx-auto space-y-6">
      <div class="bg-white p-6 rounded-xl shadow flex justify-between items-center">
        <div>
          <h1 class="text-xl font-bold text-blue-900">Welcome, ${member.first_name} ${member.last_name}</h1>
          <p class="text-sm text-gray-500">${settings.school_name} | ${settings.org_name}</p>
        </div>
        <a href="/logout" class="bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-600">Logout</a>
      </div>

      <!-- Digital ID Card (Standardized Sizing) -->
      <div class="bg-white p-6 rounded-xl shadow flex flex-col items-center">
        <h2 class="text-lg font-bold mb-4 text-gray-800">Your Digital Organization ID Card</h2>
        
        <div id="printableIdCard" class="w-[350px] bg-white border-2 border-blue-900 rounded-2xl shadow-lg p-5 text-center relative overflow-hidden">
          <div class="bg-blue-900 text-white py-2 rounded-t-lg -mx-5 -mt-5 mb-4">
            <h3 class="text-xs font-bold uppercase tracking-wider">${settings.school_name}</h3>
            <h4 class="text-sm font-extrabold">${settings.org_name}</h4>
          </div>
          <div class="w-24 h-24 mx-auto bg-gray-200 rounded-full flex items-center justify-center text-2xl font-bold text-gray-600 mb-3 border-4 border-blue-900">
            ${member.first_name[0]}${member.last_name[0]}
          </div>
          <h3 class="text-lg font-black text-gray-900">${member.first_name} ${member.last_name}</h3>
          <p class="text-xs text-blue-700 font-bold mb-2">${member.position}</p>
          
          <div class="bg-gray-50 p-2 rounded text-xs text-left space-y-1 mb-3 border">
            <div><strong>Member ID:</strong> ${member.member_id}</div>
            <div><strong>Grade/Section:</strong> ${member.grade_level} - ${member.section}</div>
            <div><strong>Username:</strong> ${member.user_id ? member.username : ''}</div>
          </div>

          <div class="flex justify-center mb-2">
            <img src="${qrCodeDataUrl}" class="w-28 h-28 border p-1 bg-white rounded">
          </div>
          <p class="text-[9px] text-gray-400">Official Membership Identification Card</p>
        </div>

        <div class="mt-4 flex space-x-3">
          <button onclick="window.print()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2 rounded shadow">Print ID Card</button>
          <a href="${qrCodeDataUrl}" download="${member.member_id}-QR.png" class="bg-green-600 hover:bg-green-700 text-white font-bold px-4 py-2 rounded shadow inline-block">Download QR</a>
        </div>
      </div>

      <!-- Attendance History -->
      <div class="bg-white p-6 rounded-xl shadow">
        <h2 class="text-lg font-bold mb-4 text-gray-800">My Attendance Records</h2>
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="border-b bg-gray-50">
              <th class="p-3">Event</th>
              <th class="p-3">Date</th>
              <th class="p-3">Time In</th>
              <th class="p-3">Time Out</th>
              <th class="p-3">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            ${attendance.map(a => `
              <tr>
                <td class="p-3 font-semibold">${a.event_name}</td>
                <td class="p-3">${a.attendance_date}</td>
                <td class="p-3">${a.time_in || '---'}</td>
                <td class="p-3">${a.time_out || '---'}</td>
                <td class="p-3"><span class="px-2 py-1 rounded text-xs font-bold ${a.status==='Present'?'bg-green-100 text-green-800':a.status==='Late'?'bg-yellow-100 text-yellow-800':'bg-blue-100 text-blue-800'}">${a.status}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </body></html>`;
}

function renderScannerPortal(events, settings) {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QR Scanner Portal - ${settings.org_name}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js"></script>
  </head>
  <body class="bg-gray-900 text-white min-h-screen flex flex-col items-center p-4">
    <div class="w-full max-w-md bg-gray-800 rounded-2xl shadow-xl p-6 space-y-4">
      <div class="flex justify-between items-center border-b border-gray-700 pb-3">
        <h1 class="text-lg font-bold">QR Attendance Scanner</h1>
        <a href="/admin" class="text-xs text-blue-400 underline">Dashboard</a>
      </div>

      <div>
        <label class="block text-xs uppercase font-bold text-gray-400 mb-1">Select Event</label>
        <select id="eventId" class="w-full bg-gray-700 border border-gray-600 rounded p-2.5 text-white">
          ${events.map(e => `<option value="${e.id}">${e.event_name} (${e.event_date})</option>`).join('')}
        </select>
      </div>

      <div>
        <label class="block text-xs uppercase font-bold text-gray-400 mb-1">Select Scan Type</label>
        <div class="grid grid-cols-2 gap-3">
          <button type="button" id="btnTimeIn" onclick="setScanType('Time In')" class="py-3 rounded-lg font-bold bg-green-600 text-white shadow-lg border-2 border-green-400">TIME IN</button>
          <button type="button" id="btnTimeOut" onclick="setScanType('Time Out')" class="py-3 rounded-lg font-bold bg-gray-700 text-gray-300 border border-gray-600">TIME OUT</button>
        </div>
      </div>

      <div class="pt-2">
        <button onclick="startScanner()" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-bold shadow-lg">START CAMERA</button>
      </div>

      <div id="reader" class="w-full overflow-hidden rounded-lg mt-4 bg-black"></div>

      <div id="scanResult" class="hidden p-4 rounded-xl text-center font-bold"></div>
    </div>

    <audio id="successSound" src="https://www.soundjay.com/buttons/sounds/button-3.mp3" preload="auto"></audio>
    <audio id="errorSound" src="https://www.soundjay.com/buttons/sounds/button-10.mp3" preload="auto"></audio>

    <script>
      let currentScanType = 'Time In';
      let html5QrCode = null;

      function setScanType(type) {
        currentScanType = type;
        const bIn = document.getElementById('btnTimeIn');
        const bOut = document.getElementById('btnTimeOut');
        if(type === 'Time In') {
          bIn.className = 'py-3 rounded-lg font-bold bg-green-600 text-white shadow-lg border-2 border-green-400';
          bOut.className = 'py-3 rounded-lg font-bold bg-gray-700 text-gray-300 border border-gray-600';
        } else {
          bOut.className = 'py-3 rounded-lg font-bold bg-blue-600 text-white shadow-lg border-2 border-blue-400';
          bIn.className = 'py-3 rounded-lg font-bold bg-gray-700 text-gray-300 border border-gray-600';
        }
      }

      function playSound(type) {
        try {
          if(type === 'success') document.getElementById('successSound').play();
          else document.getElementById('errorSound').play();
        } catch(e) {}
      }

      function startScanner() {
        if(html5QrCode) {
          html5QrCode.stop().catch(() => {});
        }
        html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: 250 },
          async (decodedText) => {
            const eventId = document.getElementById('eventId').value;
            const res = await fetch('/api/scanner/scan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: currentScanType })
            });
            const data = await res.json();
            const resBox = document.getElementById('scanResult');
            resBox.classList.remove('hidden');

            if(data.success) {
              playSound('success');
              resBox.className = 'p-4 rounded-xl text-center bg-green-800 text-green-100 font-bold';
              resBox.innerHTML = \`✓ \${currentScanType.toUpperCase()} RECORDED<br><span class="text-sm font-normal">\${data.member.first_name} \${data.member.last_name} (\${data.member.member_id})</span><br><span class="text-xs">\${data.time}</span>\`;
            } else {
              playSound('error');
              resBox.className = 'p-4 rounded-xl text-center bg-red-800 text-red-100 font-bold';
              resBox.innerHTML = \`⚠ \${data.message}\`;
            }

            setTimeout(() => { resBox.classList.add('hidden'); }, 4000);
          },
          (errorMessage) => {}
        ).catch(err => {
          alert('Unable to start camera: ' + err);
        });
      }
    </script>
  </body></html>`;
}

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
});
