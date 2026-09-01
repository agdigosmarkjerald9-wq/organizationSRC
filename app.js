const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Directory Setup
const uploadsDir = path.join(__dirname, 'public', 'uploads');
const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'super-secret-key-change-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// File Upload Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) return cb(null, true);
        cb(new Error('Only PNG, JPG, JPEG, and WEBP files are allowed.'));
    }
});

// Database Initialization
const dbPath = path.join(__dirname, 'school_club_attendance.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected to SQLite Database.');
});

db.serialize(() => {
    db.run("PRAGMA foreign_keys = ON");
    
    // Core Tables
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('ADMIN', 'SCANNER', 'STUDENT')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE NOT NULL,
        student_number TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        position_id INTEGER NOT NULL,
        photo_path TEXT NOT NULL,
        qr_token TEXT UNIQUE NOT NULL,
        qr_enabled INTEGER DEFAULT 1,
        membership_status TEXT DEFAULT 'Active' CHECK(membership_status IN ('Active','Inactive','Suspended','Alumni','Resigned')),
        date_joined DATE DEFAULT CURRENT_DATE,
        expiration_date DATE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(position_id) REFERENCES positions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS position_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        position_name TEXT NOT NULL,
        school_year TEXT NOT NULL,
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL,
        position_id INTEGER NOT NULL,
        contact_number TEXT,
        photo_path TEXT NOT NULL,
        status TEXT DEFAULT 'Pending' CHECK(status IN ('Pending', 'Approved', 'Rejected')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(position_id) REFERENCES positions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        location TEXT,
        organizer TEXT,
        late_threshold INTEGER DEFAULT 10,
        status TEXT DEFAULT 'Upcoming' CHECK(status IN ('Upcoming', 'Active', 'Completed', 'Cancelled')),
        participant_positions TEXT DEFAULT 'ALL'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        scanned_by INTEGER NOT NULL,
        time_in DATETIME,
        time_out DATETIME,
        status TEXT NOT NULL CHECK(status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
        excused_reason TEXT,
        excused_notes TEXT,
        approved_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, event_id),
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY(scanned_by) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Default Seed Data
    const defaultSettings = [
        ['school_name', 'Default High School'],
        ['school_address', '123 Education Ave'],
        ['school_contact', '555-0199'],
        ['school_email', 'info@school.edu'],
        ['school_year', '2026-2027'],
        ['club_name', 'Computer Science Club'],
        ['club_adviser', 'Prof. Alan Turing'],
        ['org_name', 'Student Tech Alliance'],
        ['registration_enabled', '1'],
        ['student_number_prefix', 'SC-'],
        ['student_number_year', '2026'],
        ['student_number_start', '1'],
        ['student_number_length', '6'],
        ['late_threshold_default', '10'],
        ['min_participation_rate', '75'],
        ['school_logo', ''],
        ['club_logo', '']
    ];
    defaultSettings.forEach(([k, v]) => {
        db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
    });

    const defaultPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor', 'Public Information Officer', 'Peace Officer', 'Representative', 'Member'];
    defaultPositions.forEach(pos => {
        db.run(`INSERT OR IGNORE INTO positions (name) VALUES (?)`, [pos]);
    });

    // Default Admin Initialization
    db.get(`SELECT * FROM users WHERE username = 'admin'`, async (err, row) => {
        if (!row) {
            const hash = await bcrypt.hash('admin123', 10);
            db.run(`INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'ADMIN')`, [hash]);
        }
    });
});

// Helper Functions
function logAudit(username, action, details) {
    db.run(`INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)`, [username || 'System', action, details]);
}

function generateStudentNumber(cb) {
    db.all(`SELECT key, value FROM settings WHERE key LIKE 'student_number_%'`, (err, rows) => {
        if (err) return cb(err);
        const map = {};
        rows.forEach(r => map[r.key] = r.value);
        const prefix = map.student_number_prefix || 'SC-';
        const year = map.student_number_year || '2026';
        let start = parseInt(map.student_number_start || '1');
        const length = parseInt(map.student_number_length || '6');

        db.get(`SELECT COUNT(*) as count FROM students`, (err, res) => {
            if (err) return cb(err);
            const nextNum = start + res.count;
            const padded = String(nextNum).padStart(length, '0');
            cb(null, `${prefix}${year}-${padded}`);
        });
    });
}

// Authentication Middlewares
function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session.user || !roles.includes(req.session.user.role)) {
            return res.status(403).send('Forbidden: Insufficient Permissions');
        }
        next();
    };
}

