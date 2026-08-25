const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'school-club-qr-secret-key-2026';

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// PostgreSQL Connection Pool Setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('Error acquiring client', err.stack);
    } else {
        console.log('Connected to PostgreSQL database successfully!');
        release();
    }
});

// Create Tables Safely on Startup
async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS admins (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password_hash TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS members (
            id SERIAL PRIMARY KEY,
            member_id TEXT UNIQUE,
            full_name TEXT,
            position TEXT,
            club TEXT,
            year_level TEXT,
            course TEXT,
            section TEXT,
            contact TEXT,
            email TEXT,
            photo TEXT,
            username TEXT UNIQUE,
            password_hash TEXT,
            temporary_password_status INTEGER DEFAULT 1,
            qr_token TEXT UNIQUE,
            status TEXT DEFAULT 'Active',
            date_joined TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS attendance (
            id SERIAL PRIMARY KEY,
            member_id TEXT,
            date TEXT,
            time_in TEXT,
            time_out TEXT,
            status TEXT,
            remarks TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS announcements (
            id SERIAL PRIMARY KEY,
            title TEXT,
            message TEXT,
            status TEXT DEFAULT 'Active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS settings (
            id SERIAL PRIMARY KEY,
            organization_name TEXT,
            school_name TEXT,
            logo TEXT,
            attendance_start TEXT,
            grace_period INTEGER
        )`);

        await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            action TEXT,
            user_name TEXT,
            date TEXT,
            time TEXT
        )`);

        // Seed Settings if empty
        const settingsCheck = await pool.query(`SELECT COUNT(*) as count FROM settings`);
        if (parseInt(settingsCheck.rows[0].count) === 0) {
            await pool.query(
                `INSERT INTO settings (organization_name, school_name, logo, attendance_start, grace_period) VALUES ($1, $2, $3, $4, $5)`,
                ['Supreme Student Council', 'National University', 'https://api.iconify.design/lucide:graduation-cap.svg?color=%234f46e5', '08:00', 15]
            );
        }

        // Seed Admin if empty
        const adminCheck = await pool.query(`SELECT COUNT(*) as count FROM admins`);
        if (parseInt(adminCheck.rows[0].count) === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            await pool.query(`INSERT INTO admins (username, password_hash) VALUES ($1, $2)`, ['admin', hash]);
            console.log('Default Admin Account Created -> Username: admin | Password: admin123');
        }
    } catch (err) {
        console.error('Database initialization error:', err);
    }
}
initDB();

// Helper for Audit Logs
async function logAction(action, user) {
    try {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        const time = now.toLocaleTimeString();
        await pool.query(`INSERT INTO audit_logs (action, user_name, date, time) VALUES ($1, $2, $3, $4)`, [action, user, date, time]);
    } catch(e) { console.error('Audit log error:', e); }
}

// HTML Layout Helper
const layoutHead = (title) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        @media print {
            body * { visibility: hidden; }
            #printable-id-card, #printable-id-card * { visibility: visible; }
            #printable-id-card { position: absolute; left: 0; top: 0; width: 85.6mm; height: 53.98mm; margin: 0; padding: 0; }
        }
        .cr80-card { width: 342px; height: 215px; background: white; border-radius: 12px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); position: relative; overflow: hidden; border: 1px solid #e2e8f0; }
    </style>
