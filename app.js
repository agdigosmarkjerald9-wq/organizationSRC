/**
 * School Student Club QR Code Attendance Management System
 * Complete Unified Application Code (`app.js`)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware configuration
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(session({
    secret: 'school-club-qr-attendance-super-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Database Initialization
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        // Settings Table
        db.run(`CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_name TEXT DEFAULT 'ABC National High School',
            school_logo TEXT DEFAULT '',
            school_address TEXT DEFAULT '123 Education St., Metro Manila',
            school_contact TEXT DEFAULT '+63 912 345 6789',
            school_email TEXT DEFAULT 'info@abcnhs.edu.ph',
            school_year TEXT DEFAULT '2026–2027',
            club_name TEXT DEFAULT 'Computer Club',
            org_name TEXT DEFAULT 'Information Technology Society',
            adviser TEXT DEFAULT 'Mr. John Doe',
            late_threshold_mins INTEGER DEFAULT 15,
            participation_threshold REAL DEFAULT 75.0,
            scanner_sound TEXT DEFAULT 'enabled',
            voice_announcement TEXT DEFAULT 'enabled',
            voice_volume REAL DEFAULT 1.0,
            speech_rate REAL DEFAULT 1.0
        )`);

        // Users / Auth Table (Admin, Scanner, Student accounts)
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'scanner', 'student')),
            student_id TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Positions Table (Fully Customizable)
        db.run(`CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            position_name TEXT UNIQUE NOT NULL,
            description TEXT
        )`);

        // Students Table (No Committee, No Grade, No Section)
        db.run(`CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT UNIQUE NOT NULL,
            first_name TEXT NOT NULL,
            middle_name TEXT,
            last_name TEXT NOT NULL,
            full_name TEXT NOT NULL,
            position TEXT NOT NULL,
            student_club TEXT DEFAULT 'Computer Club',
            school_year TEXT DEFAULT '2026–2027',
            gender TEXT,
            date_of_birth TEXT,
            contact_number TEXT,
            school_email TEXT,
            address TEXT,
            student_photo TEXT,
            date_joined TEXT,
            membership_status TEXT DEFAULT 'Active' CHECK(membership_status IN ('Active', 'Inactive', 'Suspended', 'Alumni', 'Resigned')),
            membership_expiration_date TEXT,
            parent_guardian_name TEXT,
            parent_guardian_contact TEXT,
            qr_token TEXT UNIQUE,
            qr_status TEXT DEFAULT 'active' CHECK(qr_status IN ('active', 'disabled')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Position History Table
        db.run(`CREATE TABLE IF NOT EXISTS position_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            position TEXT NOT NULL,
            school_year TEXT NOT NULL,
            assigned_date DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Events Table
        db.run(`CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            description TEXT,
            event_type TEXT DEFAULT 'General Meeting',
            event_date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            location TEXT,
            organizer TEXT,
            participant_scope TEXT DEFAULT 'ALL' CHECK(participant_scope IN ('ALL', 'OFFICERS', 'SPECIFIC_POSITIONS', 'SELECTED')),
            target_positions TEXT,
            target_students TEXT,
            status TEXT DEFAULT 'Upcoming' CHECK(status IN ('Upcoming', 'Active', 'Completed', 'Cancelled')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Attendance Table
        db.run(`CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            student_id TEXT NOT NULL,
            time_in DATETIME DEFAULT NULL,
            time_out DATETIME DEFAULT NULL,
            status TEXT DEFAULT 'Absent' CHECK(status IN ('Present', 'Late', 'Absent', 'Excused')),
            excuse_reason TEXT,
            approved_by TEXT,
            FOREIGN KEY(event_id) REFERENCES events(id),
            FOREIGN KEY(student_id) REFERENCES students(student_id)
        )`);

        // Audit Logs Table
        db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Seed Default Data
        setTimeout(() => seedDefaultData(), 500);
    }
}

function seedDefaultData() {
    db.get("SELECT COUNT(*) as count FROM settings", (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO settings (school_name, club_name, adviser) VALUES ('ABC National High School', 'Computer Club', 'Mr. John Doe')`);
        }
    });

    db.get("SELECT COUNT(*) as count FROM users WHERE role='admin'", (err, row) => {
        if (row && row.count === 0) {
            const hash = bcrypt.hashSync('admin123', 10);
            db.run(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [hash]);
            db.run(`INSERT INTO users (username, password, role) VALUES ('scanner1', ?, 'scanner')`, [bcrypt.hashSync('scanner123', 10)]);
            logAudit('System', 'Seed Default Users', 'Created default admin and scanner accounts');
        }
    });

    db.get("SELECT COUNT(*) as count FROM positions", (err, row) => {
        if (row && row.count === 0) {
            const defaultPositions = [
                'President', 'Vice President', 'Secretary', 'Treasurer', 
                'Auditor', 'Public Information Officer', 'Peace Officer', 
                'Sergeant-at-Arms', 'Representative', 'Member',
                'Event Coordinator', 'Technical Head', 'Documentation Officer'
            ];
            const stmt = db.prepare("INSERT OR IGNORE INTO positions (position_name) VALUES (?)");
            defaultPositions.forEach(pos => stmt.run(pos));
            stmt.finalize();
        }
    });

    db.get("SELECT COUNT(*) as count FROM students", (err, row) => {
        if (row && row.count === 0) {
            const sampleStudents = [
                { id: '2026-001', fn: 'Juan', mn: 'Santos', ln: 'Dela Cruz', pos: 'President' },
                { id: '2026-002', fn: 'Maria', mn: 'Reyes', ln: 'Santos', pos: 'Vice President' },
                { id: '2026-003', fn: 'Pedro', mn: 'Alvarez', ln: 'Cruz', pos: 'Secretary' },
                { id: '2026-004', fn: 'Ana', mn: 'Lim', ln: 'Gonzales', pos: 'Treasurer' }
            ];
            sampleStudents.forEach(s => {
                const token = 'QR-' + s.id + '-' + Math.random().toString(36).substring(2, 9);
                db.run(`INSERT OR IGNORE INTO students (student_id, first_name, middle_name, last_name, full_name, position, qr_token, date_joined, membership_expiration_date) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-06-01', '2027-05-31')`,
                    [s.id, s.fn, s.mn, s.ln, `${s.fn} ${s.mn} ${s.ln}`, s.pos, token]);
                db.run(`INSERT INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)`, [s.id, bcrypt.hashSync('student123', 10), s.id]);
                db.run(`INSERT INTO position_history (student_id, position, school_year) VALUES (?, ?, '2026–2027')`, [s.id, s.pos]);
            });
        }
    });

    db.get("SELECT COUNT(*) as count FROM events", (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO events (event_name, description, event_type, event_date, start_time, end_time, location, organizer, status) VALUES ('General Club Assembly', 'First general assembly for all members', 'General Assembly', date('now'), '09:00', '11:00', 'School Gymnasium', 'Mr. John Doe', 'Active')`);
        }
    });
}

function logAudit(username, action, details) {
    db.run(`INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)`, [username, action, details]);
}

// Authentication Middleware
function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    res.redirect('/login');
}

function isAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    res.status(403).send('Access Denied: Administrator privileges required.');
}

function isScanner(req, res, next) {
    if (req.session && req.session.user && (req.session.user.role === 'scanner' || req.session.user.role === 'admin')) {
        return next();
    }
    res.status(403).send('Access Denied: Scanner privileges required.');
}

function isStudent(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'student') {
        return next();
    }
    res.status(403).send('Access Denied: Student portal access required.');
}

// HTML Layout Wrapper
function renderLayout(title, user, content, customScript = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | Student Club QR System</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --primary: #4f46e5;
            --primary-dark: #4338ca;
            --secondary: #06b6d4;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --dark: #1e293b;
            --light: #f8fafc;
            --gray: #64748b;
            --border: #e2e8f0;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
        body { background: #f1f5f9; color: var(--dark); display: flex; height: 100vh; overflow: hidden; }
        .sidebar { width: 260px; background: var(--dark); color: white; display: flex; flex-direction: column; transition: all 0.3s; z-index: 100; }
        .sidebar-brand { padding: 20px; font-size: 1.1rem; font-weight: 700; background: #0f172a; display: flex; align-items: center; gap: 10px; color: var(--secondary); }
        .sidebar-menu { list-style: none; padding: 20px 0; overflow-y: auto; flex-grow: 1; }
        .sidebar-menu li a { display: flex; align-items: center; gap: 12px; padding: 12px 24px; color: #94a3b8; text-decoration: none; font-weight: 500; transition: 0.2s; }
        .sidebar-menu li a:hover, .sidebar-menu li a.active { color: white; background: rgba(255,255,255,0.08); border-left: 4px solid var(--secondary); }
        .main-content { flex-grow: 1; display: flex; flex-direction: column; overflow: hidden; }
        .top-navbar { height: 70px; background: white; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 30px; }
        .user-info { display: flex; align-items: center; gap: 15px; }
        .content-body { padding: 30px; overflow-y: auto; flex-grow: 1; }
        .card { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 25px; margin-bottom: 25px; border: 1px solid var(--border); }
        .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 25px; }
        .stat-card { background: white; border-radius: 12px; padding: 20px; border: 1px solid var(--border); display: flex; align-items: center; gap: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .stat-icon { width: 50px; height: 50px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.4rem; color: white; background: var(--primary); }
        .stat-info h3 { font-size: 1.5rem; font-weight: 700; color: var(--dark); }
        .stat-info p { color: var(--gray); font-size: 0.85rem; font-weight: 500; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; background: white; border-radius: 8px; overflow: hidden; }
        th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
        th { background: #f8fafc; font-weight: 600; color: var(--gray); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
        tr:hover { background: #f8fafc; }
        .btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 6px; font-weight: 500; font-size: 0.85rem; cursor: pointer; border: none; text-decoration: none; transition: 0.2s; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-primary:hover { background: var(--primary-dark); }
        .btn-success { background: var(--success); color: white; }
        .btn-danger { background: var(--danger); color: white; }
        .btn-warning { background: var(--warning); color: white; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 0.85rem; color: var(--dark); }
        .form-control { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; outline: none; transition: 0.2s; }
        .form-control:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
        .badge { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; display: inline-block; }
        .badge-success { background: #d1fae5; color: #065f46; }
        .badge-warning { background: #fef3c7; color: #92400e; }
        .badge-danger { background: #fee2e2; color: #991b1b; }
        .badge-info { background: #cffafe; color: #155e75; }
        .flex { display: flex; gap: 15px; align-items: center; }
        .justify-between { justify-content: space-between; }
        .align-center { align-items: center; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: white; padding: 30px; border-radius: 12px; width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; }
        @media print {
            body { background: white; overflow: auto; }
            .sidebar, .top-navbar, .no-print { display: none !important; }
            .main-content { overflow: visible !important; }
            .content-body { padding: 0 !important; }
            .card { box-shadow: none !important; border: none !important; }
        }
    </style>
</head>
<body>
    ${user.role === 'admin' ? `
    <div class="sidebar">
        <div class="sidebar-brand"><i class="fa-solid fa-graduation-cap"></i> Club Attendance</div>
        <ul class="sidebar-menu">
            <li><a href="/admin" class="${title === 'Dashboard' ? 'active' : ''}"><i class="fa-solid fa-chart-pie"></i> Dashboard</a></li>
            <li><a href="/admin/students" class="${title === 'Students Management' ? 'active' : ''}"><i class="fa-solid fa-users"></i> Students</a></li>
            <li><a href="/admin/positions" class="${title === 'Position Management' ? 'active' : ''}"><i class="fa-solid fa-id-badge"></i> Positions</a></li>
            <li><a href="/admin/events" class="${title === 'Event Management' ? 'active' : ''}"><i class="fa-solid fa-calendar-days"></i> Events</a></li>
            <li><a href="/admin/attendance" class="${title === 'Attendance Records' ? 'active' : ''}"><i class="fa-solid fa-clipboard-user"></i> Attendance</a></li>
            <li><a href="/admin/id-printing" class="${title === 'ID Card Printing' ? 'active' : ''}"><i class="fa-solid fa-print"></i> A4 ID Printing</a></li>
            <li><a href="/admin/reports" class="${title === 'Reports & Analytics' ? 'active' : ''}"><i class="fa-solid fa-file-lines"></i> Reports</a></li>
            <li><a href="/admin/settings" class="${title === 'System Settings' ? 'active' : ''}"><i class="fa-solid fa-gear"></i> Settings</a></li>
            <li><a href="/admin/audit" class="${title === 'Audit Logs' ? 'active' : ''}"><i class="fa-solid fa-shield-halved"></i> Audit Logs</a></li>
            <li><a href="/scanner" target="_blank"><i class="fa-solid fa-qrcode"></i> Open Scanner Portal</a></li>
            <li><a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a></li>
        </ul>
    </div>
    ` : ''}
    <div class="main-content">
        <div class="top-navbar no-print">
            <div class="flex align-center">
                <h3>${title}</h3>
            </div>
            <div class="user-info">
                <span><i class="fa-solid fa-user-circle"></i> <b>${user.username}</b> (${user.role.toUpperCase()})</span>
                <a href="/change-password" class="btn btn-warning" style="padding: 6px 12px; font-size: 0.8rem;"><i class="fa-solid fa-key"></i> Password</a>
                <a href="/logout" class="btn btn-danger" style="padding: 6px 12px; font-size: 0.8rem;"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
            </div>
        </div>
        <div class="content-body">
            ${content}
        </div>
    </div>
    <script>${customScript}</script>
</body>
</html>`;
}

// ================= ROUTES ================= //

// Login Page
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login | School Student Club QR System</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { background: #0f172a; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Inter', sans-serif; }
        .login-card { background: white; padding: 40px; border-radius: 16px; width: 100%; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
        .login-brand { text-align: center; margin-bottom: 30px; }
        .login-brand i { font-size: 3rem; color: #4f46e5; margin-bottom: 10px; }
        .login-brand h2 { font-weight: 700; color: #1e293b; }
        .login-brand p { color: #64748b; font-size: 0.9rem; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 500; font-size: 0.85rem; color: #1e293b; }
        .form-control { width: 100%; padding: 12px 16px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.95rem; outline: none; }
        .form-control:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
        .btn-login { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 8px; font-weight: 600; font-size: 1rem; cursor: pointer; transition: 0.2s; }
        .btn-login:hover { background: #4338ca; }
        .error-msg { background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 6px; font-size: 0.85rem; margin-bottom: 20px; text-align: center; }
        .links { text-align: center; margin-top: 20px; }
        .links a { color: #4f46e5; text-decoration: none; font-size: 0.9rem; font-weight: 500; }
    </style>
</head>
<body>
    <div class="login-card">
        <div class="login-brand">
            <i class="fa-solid fa-qrcode"></i>
            <h2>Club QR Attendance</h2>
            <p>School Student Club Management Portal</p>
        </div>
        ${req.query.error ? `<div class="error-msg">Invalid username or password!</div>` : ''}
        <form action="/login" method="POST">
            <div class="form-group">
                <label>Username / Student ID</label>
                <input type="text" name="username" class="form-control" required placeholder="Enter username or student ID">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" name="password" class="form-control" required placeholder="Enter password">
            </div>
            <button type="submit" class="btn-login">Login to System</button>
        </form>
        <div class="links">
            <a href="/scanner"><i class="fa-solid fa-camera"></i> Go to QR Scanner Portal</a>
        </div>
    </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.user = user;
            logAudit(user.username, 'Login', `User ${user.username} logged in successfully`);
            if (user.role === 'admin') res.redirect('/admin');
            else if (user.role === 'scanner') res.redirect('/scanner');
            else if (user.role === 'student') res.redirect('/member');
            else res.redirect('/login');
        } else {
            res.redirect('/login?error=1');
        }
    });
});

app.get('/logout', (req, res) => {
    if (req.session && req.session.user) {
        logAudit(req.session.user.username, 'Logout', `User logged out`);
    }
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Change Password Route
app.get('/change-password', isAuthenticated, (req, res) => {
    const content = `
    <div class="card" style="max-width: 500px; margin: 0 auto;">
        <h3><i class="fa-solid fa-key"></i> Change Password</h3>
        <p style="color: var(--gray); font-size: 0.9rem; margin-bottom: 20px;">Ensure your account is using a secure password (minimum 8 characters).</p>
        ${req.query.success ? `<div style="background: #d1fae5; color: #065f46; padding: 10px; border-radius: 6px; margin-bottom: 15px;">Password updated successfully!</div>` : ''}
        ${req.query.error ? `<div style="background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 6px; margin-bottom: 15px;">Error updating password. Check your inputs.</div>` : ''}
        <form action="/change-password" method="POST">
            <div class="form-group">
                <label>Current Password</label>
                <input type="password" name="current_password" class="form-control" required>
            </div>
            <div class="form-group">
                <label>New Password (Min 8 characters)</label>
                <input type="password" name="new_password" class="form-control" minlength="8" required>
            </div>
            <div class="form-group">
                <label>Confirm New Password</label>
                <input type="password" name="confirm_password" class="form-control" minlength="8" required>
            </div>
            <button type="submit" class="btn btn-primary"><i class="fa-solid fa-save"></i> Update Password</button>
        </form>
    </div>`;
    res.send(renderLayout('Change Password', req.session.user, content));
});

app.post('/change-password', isAuthenticated, (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    if (new_password !== confirm_password || new_password.length < 8) {
        return res.redirect('/change-password?error=1');
    }
    db.get(`SELECT * FROM users WHERE id = ?`, [req.session.user.id], (err, user) => {
        if (user && bcrypt.compareSync(current_password, user.password)) {
            const hash = bcrypt.hashSync(new_password, 10);
            db.run(`UPDATE users SET password = ? WHERE id = ?`, [hash, user.id], () => {
                logAudit(user.username, 'Change Password', 'User successfully changed password');
                res.redirect('/change-password?success=1');
            });
        } else {
            res.redirect('/change-password?error=1');
        }
    });
});

// ================= ADMIN DASHBOARD ================= //
app.get('/admin', isAuthenticated, isAdmin, (req, res) => {
    db.serialize(() => {
        db.get(`SELECT COUNT(*) as total FROM students`, (err, r1) => {
            db.get(`SELECT COUNT(*) as active FROM students WHERE membership_status='Active'`, (err, r2) => {
                db.get(`SELECT COUNT(*) as inactive FROM students WHERE membership_status != 'Active'`, (err, r3) => {
                    db.get(`SELECT COUNT(*) as officers FROM students WHERE position IN ('President','Vice President','Secretary','Treasurer','Auditor')`, (err, r4) => {
                        db.get(`SELECT COUNT(*) as present FROM attendance WHERE date(time_in) = date('now') AND status IN ('Present','Late')`, (err, r5) => {
                            db.get(`SELECT COUNT(*) as late FROM attendance WHERE date(time_in) = date('now') AND status='Late'`, (err, r6) => {
                                db.get(`SELECT * FROM events WHERE status='Active' LIMIT 1`, (err, activeEvent) => {
                                    db.all(`SELECT a.*, s.full_name, s.student_id as sid, s.position FROM attendance a JOIN students s ON a.student_id = s.student_id ORDER BY a.id DESC LIMIT 10`, (err, recentScans) => {
                                        db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
                                            
                                            const stats = {
                                                total: r1 ? r1.total : 0,
                                                active: r2 ? r2.active : 0,
                                                inactive: r3 ? r3.inactive : 0,
                                                officers: r4 ? r4.officers : 0,
                                                present: r5 ? r5.present : 0,
                                                late: r6 ? r6.late : 0,
                                                attendanceRate: r1 && r1.total > 0 ? ((r5.present / r1.total) * 100).toFixed(1) : 0
                                            };

                                            let scansHtml = recentScans.map(scan => `
                                                <tr>
                                                    <td><b>${scan.full_name}</b><br><small>${scan.sid}</small></td>
                                                    <td>${scan.position}</td>
                                                    <td>${scan.time_in ? new Date(scan.time_in).toLocaleTimeString() : '-'}</td>
                                                    <td><span class="badge ${scan.status === 'Present' ? 'badge-success' : 'badge-warning'}">${scan.status}</span></td>
                                                </tr>
                                            `).join('');

                                            const content = `
                                            <div class="card" style="background: linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%); color: white; padding: 30px;">
                                                <h2>Welcome to ${settings ? settings.school_name : 'School'} Attendance System</h2>
                                                <p style="margin-top: 5px; opacity: 0.9;">Student Club: <b>${settings ? settings.club_name : ''}</b> | School Year: <b>${settings ? settings.school_year : ''}</b> | Adviser: <b>${settings ? settings.adviser : ''}</b></p>
                                                ${activeEvent ? `<div style="margin-top: 15px; background: rgba(255,255,255,0.2); padding: 10px 15px; border-radius: 8px; display: inline-block;"><i class="fa-solid fa-bolt"></i> Active Event: <b>${activeEvent.event_name}</b> (${activeEvent.start_time} - ${activeEvent.end_time})</div>` : `<div style="margin-top: 15px; background: rgba(255,255,255,0.2); padding: 10px 15px; border-radius: 8px; display: inline-block;"><i class="fa-solid fa-circle-exclamation"></i> No Active Event Currently Running</div>`}
                                            </div>

                                            <div class="grid-4">
                                                <div class="stat-card">
                                                    <div class="stat-icon"><i class="fa-solid fa-users"></i></div>
                                                    <div class="stat-info"><h3>${stats.total}</h3><p>Total Students</p></div>
                                                </div>
                                                <div class="stat-card">
                                                    <div class="stat-icon" style="background: var(--success);"><i class="fa-solid fa-user-check"></i></div>
                                                    <div class="stat-info"><h3>${stats.active}</h3><p>Active Members</p></div>
                                                </div>
                                                <div class="stat-card">
                                                    <div class="stat-icon" style="background: var(--warning);"><i class="fa-solid fa-user-clock"></i></div>
                                                    <div class="stat-info"><h3>${stats.present}</h3><p>Present Today</p></div>
                                                </div>
                                                <div class="stat-card">
                                                    <div class="stat-icon" style="background: var(--secondary);"><i class="fa-solid fa-chart-line"></i></div>
                                                    <div class="stat-info"><h3>${stats.attendanceRate}%</h3><p>Attendance Rate</p></div>
                                                </div>
                                            </div>

                                            <div class="card">
                                                <h3><i class="fa-solid fa-clock-rotate-left"></i> Recent Live Attendance Scans</h3>
                                                <table>
                                                    <thead>
                                                        <tr>
                                                            <th>Student Name</th>
                                                            <th>Position</th>
                                                            <th>Time In</th>
                                                            <th>Status</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        ${scansHtml || '<tr><td colspan="4" style="text-align: center; color: var(--gray);">No scans recorded today yet.</td></tr>'}
                                                    </tbody>
                                                </table>
                                            </div>`;

                                            res.send(renderLayout('Dashboard', req.session.user, content));
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// ================= STUDENTS MANAGEMENT ================= //
app.get('/admin/students', isAuthenticated, isAdmin, (req, res) => {
    const search = req.query.search || '';
    const posFilter = req.query.position || '';
    
    let query = `SELECT * FROM students WHERE (first_name LIKE ? OR last_name LIKE ? OR student_id LIKE ? OR full_name LIKE ?)`;
    let params = [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`];

    if (posFilter) {
        query += ` AND position = ?`;
        params.push(posFilter);
    }
    query += ` ORDER BY last_name ASC`;

    db.all(query, params, (err, students) => {
        db.all(`SELECT * FROM positions ORDER BY position_name ASC`, (err, positions) => {
            let studentsRows = students.map(s => `
                <tr>
                    <td><b>${s.student_id}</b></td>
                    <td>${s.full_name}</td>
                    <td><span class="badge badge-info">${s.position}</span></td>
                    <td>${s.contact_number || '-'}</td>
                    <td><span class="badge ${s.membership_status === 'Active' ? 'badge-success' : 'badge-danger'}">${s.membership_status}</span></td>
                    <td>
                        <a href="/admin/student/view/${s.student_id}" class="btn btn-primary" style="padding: 4px 8px; font-size: 0.75rem;"><i class="fa-solid fa-eye"></i> View</a>
                        <a href="/admin/student/edit/${s.student_id}" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.75rem;"><i class="fa-solid fa-pen"></i> Edit</a>
                        <a href="/admin/student/id/${s.student_id}" target="_blank" class="btn btn-success" style="padding: 4px 8px; font-size: 0.75rem;"><i class="fa-solid fa-id-card"></i> ID</a>
                    </td>
                </tr>
            `).join('');

            let posOptions = positions.map(p => `<option value="${p.position_name}" ${posFilter === p.position_name ? 'selected' : ''}>${p.position_name}</option>`).join('');
            let modalPosOptions = positions.map(p => `<option value="${p.position_name}">${p.position_name}</option>`).join('');

            const content = `
            <div class="card">
                <div class="flex justify-between align-center" style="margin-bottom: 20px;">
                    <h3><i class="fa-solid fa-users"></i> Student Members Management</h3>
                    <button class="btn btn-primary" onclick="document.getElementById('addModal').style.display='flex'"><i class="fa-solid fa-user-plus"></i> Add New Student</button>
                </div>
                <form method="GET" action="/admin/students" class="flex" style="gap: 10px; margin-bottom: 20px;">
                    <input type="text" name="search" class="form-control" placeholder="Search by ID, First Name, Last Name..." value="${search}">
                    <select name="position" class="form-control" style="width: 200px;">
                        <option value="">All Positions</option>
                        ${posOptions}
                    </select>
                    <button type="submit" class="btn btn-primary"><i class="fa-solid fa-search"></i> Filter</button>
                </form>
                <table>
                    <thead>
                        <tr>
                            <th>Student ID</th>
                            <th>Full Name</th>
                            <th>Position</th>
                            <th>Contact</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${studentsRows || '<tr><td colspan="6" style="text-align: center; color: var(--gray);">No students found.</td></tr>'}
                    </tbody>
                </table>
            </div>

            <!-- Add Student Modal -->
            <div id="addModal" class="modal">
                <div class="modal-content">
                    <h3>Register New Student Member</h3>
                    <form action="/admin/student/add" method="POST" style="margin-top: 15px;">
                        <div class="form-group">
                            <label>Student ID (Must be Unique)</label>
                            <input type="text" name="student_id" class="form-control" required placeholder="e.g. 2026-005">
                        </div>
                        <div class="flex" style="gap: 10px;">
                            <div class="form-group" style="flex:1;">
                                <label>First Name</label>
                                <input type="text" name="first_name" class="form-control" required>
                            </div>
                            <div class="form-group" style="flex:1;">
                                <label>Middle Name</label>
                                <input type="text" name="middle_name" class="form-control">
                            </div>
                            <div class="form-group" style="flex:1;">
                                <label>Last Name</label>
                                <input type="text" name="last_name" class="form-control" required>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Position / Role</label>
                            <select name="position" class="form-control" required>
                                ${modalPosOptions}
                            </select>
                        </div>
                        <div class="flex" style="gap: 10px;">
                            <div class="form-group" style="flex:1;">
                                <label>Gender</label>
                                <select name="gender" class="form-control">
                                    <option value="Male">Male</option>
                                    <option value="Female">Female</option>
                                    <option value="Other">Other</option>
                                </select>
                            </div>
                            <div class="form-group" style="flex:1;">
                                <label>Contact Number</label>
                                <input type="text" name="contact_number" class="form-control" placeholder="+63...">
                            </div>
                        </div>
                        <div class="form-group">
                            <label>School Email</label>
                            <input type="email" name="school_email" class="form-control" placeholder="student@abcnhs.edu.ph">
                        </div>
                        <div class="form-group">
                            <label>Home Address</label>
                            <input type="text" name="address" class="form-control">
                        </div>
                        <div class="flex" style="justify-content: flex-end; gap: 10px; margin-top: 20px;">
                            <button type="button" class="btn btn-danger" onclick="document.getElementById('addModal').style.display='none'">Cancel</button>
                            <button type="submit" class="btn btn-primary">Save Student</button>
                        </div>
                    </form>
                </div>
            </div>`;

            res.send(renderLayout('Students Management', req.session.user, content));
        });
    });
});

app.post('/admin/student/add', isAuthenticated, isAdmin, (req, res) => {
    const { student_id, first_name, middle_name, last_name, position, gender, contact_number, school_email, address } = req.body;
    const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;
    const qr_token = 'QR-' + student_id + '-' + Math.random().toString(36).substring(2, 9);
    
    db.run(`INSERT INTO students (student_id, first_name, middle_name, last_name, full_name, position, gender, contact_number, school_email, address, qr_token, date_joined, membership_expiration_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), date('now', '+1 year'))`,
        [student_id, first_name, middle_name, last_name, full_name, position, gender, contact_number, school_email, address, qr_token], (err) => {
            if (!err) {
                // Also create student user account
                const passwordHash = bcrypt.hashSync('student123', 10);
                db.run(`INSERT OR IGNORE INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)`, [student_id, passwordHash, student_id]);
                db.run(`INSERT INTO position_history (student_id, position, school_year) VALUES (?, ?, '2026–2027')`, [student_id, position]);
                logAudit(req.session.user.username, 'Add Student', `Registered student ${full_name} (${student_id})`);
            }
            res.redirect('/admin/students');
        });
});

// View Student Profile & Digital ID Card
app.get('/admin/student/view/:id', isAuthenticated, isAdmin, (req, res) => {
    const studentId = req.params.id;
    db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, student) => {
        if (!student) return res.send('Student not found');
        db.all(`SELECT * FROM position_history WHERE student_id = ?`, [studentId], (err, history) => {
            db.all(`SELECT a.*, e.event_name, e.event_date FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.student_id = ? ORDER BY e.event_date DESC`, [studentId], (err, attendanceHistory) => {
                
                QRCode.toDataURL(student.qr_token, { width: 300 }, (err, qrCodeUrl) => {
                    let historyRows = history.map(h => `<tr><td>${h.school_year}</td><td><b>${h.position}</b></td><td>${h.assigned_date}</td></tr>`).join('');
                    let attRows = attendanceHistory.map(a => `<tr><td>${a.event_name}</td><td>${a.event_date}</td><td>${a.time_in ? new Date(a.time_in).toLocaleTimeString() : '-'}</td><td><span class="badge ${a.status === 'Present' ? 'badge-success' : 'badge-warning'}">${a.status}</span></td></tr>`).join('');

                    const content = `
                    <div class="flex" style="gap: 20px; align-items: flex-start;">
                        <div class="card" style="flex: 1; text-align: center;">
                            <div style="background: var(--primary); color: white; padding: 15px; border-radius: 8px 8px 0 0; margin: -25px -25px 20px -25px;">
                                <h4>ABC National High School</h4>
                                <small>Official Student Club ID Card</small>
                            </div>
                            <div style="width: 100px; height: 100px; background: #e2e8f0; border-radius: 50%; margin: 0 auto 15px auto; display: flex; align-items: center; justify-content: center; font-size: 2.5rem; color: var(--gray);">
                                <i class="fa-solid fa-user"></i>
                            </div>
                            <h3>${student.full_name}</h3>
                            <p style="color: var(--primary); font-weight: 600; margin-bottom: 5px;">${student.position}</p>
                            <p style="color: var(--gray); font-size: 0.85rem; margin-bottom: 15px;">ID: ${student.student_id}</p>
                            <img src="${qrCodeUrl}" alt="QR Code" style="width: 180px; height: 180px; border: 1px solid var(--border); padding: 5px; border-radius: 8px;">
                            <p style="font-size: 0.75rem; color: var(--gray); margin-top: 10px;">Club: Computer Club | SY: 2026–2027</p>
                            <div style="margin-top: 20px;">
                                <button onclick="window.print()" class="btn btn-primary"><i class="fa-solid fa-print"></i> Print ID Card</button>
                            </div>
                        </div>
                        <div class="card" style="flex: 2;">
                            <h3>Student Profile & History</h3>
                            <table style="margin-bottom: 20px;">
                                <tr><td><b>Email:</b> ${student.school_email || '-'}</td><td><b>Contact:</b> ${student.contact_number || '-'}</td></tr>
                                <tr><td><b>Gender:</b> ${student.gender || '-'}</td><td><b>Status:</b> ${student.membership_status}</td></tr>
                                <tr><td colspan="2"><b>Address:</b> ${student.address || '-'}</td></tr>
                            </table>
                            <h4>Position History</h4>
                            <table>
                                <tr><th>School Year</th><th>Position</th><th>Assigned Date</th></tr>
                                ${historyRows}
                            </table>
                            <h4 style="margin-top: 20px;">Attendance Records</h4>
                            <table>
                                <tr><th>Event</th><th>Date</th><th>Time In</th><th>Status</th></tr>
                                ${attRows || '<tr><td colspan="4">No attendance records yet.</td></tr>'}
                            </table>
                        </div>
                    </div>`;

                    res.send(renderLayout('Student Profile', req.session.user, content));
                });
            });
        });
    });
});

// Single ID Printable Route
app.get('/admin/student/id/:id', isAuthenticated, isAdmin, (req, res) => {
    const studentId = req.params.id;
    db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, student) => {
        if (!student) return res.send('Student not found');
        QRCode.toDataURL(student.qr_token, { width: 250 }, (err, qrCodeUrl) => {
            res.send(`<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Student ID - ${student.full_name}</title>
                <style>
                    body { font-family: 'Inter', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f8fafc; }
                    .id-card { width: 320px; height: 500px; border: 2px solid #4f46e5; border-radius: 12px; background: white; padding: 20px; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.1); position: relative; overflow: hidden; }
                    .id-header { background: #4f46e5; color: white; margin: -20px -20px 15px -20px; padding: 15px; }
                    .id-header h3 { font-size: 0.95rem; margin-bottom: 3px; }
                    .id-header p { font-size: 0.75rem; opacity: 0.9; }
                    .avatar { width: 90px; height: 90px; background: #e2e8f0; border-radius: 50%; margin: 0 auto 10px auto; display: flex; align-items: center; justify-content: center; font-size: 2rem; color: #64748b; }
                    .name { font-size: 1.1rem; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
                    .position { font-size: 0.9rem; font-weight: 600; color: #06b6d4; margin-bottom: 10px; }
                    .details { font-size: 0.8rem; color: #64748b; margin-bottom: 15px; }
                    .qr-container img { width: 130px; height: 130px; }
                    @media print { body { background: white; } }
                </style>
            </head>
            <body onload="window.print()">
                <div class="id-card">
                    <div class="id-header">
                        <h3>ABC National High School</h3>
                        <p>Computer Club Student ID</p>
                    </div>
                    <div class="avatar"><i class="fa-solid fa-user"></i></div>
                    <div class="name">${student.full_name}</div>
                    <div class="position">${student.position}</div>
                    <div class="details">ID: ${student.student_id} | SY: 2026–2027</div>
                    <div class="qr-container">
                        <img src="${qrCodeUrl}" alt="QR">
                    </div>
                </div>
            </body>
            </html>`);
        });
    });
});

// ================= A4 ID PRINTING (8 IDs PER PAGE) ================= //
app.get('/admin/id-printing', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT * FROM students WHERE membership_status='Active' ORDER BY last_name ASC`, (err, students) => {
        let studentCheckboxes = students.map(s => `
            <label style="display: flex; align-items: center; gap: 10px; padding: 8px; border-bottom: 1px solid var(--border);">
                <input type="checkbox" name="student_ids" value="${s.student_id}" checked style="width: 18px; height: 18px;">
                <span><b>${s.full_name}</b> (${s.student_id}) — <span style="color: var(--primary);">${s.position}</span></span>
            </label>
        `).join('');

        const content = `
        <div class="card">
            <h3><i class="fa-solid fa-print"></i> A4 Student Club ID Card Batch Generator</h3>
            <p style="color: var(--gray); font-size: 0.9rem; margin-bottom: 20px;">Automatically formats and arranges 8 ID cards per A4 bond paper with cut guides.</p>
            <form action="/admin/print-batch" method="POST" target="_blank">
                <div style="margin-bottom: 20px;">
                    <button type="submit" class="btn btn-primary"><i class="fa-solid fa-print"></i> Generate & Print Selected IDs (8 per A4)</button>
                </div>
                <div style="max-height: 450px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 10px;">
                    ${studentCheckboxes}
                </div>
            </form>
        </div>`;
        res.send(renderLayout('ID Card Printing', req.session.user, content));
    });
});

app.post('/admin/print-batch', isAuthenticated, isAdmin, (req, res) => {
    let selectedIds = req.body.student_ids;
    if (!selectedIds) return res.send('No students selected.');
    if (!Array.isArray(selectedIds)) selectedIds = [selectedIds];

    db.all(`SELECT * FROM students WHERE student_id IN (${selectedIds.map(() => '?').join(',')})`, selectedIds, async (err, students) => {
        let cardsHtml = '';
        for (let student of students) {
            const qrCodeUrl = await QRCode.toDataURL(student.qr_token, { width: 200 });
            cardsHtml += `
            <div class="id-card">
                <div class="id-header">
                    <h4>ABC National High School</h4>
                    <p>Computer Club Member ID</p>
                </div>
                <div class="avatar"><i class="fa-solid fa-user"></i></div>
                <div class="name">${student.full_name}</div>
                <div class="position">${student.position}</div>
                <div class="details">ID: ${student.student_id} | SY: 2026–2027</div>
                <div class="qr-container"><img src="${qrCodeUrl}" alt="QR"></div>
            </div>`;
        }

        res.send(`<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>A4 Batch ID Printing</title>
            <style>
                @page { size: A4 portrait; margin: 10mm; }
                body { font-family: 'Inter', sans-serif; background: white; margin: 0; padding: 0; }
                .a4-page { width: 210mm; height: 297mm; display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(4, 1fr); gap: 10mm; padding: 10mm; box-sizing: border-box; page-break-after: always; }
                .id-card { width: 85.6mm; height: 54mm; border: 1px dashed #94a3b8; border-radius: 8px; background: white; padding: 10px; text-align: center; box-sizing: border-box; position: relative; display: flex; flex-direction: column; align-items: center; justify-content: space-between; }
                .id-header { background: #4f46e5; color: white; width: 100%; margin: -10px -10px 5px -10px; padding: 6px; border-radius: 8px 8px 0 0; }
                .id-header h4 { font-size: 0.75rem; margin: 0; }
                .id-header p { font-size: 0.6rem; margin: 0; opacity: 0.9; }
                .avatar { width: 40px; height: 40px; background: #e2e8f0; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; color: #64748b; }
                .name { font-size: 0.85rem; font-weight: 700; color: #1e293b; }
                .position { font-size: 0.75rem; font-weight: 600; color: #06b6d4; }
                .details { font-size: 0.65rem; color: #64748b; }
                .qr-container img { width: 65px; height: 65px; }
            </style>
        </head>
        <body onload="window.print()">
            <div class="a4-page">
                ${cardsHtml}
            </div>
        </body>
        </html>`);
    });
});

// ================= POSITION MANAGEMENT ================= //
app.get('/admin/positions', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT p.*, COUNT(s.id) as student_count FROM positions p LEFT JOIN students s ON p.position_name = s.position GROUP BY p.id ORDER BY p.position_name ASC`, (err, positions) => {
        let posRows = positions.map(p => `
            <tr>
                <td><b>${p.position_name}</b></td>
                <td>${p.description || 'Custom Club Position'}</td>
                <td><span class="badge badge-info">${p.student_count} Students Assigned</span></td>
                <td>
                    <button onclick="editPos(${p.id}, '${p.position_name}', '${p.description || ''}')" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.75rem;"><i class="fa-solid fa-pen"></i> Edit</button>
                    <a href="/admin/position/delete/${p.id}" class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="return confirm('Delete this position?')"><i class="fa-solid fa-trash"></i> Delete</a>
                </td>
            </tr>
        `).join('');

        const content = `
        <div class="card">
            <div class="flex justify-between align-center" style="margin-bottom: 20px;">
                <h3><i class="fa-solid fa-id-badge"></i> Customizable Position Management</h3>
                <button class="btn btn-primary" onclick="document.getElementById('posModal').style.display='flex'"><i class="fa-solid fa-plus"></i> Add New Position</button>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Position Name</th>
                        <th>Description</th>
                        <th>Members Count</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${posRows}
                </tbody>
            </table>
        </div>

        <!-- Position Modal -->
        <div id="posModal" class="modal">
            <div class="modal-content">
                <h3 id="modalTitle">Create Custom Position</h3>
                <form action="/admin/position/save" method="POST" style="margin-top: 15px;">
                    <input type="hidden" name="id" id="posId">
                    <div class="form-group">
                        <label>Position Name</label>
                        <input type="text" name="position_name" id="posName" class="form-control" required placeholder="e.g. Event Coordinator">
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea name="description" id="posDesc" class="form-control" rows="3"></textarea>
                    </div>
                    <div class="flex" style="justify-content: flex-end; gap: 10px; margin-top: 20px;">
                        <button type="button" class="btn btn-danger" onclick="document.getElementById('posModal').style.display='none'">Cancel</button>
                        <button type="submit" class="btn btn-primary">Save Position</button>
                    </div>
                </form>
            </div>
        </div>
        <script>
            function editPos(id, name, desc) {
                document.getElementById('posId').value = id;
                document.getElementById('posName').value = name;
                document.getElementById('posDesc').value = desc;
                document.getElementById('modalTitle').innerText = 'Edit Position';
                document.getElementById('posModal').style.display = 'flex';
            }
        </script>`;

        res.send(renderLayout('Position Management', req.session.user, content));
    });
});

app.post('/admin/position/save', isAuthenticated, isAdmin, (req, res) => {
    const { id, position_name, description } = req.body;
    if (id) {
        db.run(`UPDATE positions SET position_name = ?, description = ? WHERE id = ?`, [position_name, description, id], () => {
            logAudit(req.session.user.username, 'Edit Position', `Updated position ${position_name}`);
            res.redirect('/admin/positions');
        });
    } else {
        db.run(`INSERT OR IGNORE INTO positions (position_name, description) VALUES (?, ?)`, [position_name, description], () => {
            logAudit(req.session.user.username, 'Add Position', `Created new position ${position_name}`);
            res.redirect('/admin/positions');
        });
    }
});

app.get('/admin/position/delete/:id', isAuthenticated, isAdmin, (req, res) => {
    db.run(`DELETE FROM positions WHERE id = ?`, [req.params.id], () => {
        logAudit(req.session.user.username, 'Delete Position', `Deleted position ID ${req.params.id}`);
        res.redirect('/admin/positions');
    });
});

// ================= EVENT MANAGEMENT ================= //
app.get('/admin/events', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT e.*, (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id) as attendance_count FROM events e ORDER BY e.event_date DESC`, (err, events) => {
        let eventRows = events.map(ev => `
            <tr>
                <td><b>${ev.event_name}</b><br><small>${ev.event_type}</small></td>
                <td>${ev.event_date} (${ev.start_time} - ${ev.end_time})</td>
                <td>${ev.location || '-'}</td>
                <td><span class="badge ${ev.status === 'Active' ? 'badge-success' : ev.status === 'Upcoming' ? 'badge-warning' : 'badge-info'}">${ev.status}</span></td>
                <td>${ev.attendance_count} Attendees</td>
                <td>
                    <a href="/admin/event/view/${ev.id}" class="btn btn-primary" style="padding: 4px 8px; font-size: 0.75rem;"><i class="fa-solid fa-eye"></i> View</a>
                    <a href="/admin/event/status/${ev.id}" class="btn btn-warning" style="padding: 4px 8px; font-size: 0.75rem;"><i class="fa-solid fa-toggle-on"></i> Status</a>
                </td>
            </tr>
        `).join('');

        const content = `
        <div class="card">
            <div class="flex justify-between align-center" style="margin-bottom: 20px;">
                <h3><i class="fa-solid fa-calendar-days"></i> Event Management & Attendance Tracking</h3>
                <button class="btn btn-primary" onclick="document.getElementById('eventModal').style.display='flex'"><i class="fa-solid fa-plus"></i> Create New Event</button>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Event Name</th>
                        <th>Date & Time</th>
                        <th>Location</th>
                        <th>Status</th>
                        <th>Attendance</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${eventRows}
                </tbody>
            </table>
        </div>

        <!-- Event Modal -->
        <div id="eventModal" class="modal">
            <div class="modal-content">
                <h3>Create Club Event</h3>
                <form action="/admin/event/add" method="POST" style="margin-top: 15px;">
                    <div class="form-group">
                        <label>Event Name</label>
                        <input type="text" name="event_name" class="form-control" required placeholder="e.g. General Assembly">
                    </div>
                    <div class="form-group">
                        <label>Event Type</label>
                        <select name="event_type" class="form-control">
                            <option value="General Assembly">General Assembly</option>
                            <option value="Club Meeting">Club Meeting</option>
                            <option value="Officer Meeting">Officer Meeting</option>
                            <option value="Seminar / Workshop">Seminar / Workshop</option>
                            <option value="Community Service">Community Service</option>
                            <option value="Special Event">Special Event</option>
                        </select>
                    </div>
                    <div class="flex" style="gap: 10px;">
                        <div class="form-group" style="flex:1;">
                            <label>Event Date</label>
                            <input type="date" name="event_date" class="form-control" required>
                        </div>
                        <div class="form-group" style="flex:1;">
                            <label>Start Time</label>
                            <input type="time" name="start_time" class="form-control" required>
                        </div>
                        <div class="form-group" style="flex:1;">
                            <label>End Time</label>
                            <input type="time" name="end_time" class="form-control" required>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Location / Venue</label>
                        <input type="text" name="location" class="form-control" placeholder="School Gymnasium">
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea name="description" class="form-control" rows="2"></textarea>
                    </div>
                    <div class="flex" style="justify-content: flex-end; gap: 10px; margin-top: 20px;">
                        <button type="button" class="btn btn-danger" onclick="document.getElementById('eventModal').style.display='none'">Cancel</button>
                        <button type="submit" class="btn btn-primary">Create Event</button>
                    </div>
                </form>
            </div>
        </div>`;

        res.send(renderLayout('Event Management', req.session.user, content));
    });
});

app.post('/admin/event/add', isAuthenticated, isAdmin, (req, res) => {
    const { event_name, event_type, event_date, start_time, end_time, location, description } = req.body;
    db.run(`INSERT INTO events (event_name, event_type, event_date, start_time, end_time, location, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Upcoming')`,
        [event_name, event_type, event_date, start_time, end_time, location, description], () => {
            logAudit(req.session.user.username, 'Create Event', `Created event ${event_name}`);
            res.redirect('/admin/events');
        });
});

app.get('/admin/event/status/:id', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM events WHERE id = ?`, [req.params.id], (err, ev) => {
        if (!ev) return res.redirect('/admin/events');
        let newStatus = ev.status === 'Upcoming' ? 'Active' : ev.status === 'Active' ? 'Completed' : 'Upcoming';
        db.run(`UPDATE events SET status = ? WHERE id = ?`, [newStatus, req.params.id], () => {
            logAudit(req.session.user.username, 'Update Event Status', `Changed event ${ev.event_name} status to ${newStatus}`);
            res.redirect('/admin/events');
        });
    });
});

app.get('/admin/event/view/:id', isAuthenticated, isAdmin, (req, res) => {
    const eventId = req.params.id;
    db.get(`SELECT * FROM events WHERE id = ?`, [eventId], (err, event) => {
        if (!event) return res.send('Event not found');
        db.all(`SELECT a.*, s.full_name, s.position FROM attendance a JOIN students s ON a.student_id = s.student_id WHERE a.event_id = ?`, [eventId], (err, attendees) => {
            
            let attendeeRows = attendees.map(at => `
                <tr>
                    <td><b>${at.student_id}</b></td>
                    <td>${at.full_name}</td>
                    <td>${at.position}</td>
                    <td>${at.time_in ? new Date(at.time_in).toLocaleTimeString() : '-'}</td>
                    <td>${at.time_out ? new Date(at.time_out).toLocaleTimeString() : '-'}</td>
                    <td><span class="badge ${at.status === 'Present' ? 'badge-success' : at.status === 'Late' ? 'badge-warning' : 'badge-danger'}">${at.status}</span></td>
                </tr>
            `).join('');

            const content = `
            <div class="card">
                <h3><i class="fa-solid fa-calendar-days"></i> Event Details: ${event.event_name}</h3>
                <p style="color: var(--gray); margin-bottom: 20px;">Date: ${event.event_date} | Time: ${event.start_time} - ${event.end_time} | Location: ${event.location || 'N/A'} | Status: <b style="color: var(--primary);">${event.status}</b></p>
                
                <h4 style="margin-bottom: 10px;">Event Attendees</h4>
                <table>
                    <thead>
                        <tr>
                            <th>Student ID</th>
                            <th>Full Name</th>
                            <th>Position</th>
                            <th>Time In</th>
                            <th>Time Out</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${attendeeRows || '<tr><td colspan="6" style="text-align: center; color: var(--gray);">No attendance recorded for this event yet.</td></tr>'}
                    </tbody>
                </table>
            </div>`;

            res.send(renderLayout('Event Attendance', req.session.user, content));
        });
    });
});

// ================= SCANNER PORTAL (/scanner) ================= //
app.get('/scanner', isScanner, (req, res) => {
    db.all(`SELECT * FROM events WHERE status IN ('Upcoming', 'Active') ORDER BY event_date DESC`, (err, events) => {
        let eventOptions = events.map(e => `<option value="${e.id}" ${e.status === 'Active' ? 'selected' : ''}>${e.event_name} (${e.event_date})</option>`).join('');

        res.send(`<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QR Scanner Portal | Club Attendance</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                body { background: #0f172a; color: white; font-family: 'Inter', sans-serif; display: flex; flex-direction: column; height: 100vh; margin: 0; }
                .scanner-header { padding: 15px 25px; background: #1e293b; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
                .scanner-body { flex-grow: 1; display: flex; gap: 20px; padding: 20px; overflow: hidden; }
                .scanner-panel { flex: 1; background: #1e293b; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid #334155; position: relative; }
                .info-panel { flex: 1; background: #1e293b; border-radius: 12px; padding: 25px; border: 1px solid #334155; display: flex; flex-direction: column; justify-content: space-between; }
                .form-control { width: 100%; padding: 10px; background: #0f172a; border: 1px solid #334155; color: white; border-radius: 6px; font-size: 0.9rem; margin-top: 5px; }
                .btn { padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; border: none; font-size: 0.9rem; }
                .btn-primary { background: #4f46e5; color: white; }
                .btn-success { background: #10b981; color: white; }
                .scan-box { width: 100%; max-width: 350px; height: 250px; border: 2px dashed #06b6d4; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; background: rgba(6,182,212,0.05); }
                #result-card { background: #0f172a; border-radius: 8px; padding: 20px; text-align: center; border: 1px solid #334155; margin-top: 15px; }
            </style>
        </head>
        <body>
            <div class="scanner-header">
                <h3><i class="fa-solid fa-qrcode"></i> Mobile QR Scanner Portal</h3>
                <div>
                    <span style="margin-right: 15px; font-size: 0.9rem;"><i class="fa-solid fa-user"></i> ${req.session.user.username}</span>
                    <a href="/admin" class="btn btn-primary" style="padding: 6px 12px; font-size: 0.8rem; text-decoration: none;">Dashboard</a>
                </div>
            </div>
            <div class="scanner-body">
                <div class="scanner-panel">
                    <div style="width: 100%; margin-bottom: 15px;">
                        <label style="font-size: 0.85rem; color: #94a3b8;">Select Active Event:</label>
                        <select id="eventSelect" class="form-control">
                            ${eventOptions}
                        </select>
                    </div>
                    <div style="margin-bottom: 15px; display: flex; gap: 10px;">
                        <button type="button" id="modeTimeIn" class="btn btn-success" onclick="setMode('IN')">MODE: TIME IN</button>
                        <button type="button" id="modeTimeOut" class="btn btn-primary" onclick="setMode('OUT')">MODE: TIME OUT</button>
                    </div>
                    <div class="scan-box">
                        <i class="fa-solid fa-camera" style="font-size: 3rem; color: #06b6d4; margin-bottom: 10px;"></i>
                        <p style="font-size: 0.85rem; color: #94a3b8;">Ready to scan QR Code...</p>
                        <input type="text" id="manualQrInput" placeholder="Click here & scan QR token..." class="form-control" style="position: absolute; bottom: 15px; width: 90%;" autofocus>
                    </div>
                </div>
                <div class="info-panel">
                    <div>
                        <h3>Scan Result & Voice Verification</h3>
                        <div id="result-card">
                            <h4 style="color: #94a3b8;">Waiting for scan...</h4>
                            <p style="font-size: 0.85rem; margin-top: 5px;">Scan student ID QR code to record attendance.</p>
                        </div>
                    </div>
                    <div>
                        <audio id="successSound" src="https://actions.google.com/sounds/v1/cartoon/success_bell.ogg"></audio>
                        <audio id="errorSound" src="https://actions.google.com/sounds/v1/cartoon/clang_and_wobble.ogg"></audio>
                    </div>
                </div>
            </div>
            <script>
                let currentMode = 'IN';
                function setMode(mode) {
                    currentMode = mode;
                    document.getElementById('modeTimeIn').style.background = mode === 'IN' ? '#10b981' : '#334155';
                    document.getElementById('modeTimeOut').style.background = mode === 'OUT' ? '#4f46e5' : '#334155';
                }

                const manualInput = document.getElementById('manualQrInput');
                manualInput.addEventListener('keypress', function (e) {
                    if (e.key === 'Enter') {
                        const token = this.value.trim();
                        const eventId = document.getElementById('eventSelect').value;
                        if (!token) return;
                        
                        fetch('/api/scan', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ token, event_id: eventId, mode: currentMode })
                        })
                        .then(res => res.json())
                        .then(data => {
                            const resCard = document.getElementById('result-card');
                            if (data.success) {
                                document.getElementById('successSound').play();
                                speakText(data.message);
                                resCard.style.borderColor = '#10b981';
                                resCard.innerHTML = \`<h3 style="color: #10b981;"><i class="fa-solid fa-check-circle"></i> \${data.status} RECORDED</h3>
                                    <h4 style="margin-top: 10px;">\${data.student.full_name}</h4>
                                    <p style="font-size: 0.85rem; color: #94a3b8;">Position: \${data.student.position} | ID: \${data.student.student_id}</p>
                                    <p style="font-size: 0.8rem; margin-top: 5px; color: #38bdf8;">Time: \${data.time}</p>\`;
                            } else {
                                document.getElementById('errorSound').play();
                                speakText(data.message);
                                resCard.style.borderColor = '#ef4444';
                                resCard.innerHTML = \`<h3 style="color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> \${data.message}</h3>\`;
                            }
                            manualInput.value = '';
                        });
                    }
                });

                function speakText(text) {
                    if ('speechSynthesis' in window) {
                        const utterance = new SpeechSynthesisUtterance(text);
                        utterance.rate = 1.0;
                        utterance.pitch = 1.0;
                        window.speechSynthesis.speak(utterance);
                    }
                }
            </script>
        </body>
        </html>`);
    });
});

// Scan API Endpoint
app.post('/api/scan', isScanner, (req, res) => {
    const { token, event_id, mode } = req.body;
    db.get(`SELECT * FROM students WHERE qr_token = ? AND qr_status = 'active'`, [token], (err, student) => {
        if (!student) {
            return res.json({ success: false, message: 'Invalid or disabled QR Code.' });
        }

        db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student.student_id], (err, att) => {
            const now = new Date().toISOString();
            if (mode === 'IN') {
                if (att && att.time_in) {
                    return res.json({ success: false, message: `${student.full_name} is already recorded for this event.` });
                }
                const status = 'Present';
                if (att) {
                    db.run(`UPDATE attendance SET time_in = ?, status = ? WHERE id = ?`, [now, status, att.id], () => {
                        res.json({ success: true, status: 'TIME IN', student, time: new Date().toLocaleTimeString(), message: `${student.full_name}, time in recorded.` });
                    });
                } else {
                    db.run(`INSERT INTO attendance (event_id, student_id, time_in, status) VALUES (?, ?, ?, ?)`, [event_id, student.student_id, now, status], () => {
                        res.json({ success: true, status: 'TIME IN', student, time: new Date().toLocaleTimeString(), message: `${student.full_name}, attendance recorded.` });
                    });
                }
            } else {
                // TIME OUT
                if (!att || !att.time_in) {
                    return res.json({ success: false, message: `${student.full_name} has no Time In record yet.` });
                }
                db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [now, att.id], () => {
                    res.json({ success: true, status: 'TIME OUT', student, time: new Date().toLocaleTimeString(), message: `${student.full_name}, time out recorded.` });
                });
            }
        });
    });
});

// ================= STUDENT PORTAL (/member) ================= //
app.get('/member', isAuthenticated, isStudent, (req, res) => {
    const studentId = req.session.user.student_id;
    db.get(`SELECT * FROM students WHERE student_id = ?`, [studentId], (err, student) => {
        db.all(`SELECT a.*, e.event_name, e.event_date FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.student_id = ?`, [studentId], (err, attendances) => {
            
            QRCode.toDataURL(student.qr_token, { width: 250 }, (err, qrCodeUrl) => {
                let attRows = attendances.map(a => `<tr><td>${a.event_name}</td><td>${a.event_date}</td><td>${a.time_in ? new Date(a.time_in).toLocaleTimeString() : '-'}</td><td><span class="badge badge-success">${a.status}</span></td></tr>`).join('');

                const content = `
                <div class="flex" style="gap: 20px; align-items: flex-start;">
                    <div class="card" style="flex: 1; text-align: center;">
                        <div style="background: var(--primary); color: white; padding: 15px; border-radius: 8px 8px 0 0; margin: -25px -25px 20px -25px;">
                            <h4>Student Club Member Portal</h4>
                            <small>${student.full_name}</small>
                        </div>
                        <img src="${qrCodeUrl}" alt="QR" style="width: 200px; height: 200px; border: 1px solid var(--border); padding: 5px; border-radius: 8px;">
                        <h3 style="margin-top: 15px;">${student.full_name}</h3>
                        <p style="color: var(--primary); font-weight: 600;">${student.position}</p>
                        <p style="color: var(--gray); font-size: 0.85rem;">ID: ${student.student_id}</p>
                    </div>
                    <div class="card" style="flex: 2;">
                        <h3>My Attendance History</h3>
                        <table>
                            <tr><th>Event</th><th>Date</th><th>Time In</th><th>Status</th></tr>
                            ${attRows || '<tr><td colspan="4">No attendance history found.</td></tr>'}
                        </table>
                    </div>
                </div>`;

                res.send(renderLayout('Student Member Portal', req.session.user, content));
            });
        });
    });
});

// ================= REPORTS & ANALYTICS ================= //
app.get('/admin/reports', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT e.event_name, e.event_date, (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id) as total_attendees FROM events e`, (err, eventReports) => {
        let reportRows = eventReports.map(er => `<tr><td><b>${er.event_name}</b></td><td>${er.event_date}</td><td><span class="badge badge-info">${er.total_attendees} Attendees</span></td></tr>`).join('');

        const content = `
        <div class="card">
            <h3><i class="fa-solid fa-file-lines"></i> Attendance Reports & Analytics</h3>
            <p style="color: var(--gray); font-size: 0.9rem; margin-bottom: 20px;">Comprehensive summary of club events and participation rates.</p>
            <table>
                <thead>
                    <tr>
                        <th>Event Name</th>
                        <th>Event Date</th>
                        <th>Total Attendance</th>
                    </tr>
                </thead>
                <tbody>
                    ${reportRows}
                </tbody>
            </table>
            <div style="margin-top: 20px;">
                <button onclick="window.print()" class="btn btn-primary"><i class="fa-solid fa-print"></i> Print Official Report</button>
            </div>
        </div>`;

        res.send(renderLayout('Reports & Analytics', req.session.user, content));
    });
});

// ================= AUDIT LOGS ================= //
app.get('/admin/audit', isAuthenticated, isAdmin, (req, res) => {
    db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50`, (err, logs) => {
        let logRows = logs.map(l => `<tr><td>${l.timestamp}</td><td><b>${l.username}</b></td><td><span class="badge badge-info">${l.action}</span></td><td>${l.details}</td></tr>`).join('');
        const content = `
        <div class="card">
            <h3><i class="fa-solid fa-shield-halved"></i> System Audit Logs</h3>
            <table>
                <thead>
                    <tr><th>Timestamp</th><th>Username</th><th>Action</th><th>Details</th></tr>
                </thead>
                <tbody>
                    ${logRows}
                </tbody>
            </table>
        </div>`;
        res.send(renderLayout('Audit Logs', req.session.user, content));
    });
});

// ================= SYSTEM SETTINGS ================= //
app.get('/admin/settings', isAuthenticated, isAdmin, (req, res) => {
    db.get(`SELECT * FROM settings LIMIT 1`, (err, s) => {
        const content = `
        <div class="card" style="max-width: 700px; margin: 0 auto;">
            <h3><i class="fa-solid fa-gear"></i> System & School Information Settings</h3>
            ${req.query.success ? `<div style="background: #d1fae5; color: #065f46; padding: 10px; border-radius: 6px; margin-bottom: 15px;">Settings updated successfully!</div>` : ''}
            <form action="/admin/settings" method="POST" style="margin-top: 15px;">
                <div class="form-group">
                    <label>School Name</label>
                    <input type="text" name="school_name" class="form-control" value="${s ? s.school_name : ''}" required>
                </div>
                <div class="form-group">
                    <label>Student Club Name</label>
                    <input type="text" name="club_name" class="form-control" value="${s ? s.club_name : ''}" required>
                </div>
                <div class="form-group">
                    <label>Organization Name</label>
                    <input type="text" name="org_name" class="form-control" value="${s ? s.org_name : ''}">
                </div>
                <div class="form-group">
                    <label>Club Adviser</label>
                    <input type="text" name="adviser" class="form-control" value="${s ? s.adviser : ''}" required>
                </div>
                <div class="form-group">
                    <label>School Year</label>
                    <input type="text" name="school_year" class="form-control" value="${s ? s.school_year : ''}" required>
                </div>
                <button type="submit" class="btn btn-primary"><i class="fa-solid fa-save"></i> Save Settings</button>
            </form>
        </div>`;
        res.send(renderLayout('System Settings', req.session.user, content));
    });
});

app.post('/admin/settings', isAuthenticated, isAdmin, (req, res) => {
    const { school_name, club_name, org_name, adviser, school_year } = req.body;
    db.run(`UPDATE settings SET school_name = ?, club_name = ?, org_name = ?, adviser = ?, school_year = ? WHERE id = 1`,
        [school_name, club_name, org_name, adviser, school_year], () => {
            logAudit(req.session.user.username, 'Update Settings', 'Updated school club settings');
            res.redirect('/admin/settings?success=1');
        });
});

// Root Redirect
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Start Server
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` School Student Club QR Attendance System`);
    console.log(` Running on port: ${PORT}`);
    console.log(` Admin URL: http://localhost:${PORT}/login`);
    console.log(` Scanner URL: http://localhost:${PORT}/scanner`);
    console.log(`==================================================`);
});
