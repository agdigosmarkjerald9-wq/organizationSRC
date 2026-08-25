const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

const dbFile = path.join(dataDir, 'attendance.db');
const db = new sqlite3.Database(dbFile);

// Initialize Database Tables & Default Config
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT UNIQUE,
        name TEXT NOT NULL,
        position TEXT NOT NULL,
        email TEXT,
        contact TEXT,
        username TEXT UNIQUE,
        password TEXT NOT NULL,
        temporary_password TEXT,
        must_change_password INTEGER DEFAULT 1,
        qr_token TEXT UNIQUE,
        status TEXT DEFAULT 'ACTIVE',
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
        club_name TEXT,
        school_name TEXT,
        school_year TEXT,
        adviser TEXT,
        logo TEXT,
        expected_in TEXT DEFAULT '08:00',
        expected_out TEXT DEFAULT '17:00',
        late_after TEXT DEFAULT '08:15'
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

    // Insert default club info if empty
    db.get(`SELECT COUNT(*) as count FROM clubs`, (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO clubs (club_name, school_name, school_year, adviser, expected_in, expected_out, late_after) 
                    VALUES ('Supreme Student Council', 'San Jose National High School', '2025-2026', 'Dr. Maria Santos', '08:00', '17:00', '08:15')`);
        }
    });

    // Insert default admin user if not exists (username: admin, password: Admin@123)
    db.get(`SELECT COUNT(*) as count FROM users WHERE position = 'Administrator'`, async (err, row) => {
        if (row && row.count === 0) {
            const hashed = await bcrypt.hash('Admin@123', 10);
            db.run(`INSERT INTO users (member_id, name, position, username, password, temporary_password, must_change_password, qr_token, status) 
                    VALUES ('ADMIN-001', 'System Administrator', 'Administrator', 'admin', ?, 'Admin@123', 1, 'ADMIN_TOKEN_SECURE', 'ACTIVE')`, [hashed]);
        }
    });
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'club-attendance-secret-key-99',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Helper: Log activity
function logActivity(username, action) {
    db.run(`INSERT INTO activity_logs (username, action) VALUES (?, ?)`, [username || 'System', action]);
}

// ==========================================================
// FRONTEND VIEWS & TEMPLATES (Embedded HTML/CSS/JS)
// ==========================================================

const commonStyles = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
        body { background: #f8fafc; color: #1e293b; min-height: 100vh; display: flex; flex-direction: column; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; width: 100%; }
        .card { background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); padding: 24px; margin-bottom: 20px; }
        .btn { background: #4f46e5; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: background 0.2s; text-decoration: none; display: inline-block; text-align: center; }
        .btn:hover { background: #4338ca; }
        .btn-danger { background: #ef4444; }
        .btn-danger:hover { background: #dc2626; }
        .btn-success { background: #10b981; }
        .btn-success:hover { background: #059669; }
        input, select, textarea { width: 100%; padding: 10px 14px; border: 1px solid #cbd5e1; border-radius: 8px; margin-top: 6px; margin-bottom: 16px; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
        th { background: #f1f5f9; font-weight: 600; color: #475569; }
        .badge { padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; }
        .badge-active { background: #d1fae5; color: #065f46; }
        .badge-disabled { background: #fee2e2; color: #991b1b; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; }
        .flex { display: flex; align-items: center; justify-content: space-between; }
        .alert { padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
        .alert-error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
        .alert-success { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
    </style>
`;

// 1. Landing Page
app.get('/', (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>${club ? club.club_name : 'School Club'} Attendance System</title>
                ${commonStyles}
                <style>
                    .hero { text-align: center; padding: 60px 20px; }
                    .portal-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; margin-top: 40px; }
                    .portal-card { background: white; padding: 30px; border-radius: 16px; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1); transition: transform 0.2s; text-align: center; }
                    .portal-card:hover { transform: translateY(-5px); }
                    .portal-card h3 { margin-bottom: 12px; color: #1e293b; font-size: 20px; }
                    .portal-card p { color: #64748b; margin-bottom: 20px; font-size: 14px; }
                </style>
            </head>
            <body>
                <div class="container hero">
                    <h1 style="font-size: 36px; color: #0f172a; margin-bottom: 10px;">${club ? club.club_name : 'School Club System'}</h1>
                    <p style="color: #64748b; font-size: 18px;">${club ? club.school_name : ''} (${club ? club.school_year : ''})</p>
                    
                    <div class="portal-cards">
                        <div class="portal-card">
                            <h3>Admin Portal</h3>
                            <p>Manage members, view reports, configure settings, and monitor attendance.</p>
                            <a href="/admin" class="btn" style="width:100%;">Open Admin Portal</a>
                        </div>
                        <div class="portal-card">
                            <h3>QR Scanner Portal</h3>
                            <p>Use your phone camera for real-time Time In / Time Out scanning.</p>
                            <a href="/scanner" class="btn btn-success" style="width:100%;">Open Scanner Portal</a>
                        </div>
                        <div class="portal-card">
                            <h3>Member Portal</h3>
                            <p>Log in to view your attendance history, profile, and QR code.</p>
                            <a href="/member" class="btn" style="background:#0ea5e9; width:100%;">Open Member Portal</a>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);
    });
});

// ==========================================================
// ADMIN PORTAL
// ==========================================================