</head>
<body class="bg-slate-50 text-slate-800 font-sans antialiased min-h-screen">
`;

// Home Route
app.get('/', (req, res) => {
    res.send(`
        ${layoutHead('School Club QR System')}
        <div class="flex flex-col items-center justify-center min-h-screen p-6">
            <div class="text-center max-w-xl">
                <div class="inline-flex p-4 bg-indigo-100 text-indigo-600 rounded-full mb-4 text-3xl"><i class="fa-solid fa-qrcode"></i></div>
                <h1 class="text-3xl font-bold text-slate-900 mb-2">School Club QR Attendance System</h1>
                <p class="text-slate-600 mb-8">Select your portal to proceed with management, member access, or live event scanning.</p>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <a href="/admin/login" class="p-6 bg-white border border-slate-200 rounded-xl shadow-sm hover:border-indigo-500 hover:shadow-md transition text-center group">
                        <div class="text-indigo-600 text-2xl mb-2 group-hover:scale-110 transition"><i class="fa-solid fa-user-shield"></i></div>
                        <h2 class="font-bold text-slate-800">Admin Portal</h2>
                        <p class="text-xs text-slate-500 mt-1">Manage members, reports, and settings</p>
                    </a>
                    <a href="/scanner" class="p-6 bg-white border border-slate-200 rounded-xl shadow-sm hover:border-indigo-500 hover:shadow-md transition text-center group">
                        <div class="text-emerald-600 text-2xl mb-2 group-hover:scale-110 transition"><i class="fa-solid fa-camera"></i></div>
                        <h2 class="font-bold text-slate-800">Scanner Portal</h2>
                        <p class="text-xs text-slate-500 mt-1">Live smartphone attendance scanner</p>
                    </a>
                    <a href="/member" class="p-6 bg-white border border-slate-200 rounded-xl shadow-sm hover:border-indigo-500 hover:shadow-md transition text-center group">
                        <div class="text-amber-600 text-2xl mb-2 group-hover:scale-110 transition"><i class="fa-solid fa-users"></i></div>
                        <h2 class="font-bold text-slate-800">Member Portal</h2>
                        <p class="text-xs text-slate-500 mt-1">Check attendance records and profile</p>
                    </a>
                </div>
            </div>
        </div>
        </body></html>
    `);
});

// Admin Login
app.get('/admin/login', (req, res) => {
    res.send(`
        ${layoutHead('Admin Login')}
        <div class="flex items-center justify-center min-h-screen">
            <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-slate-100">
                <div class="text-center mb-6">
                    <div class="bg-indigo-600 text-white w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3 text-xl"><i class="fa-solid fa-shield-halved"></i></div>
                    <h1 class="text-2xl font-bold text-slate-900">Admin Portal</h1>
                    <p class="text-sm text-slate-500">Sign in to manage club system</p>
                </div>
                <form action="/admin/login" method="POST" class="space-y-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Username</label>
                        <input type="text" name="username" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Password</label>
                        <input type="password" name="password" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none">
                    </div>
                    <button type="submit" class="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-semibold hover:bg-indigo-700 transition">Sign In</button>
                </form>
                <div class="text-center mt-4"><a href="/" class="text-xs text-indigo-600 hover:underline">← Back to Home</a></div>
            </div>
        </div>
        </body></html>
    `);
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM admins WHERE username = $1`, [username]);
        const admin = result.rows[0];
        if (admin && await bcrypt.compare(password, admin.password_hash)) {
            req.session.adminId = admin.id;
            req.session.adminUser = admin.username;
            res.redirect('/admin');
        } else {
            res.send(`<script>alert('Invalid credentials'); window.location='/admin/login';</script>`);
        }
    } catch(e) {
        res.send(`<script>alert('Database error'); window.location='/admin/login';</script>`);
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

function requireAdmin(req, res, next) {
    if (req.session.adminId) next();
    else res.redirect('/admin/login');
}

// Admin Dashboard
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const totalRow = await pool.query(`SELECT COUNT(*) as total FROM members`);
        const activeRow = await pool.query(`SELECT COUNT(*) as active FROM members WHERE status = 'Active'`);
        const inactiveRow = await pool.query(`SELECT COUNT(*) as inactive FROM members WHERE status = 'Inactive'`);
        const today = new Date().toISOString().split('T')[0];
        const presentRow = await pool.query(`SELECT COUNT(DISTINCT member_id) as present FROM attendance WHERE date = $1 AND time_in IS NOT NULL`, [today]);
        const todayScanRow = await pool.query(`SELECT COUNT(*) as totalToday FROM attendance WHERE date = $1`, [today]);
        const recentMembers = await pool.query(`SELECT * FROM members ORDER BY id DESC LIMIT 5`);
        const recentScans = await pool.query(`SELECT a.*, m.full_name, m.position FROM attendance a JOIN members m ON a.member_id = m.member_id ORDER BY a.id DESC LIMIT 5`);

        const total = parseInt(totalRow.rows[0]?.total || 0);
        const present = parseInt(presentRow.rows[0]?.present || 0);
        const absent = Math.max(0, total - present);
        const pct = total > 0 ? ((present / total) * 100).toFixed(1) : 0;

        res.send(`
            ${layoutHead('Admin Dashboard')}
            <div class="flex h-screen overflow-hidden">
                <div class="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between hidden md:flex">
                    <div>
                        <div class="p-5 border-b border-slate-800 flex items-center space-x-3">
                            <div class="bg-indigo-600 text-white p-2 rounded-lg"><i class="fa-solid fa-qrcode"></i></div>
                            <span class="font-bold text-white text-lg">Club QR System</span>
                        </div>
                        <nav class="p-4 space-y-1">
                            <a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a>
                            <a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-users w-5"></i><span>Members</span></a>
                            <a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance</span></a>
                            <a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></a>
                            <a href="/admin/audit" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-clock-rotate-left w-5"></i><span>Audit Logs</span></a>
                            <a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-gear w-5"></i><span>Settings</span></a>
                        </nav>
                    </div>
                    <div class="p-4 border-t border-slate-800">
                        <a href="/admin/logout" class="flex items-center space-x-3 px-4 py-2 rounded-lg text-rose-400 hover:bg-slate-800 transition"><i class="fa-solid fa-right-from-bracket w-5"></i><span>Logout</span></a>
                    </div>
                </div>

                <div class="flex-1 flex flex-col overflow-y-auto">
                    <header class="bg-white border-b h-16 flex items-center justify-between px-6 shadow-sm">
                        <h1 class="text-xl font-bold text-slate-800">Dashboard Overview</h1>
                        <span class="text-sm font-medium text-slate-600">Hello, Admin</span>
                    </header>
                    <main class="p-6 space-y-6">
                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            <div class="bg-white p-5 rounded-xl border shadow-sm">
                                <p class="text-xs font-semibold text-slate-500 uppercase">Total Members</p>
                                <h3 class="text-2xl font-bold text-slate-900 mt-1">${total}</h3>
                                <span class="text-xs text-emerald-600 font-medium">Active: ${activeRow.rows[0]?.active || 0}</span>
                            </div>
                            <div class="bg-white p-5 rounded-xl border shadow-sm">
                                <p class="text-xs font-semibold text-slate-500 uppercase">Present Today</p>
                                <h3 class="text-2xl font-bold text-slate-900 mt-1">${present}</h3>
                                <span class="text-xs text-slate-500 font-medium">Absent Today: ${absent}</span>
                            </div>
                            <div class="bg-white p-5 rounded-xl border shadow-sm">
                                <p class="text-xs font-semibold text-slate-500 uppercase">Total Scans Today</p>
                                <h3 class="text-2xl font-bold text-slate-900 mt-1">${todayScanRow.rows[0]?.totalToday || 0}</h3>
                                <span class="text-xs text-indigo-600 font-medium">Live tracking</span>
                            </div>
                            <div class="bg-white p-5 rounded-xl border shadow-sm">
                                <p class="text-xs font-semibold text-slate-500 uppercase">Attendance Rate</p>
                                <h3 class="text-2xl font-bold text-slate-900 mt-1">${pct}%</h3>
                                <span class="text-xs text-emerald-600 font-medium">Daily participation</span>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <div class="bg-white rounded-xl border shadow-sm p-5">
                                <h3 class="font-bold text-slate-800 mb-4">Recent Scans</h3>
                                <table class="w-full text-left text-sm">
                                    <thead><tr class="border-b text-xs text-slate-500 uppercase"><th class="pb-2">Name</th><th class="pb-2">Status</th><th class="pb-2">Time In</th></tr></thead>
                                    <tbody class="divide-y">
                                        ${recentScans.rows.map(s => `<tr><td class="py-2 font-medium">${s.full_name}</td><td class="py-2"><span class="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700">${s.status}</span></td><td class="py-2 text-slate-500">${s.time_in || '-'}</td></tr>`).join('') || '<tr><td colspan="3" class="py-3 text-center text-slate-400">No scans yet</td></tr>'}
                                    </tbody>
                                </table>
                            </div>
                            <div class="bg-white rounded-xl border shadow-sm p-5">
                                <h3 class="font-bold text-slate-800 mb-4">Recent Registrations</h3>
                                <table class="w-full text-left text-sm">
                                    <thead><tr class="border-b text-xs text-slate-500 uppercase"><th class="pb-2">ID</th><th class="pb-2">Name</th><th class="pb-2">Position</th></tr></thead>
                                    <tbody class="divide-y">
                                        ${recentMembers.rows.map(m => `<tr><td class="py-2 font-mono text-xs">${m.member_id}</td><td class="py-2 font-medium">${m.full_name}</td><td class="py-2 text-slate-500">${m.position}</td></tr>`).join('') || '<tr><td colspan="3" class="py-3 text-center text-slate-400">No members yet</td></tr>'}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </main>
                </div>
            </div>
            </body></html>
        `);
    } catch(e) {
        console.error(e);
        res.status(500).send('Database Error');
    }
});

