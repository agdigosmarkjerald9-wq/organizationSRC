/*************************************************************
 * SCHOOL CLUB QR CODE ATTENDANCE SYSTEM - ALL-IN-ONE APP.JS
 *********************************----------------************/
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });

// Configure Multer for Member Photos
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './public/uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'member-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only .png, .jpg and .jpeg format allowed!'));
    }
});

// Initialize SQLite Database
const dbFile = './data/attendance.db';
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Database opening error: ', err.message);
    } else {
        console.log('Connected to SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            member_id TEXT UNIQUE,
            name TEXT,
            position TEXT,
            email TEXT,
            contact TEXT,
            photo TEXT DEFAULT 'default.png',
            username TEXT UNIQUE,
            password TEXT,
            temporary_password TEXT,
            qr_token TEXT,
            status TEXT DEFAULT 'Active',
            is_temp_pass INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            member_id TEXT,
            scan_type TEXT,
            date TEXT,
            time TEXT,
            timestamp DATETIME,
            scanner_device TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS clubs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            club_name TEXT,
            school_name TEXT,
            school_year TEXT,
            adviser TEXT,
            logo TEXT,
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

        // Insert default club configuration if missing
        db.get(`SELECT COUNT(*) as count FROM clubs`, (err, row) => {
            if (row && row.count === 0) {
                db.run(`INSERT INTO clubs (club_name, school_name, school_year, adviser) 
                        VALUES ('Supreme Student Council', 'National High School', '2026-2027', 'Dr. Maria Santos')`);
            }
        });

        // Insert default admin account if missing (admin / Admin123!)
        db.get(`SELECT COUNT(*) as count FROM users WHERE position = 'Administrator'`, async (err, row) => {
            if (row && row.count === 0) {
                const hashedPass = await bcrypt.hash('Admin123!', 10);
                db.run(`INSERT INTO users (member_id, name, position, username, password, temporary_password, status, is_temp_pass) 
                        VALUES ('ADMIN-001', 'System Administrator', 'Administrator', 'admin', ?, '', 'Active', 0)`, [hashedPass]);
            }
        });
    });
}

// Middleware setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function logActivity(username, action) {
    db.run(`INSERT INTO activity_logs (username, action) VALUES (?, ?)`, [username || 'System', action]);
}

// --- AUTHENTICATION MIDDLEWARES ---
function requireAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.position === 'Administrator') {
        return next();
    }
    res.redirect('/admin/login');
}

function requireMember(req, res, next) {
    if (req.session && req.session.user && req.session.user.position !== 'Administrator') {
        return next();
    }
    res.redirect('/member/login');
}

