const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbFile = path.join(dataDir, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Database opening error: ', err.message);
    else console.log('Connected to SQLite database.');
});

// Initialize Database Tables & Default Admin
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT UNIQUE,
        name TEXT NOT NULL,
        position TEXT DEFAULT 'Member',
        email TEXT,
        contact TEXT,
        username TEXT UNIQUE,
        password TEXT NOT NULL,
        temporary_password TEXT,
        qr_token TEXT UNIQUE,
        status TEXT DEFAULT 'Active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT,
        scan_type TEXT,
        date TEXT,
        time TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        scanner_device TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS clubs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        club_name TEXT DEFAULT 'School Club Organization',
        school_name TEXT DEFAULT 'National High School',
        school_year TEXT DEFAULT '2025-2026',
        adviser TEXT DEFAULT 'Faculty Adviser',
        logo TEXT DEFAULT '',
        expected_time_in TEXT DEFAULT '08:00',
        expected_time_out TEXT DEFAULT '17:00',
        late_threshold TEXT DEFAULT '08:15'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        action TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Insert Default Club Info if empty
    db.get(`SELECT COUNT(*) as count FROM clubs`, (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO clubs (club_name, school_name, school_year, adviser) VALUES ('Coding & Robotics Club', 'Manila Science High School', '2025-2026', 'Dr. Juan Santos')`);
        }
    });

    // Insert Default Admin User (username: admin, password: adminpassword)
    db.get(`SELECT COUNT(*) as count FROM users WHERE username = 'admin'`, async (err, row) => {
        if (row && row.count === 0) {
            const hashed = await bcrypt.hash('adminpassword', 10);
            db.run(`INSERT INTO users (member_id, name, position, username, password, qr_token, status) VALUES ('ADMIN-001', 'System Administrator', 'Adviser', 'admin', ?, 'ADMIN_TOKEN_SECURE', 'Active')`, [hashed]);
        }
    });
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'school-club-attendance-secret-key-99!',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Helper: Log Activity
function logActivity(username, action) {
    db.run(`INSERT INTO activity_logs (username, action) VALUES (?, ?)`, [username || 'System', action]);
}

// Helper: Generate Secure Random String
function generateRandomString(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ==================== HTML TEMPLATE GENERATOR ====================
function renderLayout(title, bodyContent) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-slate-50 text-slate-800 font-sans min-h-screen flex flex-col">
    <header class="bg-indigo-700 text-white shadow-md">
        <div class="container mx-auto px-4 py-3 flex justify-between items-center">
            <div class="flex items-center space-x-3">
                <i class="fa-solid fa-qrcode text-2xl"></i>
                <span class="font-bold text-lg tracking-wide">ClubAttend Pro</span>
            </div>
            <nav class="hidden md:flex space-x-6 text-sm font-medium">
                <a href="/" class="hover:text-indigo-200">Home</a>
                <a href="/admin" class="hover:text-indigo-200">Admin Portal</a>
                <a href="/scanner" class="hover:text-indigo-200">QR Scanner</a>
                <a href="/member" class="hover:text-indigo-200">Member Portal</a>
            </nav>
        </div>
    </header>
    <main class="flex-grow container mx-auto px-4 py-6">
        ${bodyContent}
    </main>
    <footer class="bg-slate-800 text-slate-400 py-4 text-center text-xs">
        &copy; 2026 School Club Attendance Management System. All rights reserved.
    </footer>
</body>
</html>`;
}

// ==================== LANDING PAGE ====================
app.get('/', (req, res) => {
    const html = `
    <div class="max-w-4xl mx-auto text-center py-12">
        <div class="bg-indigo-600 text-white p-8 rounded-2xl shadow-xl mb-10">
            <h1 class="text-4xl font-extrabold mb-3">School Club QR Attendance System</h1>
            <p class="text-indigo-100 text-lg">Fast, reliable, and automated attendance management for school organizations.</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div class="bg-white p-6 rounded-xl shadow border border-slate-200 hover:shadow-lg transition flex flex-col items-center">
                <div class="bg-indigo-100 text-indigo-600 p-4 rounded-full text-2xl mb-4"><i class="fa-solid fa-user-shield"></i></div>
                <h3 class="font-bold text-xl mb-2">Admin Portal</h3>
                <p class="text-slate-500 text-sm mb-6 text-center">Manage members with custom positions, announcements, attendance logs, and settings.</p>
                <a href="/admin" class="mt-auto w-full bg-indigo-600 text-white py-2 rounded-lg font-medium hover:bg-indigo-700 transition text-center">Access Admin</a>
            </div>
            <div class="bg-white p-6 rounded-xl shadow border border-slate-200 hover:shadow-lg transition flex flex-col items-center">
                <div class="bg-emerald-100 text-emerald-600 p-4 rounded-full text-2xl mb-4"><i class="fa-solid fa-camera"></i></div>
                <h3 class="font-bold text-xl mb-2">QR Scanner</h3>
                <p class="text-slate-500 text-sm mb-6 text-center">Dedicated mobile scanner portal for Time In and Time Out processing.</p>
                <a href="/scanner" class="mt-auto w-full bg-emerald-600 text-white py-2 rounded-lg font-medium hover:bg-emerald-700 transition text-center">Open Scanner</a>
            </div>
            <div class="bg-white p-6 rounded-xl shadow border border-slate-200 hover:shadow-lg transition flex flex-col items-center">
                <div class="bg-blue-100 text-blue-600 p-4 rounded-full text-2xl mb-4"><i class="fa-solid fa-id-card"></i></div>
                <h3 class="font-bold text-xl mb-2">Member Portal</h3>
                <p class="text-slate-500 text-sm mb-6 text-center">Check personal attendance history, announcements, download ID QR code, and update profile.</p>
                <a href="/member" class="mt-auto w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 transition text-center">Member Login</a>
            </div>
        </div>
    </div>`;
    res.send(renderLayout('ClubAttend Pro - Home', html));
});

// ==================== ADMIN PORTAL ====================
app.get('/admin/login', (req, res) => {
    const error = req.query.error ? `<div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4 text-sm">${req.query.error}</div>` : '';
    const html = `
    <div class="max-w-md mx-auto bg-white p-8 rounded-xl shadow border border-slate-200 mt-10">
        <h2 class="text-2xl font-bold mb-6 text-center text-slate-800">Admin Portal Login</h2>
        ${error}
        <form action="/admin/login" method="POST" class="space-y-4">
            <div>
                <label class="block text-sm font-medium mb-1">Username</label>
                <input type="text" name="username" required class="w-full border rounded-lg px-3 py-2 focus:ring focus:ring-indigo-300">
            </div>
            <div>
                <label class="block text-sm font-medium mb-1">Password</label>
                <input type="password" name="password" required class="w-full border rounded-lg px-3 py-2 focus:ring focus:ring-indigo-300">
            </div>
            <button type="submit" class="w-full bg-indigo-600 text-white py-2 rounded-lg font-medium hover:bg-indigo-700 transition">Login</button>
        </form>
        <p class="text-xs text-slate-400 mt-4 text-center">Default Credentials: <b>admin</b> / <b>adminpassword</b></p>
    </div>`;
    res.send(renderLayout('Admin Login', html));
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND (position = 'Adviser' OR username = 'admin')`, [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.adminId = user.id;
            req.session.adminUser = user.username;
            logActivity(user.username, 'Admin logged in');
            res.redirect('/admin');
        } else {
            res.redirect('/admin/login?error=Invalid username or password');
        }
    });
});

app.get('/admin/logout', (req, res) => {
    if (req.session.adminUser) logActivity(req.session.adminUser, 'Admin logged out');
    req.session.adminId = null;
    req.session.adminUser = null;
    res.redirect('/admin/login');
});

function requireAdmin(req, res, next) {
    if (!req.session.adminId) return res.redirect('/admin/login');
    next();
}

app.get('/admin', requireAdmin, (req, res) => {
    db.get(`SELECT COUNT(DISTINCT member_id) as total FROM users WHERE position != 'Adviser'`, (err, mCount) => {
        db.get(`SELECT COUNT(DISTINCT member_id) as present FROM attendance WHERE date = date('localtime') AND scan_type = 'TIME IN'`, (err, pCount) => {
            db.all(`SELECT * FROM announcements ORDER BY id DESC LIMIT 5`, (err, announcements) => {
                db.all(`SELECT a.*, u.name, u.position FROM attendance a JOIN users u ON a.member_id = u.member_id ORDER BY a.id DESC LIMIT 15`, (err, liveAtt) => {
                    
                    const totalMembers = mCount ? mCount.total : 0;
                    const presentToday = pCount ? pCount.present : 0;
                    const absentToday = Math.max(0, totalMembers - presentToday);

                    const html = `
                    <div class="flex flex-col md:flex-row gap-6">
                        <!-- Sidebar Navigation -->
                        <div class="w-full md:w-64 bg-white p-4 rounded-xl shadow border border-slate-200 h-fit space-y-2">
                            <div class="font-bold text-slate-700 px-3 py-2 border-b">Admin Dashboard</div>
                            <a href="/admin" class="block px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 font-medium"><i class="fa-solid fa-chart-pie mr-2"></i> Overview</a>
                            <a href="/admin/members" class="block px-3 py-2 rounded-lg hover:bg-slate-100 text-slate-600"><i class="fa-solid fa-users mr-2"></i> Members</a>
                            <a href="/admin/announcements" class="block px-3 py-2 rounded-lg hover:bg-slate-100 text-slate-600"><i class="fa-solid fa-bullhorn mr-2"></i> Announcements</a>
                            <a href="/admin/attendance" class="block px-3 py-2 rounded-lg hover:bg-slate-100 text-slate-600"><i class="fa-solid fa-clipboard-user mr-2"></i> Attendance</a>
                            <a href="/admin/reports" class="block px-3 py-2 rounded-lg hover:bg-slate-100 text-slate-600"><i class="fa-solid fa-file-excel mr-2"></i> Reports</a>
                            <a href="/admin/settings" class="block px-3 py-2 rounded-lg hover:bg-slate-100 text-slate-600"><i class="fa-solid fa-gear mr-2"></i> Club Settings</a>
                            <a href="/admin/logout" class="block px-3 py-2 rounded-lg hover:bg-red-50 text-red-600 mt-4"><i class="fa-solid fa-right-from-bracket mr-2"></i> Logout</a>
                        </div>

                        <!-- Main Dashboard Content -->
                        <div class="flex-grow space-y-6">
                            <!-- Stats Cards -->
                            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                <div class="bg-white p-5 rounded-xl shadow border border-slate-200">
                                    <div class="text-slate-400 text-xs font-bold uppercase">Total Members</div>
                                    <div class="text-3xl font-extrabold text-slate-800 mt-1">${totalMembers}</div>
                                </div>
                                <div class="bg-white p-5 rounded-xl shadow border border-slate-200">
                                    <div class="text-emerald-500 text-xs font-bold uppercase">Present Today</div>
                                    <div class="text-3xl font-extrabold text-emerald-600 mt-1">${presentToday}</div>
                                </div>
                                <div class="bg-white p-5 rounded-xl shadow border border-slate-200">
                                    <div class="text-amber-500 text-xs font-bold uppercase">Absent Today</div>
                                    <div class="text-3xl font-extrabold text-amber-600 mt-1">${absentToday}</div>
                                </div>
                                <div class="bg-white p-5 rounded-xl shadow border border-slate-200">
                                    <div class="text-indigo-500 text-xs font-bold uppercase">Attendance Rate</div>
                                    <div class="text-3xl font-extrabold text-indigo-600 mt-1">${totalMembers > 0 ? Math.round((presentToday/totalMembers)*100) : 0}%</div>
                                </div>
                            </div>

                            <!-- Quick Actions & Live Feed -->
                            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <div class="bg-white p-6 rounded-xl shadow border border-slate-200">
                                    <h3 class="font-bold text-lg mb-4 text-slate-800"><i class="fa-solid fa-bolt text-amber-500 mr-2"></i> Quick Actions</h3>
                                    <div class="grid grid-cols-2 gap-3">
                                        <a href="/admin/members" class="p-3 bg-indigo-50 text-indigo-700 rounded-lg text-center font-medium hover:bg-indigo-100 transition"><i class="fa-solid fa-user-plus block text-xl mb-1"></i> Add Member</a>
                                        <a href="/admin/announcements" class="p-3 bg-blue-50 text-blue-700 rounded-lg text-center font-medium hover:bg-blue-100 transition"><i class="fa-solid fa-bullhorn block text-xl mb-1"></i> Post Announcement</a>
                                        <a href="/admin/reports" class="p-3 bg-emerald-50 text-emerald-700 rounded-lg text-center font-medium hover:bg-emerald-100 transition"><i class="fa-solid fa-download block text-xl mb-1"></i> Export Data</a>
                                        <a href="/scanner" target="_blank" class="p-3 bg-purple-50 text-purple-700 rounded-lg text-center font-medium hover:bg-purple-100 transition"><i class="fa-solid fa-qrcode block text-xl mb-1"></i> Open Scanner</a>
                                    </div>
                                </div>

                                <div class="bg-white p-6 rounded-xl shadow border border-slate-200">
                                    <h3 class="font-bold text-lg mb-4 text-slate-800"><i class="fa-solid fa-tower-broadcast text-emerald-500 mr-2"></i> Live Attendance Feed</h3>
                                    <div class="space-y-3 max-h-56 overflow-y-auto pr-2">
                                        ${liveAtt.length === 0 ? '<p class="text-slate-400 text-sm">No scans recorded yet today.</p>' : liveAtt.map(att => `
                                            <div class="flex justify-between items-center bg-slate-50 p-2.5 rounded-lg border border-slate-100 text-sm">
                                                <div>
                                                    <span class="font-bold text-slate-800">${att.name}</span>
                                                    <span class="text-xs text-slate-400 ml-2">(${att.position})</span>
                                                </div>
                                                <div class="text-right">
                                                    <span class="px-2 py-0.5 rounded text-xs font-bold ${att.scan_type === 'TIME IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}">${att.scan_type}</span>
                                                    <div class="text-xs text-slate-400 mt-0.5">${att.time}</div>
                                                </div>
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>`;
                    res.send(renderLayout('Admin Dashboard', html));
                });
            });
        });
    });
});

