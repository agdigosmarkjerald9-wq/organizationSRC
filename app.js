/**
 * SCHOOL CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Built for Node.js, Express, and PostgreSQL.
 * Admin Login: username 'admin', password 'password123'
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Database Connection Pool
// Automatically reads process.env.DATABASE_URL if available (e.g. on Render), otherwise local fallback
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/school_attendance',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware Setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// --- DATABASE INITIALIZATION & MIGRATIONS ---
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        organization_name VARCHAR(255) DEFAULT 'Elite Coding & Robotics Club',
        school_name VARCHAR(255) DEFAULT 'National Science High School',
        logo VARCHAR(255) DEFAULT '',
        school_year VARCHAR(50) DEFAULT '2025-2026',
        attendance_start TIME DEFAULT '08:00:00',
        grace_period INT DEFAULT 15,
        scanner_pin VARCHAR(50) DEFAULT '1234'
      );

      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        club VARCHAR(150) DEFAULT 'Coding Club',
        year_level VARCHAR(50) DEFAULT 'Grade 11',
        course VARCHAR(150) DEFAULT 'STEM',
        section VARCHAR(50) DEFAULT 'Section A',
        contact VARCHAR(50) DEFAULT '',
        email VARCHAR(150) DEFAULT '',
        photo TEXT DEFAULT '',
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        temporary_password_status BOOLEAN DEFAULT TRUE,
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        date_joined DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(50) NOT NULL,
        date DATE NOT NULL,
        time_in TIME,
        time_out TIME,
        status VARCHAR(50) DEFAULT 'Present',
        remarks TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'Published',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action VARCHAR(255) NOT NULL,
        actor VARCHAR(100) NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed default settings if empty
    const settingsRes = await client.query('SELECT * FROM settings WHERE id = 1');
    if (settingsRes.rows.length === 0) {
      await client.query(`INSERT INTO settings (id, organization_name, school_name, school_year, attendance_start, grace_period, scanner_pin) 
                          VALUES (1, 'Elite Coding & Robotics Club', 'National Science High School', '2025-2026', '08:00:00', 15, '1234')`);
    }

    // Seed default admin account (username: admin, password: password123)
    const adminRes = await client.query('SELECT * FROM admins WHERE username = $1', ['admin']);
    if (adminRes.rows.length === 0) {
      const hash = await bcrypt.hash('password123', 10);
      await client.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
      console.log('Default Admin Account Created -> Username: admin | Password: password123');
    }

    console.log('PostgreSQL Database initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

initDB();

// --- HELPER FUNCTIONS ---
async function logAudit(action, actor, details) {
  try {
    await pool.query('INSERT INTO audit_logs (action, actor, details) VALUES ($1, $2, $3)', [action, actor, details]);
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// --- AUTHENTICATION MIDDLEWARES ---
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect('/admin/login');
}

function requireMember(req, res, next) {
  if (req.session && req.session.isMember) {
    return next();
  }
  res.redirect('/member/login');
}

// --- PUBLIC ROUTES ---
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>School Club Attendance System</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-white min-h-screen flex items-center justify-center p-6">
      <div class="max-w-4xl w-full bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl p-8 md:p-12 text-center">
        <div class="inline-block p-4 bg-indigo-600/20 text-indigo-400 rounded-2xl mb-6 text-4xl">🎓</div>
        <h1 class="text-3xl md:text-5xl font-extrabold tracking-tight mb-4">School Club QR Attendance System</h1>
        <p class="text-slate-400 text-lg mb-8 max-w-2xl mx-auto">Automated organization management, instant CR80 membership ID generation, and real-time smartphone QR code scanning.</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <a href="/admin/login" class="p-6 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded-xl transition group text-left">
            <div class="text-2xl mb-2 group-hover:scale-110 transition">🛡️</div>
            <h2 class="text-xl font-bold mb-1 text-indigo-400">Admin Portal</h2>
            <p class="text-sm text-slate-400">Manage members, view reports, configure schedules, and oversee records.</p>
          </a>
          <a href="/scanner" class="p-6 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded-xl transition group text-left">
            <div class="text-2xl mb-2 group-hover:scale-110 transition">📷</div>
            <h2 class="text-xl font-bold mb-1 text-emerald-400">Scanner Portal</h2>
            <p class="text-sm text-slate-400">Optimized smartphone camera portal for instantaneous Time In & Time Out.</p>
          </a>
          <a href="/member/login" class="p-6 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 rounded-xl transition group text-left">
            <div class="text-2xl mb-2 group-hover:scale-110 transition">👤</div>
            <h2 class="text-xl font-bold mb-1 text-sky-400">Member Portal</h2>
            <p class="text-sm text-slate-400">Personal dashboard to track attendance records, digital ID, and announcements.</p>
          </a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ==========================================
// ADMIN PORTAL ROUTES
// ==========================================

app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Login - School Club Attendance</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl shadow-xl p-8">
        <div class="text-center mb-6">
          <div class="inline-flex p-3 bg-indigo-600 text-white rounded-xl text-2xl font-bold mb-2">🛡️</div>
          <h1 class="text-2xl font-bold">Admin Portal Login</h1>
          <p class="text-sm text-slate-400">Sign in with administrator credentials</p>
        </div>
        ${req.query.error ? `<div class="mb-4 p-3 bg-rose-500/20 border border-rose-500 text-rose-300 rounded-lg text-sm">${req.query.error}</div>` : ''}
        <form action="/admin/login" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Username</label>
            <input type="text" name="username" required class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-indigo-500 text-white" placeholder="admin">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Password</label>
            <input type="password" name="password" required class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-indigo-500 text-white" placeholder="password123">
          </div>
          <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 font-bold rounded-lg transition shadow-lg shadow-indigo-600/30">Sign In to Dashboard</button>
        </form>
        <div class="mt-6 text-center text-xs text-slate-500">
          Default Credentials: username: <span class="text-slate-300 font-mono">admin</span> | password: <span class="text-slate-300 font-mono">password123</span>
        </div>
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
      const admin = result.rows[0];
      const match = await bcrypt.compare(password, admin.password_hash);
      if (match) {
        req.session.isAdmin = true;
        req.session.adminUser = admin.username;
        await logAudit('Admin Login Successful', admin.username, 'Admin logged in');
        return res.redirect('/admin');
      }
    }
    res.redirect('/admin/login?error=Invalid username or password');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/login?error=Database error occurred');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// Admin Dashboard
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const totalMembers = parseInt((await pool.query('SELECT COUNT(*) FROM members')).rows[0].count);
    const activeMembers = parseInt((await pool.query('SELECT COUNT(*) FROM members WHERE status = $1', ['Active'])).rows[0].count);
    const inactiveMembers = parseInt((await pool.query('SELECT COUNT(*) FROM members WHERE status = $1', ['Inactive'])).rows[0].count);
    
    const today = new Date().toISOString().split('T')[0];
    const todayStats = await pool.query('SELECT status, COUNT(*) FROM attendance WHERE date = $1 GROUP BY status', [today]);
    let presentToday = 0, lateToday = 0, absentToday = 0;
    todayStats.rows.forEach(row => {
      if (row.status === 'Present') presentToday = parseInt(row.count);
      if (row.status === 'Late') lateToday = parseInt(row.count);
      if (row.status === 'Absent') absentToday = parseInt(row.count);
    });
    const totalAttendanceToday = presentToday + lateToday;
    const attendancePercentage = activeMembers > 0 ? Math.round((totalAttendanceToday / activeMembers) * 100) : 0;

    const recentScans = (await pool.query(`
      SELECT a.*, m.full_name, m.position, m.photo FROM attendance a 
      JOIN members m ON a.member_id = m.member_id 
      ORDER BY a.created_at DESC LIMIT 5
    `)).rows;

    const recentMembers = (await pool.query('SELECT * FROM members ORDER BY created_at DESC LIMIT 5')).rows;

    res.send(renderAdminLayout('Dashboard', req.session.adminUser, settings, `
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
          <div class="text-slate-400 text-sm font-medium mb-1">Total Members</div>
          <div class="text-3xl font-extrabold text-white">${totalMembers}</div>
          <div class="text-xs text-indigo-400 mt-2">${activeMembers} Active, ${inactiveMembers} Inactive</div>
        </div>
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
          <div class="text-slate-400 text-sm font-medium mb-1">Attendance Today</div>
          <div class="text-3xl font-extrabold text-emerald-400">${totalAttendanceToday}</div>
          <div class="text-xs text-slate-400 mt-2">${presentToday} Present, ${lateToday} Late</div>
        </div>
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
          <div class="text-slate-400 text-sm font-medium mb-1">Attendance Rate</div>
          <div class="text-3xl font-extrabold text-sky-400">${attendancePercentage}%</div>
          <div class="text-xs text-slate-400 mt-2">Based on active members</div>
        </div>
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
          <div class="text-slate-400 text-sm font-medium mb-1">Absent Today</div>
          <div class="text-3xl font-extrabold text-rose-400">${absentToday}</div>
          <div class="text-xs text-slate-400 mt-2">Unchecked members</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
          <h2 class="text-lg font-bold mb-4 flex items-center justify-between">
            <span>Recent Scans</span>
            <a href="/admin/attendance" class="text-xs text-indigo-400 hover:underline">View All</a>
          </h2>
          <div class="space-y-3">
            ${recentScans.length === 0 ? '<p class="text-sm text-slate-500">No attendance scans recorded today.</p>' : recentScans.map(s => `
              <div class="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                <div class="flex items-center space-x-3">
                  <div class="w-10 h-10 rounded-full bg-slate-700 overflow-hidden flex items-center justify-center text-xs font-bold">
                    ${s.photo ? `<img src="${s.photo}" class="w-full h-full object-cover">` : s.full_name.charAt(0)}
                  </div>
                  <div>
                    <div class="font-bold text-sm text-white">${s.full_name}</div>
                    <div class="text-xs text-slate-400">${s.position} • Time In: ${s.time_in || 'N/A'}</div>
                  </div>
                </div>
                <span class="px-2.5 py-1 text-xs rounded-full font-semibold ${s.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}">${s.status}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
          <h2 class="text-lg font-bold mb-4 flex items-center justify-between">
            <span>Recent Registrations</span>
            <a href="/admin/members" class="text-xs text-indigo-400 hover:underline">Manage Members</a>
          </h2>
          <div class="space-y-3">
            ${recentMembers.length === 0 ? '<p class="text-sm text-slate-500">No members registered yet.</p>' : recentMembers.map(m => `
              <div class="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                <div class="flex items-center space-x-3">
                  <div class="w-10 h-10 rounded-full bg-slate-700 overflow-hidden flex items-center justify-center text-xs font-bold">
                    ${m.photo ? `<img src="${m.photo}" class="w-full h-full object-cover">` : m.full_name.charAt(0)}
                  </div>
                  <div>
                    <div class="font-bold text-sm text-white">${m.full_name}</div>
                    <div class="text-xs text-slate-400">${m.member_id} • ${m.course}</div>
                  </div>
                </div>
                <a href="/admin/member/id/${m.id}" target="_blank" class="px-3 py-1 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 text-xs rounded font-semibold transition">View ID</a>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Admin Members Management Page
app.get('/admin/members', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const search = req.query.search || '';
    const statusFilter = req.query.status || '';
    
    let query = 'SELECT * FROM members WHERE (full_name ILIKE $1 OR member_id ILIKE $1 OR username ILIKE $1)';
    let params = [`%${search}%`];
    
    if (statusFilter) {
      query += ' AND status = $2';
      params.push(statusFilter);
    }
    query += ' ORDER BY created_at DESC';

    const members = (await pool.query(query, params)).rows;

    res.send(renderAdminLayout('Members Management', req.session.adminUser, settings, `
      <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <form method="GET" action="/admin/members" class="flex flex-wrap items-center gap-3 flex-1">
          <input type="text" name="search" value="${search}" placeholder="Search name, ID, username..." class="px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500 flex-1 min-w-[220px]">
          <select name="status" class="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
            <option value="">All Status</option>
            <option value="Active" ${statusFilter === 'Active' ? 'selected' : ''}>Active</option>
            <option value="Inactive" ${statusFilter === 'Inactive' ? 'selected' : ''}>Inactive</option>
          </select>
          <button type="submit" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold transition">Filter</button>
          ${search || statusFilter ? '<a href="/admin/members" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm">Reset</a>' : ''}
        </form>
        <button onclick="openAddModal()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold transition flex items-center justify-center space-x-2 shadow-lg shadow-emerald-600/20">
          <span>+ Add Member</span>
        </button>
      </div>

      <div class="bg-slate-800 border border-slate-700 rounded-xl shadow-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-900/60 border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
                <th class="p-4">Member</th>
                <th class="p-4">Member ID</th>
                <th class="p-4">Position</th>
                <th class="p-4">Course / Section</th>
                <th class="p-4">Status</th>
                <th class="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/60 text-sm">
              ${members.length === 0 ? `<tr><td colspan="6" class="p-8 text-center text-slate-500">No members found.</td></tr>` : members.map(m => `
                <tr class="hover:bg-slate-700/30 transition">
                  <td class="p-4 flex items-center space-x-3">
                    <div class="w-10 h-10 rounded-full bg-slate-700 overflow-hidden flex items-center justify-center font-bold text-xs shrink-0">
                      ${m.photo ? `<img src="${m.photo}" class="w-full h-full object-cover">` : m.full_name.charAt(0)}
                    </div>
                    <div>
                      <div class="font-bold text-white">${m.full_name}</div>
                      <div class="text-xs text-slate-400">@${m.username}</div>
                    </div>
                  </td>
                  <td class="p-4 font-mono text-indigo-300">${m.member_id}</td>
                  <td class="p-4 text-slate-300">${m.position}</td>
                  <td class="p-4 text-slate-300">${m.course} • ${m.section}</td>
                  <td class="p-4">
                    <span class="px-2.5 py-1 text-xs rounded-full font-semibold ${m.status === 'Active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}">${m.status}</span>
                  </td>
                  <td class="p-4 text-right space-x-2">
                    <a href="/admin/member/id/${m.id}" target="_blank" class="px-2.5 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 rounded text-xs font-semibold inline-block">ID Card</a>
                    <a href="/admin/member/edit/${m.id}" class="px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs font-semibold inline-block">Edit</a>
                    <form action="/admin/member/delete/${m.id}" method="POST" class="inline" onsubmit="return confirm('Delete this member?');">
                      <button type="submit" class="px-2.5 py-1.5 bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 rounded text-xs font-semibold">Delete</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Add Member Modal -->
      <div id="addModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
        <div class="bg-slate-800 border border-slate-700 rounded-2xl max-w-2xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
          <div class="flex items-center justify-between mb-4 pb-3 border-b border-slate-700">
            <h3 class="text-xl font-bold text-white">Register New Club Member</h3>
            <button onclick="closeAddModal()" class="text-slate-400 hover:text-white">&times;</button>
          </div>
          <form action="/admin/member/add" method="POST" class="space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Full Name *</label>
                <input type="text" name="full_name" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500" placeholder="e.g. Juan Dela Cruz">
              </div>
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Position</label>
                <input type="text" name="position" value="Member" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Club / Organization</label>
                <input type="text" name="club" value="${settings.organization_name}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Year Level</label>
                <input type="text" name="year_level" value="Grade 11" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Course / Strand</label>
                <input type="text" name="course" value="STEM" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Section</label>
                <input type="text" name="section" value="Section A" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Contact Number</label>
                <input type="text" name="contact" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500" placeholder="09123456789">
              </div>
              <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Email Address</label>
                <input type="email" name="email" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500" placeholder="juan@email.com">
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Profile Photo URL (Optional)</label>
              <input type="url" name="photo" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500" placeholder="https://example.com/photo.jpg">
            </div>
            <div class="p-3 bg-indigo-950/40 border border-indigo-800/50 rounded-lg text-xs text-indigo-300">
              ℹ️ Username, secure temporary password, unique Member ID, and attendance QR code will be generated automatically.
            </div>
            <div class="flex justify-end space-x-3 pt-4 border-t border-slate-700">
              <button type="button" onclick="closeAddModal()" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm font-semibold">Cancel</button>
              <button type="submit" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold shadow-lg shadow-emerald-600/30">Register Member & Generate ID</button>
            </div>
          </form>
        </div>
      </div>
      <script>
        function openAddModal() { document.getElementById('addModal').classList.remove('hidden'); document.getElementById('addModal').classList.add('flex'); }
        function closeAddModal() { document.getElementById('addModal').classList.remove('flex'); document.getElementById('addModal').classList.add('hidden'); }
      </script>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Process Add Member
app.post('/admin/member/add', requireAdmin, async (req, res) => {
  try {
    const { full_name, position, club, year_level, course, section, contact, email, photo } = req.body;
    
    // Generate unique member ID and username
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seq = parseInt(countRes.rows[0].count) + 1;
    const year = new Date().getFullYear();
    const member_id = `CLUB-${year}-${String(seq).padStart(3, '0')}`;
    const username = `club-${year}-${String(seq).padStart(3, '0')}`;
    
    // Generate random temporary password
    const tempPassword = generateRandomString(8);
    const password_hash = await bcrypt.hash(tempPassword, 10);
    
    // Generate secure QR token
    const qr_token = `TOKEN-${crypto.randomBytes(16).toString('hex')}`;

    await pool.query(`
      INSERT INTO members (member_id, full_name, position, club, year_level, course, section, contact, email, photo, username, password_hash, temporary_password_status, qr_token, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, $13, 'Active')
    `, [member_id, full_name, position, club, year_level, course, section, contact, email, photo, username, password_hash, qr_token]);

    await logAudit('Member Created', req.session.adminUser, `Created member ${full_name} (${member_id})`);

    // Retrieve inserted ID
    const newMember = (await pool.query('SELECT id FROM members WHERE member_id = $1', [member_id])).rows[0];

    // Show success modal page displaying credentials clearly
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Member Created Successfully</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen p-4">
        <div class="max-w-lg w-full bg-slate-800 border border-slate-700 rounded-2xl p-8 shadow-2xl text-center">
          <div class="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center text-3xl mx-auto mb-4">✓</div>
          <h1 class="text-2xl font-bold mb-2">Member Created Successfully!</h1>
          <p class="text-slate-400 text-sm mb-6">Generated portal credentials and membership ID card.</p>

          <div class="bg-slate-900 border border-slate-700 rounded-xl p-4 text-left space-y-3 mb-6 font-mono text-sm">
            <div class="flex justify-between border-b border-slate-800 pb-2">
              <span class="text-slate-400">Full Name:</span>
              <span class="text-white font-bold">${full_name}</span>
            </div>
            <div class="flex justify-between border-b border-slate-800 pb-2">
              <span class="text-slate-400">Member ID:</span>
              <span class="text-indigo-400 font-bold">${member_id}</span>
            </div>
            <div class="flex justify-between border-b border-slate-800 pb-2">
              <span class="text-slate-400">Temporary Username:</span>
              <span class="text-emerald-400 font-bold">${username}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">TEMPORARY PASSWORD:</span>
              <span class="text-amber-400 font-bold bg-amber-500/10 px-2 py-0.5 rounded">${tempPassword}</span>
            </div>
          </div>
          <div class="p-3 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-lg text-xs mb-6 text-left">
            ⚠️ <strong>IMPORTANT:</strong> Give these temporary credentials to the member. The member must change this password upon their first login.
          </div>
          <div class="flex flex-col sm:flex-row gap-3 justify-center">
            <a href="/admin/member/id/${newMember.id}" target="_blank" class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-bold shadow-lg shadow-indigo-600/30 transition">View & Print ID Card</a>
            <a href="/admin/members" class="px-5 py-2.5 bg-slate-700 hover:bg-slate-650 text-slate-200 rounded-lg text-sm font-bold transition">Back to Members</a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error during member creation.');
  }
});

// Member Edit Form
app.get('/admin/member/edit/:id', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const member = (await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id])).rows[0];
    if (!member) return res.status(404).send('Member not found');

    res.send(renderAdminLayout('Edit Member', req.session.adminUser, settings, `
      <div class="max-w-2xl mx-auto bg-slate-800 border border-slate-700 rounded-xl p-8 shadow-lg">
        <h2 class="text-xl font-bold mb-6 text-white pb-3 border-b border-slate-700">Edit Member: ${member.full_name}</h2>
        <form action="/admin/member/edit/${member.id}" method="POST" class="space-y-4">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Full Name</label>
              <input type="text" name="full_name" value="${member.full_name}" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Position</label>
              <input type="text" name="position" value="${member.position}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Club</label>
              <input type="text" name="club" value="${member.club}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Year Level</label>
              <input type="text" name="year_level" value="${member.year_level}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Course / Strand</label>
              <input type="text" name="course" value="${member.course}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Section</label>
              <input type="text" name="section" value="${member.section}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Contact Number</label>
              <input type="text" name="contact" value="${member.contact}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Email</label>
              <input type="email" name="email" value="${member.email}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Profile Photo URL</label>
            <input type="url" name="photo" value="${member.photo}" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Status</label>
            <select name="status" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
              <option value="Active" ${member.status === 'Active' ? 'selected' : ''}>Active</option>
              <option value="Inactive" ${member.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="flex justify-end space-x-3 pt-4 border-t border-slate-700">
            <a href="/admin/members" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm font-semibold">Cancel</a>
            <button type="submit" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold">Save Changes</button>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/admin/member/edit/:id', requireAdmin, async (req, res) => {
  try {
    const { full_name, position, club, year_level, course, section, contact, email, photo, status } = req.body;
    await pool.query(`
      UPDATE members SET full_name = $1, position = $2, club = $3, year_level = $4, course = $5, section = $6, contact = $7, email = $8, photo = $9, status = $10
      WHERE id = $11
    `, [full_name, position, club, year_level, course, section, contact, email, photo, status, req.params.id]);

    await logAudit('Member Updated', req.session.adminUser, `Updated member ${full_name}`);
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/admin/member/delete/:id', requireAdmin, async (req, res) => {
  try {
    const member = (await pool.query('SELECT full_name FROM members WHERE id = $1', [req.params.id])).rows[0];
    await pool.query('DELETE FROM members WHERE id = $1', [req.params.id]);
    await logAudit('Member Deleted', req.session.adminUser, `Deleted member ID ${req.params.id}`);
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// CR80 Printable Member ID Card Route
app.get('/admin/member/id/:id', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const member = (await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id])).rows[0];
    if (!member) return res.status(404).send('Member not found');

    // Generate QR code data URL from member qr_token
    const qrDataUrl = await QRCode.toDataURL(member.qr_token, { width: 300, margin: 1 });

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Membership ID - ${member.full_name}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @media print {
            body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .no-print { display: none !important; }
            .id-card-container { box-shadow: none !important; border: 1px solid #cbd5e1 !important; }
          }
          /* CR80 Standard Proportional Size: 85.60 mm x 53.98 mm (~ 3.37 inch x 2.125 inch) */
          .cr80-card {
            width: 380px;
            height: 240px;
          }
        </style>
      </head>
      <body class="bg-slate-900 min-h-screen flex flex-col items-center justify-center p-4">
        <div class="no-print mb-6 flex gap-4">
          <button onclick="window.print()" class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold shadow-lg transition">🖨️ Print ID Card</button>
          <a href="/admin/members" class="px-5 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg font-bold transition">Back to Members</a>
        </div>

        <div class="flex flex-col gap-8 items-center">
          <!-- FRONT ID CARD -->
          <div class="cr80-card bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 border-2 border-indigo-500/50 rounded-xl shadow-2xl p-4 flex flex-col justify-between relative overflow-hidden id-card-container text-white">
            <div class="absolute -right-12 -top-12 w-32 h-32 bg-indigo-500/10 rounded-full blur-2xl"></div>
            <div class="flex items-center justify-between border-b border-indigo-500/30 pb-2">
              <div class="flex items-center space-x-2">
                <div class="w-8 h-8 rounded bg-indigo-600 flex items-center justify-center font-bold text-xs">🎓</div>
                <div>
                  <div class="text-[10px] uppercase font-semibold text-indigo-300 tracking-wider">${settings.school_name}</div>
                  <div class="text-xs font-bold text-white truncate max-w-[180px]">${settings.organization_name}</div>
                </div>
              </div>
              <div class="text-[10px] font-mono bg-indigo-500/20 px-2 py-0.5 rounded text-indigo-300">SY ${settings.school_year}</div>
            </div>

            <div class="flex items-center space-x-4 my-auto">
              <div class="w-20 h-24 rounded-lg bg-slate-800 border-2 border-indigo-400/50 overflow-hidden shrink-0 flex items-center justify-center font-bold text-slate-500">
                ${member.photo ? `<img src="${member.photo}" class="w-full h-full object-cover">` : member.full_name.charAt(0)}
              </div>
              <div class="overflow-hidden flex-1">
                <div class="text-[10px] uppercase font-semibold text-slate-400">Official Member</div>
                <div class="text-base font-extrabold text-white truncate">${member.full_name}</div>
                <div class="text-xs font-semibold text-indigo-400 mb-1">${member.position}</div>
                <div class="text-[11px] text-slate-300">${member.course} - ${member.section}</div>
                <div class="text-[11px] font-mono text-emerald-400 font-bold mt-1">${member.member_id}</div>
              </div>
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-indigo-500/30 text-[9px] text-slate-400">
              <div>Scan QR Code at Attendance Portal</div>
              <div class="font-bold text-indigo-300 uppercase">${member.status}</div>
            </div>
          </div>

          <!-- BACK ID CARD (QR & Credentials) -->
          <div class="cr80-card bg-slate-900 border-2 border-slate-700 rounded-xl shadow-2xl p-4 flex flex-col justify-between relative overflow-hidden id-card-container text-white">
            <div class="text-center border-b border-slate-800 pb-1">
              <div class="text-xs font-bold text-indigo-400">PORTAL ACCESS CREDENTIALS</div>
              <div class="text-[9px] text-slate-400">Member Portal: /member</div>
            </div>
            
            <div class="flex items-center justify-between my-auto">
              <div class="space-y-1 font-mono text-[10px] flex-1 pr-2">
                <div>
                  <span class="text-slate-400 block text-[9px]">TEMPORARY USERNAME:</span>
                  <span class="text-emerald-400 font-bold">${member.username}</span>
                </div>
                <div>
                  <span class="text-slate-400 block text-[9px]">TEMPORARY PASSWORD:</span>
                  <span class="text-amber-400 font-bold bg-amber-500/10 px-1 py-0.5 rounded">Check Admin Record</span>
                </div>
                <div class="text-[9px] text-slate-400 italic mt-1">Change password upon first login.</div>
              </div>
              <div class="w-20 h-20 bg-white p-1 rounded-lg shrink-0 flex items-center justify-center">
                <img src="${qrDataUrl}" class="w-full h-full">
              </div>
            </div>

            <div class="text-[8px] text-center text-slate-500 border-t border-slate-800 pt-1">
              If found, please return to ${settings.organization_name} office.
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Admin Attendance Records Page
app.get('/admin/attendance', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const dateQuery = req.query.date || '';
    const statusQuery = req.query.status || '';
    const search = req.query.search || '';

    let query = `
      SELECT a.*, m.full_name, m.position, m.course FROM attendance a
      JOIN members m ON a.member_id = m.member_id
      WHERE (m.full_name ILIKE $1 OR m.member_id ILIKE $1)
    `;
    let params = [`%${search}%`];
    let paramIndex = 2;

    if (dateQuery) {
      query += ` AND a.date = $${paramIndex++}`;
      params.push(dateQuery);
    }
    if (statusQuery) {
      query += ` AND a.status = $${paramIndex++}`;
      params.push(statusQuery);
    }

    query += ' ORDER BY a.date DESC, a.time_in DESC';
    const records = (await pool.query(query, params)).rows;

    res.send(renderAdminLayout('Attendance Records', req.session.adminUser, settings, `
      <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg mb-6">
        <form method="GET" action="/admin/attendance" class="flex flex-wrap items-center gap-3">
          <input type="text" name="search" value="${search}" placeholder="Search name or ID..." class="px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500 flex-1 min-w-[200px]">
          <input type="date" name="date" value="${dateQuery}" class="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
          <select name="status" class="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500">
            <option value="">All Status</option>
            <option value="Present" ${statusQuery === 'Present' ? 'selected' : ''}>Present</option>
            <option value="Late" ${statusQuery === 'Late' ? 'selected' : ''}>Late</option>
            <option value="Absent" ${statusQuery === 'Absent' ? 'selected' : ''}>Absent</option>
          </select>
          <button type="submit" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold transition">Filter</button>
          <button type="button" onclick="window.print()" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm font-semibold">Print Report</button>
        </form>
      </div>

      <div class="bg-slate-800 border border-slate-700 rounded-xl shadow-lg overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-900/60 border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
                <th class="p-4">Date</th>
                <th class="p-4">Member ID</th>
                <th class="p-4">Name</th>
                <th class="p-4">Position</th>
                <th class="p-4">Time In</th>
                <th class="p-4">Time Out</th>
                <th class="p-4">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/60 text-sm">
              ${records.length === 0 ? `<tr><td colspan="7" class="p-8 text-center text-slate-500">No attendance records found.</td></tr>` : records.map(r => `
                <tr class="hover:bg-slate-700/30 transition">
                  <td class="p-4 text-slate-300 font-mono text-xs">${r.date}</td>
                  <td class="p-4 text-indigo-300 font-mono">${r.member_id}</td>
                  <td class="p-4 font-bold text-white">${r.full_name}</td>
                  <td class="p-4 text-slate-300">${r.position}</td>
                  <td class="p-4 text-emerald-400 font-mono">${r.time_in || '—'}</td>
                  <td class="p-4 text-amber-400 font-mono">${r.time_out || '—'}</td>
                  <td class="p-4"><span class="px-2.5 py-1 text-xs rounded-full font-semibold ${r.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}">${r.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Admin Announcements Page
app.get('/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const announcements = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC')).rows;

    res.send(renderAdminLayout('Announcements', req.session.adminUser, settings, `
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg lg:col-span-1 h-fit">
          <h2 class="text-lg font-bold mb-4 text-white">Post Announcement</h2>
          <form action="/admin/announcements" method="POST" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Title</label>
              <input type="text" name="title" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Message</label>
              <textarea name="message" rows="4" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm"></textarea>
            </div>
            <button type="submit" class="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold transition">Publish Announcement</button>
          </form>
        </div>

        <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg lg:col-span-2">
          <h2 class="text-lg font-bold mb-4 text-white">Active Announcements</h2>
          <div class="space-y-4">
            ${announcements.length === 0 ? '<p class="text-sm text-slate-500">No announcements posted.</p>' : announcements.map(a => `
              <div class="p-4 bg-slate-900/50 rounded-xl border border-slate-700/60">
                <div class="flex items-center justify-between mb-2">
                  <h3 class="font-bold text-white">${a.title}</h3>
                  <span class="text-xs font-mono text-slate-400">${new Date(a.created_at).toLocaleDateString()}</span>
                </div>
                <p class="text-sm text-slate-300 whitespace-pre-line">${a.message}</p>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const { title, message } = req.body;
    await pool.query('INSERT INTO announcements (title, message, status) VALUES ($1, $2, $3)', [title, message, 'Published']);
    await logAudit('Announcement Created', req.session.adminUser, `Posted announcement: ${title}`);
    res.redirect('/admin/announcements');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Admin Settings Page
app.get('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    res.send(renderAdminLayout('System Settings', req.session.adminUser, settings, `
      <div class="max-w-2xl mx-auto bg-slate-800 border border-slate-700 rounded-xl p-8 shadow-lg">
        <h2 class="text-xl font-bold mb-6 text-white pb-3 border-b border-slate-700">Organization & Attendance Settings</h2>
        ${req.query.success ? '<div class="mb-4 p-3 bg-emerald-500/20 border border-emerald-500 text-emerald-300 rounded-lg text-sm">Settings updated successfully!</div>' : ''}
        <form action="/admin/settings" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Organization Name</label>
            <input type="text" name="organization_name" value="${settings.organization_name}" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">School Name</label>
            <input type="text" name="school_name" value="${settings.school_name}" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">School Year</label>
            <input type="text" name="school_year" value="${settings.school_year}" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Regular Time In Start</label>
              <input type="time" name="attendance_start" value="${settings.attendance_start}" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Grace Period (Minutes)</label>
              <input type="number" name="grace_period" value="${settings.grace_period}" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Scanner PIN Code</label>
            <input type="text" name="scanner_pin" value="${settings.scanner_pin}" required class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm">
          </div>
          <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-sm shadow-lg shadow-indigo-600/30 transition">Save System Settings</button>
        </form>
      </div>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { organization_name, school_name, school_year, attendance_start, grace_period, scanner_pin } = req.body;
    await pool.query(`
      UPDATE settings SET organization_name = $1, school_name = $2, school_year = $3, attendance_start = $4, grace_period = $5, scanner_pin = $6 WHERE id = 1
    `, [organization_name, school_name, school_year, attendance_start, grace_period, scanner_pin]);

    await logAudit('Settings Updated', req.session.adminUser, 'Updated club settings');
    res.redirect('/admin/settings?success=1');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Admin Layout Helper
fnRenderAdminLayout = function(title, username, settings, content) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - Admin Portal</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 min-h-screen flex">
      <!-- Sidebar -->
      <aside class="w-64 bg-slate-800 border-r border-slate-700 hidden lg:flex flex-col justify-between shrink-0">
        <div>
          <div class="p-6 border-b border-slate-700">
            <div class="text-xs uppercase text-indigo-400 font-bold tracking-wider">${settings.school_name}</div>
            <div class="text-lg font-extrabold text-white truncate">${settings.organization_name}</div>
          </div>
          <nav class="p-4 space-y-1">
            <a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-700 transition ${title === 'Dashboard' ? 'bg-indigo-600 text-white' : 'text-slate-300'}"><span>📊</span><span>Dashboard</span></a>
            <a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-700 transition ${title === 'Members Management' ? 'bg-indigo-600 text-white' : 'text-slate-300'}"><span>👥</span><span>Members</span></a>
            <a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-700 transition ${title === 'Attendance Records' ? 'bg-indigo-600 text-white' : 'text-slate-300'}"><span>📋</span><span>Attendance</span></a>
            <a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-700 transition ${title === 'Announcements' ? 'bg-indigo-600 text-white' : 'text-slate-300'}"><span>📢</span><span>Announcements</span></a>
            <a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-700 transition ${title === 'System Settings' ? 'bg-indigo-600 text-white' : 'text-slate-300'}"><span>⚙️</span><span>Settings</span></a>
          </nav>
        </div>
        <div class="p-4 border-t border-slate-700">
          <div class="flex items-center justify-between">
            <div class="text-xs text-slate-400 truncate">Logged in as <strong class="text-white">${username}</strong></div>
            <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
          </div>
        </div>
      </aside>

      <!-- Main Content -->
      <div class="flex-1 flex flex-col min-w-0">
        <header class="bg-slate-800 border-b border-slate-700 h-16 px-6 flex items-center justify-between lg:justify-end">
          <div class="lg:hidden font-bold text-sm text-indigo-400">${settings.organization_name}</div>
          <div class="flex items-center space-x-4">
            <a href="/scanner" target="_blank" class="px-3 py-1.5 bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 rounded-lg text-xs font-semibold transition">📷 Open Scanner</a>
            <a href="/admin/logout" class="text-xs text-rose-400 hover:underline lg:hidden">Logout</a>
          </div>
        </header>
        <main class="p-6 md:p-8 flex-1 overflow-y-auto">
          <div class="mb-6">
            <h1 class="text-2xl font-bold text-white">${title}</h1>
          </div>
          ${content}
        </main>
      </div>
    </body>
    </html>
  `;
};
function renderAdminLayout(title, username, settings, content) {
  return fnRenderAdminLayout(title, username, settings, content);
}


// ==========================================
// SEPARATE SCANNER PORTAL ROUTES
// ==========================================

app.get('/scanner', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Smartphone QR Scanner Portal</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://unpkg.com/html5-qrcode"></script>
    </head>
    <body class="bg-slate-950 text-white min-h-screen flex flex-col">
      <!-- Top Bar -->
      <header class="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between shadow-md">
        <div class="flex items-center space-x-2">
          <span class="text-xl">📷</span>
          <h1 class="font-bold text-sm tracking-wide">Attendance Scanner</h1>
        </div>
        <div id="connectionStatus" class="flex items-center space-x-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>Online</span>
        </div>
      </header>

      <!-- Main Scanner Container -->
      <main class="flex-1 max-w-md w-full mx-auto p-4 flex flex-col justify-between">
        <div class="space-y-4">
          <!-- PIN Modal / Overlay if locked -->
          <div id="pinOverlay" class="hidden fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-sm text-center">
              <div class="text-3xl mb-2">🔒</div>
              <h2 class="text-lg font-bold mb-1">Scanner PIN Required</h2>
              <p class="text-xs text-slate-400 mb-4">Enter club security PIN to enable scanner.</p>
              <input type="password" id="pinInput" placeholder="Enter PIN (Default 1234)" class="w-full px-4 py-2 bg-slate-950 border border-slate-800 rounded-lg text-center text-lg tracking-widest mb-4 focus:outline-none focus:border-indigo-500">
              <button onclick="verifyPin()" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 font-bold rounded-lg transition">Unlock Scanner</button>
            </div>
          </div>

          <!-- Mode Selector -->
          <div class="grid grid-cols-2 gap-3 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
            <button onclick="setMode('IN')" id="btnIn" class="py-2.5 rounded-lg text-sm font-bold transition bg-indigo-600 text-white shadow">TIME IN</button>
            <button onclick="setMode('OUT')" id="btnOut" class="py-2.5 rounded-lg text-sm font-bold transition text-slate-400 hover:text-white">TIME OUT</button>
          </div>

          <!-- Camera Box -->
          <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
            <div id="reader" class="w-full aspect-square bg-black"></div>
            <div id="scanOverlay" class="absolute inset-0 pointer-events-none border-4 border-indigo-500/40 rounded-2xl flex items-center justify-center">
              <div class="w-48 h-48 border-2 border-dashed border-indigo-400/60 rounded-xl"></div>
            </div>
          </div>

          <!-- Result Card -->
          <div id="resultCard" class="hidden p-4 rounded-xl border transition shadow-xl text-center">
            <div id="resultIcon" class="text-3xl mb-1">✓</div>
            <div id="resultTitle" class="font-extrabold text-lg mb-1">SUCCESS</div>
            <div id="resultMessage" class="text-xs text-slate-300">Member attendance recorded successfully.</div>
          </div>
        </div>

        <!-- Recent Scans Bar -->
        <div class="mt-4 bg-slate-900 border border-slate-800 rounded-xl p-3">
          <div class="text-xs font-bold uppercase text-slate-400 mb-2">Recent Scans Today</div>
          <div id="recentScansList" class="space-y-1.5 max-h-32 overflow-y-auto text-xs">
            <div class="text-slate-500 text-center py-1">No scans yet</div>
          </div>
        </div>
      </main>

      <!-- Audio Synthesizer for Beeps -->
      <script>
        let currentMode = 'IN';
        let scannerUnlocked = false;
        let isProcessing = false;

        function playSound(type) {
          try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            
            if (type === 'success') {
              osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
              gain.gain.setValueAtTime(0.1, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.15);
            } else {
              // Error beep-beep-beep
              osc.frequency.setValueAtTime(300, ctx.currentTime);
              gain.gain.setValueAtTime(0.1, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.1);
              setTimeout(() => {
                const osc2 = ctx.createOscillator();
                osc2.connect(gain);
                osc2.frequency.setValueAtTime(300, ctx.currentTime);
                osc2.start();
                osc2.stop(ctx.currentTime + 0.1);
              }, 150);
            }
          } catch(e) {}
        }

        function setMode(mode) {
          currentMode = mode;
          if (mode === 'IN') {
            document.getElementById('btnIn').className = 'py-2.5 rounded-lg text-sm font-bold transition bg-indigo-600 text-white shadow';
            document.getElementById('btnOut').className = 'py-2.5 rounded-lg text-sm font-bold transition text-slate-400 hover:text-white';
          } else {
            document.getElementById('btnOut').className = 'py-2.5 rounded-lg text-sm font-bold transition bg-indigo-600 text-white shadow';
            document.getElementById('btnIn').className = 'py-2.5 rounded-lg text-sm font-bold transition text-slate-400 hover:text-white';
          }
        }

        function verifyPin() {
          const pin = document.getElementById('pinInput').value;
          fetch('/scanner/verify-pin', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ pin })
          }).then(res => res.json()).then(data => {
            if (data.success) {
              document.getElementById('pinOverlay').classList.add('hidden');
              scannerUnlocked = true;
              initScanner();
            } else {
              alert('Incorrect PIN');
            }
          });
        }

        function initScanner() {
          const html5QrCode = new Html5Qrcode("reader");
          html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            onScanSuccess,
            onScanFailure
          ).catch(err => {
            console.error("Camera error:", err);
          });
        }

        async function onScanSuccess(decodedText) {
          if (isProcessing) return;
          isProcessing = true;

          try {
            const res = await fetch('/scanner/record', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ token: decodedText, type: currentMode })
            });
            const data = await res.json();
            
            const card = document.getElementById('resultCard');
            card.classList.remove('hidden');

            if (data.success) {
              playSound('success');
              card.className = 'p-4 rounded-xl border bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-xl text-center';
              document.getElementById('resultIcon').innerText = '✓';
              document.getElementById('resultTitle').innerText = data.title;
              document.getElementById('resultMessage').innerText = data.message;
            } else {
              playSound('error');
              card.className = 'p-4 rounded-xl border bg-rose-500/20 border-rose-500 text-rose-300 shadow-xl text-center';
              document.getElementById('resultIcon').innerText = '✕';
              document.getElementById('resultTitle').innerText = data.title;
              document.getElementById('resultMessage').innerText = data.message;
            }

            loadRecentScans();
          } catch(err) {
            console.error(err);
          } finally {
            setTimeout(() => { isProcessing = false; }, 3000); // 3-second cooldown
          }
        }

        function onScanFailure(error) {
          // Ignore frequent scanning misses
        }

        async function loadRecentScans() {
          try {
            const res = await fetch('/scanner/recent');
            const scans = await res.json();
            const list = document.getElementById('recentScansList');
            if (scans.length === 0) {
              list.innerHTML = '<div class="text-slate-500 text-center py-1">No scans yet</div>';
              return;
            }
            list.innerHTML = scans.map(s => \`
              <div class="flex items-center justify-between bg-slate-950/50 px-2.5 py-1.5 rounded border border-slate-800">
                <span class="font-bold text-white truncate max-w-[140px]">\${s.full_name}</span>
                <span class="text-[10px] text-indigo-300">\${s.time_in ? 'IN: ' + s.time_in : 'OUT: ' + s.time_out}</span>
              </div>
            \`).join('');
          } catch(e) {}
        }

        // On load, check if PIN is verified or required
        window.onload = () => {
          fetch('/scanner/check-pin').then(res => res.json()).then(data => {
            if (data.required) {
              document.getElementById('pinOverlay').classList.remove('hidden');
            } else {
              initScanner();
            }
          });
          loadRecentScans();
        };
      </script>
    </body>
    </html>
  `);
});

app.post('/scanner/verify-pin', async (req, res) => {
  const { pin } = req.body;
  const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
  if (pin === settings.scanner_pin) {
    req.session.scannerAuthorized = true;
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/scanner/check-pin', (req, res) => {
  // Always permit or check session
  res.json({ required: false });
});

app.get('/scanner/recent', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const scans = (await pool.query(`
      SELECT a.*, m.full_name FROM attendance a 
      JOIN members m ON a.member_id = m.member_id 
      WHERE a.date = $1 ORDER BY a.created_at DESC LIMIT 5
    `, [today])).rows;
    res.json(scans);
  } catch (err) {
    res.json([]);
  }
});

// Process QR Code Scan
app.post('/scanner/record', async (req, res) => {
  const { token, type } = req.body; // type: 'IN' or 'OUT'
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [token]);
    if (memberRes.rows.length === 0) {
      return res.json({ success: false, title: 'INVALID QR CODE', message: 'This QR code is not registered in the system.' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'Active') {
      return res.json({ success: false, title: 'MEMBER INACTIVE', message: `Member ${member.full_name} is currently inactive.` });
    }

    const today = new Date().toISOString().split('T')[0];
    const nowTime = new Date().toTimeString().split(' ')[0]; // HH:MM:SS

    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];

    // Check existing attendance today
    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND date = $2', [member.member_id, today]);

    if (type === 'IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({ success: false, title: 'ALREADY TIMED IN', message: `${member.full_name} already timed in at ${attRes.rows[0].time_in}.` });
      }

      // Calculate if Late
      const startTime = settings.attendance_start; // e.g. '08:00:00'
      const gracePeriod = settings.grace_period || 15; // minutes

      // Parse times into minutes
      const [startH, startM] = startTime.split(':').map(Number);
      const startTotalMins = startH * 60 + startM + gracePeriod;

      const [nowH, nowM] = nowTime.split(':').map(Number);
      const nowTotalMins = nowH * 60 + nowM;

      const attStatus = nowTotalMins > startTotalMins ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE member_id = $3 AND date = $4', [nowTime, attStatus, member.member_id, today]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, date, time_in, status) VALUES ($1, $2, $3, $4)', [member.member_id, today, nowTime, attStatus]);
      }

      return res.json({
        success: true,
        title: `TIME IN SUCCESSFUL (${attStatus})`,
        message: `${member.full_name} (${member.position}) timed in at ${nowTime}`
      });

    } else {
      // TIME OUT
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ success: false, title: 'NO TIME-IN RECORD FOUND', message: `${member.full_name} has not timed in today.` });
      }

      if (attRes.rows[0].time_out) {
        return res.json({ success: false, title: 'ALREADY TIMED OUT', message: `${member.full_name} already timed out today at ${attRes.rows[0].time_out}.` });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE member_id = $2 AND date = $3', [nowTime, member.member_id, today]);

      return res.json({
        success: true,
        title: 'TIME OUT SUCCESSFUL',
        message: `${member.full_name} timed out at ${nowTime}`
      });
    }

  } catch (err) {
    console.error(err);
    res.json({ success: false, title: 'SERVER ERROR', message: 'An error occurred recording attendance.' });
  }
});