// ==========================================
// LANDING PAGE (PORTAL SELECTOR)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>School Club Attendance System</title>
            <style>
                :root { --primary: #4f46e5; --bg: #f8fafc; --text: #1e293b; }
                body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { text-align: center; max-width: 600px; padding: 40px; background: white; border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); width: 90%; }
                h1 { margin-bottom: 10px; color: var(--primary); font-size: 28px; }
                p { color: #64748b; margin-bottom: 30px; }
                .portal-grid { display: grid; grid-template-columns: 1fr; gap: 15px; }
                @media(min-width: 600px) { .portal-grid { grid-template-columns: repeat(3, 1fr); } }
                .btn { display: block; padding: 16px 20px; background: var(--primary); color: white; text-decoration: none; border-radius: 10px; font-weight: 600; transition: transform 0.2s, background 0.2s; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2); }
                .btn:hover { background: #4338ca; transform: translateY(-2px); }
                .btn-scanner { background: #059669; box-shadow: 0 4px 6px -1px rgba(5, 150, 105, 0.2); }
                .btn-scanner:hover { background: #047857; }
                .btn-member { background: #d97706; box-shadow: 0 4px 6px -1px rgba(217, 119, 6, 0.2); }
                .btn-member:hover { background: #b45309; }
                .footer { margin-top: 30px; font-size: 13px; color: #94a3b8; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>School Club Attendance</h1>
                <p>Select your portal to proceed to the system.</p>
                <div class="portal-grid">
                    <a href="/admin" class="btn">Admin Portal</a>
                    <a href="/scanner" class="btn btn-scanner">QR Scanner</a>
                    <a href="/member" class="btn btn-member">Member Portal</a>
                </div>
                <div class="footer">Secure QR-Based Club Management System</div>
            </div>
        </body>
        </html>
    `);
});

// ==========================================
// ADMIN PORTAL & AUTH
// ==========================================
app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Admin Login</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #f1f5f9; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); width: 100%; max-width: 400px; }
            h2 { margin-top: 0; color: #1e293b; }
            label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 14px; }
            input { width: 100%; padding: 12px; margin-bottom: 20px; border: 1px solid #cbd5e1; border-radius: 8px; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; }
            button:hover { background: #4338ca; }
            .error { background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 6px; margin-bottom: 15px; font-size: 14px; }
        </style>
        </head>
        <body>
            <div class="card">
                <h2>Admin Login</h2>
                ${req.query.error ? `<div class="error">${req.query.error}</div>` : ''}
                <form action="/admin/login" method="POST">
                    <label>Username</label><input type="text" name="username" required autocomplete="username">
                    <label>Password</label><input type="password" name="password" required autocomplete="current-password">
                    <button type="submit">Login</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND position = 'Administrator'`, [username], async (err, user) => {
        if (err || !user || !(await bcrypt.compare(password, user.password))) {
            return res.redirect('/admin/login?error=Invalid+Username+or+Password');
        }
        req.session.user = user;
        logActivity(user.username, 'Admin logged in');
        res.redirect('/admin');
    });
});

app.get('/admin/logout', (req, res) => {
    if (req.session.user) logActivity(req.session.user.username, 'Admin logged out');
    req.session.destroy(() => res.redirect('/admin/login'));
});

// Admin Dashboard and Management
app.get('/admin', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM clubs LIMIT 1`, (err, club) => {
        db.all(`SELECT * FROM users WHERE position != 'Administrator' ORDER BY id DESC`, (err, members) => {
            db.all(`SELECT * FROM announcements ORDER BY id DESC`, (err, announcements) => {
                db.all(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT 50`, (err, logs) => {
                    db.all(`SELECT a.*, u.name, u.position FROM attendance a JOIN users u ON a.member_id = u.member_id ORDER BY a.id DESC LIMIT 100`, (err, attendance) => {
                        
                        const today = new Date().toISOString().split('T')[0];
                        db.all(`SELECT DISTINCT member_id FROM attendance WHERE date = ? AND scan_type = 'TIME IN'`, [today], (err, presentRows) => {
                            const presentCount = presentRows ? presentRows.length : 0;
                            const totalMembers = members ? members.length : 0;
                            const absentCount = Math.max(0, totalMembers - presentCount);

                            res.send(renderAdminHTML({
                                club, members, announcements, logs, attendance, presentCount, absentCount, totalMembers
                            }));
                        });
                    });
                });
            });
        });
    });
});

