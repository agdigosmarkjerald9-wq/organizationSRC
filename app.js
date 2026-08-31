const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup directories
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// Multer Storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Database Initialization
const dbPath = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        full_name TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE,
        first_name TEXT,
        middle_name TEXT,
        last_name TEXT,
        full_name TEXT,
        grade_level TEXT,
        section TEXT,
        gender TEXT,
        dob TEXT,
        contact TEXT,
        email TEXT,
        address TEXT,
        guardian_name TEXT,
        guardian_contact TEXT,
        photo_url TEXT,
        school_year TEXT,
        status TEXT DEFAULT 'Active',
        qr_token TEXT UNIQUE,
        qr_status TEXT DEFAULT 'Active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT,
        description TEXT,
        event_date TEXT,
        start_time TEXT,
        end_time TEXT,
        location TEXT,
        organizer TEXT,
        attendance_type TEXT,
        status TEXT DEFAULT 'Upcoming',
        allowed_grade TEXT DEFAULT 'All',
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        event_id INTEGER,
        date TEXT,
        time_in TEXT,
        time_out TEXT,
        status TEXT,
        scanned_by TEXT,
        FOREIGN KEY(student_id) REFERENCES students(student_id),
        FOREIGN KEY(event_id) REFERENCES events(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS excuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        event_id INTEGER,
        date TEXT,
        reason TEXT,
        notes TEXT,
        approved_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        action TEXT,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Seed Default Admin and General Event
    bcrypt.hash('admin123', 10, (err, hash) => {
        if (!err) {
            db.run(`INSERT OR IGNORE INTO users (username, password, role, full_name) VALUES ('admin', ?, 'Administrator', 'System Administrator')`, [hash]);
        }
    });

    const defaultSettings = [
        ['school_name', 'Global Academy Institute'],
        ['school_address', '123 Academic Avenue, Metro City'],
        ['contact_info', '+1 (555) 019-2831'],
        ['school_year', '2026-2027'],
        ['late_threshold', '07:30'],
        ['min_attendance_pct', '75'],
        ['voice_enabled', 'true'],
        ['voice_volume', '1.0']
    ];

    defaultSettings.forEach(([key, val]) => {
        db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, val]);
    });

    const today = new Date().toISOString().split('T')[0];
    db.run(`INSERT OR IGNORE INTO events (id, event_name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade) 
            VALUES (1, 'General Attendance', 'Daily General Attendance', ?, '07:00', '17:00', 'Main Campus', 'Administration', 'General', 'Active', 'All')`, [today]);
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
    secret: 'school-qr-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 }
}));

// Audit Logging Helper
function logAudit(req, action, details) {
    const user = req.session && req.session.user ? req.session.user.username : 'System';
    db.run(`INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)`, [user, action, details]);
}

// Security Auth Middleware
function requireAuth(roles = []) {
    return (req, res, next) => {
        if (!req.session.user) return res.status(401).json({ error: 'Unauthorized. Please login.' });
        if (roles.length > 0 && !roles.includes(req.session.user.role)) {
            return res.status(403).json({ error: 'Forbidden. Access denied.' });
        }
        next();
    };
}

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------

// Authentication
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Invalid credentials.' });
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (isMatch) {
                req.session.user = { id: user.id, username: user.username, role: user.role, full_name: user.full_name };
                logAudit(req, 'Login', `User ${username} logged in.`);
                res.json({ success: true, role: user.role, studentId: user.username });
            } else {
                res.status(400).json({ error: 'Invalid credentials.' });
            }
        });
    });
});

app.post('/api/logout', (req, res) => {
    logAudit(req, 'Logout', `User logged out.`);
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
    else res.json({ loggedIn: false });
});

// Settings API
app.get('/api/settings', (req, res) => {
    db.all(`SELECT * FROM settings`, [], (err, rows) => {
        const settings = {};
        if (rows) rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    });
});

