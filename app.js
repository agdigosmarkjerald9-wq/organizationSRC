/* ==========================================================================
   SCHOOL STUDENT CLUB QR ATTENDANCE SYSTEM - MONOLITHIC APPLICATION (app.js)
   Tech Stack: Express, SQLite3, BcryptJS, Express-Session, HTML5, CSS3, JS
   ========================================================================== */

const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload & data directories exist
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Middleware Setup
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'club_qr_attendance_super_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours session
}));

// Initialize SQLite Database
const dbPath = path.join(DATA_DIR, 'attendance.db');
const db = new sqlite3.Database(dbPath);

// Database Initialization Routine
db.serialize(() => {
    // Foreign keys enablement
    db.run("PRAGMA foreign_keys = ON;");

    // 1. Users / Accounts Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'scanner', 'student')),
        student_id TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Positions Table (Customizable)
    db.run(`CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT UNIQUE NOT NULL,
        description TEXT,
        is_officer INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. Student Members Table (Strictly NO Committee, Grade, Year Level, Section)
    db.run(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        position_id INTEGER,
        student_club TEXT NOT NULL DEFAULT 'Computer Club',
        school_year TEXT NOT NULL DEFAULT '2026-2027',
        gender TEXT,
        date_of_birth DATE,
        contact_number TEXT,
        school_email TEXT UNIQUE,
        address TEXT,
        photo_url TEXT,
        date_joined DATE DEFAULT CURRENT_DATE,
        membership_status TEXT DEFAULT 'Active' CHECK(membership_status IN ('Active', 'Inactive', 'Suspended', 'Alumni', 'Resigned')),
        membership_expiration DATE,
        guardian_name TEXT,
        guardian_contact TEXT,
        qr_token TEXT UNIQUE NOT NULL,
        qr_status TEXT DEFAULT 'Active' CHECK(qr_status IN ('Active', 'Disabled')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE SET NULL
    )`);

    // 4. Position History Table
    db.run(`CREATE TABLE IF NOT EXISTS position_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        position_title TEXT NOT NULL,
        school_year TEXT NOT NULL,
        assigned_date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. Events Table
    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        description TEXT,
        event_type TEXT DEFAULT 'Club Meeting',
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        location TEXT,
        organizer TEXT,
        participant_scope TEXT DEFAULT 'ALL' CHECK(participant_scope IN ('ALL', 'OFFICERS_ONLY', 'SPECIFIC_POSITIONS')),
        allowed_positions TEXT, -- JSON array string of position IDs if scope is SPECIFIC_POSITIONS
        status TEXT DEFAULT 'Upcoming' CHECK(status IN ('Upcoming', 'Active', 'Completed', 'Cancelled')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 6. Attendance Table
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        student_id TEXT NOT NULL,
        time_in DATETIME,
        time_out DATETIME,
        status TEXT NOT NULL CHECK(status IN ('Present', 'Late', 'Absent', 'Excused')),
        scanned_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_id, student_id),
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    )`);

    // 7. Excuses Table
    db.run(`CREATE TABLE IF NOT EXISTS attendance_excuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendance_id INTEGER UNIQUE NOT NULL,
        reason TEXT NOT NULL,
        notes TEXT,
        approved_by TEXT NOT NULL,
        approved_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (attendance_id) REFERENCES attendance(id) ON DELETE CASCADE
    )`);

    // 8. System Settings Table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`);

    // 9. Audit Logs Table
    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Seed Initial System Data
    seedDefaultData();
});

function seedDefaultData() {
    // Default Settings
    const defaults = [
        ['school_name', 'ABC National High School'],
        ['school_logo', ''],
        ['club_name', 'Computer Club'],
        ['organization_name', 'Student Technology Association'],
        ['club_adviser', 'Mr. John Doe'],
        ['school_year', '2026-2027'],
        ['late_threshold_minutes', '15'],
        ['low_participation_threshold', '60'],
        ['voice_enabled', 'true'],
        ['voice_volume', '1.0'],
        ['voice_rate', '1.0'],
        ['sound_enabled', 'true']
    ];

    defaults.forEach(([k, v]) => {
        db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
    });

    // Default Positions
    const positions = [
        ['President', 'Lead officer of the organization', 1],
        ['Vice President', 'Assists the president and oversees operations', 1],
        ['Secretary', 'Manages records and minutes', 1],
        ['Treasurer', 'Handles finances and budgets', 1],
        ['Auditor', 'Inspects financial records', 1],
        ['Public Information Officer', 'Manages communications and PR', 1],
        ['Peace Officer', 'Maintains order during meetings', 1],
        ['Sergeant-at-Arms', 'Assists in order and protocol', 1],
        ['Representative', 'Represents student members', 1],
        ['Member', 'Regular active club member', 0]
    ];

    positions.forEach(([title, desc, officer]) => {
        db.run(`INSERT OR IGNORE INTO positions (title, description, is_officer) VALUES (?, ?, ?)`, [title, desc, officer]);
    });

    // Seed Admin Account (Password: admin123)
    db.get(`SELECT id FROM users WHERE username = ?`, ['admin'], (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync('admin123', 10);
            db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, ['admin', hash, 'admin']);
        }
    });

    // Seed Scanner Account (Password: scanner123)
    db.get(`SELECT id FROM users WHERE username = ?`, ['scanner'], (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync('scanner123', 10);
            db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, ['scanner', hash, 'scanner']);
        }
    });
}

// Security & Authentication Helper Functions
function logAudit(req, action, details) {
    const username = req.session && req.session.user ? req.session.user.username : 'SYSTEM';
    const role = req.session && req.session.user ? req.session.user.role : 'ANONYMOUS';
    const ip = req.ip || req.connection.remoteAddress;
    db.run(`INSERT INTO audit_logs (username, role, action, details, ip_address) VALUES (?, ?, ?, ?, ?)`,
        [username, role, action, details, ip]);
}

function requireAuth(roles = []) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            if (req.xhr || req.headers.accept.indexOf('json') > -1) {
                return res.status(401).json({ success: false, message: 'Unauthorized session.' });
            }
            return res.redirect('/');
        }
        if (roles.length > 0 && !roles.includes(req.session.user.role)) {
            if (req.xhr || req.headers.accept.indexOf('json') > -1) {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }
            return res.status(403).send('Forbidden: Insufficient privileges.');
        }
        next();
    };
}

// Single-Page Dynamic Application Frontend Generator Router
app.get('/', (req, res) => {
    if (req.session && req.session.user) {
        if (req.session.user.role === 'admin') return res.redirect('/admin');
        if (req.session.user.role === 'scanner') return res.redirect('/scanner');
        if (req.session.user.role === 'student') return res.redirect('/member');
    }
    res.send(renderLoginPage());
});

app.get('/admin', requireAuth(['admin']), (req, res) => {
    res.send(renderAdminApp(req.session.user));
});

app.get('/scanner', requireAuth(['admin', 'scanner']), (req, res) => {
    res.send(renderScannerApp(req.session.user));
});

app.get('/member', requireAuth(['student']), (req, res) => {
    res.send(renderStudentPortal(req.session.user));
});

// Authentication API Endpoints
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: 'All fields are required.' });

    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (err || !user) return res.json({ success: false, message: 'Invalid credentials.' });

        if (!bcrypt.compareSync(password, user.password)) {
            return res.json({ success: false, message: 'Invalid credentials.' });
        }

        req.session.user = {
            id: user.id,
            username: user.username,
            role: user.role,
            student_id: user.student_id
        };

        logAudit(req, 'LOGIN', `User ${username} logged in successfully as ${user.role}.`);
        return res.json({ success: true, role: user.role });
    });
});