// ==========================================
// MEMBER PORTAL ROUTES
// ==========================================

app.get('/member/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Member Portal Login</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl shadow-xl p-8">
        <div class="text-center mb-6">
          <div class="inline-flex p-3 bg-sky-600 text-white rounded-xl text-2xl font-bold mb-2">👤</div>
          <h1 class="text-2xl font-bold">Member Portal</h1>
          <p class="text-sm text-slate-400">Log in with your temporary username & password</p>
        </div>
        ${req.query.error ? `<div class="mb-4 p-3 bg-rose-500/20 border border-rose-500 text-rose-300 rounded-lg text-sm">${req.query.error}</div>` : ''}
        <form action="/member/login" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Username</label>
            <input type="text" name="username" required class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-sky-500 text-white" placeholder="club-2026-001">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Password</label>
            <input type="password" name="password" required class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-sky-500 text-white" placeholder="Temporary password">
          </div>
          <button type="submit" class="w-full py-3 bg-sky-600 hover:bg-sky-500 font-bold rounded-lg transition shadow-lg shadow-sky-600/30">Member Sign In</button>
        </form>
        <div class="mt-6 text-center text-xs text-slate-500">
          Contact club administrator if you lost your credentials.
        </div>
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

        // Check if temporary password needs change
        if (member.temporary_password_status) {
          return res.redirect('/member/change-password');
        }

        return res.redirect('/member');
      }
    }
    res.redirect('/member/login?error=Invalid username or password');
  } catch (err) {
    console.error(err);
    res.redirect('/member/login?error=Database error occurred');
  }
});