app.post('/api/settings', requireAuth(['Administrator']), (req, res) => {
    const keys = Object.keys(req.body);
    keys.forEach(key => {
        db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`, [key, req.body[key], req.body[key]]);
    });
    logAudit(req, 'Update Settings', 'System settings were updated.');
    res.json({ success: true });
});

// Student Management API
app.get('/api/students', requireAuth(['Administrator', 'Scanner User']), (req, res) => {
    const { search, grade, section, status } = req.query;
    let query = `SELECT * FROM students WHERE 1=1`;
    let params = [];
    if (search) {
        query += ` AND (student_id LIKE ? OR full_name LIKE ? OR first_name LIKE ? OR last_name LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (grade) { query += ` AND grade_level = ?`; params.push(grade); }
    if (section) { query += ` AND section = ?`; params.push(section); }
    if (status) { query += ` AND status = ?`; params.push(status); }
    query += ` ORDER BY created_at DESC`;

    db.all(query, params, (err, rows) => res.json(rows || []));
});

app.post('/api/students', requireAuth(['Administrator']), upload.single('photo'), (req, res) => {
    const { student_id, first_name, middle_name, last_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, school_year } = req.body;
    const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;
    const photo_url = req.file ? `/uploads/${req.file.filename}` : '/uploads/default-avatar.png';
    const qr_token = 'QR-' + crypto.randomBytes(12).toString('hex');

    db.run(`INSERT INTO students (student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, photo_url, school_year, qr_token) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [student_id, first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, photo_url, school_year, qr_token],
        function (err) {
            if (err) return res.status(400).json({ error: 'Student ID already exists or database error.' });
            bcrypt.hash('student123', 10, (e, hash) => {
                db.run(`INSERT OR IGNORE INTO users (username, password, role, full_name) VALUES (?, ?, 'Student', ?)`, [student_id, hash, full_name]);
            });
            logAudit(req, 'Register Student', `Created student ${full_name} (${student_id})`);
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/students/:id', requireAuth(['Administrator']), upload.single('photo'), (req, res) => {
    const { first_name, middle_name, last_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, school_year, status } = req.body;
    const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;
    let photoUpdate = req.file ? `, photo_url = '/uploads/${req.file.filename}'` : '';

    db.run(`UPDATE students SET first_name=?, middle_name=?, last_name=?, full_name=?, grade_level=?, section=?, gender=?, dob=?, contact=?, email=?, address=?, guardian_name=?, guardian_contact=?, school_year=?, status=? ${photoUpdate} WHERE id=?`,
        [first_name, middle_name, last_name, full_name, grade_level, section, gender, dob, contact, email, address, guardian_name, guardian_contact, school_year, status, req.params.id],
        function (err) {
            if (err) return res.status(400).json({ error: err.message });
            logAudit(req, 'Update Student', `Updated student ID ${req.params.id}`);
            res.json({ success: true });
        }
    );
});

app.post('/api/students/:id/regenerate-qr', requireAuth(['Administrator']), (req, res) => {
    const newToken = 'QR-' + crypto.randomBytes(12).toString('hex');
    db.run(`UPDATE students SET qr_token = ? WHERE id = ?`, [newToken, req.params.id], function (err) {
        if (err) return res.status(400).json({ error: err.message });
        logAudit(req, 'Regenerate QR', `Regenerated QR token for Student DB ID ${req.params.id}`);
        res.json({ success: true, qr_token: newToken });
    });
});

app.post('/api/students/:id/toggle-qr', requireAuth(['Administrator']), (req, res) => {
    const { qr_status } = req.body;
    db.run(`UPDATE students SET qr_status = ? WHERE id = ?`, [qr_status, req.params.id], function (err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ success: true });
    });
});

// Event Management API
app.get('/api/events', (req, res) => {
    db.all(`SELECT * FROM events ORDER BY event_date DESC, start_time DESC`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/events', requireAuth(['Administrator']), (req, res) => {
    const { event_name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade } = req.body;
    const created_by = req.session.user.username;
    db.run(`INSERT INTO events (event_name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [event_name, description, event_date, start_time, end_time, location, organizer, attendance_type, status, allowed_grade || 'All', created_by],
        function (err) {
            if (err) return res.status(400).json({ error: err.message });
            logAudit(req, 'Create Event', `Created event: ${event_name}`);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Attendance Scanning Engine
app.post('/api/scan', requireAuth(['Administrator', 'Scanner User']), (req, res) => {
    const { qr_token, event_id, scan_mode } = req.body; // scan_mode: 'IN' or 'OUT'
    const scanned_by = req.session.user.username;
    const today = new Date().toISOString().split('T')[0];
    const nowTime = new Date().toTimeString().split(' ')[0].substring(0, 5); // HH:MM

    db.get(`SELECT * FROM students WHERE qr_token = ?`, [qr_token], (err, student) => {
        if (err || !student) return res.status(404).json({ status: 'INVALID', message: 'Invalid or unknown QR Code.' });
        if (student.status !== 'Active' || student.qr_status !== 'Active') {
            return res.status(400).json({ status: 'DISABLED', message: 'Student QR Code is inactive/disabled.' });
        }

        db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
            if (err || !event) return res.status(404).json({ status: 'ERROR', message: 'Active Event not selected.' });

            if (event.allowed_grade !== 'All' && event.allowed_grade !== student.grade_level) {
                return res.status(403).json({ status: 'RESTRICTED', message: `Event restricted to ${event.allowed_grade}.` });
            }

            db.get(`SELECT * FROM attendance WHERE student_id = ? AND event_id = ? AND date = ?`, [student.student_id, event_id, today], (err, record) => {
                if (scan_mode === 'IN') {
                    if (record && record.time_in) {
                        return res.json({ status: 'DUPLICATE', student, message: `${student.full_name}, Time In is already recorded.` });
                    }
                    
                    // Determine Status
                    let attStatus = 'Present';
                    if (event.start_time && nowTime > event.start_time) {
                        attStatus = 'Late';
                    }

                    if (record) {
                        db.run(`UPDATE attendance SET time_in = ?, status = ? WHERE id = ?`, [nowTime, attStatus, record.id]);
                    } else {
                        db.run(`INSERT INTO attendance (student_id, event_id, date, time_in, status, scanned_by) VALUES (?, ?, ?, ?, ?, ?)`,
                            [student.student_id, event_id, today, nowTime, attStatus, scanned_by]);
                    }

                    return res.json({ status: 'SUCCESS', type: 'IN', student, attStatus, time: nowTime, message: `${student.full_name}, attendance recorded.` });

                } else if (scan_mode === 'OUT') {
                    if (!record || !record.time_in) {
                        return res.status(400).json({ status: 'NO_IN', student, message: `${student.full_name} has not scanned Time In yet.` });
                    }
                    if (record.time_out) {
                        return res.json({ status: 'DUPLICATE', student, message: `${student.full_name}, Time Out is already recorded.` });
                    }

                    db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [nowTime, record.id]);
                    return res.json({ status: 'SUCCESS', type: 'OUT', student, attStatus: record.status, time: nowTime, message: `${student.full_name}, time out recorded.` });
                }
            });
        });
    });
});

// Live Scans Monitor API
app.get('/api/attendance/recent', (req, res) => {
    db.all(`SELECT a.*, s.full_name, s.grade_level, s.section, s.photo_url, e.event_name 
            FROM attendance a 
            JOIN students s ON a.student_id = s.student_id 
            JOIN events e ON a.event_id = e.id 
            ORDER BY a.id DESC LIMIT 10`, [], (err, rows) => res.json(rows || []));
});

// Attendance Records List API
app.get('/api/attendance', requireAuth(['Administrator']), (req, res) => {
    const { date, event_id, grade, section, status } = req.query;
    let query = `SELECT a.*, s.full_name, s.grade_level, s.section, e.event_name 
                 FROM attendance a 
                 JOIN students s ON a.student_id = s.student_id 
                 JOIN events e ON a.event_id = e.id WHERE 1=1`;
    let params = [];

    if (date) { query += ` AND a.date = ?`; params.push(date); }
    if (event_id) { query += ` AND a.event_id = ?`; params.push(event_id); }
    if (grade) { query += ` AND s.grade_level = ?`; params.push(grade); }
    if (section) { query += ` AND s.section = ?`; params.push(section); }
    if (status) { query += ` AND a.status = ?`; params.push(status); }

    query += ` ORDER BY a.date DESC, a.id DESC`;
    db.all(query, params, (err, rows) => res.json(rows || []));
});

app.delete('/api/attendance/:id', requireAuth(['Administrator']), (req, res) => {
    db.run(`DELETE FROM attendance WHERE id = ?`, [req.params.id], function(err) {
        if(err) return res.status(400).json({ error: err.message });
        logAudit(req, 'Delete Attendance', `Deleted attendance record ID ${req.params.id}`);
        res.json({ success: true });
    });
});

// Analytics & Dashboard Stats
app.get('/api/analytics/dashboard', requireAuth(['Administrator']), (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    db.get(`SELECT COUNT(*) as total FROM students WHERE status = 'Active'`, [], (e, r1) => {
        db.get(`SELECT 
            SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) as present,
            SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) as late,
            SUM(CASE WHEN status = 'Excused' THEN 1 ELSE 0 END) as excused
            FROM attendance WHERE date = ?`, [today], (e, r2) => {
                
                const totalStudents = r1 ? r1.total : 0;
                const presentToday = r2 ? (r2.present || 0) : 0;
                const lateToday = r2 ? (r2.late || 0) : 0;
                const excusedToday = r2 ? (r2.excused || 0) : 0;
                const absentToday = Math.max(0, totalStudents - (presentToday + lateToday + excusedToday));
                const attendancePct = totalStudents > 0 ? (((presentToday + lateToday + excusedToday) / totalStudents) * 100).toFixed(1) : 0;

                db.all(`SELECT grade_level, COUNT(*) as count FROM students GROUP BY grade_level`, [], (e, gradeData) => {
                    db.all(`SELECT status, COUNT(*) as count FROM attendance WHERE date = ? GROUP BY status`, [today], (e, todayData) => {
                        res.json({
                            totalStudents,
                            presentToday,
                            lateToday,
                            absentToday,
                            excusedToday,
                            attendancePct,
                            gradeData,
                            todayData
                        });
                    });
                });
        });
    });
});

// Student Self Profile Portal Data
app.get('/api/student/profile/:studentId', (req, res) => {
    const studentId = req.params.studentId;
    db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, student) => {
        if (err || !student) return res.status(404).json({ error: 'Student not found.' });
        db.all(`SELECT a.*, e.event_name FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.student_id = ? ORDER BY a.date DESC`, [studentId], (err, history) => {
            db.get(`SELECT COUNT(*) as totalEvents FROM events`, [], (err, totalEv) => {
                const attended = history.length;
                const present = history.filter(h => h.status === 'Present').length;
                const late = history.filter(h => h.status === 'Late').length;
                const excused = history.filter(h => h.status === 'Excused').length;
                const total = totalEv ? totalEv.totalEvents : 1;
                const pct = total > 0 ? (((present + late + excused) / total) * 100).toFixed(1) : 0;

                res.json({
                    student,
                    history,
                    stats: { totalEvents: total, attended, present, late, excused, pct }
                });
            });
        });
    });
});

// Audit Log & Backup APIs
app.get('/api/audit-logs', requireAuth(['Administrator']), (req, res) => {
    db.all(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100`, [], (err, rows) => res.json(rows || []));
});

app.post('/api/backup', requireAuth(['Administrator']), (req, res) => {
    const backupName = `backup-${Date.now()}.db`;
    const dest = path.join(backupsDir, backupName);
    fs.copyFile(dbPath, dest, (err) => {
        if (err) return res.status(500).json({ error: 'Backup failed.' });
        logAudit(req, 'Backup Created', `File: ${backupName}`);
        res.json({ success: true, file: backupName });
    });
});

// -------------------------------------------------------------
// FRONTEND INTERFACE (HTML / CSS / JS SPA)
// -------------------------------------------------------------
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QR Attendance Management System</title>
    <!-- Tailwind CSS CDN -->
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- HTML5-QRCode Scanner Library -->
    <script src="https://unpkg.com/html5-qrcode"></script>
    <!-- QRCode JS Library -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <!-- Chart.js CDN -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        @media print {
            body * { visibility: hidden; }
            #printableArea, #printableArea * { visibility: visible; }
            #printableArea { position: absolute; left: 0; top: 0; width: 100%; }
            .no-print { display: none !important; }
        }
        .a4-page {
            width: 210mm;
            min-height: 297mm;
            padding: 10mm;
            margin: auto;
            background: white;
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            grid-gap: 8mm;
            box-sizing: border-box;
        }
        .id-card {
            width: 85.6mm;
            height: 54mm;
            border: 2px solid #1e293b;
            border-radius: 8px;
            padding: 6px;
            box-sizing: border-box;
            background: linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%);
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            position: relative;
            overflow: hidden;
            font-family: sans-serif;
        }
    </style>
</head>
<body class="bg-slate-100 text-slate-800 font-sans antialiased">

    <!-- Top Navigation Bar -->
    <nav class="bg-indigo-900 text-white shadow-lg no-print">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <div class="flex items-center space-x-3">
                    <span class="text-2xl">🎓</span>
                    <span class="font-bold text-xl tracking-wide">EduScan QR System</span>
                </div>
                <div id="navLinks" class="hidden md:flex items-center space-x-4">
                    <!-- Links inserted by JS -->
                </div>
            </div>
        </div>
    </nav>

    <!-- Main Container -->
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6" id="mainContainer">
        <!-- SPA Views Rendered Here -->
    </div>

    <!-- Printable Area for A4 IDs and Reports -->
    <div id="printableArea" class="hidden"></div>

    <!-- Application Script -->
    <script>
        // Global State
        let currentUser = null;
        let systemSettings = {};

        // Page Router
        async function navigateTo(view) {
            const container = document.getElementById('mainContainer');
            await checkAuth();

            if (view === 'login') return renderLogin(container);
            if (view === 'scanner') return renderScanner(container);

            if (!currentUser) return renderLogin(container);

            if (view === 'dashboard') renderDashboard(container);
            else if (view === 'students') renderStudents(container);
            else if (view === 'events') renderEvents(container);
            else if (view === 'attendance') renderAttendanceRecords(container);
            else if (view === 'reports') renderReports(container);
            else if (view === 'student-profile') renderStudentSelfPortal(container);
            else if (view === 'settings') renderSettings(container);
            else renderDashboard(container);

            updateNav();
        }

        async function checkAuth() {
            try {
                const res = await fetch('/api/me');
                const data = await res.json();
                currentUser = data.loggedIn ? data.user : null;
            } catch(e) { currentUser = null; }
            updateNav();
        }

        function updateNav() {
            const nav = document.getElementById('navLinks');
            if (!currentUser) {
                nav.innerHTML = \`<button onclick="navigateTo('login')" class="hover:bg-indigo-800 px-3 py-2 rounded">Login</button>
                                 <button onclick="navigateTo('scanner')" class="bg-emerald-600 hover:bg-emerald-700 px-3 py-2 rounded font-semibold">📷 Open Scanner</button>\`;
                return;
            }

            if (currentUser.role === 'Administrator') {
                nav.innerHTML = \`
                    <button onclick="navigateTo('dashboard')" class="hover:bg-indigo-800 px-3 py-2 rounded">Dashboard</button>
                    <button onclick="navigateTo('students')" class="hover:bg-indigo-800 px-3 py-2 rounded">Students</button>
                    <button onclick="navigateTo('events')" class="hover:bg-indigo-800 px-3 py-2 rounded">Events</button>
                    <button onclick="navigateTo('attendance')" class="hover:bg-indigo-800 px-3 py-2 rounded">Attendance</button>
                    <button onclick="navigateTo('reports')" class="hover:bg-indigo-800 px-3 py-2 rounded">Reports</button>
                    <button onclick="navigateTo('settings')" class="hover:bg-indigo-800 px-3 py-2 rounded">Settings</button>
                    <button onclick="navigateTo('scanner')" class="bg-emerald-600 hover:bg-emerald-700 px-3 py-2 rounded font-semibold">📷 Scanner</button>
                    <button onclick="logout()" class="bg-red-600 hover:bg-red-700 px-3 py-2 rounded">Logout</button>
                \`;
            } else if (currentUser.role === 'Student') {
                nav.innerHTML = \`
                    <button onclick="navigateTo('student-profile')" class="hover:bg-indigo-800 px-3 py-2 rounded">My Attendance Profile</button>
                    <button onclick="logout()" class="bg-red-600 hover:bg-red-700 px-3 py-2 rounded">Logout</button>
                \`;
            } else {
                nav.innerHTML = \`
                    <button onclick="navigateTo('scanner')" class="bg-emerald-600 hover:bg-emerald-700 px-3 py-2 rounded font-semibold">📷 Scanner Portal</button>
                    <button onclick="logout()" class="bg-red-600 hover:bg-red-700 px-3 py-2 rounded">Logout</button>
                \`;
            }
        }

        async function logout() {
            await fetch('/api/logout', { method: 'POST' });
            currentUser = null;
            navigateTo('login');
        }

        // VIEW 1: LOGIN
        function renderLogin(container) {
            container.innerHTML = \`
                <div class="max-w-md mx-auto bg-white p-8 rounded-xl shadow-md mt-12 border border-slate-200">
                    <h2 class="text-2xl font-bold text-center text-slate-800 mb-6">Portal Access Login</h2>
                    <form id="loginForm" class="space-y-4">
                        <div>
                            <label class="block text-sm font-medium text-slate-700">Username / Student ID</label>
                            <input type="text" id="loginUsername" required class="w-full mt-1 p-2 border rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-slate-700">Password</label>
                            <input type="password" id="loginPassword" required class="w-full mt-1 p-2 border rounded-lg focus:ring-2 focus:ring-indigo-500">
                        </div>
                        <button type="submit" class="w-full bg-indigo-600 text-white py-2 rounded-lg font-semibold hover:bg-indigo-700">Log In</button>
                    </form>
                    <div class="mt-6 pt-4 border-t text-center">
                        <button onclick="navigateTo('scanner')" class="text-emerald-600 font-semibold hover:underline">Access Public Scanner Portal →</button>
                    </div>
                </div>
            \`;

            document.getElementById('loginForm').onsubmit = async (e) => {
                e.preventDefault();
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: document.getElementById('loginUsername').value,
                        password: document.getElementById('loginPassword').value
                    })
                });
                const data = await res.json();
                if (data.success) {
                    await checkAuth();
                    if (data.role === 'Student') navigateTo('student-profile');
                    else if (data.role === 'Scanner User') navigateTo('scanner');
                    else navigateTo('dashboard');
                } else {
                    alert(data.error || 'Login failed.');
                }
            };
        }

        // VIEW 2: DASHBOARD
        async function renderDashboard(container) {
            const res = await fetch('/api/analytics/dashboard');
            const data = await res.json();

            container.innerHTML = \`
                <div class="space-y-6">
                    <div class="flex justify-between items-center">
                        <h1 class="text-3xl font-bold text-slate-800">Admin Dashboard</h1>
                        <span class="text-slate-500 text-sm">\${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
                    </div>

                    <!-- Metric Cards -->
                    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-indigo-500">
                            <p class="text-xs text-slate-500 uppercase font-bold">Total Students</p>
                            <p class="text-2xl font-black mt-1 text-slate-800">\${data.totalStudents}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-emerald-500">
                            <p class="text-xs text-slate-500 uppercase font-bold">Present Today</p>
                            <p class="text-2xl font-black mt-1 text-emerald-600">\${data.presentToday}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-amber-500">
                            <p class="text-xs text-slate-500 uppercase font-bold">Late Today</p>
                            <p class="text-2xl font-black mt-1 text-amber-600">\${data.lateToday}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-rose-500">
                            <p class="text-xs text-slate-500 uppercase font-bold">Absent Today</p>
                            <p class="text-2xl font-black mt-1 text-rose-600">\${data.absentToday}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-blue-500">
                            <p class="text-xs text-slate-500 uppercase font-bold">Excused Today</p>
                            <p class="text-2xl font-black mt-1 text-blue-600">\${data.excusedToday}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow border-l-4 border-teal-500">
                            <p class="text-xs text-slate-500 uppercase font-bold">Attendance Rate</p>
                            <p class="text-2xl font-black mt-1 text-teal-600">\${data.attendancePct}%</p>
                        </div>
                    </div>

                    <!-- Quick Actions -->
                    <div class="bg-white p-4 rounded-xl shadow flex flex-wrap gap-3">
                        <button onclick="navigateTo('students')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">+ Register Student</button>
                        <button onclick="navigateTo('events')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">+ Create Event</button>
                        <button onclick="navigateTo('scanner')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">📷 Open Scanner Portal</button>
                        <button onclick="printBatchIDs()" class="bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-semibold">🖨️ Print Batch A4 IDs</button>
                    </div>

                    <!-- Charts & Live Feed Grid -->
                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div class="bg-white p-5 rounded-xl shadow lg:col-span-2">
                            <h3 class="text-lg font-bold text-slate-800 mb-4">Grade Level Distribution</h3>
                            <canvas id="gradeChart" class="max-h-64"></canvas>
                        </div>
                        <div class="bg-white p-5 rounded-xl shadow">
                            <h3 class="text-lg font-bold text-slate-800 mb-4">Live Attendance Feed</h3>
                            <div id="liveFeed" class="space-y-3 max-h-80 overflow-y-auto">
                                <p class="text-slate-400 text-sm">Waiting for live scans...</p>
                            </div>
                        </div>
                    </div>
                </div>
            \`;

            // Render Chart
            const ctx = document.getElementById('gradeChart').getContext('2d');
            new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data.gradeData.map(g => g.grade_level),
                    datasets: [{
                        label: 'Students',
                        data: data.gradeData.map(g => g.count),
                        backgroundColor: '#4f46e5'
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false }
            });

            // Poll Live Feed
            setInterval(async () => {
                const fRes = await fetch('/api/attendance/recent');
                const feeds = await fRes.json();
                const feedContainer = document.getElementById('liveFeed');
                if (feedContainer && feeds.length > 0) {
                    feedContainer.innerHTML = feeds.map(f => \`
                        <div class="flex items-center space-x-3 p-2 bg-slate-50 rounded-lg border">
                            <img src="\${f.photo_url}" class="w-10 h-10 rounded-full object-cover">
                            <div class="flex-1 text-xs">
                                <p class="font-bold text-slate-800">\${f.full_name}</p>
                                <p class="text-slate-500">\${f.grade_level} - \${f.section} | \${f.time_in || f.time_out}</p>
                            </div>
                            <span class="px-2 py-1 rounded-full text-xs font-bold \${f.status === 'Present' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">\${f.status}</span>
                        </div>
                    \`).join('');
                }
            }, 3000);
        }

        // VIEW 3: SEPARATE DEDICATED SCANNER PORTAL
        async function renderScanner(container) {
            const evRes = await fetch('/api/events');
            const events = await evRes.json();
            const activeEvents = events.filter(e => e.status === 'Active');

            container.innerHTML = \`
                <div class="max-w-2xl mx-auto space-y-4">
                    <div class="bg-slate-900 text-white p-4 rounded-xl shadow flex justify-between items-center">
                        <div>
                            <h2 class="text-xl font-bold">QR Attendance Scanner Portal</h2>
                            <p class="text-xs text-slate-400">● Live Camera Detection Ready</p>
                        </div>
                        <div class="flex items-center space-x-2">
                            <button id="scanModeBtn" onclick="toggleScanMode()" class="bg-emerald-500 text-white font-bold text-sm px-3 py-1.5 rounded">Mode: TIME IN</button>
                        </div>
                    </div>

                    <!-- Event Picker -->
                    <div class="bg-white p-4 rounded-xl shadow">
                        <label class="block text-sm font-bold text-slate-700 mb-1">Select Active Attendance Event:</label>
                        <select id="scannerEventId" class="w-full p-2 border rounded-lg bg-slate-50 font-semibold">
                            \${activeEvents.map(e => \`<option value="\${e.id}">\${e.event_name} (\${e.attendance_type})</option>\`).join('')}
                        </select>
                    </div>

                    <!-- Camera Viewport -->
                    <div class="bg-white p-4 rounded-xl shadow text-center relative overflow-hidden">
                        <div id="reader" class="w-full h-64 bg-black rounded-lg"></div>
                        <div id="scanResultCard" class="hidden absolute inset-0 bg-white p-6 flex flex-col items-center justify-center space-y-3 z-10">
                            <!-- Live Scan Overlay -->
                        </div>
                    </div>
                </div>
            \`;

            let scanMode = 'IN';
            window.toggleScanMode = () => {
                scanMode = scanMode === 'IN' ? 'OUT' : 'IN';
                const btn = document.getElementById('scanModeBtn');
                btn.innerText = 'Mode: TIME ' + scanMode;
                btn.className = scanMode === 'IN' ? 'bg-emerald-500 text-white font-bold text-sm px-3 py-1.5 rounded' : 'bg-amber-500 text-white font-bold text-sm px-3 py-1.5 rounded';
            };

            // HTML5 QRCode Scanner Setup
            const html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: { width: 220, height: 220 } }, false);
            
            async function onScanSuccess(decodedText) {
                const eventId = document.getElementById('scannerEventId').value;
                if (!eventId) return alert('Please select an active event first.');

                html5QrcodeScanner.pause();

                const res = await fetch('/api/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_mode: scanMode })
                });

                const data = await res.json();
                speakAnnouncement(data.message);
                showScanOverlay(data);

                setTimeout(() => {
                    document.getElementById('scanResultCard').classList.add('hidden');
                    html5QrcodeScanner.resume();
                }, 3500);
            }

            html5QrcodeScanner.render(onScanSuccess, () => {});
        }

        // Web Speech API Voice Announcement Engine
        function speakAnnouncement(text) {
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.rate = 0.9;
                utterance.pitch = 1.0;
                window.speechSynthesis.speak(utterance);
            }
        }

        function showScanOverlay(data) {
            const card = document.getElementById('scanResultCard');
            card.classList.remove('hidden');

            if (data.status === 'SUCCESS') {
                card.innerHTML = \`
                    <div class="text-5xl">✅</div>
                    <img src="\${data.student.photo_url}" class="w-20 h-20 rounded-full object-cover border-4 border-emerald-500">
                    <h3 class="text-xl font-bold text-slate-800">\${data.student.full_name}</h3>
                    <p class="text-slate-500 text-sm">\${data.student.student_id} | \${data.student.grade_level} - \${data.student.section}</p>
                    <span class="bg-emerald-100 text-emerald-800 font-bold px-3 py-1 rounded-full text-sm">\${data.type} RECORDED (\${data.time}) - \${data.attStatus}</span>
                \`;
            } else {
                card.innerHTML = \`
                    <div class="text-5xl">⚠️</div>
                    <h3 class="text-xl font-bold text-rose-600">Scan Warning</h3>
                    <p class="text-slate-700 font-semibold text-center">\${data.message}</p>
                \`;
            }
        }

        // VIEW 4: STUDENTS MANAGEMENT
        async function renderStudents(container) {
            const res = await fetch('/api/students');
            const students = await res.json();

            container.innerHTML = \`
                <div class="space-y-6">
                    <div class="flex justify-between items-center">
                        <h1 class="text-2xl font-bold text-slate-800">Student Directory</h1>
                        <button onclick="showRegisterModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold">+ Register New Student</button>
                    </div>

                    <div class="bg-white rounded-xl shadow overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-slate-50 border-b text-xs text-slate-500 uppercase">
                                    <th class="p-4">Student ID</th>
                                    <th class="p-4">Full Name</th>
                                    <th class="p-4">Grade & Section</th>
                                    <th class="p-4">QR Token</th>
                                    <th class="p-4">Status</th>
                                    <th class="p-4">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y">
                                \${students.map(s => \`
                                    <tr class="hover:bg-slate-50">
                                        <td class="p-4 font-bold text-indigo-600">\${s.student_id}</td>
                                        <td class="p-4 flex items-center space-x-3">
                                            <img src="\${s.photo_url}" class="w-8 h-8 rounded-full object-cover">
                                            <span>\${s.full_name}</span>
                                        </td>
                                        <td class="p-4">\${s.grade_level} - \${s.section}</td>
                                        <td class="p-4 text-xs font-mono text-slate-500">\${s.qr_token}</td>
                                        <td class="p-4"><span class="px-2 py-1 bg-emerald-100 text-emerald-800 text-xs font-bold rounded-full">\${s.status}</span></td>
                                        <td class="p-4 space-x-2">
                                            <button onclick="viewSingleID('\${s.student_id}')" class="text-indigo-600 font-bold hover:underline">Digital ID</button>
                                            <button onclick="regenerateQR('\${s.id}')" class="text-amber-600 font-bold hover:underline">Regen QR</button>
                                        </td>
                                    </tr>
                                \`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Registration Modal -->
                <div id="regModal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div class="bg-white rounded-xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
                        <h2 class="text-xl font-bold">Register Student</h2>
                        <form id="regForm" class="grid grid-cols-2 gap-4">
                            <input type="text" name="student_id" placeholder="Student ID (e.g. 2026-001)" required class="p-2 border rounded">
                            <input type="text" name="first_name" placeholder="First Name" required class="p-2 border rounded">
                            <input type="text" name="middle_name" placeholder="Middle Name" class="p-2 border rounded">
                            <input type="text" name="last_name" placeholder="Last Name" required class="p-2 border rounded">
                            
                            <select name="grade_level" required class="p-2 border rounded">
                                <option value="Grade 7">Grade 7</option>
                                <option value="Grade 8">Grade 8</option>
                                <option value="Grade 9">Grade 9</option>
                                <option value="Grade 10">Grade 10</option>
                                <option value="Grade 11">Grade 11</option>
                                <option value="Grade 12">Grade 12</option>
                            </select>
                            
                            <input type="text" name="section" placeholder="Section (e.g. STEM-A)" required class="p-2 border rounded">
                            <select name="gender" class="p-2 border rounded"><option>Male</option><option>Female</option></select>
                            <input type="date" name="dob" class="p-2 border rounded">
                            <input type="text" name="contact" placeholder="Contact Number" class="p-2 border rounded">
                            <input type="email" name="email" placeholder="Email Address" class="p-2 border rounded">
                            <input type="text" name="guardian_name" placeholder="Guardian Name" class="p-2 border rounded">
                            <input type="text" name="guardian_contact" placeholder="Guardian Contact" class="p-2 border rounded">
                            <input type="text" name="school_year" value="2026-2027" class="p-2 border rounded">
                            <div class="col-span-2">
                                <label class="block text-sm font-semibold">Student Photo</label>
                                <input type="file" name="photo" accept="image/*" class="p-1 border rounded w-full">
                            </div>
                            <div class="col-span-2 flex justify-end space-x-2 pt-4">
                                <button type="button" onclick="closeRegisterModal()" class="px-4 py-2 bg-slate-200 rounded">Cancel</button>
                                <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded font-bold">Save Student</button>
                            </div>
                        </form>
                    </div>
                </div>
            \`;

            window.showRegisterModal = () => document.getElementById('regModal').classList.remove('hidden');
            window.closeRegisterModal = () => document.getElementById('regModal').classList.add('hidden');

            document.getElementById('regForm').onsubmit = async (e) => {
                e.preventDefault();
                const formData = new FormData(e.target);
                const res = await fetch('/api/students', { method: 'POST', body: formData });
                if (res.ok) {
                    closeRegisterModal();
                    renderStudents(container);
                } else alert('Failed to register student.');
            };
        }

        window.regenerateQR = async (id) => {
            if (confirm('Regenerating QR will invalidate previous printed IDs. Proceed?')) {
                await fetch(\`/api/students/\${id}/regenerate-qr\`, { method: 'POST' });
                alert('QR Code Regenerated successfully.');
                navigateTo('students');
            }
        };

        // BATCH A4 8-ID PRINTING ENGINE
        async function printBatchIDs() {
            const res = await fetch('/api/students');
            const students = await res.json();
            const setRes = await fetch('/api/settings');
            const settings = await setRes.json();

            const printArea = document.getElementById('printableArea');
            printArea.innerHTML = '';
            printArea.classList.remove('hidden');

            let pageHTML = '';
            for (let i = 0; i < students.length; i += 8) {
                const pageStudents = students.slice(i, i + 8);
                pageHTML += \`<div class="a4-page">\`;
                
                for (const s of pageStudents) {
                    pageHTML += \`
                        <div class="id-card">
                            <div class="flex items-center space-x-2 border-b pb-1">
                                <span class="text-xl">🏫</span>
                                <div>
                                    <h4 class="font-bold text-xs uppercase leading-tight text-indigo-900">\${settings.school_name || 'Global Academy'}</h4>
                                    <p class="text-[8px] text-slate-500">Student Identification Card</p>
                                </div>
                            </div>
                            <div class="flex items-center space-x-2 my-1">
                                <img src="\${s.photo_url}" class="w-14 h-14 rounded object-cover border">
                                <div class="text-[10px] space-y-0.5">
                                    <p class="font-bold text-slate-900">\${s.full_name}</p>
                                    <p class="text-slate-600">ID: <strong>\${s.student_id}</strong></p>
                                    <p class="text-slate-600">\${s.grade_level} - \${s.section}</p>
                                    <p class="text-slate-500 text-[8px]">SY: \${s.school_year}</p>
                                </div>
                            </div>
                            <div class="flex justify-between items-end border-t pt-1">
                                <div class="text-[7px] text-slate-400">Official Student Pass</div>
                                <div id="qr-target-\${s.id}" class="w-10 h-10"></div>
                            </div>
                        </div>
                    \`;
                }
                pageHTML += \`</div>\`;
            }

            printArea.innerHTML = pageHTML;

            // Generate QR elements dynamically into HTML
            for (const s of students) {
                const el = document.getElementById(\`qr-target-\${s.id}\`);
                if (el) {
                    new QRCode(el, { text: s.qr_token, width: 40, height: 40 });
                }
            }

            setTimeout(() => {
                window.print();
                printArea.classList.add('hidden');
            }, 500);
        }

        // VIEW 5: EVENTS MANAGEMENT
        async function renderEvents(container) {
            const res = await fetch('/api/events');
            const events = await res.json();

            container.innerHTML = \`
                <div class="space-y-6">
                    <div class="flex justify-between items-center">
                        <h1 class="text-2xl font-bold text-slate-800">Event Management</h1>
                        <button onclick="showEventModal()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold">+ Create Event</button>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        \${events.map(e => \`
                            <div class="bg-white p-5 rounded-xl shadow border-t-4 \${e.status === 'Active' ? 'border-emerald-500' : 'border-slate-400'}">
                                <div class="flex justify-between items-start">
                                    <h3 class="font-bold text-lg text-slate-800">\${e.event_name}</h3>
                                    <span class="px-2 py-0.5 text-xs font-bold rounded \${e.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100'}">\${e.status}</span>
                                </div>
                                <p class="text-xs text-slate-500 mt-1">\${e.description || 'No description'}</p>
                                <div class="mt-4 text-xs space-y-1 text-slate-600 border-t pt-2">
                                    <p>📅 Date: <strong>\${e.event_date}</strong> (\${e.start_time} - \${e.end_time})</p>
                                    <p>📍 Location: \${e.location}</p>
                                    <p>🎯 Allowed: \${e.allowed_grade}</p>
                                </div>
                            </div>
                        \`).join('')}
                    </div>
                </div>

                <!-- Event Modal -->
                <div id="eventModal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div class="bg-white rounded-xl max-w-md w-full p-6 space-y-4">
                        <h2 class="text-xl font-bold">Create Attendance Event</h2>
                        <form id="eventForm" class="space-y-3">
                            <input type="text" name="event_name" placeholder="Event Name" required class="w-full p-2 border rounded">
                            <textarea name="description" placeholder="Description" class="w-full p-2 border rounded"></textarea>
                            <input type="date" name="event_date" required class="w-full p-2 border rounded">
                            <div class="grid grid-cols-2 gap-2">
                                <input type="time" name="start_time" required class="p-2 border rounded">
                                <input type="time" name="end_time" required class="p-2 border rounded">
                            </div>
                            <input type="text" name="location" placeholder="Location" class="w-full p-2 border rounded">
                            <input type="text" name="organizer" placeholder="Organizer" class="w-full p-2 border rounded">
                            <select name="status" class="w-full p-2 border rounded">
                                <option value="Active">Active</option>
                                <option value="Upcoming">Upcoming</option>
                            </select>
                            <div class="flex justify-end space-x-2 pt-2">
                                <button type="button" onclick="closeEventModal()" class="px-4 py-2 bg-slate-200 rounded">Cancel</button>
                                <button type="submit" class="px-4 py-2 bg-blue-600 text-white rounded font-bold">Save Event</button>
                            </div>
                        </form>
                    </div>
                </div>
            \`;

            window.showEventModal = () => document.getElementById('eventModal').classList.remove('hidden');
            window.closeEventModal = () => document.getElementById('eventModal').classList.add('hidden');

            document.getElementById('eventForm').onsubmit = async (e) => {
                e.preventDefault();
                const formData = new FormData(e.target);
                const data = Object.fromEntries(formData.entries());
                data.attendance_type = 'Special Event';
                data.allowed_grade = 'All';

                const res = await fetch('/api/events', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                if (res.ok) {
                    closeEventModal();
                    renderEvents(container);
                }
            };
        }

        // VIEW 6: ATTENDANCE RECORDS & REPORTS
        async function renderAttendanceRecords(container) {
            const res = await fetch('/api/attendance');
            const records = await res.json();

            container.innerHTML = \`
                <div class="space-y-6">
                    <h1 class="text-2xl font-bold text-slate-800">Attendance Log Records</h1>
                    <div class="bg-white rounded-xl shadow overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-slate-50 border-b text-xs text-slate-500 uppercase">
                                    <th class="p-4">Student</th>
                                    <th class="p-4">Event</th>
                                    <th class="p-4">Date</th>
                                    <th class="p-4">Time In</th>
                                    <th class="p-4">Time Out</th>
                                    <th class="p-4">Status</th>
                                    <th class="p-4">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y">
                                \${records.map(r => \`
                                    <tr class="hover:bg-slate-50">
                                        <td class="p-4 font-bold">\${r.full_name} <br><span class="text-xs text-slate-400">\${r.student_id}</span></td>
                                        <td class="p-4 text-sm">\${r.event_name}</td>
                                        <td class="p-4 text-sm">\${r.date}</td>
                                        <td class="p-4 text-sm font-mono">\${r.time_in || '-'}</td>
                                        <td class="p-4 text-sm font-mono">\${r.time_out || '-'}</td>
                                        <td class="p-4"><span class="px-2 py-1 text-xs font-bold rounded-full \${r.status === 'Present' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">\${r.status}</span></td>
                                        <td class="p-4"><button onclick="deleteRecord('\${r.id}')" class="text-rose-600 text-xs font-bold hover:underline">Delete</button></td>
                                    </tr>
                                \`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            \`;

            window.deleteRecord = async (id) => {
                if (confirm('Delete this record?')) {
                    await fetch(\`/api/attendance/\${id}\`, { method: 'DELETE' });
                    renderAttendanceRecords(container);
                }
            };
        }

        // VIEW 7: STUDENT SELF PROFILE PORTAL
        async function renderStudentSelfPortal(container) {
            const res = await fetch(\`/api/student/profile/\${currentUser.username}\`);
            const data = await res.json();
            const s = data.student;

            container.innerHTML = \`
                <div class="max-w-4xl mx-auto space-y-6">
                    <div class="bg-white p-6 rounded-xl shadow flex items-center space-x-6">
                        <img src="\${s.photo_url}" class="w-24 h-24 rounded-full object-cover border-4 border-indigo-600">
                        <div class="space-y-1">
                            <h2 class="text-2xl font-bold text-slate-800">\${s.full_name}</h2>
                            <p class="text-slate-500 font-semibold">\${s.student_id} | \${s.grade_level} - \${s.section}</p>
                            <p class="text-xs text-slate-400">School Year: \${s.school_year}</p>
                        </div>
                    </div>

                    <div class="grid grid-cols-4 gap-4">
                        <div class="bg-white p-4 rounded-xl shadow text-center">
                            <p class="text-xs text-slate-500 font-bold">Attended</p>
                            <p class="text-2xl font-black text-indigo-600">\${data.stats.attended}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow text-center">
                            <p class="text-xs text-slate-500 font-bold">Present</p>
                            <p class="text-2xl font-black text-emerald-600">\${data.stats.present}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow text-center">
                            <p class="text-xs text-slate-500 font-bold">Late</p>
                            <p class="text-2xl font-black text-amber-600">\${data.stats.late}</p>
                        </div>
                        <div class="bg-white p-4 rounded-xl shadow text-center">
                            <p class="text-xs text-slate-500 font-bold">Attendance %</p>
                            <p class="text-2xl font-black text-teal-600">\${data.stats.pct}%</p>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-xl shadow">
                        <h3 class="font-bold text-lg text-slate-800 mb-4">My Attendance History</h3>
                        <div class="space-y-3">
                            \${data.history.map(h => \`
                                <div class="flex justify-between items-center border-b pb-2">
                                    <div>
                                        <p class="font-bold text-slate-800 text-sm">\${h.event_name}</p>
                                        <p class="text-xs text-slate-400">\${h.date} | In: \${h.time_in || '-'} | Out: \${h.time_out || '-'}</p>
                                    </div>
                                    <span class="px-2 py-1 text-xs font-bold rounded-full \${h.status === 'Present' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">\${h.status}</span>
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                </div>
            \`;
        }

        // VIEW 8: SYSTEM SETTINGS & BACKUP
        async function renderSettings(container) {
            const res = await fetch('/api/settings');
            const settings = await res.json();

            container.innerHTML = \`
                <div class="max-w-2xl mx-auto space-y-6">
                    <h1 class="text-2xl font-bold text-slate-800">System Configuration & Backup</h1>
                    
                    <div class="bg-white p-6 rounded-xl shadow space-y-4">
                        <h3 class="font-bold text-slate-700">General Settings</h3>
                        <form id="settingsForm" class="space-y-3">
                            <div>
                                <label class="block text-sm font-semibold">School Name</label>
                                <input type="text" name="school_name" value="\${settings.school_name || ''}" class="w-full p-2 border rounded">
                            </div>
                            <div>
                                <label class="block text-sm font-semibold">Late Threshold Time</label>
                                <input type="time" name="late_threshold" value="\${settings.late_threshold || '07:30'}" class="w-full p-2 border rounded">
                            </div>
                            <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded font-bold">Save Settings</button>
                        </form>
                    </div>

                    <div class="bg-white p-6 rounded-xl shadow space-y-4">
                        <h3 class="font-bold text-slate-700">Database Backup</h3>
                        <button onclick="triggerBackup()" class="bg-emerald-600 text-white px-4 py-2 rounded font-bold">Create SQLite Backup</button>
                    </div>
                </div>
            \`;

            document.getElementById('settingsForm').onsubmit = async (e) => {
                e.preventDefault();
                const formData = new FormData(e.target);
                const data = Object.fromEntries(formData.entries());
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                alert('Settings saved.');
            };

            window.triggerBackup = async () => {
                const res = await fetch('/api/backup', { method: 'POST' });
                const data = await res.json();
                if (data.success) alert('Backup created: ' + data.file);
            };
        }

        // INITIAL ROUTE
        navigateTo('dashboard');
    </script>
</body>
</html>
    `);
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`  🎓 QR Attendance System Server Running!`);
    console.log(`  Local URL:   http://localhost:${PORT}`);
    console.log(`  Scanner URL: http://localhost:${PORT}/scanner`);
    console.log(`===================================================`);
});