app.post('/api/auth/logout', (req, res) => {
    logAudit(req, 'LOGOUT', `User ${req.session.user ? req.session.user.username : 'Unknown'} logged out.`);
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

app.post('/api/auth/change-password', requireAuth(['admin', 'scanner', 'student']), (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;

    if (!new_password || new_password.length < 8) {
        return res.json({ success: false, message: 'Password must be at least 8 characters long.' });
    }
    if (new_password !== confirm_password) {
        return res.json({ success: false, message: 'New passwords do not match.' });
    }

    db.get(`SELECT password FROM users WHERE id = ?`, [req.session.user.id], (err, user) => {
        if (!bcrypt.compareSync(current_password, user.password)) {
            return res.json({ success: false, message: 'Current password is incorrect.' });
        }

        const newHash = bcrypt.hashSync(new_password, 10);
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [newHash, req.session.user.id], (err) => {
            if (err) return res.json({ success: false, message: 'Failed to update password.' });
            logAudit(req, 'PASSWORD_CHANGE', `User updated their password successfully.`);
            res.json({ success: true, message: 'Password updated successfully.' });
        });
    });
});

// ==========================================
// FRONTEND INTERFACE HTML ENGINE RENDERING
// ==========================================

function getCommonHead(title) {
    return `
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title} - School Student Club QR Attendance</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css">
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <script src="https://unpkg.com/html5-qrcode"></script>
        <style>
            :root {
                --sidebar-width: 260px;
                --primary-color: #1e3a8a;
                --secondary-color: #0d9488;
                --dark-bg: #0f172a;
            }
            body { background-color: #f8fafc; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
            .sidebar { width: var(--sidebar-width); height: 100vh; position: fixed; top: 0; left: 0; background: var(--dark-bg); color: #fff; z-index: 1000; overflow-y: auto; transition: all 0.3s; }
            .sidebar .nav-link { color: #94a3b8; padding: 12px 20px; font-weight: 500; display: flex; align-items: center; gap: 12px; border-radius: 8px; margin: 4px 12px; }
            .sidebar .nav-link:hover, .sidebar .nav-link.active { color: #fff; background-color: rgba(255,255,255,0.1); }
            .sidebar .nav-link i { font-size: 1.2rem; }
            .main-content { margin-left: var(--sidebar-width); padding: 30px; transition: all 0.3s; }
            @media (max-width: 991px) {
                .sidebar { margin-left: -260px; }
                .sidebar.open { margin-left: 0; }
                .main-content { margin-left: 0; }
            }
            .card-dashboard { border: none; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); transition: transform 0.2s; }
            .card-dashboard:hover { transform: translateY(-3px); }
            .stat-icon { width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; }
            
            /* Standard Student Club ID Layout Rules (8 per A4 Sheet) */
            .id-card-grid { display: grid; grid-template-columns: repeat(2, 3.375in); gap: 0.2in 0.3in; justify-content: center; padding: 0.25in; }
            .id-card { width: 3.375in; height: 2.125in; border: 1px solid #cbd5e1; border-radius: 10px; background: #fff; position: relative; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); font-size: 8pt; display: flex; flex-direction: column; justify-content: space-between; page-break-inside: avoid; }
            .id-card-header { background: linear-gradient(135deg, #1e3a8a, #3b82f6); color: white; padding: 6px 8px; text-align: center; }
            .id-card-body { display: flex; padding: 8px; gap: 10px; flex-grow: 1; align-items: center; }
            .id-photo { width: 0.85in; height: 0.95in; border-radius: 6px; object-fit: cover; border: 1px solid #cbd5e1; }
            .id-details { flex-grow: 1; line-height: 1.2; }
            .id-qr { width: 0.85in; height: 0.85in; }
            .id-card-footer { background: #f1f5f9; text-align: center; padding: 4px; font-weight: bold; font-size: 7pt; color: #475569; border-top: 1px solid #e2e8f0; }
            
            @media print {
                body * { visibility: hidden; }
                #print-section, #print-section * { visibility: visible; }
                #print-section { position: absolute; left: 0; top: 0; width: 100%; }
                .no-print { display: none !important; }
                @page { size: A4 portrait; margin: 0.4in; }
            }
        </style>
    </head>
    `;
}

function renderLoginPage() {
    return `
    <!DOCTYPE html>
    <html lang="en">
    ${getCommonHead('Login')}
    <body class="bg-dark d-flex align-items-center justify-content-center vh-100">
        <div class="card card-dashboard p-4 shadow-lg style="width: 100%; max-width: 420px; background: #ffffff;">
            <div class="text-center mb-4">
                <div class="bg-primary text-white rounded-circle d-inline-flex align-items-center justify-content-center mb-2" style="width: 60px; height: 60px;">
                    <i class="bi bi-qr-code-scan fs-2"></i>
                </div>
                <h4 class="fw-bold text-primary mb-1" id="disp_school_name">ABC National High School</h4>
                <p class="text-muted small mb-0" id="disp_club_name">Computer Club Attendance Portal</p>
            </div>
            <form id="loginForm">
                <div class="mb-3">
                    <label class="form-label font-weight-bold">Username or Student ID</label>
                    <div class="input-group">
                        <span class="input-group-text"><i class="bi bi-person"></i></span>
                        <input type="text" class="form-control" id="username" required placeholder="Enter username">
                    </div>
                </div>
                <div class="mb-3">
                    <label class="form-label font-weight-bold">Password</label>
                    <div class="input-group">
                        <span class="input-group-text"><i class="bi bi-lock"></i></span>
                        <input type="password" class="form-control" id="password" required placeholder="Enter password">
                    </div>
                </div>
                <div id="loginError" class="alert alert-danger d-none py-2 small"></div>
                <button type="submit" class="btn btn-primary w-100 py-2 fw-bold">Sign In</button>
            </form>
            <div class="mt-4 pt-3 border-top text-center text-muted small">
                Default Credentials:<br>
                Admin: <code>admin</code> / <code>admin123</code><br>
                Scanner: <code>scanner</code> / <code>scanner123</code>
            </div>
        </div>

        <script>
            document.getElementById('loginForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const errDiv = document.getElementById('loginError');
                errDiv.classList.add('d-none');
                
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: document.getElementById('username').value,
                        password: document.getElementById('password').value
                    })
                });
                const data = await res.json();
                if(data.success) {
                    if(data.role === 'admin') window.location.href = '/admin';
                    else if(data.role === 'scanner') window.location.href = '/scanner';
                    else window.location.href = '/member';
                } else {
                    errDiv.textContent = data.message;
                    errDiv.classList.remove('d-none');
                }
            });
        </script>
    </body>
    </html>
    `;
}
/* ==========================================================================
   SCHOOL STUDENT CLUB QR ATTENDANCE SYSTEM - MONOLITHIC APPLICATION (app.js)
   PART 2: ADMIN APP, SCANNER APP, MEMBER PORTAL & FULL API ROUTING
   ========================================================================== */

function renderAdminApp(user) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    ${getCommonHead('Admin Dashboard')}
    <body>
        <!-- Navigation Sidebar -->
        <div class="sidebar" id="sidebar">
            <div class="p-3 text-center border-bottom border-secondary">
                <i class="bi bi-shield-lock-fill fs-2 text-primary"></i>
                <h6 class="mt-2 mb-0 text-white fw-bold" id="sys_club_name">Computer Club</h6>
                <small class="text-muted" id="sys_school_name">ABC National High School</small>
            </div>
            <div class="py-3">
                <a href="#" class="nav-link active" onclick="switchTab('dashboard')"><i class="bi bi-speedometer2"></i> Dashboard</a>
                <a href="#" class="nav-link" onclick="switchTab('students')"><i class="bi bi-people-fill"></i> Student Members</a>
                <a href="#" class="nav-link" onclick="switchTab('positions')"><i class="bi bi-person-badge"></i> Positions</a>
                <a href="#" class="nav-link" onclick="switchTab('events')"><i class="bi bi-calendar-event"></i> Events</a>
                <a href="#" class="nav-link" onclick="switchTab('attendance')"><i class="bi bi-clock-history"></i> Attendance Records</a>
                <a href="#" class="nav-link" onclick="switchTab('id-cards')"><i class="bi bi-card-heading"></i> Print ID Cards (A4)</a>
                <a href="#" class="nav-link" onclick="switchTab('reports')"><i class="bi bi-file-earmark-bar-graph"></i> Reports & Analytics</a>
                <a href="#" class="nav-link" onclick="switchTab('audit')"><i class="bi bi-journal-text"></i> Audit Logs</a>
                <a href="#" class="nav-link" onclick="switchTab('settings')"><i class="bi bi-gear-fill"></i> System Settings</a>
            </div>
        </div>

        <!-- Main Workspace -->
        <div class="main-content">
            <!-- Top Navigation Bar -->
            <div class="d-flex justify-content-between align-items-center mb-4 pb-3 border-bottom">
                <div class="d-flex align-items-center gap-2">
                    <button class="btn btn-light d-lg-none" onclick="document.getElementById('sidebar').classList.toggle('open')"><i class="bi bi-list"></i></button>
                    <h4 class="fw-bold mb-0" id="page-title">Dashboard Overview</h4>
                </div>
                <div class="dropdown">
                    <button class="btn btn-white shadow-sm dropdown-toggle fw-semibold" type="button" data-bs-toggle="dropdown">
                        <i class="bi bi-person-circle me-1"></i> ${user.username} (Adviser/Admin)
                    </button>
                    <ul class="dropdown-menu dropdown-menu-end shadow">
                        <li><a class="dropdown-link dropdown-item" href="#" onclick="openPasswordModal()"><i class="bi bi-key me-2"></i>Change Password</a></li>
                        <li><hr class="dropdown-divider"></li>
                        <li><a class="dropdown-link dropdown-item text-danger" href="#" onclick="logout()"><i class="bi bi-box-arrow-right me-2"></i>Logout</a></li>
                    </ul>
                </div>
            </div>

            <div id="alert-container"></div>

            <!-- Dynamic Tab Content Sections -->
            <div id="content-area">
                <!-- Content will be injected by JavaScript router -->
            </div>
        </div>

        <!-- Global Password Change Modal -->
        <div class="modal fade" id="passwordModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title fw-bold">Change Account Password</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <form id="changePasswordForm">
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label">Current Password</label>
                                <input type="password" class="form-control" id="curr_pass" required>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">New Password (Min 8 characters)</label>
                                <input type="password" class="form-control" id="new_pass" required minlength="8">
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Confirm New Password</label>
                                <input type="password" class="form-control" id="conf_pass" required minlength="8">
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="submit" class="btn btn-primary">Update Password</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>

        <!-- Printable Container hidden from screen layout -->
        <div id="print-section" class="d-none"></div>

        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
        <script>
            let passModal;
            document.addEventListener('DOMContentLoaded', () => {
                passModal = new bootstrap.Modal(document.getElementById('passwordModal'));
                loadSystemSettings();
                switchTab('dashboard');
            });

            async function loadSystemSettings() {
                const res = await fetch('/api/admin/settings');
                const settings = await res.json();
                if(settings.school_name) {
                    const sn = document.getElementById('sys_school_name');
                    if (sn) sn.textContent = settings.school_name;
                }
                if(settings.club_name) {
                    const cn = document.getElementById('sys_club_name');
                    if (cn) cn.textContent = settings.club_name;
                }
            }

            function openPasswordModal() { passModal.show(); }

            document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const curr = document.getElementById('curr_pass').value;
                const newP = document.getElementById('new_pass').value;
                const conf = document.getElementById('conf_pass').value;

                if (newP !== conf) {
                    alert('New passwords do not match.');
                    return;
                }

                const res = await fetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ current_password: curr, new_password: newP, confirm_password: conf })
                });
                const data = await res.json();
                alert(data.message);
                if(data.success) {
                    passModal.hide();
                    document.getElementById('changePasswordForm').reset();
                }
            });

            async function logout() {
                await fetch('/api/auth/logout', { method: 'POST' });
                window.location.href = '/';
            }

            function switchTab(tab) {
                document.querySelectorAll('.sidebar .nav-link').forEach(el => el.classList.remove('active'));
                const activeNav = document.querySelector(\`.sidebar .nav-link[onclick="switchTab('\${tab}')"]\`);
                if(activeNav) activeNav.classList.add('active');

                const container = document.getElementById('content-area');
                document.getElementById('page-title').textContent = tab.replace('-', ' ').toUpperCase();

                if(tab === 'dashboard') loadDashboardView(container);
                else if(tab === 'students') loadStudentsView(container);
                else if(tab === 'positions') loadPositionsView(container);
                else if(tab === 'events') loadEventsView(container);
                else if(tab === 'attendance') loadAttendanceView(container);
                else if(tab === 'id-cards') loadIDCardsView(container);
                else if(tab === 'reports') loadReportsView(container);
                else if(tab === 'audit') loadAuditLogsView(container);
                else if(tab === 'settings') loadSettingsView(container);
            }

            /* --- DASHBOARD VIEW --- */
            async function loadDashboardView(container) {
                container.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>';
                const res = await fetch('/api/admin/dashboard-stats');
                const stats = await res.json();

                container.innerHTML = \`
                <div class="row g-3 mb-4">
                    <div class="col-md-3">
                        <div class="card card-dashboard p-3 bg-white border-start border-primary border-4">
                            <div class="d-flex align-items-center justify-content-between">
                                <div>
                                    <div class="text-muted small fw-bold text-uppercase">Total Students</div>
                                    <div class="fs-3 fw-bold text-dark">\${stats.total_students}</div>
                                </div>
                                <div class="stat-icon bg-primary-subtle text-primary"><i class="bi bi-people"></i></div>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card card-dashboard p-3 bg-white border-start border-success border-4">
                            <div class="d-flex align-items-center justify-content-between">
                                <div>
                                    <div class="text-muted small fw-bold text-uppercase">Active Officers</div>
                                    <div class="fs-3 fw-bold text-dark">\${stats.total_officers}</div>
                                </div>
                                <div class="stat-icon bg-success-subtle text-success"><i class="bi bi-person-badge"></i></div>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card card-dashboard p-3 bg-white border-start border-warning border-4">
                            <div class="d-flex align-items-center justify-content-between">
                                <div>
                                    <div class="text-muted small fw-bold text-uppercase">Active Event</div>
                                    <div class="fs-6 fw-bold text-dark">\${stats.active_event ? stats.active_event.event_name : 'None'}</div>
                                </div>
                                <div class="stat-icon bg-warning-subtle text-warning"><i class="bi bi-calendar-check"></i></div>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card card-dashboard p-3 bg-white border-start border-info border-4">
                            <div class="d-flex align-items-center justify-content-between">
                                <div>
                                    <div class="text-muted small fw-bold text-uppercase">Attendance Rate</div>
                                    <div class="fs-3 fw-bold text-dark">\${stats.overall_rate}%</div>
                                </div>
                                <div class="stat-icon bg-info-subtle text-info"><i class="bi bi-graph-up"></i></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="row g-4 mb-4">
                    <div class="col-md-8">
                        <div class="card card-dashboard p-4 bg-white">
                            <h6 class="fw-bold mb-3">Recent Attendance Activity</h6>
                            <div class="table-responsive">
                                <table class="table table-hover align-middle">
                                    <thead class="table-light">
                                        <tr>
                                            <th>Student</th>
                                            <th>Position</th>
                                            <th>Event</th>
                                            <th>Time In</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        \${stats.recent_scans.length === 0 ? '<tr><td colspan="5" class="text-center py-3 text-muted">No recent scans today</td></tr>' : 
                                            stats.recent_scans.map(s => \`
                                                <tr>
                                                    <td class="fw-bold">\${s.full_name} <br><small class="text-muted">\${s.student_id}</small></td>
                                                    <td><span class="badge bg-light text-dark border">\${s.position_title || 'Member'}</span></td>
                                                    <td>\${s.event_name}</td>
                                                    <td>\${new Date(s.time_in).toLocaleTimeString()}</td>
                                                    <td><span class="badge bg-\${s.status==='Present'?'success':s.status==='Late'?'warning':'danger'}">\${s.status}</span></td>
                                                </tr>
                                            \`).join('')
                                        }
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card card-dashboard p-4 bg-white mb-4">
                            <h6 class="fw-bold mb-3">Attendance Breakdown</h6>
                            <canvas id="attendancePieChart" height="200"></canvas>
                        </div>
                    </div>
                </div>
                \`;

                // Render Chart
                const ctx = document.getElementById('attendancePieChart').getContext('2d');
                new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Present', 'Late', 'Absent', 'Excused'],
                        datasets: [{
                            data: [stats.present_count, stats.late_count, stats.absent_count, stats.excused_count],
                            backgroundColor: ['#10b981', '#f59e0b', '#ef4444', '#3b82f6']
                        }]
                    },
                    options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
                });
            }

            /* --- STUDENT MEMBERS MANAGEMENT VIEW --- */
            async function loadStudentsView(container) {
                container.innerHTML = \`
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <div class="d-flex gap-2 w-50">
                        <input type="text" id="searchStudent" class="form-control" placeholder="Search by ID or Name..." onkeyup="filterStudentsTable()">
                        <select id="filterPosition" class="form-select" onchange="filterStudentsTable()">
                            <option value="">All Positions</option>
                        </select>
                    </div>
                    <button class="btn btn-primary fw-bold" onclick="openStudentModal()"><i class="bi bi-person-plus-fill me-1"></i> Add Student Member</button>
                </div>
                <div class="card card-dashboard p-3 bg-white">
                    <div class="table-responsive">
                        <table class="table table-hover align-middle" id="studentsTable">
                            <thead class="table-light">
                                <tr>
                                    <th>Student ID</th>
                                    <th>Full Name</th>
                                    <th>Position</th>
                                    <th>Club / Year</th>
                                    <th>Status</th>
                                    <th>QR Token</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="studentTableBody">
                                <tr><td colspan="7" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Student Modal -->
                <div class="modal fade" id="studentModal" tabindex="-1">
                    <div class="modal-dialog modal-lg">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title fw-bold" id="studentModalTitle">Add Student Member</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <form id="studentForm">
                                <input type="hidden" id="stud_db_id">
                                <div class="modal-body row g-3">
                                    <div class="col-md-4">
                                        <label class="form-label">Student ID *</label>
                                        <input type="text" class="form-control" id="stud_id" required>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">First Name *</label>
                                        <input type="text" class="form-control" id="stud_fn" required>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">Middle Name</label>
                                        <input type="text" class="form-control" id="stud_mn">
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Last Name *</label>
                                        <input type="text" class="form-control" id="stud_ln" required>
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Assigned Position *</label>
                                        <select class="form-select" id="stud_pos" required></select>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">Gender</label>
                                        <select class="form-select" id="stud_gender">
                                            <option value="Male">Male</option>
                                            <option value="Female">Female</option>
                                            <option value="Other">Other</option>
                                        </select>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">Contact Number</label>
                                        <input type="text" class="form-control" id="stud_contact">
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">School Email</label>
                                        <input type="email" class="form-control" id="stud_email">
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Parent / Guardian Name</label>
                                        <input type="text" class="form-control" id="stud_guardian">
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Guardian Contact</label>
                                        <input type="text" class="form-control" id="stud_guardian_contact">
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Membership Status</label>
                                        <select class="form-select" id="stud_status">
                                            <option value="Active">Active</option>
                                            <option value="Inactive">Inactive</option>
                                            <option value="Suspended">Suspended</option>
                                            <option value="Alumni">Alumni</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="modal-footer">
                                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                                    <button type="submit" class="btn btn-primary">Save Student</button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
                \`;

                loadStudentsData();
            }

            let allStudentsCache = [];
            async function loadStudentsData() {
                const [studRes, posRes] = await Promise.all([
                    fetch('/api/admin/students'),
                    fetch('/api/admin/positions')
                ]);
                allStudentsCache = await studRes.json();
                const positions = await posRes.json();

                // Populate position dropdowns
                const posSelect = document.getElementById('stud_pos');
                const filterPos = document.getElementById('filterPosition');
                posSelect.innerHTML = positions.map(p => \`<option value="\${p.id}">\${p.title}\${p.is_officer?' (Officer)':''}</option>\`).join('');
                filterPos.innerHTML = '<option value="">All Positions</option>' + positions.map(p => \`<option value="\${p.title}">\${p.title}</option>\`).join('');

                renderStudentTableRows(allStudentsCache);
            }

            function renderStudentTableRows(students) {
                const tbody = document.getElementById('studentTableBody');
                if(!students || students.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-muted">No student records found.</td></tr>';
                    return;
                }
                tbody.innerHTML = students.map(s => \`
                    <tr>
                        <td class="fw-bold">\${s.student_id}</td>
                        <td>\${s.full_name}</td>
                        <td><span class="badge bg-primary-subtle text-primary border border-primary-subtle">\${s.position_title || 'Member'}</span></td>
                        <td>\${s.student_club} (\${s.school_year})</td>
                        <td><span class="badge bg-\${s.membership_status==='Active'?'success':'secondary'}">\${s.membership_status}</span></td>
                        <td>
                            <span class="badge bg-\${s.qr_status==='Active'?'success':'danger'}">\${s.qr_status}</span>
                            <button class="btn btn-sm btn-link p-0 ms-1" onclick="regenerateQR('\${s.student_id}')" title="Regenerate QR"><i class="bi bi-arrow-clockwise"></i></button>
                        </td>
                        <td>
                            <button class="btn btn-sm btn-outline-primary me-1" onclick="editStudent(\${s.id})"><i class="bi bi-pencil"></i></button>
                            <button class="btn btn-sm btn-outline-danger" onclick="deleteStudent('\${s.student_id}')"><i class="bi bi-trash"></i></button>
                        </td>
                    </tr>
                \`).join('');
            }

            function filterStudentsTable() {
                const q = document.getElementById('searchStudent').value.toLowerCase();
                const p = document.getElementById('filterPosition').value;
                const filtered = allStudentsCache.filter(s => {
                    const matchQ = s.full_name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q);
                    const matchP = !p || s.position_title === p;
                    return matchQ && matchP;
                });
                renderStudentTableRows(filtered);
            }

            function openStudentModal() {
                document.getElementById('studentForm').reset();
                document.getElementById('stud_db_id').value = '';
                document.getElementById('studentModalTitle').textContent = 'Add Student Member';
                new bootstrap.Modal(document.getElementById('studentModal')).show();
            }

            async function editStudent(id) {
                const s = allStudentsCache.find(x => x.id === id);
                if(!s) return;
                document.getElementById('stud_db_id').value = s.id;
                document.getElementById('stud_id').value = s.student_id;
                document.getElementById('stud_fn').value = s.first_name;
                document.getElementById('stud_mn').value = s.middle_name || '';
                document.getElementById('stud_ln').value = s.last_name;
                document.getElementById('stud_pos').value = s.position_id;
                document.getElementById('stud_gender').value = s.gender || 'Male';
                document.getElementById('stud_contact').value = s.contact_number || '';
                document.getElementById('stud_email').value = s.school_email || '';
                document.getElementById('stud_guardian').value = s.guardian_name || '';
                document.getElementById('stud_guardian_contact').value = s.guardian_contact || '';
                document.getElementById('stud_status').value = s.membership_status;

                document.getElementById('studentModalTitle').textContent = 'Edit Student Member';
                new bootstrap.Modal(document.getElementById('studentModal')).show();
            }

            document.addEventListener('submit', async (e) => {
                if(e.target && e.target.id === 'studentForm') {
                    e.preventDefault();
                    const dbId = document.getElementById('stud_db_id').value;
                    const payload = {
                        student_id: document.getElementById('stud_id').value,
                        first_name: document.getElementById('stud_fn').value,
                        middle_name: document.getElementById('stud_mn').value,
                        last_name: document.getElementById('stud_ln').value,
                        position_id: document.getElementById('stud_pos').value,
                        gender: document.getElementById('stud_gender').value,
                        contact_number: document.getElementById('stud_contact').value,
                        school_email: document.getElementById('stud_email').value,
                        guardian_name: document.getElementById('stud_guardian').value,
                        guardian_contact: document.getElementById('stud_guardian_contact').value,
                        membership_status: document.getElementById('stud_status').value
                    };

                    const url = dbId ? \`/api/admin/students/\${dbId}\` : '/api/admin/students';
                    const method = dbId ? 'PUT' : 'POST';

                    const res = await fetch(url, {
                        method: method,
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    alert(data.message);
                    if(data.success) {
                        bootstrap.Modal.getInstance(document.getElementById('studentModal')).hide();
                        loadStudentsData();
                    }
                }
            });

            async function regenerateQR(studentId) {
                if(!confirm('Regenerating QR will invalidate the old QR code. Continue?')) return;
                const res = await fetch(\`/api/admin/students/\${studentId}/regenerate-qr\`, { method: 'POST' });
                const data = await res.json();
                alert(data.message);
                if(data.success) loadStudentsData();
            }

            async function deleteStudent(studentId) {
                if(!confirm(\`Are you sure you want to delete student ID \${studentId}?\`)) return;
                const res = await fetch(\`/api/admin/students/\${studentId}\`, { method: 'DELETE' });
                const data = await res.json();
                alert(data.message);
                if(data.success) loadStudentsData();
            }

            /* --- CUSTOM POSITIONS VIEW --- */
            async function loadPositionsView(container) {
                container.innerHTML = \`
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h6 class="fw-bold text-muted mb-0">Custom Club Officers & Roles</h6>
                    <button class="btn btn-primary fw-bold" onclick="openPositionModal()"><i class="bi bi-plus-circle me-1"></i> Add Custom Position</button>
                </div>
                <div class="card card-dashboard p-3 bg-white">
                    <div class="table-responsive">
                        <table class="table table-hover align-middle">
                            <thead class="table-light">
                                <tr>
                                    <th>Position Title</th>
                                    <th>Description</th>
                                    <th>Officer Rank</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="positionTableBody">
                                <tr><td colspan="4" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Position Modal -->
                <div class="modal fade" id="positionModal" tabindex="-1">
                    <div class="modal-dialog">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title fw-bold" id="posModalTitle">Create Custom Position</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <form id="positionForm">
                                <input type="hidden" id="pos_db_id">
                                <div class="modal-body">
                                    <div class="mb-3">
                                        <label class="form-label">Position Title *</label>
                                        <input type="text" class="form-control" id="pos_title" required placeholder="e.g., Event Coordinator">
                                    </div>
                                    <div class="mb-3">
                                        <label class="form-label">Description</label>
                                        <textarea class="form-control" id="pos_desc" rows="2"></textarea>
                                    </div>
                                    <div class="form-check mb-3">
                                        <input class="form-check-input" type="checkbox" id="pos_is_officer">
                                        <label class="form-check-label font-weight-bold" for="pos_is_officer">
                                            Classify as Student Officer Role
                                        </label>
                                    </div>
                                </div>
                                <div class="modal-footer">
                                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                                    <button type="submit" class="btn btn-primary">Save Position</button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
                \`;

                loadPositionsData();
            }

            async function loadPositionsData() {
                const res = await fetch('/api/admin/positions');
                const positions = await res.json();
                const tbody = document.getElementById('positionTableBody');
                tbody.innerHTML = positions.map(p => \`
                    <tr>
                        <td class="fw-bold">\${p.title}</td>
                        <td>\${p.description || '-'}</td>
                        <td><span class="badge bg-\${p.is_officer?'primary':'secondary'}">\${p.is_officer?'Officer':'Member'}</span></td>
                        <td>
                            <button class="btn btn-sm btn-outline-primary me-1" onclick="editPosition(\${p.id}, '\${p.title}', '\${p.description||''}', \${p.is_officer})"><i class="bi bi-pencil"></i></button>
                            <button class="btn btn-sm btn-outline-danger" onclick="deletePosition(\${p.id})"><i class="bi bi-trash"></i></button>
                        </td>
                    </tr>
                \`).join('');
            }

            function openPositionModal() {
                document.getElementById('positionForm').reset();
                document.getElementById('pos_db_id').value = '';
                document.getElementById('posModalTitle').textContent = 'Create Custom Position';
                new bootstrap.Modal(document.getElementById('positionModal')).show();
            }

            function editPosition(id, title, desc, isOfficer) {
                document.getElementById('pos_db_id').value = id;
                document.getElementById('pos_title').value = title;
                document.getElementById('pos_desc').value = desc;
                document.getElementById('pos_is_officer').checked = !!isOfficer;
                document.getElementById('posModalTitle').textContent = 'Edit Custom Position';
                new bootstrap.Modal(document.getElementById('positionModal')).show();
            }

            document.addEventListener('submit', async (e) => {
                if(e.target && e.target.id === 'positionForm') {
                    e.preventDefault();
                    const id = document.getElementById('pos_db_id').value;
                    const payload = {
                        title: document.getElementById('pos_title').value,
                        description: document.getElementById('pos_desc').value,
                        is_officer: document.getElementById('pos_is_officer').checked ? 1 : 0
                    };
                    const url = id ? \`/api/admin/positions/\${id}\` : '/api/admin/positions';
                    const method = id ? 'PUT' : 'POST';

                    const res = await fetch(url, {
                        method: method,
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    alert(data.message);
                    if(data.success) {
                        bootstrap.Modal.getInstance(document.getElementById('positionModal')).hide();
                        loadPositionsData();
                    }
                }
            });

            async function deletePosition(id) {
                if(!confirm('Are you sure you want to delete this position?')) return;
                const res = await fetch(\`/api/admin/positions/\${id}\`, { method: 'DELETE' });
                const data = await res.json();
                alert(data.message);
                if(data.success) loadPositionsData();
            }

            /* --- EVENTS MANAGEMENT VIEW --- */
            async function loadEventsView(container) {
                container.innerHTML = \`
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h6 class="fw-bold text-muted mb-0">Club Activities & Meetings</h6>
                    <button class="btn btn-primary fw-bold" onclick="openEventModal()"><i class="bi bi-calendar-plus me-1"></i> Create Event</button>
                </div>
                <div class="card card-dashboard p-3 bg-white">
                    <div class="table-responsive">
                        <table class="table table-hover align-middle">
                            <thead class="table-light">
                                <tr>
                                    <th>Event Name</th>
                                    <th>Type</th>
                                    <th>Date & Time</th>
                                    <th>Location</th>
                                    <th>Scope</th>
                                    <th>Status</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="eventsTableBody">
                                <tr><td colspan="7" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Event Modal -->
                <div class="modal fade" id="eventModal" tabindex="-1">
                    <div class="modal-dialog modal-lg">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title fw-bold" id="eventModalTitle">Create Event</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <form id="eventForm">
                                <input type="hidden" id="event_db_id">
                                <div class="modal-body row g-3">
                                    <div class="col-md-8">
                                        <label class="form-label">Event Name *</label>
                                        <input type="text" class="form-control" id="ev_name" required>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">Event Type</label>
                                        <select class="form-select" id="ev_type">
                                            <option value="Club Meeting">Club Meeting</option>
                                            <option value="General Assembly">General Assembly</option>
                                            <option value="Officer Meeting">Officer Meeting</option>
                                            <option value="Workshop">Workshop</option>
                                            <option value="Special Event">Special Event</option>
                                        </select>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">Event Date *</label>
                                        <input type="date" class="form-control" id="ev_date" required>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">Start Time *</label>
                                        <input type="time" class="form-control" id="ev_start" required>
                                    </div>
                                    <div class="col-md-4">
                                        <label class="form-label">End Time *</label>
                                        <input type="time" class="form-control" id="ev_end" required>
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Location</label>
                                        <input type="text" class="form-control" id="ev_location" placeholder="e.g., Computer Lab 1">
                                    </div>
                                    <div class="col-md-6">
                                        <label class="form-label">Participant Scope</label>
                                        <select class="form-select" id="ev_scope">
                                            <option value="ALL">All Student Members</option>
                                            <option value="OFFICERS_ONLY">Officers Only</option>
                                        </select>
                                    </div>
                                    <div class="col-md-12">
                                        <label class="form-label">Status</label>
                                        <select class="form-select" id="ev_status">
                                            <option value="Upcoming">Upcoming</option>
                                            <option value="Active">Active (Ready for Scanning)</option>
                                            <option value="Completed">Completed</option>
                                            <option value="Cancelled">Cancelled</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="modal-footer">
                                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                                    <button type="submit" class="btn btn-primary">Save Event</button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
                \`;

                loadEventsData();
            }

            async function loadEventsData() {
                const res = await fetch('/api/admin/events');
                const events = await res.json();
                const tbody = document.getElementById('eventsTableBody');
                tbody.innerHTML = events.map(e => \`
                    <tr>
                        <td class="fw-bold">\${e.event_name}</td>
                        <td>\${e.event_type}</td>
                        <td>\${e.event_date}<br><small class="text-muted">\${e.start_time} - \${e.end_time}</small></td>
                        <td>\${e.location || 'TBA'}</td>
                        <td><span class="badge bg-info-subtle text-info">\${e.participant_scope}</span></td>
                        <td><span class="badge bg-\${e.status==='Active'?'success':e.status==='Completed'?'secondary':'warning'}">\${e.status}</span></td>
                        <td>
                            <button class="btn btn-sm btn-outline-primary me-1" onclick="editEvent(\${e.id})"><i class="bi bi-pencil"></i></button>
                            \${e.status==='Active'?'':\`<button class="btn btn-sm btn-success me-1" onclick="setActiveEvent(\${e.id})" title="Set as Active Event"><i class="bi bi-play-circle"></i> Activate</button>\`}
                            <button class="btn btn-sm btn-outline-danger" onclick="deleteEvent(\${e.id})"><i class="bi bi-trash"></i></button>
                        </td>
                    </tr>
                \`).join('');
            }

            function openEventModal() {
                document.getElementById('eventForm').reset();
                document.getElementById('event_db_id').value = '';
                document.getElementById('eventModalTitle').textContent = 'Create Event';
                new bootstrap.Modal(document.getElementById('eventModal')).show();
            }

            async function setActiveEvent(id) {
                const res = await fetch(\`/api/admin/events/\${id}/activate\`, { method: 'POST' });
                const data = await res.json();
                alert(data.message);
                if(data.success) loadEventsData();
            }

            document.addEventListener('submit', async (e) => {
                if(e.target && e.target.id === 'eventForm') {
                    e.preventDefault();
                    const id = document.getElementById('event_db_id').value;
                    const payload = {
                        event_name: document.getElementById('ev_name').value,
                        event_type: document.getElementById('ev_type').value,
                        event_date: document.getElementById('ev_date').value,
                        start_time: document.getElementById('ev_start').value,
                        end_time: document.getElementById('ev_end').value,
                        location: document.getElementById('ev_location').value,
                        participant_scope: document.getElementById('ev_scope').value,
                        status: document.getElementById('ev_status').value
                    };
                    const url = id ? \`/api/admin/events/\${id}\` : '/api/admin/events';
                    const method = id ? 'PUT' : 'POST';

                    const res = await fetch(url, {
                        method: method,
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    alert(data.message);
                    if(data.success) {
                        bootstrap.Modal.getInstance(document.getElementById('eventModal')).hide();
                        loadEventsData();
                    }
                }
            });

            async function deleteEvent(id) {
                if(!confirm('Are you sure? This will delete all attendance records associated with this event.')) return;
                const res = await fetch(\`/api/admin/events/\${id}\`, { method: 'DELETE' });
                const data = await res.json();
                alert(data.message);
                if(data.success) loadEventsData();
            }

            /* --- ATTENDANCE RECORDS VIEW --- */
            async function loadAttendanceView(container) {
                container.innerHTML = \`
                <div class="card card-dashboard p-3 bg-white">
                    <div class="table-responsive">
                        <table class="table table-hover align-middle">
                            <thead class="table-light">
                                <tr>
                                    <th>Student</th>
                                    <th>Position</th>
                                    <th>Event</th>
                                    <th>Date</th>
                                    <th>Time In</th>
                                    <th>Time Out</th>
                                    <th>Status</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="attendanceLogsBody">
                                <tr><td colspan="8" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                \`;

                const res = await fetch('/api/admin/attendance');
                const logs = await res.json();
                const tbody = document.getElementById('attendanceLogsBody');
                tbody.innerHTML = logs.map(l => \`
                    <tr>
                        <td class="fw-bold">\${l.full_name}<br><small class="text-muted">\${l.student_id}</small></td>
                        <td>\${l.position_title || 'Member'}</td>
                        <td>\${l.event_name}</td>
                        <td>\${l.event_date}</td>
                        <td>\${l.time_in ? new Date(l.time_in).toLocaleTimeString() : '-'}</td>
                        <td>\${l.time_out ? new Date(l.time_out).toLocaleTimeString() : '-'}</td>
                        <td><span class="badge bg-\${l.status==='Present'?'success':l.status==='Late'?'warning':'danger'}">\${l.status}</span></td>
                        <td>
                            <button class="btn btn-sm btn-outline-secondary" onclick="markExcused(\${l.id})">Excuse</button>
                        </td>
                    </tr>
                \`).join('');
            }

            async function markExcused(attendanceId) {
                const reason = prompt('Enter reason for excusing student absence/lateness:');
                if(!reason) return;
                const res = await fetch(\`/api/admin/attendance/\${attendanceId}/excuse\`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ reason })
                });
                const data = await res.json();
                alert(data.message);
                if(data.success) switchTab('attendance');
            }

            /* --- A4 PRINTABLE ID CARDS VIEW --- */
            async function loadIDCardsView(container) {
                container.innerHTML = \`
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <div>
                        <h6 class="fw-bold text-muted mb-0">Student Club Digital & Printable IDs</h6>
                        <small class="text-muted">Arranged precisely 8 IDs per A4 Bond Paper sheet.</small>
                    </div>
                    <button class="btn btn-success fw-bold" onclick="printIDSheet()"><i class="bi bi-printer-fill me-1"></i> Print A4 Sheet</button>
                </div>
                <div class="card card-dashboard p-4 bg-white" id="idCardsContainer">
                    <div class="text-center py-4"><div class="spinner-border text-primary"></div></div>
                </div>
                \`;

                const res = await fetch('/api/admin/students');
                const students = await res.json();
                const settingsRes = await fetch('/api/admin/settings');
                const settings = await settingsRes.json();

                const containerDiv = document.getElementById('idCardsContainer');
                
                let html = '<div class="id-card-grid">';
                for(let s of students) {
                    const qrUrl = await QRCode.toDataURL(s.qr_token);
                    html += \`
                    <div class="id-card">
                        <div class="id-card-header">
                            <div class="fw-bold" style="font-size: 8pt;">\${settings.school_name || 'ABC National High School'}</div>
                            <div style="font-size: 7pt;">\${settings.club_name || 'Computer Club'}</div>
                        </div>
                        <div class="id-card-body">
                            <img src="\${s.photo_url || 'https://via.placeholder.com/80'}" class="id-photo" alt="Photo">
                            <div class="id-details">
                                <div class="fw-bold text-primary" style="font-size: 9pt;">\${s.full_name}</div>
                                <div class="text-muted">ID: \${s.student_id}</div>
                                <div class="fw-bold text-dark mt-1">POS: \${s.position_title || 'Member'}</div>
                                <div>S.Y. \${s.school_year}</div>
                            </div>
                            <img src="\${qrUrl}" class="id-qr" alt="QR">
                        </div>
                        <div class="id-card-footer">
                            OFFICIAL STUDENT CLUB MEMBER ID CARD
                        </div>
                    </div>
                    \`;
                }
                html += '</div>';
                containerDiv.innerHTML = html;
            }

            function printIDSheet() {
                const printSection = document.getElementById('print-section');
                printSection.innerHTML = document.getElementById('idCardsContainer').innerHTML;
                printSection.classList.remove('d-none');
                window.print();
                printSection.classList.add('d-none');
            }

            /* --- REPORTS & AUDIT LOGS VIEW --- */
            async function loadReportsView(container) {
                container.innerHTML = \`
                <div class="card card-dashboard p-4 bg-white mb-4">
                    <h6 class="fw-bold mb-3">Export System Data</h6>
                    <div class="d-flex gap-2">
                        <a href="/api/admin/export/students" class="btn btn-outline-primary"><i class="bi bi-file-earmark-spreadsheet me-1"></i> Export Students CSV</a>
                        <a href="/api/admin/export/attendance" class="btn btn-outline-success"><i class="bi bi-file-earmark-spreadsheet me-1"></i> Export Attendance CSV</a>
                    </div>
                </div>
                \`;
            }

            async function loadAuditLogsView(container) {
                container.innerHTML = \`
                <div class="card card-dashboard p-3 bg-white">
                    <div class="table-responsive">
                        <table class="table table-hover align-middle">
                            <thead class="table-light">
                                <tr>
                                    <th>Timestamp</th>
                                    <th>User</th>
                                    <th>Role</th>
                                    <th>Action</th>
                                    <th>Details</th>
                                    <th>IP</th>
                                </tr>
                            </thead>
                            <tbody id="auditLogsBody">
                                <tr><td colspan="6" class="text-center py-4"><div class="spinner-border text-primary"></div></td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                \`;

                const res = await fetch('/api/admin/audit-logs');
                const logs = await res.json();
                document.getElementById('auditLogsBody').innerHTML = logs.map(l => \`
                    <tr>
                        <td>\${new Date(l.timestamp).toLocaleString()}</td>
                        <td class="fw-bold">\${l.username}</td>
                        <td><span class="badge bg-secondary">\${l.role}</span></td>
                        <td><span class="badge bg-info">\${l.action}</span></td>
                        <td>\${l.details}</td>
                        <td><small class="text-muted">\${l.ip_address}</small></td>
                    </tr>
                \`).join('');
            }

            /* --- SYSTEM SETTINGS VIEW --- */
            async function loadSettingsView(container) {
                const res = await fetch('/api/admin/settings');
                const s = await res.json();

                container.innerHTML = \`
                <div class="row g-4">
                    <div class="col-md-6">
                        <div class="card card-dashboard p-4 bg-white">
                            <h6 class="fw-bold mb-3">School & Club Branding</h6>
                            <form id="settingsForm">
                                <div class="mb-3">
                                    <label class="form-label">School Name</label>
                                    <input type="text" class="form-control" name="school_name" value="\${s.school_name || ''}">
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Student Club Name</label>
                                    <input type="text" class="form-control" name="club_name" value="\${s.club_name || ''}">
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">Club Adviser</label>
                                    <input type="text" class="form-control" name="club_adviser" value="\${s.club_adviser || ''}">
                                </div>
                                <div class="mb-3">
                                    <label class="form-label">School Year</label>
                                    <input type="text" class="form-control" name="school_year" value="\${s.school_year || ''}">
                                </div>
                                <button type="submit" class="btn btn-primary fw-bold">Save Settings</button>
                            </form>
                        </div>
                    </div>
                    <div class="col-md-6">
                        <div class="card card-dashboard p-4 bg-white mb-4">
                            <h6 class="fw-bold mb-3">Database Backup & Recovery</h6>
                            <a href="/api/admin/backup" class="btn btn-outline-dark mb-3 w-100"><i class="bi bi-download me-1"></i> Download Database Backup (.db)</a>
                        </div>
                    </div>
                </div>
                \`;

                document.getElementById('settingsForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const payload = {};
                    formData.forEach((val, key) => payload[key] = val);

                    const res = await fetch('/api/admin/settings', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    alert(data.message);
                });
            }
        </script>
    </body>
    </html>
    `;
}

function renderScannerApp(user) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    ${getCommonHead('Mobile QR Scanner')}
    <body class="bg-dark text-white">
        <div class="container py-3 style="max-width: 600px;">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <div>
                    <h5 class="fw-bold mb-0 text-primary"><i class="bi bi-qr-code-scan me-2"></i> Attendance Scanner</h5>
                    <small class="text-muted">User: ${user.username}</small>
                </div>
                <div>
                    <button class="btn btn-sm btn-outline-light me-1" onclick="openPasswordModal()"><i class="bi bi-key"></i></button>
                    <button class="btn btn-sm btn-outline-danger" onclick="logout()"><i class="bi bi-box-arrow-right"></i></button>
                </div>
            </div>

            <!-- Active Event Banner -->
            <div class="card bg-secondary text-white p-3 mb-3 border-0">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <small class="text-uppercase fw-bold text-info">Target Event</small>
                        <h6 class="fw-bold mb-0" id="scannerEventTitle">Loading event...</h6>
                    </div>
                    <span class="badge bg-success" id="scannerEventStatus">ACTIVE</span>
                </div>
            </div>

            <!-- Mode Selector -->
            <div class="btn-group w-100 mb-3" role="group">
                <input type="radio" class="btn-check" name="scanMode" id="modeTimeIn" value="TIME_IN" checked>
                <label class="btn btn-outline-success py-2 fw-bold" for="modeTimeIn"><i class="bi bi-box-arrow-in-right me-1"></i> TIME IN</label>

                <input type="radio" class="btn-check" name="scanMode" id="modeTimeOut" value="TIME_OUT">
                <label class="btn btn-outline-warning py-2 fw-bold" for="modeTimeOut"><i class="bi bi-box-arrow-left me-1"></i> TIME OUT</label>
            </div>

            <!-- Camera Viewport Card -->
            <div class="card bg-black border-secondary p-2 mb-3 text-center">
                <div id="reader" style="width: 100%; min-height: 280px; background: #000;"></div>
            </div>

            <!-- Feedback Display Container -->
            <div id="scanResultCard" class="card p-3 text-center d-none mb-3"></div>

            <!-- Recent Local Scans Log -->
            <div class="card bg-secondary text-white p-3 border-0">
                <h6 class="fw-bold mb-2"><i class="bi bi-clock-history me-1"></i> Recent Scans</h6>
                <div id="recentScansList" class="small">
                    <div class="text-muted text-center">No scans recorded in this session.</div>
                </div>
            </div>
        </div>

        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
        <script>
            let html5QrcodeScanner;
            let currentEvent = null;
            let isProcessing = false;

            document.addEventListener('DOMContentLoaded', async () => {
                await fetchActiveEvent();
                initScanner();
            });

            async function fetchActiveEvent() {
                const res = await fetch('/api/scanner/active-event');
                const data = await res.json();
                if(data.success && data.event) {
                    currentEvent = data.event;
                    document.getElementById('scannerEventTitle').textContent = data.event.event_name;
                } else {
                    document.getElementById('scannerEventTitle').textContent = 'No Active Event Selected';
                    document.getElementById('scannerEventStatus').className = 'badge bg-danger';
                    document.getElementById('scannerEventStatus').textContent = 'INACTIVE';
                }
            }

            function initScanner() {
                html5QrcodeScanner = new Html5Qrcode("reader");
                html5QrcodeScanner.start(
                    { facingMode: "environment" },
                    { fps: 10, qrbox: { width: 250, height: 250 } },
                    onScanSuccess
                ).catch(err => console.error("Camera access error:", err));
            }

            async function onScanSuccess(decodedText) {
                if (isProcessing) return;
                isProcessing = true;

                const mode = document.querySelector('input[name="scanMode"]:checked').value;
                if(!currentEvent) {
                    playAudio('error');
                    speak('No active event selected.');
                    showFeedback('danger', 'No Active Event', 'Administrator must activate an event first.');
                    setTimeout(() => { isProcessing = false; }, 3000);
                    return;
                }

                const res = await fetch('/api/scanner/scan', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        qr_token: decodedText,
                        event_id: currentEvent.id,
                        mode: mode
                    })
                });

                const data = await res.json();

                if(data.success) {
                    playAudio('success');
                    speak(\`\${data.student.full_name}, \${mode === 'TIME_IN' ? 'attendance recorded' : 'time out recorded'}.\`);
                    showFeedback('success', \`\${data.student.full_name}\`, \`ID: \${data.student.student_id} | \${data.student.position_title || 'Member'}<br>Status: \${data.status}\`);
                    prependRecentScan(data.student.full_name, mode, new Date().toLocaleTimeString());
                } else if(data.duplicate) {
                    playAudio('warning');
                    speak(\`\${data.student ? data.student.full_name : 'User'}, you are already recorded.\`);
                    showFeedback('warning', 'Already Recorded', data.message);
                } else {
                    playAudio('error');
                    speak('Invalid QR code.');
                    showFeedback('danger', 'Scan Failed', data.message);
                }

                setTimeout(() => {
                    document.getElementById('scanResultCard').classList.add('d-none');
                    isProcessing = false;
                }, 3500);
            }

            function showFeedback(type, title, message) {
                const card = document.getElementById('scanResultCard');
                card.className = \`card p-3 text-center mb-3 bg-\${type} text-white\`;
                card.innerHTML = \`<h5 class="fw-bold mb-1">\${title}</h5><div>\${message}</div>\`;
                card.classList.remove('d-none');
            }

            function prependRecentScan(name, mode, time) {
                const list = document.getElementById('recentScansList');
                if(list.querySelector('.text-muted')) list.innerHTML = '';
                const item = document.createElement('div');
                item.className = 'd-flex justify-content-between border-bottom border-dark py-1';
                item.innerHTML = \`<span>\${name} (\${mode})</span><span class="text-info">\${time}</span>\`;
                list.prepend(item);
            }

            /* Web Audio Synthesizer Tone Helpers */
            function playAudio(type) {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                if (type === 'success') {
                    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
                    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
                } else if (type === 'warning') {
                    osc.frequency.setValueAtTime(440, ctx.currentTime);
                    osc.frequency.setValueAtTime(440, ctx.currentTime + 0.15);
                } else {
                    osc.frequency.setValueAtTime(150, ctx.currentTime);
                }

                osc.start();
                gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.3);
                osc.stop(ctx.currentTime + 0.3);
            }

            /* Web Speech API Voice Synthesis */
            function speak(text) {
                if ('speechSynthesis' in window) {
                    window.speechSynthesis.cancel();
                    const utterance = new SpeechSynthesisUtterance(text);
                    utterance.rate = 1.0;
                    utterance.pitch = 1.0;
                    window.speechSynthesis.speak(utterance);
                }
            }

            async function logout() {
                await fetch('/api/auth/logout', { method: 'POST' });
                window.location.href = '/';
            }
        </script>
    </body>
    </html>
    `;
}

function renderStudentPortal(user) {
    return `
    <!DOCTYPE html>
    <html lang="en">
    ${getCommonHead('Student Portal')}
    <body>
        <div class="container py-4 style="max-width: 800px;">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <div>
                    <h4 class="fw-bold text-primary mb-0"><i class="bi bi-person-badge-fill me-2"></i> Student Member Portal</h4>
                    <small class="text-muted">Welcome back, ${user.username}</small>
                </div>
                <button class="btn btn-outline-danger btn-sm" onclick="logout()"><i class="bi bi-box-arrow-right me-1"></i> Logout</button>
            </div>

            <div id="studentPortalContent">
                <div class="text-center py-5"><div class="spinner-border text-primary"></div></div>
            </div>
        </div>

        <script>
            document.addEventListener('DOMContentLoaded', loadMemberData);

            async function loadMemberData() {
                const res = await fetch('/api/member/profile');
                const data = await res.json();
                const container = document.getElementById('studentPortalContent');

                if(!data.success) {
                    container.innerHTML = \`<div class="alert alert-danger">\${data.message}</div>\`;
                    return;
                }

                const s = data.student;
                const qrUrl = await QRCode.toDataURL(s.qr_token);

                container.innerHTML = \`
                <div class="row g-4">
                    <div class="col-md-5">
                        <div class="card card-dashboard p-4 bg-white text-center">
                            <img src="\${qrUrl}" class="img-fluid mb-3 mx-auto" style="max-width: 200px;" alt="Digital QR">
                            <h5 class="fw-bold text-primary mb-0">\${s.full_name}</h5>
                            <div class="badge bg-secondary mb-2">\${s.position_title || 'Member'}</div>
                            <div class="small text-muted">Student ID: \${s.student_id}</div>
                            <div class="small text-muted">S.Y. \${s.school_year}</div>
                        </div>
                    </div>
                    <div class="col-md-7">
                        <div class="card card-dashboard p-4 bg-white mb-4">
                            <h6 class="fw-bold mb-3 border-bottom pb-2">Participation Metrics</h6>
                            <div class="row text-center">
                                <div class="col-4">
                                    <div class="fs-4 fw-bold text-primary">\${data.metrics.total_events}</div>
                                    <small class="text-muted">Total Events</small>
                                </div>
                                <div class="col-4">
                                    <div class="fs-4 fw-bold text-success">\${data.metrics.attended_events}</div>
                                    <small class="text-muted">Attended</small>
                                </div>
                                <div class="col-4">
                                    <div class="fs-4 fw-bold text-info">\${data.metrics.participation_rate}%</div>
                                    <small class="text-muted">Rate</small>
                                </div>
                            </div>
                        </div>

                        <div class="card card-dashboard p-4 bg-white">
                            <h6 class="fw-bold mb-3 border-bottom pb-2">Recent Attendance History</h6>
                            <div class="table-responsive">
                                <table class="table table-sm align-middle">
                                    <thead>
                                        <tr>
                                            <th>Event</th>
                                            <th>Date</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        \${data.history.length === 0 ? '<tr><td colspan="3" class="text-center py-2 text-muted">No attendance logs found</td></tr>' :
                                            data.history.map(h => \`
                                                <tr>
                                                    <td class="fw-bold">\${h.event_name}</td>
                                                    <td>\${h.event_date}</td>
                                                    <td><span class="badge bg-\${h.status==='Present'?'success':h.status==='Late'?'warning':'danger'}">\${h.status}</span></td>
                                                </tr>
                                            \`).join('')
                                        }
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
                \`;
            }

            async function logout() {
                await fetch('/api/auth/logout', { method: 'POST' });
                window.location.href = '/';
            }
        </script>
    </body>
    </html>
    `;
}

// ==========================================
// API ROUTING ENDPOINTS & DATABASE OPERATIONS
// ==========================================

/* --- Admin Analytics & Stats --- */
app.get('/api/admin/dashboard-stats', requireAuth(['admin']), (req, res) => {
    db.get(`SELECT COUNT(*) as total FROM students`, (err, totStud) => {
        db.get(`SELECT COUNT(*) as officers FROM students s JOIN positions p ON s.position_id = p.id WHERE p.is_officer = 1`, (err, totOff) => {
            db.get(`SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1`, (err, activeEv) => {
                db.all(`SELECT a.*, s.full_name, s.student_id, p.title as position_title, e.event_name 
                        FROM attendance a 
                        JOIN students s ON a.student_id = s.student_id 
                        LEFT JOIN positions p ON s.position_id = p.id
                        JOIN events e ON a.event_id = e.id
                        ORDER BY a.id DESC LIMIT 10`, (err, recentScans) => {
                    
                    db.all(`SELECT status, COUNT(*) as count FROM attendance GROUP BY status`, (err, counts) => {
                        let present = 0, late = 0, absent = 0, excused = 0;
                        (counts || []).forEach(c => {
                            if (c.status === 'Present') present = c.count;
                            if (c.status === 'Late') late = c.count;
                            if (c.status === 'Absent') absent = c.count;
                            if (c.status === 'Excused') excused = c.count;
                        });
                        const totalScans = present + late + absent + excused;
                        const overallRate = totalScans > 0 ? (((present + late) / totalScans) * 100).toFixed(1) : 100;

                        res.json({
                            total_students: totStud ? totStud.total : 0,
                            total_officers: totOff ? totOff.officers : 0,
                            active_event: activeEv || null,
                            recent_scans: recentScans || [],
                            present_count: present,
                            late_count: late,
                            absent_count: absent,
                            excused_count: excused,
                            overall_rate: overallRate
                        });
                    });
                });
            });
        });
    });
});

/* --- Student Management Endpoints --- */
app.get('/api/admin/students', requireAuth(['admin']), (req, res) => {
    db.all(`SELECT s.*, p.title as position_title, p.is_officer 
            FROM students s 
            LEFT JOIN positions p ON s.position_id = p.id 
            ORDER BY s.id DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/students', requireAuth(['admin']), (req, res) => {
    const { student_id, first_name, middle_name, last_name, position_id, gender, contact_number, school_email, guardian_name, guardian_contact, membership_status } = req.body;
    
    if(!student_id || !first_name || !last_name || !position_id) {
        return res.json({ success: false, message: 'Missing required student fields.' });
    }

    const fullName = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;
    const qrToken = 'QR_' + crypto.randomBytes(8).toString('hex').toUpperCase();

    db.get(`SELECT key, value FROM settings`, (err, rows) => {
        let clubName = 'Computer Club', schoolYear = '2026-2027';
        (rows || []).forEach(r => {
            if(r.key === 'club_name') clubName = r.value;
            if(r.key === 'school_year') schoolYear = r.value;
        });

        db.run(`INSERT INTO students (student_id, first_name, middle_name, last_name, full_name, position_id, student_club, school_year, gender, contact_number, school_email, guardian_name, guardian_contact, membership_status, qr_token)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [student_id, first_name, middle_name, last_name, fullName, position_id, clubName, schoolYear, gender, contact_number, school_email, guardian_name, guardian_contact, membership_status || 'Active', qrToken],
                function(err) {
                    if (err) return res.json({ success: false, message: 'Student ID or Email already exists.' });
                    
                    // Create default student login credentials (password: student123)
                    const hash = bcrypt.hashSync('student123', 10);
                    db.run(`INSERT INTO users (username, password, role, student_id) VALUES (?, ?, 'student', ?)`, [student_id, hash, student_id]);

                    logAudit(req, 'ADD_STUDENT', `Added student ${fullName} (${student_id}).`);
                    res.json({ success: true, message: 'Student registered successfully. Default password is student123' });
                });
    });
});