// Members Management Page
app.get('/admin/members', requireAdmin, async (req, res) => {
    const search = req.query.search || '';
    try {
        const result = await pool.query(`SELECT * FROM members WHERE full_name ILIKE $1 OR member_id ILIKE $1 ORDER BY id DESC`, [`%${search}%`]);
        res.send(`
            ${layoutHead('Manage Members')}
            <div class="flex h-screen overflow-hidden">
                <div class="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between hidden md:flex">
                    <div>
                        <div class="p-5 border-b border-slate-800 flex items-center space-x-3">
                            <div class="bg-indigo-600 text-white p-2 rounded-lg"><i class="fa-solid fa-qrcode"></i></div>
                            <span class="font-bold text-white text-lg">Club QR System</span>
                        </div>
                        <nav class="p-4 space-y-1">
                            <a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a>
                            <a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium"><i class="fa-solid fa-users w-5"></i><span>Members</span></a>
                            <a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance</span></a>
                            <a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></a>
                            <a href="/admin/audit" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-clock-rotate-left w-5"></i><span>Audit Logs</span></a>
                            <a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"><i class="fa-solid fa-gear w-5"></i><span>Settings</span></a>
                        </nav>
                    </div>
                    <div class="p-4 border-t border-slate-800"><a href="/admin/logout" class="flex items-center space-x-3 px-4 py-2 rounded-lg text-rose-400 hover:bg-slate-800 transition"><i class="fa-solid fa-right-from-bracket w-5"></i><span>Logout</span></a></div>
                </div>
                <div class="flex-1 flex flex-col overflow-y-auto">
                    <header class="bg-white border-b h-16 flex items-center justify-between px-6 shadow-sm">
                        <h1 class="text-xl font-bold text-slate-800">Member Management</h1>
                        <button onclick="document.getElementById('addModal').classList.remove('hidden')" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition"><i class="fa-solid fa-user-plus mr-2"></i>Add Member</button>
                    </header>
                    <main class="p-6 space-y-6">
                        <div class="bg-white rounded-xl border shadow-sm p-4">
                            <form action="/admin/members" method="GET" class="flex gap-4">
                                <input type="text" name="search" value="${search}" placeholder="Search by name or ID..." class="flex-1 px-4 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-indigo-500">
                                <button type="submit" class="bg-slate-800 text-white px-5 py-2 rounded-lg font-semibold text-sm">Search</button>
                            </form>
                        </div>
                        <div class="bg-white rounded-xl border shadow-sm overflow-hidden">
                            <table class="w-full text-left text-sm">
                                <thead class="bg-slate-50 border-b text-xs text-slate-500 uppercase">
                                    <tr><th class="p-4">Member ID</th><th class="p-4">Full Name</th><th class="p-4">Position</th><th class="p-4">Course / Section</th><th class="p-4">Status</th><th class="p-4 text-right">Actions</th></tr>
                                </thead>
                                <tbody class="divide-y">
                                    ${result.rows.map(m => `
                                        <tr>
                                            <td class="p-4 font-mono text-xs">${m.member_id}</td>
                                            <td class="p-4 font-medium">${m.full_name}</td>
                                            <td class="p-4 text-slate-600">${m.position}</td>
                                            <td class="p-4 text-slate-600">${m.course} - ${m.section}</td>
                                            <td class="p-4"><span class="px-2 py-0.5 rounded text-xs ${m.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">${m.status}</span></td>
                                            <td class="p-4 text-right space-x-2">
                                                <a href="/admin/members/id/${m.id}" class="text-indigo-600 hover:underline text-xs font-semibold"><i class="fa-solid fa-id-card"></i> ID</a>
                                                <a href="/admin/members/toggle/${m.id}" class="text-amber-600 hover:underline text-xs font-semibold">${m.status === 'Active' ? 'Deactivate' : 'Activate'}</a>
                                                <a href="/admin/members/reset/${m.id}" class="text-blue-600 hover:underline text-xs font-semibold" onclick="return confirm('Reset temporary password?')">Reset Pwd</a>
                                                <a href="/admin/members/delete/${m.id}" class="text-rose-600 hover:underline text-xs font-semibold" onclick="return confirm('Delete member?')">Delete</a>
                                            </td>
                                        </tr>
                                    `).join('') || '<tr><td colspan="6" class="p-4 text-center text-slate-400">No members found</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </main>
                </div>
            </div>
            <!-- Add Modal -->
            <div id="addModal" class="fixed inset-0 bg-black/50 hidden flex items-center justify-center p-4 z-50">
                <div class="bg-white rounded-2xl max-w-xl w-full p-6 max-h-[90vh] overflow-y-auto">
                    <div class="flex justify-between items-center mb-4"><h3 class="font-bold text-lg text-slate-800">Add New Member</h3><button onclick="document.getElementById('addModal').classList.add('hidden')" class="text-slate-400 hover:text-slate-600"><i class="fa-solid fa-xmark text-lg"></i></button></div>
                    <form action="/admin/members/add" method="POST" class="space-y-4">
                        <div class="grid grid-cols-2 gap-4">
                            <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Full Name</label><input type="text" name="full_name" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                            <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Position</label><input type="text" name="position" value="Member" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                        </div>
                        <div class="grid grid-cols-2 gap-4">
                            <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Year Level</label><input type="text" name="year_level" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                            <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Course / Program</label><input type="text" name="course" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                        </div>
                        <div class="grid grid-cols-2 gap-4">
                            <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Section</label><input type="text" name="section" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                            <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Contact Number</label><input type="text" name="contact" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                        </div>
                        <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Email Address</label><input type="email" name="email" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                        <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Profile Photo URL</label><input type="text" name="photo" placeholder="https://..." class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                        <button type="submit" class="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-semibold hover:bg-indigo-700 transition">Create Member & Generate ID</button>
                    </form>
                </div>
            </div>
            </body></html>
        `);
    } catch(e) { res.status(500).send('Database Error'); }
});

