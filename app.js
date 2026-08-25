const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'club-attendance-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS in production
}));

// Set EJS as templating engine
app.set('view engine', 'ejs');

// Database Setup
const dbFile = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Error opening database', err.message);
    else console.log('Connected to SQLite database.');
});

// Initialize Tables and Default Admin
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT,
        date TEXT,
        time_in TEXT,
        time_out TEXT,
        status TEXT,
        remarks TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        message TEXT,
        status TEXT DEFAULT 'Active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_name TEXT,
        school_name TEXT,
        logo TEXT,
        attendance_start TEXT,
        grace_period INTEGER,
        scanner_pin TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT,
        user TEXT,
        date TEXT,
        time TEXT
    )`);

    // Seed default settings if empty
    db.get(`SELECT COUNT(*) as count FROM settings`, (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO settings (organization_name, school_name, logo, attendance_start, grace_period, scanner_pin) VALUES (?, ?, ?, ?, ?, ?)`,
                ['Supreme Student Council', 'National University', 'https://via.placeholder.com/150', '08:00', 15, '1234']);
        }
    });

    // Seed default admin if empty
    db.get(`SELECT COUNT(*) as count FROM admins`, async (err, row) => {
        if (row.count === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            db.run(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`, ['admin', hash], () => {
                console.log('--------------------------------------------------');
                console.log('DEFAULT ADMIN CREATED: username: admin | password: admin123');
                console.log('--------------------------------------------------');
            });
        }
    });
});

// Helper Functions
function logAudit(action, user) {
    const d = new Date();
    const dateStr = d.toLocaleDateString();
    const timeStr = d.toLocaleTimeString();
    db.run(`INSERT INTO audit_logs (action, user, date, time) VALUES (?, ?, ?, ?)`, [action, user, dateStr, timeStr]);
}

// Authentication Middlewares
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) return next();
    res.redirect('/admin/login');
}

function requireMember(req, res, next) {
    if (req.session && req.session.isMember) return next();
    res.redirect('/member/login');
}

// ==========================================
// ROUTES: HOME & AUTHENTICATION
// ==========================================
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>Club QR Attendance System</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f7f6; text-align: center; padding-top: 50px; }
            .container { background: white; max-width: 600px; margin: auto; padding: 40px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
            h1 { color: #2c3e50; }
            .btn { display: inline-block; background: #3498db; color: white; padding: 12px 25px; margin: 10px; border-radius: 5px; text-decoration: none; font-weight: bold; transition: background 0.3s; }
            .btn:hover { background: #2980b9; }
            .btn-scanner { background: #2ecc71; }
            .btn-scanner:hover { background: #27ae60; }
        </style>
        </head>
        <body>
            <div class="container">
                <h1>School Club QR Attendance System</h1>
                <p>Welcome to the official QR Code Attendance and Management portal for school organizations.</p>
                <br>
                <a href="/admin/login" class="btn">Admin Portal</a>
                <a href="/scanner" class="btn btn-scanner">Scanner Portal</a>
                <a href="/member/login" class="btn" style="background:#e67e22;">Member Portal</a>
            </div>
        </body>
        </html>
    `);
});

// ADMIN AUTH
app.get('/admin/login', (req, res) => {
    res.render('admin_login', { error: null });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM admins WHERE username = ?`, [username], async (err, admin) => {
        if (admin && await bcrypt.compare(password, admin.password_hash)) {
            req.session.isAdmin = true;
            req.session.username = admin.username;
            logAudit('Admin Logged In', admin.username);
            res.redirect('/admin');
        } else {
            res.render('admin_login', { error: 'Invalid username or password' });
        }
    });
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});

// MEMBER AUTH
app.get('/member/login', (req, res) => {
    res.render('member_login', { error: null });
});

app.post('/member/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM members WHERE username = ?`, [username], async (err, member) => {
        if (member && await bcrypt.compare(password, member.password_hash)) {
            req.session.isMember = true;
            req.session.memberId = member.member_id;
            req.session.username = member.username;
            if (member.temporary_password_status === 1) {
                return res.redirect('/member/change-password');
            }
            res.redirect('/member');
        } else {
            res.render('member_login', { error: 'Invalid username or password' });
        }
    });
});

app.get('/member/change-password', requireMember, (req, res) => {
    res.render('member_change_password', { error: null });
});

app.post('/member/change-password', requireMember, async (req, res) => {
    const { new_password } = req.body;
    const hash = await bcrypt.hash(new_password, 10);
    db.run(`UPDATE members SET password_hash = ?, temporary_password_status = 0 WHERE username = ?`, [hash, req.session.username], () => {
        logAudit('Member Changed Password', req.session.username);
        res.redirect('/member');
    });
});

app.get('/member/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/member/login');
});