// ==================== MEMBER MANAGEMENT (WITH DELETE & CUSTOM POSITION) ====================
app.get('/admin/members', requireAdmin, (req, res) => {
    db.all(`SELECT * FROM users WHERE position != 'Adviser' ORDER BY id DESC`, [], (err, members) => {
        // Kunin din ang mga natatanging posisyon na ginamit na para sa position selector/filter kung kailangan
        db.all(`SELECT DISTINCT position FROM users`, [], (err, positions) => {
            const html = `
            <div class="space-y-6">
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <h2 class="text-2xl font-bold text-slate-800">Member Management</h2>
                    <button onclick="openAddModal()" class="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 transition"><i class="fa-solid fa-user-plus mr-2"></i> Add Member</button>
                </div>

                <div class="bg-white rounded-xl shadow border border-slate-200 overflow-hidden">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-slate-100 text-slate-600 text-xs uppercase tracking-wider border-b">
                                <th class="p-4">Member ID</th>
                                <th class="p-4">Name</th>
                                <th class="p-4">Position</th>
                                <th class="p-4">Username / Temp Pass</th>
                                <th class="p-4">Status</th>
                                <th class="p-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-100 text-sm">
                            ${members.length === 0 ? `<tr><td colspan="6" class="p-6 text-center text-slate-400">No members registered yet.</td></tr>` : members.map(m => `
                                <tr class="hover:bg-slate-50">
                                    <td class="p-4 font-mono font-bold text-indigo-600">${m.member_id}</td>
                                    <td class="p-4 font-medium text-slate-800">${m.name}</td>
                                    <td class="p-4 text-slate-600"><span class="bg-slate-100 px-2 py-1 rounded text-xs font-semibold">${m.position}</span></td>
                                    <td class="p-4 font-mono text-xs text-slate-500">${m.username} / ${m.temporary_password || 'Changed'}</td>
                                    <td class="p-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold ${m.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}">${m.status}</span></td>
                                    <td class="p-4 text-right space-x-2">
                                        <a href="/admin/member/id/${m.id}" target="_blank" class="text-indigo-600 hover:text-indigo-800" title="Print/View ID"><i class="fa-solid fa-id-card"></i></a>
                                        <a href="/admin/member/qr/${m.id}" target="_blank" class="text-purple-600 hover:text-purple-800" title="QR Code"><i class="fa-solid fa-qrcode"></i></a>
                                        <a href="/admin/member/toggle/${m.id}" class="text-amber-600 hover:text-amber-800" title="Toggle Status"><i class="fa-solid fa-power-off"></i></a>
                                        <a href="/admin/member/delete/${m.id}" onclick="return confirm('Are you sure you want to delete member ${m.name}? This action cannot be undone.')" class="text-red-600 hover:text-red-800" title="Delete Member"><i class="fa-solid fa-trash"></i></a>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Add Member Modal -->
            <div id="addModal" class="fixed inset-0 bg-black/50 hidden flex items-center justify-center p-4 z-50">
                <div class="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4">
                    <div class="flex justify-between items-center border-b pb-3">
                        <h3 class="font-bold text-lg text-slate-800">Add New Club Member</h3>
                        <button onclick="closeAddModal()" class="text-slate-400 hover:text-slate-600"><i class="fa-solid fa-xmark text-xl"></i></button>
                    </div>
                    <form action="/admin/member/add" method="POST" class="space-y-4">
                        <div>
                            <label class="block text-sm font-medium mb-1">Full Name</label>
                            <input type="text" name="name" required class="w-full border rounded-lg px-3 py-2">
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-1">Position</label>
                            <select name="position_select" id="positionSelect" onchange="checkCustomPosition(this)" class="w-full border rounded-lg px-3 py-2 mb-2">
                                <option value="Member">Member</option>
                                <option value="President">President</option>
                                <option value="Vice President">Vice President</option>
                                <option value="Secretary">Secretary</option>
                                <option value="Treasurer">Treasurer</option>
                                <option value="Auditor">Auditor</option>
                                <option value="Public Information Officer">Public Information Officer</option>
                                <option value="Sergeant-at-Arms">Sergeant-at-Arms</option>
                                <option value="CUSTOM">-- Type Custom Position --</option>
                            </select>
                            <input type="text" name="position_custom" id="customPositionInput" placeholder="Enter custom position..." class="w-full border rounded-lg px-3 py-2 hidden">
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-1">Email (Optional)</label>
                            <input type="email" name="email" class="w-full border rounded-lg px-3 py-2">
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-1">Contact Number (Optional)</label>
                            <input type="text" name="contact" class="w-full border rounded-lg px-3 py-2">
                        </div>
                        <p class="text-xs text-slate-400">Member ID, Username, Temporary Password, and QR Token will be automatically generated.</p>
                        <div class="flex justify-end space-x-3 pt-3 border-t">
                            <button type="button" onclick="closeAddModal()" class="px-4 py-2 border rounded-lg text-slate-600 hover:bg-slate-100">Cancel</button>
                            <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Create Member</button>
                        </div>
                    </form>
                </div>
            </div>

            <script>
                function openAddModal() { document.getElementById('addModal').classList.remove('hidden'); }
                function closeAddModal() { document.getElementById('addModal').classList.add('hidden'); }
                function checkCustomPosition(select) {
                    const customInput = document.getElementById('customPositionInput');
                    if (select.value === 'CUSTOM') {
                        customInput.classList.remove('hidden');
                        customInput.required = true;
                        customInput.name = 'position';
                        select.name = 'ignore_pos';
                    } else {
                        customInput.classList.add('hidden');
                        customInput.required = false;
                        customInput.name = 'position_custom';
                        select.name = 'position';
                    }
                }
            </script>`;
            res.send(renderLayout('Member Management', html));
        });
    });
});

app.post('/admin/member/add', requireAdmin, (req, res) => {
    let { name, position, email, contact } = req.body;
    if (!position) position = 'Member';

    db.get(`SELECT COUNT(*) as count FROM users`, async (err, row) => {
        const nextIdNum = (row ? row.count : 0) + 1001;
        const member_id = `CLUB-2026-${String(nextIdNum).padStart(4, '0')}`;
        const username = `member${String(nextIdNum).padStart(4, '0')}`;
        const temp_password = generateRandomString(8);
        const hashedPass = await bcrypt.hash(temp_password, 10);
        const qr_token = `CLUBATTEND:MEMBER:${generateRandomString(32)}`;

        db.run(`INSERT INTO users (member_id, name, position, email, contact, username, password, temporary_password, qr_token, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
            [member_id, name, position, email, contact, username, hashedPass, temp_password, qr_token], (err) => {
                if (err) console.error(err);
                logActivity(req.session.adminUser, `Created member ${name} (${member_id}) with position ${position}`);
                res.redirect('/admin/members');
            });
    });
});

app.get('/admin/member/toggle/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, user) => {
        if (user) {
            const newStatus = user.status === 'Active' ? 'Disabled' : 'Active';
            db.run(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, req.params.id], () => {
                logActivity(req.session.adminUser, `Toggled status of ${user.name} to ${newStatus}`);
                res.redirect('/admin/members');
            });
        } else {
            res.redirect('/admin/members');
        }
    });
});