app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login - School Club System</title>
            ${commonStyles}
            <style>body { display: flex; align-items: center; justify-content: center; background: #f1f5f9; }</style>
        </head>
        <body>
            <div class="card" style="width: 100%; max-width: 400px;">
                <h2 style="margin-bottom: 20px; text-align: center;">Admin Login</h2>
                ${req.query.error ? `<div class="alert alert-error">Invalid username or password</div>` : ''}
                <form action="/admin/login" method="POST">
                    <label>Username</label>
                    <input type="text" name="username" required autocomplete="off">
                    <label>Password</label>
                    <input type="password" name="password" required>
                    <button type="submit" class="btn" style="width:100%; margin-top: 10px;">Login</button>
                </form>
                <div style="text-align: center; margin-top: 15px;"><a href="/" style="color: #64748b; font-size: 13px; text-decoration: none;">← Back to Home</a></div>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND position = 'Administrator'`, async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.admin = user;
            logActivity(user.username, 'Admin logged in');
            if (user.must_change_password === 1) {
                return res.redirect('/admin/change-password');
            }
            res.redirect('/admin/dashboard');
        } else {
            res.redirect('/admin/login?error=1');
        }
    });
});

app.get('/admin/logout', (req, res) => {
    if (req.session.admin) logActivity(req.session.admin.username, 'Admin logged out');
    req.session.admin = null;
    res.redirect('/admin/login');
});

// Admin Password Change (Forced on first login)
app.get('/admin/change-password', (req, res) => {
    if (!req.session.admin) return res.redirect('/admin/login');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Change Default Password</title>
            ${commonStyles}
            <style>body { display: flex; align-items: center; justify-content: center; background: #f1f5f9; }</style>
        </head>
        <body>
            <div class="card" style="width: 100%
, max-width: 400px;">
                <h2>Change Admin Password</h2>
                <p style="font-size: 13px; color: #ef4444; margin-bottom: 15px;">You must change your default password before continuing.</p>
                ${req.query.error ? `<div class="alert alert-error">${req.query.error}</div>` : ''}
                <form action="/admin/change-password" method="POST">
                    <label>New Password</label>
                    <input type="password" name="new_password" required minlength="6">
                    <label>Confirm New Password</label>
                    <input type="password" name="confirm_password" required minlength="6">
                    <button type="submit" class="btn" style="width:100%;">Update Password</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/change-password', async (req, res) => {
    if (!req.session.admin) return res.redirect('/admin/login');
    const { new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) {
        return res.redirect('/admin/change-password?error=Passwords do not match');
    }
    const hashed = await bcrypt.hash(new_password, 10);
    db.run(`UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?`, [hashed, req.session.admin.id], (err) => {
        if (err) return res.redirect('/admin/change-password?error=Database error');
        logActivity(req.session.admin.username, 'Admin changed password');
        req.session.admin.must_change_password = 0;
        res.redirect('/admin/dashboard');
    });
});

// Admin Middleware protection
function requireAdmin(req, res, next) {
    if (!req.session.admin) return res.redirect('/admin/login');
    if (req.session.admin.must_change_password === 1) return res.redirect('/admin/change-password');
    next();
}

// Admin Dashboard
app.get('/admin/dashboard', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
        db.get(`SELECT COUNT(*) as total FROM users WHERE position != 'Administrator'`, (err, mCount) => {
            const today = new Date().toISOString().split('T')[0];
            db.get(`SELECT COUNT(DISTINCT member_id) as present FROM attendance WHERE date = ? AND scan_type = 'TIME_IN'`, [today], (err, pCount) => {
                db.get(`SELECT COUNT(DISTINCT member_id) as timedout FROM attendance WHERE date = ? AND scan_type = 'TIME_OUT'`, [today], (err, tCount) => {
                    db.all(`SELECT * FROM attendance WHERE date = ? ORDER BY timestamp DESC LIMIT 10`, [today], (err, recent) => {
                        db.all(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5`, (err, announcements) => {
                            res.send(`
                                <!DOCTYPE html>
                                <html>
                                <head>
                                    <title>Admin Dashboard - ${club ? club.club_name : ''}</title>
                                    ${commonStyles}
                                </head>
                                <body>
                                    <div class="flex" style="background: #1e293b; color: white; padding: 15px 30px;">
                                        <h2>${club ? club.club_name : 'Club'} Admin Portal</h2>
                                        <div>
                                            <a href="/admin/dashboard" style="color:white; margin-right:15px; text-decoration:none;">Dashboard</a>
                                            <a href="/admin/members" style="color:white; margin-right:15px; text-decoration:none;">Members</a>
                                            <a href="/admin/attendance" style="color:white; margin-right:15px; text-decoration:none;">Attendance</a>
                                            <a href="/admin/reports" style="color:white; margin-right:15px; text-decoration:none;">Reports</a>
                                            <a href="/admin/settings" style="color:white; margin-right:15px; text-decoration:none;">Settings</a>
                                            <a href="/admin/logout" class="btn btn-danger" style="padding: 6px 12px; font-size:13px;">Logout</a>
                                        </div>
                                    </div>
                                    <div class="container" style="margin-top: 20px;">
                                        <div class="grid">
                                            <div class="card" style="border-left: 5px solid #4f46e5;">
                                                <h3>Total Members</h3>
                                                <p style="font-size: 28px; font-weight:700; margin-top:10px;">${mCount.total}</p>
                                            </div>
                                            <div class="card" style="border-left: 5px solid #10b981;">
                                                <h3>Present Today (Time In)</h3>
                                                <p style="font-size: 28px; font-weight:700; margin-top:10px;">${pCount.present}</p>
                                            </div>
                                            <div class="card" style="border-left: 5px solid #0ea5e9;">
                                                <h3>Timed Out Today</h3>
                                                <p style="font-size: 28px; font-weight:700; margin-top:10px;">${tCount.timedout}</p>
                                            </div>
                                            <div class="card" style="border-left: 5px solid #f59e0b;">
                                                <h3>Absent Today</h3>
                                                <p style="font-size: 28px; font-weight:700; margin-top:10px;">${mCount.total - pCount.present}</p>
                                            </div>
                                        </div>

                                        <div class="card">
                                            <div class="flex">
                                                <h3>Live Attendance Feed (Today)</h3>
                                                <span class="badge badge-active" id="live-status">Auto-updating</span>
                                            </div>
                                            <table>
                                                <thead>
                                                    <tr><th>Member ID</th><th>Scan Type</th><th>Time</th><th>Scanner Device</th></tr>
                                                </thead>
                                                <tbody id="live-feed">
                                                    ${recent.map(r => `<tr><td>${r.member_id}</td><td><span class="badge ${r.scan_type === 'TIME_IN' ? 'badge-active' : 'badge-disabled'}">${r.scan_type}</span></td><td>${r.time}</td><td>${r.scanner_device || 'Main Scanner'}</td></tr>`).join('')}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                    <script>
                                        setInterval(() => {
                                            fetch('/admin/api/live-feed')
                                                .then(res => res.json())
                                                .then(data => {
                                                    const tbody = document.getElementById('live-feed');
                                                    tbody.innerHTML = data.map(r => '<tr><td>' + r.member_id + '</td><td><span class="badge ' + (r.scan_type === 'TIME_IN' ? 'badge-active' : 'badge-disabled') + '">' + r.scan_type + '</span></td><td>' + r.time + '</td><td>' + (r.scanner_device || 'Scanner') + '</td></tr>').join('');
                                                });
                                        }, 3000);
                                    </script>
                                </body>
                                </html>
                            `);
                        });
                    });
                });
            });
        });
    });
});