// Add Member
app.post('/admin/members/add', requireAdmin, async (req, res) => {
    const { full_name, position, year_level, course, section, contact, email, photo } = req.body;
    const year = new Date().getFullYear();
    const randomNum = Math.floor(100 + Math.random() * 900);
    const member_id = `CLUB-${year}-${randomNum}`;
    const username = `MEM-${year}-${Math.floor(1000 + Math.random() * 9000)}`;
    const tempPassword = Math.random().toString(36).substring(2, 10).toUpperCase();
    const password_hash = await bcrypt.hash(tempPassword, 10);
    const qr_token = member_id + '-' + crypto.randomBytes(4).toString('hex');
    const date_joined = new Date().toISOString().split('T')[0];
    const profilePhoto = photo || 'https://api.iconify.design/lucide:user.svg?color=%2394a3b8';

    try {
        const ins = await pool.query(
            `INSERT INTO members (member_id, full_name, position, club, year_level, course, section, contact, email, photo, username, password_hash, temporary_password_status, qr_token, status, date_joined) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, 'Active', $14) RETURNING id`,
            [member_id, full_name, position, 'Supreme Student Council', year_level, course, section, contact, email, profilePhoto, username, password_hash, qr_token, date_joined]
        );
        logAction(`Created member: ${full_name} (${member_id})`, req.session.adminUser);
        res.redirect(`/admin/members/id/${ins.rows[0].id}?new=true&user=${username}&pass=${tempPassword}`);
    } catch(e) {
        console.error(e);
        res.send(`<script>alert('Error creating member.'); window.location='/admin/members';</script>`);
    }
});

// Member ID View
app.get('/admin/members/id/:id', requireAdmin, async (req, res) => {
    const isNew = req.query.new === 'true';
    const tempUser = req.query.user || '';
    const tempPass = req.query.pass || '';
    try {
        const memRes = await pool.query(`SELECT * FROM members WHERE id = $1`, [req.params.id]);
        const member = memRes.rows[0];
        if (!member) return res.redirect('/admin/members');

        const setRes = await pool.query(`SELECT school_name FROM settings LIMIT 1`);
        const qrDataUrl = await QRCode.toDataURL(member.qr_token);

        res.send(`
            ${layoutHead('Member ID Card')}
            <div class="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4">
                ${isNew ? `<div class="mb-6 bg-emerald-50 border border-emerald-200 p-4 rounded-xl text-center max-w-md w-full"><h3 class="font-bold text-emerald-800 text-lg mb-1">Member Created Successfully!</h3><div class="bg-white p-3 rounded border text-left font-mono text-xs space-y-1 mt-2"><div><strong>Username:</strong> ${tempUser}</div><div><strong>Temp Password:</strong> ${tempPass}</div></div></div>` : ''}
                <div id="printable-id-card" class="cr80-card flex flex-col justify-between p-4 bg-gradient-to-br from-indigo-900 to-slate-900 text-white">
                    <div class="flex justify-between items-center border-b border-white/10 pb-2"><div class="text-[10px] uppercase font-semibold text-indigo-200">${setRes.rows[0]?.school_name || ''}</div><div class="text-[10px] bg-indigo-600 px-2 py-0.5 rounded">${member.position}</div></div>
                    <div class="flex items-center space-x-3 my-auto"><img src="${member.photo}" class="w-16 h-16 rounded-full object-cover border-2 border-white/20"><div><h2 class="font-bold text-sm leading-tight">${member.full_name}</h2><p class="text-[10px] text-indigo-300">${member.course} - ${member.section}</p><p class="text-[9px] font-mono mt-1 text-slate-300">ID: ${member.member_id}</p></div><div class="ml-auto bg-white p-1 rounded"><img src="${qrDataUrl}" class="w-14 h-14"></div></div>
                    <div class="text-[8px] text-center text-slate-400 border-t border-white/10 pt-1">Official Membership ID Card</div>
                </div>
                <div class="mt-6 flex space-x-3"><button onclick="window.print()" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition">Print ID</button><a href="/admin/members" class="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-semibold">Back to Members</a></div>
            </div>
            </body></html>
        `);
    } catch(e) { res.redirect('/admin/members'); }
});