app.put('/api/admin/students/:id', requireAuth(['admin']), (req, res) => {
    const { student_id, first_name, middle_name, last_name, position_id, gender, contact_number, school_email, guardian_name, guardian_contact, membership_status } = req.body;
    const fullName = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;

    db.run(`UPDATE students SET student_id=?, first_name=?, middle_name=?, last_name=?, full_name=?, position_id=?, gender=?, contact_number=?, school_email=?, guardian_name=?, guardian_contact=?, membership_status=? WHERE id=?`,
        [student_id, first_name, middle_name, last_name, fullName, position_id, gender, contact_number, school_email, guardian_name, guardian_contact, membership_status, req.params.id],
        function(err) {
            if(err) return res.json({ success: false, message: 'Failed to update student profile.' });
            logAudit(req, 'UPDATE_STUDENT', `Updated student ID ${student_id}.`);
            res.json({ success: true, message: 'Student profile updated successfully.' });
        });
});

app.post('/api/admin/students/:student_id/regenerate-qr', requireAuth(['admin']), (req, res) => {
    const newToken = 'QR_' + crypto.randomBytes(8).toString('hex').toUpperCase();
    db.run(`UPDATE students SET qr_token = ? WHERE student_id = ?`, [newToken, req.params.student_id], function(err) {
        if(err) return res.json({ success: false, message: 'Failed to regenerate QR code.' });
        logAudit(req, 'REGENERATE_QR', `Regenerated QR token for student ${req.params.student_id}.`);
        res.json({ success: true, message: 'QR Code regenerated successfully.' });
    });
});

