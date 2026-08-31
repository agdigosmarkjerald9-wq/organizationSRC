const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'qr-attendance-super-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Setup SQLite Database
const dbFile = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        // Admins table
        db.run(`CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            email TEXT
        )`);

        // Members table
        db.run(`CREATE TABLE IF NOT EXISTS members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT UNIQUE,
            first_name TEXT,
            middle_name TEXT,
            last_name TEXT,
            course_section TEXT,
            year_level TEXT,
            gender TEXT,
            contact_number TEXT,
            email TEXT,
            address TEXT,
            emergency_contact TEXT,
            photo TEXT,
            qr_token TEXT UNIQUE,
            date_registered TEXT,
            status TEXT DEFAULT 'Active'
        )`);

        // Events table
        db.run(`CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            description TEXT,
            event_date TEXT,
            start_time TEXT,
            end_time TEXT,
            location TEXT,
            event_type TEXT,
            status TEXT DEFAULT 'Inactive'
        )`);

        // Attendance table
        db.run(`CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER,
            member_id INTEGER,
            time_in TEXT,
            time_out TEXT,
            status TEXT,
            remarks TEXT,
            date TEXT,
            FOREIGN KEY(event_id) REFERENCES events(id),
            FOREIGN KEY(member_id) REFERENCES members(id)
        )`);

        // Settings table
        db.run(`CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE,
            value TEXT
        )`);

        // Audit logs table
        db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT,
            admin_username TEXT,
            details TEXT,
            date TEXT,
            time TEXT
        )`);

        // Seed Default Data
        seedDefaultData();
    });
}

function seedDefaultData() {
    // Default Admin
    db.get("SELECT * FROM admins WHERE username = ?", ['admin'], async (err, row) => {
        if (!row) {
            const hashedPwd = await bcrypt.hash('admin123', 10);
            db.run("INSERT INTO admins (username, password, email) VALUES (?, ?, ?)", ['admin', hashedPwd, 'admin@school.edu']);
            console.log('Default admin created: admin / admin123');
        }
    });

    // Default Settings
    const defaultSettings = [
        ['org_name', 'St. Jude Academic Institution'],
        ['org_address', '123 Education St, Metro Manila'],
        ['org_contact', '+63 912 345 6789'],
        ['late_threshold_mins', '15'],
        ['scanner_sound', 'true']
    ];
    defaultSettings.forEach(([key, value]) => {
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
    });

    // Default Event if none exists
    db.get("SELECT COUNT(*) as count FROM events", (err, row) => {
        if (row && row.count === 0) {
            const today = new Date().toISOString().split('T')[0];
            db.run(`INSERT INTO events (name, description, event_date, start_time, end_time, location, event_type, status) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                    ['General Attendance', 'Opening Assembly & Daily Roll Call', today, '07:00', '17:00', 'Main Gymnasium', 'General Attendance', 'Active']);
            console.log('Default Active Event created.');
        }
    });

    // Default Members if none exists
    db.get("SELECT COUNT(*) as count FROM members", (err, row) => {
        if (row && row.count === 0) {
            const sampleMembers = [
                ['2026-001', 'Juan', 'Santos', 'Dela Cruz', 'BSIT 3-A', '3rd Year', 'Male', '09123456789', 'juan@email.com', 'Manila', 'Maria Dela Cruz - 09187654321', 'ATT-TOKEN-2026-001', '2026-09-01'],
                ['2026-002', 'Maria', 'Reyes', 'Santos', 'BSCS 2-B', '2nd Year', 'Female', '09198765432', 'maria@email.com', 'Quezon City', 'Jose Santos - 09123334455', 'ATT-TOKEN-2026-002', '2026-09-01'],
                ['2026-003', 'Pedro', 'Cruz', 'Aquino', 'BSED 4-C', '4th Year', 'Male', '09171112233', 'pedro@email.com', 'Caloocan', 'Ana Aquino - 09189998877', 'ATT-TOKEN-2026-003', '2026-09-01']
            ];
            sampleMembers.forEach(m => {
                db.run(`INSERT INTO members (student_id, first_name, middle_name, last_name, course_section, year_level, gender, contact_number, email, address, emergency_contact, qr_token, date_registered, status) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`, m);
            });
            console.log('Sample members created.');
        }
    });
}

// Helper: Log audit
function logAudit(action, adminUser, details) {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    db.run("INSERT INTO audit_logs (action, admin_username, details, date, time) VALUES (?, ?, ?, ?, ?)",
        [action, adminUser || 'System', details, date, time]);
}

// Auth Middleware
function isAuthenticated(req, res, next) {
    if (req.session && req.session.adminId) {
        return next();
    }
    res.redirect('/login');
}

// Layout Wrapper Template with Modern Tailwind CSS & Sidebar
function renderLayout(title, activeNav, content, settings = {}) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - QR Attendance Management System</title>
    <!-- Tailwind CSS -->
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- FontAwesome Icons -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <!-- Chart.js -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; }
    </style>
</head>
<body class="bg-slate-50 text-slate-800 antialiased min-h-screen flex">

    <!-- Sidebar -->
    <aside class="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between hidden md:flex shadow-xl fixed h-full z-20">
        <div>
            <div class="p-6 border-b border-slate-800 flex items-center space-x-3">
                <div class="bg-indigo-600 text-white p-2.5 rounded-xl shadow-lg">
                    <i class="fa-solid fa-qrcode text-xl"></i>
                </div>
                <div>
                    <h1 class="font-bold text-white text-base leading-tight">QR Attendance</h1>
                    <span class="text-xs text-indigo-400 font-medium">Management v2.0</span>
                </div>
            </div>
            
            <nav class="p-4 space-y-1.5 text-sm font-medium">
                <a href="/dashboard" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition ${activeNav === 'dashboard' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}">
                    <i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span>
                </a>
                <a href="/scanner" target="_blank" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition hover:bg-slate-800 hover:text-white text-indigo-300">
                    <i class="fa-solid fa-camera w-5"></i><span>Open Scanner <i class="fa-solid fa-external-link-alt text-xs ml-1"></i></span>
                </a>
                <a href="/members" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition ${activeNav === 'members' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}">
                    <i class="fa-solid fa-users w-5"></i><span>Members</span>
                </a>
                <a href="/events" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition ${activeNav === 'events' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}">
                    <i class="fa-solid fa-calendar-days w-5"></i><span>Events</span>
                </a>
                <a href="/attendance" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition ${activeNav === 'attendance' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}">
                    <i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance Records</span>
                </a>
                <a href="/reports" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition ${activeNav === 'reports' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}">
                    <i class="fa-solid fa-file-excel w-5"></i><span>Reports & Analytics</span>
                </a>
                <a href="/audit" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition ${activeNav === 'audit' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}">
                    <i class="fa-solid fa-shield-halved w-5"></i><span>Audit Logs</span>
                </a>
                <a href="/settings" class="flex items-center space-x-3 px-4 py-3 rounded-xl transition ${activeNav === 'settings' ? 'bg-indigo-600 text-white shadow-md' : 'hover:bg-slate-800 hover:text-white'}">
                    <i class="fa-solid fa-gear w-5"></i><span>Settings & Backup</span>
                </a>
            </nav>
        </div>
        
        <div class="p-4 border-t border-slate-800">
            <div class="flex items-center justify-between px-3 py-2 bg-slate-800/60 rounded-xl">
                <div class="flex items-center space-x-2">
                    <div class="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center font-bold text-white text-xs">
                        ${settings.username ? settings.username.substring(0,2).toUpperCase() : 'AD'}
                    </div>
                    <div class="text-xs">
                        <p class="font-semibold text-white">${settings.username || 'Administrator'}</p>
                        <p class="text-slate-400">Online</p>
                    </div>
                </div>
                <form action="/logout" method="POST">
                    <button type="submit" class="text-slate-400 hover:text-red-400 transition p-2" title="Logout">
                        <i class="fa-solid fa-right-from-bracket"></i>
                    </button>
                </form>
            </div>
        </div>
    </aside>

    <!-- Main Content Area -->
    <div class="flex-1 md:ml-64 flex flex-col min-h-screen">
        <!-- Top Navigation / Mobile Header -->
        <header class="bg-white border-b border-slate-200 sticky top-0 z-10 px-6 py-4 flex items-center justify-between shadow-xs">
            <div class="flex items-center space-x-4">
                <h2 class="text-xl font-bold text-slate-900">${title}</h2>
            </div>
            <div class="flex items-center space-x-3">
                <a href="/scanner" target="_blank" class="bg-indigo-50 text-indigo-600 hover:bg-indigo-100 px-4 py-2 rounded-xl font-semibold text-sm transition flex items-center space-x-2 border border-indigo-200">
                    <i class="fa-solid fa-camera"></i>
                    <span>Scanner Page</span>
                </a>
                <form action="/logout" method="POST" class="md:hidden">
                    <button type="submit" class="text-red-600 hover:bg-red-50 p-2 rounded-lg text-sm font-semibold">
                        <i class="fa-solid fa-right-from-bracket"></i>
                    </button>
                </form>
            </div>
        </header>

        <!-- Page Body Content -->
        <main class="flex-1 p-6 md:p-8 max-w-7xl w-full mx-auto">
            ${content}
        </main>
    </div>