// Toggle Status
app.get('/admin/members/toggle/:id', requireAdmin, async (req, res) => {
    try {
        const m = await pool.query(`SELECT status, full_name FROM members WHERE id = $1`, [req.params.id]);
        if (m.rows.length > 0) {
            const newStatus = m.rows[0].status === 'Active' ? 'Inactive' : 'Active';
            await pool.query(`UPDATE members SET status = $1 WHERE id = $2`, [newStatus, req.params.id]);
            logAction(`Toggled status: ${m.rows[0].full_name} to ${newStatus}`, req.session.adminUser);
        }
        res.redirect('/admin/members');
    } catch(e) { res.redirect('/admin/members'); }
});

// Reset Password
app.get('/admin/members/reset/:id', requireAdmin, async (req, res) => {
    try {
        const tempPassword = Math.random().toString(36).substring(2, 10).toUpperCase();
        const password_hash = await bcrypt.hash(tempPassword, 10);
        const m = await pool.query(`SELECT full_name FROM members WHERE id = $1`, [req.params.id]);
        if (m.rows.length > 0) {
            await pool.query(`UPDATE members SET password_hash = $1, temporary_password_status = 1 WHERE id = $2`, [password_hash, req.params.id]);
            logAction(`Reset password for member: ${m.rows[0].full_name}`, req.session.adminUser);
            res.send(`<script>alert('New Temporary Password: ${tempPassword}'); window.location='/admin/members';</script>`);
        } else { res.redirect('/admin/members'); }
    } catch(e) { res.redirect('/admin/members'); }
});

// Delete Member
app.get('/admin/members/delete/:id', requireAdmin, async (req, res) => {
    try {
        const m = await pool.query(`SELECT full_name FROM members WHERE id = $1`, [req.params.id]);
        await pool.query(`DELETE FROM members WHERE id = $1`, [req.params.id]);
        if (m.rows.length > 0) logAction(`Deleted member: ${m.rows[0].full_name}`, req.session.adminUser);
        res.redirect('/admin/members');
    } catch(e) { res.redirect('/admin/members'); }
});

// Attendance Page
app.get('/admin/attendance', requireAdmin, async (req, res) => {
    try {
        const records = await pool.query(`SELECT a.*, m.full_name, m.position FROM attendance a JOIN members m ON a.member_id = m.member_id ORDER BY a.id DESC`);
        res.send(`
            ${layoutHead('Attendance Records')}
            <div class="flex h-screen overflow-hidden">
                <div class="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between hidden md:flex">
                    <div>
                        <div class="p-5 border-b border-slate-800 flex items-center space-x-3"><div class="bg-indigo-600 text-white p-2 rounded-lg"><i class="fa-solid fa-qrcode"></i></div><span class="font-bold text-white text-lg">Club QR System</span></div>
                        <nav class="p-4 space-y-1"><a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a><a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-users w-5"></i><span>Members</span></a><a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium"><i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance</span></a><a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></a><a href="/admin/audit" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-clock-rotate-left w-5"></i><span>Audit Logs</span></a><a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-gear w-5"></i><span>Settings</span></a></nav>
                    </div>
                    <div class="p-4 border-t border-slate-800"><a href="/admin/logout" class="text-rose-400 text-sm">Logout</a></div>
                </div>
                <div class="flex-1 flex flex-col overflow-y-auto">
                    <header class="bg-white border-b h-16 flex items-center justify-between px-6 shadow-sm"><h1 class="text-xl font-bold text-slate-800">Attendance Log</h1><button onclick="window.print()" class="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-semibold">Print Report</button></header>
                    <main class="p-6">
                        <div class="bg-white rounded-xl border shadow-sm overflow-hidden">
                            <table class="w-full text-left text-sm">
                                <thead class="bg-slate-50 border-b text-xs text-slate-500 uppercase"><tr><th class="p-4">Date</th><th class="p-4">Member ID</th><th class="p-4">Name</th><th class="p-4">Time In</th><th class="p-4">Time Out</th><th class="p-4">Status</th></tr></thead>
                                <tbody class="divide-y">
                                    ${records.rows.map(r => `<tr><td class="p-4">${r.date}</td><td class="p-4 font-mono text-xs">${r.member_id}</td><td class="p-4 font-medium">${r.full_name}</td><td class="p-4 text-slate-600">${r.time_in || '-'}</td><td class="p-4 text-slate-600">${r.time_out || '-'}</td><td class="p-4"><span class="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700">${r.status}</span></td></tr>`).join('') || '<tr><td colspan="6" class="p-4 text-center text-slate-400">No attendance records found</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </main>
                </div>
            </div>
            </body></html>
        `);
    } catch(e) { res.status(500).send('Error'); }
});