function renderAdminHTML(data) {
    const { club, members, announcements, logs, attendance, presentCount, absentCount, totalMembers } = data;
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Dashboard - ${club ? club.club_name : 'Club System'}</title>
        <style>
            :root { --primary: #4f46e5; --bg: #f8fafc; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; }
            body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; display: flex; flex-direction: column; min-height: 100vh; }
            header { background: var(--primary); color: white; padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; }
            header h1 { margin: 0; font-size: 20px; }
            .nav-links a { color: white; text-decoration: none; margin-left: 20px; font-weight: 500; font-size: 14px; }
            .container { padding: 30px; max-width: 1400px; margin: 0 auto; width: 100%; box-sizing: border-box; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
            .stat-card { background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid var(--border); }
            .stat-card h3 { margin: 0 0 10px; font-size: 14px; color: #64748b; }
            .stat-card .val { font-size: 28px; font-weight: bold; color: var(--primary); }
            .section { background: var(--card); border-radius: 12px; padding: 25px; margin-bottom: 30px; border: 1px solid var(--border); }
            h2 { margin-top: 0; font-size: 18px; border-bottom: 2px solid var(--border); padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid var(--border); }
            th { background: #f1f5f9; font-weight: 600; }
            .btn { background: var(--primary); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; text-decoration: none; display: inline-block; font-size: 13px; }
            .btn:hover { background: #4338ca; }
            .btn-danger { background: #dc2626; } .btn-danger:hover { background: #b91c1c; }
            .btn-success { background: #059669; } .btn-success:hover { background: #047857; }
            form input, form select, form textarea { width: 100%; padding: 10px; margin-bottom: 15px; border: 1px solid var(--border); border-radius: 6px; box-sizing: border-box; }
            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            @media(max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
            .badge { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
            .badge-active { background: #d1fae5; color: #065f46; }
            .badge-disabled { background: #fee2e2; color: #991b1b; }
            .avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; vertical-align: middle; margin-right: 8px; }
        </style>
    </head>
    <body>
        <header>
            <h1>Admin Portal - ${club ? club.club_name : 'Club System'}</h1>
            <div class="nav-links">
                <a href="/scanner" target="_blank">Open Scanner</a>
                <a href="/admin/backup" class="btn-success" style="padding:6px 12px; border-radius:4px;">Backup DB</a>
                <a href="/admin/logout">Logout</a>
            </div>
        </header>

        <div class="container">
            <div class="stats-grid">
                <div class="stat-card"><h3>Total Members</h3><div class="val">${totalMembers}</div></div>
                <div class="stat-card"><h3>Present Today</h3><div class="val" style="color:#059669;">${presentCount}</div></div>
                <div class="stat-card"><h3>Absent Today</h3><div class="val" style="color:#dc2626;">${absentCount}</div></div>
                <div class="stat-card"><h3>Attendance Rate</h3><div class="val">${totalMembers > 0 ? Math.round((presentCount/totalMembers)*100) : 0}%</div></div>
            </div>

            <div class="grid-2">
                <!-- Add Member Form with Photo Upload -->
                <div class="section">
                    <h2>Add New Member</h2>
                    <form action="/admin/member/add" method="POST" enctype="multipart/form-data">
                        <label>Full Name</label>
                        <input type="text" name="name" required placeholder="Juan Dela Cruz">
                        
                        <label>Position</label>
                        <select name="position">
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

                        <label>Member Photo (JPG/PNG)</label>
                        <input type="file" name="photo" accept="image/*">

                        <label>Email (Optional)</label>
                        <input type="email" name="email" placeholder="juan@example.com">

                        <label>Contact Number (Optional)</label>
                        <input type="text" name="contact" placeholder="09123456789">

                        <button type="submit" class="btn">Create Member</button>
                    </form>
                </div>

                <!-- Club Settings & Announcements Creator -->
                <div>
                    <div class="section">
                        <h2>Post Announcement</h2>
                        <form action="/admin/announcement/add" method="POST">
                            <label>Title</label>
                            <input type="text" name="title" required placeholder="Meeting Reminder">
                            <label>Message</label>
                            <textarea name="message" rows="3" required placeholder="General meeting this Friday at 3 PM..."></textarea>
                            <button type="submit" class="btn btn-success">Publish Announcement</button>
                        </form>
                    </div>

                    <div class="section">
                        <h2>Club Configuration</h2>
                        <form action="/admin/settings/update" method="POST">
                            <label>School Name</label>
                            <input type="text" name="school_name" value="${club ? club.school_name : ''}" required>
                            <label>Club Name</label>
                            <input type="text" name="club_name" value="${club ? club.club_name : ''}" required>
                            <label>School Year</label>
                            <input type="text" name="school_year" value="${club ? club.school_year : ''}" required>
                            <label>Adviser Name</label>
                            <input type="text" name="adviser" value="${club ? club.adviser : ''}" required>
                            <button type="submit" class="btn">Save Settings</button>
                        </form>
                    </div>
                </div>
            </div>

            <!-- Members Management Table -->
            <div class="section">
                <h2>Members Management 
                    <a href="/admin/members/all-ids" target="_blank" class="btn btn-success" style="font-size:12px;">Generate All ID Cards</a>
                </h2>
                <div style="overflow-x:auto;">
                    <table>
                        <thead>
                            <tr>
                                <th>Photo</th>
                                <th>Member ID</th>
                                <th>Name</th>
                                <th>Position</th>
                                <th>Username</th>
                                <th>Temp Password</th>
                                <th>Status</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${members.map(m => `
                                <tr>
                                    <td><img src="/public/uploads/${m.photo || 'default.png'}" class="avatar" onerror="this.src='/public/uploads/default.png'"></td>
                                    <td><strong>${m.member_id}</strong></td>
                                    <td>${m.name}</td>
                                    <td>${m.position}</td>
                                    <td><code>${m.username}</code></td>
                                    <td><code>${m.temporary_password || 'Changed'}</code></td>
                                    <td><span class="badge ${m.status === 'Active' ? 'badge-active' : 'badge-disabled'}">${m.status}</span></td>
                                    <td>
                                        <a href="/admin/member/id/${m.id}" target="_blank" class="btn" style="padding:4px 8px; font-size:11px;">ID Card</a>
                                        <a href="/admin/member/qr/${m.id}" target="_blank" class="btn btn-success" style="padding:4px 8px; font-size:11px;">QR</a>
                                        <a href="/admin/member/toggle/${m.id}" class="btn ${m.status === 'Active' ? 'btn-danger' : 'btn-success'}" style="padding:4px 8px; font-size:11px;">${m.status === 'Active' ? 'Disable' : 'Enable'}</a>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Attendance Logs Table -->
            <div class="section">
                <h2>Live Attendance Logs
                    <a href="/admin/attendance/export" class="btn btn-success" style="font-size:12px;">Export CSV Report</a>
                </h2>
                <div style="overflow-x:auto;">
                    <table>
                        <thead>
                            <tr>
                                <th>Member ID</th>
                                <th>Name</th>
                                <th>Position</th>
                                <th>Scan Type</th>
                                <th>Date</th>
                                <th>Time</th>
                                <th>Scanner</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${attendance.map(a => `
                                <tr>
                                    <td>${a.member_id}</td>
                                    <td>${a.name}</td>
                                    <td>${a.position}</td>
                                    <td><strong><span style="color:${a.scan_type === 'TIME IN' ? '#059669' : '#d97706'}">${a.scan_type}</span></strong></td>
                                    <td>${a.date}</td>
                                    <td>${a.time}</td>
                                    <td>${a.scanner_device}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- System Activity Logs -->
            <div class="section">
                <h2>System Activity Logs</h2>
                <div style="max-height:200px; overflow-y:auto;">
                    <table>
                        <thead><tr><th>User</th><th>Action</th><th>Timestamp</th></tr></thead>
                        <tbody>
                            ${logs.map(l => `<tr><td>${l.username}</td><td>${l.action}</td><td>${l.timestamp}</td></tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </body>
    </html>
    `;
}

// Admin Actions
app.post('/admin/member/add', requireAdmin, upload.single('photo'), (req, res) => {
    const { name, position, email, contact } = req.body;
    const photoFilename = req.file ? req.file.filename : 'default.png';
    
    db.get(`SELECT COUNT(*) as count FROM users`, async (err, row) => {
        const seq = (row ? row.count : 0) + 1;
        const member_id = `CLUB-2026-${String(seq).padStart(4, '0')}`;
        const username = `member${String(seq).padStart(4, '0')}`;
        
        const temp_pass = Math.random().toString(36).substring(2, 10);
        const hashedPass = await bcrypt.hash(temp_pass, 10);
        const qr_token = crypto.randomBytes(16).toString('hex');

        db.run(`INSERT INTO users (member_id, name, position, email, contact, photo, username, password, temporary_password, qr_token, status, is_temp_pass) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 1)`,
            [member_id, name, position, email, contact, photoFilename, username, hashedPass, temp_pass, qr_token], (err) => {
                if (err) return res.send('Error adding member: ' + err.message);
                logActivity(req.session.user.username, `Created member ${name} (${member_id})`);
                res.redirect('/admin');
            });
    });
});

app.post('/admin/announcement/add', requireAdmin, (req, res) => {
    const { title, message } = req.body;
    db.run(`INSERT INTO announcements (title, message) VALUES (?, ?)`, [title, message], () => {
        logActivity(req.session.user.username, `Published announcement: ${title}`);
        res.redirect('/admin');
    });
});

app.get('/admin/member/toggle/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, member) => {
        if (!member) return res.redirect('/admin');
        const newStatus = member.status === 'Active' ? 'Disabled' : 'Active';
        db.run(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, req.params.id], () => {
            logActivity(req.session.user.username, `Changed member ${member.name} status to ${newStatus}`);
            res.redirect('/admin');
        });
    });
});

app.post('/admin/settings/update', requireAdmin, (req, res) => {
    const { school_name, club_name, school_year, adviser } = req.body;
    db.run(`UPDATE clubs SET school_name = ?, club_name = ?, school_year = ?, adviser = ? WHERE id = 1`,
        [school_name, club_name, school_year, adviser], () => {
            logActivity(req.session.user.username, 'Updated club settings');
            res.redirect('/admin');
        });
});

app.get('/admin/backup', requireAdmin, (req, res) => {
    logActivity(req.session.user.username, 'Downloaded database backup');
    res.download(dbFile);
});

app.get('/admin/attendance/export', requireAdmin, (req, res) => {
    db.all(`SELECT a.member_id, u.name, u.position, a.scan_type, a.date, a.time, a.scanner_device FROM attendance a JOIN users u ON a.member_id = u.member_id ORDER BY a.id DESC`, (err, rows) => {
        let csv = 'Member ID,Name,Position,Scan Type,Date,Time,Scanner Device\n';
        rows.forEach(r => {
            csv += `"${r.member_id}","${r.name}","${r.position}","${r.scan_type}","${r.date}","${r.time}","${r.scanner_device}"\n`;
        });
        logActivity(req.session.user.username, 'Exported attendance CSV report');
        res.header('Content-Type', 'text/csv');
        res.attachment('attendance_report.csv');
        res.send(csv);
    });
});

// Printable ID Card including Member Photo
app.get('/admin/member/id/:id', requireAdmin, (req, res) => {
    db.get(`SELECT u.*, c.* FROM users u CROSS JOIN clubs c WHERE u.id = ?`, [req.params.id], async (err, row) => {
        if (!row) return res.send('Member not found.');
        const qrData = `CLUBATTENDANCE:MEMBER:${row.qr_token}`;
        const qrDataURL = await QRCode.toDataURL(qrData);

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head><meta charset="UTF-8"><title>ID Card - ${row.name}</title>
            <style>
                body { font-family: sans-serif; background: #e2e8f0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .id-card { width: 85.60mm; height: 53.98mm; background: white; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.15); padding: 12px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; border: 2px solid #4f46e5; }
                .header { text-align: center; border-bottom: 2px solid #4f46e5; padding-bottom: 3px; }
                .header h3 { margin: 0; font-size: 10px; color: #4f46e5; text-transform: uppercase; }
                .header h4 { margin: 2px 0 0; font-size: 8px; color: #64748b; }
                .body { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
                .photo { width: 65px; height: 65px; border-radius: 50%; object-fit: cover; border: 2px solid #4f46e5; margin-right: 10px; }
                .info { font-size: 9px; line-height: 1.3; flex: 1; }
                .info strong { color: #1e293b; }
                .qr img { width: 75px; height: 75px; }
                .footer { font-size: 6px; text-align: center; color: #dc2626; border-top: 1px solid #cbd5e1; padding-top: 2px; }
                .no-print { margin-top: 20px; }
                .btn { padding: 10px 20px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; text-decoration: none; }
                @media print { body { background: none; } .no-print { display: none; } }
            </style>
            </head>
            <body>
                <div class="id-card">
                    <div class="header">
                        <h3>${row.school_name}</h3>
                        <h4>${row.club_name}</h4>
                    </div>
                    <div class="body">
                        <img src="/public/uploads/${row.photo || 'default.png'}" class="photo" onerror="this.src='/public/uploads/default.png'">
                        <div class="info">
                            <div><strong>${row.name}</strong></div>
                            <div>${row.position}</div>
                            <div><strong>ID:</strong> ${row.member_id}</div>
                            <div><strong>User:</strong> ${row.username}</div>
                            <div><strong>Temp Pass:</strong> ${row.temporary_password || 'Changed'}</div>
                        </div>
                        <div class="qr"><img src="${qrDataURL}" alt="QR"></div>
                    </div>
                    <div class="footer">Change temporary password after login.</div>
                </div>
                <div class="no-print"><button class="btn" onclick="window.print()">Print ID Card</button></div>
            </body>
            </html>
        `);
    });
});

app.get('/admin/members/all-ids', requireAdmin, (req, res) => {
    db.all(`SELECT u.*, c.* FROM users u CROSS JOIN clubs c WHERE u.position != 'Administrator'`, async (err, rows) => {
        let cardsHTML = '';
        for (const row of rows) {
            const qrData = `CLUBATTENDANCE:MEMBER:${row.qr_token}`;
            const qrDataURL = await QRCode.toDataURL(qrData);
            cardsHTML += `
                <div class="id-card">
                    <div class="header">
                        <h3>${row.school_name}</h3>
                        <h4>${row.club_name}</h4>
                    </div>
                    <div class="body">
                        <img src="/public/uploads/${row.photo || 'default.png'}" class="photo" onerror="this.src='/public/uploads/default.png'">
                        <div class="info">
                            <div><strong>${row.name}</strong></div>
                            <div>${row.position}</div>
                            <div><strong>ID:</strong> ${row.member_id}</div>
                            <div><strong>User:</strong> ${row.username}</div>
                            <div><strong>Temp Pass:</strong> ${row.temporary_password || 'Changed'}</div>
                        </div>
                        <div class="qr"><img src="${qrDataURL}" alt="QR"></div>
                    </div>
                    <div class="footer">Change temporary password after login.</div>
                </div>
            `;
        }

        res.send(`
            <!DOCTYPE html>
            <html><head><title>All Member IDs</title>
            <style>
                body { background: #cbd5e1; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; margin: 0; padding: 20px; }
                .id-card { width: 85.60mm; height: 53.98mm; background: white; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.15); padding: 12px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: space-between; border: 2px solid #4f46e5; margin-bottom: 20px; page-break-inside: avoid; }
                .header { text-align: center; border-bottom: 2px solid #4f46e5; padding-bottom: 3px; }
                .header h3 { margin: 0; font-size: 10px; color: #4f46e5; }
                .header h4 { margin: 2px 0 0; font-size: 8px; color: #64748b; }
                .body { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
                .photo { width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid #4f46e5; margin-right: 8px; }
                .info { font-size: 9px; line-height: 1.3; flex: 1; }
                .qr img { width: 70px; height: 70px; }
                .footer { font-size: 6px; text-align: center; color: #dc2626; border-top: 1px solid #ccc; padding-top: 2px; }
                .no-print { margin-bottom: 20px; }
                .btn { padding: 10px 20px; background: #4f46e5; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
                @media print { .no-print { display: none; } body { background: white; padding: 0; } }
            </style></head>
            <body>
                <div class="no-print"><button class="btn" onclick="window.print()">Print All ID Cards</button></div>
                ${cardsHTML}
            </body></html>
        `);
    });
});

app.get('/admin/member/qr/:id', requireAdmin, (req, res) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], async (err, row) => {
        if (!row) return res.send('Member not found.');
        const qrDataURL = await QRCode.toDataURL(`CLUBATTENDANCE:MEMBER:${row.qr_token}`);
        res.send(`
            <div style="text-align:center; padding:50px; font-family:sans-serif;">
                <h2>${row.name} (${row.member_id})</h2>
                <img src="${qrDataURL}" style="width:250px;height:250px; border:2px solid #333; padding:10px; border-radius:8px;">
                <br><br><a href="/admin" style="padding:10px 20px; background:#4f46e5; color:white; text-decoration:none; border-radius:6px;">Back to Dashboard</a>
            </div>
        `);
    });
});

// ==========================================
// SEPARATE QR SCANNER PORTAL (/scanner)
// ==========================================
app.get('/scanner', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QR Scanner Portal</title>
            <script src="https://unpkg.com/html5-qrcode"></script>
            <style>
                body { font-family: system-ui, sans-serif; background: #0f172a; color: white; margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; box-sizing: border-box; }
                h1 { font-size: 22px; margin-bottom: 10px; color: #38bdf8; text-align: center; }
                .controls { display: flex; gap: 10px; margin-bottom: 20px; width: 100%; max-width: 400px; }
                .mode-btn { flex: 1; padding: 14px; border: none; border-radius: 8px; font-weight: bold; font-size: 16px; cursor: pointer; background: #334155; color: #94a3b8; }
                .mode-btn.active-in { background: #059669; color: white; }
                .mode-btn.active-out { background: #d97706; color: white; }
                #reader { width: 100%; max-width: 400px; background: #1e293b; border-radius: 12px; overflow: hidden; border: 2px solid #334155; }
                .result-box { margin-top: 20px; width: 100%; max-width: 400px; padding: 20px; border-radius: 12px; text-align: center; background: #1e293b; display: none; box-sizing: border-box; }
                .success { border: 2px solid #059669; background: #064e3b; }
                .error { border: 2px solid #dc2626; background: #7f1d1d; }
                .sound-toggle { margin-top: 15px; font-size: 14px; color: #94a3b8; cursor: pointer; }
            </style>
        </head>
        <body>
            <h1>Club Attendance Scanner</h1>
            <div class="controls">
                <button id="btnIn" class="mode-btn active-in" onclick="setScanMode('TIME IN')">TIME IN</button>
                <button id="btnOut" class="mode-btn" onclick="setScanMode('TIME OUT')">TIME OUT</button>
            </div>
            <div id="reader"></div>
            <div id="resultBox" class="result-box">
                <h2 id="resTitle" style="margin:0 0 10px; font-size:20px;"></h2>
                <p id="resName" style="font-size:18px; font-weight:bold; margin:5px 0;"></p>
                <p id="resDetails" style="font-size:14px; color:#cbd5e1; margin:5px 0;"></p>
                <p id="resTime" style="font-size:16px; font-weight:bold; margin-top:10px;"></p>
            </div>
            <div class="sound-toggle" onclick="toggleSound()">
                <input type="checkbox" id="soundCheck" checked> Sound Effects: <span id="soundStatus">ON</span>
            </div>
            <script>
                let currentMode = 'TIME IN';
                let soundEnabled = true;

                function setScanMode(mode) {
                    currentMode = mode;
                    document.getElementById('btnIn').className = mode === 'TIME IN' ? 'mode-btn active-in' : 'mode-btn';
                    document.getElementById('btnOut').className = mode === 'TIME OUT' ? 'mode-btn active-out' : 'mode-btn';
                }

                function toggleSound() {
                    soundEnabled = !soundEnabled;
                    document.getElementById('soundCheck').checked = soundEnabled;
                    document.getElementById('soundStatus').innerText = soundEnabled ? 'ON' : 'OFF';
                }

                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                function playTone(type) {
                    if (!soundEnabled) return;
                    if (audioCtx.state === 'suspended') audioCtx.resume();
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.connect(gain);
                    gain.connect(audioCtx.destination);
                    if (type === 'success') {
                        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
                        osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.1);
                        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
                        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
                        osc.start(); osc.stop(audioCtx.currentTime + 0.3);
                    } else {
                        osc.type = 'sawtooth';
                        osc.frequency.setValueAtTime(200, audioCtx.currentTime);
                        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
                        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
                        osc.start(); osc.stop(audioCtx.currentTime + 0.4);
                    }
                }

                function onScanSuccess(decodedText) {
                    fetch('/api/scan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ qr_data: decodedText, scan_type: currentMode, scanner: 'Mobile Camera' })
                    })
                    .then(res => res.json())
                    .then(data => {
                        const box = document.getElementById('resultBox');
                        box.style.display = 'block';
                        if (data.status === 'success') {
                            box.className = 'result-box success';
                            document.getElementById('resTitle').innerText = '✓ ATTENDANCE RECORDED';
                            document.getElementById('resName').innerText = data.member.name;
                            document.getElementById('resDetails').innerText = data.member.position + ' (' + data.member.member_id + ')';
                            document.getElementById('resTime').innerText = data.scan_type + ' - ' + data.time;
                            playTone('success');
                        } else {
                            box.className = 'result-box error';
                            document.getElementById('resTitle').innerText = '✕ REJECTED';
                            document.getElementById('resName').innerText = 'Invalid Scan';
                            document.getElementById('resDetails').innerText = data.message;
                            document.getElementById('resTime').innerText = '';
                            playTone('error');
                        }
                        setTimeout(() => { box.style.display = 'none'; }, 4000);
                    });
                }
                const scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
                scanner.render(onScanSuccess, (err) => {});
            </script>
        </body>
        </html>
    `);
});

app.post('/api/scan', (req, res) => {
    const { qr_data, scan_type, scanner } = req.body;
    if (!qr_data || !qr_data.startsWith('CLUBATTENDANCE:MEMBER:')) {
        return res.json({ status: 'error', message: 'Unregistered QR code format.' });
    }
    const token = qr_data.split(':')[2];
    db.get(`SELECT * FROM users WHERE qr_token = ?`, [token], (err, member) => {
        if (!member || member.status !== 'Active') {
            return res.json({ status: 'error', message: 'Member not found or disabled.' });
        }
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        db.get(`SELECT * FROM attendance WHERE member_id = ? AND date = ? AND scan_type = ?`, 
            [member.member_id, dateStr, scan_type], (err, existing) => {
            if (existing) {
                return res.json({ status: 'error', message: `${member.name} already recorded ${scan_type} today.` });
            }
            db.run(`INSERT INTO attendance (member_id, scan_type, date, time, timestamp, scanner_device) VALUES (?, ?, ?, ?, datetime('now'), ?)`,
                [member.member_id, scan_type, dateStr, timeStr, scanner], () => {
                    logActivity(member.username, `Recorded ${scan_type} via scanner`);
                    res.json({ status: 'success', scan_type, time: timeStr, member: { name: member.name, position: member.position, member_id: member.member_id } });
                });
        });
    });
});

// ==========================================
// MEMBER PORTAL (/member)
// ==========================================
app.get('/member/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>Member Login</title>
        <style>body{font-family:sans-serif;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.box{background:white;padding:40px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.05);width:100%;max-width:380px}input{width:100%;padding:12px;margin-bottom:15px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box}button{width:100%;padding:12px;background:#d97706;color:white;border:none;border-radius:8px;font-weight:bold;cursor:pointer}.error{background:#fee2e2;color:#991b1b;padding:10px;border-radius:6px;margin-bottom:15px;font-size:14px;}</style>
        </head>
        <body>
        <div class="box">
            <h2>Member Portal Login</h2>
            ${req.query.error ? `<div class="error">${req.query.error}</div>` : ''}
            <form method="POST" action="/member/login">
                <label>Username</label><input type="text" name="username" required autocomplete="username">
                <label>Password</label><input type="password" name="password" required autocomplete="current-password">
                <button type="submit">Login</button>
            </form>
        </div>
        </body></html>
    `);
});

app.post('/member/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND position != 'Administrator'`, [username], async (err, user) => {
        if (err || !user || !(await bcrypt.compare(password, user.password))) {
            return res.redirect('/member/login?error=Invalid+Credentials');
        }
        req.session.user = user;
        if (user.is_temp_pass === 1) return res.redirect('/member/force-change-password');
        res.redirect('/member');
    });
});

app.get('/member/force-change-password', requireMember, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>Change Temp Password</title>
        <style>body{font-family:sans-serif;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.box{background:white;padding:30px;border-radius:10px;box-shadow:0 4px 10px rgba(0,0,0,0.05);width:350px}input{width:100%;padding:10px;margin-bottom:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}button{width:100%;padding:10px;background:#d97706;color:white;border:none;border-radius:6px;font-weight:bold;cursor:pointer}</style>
        </head>
        <body>
        <div class="box">
            <h3>Change Temporary Password</h3>
            <form method="POST" action="/member/force-change-password">
                <label>New Password</label><input type="password" name="new_password" required minlength="6">
                <button type="submit">Update Password</button>
            </form>
        </div>
        </body></html>
    `);
});

app.post('/member/force-change-password', requireMember, async (req, res) => {
    const { new_password } = req.body;
    const hashed = await bcrypt.hash(new_password, 10);
    db.run(`UPDATE users SET password = ?, temporary_password = '', is_temp_pass = 0 WHERE id = ?`, [hashed, req.session.user.id], () => {
        res.redirect('/member');
    });
});

app.get('/member/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/member/login'));
});

app.get('/member', requireMember, (req, res) => {
    const user = req.session.user;
    db.all(`SELECT * FROM attendance WHERE member_id = ? ORDER BY id DESC LIMIT 20`, [user.member_id], (err, attendance) => {
        db.all(`SELECT * FROM announcements ORDER BY id DESC LIMIT 5`, (err, announcements) => {
            QRCode.toDataURL(`CLUBATTENDANCE:MEMBER:${user.qr_token}`, (err, qrDataURL) => {
                db.get(`SELECT COUNT(DISTINCT date) as present FROM attendance WHERE member_id = ? AND scan_type = 'TIME IN'`, [user.member_id], (err, statRow) => {
                    const presentCount = statRow ? statRow.present : 0;

                    res.send(`
                        <!DOCTYPE html>
                        <html lang="en">
                        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Member Portal</title>
                        <style>
                            body { font-family: system-ui, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; }
                            header { background: #d97706; color: white; padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; }
                            header h1 { margin: 0; font-size: 20px; }
                            .container { max-width: 1000px; margin: 30px auto; padding: 0 20px; box-sizing: border-box; }
                            .card { background: white; border-radius: 12px; padding: 25px; margin-bottom: 25px; border: 1px solid #e2e8f0; }
                            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                            @media(max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
                            table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
                            th, td { padding: 10px; text-align: left; border-bottom: 1px solid #e2e8f0; }
                            th { background: #f1f5f9; }
                            .avatar { width: 90px; height: 90px; border-radius: 50%; object-fit: cover; border: 3px solid #d97706; margin-bottom: 10px; }
                            .btn { background: #d97706; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 500; display: inline-block; }
                        </style>
                        </head>
                        <body>
                            <header>
                                <h1>Member Portal</h1>
                                <div><a href="/member/logout" style="color:white; text-decoration:none; font-weight:bold;">Logout</a></div>
                            </header>
                            <div class="container">
                                <div class="grid-2">
                                    <div class="card" style="text-align:center;">
                                        <img src="/public/uploads/${user.photo || 'default.png'}" class="avatar" onerror="this.src='/public/uploads/default.png'">
                                        <h2>${user.name}</h2>
                                        <p><strong>Position:</strong> ${user.position}</p>
                                        <p><strong>Member ID:</strong> ${user.member_id}</p>
                                        <p><strong>Days Present:</strong> ${presentCount}</p>
                                        <a href="/admin/member/id/${user.id}" target="_blank" class="btn">View ID Card</a>
                                    </div>
                                    <div class="card" style="text-align:center;">
                                        <h3>Your QR Code</h3>
                                        <img src="${qrDataURL}" alt="QR" style="width:160px; height:160px;">
                                    </div>
                                </div>

                                <div class="card">
                                    <h3>Club Announcements</h3>
                                    ${announcements.length === 0 ? '<p>No announcements yet.</p>' : announcements.map(a => `
                                        <div style="border-bottom:1px solid #eee; padding-bottom:12px; margin-bottom:12px;">
                                            <strong style="font-size:16px; color:#d97706;">${a.title}</strong><br>
                                            <small style="color:#64748b;">${a.created_at}</small>
                                            <p style="margin:6px 0 0;">${a.message}</p>
                                        </div>
                                    `).join('')}
                                </div>

                                <div class="card">
                                    <h3>Recent Attendance History</h3>
                                    <table>
                                        <thead><tr><th>Scan Type</th><th>Date</th><th>Time</th><th>Scanner</th></tr></thead>
                                        <tbody>
                                            ${attendance.map(a => `<tr><td>${a.scan_type}</td><td>${a.date}</td><td>${a.time}</td><td>${a.scanner_device}</td></tr>`).join('')}
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
    });
});

// ==========================================
// START SERVER ON 0.0.0.0 FOR NETWORK ACCESS
// ==========================================
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
    const interfaces = require('os').networkInterfaces();
    let localIp = 'localhost';
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) localIp = net.address;
        }
    }

    console.log('\n======================================================');
    console.log('SCHOOL CLUB QR CODE ATTENDANCE SYSTEM RUNNING');
    console.log('======================================================');
    console.log(`Local:    http://localhost:${PORT}`);
    console.log(`Network:  http://${localIp}:${PORT}`);
    console.log('------------------------------------------------------');
    console.log(`Admin Portal:   http://${localIp}:${PORT}/admin`);
    console.log(`Scanner Portal: http://${localIp}:${PORT}/scanner`);
    console.log(`Member Portal:  http://${localIp}:${PORT}/member`);
    console.log('======================================================\n');
});