</body>
</html>
    `;
}

// ==================== ROUTES ====================

// 1. LOGIN PAGE
app.get('/login', (req, res) => {
    if (req.session && req.session.adminId) {
        return res.redirect('/dashboard');
    }
    const error = req.query.error || '';
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login - QR Attendance System</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'); body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-slate-950 flex items-center justify-center min-h-screen px-4">
    <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-8">
        <div class="text-center mb-8">
            <div class="inline-flex bg-indigo-600 text-white p-4 rounded-2xl shadow-lg mb-4">
                <i class="fa-solid fa-qrcode text-3xl"></i>
            </div>
            <h1 class="text-2xl font-bold text-white tracking-tight">Admin Portal</h1>
            <p class="text-sm text-slate-400 mt-1">QR Attendance Management System</p>
        </div>

        ${error ? `<div class="mb-4 bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl text-sm flex items-center space-x-2"><i class="fa-solid fa-circle-exclamation"></i><span>${error}</span></div>` : ''}

        <form action="/login" method="POST" class="space-y-5">
            <div>
                <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Username / Email</label>
                <div class="relative">
                    <span class="absolute inset-y-0 left-0 pl-4 flex items-center text-slate-500"><i class="fa-solid fa-user"></i></span>
                    <input type="text" name="username" required class="w-full bg-slate-800 border border-slate-700 rounded-xl pl-11 pr-4 py-3 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-indigo-500 transition" placeholder="admin">
                </div>
            </div>
            <div>
                <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Password</label>
                <div class="relative">
                    <span class="absolute inset-y-0 left-0 pl-4 flex items-center text-slate-500"><i class="fa-solid fa-lock"></i></span>
                    <input type="password" name="password" required class="w-full bg-slate-800 border border-slate-700 rounded-xl pl-11 pr-4 py-3 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-indigo-500 transition" placeholder="••••••••">
                </div>
            </div>
            <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl shadow-lg transition duration-200 text-sm flex items-center justify-center space-x-2">
                <span>Sign In to Dashboard</span>
                <i class="fa-solid fa-arrow-right"></i>
            </button>
        </form>

        <div class="mt-8 pt-6 border-t border-slate-800 text-center text-xs text-slate-500">
            <p>Default Credentials: <span class="text-indigo-400 font-mono">admin</span> / <span class="text-indigo-400 font-mono">admin123</span></p>
        </div>
    </div>
</body>
</html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admins WHERE username = ? OR email = ?", [username, username], async (err, admin) => {
        if (err || !admin) {
            return res.redirect('/login?error=Invalid username or password');
        }
        const match = await bcrypt.compare(password, admin.password);
        if (match) {
            req.session.adminId = admin.id;
            req.session.username = admin.username;
            logAudit('ADMIN_LOGIN', admin.username, 'Admin logged into dashboard');
            res.redirect('/dashboard');
        } else {
            res.redirect('/login?error=Invalid username or password');
        }
    });
});

app.post('/logout', (req, res) => {
    const user = req.session.username;
    req.session.destroy(() => {
        logAudit('ADMIN_LOGOUT', user, 'Admin logged out');
        res.redirect('/login');
    });
});

// 2. ADMIN DASHBOARD
app.get('/dashboard', isAuthenticated, (req, res) => {
    db.serialize(() => {
        db.get("SELECT COUNT(*) as count FROM members WHERE status = 'Active'", (err, mRow) => {
            db.get("SELECT COUNT(*) as count FROM events", (err, eRow) => {
                db.get("SELECT * FROM events WHERE status = 'Active' LIMIT 1", (err, activeEvent) => {
                    const eventId = activeEvent ? activeEvent.id : 0;
                    const today = new Date().toISOString().split('T')[0];
                    
                    db.get("SELECT COUNT(DISTINCT member_id) as count FROM attendance WHERE event_id = ? AND date = ?", [eventId, today], (err, pRow) => {
                        db.get("SELECT COUNT(DISTINCT member_id) as count FROM attendance WHERE event_id = ? AND date = ? AND status = 'Late'", [eventId, today], (err, lRow) => {
                            db.all("SELECT a.*, m.first_name, m.last_name, m.student_id, m.photo FROM attendance a JOIN members m ON a.member_id = m.id WHERE a.event_id = ? AND a.date = ? ORDER BY a.id DESC LIMIT 10", [eventId, today], (err, liveScans) => {
                                
                                const totalMembers = mRow ? mRow.count : 0;
                                const presentToday = pRow ? pRow.count : 0;
                                const lateToday = lRow ? lRow.count : 0;
                                const absentToday = Math.max(0, totalMembers - presentToday);
                                const attendanceRate = totalMembers > 0 ? Math.round((presentToday / totalMembers) * 100) : 0;

                                let liveScansHtml = liveScans && liveScans.length > 0 ? liveScans.map(s => `
                                    <div class="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl shadow-xs">
                                        <div class="flex items-center space-x-3">
                                            <div class="w-10 h-10 rounded-full bg-indigo-100 text-indigo-600 font-bold flex items-center justify-center overflow-hidden">
                                                ${s.photo ? `<img src="${s.photo}" class="w-full h-full object-cover">` : s.first_name.substring(0,2).toUpperCase()}
                                            </div>
                                            <div>
                                                <p class="font-semibold text-slate-800 text-sm">${s.first_name} ${s.last_name}</p>
                                                <p class="text-xs text-slate-500 font-mono">ID: ${s.student_id}</p>
                                            </div>
                                        </div>
                                        <div class="text-right">
                                            <span class="px-2.5 py-1 text-xs font-semibold rounded-full ${s.status === 'Present' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">${s.status}</span>
                                            <p class="text-xs text-slate-400 mt-1">${s.time_in || s.time_out}</p>
                                        </div>
                                    </div>
                                `).join('') : `<p class="text-slate-400 text-sm text-center py-4">No scans recorded for today yet.</p>`;

                                const content = `
                                    <div class="space-y-6">
                                        <!-- Active Event Banner -->
                                        <div class="bg-gradient-to-r from-indigo-900 to-slate-900 text-white p-6 rounded-2xl shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center space-y-4 md:space-y-0">
                                            <div>
                                                <div class="flex items-center space-x-2 mb-1">
                                                    <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                                    <span class="text-xs uppercase tracking-wider text-indigo-300 font-semibold">Active Event Session</span>
                                                </div>
                                                <h3 class="text-xl font-bold">${activeEvent ? activeEvent.name : 'No Active Event'}</h3>
                                                <p class="text-sm text-slate-300 mt-1">${activeEvent ? `${activeEvent.event_date} | ${activeEvent.start_time} - ${activeEvent.end_time} @ ${activeEvent.location}` : 'Please activate an event in the Events tab.'}</p>
                                            </div>
                                            <div class="flex space-x-3">
                                                <a href="/scanner" target="_blank" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition flex items-center space-x-2">
                                                    <i class="fa-solid fa-camera"></i><span>Launch Scanner</span>
                                                </a>
                                                <a href="/events" class="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2.5 rounded-xl font-semibold text-sm transition border border-slate-700">
                                                    Manage Events
                                                </a>
                                            </div>
                                        </div>

                                        <!-- Statistics Grid -->
                                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                                            <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
                                                <div class="p-4 bg-indigo-50 text-indigo-600 rounded-xl"><i class="fa-solid fa-users text-2xl"></i></div>
                                                <div>
                                                    <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Members</p>
                                                    <h4 class="text-2xl font-bold text-slate-900 mt-1">${totalMembers}</h4>
                                                </div>
                                            </div>
                                            <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
                                                <div class="p-4 bg-emerald-50 text-emerald-600 rounded-xl"><i class="fa-solid fa-user-check text-2xl"></i></div>
                                                <div>
                                                    <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">Present Today</p>
                                                    <h4 class="text-2xl font-bold text-slate-900 mt-1">${presentToday}</h4>
                                                </div>
                                            </div>
                                            <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
                                                <div class="p-4 bg-amber-50 text-amber-600 rounded-xl"><i class="fa-solid fa-user-clock text-2xl"></i></div>
                                                <div>
                                                    <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">Late Today</p>
                                                    <h4 class="text-2xl font-bold text-slate-900 mt-1">${lateToday}</h4>
                                                </div>
                                            </div>
                                            <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
                                                <div class="p-4 bg-rose-50 text-rose-600 rounded-xl"><i class="fa-solid fa-user-xmark text-2xl"></i></div>
                                                <div>
                                                    <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">Absent Today</p>
                                                    <h4 class="text-2xl font-bold text-slate-900 mt-1">${absentToday}</h4>
                                                </div>
                                            </div>
                                        </div>

                                        <!-- Charts & Live Feed Section -->
                                        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                            <!-- Chart -->
                                            <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs lg:col-span-2 flex flex-col">
                                                <h3 class="font-bold text-slate-900 text-lg mb-4">Attendance Overview</h3>
                                                <div class="flex-1 flex items-center justify-center min-h-[280px]">
                                                    <canvas id="attendanceChart"></canvas>
                                                </div>
                                            </div>

                                            <!-- Live Feed -->
                                            <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex flex-col">
                                                <div class="flex items-center justify-between mb-4">
                                                    <h3 class="font-bold text-slate-900 text-lg">Live Scans Feed</h3>
                                                    <span class="relative flex h-3 w-3">
                                                      <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                                      <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                                                    </span>
                                                </div>
                                                <div class="space-y-3 overflow-y-auto max-h-[320px] pr-1" id="liveFeedContainer">
                                                    ${liveScansHtml}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <script>
                                        // Render Chart
                                        const ctx = document.getElementById('attendanceChart').getContext('2d');
                                        new Chart(ctx, {
                                            type: 'doughnut',
                                            data: {
                                                labels: ['Present', 'Late', 'Absent'],
                                                datasets: [{
                                                    data: [${presentToday}, ${lateToday}, ${absentToday}],
                                                    backgroundColor: ['#10b981', '#f59e0b', '#f43f5e'],
                                                    borderWidth: 0
                                                }]
                                            },
                                            options: {
                                                responsive: true,
                                                maintainAspectRatio: false,
                                                plugins: {
                                                    legend: { position: 'bottom' }
                                                }
                                            }
                                        });

                                        // Auto-refresh live feed every 5 seconds
                                        setInterval(() => {
                                            fetch('/api/live-scans')
                                                .then(res => res.json())
                                                .then(data => {
                                                    if(data && data.length > 0) {
                                                        let html = '';
                                                        data.forEach(s => {
                                                            html += \`
                                                                <div class="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl shadow-xs">
                                                                    <div class="flex items-center space-x-3">
                                                                        <div class="w-10 h-10 rounded-full bg-indigo-100 text-indigo-600 font-bold flex items-center justify-center overflow-hidden">
                                                                            \${s.photo ? \`<img src="\${s.photo}" class="w-full h-full object-cover">\` : s.first_name.substring(0,2).toUpperCase()}
                                                                        </div>
                                                                        <div>
                                                                            <p class="font-semibold text-slate-800 text-sm">\${s.first_name} \${s.last_name}</p>
                                                                            <p class="text-xs text-slate-500 font-mono">ID: \${s.student_id}</p>
                                                                        </div>
                                                                    </div>
                                                                    <div class="text-right">
                                                                        <span class="px-2.5 py-1 text-xs font-semibold rounded-full \${s.status === 'Present' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">\${s.status}</span>
                                                                        <p class="text-xs text-slate-400 mt-1">\${s.time_in || s.time_out}</p>
                                                                    </div>
                                                                </div>
                                                            \`;
                                                        });
                                                        document.getElementById('liveFeedContainer').innerHTML = html;
                                                    }
                                                }).catch(e => console.log(e));
                                        }, 5000);
                                    </script>
                                `;

                                res.send(renderLayout('Admin Dashboard', 'dashboard', content, req.session));
                            });
                        });
                    });
                });
            });
        });
    });
});