// Delete Member Route
app.get('/admin/member/delete/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, user) => {
        if (user) {
            db.run(`DELETE FROM users WHERE id = ?`, [req.params.id], () => {
                logActivity(req.session.adminUser, `Deleted member ${user.name} (${user.member_id})`);
                res.redirect('/admin/members');
            });
        } else {
            res.redirect('/admin/members');
        }
    });
});

// Member ID Card Printable View
app.get('/admin/member/id/:id', requireAdmin, (req, res) => {
    db.get(`SELECT u.*, c.* FROM users u CROSS JOIN clubs c WHERE u.id = ?`, [req.params.id], async (err, data) => {
        if (!data) return res.send('Member not found');
        const qrDataUrl = await qrcode.toDataURL(data.qr_token);
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>ID Card - ${data.name}</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <style>
                @media print { body { -webkit-print-color-adjust: exact; } }
                .id-card { width: 340px; height: 210px; border-radius: 12px; border: 2px solid #cbd5e1; background: white; overflow: hidden; position: relative; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            </style>
        </head>
        <body class="bg-slate-100 flex flex-col items-center justify-center min-h-screen p-4">
            <div class="mb-6 flex gap-4 print:hidden">
                <button onclick="window.print()" class="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium shadow hover:bg-indigo-750"><i class="fa-solid fa-print mr-2"></i> Print ID Card</button>
                <a href="/admin/members" class="bg-slate-500 text-white px-4 py-2 rounded-lg font-medium shadow hover:bg-slate-600">Back</a>
            </div>
            
            <div class="id-card flex flex-col p-4 justify-between">
                <div class="flex justify-between items-center border-b pb-2">
                    <div>
                        <div class="text-[10px] font-bold text-indigo-600 uppercase">${data.school_name}</div>
                        <div class="text-xs font-extrabold text-slate-800">${data.club_name}</div>
                    </div>
                    <div class="text-right text-[9px] font-mono font-bold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">${data.member_id}</div>
                </div>
                <div class="flex items-center gap-3 my-auto">
                    <div class="w-16 h-20 bg-slate-200 rounded border flex items-center justify-center text-slate-400 text-xs font-bold">PHOTO</div>
                    <div class="flex-grow">
                        <div class="text-sm font-extrabold text-slate-800 leading-tight">${data.name}</div>
                        <div class="text-[11px] font-semibold text-indigo-600">${data.position}</div>
                        <div class="mt-2 text-[9px] text-slate-500 font-mono">
                            User: <b>${data.username}</b><br>
                            Temp Pass: <b>${data.temporary_password || 'Changed'}</b>
                        </div>
                    </div>
                    <div>
                        <img src="${qrDataUrl}" class="w-20 h-20 border rounded p-1 bg-white">
                    </div>
                </div>
                <div class="text-[8px] text-center text-slate-400 border-t pt-1">
                    Please change your temporary password after logging in.
                </div>
            </div>
        </body>
        </html>`;
        res.send(html);
    });
});

app.get('/admin/member/qr/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], async (err, user) => {
        if (!user) return res.send('Member not found');
        const qrDataUrl = await qrcode.toDataURL(user.qr_token, { width: 300 });
        const html = `
        <div class="max-w-sm mx-auto bg-white p-8 rounded-xl shadow text-center space-y-4 mt-10">
            <h2 class="font-bold text-xl text-slate-800">${user.name}</h2>
            <p class="text-sm text-indigo-600 font-semibold">${user.position} (${user.member_id})</p>
            <div class="flex justify-center"><img src="${qrDataUrl}" class="border p-2 rounded-lg shadow-inner"></div>
            <a href="${qrDataUrl}" download="${user.member_id}-QR.png" class="block w-full bg-indigo-600 text-white py-2 rounded-lg font-medium hover:bg-indigo-700">Download QR Code</a>
            <a href="/admin/members" class="block text-sm text-slate-500 hover:underline">Back to Members</a>
        </div>`;
        res.send(renderLayout('Member QR Code', html));
    });
});

// ==================== ANNOUNCEMENTS MANAGEMENT ====================
app.get('/admin/announcements', requireAdmin, (req, res) => {
    db.all(`SELECT * FROM announcements ORDER BY id DESC`, [], (err, announcements) => {
        const html = `
        <div class="space-y-6 max-w-4xl mx-auto">
            <h2 class="text-2xl font-bold text-slate-800">Announcements Management</h2>
            
            <div class="bg-white p-6 rounded-xl shadow border border-slate-200">
                <h3 class="font-bold text-lg mb-4 text-slate-800"><i class="fa-solid fa-bullhorn text-indigo-600 mr-2"></i> Post New Announcement</h3>
                <form action="/admin/announcement/add" method="POST" class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium mb-1">Title</label>
                        <input type="text" name="title" required class="w-full border rounded-lg px-3 py-2" placeholder="e.g. Emergency Meeting on Friday">
                    </div>
                    <div>
                        <label class="block text-sm font-medium mb-1">Message</label>
                        <textarea name="message" rows="3" required class="w-full border rounded-lg px-3 py-2" placeholder="Enter announcement details here..."></textarea>
                    </div>
                    <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 transition">Publish Announcement</button>
                </form>
            </div>

            <div class="bg-white p-6 rounded-xl shadow border border-slate-200 space-y-4">
                <h3 class="font-bold text-lg text-slate-800">Published Announcements</h3>
                <div class="space-y-3">
                    ${announcements.length === 0 ? '<p class="text-slate-400 text-sm">No announcements posted yet.</p>' : announcements.map(ann => `
                        <div class="flex justify-between items-start bg-slate-50 p-4 rounded-lg border border-slate-100">
                            <div>
                                <h4 class="font-bold text-indigo-900">${ann.title}</h4>
                                <p class="text-sm text-slate-600 mt-1">${ann.message}</p>
                                <span class="text-xs text-slate-400 mt-2 block"><i class="fa-regular fa-clock mr-1"></i> ${ann.created_at}</span>
                            </div>
                            <a href="/admin/announcement/delete/${ann.id}" onclick="return confirm('Delete this announcement?')" class="text-red-500 hover:text-red-700 text-sm p-1"><i class="fa-solid fa-trash"></i></a>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>`;
        res.send(renderLayout('Announcements', html));
    });
});

app.post('/admin/announcement/add', requireAdmin, (req, res) => {
    const { title, message } = req.body;
    db.run(`INSERT INTO announcements (title, message) VALUES (?, ?)`, [title, message], () => {
        logActivity(req.session.adminUser, `Posted announcement: ${title}`);
        res.redirect('/admin/announcements');
    });
});

app.get('/admin/announcement/delete/:id', requireAdmin, (req, res) => {
    db.run(`DELETE FROM announcements WHERE id = ?`, [req.params.id], () => {
        logActivity(req.session.adminUser, `Deleted announcement ID ${req.params.id}`);
        res.redirect('/admin/announcements');
    });
});

// ==================== ATTENDANCE & REPORTS ====================
app.get('/admin/attendance', requireAdmin, (req, res) => {
    const dateFilter = req.query.date || '';
    const searchFilter = req.query.search || '';
    
    let query = `SELECT a.*, u.name, u.position FROM attendance a JOIN users u ON a.member_id = u.member_id WHERE 1=1`;
    let params = [];
    if (dateFilter) {
        query += ` AND a.date = ?`;
        params.push(dateFilter);
    }
    if (searchFilter) {
        query += ` AND (u.name LIKE ? OR u.member_id LIKE ?)`;
        params.push(`%${searchFilter}%`, `%${searchFilter}%`);
    }
    query += ` ORDER BY a.id DESC LIMIT 100`;

    db.all(query, params, (err, rows) => {
        const html = `
        <div class="space-y-6">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <h2 class="text-2xl font-bold text-slate-800">Attendance Records</h2>
                <form method="GET" class="flex gap-2 w-full sm:w-auto">
                    <input type="date" name="date" value="${dateFilter}" class="border rounded-lg px-3 py-1.5 text-sm">
                    <input type="text" name="search" placeholder="Search name/ID..." value="${searchFilter}" class="border rounded-lg px-3 py-1.5 text-sm">
                    <button type="submit" class="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700">Filter</button>
                </form>
            </div>

            <div class="bg-white rounded-xl shadow border border-slate-200 overflow-hidden">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-100 text-slate-600 text-xs uppercase tracking-wider border-b">
                            <th class="p-4">Date & Time</th>
                            <th class="p-4">Member ID</th>
                            <th class="p-4">Name</th>
                            <th class="p-4">Position</th>
                            <th class="p-4">Scan Type</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100 text-sm">
                        ${rows.length === 0 ? `<tr><td colspan="5" class="p-6 text-center text-slate-400">No attendance records found.</td></tr>` : rows.map(r => `
                            <tr class="hover:bg-slate-50">
                                <td class="p-4 text-slate-600">${r.date} ${r.time}</td>
                                <td class="p-4 font-mono font-bold text-indigo-600">${r.member_id}</td>
                                <td class="p-4 font-medium text-slate-800">${r.name}</td>
                                <td class="p-4 text-slate-600">${r.position}</td>
                                <td class="p-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold ${r.scan_type === 'TIME IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}">${r.scan_type}</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
        res.send(renderLayout('Attendance Logs', html));
    });
});

app.get('/admin/reports', requireAdmin, (req, res) => {
    db.all(`SELECT a.*, u.name, u.position FROM attendance a JOIN users u ON a.member_id = u.member_id ORDER BY a.id DESC`, [], (err, rows) => {
        const csvRows = ['ID,Member ID,Name,Position,Scan Type,Date,Time'];
        rows.forEach(r => {
            csvRows.push(`${r.id},${r.member_id},"${r.name}",${r.position},${r.scan_type},${r.date},${r.time}`);
        });
        const csvContent = csvRows.join('\n');

        const html = `
        <div class="space-y-6">
            <h2 class="text-2xl font-bold text-slate-800">Attendance Reports & Exports</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="bg-white p-6 rounded-xl shadow border border-slate-200 space-y-4">
                    <h3 class="font-bold text-lg text-slate-800"><i class="fa-solid fa-file-csv text-emerald-600 mr-2"></i> CSV Export</h3>
                    <p class="text-slate-500 text-sm">Download complete system attendance records in CSV format compatible with Excel or Google Sheets.</p>
                    <button onclick="downloadCSV()" class="bg-emerald-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-emerald-700 transition"><i class="fa-solid fa-download mr-2"></i> Download CSV Report</button>
                </div>
                <div class="bg-white p-6 rounded-xl shadow border border-slate-200 space-y-4">
                    <h3 class="font-bold text-lg text-slate-800"><i class="fa-solid fa-print text-indigo-600 mr-2"></i> Print Report</h3>
                    <p class="text-slate-500 text-sm">Generate a clean printable table of all attendance entries.</p>
                    <button onclick="window.print()" class="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 transition"><i class="fa-solid fa-print mr-2"></i> Print Full Report</button>
                </div>
            </div>
        </div>
        <script>
            function downloadCSV() {
                const csv = \`${csvContent}\`;
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'attendance_report_2026.csv';
                a.click();
            }
        </script>`;
        res.send(renderLayout('Reports', html));
    });
});

app.get('/admin/backup', requireAdmin, (req, res) => {
    res.download(dbFile, 'attendance_backup.sqlite');
});

app.get('/admin/settings', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, [], (err, club) => {
        const success = req.query.success ? `<div class="bg-emerald-100 text-emerald-700 p-3 rounded-lg text-sm mb-4">Settings updated successfully!</div>` : '';
        const html = `
        <div class="max-w-xl mx-auto bg-white p-8 rounded-xl shadow border border-slate-200 space-y-6">
            <h2 class="text-2xl font-bold text-slate-800">Club Configuration</h2>
            ${success}
            <form action="/admin/settings" method="POST" class="space-y-4">
                <div>
                    <label class="block text-sm font-medium mb-1">Club Name</label>
                    <input type="text" name="club_name" value="${club ? club.club_name : ''}" required class="w-full border rounded-lg px-3 py-2">
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1">School Name</label>
                    <input type="text" name="school_name" value="${club ? club.school_name : ''}" required class="w-full border rounded-lg px-3 py-2">
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1">School Year</label>
                    <input type="text" name="school_year" value="${club ? club.school_year : ''}" required class="w-full border rounded-lg px-3 py-2">
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1">Faculty Adviser</label>
                    <input type="text" name="adviser" value="${club ? club.adviser : ''}" required class="w-full border rounded-lg px-3 py-2">
                </div>
                <button type="submit" class="w-full bg-indigo-600 text-white py-2 rounded-lg font-medium hover:bg-indigo-700 transition">Save Settings</button>
            </form>
        </div>`;
        res.send(renderLayout('Club Settings', html));
    });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
    const { club_name, school_name, school_year, adviser } = req.body;
    db.run(`UPDATE clubs SET club_name = ?, school_name = ?, school_year = ?, adviser = ? WHERE id = 1`, [club_name, school_name, school_year, adviser], () => {
        logActivity(req.session.adminUser, 'Updated club settings');
        res.redirect('/admin/settings?success=1');
    });
});


// ==================== QR SCANNER PORTAL ====================
app.get('/scanner', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QR Scanner Portal</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <script src="https://unpkg.com/html5-qrcode"></script>
    </head>
    <body class="bg-slate-900 text-white min-h-screen flex flex-col justify-between p-4">
        <header class="flex justify-between items-center py-2 border-b border-slate-800">
            <div class="font-bold text-lg flex items-center space-x-2">
                <i class="fa-solid fa-camera text-emerald-400"></i>
                <span>Scanner Terminal</span>
            </div>
            <div class="flex items-center space-x-3 text-sm">
                <span id="soundStatus" class="text-xs bg-emerald-900 text-emerald-300 px-2 py-1 rounded cursor-pointer" onclick="toggleSound()">Sound: ON</span>
                <a href="/" class="text-slate-400 hover:text-white"><i class="fa-solid fa-house"></i></a>
            </div>
        </header>

        <div class="max-w-md mx-auto w-full my-auto space-y-4 text-center">
            <!-- Scan Mode Selector -->
            <div class="grid grid-cols-2 gap-2 bg-slate-800 p-1.5 rounded-xl border border-slate-700">
                <button id="modeIn" onclick="setMode('TIME IN')" class="py-3 rounded-lg font-bold text-sm bg-emerald-600 text-white transition shadow">TIME IN</button>
                <button id="modeOut" onclick="setMode('TIME OUT')" class="py-3 rounded-lg font-bold text-sm bg-slate-700 text-slate-300 transition">TIME OUT</button>
            </div>

            <!-- Camera Box -->
            <div class="bg-black rounded-xl overflow-hidden border border-slate-700 relative aspect-square flex items-center justify-center">
                <div id="reader" class="w-full h-full"></div>
            </div>

            <!-- Scan Result Alert Box -->
            <div id="resultBox" class="hidden p-4 rounded-xl border transition-all text-left">
                <div id="resultHeader" class="font-bold text-base flex items-center"></div>
                <div id="resultBody" class="text-sm mt-1 text-slate-300"></div>
            </div>
        </div>

        <footer class="text-center text-xs text-slate-500 py-2">
            Point camera at member QR code.
        </footer>

        <script>
            let currentMode = 'TIME IN';
            let soundEnabled = true;
            let lastScannedToken = '';
            let lastScanTime = 0;

            function setMode(mode) {
                currentMode = mode;
                if(mode === 'TIME IN') {
                    document.getElementById('modeIn').className = 'py-3 rounded-lg font-bold text-sm bg-emerald-600 text-white transition shadow';
                    document.getElementById('modeOut').className = 'py-3 rounded-lg font-bold text-sm bg-slate-700 text-slate-300 transition';
                } else {
                    document.getElementById('modeOut').className = 'py-3 rounded-lg font-bold text-sm bg-blue-600 text-white transition shadow';
                    document.getElementById('modeIn').className = 'py-3 rounded-lg font-bold text-sm bg-slate-700 text-slate-300 transition';
                }
            }

            function toggleSound() {
                soundEnabled = !soundEnabled;
                document.getElementById('soundStatus').innerText = soundEnabled ? 'Sound: ON' : 'Sound: OFF';
                document.getElementById('soundStatus').className = soundEnabled ? 'text-xs bg-emerald-900 text-emerald-300 px-2 py-1 rounded cursor-pointer' : 'text-xs bg-red-900 text-red-300 px-2 py-1 rounded cursor-pointer';
            }

            function playSound(type) {
                if (!soundEnabled) return;
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                if (type === 'success') {
                    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
                    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
                    gain.gain.setValueAtTime(0.1, ctx.currentTime);
                    osc.start();
                    osc.stop(ctx.currentTime + 0.3);
                } else if (type === 'warning') {
                    osc.frequency.setValueAtTime(440, ctx.currentTime);
                    osc.frequency.setValueAtTime(330, ctx.currentTime + 0.15);
                    gain.gain.setValueAtTime(0.1, ctx.currentTime);
                    osc.start();
                    osc.stop(ctx.currentTime + 0.3);
                } else {
                    osc.frequency.setValueAtTime(200, ctx.currentTime);
                    osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
                    gain.gain.setValueAtTime(0.15, ctx.currentTime);
                    osc.start();
                    osc.stop(ctx.currentTime + 0.3);
                }
            }

            function showResult(title, body, statusType) {
                const box = document.getElementById('resultBox');
                const header = document.getElementById('resultHeader');
                const bodyEl = document.getElementById('resultBody');
                box.classList.remove('hidden');
                
                if (statusType === 'success') {
                    box.className = 'p-4 rounded-xl border bg-emerald-950 border-emerald-600 text-emerald-100';
                    header.innerHTML = \`<i class="fa-solid fa-circle-check text-emerald-400 mr-2 text-lg"></i> \${title}\`;
                    playSound('success');
                } else if (statusType === 'warning') {
                    box.className = 'p-4 rounded-xl border bg-amber-950 border-amber-600 text-amber-100';
                    header.innerHTML = \`<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-2 text-lg"></i> \${title}\`;
                    playSound('warning');
                } else {
                    box.className = 'p-4 rounded-xl border bg-red-950 border-red-600 text-red-100';
                    header.innerHTML = \`<i class="fa-solid fa-circle-xmark text-red-400 mr-2 text-lg"></i> \${title}\`;
                    playSound('error');
                }
                bodyEl.innerHTML = body;
            }

            function onScanSuccess(decodedText) {
                const now = Date.now();
                if (decodedText === lastScannedToken && now - lastScanTime < 4000) {
                    return;
                }
                lastScannedToken = decodedText;
                lastScanTime = now;

                fetch('/api/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: decodedText, scan_type: currentMode, scanner_device: 'Mobile Scanner' })
                })
                .then(res => res.json())
                .then(data => {
                    if (data.status === 'success') {
                        showResult('ATTENDANCE RECORDED', \`<b>\${data.name}</b> (\${data.position})<br>Member ID: \${data.member_id}<br><span class="text-xs uppercase text-emerald-400 font-bold">\${currentMode} - \${data.time}</span>\`, 'success');
                    } else if (data.status === 'duplicate') {
                        showResult('ALREADY RECORDED', \`<b>\${data.name}</b> has already recorded \${currentMode} today at \${data.time}.\`, 'warning');
                    } else {
                        showResult('INVALID QR CODE', data.message || 'This QR code is not registered in the system.', 'error');
                    }
                })
                .catch(err => {
                    showResult('CONNECTION ERROR', 'Unable to reach the server. Check network connection.', 'error');
                });
            }

            const html5QrCode = new Html5Qrcode("reader");
            html5QrCode.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 250, height: 250 } },
                onScanSuccess
            ).catch(err => {
                showResult('CAMERA ERROR', 'Camera permission denied or not supported on this browser/HTTP connection.', 'error');
            });
        </script>
    </body>
    </html>`;
    res.send(html);
});

app.post('/api/scan', (req, res) => {
    const { token, scan_type, scanner_device } = req.body;
    if (!token) return res.json({ status: 'error', message: 'No QR token provided.' });

    db.get(`SELECT * FROM users WHERE qr_token = ?`, [token], (err, user) => {
        if (!user) return res.json({ status: 'error', message: 'QR code not recognized in system database.' });
        if (user.status !== 'Active') return res.json({ status: 'error', message: 'This member account is disabled.' });

        const today = new Date().toLocaleDateString('en-CA');
        const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        db.get(`SELECT * FROM attendance WHERE member_id = ? AND date = ? AND scan_type = ?`, [user.member_id, today, scan_type], (err, existing) => {
            if (existing) {
                return res.json({ status: 'duplicate', name: user.name, position: user.position, member_id: user.member_id, time: existing.time });
            }

            db.run(`INSERT INTO attendance (member_id, scan_type, date, time, scanner_device) VALUES (?, ?, ?, ?, ?)`,
                [user.member_id, scan_type, today, timeNow, scanner_device || 'Scanner'], (err) => {
                    if (err) return res.json({ status: 'error', message: 'Database error recording attendance.' });
                    res.json({ status: 'success', name: user.name, position: user.position, member_id: user.member_id, time: timeNow });
                });
        });
    });
});


// ==================== MEMBER PORTAL ====================
app.get('/member/login', (req, res) => {
    const error = req.query.error ? `<div class="bg-red-100 text-red-700 p-3 rounded-lg text-sm mb-4">${req.query.error}</div>` : '';
    const html = `
    <div class="max-w-md mx-auto bg-white p-8 rounded-xl shadow border border-slate-200 mt-10">
        <h2 class="text-2xl font-bold mb-6 text-center text-slate-800">Member Portal Login</h2>
        ${error}
        <form action="/member/login" method="POST" class="space-y-4">
            <div>
                <label class="block text-sm font-medium mb-1">Username</label>
                <input type="text" name="username" required class="w-full border rounded-lg px-3 py-2">
            </div>
            <div>
                <label class="block text-sm font-medium mb-1">Password (or Temporary Password)</label>
                <input type="password" name="password" required class="w-full border rounded-lg px-3 py-2">
            </div>
            <button type="submit" class="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 transition">Login</button>
        </form>
    </div>`;
    res.send(renderLayout('Member Login', html));
});

app.post('/member/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND position != 'Adviser'`, [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.memberId = user.id;
            if (user.temporary_password) {
                res.redirect('/member/change-password');
            } else {
                res.redirect('/member');
            }
        } else {
            res.redirect('/member/login?error=Invalid username or password');
        }
    });
});