// Announcements
app.get('/admin/announcements', requireAdmin, async (req, res) => {
    try {
        const items = await pool.query(`SELECT * FROM announcements ORDER BY id DESC`);
        res.send(`
            ${layoutHead('Announcements')}
            <div class="flex h-screen overflow-hidden">
                <div class="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between hidden md:flex">
                    <div>
                        <div class="p-5 border-b border-slate-800 flex items-center space-x-3"><div class="bg-indigo-600 text-white p-2 rounded-lg"><i class="fa-solid fa-qrcode"></i></div><span class="font-bold text-white text-lg">Club QR System</span></div>
                        <nav class="p-4 space-y-1"><a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a><a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-users w-5"></i><span>Members</span></a><a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance</span></a><a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></a><a href="/admin/audit" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-clock-rotate-left w-5"></i><span>Audit Logs</span></a><a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-gear w-5"></i><span>Settings</span></a></nav>
                    </div>
                    <div class="p-4 border-t border-slate-800"><a href="/admin/logout" class="text-rose-400 text-sm">Logout</a></div>
                </div>
                <div class="flex-1 flex flex-col overflow-y-auto">
                    <header class="bg-white border-b h-16 flex items-center px-6 shadow-sm"><h1 class="text-xl font-bold text-slate-800">Announcements</h1></header>
                    <main class="p-6 space-y-6">
                        <div class="bg-white p-6 rounded-xl border shadow-sm max-w-xl">
                            <h3 class="font-bold text-slate-800 mb-4">Post Announcement</h3>
                            <form action="/admin/announcements" method="POST" class="space-y-4">
                                <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Title</label><input type="text" name="title" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                                <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Message</label><textarea name="message" rows="3" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></textarea></div>
                                <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-lg font-semibold text-sm">Post</button>
                            </form>
                        </div>
                        <div class="space-y-4 max-w-xl">
                            ${items.rows.map(i => `<div class="bg-white p-4 rounded-xl border shadow-sm"><h4 class="font-bold text-slate-800">${i.title}</h4><p class="text-sm text-slate-600 mt-2">${i.message}</p></div>`).join('') || '<p class="text-slate-400">No announcements</p>'}
                        </div>
                    </main>
                </div>
            </div>
            </body></html>
        `);
    } catch(e) { res.status(500).send('Error'); }
});

app.post('/admin/announcements', requireAdmin, async (req, res) => {
    const { title, message } = req.body;
    try {
        await pool.query(`INSERT INTO announcements (title, message) VALUES ($1, $2)`, [title, message]);
        logAction(`Created announcement: ${title}`, req.session.adminUser);
        res.redirect('/admin/announcements');
    } catch(e) { res.redirect('/admin/announcements'); }
});

// Audit Logs
app.get('/admin/audit', requireAdmin, async (req, res) => {
    try {
        const logs = await pool.query(`SELECT * FROM audit_logs ORDER BY id DESC`);
        res.send(`
            ${layoutHead('Audit Logs')}
            <div class="flex h-screen overflow-hidden">
                <div class="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between hidden md:flex">
                    <div>
                        <div class="p-5 border-b border-slate-800 flex items-center space-x-3"><div class="bg-indigo-600 text-white p-2 rounded-lg"><i class="fa-solid fa-qrcode"></i></div><span class="font-bold text-white text-lg">Club QR System</span></div>
                        <nav class="p-4 space-y-1"><a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a><a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-users w-5"></i><span>Members</span></a><a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance</span></a><a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></a><a href="/admin/audit" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium"><i class="fa-solid fa-clock-rotate-left w-5"></i><span>Audit Logs</span></a><a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-gear w-5"></i><span>Settings</span></a></nav>
                    </div>
                    <div class="p-4 border-t border-slate-800"><a href="/admin/logout" class="text-rose-400 text-sm">Logout</a></div>
                </div>
                <div class="flex-1 flex flex-col overflow-y-auto">
                    <header class="bg-white border-b h-16 flex items-center px-6 shadow-sm"><h1 class="text-xl font-bold text-slate-800">System Audit Logs</h1></header>
                    <main class="p-6">
                        <div class="bg-white rounded-xl border shadow-sm overflow-hidden">
                            <table class="w-full text-left text-sm">
                                <thead class="bg-slate-50 border-b text-xs text-slate-500 uppercase"><tr><th class="p-4">Action</th><th class="p-4">Admin User</th><th class="p-4">Date</th><th class="p-4">Time</th></tr></thead>
                                <tbody class="divide-y">
                                    ${logs.rows.map(l => `<tr><td class="p-4 font-medium">${l.action}</td><td class="p-4 text-slate-600">${l.user_name}</td><td class="p-4 text-slate-500">${l.date}</td><td class="p-4 text-slate-500">${l.time}</td></tr>`).join('') || '<tr><td colspan="4" class="p-4 text-center text-slate-400">No logs</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </main>
                </div>
            </div>
            </body></html>
        `);
    } catch(e) { res.status(500).send('Error'); }
});

// Settings
app.get('/admin/settings', requireAdmin, async (req, res) => {
    try {
        const settings = await pool.query(`SELECT * FROM settings LIMIT 1`);
        res.send(`
            ${layoutHead('Settings')}
            <div class="flex h-screen overflow-hidden">
                <div class="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between hidden md:flex">
                    <div>
                        <div class="p-5 border-b border-slate-800 flex items-center space-x-3"><div class="bg-indigo-600 text-white p-2 rounded-lg"><i class="fa-solid fa-qrcode"></i></div><span class="font-bold text-white text-lg">Club QR System</span></div>
                        <nav class="p-4 space-y-1"><a href="/admin" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a><a href="/admin/members" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-users w-5"></i><span>Members</span></a><a href="/admin/attendance" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance</span></a><a href="/admin/announcements" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></a><a href="/admin/audit" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg hover:bg-slate-800 text-slate-300"><i class="fa-solid fa-clock-rotate-left w-5"></i><span>Audit Logs</span></a><a href="/admin/settings" class="flex items-center space-x-3 px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium"><i class="fa-solid fa-gear w-5"></i><span>Settings</span></a></nav>
                    </div>
                    <div class="p-4 border-t border-slate-800"><a href="/admin/logout" class="text-rose-400 text-sm">Logout</a></div>
                </div>
                <div class="flex-1 flex flex-col overflow-y-auto">
                    <header class="bg-white border-b h-16 flex items-center px-6 shadow-sm"><h1 class="text-xl font-bold text-slate-800">System Configuration</h1></header>
                    <main class="p-6">
                        <div class="bg-white p-6 rounded-xl border shadow-sm max-w-xl">
                            <form action="/admin/settings" method="POST" class="space-y-4">
                                <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Organization Name</label><input type="text" name="organization_name" value="${settings.rows[0]?.organization_name || ''}" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                                <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">School Name</label><input type="text" name="school_name" value="${settings.rows[0]?.school_name || ''}" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                                <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Attendance Start Time</label><input type="text" name="attendance_start" value="${settings.rows[0]?.attendance_start || '08:00'}" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                                <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Grace Period (Minutes)</label><input type="number" name="grace_period" value="${settings.rows[0]?.grace_period || 15}" required class="w-full px-3 py-2 border rounded-lg text-sm outline-none"></div>
                                <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-lg font-semibold text-sm">Save Settings</button>
                            </form>
                        </div>
                    </main>
                </div>
            </div>
            </body></html>
        `);
    } catch(e) { res.status(500).send('Error'); }
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
    const { organization_name, school_name, attendance_start, grace_period } = req.body;
    try {
        await pool.query(`UPDATE settings SET organization_name = $1, school_name = $2, attendance_start = $3, grace_period = $4`, [organization_name, school_name, attendance_start, grace_period]);
        logAction(`Updated system settings`, req.session.adminUser);
        res.redirect('/admin/settings');
    } catch(e) { res.redirect('/admin/settings'); }
});