// API for live feed JSON
app.get('/api/live-scans', isAuthenticated, (req, res) => {
    db.get("SELECT * FROM events WHERE status = 'Active' LIMIT 1", (err, activeEvent) => {
        const eventId = activeEvent ? activeEvent.id : 0;
        const today = new Date().toISOString().split('T')[0];
        db.all("SELECT a.*, m.first_name, m.last_name, m.student_id, m.photo FROM attendance a JOIN members m ON a.member_id = m.id WHERE a.event_id = ? AND a.date = ? ORDER BY a.id DESC LIMIT 10", [eventId, today], (err, rows) => {
            res.json(rows || []);
        });
    });
});

// 3 & 13. MEMBER MANAGEMENT & REGISTRATION
app.get('/members', isAuthenticated, (req, res) => {
    const search = req.query.search || '';
    const query = search ? `SELECT * FROM members WHERE first_name LIKE ? OR last_name LIKE ? OR student_id LIKE ? OR course_section LIKE ? ORDER BY id DESC` : `SELECT * FROM members ORDER BY id DESC`;
    const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];

    db.all(query, params, (err, members) => {
        const content = `
            <div class="space-y-6">
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h3 class="text-xl font-bold text-slate-900">Member Management</h3>
                        <p class="text-sm text-slate-500">Register students/members, generate QR codes, and print ID cards.</p>
                    </div>
                    <a href="/members/add" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition flex items-center space-x-2">
                        <i class="fa-solid fa-user-plus"></i><span>Register New Member</span>
                    </a>
                </div>

                <!-- Search & Filters -->
                <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
                    <form action="/members" method="GET" class="flex items-center space-x-3 w-full max-w-md">
                        <div class="relative flex-1">
                            <span class="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-400"><i class="fa-solid fa-search"></i></span>
                            <input type="text" name="search" value="${search}" placeholder="Search by name, ID, or course..." class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <button type="submit" class="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-sm font-semibold transition">Search</button>
                    </form>
                </div>

                <!-- Members Table -->
                <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-slate-50 border-b border-slate-200 text-xs uppercase font-semibold text-slate-500 tracking-wider">
                                    <th class="p-4">Member</th>
                                    <th class="p-4">Student ID</th>
                                    <th class="p-4">Course / Section</th>
                                    <th class="p-4">Contact</th>
                                    <th class="p-4">Status</th>
                                    <th class="p-4 text-center">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 text-sm">
                                ${members && members.length > 0 ? members.map(m => `
                                    <tr class="hover:bg-slate-50/50 transition">
                                        <td class="p-4 flex items-center space-x-3">
                                            <div class="w-10 h-10 rounded-full bg-indigo-100 text-indigo-600 font-bold flex items-center justify-center overflow-hidden shrink-0">
                                                ${m.photo ? `<img src="${m.photo}" class="w-full h-full object-cover">` : m.first_name.substring(0,2).toUpperCase()}
                                            </div>
                                            <div>
                                                <p class="font-semibold text-slate-900">${m.first_name} ${m.last_name}</p>
                                                <p class="text-xs text-slate-400">${m.email || 'No email'}</p>
                                            </div>
                                        </td>
                                        <td class="p-4 font-mono text-xs font-semibold text-slate-700">${m.student_id}</td>
                                        <td class="p-4 text-slate-600">${m.course_section || 'N/A'}</td>
                                        <td class="p-4 text-slate-600">${m.contact_number || 'N/A'}</td>
                                        <td class="p-4">
                                            <span class="px-2.5 py-1 text-xs font-semibold rounded-full ${m.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}">${m.status}</span>
                                        </td>
                                        <td class="p-4 text-center space-x-2">
                                            <a href="/members/id/${m.id}" class="text-indigo-600 hover:text-indigo-800 p-1.5 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition" title="Print/View ID">
                                                <i class="fa-solid fa-id-card"></i>
                                            </a>
                                            <a href="/members/edit/${m.id}" class="text-amber-600 hover:text-amber-800 p-1.5 bg-amber-50 hover:bg-amber-100 rounded-lg transition" title="Edit Member">
                                                <i class="fa-solid fa-pen"></i>
                                            </a>
                                            <a href="/members/delete/${m.id}" onclick="return confirm('Are you sure you want to delete this member?');" class="text-rose-600 hover:text-rose-800 p-1.5 bg-rose-50 hover:bg-rose-100 rounded-lg transition" title="Delete Member">
                                                <i class="fa-solid fa-trash"></i>
                                            </a>
                                        </td>
                                    </tr>
                                `).join('') : `<tr><td colspan="6" class="p-6 text-center text-slate-400">No members found.</td></tr>`}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        res.send(renderLayout('Member Management', 'members', content, req.session));
    });
});

app.get('/members/add', isAuthenticated, (req, res) => {
    const content = `
        <div class="max-w-3xl mx-auto bg-white p-8 rounded-2xl border border-slate-200 shadow-xs">
            <h3 class="text-xl font-bold text-slate-900 mb-6">Register New Member / Student</h3>
            <form action="/members/add" method="POST" class="space-y-5">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">First Name *</label>
                        <input type="text" name="first_name" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Middle Name</label>
                        <input type="text" name="middle_name" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Last Name *</label>
                        <input type="text" name="last_name" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Student / Member ID *</label>
                        <input type="text" name="student_id" required placeholder="e.g. 2026-001" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Course / Section *</label>
                        <input type="text" name="course_section" required placeholder="e.g. BSIT 3-A" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Year Level</label>
                        <select name="year_level" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                            <option>1st Year</option>
                            <option>2nd Year</option>
                            <option>3rd Year</option>
                            <option>4th Year</option>
                            <option>Other</option>
                        </select>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Gender</label>
                        <select name="gender" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                            <option>Male</option>
                            <option>Female</option>
                            <option>Other</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Contact Number</label>
                        <input type="text" name="contact_number" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Email Address</label>
                        <input type="email" name="email" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Address</label>
                        <input type="text" name="address" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Emergency Contact (Name & No.)</label>
                        <input type="text" name="emergency_contact" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                </div>

                <div>
                    <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Photo URL (Optional avatar image)</label>
                    <input type="text" name="photo" placeholder="https://example.com/photo.jpg" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                </div>

                <div class="flex justify-end space-x-3 pt-4 border-t border-slate-100">
                    <a href="/members" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl font-semibold text-sm transition">Cancel</a>
                    <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition">Save & Generate QR</button>
                </div>
            </form>
        </div>
    `;
    res.send(renderLayout('Register Member', 'members', content, req.session));
});

app.post('/members/add', isAuthenticated, (req, res) => {
    const { student_id, first_name, middle_name, last_name, course_section, year_level, gender, contact_number, email, address, emergency_contact, photo } = req.body;
    const qr_token = 'ATT-TOKEN-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-' + Date.now().toString().slice(-4);
    const date_registered = new Date().toISOString().split('T')[0];

    db.run(`INSERT INTO members (student_id, first_name, middle_name, last_name, course_section, year_level, gender, contact_number, email, address, emergency_contact, photo, qr_token, date_registered, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
            [student_id, first_name, middle_name, last_name, course_section, year_level, gender, contact_number, email, address, emergency_contact, photo, qr_token, date_registered],
            function(err) {
                if (err) {
                    return res.send(`<script>alert('Error registering member: ${err.message}'); window.history.back();</script>`);
                }
                logAudit('MEMBER_CREATED', req.session.username, `Registered member ${first_name} ${last_name} (${student_id})`);
                res.redirect(`/members/id/${this.lastID}`);
            });
});

// 4. PRINTABLE QR ID
app.get('/members/id/:id', isAuthenticated, (req, res) => {
    const memberId = req.params.id;
    db.get("SELECT * FROM members WHERE id = ?", [memberId], async (err, member) => {
        if (!member) return res.redirect('/members');

        // Generate QR code data URL
        try {
            const qrDataUrl = await QRCode.toDataURL(member.qr_token, { width: 300, margin: 2 });
            
            db.get("SELECT value FROM settings WHERE key = 'org_name'", (err, orgRow) => {
                const orgName = orgRow ? orgRow.value : 'Academic Institution';

                const content = `
                    <div class="max-w-2xl mx-auto space-y-6">
                        <div class="flex justify-between items-center print:hidden">
                            <h3 class="text-xl font-bold text-slate-900">Printable Member ID Card</h3>
                            <div class="space-x-3">
                                <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition flex items-center space-x-2 inline-flex">
                                    <i class="fa-solid fa-print"></i><span>Print ID Card</span>
                                </button>
                                <a href="/members" class="bg-slate-200 hover:bg-slate-300 text-slate-700 px-4 py-2.5 rounded-xl font-semibold text-sm transition">Back</a>
                            </div>
                        </div>

                        <!-- ID Card Box -->
                        <div id="printableCard" class="bg-white border-2 border-indigo-900 rounded-3xl shadow-xl overflow-hidden max-w-md mx-auto p-6 text-center relative">
                            <div class="absolute top-0 left-0 right-0 h-3 bg-indigo-600"></div>
                            
                            <div class="mb-4 pt-2">
                                <h4 class="font-extrabold text-indigo-900 text-lg uppercase tracking-wider">${orgName}</h4>
                                <span class="text-xs uppercase tracking-widest text-slate-400 font-semibold">Official Student / Member ID</span>
                            </div>

                            <div class="my-6 flex justify-center">
                                <div class="w-32 h-32 rounded-2xl bg-indigo-50 border-4 border-indigo-100 shadow-md overflow-hidden flex items-center justify-center font-bold text-indigo-400 text-2xl">
                                    ${member.photo ? `<img src="${member.photo}" class="w-full h-full object-cover">` : member.first_name.substring(0,2).toUpperCase()}
                                </div>
                            </div>

                            <div class="mb-6">
                                <h2 class="text-2xl font-bold text-slate-900">${member.first_name} ${member.middle_name ? member.middle_name[0] + '.' : ''} ${member.last_name}</h2>
                                <p class="text-indigo-600 font-bold text-sm mt-1">${member.course_section || 'Member'} (${member.year_level || 'N/A'})</p>
                                <p class="text-xs font-mono text-slate-500 mt-1">ID: ${member.student_id}</p>
                            </div>

                            <div class="bg-slate-50 border border-slate-200 rounded-2xl p-4 inline-block mx-auto mb-4">
                                <img src="${qrDataUrl}" class="w-40 h-40 mx-auto">
                                <p class="text-[10px] font-mono text-slate-400 mt-2">${member.qr_token}</p>
                            </div>

                            <div class="text-[11px] text-slate-400 border-t border-slate-100 pt-3 flex justify-between px-2">
                                <span>Status: <strong class="text-emerald-600">${member.status}</strong></span>
                                <span>Registered: ${member.date_registered}</span>
                            </div>
                        </div>
                    </div>

                    <style>
                        @media print {
                            body * { visibility: hidden; }
                            #printableCard, #printableCard * { visibility: visible; }
                            #printableCard { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border: 2px solid #312e81 !important; box-shadow: none !important; width: 100%; max-width: 400px; }
                        }
                    </style>
                `;
                res.send(renderLayout('Member ID Card', 'members', content, req.session));
            });
        } catch (e) {
            res.redirect('/members');
        }
    });
});

app.get('/members/edit/:id', isAuthenticated, (req, res) => {
    db.get("SELECT * FROM members WHERE id = ?", [req.params.id], (err, member) => {
        if (!member) return res.redirect('/members');
        const content = `
            <div class="max-w-3xl mx-auto bg-white p-8 rounded-2xl border border-slate-200 shadow-xs">
                <h3 class="text-xl font-bold text-slate-900 mb-6">Edit Member Details</h3>
                <form action="/members/edit/${member.id}" method="POST" class="space-y-5">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">First Name</label>
                            <input type="text" name="first_name" value="${member.first_name}" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Middle Name</label>
                            <input type="text" name="middle_name" value="${member.middle_name || ''}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Last Name</label>
                            <input type="text" name="last_name" value="${member.last_name}" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Student ID</label>
                            <input type="text" name="student_id" value="${member.student_id}" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Course / Section</label>
                            <input type="text" name="course_section" value="${member.course_section || ''}" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Status</label>
                            <select name="status" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                                <option ${member.status === 'Active' ? 'selected' : ''}>Active</option>
                                <option ${member.status === 'Inactive' ? 'selected' : ''}>Inactive</option>
                            </select>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Contact Number</label>
                            <input type="text" name="contact_number" value="${member.contact_number || ''}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Email</label>
                            <input type="email" name="email" value="${member.email || ''}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                    </div>

                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Photo URL</label>
                        <input type="text" name="photo" value="${member.photo || ''}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>

                    <div class="flex justify-end space-x-3 pt-4 border-t border-slate-100">
                        <a href="/members" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl font-semibold text-sm transition">Cancel</a>
                        <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition">Update Member</button>
                    </div>
                </form>
            </div>
        `;
        res.send(renderLayout('Edit Member', 'members', content, req.session));
    });
});

app.post('/members/edit/:id', isAuthenticated, (req, res) => {
    const { student_id, first_name, middle_name, last_name, course_section, status, contact_number, email, photo } = req.body;
    db.run("UPDATE members SET student_id = ?, first_name = ?, middle_name = ?, last_name = ?, course_section = ?, status = ?, contact_number = ?, email = ?, photo = ? WHERE id = ?",
        [student_id, first_name, middle_name, last_name, course_section, status, contact_number, email, photo, req.params.id],
        (err) => {
            logAudit('MEMBER_UPDATED', req.session.username, `Updated member ID ${req.params.id}`);
            res.redirect('/members');
        });
});

app.get('/members/delete/:id', isAuthenticated, (req, res) => {
    db.run("DELETE FROM members WHERE id = ?", [req.params.id], (err) => {
        logAudit('MEMBER_DELETED', req.session.username, `Deleted member ID ${req.params.id}`);
        res.redirect('/members');
    });
});

// 5, 6, 8, 9, 22, 23. SEPARATE PUBLIC QR SCANNER PAGE WITH AUDIO & VERIFICATION
app.get('/scanner', (req, res) => {
    db.get("SELECT * FROM events WHERE status = 'Active' LIMIT 1", (err, activeEvent) => {
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QR Attendance Scanner</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <!-- Html5-qrcode scanner library -->
    <script src="https://unpkg.com/html5-qrcode"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'); body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col justify-between">

    <!-- Top Bar -->
    <header class="bg-slate-900 border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div class="flex items-center space-x-3">
            <div class="bg-indigo-600 text-white p-2 rounded-xl">
                <i class="fa-solid fa-qrcode text-lg"></i>
            </div>
            <div>
                <h1 class="font-bold text-white text-base">Live QR Scanner</h1>
                <p class="text-xs text-indigo-400">Point QR Code to camera</p>
            </div>
        </div>
        <div>
            <a href="/dashboard" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold transition border border-slate-700">Admin Dashboard</a>
        </div>
    </header>

    <!-- Main Scanner Body -->
    <main class="flex-1 max-w-4xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
        <!-- Camera Box -->
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-2xl flex flex-col items-center">
            <div class="w-full mb-4">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-xs uppercase tracking-wider text-slate-400 font-semibold">Active Event</span>
                    <span class="px-2.5 py-0.5 text-xs font-semibold rounded-full ${activeEvent ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-700' : 'bg-rose-900/50 text-rose-400 border border-rose-700'}">${activeEvent ? activeEvent.name : 'No Active Event'}</span>
                </div>
                <p class="text-sm font-medium text-white">${activeEvent ? `${activeEvent.event_date} (${activeEvent.start_time} - ${activeEvent.end_time})` : 'Please activate an event in admin panel.'}</p>
            </div>

            <!-- Scanner Viewport -->
            <div class="w-full bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 relative min-h-[280px] flex items-center justify-center">
                <div id="reader" class="w-full"></div>
            </div>

            <div class="mt-4 w-full flex space-x-3">
                <button onclick="startScanner()" class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-xl font-semibold text-sm transition shadow-md">Start Camera</button>
                <button onclick="stopScanner()" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2.5 rounded-xl font-semibold text-sm transition border border-slate-700">Stop</button>
            </div>
        </div>

        <!-- Scan Result Card -->
        <div id="resultCard" class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl flex flex-col items-center justify-center text-center min-h-[380px] transition duration-300">
            <div id="resultIcon" class="w-20 h-20 rounded-full bg-slate-800 text-slate-500 flex items-center justify-center text-3xl mb-4 shadow-inner">
                <i class="fa-solid fa-qrcode"></i>
            </div>
            <h3 id="resultTitle" class="text-xl font-bold text-white">Ready to Scan</h3>
            <p id="resultSubtitle" class="text-sm text-slate-400 mt-2">Position student QR code in front of the camera to record attendance.</p>
            
            <div id="memberDetails" class="hidden mt-6 w-full bg-slate-950 border border-slate-800 rounded-2xl p-4 text-left space-y-2">
                <div class="flex items-center space-x-3">
                    <div id="memberAvatar" class="w-12 h-12 rounded-xl bg-indigo-600 text-white font-bold flex items-center justify-center overflow-hidden shrink-0"></div>
                    <div>
                        <h4 id="memberName" class="font-bold text-white text-base"></h4>
                        <p id="memberId" class="text-xs font-mono text-indigo-400"></p>
                    </div>
                </div>
                <div class="pt-2 border-t border-slate-800 text-xs flex justify-between text-slate-400">
                    <span id="scanTimeLabel">Time In: --:--</span>
                    <span id="scanStatusBadge" class="px-2 py-0.5 rounded font-semibold"></span>
                </div>
            </div>
        </div>
    </main>

    <!-- Footer -->
    <footer class="bg-slate-900 border-t border-slate-800 py-4 text-center text-xs text-slate-500">
        QR Attendance Management System &bull; Secure Scanner Module
    </footer>

    <!-- Audio Synthesis or Audio Elements for Success/Error/Warning -->
    <script>
        // Web Audio API Sound Generator for instant feedback without external files
        function playSound(type) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if(type === 'success') {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
                osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
                osc.start();
                osc.stop(ctx.currentTime + 0.4);
            } else if(type === 'error') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(220, ctx.currentTime);
                osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
                osc.start();
                osc.stop(ctx.currentTime + 0.4);
            } else if(type === 'warning') {
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(440, ctx.currentTime);
                osc.frequency.setValueAtTime(330, ctx.currentTime + 0.15);
                gain.gain.setValueAtTime(0.25, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
                osc.start();
                osc.stop(ctx.currentTime + 0.35);
            }
        }

        let html5QrCode;
        let isScanning = false;

        function startScanner() {
            if(isScanning) return;
            html5QrCode = new Html5Qrcode("reader");
            html5QrCode.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: { width: 250, height: 250 } },
                onScanSuccess,
                onScanFailure
            ).then(() => { isScanning = true; }).catch(err => {
                alert("Camera permission denied or not supported.");
            });
        }

        function stopScanner() {
            if(html5QrCode && isScanning) {
                html5QrCode.stop().then(() => { isScanning = false; }).catch(err => console.log(err));
            }
        }

        let lastScannedToken = '';
        let lastScanTime = 0;

        function onScanSuccess(decodedText) {
            const now = Date.now();
            if(decodedText === lastScannedToken && now - lastScanTime < 5000) {
                return; // Prevent rapid duplicate triggers
            }
            lastScannedToken = decodedText;
            lastScanTime = now;

            // Send QR token to server
            fetch('/api/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qr_token: decodedText })
            })
            .then(res => res.json())
            .then(data => {
                const card = document.getElementById('resultCard');
                const icon = document.getElementById('resultIcon');
                const title = document.getElementById('resultTitle');
                const subtitle = document.getElementById('resultSubtitle');
                const details = document.getElementById('memberDetails');

                details.classList.remove('hidden');

                if(data.status === 'success') {
                    playSound('success');
                    card.className = "bg-emerald-950/80 border-2 border-emerald-500 rounded-3xl p-6 shadow-2xl flex flex-col items-center justify-center text-center min-h-[380px] transition duration-300";
                    icon.className = "w-20 h-20 rounded-full bg-emerald-600 text-white flex items-center justify-center text-3xl mb-4 shadow-lg";
                    icon.innerHTML = '<i class="fa-solid fa-check"></i>';
                    title.innerText = "ATTENDANCE RECORDED";
                    subtitle.innerText = data.message;
                    
                    document.getElementById('memberName').innerText = data.member.name;
                    document.getElementById('memberId').innerText = "ID: " + data.member.student_id;
                    document.getElementById('scanTimeLabel').innerText = data.action_type + ": " + data.scan_time;
                    document.getElementById('scanStatusBadge').innerText = data.attendance_status;
                    document.getElementById('scanStatusBadge').className = "px-2 py-0.5 rounded font-semibold " + (data.attendance_status === 'Present' ? 'bg-emerald-800 text-emerald-200' : 'bg-amber-800 text-amber-200');
                    document.getElementById('memberAvatar').innerHTML = data.member.photo ? '<img src="'+data.member.photo+'" class="w-full h-full object-cover">' : data.member.name.substring(0,2).toUpperCase();

                } else if(data.status === 'duplicate') {
                    playSound('warning');
                    card.className = "bg-amber-950/80 border-2 border-amber-500 rounded-3xl p-6 shadow-2xl flex flex-col items-center justify-center text-center min-h-[380px] transition duration-300";
                    icon.className = "w-20 h-20 rounded-full bg-amber-600 text-white flex items-center justify-center text-3xl mb-4 shadow-lg";
                    icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
                    title.innerText = "ALREADY SCANNED";
                    subtitle.innerText = data.message;

                    document.getElementById('memberName').innerText = data.member.name;
                    document.getElementById('memberId').innerText = "ID: " + data.member.student_id;
                    document.getElementById('scanTimeLabel').innerText = "Recorded: " + data.scan_time;
                    document.getElementById('scanStatusBadge').innerText = "Duplicate";
                    document.getElementById('scanStatusBadge').className = "px-2.5 py-0.5 rounded font-semibold bg-amber-800 text-amber-200";
                    document.getElementById('memberAvatar').innerHTML = data.member.photo ? '<img src="'+data.member.photo+'" class="w-full h-full object-cover">' : data.member.name.substring(0,2).toUpperCase();

                } else {
                    playSound('error');
                    card.className = "bg-rose-950/80 border-2 border-rose-500 rounded-3xl p-6 shadow-2xl flex flex-col items-center justify-center text-center min-h-[380px] transition duration-300";
                    icon.className = "w-20 h-20 rounded-full bg-rose-600 text-white flex items-center justify-center text-3xl mb-4 shadow-lg";
                    icon.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                    title.innerText = "INVALID QR CODE";
                    subtitle.innerText = data.message;
                    details.classList.add('hidden');
                }
            })
            .catch(err => console.log(err));
        }

        function onScanFailure(error) {
            // suppress continuous scan failure logs
        }

        // Auto start camera on load
        window.onload = () => { startScanner(); };
    </script>
</body>
</html>
        `);
    });
});

// Scan Processing API Endpoint
app.post('/api/scan', (req, res) => {
    const { qr_token } = req.body;
    if (!qr_token) return res.json({ status: 'error', message: 'Missing QR Token' });

    db.get("SELECT * FROM members WHERE qr_token = ? AND status = 'Active'", [qr_token], (err, member) => {
        if (!member) {
            return res.json({ status: 'error', message: 'Member not found or inactive in the system.' });
        }

        db.get("SELECT * FROM events WHERE status = 'Active' LIMIT 1", (err, activeEvent) => {
            if (!activeEvent) {
                return res.json({ status: 'error', message: 'No active event scheduled at this time. Please wait for admin.' });
            }

            const today = new Date().toISOString().split('T')[0];
            const now = new Date();
            const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            // Check if already has attendance for this event today
            db.get("SELECT * FROM attendance WHERE event_id = ? AND member_id = ? AND date = ?", [activeEvent.id, member.id, today], (err, att) => {
                if (!att) {
                    // First scan today -> TIME IN
                    // Determine if Late or On Time based on activeEvent.start_time and grace period (default 15 mins)
                    db.get("SELECT value FROM settings WHERE key = 'late_threshold_mins'", (err, settingRow) => {
                        const graceMins = settingRow ? parseInt(settingRow.value) : 15;
                        
                        const [eventHour, eventMinute] = activeEvent.start_time.split(':').map(Number);
                        const eventDateObj = new Date();
                        eventDateObj.setHours(eventHour, eventMinute + graceMins, 0);

                        const attendanceStatus = now > eventDateObj ? 'Late' : 'Present';

                        db.run(`INSERT INTO attendance (event_id, member_id, time_in, status, date, remarks) VALUES (?, ?, ?, ?, ?, ?)`,
                            [activeEvent.id, member.id, timeString, attendanceStatus, today, attendanceStatus === 'Late' ? 'Arrived past grace period' : 'On time'], () => {
                                res.json({
                                    status: 'success',
                                    message: `Welcome, ${member.first_name}! Time In recorded successfully.`,
                                    action_type: 'Time In',
                                    scan_time: timeString,
                                    attendance_status: attendanceStatus,
                                    member: {
                                        name: `${member.first_name} ${member.last_name}`,
                                        student_id: member.student_id,
                                        photo: member.photo
                                    }
                                });
                            });
                    });
                } else if (!att.time_out) {
                    // Second scan today -> TIME OUT
                    db.run("UPDATE attendance SET time_out = ? WHERE id = ?", [timeString, att.id], () => {
                        res.json({
                            status: 'success',
                            message: `Goodbye, ${member.first_name}! Time Out recorded successfully.`,
                            action_type: 'Time Out',
                            scan_time: timeString,
                            attendance_status: att.status,
                            member: {
                                name: `${member.first_name} ${member.last_name}`,
                                student_id: member.student_id,
                                photo: member.photo
                            }
                        });
                    });
                } else {
                    // Already scanned both Time In and Time Out -> Duplicate
                    res.json({
                        status: 'duplicate',
                        message: 'Attendance already recorded (Time In & Time Out completed for today).',
                        scan_time: att.time_in,
                        member: {
                            name: `${member.first_name} ${member.last_name}`,
                            student_id: member.student_id,
                            photo: member.photo
                        }
                    });
                }
            });
        });
    });
});

// 7 & 14. EVENT MANAGEMENT SYSTEM
app.get('/events', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM events ORDER BY event_date DESC, id DESC", (err, events) => {
        const content = `
            <div class="space-y-6">
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div>
                        <h3 class="text-xl font-bold text-slate-900">Event Management</h3>
                        <p class="text-sm text-slate-500">Create seminars, school events, assemblies and activate active scanner sessions.</p>
                    </div>
                    <a href="/events/add" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition flex items-center space-x-2">
                        <i class="fa-solid fa-calendar-plus"></i><span>Create New Event</span>
                    </a>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    ${events && events.length > 0 ? events.map(e => `
                        <div class="bg-white p-6 rounded-2xl border ${e.status === 'Active' ? 'border-indigo-600 ring-2 ring-indigo-600/20' : 'border-slate-200'} shadow-xs flex flex-col justify-between">
                            <div>
                                <div class="flex justify-between items-start mb-3">
                                    <span class="px-2.5 py-1 text-xs font-semibold rounded-full ${e.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}">${e.status}</span>
                                    <span class="text-xs font-medium text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">${e.event_type}</span>
                                </div>
                                <h4 class="font-bold text-slate-900 text-lg mb-1">${e.name}</h4>
                                <p class="text-xs text-slate-500 mb-4">${e.description || 'No description provided.'}</p>
                                
                                <div class="space-y-2 text-xs text-slate-600 border-t border-slate-100 pt-3">
                                    <p><i class="fa-solid fa-calendar w-5 text-indigo-500"></i> ${e.event_date}</p>
                                    <p><i class="fa-solid fa-clock w-5 text-indigo-500"></i> ${e.start_time} - ${e.end_time}</p>
                                    <p><i class="fa-solid fa-location-dot w-5 text-indigo-500"></i> ${e.location || 'N/A'}</p>
                                </div>
                            </div>

                            <div class="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between">
                                ${e.status !== 'Active' ? `<a href="/events/activate/${e.id}" class="text-indigo-600 hover:text-indigo-800 font-semibold text-xs bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition">Set Active</a>` : '<span class="text-xs font-bold text-emerald-600">Currently Active</span>'}
                                <div class="space-x-2">
                                    <a href="/events/edit/${e.id}" class="text-amber-600 hover:text-amber-800 p-1.5" title="Edit"><i class="fa-solid fa-pen"></i></a>
                                    <a href="/events/delete/${e.id}" onclick="return confirm('Delete this event?');" class="text-rose-600 hover:text-rose-800 p-1.5" title="Delete"><i class="fa-solid fa-trash"></i></a>
                                </div>
                            </div>
                        </div>
                    `).join('') : '<p class="text-slate-400">No events found.</p>'}
                </div>
            </div>
        `;
        res.send(renderLayout('Event Management', 'events', content, req.session));
    });
});

app.get('/events/add', isAuthenticated, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const content = `
        <div class="max-w-2xl mx-auto bg-white p-8 rounded-2xl border border-slate-200 shadow-xs">
            <h3 class="text-xl font-bold text-slate-900 mb-6">Create New Event</h3>
            <form action="/events/add" method="POST" class="space-y-5">
                <div>
                    <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Event Name *</label>
                    <input type="text" name="name" required placeholder="e.g. Annual Science Seminar" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                </div>
                <div>
                    <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Description</label>
                    <textarea name="description" rows="3" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500"></textarea>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Event Date *</label>
                        <input type="date" name="event_date" value="${today}" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Event Type</label>
                        <select name="event_type" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                            <option>General Attendance</option>
                            <option>School Event</option>
                            <option>Seminar</option>
                            <option>Meeting</option>
                            <option>Sports Event</option>
                            <option>Workshop</option>
                            <option>Examination</option>
                        </select>
                    </div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Start Time *</label>
                        <input type="time" name="start_time" value="07:00" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                    <div>
                        <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">End Time *</label>
                        <input type="time" name="end_time" value="17:00" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                    </div>
                </div>
                <div>
                    <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Location</label>
                    <input type="text" name="location" placeholder="e.g. Main Auditorium" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                </div>
                <div class="flex justify-end space-x-3 pt-4 border-t border-slate-100">
                    <a href="/events" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl font-semibold text-sm transition">Cancel</a>
                    <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition">Create Event</button>
                </div>
            </form>
        </div>
    `;
    res.send(renderLayout('Create Event', 'events', content, req.session));
});

app.post('/events/add', isAuthenticated, (req, res) => {
    const { name, description, event_date, start_time, end_time, location, event_type } = req.body;
    db.run("INSERT INTO events (name, description, event_date, start_time, end_time, location, event_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Inactive')",
        [name, description, event_date, start_time, end_time, location, event_type], () => {
            logAudit('EVENT_CREATED', req.session.username, `Created event ${name}`);
            res.redirect('/events');
        });
});

app.get('/events/activate/:id', isAuthenticated, (req, res) => {
    db.run("UPDATE events SET status = 'Inactive'", [], () => {
        db.run("UPDATE events SET status = 'Active' WHERE id = ?", [req.params.id], () => {
            logAudit('EVENT_ACTIVATED', req.session.username, `Activated event ID ${req.params.id}`);
            res.redirect('/events');
        });
    });
});

app.get('/events/delete/:id', isAuthenticated, (req, res) => {
    db.run("DELETE FROM events WHERE id = ?", [req.params.id], () => {
        logAudit('EVENT_DELETED', req.session.username, `Deleted event ID ${req.params.id}`);
        res.redirect('/events');
    });
});

// 10. ATTENDANCE RECORDS
app.get('/attendance', isAuthenticated, (req, res) => {
    const search = req.query.search || '';
    const dateFilter = req.query.date || '';
    
    let query = `SELECT a.*, m.first_name, m.last_name, m.student_id, m.course_section, e.name as event_name 
                 FROM attendance a 
                 JOIN members m ON a.member_id = m.id 
                 JOIN events e ON a.event_id = e.id`;
    let params = [];

    if (search || dateFilter) {
        query += ` WHERE`;
        if (search) {
            query += ` (m.first_name LIKE ? OR m.last_name LIKE ? OR m.student_id LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (search && dateFilter) query += ` AND`;
        if (dateFilter) {
            query += ` a.date = ?`;
            params.push(dateFilter);
        }
    }
    query += ` ORDER BY a.id DESC LIMIT 50`;

    db.all(query, params, (err, records) => {
        const content = `
            <div class="space-y-6">
                <div class="flex justify-between items-center">
                    <div>
                        <h3 class="text-xl font-bold text-slate-900">Attendance Records</h3>
                        <p class="text-sm text-slate-500">View, search, and filter time in and time out logs.</p>
                    </div>
                </div>

                <!-- Filters -->
                <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
                    <form action="/attendance" method="GET" class="flex flex-col md:flex-row gap-3">
                        <div class="flex-1 relative">
                            <span class="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-400"><i class="fa-solid fa-search"></i></span>
                            <input type="text" name="search" value="${search}" placeholder="Search member name or ID..." class="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <input type="date" name="date" value="${dateFilter}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <button type="submit" class="bg-slate-800 hover:bg-slate-700 text-white px-5 py-2 rounded-xl text-sm font-semibold transition">Filter</button>
                    </form>
                </div>

                <!-- Table -->
                <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-slate-50 border-b border-slate-200 text-xs uppercase font-semibold text-slate-500 tracking-wider">
                                    <th class="p-4">Date</th>
                                    <th class="p-4">Event</th>
                                    <th class="p-4">Member Name</th>
                                    <th class="p-4">Student ID</th>
                                    <th class="p-4">Time In</th>
                                    <th class="p-4">Time Out</th>
                                    <th class="p-4">Status</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 text-sm">
                                ${records && records.length > 0 ? records.map(r => `
                                    <tr class="hover:bg-slate-50/50 transition">
                                        <td class="p-4 text-slate-600 font-mono text-xs">${r.date}</td>
                                        <td class="p-4 font-semibold text-slate-800">${r.event_name}</td>
                                        <td class="p-4 text-slate-900">${r.first_name} ${r.last_name}</td>
                                        <td class="p-4 font-mono text-xs text-slate-600">${r.student_id}</td>
                                        <td class="p-4 text-slate-600 font-mono text-xs">${r.time_in || '--:--'}</td>
                                        <td class="p-4 text-slate-600 font-mono text-xs">${r.time_out || '--:--'}</td>
                                        <td class="p-4">
                                            <span class="px-2.5 py-1 text-xs font-semibold rounded-full ${r.status === 'Present' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">${r.status}</span>
                                        </td>
                                    </tr>
                                `).join('') : '<tr><td colspan="7" class="p-6 text-center text-slate-400">No attendance logs found.</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        res.send(renderLayout('Attendance Records', 'attendance', content, req.session));
    });
});

// 11 & 12. REPORT GENERATOR & ANALYTICS
app.get('/reports', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM events", (err, events) => {
        db.all("SELECT * FROM members", (err, members) => {
            const content = `
                <div class="space-y-6">
                    <div>
                        <h3 class="text-xl font-bold text-slate-900">Reports & Analytics</h3>
                        <p class="text-sm text-slate-500">Generate printable reports, export CSV summary, and review analytics.</p>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <!-- Generate Report Card -->
                        <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
                            <h4 class="font-bold text-slate-900 text-base">Export & Print Attendance Report</h4>
                            <form action="/reports/generate" method="GET" class="space-y-4">
                                <div>
                                    <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Report Type</label>
                                    <select name="type" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                                        <option value="daily">Daily Attendance Report</option>
                                        <option value="event">By Event Report</option>
                                        <option value="all">All Records Summary</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Select Event (if applicable)</label>
                                    <select name="event_id" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                                        <option value="">-- All Events --</option>
                                        ${events ? events.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('') : ''}
                                    </select>
                                </div>
                                <div>
                                    <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Specific Date</label>
                                    <input type="date" name="date" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                                </div>
                                <div class="flex space-x-3 pt-2">
                                    <button type="submit" name="format" value="view" class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 rounded-xl font-semibold text-sm shadow-md transition">View Report</button>
                                    <button type="submit" name="format" value="csv" class="bg-slate-800 hover:bg-slate-700 text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition">Export CSV</button>
                                </div>
                            </form>
                        </div>

                        <!-- Quick Stats Overview -->
                        <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs flex flex-col justify-between">
                            <div>
                                <h4 class="font-bold text-slate-900 text-base mb-2">System Analytics Overview</h4>
                                <p class="text-xs text-slate-500 mb-4">Summary metrics across all registered events and members.</p>
                                <div class="space-y-3">
                                    <div class="flex justify-between items-center p-3 bg-slate-50 rounded-xl">
                                        <span class="text-xs font-semibold text-slate-600">Total Registered Members</span>
                                        <span class="font-bold text-indigo-600 text-sm">${members ? members.length : 0}</span>
                                    </div>
                                    <div class="flex justify-between items-center p-3 bg-slate-50 rounded-xl">
                                        <span class="text-xs font-semibold text-slate-600">Total Scheduled Events</span>
                                        <span class="font-bold text-emerald-600 text-sm">${events ? events.length : 0}</span>
                                    </div>
                                </div>
                            </div>
                            <div class="pt-4 border-t border-slate-100 text-xs text-slate-400 text-center">
                                Use printer-friendly view when generating reports for official documentation.
                            </div>
                        </div>
                    </div>
                </div>
            `;
            res.send(renderLayout('Reports & Analytics', 'reports', content, req.session));
        });
    });
});

app.get('/reports/generate', isAuthenticated, (req, res) => {
    const { type, event_id, date, format } = req.query;
    let query = `SELECT a.*, m.first_name, m.last_name, m.student_id, m.course_section, e.name as event_name 
                 FROM attendance a 
                 JOIN members m ON a.member_id = m.id 
                 JOIN events e ON a.event_id = e.id`;
    let params = [];

    if (type === 'event' && event_id) {
        query += ` WHERE a.event_id = ?`;
        params.push(event_id);
    } else if (type === 'daily' && date) {
        query += ` WHERE a.date = ?`;
        params.push(date);
    }
    query += ` ORDER BY a.id DESC`;

    db.all(query, params, (err, rows) => {
        if (format === 'csv') {
            let csv = 'ID,Name,Course/Section,Event,Date,Time In,Time Out,Status\n';
            rows.forEach(r => {
                csv += `"${r.student_id}","${r.first_name} ${r.last_name}","${r.course_section}","${r.event_name}","${r.date}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
            });
            res.header('Content-Type', 'text/csv');
            res.attachment('attendance-report.csv');
            return res.send(csv);
        }

        db.get("SELECT value FROM settings WHERE key = 'org_name'", (err, orgRow) => {
            const orgName = orgRow ? orgRow.value : 'Academic Institution';
            res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Attendance Report</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'); body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-white text-slate-800 p-8">
    <div class="max-w-4xl mx-auto space-y-6">
        <div class="flex justify-between items-center border-b border-slate-200 pb-4">
            <div>
                <h1 class="text-2xl font-bold text-slate-900">${orgName}</h1>
                <p class="text-sm text-slate-500">Official Attendance Report Summary</p>
            </div>
            <button onclick="window.print()" class="print:hidden bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-semibold shadow">Print Report</button>
        </div>

        <div class="text-xs text-slate-500">
            <p>Generated on: ${new Date().toLocaleString()}</p>
        </div>

        <table class="w-full text-left border-collapse border border-slate-300 text-sm">
            <thead>
                <tr class="bg-slate-100 border-b border-slate-300 text-xs uppercase font-semibold text-slate-700">
                    <th class="p-3 border border-slate-300">Student ID</th>
                    <th class="p-3 border border-slate-300">Name</th>
                    <th class="p-3 border border-slate-300">Course & Section</th>
                    <th class="p-3 border border-slate-300">Event</th>
                    <th class="p-3 border border-slate-300">Date</th>
                    <th class="p-3 border border-slate-300">Time In / Out</th>
                    <th class="p-3 border border-slate-300">Status</th>
                </tr>
            </thead>
            <tbody>
                ${rows && rows.length > 0 ? rows.map(r => `
                    <tr>
                        <td class="p-3 border border-slate-300 font-mono text-xs">${r.student_id}</td>
                        <td class="p-3 border border-slate-300 font-semibold">${r.first_name} ${r.last_name}</td>
                        <td class="p-3 border border-slate-300">${r.course_section}</td>
                        <td class="p-3 border border-slate-300">${r.event_name}</td>
                        <td class="p-3 border border-slate-300">${r.date}</td>
                        <td class="p-3 border border-slate-300 font-mono text-xs">${r.time_in || '--'} / ${r.time_out || '--'}</td>
                        <td class="p-3 border border-slate-300 font-semibold">${r.status}</td>
                    </tr>
                `).join('') : '<tr><td colspan="7" class="p-4 text-center text-slate-400">No records found.</td></tr>'}
            </tbody>
        </table>
    </div>
</body>
</html>
            `);
        });
    });
});

// 26. AUDIT LOGS
app.get('/audit', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50", (err, logs) => {
        const content = `
            <div class="space-y-6">
                <div>
                    <h3 class="text-xl font-bold text-slate-900">Admin Audit Logs</h3>
                    <p class="text-sm text-slate-500">Security trail tracking administrative actions and system events.</p>
                </div>

                <div class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-slate-50 border-b border-slate-200 text-xs uppercase font-semibold text-slate-500 tracking-wider">
                                    <th class="p-4">Action</th>
                                    <th class="p-4">Admin</th>
                                    <th class="p-4">Details</th>
                                    <th class="p-4">Timestamp</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 text-sm">
                                ${logs && logs.length > 0 ? logs.map(l => `
                                    <tr class="hover:bg-slate-50/50 transition">
                                        <td class="p-4 font-semibold text-indigo-600 text-xs font-mono">${l.action}</td>
                                        <td class="p-4 text-slate-800">${l.admin_username}</td>
                                        <td class="p-4 text-slate-600">${l.details}</td>
                                        <td class="p-4 text-xs font-mono text-slate-400">${l.date} ${l.time}</td>
                                    </tr>
                                `).join('') : '<tr><td colspan="4" class="p-6 text-center text-slate-400">No audit logs recorded.</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        res.send(renderLayout('Audit Logs', 'audit', content, req.session));
    });
});