// Force Password Change Route
app.get('/member/change-password', requireMember, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Change Temporary Password</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl shadow-xl p-8">
        <div class="text-center mb-6">
          <div class="inline-flex p-3 bg-amber-500/20 text-amber-400 rounded-xl text-2xl font-bold mb-2">🔒</div>
          <h1 class="text-xl font-bold">Password Change Required</h1>
          <p class="text-xs text-slate-400 mt-1">Your password is temporary. Please create a new secure password before continuing.</p>
        </div>
        ${req.query.error ? `<div class="mb-4 p-3 bg-rose-500/20 border border-rose-500 text-rose-300 rounded-lg text-sm">${req.query.error}</div>` : ''}
        <form action="/member/change-password" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">New Password</label>
            <input type="password" name="new_password" required minlength="6" class="w-full px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-sky-500 text-white" placeholder="At least 6 characters">
          </div>
          <button type="submit" class="w-full py-3 bg-sky-600 hover:bg-sky-500 font-bold rounded-lg transition">Update Password & Continue</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/member/change-password', requireMember, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.redirect('/member/change-password?error=Password must be at least 6 characters long');
  }
  try {
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = FALSE WHERE member_id = $2', [hash, req.session.memberId]);
    res.redirect('/member');
  } catch (err) {
    console.error(err);
    res.redirect('/member/change-password?error=Database error');
  }
});