app.get('/admin/api/live-feed', requireAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.all(`SELECT * FROM attendance WHERE date = ? ORDER BY timestamp DESC LIMIT 10`, [today], (err, rows) => {
        res.json(rows || []);
    });
});

// Members Management
app.get('/admin/members', requireAdmin, (req, res) => {
    const search = req.query.search || '';
    const query = `SELECT * FROM users WHERE position != 'Administrator' AND (name LIKE ? OR member_id LIKE ? OR position LIKE ?) ORDER BY created_at DESC`;
    db.all(query, [`%${search}%`, `%${search}%`, `%${search}%`], (err, members) => {
        db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Manage Members - Admin Portal</title>
                    ${commonStyles}
                </head>
                <body>
                    <div class="flex" style="background: #1e293b; color: white; padding: 15px 30px;">
                        <h2>Member Management</h2>
                        <div>
                            <a href="/admin/dashboard" style="color:white; margin-right:15px; text-decoration:none;">Dashboard</a>
                            <a href="/admin/members" style="color:white; margin-right:15px; text-decoration:none;">Members</a>
                            <a href="/admin/attendance" style="color:white; margin-right:15px; text-decoration:none;">Attendance</a>
                            <a href="/admin/reports" style="color:white; margin-right:15px; text-decoration:none;">Reports</a>
                            <a href="/admin/settings" style="color:white; margin-right:15px; text-decoration:none;">Settings</a>
                            <a href="/admin/logout" class="btn btn-danger" style="padding: 6px 12px; font-size:13px;">Logout</a>
                        </div>
                    </div>
                    <div class="container" style="margin-top: 20px;">
                        <div class="card flex" style="flex-wrap: wrap; gap: 15px;">
                            <form action="/admin/members" method="GET" style="display:flex; gap:10px; flex:1; margin:0;">
                                <input type="text" name="search" placeholder="Search by name, ID, position..." value="${search}" style="margin:0;">
                                <button type="submit" class="btn">Search</button>
                            </form>
                            <div>
                                <a href="/admin/members/add" class="btn btn-success">+ Add Member</a>
                                <a href="/admin/members/generate-all-ids" class="btn" style="background:#0ea5e9;">Generate All IDs</a>
                            </div>
                        </div>

                        <div class="card">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Member ID</th><th>Name</th><th>Position</th><th>Username</th><th>Status</th><th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${members.map(m => `
                                        <tr>
                                            <td>${m.member_id}</td>
                                            <td>${m.name}</td>
                                            <td>${m.position}</td>
                                            <td>${m.username}</td>
                                            <td><span class="badge ${m.status === 'ACTIVE' ? 'badge-active' : 'badge-disabled'}">${m.status}</span></td>
                                            <td>
                                                <a href="/admin/members/id-card/${m.id}" class="btn" style="padding:4px 8px; font-size:12px;">ID Card</a>
                                                <a href="/admin/members/edit/${m.id}" class="btn" style="padding:4px 8px; font-size:12px; background:#f59e0b;">Edit</a>
                                                <a href="/admin/members/toggle/${m.id}" class="btn ${m.status === 'ACTIVE' ? 'btn-danger' : 'btn-success'}" style="padding:4px 8px; font-size:12px;">${m.status === 'ACTIVE' ? 'Disable' : 'Enable'}</a>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </body>
                </html>
            `);
        });
    });
});

// Add Member Form
app.get('/admin/members/add', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Add Member</title>${commonStyles}</head>
            <body>
                <div class="container" style="max-width: 600px; margin-top: 40px;">
                    <div class="card">
                        <h2>Add New Club Member</h2>
                        <form action="/admin/members/add" method="POST">
                            <label>Full Name *</label>
                            <input type="text" name="name" required>
                            
                            <label>Position *</label>
                            <select name="position" required>
                                <option value="President">President</option>
                                <option value="Vice President">Vice President</option>
                                <option value="Secretary">Secretary</option>
                                <option value="Treasurer">Treasurer</option>
                                <option value="Auditor">Auditor</option>
                                <option value="Public Information Officer">Public Information Officer</option>
                                <option value="Sergeant-at-Arms">Sergeant-at-Arms</option>
                                <option value="Member" selected>Member</option>
                                <option value="Adviser">Adviser</option>
                                <option value="Other">Other</option>
                            </select>

                            <label>Email (Optional)</label>
                            <input type="email" name="email">

                            <label>Contact Number (Optional)</label>
                            <input type="text" name="contact">

                            <button type="submit" class="btn btn-success" style="width:100%; margin-top:10px;">Create Member</button>
                        </form>
                        <a href="/admin/members" style="display:block; text-align:center; margin-top:15px; color:#64748b; text-decoration:none;">← Back to Members</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    });
});