// Layout Helper Engine
function renderBaseUI(title, content, user = null, settings = {}) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ${settings.club_name || 'Club Attendance'}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background-color: #f4f6f9; color: #333; display: flex; flex-direction: column; min-height: 100vh; }
        header { background: #1a252f; color: #fff; padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; }
        header .brand { display: flex; align-items: center; gap: 15px; }
        header img { height: 40px; border-radius: 4px; background: #fff; padding: 2px; }
        nav { background: #2c3e50; padding: 0.5rem 2rem; display: flex; gap: 15px; overflow-x: auto; }
        nav a { color: #ecf0f1; text-decoration: none; padding: 6px 12px; border-radius: 4px; font-size: 0.9rem; white-space: nowrap; }
        nav a:hover, nav a.active { background: #34495e; color: #3498db; }
        main { flex: 1; padding: 2rem; max-width: 1400px; margin: 0 auto; width: 100%; }
        .card { background: #fff; border-radius: 8px; padding: 1.5rem; box-shadow: 0 2px 4px rgba(0,0,0,0.05); margin-bottom: 1.5rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; }
        .stat-card { background: #fff; border-left: 4px solid #3498db; padding: 1.2rem; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .stat-card h3 { font-size: 0.85rem; color: #7f8c8d; text-transform: uppercase; }
        .stat-card p { font-size: 1.8rem; font-weight: bold; color: #2c3e50; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; color: #2c3e50; font-weight: 600; }
        .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; text-decoration: none; display: inline-block; background: #3498db; color: white; }
        .btn:hover { background: #2980b9; }
        .btn-danger { background: #e74c3c; } .btn-danger:hover { background: #c0392b; }
        .btn-success { background: #2ecc71; } .btn-success:hover { background: #27ae60; }
        .btn-warning { background: #f39c12; } .btn-warning:hover { background: #d35400; }
        .form-group { margin-bottom: 1rem; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: 600; font-size: 0.9rem; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; color: #fff; }
        .badge-success { background: #2ecc71; } .badge-warning { background: #f39c12; } .badge-danger { background: #e74c3c; } .badge-info { background: #3498db; }
        footer { background: #1a252f; color: #7f8c8d; text-align: center; padding: 1rem; font-size: 0.85rem; margin-top: auto; }
        @media print { nav, header, .no-print { display: none !important; } main { padding: 0; } .card { box-shadow: none; border: none; } }
    </style>
</head>
<body>
    <header>
        <div class="brand">
            ${settings.school_logo ? `<img src="${settings.school_logo}" alt="School Logo">` : ''}
            ${settings.club_logo ? `<img src="${settings.club_logo}" alt="Club Logo">` : ''}
            <div>
                <h1 style="font-size: 1.2rem;">${settings.school_name || 'School System'}</h1>
                <h2 style="font-size: 0.9rem; font-weight: normal; color: #bdc3c7;">${settings.club_name || 'Student Club'}</h2>
            </div>
        </div>
        ${user ? `<div class="no-print"><span>${user.username} (${user.role})</span> | <a href="/logout" style="color: #e74c3c; text-decoration: none; margin-left: 10px;">Logout</a></div>` : ''}
    </header>
    ${user ? `
    <nav class="no-print">
        ${user.role === 'ADMIN' ? `
            <a href="/admin/dashboard">Dashboard</a>
            <a href="/admin/students">Students</a>
            <a href="/admin/registrations">Registrations</a>
            <a href="/admin/positions">Positions</a>
            <a href="/admin/events">Events</a>
            <a href="/admin/attendance">Attendance</a>
            <a href="/admin/reports">Reports</a>
            <a href="/scanner">Scanner Portal</a>
            <a href="/admin/users">System Users</a>
            <a href="/admin/settings">Settings</a>
            <a href="/admin/backup">Backup & Audit</a>
        ` : ''}
        ${user.role === 'SCANNER' ? `<a href="/scanner">Scanner Console</a>` : ''}
        ${user.role === 'STUDENT' ? `<a href="/member">Student Portal</a>` : ''}
        <a href="/change-password">Change Password</a>
    </nav>` : ''}
    <main>${content}</main>
    <footer>&copy; ${new Date().getFullYear()} ${settings.school_name || 'School'} - ${settings.club_name || 'Club System'}. All Rights Reserved.</footer>
</body>
</html>`;
}

// Global Middleware for Settings
app.use((req, res, next) => {
    db.all(`SELECT key, value FROM settings`, (err, rows) => {
        req.appSettings = {};
        if (rows) rows.forEach(r => req.appSettings[r.key] = r.value);
        next();
    });
});

// Authentication Routes
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
    if (req.session.user) {
        if (req.session.user.role === 'ADMIN') return res.redirect('/admin/dashboard');
        if (req.session.user.role === 'SCANNER') return res.redirect('/scanner');
        if (req.session.user.role === 'STUDENT') return res.redirect('/member');
    }
    const html = `
    <div style="max-width: 400px; margin: 80px auto;" class="card">
        <h2 style="text-align: center; margin-bottom: 1.5rem;">System Login</h2>
        ${req.query.err ? `<div style="color:red; margin-bottom: 10px; text-align:center;">${req.query.err}</div>` : ''}
        <form action="/login" method="POST">
            <div class="form-group">
                <label>Username</label>
                <input type="text" name="username" required autofocus>
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" name="password" required>
            </div>
            <button type="submit" class="btn" style="width:100%;">LOGIN</button>
        </form>
        <div style="text-align: center; margin-top: 15px;">
            <a href="/register" style="font-size: 0.85rem; color: #3498db;">Public Student Registration</a>
        </div>
    </div>`;
    res.send(renderBaseUI('Login', html, null, req.appSettings));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.redirect('/login?err=Invalid Username or Password');
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.redirect('/login?err=Invalid Username or Password');

        req.session.user = { id: user.id, username: user.username, role: user.role };
        logAudit(user.username, 'LOGIN', 'User logged in');

        if (user.role === 'ADMIN') res.redirect('/admin/dashboard');
        else if (user.role === 'SCANNER') res.redirect('/scanner');
        else if (user.role === 'STUDENT') res.redirect('/member');
        else res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    if (req.session.user) logAudit(req.session.user.username, 'LOGOUT', 'User logged out');
    req.session.destroy(() => res.redirect('/login'));
});

app.get('/change-password', requireAuth, (req, res) => {
    const html = `
    <div style="max-width: 500px; margin: 40px auto;" class="card">
        <h2>Change Password</h2>
        ${req.query.msg ? `<div style="color:green; margin-top:10px;">${req.query.msg}</div>` : ''}
        ${req.query.err ? `<div style="color:red; margin-top:10px;">${req.query.err}</div>` : ''}
        <form action="/change-password" method="POST" style="margin-top:15px;">
            <div class="form-group">
                <label>Current Password</label>
                <input type="password" name="current_password" required>
            </div>
            <div class="form-group">
                <label>New Password (min 8 chars)</label>
                <input type="password" name="new_password" minlength="8" required>
            </div>
            <div class="form-group">
                <label>Confirm New Password</label>
                <input type="password" name="confirm_password" minlength="8" required>
            </div>
            <button type="submit" class="btn">Update Password</button>
        </form>
    </div>`;
    res.send(renderBaseUI('Change Password', html, req.session.user, req.appSettings));
});

app.post('/change-password', requireAuth, (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) return res.redirect('/change-password?err=New passwords do not match');

    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], async (err, user) => {
        const match = await bcrypt.compare(current_password, user.password_hash);
        if (!match) return res.redirect('/change-password?err=Incorrect current password');

        const newHash = await bcrypt.hash(new_password, 10);
        db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.session.user.id], (err) => {
            logAudit(req.session.user.username, 'PASSWORD_CHANGE', 'User updated password');
            res.redirect('/change-password?msg=Password updated successfully');
        });
    });
});

// Registration Routes
app.get('/register', (req, res) => {
    if (req.appSettings.registration_enabled !== '1') {
        return res.send(renderBaseUI('Registration Closed', `
            <div style="max-width: 500px; margin: 50px auto; text-align:center;" class="card">
                <h2>Registration Closed</h2>
                <p style="margin-top:10px;">Registration is currently closed. Please contact the Club Adviser.</p>
            </div>
        `, null, req.appSettings));
    }

    db.all(`SELECT * FROM positions ORDER BY name ASC`, (err, positions) => {
        const options = positions.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
        const html = `
        <div style="max-width: 600px; margin: 30px auto;" class="card">
            <h2>Student Registration</h2>
            <form action="/register" method="POST" enctype="multipart/form-data" style="margin-top:15px;">
                <div class="form-group">
                    <label>First Name *</label>
                    <input type="text" name="first_name" required>
                </div>
                <div class="form-group">
                    <label>Middle Name</label>
                    <input type="text" name="middle_name">
                </div>
                <div class="form-group">
                    <label>Last Name *</label>
                    <input type="text" name="last_name" required>
                </div>
                <div class="form-group">
                    <label>Email Address *</label>
                    <input type="email" name="email" required>
                </div>
                <div class="form-group">
                    <label>Contact Number</label>
                    <input type="text" name="contact_number">
                </div>
                <div class="form-group">
                    <label>Club Position *</label>
                    <select name="position_id" required>${options}</select>
                </div>
                <div class="form-group">
                    <label>Student Photo (PNG, JPG, JPEG, WEBP) *</label>
                    <input type="file" name="photo" accept="image/*" required>
                </div>
                <button type="submit" class="btn btn-success" style="width:100%;">Submit Registration</button>
            </form>
        </div>`;
        res.send(renderBaseUI('Student Registration', html, null, req.appSettings));
    });
});

app.post('/register', upload.single('photo'), (req, res) => {
    if (req.appSettings.registration_enabled !== '1') return res.status(403).send('Registration is closed.');
    if (!req.file) return res.status(400).send('Photo upload is required.');

    const { first_name, middle_name, last_name, email, position_id, contact_number } = req.body;
    const photo_path = '/uploads/' + req.file.filename;

    db.run(`INSERT INTO registrations (first_name, middle_name, last_name, email, position_id, contact_number, photo_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [first_name, middle_name, last_name, email, position_id, contact_number, photo_path], function(err) {
            if (err) return res.status(500).send('Registration failed: Email may already exist.');
            logAudit('Public', 'REGISTRATION_SUBMIT', `Registration submitted for ${first_name} ${last_name}`);
            const html = `
            <div style="max-width: 500px; margin: 50px auto; text-align:center;" class="card">
                <h2 style="color:#2ecc71;">✓ REGISTRATION SUCCESSFUL</h2>
                <p style="margin-top:15px;">Your registration has been submitted.</p>
                <p><strong>Status:</strong> Pending Approval</p>
                <p style="margin-top:10px; color:#7f8c8d;">Please wait for the Club Adviser to review your registration.</p>
                <a href="/login" class="btn" style="margin-top:20px;">Return to Login</a>
            </div>`;
            res.send(renderBaseUI('Registration Received', html, null, req.appSettings));
        });
});

// Admin Dashboard & Management Routes
app.get('/admin/dashboard', requireAuth, requireRole('ADMIN'), (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    db.get(`SELECT COUNT(*) as total FROM students`, (err, totalS) => {
    db.get(`SELECT COUNT(*) as active FROM students WHERE membership_status = 'Active'`, (err, activeS) => {
    db.get(`SELECT COUNT(*) as pending FROM registrations WHERE status = 'Pending'`, (err, pendingR) => {
    db.get(`SELECT 
        SUM(CASE WHEN status = 'PRESENT' THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN status = 'LATE' THEN 1 ELSE 0 END) as late,
        SUM(CASE WHEN status = 'ABSENT' THEN 1 ELSE 0 END) as absent,
        SUM(CASE WHEN status = 'EXCUSED' THEN 1 ELSE 0 END) as excused
        FROM attendance WHERE DATE(created_at) = ?`, [today], (err, todayAtt) => {

        db.all(`SELECT a.*, s.first_name, s.last_name, s.student_number, e.name as event_name, p.name as position_name 
                FROM attendance a
                JOIN students s ON a.student_id = s.id
                JOIN events e ON a.event_id = e.id
                JOIN positions p ON s.position_id = p.id
                ORDER BY a.id DESC LIMIT 10`, (err, recentScans) => {

            const pres = todayAtt.present || 0;
            const late = todayAtt.late || 0;
            const abs = todayAtt.absent || 0;
            const exc = todayAtt.excused || 0;
            const totalToday = pres + late + abs + exc;
            const attRate = totalToday > 0 ? Math.round(((pres + late) / totalToday) * 100) : 0;

            const scanRows = recentScans.map(s => `
                <tr>
                    <td>${s.first_name} ${s.last_name}</td>
                    <td>${s.student_number}</td>
                    <td>${s.position_name}</td>
                    <td>${s.event_name}</td>
                    <td>${s.time_in ? new Date(s.time_in).toLocaleTimeString() : '-'}</td>
                    <td><span class="badge badge-${s.status === 'PRESENT' ? 'success' : s.status === 'LATE' ? 'warning' : 'danger'}">${s.status}</span></td>
                </tr>
            `).join('');

            const html = `
            <h2>Admin Dashboard</h2>
            <div class="grid" style="margin-top: 1.5rem;">
                <div class="stat-card"><h3>Total Students</h3><p>${totalS.total}</p></div>
                <div class="stat-card"><h3>Active Students</h3><p>${activeS.active}</p></div>
                <div class="stat-card"><h3>Pending Registrations</h3><p>${pendingR.pending}</p></div>
                <div class="stat-card"><h3>Attendance Rate Today</h3><p>${attRate}%</p></div>
                <div class="stat-card"><h3>Present Today</h3><p>${pres}</p></div>
                <div class="stat-card"><h3>Late Today</h3><p>${late}</p></div>
                <div class="stat-card"><h3>Absent Today</h3><p>${abs}</p></div>
                <div class="stat-card"><h3>Excused Today</h3><p>${exc}</p></div>
            </div>
            
            <div class="card" style="margin-top: 2rem;">
                <h3>Recent Activity & Scans</h3>
                <table>
                    <thead>
                        <tr><th>Student</th><th>Number</th><th>Position</th><th>Event</th><th>Time In</th><th>Status</th></tr>
                    </thead>
                    <tbody>${scanRows.length ? scanRows : '<tr><td colspan="6">No activity recorded today.</td></tr>'}</tbody>
                </table>
            </div>`;
            res.send(renderBaseUI('Dashboard', html, req.session.user, req.appSettings));
        });
    });
    });
    });
    });
});

// Registrations Management
app.get('/admin/registrations', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.all(`SELECT r.*, p.name as position_name FROM registrations r JOIN positions p ON r.position_id = p.id WHERE r.status = 'Pending' ORDER BY r.id DESC`, (err, rows) => {
        const tableRows = rows.map(r => `
            <tr>
                <td><img src="${r.photo_path}" style="width:50px; height:50px; object-fit:cover; border-radius:4px;"></td>
                <td>${r.first_name} ${r.middle_name || ''} ${r.last_name}</td>
                <td>${r.email}</td>
                <td>${r.position_name}</td>
                <td>${r.contact_number || '-'}</td>
                <td>
                    <a href="/admin/registrations/approve/${r.id}" class="btn btn-success">Approve</a>
                    <a href="/admin/registrations/reject/${r.id}" class="btn btn-danger" onclick="return confirm('Reject registration?')">Reject</a>
                </td>
            </tr>
        `).join('');

        const html = `
        <div class="card">
            <h2>Pending Registrations</h2>
            <table>
                <thead>
                    <tr><th>Photo</th><th>Name</th><th>Email</th><th>Position</th><th>Contact</th><th>Actions</th></tr>
                </thead>
                <tbody>${tableRows.length ? tableRows : '<tr><td colspan="6">No pending registrations.</td></tr>'}</tbody>
            </table>
        </div>`;
        res.send(renderBaseUI('Registrations', html, req.session.user, req.appSettings));
    });
});

app.get('/admin/registrations/approve/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
    const regId = req.params.id;
    db.get(`SELECT * FROM registrations WHERE id = ?`, [regId], (err, reg) => {
        if (err || !reg) return res.redirect('/admin/registrations');

        generateStudentNumber((err, studentNumber) => {
            if (err) return res.status(500).send('Error generating Student Number');

            const baseUsername = (reg.first_name.charAt(0) + reg.last_name).toLowerCase().replace(/[^a-z0-9]/g, '');
            const username = baseUsername + Math.floor(1000 + Math.random() * 9000);
            const rawPassword = 'Password123!';
            
            bcrypt.hash(rawPassword, 10, (err, hash) => {
                db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'STUDENT')`, [username, hash], function(err) {
                    if (err) return res.status(500).send('Error creating user account');
                    const userId = this.lastID;
                    const qrToken = 'QR-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);

                    db.run(`INSERT INTO students (user_id, student_number, first_name, middle_name, last_name, email, position_id, photo_path, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [userId, studentNumber, reg.first_name, reg.middle_name, reg.last_name, reg.email, reg.position_id, reg.photo_path, qrToken], function(err) {
                            if (err) return res.status(500).send('Error creating student profile');
                            
                            db.run(`UPDATE registrations SET status = 'Approved' WHERE id = ?`, [regId]);
                            logAudit(req.session.user.username, 'APPROVE_REGISTRATION', `Approved student ${studentNumber} (${username})`);

                            const html = `
                            <div class="card" style="max-width: 600px; margin: 40px auto;">
                                <h2 style="color:#2ecc71;">Registration Approved!</h2>
                                <p style="margin-top:10px;">The student account has been created successfully.</p>
                                <table style="margin-top:15px;">
                                    <tr><th>Student Number</th><td>${studentNumber}</td></tr>
                                    <tr><th>Assigned Username</th><td><strong>${username}</strong></td></tr>
                                    <tr><th>Temporary Password</th><td><strong>${rawPassword}</strong></td></tr>
                                </table>
                                <p style="margin-top:15px; font-size:0.85rem; color:#7f8c8d;">Please instruct the student to log in using these credentials and change their password.</p>
                                <a href="/admin/registrations" class="btn" style="margin-top:15px;">Back to Registrations</a>
                            </div>`;
                            res.send(renderBaseUI('Approval Success', html, req.session.user, req.appSettings));
                        });
                });
            });
        });
    });
});

app.get('/admin/registrations/reject/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.run(`UPDATE registrations SET status = 'Rejected' WHERE id = ?`, [req.params.id], (err) => {
        logAudit(req.session.user.username, 'REJECT_REGISTRATION', `Rejected registration ID ${req.params.id}`);
        res.redirect('/admin/registrations');
    });
});

// Student Management & ID Generation
app.get('/admin/students', requireAuth, requireRole('ADMIN'), (req, res) => {
    const search = req.query.search || '';
    const posFilter = req.query.position_id || '';
    
    let query = `SELECT s.*, p.name as position_name, u.username FROM students s 
                 JOIN positions p ON s.position_id = p.id 
                 JOIN users u ON s.user_id = u.id WHERE 1=1`;
    const params = [];

    if (search) {
        query += ` AND (s.first_name LIKE ? OR s.last_name LIKE ? OR s.student_number LIKE ? OR u.username LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (posFilter) {
        query += ` AND s.position_id = ?`;
        params.push(posFilter);
    }
    query += ` ORDER BY s.id DESC`;

    db.all(`SELECT * FROM positions ORDER BY name ASC`, (err, positions) => {
        db.all(query, params, (err, students) => {
            const posOptions = positions.map(p => `<option value="${p.id}" ${posFilter == p.id ? 'selected' : ''}>${p.name}</option>`).join('');
            
            const rows = students.map(s => `
                <tr>
                    <td><input type="checkbox" name="selected_ids" value="${s.id}"></td>
                    <td><img src="${s.photo_path}" style="width:40px; height:40px; object-fit:cover; border-radius:50%;"></td>
                    <td>${s.student_number}</td>
                    <td>${s.first_name} ${s.last_name}</td>
                    <td>${s.username}</td>
                    <td>${s.position_name}</td>
                    <td><span class="badge badge-${s.membership_status === 'Active' ? 'success' : 'danger'}">${s.membership_status}</span></td>
                    <td>
                        <a href="/admin/students/id/${s.id}" class="btn" style="padding: 4px 8px; font-size:0.8rem;">View ID</a>
                        <a href="/admin/students/edit/${s.id}" class="btn btn-warning" style="padding: 4px 8px; font-size:0.8rem;">Edit</a>
                    </td>
                </tr>
            `).join('');

            const html = `
            <div class="card">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h2>Student Management</h2>
                    <button onclick="printSelected()" class="btn btn-success">Print Selected IDs (A4 Layout)</button>
                </div>
                <form method="GET" action="/admin/students" style="display:flex; gap:10px; margin-top:15px; margin-bottom:15px;">
                    <input type="text" name="search" placeholder="Search name, student #, username..." value="${search}">
                    <select name="position_id"><option value="">All Positions</option>${posOptions}</select>
                    <button type="submit" class="btn">Filter</button>
                </form>
                <form id="printForm" action="/admin/students/print-batch" method="POST">
                    <table>
                        <thead>
                            <tr><th><input type="checkbox" onclick="toggleSelectAll(this)"></th><th>Photo</th><th>Student #</th><th>Name</th><th>Username</th><th>Position</th><th>Status</th><th>Actions</th></tr>
                        </thead>
                        <tbody>${rows.length ? rows : '<tr><td colspan="8">No students found.</td></tr>'}</tbody>
                    </table>
                </form>
            </div>
            <script>
                function toggleSelectAll(master) {
                    document.querySelectorAll('input[name="selected_ids"]').forEach(cb => cb.checked = master.checked);
                }
                function printSelected() {
                    const checked = document.querySelectorAll('input[name="selected_ids"]:checked');
                    if (checked.length === 0) return alert('Select at least one student to print IDs.');
                    document.getElementById('printForm').submit();
                }
            </script>`;
            res.send(renderBaseUI('Students', html, req.session.user, req.appSettings));
        });
    });
});

// Single Printable ID View
app.get('/admin/students/id/:id', requireAuth, (req, res) => {
    db.get(`SELECT s.*, p.name as position_name FROM students s JOIN positions p ON s.position_id = p.id WHERE s.id = ?`, [req.params.id], async (err, student) => {
        if (err || !student) return res.status(404).send('Student not found');
        const qrDataUrl = await QRCode.toDataURL(student.qr_token, { margin: 1, width: 200 });

        const html = `
        <style>
            .id-card { width: 3.375in; height: 2.125in; border: 2px solid #2c3e50; border-radius: 8px; padding: 10px; background: #fff; position: relative; box-sizing: border-box; display: flex; gap: 10px; font-family: sans-serif; }
            .id-left { width: 60%; display: flex; flex-direction: column; justify-content: space-between; }
            .id-right { width: 40%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
            .id-header { font-size: 8pt; font-weight: bold; color: #1a252f; text-transform: uppercase; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
            .id-body { display: flex; gap: 8px; margin-top: 5px; }
            .id-photo { width: 55px; height: 55px; border-radius: 4px; object-fit: cover; border: 1px solid #ddd; }
            .id-details { font-size: 7pt; line-height: 1.2; }
            .id-qr { width: 90px; height: 90px; object-fit: contain; }
        </style>
        <div style="margin: 20px auto; width: max-content;" class="no-print">
            <button onclick="window.print()" class="btn">Print Student ID</button>
        </div>
        <div style="display:flex; justify-content:center;">
            <div class="id-card">
                <div class="id-left">
                    <div class="id-header">
                        <div>${req.appSettings.school_name || 'School Name'}</div>
                        <div style="font-size:6pt; color:#7f8c8d;">${req.appSettings.club_name || 'Student Club'}</div>
                    </div>
                    <div class="id-body">
                        <img src="${student.photo_path}" class="id-photo">
                        <div class="id-details">
                            <strong style="font-size:8pt; color:#2c3e50;">${student.first_name} ${student.last_name}</strong><br>
                            <span>ID: ${student.student_number}</span><br>
                            <span>Role: ${student.position_name}</span><br>
                            <span>SY: ${req.appSettings.school_year || '2026-2027'}</span>
                        </div>
                    </div>
                </div>
                <div class="id-right">
                    <img src="${qrDataUrl}" class="id-qr">
                    <span style="font-size:5pt; margin-top:2px; color:#555;">SCAN FOR ATTENDANCE</span>
                </div>
            </div>
        </div>`;
        res.send(renderBaseUI('Student ID', html, req.session.user, req.appSettings));
    });
});

// A4 Batch ID Printing (8 per page)
app.post('/admin/students/print-batch', requireAuth, requireRole('ADMIN'), (req, res) => {
    let ids = req.body.selected_ids;
    if (!ids) return res.redirect('/admin/students');
    if (!Array.isArray(ids)) ids = [ids];

    const placeholders = ids.map(() => '?').join(',');
    db.all(`SELECT s.*, p.name as position_name FROM students s JOIN positions p ON s.position_id = p.id WHERE s.id IN (${placeholders})`, ids, async (err, students) => {
        let cardsHtml = '';
        for (let student of students) {
            const qrDataUrl = await QRCode.toDataURL(student.qr_token, { margin: 1, width: 200 });
            cardsHtml += `
            <div class="id-card">
                <div class="id-left">
                    <div class="id-header">
                        <div>${req.appSettings.school_name || 'School Name'}</div>
                        <div style="font-size:6pt; color:#7f8c8d;">${req.appSettings.club_name || 'Student Club'}</div>
                    </div>
                    <div class="id-body">
                        <img src="${student.photo_path}" class="id-photo">
                        <div class="id-details">
                            <strong style="font-size:8pt; color:#2c3e50;">${student.first_name} ${student.last_name}</strong><br>
                            <span>ID: ${student.student_number}</span><br>
                            <span>Role: ${student.position_name}</span><br>
                            <span>SY: ${req.appSettings.school_year || '2026-2027'}</span>
                        </div>
                    </div>
                </div>
                <div class="id-right">
                    <img src="${qrDataUrl}" class="id-qr">
                    <span style="font-size:5pt; margin-top:2px; color:#555;">SCAN FOR ATTENDANCE</span>
                </div>
            </div>`;
        }

        const html = `
        <style>
            @page { size: A4; margin: 10mm; }
            body { background: white; }
            .a4-grid { display: grid; grid-template-columns: repeat(2, 3.375in); gap: 15mm 10mm; justify-content: center; }
            .id-card { width: 3.375in; height: 2.125in; border: 1.5px solid #2c3e50; border-radius: 6px; padding: 8px; background: #fff; box-sizing: border-box; display: flex; gap: 8px; font-family: sans-serif; page-break-inside: avoid; }
            .id-left { width: 62%; display: flex; flex-direction: column; justify-content: space-between; }
            .id-right { width: 38%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
            .id-header { font-size: 7.5pt; font-weight: bold; color: #1a252f; text-transform: uppercase; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
            .id-body { display: flex; gap: 6px; margin-top: 4px; }
            .id-photo { width: 50px; height: 50px; border-radius: 4px; object-fit: cover; border: 1px solid #ddd; }
            .id-details { font-size: 6.5pt; line-height: 1.2; }
            .id-qr { width: 85px; height: 85px; object-fit: contain; }
        </style>
        <div style="text-align:center; margin-bottom: 20px;" class="no-print">
            <button onclick="window.print()" class="btn btn-success">Print A4 Sheet Now</button>
        </div>
        <div class="a4-grid">${cardsHtml}</div>`;
        res.send(html);
    });
});

// Position Management Routes
app.get('/admin/positions', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.all(`SELECT * FROM positions ORDER BY name ASC`, (err, positions) => {
        const rows = positions.map(p => `
            <tr>
                <td>${p.id}</td>
                <td>${p.name}</td>
                <td>
                    <form action="/admin/positions/delete/${p.id}" method="POST" style="display:inline;" onsubmit="return confirm('Delete position?')">
                        <button type="submit" class="btn btn-danger" style="padding: 2px 6px; font-size: 0.8rem;">Delete</button>
                    </form>
                </td>
            </tr>
        `).join('');

        const html = `
        <div class="grid" style="grid-template-columns: 1fr 2fr;">
            <div class="card">
                <h3>Add Position</h3>
                <form action="/admin/positions/add" method="POST" style="margin-top: 15px;">
                    <div class="form-group">
                        <label>Position Name</label>
                        <input type="text" name="name" required>
                    </div>
                    <button type="submit" class="btn">Save Position</button>
                </form>
            </div>
            <div class="card">
                <h3>Club Positions</h3>
                <table>
                    <thead><tr><th>ID</th><th>Position Name</th><th>Action</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
        res.send(renderBaseUI('Positions', html, req.session.user, req.appSettings));
    });
});

app.post('/admin/positions/add', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.run(`INSERT INTO positions (name) VALUES (?)`, [req.body.name], (err) => {
        logAudit(req.session.user.username, 'ADD_POSITION', `Added position ${req.body.name}`);
        res.redirect('/admin/positions');
    });
});

app.post('/admin/positions/delete/:id', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.run(`DELETE FROM positions WHERE id = ?`, [req.params.id], (err) => {
        logAudit(req.session.user.username, 'DELETE_POSITION', `Deleted position ID ${req.params.id}`);
        res.redirect('/admin/positions');
    });
});

// Events Management
app.get('/admin/events', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.all(`SELECT * FROM events ORDER BY event_date DESC, start_time DESC`, (err, events) => {
        const rows = events.map(e => `
            <tr>
                <td><strong>${e.name}</strong></td>
                <td>${e.type}</td>
                <td>${e.event_date} (${e.start_time} - ${e.end_time})</td>
                <td>${e.location || '-'}</td>
                <td><span class="badge badge-${e.status === 'Active' ? 'success' : e.status === 'Completed' ? 'info' : 'warning'}">${e.status}</span></td>
                <td>
                    <a href="/admin/events/status/${e.id}/Active" class="btn btn-success" style="padding:2px 6px; font-size:0.75rem;">Activate</a>
                    <a href="/admin/events/status/${e.id}/Completed" class="btn" style="padding:2px 6px; font-size:0.75rem;">Complete</a>
                </td>
            </tr>
        `).join('');

        const html = `
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h2>Event Management</h2>
                <a href="/admin/events/create" class="btn btn-success">Create New Event</a>
            </div>
            <table style="margin-top:15px;">
                <thead><tr><th>Event Name</th><th>Type</th><th>Date & Time</th><th>Location</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>${rows.length ? rows : '<tr><td colspan="6">No events created yet.</td></tr>'}</tbody>
            </table>
        </div>`;
        res.send(renderBaseUI('Events', html, req.session.user, req.appSettings));
    });
});

app.get('/admin/events/create', requireAuth, requireRole('ADMIN'), (req, res) => {
    const html = `
    <div class="card" style="max-width: 600px; margin: 20px auto;">
        <h2>Create Event</h2>
        <form action="/admin/events/create" method="POST" style="margin-top:15px;">
            <div class="form-group"><label>Event Name *</label><input type="text" name="name" required></div>
            <div class="form-group"><label>Event Type *</label><input type="text" name="type" placeholder="e.g. Club Meeting, Seminar" required></div>
            <div class="form-group"><label>Description</label><textarea name="description"></textarea></div>
            <div class="form-group"><label>Event Date *</label><input type="date" name="event_date" required></div>
            <div class="form-group"><label>Start Time *</label><input type="time" name="start_time" required></div>
            <div class="form-group"><label>End Time *</label><input type="time" name="end_time" required></div>
            <div class="form-group"><label>Location</label><input type="text" name="location"></div>
            <div class="form-group"><label>Late Threshold (Minutes)</label><input type="number" name="late_threshold" value="10" required></div>
            <button type="submit" class="btn btn-success">Create Event</button>
        </form>
    </div>`;
    res.send(renderBaseUI('Create Event', html, req.session.user, req.appSettings));
});

app.post('/admin/events/create', requireAuth, requireRole('ADMIN'), (req, res) => {
    const { name, type, description, event_date, start_time, end_time, location, late_threshold } = req.body;
    db.run(`INSERT INTO events (name, type, description, event_date, start_time, end_time, location, late_threshold, organizer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, type, description, event_date, start_time, end_time, location, late_threshold, req.session.user.username], (err) => {
            logAudit(req.session.user.username, 'CREATE_EVENT', `Created event ${name}`);
            res.redirect('/admin/events');
        });
});

app.get('/admin/events/status/:id/:status', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.run(`UPDATE events SET status = ? WHERE id = ?`, [req.params.status, req.params.id], (err) => {
        logAudit(req.session.user.username, 'UPDATE_EVENT_STATUS', `Event ${req.params.id} set to ${req.params.status}`);
        res.redirect('/admin/events');
    });
});

// QR Scanner Portal & API
app.get('/scanner', requireAuth, requireRole('ADMIN', 'SCANNER'), (req, res) => {
    db.all(`SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC`, (err, events) => {
        const eventOptions = events.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('');

        const html = `
        <div class="card" style="max-width: 800px; margin: 0 auto; text-align: center;">
            <h2>QR Scanner Portal</h2>
            <div style="margin-top: 15px; display:flex; gap:10px; justify-content:center;">
                <select id="eventSelect" style="max-width:300px; padding:8px;">
                    ${eventOptions.length ? eventOptions : '<option value="">-- NO ACTIVE EVENTS --</option>'}
                </select>
                <select id="modeSelect" style="width:120px; padding:8px;">
                    <option value="IN">TIME IN</option>
                    <option value="OUT">TIME OUT</option>
                </select>
            </div>

            <div style="margin-top:20px; position:relative; display:inline-block; width:100%; max-width:400px; height:300px; background:#000; border-radius:8px; overflow:hidden;">
                <video id="webcam" autoplay playsinline style="width:100%; height:100%; object-fit:cover;"></video>
                <div style="position:absolute; top:20%; left:20%; width:60%; height:60%; border:2px dashed #2ecc71; box-sizing:border-box; pointer-events:none;"></div>
            </div>

            <div class="form-group" style="margin-top:15px; max-width:400px; margin-left:auto; margin-right:auto;">
                <input type="text" id="manualQrInput" placeholder="Manual Scan / Enter QR Token..." style="text-align:center;">
                <button onclick="processManualScan()" class="btn" style="margin-top:5px; width:100%;">Submit Manual Token</button>
            </div>

            <div id="scanResult" style="margin-top:20px; padding:15px; border-radius:6px; display:none;"></div>
        </div>

        <script>
            let lastScanTime = 0;
            const scanCooldown = 3000; // 3 seconds cooldown

            function speak(text) {
                if ('speechSynthesis' in window) {
                    const msg = new SpeechSynthesisUtterance(text);
                    window.speechSynthesis.speak(msg);
                }
            }

            async function submitScan(qrToken) {
                const now = Date.now();
                if (now - lastScanTime < scanCooldown) return;
                lastScanTime = now;

                const eventId = document.getElementById('eventSelect').value;
                const mode = document.getElementById('modeSelect').value;
                const resDiv = document.getElementById('scanResult');

                if (!eventId) {
                    alert('Please select an active event first!');
                    return;
                }

                try {
                    const res = await fetch('/api/scan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ qr_token: qrToken, event_id: eventId, mode })
                    });
                    const data = await res.json();

                    resDiv.style.display = 'block';
                    if (data.success) {
                        resDiv.style.background = '#d4edda';
                        resDiv.style.color = '#155724';
                        resDiv.innerHTML = '<h3>✓ ' + data.message + '</h3><p><strong>' + data.student.name + '</strong> (' + data.student.student_number + ')</p>';
                        speak(data.student.name + ', ' + (mode === 'IN' ? 'attendance recorded' : 'time out recorded'));
                    } else {
                        resDiv.style.background = '#f8d7da';
                        resDiv.style.color = '#721c24';
                        resDiv.innerHTML = '<h3>✕ ' + data.message + '</h3>';
                        speak(data.message);
                    }
                } catch(err) {
                    console.error(err);
                }
            }

            function processManualScan() {
                const val = document.getElementById('manualQrInput').value.trim();
                if (val) {
                    submitScan(val);
                    document.getElementById('manualQrInput').value = '';
                }
            }

            // Web Camera Initialization
            navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
                .then(stream => { document.getElementById('webcam').srcObject = stream; })
                .catch(err => console.log('Camera access denied or unavailable.'));
        </script>`;
        res.send(renderBaseUI('QR Scanner Portal', html, req.session.user, req.appSettings));
    });
});

// Process Attendance Scan Endpoint
app.post('/api/scan', requireAuth, requireRole('ADMIN', 'SCANNER'), (req, res) => {
    const { qr_token, event_id, mode } = req.body;
    const scannerUserId = req.session.user.id;

    db.get(`SELECT * FROM students WHERE qr_token = ?`, [qr_token], (err, student) => {
        if (err || !student) return res.json({ success: false, message: 'Invalid QR Code' });
        if (!student.qr_enabled) return res.json({ success: false, message: 'QR Code is Disabled' });

        db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
            if (err || !event || event.status !== 'Active') {
                return res.json({ success: false, message: 'Event is not active' });
            }

            const now = new Date();
            const nowIso = now.toISOString();

            if (mode === 'IN') {
                db.get(`SELECT * FROM attendance WHERE student_id = ? AND event_id = ?`, [student.id, event_id], (err, existing) => {
                    if (existing) {
                        return res.json({ success: false, message: `${student.first_name} ${student.last_name}, already recorded!` });
                    }

                    // Determine Status Present/Late
                    const eventStart = new Date(`${event.event_date}T${event.start_time}`);
                    const lateTime = new Date(eventStart.getTime() + event.late_threshold * 60000);
                    const status = now > lateTime ? 'LATE' : 'PRESENT';

                    db.run(`INSERT INTO attendance (student_id, event_id, scanned_by, time_in, status) VALUES (?, ?, ?, ?, ?)`,
                        [student.id, event_id, scannerUserId, nowIso, status], (err) => {
                            if (err) return res.json({ success: false, message: 'Failed to record attendance' });
                            logAudit(req.session.user.username, 'ATTENDANCE_IN', `Recorded ${status} for ${student.student_number}`);
                            res.json({
                                success: true,
                                message: `ATTENDANCE RECORDED (${status})`,
                                student: { name: `${student.first_name} ${student.last_name}`, student_number: student.student_number }
                            });
                        });
                });
            } else if (mode === 'OUT') {
                db.get(`SELECT * FROM attendance WHERE student_id = ? AND event_id = ?`, [student.id, event_id], (err, existing) => {
                    if (!existing) return res.json({ success: false, message: 'No Time In record found for Time Out' });

                    db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [nowIso, existing.id], (err) => {
                        if (err) return res.json({ success: false, message: 'Failed to record Time Out' });
                        logAudit(req.session.user.username, 'ATTENDANCE_OUT', `Recorded Time Out for ${student.student_number}`);
                        res.json({
                            success: true,
                            message: 'TIME OUT RECORDED',
                            student: { name: `${student.first_name} ${student.last_name}`, student_number: student.student_number }
                        });
                    });
                });
            }
        });
    });
});

// Student Member Portal
app.get('/member', requireAuth, requireRole('STUDENT'), (req, res) => {
    db.get(`SELECT s.*, p.name as position_name, u.username FROM students s 
            JOIN positions p ON s.position_id = p.id 
            JOIN users u ON s.user_id = u.id 
            WHERE s.user_id = ?`, [req.session.user.id], async (err, student) => {
        if (err || !student) return res.status(404).send('Student Profile Not Found');

        const qrDataUrl = await QRCode.toDataURL(student.qr_token, { margin: 1, width: 250 });

        db.all(`SELECT a.*, e.name as event_name, e.event_date FROM attendance a 
                JOIN events e ON a.event_id = e.id 
                WHERE a.student_id = ? ORDER BY a.id DESC`, [student.id], (err, attendanceHistory) => {

            const attRows = attendanceHistory.map(a => `
                <tr>
                    <td>${a.event_name}</td>
                    <td>${a.event_date}</td>
                    <td>${a.time_in ? new Date(a.time_in).toLocaleTimeString() : '-'}</td>
                    <td>${a.time_out ? new Date(a.time_out).toLocaleTimeString() : '-'}</td>
                    <td><span class="badge badge-${a.status === 'PRESENT' ? 'success' : a.status === 'LATE' ? 'warning' : 'danger'}">${a.status}</span></td>
                </tr>
            `).join('');

            const html = `
            <div class="grid" style="grid-template-columns: 1fr 2fr;">
                <div class="card" style="text-align: center;">
                    <img src="${student.photo_path}" style="width:120px; height:120px; object-fit:cover; border-radius:50%; border:3px solid #3498db;">
                    <h2 style="margin-top:10px;">${student.first_name} ${student.last_name}</h2>
                    <p style="color:#7f8c8d;">${student.position_name}</p>
                    <hr style="margin:15px 0;">
                    <p><strong>Student Number:</strong> ${student.student_number}</p>
                    <p><strong>Username:</strong> ${student.username}</p>
                    <p><strong>Email:</strong> ${student.email}</p>
                    <div style="margin-top:15px;">
                        <img src="${qrDataUrl}" style="width:180px; height:180px;">
                        <p style="font-size:0.8rem; color:#7f8c8d;">Your Digital Attendance QR Code</p>
                    </div>
                </div>

                <div class="card">
                    <h3>My Attendance History</h3>
                    <table>
                        <thead><tr><th>Event</th><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                        <tbody>${attRows.length ? attRows : '<tr><td colspan="5">No attendance history available.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>`;
            res.send(renderBaseUI('Student Portal', html, req.session.user, req.appSettings));
        });
    });
});

// System Users Management
app.get('/admin/users', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.all(`SELECT id, username, role, created_at FROM users ORDER BY id DESC`, (err, users) => {
        const rows = users.map(u => `
            <tr>
                <td>${u.id}</td>
                <td><strong>${u.username}</strong></td>
                <td><span class="badge badge-info">${u.role}</span></td>
                <td>${new Date(u.created_at).toLocaleDateString()}</td>
            </tr>
        `).join('');

        const html = `
        <div class="grid" style="grid-template-columns: 1fr 2fr;">
            <div class="card">
                <h3>Create Scanner Account</h3>
                <form action="/admin/users/create" method="POST" style="margin-top:15px;">
                    <div class="form-group"><label>Username</label><input type="text" name="username" required></div>
                    <div class="form-group"><label>Password</label><input type="password" name="password" required></div>
                    <input type="hidden" name="role" value="SCANNER">
                    <button type="submit" class="btn btn-success">Create Scanner User</button>
                </form>
            </div>
            <div class="card">
                <h3>System Users</h3>
                <table>
                    <thead><tr><th>ID</th><th>Username</th><th>Role</th><th>Created</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
        res.send(renderBaseUI('System Users', html, req.session.user, req.appSettings));
    });
});

app.post('/admin/users/create', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const { username, password, role } = req.body;
    const hash = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, [username, hash, role], (err) => {
        logAudit(req.session.user.username, 'CREATE_USER', `Created user ${username} (${role})`);
        res.redirect('/admin/users');
    });
});

// Admin System Settings
app.get('/admin/settings', requireAuth, requireRole('ADMIN'), (req, res) => {
    const s = req.appSettings;
    const html = `
    <div class="card" style="max-width: 800px; margin: 0 auto;">
        <h2>System & School Settings</h2>
        <form action="/admin/settings" method="POST" enctype="multipart/form-data" style="margin-top:15px;">
            <div class="grid" style="grid-template-columns: 1fr 1fr;">
                <div class="form-group"><label>School Name</label><input type="text" name="school_name" value="${s.school_name || ''}"></div>
                <div class="form-group"><label>Club Name</label><input type="text" name="club_name" value="${s.club_name || ''}"></div>
                <div class="form-group"><label>School Year</label><input type="text" name="school_year" value="${s.school_year || ''}"></div>
                <div class="form-group"><label>Club Adviser</label><input type="text" name="club_adviser" value="${s.club_adviser || ''}"></div>
                <div class="form-group"><label>Registration Status</label>
                    <select name="registration_enabled">
                        <option value="1" ${s.registration_enabled === '1' ? 'selected' : ''}>OPEN</option>
                        <option value="0" ${s.registration_enabled === '0' ? 'selected' : ''}>CLOSED</option>
                    </select>
                </div>
                <div class="form-group"><label>Student # Prefix</label><input type="text" name="student_number_prefix" value="${s.student_number_prefix || 'SC-'}"></div>
            </div>
            <button type="submit" class="btn btn-success" style="margin-top:15px;">Save Settings</button>
        </form>
    </div>`;
    res.send(renderBaseUI('Settings', html, req.session.user, req.appSettings));
});

app.post('/admin/settings', requireAuth, requireRole('ADMIN'), (req, res) => {
    const fields = req.body;
    db.serialize(() => {
        Object.keys(fields).forEach(key => {
            db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, fields[key]]);
        });
        logAudit(req.session.user.username, 'UPDATE_SETTINGS', 'Updated system settings');
        res.redirect('/admin/settings');
    });
});

// Audit Logs & Backup
app.get('/admin/backup', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50`, (err, logs) => {
        const logRows = logs.map(l => `
            <tr>
                <td>${l.timestamp}</td>
                <td><strong>${l.username}</strong></td>
                <td>${l.action}</td>
                <td>${l.details || '-'}</td>
            </tr>
        `).join('');

        const html = `
        <div class="card">
            <h2>Audit Logs</h2>
            <table>
                <thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
                <tbody>${logRows.length ? logRows : '<tr><td colspan="4">No logs recorded.</td></tr>'}</tbody>
            </table>
        </div>`;
        res.send(renderBaseUI('Backup & Audit', html, req.session.user, req.appSettings));
    });
});

// Reports Management
app.get('/admin/reports', requireAuth, requireRole('ADMIN'), (req, res) => {
    db.all(`SELECT e.name, e.event_date, 
            COUNT(a.id) as total_scans,
            SUM(CASE WHEN a.status='PRESENT' THEN 1 ELSE 0 END) as present_count,
            SUM(CASE WHEN a.status='LATE' THEN 1 ELSE 0 END) as late_count
            FROM events e LEFT JOIN attendance a ON e.id = a.event_id 
            GROUP BY e.id ORDER BY e.id DESC`, (err, reports) => {

        const rows = reports.map(r => `
            <tr>
                <td><strong>${r.name}</strong></td>
                <td>${r.event_date}</td>
                <td>${r.total_scans}</td>
                <td>${r.present_count}</td>
                <td>${r.late_count}</td>
            </tr>
        `).join('');

        const html = `
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h2>Attendance Summary Reports</h2>
                <button onclick="window.print()" class="btn">Print Report</button>
            </div>
            <table style="margin-top:15px;">
                <thead><tr><th>Event Name</th><th>Event Date</th><th>Total Attendees</th><th>Present</th><th>Late</th></tr></thead>
                <tbody>${rows.length ? rows : '<tr><td colspan="5">No attendance data available for reports.</td></tr>'}</tbody>
            </table>
        </div>`;
        res.send(renderBaseUI('Reports', html, req.session.user, req.appSettings));
    });
});

// Server Start
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