app.get('/member/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/member/login');
  });
});

// Member Dashboard
app.get('/member', requireMember, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const member = (await pool.query('SELECT * FROM members WHERE member_id = $1', [req.session.memberId])).rows[0];
    if (!member) return res.redirect('/member/login');

    if (member.temporary_password_status) {
      return res.redirect('/member/change-password');
    }

    const attendance = (await pool.query('SELECT * FROM attendance WHERE member_id = $1 ORDER BY date DESC LIMIT 10', [member.member_id])).rows;
    const announcements = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5')).rows;

    // Attendance stats
    const totalAtt = (await pool.query('SELECT COUNT(*) FROM attendance WHERE member_id = $1', [member.member_id])).rows[0].count;
    const presentAtt = (await pool.query("SELECT COUNT(*) FROM attendance WHERE member_id = $1 AND status = 'Present'", [member.member_id])).rows[0].count;
    const lateAtt = (await pool.query("SELECT COUNT(*) FROM attendance WHERE member_id = $1 AND status = 'Late'", [member.member_id])).rows[0].count;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Member Dashboard - ${member.full_name}</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-900 text-slate-100 min-h-screen flex flex-col">
        <header class="bg-slate-800 border-b border-slate-700 p-4 flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <div class="w-9 h-9 rounded-full bg-sky-600 flex items-center justify-center font-bold text-sm">👤</div>
            <div>
              <div class="font-bold text-sm text-white">${member.full_name}</div>
              <div class="text-xs text-sky-400">${member.member_id} • ${member.position}</div>
            </div>
          </div>
          <a href="/member/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
        </header>

        <main class="max-w-5xl w-full mx-auto p-6 flex-1 space-y-6">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg flex flex-col justify-between">
              <div>
                <div class="text-xs uppercase text-slate-400 font-semibold mb-1">My Membership ID</div>
                <div class="text-xl font-bold text-white mb-2">${member.member_id}</div>
                <p class="text-xs text-slate-400 mb-4">View or print your official membership ID card.</p>
              </div>
              <a href="/admin/member/id/${member.id}" target="_blank" class="w-full py-2 bg-sky-600 hover:bg-sky-500 text-center rounded-lg text-sm font-bold transition">View My ID Card</a>
            </div>
            
            <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg md:col-span-2 flex flex-col justify-between">
              <div>
                <div class="text-xs uppercase text-slate-400 font-semibold mb-1">Attendance Summary</div>
                <div class="grid grid-cols-3 gap-4 my-3 text-center">
                  <div class="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50">
                    <div class="text-2xl font-extrabold text-emerald-400">${presentAtt}</div>
                    <div class="text-xs text-slate-400">Present</div>
                  </div>
                  <div class="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50">
                    <div class="text-2xl font-extrabold text-amber-400">${lateAtt}</div>
                    <div class="text-xs text-slate-400">Late</div>
                  </div>
                  <div class="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50">
                    <div class="text-2xl font-extrabold text-indigo-400">${totalAtt}</div>
                    <div class="text-xs text-slate-400">Total Scans</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
              <h2 class="text-lg font-bold mb-4 text-white">Recent Attendance Logs</h2>
              <div class="space-y-3">
                ${attendance.length === 0 ? '<p class="text-sm text-slate-500">No attendance records found.</p>' : attendance.map(a => `
                  <div class="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border border-slate-700/50 text-sm">
                    <div>
                      <div class="font-mono text-xs text-indigo-300">${a.date}</div>
                      <div class="text-xs text-slate-400">In: ${a.time_in || '—'} | Out: ${a.time_out || '—'}</div>
                    </div>
                    <span class="px-2.5 py-1 text-xs rounded-full font-semibold ${a.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}">${a.status}</span>
                  </div>
                `).join('')}
              </div>
            </div>

            <div class="bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-lg">
              <h2 class="text-lg font-bold mb-4 text-white">Club Announcements</h2>
              <div class="space-y-3">
                ${announcements.length === 0 ? '<p class="text-sm text-slate-500">No announcements posted.</p>' : announcements.map(an => `
                  <div class="p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                    <div class="flex justify-between items-center mb-1">
                      <h3 class="font-bold text-sm text-white">${an.title}</h3>
                      <span class="text-[10px] font-mono text-slate-400">${new Date(an.created_at).toLocaleDateString()}</span>
                    </div>
                    <p class="text-xs text-slate-300">${an.message}</p>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        </main>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`School Club Attendance System running on port ${PORT}`);
});