// Process Add Member & Auto-generate ID, Username, Temp Password, QR Token
app.post('/admin/members/add', requireAdmin, async (req, res) => {
    const { name, position, email, contact } = req.body;
    db.get(`SELECT * FROM clubs LIMIT 1`, async (err, club) => {
        const year = club ? club.school_year.split('-')[0] : '2026';
        
        // Generate Unique Member ID e.g. CLUB-2026-0001
        db.get(`SELECT COUNT(*) as count FROM users`, async (err, row) => {
            const seq = String(row.count + 1).padStart(4, '0');
            const member_id = `CLUB-${year}-${seq}`;
            const username = `member${seq}`;
            
            // Random temporary password e.g. K7mP9xQ2
            const temp_pass = Math.random().toString(36.substring(2, 10)).slice(-8);
            const hashed = await bcrypt.hash(temp_pass, 10);
            
            const qr_token = `CLUBATTENDANCE:MEMBER:${uuidv4()}`;

            db.run(`INSERT INTO users (member_id, name, position, email, contact, username, password, temporary_password, must_change_password, qr_token, status) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'ACTIVE')`,
                [member_id, name, position, email, contact, username, hashed, temp_pass, qr_token], (err) => {
                    if (err) return res.send(`Error: ${err.message}`);
                    logActivity(req.session.admin.username, `Created member ${member_id} - ${name}`);
                    res.redirect(`/admin/members/id-card-success?member_id=${member_id}&temp_pass=${temp_pass}&username=${username}`);
                });
        });
    });
});

// Success Modal / Screen showing credentials after member creation
app.get('/admin/members/id-card-success', requireAdmin, (req, res) => {
    const { member_id, temp_pass, username } = req.query;
    db.get(`SELECT * FROM users WHERE member_id = ?`, [member_id], (err, member) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Member Created</title>${commonStyles}</head>
            <body>
                <div class="container" style="max-width: 600px; margin-top: 40px;">
                    <div class="card" style="text-align:center;">
                        <h2 style="color: #10b981;">✓ Member Successfully Created!</h2>
                        <p style="margin: 15px 0; color: #475569;">Generated credentials and ID for <b>${member.name}</b></p>
                        
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; text-align:left; margin-bottom:20px;">
                            <p><b>Member ID:</b> ${member.member_id}</p>
                            <p><b>Username:</b> ${username}</p>
                            <p><b>Temporary Password:</b> <span style="background:#fee2e2; padding:2px 6px; border-radius:4px; font-family:monospace;">${temp_pass}</span></p>
                            <p style="font-size: 12px; color: #ef4444; margin-top:8px;">IMPORTANT: This password is temporary. Please change password after first login.</p>
                        </div>

                        <div style="display: flex; gap: 10px; justify-content: center;">
                            <a href="/admin/members/id-card/${member.id}" class="btn">View & Print ID Card</a>
                            <a href="/admin/members" class="btn" style="background:#64748b;">Back to Members</a>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);
    });
});