app.delete('/api/admin/students/:student_id', requireAuth(['admin']), (req, res) => {
    db.run(`DELETE FROM students WHERE student_id = ?`, [req.params.student_id], function(err) {
        if(err) return res.json({ success: false, message: 'Failed to delete student.' });
        db.run(`DELETE FROM users WHERE student_id = ?`, [req.params.student_id]);
        logAudit(req, 'DELETE_STUDENT', `Deleted student ID ${req.params.student_id}.`);
        res.json({ success: true, message: 'Student removed successfully.' });
    });
});

/* --- Positions Management Endpoints --- */
app.get('/api/admin/positions', requireAuth(['admin', 'scanner']), (req, res) => {
    db.all(`SELECT * FROM positions ORDER BY is_officer DESC, title ASC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/positions', requireAuth(['admin']), (req, res) => {
    const { title, description, is_officer } = req.body;
    if(!title) return res.json({ success: false, message: 'Title is required.' });

    db.run(`INSERT INTO positions (title, description, is_officer) VALUES (?, ?, ?)`, [title, description, is_officer ? 1 : 0], function(err) {
        if(err) return res.json({ success: false, message: 'Position title already exists.' });
        logAudit(req, 'CREATE_POSITION', `Created custom position "${title}".`);
        res.json({ success: true, message: 'Position created successfully.' });
    });
});

app.put('/api/admin/positions/:id', requireAuth(['admin']), (req, res) => {
    const { title, description, is_officer } = req.body;
    db.run(`UPDATE positions SET title=?, description=?, is_officer=? WHERE id=?`, [title, description, is_officer ? 1 : 0, req.params.id], function(err) {
        if(err) return res.json({ success: false, message: 'Failed to update position.' });
        logAudit(req, 'UPDATE_POSITION', `Updated position ID ${req.params.id}.`);
        res.json({ success: true, message: 'Position updated successfully.' });
    });
});

app.delete('/api/admin/positions/:id', requireAuth(['admin']), (req, res) => {
    db.run(`DELETE FROM positions WHERE id=?`, [req.params.id], function(err) {
        if(err) return res.json({ success: false, message: 'Failed to delete position.' });
        logAudit(req, 'DELETE_POSITION', `Deleted position ID ${req.params.id}.`);
        res.json({ success: true, message: 'Position deleted successfully.' });
    });
});

/* --- Events Management Endpoints --- */
app.get('/api/admin/events', requireAuth(['admin', 'scanner']), (req, res) => {
    db.all(`SELECT * FROM events ORDER BY event_date DESC, start_time DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/events', requireAuth(['admin']), (req, res) => {
    const { event_name, event_type, event_date, start_time, end_time, location, participant_scope, status } = req.body;

    db.run(`INSERT INTO events (event_name, event_type, event_date, start_time, end_time, location, participant_scope, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [event_name, event_type, event_date, start_time, end_time, location, participant_scope || 'ALL', status || 'Upcoming'],
            function(err) {
                if(err) return res.json({ success: false, message: 'Failed to create event.' });
                logAudit(req, 'CREATE_EVENT', `Created event "${event_name}".`);
                res.json({ success: true, message: 'Event created successfully.' });
            });
});

app.post('/api/admin/events/:id/activate', requireAuth(['admin']), (req, res) => {
    db.run(`UPDATE events SET status = 'Completed' WHERE status = 'Active'`, () => {
        db.run(`UPDATE events SET status = 'Active' WHERE id = ?`, [req.params.id], function(err) {
            if(err) return res.json({ success: false, message: 'Failed to set active event.' });
            logAudit(req, 'ACTIVATE_EVENT', `Set event ID ${req.params.id} as Active.`);
            res.json({ success: true, message: 'Event activated successfully.' });
        });
    });
});

app.delete('/api/admin/events/:id', requireAuth(['admin']), (req, res) => {
    db.run(`DELETE FROM events WHERE id = ?`, [req.params.id], function(err) {
        if(err) return res.json({ success: false, message: 'Failed to delete event.' });
        logAudit(req, 'DELETE_EVENT', `Deleted event ID ${req.params.id}.`);
        res.json({ success: true, message: 'Event deleted successfully.' });
    });
});

/* --- Attendance & Excuses Endpoints --- */
app.get('/api/admin/attendance', requireAuth(['admin']), (req, res) => {
    db.all(`SELECT a.*, s.full_name, s.student_id, p.title as position_title, e.event_name, e.event_date
            FROM attendance a
            JOIN students s ON a.student_id = s.student_id
            LEFT JOIN positions p ON s.position_id = p.id
            JOIN events e ON a.event_id = e.id
            ORDER BY a.id DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/attendance/:id/excuse', requireAuth(['admin']), (req, res) => {
    const { reason, notes } = req.body;
    db.run(`UPDATE attendance SET status = 'Excused' WHERE id = ?`, [req.params.id], function(err) {
        if(err) return res.json({ success: false, message: 'Failed to mark excused.' });
        db.run(`INSERT INTO attendance_excuses (attendance_id, reason, notes, approved_by) VALUES (?, ?, ?, ?)`,
            [req.params.id, reason, notes || '', req.session.user.username]);
        logAudit(req, 'EXCUSE_ATTENDANCE', `Excused attendance ID ${req.params.id}.`);
        res.json({ success: true, message: 'Student attendance status marked as Excused.' });
    });
});

/* --- Mobile Scanner Endpoints --- */
app.get('/api/scanner/active-event', requireAuth(['admin', 'scanner']), (req, res) => {
    db.get(`SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1`, (err, row) => {
        res.json({ success: true, event: row || null });
    });
});

app.post('/api/scanner/scan', requireAuth(['admin', 'scanner']), (req, res) => {
    const { qr_token, event_id, mode } = req.body;

    db.get(`SELECT s.*, p.title as position_title FROM students s LEFT JOIN positions p ON s.position_id = p.id WHERE s.qr_token = ?`, [qr_token], (err, student) => {
        if (err || !student) {
            return res.json({ success: false, message: 'Invalid or unrecognized QR Code token.' });
        }

        if (student.qr_status === 'Disabled' || student.membership_status === 'Suspended') {
            return res.json({ success: false, message: 'Student membership or QR code is currently disabled.' });
        }

        db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
            if (!event) return res.json({ success: false, message: 'Target event not found.' });

            db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student.student_id], (err, record) => {
                const now = new Date().toISOString();

                if (mode === 'TIME_IN') {
                    if (record) {
                        return res.json({ success: false, duplicate: true, student, message: `${student.full_name} is already recorded Time In.` });
                    }

                    // Compute Late Status
                    const eventStart = new Date(`${event.event_date}T${event.start_time}`);
                    const scanTime = new Date();
                    const diffMins = (scanTime - eventStart) / (1000 * 60);
                    const status = diffMins > 15 ? 'Late' : 'Present';

                    db.run(`INSERT INTO attendance (event_id, student_id, time_in, status, scanned_by) VALUES (?, ?, ?, ?, ?)`,
                        [event_id, student.student_id, now, status, req.session.user.username],
                        function(err) {
                            if(err) return res.json({ success: false, message: 'Database writing error.' });
                            logAudit(req, 'SCAN_TIME_IN', `Recorded Time In for ${student.full_name} (${status}).`);
                            res.json({ success: true, student, status, time_in: now });
                        });
                } else {
                    // TIME OUT MODE
                    if (!record) {
                        return res.json({ success: false, message: 'Cannot record Time Out without an existing Time In.' });
                    }
                    if (record.time_out) {
                        return res.json({ success: false, duplicate: true, student, message: `${student.full_name} has already recorded Time Out.` });
                    }

                    db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [now, record.id], function(err) {
                        if(err) return res.json({ success: false, message: 'Failed to record Time Out.' });
                        logAudit(req, 'SCAN_TIME_OUT', `Recorded Time Out for ${student.full_name}.`);
                        res.json({ success: true, student, status: record.status, time_out: now });
                    });
                }
            });
        });
    });
});

