/**
 * School Organization QR Attendance System
 * Complete single-file Full-Stack Node.js Application (Express, SQLite/PostgreSQL, EJS-like Templates, QR Code Engine)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session Configuration
let sessionStore = undefined;
if (process.env.DATABASE_URL) {
    const connectPgSimple = require('connect-pg-simple')(session);
    const pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    sessionStore = new connectPgSimple({
        pool: pgPool,
        tableName: 'session',
        createTableIfMissing: true
    });
}

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'super_secret_school_qr_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ==========================================
// DATABASE ABSTRACTION LAYER (PostgreSQL / SQLite)
// ==========================================
let db;
const isPostgres = !!process.env.DATABASE_URL;

async function initDB() {
    if (isPostgres) {
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        db = {
            query: async (text, params) => pool.query(text, params),
            get: async (text, params) => {
                const res = await pool.query(text, params);
                return res.rows[0];
            },
            all: async (text, params) => {
                const res = await pool.query(text, params);
                return res.rows;
            },
            run: async (text, params) => {
                return pool.query(text, params);
            }
        };

        // Create PostgreSQL Tables
        await db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                role VARCHAR(50) NOT NULL,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                must_change_password BOOLEAN DEFAULT FALSE,
                active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS organizations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                code VARCHAR(50) UNIQUE NOT NULL,
                description TEXT,
                logo TEXT,
                active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS members (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE SET NULL,
                organization_id INT REFERENCES organizations(id) ON DELETE CASCADE,
                member_code VARCHAR(50) UNIQUE NOT NULL,
                first_name VARCHAR(100) NOT NULL,
                middle_name VARCHAR(100),
                last_name VARCHAR(100) NOT NULL,
                grade_level VARCHAR(20) NOT NULL,
                section VARCHAR(50) NOT NULL,
                email VARCHAR(150),
                contact_number VARCHAR(50),
                photo TEXT,
                qr_token VARCHAR(255) UNIQUE NOT NULL,
                qr_created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                active BOOLEAN DEFAULT TRUE,
                deleted_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                organization_id INT REFERENCES organizations(id) ON DELETE CASCADE,
                title VARCHAR(150) NOT NULL,
                event_date DATE NOT NULL,
                active BOOLEAN DEFAULT TRUE
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS attendance (
                id SERIAL PRIMARY KEY,
                member_id INT REFERENCES members(id) ON DELETE CASCADE,
                organization_id INT REFERENCES organizations(id) ON DELETE CASCADE,
                event_id INT REFERENCES events(id) ON DELETE SET NULL,
                attendance_date DATE DEFAULT CURRENT_DATE,
                time_in TIMESTAMP,
                time_out TIMESTAMP,
                status VARCHAR(50) DEFAULT 'PRESENT',
                scanner_user_id INT REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS announcements (
                id SERIAL PRIMARY KEY,
                title VARCHAR(150) NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id SERIAL PRIMARY KEY,
                user_id INT,
                action TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } else {
        // SQLite Local Fallback
        const sqlitePath = path.join(__dirname, 'database.sqlite');
        const sqlDb = new sqlite3.Database(sqlitePath);
        
        db = {
            query: (text, params = []) => new Promise((resolve, reject) => {
                sqlDb.all(text, params, (err, rows) => err ? reject(err) : resolve({ rows }));
            }),
            get: (text, params = []) => new Promise((resolve, reject) => {
                sqlDb.get(text, params, (err, row) => err ? reject(err) : resolve(row));
            }),
            all: (text, params = []) => new Promise((resolve, reject) => {
                sqlDb.all(text, params, (err, rows) => err ? reject(err) : resolve(rows));
            }),
            run: (text, params = []) => new Promise((resolve, reject) => {
                sqlDb.run(text, params, function(err) {
                    err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
                });
            })
        };

        // Create SQLite Tables
        await db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER DEFAULT 0,
                active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS organizations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                code TEXT UNIQUE NOT NULL,
                description TEXT,
                logo TEXT,
                active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS members (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                organization_id INTEGER,
                member_code TEXT UNIQUE NOT NULL,
                first_name TEXT NOT NULL,
                middle_name TEXT,
                last_name TEXT NOT NULL,
                grade_level TEXT NOT NULL,
                section TEXT NOT NULL,
                email TEXT,
                contact_number TEXT,
                photo TEXT,
                qr_token TEXT UNIQUE NOT NULL,
                qr_created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                active INTEGER DEFAULT 1,
                deleted_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                organization_id INTEGER,
                title TEXT NOT NULL,
                event_date TEXT NOT NULL,
                active INTEGER DEFAULT 1
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                member_id INTEGER,
                organization_id INTEGER,
                event_id INTEGER,
                attendance_date TEXT DEFAULT CURRENT_DATE,
                time_in DATETIME,
                time_out DATETIME,
                status TEXT DEFAULT 'PRESENT',
                scanner_user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await db.run(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                action TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
    }

    // Seed Default Super Admin
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'ChangeThisPasswordImmediately';
    const existingAdmin = await db.get(`SELECT * FROM users WHERE username = ? OR username = $1`, [adminUser]); // handles driver parameters safely
    
    // Normalize parameter query for both drivers
    const checkAdmin = isPostgres 
        ? await db.get(`SELECT * FROM users WHERE username = $1`, [adminUser])
        : await db.get(`SELECT * FROM users WHERE username = ?`, [adminUser]);

    if (!checkAdmin) {
        const hash = await bcrypt.hash(adminPass, 10);
        if (isPostgres) {
            await db.run(`INSERT INTO users (role, username, password_hash, must_change_password) VALUES ($1, $2, $3, $4)`, ['Super Admin', adminUser, hash, false]);
        } else {
            await db.run(`INSERT INTO users (role, username, password_hash, must_change_password) VALUES (?, ?, ?, ?)`, ['Super Admin', adminUser, hash, 0]);
        }
        console.log(`[INIT] Default Super Admin created: Username -> ${adminUser}`);
    }
}

// ==========================================
// AUTHENTICATION & ROLE MIDDLEWARES
// ==========================================
function requireAuth(roles = []) {
    return (req, res, next) => {
        if (!req.session.user) {
            return res.redirect('/login');
        }
        if (roles.length > 0 && !roles.includes(req.session.user.role)) {
            return res.status(403).send('Access Denied: You do not have permission to view this resource.');
        }
        next();
    };
}

// ==========================================
// CORE UI LAYOUT WRAPPER (Single Template Engine Engine)
// ==========================================
function renderLayout(title, content, user = null) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | School Organization QR Attendance</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --bs-primary-rgb: 13, 110, 253; }
        body { background-color: #f4f6f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .sidebar { min-height: 100vh; background: #212529; color: #fff; position: fixed; top: 0; left: 0; width: 260px; z-index: 1000; transition: all 0.3s; }
        .sidebar .nav-link { color: rgba(255,255,255,0.75); margin-bottom: 5px; border-radius: 6px; }
        .sidebar .nav-link:hover, .sidebar .nav-link.active { color: #fff; background: rgba(255,255,255,0.1); }
        .main-content { margin-left: 260px; padding: 30px; }
        .card { border: none; box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075); border-radius: 10px; }
        @media (max-width: 768px) {
            .sidebar { width: 100%; position: relative; min-height: auto; }
            .main-content { margin-left: 0; padding: 15px; }
        }
        @media print {
            body { background: #fff !important; }
            .sidebar, .no-print, .btn, nav { display: none !important; }
            .main-content { margin: 0 !important; padding: 0 !important; width: 100% !important; }
            .id-card-print { border: 2px solid #000 !important; box-shadow: none !important; width: 100% !important; max-width: 400px; margin: 0 auto; page-break-after: always; }
        }
    </style>
</head>
<body>
    ${user ? `
    <div class="sidebar p-3 d-flex flex-column justify-content-between">
        <div>
            <h4 class="text-white text-center py-3 border-bottom"><i class="fa-solid fa-qrcode me-2"></i>QR Attendance</h4>
            <ul class="nav flex-column mt-3">
                ${user.role === 'Super Admin' || user.role === 'Organization Admin' ? `
                    <li class="nav-item"><a href="/admin" class="nav-link"><i class="fa-solid fa-chart-line me-2"></i>Dashboard</a></li>
                    <li class="nav-item"><a href="/admin/members" class="nav-link"><i class="fa-solid fa-users me-2"></i>Members</a></li>
                    <li class="nav-item"><a href="/admin/organizations" class="nav-link"><i class="fa-solid fa-sitemap me-2"></i>Organizations</a></li>
                    <li class="nav-item"><a href="/admin/attendance" class="nav-link"><i class="fa-solid fa-clipboard-user me-2"></i>Attendance Logs</a></li>
                    <li class="nav-item"><a href="/admin/reports" class="nav-link"><i class="fa-solid fa-file-excel me-2"></i>Reports</a></li>
                    <li class="nav-item"><a href="/admin/accounts" class="nav-link"><i class="fa-solid fa-user-shield me-2"></i>Admin/Scanners</a></li>
                ` : ''}
                ${user.role === 'Member' ? `
                    <li class="nav-item"><a href="/member" class="nav-link"><i class="fa-solid fa-house me-2"></i>Member Dashboard</a></li>
                    <li class="nav-item"><a href="/member/id" class="nav-link"><i class="fa-solid id-card me-2"></i>Digital ID Card</a></li>
                    <li class="nav-item"><a href="/member/change-password" class="nav-link"><i class="fa-solid fa-key me-2"></i>Change Password</a></li>
                ` : ''}
                ${user.role === 'Scanner' ? `
                    <li class="nav-item"><a href="/scanner" class="nav-link"><i class="fa-solid fa-camera me-2"></i>QR Scanner Console</a></li>
                ` : ''}
            </ul>
        </div>
        <div class="border-top pt-3">
            <div class="small text-muted mb-2">Logged in as: <strong>${user.username}</strong> (${user.role})</div>
            <a href="/api/logout" class="btn btn-outline-danger w-100 btn-sm"><i class="fa-solid fa-right-from-bracket me-2"></i>Logout</a>
        </div>
    </div>
    ` : ''}
    <div class="${user ? 'main-content' : 'container mt-5'}">
        ${content}
    </div>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
}

// ==========================================
// PUBLIC & AUTH ROUTES
// ==========================================
app.get('/', (req, res) => {
    if (req.session.user) {
        if (req.session.user.role === 'Member') return res.redirect('/member');
        if (req.session.user.role === 'Scanner') return res.redirect('/scanner');
        return res.redirect('/admin');
    }
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    res.send(renderLayout('Login', `
        <div class="row justify-content-center">
            <div class="col-md-5">
                <div class="card shadow p-4">
                    <div class="text-center mb-4">
                        <i class="fa-solid fa-school-flag fa-3x text-primary mb-2"></i>
                        <h3>School Organization QR Attendance</h3>
                        <p class="text-muted">Sign in to your portal</p>
                    </div>
                    <form action="/api/login" method="POST">
                        <div class="mb-3">
                            <label class="form-label">Username</label>
                            <input type="text" name="username" class="form-control" required>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Password</label>
                            <input type="password" name="password" class="form-control" required>
                        </div>
                        <button type="submit" class="btn btn-primary w-100 py-2">Login</button>
                    </form>
                </div>
            </div>
        </div>
    `));
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const queryStr = isPostgres ? 'SELECT * FROM users WHERE username = $1' : 'SELECT * FROM users WHERE username = ?';
        const user = await db.get(queryStr, [username]);
        
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.send(`<script>alert('Invalid username or password.'); window.location='/login';</script>`);
        }
        if (!user.active) {
            return res.send(`<script>alert('Account is deactivated.'); window.location='/login';</script>`);
        }

        req.session.user = { id: user.id, username: user.username, role: user.role, must_change_password: user.must_change_password };
        
        if (user.must_change_password) {
            return res.redirect('/member/change-password');
        }
        if (user.role === 'Member') return res.redirect('/member');
        if (user.role === 'Scanner') return res.redirect('/scanner');
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ==========================================
// MEMBER PORTAL ROUTES
// ==========================================
app.get('/member', requireAuth(['Member']), async (req, res) => {
    if (req.session.user.must_change_password) return res.redirect('/member/change-password');
    
    const userQuery = isPostgres 
        ? `SELECT m.*, o.name as org_name, o.code as org_code FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.user_id = $1`
        : `SELECT m.*, o.name as org_name, o.code as org_code FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.user_id = ?`;
    
    const member = await db.get(userQuery, [req.session.user.id]);
    if (!member) return res.send('Member profile not found.');

    const attQuery = isPostgres 
        ? `SELECT * FROM attendance WHERE member_id = $1 ORDER BY created_at DESC LIMIT 10`
        : `SELECT * FROM attendance WHERE member_id = ? ORDER BY created_at DESC LIMIT 10`;
    const attendances = await db.all(attQuery, [member.id]);

    const qrImage = await QRCode.toDataURL(member.qr_token);

    res.send(renderLayout('Member Dashboard', `
        <div class="row">
            <div class="col-md-4 mb-4">
                <div class="card text-center p-4">
                    <img src="${member.photo || 'https://via.placeholder.com/150'}" class="rounded-circle mx-auto mb-3 img-thumbnail" style="width: 120px; height: 120px; object-fit: cover;">
                    <h4>${member.first_name} ${member.last_name}</h4>
                    <p class="text-muted">${member.org_name} (${member.member_code})</p>
                    <p class="badge bg-secondary">Grade ${member.grade_level} - ${member.section}</p>
                    <div class="mt-3">
                        <img src="${qrImage}" alt="QR Code" class="img-fluid border p-2 bg-white" style="max-width: 180px;">
                        <p class="small text-muted mt-2">Your Personal Attendance QR</p>
                    </div>
                    <div class="d-grid gap-2 mt-3">
                        <a href="/member/id" class="btn btn-outline-primary btn-sm"><i class="fa-solid fa-id-card me-2"></i>View Digital ID</a>
                        <a href="/member/change-password" class="btn btn-outline-secondary btn-sm"><i class="fa-solid fa-key me-2"></i>Change Password</a>
                    </div>
                </div>
            </div>
            <div class="col-md-8">
                <div class="card p-4">
                    <h4>Recent Attendance History</h4>
                    <table class="table table-striped mt-3">
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Time In</th>
                                <th>Time Out</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${attendances.length === 0 ? `<tr><td colspan="4" class="text-center text-muted">No attendance recorded yet.</td></tr>` : ''}
                            ${attendances.map(a => `
                                <tr>
                                    <td>${a.attendance_date}</td>
                                    <td>${a.time_in ? new Date(a.time_in).toLocaleTimeString() : '-'}</td>
                                    <td>${a.time_out ? new Date(a.time_out).toLocaleTimeString() : '-'}</td>
                                    <td><span class="badge bg-success">${a.status}</span></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `, req.session.user));
});

app.get('/member/change-password', requireAuth(['Member']), (req, res) => {
    res.send(renderLayout('Change Password', `
        <div class="row justify-content-center">
            <div class="col-md-6">
                <div class="card p-4">
                    <h3>Change Password Required</h3>
                    ${req.session.user.must_change_password ? `<div class="alert alert-warning">You are using a temporary password. Please secure your account by changing it now.</div>` : ''}
                    <form action="/api/member/change-password" method="POST">
                        <div class="mb-3">
                            <label class="form-label">Current Password / Temp Password</label>
                            <input type="password" name="current_password" class="form-control" required>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">New Password</label>
                            <input type="password" name="new_password" class="form-control" required>
                        </div>
                        <div class="mb-3">
                            <label class="form-label">Confirm New Password</label>
                            <input type="password" name="confirm_password" class="form-control" required>
                        </div>
                        <button type="submit" class="btn btn-primary w-100">Update Password</button>
                    </form>
                </div>
            </div>
        </div>
    `, req.session.user));
});

app.post('/api/member/change-password', requireAuth(['Member']), async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) return res.send(`<script>alert('New passwords do not match.'); window.history.back();</script>');`);

    const user = await db.get(isPostgres ? 'SELECT * FROM users WHERE id = $1' : 'SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.send(`<script>alert('Incorrect current password.'); window.history.back();</script>`);

    const newHash = await bcrypt.hash(new_password, 10);
    if (isPostgres) {
        await db.run('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [newHash, user.id]);
    } else {
        await db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [newHash, user.id]);
    }

    req.session.user.must_change_password = false;
    res.send(`<script>alert('Password updated successfully!'); window.location='/member';</script>`);
});

app.get('/member/id', requireAuth(['Member']), async (req, res) => {
    const member = await db.get(isPostgres 
        ? `SELECT m.*, o.name as org_name, o.code as org_code FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.user_id = $1`
        : `SELECT m.*, o.name as org_name, o.code as org_code FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.user_id = ?`,
        [req.session.user.id]);

    const qrImage = await QRCode.toDataURL(member.qr_token);

    res.send(renderLayout('Digital ID Card', `
        <div class="text-center mb-3 no-print">
            <button onclick="window.print()" class="btn btn-primary"><i class="fa-solid fa-print me-2"></i>Print ID Card</button>
            <a href="/member" class="btn btn-secondary ms-2">Back to Dashboard</a>
        </div>
        <div class="card id-card-print p-4 mx-auto" style="max-width: 420px; border: 3px solid #0d6efd; border-radius: 15px; background: #fff;">
            <div class="text-center border-bottom pb-3">
                <h5 class="text-uppercase fw-bold text-primary mb-0">${member.org_name}</h5>
                <small class="text-muted">Official School Organization ID</small>
            </div>
            <div class="text-center my-3">
                <img src="${member.photo || 'https://via.placeholder.com/120'}" class="rounded-circle img-thumbnail" style="width: 110px; height: 110px; object-fit: cover;">
                <h4 class="mt-2 mb-0 fw-bold">${member.first_name} ${member.middle_name ? member.middle_name[0] + '.' : ''} ${member.last_name}</h4>
                <p class="text-muted mb-1">${member.member_code}</p>
                <span class="badge bg-dark">Grade ${member.grade_level} - ${member.section}</span>
            </div>
            <div class="text-center bg-light p-3 rounded">
                <img src="${qrImage}" alt="QR Code" style="width: 150px; height: 150px;">
                <p class="small text-danger fw-bold mt-2 mb-0">IMPORTANT REMINDER: Keep your QR code secure. Do not share.</p>
            </div>
        </div>
    `, req.session.user));
});

// ==========================================
// SCANNER PORTAL ROUTES
// ==========================================
app.get('/scanner', requireAuth(['Scanner', 'Super Admin', 'Organization Admin']), (req, res) => {
    res.send(renderLayout('QR Code Scanner Console', `
        <div class="row justify-content-center">
            <div class="col-md-8 text-center">
                <div class="card p-4 shadow">
                    <h3><i class="fa-solid fa-camera me-2"></i>Attendance QR Scanner</h3>
                    <div id="mode-display" class="alert alert-info fw-bold fs-5 my-3">CURRENT MODE: TIME IN</div>
                    
                    <div class="mb-3">
                        <button class="btn btn-success me-2" onclick="setMode('TIME_IN')">Set Mode: TIME IN</button>
                        <button class="btn btn-warning" onclick="setMode('TIME_OUT')">Set Mode: TIME OUT</button>
                    </div>

                    <div id="reader" style="width: 100%; max-width: 500px; margin: 0 auto;" class="border rounded p-2"></div>
                    <div id="scan-result" class="mt-3"></div>
                </div>
            </div>
        </div>
        <script src="https://unpkg.com/html5-qrcode"></script>
        <script>
            let currentMode = 'TIME_IN';
            function setMode(mode) {
                currentMode = mode;
                document.getElementById('mode-display').innerText = 'CURRENT MODE: ' + mode.replace('_', ' ');
                document.getElementById('mode-display').className = mode === 'TIME_IN' ? 'alert alert-success fw-bold fs-5 my-3' : 'alert alert-warning fw-bold fs-5 my-3';
            }

            function playAudio(type) {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                if(type === 'success') {
                    osc.frequency.setValueAtTime(600, ctx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.15);
                } else {
                    osc.frequency.setValueAtTime(300, ctx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.2);
                }
                osc.start();
                osc.stop(ctx.currentTime + 0.2);
            }

            async function onScanSuccess(decodedText) {
                try {
                    const response = await fetch('/api/scan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ qr_token: decodedText, mode: currentMode })
                    });
                    const result = await response.json();
                    const resDiv = document.getElementById('scan-result');
                    if(result.success) {
                        playAudio('success');
                        resDiv.innerHTML = \`<div class="alert alert-success"><h4>\${result.message}</h4><p>\${result.member.first_name} \${result.member.last_name} (\${result.member.member_code})</p></div>\`;
                    } else {
                        playAudio('error');
                        resDiv.innerHTML = \`<div class="alert alert-danger"><h4>UNREGISTERED OR INVALID QR CODE</h4><p>\${result.message}</p></div>\`;
                    }
                } catch(e) {
                    console.error(e);
                }
            }

            const html5QrCode = new Html5Qrcode("reader");
            html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess).catch(err => {
                document.getElementById('reader').innerHTML = '<p class="text-danger">Camera error or permission denied.</p>';
            });
        </script>
    `, req.session.user));
});

app.post('/api/scan', async (req, res) => {
    const { qr_token, mode } = req.body;
    try {
        const memberQuery = isPostgres 
            ? `SELECT m.*, o.active as org_active FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.qr_token = $1`
            : `SELECT m.*, o.active as org_active FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.qr_token = ?`;
        const member = await db.get(memberQuery, [qr_token]);

        if (!member || !member.active || member.deleted_at || !member.org_active) {
            return res.json({ success: false, message: 'QR Code is invalid, inactive, or belongs to a deleted/inactive organization.' });
        }

        const today = new Date().toISOString().split('T')[0];
        const attQuery = isPostgres 
            ? `SELECT * FROM attendance WHERE member_id = $1 AND attendance_date = $2`
            : `SELECT * FROM attendance WHERE member_id = ? AND attendance_date = ?`;
        let attendance = await db.get(attQuery, [member.id, today]);

        if (mode === 'TIME_IN') {
            if (attendance && attendance.time_in) {
                return res.json({ success: true, message: 'Already Timed In Today!', member });
            }
            if (attendance) {
                const updateQuery = isPostgres 
                    ? `UPDATE attendance SET time_in = CURRENT_TIMESTAMP, scanner_user_id = $1 WHERE id = $2`
                    : `UPDATE attendance SET time_in = CURRENT_TIMESTAMP, scanner_user_id = ? WHERE id = ?`;
                await db.run(updateQuery, [req.session.user ? req.session.user.id : null, attendance.id]);
            } else {
                const insertQuery = isPostgres 
                    ? `INSERT INTO attendance (member_id, organization_id, attendance_date, time_in, scanner_user_id) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`
                    : `INSERT INTO attendance (member_id, organization_id, attendance_date, time_in, scanner_user_id) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)`;
                await db.run(insertQuery, [member.id, member.organization_id, today, req.session.user ? req.session.user.id : null]);
            }
            return res.json({ success: true, message: 'TIME IN SUCCESSFUL', member });
        } else {
            if (!attendance || !attendance.time_in) {
                return res.json({ success: false, message: 'Cannot Time Out without a valid Time In record today.' });
            }
            if (attendance.time_out) {
                return res.json({ success: true, message: 'Already Timed Out Today!', member });
            }
            const updateOutQuery = isPostgres 
                ? `UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = $1`
                : `UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = ?`;
            await db.run(updateOutQuery, [attendance.id]);
            return res.json({ success: true, message: 'TIME OUT SUCCESSFUL', member });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Database error during scan processing.' });
    }
});

// ==========================================
// ADMIN PORTAL & MANAGEMENT ROUTES
// ==========================================
app.get('/admin', requireAuth(['Super Admin', 'Organization Admin']), async (req, res) => {
    const orgCount = await db.get(`SELECT COUNT(*) as count FROM organizations`);
    const memCount = await db.get(`SELECT COUNT(*) as count FROM members WHERE active = 1 AND deleted_at IS NULL`);
    const presentToday = await db.get(`SELECT COUNT(*) as count FROM attendance WHERE attendance_date = CURRENT_DATE AND time_in IS NOT NULL`);
    const recentScans = await db.all(`SELECT a.*, m.first_name, m.last_name, m.member_code FROM attendance a JOIN members m ON a.member_id = m.id ORDER BY a.created_at DESC LIMIT 5`);

    res.send(renderLayout('Admin Dashboard', `
        <div class="row">
            <div class="col-md-4 mb-3">
                <div class="card bg-primary text-white p-3">
                    <h5>Total Organizations</h5>
                    <h3>${orgCount.count}</h3>
                </div>
            </div>
            <div class="col-md-4 mb-3">
                <div class="card bg-success text-white p-3">
                    <h5>Active Members</h5>
                    <h3>${memCount.count}</h3>
                </div>
            </div>
            <div class="col-md-4 mb-3">
                <div class="card bg-info text-white p-3">
                    <h5>Present Today</h5>
                    <h3>${presentToday.count}</h3>
                </div>
            </div>
        </div>
        <div class="row mt-4">
            <div class="col-md-12">
                <div class="card p-4">
                    <h4>Recent Attendance Activity</h4>
                    <table class="table table-striped mt-3">
                        <thead>
                            <tr>
                                <th>Member</th>
                                <th>ID Code</th>
                                <th>Time In</th>
                                <th>Time Out</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${recentScans.map(s => `
                                <tr>
                                    <td>${s.first_name} ${s.last_name}</td>
                                    <td>${s.member_code}</td>
                                    <td>${s.time_in ? new Date(s.time_in).toLocaleTimeString() : '-'}</td>
                                    <td>${s.time_out ? new Date(s.time_out).toLocaleTimeString() : '-'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `, req.session.user));
});

app.get('/admin/members', requireAuth(['Super Admin', 'Organization Admin']), async (req, res) => {
    const members = await db.all(`SELECT m.*, o.name as org_name FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.deleted_at IS NULL`);
    const orgs = await db.all(`SELECT * FROM organizations WHERE active = 1`);

    res.send(renderLayout('Member Management', `
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2>Member Management</h2>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addMemberModal"><i class="fa-solid fa-user-plus me-2"></i>Add Member</button>
        </div>
        <div class="card p-4">
            <table class="table table-striped align-middle">
                <thead>
                    <tr>
                        <th>ID Code</th>
                        <th>Name</th>
                        <th>Organization</th>
                        <th>Grade & Section</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${members.map(m => `
                        <tr>
                            <td>${m.member_code}</td>
                            <td>${m.first_name} ${m.last_name}</td>
                            <td>${m.org_name}</td>
                            <td>Grade ${m.grade_level} - ${m.section}</td>
                            <td>
                                <a href="/admin/members/${m.id}/id" class="btn btn-sm btn-info text-white"><i class="fa-solid fa-id-card"></i></a>
                                <form action="/api/members/${m.id}/delete" method="POST" class="d-inline" onsubmit="return confirm('Are you sure you want to delete this member and invalidate their QR code?');">
                                    <button type="submit" class="btn btn-sm btn-danger"><i class="fa-solid fa-trash"></i></button>
                                </form>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div class="modal fade" id="addMemberModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form action="/api/members" method="POST">
                        <div class="modal-header">
                            <h5 class="modal-title">Register New Member</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label">First Name</label>
                                <input type="text" name="first_name" class="form-control" required>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Middle Name</label>
                                <input type="text" name="middle_name" class="form-control">
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Last Name</label>
                                <input type="text" name="last_name" class="form-control" required>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Organization</label>
                                <select name="organization_id" class="form-select" required>
                                    ${orgs.map(o => `<option value="${o.id}">${o.name} (${o.code})</option>`).join('')}
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Grade Level</label>
                                <input type="text" name="grade_level" class="form-control" required>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Section</label>
                                <input type="text" name="section" class="form-control" required>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="submit" class="btn btn-primary">Save & Generate ID</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    `, req.session.user));
});

app.post('/api/members', requireAuth(['Super Admin', 'Organization Admin']), async (req, res) => {
    const { first_name, middle_name, last_name, organization_id, grade_level, section } = req.body;
    try {
        const org = await db.get(isPostgres ? 'SELECT * FROM organizations WHERE id = $1' : 'SELECT * FROM organizations WHERE id = ?', [organization_id]);
        const year = new Date().getFullYear();
        const countRes = await db.get(isPostgres ? 'SELECT COUNT(*) as count FROM members WHERE organization_id = $1' : 'SELECT COUNT(*) as count FROM members WHERE organization_id = ?', [organization_id]);
        const seq = (parseInt(countRes.count) + 1).toString().padStart(4, '0');
        const member_code = `${org.code}-${year}-${seq}`;
        const username = member_code.toLowerCase();
        const tempPassword = crypto.randomBytes(4).toString('hex');
        const password_hash = await bcrypt.hash(tempPassword, 10);
        const qr_token = crypto.randomBytes(32).toString('hex');

        let userInsert;
        if (isPostgres) {
            userInsert = await db.query('INSERT INTO users (role, username, password_hash, must_change_password) VALUES ($1, $2, $3, TRUE) RETURNING id', ['Member', username, password_hash]);
        } else {
            userInsert = await db.run('INSERT INTO users (role, username, password_hash, must_change_password) VALUES (?, ?, ?, 1)', ['Member', username, password_hash]);
        }
        const userId = isPostgres ? userInsert.rows[0].id : userInsert.lastID;

        if (isPostgres) {
            await db.run(`INSERT INTO members (user_id, organization_id, member_code, first_name, middle_name, last_name, grade_level, section, qr_token) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [userId, organization_id, member_code, first_name, middle_name, last_name, grade_level, section, qr_token]);
        } else {
            await db.run(`INSERT INTO members (user_id, organization_id, member_code, first_name, middle_name, last_name, grade_level, section, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, organization_id, member_code, first_name, middle_name, last_name, grade_level, section, qr_token]);
        }

        res.send(renderLayout('Member Created', `
            <div class="row justify-content-center">
                <div class="col-md-6">
                    <div class="card p-4 text-center">
                        <div class="alert alert-success">Member successfully registered!</div>
                        <h4>${first_name} ${last_name}</h4>
                        <p class="mb-1"><strong>Member ID:</strong> ${member_code}</p>
                        <p class="mb-1"><strong>Username:</strong> ${username}</p>
                        <p class="mb-3 text-danger"><strong>Temporary Password:</strong> ${tempPassword}</p>
                        <div class="alert alert-warning small">IMPORTANT REMINDER: This password is temporary. Please instruct the member to log in to the Member Portal and change their password immediately.</div>
                        <a href="/admin/members" class="btn btn-primary mt-3">Back to Members</a>
                    </div>
                </div>
            </div>
        `, req.session.user));
    } catch (err) {
        console.error(err);
        res.status(500).send('Error registering member: ' + err.message);
    }
});

app.post('/api/members/:id/delete', requireAuth(['Super Admin', 'Organization Admin']), async (req, res) => {
    const memberId = req.params.id;
    if (isPostgres) {
        await db.run('UPDATE members SET deleted_at = CURRENT_TIMESTAMP, active = FALSE, qr_token = $1 WHERE id = $2', ['INVALID_' + crypto.randomBytes(8).toString('hex'), memberId]);
    } else {
        await db.run('UPDATE members SET deleted_at = CURRENT_TIMESTAMP, active = 0, qr_token = ? WHERE id = ?', ['INVALID_' + crypto.randomBytes(8).toString('hex'), memberId]);
    }
    res.redirect('/admin/members');
});

app.get('/admin/organizations', requireAuth(['Super Admin']), async (req, res) => {
    const orgs = await db.all(`SELECT o.*, (SELECT COUNT(*) FROM members m WHERE m.organization_id = o.id AND m.deleted_at IS NULL) as member_count FROM organizations o`);
    res.send(renderLayout('Organizations Management', `
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2>Organization Management</h2>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addOrgModal"><i class="fa-solid fa-sitemap me-2"></i>Add Organization</button>
        </div>
        <div class="card p-4">
            <table class="table table-striped align-middle">
                <thead>
                    <tr>
                        <th>Code</th>
                        <th>Organization Name</th>
                        <th>Description</th>
                        <th>Members</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${orgs.map(o => `
                        <tr>
                            <td><strong>${o.code}</strong></td>
                            <td>${o.name}</td>
                            <td>${o.description || '-'}</td>
                            <td><span class="badge bg-secondary">${o.member_count}</span></td>
                            <td><span class="badge bg-${o.active ? 'success' : 'danger'}">${o.active ? 'Active' : 'Inactive'}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div class="modal fade" id="addOrgModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <form action="/api/organizations" method="POST">
                        <div class="modal-header">
                            <h5 class="modal-title">Create Organization</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="mb-3">
                                <label class="form-label">Organization Name</label>
                                <input type="text" name="name" class="form-control" required placeholder="e.g. Science Club">
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Organization Code Prefix</label>
                                <input type="text" name="code" class="form-control" required placeholder="e.g. SCI">
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Description</label>
                                <textarea name="description" class="form-control"></textarea>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="submit" class="btn btn-primary">Create Organization</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    `, req.session.user));
});

app.post('/api/organizations', requireAuth(['Super Admin']), async (req, res) => {
    const { name, code, description } = req.body;
    if (isPostgres) {
        await db.run('INSERT INTO organizations (name, code, description) VALUES ($1, $2, $3)', [name, code.toUpperCase(), description]);
    } else {
        await db.run('INSERT INTO organizations (name, code, description) VALUES (?, ?, ?)', [name, code.toUpperCase(), description]);
    }
    res.redirect('/admin/organizations');
});

app.get('/admin/attendance', requireAuth(['Super Admin', 'Organization Admin']), async (req, res) => {
    const logs = await db.all(`SELECT a.*, m.first_name, m.last_name, m.member_code, o.name as org_name FROM attendance a JOIN members m ON a.member_id = m.id JOIN organizations o ON a.organization_id = o.id ORDER BY a.created_at DESC LIMIT 50`);
    res.send(renderLayout('Attendance Logs', `
        <h2>Attendance Logs</h2>
        <div class="card p-4 mt-3">
            <table class="table table-striped align-middle">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Member Name</th>
                        <th>ID Code</th>
                        <th>Organization</th>
                        <th>Time In</th>
                        <th>Time Out</th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map(l => `
                        <tr>
                            <td>${l.attendance_date}</td>
                            <td>${l.first_name} ${l.last_name}</td>
                            <td>${l.member_code}</td>
                            <td>${l.org_name}</td>
                            <td>${l.time_in ? new Date(l.time_in).toLocaleTimeString() : '-'}</td>
                            <td>${l.time_out ? new Date(l.time_out).toLocaleTimeString() : '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `, req.session.user));
});

app.get('/admin/reports', requireAuth(['Super Admin', 'Organization Admin']), (req, res) => {
    res.send(renderLayout('Reports', `
        <h2>Attendance Reports & Analytics</h2>
        <div class="card p-4 mt-3">
            <p class="text-muted">Generate and print daily, weekly, or organization attendance reports.</p>
            <button onclick="window.print()" class="btn btn-secondary w-25"><i class="fa-solid fa-print me-2"></i>Print Report</button>
        </div>
    `, req.session.user));
});

app.get('/admin/accounts', requireAuth(['Super Admin']), async (req, res) => {
    const accounts = await db.all(`SELECT * FROM users WHERE role != 'Member'`);
    res.send(renderLayout('Admin & Scanner Accounts', `
        <h2>Admin & Scanner Accounts</h2>
        <div class="card p-4 mt-3">
            <table class="table table-striped">
                <thead>
                    <tr>
                        <th>Username</th>
                        <th>Role</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${accounts.map(a => `
                        <tr>
                            <td>${a.username}</td>
                            <td><span class="badge bg-primary">${a.role}</span></td>
                            <td><span class="badge bg-${a.active ? 'success' : 'danger'}">${a.active ? 'Active' : 'Inactive'}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `, req.session.user));
});

// Initialization & Server Startup
initDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[SERVER] School Organization QR Attendance System running on port ${PORT}`);
    });
}).catch(err => {
    console.error('[CRITICAL] Failed to initialize database:', err);
});