// ==========================================
// ROUTES: ADMIN PORTAL
// ==========================================
app.get('/admin', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
        db.get(`SELECT COUNT(*) as total FROM members`, (err, m1) => {
            db.get(`SELECT COUNT(*) as active FROM members WHERE status = 'Active'`, (err, m2) => {
                db.get(`SELECT COUNT(*) as inactive FROM members WHERE status = 'Inactive'`, (err, m3) => {
                    const today = new Date().toLocaleDateString();
                    db.get(`SELECT COUNT(DISTINCT member_id) as present FROM attendance WHERE date = ? AND time_in IS NOT NULL`, [today], (err, a1) => {
                        db.get(`SELECT COUNT(DISTINCT member_id) as late FROM attendance WHERE date = ? AND status = 'Late'`, [today], (err, a2) => {
                            db.all(`SELECT * FROM attendance ORDER BY id DESC LIMIT 5`, (err, recentScans) => {
                                db.all(`SELECT * FROM members ORDER BY id DESC LIMIT 5`, (err, recentMembers) => {
                                    res.render('admin_dashboard', {
                                        settings,
                                        stats: {
                                            totalMembers: m1.total,
                                            activeMembers: m2.active,
                                            inactiveMembers: m3.inactive,
                                            presentToday: a1.present,
                                            absentToday: m1.total - a1.present,
                                            lateToday: a2.late,
                                            attendanceRate: m1.total > 0 ? ((a1.present / m1.total) * 100).toFixed(1) : 0
                                        },
                                        recentScans,
                                        recentMembers
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

// MEMBERS MANAGEMENT
app.get('/admin/members', requireAdmin, (req, res) => {
    const search = req.query.search || '';
    const filter = req.query.filter || '';
    let query = `SELECT * FROM members WHERE (full_name LIKE ? OR member_id LIKE ? OR username LIKE ?)`;
    let params = [`%${search}%`, `%${search}%`, `%${search}%`];
    if (filter) {
        query += ` AND status = ?`;
        params.push(filter);
    }
    db.all(query, params, (err, members) => {
        db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
            res.render('admin_members', { members, search, filter, settings, newlyCreated: null });
        });
    });
});

app.post('/admin/members/add', requireAdmin, async (req, res) => {
    const { full_name, position, club, year_level, course, section, contact, email, photo, status, date_joined } = req.body;
    
    // Generate unique identifiers
    const randomNum = Math.floor(100 + Math.random() * 900);
    const member_id = `MEM-2026-${randomNum}-${Math.floor(Math.random()*90+10)}`;
    const username = `CLUB-2026-${Math.floor(100 + Math.random() * 900)}`;
    const tempPassword = Math.random().toString(36.slice(-8)).substring(2, 10).toUpperCase();
    const password_hash = await bcrypt.hash(tempPassword, 10);
    const qr_token = `TOKEN-${uuidv4()}`;

    db.run(`INSERT INTO members (member_id, full_name, position, club, year_level, course, section, contact, email, photo, username, password_hash, qr_token, status, date_joined) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [member_id, full_name, position, club, year_level, course, section, contact, email, photo || 'https://via.placeholder.com/150', username, password_hash, qr_token, status || 'Active', date_joined || new Date().toLocaleDateString()],
        function(err) {
            if (err) return res.send("Error creating member: " + err.message);
            logAudit(`Created Member: ${full_name}`, req.session.username);
            
            db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
                db.all(`SELECT * FROM members`, (err, members) => {
                    res.render('admin_members', {
                        members,
                        search: '',
                        filter: '',
                        settings,
                        newlyCreated: { member_id, full_name, username, tempPassword, qr_token, position, club, year_level, course, section, photo }
                    });
                });
            });
        }
    );
});

app.post('/admin/members/edit/:id', requireAdmin, (req, res) => {
    const { full_name, position, club, year_level, course, section, contact, email, status } = req.body;
    db.run(`UPDATE members SET full_name = ?, position = ?, club = ?, year_level = ?, course = ?, section = ?, contact = ?, email = ?, status = ? WHERE id = ?`,
        [full_name, position, club, year_level, course, section, contact, email, status, req.params.id], () => {
            logAudit(`Updated Member ID ${req.params.id}`, req.session.username);
            res.redirect('/admin/members');
        });
});

app.get('/admin/members/delete/:id', requireAdmin, (req, res) => {
    db.run(`DELETE FROM members WHERE id = ?`, [req.params.id], () => {
        logAudit(`Deleted Member ID ${req.params.id}`, req.session.username);
        res.redirect('/admin/members');
    });
});

app.get('/admin/members/reset-password/:id', requireAdmin, async (req, res) => {
    const tempPassword = Math.random().toString(36).substring(2, 10).toUpperCase();
    const password_hash = await bcrypt.hash(tempPassword, 10);
    db.run(`UPDATE members SET password_hash = ?, temporary_password_status = 1 WHERE id = ?`, [password_hash, req.params.id], () => {
        logAudit(`Reset Password for Member ID ${req.params.id}`, req.session.username);
        res.redirect('/admin/members');
    });
});

app.get('/admin/members/regenerate-qr/:id', requireAdmin, (req, res) => {
    const qr_token = `TOKEN-${uuidv4()}`;
    db.run(`UPDATE members SET qr_token = ? WHERE id = ?`, [qr_token, req.params.id], () => {
        logAudit(`Regenerated QR for Member ID ${req.params.id}`, req.session.username);
        res.redirect('/admin/members');
    });
});

// ATTENDANCE RECORDS & REPORTS
app.get('/admin/attendance', requireAdmin, (req, res) => {
    db.all(`SELECT attendance.*, members.full_name, members.position FROM attendance LEFT JOIN members ON attendance.member_id = members.member_id ORDER BY attendance.id DESC`, (err, records) => {
        db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
            res.render('admin_attendance', { records, settings });
        });
    });
});

app.get('/admin/reports', requireAdmin, (req, res) => {
    db.all(`SELECT attendance.*, members.full_name, members.position, members.club FROM attendance LEFT JOIN members ON attendance.member_id = members.member_id ORDER BY attendance.id DESC`, (err, records) => {
        db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
            res.render('admin_reports', { records, settings });
        });
    });
});

// ANNOUNCEMENTS
app.get('/admin/announcements', requireAdmin, (req, res) => {
    db.all(`SELECT * FROM announcements ORDER BY id DESC`, (err, announcements) => {
        db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
            res.render('admin_announcements', { announcements, settings });
        });
    });
});

app.post('/admin/announcements/add', requireAdmin, (req, res) => {
    const { title, message } = req.body;
    db.run(`INSERT INTO announcements (title, message) VALUES (?, ?)`, [title, message], () => {
        logAudit(`Created Announcement: ${title}`, req.session.username);
        res.redirect('/admin/announcements');
    });
});

// SETTINGS & AUDIT LOGS
app.get('/admin/settings', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
        db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50`, (err, logs) => {
            res.render('admin_settings', { settings, logs, error: null, success: null });
        });
    });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
    const { organization_name, school_name, logo, attendance_start, grace_period, scanner_pin, admin_password } = req.body;
    db.run(`UPDATE settings SET organization_name = ?, school_name = ?, logo = ?, attendance_start = ?, grace_period = ?, scanner_pin = ? WHERE id = 1`,
        [organization_name, school_name, logo, attendance_start, grace_period, scanner_pin], async () => {
            if (admin_password && admin_password.trim() !== '') {
                const hash = await bcrypt.hash(admin_password, 10);
                db.run(`UPDATE admins SET password_hash = ? WHERE username = ?`, [hash, req.session.username]);
            }
            logAudit('Updated System Settings', req.session.username);
            db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
                db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50`, (err, logs) => {
                    res.render('admin_settings', { settings, logs, error: null, success: 'Settings updated successfully!' });
                });
            });
        });
});


// ==========================================
// ROUTES: SCANNER PORTAL
// ==========================================
app.get('/scanner', (req, res) => {
    db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
        res.render('scanner', { settings });
    });
});

app.post('/scanner/process', (req, res) => {
    const { qr_token, mode } = req.body; // mode: 'TIME IN' or 'TIME OUT'
    const today = new Date().toLocaleDateString();
    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    db.get(`SELECT * FROM members WHERE qr_token = ?`, [qr_token], (err, member) => {
        if (!member) {
            return res.json({ success: false, error: 'INVALID QR CODE', message: 'This QR code is not registered in the system.' });
        }
        if (member.status !== 'Active') {
            return res.json({ success: false, error: 'MEMBER INACTIVE', message: 'This member account has been deactivated.' });
        }

        db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
            db.get(`SELECT * FROM attendance WHERE member_id = ? AND date = ?`, [member.member_id, today], (err, att) => {
                
                if (mode === 'TIME IN') {
                    if (att && att.time_in) {
                        return res.json({ success: false, error: 'ALREADY TIMED IN', message: `Already timed in at ${att.time_in}`, member });
                    }

                    // Compute Late / Present status based on settings
                    let status = 'Present';
                    if (settings && settings.attendance_start) {
                        const [sHour, sMin] = settings.attendance_start.split(':').map(Number);
                        const grace = settings.grace_period || 0;
                        const now = new Date();
                        const totalStartMins = sHour * 60 + sMin + grace;
                        const totalCurrentMins = now.getHours() * 60 + now.getMinutes();
                        if (totalCurrentMins > totalStartMins) {
                            status = 'Late';
                        }
                    }

                    if (att) {
                        db.run(`UPDATE attendance SET time_in = ?, status = ? WHERE id = ?`, [nowTime, status, att.id], () => {
                            res.json({ success: true, mode: 'TIME IN', status, time: nowTime, date: today, member });
                        });
                    } else {
                        db.run(`INSERT INTO attendance (member_id, date, time_in, status, remarks) VALUES (?, ?, ?, ?, ?)`,
                            [member.member_id, today, nowTime, status, 'On time'], () => {
                                res.json({ success: true, mode: 'TIME IN', status, time: nowTime, date: today, member });
                            });
                    }
                } else { // TIME OUT
                    if (!att || !att.time_in) {
                        return res.json({ success: false, error: 'NO TIME-IN RECORD FOUND', message: 'Cannot Time Out without an existing Time In record.' });
                    }
                    if (att.time_out) {
                        return res.json({ success: false, error: 'ALREADY TIMED OUT', message: `Already timed out at ${att.time_out}`, member });
                    }

                    db.run(`UPDATE attendance SET time_out = ? WHERE id = ?`, [nowTime, att.id], () => {
                        res.json({ success: true, mode: 'TIME OUT', status: att.status, time: nowTime, date: today, member });
                    });
                }
            });
        });
    });
});


// ==========================================
// ROUTES: MEMBER PORTAL
// ==========================================
app.get('/member', requireMember, (req, res) => {
    db.get(`SELECT * FROM members WHERE member_id = ?`, [req.session.memberId], (err, member) => {
        db.all(`SELECT * FROM attendance WHERE member_id = ? ORDER BY id DESC`, [member.member_id], (err, attendance) => {
            db.all(`SELECT * FROM announcements WHERE status = 'Active' ORDER BY id DESC`, (err, announcements) => {
                db.get(`SELECT * FROM settings LIMIT 1`, (err, settings) => {
                    const totalPresent = attendance.filter(a => a.status === 'Present').length;
                    const totalLate = attendance.filter(a => a.status === 'Late').length;
                    const totalAbsent = attendance.filter(a => a.status === 'Absent').length;
                    res.render('member_dashboard', { member, attendance, announcements, settings, totalPresent, totalLate, totalAbsent });
                });
            });
        });
    });
});


// ==========================================
// EMBEDDED EJS TEMPLATES (VIEWS)
// ==========================================
const fs = require('fs');
const viewsDir = path.join(__dirname, 'views');
if (!fs.existsSync(viewsDir)) fs.mkdirSync(viewsDir);

// 1. admin_login.ejs
fs.writeFileSync(path.join(viewsDir, 'admin_login.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Admin Login - Club Portal</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="bg-light d-flex align-items-center justify-content-center vh-100">
    <div class="card shadow p-4" style="width: 400px;">
        <h3 class="text-center mb-4 text-primary">Admin Portal</h3>
        <% if (error) { %> <div class="alert alert-danger"><%= error %></div> <% } %>
        <form method="POST" action="/admin/login">
            <div class="mb-3"><label>Username</label><input type="text" name="username" class="form-control" required></div>
            <div class="mb-3"><label>Password</label><input type="password" name="password" class="form-control" required></div>
            <button type="submit" class="btn btn-primary w-100">Login</button>
        </form>
        <div class="text-center mt-3"><a href="/" class="text-decoration-none">← Back to Home</a></div>
    </div>
</body>
</html>
`);

// 2. member_login.ejs
fs.writeFileSync(path.join(viewsDir, 'member_login.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Member Login - Club Portal</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="bg-light d-flex align-items-center justify-content-center vh-100">
    <div class="card shadow p-4" style="width: 400px;">
        <h3 class="text-center mb-4 text-warning">Member Portal</h3>
        <% if (error) { %> <div class="alert alert-danger"><%= error %></div> <% } %>
        <form method="POST" action="/member/login">
            <div class="mb-3"><label>Temporary / Assigned Username</label><input type="text" name="username" class="form-control" required></div>
            <div class="mb-3"><label>Password</label><input type="password" name="password" class="form-control" required></div>
            <button type="submit" class="btn btn-warning w-100 text-white">Login</button>
        </form>
        <div class="text-center mt-3"><a href="/" class="text-decoration-none">← Back to Home</a></div>
    </div>
</body>
</html>
`);

// 3. member_change_password.ejs
fs.writeFileSync(path.join(viewsDir, 'member_change_password.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Change Password - Member Portal</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="bg-light d-flex align-items-center justify-content-center vh-100">
    <div class="card shadow p-4" style="width: 400px;">
        <h4 class="text-center mb-3 text-danger">Password Change Required</h4>
        <p class="text-muted small text-center">Your password is temporary. Please change your password before continuing.</p>
        <form method="POST" action="/member/change-password">
            <div class="mb-3"><label>New Password</label><input type="password" name="new_password" class="form-control" required></div>
            <button type="submit" class="btn btn-danger w-100">Update Password</button>
        </form>
    </div>
</body>
</html>
`);

// 4. admin_dashboard.ejs
fs.writeFileSync(path.join(viewsDir, 'admin_dashboard.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Admin Dashboard</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-light">
    <div class="container-fluid">
        <div class="row">
            <nav id="sidebar" class="col-md-3 col-lg-2 d-md-block bg-dark sidebar collapse text-white min-vh-100 p-3">
                <h4 class="text-center py-3"><%= settings.organization_name %></h4>
                <ul class="nav flex-column">
                    <li class="nav-item mb-2"><a href="/admin" class="nav-link text-white active"><i class="fas fa-home me-2"></i> Dashboard</a></li>
                    <li class="nav-item mb-2"><a href="/admin/members" class="nav-link text-white"><i class="fas fa-users me-2"></i> Members</a></li>
                    <li class="nav-item mb-2"><a href="/admin/attendance" class="nav-link text-white"><i class="fas fa-clipboard-check me-2"></i> Attendance</a></li>
                    <li class="nav-item mb-2"><a href="/admin/reports" class="nav-link text-white"><i class="fas fa-chart-bar me-2"></i> Reports</a></li>
                    <li class="nav-item mb-2"><a href="/admin/announcements" class="nav-link text-white"><i class="fas fa-bullhorn me-2"></i> Announcements</a></li>
                    <li class="nav-item mb-2"><a href="/admin/settings" class="nav-link text-white"><i class="fas fa-cog me-2"></i> Settings</a></li>
                    <li class="nav-item mt-4"><a href="/admin/logout" class="nav-link text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a></li>
                </ul>
            </nav>
            <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4">
                <h2>Dashboard Overview</h2>
                <div class="row text-white mt-4">
                    <div class="col-md-3 mb-3"><div class="card bg-primary p-3"><h6>Total Members</h6><h3><%= stats.totalMembers %></h3></div></div>
                    <div class="col-md-3 mb-3"><div class="card bg-success p-3"><h6>Active Members</h6><h3><%= stats.activeMembers %></h3></div></div>
                    <div class="col-md-3 mb-3"><div class="card bg-warning p-3"><h6>Present Today</h6><h3><%= stats.presentToday %></h3></div></div>
                    <div class="col-md-3 mb-3"><div class="card bg-danger p-3"><h6>Attendance Rate</h6><h3><%= stats.attendanceRate %>%</h3></div></div>
                </div>
                <div class="row mt-4">
                    <div class="col-md-6">
                        <div class="card p-3 shadow-sm">
                            <h5>Recent Scans</h5>
                            <table class="table table-sm">
                                <thead><tr><th>Member ID</th><th>Time In</th><th>Status</th></tr></thead>
                                <tbody>
                                    <% recentScans.forEach(s => { %>
                                        <tr><td><%= s.member_id %></td><td><%= s.time_in %></td><td><span class="badge bg-<%= s.status==='Present'?'success':'warning' %>"><%= s.status %></span></td></tr>
                                    <% }) %>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div class="col-md-6">
                        <div class="card p-3 shadow-sm">
                            <h5>Recent Registrations</h5>
                            <table class="table table-sm">
                                <thead><tr><th>Name</th><th>Position</th><th>Username</th></tr></thead>
                                <tbody>
                                    <% recentMembers.forEach(m => { %>
                                        <tr><td><%= m.full_name %></td><td><%= m.position %></td><td><code><%= m.username %></code></td></tr>
                                    <% }) %>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    </div>
</body>
</html>
`);

// 5. admin_members.ejs
fs.writeFileSync(path.join(viewsDir, 'admin_members.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Manage Members</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        /* CR80 ID Card dimensions: 85.6mm x 53.98mm */
        .id-card { width: 342px; height: 215px; background: white; border: 1px solid #ccc; border-radius: 10px; padding: 15px; position: relative; box-shadow: 0 4px 10px rgba(0,0,0,0.1); font-family: sans-serif; display: flex; flex-direction: column; justify-content: space-between; }
        @media print { body * { visibility: hidden; } #printable-id, #printable-id * { visibility: visible; } #printable-id { position: absolute; left: 0; top: 0; } }
    </style>
</head>
<body class="bg-light">
    <div class="container-fluid">
        <div class="row">
            <nav class="col-md-3 col-lg-2 bg-dark sidebar min-vh-100 p-3 text-white">
                <h4 class="text-center py-3"><%= settings.organization_name %></h4>
                <ul class="nav flex-column">
                    <li class="nav-item mb-2"><a href="/admin" class="nav-link text-white">Dashboard</a></li>
                    <li class="nav-item mb-2"><a href="/admin/members" class="nav-link text-white active">Members</a></li>
                    <li class="nav-item mb-2"><a href="/admin/attendance" class="nav-link text-white">Attendance</a></li>
                    <li class="nav-item mb-2"><a href="/admin/reports" class="nav-link text-white">Reports</a></li>
                    <li class="nav-item mb-2"><a href="/admin/announcements" class="nav-link text-white">Announcements</a></li>
                    <li class="nav-item mb-2"><a href="/admin/settings" class="nav-link text-white">Settings</a></li>
                    <li class="nav-item mt-4"><a href="/admin/logout" class="nav-link text-danger">Logout</a></li>
                </ul>
            </nav>
            <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h2>Club Members</h2>
                    <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addMemberModal">+ Add Member</button>
                </div>

                <div class="card p-3 shadow-sm">
                    <table class="table table-striped align-middle">
                        <thead><tr><th>ID</th><th>Name</th><th>Position</th><th>Username</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            <% members.forEach(m => { %>
                                <tr>
                                    <td><%= m.member_id %></td>
                                    <td><%= m.full_name %></td>
                                    <td><%= m.position %></td>
                                    <td><code><%= m.username %></code></td>
                                    <td><span class="badge bg-<%= m.status==='Active'?'success':'secondary' %>"><%= m.status %></span></td>
                                    <td>
                                        <a href="/admin/members/reset-password/<%= m.id %>" class="btn btn-sm btn-warning" title="Reset Password">🔑</a>
                                        <a href="/admin/members/regenerate-qr/<%= m.id %>" class="btn btn-sm btn-info text-white" title="Regenerate QR">🔄</a>
                                        <a href="/admin/members/delete/<%= m.id %>" class="btn btn-sm btn-danger" onclick="return confirm('Delete member?')">🗑️</a>
                                    </td>
                                </tr>
                            <% }) %>
                        </tbody>
                    </table>
                </div>
            </main>
        </div>
    </div>

    <!-- Add Member Modal -->
    <div class="modal fade" id="addMemberModal" tabindex="-1">
        <div class="modal-dialog">
            <form class="modal-content" method="POST" action="/admin/members/add">
                <div class="modal-header"><h5 class="modal-title">Register New Member</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
                <div class="modal-body">
                    <div class="mb-2"><label>Full Name</label><input type="text" name="full_name" class="form-control" required></div>
                    <div class="mb-2"><label>Position</label><input type="text" name="position" class="form-control" value="Member" required></div>
                    <div class="mb-2"><label>Club / Organization</label><input type="text" name="club" value="<%= settings.organization_name %>" class="form-control" required></div>
                    <div class="mb-2"><label>Year Level & Course</label><input type="text" name="year_level" class="form-control" placeholder="3rd Year BSIT"></div>
                    <div class="mb-2"><label>Email & Contact</label><input type="text" name="email" class="form-control" placeholder="email@school.edu"></div>
                    <div class="mb-2"><label>Profile Photo URL</label><input type="text" name="photo" class="form-control" placeholder="https://..."></div>
                </div>
                <div class="modal-footer"><button type="submit" class="btn btn-primary">Save Member & Generate Credentials</button></div>
            </form>
        </div>
    </div>

    <% if (newlyCreated) { %>
    <!-- Success Created Modal with ID Card -->
    <div class="modal fade show" id="successModal" tabindex="-1" style="display: block; background: rgba(0,0,0,0.5);">
        <div class="modal-dialog modal-lg">
            <div class="modal-content p-4">
                <h4 class="text-success">Member Created Successfully!</h4>
                <p class="text-muted small">TEMPORARY PASSWORD — MEMBER MUST CHANGE THIS PASSWORD AFTER FIRST LOGIN</p>
                <div class="row">
                    <div class="col-md-6">
                        <p><strong>Username:</strong> <code><%= newlyCreated.username %></code></p>
                        <p><strong>Temporary Password:</strong> <code class="text-danger fw-bold"><%= newlyCreated.tempPassword %></code></p>
                        <hr>
                        <div id="printable-id" class="id-card">
                            <div style="font-size: 10px; font-weight: bold;"><%= settings.organization_name %></div>
                            <div class="d-flex align-items-center my-1">
                                <img src="<%= newlyCreated.photo %>" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; margin-right: 10px;">
                                <div>
                                    <div style="font-size: 11px; font-weight: bold;"><%= newlyCreated.full_name %></div>
                                    <div style="font-size: 9px; color: #555;"><%= newlyCreated.position %></div>
                                    <div style="font-size: 8px;">ID: <%= newlyCreated.member_id %></div>
                                </div>
                            </div>
                            <div id="qrcode" style="margin: auto;"></div>
                            <div style="font-size: 7px; text-align: center;">User: <%= newlyCreated.username %> | Pass: <%= newlyCreated.tempPassword %></div>
                        </div>
                    </div>
                    <div class="col-md-6 d-flex flex-column justify-content-center">
                        <button onclick="window.print()" class="btn btn-success mb-2">🖨️ Print ID Card</button>
                        <a href="/admin/members" class="btn btn-secondary">Close & Return</a>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <script>
        new QRCode(document.getElementById("qrcode"), { text: "<%= newlyCreated.qr_token %>", width: 64, height: 64 });
    </script>
    <% } %>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>
`);

// 6. admin_attendance.ejs & 7. admin_reports.ejs & 8. admin_announcements.ejs & 9. admin_settings.ejs
fs.writeFileSync(path.join(viewsDir, 'admin_attendance.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Attendance Records</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
<body class="bg-light">
    <div class="container-fluid"><div class="row">
        <nav class="col-md-3 col-lg-2 bg-dark sidebar min-vh-100 p-3 text-white">
            <h4 class="text-center py-3"><%= settings.organization_name %></h4>
            <ul class="nav flex-column">
                <li class="nav-item mb-2"><a href="/admin" class="nav-link text-white">Dashboard</a></li>
                <li class="nav-item mb-2"><a href="/admin/members" class="nav-link text-white">Members</a></li>
                <li class="nav-item mb-2"><a href="/admin/attendance" class="nav-link text-white active">Attendance</a></li>
                <li class="nav-item mb-2"><a href="/admin/reports" class="nav-link text-white">Reports</a></li>
                <li class="nav-item mb-2"><a href="/admin/announcements" class="nav-link text-white">Announcements</a></li>
                <li class="nav-item mb-2"><a href="/admin/settings" class="nav-link text-white">Settings</a></li>
                <li class="nav-item mt-4"><a href="/admin/logout" class="nav-link text-danger">Logout</a></li>
            </ul>
        </nav>
        <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4">
            <h2>Attendance Logs</h2>
            <div class="card p-3 mt-3 shadow-sm">
                <table class="table table-sm">
                    <thead><tr><th>Date</th><th>Member ID</th><th>Name</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                    <tbody>
                        <% records.forEach(r => { %>
                            <tr><td><%= r.date %></td><td><%= r.member_id %></td><td><%= r.full_name %></td><td><%= r.time_in || '-' %></td><td><%= r.time_out || '-' %></td><td><span class="badge bg-<%= r.status==='Present'?'success':'warning' %>"><%= r.status %></span></td></tr>
                        <% }) %>
                    </tbody>
                </table>
            </div>
        </main>
    </div></div>
</body>
</html>
`);

fs.writeFileSync(path.join(viewsDir, 'admin_reports.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Reports</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
<body class="bg-light">
    <div class="container-fluid"><div class="row">
        <nav class="col-md-3 col-lg-2 bg-dark sidebar min-vh-100 p-3 text-white">
            <h4 class="text-center py-3"><%= settings.organization_name %></h4>
            <ul class="nav flex-column">
                <li class="nav-item mb-2"><a href="/admin" class="nav-link text-white">Dashboard</a></li>
                <li class="nav-item mb-2"><a href="/admin/members" class="nav-link text-white">Members</a></li>
                <li class="nav-item mb-2"><a href="/admin/attendance" class="nav-link text-white">Attendance</a></li>
                <li class="nav-item mb-2"><a href="/admin/reports" class="nav-link text-white active">Reports</a></li>
                <li class="nav-item mb-2"><a href="/admin/announcements" class="nav-link text-white">Announcements</a></li>
                <li class="nav-item mb-2"><a href="/admin/settings" class="nav-link text-white">Settings</a></li>
                <li class="nav-item mt-4"><a href="/admin/logout" class="nav-link text-danger">Logout</a></li>
            </ul>
        </nav>
        <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4">
            <h2>Organization Reports & Export</h2>
            <button onclick="window.print()" class="btn btn-secondary my-3">🖨️ Print / Save PDF Report</button>
            <div class="card p-3 shadow-sm">
                <table class="table table-bordered">
                    <thead><tr><th>Date</th><th>Name</th><th>Club</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                    <tbody>
                        <% records.forEach(r => { %>
                            <tr><td><%= r.date %></td><td><%= r.full_name %></td><td><%= r.club %></td><td><%= r.time_in %></td><td><%= r.time_out || '-' %></td><td><%= r.status %></td></tr>
                        <% }) %>
                    </tbody>
                </table>
            </div>
        </main>
    </div></div>
</body>
</html>
`);

fs.writeFileSync(path.join(viewsDir, 'admin_announcements.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Announcements</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
<body class="bg-light">
    <div class="container-fluid"><div class="row">
        <nav class="col-md-3 col-lg-2 bg-dark sidebar min-vh-100 p-3 text-white">
            <h4 class="text-center py-3"><%= settings.organization_name %></h4>
            <ul class="nav flex-column">
                <li class="nav-item mb-2"><a href="/admin" class="nav-link text-white">Dashboard</a></li>
                <li class="nav-item mb-2"><a href="/admin/members" class="nav-link text-white">Members</a></li>
                <li class="nav-item mb-2"><a href="/admin/attendance" class="nav-link text-white">Attendance</a></li>
                <li class="nav-item mb-2"><a href="/admin/reports" class="nav-link text-white">Reports</a></li>
                <li class="nav-item mb-2"><a href="/admin/announcements" class="nav-link text-white active">Announcements</a></li>
                <li class="nav-item mb-2"><a href="/admin/settings" class="nav-link text-white">Settings</a></li>
                <li class="nav-item mt-4"><a href="/admin/logout" class="nav-link text-danger">Logout</a></li>
            </ul>
        </nav>
        <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4">
            <h2>Announcements</h2>
            <form method="POST" action="/admin/announcements/add" class="card p-3 my-3 shadow-sm">
                <h5>Post New Announcement</h5>
                <div class="mb-2"><input type="text" name="title" class="form-control" placeholder="Title" required></div>
                <div class="mb-2"><textarea name="message" class="form-control" placeholder="Message content..." required></textarea></div>
                <button type="submit" class="btn btn-primary">Post Announcement</button>
            </form>
            <div class="list-group">
                <% announcements.forEach(a => { %>
                    <div class="list-group-item mb-2 shadow-sm"><h5><%= a.title %></h5><p><%= a.message %></p><small class="text-muted"><%= a.created_at %></small></div>
                <% }) %>
            </div>
        </main>
    </div></div>
</body>
</html>
`);

fs.writeFileSync(path.join(viewsDir, 'admin_settings.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Settings</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
<body class="bg-light">
    <div class="container-fluid"><div class="row">
        <nav class="col-md-3 col-lg-2 bg-dark sidebar min-vh-100 p-3 text-white">
            <h4 class="text-center py-3"><%= settings.organization_name %></h4>
            <ul class="nav flex-column">
                <li class="nav-item mb-2"><a href="/admin" class="nav-link text-white">Dashboard</a></li>
                <li class="nav-item mb-2"><a href="/admin/members" class="nav-link text-white">Members</a></li>
                <li class="nav-item mb-2"><a href="/admin/attendance" class="nav-link text-white">Attendance</a></li>
                <li class="nav-item mb-2"><a href="/admin/reports" class="nav-link text-white">Reports</a></li>
                <li class="nav-item mb-2"><a href="/admin/announcements" class="nav-link text-white">Announcements</a></li>
                <li class="nav-item mb-2"><a href="/admin/settings" class="nav-link text-white active">Settings</a></li>
                <li class="nav-item mt-4"><a href="/admin/logout" class="nav-link text-danger">Logout</a></li>
            </ul>
        </nav>
        <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4">
            <h2>System Settings</h2>
            <% if (success) { %> <div class="alert alert-success"><%= success %></div> <% } %>
            <form method="POST" action="/admin/settings" class="card p-4 shadow-sm">
                <div class="mb-3"><label>Organization Name</label><input type="text" name="organization_name" value="<%= settings.organization_name %>" class="form-control" required></div>
                <div class="mb-3"><label>School Name</label><input type="text" name="school_name" value="<%= settings.school_name %>" class="form-control" required></div>
                <div class="mb-3"><label>Attendance Start Time (HH:MM)</label><input type="text" name="attendance_start" value="<%= settings.attendance_start %>" class="form-control" required></div>
                <div class="mb-3"><label>Grace Period (Minutes)</label><input type="number" name="grace_period" value="<%= settings.grace_period %>" class="form-control" required></div>
                <div class="mb-3"><label>New Admin Password (leave blank to keep current)</label><input type="password" name="admin_password" class="form-control"></div>
                <button type="submit" class="btn btn-primary">Save Settings</button>
            </form>
        </main>
    </div></div>
</body>
</html>
`);

// 10. scanner.ejs
fs.writeFileSync(path.join(viewsDir, 'scanner.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Scanner Portal</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://unpkg.com/html5-qrcode"></script>
</head>
<body class="bg-dark text-white">
    <div class="container text-center py-4">
        <h2><%= settings.organization_name %> Scanner</h2>
        <div class="my-3">
            <div class="btn-group" role="group">
                <input type="radio" class="btn-check" name="scanMode" id="modeIn" value="TIME IN" checked>
                <label class="btn btn-outline-success" for="modeIn">TIME IN</label>
                <input type="radio" class="btn-check" name="scanMode" id="modeOut" value="TIME OUT">
                <label class="btn btn-outline-warning" for="modeOut">TIME OUT</label>
            </div>
        </div>
        <div id="reader" style="width: 300px; margin: auto;" class="rounded border"></div>
        <div id="resultBox" class="mt-4 p-3 rounded" style="display:none; max-width: 400px; margin: auto;"></div>
    </div>
    <audio id="successSound" src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg"></audio>
    <audio id="errorSound" src="https://actions.google.com/sounds/v1/alarms/bugle_tune.ogg"></audio>
    <script>
        function playSound(type) {
            if(type === 'success') document.getElementById('successSound').play();
            else document.getElementById('errorSound').play();
        }

        function onScanSuccess(decodedText) {
            const mode = document.querySelector('input[name="scanMode"]:checked').value;
            fetch('/scanner/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qr_token: decodedText, mode: mode })
            })
            .then(res => res.json())
            .then(data => {
                const box = document.getElementById('resultBox');
                box.style.display = 'block';
                if(data.success) {
                    playSound('success');
                    box.className = 'mt-4 p-3 rounded bg-success text-white';
                    box.innerHTML = '<h4>✓ ' + data.mode + ' SUCCESSFUL</h4><p>' + data.member.full_name + '<br>' + data.member.position + '<br>Time: ' + data.time + '</p>';
                } else {
                    playSound('error');
                    box.className = 'mt-4 p-3 rounded bg-danger text-white';
                    box.innerHTML = '<h4>✕ ' + data.error + '</h4><p>' + data.message + '</p>';
                }
                setTimeout(() => { box.style.display = 'none'; }, 4000);
            });
        }

        const html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess);
    </script>
</body>
</html>
`);

// 11. member_dashboard.ejs
fs.writeFileSync(path.join(viewsDir, 'member_dashboard.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Member Portal</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head>
<body class="bg-light">
    <div class="container py-4">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2>Welcome, <%= member.full_name %></h2>
            <a href="/member/logout" class="btn btn-outline-danger">Logout</a>
        </div>
        <div class="row">
            <div class="col-md-4">
                <div class="card p-3 shadow-sm text-center">
                    <img src="<%= member.photo %>" class="rounded-circle mx-auto mb-3" style="width: 100px; height: 100px; object-fit: cover;">
                    <h5><%= member.full_name %></h5>
                    <p class="text-muted"><%= member.position %> | <%= member.member_id %></p>
                    <hr>
                    <p class="mb-1"><strong>Username:</strong> <code><%= member.username %></code></p>
                </div>
            </div>
            <div class="col-md-8">
                <div class="card p-3 shadow-sm mb-4">
                    <h5>Attendance History</h5>
                    <table class="table table-sm">
                        <thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                        <tbody>
                            <% attendance.forEach(a => { %>
                                <tr><td><%= a.date %></td><td><%= a.time_in || '-' %></td><td><%= a.time_out || '-' %></td><td><span class="badge bg-<%= a.status==='Present'?'success':'warning' %>"><%= a.status %></span></td></tr>
                            <% }) %>
                        </tbody>
                    </table>
                </div>
                <div class="card p-3 shadow-sm">
                    <h5>Announcements</h5>
                    <% announcements.forEach(an => { %>
                        <div class="border-bottom pb-2 mb-2"><h6><%= an.title %></h6><p class="small mb-0"><%= an.message %></p></div>
                    <% }) %>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
`);

// Start Server
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`School Club QR Attendance System is running!`);
    console.log(`Local Access: http://localhost:${PORT}`);
    console.log(`Admin Portal: http://localhost:${PORT}/admin/login`);
    console.log(`Scanner Portal: http://localhost:${PORT}/scanner`);
    console.log(`Member Portal: http://localhost:${PORT}/member/login`);
    console.log(`==================================================`);
});