/* --- Student Portal Endpoints --- */
app.get('/api/member/profile', requireAuth(['student']), (req, res) => {
    const studentId = req.session.user.student_id;
    db.get(`SELECT s.*, p.title as position_title FROM students s LEFT JOIN positions p ON s.position_id = p.id WHERE s.student_id = ?`, [studentId], (err, student) => {
        if(!student) return res.json({ success: false, message: 'Member profile not found.' });

        db.all(`SELECT a.*, e.event_name, e.event_date FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.student_id = ? ORDER BY a.id DESC`, [studentId], (err, history) => {
            db.get(`SELECT COUNT(*) as total FROM events WHERE status = 'Completed'`, (err, totEv) => {
                const attended = history ? history.length : 0;
                const total = totEv ? totEv.total : 0;
                const rate = total > 0 ? ((attended / total) * 100).toFixed(0) : 100;

                res.json({
                    success: true,
                    student,
                    history: history || [],
                    metrics: {
                        total_events: total,
                        attended_events: attended,
                        participation_rate: rate
                    }
                });
            });
        });
    });
});

/* --- Audit Logs & Export Endpoints --- */
app.get('/api/admin/audit-logs', requireAuth(['admin']), (req, res) => {
    db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100`, (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/admin/settings', requireAuth(['admin', 'scanner', 'student']), (req, res) => {
    db.all(`SELECT key, value FROM settings`, (err, rows) => {
        const obj = {};
        (rows || []).forEach(r => obj[r.key] = r.value);
        res.json(obj);
    });
});

app.post('/api/admin/settings', requireAuth(['admin']), (req, res) => {
    const payload = req.body;
    db.serialize(() => {
        Object.keys(payload).forEach(k => {
            db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`, [k, payload[k], payload[k]]);
        });
        logAudit(req, 'UPDATE_SETTINGS', 'Updated system branding and configuration settings.');
        res.json({ success: true, message: 'Settings saved successfully.' });
    });
});