// Scanner Portal
app.get('/scanner', (req, res) => {
    res.send(`
        ${layoutHead('Scanner Portal')}
        <div class="min-h-screen bg-slate-900 text-white flex flex-col justify-between p-4">
            <div class="flex justify-between items-center max-w-md mx-auto w-full pt-2">
                <h1 class="font-bold text-lg"><i class="fa-solid fa-camera text-indigo-400 mr-2"></i>Scanner Portal</h1>
                <div class="flex bg-slate-800 p-1 rounded-lg text-xs font-semibold">
                    <button onclick="setMode('IN')" id="btn-in" class="px-3 py-1.5 rounded bg-indigo-600 text-white transition">TIME IN</button>
                    <button onclick="setMode('OUT')" id="btn-out" class="px-3 py-1.5 rounded text-slate-400 transition">TIME OUT</button>
                </div>
            </div>
            <div class="max-w-md mx-auto w-full my-auto text-center space-y-4">
                <div id="reader" class="overflow-hidden rounded-2xl border-2 border-indigo-500/50 bg-black"></div>
                <div id="scan-result" class="p-4 rounded-xl bg-slate-800 border border-slate-700 min-h-[90px] flex flex-col justify-center items-center"><p class="text-sm text-slate-400">Position QR code inside scanner frame</p></div>
            </div>
            <div class="text-center text-xs text-slate-500 pb-2">School Club QR Attendance System</div>
        </div>
        <script>
            let currentMode = 'IN';
            function setMode(mode) {
                currentMode = mode;
                document.getElementById('btn-in').className = mode === 'IN' ? 'px-3 py-1.5 rounded bg-indigo-600 text-white transition' : 'px-3 py-1.5 rounded text-slate-400 transition';
                document.getElementById('btn-out').className = mode === 'OUT' ? 'px-3 py-1.5 rounded bg-indigo-600 text-white transition' : 'px-3 py-1.5 rounded text-slate-400 transition';
            }
            let isProcessing = false;
            function onScanSuccess(decodedText) {
                if(isProcessing) return;
                isProcessing = true;
                fetch('/scanner/process', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: decodedText, mode: currentMode })
                })
                .then(res => res.json())
                .then(data => {
                    const resBox = document.getElementById('scan-result');
                    if(data.success) {
                        resBox.className = 'p-4 rounded-xl bg-emerald-950 border border-emerald-600 flex flex-col justify-center items-center';
                        resBox.innerHTML = \`<div class="font-bold text-emerald-400 text-sm">✓ \${data.message}</div><div class="text-xs text-white mt-1">\${data.name} (\${data.position})</div>\`;
                    } else {
                        resBox.className = 'p-4 rounded-xl bg-rose-950 border border-rose-600 flex flex-col justify-center items-center';
                        resBox.innerHTML = \`<div class="font-bold text-rose-400 text-sm">✕ \${data.message}</div>\`;
                    }
                    setTimeout(() => { isProcessing = false; }, 2500);
                }).catch(() => { isProcessing = false; });
            }
            const html5QrCode = new Html5Qrcode("reader");
            html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess, err => {});
        </script>
        </body></html>
    `);
});

// Scanner Process API
app.post('/scanner/process', async (req, res) => {
    const { token, mode } = req.body;
    try {
        const memRes = await pool.query(`SELECT * FROM members WHERE qr_token = $1`, [token]);
        const member = memRes.rows[0];
        if (!member) return res.json({ success: false, message: 'Invalid QR Code. Not registered.' });
        if (member.status !== 'Active') return res.json({ success: false, message: 'Member account is inactive.' });

        const today = new Date().toISOString().split('T')[0];
        const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const attRes = await pool.query(`SELECT * FROM attendance WHERE member_id = $1 AND date = $2`, [member.member_id, today]);
        const att = attRes.rows[0];

        if (mode === 'IN') {
            if (att && att.time_in) return res.json({ success: false, message: 'Already Timed In Today' });
            if (att) {
                await pool.query(`UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3`, [timeNow, 'Present', att.id]);
            } else {
                await pool.query(`INSERT INTO attendance (member_id, date, time_in, status) VALUES ($1, $2, $3, $4)`, [member.member_id, today, timeNow, 'Present']);
            }
            res.json({ success: true, message: 'TIME IN RECORDED', name: member.full_name, position: member.position, time: timeNow });
        } else {
            if (!att || !att.time_in) return res.json({ success: false, message: 'No Time-In Record Found' });
            if (att.time_out) return res.json({ success: false, message: 'Already Timed Out' });
            await pool.query(`UPDATE attendance SET time_out = $1 WHERE id = $2`, [timeNow, att.id]);
            res.json({ success: true, message: 'TIME OUT RECORDED', name: member.full_name, position: member.position, time: timeNow });
        }
    } catch(e) {
        res.json({ success: false, message: 'Server error processing scan' });
    }
});