// Printable ID Card
app.get('/admin/members/id-card/:id', requireAdmin, (req, res) => {
    const id = req.params.id;
    db.get(`SELECT * FROM users WHERE id = ?`, [id], async (err, member) => {
        if (!member) return res.send('Member not found');
        db.get(`SELECT * FROM clubs LIMIT 1`, async (err, club) => {
            const qrDataUrl = await QRCode.toDataURL(member.qr_token);
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>ID Card - ${member.name}</title>
                    ${commonStyles}
                    <style>
                        .id-card { width: 340px; height: 212px; border: 2px solid #cbd5e1; border-radius: 12px; background: white; padding: 15px; position: relative; margin: 30px auto; box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; }
                        .id-header { text-align: center; border-bottom: 2px solid #4f46e5; padding-bottom: 5px; }
                        .id-header h4 { font-size: 11px; color: #475569; text-transform: uppercase; }
                        .id-header h3 { font-size: 13px; color: #4f46e5; font-weight: 700; }
                        .id-body { display: flex; align-items: center; gap: 15px; margin-top: 8px; }
                        .id-qr img { width: 90px; height: 90px; }
                        .id-info h2 { font-size: 15px; color: #1e293b; margin-bottom: 2px; }
                        .id-info p { font-size: 11px; color: #64748b; margin-bottom: 2px; }
                        .id-footer { font-size: 8px; text-align: center; color: #ef4444; border-top: 1px solid #e2e8f0; padding-top: 4px; }
                        @media print { body { background: white; } .no-print { display: none; } }
                    </style>
                </head>
                <body>
                    <div class="no-print container" style="text-align: center; margin-top: 20px;">
                        <button onclick="window.print()" class="btn">Print ID Card</button>
                        <a href="/admin/members" class="btn" style="background:#64748b;">Back</a>
                    </div>

                    <div class="id-card">
                        <div class="id-header">
                            <h4>${club ? club.school_name : 'School Name'}</h4>
                            <h3>${club ? club.club_name : 'School Club'}</h3>
                        </div>
                        <div class="id-body">
                            <div class="id-qr">
                                <img src="${qrDataUrl}" alt="QR">
                            </div>
                            <div class="id-info">
                                <h2>${member.name}</h2>
                                <p><b>Position:</b> ${member.position}</p>
                                <p><b>ID:</b> ${member.member_id}</p>
                                <p><b>User:</b> ${member.username}</p>
                                <p><b>Temp Pass:</b> ${member.temporary_password || '******'}</p>
                            </div>
                        </div>
                        <div class="id-footer">
                            IMPORTANT: Change temporary password after first login.
                        </div>
                    </div>
                </body>
                </html>
            `);
        });
    });
});

// Toggle member status (Enable/Disable)
app.get('/admin/members/toggle/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, member) => {
        if (member) {
            const newStatus = member.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
            db.run(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, member.id], () => {
                logActivity(req.session.admin.username, `Toggled member ${member.member_id} status to ${newStatus}`);
                res.redirect('/admin/members');
            });
        } else {
            res.redirect('/admin/members');
        }
    });
});

// Generate All IDs Page
app.get('/admin/members/generate-all-ids', requireAdmin, (req, res) => {
    db.all(`SELECT * FROM users WHERE position != 'Administrator'`, async (err, members) => {
        db.get(`SELECT * FROM clubs LIMIT 1`, async (err, club) => {
            let cardsHtml = '';
            for (const member of members) {
                const qrDataUrl = await QRCode.toDataURL(member.qr_token);
                cardsHtml += `
                    <div class="id-card">
                        <div class="id-header">
                            <h4>${club ? club.school_name : 'School'}</h4>
                            <h3>${club ? club.club_name : 'Club'}</h3>
                        </div>
                        <div class="id-body">
                            <div class="id-qr"><img src="${qrDataUrl}" width="85" height="85"></div>
                            <div class="id-info">
                                <h2>${member.name}</h2>
                                <p><b>Position:</b> ${member.position}</p>
                                <p><b>ID:</b> ${member.member_id}</p>
                                <p><b>User:</b> ${member.username}</p>
                                <p><b>Temp Pass:</b> ${member.temporary_password || '******'}</p>
                            </div>
                        </div>
                        <div class="id-footer">Change temporary password after login.</div>
                    </div>
                `;
            }
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>All ID Cards</title>
                    ${commonStyles}
                    <style>
                        .id-card { width: 340px; height: 212px; border: 2px solid #cbd5e1; border-radius: 12px; background: white; padding: 15px; margin: 15px auto; display: inline-block; vertical-align: top; box-sizing: border-box; }
                        .id-header { text-align: center; border-bottom: 2px solid #4f46e5; padding-bottom: 5px; }
                        .id-header h4 { font-size: 11px; color: #475569; text-transform: uppercase; }
                        .id-header h3 { font-size: 13px; color: #4f46e5; font-weight: 700; }
                        .id-body { display: flex; align-items: center; gap: 15px; margin-top: 8px; }
                        .id-info h2 { font-size: 14px; color: #1e293b; margin-bottom: 2px; }
                        .id-info p { font-size: 10px; color: #64748b; margin-bottom: 2px; }
                        .id-footer { font-size: 8px; text-align: center; color: #ef4444; border-top: 1px solid #e2e8f0; padding-top: 4px; margin-top:5px; }
                        @media print { body { background: white; } .no-print { display: none; } }
                    </style>
                </head>
                <body>
                    <div class="no-print container" style="text-align: center; margin: 20px auto;">
                        <button onclick="window.print()" class="btn">Print All ID Cards</button>
                        <a href="/admin/members" class="btn" style="background:#64748b;">Back</a>
                    </div>
                    <div style="text-align: center;">${cardsHtml}</div>
                </body>
                </html>
            `);
        });
    });
});

// Admin Attendance View & Filters
app.get('/admin/attendance', requireAdmin, (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const search = req.query.search || '';
    const position = req.query.position || '';

    let query = `SELECT a.*, u.name, u.position FROM attendance a JOIN users u ON a.member_id = u.member_id WHERE a.date = ?`;
    let params = [date];

    if (search) {
        query += ` AND (u.name LIKE ? OR u.member_id LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
    }
    if (position) {
        query += ` AND u.position = ?`;
        params.push(position);
    }
    query += ` ORDER BY a.timestamp DESC`;

    db.all(query, params, (err, records) => {
        db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Attendance Records</title>
                    ${commonStyles}
                </head>
                <body>
                    <div class="flex" style="background: #1e293b; color: white; padding: 15px 30px;">
                        <h2>Attendance Logs</h2>
                        <div>
                            <a href="/admin/dashboard" style="color:white; margin-right:15px; text-decoration:none;">Dashboard</a>
                            <a href="/admin/members" style="color:white; margin-right:15px; text-decoration:none;">Members</a>
                            <a href="/admin/attendance" style="color:white; margin-right:15px; text-decoration:none;">Attendance</a>
                            <a href="/admin/reports" style="color:white; margin-right:15px; text-decoration:none;">Reports</a>
                            <a href="/admin/settings" style="color:white; margin-right:15px; text-decoration:none;">Settings</a>
                            <a href="/admin/logout" class="btn btn-danger" style="padding: 6px 12px; font-size:13px;">Logout</a>
                        </div>
                    </div>
                    <div class="container" style="margin-top: 20px;">
                        <div class="card">
                            <form action="/admin/attendance" method="GET" style="display: flex; gap: 15px; flex-wrap: wrap; align-items: flex-end;">
                                <div style="flex:1;">
                                    <label>Date</label>
                                    <input type="date" name="date" value="${date}" style="margin:0;">
                                </div>
                                <div style="flex:1;">
                                    <label>Search Member</label>
                                    <input type="text" name="search" placeholder="Name or ID" value="${search}" style="margin:0;">
                                </div>
                                <div style="flex:1;">
                                    <label>Position</label>
                                    <select name="position" style="margin:0;">
                                        <option value="">All Positions</option>
                                        <option value="President" ${position==='President'?'selected':''}>President</option>
                                        <option value="Secretary" ${position==='Secretary'?'selected':''}>Secretary</option>
                                        <option value="Treasurer" ${position==='Treasurer'?'selected':''}>Treasurer</option>
                                        <option value="Member" ${position==='Member'?'selected':''}>Member</option>
                                    </select>
                                </div>
                                <div>
                                    <button type="submit" class="btn" style="margin:0;">Filter</button>
                                </div>
                            </form>
                        </div>

                        <div class="card">
                            <table>
                                <thead>
                                    <tr><th>Member ID</th><th>Name</th><th>Position</th><th>Scan Type</th><th>Date</th><th>Time</th><th>Device</th></tr>
                                </thead>
                                <tbody>
                                    ${records.map(r => `
                                        <tr>
                                            <td>${r.member_id}</td>
                                            <td>${r.name}</td>
                                            <td>${r.position}</td>
                                            <td><span class="badge ${r.scan_type === 'TIME_IN' ? 'badge-active' : 'badge-disabled'}">${r.scan_type}</span></td>
                                            <td>${r.date}</td>
                                            <td>${r.time}</td>
                                            <td>${r.scanner_device || 'Scanner'}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </body>
                </html>
            `);
        });
    });
});

// Admin Reports & CSV Export
app.get('/admin/reports', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Attendance Reports</title>${commonStyles}</head>
            <body>
                <div class="flex" style="background: #1e293b; color: white; padding: 15px 30px;">
                    <h2>Attendance Reports & Export</h2>
                    <div>
                        <a href="/admin/dashboard" style="color:white; margin-right:15px; text-decoration:none;">Dashboard</a>
                        <a href="/admin/members" style="color:white; margin-right:15px; text-decoration:none;">Members</a>
                        <a href="/admin/attendance" style="color:white; margin-right:15px; text-decoration:none;">Attendance</a>
                        <a href="/admin/reports" style="color:white; margin-right:15px; text-decoration:none;">Reports</a>
                        <a href="/admin/settings" style="color:white; margin-right:15px; text-decoration:none;">Settings</a>
                        <a href="/admin/logout" class="btn btn-danger" style="padding: 6px 12px; font-size:13px;">Logout</a>
                    </div>
                </div>
                <div class="container" style="margin-top: 20px;">
                    <div class="card">
                        <h3>Export Attendance as CSV</h3>
                        <p style="color: #64748b; font-size: 14px; margin-bottom: 15px;">Download all attendance logs formatted as a spreadsheet CSV file.</p>
                        <a href="/admin/reports/export-csv" class="btn btn-success">Download CSV Report</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    });
});

app.get('/admin/reports/export-csv', requireAdmin, (req, res) => {
    db.all(`SELECT a.member_id, u.name, u.position, a.scan_type, a.date, a.time, a.scanner_device FROM attendance a JOIN users u ON a.member_id = u.member_id ORDER BY a.timestamp DESC`, (err, rows) => {
        let csv = 'Member ID,Name,Position,Scan Type,Date,Time,Device\n';
        rows.forEach(r => {
            csv += `"${r.member_id}","${r.name}","${r.position}","${r.scan_type}","${r.date}","${r.time}","${r.scanner_device}"\n`;
        });
        res.header('Content-Type', 'text/csv');
        res.attachment('attendance_report.csv');
        res.send(csv);
    });
});

// Admin Settings & Backup
app.get('/admin/settings', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Club Settings</title>${commonStyles}</head>
            <body>
                <div class="flex" style="background: #1e293b; color: white; padding: 15px 30px;">
                    <h2>Club Settings & Backup</h2>
                    <div>
                        <a href="/admin/dashboard" style="color:white; margin-right:15px; text-decoration:none;">Dashboard</a>
                        <a href="/admin/members" style="color:white; margin-right:15px; text-decoration:none;">Members</a>
                        <a href="/admin/attendance" style="color:white; margin-right:15px; text-decoration:none;">Attendance</a>
                        <a href="/admin/reports" style="color:white; margin-right:15px; text-decoration:none;">Reports</a>
                        <a href="/admin/settings" style="color:white; margin-right:15px; text-decoration:none;">Settings</a>
                        <a href="/admin/logout" class="btn btn-danger" style="padding: 6px 12px; font-size:13px;">Logout</a>
                    </div>
                </div>
                <div class="container" style="margin-top: 20px;">
                    <div class="card">
                        <h3>Club Configuration</h3>
                        <form action="/admin/settings" method="POST">
                            <label>Club Name</label>
                            <input type="text" name="club_name" value="${club ? club.club_name : ''}" required>
                            <label>School Name</label>
                            <input type="text" name="school_name" value="${club ? club.school_name : ''}" required>
                            <label>School Year</label>
                            <input type="text" name="school_year" value="${club ? club.school_year : ''}" required>
                            <label>Adviser Name</label>
                            <input type="text" name="adviser" value="${club ? club.adviser : ''}" required>
                            <button type="submit" class="btn">Save Settings</button>
                        </form>
                    </div>
                    <div class="card">
                        <h3>Database Backup</h3>
                        <p style="color: #64748b; font-size: 14px; margin-bottom: 15px;">Download a secure backup of the SQLite database.</p>
                        <a href="/admin/settings/backup" class="btn btn-success">Download Database (.db)</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
    const { club_name, school_name, school_year, adviser } = req.body;
    db.run(`UPDATE clubs SET club_name = ?, school_name = ?, school_year = ?, adviser = ? WHERE id = 1`, [club_name, school_name, school_year, adviser], () => {
        logActivity(req.session.admin.username, 'Updated club configuration');
        res.redirect('/admin/settings');
    });
});

app.get('/admin/settings/backup', requireAdmin, (req, res) => {
    res.download(dbFile);
});


// ==========================================================
// QR SCANNER PORTAL (/scanner)
// ==========================================================

app.get('/scanner', (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>QR Scanner - ${club ? club.club_name : ''}</title>
                ${commonStyles}
                <script src="https://unpkg.com/html5-qrcode"></script>
                <style>
                    body { background: #0f172a; color: white; }
                    .scanner-container { max-width: 500px; margin: 20px auto; text-align: center; }
                    .mode-select { display: flex; gap: 10px; margin-bottom: 20px; }
                    .mode-btn { flex: 1; padding: 15px; font-size: 16px; font-weight: 700; border: 2px solid #475569; background: #1e293b; color: white; border-radius: 10px; cursor: pointer; }
                    .mode-btn.active { background: #4f46e5; border-color: #6366f1; }
                    #reader { width: 100%; border-radius: 12px; overflow: hidden; border: none; }
                    .result-box { margin-top: 20px; padding: 20px; border-radius: 12px; display: none; }
                </style>
            </head>
            <body>
                <div class="container scanner-container">
                    <h2>QR Attendance Scanner</h2>
                    <p style="color: #94a3b8; margin-bottom: 20px;">${club ? club.club_name : ''}</p>

                    <div class="mode-select">
                        <button class="mode-btn active" id="btn-in" onclick="setScanMode('TIME_IN')">TIME IN</button>
                        <button class="mode-btn" id="btn-out" onclick="setScanMode('TIME_OUT')">TIME OUT</button>
                    </div>

                    <div style="margin-bottom: 10px; text-align: left;">
                        <label style="font-size:13px; color:#94a3b8;"><input type="checkbox" id="sound-toggle" checked> Sound Effects: ON</label>
                    </div>

                    <div id="reader"></div>

                    <div id="result-box" class="result-box">
                        <h3 id="res-title"></h3>
                        <p id="res-name" style="font-size: 20px; font-weight:bold; margin: 10px 0;"></p>
                        <p id="res-details" style="color: #cbd5e1;"></p>
                    </div>
                    
                    <div style="margin-top: 20px;"><a href="/" style="color: #94a3b8; text-decoration:none;">← Home</a></div>
                </div>

                <script>
                    let currentMode = 'TIME_IN';

                    function setScanMode(mode) {
                        currentMode = mode;
                        document.getElementById('btn-in').classList.toggle('active', mode === 'TIME_IN');
                        document.getElementById('btn-out').classList.toggle('active', mode === 'TIME_OUT');
                    }

                    // Web Audio API Sound Generator
                    function playSound(type) {
                        if (!document.getElementById('sound-toggle').checked) return;
                        const ctx = new (window.AudioContext || window.webkitAudioContext)();
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.connect(gain);
                        gain.connect(ctx.destination);

                        if (type === 'success') {
                            osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
                            osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
                            gain.gain.setValueAtTime(0.1, ctx.currentTime);
                            osc.start();
                            osc.stop(ctx.currentTime + 0.3);
                        } else {
                            osc.frequency.setValueAtTime(200, ctx.currentTime);
                            osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
                            gain.gain.setValueAtTime(0.2, ctx.currentTime);
                            osc.start();
                            osc.stop(ctx.currentTime + 0.4);
                        }
                    }

                    function onScanSuccess(decodedText) {
                        fetch('/scanner/process', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ token: decodedText, scan_type: currentMode })
                        })
                        .then(res => res.json())
                        .then(data => {
                            const box = document.getElementById('result-box');
                            box.style.display = 'block';
                            if (data.status === 'success') {
                                box.style.background = '#065f46';
                                document.getElementById('res-title').innerText = '✓ ATTENDANCE RECORDED (' + currentMode + ')';
                                document.getElementById('res-name').innerText = data.member.name;
                                document.getElementById('res-details').innerText = data.member.position + ' | ID: ' + data.member.member_id + ' | ' + data.time;
                                playSound('success');
                            } else if (data.status === 'duplicate') {
                                box.style.background = '#b45309';
                                document.getElementById('res-title').innerText = '⚠ ALREADY SCANNED';
                                document.getElementById('res-name').innerText = data.member.name;
                                document.getElementById('res-details').innerText = 'Already recorded ' + currentMode + ' today at ' + data.time;
                                playSound('error');
                            } else {
                                box.style.background = '#991b1b';
                                document.getElementById('res-title').innerText = '✕ INVALID QR CODE';
                                document.getElementById('res-name').innerText = data.message || 'Unknown QR Code';
                                document.getElementById('res-details').innerText = 'Access denied.';
                                playSound('error');
                            }

                            setTimeout(() => { box.style.display = 'none'; }, 4000);
                        })
                        .catch(err => console.error(err));
                    }

                    const html5QrCode = new Html5Qrcode("reader");
                    html5QrCode.start(
                        { facingMode: "environment" },
                        { fps: 10, qrbox: { width: 250, height: 250 } },
                        onScanSuccess
                    ).catch(err => {
                        document.getElementById('reader').innerHTML = '<div style="padding:20px; background:#1e293b; color:#ef4444; border-radius:8px;">Camera access required or HTTPS needed on mobile devices. Error: ' + err + '</div>';
                    });
                </script>
            </body>
            </html>
        `);
    });
});

app.post('/scanner/process', (req, res) => {
    const { token, scan_type } = req.body;
    db.get(`SELECT * FROM users WHERE qr_token = ?`, [token], (err, member) => {
        if (!member) {
            return res.json({ status: 'error', message: 'This QR code is not registered in the system.' });
        }
        if (member.status !== 'ACTIVE') {
            return res.json({ status: 'error', message: 'This member account is disabled.' });
        }

        const today = new Date().toISOString().split('T')[0];
        const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // Check duplicate scan for same scan_type today
        db.get(`SELECT * FROM attendance WHERE member_id = ? AND date = ? AND scan_type = ?`, [member.member_id, today, scan_type], (err, existing) => {
            if (existing) {
                return res.json({ status: 'duplicate', member, time: existing.time });
            }

            db.run(`INSERT INTO attendance (member_id, scan_type, date, time, scanner_device) VALUES (?, ?, ?, ?, ?)`,
                [member.member_id, scan_type, today, timeNow, 'Mobile Scanner'], () => {
                    res.json({ status: 'success', member, time: timeNow });
                });
        });
    });
});


// ==========================================================
// MEMBER PORTAL (/member)
// ==========================================================

app.get('/member/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Member Login</title>${commonStyles}<style>body { display: flex; align-items: center; justify-content: center; background: #f1f5f9; }</style></head>
        <body>
            <div class="card" style="width: 100%; max-width: 400px;">
                <h2 style="margin-bottom: 20px; text-align: center;">Member Portal Login</h2>
                ${req.query.error ? `<div class="alert alert-error">${req.query.error}</div>` : ''}
                <form action="/member/login" method="POST">
                    <label>Username</label>
                    <input type="text" name="username" required autocomplete="off">
                    <label>Password / Temporary Password</label>
                    <input type="password" name="password" required>
                    <button type="submit" class="btn" style="width:100%; margin-top: 10px;">Login</button>
                </form>
                <div style="text-align: center; margin-top: 15px;"><a href="/" style="color: #64748b; font-size: 13px; text-decoration: none;">← Back to Home</a></div>
            </div>
        </body>
        </html>
    `);
});

app.post('/member/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND position != 'Administrator'`, async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.member = user;
            if (user.must_change_password === 1) {
                return res.redirect('/member/change-password');
            }
            res.redirect('/member/dashboard');
        } else {
            res.redirect('/member/login?error=Invalid username or password');
        }
    });
});