app.get('/api/admin/export/students', requireAuth(['admin']), (req, res) => {
    db.all(`SELECT s.student_id, s.full_name, p.title as position, s.gender, s.school_email, s.membership_status 
            FROM students s LEFT JOIN positions p ON s.position_id = p.id`, (err, rows) => {
        let csv = 'Student ID,Full Name,Position,Gender,Email,Status\n';
        (rows || []).forEach(r => {
            csv += `"${r.student_id}","${r.full_name}","${r.position || 'Member'}","${r.gender || ''}","${r.school_email || ''}","${r.membership_status}"\n`;
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=students_export.csv');
        res.send(csv);
    });
});

app.get('/api/admin/export/attendance', requireAuth(['admin']), (req, res) => {
    db.all(`SELECT a.id, s.student_id, s.full_name, e.event_name, a.time_in, a.time_out, a.status 
            FROM attendance a 
            JOIN students s ON a.student_id = s.student_id 
            JOIN events e ON a.event_id = e.id`, (err, rows) => {
        let csv = 'Attendance ID,Student ID,Full Name,Event,Time In,Time Out,Status\n';
        (rows || []).forEach(r => {
            csv += `"${r.id}","${r.student_id}","${r.full_name}","${r.event_name}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=attendance_export.csv');
        res.send(csv);
    });
});

app.get('/api/admin/backup', requireAuth(['admin']), (req, res) => {
    const file = path.join(DATA_DIR, 'attendance.db');
    res.download(file, `attendance_backup_${Date.now()}.db`);
});

// Start Server Routine
app.listen(PORT, () => {
    console.log(`=================================================================`);
    console.log(`School Student Club QR Attendance System is live on port ${PORT}`);
    console.log(`Admin Dashboard: http://localhost:${PORT}/admin`);
    console.log(`Mobile Scanner:  http://localhost:${PORT}/scanner`);
    console.log(`Student Portal:  http://localhost:${PORT}/member`);
    console.log(`=================================================================`);
});
