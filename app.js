/**
 * SCHOOL CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Consolidated Single-File Application (Node.js + Express + PostgreSQL + Embedded Frontend)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Database Connection Pool Configuration
// Automatically reads process.env.DATABASE_URL (or local fallback)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/school_club_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware Setup
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ==========================================
// DATABASE INITIALIZATION & AUTO-SETUP
// ==========================================
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        organization_name TEXT DEFAULT 'Supreme Student Council & Tech Club',
        school_name TEXT DEFAULT 'National Polytechnic University',
        logo TEXT DEFAULT '',
        school_year TEXT DEFAULT '2026-2027',
        attendance_start TEXT DEFAULT '08:00',
        grace_period INT DEFAULT 15,
        club_info TEXT DEFAULT 'Official university organization for tech enthusiasts and leaders.'
      );

      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL,
        position TEXT DEFAULT 'Member',
        club TEXT DEFAULT 'Tech Club',
        year_level TEXT DEFAULT '1st Year',
        course TEXT DEFAULT 'BS Information Technology',
        section TEXT DEFAULT 'IT-101',
        contact TEXT DEFAULT '',
        email TEXT DEFAULT '',
        photo TEXT DEFAULT '',
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        temporary_password_status BOOLEAN DEFAULT TRUE,
        qr_token TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'Active',
        date_joined DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id TEXT NOT NULL,
        date DATE DEFAULT CURRENT_DATE,
        time_in TEXT DEFAULT '',
        time_out TEXT DEFAULT '',
        status TEXT DEFAULT 'Present',
        remarks TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'Published',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        username TEXT NOT NULL,
        date DATE DEFAULT CURRENT_DATE,
        time TEXT NOT NULL
      );
    `);

    // Insert Default Settings if empty
    const settingsCheck = await client.query('SELECT COUNT(*) FROM settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await client.query(`INSERT INTO settings (organization_name, school_name, school_year) VALUES ('Tech Club Organization', 'National Polytechnic University', '2026-2027')`);
    }

    // Insert Default Admin if none exists
    const adminCheck = await client.query('SELECT COUNT(*) FROM admins');
    if (parseInt(adminCheck.rows[0].count) === 0) {
      const defaultUser = 'admin';
      const rawPassword = 'admin123!';
      const hash = await bcrypt.hash(rawPassword, 10);
      await client.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', [defaultUser, hash]);
      
      console.log('\n======================================================');
      console.log(' [SETUP SUCCESS] Default Administrator Account Created:');
      console.log(` Username: ${defaultUser}`);
      console.log(` Password: ${rawPassword}`);
      console.log(' (Please log in and modify this password immediately)');
      console.log('======================================================\n');
    }
  } catch (err) {
    console.error('Database Initialization Error:', err);
  } finally {
    client.release();
  }
}

initializeDatabase();

// Audit Logger Helper
async function logAudit(action, username) {
  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await pool.query('INSERT INTO audit_logs (action, username, date, time) VALUES ($1, $2, CURRENT_DATE, $3)', [action, username, timeStr]);
  } catch (err) {
    console.error('Audit Log Error:', err);
  }
}

// Middleware Guards
function isAuthenticatedAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

function isAuthenticatedMember(req, res, next) {
  if (req.session && req.session.isMember) return next();
  res.redirect('/member/login');
}

// ==========================================
// ROUTES: PORTAL HUBS & AUTHENTICATION
// ==========================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>School Club Attendance Management System</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 min-h-screen flex flex-col items-center justify-center p-6">
      <div class="max-w-4xl w-full text-center space-y-8">
        <div class="space-y-3">
          <span class="bg-indigo-500/10 text-indigo-400 text-xs font-semibold px-3 py-1 rounded-full uppercase tracking-wider border border-indigo-500/20">Secure School Organization System</span>
          <h1 class="text-4xl md:text-5xl font-extrabold tracking-tight">QR Code Attendance & Member Hub</h1>
          <p class="text-slate-400 max-w-xl mx-auto text-sm md:text-base">Select your corresponding portal below to access administration controls, smartphone entrance scanning, or member dashboards.</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4">
          <a href="/admin/login" class="group bg-slate-800 border border-slate-700 hover:border-indigo-500 p-8 rounded-2xl transition-all shadow-xl flex flex-col items-center text-center">
            <div class="w-14 h-14 bg-indigo-600/20 text-indigo-400 rounded-xl flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform">🛡️</div>
            <h3 class="text-lg font-bold text-white mb-2">Admin Portal</h3>
            <p class="text-xs text-slate-400 mb-6">Manage members, IDs, system configurations, reports & analytics.</p>
            <span class="mt-auto inline-flex items-center text-xs font-semibold text-indigo-400 group-hover:translate-x-1 transition-transform">Enter Portal →</span>
          </a>
          <a href="/scanner" class="group bg-slate-800 border border-slate-700 hover:border-emerald-500 p-8 rounded-2xl transition-all shadow-xl flex flex-col items-center text-center">
            <div class="w-14 h-14 bg-emerald-600/20 text-emerald-400 rounded-xl flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform">📷</div>
            <h3 class="text-lg font-bold text-white mb-2">Scanner Portal</h3>
            <p class="text-xs text-slate-400 mb-6">Optimized smartphone entrance camera scanner for Time-In and Time-Out.</p>
            <span class="mt-auto inline-flex items-center text-xs font-semibold text-emerald-400 group-hover:translate-x-1 transition-transform">Open Scanner →</span>
          </a>
          <a href="/member/login" class="group bg-slate-800 border border-slate-700 hover:border-sky-500 p-8 rounded-2xl transition-all shadow-xl flex flex-col items-center text-center">
            <div class="w-14 h-14 bg-sky-600/20 text-sky-400 rounded-xl flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform">🎓</div>
            <h3 class="text-lg font-bold text-white mb-2">Member Portal</h3>
            <p class="text-xs text-slate-400 mb-6">View attendance logs, personal QR codes, ID cards, and club announcements.</p>
            <span class="mt-auto inline-flex items-center text-xs font-semibold text-sky-400 group-hover:translate-x-1 transition-transform">Member Login →</span>
          </a>
        </div>
        <div class="text-xs text-slate-500 pt-8">Powered by Node.js & PostgreSQL 18 • CR80 Printable ID Standards Enabled</div>
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
      <meta charset="UTF-8"><title>Admin Login - Attendance System</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl space-y-6">
        <div class="text-center space-y-2">
          <div class="w-12 h-12 bg-indigo-600 text-white font-bold rounded-xl flex items-center justify-center mx-auto text-xl shadow-lg">🛡️</div>
          <h2 class="text-2xl font-bold">Admin Portal</h2>
          <p class="text-xs text-slate-400">Enter administrator credentials to proceed</p>
        </div>
        ${req.query.error ? `<div class="bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-xl text-xs text-center">${req.query.error}</div>` : ''}
        <form action="/admin/login" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Username</label>
            <input type="text" name="username" required class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Password</label>
            <input type="password" name="password" required class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
          </div>
          <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 font-semibold py-2.5 rounded-xl text-sm transition-colors shadow-lg">Sign In to Dashboard</button>
        </form>
        <div class="text-center pt-2"><a href="/" class="text-xs text-slate-400 hover:text-white">← Return to Home Hub</a></div>
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
        await logAudit('Admin Logged In', admin.username);
        return res.redirect('/admin/dashboard');
      }
    }
    res.redirect('/admin/login?error=Invalid+Username+or+Password');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/login?error=Server+Error');
  }
});

app.get('/admin/logout', isAuthenticatedAdmin, async (req, res) => {
  await logAudit('Admin Logged Out', req.session.adminUser || 'admin');
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Admin Dashboard
app.get('/admin/dashboard', isAuthenticatedAdmin, async (req, res) => {
  try {
    const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
    const settings = settingsRes.rows[0] || {};

    const membersCount = await pool.query('SELECT COUNT(*) FROM members');
    const activeCount = await pool.query("SELECT COUNT(*) FROM members WHERE status = 'Active'");
    const inactiveCount = await pool.query("SELECT COUNT(*) FROM members WHERE status = 'Inactive'");
    
    const todayStr = new Date().toISOString().split('T')[0];
    const presentToday = await pool.query("SELECT COUNT(*) FROM attendance WHERE date = $1 AND status = 'Present'", [todayStr]);
    const lateToday = await pool.query("SELECT COUNT(*) FROM attendance WHERE date = $1 AND status = 'Late'", [todayStr]);
    const totalAttToday = await pool.query("SELECT COUNT(*) FROM attendance WHERE date = $1", [todayStr]);
    const absentToday = parseInt(activeCount.rows[0].count) - parseInt(totalAttToday.rows[0].count);

    const recentScans = await pool.query(`
      a.id, a.member_id, a.date, a.time_in, a.time_out, a.status, m.full_name, m.position 
      FROM attendance a JOIN members m ON a.member_id = m.member_id 
      ORDER BY a.id DESC LIMIT 5
    `).catch(() => ({ rows: [] }));

    const recentMembers = await pool.query('SELECT * FROM members ORDER BY id DESC LIMIT 5');
    const announcements = await pool.query('SELECT * FROM announcements ORDER BY id DESC');

    res.send(renderAdminLayout('Dashboard', req.session.adminUser, settings, `
      <div class="space-y-6">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="bg-slate-800/80 border border-slate-700/60 p-5 rounded-2xl shadow-md">
            <p class="text-xs font-medium text-slate-400">Total Members</p>
            <h3 class="text-2xl font-extrabold text-white mt-1">${membersCount.rows[0].count}</h3>
            <span class="text-[10px] text-indigo-400 mt-2 block">${activeCount.rows[0].count} Active / ${inactiveCount.rows[0].count} Inactive</span>
          </div>
          <div class="bg-slate-800/80 border border-slate-700/60 p-5 rounded-2xl shadow-md">
            <p class="text-xs font-medium text-slate-400">Present Today</p>
            <h3 class="text-2xl font-extrabold text-emerald-400 mt-1">${presentToday.rows[0].count}</h3>
            <span class="text-[10px] text-emerald-500 mt-2 block">On-time entrance scans</span>
          </div>
          <div class="bg-slate-800/80 border border-slate-700/60 p-5 rounded-2xl shadow-md">
            <p class="text-xs font-medium text-slate-400">Late Today</p>
            <h3 class="text-2xl font-extrabold text-amber-400 mt-1">${lateToday.rows[0].count}</h3>
            <span class="text-[10px] text-amber-500 mt-2 block">Exceeded grace period</span>
          </div>
          <div class="bg-slate-800/80 border border-slate-700/60 p-5 rounded-2xl shadow-md">
            <p class="text-xs font-medium text-slate-400">Absent Today</p>
            <h3 class="text-2xl font-extrabold text-rose-400 mt-1">${Math.max(0, absentToday)}</h3>
            <span class="text-[10px] text-rose-500 mt-2 block">Not scanned yet</span>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="bg-slate-800/80 border border-slate-700/60 p-6 rounded-2xl shadow-md">
            <h3 class="text-sm font-bold text-white mb-4 flex items-center justify-between">
              <span>Recent Scan Activity</span>
              <a href="/admin/attendance" class="text-xs text-indigo-400 hover:underline">View All →</a>
            </h3>
            <div class="space-y-3">
              ${recentScans.rows.length === 0 ? '<p class="text-xs text-slate-500">No attendance scans recorded for today.</p>' : recentScans.rows.map(s => `
                <div class="flex items-center justify-between bg-slate-900/50 p-3 rounded-xl border border-slate-800 text-xs">
                  <div>
                    <span class="font-bold text-white">${s.full_name}</span>
                    <span class="text-slate-400 block text-[10px]">${s.position} (${s.member_id})</span>
                  </div>
                  <div class="text-right">
                    <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${s.status === 'Present' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}">${s.status}</span>
                    <span class="text-slate-400 block text-[10px] mt-0.5">${s.time_in || s.time_out || 'N/A'}</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="bg-slate-800/80 border border-slate-700/60 p-6 rounded-2xl shadow-md">
            <h3 class="text-sm font-bold text-white mb-4 flex items-center justify-between">
              <span>Recently Registered Members</span>
              <a href="/admin/members" class="text-xs text-indigo-400 hover:underline">Manage Members →</a>
            </h3>
            <div class="space-y-3">
              ${recentMembers.rows.length === 0 ? '<p class="text-xs text-slate-500">No members registered yet.</p>' : recentMembers.rows.map(m => `
                <div class="flex items-center justify-between bg-slate-900/50 p-3 rounded-xl border border-slate-800 text-xs">
                  <div class="flex items-center space-x-3">
                    <div class="w-8 h-8 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-xs">${m.full_name.charAt(0)}</div>
                    <div>
                      <span class="font-bold text-white">${m.full_name}</span>
                      <span class="text-slate-400 block text-[10px]">${m.member_id} • ${m.course}</span>
                    </div>
                  </div>
                  <a href="/admin/members/view/${m.id}" class="text-indigo-400 hover:underline">View ID</a>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `));
  } catch (err) {
    console.error(err);
    res.status(500).send('Dashboard Error');
  }
});

// Members Management Page
app.get('/admin/members', isAuthenticatedAdmin, async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
  const settings = settingsRes.rows[0] || {};
  const search = req.query.search || '';
  const statusFilter = req.query.status || '';

  let query = 'SELECT * FROM members WHERE (full_name ILIKE $1 OR member_id ILIKE $1 OR username ILIKE $1)';
  let params = [`%${search}%`];

  if (statusFilter) {
    query += ' AND status = $2';
    params.push(statusFilter);
  }
  query += ' ORDER BY id DESC';

  const membersRes = await pool.query(query, params);

  res.send(renderAdminLayout('Member Management', req.session.adminUser, settings, `
    <div class="space-y-6">
      <div class="flex flex-col md:flex-row items-center justify-between gap-4 bg-slate-800/80 p-5 rounded-2xl border border-slate-700/60 shadow-md">
        <form method="GET" action="/admin/members" class="flex items-center gap-3 w-full md:w-auto">
          <input type="text" name="search" value="${search}" placeholder="Search name, ID, username..." class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-xs focus:outline-none focus:border-indigo-500 w-full md:w-64">
          <select name="status" class="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-indigo-500">
            <option value="">All Status</option>
            <option value="Active" ${statusFilter === 'Active' ? 'selected' : ''}>Active</option>
            <option value="Inactive" ${statusFilter === 'Inactive' ? 'selected' : ''}>Inactive</option>
          </select>
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-semibold">Filter</button>
        </form>
        <button onclick="openAddModal()" class="w-full md:w-auto bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl text-xs font-semibold shadow-lg flex items-center justify-center space-x-2">
          <span>+ Add Member</span>
        </button>
      </div>

      <div class="bg-slate-800/80 border border-slate-700/60 rounded-2xl overflow-hidden shadow-md">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-900/80 text-slate-400 uppercase tracking-wider border-b border-slate-700">
              <tr>
                <th class="p-4">Member</th>
                <th class="p-4">Position / Club</th>
                <th class="p-4">Course & Year</th>
                <th class="p-4">Portal Credentials</th>
                <th class="p-4">Status</th>
                <th class="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/50">
              ${membersRes.rows.length === 0 ? '<tr><td colspan="6" class="p-6 text-center text-slate-500">No members found.</td></tr>' : membersRes.rows.map(m => `
                <tr class="hover:bg-slate-700/25 transition-colors">
                  <td class="p-4">
                    <div class="font-bold text-white">${m.full_name}</div>
                    <div class="text-[10px] text-slate-400">ID: ${m.member_id}</div>
                  </td>
                  <td class="p-4">
                    <div class="text-white">${m.position}</div>
                    <div class="text-[10px] text-slate-400">${m.club}</div>
                  </td>
                  <td class="p-4">
                    <div class="text-white">${m.course}</div>
                    <div class="text-[10px] text-slate-400">${m.year_level} — Section ${m.section}</div>
                  </td>
                  <td class="p-4">
                    <div class="text-indigo-300 font-mono">User: ${m.username}</div>
                    <div class="text-[10px] text-slate-400">${m.temporary_password_status ? '⚠️ Temp Password Active' : '🔒 Password Changed'}</div>
                  </td>
                  <td class="p-4">
                    <span class="px-2.5 py-1 rounded-full text-[10px] font-semibold ${m.status === 'Active' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">${m.status}</span>
                  </td>
                  <td class="p-4 text-right space-x-2">
                    <a href="/admin/members/view/${m.id}" class="bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-colors">View ID</a>
                    <a href="/admin/members/reset-password/${m.id}" onclick="return confirm('Generate a new temporary password for ${m.full_name}?')" class="bg-amber-600/20 hover:bg-amber-600 text-amber-300 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-colors">Reset Pwd</a>
                    <a href="/admin/members/toggle-status/${m.id}" class="bg-slate-700 hover:bg-slate-600 text-slate-300 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-colors">${m.status === 'Active' ? 'Deactivate' : 'Activate'}</a>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Add Member Modal -->
      <div id="addMemberModal" class="fixed inset-0 bg-black/70 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
        <div class="bg-slate-900 border border-slate-700 max-w-xl w-full p-6 rounded-2xl shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
          <div class="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 class="text-base font-bold text-white">Register New Club Member</h3>
            <button onclick="closeAddModal()" class="text-slate-400 hover:text-white text-lg">✕</button>
          </div>
          <p class="text-xs text-slate-400">Username, temporary secure password, unique ID, and CR80 QR code will be generated automatically.</p>
          <form action="/admin/members/add" method="POST" class="space-y-4 text-xs">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Full Name *</label>
                <input type="text" name="full_name" required class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Position</label>
                <input type="text" name="position" value="Member" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Club / Organization</label>
                <input type="text" name="club" value="${settings.organization_name || 'Tech Club'}" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Year Level</label>
                <select name="year_level" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
                  <option value="1st Year">1st Year</option>
                  <option value="2nd Year">2nd Year</option>
                  <option value="3rd Year">3rd Year</option>
                  <option value="4th Year">4th Year</option>
                </select>
              </div>
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Course / Program</label>
                <input type="text" name="course" value="BS Information Technology" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Section</label>
                <input type="text" name="section" value="IT-101" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Contact Number</label>
                <input type="text" name="contact" placeholder="+63 912 345 6789" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
              </div>
              <div>
                <label class="block font-semibold text-slate-300 mb-1">Email Address</label>
                <input type="email" name="email" placeholder="student@university.edu.ph" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500">
              </div>
            </div>
            <div class="flex justify-end space-x-3 pt-3 border-t border-slate-800">
              <button type="button" onclick="closeAddModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-semibold">Cancel</button>
              <button type="submit" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-semibold shadow-lg">Register & Generate ID</button>
            </div>
          </form>
        </div>
      </div>

      <script>
        function openAddModal() { document.getElementById('addMemberModal').classList.remove('hidden'); document.getElementById('addMemberModal').classList.add('flex'); }
        function closeAddModal() { document.getElementById('addMemberModal').classList.remove('flex'); document.getElementById('addMemberModal').classList.add('hidden'); }
      </script>
    </div>
  `));
});

// Add Member Endpoint
app.post('/admin/members/add', isAuthenticatedAdmin, async (req, res) => {
  const { full_name, position, club, year_level, course, section, contact, email } = req.body;
  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seq = parseInt(countRes.rows[0].count) + 1;
    const year = new Date().getFullYear();
    const member_id = `CLUB-${year}-${String(seq).padStart(3, '0')}`;
    const username = `club-${year}-${String(seq).padStart(3, '0')}`;

    // Generate random secure temporary password
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const password_hash = await bcrypt.hash(tempPassword, 10);
    const qr_token = `TOKEN-${member_id}-${crypto.randomBytes(12).toString('hex')}`;

    await pool.query(`
      INSERT INTO members (member_id, full_name, position, club, year_level, course, section, contact, email, username, password_hash, temporary_password_status, qr_token, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, 'Active')
    `, [member_id, full_name, position, club, year_level, course, section, contact, email, username, password_hash, qr_token]);

    await logAudit(`Registered member: ${full_name} (${member_id})`, req.session.adminUser);

    const newMemberRes = await pool.query('SELECT id FROM members WHERE member_id = $1', [member_id]);
    const newId = newMemberRes.rows[0].id;

    // Show Success Modal with credentials
    res.send(renderSuccessModalLayout(full_name, member_id, username, tempPassword, newId));
  } catch (err) {
    console.error(err);
    res.redirect('/admin/members?error=Failed+to+register+member');
  }
});

// View Member ID Card (CR80 Standard)
app.get('/admin/members/view/:id', isAuthenticatedAdmin, async (req, res) => {
  const memberId = req.params.id;
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [memberId]);
    if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
    const member = memberRes.rows[0];

    const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
    const settings = settingsRes.rows[0] || {};

    // Generate QR code Data URL
    const qrDataUrl = await QRCode.toDataURL(member.qr_token, { width: 300, margin: 1 });

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><title>ID Card - ${member.full_name}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @media print {
            body { background: white !important; -webkit-print-color-adjust: exact; }
            .no-print { display: none !important; }
            .id-card-print { box-shadow: none !important; border: 2px solid #333 !important; margin: 0 auto; }
          }
        </style>
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col items-center justify-center p-4">
        
        <div class="no-print mb-6 flex items-center space-x-3">
          <a href="/admin/members" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">← Back to Members</a>
          <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-xl text-xs font-semibold shadow-lg">🖨️ Print / Save ID Card</button>
          <a href="/admin/members/regenerate-qr/${member.id}" onclick="return confirm('Regenerating QR will invalidate the previous QR code. Proceed?')" class="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-xl text-xs font-semibold">🔄 Regenerate QR</a>
        </div>

        <div class="space-y-6 w-full max-w-md">
          <!-- CR80 Standard Aspect Ratio ID Card -->
          <div class="id-card-print bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 border border-indigo-500/40 rounded-3xl p-6 shadow-2xl relative overflow-hidden w-full max-w-[420px] mx-auto text-slate-100">
            <div class="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full blur-2xl pointer-events-none"></div>
            
            <!-- Header -->
            <div class="flex items-center justify-between border-b border-indigo-500/30 pb-3 mb-4">
              <div>
                <h4 class="text-[10px] uppercase font-bold text-indigo-400 tracking-widest">${settings.school_name || 'University'}</h4>
                <h3 class="text-sm font-extrabold text-white">${settings.organization_name || 'Club'}</h3>
              </div>
              <div class="w-9 h-9 rounded-xl bg-indigo-600/30 border border-indigo-400/40 flex items-center justify-center font-bold text-indigo-300 text-xs">ID</div>
            </div>

            <!-- Member Info & QR -->
            <div class="grid grid-cols-12 gap-4 items-center mb-4">
              <div class="col-span-4 flex flex-col items-center">
                <div class="w-20 h-20 rounded-2xl bg-indigo-950 border-2 border-indigo-500/50 flex items-center justify-center text-indigo-300 font-extrabold text-2xl shadow-inner overflow-hidden mb-2">
                  ${member.full_name.charAt(0)}
                </div>
                <span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/30">${member.status}</span>
              </div>
              <div class="col-span-8 space-y-1">
                <h2 class="text-base font-extrabold text-white leading-tight">${member.full_name}</h2>
                <p class="text-xs font-bold text-indigo-300">${member.position}</p>
                <p class="text-[11px] text-slate-300">${member.course}</p>
                <p class="text-[10px] text-slate-400">ID No: <span class="font-mono text-white font-bold">${member.member_id}</span></p>
                <p class="text-[10px] text-slate-400">School Year: <span class="text-white">${settings.school_year || '2026-2027'}</span></p>
              </div>
            </div>

            <!-- QR Section -->
            <div class="bg-slate-950/70 border border-slate-800 rounded-2xl p-3 flex items-center space-x-4 mb-4">
              <img src="${qrDataUrl}" alt="QR Code" class="w-20 h-20 bg-white p-1 rounded-xl shadow">
              <div class="text-[10px] space-y-1 text-slate-300">
                <p class="font-bold text-indigo-400">Scan for Attendance</p>
                <p class="text-[9px] text-slate-400">Present this QR at entrance scanner for automated Time-In / Time-Out.</p>
              </div>
            </div>

            <!-- Portal Credentials Box -->
            <div class="bg-indigo-950/50 border border-indigo-500/30 rounded-xl p-3 text-[10px] space-y-1">
              <p class="font-bold text-indigo-300 uppercase tracking-wider">Member Portal Initial Credentials</p>
              <div class="flex justify-between font-mono text-slate-200">
                <span>Username: <strong>${member.username}</strong></span>
                <span>Temp Pwd: <strong class="text-amber-400">${member.temporary_password_status ? 'Active' : 'Changed'}</strong></span>
              </div>
              <p class="text-[9px] text-slate-400 italic">Login at /member. Please change password upon first login.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading ID card');
  }
});

// Regenerate QR Code
app.get('/admin/members/regenerate-qr/:id', isAuthenticatedAdmin, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT member_id, full_name FROM members WHERE id = $1', [req.params.id]);
    if (memberRes.rows.length === 0) return res.redirect('/admin/members');
    const member = memberRes.rows[0];

    const newQrToken = `TOKEN-${member.member_id}-${crypto.randomBytes(12).toString('hex')}`;
    await pool.query('UPDATE members SET qr_token = $1 WHERE id = $2', [newQrToken, req.params.id]);
    await logAudit(`Regenerated QR code for ${member.full_name}`, req.session.adminUser);

    res.redirect(`/admin/members/view/${req.params.id}`);
  } catch (err) {
    console.error(err);
    res.redirect('/admin/members');
  }
});

// Reset Member Password
app.get('/admin/members/reset-password/:id', isAuthenticatedAdmin, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT full_name, member_id FROM members WHERE id = $1', [req.params.id]);
    if (memberRes.rows.length === 0) return res.redirect('/admin/members');
    const member = memberRes.rows[0];

    const newTempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hash = await bcrypt.hash(newTempPassword, 10);

    await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = TRUE WHERE id = $2', [hash, req.params.id]);
    await logAudit(`Reset password for member: ${member.full_name}`, req.session.adminUser);

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><title>Password Reset Successful</title><script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-slate-950 text-slate-100 flex items-center justify-center min-h-screen p-4">
        <div class="max-w-md w-full bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center space-y-6 shadow-2xl">
          <div class="w-14 h-14 bg-amber-500/20 text-amber-400 font-bold rounded-2xl flex items-center justify-center mx-auto text-2xl">🔑</div>
          <h2 class="text-xl font-bold">Password Reset Successful</h2>
          <p class="text-xs text-slate-400">A new temporary password has been generated for <strong>${member.full_name}</strong> (${member.member_id}).</p>
          <div class="bg-slate-800 p-4 rounded-xl border border-slate-700 space-y-2">
            <span class="text-xs text-slate-400 block">New Temporary Password:</span>
            <span class="text-lg font-mono font-bold text-amber-400 tracking-wider">${newTempPassword}</span>
          </div>
          <p class="text-[11px] text-amber-500">Provide this password to the member. They will be forced to change it upon next login.</p>
          <a href="/admin/members" class="block w-full bg-indigo-600 hover:bg-indigo-500 font-semibold py-2.5 rounded-xl text-xs">Return to Members</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.redirect('/admin/members');
  }
});

// Toggle Member Status
app.get('/admin/members/toggle-status/:id', isAuthenticatedAdmin, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT status, full_name FROM members WHERE id = $1', [req.params.id]);
    if (memberRes.rows.length > 0) {
      const newStatus = memberRes.rows[0].status === 'Active' ? 'Inactive' : 'Active';
      await pool.query('UPDATE members SET status = $1 WHERE id = $2', [newStatus, req.params.id]);
      await logAudit(`Changed status of ${memberRes.rows[0].full_name} to ${newStatus}`, req.session.adminUser);
    }
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/members');
  }
});

// Attendance Management Page
app.get('/admin/attendance', isAuthenticatedAdmin, async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
  const settings = settingsRes.rows[0] || {};

  const dateFilter = req.query.date || '';
  const statusFilter = req.query.status || '';
  const search = req.query.search || '';

  let query = `
    SELECT a.*, m.full_name, m.position, m.course 
    FROM attendance a JOIN members m ON a.member_id = m.member_id 
    WHERE (m.full_name ILIKE $1 OR m.member_id ILIKE $1)
  `;
  let params = [`%${search}%`];
  let paramIdx = 2;

  if (dateFilter) {
    query += ` AND a.date = $${paramIdx++}`;
    params.push(dateFilter);
  }
  if (statusFilter) {
    query += ` AND a.status = $${paramIdx++}`;
    params.push(statusFilter);
  }
  query += ' ORDER BY a.id DESC LIMIT 100';

  const attRes = await pool.query(query, params);

  res.send(renderAdminLayout('Attendance Logs', req.session.adminUser, settings, `
    <div class="space-y-6">
      <div class="bg-slate-800/80 p-5 rounded-2xl border border-slate-700/60 shadow-md">
        <form method="GET" action="/admin/attendance" class="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input type="text" name="search" value="${search}" placeholder="Search member name or ID..." class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-xs focus:outline-none focus:border-indigo-500">
          <input type="date" name="date" value="${dateFilter}" class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-xs focus:outline-none focus:border-indigo-500 text-slate-300">
          <select name="status" class="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-indigo-500 text-slate-300">
            <option value="">All Statuses</option>
            <option value="Present" ${statusFilter === 'Present' ? 'selected' : ''}>Present</option>
            <option value="Late" ${statusFilter === 'Late' ? 'selected' : ''}>Late</option>
          </select>
          <div class="flex space-x-2">
            <button type="submit" class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold py-2">Filter Logs</button>
            <a href="/admin/attendance" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl text-xs font-semibold flex items-center justify-center">Reset</a>
          </div>
        </form>
      </div>

      <div class="bg-slate-800/80 border border-slate-700/60 rounded-2xl overflow-hidden shadow-md">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-900/80 text-slate-400 uppercase tracking-wider border-b border-slate-700">
              <tr>
                <th class="p-4">Date</th>
                <th class="p-4">Member</th>
                <th class="p-4">Position</th>
                <th class="p-4">Time In</th>
                <th class="p-4">Time Out</th>
                <th class="p-4">Status</th>
                <th class="p-4">Remarks</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/50">
              ${attRes.rows.length === 0 ? '<tr><td colspan="7" class="p-6 text-center text-slate-500">No attendance logs matching filter criteria.</td></tr>' : attRes.rows.map(a => `
                <tr class="hover:bg-slate-700/25 transition-colors">
                  <td class="p-4 text-slate-300">${new Date(a.date).toLocaleDateString()}</td>
                  <td class="p-4">
                    <span class="font-bold text-white">${a.full_name}</span>
                    <span class="block text-[10px] text-slate-400">${a.member_id}</span>
                  </td>
                  <td class="p-4 text-slate-300">${a.position}</td>
                  <td class="p-4 text-emerald-400 font-mono">${a.time_in || '—'}</td>
                  <td class="p-4 text-amber-400 font-mono">${a.time_out || '—'}</td>
                  <td class="p-4">
                    <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${a.status === 'Present' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}">${a.status}</span>
                  </td>
                  <td class="p-4 text-slate-400">${a.remarks || 'Normal scan'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `));
});

// Admin Reports Section
app.get('/admin/reports', isAuthenticatedAdmin, async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
  const settings = settingsRes.rows[0] || {};

  const totalMembers = await pool.query('SELECT COUNT(*) FROM members WHERE status = \'Active\'');
  const totalScans = await pool.query('SELECT COUNT(*) FROM attendance');
  const presentCount = await pool.query("SELECT COUNT(*) FROM attendance WHERE status = 'Present'");
  const lateCount = await pool.query("SELECT COUNT(*) FROM attendance WHERE status = 'Late'");

  res.send(renderAdminLayout('Reports & Analytics', req.session.adminUser, settings, `
    <div class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="bg-slate-800/80 p-5 rounded-2xl border border-slate-700/60 shadow-md">
          <p class="text-xs font-medium text-slate-400">Total Scans Recorded</p>
          <h3 class="text-2xl font-extrabold text-white mt-1">${totalScans.rows[0].count}</h3>
        </div>
        <div class="bg-slate-800/80 p-5 rounded-2xl border border-slate-700/60 shadow-md">
          <p class="text-xs font-medium text-slate-400">On-Time Present Count</p>
          <h3 class="text-2xl font-extrabold text-emerald-400 mt-1">${presentCount.rows[0].count}</h3>
        </div>
        <div class="bg-slate-800/80 p-5 rounded-2xl border border-slate-700/60 shadow-md">
          <p class="text-xs font-medium text-slate-400">Late Arrivals Count</p>
          <h3 class="text-2xl font-extrabold text-amber-400 mt-1">${lateCount.rows[0].count}</h3>
        </div>
        <div class="bg-slate-800/80 p-5 rounded-2xl border border-slate-700/60 shadow-md">
          <p class="text-xs font-medium text-slate-400">Active Registered Members</p>
          <h3 class="text-2xl font-extrabold text-indigo-400 mt-1">${totalMembers.rows[0].count}</h3>
        </div>
      </div>

      <div class="bg-slate-800/80 p-6 rounded-2xl border border-slate-700/60 shadow-md space-y-4">
        <h3 class="text-sm font-bold text-white">Export & Report Actions</h3>
        <p class="text-xs text-slate-400">Print formal organization attendance logs or download database backups for offline archiving.</p>
        <div class="flex flex-wrap gap-3 pt-2">
          <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl text-xs font-semibold shadow-lg">🖨️ Print Attendance Report</button>
          <a href="/admin/backup" class="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl text-xs font-semibold shadow-lg">💾 Download Database Backup (SQL)</a>
        </div>
      </div>
    </div>
  `));
});

// Database Backup Endpoint
app.get('/admin/backup', isAuthenticatedAdmin, async (req, res) => {
  try {
    const members = await pool.query('SELECT * FROM members');
    const attendance = await pool.query('SELECT * FROM attendance');
    const announcements = await pool.query('SELECT * FROM announcements');
    const settings = await pool.query('SELECT * FROM settings');

    const backupData = {
      timestamp: new Date().toISOString(),
      settings: settings.rows,
      members: members.rows,
      attendance: attendance.rows,
      announcements: announcements.rows
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=club_system_backup_${new Date().toISOString().split('T')[0]}.json`);
    res.send(JSON.stringify(backupData, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).send('Backup Error');
  }
});

// Announcements Page
app.get('/admin/announcements', isAuthenticatedAdmin, async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
  const settings = settingsRes.rows[0] || {};
  const annRes = await pool.query('SELECT * FROM announcements ORDER BY id DESC');

  res.send(renderAdminLayout('Announcements', req.session.adminUser, settings, `
    <div class="space-y-6">
      <div class="bg-slate-800/80 p-6 rounded-2xl border border-slate-700/60 shadow-md">
        <h3 class="text-sm font-bold text-white mb-4">Post Club Announcement</h3>
        <form action="/admin/announcements/add" method="POST" class="space-y-4 text-xs">
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Title</label>
            <input type="text" name="title" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Message Content</label>
            <textarea name="message" rows="3" required class="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 focus:outline-none focus:border-indigo-500"></textarea>
          </div>
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl font-semibold shadow-lg">Publish Announcement</button>
        </form>
      </div>

      <div class="space-y-4">
        <h3 class="text-sm font-bold text-white">Active Announcements (${annRes.rows.length})</h3>
        ${annRes.rows.map(a => `
          <div class="bg-slate-800/80 border border-slate-700/60 p-5 rounded-2xl shadow-md space-y-2">
            <div class="flex items-center justify-between">
              <h4 class="font-bold text-white text-sm">${a.title}</h4>
              <span class="text-[10px] text-slate-400">${new Date(a.created_at).toLocaleDateString()}</span>
            </div>
            <p class="text-xs text-slate-300">${a.message}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `));
});

app.post('/admin/announcements/add', isAuthenticatedAdmin, async (req, res) => {
  const { title, message } = req.body;
  try {
    await pool.query('INSERT INTO announcements (title, message) VALUES ($1, $2)', [title, message]);
    await logAudit(`Created announcement: ${title}`, req.session.adminUser);
    res.redirect('/admin/announcements');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/announcements');
  }
});

// Admin Settings Page
app.get('/admin/settings', isAuthenticatedAdmin, async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
  const settings = settingsRes.rows[0] || {};

  res.send(renderAdminLayout('System Settings', req.session.adminUser, settings, `
    <div class="max-w-2xl bg-slate-800/80 border border-slate-700/60 p-6 rounded-2xl shadow-md space-y-6">
      <h3 class="text-sm font-bold text-white border-b border-slate-700 pb-3">Organization & Attendance Configuration</h3>
      ${req.query.success ? '<div class="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-3 rounded-xl text-xs">Settings updated successfully!</div>' : ''}
      <form action="/admin/settings/update" method="POST" class="space-y-4 text-xs">
        <div>
          <label class="block font-semibold text-slate-300 mb-1">Organization Name</label>
          <input type="text" name="organization_name" value="${settings.organization_name || ''}" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
        </div>
        <div>
          <label class="block font-semibold text-slate-300 mb-1">School / University Name</label>
          <input type="text" name="school_name" value="${settings.school_name || ''}" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
        </div>
        <div>
          <label class="block font-semibold text-slate-300 mb-1">School Year</label>
          <input type="text" name="school_year" value="${settings.school_year || ''}" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Regular Attendance Start Time</label>
            <input type="text" name="attendance_start" value="${settings.attendance_start || '08:00'}" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Grace Period (Minutes)</label>
            <input type="number" name="grace_period" value="${settings.grace_period || 15}" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
          </div>
        </div>
        <div>
          <label class="block font-semibold text-slate-300 mb-1">Club Information / Bio</label>
          <textarea name="club_info" rows="3" class="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 focus:outline-none focus:border-indigo-500">${settings.club_info || ''}</textarea>
        </div>
        <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl font-semibold shadow-lg">Save Configuration</button>
      </form>

      <div class="pt-6 border-t border-slate-700 space-y-4">
        <h3 class="text-sm font-bold text-white">Change Admin Password</h3>
        <form action="/admin/settings/password" method="POST" class="space-y-4 text-xs">
          <div>
            <label class="block font-semibold text-slate-300 mb-1">Current Password</label>
            <input type="password" name="current_password" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block font-semibold text-slate-300 mb-1">New Password</label>
            <input type="password" name="new_password" required class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 focus:outline-none focus:border-indigo-500">
          </div>
          <button type="submit" class="bg-amber-600 hover:bg-amber-500 text-white px-5 py-2.5 rounded-xl font-semibold shadow-lg">Update Administrator Password</button>
        </form>
      </div>
    </div>
  `));
});

app.post('/admin/settings/update', isAuthenticatedAdmin, async (req, res) => {
  const { organization_name, school_name, school_year, attendance_start, grace_period, club_info } = req.body;
  try {
    await pool.query(`
      UPDATE settings SET organization_name = $1, school_name = $2, school_year = $3, attendance_start = $4, grace_period = $5, club_info = $6 WHERE id = 1
    `, [organization_name, school_name, school_year, attendance_start, grace_period, club_info]);
    await logAudit('Updated system settings', req.session.adminUser);
    res.redirect('/admin/settings?success=1');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/settings');
  }
});

app.post('/admin/settings/password', isAuthenticatedAdmin, async (req, res) => {
  const { current_password, new_password } = req.body;
  try {
    const adminRes = await pool.query('SELECT * FROM admins WHERE username = $1', [req.session.adminUser]);
    if (adminRes.rows.length > 0) {
      const match = await bcrypt.compare(current_password, adminRes.rows[0].password_hash);
      if (match) {
        const newHash = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE admins SET password_hash = $1 WHERE username = $2', [newHash, req.session.adminUser]);
        await logAudit('Changed administrator password', req.session.adminUser);
        return res.redirect('/admin/settings?success=1');
      }
    }
    res.redirect('/admin/settings?error=Invalid+Current+Password');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/settings');
  }
});

// Audit Log Page
app.get('/admin/audit', isAuthenticatedAdmin, async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
  const settings = settingsRes.rows[0] || {};
  const logsRes = await pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100');

  res.send(renderAdminLayout('Audit Logs', req.session.adminUser, settings, `
    <div class="bg-slate-800/80 border border-slate-700/60 rounded-2xl overflow-hidden shadow-md">
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-900/80 text-slate-400 uppercase tracking-wider border-b border-slate-700">
            <tr>
              <th class="p-4">ID</th>
              <th class="p-4">Action Performed</th>
              <th class="p-4">Admin User</th>
              <th class="p-4">Date</th>
              <th class="p-4">Time</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-700/50">
            ${logsRes.rows.length === 0 ? '<tr><td colspan="5" class="p-6 text-center text-slate-500">No audit logs recorded.</td></tr>' : logsRes.rows.map(l => `
              <tr class="hover:bg-slate-700/25 transition-colors">
                <td class="p-4 text-slate-400 font-mono">#${l.id}</td>
                <td class="p-4 font-bold text-white">${l.action}</td>
                <td class="p-4 text-indigo-300">${l.username}</td>
                <td class="p-4 text-slate-300">${new Date(l.date).toLocaleDateString()}</td>
                <td class="p-4 text-slate-400 font-mono">${l.time}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `));
});


// ==========================================
// SEPARATE SCANNER PORTAL (/scanner)
// Optimized for dedicated mobile smartphone entrance use
// ==========================================
app.get('/scanner', async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
  const settings = settingsRes.rows[0] || {};

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Smartphone Entrance Scanner - ${settings.organization_name || 'Club'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://unpkg.com/html5-qrcode"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">
      <!-- Header -->
      <header class="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between shadow-md">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 bg-emerald-600 rounded-xl flex items-center justify-center font-bold text-white shadow">📷</div>
          <div>
            <h1 class="text-xs font-bold text-white tracking-wide uppercase">Entrance Scanner</h1>
            <p class="text-[10px] text-slate-400">${settings.organization_name || 'Club Organization'}</p>
          </div>
        </div>
        <div class="flex items-center space-x-2">
          <a href="/" class="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg font-semibold">Home Hub</a>
        </div>
      </header>

      <!-- Main Scanner Interface -->
      <main class="flex-1 max-w-lg w-full mx-auto p-4 flex flex-col space-y-4">
        
        <!-- Mode Switcher -->
        <div class="bg-slate-900 border border-slate-800 p-2 rounded-2xl flex items-center shadow-md">
          <button onclick="setMode('IN')" id="btnIn" class="flex-1 py-2.5 rounded-xl text-xs font-bold transition-all bg-emerald-600 text-white shadow">🟢 TIME IN MODE</button>
          <button onclick="setMode('OUT')" id="btnOut" class="flex-1 py-2.5 rounded-xl text-xs font-bold transition-all text-slate-400 hover:text-white">🔴 TIME OUT MODE</button>
        </div>

        <!-- Camera Viewport Box -->
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl flex flex-col items-center relative overflow-hidden">
          <div id="reader" class="w-full rounded-xl overflow-hidden border border-slate-800 bg-black"></div>
          <p id="scannerStatus" class="text-[11px] text-slate-400 mt-3 text-center">Position QR code inside camera frame to scan</p>
        </div>

        <!-- Live Scan Result Card -->
        <div id="resultCard" class="hidden bg-slate-900 border p-5 rounded-2xl shadow-2xl space-y-3 transition-all">
          <div id="resBadge" class="inline-block px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider"></div>
          <div class="flex items-center space-x-4">
            <div id="resAvatar" class="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center text-xl font-bold text-indigo-300"></div>
            <div>
              <h2 id="resName" class="text-base font-extrabold text-white"></h2>
              <p id="resPosition" class="text-xs text-indigo-400"></p>
              <p id="resMeta" class="text-[10px] text-slate-400 mt-0.5"></p>
            </div>
          </div>
          <div class="bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex items-center justify-between text-xs">
            <span id="resTime" class="font-mono font-bold text-white"></span>
            <span id="resStatusText" class="font-semibold"></span>
          </div>
        </div>

        <!-- Recent Scans List -->
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-md space-y-3">
          <h3 class="text-xs font-bold text-slate-300 uppercase tracking-wider">Recent Entrance Scans</h3>
          <div id="recentScansList" class="space-y-2 max-h-40 overflow-y-auto text-xs">
            <p class="text-[11px] text-slate-500">No scans yet in this session.</p>
          </div>
        </div>
      </main>

      <!-- Audio Elements for Beeper -->
      <audio id="successSound" src="https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3" preload="auto"></audio>
      <audio id="errorSound" src="https://assets.mixkit.co/active_storage/sfx/2955/2955-preview.mp3" preload="auto"></audio>

      <script>
        let currentMode = 'IN';
        let isProcessing = false;

        function setMode(mode) {
          currentMode = mode;
          const btnIn = document.getElementById('btnIn');
          const btnOut = document.getElementById('btnOut');
          if (mode === 'IN') {
            btnIn.className = 'flex-1 py-2.5 rounded-xl text-xs font-bold transition-all bg-emerald-600 text-white shadow';
            btnOut.className = 'flex-1 py-2.5 rounded-xl text-xs font-bold transition-all text-slate-400 hover:text-white';
          } else {
            btnOut.className = 'flex-1 py-2.5 rounded-xl text-xs font-bold transition-all bg-rose-600 text-white shadow';
            btnIn.className = 'flex-1 py-2.5 rounded-xl text-xs font-bold transition-all text-slate-400 hover:text-white';
          }
        }

        function playSuccess() { document.getElementById('successSound').play().catch(e => {}); }
        function playError() { document.getElementById('errorSound').play().catch(e => {}); }

        async function onScanSuccess(decodedText) {
          if (isProcessing) return;
          isProcessing = true;

          try {
            const response = await fetch('/scanner/process', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: decodedText, mode: currentMode })
            });
            const data = await response.json();

            const card = document.getElementById('resultCard');
            card.classList.remove('hidden');

            if (data.success) {
              playSuccess();
              card.className = 'bg-slate-900 border border-emerald-500/50 p-5 rounded-2xl shadow-2xl space-y-3';
              document.getElementById('resBadge').className = 'inline-block px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
              document.getElementById('resBadge').innerText = currentMode === 'IN' ? '✓ TIME IN SUCCESSFUL' : '✓ TIME OUT SUCCESSFUL';
              document.getElementById('resAvatar').innerText = data.member.full_name.charAt(0);
              document.getElementById('resName').innerText = data.member.full_name;
              document.getElementById('resPosition').innerText = data.member.position + ' (' + data.member.member_id + ')';
              document.getElementById('resMeta').innerText = data.member.course + ' • ' + data.member.year_level;
              document.getElementById('resTime').innerText = data.time;
              document.getElementById('resStatusText').innerHTML = '<span class="text-emerald-400 font-bold">' + data.status + '</span>';

              // Prepend to recent scans
              const list = document.getElementById('recentScansList');
              if (list.innerHTML.includes('No scans yet')) list.innerHTML = '';
              list.insertAdjacentHTML('afterbegin', '<div class="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between text-[11px]"><div><span class="font-bold text-white">' + data.member.full_name + '</span> <span class="text-slate-400">(' + currentMode + ')</span></div><span class="text-emerald-400 font-mono">' + data.time + '</span></div>');
            } else {
              playError();
              card.className = 'bg-slate-900 border border-rose-500/50 p-5 rounded-2xl shadow-2xl space-y-3';
              document.getElementById('resBadge').className = 'inline-block px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-rose-500/20 text-rose-400 border border-rose-500/30';
              document.getElementById('resBadge').innerText = '✕ ' + data.message.toUpperCase();
              document.getElementById('resAvatar').innerText = '⚠️';
              document.getElementById('resName').innerText = data.message;
              document.getElementById('resPosition').innerText = 'Action Denied';
              document.getElementById('resMeta').innerText = 'Please check member status or contact admin.';
              document.getElementById('resTime').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              document.getElementById('resStatusText').innerHTML = '<span class="text-rose-400 font-bold">Error</span>';
            }
          } catch (err) {
            playError();
            console.error(err);
          }

          // Cooldown before next scan
          setTimeout(() => { isProcessing = false; }, 3000);
        }

        const html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess, (err) => {}).catch(err => {
          document.getElementById('scannerStatus').innerText = 'Camera access error or permission denied.';
        });
      </script>
    </body>
    </html>
  `);
});

// Scanner Attendance Processing Endpoint
app.post('/scanner/process', async (req, res) => {
  const { token, mode } = req.body;
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [token]);
    if (memberRes.rows.length === 0) {
      return res.json({ success: false, message: 'Invalid QR Code — Not Registered' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'Active') {
      return res.json({ success: false, message: 'Member Account Inactive' });
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Fetch Settings for Grace Period calculations
    const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
    const settings = settingsRes.rows[0] || {};
    const startParts = (settings.attendance_start || '08:00').split(':');
    const startMinutes = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
    const grace = settings.grace_period || 15;

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let attStatus = 'Present';
    if (currentMinutes > (startMinutes + grace)) {
      attStatus = 'Late';
    }

    const attCheck = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND date = $2', [member.member_id, todayStr]);

    if (mode === 'IN') {
      if (attCheck.rows.length > 0 && attCheck.rows[0].time_in) {
        return res.json({ success: false, message: 'Already Timed In Today (' + attCheck.rows[0].time_in + ')' });
      }

      if (attCheck.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE member_id = $3 AND date = $4', [timeStr, attStatus, member.member_id, todayStr]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, date, time_in, status) VALUES ($1, $2, $3, $4)', [member.member_id, todayStr, timeStr, attStatus]);
      }

      return res.json({ success: true, member, time: timeStr, status: attStatus });
    } else {
      // TIME OUT MODE
      if (attCheck.rows.length === 0 || !attCheck.rows[0].time_in) {
        return res.json({ success: false, message: 'No Time-In Record Found for Today' });
      }
      if (attCheck.rows.length > 0 && attCheck.rows[0].time_out) {
        return res.json({ success: false, message: 'Already Timed Out Today (' + attCheck.rows[0].time_out + ')' });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE member_id = $2 AND date = $3', [timeStr, member.member_id, todayStr]);
      return res.json({ success: true, member, time: timeStr, status: 'Completed Out' });
    }
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: 'Server Database Error' });
  }
});


// ==========================================
// MEMBER PORTAL ROUTES (/member)
// ==========================================

app.get('/member/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Member Portal Login</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl space-y-6">
        <div class="text-center space-y-2">
          <div class="w-12 h-12 bg-sky-600 text-white font-bold rounded-xl flex items-center justify-center mx-auto text-xl shadow-lg">🎓</div>
          <h2 class="text-2xl font-bold">Member Portal Login</h2>
          <p class="text-xs text-slate-400">Access your attendance records and digital membership card</p>
        </div>
        ${req.query.error ? `<div class="bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-xl text-xs text-center">${req.query.error}</div>` : ''}
        <form action="/member/login" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Username</label>
            <input type="text" name="username" required class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-sky-500" placeholder="club-2026-001">
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Password</label>
            <input type="password" name="password" required class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-sky-500">
          </div>
          <button type="submit" class="w-full bg-sky-600 hover:bg-sky-500 font-semibold py-2.5 rounded-xl text-sm transition-colors shadow-lg">Sign In to Member Portal</button>
        </form>
        <div class="text-center pt-2"><a href="/" class="text-xs text-slate-400 hover:text-white">← Return to Home Hub</a></div>
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
        req.session.memberId = member.id;
        req.session.memberUsername = member.username;

        // Check if temporary password needs immediate change
        if (member.temporary_password_status) {
          return res.redirect('/member/change-password');
        }
        return res.redirect('/member/dashboard');
      }
    }
    res.redirect('/member/login?error=Invalid+Username+or+Password');
  } catch (err) {
    console.error(err);
    res.redirect('/member/login?error=Server+Error');
  }
});

// Force Password Change on First Login
app.get('/member/change-password', isAuthenticatedMember, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Change Temporary Password</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-900 border border-amber-500/40 p-8 rounded-2xl shadow-2xl space-y-6">
        <div class="text-center space-y-2">
          <div class="w-12 h-12 bg-amber-500/20 text-amber-400 font-bold rounded-xl flex items-center justify-center mx-auto text-xl">⚠️</div>
          <h2 class="text-xl font-bold">Temporary Password Detected</h2>
          <p class="text-xs text-slate-300">Your account is using a temporary password. You must create a secure personal password before continuing to your dashboard.</p>
        </div>
        <form action="/member/change-password" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">Create New Secure Password</label>
            <input type="password" name="new_password" required minlength="6" class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-sky-500">
          </div>
          <button type="submit" class="w-full bg-amber-600 hover:bg-amber-500 font-semibold py-2.5 rounded-xl text-sm transition-colors shadow-lg">Update Password & Continue</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/member/change-password', isAuthenticatedMember, async (req, res) => {
  const { new_password } = req.body;
  try {
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = FALSE WHERE id = $2', [hash, req.session.memberId]);
    res.redirect('/member/dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/member/change-password');
  }
});

app.get('/member/logout', isAuthenticatedMember, (req, res) => {
  req.session.destroy(() => res.redirect('/member/login'));
});

// Member Dashboard
app.get('/member/dashboard', isAuthenticatedMember, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [req.session.memberId]);
    if (memberRes.rows.length === 0) return res.redirect('/member/login');
    const member = memberRes.rows[0];

    if (member.temporary_password_status) {
      return res.redirect('/member/change-password');
    }

    const settingsRes = await pool.query('SELECT * FROM settings LIMIT 1');
    const settings = settingsRes.rows[0] || {};

    const attendanceRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 ORDER BY id DESC LIMIT 10', [member.member_id]);
    const announcementsRes = await pool.query('SELECT * FROM announcements ORDER BY id DESC LIMIT 3');
    const qrDataUrl = await QRCode.toDataURL(member.qr_token, { width: 300, margin: 1 });

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><title>Member Portal - ${member.full_name}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">
        <!-- Header -->
        <header class="bg-slate-900 border-b border-slate-800 p-4 flex items-center justify-between shadow-md">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 bg-sky-600 rounded-xl flex items-center justify-center font-bold text-white shadow">🎓</div>
            <div>
              <h1 class="text-sm font-bold text-white">${settings.organization_name || 'Tech Club'}</h1>
              <p class="text-[10px] text-slate-400">Member Portal • ${member.full_name}</p>
            </div>
          </div>
          <a href="/member/logout" class="text-xs bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white px-3.5 py-2 rounded-xl font-semibold transition-colors">Sign Out</a>
        </header>

        <!-- Main Content -->
        <main class="flex-1 max-w-4xl w-full mx-auto p-4 md:p-6 space-y-6">
          
          <!-- Profile & QR Card -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl flex flex-col items-center text-center space-y-4 md:col-span-1">
              <div class="w-24 h-24 rounded-2xl bg-sky-600/20 text-sky-400 font-bold flex items-center justify-center text-3xl border border-sky-500/30 shadow-inner">
                ${member.full_name.charAt(0)}
              </div>
              <div>
                <h2 class="text-lg font-bold text-white">${member.full_name}</h2>
                <p class="text-xs text-sky-400 font-semibold">${member.position}</p>
                <p class="text-[11px] text-slate-400 mt-1">ID: ${member.member_id}</p>
              </div>
              <div class="w-full pt-2 border-t border-slate-800 text-left text-xs space-y-1 text-slate-300">
                <p><strong class="text-slate-400">Course:</strong> ${member.course}</p>
                <p><strong class="text-slate-400">Section:</strong> ${member.section}</p>
                <p><strong class="text-slate-400">Status:</strong> <span class="text-emerald-400 font-bold">${member.status}</span></p>
              </div>
              <a href="/admin/members/view/${member.id}" target="_blank" class="w-full bg-sky-600 hover:bg-sky-500 text-white py-2 rounded-xl text-xs font-semibold shadow-lg">View Digital ID Card</a>
            </div>

            <!-- QR Display & Announcements -->
            <div class="md:col-span-2 space-y-6">
              <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl flex flex-col md:flex-row items-center gap-6">
                <img src="${qrDataUrl}" alt="My QR Code" class="w-36 h-36 bg-white p-2 rounded-2xl shadow-md">
                <div class="space-y-2 text-center md:text-left">
                  <span class="bg-sky-500/10 text-sky-400 text-[10px] font-semibold px-2.5 py-1 rounded-full border border-sky-500/20">Secure Entrance Token</span>
                  <h3 class="text-base font-bold text-white">Your Attendance QR Code</h3>
                  <p class="text-xs text-slate-400">Present this QR code to the entrance scanner smartphone to record your attendance time-in and time-out instantly.</p>
                </div>
              </div>

              <!-- Announcements Box -->
              <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-3">
                <h3 class="text-xs font-bold text-slate-300 uppercase tracking-wider">Club Announcements</h3>
                <div class="space-y-3">
                  ${announcementsRes.rows.length === 0 ? '<p class="text-xs text-slate-500">No announcements posted yet.</p>' : announcementsRes.rows.map(a => `
                    <div class="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1 text-xs">
                      <div class="flex items-center justify-between font-bold text-white">
                        <span>${a.title}</span>
                        <span class="text-[10px] text-slate-400">${new Date(a.created_at).toLocaleDateString()}</span>
                      </div>
                      <p class="text-slate-300 text-[11px]">${a.message}</p>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <!-- Attendance History Table -->
          <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
            <h3 class="text-xs font-bold text-slate-300 uppercase tracking-wider">Your Attendance History</h3>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="bg-slate-950 text-slate-400 uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th class="p-3">Date</th>
                    <th class="p-3">Time In</th>
                    <th class="p-3">Time Out</th>
                    <th class="p-3">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-800">
                  ${attendanceRes.rows.length === 0 ? '<tr><td colspan="4" class="p-4 text-center text-slate-500">No attendance history logs recorded yet.</td></tr>' : attendanceRes.rows.map(att => `
                    <tr class="hover:bg-slate-800/30">
                      <td class="p-3 text-slate-300">${new Date(att.date).toLocaleDateString()}</td>
                      <td class="p-3 text-emerald-400 font-mono">${att.time_in || '—'}</td>
                      <td class="p-3 text-amber-400 font-mono">${att.time_out || '—'}</td>
                      <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-semibold ${att.status === 'Present' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}">${att.status}</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Member Portal Error');
  }
});


// ==========================================
// LAYOUT & HELPER TEMPLATE FUNCTIONS
// ==========================================

function renderAdminLayout(title, username, settings, content) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Admin - ${title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen flex">
      <!-- Sidebar -->
      <aside class="w-64 bg-slate-900 border-r border-slate-800 hidden md:flex flex-col p-6 space-y-6">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center font-bold text-white shadow">🛡️</div>
          <div>
            <h1 class="text-xs font-bold text-white">${settings.organization_name || 'Club System'}</h1>
            <p class="text-[10px] text-slate-400">Admin Portal</p>
          </div>
        </div>
        <nav class="space-y-1.5 text-xs font-semibold">
          <a href="/admin/dashboard" class="flex items-center space-x-3 px-4 py-2.5 rounded-xl ${title === 'Dashboard' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}"><span>📊</span><span>Dashboard</span></a>
          <a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-xl ${title === 'Member Management' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}"><span>👥</span><span>Members & IDs</span></a>
          <a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-xl ${title === 'Attendance Logs' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}"><span>📋</span><span>Attendance Logs</span></a>
          <a href="/admin/reports" class="flex items-center space-x-3 px-4 py-2.5 rounded-xl ${title === 'Reports & Analytics' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}"><span>📈</span><span>Reports & Backup</span></a>
          <a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-xl ${title === 'Announcements' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}"><span>📢</span><span>Announcements</span></a>
          <a href="/admin/audit" class="flex items-center space-x-3 px-4 py-2.5 rounded-xl ${title === 'Audit Logs' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}"><span>🔒</span><span>Audit Logs</span></a>
          <a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-xl ${title === 'System Settings' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}"><span>⚙️</span><span>Settings</span></a>
        </nav>
        <div class="pt-auto mt-auto border-t border-slate-800 pt-4">
          <a href="/" class="text-[11px] text-slate-400 hover:text-white block mb-2">← Back to Hub</a>
          <a href="/admin/logout" class="text-xs text-rose-400 hover:underline font-semibold">Sign Out (${username})</a>
        </div>
      </aside>

      <!-- Main Content Area -->
      <div class="flex-1 flex flex-col min-h-screen">
        <header class="bg-slate-900 border-b border-slate-800 p-4 md:px-8 flex items-center justify-between shadow-sm">
          <h2 class="text-sm md:text-base font-bold text-white">${title}</h2>
          <div class="flex items-center space-x-3">
            <span class="text-xs text-slate-400">Logged in as <strong class="text-indigo-400">${username}</strong></span>
          </div>
        </header>
        <main class="flex-1 p-4 md:p-8">${content}</main>
      </div>
    </body>
    </html>
  `;
}

function renderSuccessModalLayout(fullName, memberId, username, tempPassword, id) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Member Registered Successfully</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-slate-100 flex items-center justify-center min-h-screen p-4">
      <div class="max-w-md w-full bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl space-y-6 text-center">
        <div class="w-14 h-14 bg-emerald-500/20 text-emerald-400 font-bold rounded-2xl flex items-center justify-center mx-auto text-2xl">✓</div>
        <h2 class="text-xl font-bold">Member Created Successfully!</h2>
        <p class="text-xs text-slate-400">Account and CR80 QR code have been automatically generated for <strong>${fullName}</strong>.</p>
        
        <div class="bg-slate-800 p-4 rounded-xl border border-slate-700 text-left text-xs space-y-2 font-mono">
          <p><span class="text-slate-400">Member ID:</span> <strong class="text-white">${memberId}</strong></p>
          <p><span class="text-slate-400">Username:</span> <strong class="text-indigo-400">${username}</strong></p>
          <p><span class="text-slate-400">Temporary Password:</span> <strong class="text-amber-400">${tempPassword}</strong></p>
        </div>
        <p class="text-[10px] text-amber-500 italic">Please record these temporary credentials. The member must change this password upon first login.</p>

        <div class="space-y-2 pt-2">
          <a href="/admin/members/view/${id}" target="_blank" class="block w-full bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-xl text-xs font-semibold shadow-lg">View & Print CR80 ID Card</a>
          <a href="/admin/members" class="block w-full bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl text-xs font-semibold">Return to Members Directory</a>
        </div>
      </div>
    </body>
    </html>
  `;
}

// Start Server
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` School Club Attendance System is running on port ${PORT}`);
  console.log(` Access Admin Portal:  http://localhost:${PORT}/admin/login`);
  console.log(` Access Scanner Hub:   http://localhost:${PORT}/scanner`);
  console.log(` Access Member Portal: http://localhost:${PORT}/member/login`);
  console.log(`======================================================\n`);
});