app.get('/member/logout', (req, res) => {
    req.session.memberId = null;
    res.redirect('/member/login');
});

function requireMember(req, res, next) {
    if (!req.session.memberId) return res.redirect('/member/login');
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.memberId], (err, user) => {
        if (!user || user.status !== 'Active') return res.redirect('/member/login?error=Account disabled or not found');
        if (user.temporary_password && req.path !== '/change-password') {
            return res.redirect('/member/change-password');
        }
        next();
    });
}

app.get('/member/change-password', (req, res) => {
    if (!req.session.memberId) return res.redirect('/member/login');
    const error = req.query.error ? `<div class="bg-red-100 text-red-700 p-3 rounded-lg text-sm mb-4">${req.query.error}</div>` : '';
    const html = `
    <div class="max-w-md mx-auto bg-white p-8 rounded-xl shadow border border-slate-200 mt-10 space-y-4">
        <div class="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-lg text-xs font-semibold">
            IMPORTANT: This password is temporary. Please change your password after your first login.
        </div>
        <h2 class="text-xl font-bold text-slate-800">Change Password Required</h2>
        ${error}
        <form action="/member/change-password" method="POST" class="space-y-4">
            <div>
                <label class="block text-sm font-medium mb-1">New Password</label>
                <input type="password" name="new_password" required minlength="6" class="w-full border rounded-lg px-3 py-2">
            </div>
            <button type="submit" class="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700">Update Password</button>
        </form>
    </div>`;
    res.send(renderLayout('Change Password', html));
});

