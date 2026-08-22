/**
 * ClubTrack QR Attendance System
 * Organization and Club Management System for High School (PostgreSQL Edition)
 * Main Source Code - Single File Architecture
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
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'clubtrack-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// --- DATABASE INITIALIZATION ---
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name TEXT DEFAULT 'ABC High School',
        organization_name TEXT DEFAULT 'Supreme Student Council',
        school_year TEXT DEFAULT '2026–2027',
        org_description TEXT DEFAULT 'Official student governance organization.',
        theme_color TEXT DEFAULT '#4f46e5',
        org_prefix TEXT DEFAULT 'SSC'
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'scanner')),
        name TEXT NOT NULL,
        must_change_password BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        member_id TEXT UNIQUE NOT NULL,
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
        photo_url TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        event_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        late_cutoff TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        attendance_date TEXT NOT NULL,
        time_in TEXT,
        time_out TEXT,
        status TEXT DEFAULT 'Present',
        scan_method TEXT DEFAULT 'QR',
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        date_posted TEXT NOT NULL,
        expiry_date TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        timestamp TEXT NOT NULL,
        username TEXT,
        role TEXT,
        action TEXT NOT NULL,
        details TEXT
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        timestamp TEXT NOT NULL,
        scanner_user TEXT,
        event_name TEXT,
        scan_type TEXT,
        qr_value TEXT,
        result_status TEXT,
        message TEXT
      );
    `);

    // Default Settings
    const settingsRes = await client.query('SELECT * FROM organization_settings WHERE id = 1');
    if (settingsRes.rows.length === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, organization_name, school_year, org_description, theme_color, org_prefix)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official student governance organization.', '#4f46e5', 'SSC')
      `);
    }

    // Default Admin Account
    const adminRes = await client.query("SELECT * FROM users WHERE username = 'admin'");
    if (adminRes.rows.length === 0) {
      const hashedPass = await bcrypt.hash('admin123', 10);
      await client.query(`
        INSERT INTO users (username, password, role, name, must_change_password, status)
        VALUES ('admin', $1, 'admin', 'System Administrator', true, 'active')
      `, [hashedPass]);
    }
    console.log('Database initialized successfully with PostgreSQL.');
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

// Audit Logger helper
async function logAction(username, role, action, details) {
  try {
    const timestamp = new Date().toLocaleString();
    await pool.query(
      'INSERT INTO audit_logs (timestamp, username, role, action, details) VALUES ($1, $2, $3, $4, $5)',
      [timestamp, username || 'System', role || 'System', action, details]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

// --- HTML TEMPLATE ENGINE WITH BUILT-IN UI ---
function renderLayout(title, content, user, settings) {
  const primaryColor = settings?.theme_color || '#4f46e5';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - ClubTrack QR Attendance</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
  <style>
    :root { --primary: ${primaryColor}; }
    .bg-primary { background-color: var(--primary); }
    .text-primary { color: var(--primary); }
    .border-primary { border-color: var(--primary); }
  </style>
</head>
<body class="bg-slate-50 min-h-screen font-sans text-slate-800">
  ${content}
</body>
</html>`;
}

// --- ROUTES ---

// Login Page
app.get('/login', async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings WHERE id = 1');
  const settings = settingsRes.rows[0];
  
  const html = `
    <div class="min-h-screen flex items-center justify-center p-4">
      <div class="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-slate-100">
        <div class="text-center mb-8">
          <div class="inline-flex p-3 bg-indigo-50 text-primary rounded-2xl mb-3 text-2xl font-bold">CT</div>
          <h1 class="text-2xl font-black text-slate-900">${settings.organization_name}</h1>
          <p class="text-sm text-slate-500">${settings.school_name} (${settings.school_year})</p>
          <span class="inline-block mt-2 px-3 py-1 bg-indigo-100 text-primary text-xs font-semibold rounded-full">ClubTrack QR Attendance System</span>
        </div>
        
        <form action="/login" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Username</label>
            <input type="text" name="username" required class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Password</label>
            <input type="password" name="password" required class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm">
          </div>
          <button type="submit" class="w-full py-3 bg-primary text-white font-bold rounded-xl shadow-lg hover:opacity-95 transition text-sm">Sign In to Portal</button>
        </form>
        
        <div class="mt-6 text-center text-xs text-slate-400">
          Default Admin: admin / admin123
        </div>
      </div>
    </div>
  `;
  res.send(renderLayout('Login', html, null, settings));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.redirect('/login?error=Invalid credentials');
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.redirect('/login?error=Invalid credentials');
    if (user.status !== 'active') return res.redirect('/login?error=Account is inactive');

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;
    req.session.name = user.name;
    req.session.mustChangePassword = user.must_change_password;

    await logAction(user.username, user.role, 'Login', 'User logged in successfully');

    if (user.must_change_password) {
      return res.redirect('/change-password-required');
    }

    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member');
  } catch (err) {
    console.error(err);
    res.redirect('/login?error=Server error');
  }
});

// Forced Password Change Modal/Page
app.get('/change-password-required', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
  
  const html = `
    <div class="min-h-screen flex items-center justify-center p-4">
      <div class="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-amber-200">
        <div class="mb-6 bg-amber-50 border border-amber-200 p-4 rounded-xl">
          <h2 class="text-amber-800 font-bold text-base mb-1">Security Reminder</h2>
          <p class="text-amber-700 text-xs leading-relaxed">Welcome! Your account is using a temporary password. Please create a new private password before proceeding.</p>
        </div>
        <form action="/change-password-required" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">New Password (Min 8 chars)</label>
            <input type="password" name="new_password" minlength="8" required class="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Confirm New Password</label>
            <input type="password" name="confirm_password" minlength="8" required class="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm">
          </div>
          <button type="submit" class="w-full py-3 bg-primary text-white font-bold rounded-xl text-sm">Update Password & Secure Account</button>
        </form>
      </div>
    </div>
  `;
  res.send(renderLayout('Security Update', html, null, settings));
});

app.post('/change-password-required', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const { new_password, confirm_password } = req.body;
  if (new_password !== confirm_password || new_password.length < 8) {
    return res.redirect('/change-password-required?error=Passwords must match and be at least 8 characters.');
  }
  const hashed = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password = $1, must_change_password = false WHERE id = $2', [hashed, req.session.userId]);
  req.session.mustChangePassword = false;
  await logAction(req.session.username, req.session.role, 'Password Change', 'User changed temporary password.');
  
  if (req.session.role === 'admin') res.redirect('/admin');
  else if (req.session.role === 'scanner') res.redirect('/scanner');
  else res.redirect('/member');
});

// Logout
app.get('/logout', async (req, res) => {
  if (req.session.username) {
    await logAction(req.session.username, req.session.role, 'Logout', 'User logged out.');
  }
  req.session.destroy(() => res.redirect('/login'));
});

// Admin Portal Dashboard
app.get('/admin', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') return res.redirect('/login');
  const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
  
  const totalMembers = (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count;
  const activeMembers = (await pool.query("SELECT COUNT(*) FROM users WHERE role = 'member' AND status = 'active'")).rows[0].count;
  const todayDate = new Date().toLocaleDateString();
  const presentToday = (await pool.query('SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date = $1', [todayDate])).rows[0].count;
  const invalidScans = (await pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result_status = 'INVALID'")).rows[0].count;

  const membersList = (await pool.query('SELECT m.*, u.username, u.status FROM members m JOIN users u ON m.user_id = u.id ORDER BY m.id DESC')).rows[0] ? (await pool.query('SELECT m.*, u.username, u.status FROM members m JOIN users u ON m.user_id = u.id ORDER BY m.id DESC')).rows : [];
  const eventsList = (await pool.query('SELECT * FROM events ORDER BY id DESC')).rows;
  const liveLogs = (await pool.query('SELECT a.*, m.first_name, m.last_name, m.grade_level, m.section, e.name as event_name FROM attendance a JOIN members m ON a.member_id = m.id JOIN events e ON a.event_id = e.id ORDER BY a.id DESC LIMIT 20')).rows;

  const html = `
    <div class="flex h-screen overflow-hidden">
      <aside class="w-64 bg-slate-900 text-white flex flex-col">
        <div class="p-6 border-b border-slate-800">
          <h2 class="font-black text-lg">${settings.organization_name}</h2>
          <p class="text-xs text-slate-400">Admin Control Panel</p>
        </div>
        <nav class="flex-1 p-4 space-y-1 overflow-y-auto text-sm">
          <a href="/admin" class="block py-2.5 px-4 rounded-xl bg-indigo-600 font-semibold">Dashboard & Stats</a>
          <a href="/admin/members" class="block py-2.5 px-4 rounded-xl hover:bg-slate-800 text-slate-300">Member Management</a>
          <a href="/admin/events" class="block py-2.5 px-4 rounded-xl hover:bg-slate-800 text-slate-300">Events Management</a>
          <a href="/admin/attendance" class="block py-2.5 px-4 rounded-xl hover:bg-slate-800 text-slate-300">Attendance Logs</a>
          <a href="/admin/scanners" class="block py-2.5 px-4 rounded-xl hover:bg-slate-800 text-slate-300">Scanner Accounts</a>
          <a href="/admin/settings" class="block py-2.5 px-4 rounded-xl hover:bg-slate-800 text-slate-300">Organization Settings</a>
          <a href="/logout" class="block py-2.5 px-4 rounded-xl text-rose-400 hover:bg-slate-800 mt-6">Sign Out</a>
        </nav>
      </aside>
      
      <main class="flex-1 overflow-y-auto p-8">
        <header class="flex justify-between items-center mb-8">
          <div>
            <h1 class="text-2xl font-black text-slate-900">Admin Dashboard</h1>
            <p class="text-xs text-slate-500">Welcome back, ${req.session.name}</p>
          </div>
          <span class="px-4 py-2 bg-indigo-50 text-primary font-bold text-xs rounded-xl border border-indigo-100">${settings.school_name}</span>
        </header>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
            <p class="text-xs font-bold text-slate-400 uppercase">Total Members</p>
            <h3 class="text-3xl font-black text-slate-900 mt-2">${totalMembers}</h3>
          </div>
          <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
            <p class="text-xs font-bold text-slate-400 uppercase">Active Members</p>
            <h3 class="text-3xl font-black text-emerald-600 mt-2">${activeMembers}</h3>
          </div>
          <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
            <p class="text-xs font-bold text-slate-400 uppercase">Present Today</p>
            <h3 class="text-3xl font-black text-indigo-600 mt-2">${presentToday}</h3>
          </div>
          <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
            <p class="text-xs font-bold text-slate-400 uppercase">Invalid Scans</p>
            <h3 class="text-3xl font-black text-rose-600 mt-2">${invalidScans}</h3>
          </div>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-8">
          <h2 class="text-lg font-bold text-slate-900 mb-4">Register New Member</h2>
          <form action="/admin/members/add" method="POST" class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input type="text" name="first_name" placeholder="First Name" required class="px-4 py-3 rounded-xl border text-sm">
            <input type="text" name="middle_name" placeholder="Middle Name" class="px-4 py-3 rounded-xl border text-sm">
            <input type="text" name="last_name" placeholder="Last Name" required class="px-4 py-3 rounded-xl border text-sm">
            <input type="text" name="grade_level" placeholder="Grade Level (e.g. Grade 10)" required class="px-4 py-3 rounded-xl border text-sm">
            <input type="text" name="section" placeholder="Section (e.g. Rizal)" required class="px-4 py-3 rounded-xl border text-sm">
            <input type="text" name="position" placeholder="Position (e.g. Member)" class="px-4 py-3 rounded-xl border text-sm">
            <button type="submit" class="md:col-span-3 py-3 bg-primary text-white font-bold rounded-xl text-sm shadow">Register Member & Generate QR</button>
          </form>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 class="text-lg font-bold text-slate-900 mb-4">Live Attendance Feed</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="bg-slate-50 text-slate-400 text-xs uppercase font-bold">
                <tr>
                  <th class="p-3">Member</th>
                  <th class="p-3">Event</th>
                  <th class="p-3">Time In</th>
                  <th class="p-3">Time Out</th>
                  <th class="p-3">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                ${liveLogs.map(l => `
                  <tr>
                    <td class="p-3 font-bold">${l.first_name} ${l.last_name} (${l.grade_level})</td>
                    <td class="p-3">${l.event_name}</td>
                    <td class="p-3">${l.time_in || '-'}</td>
                    <td class="p-3">${l.time_out || '-'}</td>
                    <td class="p-3"><span class="px-2.5 py-1 bg-emerald-50 text-emerald-600 rounded-full text-xs font-bold">${l.status}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  `;
  res.send(renderLayout('Admin Dashboard', html, req.session, settings));
});

// Admin Add Member Handler
app.post('/admin/members/add', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'admin') return res.redirect('/login');
  const { first_name, middle_name, last_name, grade_level, section, position } = req.body;
  const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];

  const baseUsername = (first_name + last_name).toLowerCase().replace(/[^a-z0-9]/g, '');
  let username = baseUsername;
  let counter = 1;
  while ((await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows.length > 0) {
    username = `${baseUsername}${counter++}`;
  }

  const tempPass = Math.random().toString(36).slice(-8);
  const hashedPass = await bcrypt.hash(tempPass, 10);
  const userRes = await pool.query(
    'INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, $3, $4, true) RETURNING id',
    [username, hashedPass, 'member', `${first_name} ${last_name}`]
  );
  const userId = userRes.rows[0].id;

  const countRes = await pool.query('SELECT COUNT(*) FROM members');
  const memberNum = String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0');
  const memberIdCode = `${settings.org_prefix}-${new Date().getFullYear()}-${memberNum}`;
  const qrToken = crypto.randomUUID();

  await pool.query(
    'INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, grade_level, section, position, qr_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [userId, memberIdCode, first_name, middle_name || '', last_name, grade_level, section, position || 'Member', qrToken]
  );

  await logAction(req.session.username, req.session.role, 'Add Member', `Registered member ${first_name} ${last_name} (${memberIdCode})`);
  res.redirect('/admin');
});

// Scanner Portal (Mobile Optimized QR Scanner)
app.get('/scanner', async (req, res) => {
  if (!req.session.userId || (req.session.role !== 'scanner' && req.session.role !== 'admin')) return res.redirect('/login');
  const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
  const events = (await pool.query('SELECT * FROM events ORDER BY id DESC')).rows;

  const html = `
    <div class="max-w-md mx-auto p-4 min-h-screen flex flex-col justify-between bg-slate-900 text-white">
      <div>
        <div class="flex justify-between items-center mb-4">
          <h1 class="text-lg font-black">${settings.organization_name} Scanner</h1>
          <a href="/logout" class="text-xs text-rose-400 font-bold">Logout</a>
        </div>

        <div class="space-y-4 mb-6">
          <div>
            <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Select Event</label>
            <select id="eventSelect" class="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white font-bold text-sm">
              ${events.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('')}
            </select>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-400 uppercase mb-1">Scan Type</label>
            <div class="grid grid-cols-2 gap-3">
              <button onclick="setScanType('IN')" id="btnIn" class="py-4 bg-indigo-600 rounded-xl font-black text-white shadow-lg border-2 border-indigo-400">TIME IN</button>
              <button onclick="setScanType('OUT')" id="btnOut" class="py-4 bg-slate-800 rounded-xl font-black text-slate-400 border-2 border-slate-700">TIME OUT</button>
            </div>
          </div>
        </div>

        <div class="bg-black rounded-2xl overflow-hidden relative border border-slate-800 mb-4">
          <div id="reader" style="width: 100%;"></div>
        </div>

        <div id="resultBox" class="p-4 rounded-2xl bg-slate-800 text-center hidden">
          <h3 id="resultTitle" class="text-lg font-black mb-1"></h3>
          <p id="resultText" class="text-sm text-slate-300"></p>
        </div>
      </div>

      <div class="text-center text-xs text-slate-500 py-2">
        ClubTrack Scanner v1.0 • Audio Enabled
      </div>
    </div>

    <script>
      let currentScanType = 'IN';
      function setScanType(type) {
        currentScanType = type;
        if(type === 'IN') {
          document.getElementById('btnIn').className = 'py-4 bg-indigo-600 rounded-xl font-black text-white shadow-lg border-2 border-indigo-400';
          document.getElementById('btnOut').className = 'py-4 bg-slate-800 rounded-xl font-black text-slate-400 border-2 border-slate-700';
        } else {
          document.getElementById('btnOut').className = 'py-4 bg-emerald-600 rounded-xl font-black text-white shadow-lg border-2 border-emerald-400';
          document.getElementById('btnIn').className = 'py-4 bg-slate-800 rounded-xl font-black text-slate-400 border-2 border-slate-700';
        }
      }

      function playSound(type) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        if(type === 'success') {
          osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.15);
        } else {
          osc.frequency.setValueAtTime(220, ctx.currentTime); // A3
          gain.gain.setValueAtTime(0.2, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.3);
        }
      }

      let isProcessing = false;
      function onScanSuccess(decodedText) {
        if(isProcessing) return;
        isProcessing = true;

        const eventId = document.getElementById('eventSelect').value;
        fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: currentScanType })
        })
        .then(res => res.json())
        .then(data => {
          const box = document.getElementById('resultBox');
          const title = document.getElementById('resultTitle');
          const text = document.getElementById('resultText');
          box.classList.remove('hidden');
          
          if(data.success) {
            playSound('success');
            box.className = 'p-4 rounded-2xl bg-emerald-900 border border-emerald-700 text-center';
            title.textContent = '✓ ' + data.message;
            text.textContent = data.name + ' (' + data.member_id + ')';
          } else {
            playSound('error');
            box.className = 'p-4 rounded-2xl bg-rose-900 border border-rose-700 text-center';
            title.textContent = '⚠ ' + data.message;
            text.textContent = data.details || 'Please check ID';
          }
          setTimeout(() => { isProcessing = false; }, 3000);
        })
        .catch(err => {
          isProcessing = false;
        });
      }

      const html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
      html5QrcodeScanner.render(onScanSuccess);
    </script>
  `;
  res.send(renderLayout('QR Scanner', html, req.session, settings));
});

// Scanner API Processing Endpoint
app.post('/api/scan', async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  const todayDate = new Date().toLocaleDateString();
  const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      await pool.query(
        'INSERT INTO scanner_logs (timestamp, scanner_user, event_name, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [new Date().toLocaleString(), req.session.username || 'Scanner', event_id, scan_type, qr_token, 'INVALID', 'Unregistered QR Code']
      );
      return res.json({ success: false, message: 'QR CODE NOT REGISTERED', details: 'Does not belong to any member.' });
    }

    const member = memberRes.rows[0];
    const userRes = await pool.query('SELECT status FROM users WHERE id = $1', [member.user_id]);
    if (userRes.rows[0].status !== 'active') {
      return res.json({ success: false, message: 'ACCOUNT INACTIVE', details: 'Member account is deactivated.' });
    }

    // Check existing attendance for this event & date
    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, todayDate]);

    if (scan_type === 'IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({ success: false, message: 'ALREADY TIMED IN', details: `${member.first_name} already timed in at ${attRes.rows[0].time_in}` });
      }
      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1 WHERE id = $2', [timeNow, attRes.rows[0].id]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status) VALUES ($1, $2, $3, $4, $5)', [member.id, event_id, todayDate, timeNow, 'Present']);
      }
    } else {
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ success: false, message: 'MISSING TIME IN', details: 'Member must Time In first.' });
      }
      if (attRes.rows[0].time_out) {
        return res.json({ success: false, message: 'ALREADY TIMED OUT', details: `${member.first_name} already timed out.` });
      }
      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [timeNow, attRes.rows[0].id]);
    }

    await pool.query(
      'INSERT INTO scanner_logs (timestamp, scanner_user, event_name, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [new Date().toLocaleString(), req.session.username || 'Scanner', event_id, scan_type, member.member_id, 'SUCCESS', 'Attendance recorded']
    );

    res.json({ success: true, message: `TIME ${scan_type} RECORDED`, name: `${member.first_name} ${member.last_name}`, member_id: member.member_id });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'SERVER ERROR', details: err.message });
  }
});

// Member Portal
app.get('/member', async (req, res) => {
  if (!req.session.userId || req.session.role !== 'member') return res.redirect('/login');
  const settings = (await pool.query('SELECT * FROM organization_settings WHERE id = 1')).rows[0];
  const memberRes = await pool.query('SELECT m.*, u.username, u.status FROM members m JOIN users u ON m.user_id = u.id WHERE m.user_id = $1', [req.session.userId]);
  
  if (memberRes.rows.length === 0) return res.redirect('/logout');
  const member = memberRes.rows[0];
  const announcements = (await pool.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 5')).rows;
  const attendanceLogs = (await pool.query('SELECT a.*, e.name as event_name FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.member_id = $1 ORDER BY a.id DESC', [member.id])).rows;

  // Generate QR Code Data URL
  const qrCodeDataUrl = await QRCode.toDataURL(member.qr_token);

  const html = `
    <div class="max-w-4xl mx-auto p-6">
      <header class="flex justify-between items-center mb-8 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <div>
          <h1 class="text-xl font-black text-slate-900">${settings.organization_name} Portal</h1>
          <p class="text-xs text-slate-500">${settings.school_name}</p>
        </div>
        <div class="flex items-center space-x-4">
          <span class="text-xs font-bold text-primary bg-indigo-50 px-3 py-1.5 rounded-xl">${member.member_id}</span>
          <a href="/logout" class="text-xs font-bold text-rose-600">Sign Out</a>
        </div>
      </header>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 text-center">
          <div class="w-24 h-24 bg-indigo-100 rounded-full mx-auto mb-4 flex items-center text-3xl font-black text-primary justify-center">${member.first_name[0]}${member.last_name[0]}</div>
          <h2 class="text-lg font-black text-slate-900">${member.first_name} ${member.last_name}</h2>
          <p class="text-xs text-slate-500">${member.grade_level} - ${member.section}</p>
          <span class="inline-block mt-3 px-3 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded-full">${member.position}</span>
        </div>

        <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 md:col-span-2 flex flex-col items-center justify-center text-center">
          <h3 class="text-sm font-bold text-slate-700 mb-2 uppercase">Digital Attendance QR ID</h3>
          <img src="${qrCodeDataUrl}" alt="Member QR" class="w-40 h-40 border-4 border-slate-50 rounded-xl shadow">
          <p class="text-xs text-slate-400 mt-2">Present this QR code to the scanner officer during events.</p>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-8">
        <h3 class="text-base font-bold text-slate-900 mb-4">My Attendance History</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 text-slate-400 text-xs uppercase font-bold">
              <tr>
                <th class="p-3">Event</th>
                <th class="p-3">Date</th>
                <th class="p-3">Time In</th>
                <th class="p-3">Time Out</th>
                <th class="p-3">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${attendanceLogs.length === 0 ? '<tr><td colspan="5" class="p-4 text-center text-slate-400 text-xs">No attendance records found yet.</td></tr>' : attendanceLogs.map(a => `
                <tr>
                  <td class="p-3 font-bold">${a.event_name}</td>
                  <td class="p-3">${a.attendance_date}</td>
                  <td class="p-3">${a.time_in || '-'}</td>
                  <td class="p-3">${a.time_out || '-'}</td>
                  <td class="p-3"><span class="px-2.5 py-1 bg-indigo-50 text-indigo-600 rounded-full text-xs font-bold">${a.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h3 class="text-base font-bold text-slate-900 mb-4">Organization Announcements</h3>
        <div class="space-y-4">
          ${announcements.map(ann => `
            <div class="p-4 bg-indigo-50/50 rounded-xl border border-indigo-100">
              <h4 class="font-bold text-sm text-slate-900 mb-1">${ann.title}</h4>
              <p class="text-xs text-slate-600">${ann.message}</p>
              <span class="text-[10px] text-slate-400 mt-2 block">Posted: ${ann.date_posted}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  res.send(renderLayout('Member Portal', html, req.session, settings));
});

// Root Redirect
app.get('/', (req, res) => {
  if (req.session.userId) {
    if (req.session.role === 'admin') return res.redirect('/admin');
    if (req.session.role === 'scanner') return res.redirect('/scanner');
    return res.redirect('/member');
  }
  res.redirect('/login');
});

// Initialize DB and Start Server
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClubTrack Server running on port ${PORT}`);
  });
});