app.get('/member/logout', (req, res) => {
    req.session.member = null;
    res.redirect('/member/login');
});

// Member Forced Password Change
app.get('/member/change-password', (req, res) => {
    if (!req.session.member) return res.redirect('/member/login');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Change Password</title>${commonStyles}<style>body { display: flex; align-items: center; justify-content: center; background: #f1f5f9; }</style></head>
        <body>
            <div class="card" style="width: 100%; max-width: 400px;">
                <h2>Change Temporary Password</h2>
                <p style="font-size: 13px; color: #ef4444; margin-bottom: 15px;">You must change your temporary password before accessing your dashboard.</p>
                ${req.query.error ? `<div class="alert alert-error">${req.query.error}</div>` : ''}
                <form action="/member/change-password" method="POST">
                    <label>New Password</label>
                    <input type="password" name="new_password" required minlength="6">
                    <label>Confirm New Password</label>
                    <input type="password" name="confirm_password" required minlength="6">
                    <button type="submit" class="btn" style="width:100%;">Update Password</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/member/change-password', async (req, res) => {
    if (!req.session.member) return res.redirect('/member/login');
    const { new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) return res.redirect('/member/change-password?error=Passwords do not match');
    
    const hashed = await bcrypt.hash(new_password, 10);
    db.run(`UPDATE users SET password = ?, temporary_password = NULL, must_change_password = 0 WHERE id = ?`, [hashed, req.session.member.id], () => {
        req.session.member.must_change_password = 0;
        res.redirect('/member/dashboard');
    });
});

function requireMember(req, res, next) {
    if (!req.session.member) return res.redirect('/member/login');
    if (req.session.member.must_change_password === 1) return res.redirect('/member/change-password');
    next();
}

app.get('/member', (req, res) => {
    if (req.session.member) return res.redirect('/member/dashboard');
    res.redirect('/member/login');
});

app.get('/member/dashboard', requireMember, (req, res) => {
    const member = req.session.member;
    db.all(`SELECT * FROM attendance WHERE member_id = ? ORDER BY timestamp DESC LIMIT 10`, [member.member_id], async (err, attendance) => {
        db.get(`SELECT * FROM clubs LIMIT 1`, async (err, club) => {
            const qrDataUrl = await QRCode.toDataURL(member.qr_token);
            res.send(`
                <!DOCTYPE html>
                <html>
                <head><title>Member Dashboard - ${member.name}</title>${commonStyles}</head>
                <body>
                    <div class="flex" style="background: #0ea5e9; color: white; padding: 15px 30px;">
                        <h2>Member Portal</h2>
                        <div>
                            <span style="margin-right: 15px;">Hello, ${member.name}</span>
                            <a href="/member/logout" class="btn btn-danger" style="padding: 6px 12px; font-size:13px;">Logout</a>
                        </div>
                    </div>
                    <div class="container" style="margin-top: 20px;">
                        <div class="grid">
                            <div class="card" style="text-align: center;">
                                <h3>Your QR Code</h3>
                                <img src="${qrDataUrl}" alt="QR" style="margin: 15px 0; width: 180px; height: 180px;">
                                <p style="font-size: 13px; color: #64748b;">Show this QR code to the scanner.</p>
                            </div>
                            <div class="card">
                                <h3>Profile Information</h3>
                                <p style="margin-top: 10px;"><b>Name:</b> ${member.name}</p>
                                <p style="margin-top: 6px;"><b>Position:</b> ${member.position}</p>
                                <p style="margin-top: 6px;"><b>Member ID:</b> ${member.member_id}</p>
                                <p style="margin-top: 6px;"><b>Username:</b> ${member.username}</p>
                                <p style="margin-top: 6px;"><b>Status:</b> <span class="badge badge-active">${member.status}</span></p>
                            </div>
                        </div>

                        <div class="card">
                            <h3>Recent Attendance History</h3>
                            <table>
                                <thead>
                                    <tr><th>Scan Type</th><th>Date</th><th>Time</th><th>Device</th></tr>
                                </thead>
                                <tbody>
                                    ${attendance.map(a => `<tr><td><span class="badge ${a.scan_type === 'TIME_IN' ? 'badge-active' : 'badge-disabled'}">${a.scan_type}</span></td><td>${a.date}</td><td>${a.time}</td><td>${a.scanner_device || 'Scanner'}</td></tr>`).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </body>
                </html>
            `);
        });
    });
});

// Start Server & Print Network URLs
app.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';
    for (let name of Object.keys(interfaces)) {
        for (let net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                localIp = net.address;
            }
        }
    }

    console.log(`\n======================================================`);
    console.log(` SCHOOL CLUB QR CODE ATTENDANCE SYSTEM RUNNING`);
    console.log(`======================================================`);
    console.log(` Local:   http://localhost:${PORT}`);
    console.log(` Network: http://${localIp}:${PORT}`);
    console.log(`------------------------------------------------------`);
    console.log(` Admin Portal:   http://${localIp}:${PORT}/admin`);
    console.log(` Scanner Portal: http://${localIp}:${PORT}/scanner`);
    console.log(` Member Portal:  http://${localIp}:${PORT}/member`);
    console.log(`======================================================\n`);
});