app.post('/member/change-password', (req, res) => {
    if (!req.session.memberId) return res.redirect('/member/login');
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.redirect('/member/change-password?error=Password must be at least 6 characters');

    bcrypt.hash(new_password, 10, (err, hashed) => {
        db.run(`UPDATE users SET password = ?, temporary_password = NULL WHERE id = ?`, [hashed, req.session.memberId], () => {
            res.redirect('/member');
        });
    });
});

app.get('/member', requireMember, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.memberId], async (err, user) => {
        db.all(`SELECT * FROM attendance WHERE member_id = ? ORDER BY id DESC LIMIT 10`, [user.member_id], async (err, attendance) => {
            db.all(`SELECT * FROM announcements ORDER BY id DESC LIMIT 3`, [], async (err, announcements) => {
                const qrDataUrl = await qrcode.toDataURL(user.qr_token, { width: 220 });
                const html = `
                <div class="max-w-4xl mx-auto space-y-6">
                    <div class="bg-white p-6 rounded-xl shadow border border-slate-200 flex flex-col md:flex-row justify-between items-center gap-6">
                        <div>
                            <span class="bg-indigo-100 text-indigo-700 text-xs font-bold px-2.5 py-1 rounded-full">${user.position}</span>
                            <h2 class="text-2xl font-extrabold text-slate-800 mt-2">Welcome, ${user.name}</h2>
                            <p class="text-sm font-mono text-slate-500">Member ID: ${user.member_id}</p>
                            <div class="mt-4 flex gap-3">
                                <a href="/member/logout" class="text-xs bg-red-50 text-red-600 px-3 py-1.5 rounded-lg font-medium hover:bg-red-100"><i class="fa-solid fa-right-from-bracket mr-1"></i> Logout</a>
                            </div>
                        </div>
                        <div class="bg-slate-50 p-4 rounded-xl border text-center">
                            <img src="${qrDataUrl}" class="mx-auto border p-1 rounded bg-white mb-2">
                            <a href="${qrDataUrl}" download="my_qr_code.png" class="text-xs font-medium text-indigo-600 hover:underline">Download QR</a>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div class="bg-white p-6 rounded-xl shadow border border-slate-200 space-y-4">
                            <h3 class="font-bold text-lg text-slate-800">Recent Attendance History</h3>
                            <div class="space-y-2">
                                ${attendance.length === 0 ? '<p class="text-slate-400 text-sm">No attendance records found.</p>' : attendance.map(a => `
                                    <div class="flex justify-between items-center bg-slate-50 p-2.5 rounded-lg text-sm border">
                                        <div>
                                            <span class="font-bold text-slate-700">${a.date}</span>
                                            <span class="text-xs text-slate-400 ml-2">${a.time}</span>
                                        </div>
                                        <span class="px-2 py-0.5 rounded text-xs font-bold ${a.scan_type === 'TIME IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}">${a.scan_type}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>

                        <div class="bg-white p-6 rounded-xl shadow border border-slate-200 space-y-4">
                            <h3 class="font-bold text-lg text-slate-800">Club Announcements</h3>
                            <div class="space-y-3">
                                ${announcements.length === 0 ? '<p class="text-slate-400 text-sm">No announcements posted.</p>' : announcements.map(ann => `
                                    <div class="p-3 bg-indigo-50/50 rounded-lg border border-indigo-100 space-y-1">
                                        <div class="font-bold text-sm text-indigo-900">${ann.title}</div>
                                        <p class="text-xs text-slate-600">${ann.message}</p>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                </div>`;
                res.send(renderLayout('Member Portal', html));
            });
        });
    });
});


// ==================== START SERVER ====================
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n======================================================');
    console.log('       SCHOOL CLUB QR CODE ATTENDANCE SYSTEM          ');
    console.log('======================================================');
    console.log(`\nServer is running successfully!\n`);
    
    console.log(`Local Access:`);
    console.log(`  > Main Home:   http://localhost:${PORT}`);
    console.log(`  > Admin:       http://localhost:${PORT}/admin`);
    console.log(`  > Scanner:     http://localhost:${PORT}/scanner`);
    console.log(`  > Member:      http://localhost:${PORT}/member`);

    const interfaces = os.networkInterfaces();
    console.log(`\nNetwork Access (for phone scanner/other devices on Wi-Fi):`);
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`  > Network URL: http://${net.address}:${PORT}`);
                console.log(`  > Scanner:     http://${net.address}:${PORT}/scanner`);
                console.log(`  > Admin:       http://${net.address}:${PORT}/admin`);
            }
        }
    }
    console.log('\n======================================================\n');
});