// Member Portal
app.get('/member', (req, res) => {
    if (req.session.memberId) return res.redirect('/member/dashboard');
    res.send(`
        ${layoutHead('Member Portal Login')}
        <div class="flex items-center justify-center min-h-screen p-4">
            <div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border">
                <div class="text-center mb-6"><div class="bg-amber-600 text-white w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3 text-xl"><i class="fa-solid fa-users"></i></div><h1 class="text-2xl font-bold text-slate-900">Member Portal</h1><p class="text-sm text-slate-500">Sign in with credentials</p></div>
                <form action="/member/login" method="POST" class="space-y-4">
                    <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Username</label><input type="text" name="username" required class="w-full px-4 py-2 border rounded-lg outline-none"></div>
                    <div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">Password</label><input type="password" name="password" required class="w-full px-4 py-2 border rounded-lg outline-none"></div>
                    <button type="submit" class="w-full bg-amber-600 text-white py-2.5 rounded-lg font-semibold hover:bg-amber-700 transition">Member Login</button>
                </form>
            </div>
        </div>
        </body></html>
    `);
});

app.post('/member/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const memberRes = await pool.query(`SELECT * FROM members WHERE username = $1`, [username]);
        const member = memberRes.rows[0];
        if (member && await bcrypt.compare(password, member.password_hash)) {
            req.session.memberId = member.id;
            if (member.temporary_password_status === 1) res.redirect('/member/change-password');
            else res.redirect('/member/dashboard');
        } else {
            res.send(`<script>alert('Invalid credentials'); window.location='/member';</script>`);
        }
    } catch(e) { res.redirect('/member'); }
});

app.get('/member/change-password', (req, res) => {
    if (!req.session.memberId) return res.redirect('/member');
    res.send(`
        ${layoutHead('Change Password')}
        <div class="flex items-center justify-center min-h-screen p-4"><div class="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border"><h2 class="text-xl font-bold mb-2">Change Password Required</h2><form action="/member/change-password" method="POST" class="space-y-4 mt-4"><div><label class="block text-xs font-semibold uppercase text-slate-600 mb-1">New Password</label><input type="password" name="password" required class="w-full px-4 py-2 border rounded-lg outline-none"></div><button type="submit" class="w-full bg-amber-600 text-white py-2.5 rounded-lg font-semibold">Update Password</button></form></div></div>
        </body></html>
    `);
});

app.post('/member/change-password', async (req, res) => {
    if (!req.session.memberId) return res.redirect('/member');
    const { password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query(`UPDATE members SET password_hash = $1, temporary_password_status = 0 WHERE id = $2`, [hash, req.session.memberId]);
        res.redirect('/member/dashboard');
    } catch(e) { res.redirect('/member'); }
});

app.get('/member/dashboard', async (req, res) => {
    if (!req.session.memberId) return res.redirect('/member');
    try {
        const memRes = await pool.query(`SELECT * FROM members WHERE id = $1`, [req.session.memberId]);
        const member = memRes.rows[0];
        if (!member) return res.redirect('/member');

        const recRes = await pool.query(`SELECT * FROM attendance WHERE member_id = $1 ORDER BY id DESC`, [member.member_id]);
        const qrDataUrl = await QRCode.toDataURL(member.qr_token);

        res.send(`
            ${layoutHead('Member Dashboard')}
            <div class="min-h-screen bg-slate-50 flex flex-col">
                <header class="bg-white border-b h-16 flex items-center justify-between px-6 shadow-sm"><h1 class="text-xl font-bold text-slate-800">Member Portal</h1><a href="/member/logout" class="text-xs font-semibold text-rose-600">Logout</a></header>
                <main class="p-6 max-w-4xl mx-auto w-full space-y-6">
                    <div class="bg-white p-6 rounded-xl border shadow-sm flex flex-col md:flex-row items-center gap-6"><img src="${member.photo}" class="w-24 h-24 rounded-full object-cover border-2 border-amber-500"><div class="flex-1 text-center md:text-left"><h2 class="text-xl font-bold text-slate-900">${member.full_name}</h2><p class="text-sm text-slate-600">${member.position} • <span class="font-mono">${member.member_id}</span></p><p class="text-xs text-slate-500 mt-1">${member.course} - Section ${member.section}</p></div><div class="bg-white p-2 border rounded-xl shadow-inner"><img src="${qrDataUrl}" class="w-24 h-24"></div></div>
                    <div class="bg-white rounded-xl border shadow-sm p-6"><h3 class="font-bold text-slate-800 mb-4">My Attendance History</h3><table class="w-full text-left text-sm"><thead class="border-b text-xs text-slate-500 uppercase"><tr><th class="pb-2">Date</th><th class="pb-2">Time In</th><th class="pb-2">Time Out</th><th class="pb-2">Status</th></tr></thead><tbody class="divide-y">${recRes.rows.map(r => `<tr><td class="py-2">${r.date}</td><td class="py-2">${r.time_in || '-'}</td><td class="py-2">${r.time_out || '-'}</td><td class="py-2"><span class="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700">${r.status}</span></td></tr>`).join('') || '<tr><td colspan="4" class="py-3 text-center text-slate-400">No attendance history</td></tr>'}</tbody></table></div>
                </main>
            </div>
            </body></html>
        `);
    } catch(e) { res.redirect('/member'); }
});

app.get('/member/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/member'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`School Club QR Attendance System running on port ${PORT}`);
});