// 25. SETTINGS & BACKUP (18. BACKUP & RESTORE)
app.get('/settings', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM settings", (err, settingsRows) => {
        const settings = {};
        if (settingsRows) settingsRows.forEach(s => settings[s.key] = s.value);

        const content = `
            <div class="max-w-3xl mx-auto space-y-6">
                <div class="bg-white p-8 rounded-2xl border border-slate-200 shadow-xs">
                    <h3 class="text-xl font-bold text-slate-900 mb-6">System Settings</h3>
                    <form action="/settings" method="POST" class="space-y-5">
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Organization / School Name</label>
                            <input type="text" name="org_name" value="${settings.org_name || ''}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Organization Address</label>
                            <input type="text" name="org_address" value="${settings.org_address || ''}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Contact Number</label>
                            <input type="text" name="org_contact" value="${settings.org_contact || ''}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Late Threshold (Minutes after start time)</label>
                            <input type="number" name="late_threshold_mins" value="${settings.late_threshold_mins || '15'}" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-indigo-500">
                        </div>
                        <div class="flex justify-end pt-4 border-t border-slate-100">
                            <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-xl font-semibold text-sm shadow-lg transition">Save Settings</button>
                        </div>
                    </form>
                </div>

                <!-- Backup & Database Download -->
                <div class="bg-white p-8 rounded-2xl border border-slate-200 shadow-xs">
                    <h3 class="text-xl font-bold text-slate-900 mb-2">Database Backup</h3>
                    <p class="text-sm text-slate-500 mb-4">Download a complete copy of the SQLite database file for backup purposes.</p>
                    <a href="/settings/backup" class="bg-slate-800 hover:bg-slate-700 text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition inline-flex items-center space-x-2">
                        <i class="fa-solid fa-download"></i><span>Download Database Backup</span>
                    </a>
                </div>
            </div>
        `;
        res.send(renderLayout('Settings', 'settings', content, req.session));
    });
});

app.post('/settings', isAuthenticated, (req, res) => {
    const { org_name, org_address, org_contact, late_threshold_mins } = req.body;
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('org_name', ?)", [org_name]);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('org_address', ?)", [org_address]);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('org_contact', ?)", [org_contact]);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('late_threshold_mins', ?)", [late_threshold_mins]);
    
    logAudit('SETTINGS_UPDATED', req.session.username, 'Updated system configuration settings');
    res.redirect('/settings');
});

app.get('/settings/backup', isAuthenticated, (req, res) => {
    res.download(dbFile, 'attendance-backup.db');
});

// Root redirect
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// Start Server
app.listen(PORT, () => {
    console.log(`QR Attendance System running on http://localhost:${PORT}`);
});
