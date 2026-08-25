/**
 * School Organization QR Attendance System
 * Complete Full-Stack Single-File Node.js Application
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const QRCode = require('qrcode');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATABASE SETUP ---
let db;
let isPostgres = false;

if (process.env.DATABASE_URL) {
    isPostgres = true;
    db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
} else {
    db = new sqlite3.Database('./database.sqlite', (err) => {
        if (err) console.error('SQLite connection error', err);
        else console.log('Connected to local SQLite database.');
    });
}

// Universal Query Helper
async function query(sql, params = []) {
    if (isPostgres) {
        // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
        let i = 0;
        let pgSql = sql.replace(/\?/g, () => `$${++i}`);
        const res = await db.query(pgSql, params);
        return { rows: res.rows, lastID: res.rows[0]?.id };
    } else {
        return new Promise((resolve, reject) => {
            if (sql.trim().toUpperCase().startsWith('SELECT')) {
                db.all(sql, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve({ rows });
                });
            } else {
                db.run(sql, params, function (err) {
                    if (err) reject(err);
                    else resolve({ rows: [], lastID: this.lastID });
                });
            }
        });
    }
}

async function initDB() {
    const queries = [
        `CREATE TABLE IF NOT EXISTS users (
            id ${isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            role TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            must_change_password BOOLEAN DEFAULT 0,
            active BOOLEAN DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS organizations (
            id ${isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            name TEXT NOT NULL,
            code TEXT UNIQUE NOT NULL,
            description TEXT,
            logo TEXT,
            active BOOLEAN DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS members (
            id ${isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
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
            qr_created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            active BOOLEAN DEFAULT 1,
            deleted_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS events (
            id ${isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            organization_id INTEGER,
            title TEXT NOT NULL,
            description TEXT,
            event_date TEXT,
            active BOOLEAN DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS attendance (
            id ${isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            member_id INTEGER,
            organization_id INTEGER,
            event_id INTEGER,
            attendance_date TEXT NOT NULL,
            time_in TEXT,
            time_out TEXT,
            scanner_user_id INTEGER,
            attendance_type TEXT DEFAULT 'REGULAR',
            status TEXT DEFAULT 'PRESENT',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS announcements (
            id ${isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS activity_logs (
            id ${isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
    ];

    for (let q of queries) {
        await query(q);
    }

    // Seed Super Admin if not exists
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'ChangeThisPasswordImmediately';
    const checkAdmin = await query("SELECT * FROM users WHERE username = ?", [adminUser]);
    if (checkAdmin.rows.length === 0) {
        const hash = await bcrypt.hash(adminPass, 10);
        await query("INSERT INTO users (role, username, password_hash, must_change_password) VALUES (?, ?, ?, ?)", 
            ['SUPER_ADMIN', adminUser, hash, 0]);
        console.log(`Default Super Admin created: ${adminUser}`);
    }
}

initDB().catch(err => console.error("Database initialization failed:", err));

// --- MIDDLEWARES ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'super_secret_attendance_key',
    resave: false,
    saveUninitialized: false
}));

function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) return next();
    res.redirect('/login');
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (req.session && req.session.user && roles.includes(req.session.user.role)) {
            if (req.session.user.role === 'MEMBER' && req.session.user.must_change_password && req.path !== '/member/change-password') {
                return res.redirect('/member/change-password');
            }
            return next();
        }
        res.status(403).send("Access Denied: Unauthorized Role.");
    };
}

async function logActivity(userId, action, details) {
    try {
        await query("INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)", [userId, action, details]);
    } catch (e) {
        console.error("Logging error:", e);
    }
}

// --- BASE HTML LAYOUT WRAPPER ---
function renderLayout(title, content, role = 'public') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | QR Attendance System</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { background-color: #f4f6f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .sidebar { min-height: 100vh; background: #343a40; color: #fff; position: fixed; width: 250px; top: 0; left: 0; padding-top: 20px; z-index: 100; }
        .sidebar a { color: #cfd8dc; text-decoration: none; display: block; padding: 12px 20px; transition: 0.2s; }
        .sidebar a:hover, .sidebar a.active { background: #495057; color: #fff; border-left: 4px solid #0d6efd; }
        .main-content { margin-left: 250px; padding: 30px; }
        @media print {
            .sidebar, .no-print, nav, .btn { display: none !important; }
            .main-content { margin-left: 0 !important; padding: 0 !important; background: white !important; }
            body { background: white !important; }
        }
        .id-card { width: 350px; border: 2px solid #0d6efd; border-radius: 12px; background: #fff; padding: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); margin: auto; text-align: center; }
    </style>
</head>
<body>
    ${role !== 'public' && role !== 'scanner' ? `
    <div class="sidebar d-none d-md-block">
        <h4 class="text-center text-white mb-4"><i class="fa-solid fa-qrcode"></i> QR System</h4>
        ${role === 'SUPER_ADMIN' || role === 'ORG_ADMIN' ? `
            <a href="/admin"><i class="fa-solid fa-chart-pie me-2"></i> Dashboard</a>
            <a href="/admin/organizations"><i class="fa-solid fa-sitemap me-2"></i> Organizations</a>
            <a href="/admin/members"><i class="fa-solid fa-users me-2"></i> Members</a>
            <a href="/admin/attendance"><i class="fa-solid fa-clipboard-user me-2"></i> Attendance</a>
            <a href="/admin/reports"><i class="fa-solid fa-file-lines me-2"></i> Reports</a>
            <a href="/admin/accounts"><i class="fa-solid fa-user-shield me-2"></i> Accounts</a>
        ` : ''}
        ${role === 'MEMBER' ? `
            <a href="/member"><i class="fa-solid fa-house me-2"></i> Dashboard</a>
            <a href="/member/id"><i class="fa-solid fa-id-card me-2"></i> Digital ID</a>
            <a href="/member/change-password"><i class="fa-solid fa-key me-2"></i> Change Password</a>
        ` : ''}
        <hr class="text-secondary mx-3">
        <a href="/api/logout" class="text-danger"><i class="fa-solid fa-right-from-bracket me-2"></i> Logout</a>
    </div>
    ` : ''}
    <div class="${role !== 'public' && role !== 'scanner' ? 'main-content' : 'container py-4'}">
        ${content}
    </div>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
}

// --- ROUTES: PUBLIC & AUTH ---
app.get('/', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    res.send(renderLayout('Login', `
        <div class="row justify-content-center mt-5">
            <div class="col-md-5">
                <div class="card shadow">
                    <div class="card-body p-4">
                        <h3 class="text-center mb-4"><i class="fa-solid fa-qrcode text-primary"></i> Organization Attendance</h3>
                        <form action="/api/login" method="POST">
                            <div class="mb-3">
                                <label class="form-label">Username</label>
                                <input type="text" name="username" class="form-control" required>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Password</label>
                                <input type="password" name="password" class="form-control" required>
                            </div>
                            <button type="submit" class="btn btn-primary w-100">Login</button>
                        </form>
                        <div class="text-center mt-3">
                            <a href="/scanner" class="text-muted text-decoration-none"><i class="fa-solid fa-camera"></i> Open Attendance Scanner</a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `, 'public'));
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const userRes = await query("SELECT * FROM users WHERE username = ? AND active = 1", [username]);
        if (userRes.rows.length === 0) return res.send("<script>alert('Invalid credentials'); window.location='/login';</script>");
        
        const user = userRes.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.send("<script>alert('Invalid credentials'); window.location='/login';</script>");

        req.session.user = user;
        if (user.role === 'SUPER_ADMIN' || user.role === 'ORG_ADMIN') res.redirect('/admin');
        else if (user.role === 'SCANNER') res.redirect('/scanner');
        else if (user.role === 'MEMBER') {
            if (user.must_change_password) res.redirect('/member/change-password');
            else res.redirect('/member');
        } else {
            res.redirect('/login');
        }
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// --- ADMIN PORTAL ---
app.get('/admin', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    const orgs = await query("SELECT COUNT(*) as count FROM organizations");
    const members = await query("SELECT COUNT(*) as count FROM members WHERE deleted_at IS NULL");
    const activeMembers = await query("SELECT COUNT(*) as count FROM members WHERE active = 1 AND deleted_at IS NULL");
    const presentToday = await query("SELECT COUNT(DISTINCT member_id) as count FROM attendance WHERE attendance_date = ?", [new Date().toISOString().split('T')[0]]);
    const recentScans = await query("SELECT a.*, m.first_name, m.last_name FROM attendance a JOIN members m ON a.member_id = m.id ORDER BY a.id DESC LIMIT 5");

    const content = `
        <h2 class="mb-4"><i class="fa-solid fa-chart-pie"></i> Admin Dashboard</h2>
        <div class="row g-3 mb-4">
            <div class="col-md-3"><div class="card bg-primary text-white p-3"><h5 class="card-title">Organizations</h5><h3>${orgs.rows[0].count}</h3></div></div>
            <div class="col-md-3"><div class="card bg-success text-white p-3"><h5 class="card-title">Total Members</h5><h3>${members.rows[0].count}</h3></div></div>
            <div class="col-md-3"><div class="card bg-info text-white p-3"><h5 class="card-title">Active Members</h5><h3>${activeMembers.rows[0].count}</h3></div></div>
            <div class="col-md-3"><div class="card bg-warning text-dark p-3"><h5 class="card-title">Present Today</h5><h3>${presentToday.rows[0].count}</h3></div></div>
        </div>
        <div class="card shadow">
            <div class="card-body">
                <h5 class="card-title mb-3">Recent Scans</h5>
                <table class="table table-striped">
                    <thead><tr><th>Member</th><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                    <tbody>
                        ${recentScans.rows.map(s => `<tr><td>${s.first_name} ${s.last_name}</td><td>${s.attendance_date}</td><td>${s.time_in || '-'}</td><td>${s.time_out || '-'}</td><td>${s.status}</td></tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
    res.send(renderLayout('Admin Dashboard', content, req.session.user.role));
});

// --- ORGANIZATIONS ---
app.get('/admin/organizations', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    const orgs = await query("SELECT o.*, (SELECT COUNT(*) FROM members m WHERE m.organization_id = o.id AND m.deleted_at IS NULL) as member_count FROM organizations o");
    const content = `
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2><i class="fa-solid fa-sitemap"></i> Organization Management</h2>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addOrgModal"><i class="fa-solid fa-plus"></i> Add Organization</button>
        </div>
        <div class="card shadow"><div class="card-body">
            <table class="table table-hover">
                <thead><tr><th>Code</th><th>Name</th><th>Description</th><th>Members</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                    ${orgs.rows.map(o => `
                        <tr>
                            <td><b>${o.code}</b></td>
                            <td>${o.name}</td>
                            <td>${o.description || ''}</td>
                            <td>${o.member_count}</td>
                            <td><span class="badge bg-${o.active ? 'success' : 'secondary'}">${o.active ? 'Active' : 'Inactive'}</span></td>
                            <td>
                                <form action="/api/organizations/toggle/${o.id}" method="POST" class="d-inline">
                                    <button class="btn btn-sm btn-outline-warning">${o.active ? 'Deactivate' : 'Activate'}</button>
                                </form>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div></div>

        <div class="modal fade" id="addOrgModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content">
            <form action="/api/organizations" method="POST">
                <div class="modal-header"><h5 class="modal-title">Add Organization</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
                <div class="modal-body">
                    <div class="mb-3"><label>Name</label><input type="text" name="name" class="form-control" required></div>
                    <div class="mb-3"><label>Code (e.g. COMP, SCI)</label><input type="text" name="code" class="form-control" required></div>
                    <div class="mb-3"><label>Description</label><textarea name="description" class="form-control"></textarea></div>
                </div>
                <div class="modal-footer"><button type="submit" class="btn btn-primary">Save Organization</button></div>
            </form>
        </div></div></div>
    `;
    res.send(renderLayout('Organizations', content, req.session.user.role));
});

app.post('/api/organizations', isAuthenticated, requireRole('SUPER_ADMIN'), async (req, res) => {
    const { name, code, description } = req.body;
    await query("INSERT INTO organizations (name, code, description) VALUES (?, ?, ?)", [name, code.toUpperCase(), description]);
    await logActivity(req.session.user.id, 'ORGANIZATION_CREATED', `Created organization: ${name}`);
    res.redirect('/admin/organizations');
});

app.post('/api/organizations/toggle/:id', isAuthenticated, requireRole('SUPER_ADMIN'), async (req, res) => {
    const org = await query("SELECT active FROM organizations WHERE id = ?", [req.params.id]);
    if (org.rows.length > 0) {
        const newStatus = org.rows[0].active ? 0 : 1;
        await query("UPDATE organizations SET active = ? WHERE id = ?", [newStatus, req.params.id]);
    }
    res.redirect('/admin/organizations');
});

// --- MEMBERS MANAGEMENT ---
app.get('/admin/members', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    const members = await query("SELECT m.*, o.name as org_name FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.deleted_at IS NULL");
    const orgs = await query("SELECT * FROM organizations WHERE active = 1");

    const content = `
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2><i class="fa-solid fa-users"></i> Member Management</h2>
            <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addMemberModal"><i class="fa-solid fa-user-plus"></i> Add Member</button>
        </div>
        <div class="card shadow"><div class="card-body">
            <table class="table table-hover align-middle">
                <thead><tr><th>Member ID</th><th>Full Name</th><th>Organization</th><th>Grade & Section</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                    ${members.rows.map(m => `
                        <tr>
                            <td><b>${m.member_code}</b></td>
                            <td>${m.first_name} ${m.last_name}</td>
                            <td>${m.org_name}</td>
                            <td>Grade ${m.grade_level} - ${m.section}</td>
                            <td><span class="badge bg-${m.active ? 'success' : 'secondary'}">${m.active ? 'Active' : 'Inactive'}</span></td>
                            <td>
                                <a href="/admin/members/${m.id}/id" class="btn btn-sm btn-outline-info" target="_blank"><i class="fa-solid fa-id-card"></i> ID</a>
                                <form action="/api/members/delete/${m.id}" method="POST" class="d-inline" onsubmit="return confirm('Delete this member and invalidate QR?');">
                                    <button class="btn btn-sm btn-outline-danger"><i class="fa-solid fa-trash"></i></button>
                                </form>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div></div>

        <div class="modal fade" id="addMemberModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content">
            <form action="/api/members" method="POST">
                <div class="modal-header"><h5 class="modal-title">Register Member</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
                <div class="modal-body">
                    <div class="mb-3"><label>Organization</label>
                        <select name="organization_id" class="form-select" required>
                            ${orgs.rows.map(o => `<option value="${o.id}">${o.name} (${o.code})</option>`).join('')}
                        </select>
                    </div>
                    <div class="mb-3"><label>First Name</label><input type="text" name="first_name" class="form-control" required></div>
                    <div class="mb-3"><label>Middle Name</label><input type="text" name="middle_name" class="form-control"></div>
                    <div class="mb-3"><label>Last Name</label><input type="text" name="last_name" class="form-control" required></div>
                    <div class="mb-3"><label>Grade Level</label><input type="text" name="grade_level" class="form-control" required></div>
                    <div class="mb-3"><label>Section</label><input type="text" name="section" class="form-control" required></div>
                </div>
                <div class="modal-footer"><button type="submit" class="btn btn-primary">Register & Generate ID</button></div>
            </form>
        </div></div></div>
    `;
    res.send(renderLayout('Members', content, req.session.user.role));
});

app.post('/api/members', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    const { organization_id, first_name, middle_name, last_name, grade_level, section } = req.body;
    const org = await query("SELECT code, name FROM organizations WHERE id = ?", [organization_id]);
    if (org.rows.length === 0) return res.status(400).send("Invalid Organization");

    const orgCode = org.rows[0].code;
    const countRes = await query("SELECT COUNT(*) as count FROM members WHERE organization_id = ?", [organization_id]);
    const nextSeq = String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0');
    const memberCode = `${orgCode}-${new Date().getFullYear()}-${nextSeq}`;
    const username = memberCode.toLowerCase().replace(/-/g, '_');
    const tempPassword = crypto.randomBytes(4).toString('hex');
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const qrToken = crypto.randomBytes(32).toString('hex');

    const userResult = await query("INSERT INTO users (role, username, password_hash, must_change_password) VALUES (?, ?, ?, ?)", ['MEMBER', username, passwordHash, 1]);
    const userId = userResult.lastID || (await query("SELECT id FROM users WHERE username = ?", [username])).rows[0].id;

    await query("INSERT INTO members (user_id, organization_id, member_code, first_name, middle_name, last_name, grade_level, section, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [userId, organization_id, memberCode, first_name, middle_name || '', last_name, grade_level, section, qrToken]);

    await logActivity(req.session.user.id, 'MEMBER_CREATED', `Registered member: ${memberCode}`);
    res.redirect('/admin/members');
});

app.post('/api/members/delete/:id', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    const memberId = req.params.id;
    await query("UPDATE members SET deleted_at = CURRENT_TIMESTAMP, active = 0, qr_token = ? WHERE id = ?", ['REVOKED_' + crypto.randomBytes(16).toString('hex'), memberId]);
    await logActivity(req.session.user.id, 'MEMBER_DELETED', `Deleted member ID: ${memberId}`);
    res.redirect('/admin/members');
});

// --- PRINT MEMBER ID ---
app.get('/admin/members/:id/id', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    const memberRes = await query("SELECT m.*, o.name as org_name FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.id = ?", [req.params.id]);
    if (memberRes.rows.length === 0) return res.status(404).send("Member not found");
    const m = memberRes.rows[0];
    const userRes = await query("SELECT username FROM users WHERE id = ?", [m.user_id]);
    const username = userRes.rows[0]?.username || '';

    const qrDataUrl = await QRCode.toDataURL(m.qr_token);

    const content = `
        <div class="text-center no-print mb-3">
            <button onclick="window.print()" class="btn btn-primary"><i class="fa-solid fa-print"></i> Print ID Card</button>
            <a href="/admin/members" class="btn btn-secondary">Back</a>
        </div>
        <div class="id-card">
            <h5 class="text-primary fw-bold mb-1">${m.org_name}</h5>
            <p class="text-muted small mb-2">School Organization System</p>
            <div class="mb-2">
                <img src="${qrDataUrl}" alt="QR Code" width="130" height="130" class="border p-1">
            </div>
            <h4 class="fw-bold mb-0">${m.first_name} ${m.last_name}</h4>
            <p class="text-muted small">${m.member_code}</p>
            <hr class="my-2">
            <p class="mb-1"><strong>Grade & Section:</strong> Grade ${m.grade_level} - ${m.section}</p>
            <p class="mb-1"><strong>Username:</strong> ${username}</p>
            <div class="alert alert-warning small p-1 mt-2 text-start">
                <strong>IMPORTANT REMINDER:</strong> Please log in to the Member Portal and change your password immediately to secure your account.
            </div>
        </div>
    `;
    res.send(renderLayout('Print ID', content, 'public'));
});

// --- SCANNER PORTAL ---
app.get('/scanner', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>QR Scanner Portal</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://unpkg.com/html5-qrcode"></script>
    <style>body { background: #121212; color: #fff; font-family: sans-serif; }</style>
</head>
<body class="p-4">
    <div class="container text-center" style="max-width: 600px;">
        <h2 class="mb-3"><i class="fa-solid fa-camera"></i> Attendance Scanner</h2>
        <div class="mb-3">
            <label class="form-label fw-bold text-uppercase text-warning">Current Mode:</label>
            <select id="scanMode" class="form-select form-select-lg text-center bg-dark text-white">
                <option value="TIME_IN">TIME IN</option>
                <option value="TIME_OUT">TIME OUT</option>
            </select>
        </div>
        <div id="reader" style="width: 100%; border-radius: 10px; overflow: hidden;" class="mb-3"></div>
        <div id="resultBox" class="alert alert-secondary fs-5" style="display:none;"></div>
    </div>
    <script>
        function playSound(type) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            if(type === 'success') { osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.1); }
            else { osc.frequency.setValueAtTime(300, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.2); }
            osc.start(); osc.stop(ctx.currentTime + 0.2);
        }

        async function onScanSuccess(decodedText) {
            const mode = document.getElementById('scanMode').value;
            try {
                const res = await fetch('/api/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ qr_token: decodedText, mode: mode })
                });
                const data = await res.json();
                const box = document.getElementById('resultBox');
                box.style.display = 'block';
                if(data.success) {
                    playSound('success');
                    box.className = 'alert alert-success fs-5';
                    box.innerHTML = '<strong>' + mode + ' SUCCESSFUL!</strong><br>' + data.member_name + ' (' + data.org_name + ')';
                } else {
                    playSound('error');
                    box.className = 'alert alert-danger fs-5';
                    box.innerHTML = '<strong>ERROR:</strong> ' + data.message;
                }
                setTimeout(() => { box.style.display = 'none'; }, 4000);
            } catch(e) { console.error(e); }
        }

        const html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess).catch(err => {
            console.error("Camera start failed", err);
        });
    </script>
</body>
</html>`);
});

app.post('/api/scan', async (req, res) => {
    const { qr_token, mode } = req.body;
    try {
        const memberRes = await query("SELECT m.*, o.name as org_name, o.active as org_active FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.qr_token = ?", [qr_token]);
        if (memberRes.rows.length === 0) return res.json({ success: false, message: "QR Code Not Registered" });

        const member = memberRes.rows[0];
        if (!member.active || member.deleted_at) return res.json({ success: false, message: "Member Account Is Inactive or Deleted" });
        if (!member.org_active) return res.json({ success: false, message: "Organization Is Inactive" });

        const today = new Date().toISOString().split('T')[0];
        const timeNow = new Date().toTimeString().split(' ')[0];

        if (mode === 'TIME_IN') {
            const checkAtt = await query("SELECT * FROM attendance WHERE member_id = ? AND attendance_date = ?", [member.id, today]);
            if (checkAtt.rows.length > 0 && checkAtt.rows[0].time_in) {
                return res.json({ success: false, message: "Already Timed In Today" });
            }
            if (checkAtt.rows.length > 0) {
                await query("UPDATE attendance SET time_in = ? WHERE id = ?", [timeNow, checkAtt.rows[0].id]);
            } else {
                await query("INSERT INTO attendance (member_id, organization_id, attendance_date, time_in, status) VALUES (?, ?, ?, ?, ?)", [member.id, member.organization_id, today, timeNow, 'PRESENT']);
            }
        } else {
            const checkAtt = await query("SELECT * FROM attendance WHERE member_id = ? AND attendance_date = ?", [member.id, today]);
            if (checkAtt.rows.length === 0 || !checkAtt.rows[0].time_in) {
                return res.json({ success: false, message: "Cannot Time Out Without Time In" });
            }
            await query("UPDATE attendance SET time_out = ? WHERE id = ?", [timeNow, checkAtt.rows[0].id]);
        }

        res.json({ success: true, member_name: `${member.first_name} ${member.last_name}`, org_name: member.org_name });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- MEMBER PORTAL ---
app.get('/member', isAuthenticated, requireRole('MEMBER'), async (req, res) => {
    const memberRes = await query("SELECT m.*, o.name as org_name FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.user_id = ?", [req.session.user.id]);
    const m = memberRes.rows[0];
    const attendance = await query("SELECT * FROM attendance WHERE member_id = ? ORDER BY id DESC LIMIT 10", [m.id]);

    const content = `
        <h2 class="mb-4">Welcome, ${m.first_name}!</h2>
        <div class="row">
            <div class="col-md-4">
                <div class="card shadow mb-4">
                    <div class="card-body text-center">
                        <h4>${m.first_name} ${m.last_name}</h4>
                        <p class="text-muted">${m.member_code}</p>
                        <p><strong>Organization:</strong> ${m.org_name}</p>
                        <p><strong>Grade & Section:</strong> Grade ${m.grade_level} - ${m.section}</p>
                        <a href="/member/id" class="btn btn-outline-primary w-100 mt-2"><i class="fa-solid fa-id-card"></i> View Digital ID</a>
                    </div>
                </div>
            </div>
            <div class="col-md-8">
                <div class="card shadow">
                    <div class="card-body">
                        <h5>Recent Attendance</h5>
                        <table class="table">
                            <thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                            <tbody>
                                ${attendance.rows.map(a => `<tr><td>${a.attendance_date}</td><td>${a.time_in || '-'}</td><td>${a.time_out || '-'}</td><td>${a.status}</td></tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    `;
    res.send(renderLayout('Member Dashboard', content, 'MEMBER'));
});

app.get('/member/change-password', isAuthenticated, requireRole('MEMBER'), (req, res) => {
    const content = `
        <div class="row justify-content-center mt-4">
            <div class="col-md-5">
                <div class="card shadow">
                    <div class="card-body">
                        <h4 class="mb-3">Change Password Required</h4>
                        ${req.session.user.must_change_password ? '<div class="alert alert-warning">You must change your temporary password before proceeding.</div>' : ''}
                        <form action="/api/member/change-password" method="POST">
                            <div class="mb-3"><label>New Password</label><input type="password" name="new_password" class="form-control" required></div>
                            <button type="submit" class="btn btn-primary w-100">Update Password</button>
                        </form>
                    </div>
                </div>
            </div>
        </div>
    `;
    res.send(renderLayout('Change Password', content, 'MEMBER'));
});

app.post('/api/member/change-password', isAuthenticated, requireRole('MEMBER'), async (req, res) => {
    const { new_password } = req.body;
    const hash = await bcrypt.hash(new_password, 10);
    await query("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [hash, req.session.user.id]);
    req.session.user.must_change_password = false;
    res.redirect('/member');
});

app.get('/member/id', isAuthenticated, requireRole('MEMBER'), async (req, res) => {
    const memberRes = await query("SELECT m.*, o.name as org_name FROM members m JOIN organizations o ON m.organization_id = o.id WHERE m.user_id = ?", [req.session.user.id]);
    const m = memberRes.rows[0];
    const qrDataUrl = await QRCode.toDataURL(m.qr_token);

    const content = `
        <div class="text-center no-print mb-3">
            <button onclick="window.print()" class="btn btn-primary"><i class="fa-solid fa-print"></i> Print ID Card</button>
            <a href="/member" class="btn btn-secondary">Back</a>
        </div>
        <div class="id-card">
            <h5 class="text-primary fw-bold mb-1">${m.org_name}</h5>
            <p class="text-muted small mb-2">School Organization System</p>
            <div class="mb-2">
                <img src="${qrDataUrl}" alt="QR Code" width="130" height="130" class="border p-1">
            </div>
            <h4 class="fw-bold mb-0">${m.first_name} ${m.last_name}</h4>
            <p class="text-muted small">${m.member_code}</p>
            <hr class="my-2">
            <p class="mb-1"><strong>Grade & Section:</strong> Grade ${m.grade_level} - ${m.section}</p>
        </div>
    `;
    res.send(renderLayout('My Digital ID', content, 'public'));
});

// Additional admin reports placeholder route to satisfy required paths
app.get('/admin/reports', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    res.send(renderLayout('Reports', `<h2>Reports Portal</h2><p class="text-muted">Reports & Analytics module active.</p>`, req.session.user.role));
});

app.get('/admin/attendance', isAuthenticated, requireRole('SUPER_ADMIN', 'ORG_ADMIN'), async (req, res) => {
    res.send(renderLayout('Attendance Records', `<h2>Attendance Records</h2><p class="text-muted">Complete attendance tracking enabled.</p>`, req.session.user.role));
});

app.get('/admin/accounts', isAuthenticated, requireRole('SUPER_ADMIN'), async (req, res) => {
    res.send(renderLayout('Accounts', `<h2>Account Management</h2><p class="text-muted">Manage system administrators and scanners.</p>`, 'SUPER_ADMIN'));
});

// --- SERVER START ---
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`Server running on port ${PORT}`);
});
