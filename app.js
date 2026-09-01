// PART 1: app.js - Setup, Dependencies, Database Initialization, and Core Configuration
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb(new Error('Only standard image files are allowed (JPG, JPEG, PNG, WEBP).'));
    }
});

// Database Setup
const dbFile = process.env.DATABASE_URL || path.join(__dirname, 'school_club_attendance.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            school_name TEXT DEFAULT 'National High School',
            school_logo TEXT DEFAULT '',
            school_address TEXT DEFAULT '123 Education St.',
            school_contact TEXT DEFAULT '555-0199',
            school_email TEXT DEFAULT 'info@school.edu',
            school_year TEXT DEFAULT '2025-2026',
            club_name TEXT DEFAULT 'Youth Information Technology Club',
            club_logo TEXT DEFAULT '',
            club_adviser TEXT DEFAULT 'Dr. Maria Santos',
            org_name TEXT DEFAULT 'Student Supreme Council Affiliate',
            registration_open INTEGER DEFAULT 1,
            num_prefix TEXT DEFAULT 'SC-',
            start_number INTEGER DEFAULT 1,
            num_length INTEGER DEFAULT 6,
            min_participation REAL DEFAULT 75.0,
            late_threshold_mins INTEGER DEFAULT 15,
            timezone TEXT DEFAULT 'Asia/Manila'
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT UNIQUE,
            password TEXT,
            role TEXT DEFAULT 'admin',
            first_name TEXT,
            last_name TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            description TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_number TEXT UNIQUE,
            first_name TEXT,
            middle_name TEXT,
            last_name TEXT,
            email TEXT UNIQUE,
            contact_number TEXT,
            position TEXT,
            photo TEXT,
            qr_token TEXT UNIQUE,
            status TEXT DEFAULT 'Pending',
            membership_status TEXT DEFAULT 'Active',
            date_joined DATE DEFAULT CURRENT_DATE,
            expiration_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS position_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER,
            position TEXT,
            school_year TEXT,
            assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(student_id) REFERENCES students(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            description TEXT,
            event_type TEXT,
            event_date DATE,
            start_time TEXT,
            end_time TEXT,
            location TEXT,
            organizer TEXT,
            status TEXT DEFAULT 'Upcoming',
            target_positions TEXT DEFAULT 'All'
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER,
            student_id INTEGER,
            time_in DATETIME,
            time_out DATETIME,
            status TEXT DEFAULT 'Present',
            excused_reason TEXT,
            recorded_by TEXT,
            FOREIGN KEY(event_id) REFERENCES events(id),
            FOREIGN KEY(student_id) REFERENCES students(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user TEXT,
            action TEXT,
            details TEXT,
            ip_address TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Seed default admin if none exists
        db.get(`SELECT COUNT(*) as count FROM users`, (err, row) => {
            if (row && row.count === 0) {
                bcrypt.hash('admin123', 10, (err, hash) => {
                    db.run(`INSERT INTO users (username, email, password, role, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)`,
                        ['admin', 'admin@school.edu', hash, 'admin', 'System', 'Admin']);
                });
                // Seed default positions
                const defaultPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor', 'Public Information Officer', 'Peace Officer', 'Representative', 'Member'];
                defaultPositions.forEach(pos => {
                    db.run(`INSERT OR IGNORE INTO positions (name, description) VALUES (?, ?)`, [pos, 'Standard club position']);
                });
                // Seed default settings
                db.run(`INSERT INTO settings (school_name) VALUES ('National High School')`);
            }
        });
    });
}

// Middleware setup
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: './' }),
    secret: 'school_club_qr_attendance_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Helper function for logging audit trails
function logAudit(user, action, details, ip) {
    db.run(`INSERT INTO audit_logs (user, action, details, ip_address) VALUES (?, ?, ?, ?)`, 
        [user || 'Guest', action, details, ip || '127.0.0.1']);
}

// Auth Middleware
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
    res.status(403).send('Access Denied: Scanner or Admin privileges required.');
}

function isStudentUser(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'student') {
        return next();
    }
    res.status(403).send('Access Denied: Student portal access only.');
}
// PART 2: app.js - Authentication Routes & Public Student Self-Registration
// Authentication Routes
app.get('/login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - School Club Attendance System</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg); margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
        .login-card { background: white; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
        .login-card h2 { margin-top: 0; color: #1e293b; text-align: center; }
        .form-group { margin-bottom: 1.25rem; }
        .form-group label { display: block; margin-bottom: 0.5rem; color: #475569; font-weight: 600; font-size: 0.875rem; }
        .form-group input { width: 100%; padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 0.5rem; font-size: 1rem; box-sizing: border-box; }
        .btn { width: 100%; padding: 0.75rem; background: var(--primary); color: white; border: none; border-radius: 0.5rem; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        .btn:hover { background: #4338ca; }
        .links { margin-top: 1rem; text-align: center; font-size: 0.875rem; }
        .links a { color: var(--primary); text-decoration: none; }
        .error { background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.5rem; margin-bottom: 1rem; font-size: 0.875rem; text-align: center; }
    </style>
</head>
<body>
    <div class="login-card">
        <h2>System Login</h2>
        ${req.query.error ? `<div class="error">${req.query.error}</div>` : ''}
        <form action="/login" method="POST">
            <div class="form-group">
                <label>Email or Username</label>
                <input type="text" name="username" required placeholder="Enter username or email">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" name="password" required placeholder="Enter password">
            </div>
            <button type="submit" class="btn">Sign In</button>
        </form>
        <div class="links">
            <p>Student self-registration? <a href="/register">Register here</a></p>
            <p><a href="/scanner">Go to QR Scanner</a></p>
        </div>
    </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? OR email = ?`, [username, username], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.user = { id: user.id, username: user.username, role: user.role, name: `${user.first_name} ${user.last_name}` };
            logAudit(user.username, 'LOGIN', 'User logged in successfully', req.ip);
            if (user.role === 'admin') return res.redirect('/admin');
            if (user.role === 'scanner') return res.redirect('/scanner');
        }
        // Check if student login
        db.get(`SELECT * FROM students WHERE email = ? AND status = 'Approved'`, [username], (err, student) => {
            if (student && bcrypt.compareSync(password, student.student_number)) { // Default student password is student number initially or hashed
                req.session.user = { id: student.id, username: student.email, role: 'student', name: `${student.first_name} ${student.last_name}`, student_number: student.student_number };
                logAudit(student.email, 'STUDENT_LOGIN', 'Student logged into portal', req.ip);
                return res.redirect('/member');
            }
            res.redirect('/login?error=Invalid username or password');
        });
    });
});

app.get('/logout', (req, res) => {
    if (req.session.user) {
        logAudit(req.session.user.username, 'LOGOUT', 'User logged out', req.ip);
    }
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Public Student Self-Registration Link Route
app.get('/register', (req, res) => {
    db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
        if (settings && settings.registration_open === 0) {
            return res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Registration Closed</title><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"><style>body{font-family:sans-serif;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}.card{background:white;padding:3rem;border-radius:1rem;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.1);max-width:450px;}h2{color:#ef4444;}</style></head>
<body><div class="card"><i class="fa-solid fa-lock fa-3x" style="color:#ef4444;margin-bottom:1rem;"></i><h2>Registration Closed</h2><p>Registration is currently closed. Please contact the Club Adviser for assistance.</p><a href="/login" style="color:#4f46e5;text-decoration:none;font-weight:600;">Go to Login</a></div></body></html>`);
        }
        db.all(`SELECT name FROM positions`, (err, positions) => {
            res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Student Club Registration</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg); margin: 0; padding: 2rem; display: flex; justify-content: center; }
        .register-container { background: white; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); width: 100%; max-width: 600px; }
        h2 { color: #1e293b; text-align: center; margin-top: 0; }
        .form-group { margin-bottom: 1.25rem; }
        label { display: block; margin-bottom: 0.5rem; color: #475569; font-weight: 600; font-size: 0.875rem; }
        input, select { width: 100%; padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 0.5rem; font-size: 1rem; box-sizing: border-box; }
        .btn { width: 100%; padding: 0.75rem; background: var(--primary); color: white; border: none; border-radius: 0.5rem; font-size: 1rem; font-weight: 600; cursor: pointer; }
        .btn:hover { background: #4338ca; }
        .preview-img { width: 120px; height: 120px; border-radius: 50%; object-fit: cover; border: 3px solid #cbd5e1; display: none; margin-top: 0.5rem; }
    </style>
</head>
<body>
    <div class="register-container">
        <h2>Student Club Registration</h2>
        <form action="/register" method="POST" enctype="multipart/form-data">
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
                <input type="email" name="email" required placeholder="student@example.com">
            </div>
            <div class="form-group">
                <label>Contact Number</label>
                <input type="text" name="contact_number">
            </div>
            <div class="form-group">
                <label>Position *</label>
                <select name="position" required>
                    <option value="">Select Position</option>
                    ${positions.map(p => `<option value="${p.name}">${p.name}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Student Photo * (Clear, Front-facing)</label>
                <input type="file" name="photo" id="photoInput" accept="image/*" required onchange="previewImage(event)">
                <img id="photoPreview" class="preview-img">
            </div>
            <button type="submit" class="btn">Submit Registration</button>
        </form>
    </div>
    <script>
        function previewImage(event) {
            const reader = new FileReader();
            reader.onload = function(){
                const output = document.getElementById('photoPreview');
                output.src = reader.result;
                output.style.display = 'block';
            };
            reader.readAsDataURL(event.target.files[0]);
        }
    </script>
</body>
</html>`);
        });
    });
});

app.post('/register', upload.single('photo'), (req, res) => {
    const { first_name, middle_name, last_name, email, contact_number, position } = req.body;
    const photo = req.file ? req.file.filename : '';

    if (!first_name || !last_name || !email || !position || !photo) {
        return res.status(400).send('Missing required registration fields.');
    }

    db.get(`SELECT id FROM students WHERE email = ?`, [email], (err, row) => {
        if (row) {
            return res.send(`<!DOCTYPE html><html><head><title>Duplicate Email</title></head><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2>Registration Error</h2><p>The email address ${email} is already registered.</p><a href="/register">Back to Registration</a></body></html>`);
        }

        db.run(`INSERT INTO students (first_name, middle_name, last_name, email, contact_number, position, photo, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
            [first_name, middle_name || '', last_name, email, contact_number || '', position, photo], function(err) {
                if (err) {
                    return res.status(500).send('Database error during registration.');
                }
                logAudit(email, 'REGISTER', 'Student submitted registration', req.ip);
                res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Registration Successful</title><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"><style>body{font-family:sans-serif;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}.card{background:white;padding:3rem;border-radius:1rem;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.1);max-width:450px;}h2{color:#10b981;}</style></head>
<body><div class="card"><i class="fa-solid fa-circle-check fa-3x" style="color:#10b981;margin-bottom:1rem;"></i><h2>Registration Successful!</h2><p>Your registration has been submitted successfully.</p><p><strong>Status: Pending Approval</strong></p><p>Please wait for your Club Adviser to approve your registration.</p><a href="/login" style="color:#4f46e5;text-decoration:none;font-weight:600;display:inline-block;margin-top:1rem;">Go to Login</a></div></body></html>`);
            });
    });
});
// PART 3: app.js - Independent Mobile QR Scanner Portal with Voice & Sound
app.get('/scanner', isScanner, (req, res) => {
    db.all(`SELECT * FROM events WHERE status != 'Cancelled'`, (err, events) => {
        db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
            res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QR Scanner Portal - ${settings ? settings.club_name : 'Club'}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
    <style>
        :root { --primary: #4f46e5; --success: #10b981; --warning: #f59e0b; --danger: #ef4444; --bg: #f1f5f9; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg); margin: 0; padding: 1rem; }
        .scanner-container { max-width: 800px; margin: 0 auto; background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 1rem; margin-bottom: 1.5rem; }
        .header h2 { margin: 0; color: #1e293b; font-size: 1.5rem; }
        .form-group { margin-bottom: 1rem; }
        label { display: block; font-weight: 600; margin-bottom: 0.5rem; color: #475569; }
        select { width: 100%; padding: 0.75rem; border: 1px solid #cbd5e1; border-radius: 0.5rem; font-size: 1rem; }
        #reader { width: 100%; max-width: 500px; margin: 0 auto; border-radius: 0.5rem; overflow: hidden; border: 2px solid #cbd5e1; }
        .result-box { margin-top: 1.5rem; padding: 1.5rem; border-radius: 0.75rem; text-align: center; display: none; }
        .result-box.success { background: #d1fae5; color: #065f46; border: 2px solid var(--success); }
        .result-box.error { background: #fee2e2; color: #991b1b; border: 2px solid var(--danger); }
        .result-box.warning { background: #fef3c7; color: #92400e; border: 2px solid var(--warning); }
        .student-photo { width: 100px; height: 100px; border-radius: 50%; object-fit: cover; margin-bottom: 1rem; border: 3px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .recent-scans { margin-top: 2rem; }
        .recent-scans h3 { border-bottom: 1px solid #e2e8f0; padding-bottom: 0.5rem; color: #334155; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
    </style>
</head>
<body>
    <div class="scanner-container">
        <div class="header">
            <h2><i class="fa-solid fa-qrcode"></i> QR Attendance Scanner</h2>
            <div>
                <span style="font-weight: 600; color: #64748b; margin-right: 1rem;">${req.session.user.name}</span>
                <a href="/admin" style="text-decoration:none; background:var(--primary); color:white; padding:0.5rem 1rem; border-radius:0.375rem; font-size:0.875rem;">Dashboard</a>
            </div>
        </div>
        
        <div class="form-group">
            <label>Select Active Event *</label>
            <select id="eventSelect" required>
                <option value="">-- Choose Event for Attendance --</option>
                ${events.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('')}
            </select>
        </div>

        <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
            <div style="flex: 1;">
                <label>Scan Type</label>
                <select id="scanType">
                    <option value="Time In">Time In</option>
                    <option value="Time Out">Time Out</option>
                </select>
            </div>
        </div>

        <div id="reader"></div>

        <div id="resultBox" class="result-box">
            <img id="resPhoto" class="student-photo" style="display:none;">
            <h3 id="resTitle" style="margin:0 0 0.5rem 0; font-size:1.5rem;"></h3>
            <p id="resDetails" style="margin:0; font-size:1.1rem; font-weight:600;"></p>
        </div>

        <div class="recent-scans">
            <h3>Recent Scans</h3>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Student Name</th>
                        <th>Student No.</th>
                        <th>Event</th>
                        <th>Type</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody id="recentScansBody">
                    <tr><td colspan="6" style="text-align:center; color:#64748b;">No scans recorded yet in this session.</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <audio id="successSound" src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg"></audio>
    <audio id="errorSound" src="https://actions.google.com/sounds/v1/alarms/bugle_tune.ogg"></audio>
    <audio id="warningSound" src="https://actions.google.com/sounds/v1/cartoon/clang_and_wobble.ogg"></audio>

    <script>
        const recentScans = [];

        function playSound(type) {
            if (type === 'success') document.getElementById('successSound').play().catch(e => {});
            if (type === 'error') document.getElementById('errorSound').play().catch(e => {});
            if (type === 'warning') document.getElementById('warningSound').play().catch(e => {});
        }

        function speakText(text) {
            if ('speechSynthesis' in window) {
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.rate = 1.0;
                window.speechSynthesis.speak(utterance);
            }
        }

        function showResult(status, title, details, photoUrl) {
            const box = document.getElementById('resultBox');
            box.className = 'result-box ' + status;
            box.style.display = 'block';
            
            document.getElementById('resTitle').innerText = title;
            document.getElementById('resDetails').innerText = details;
            
            const img = document.getElementById('resPhoto');
            if (photoUrl) {
                img.src = '/uploads/' + photoUrl;
                img.style.display = 'inline-block';
            } else {
                img.style.display = 'none';
            }
        }

        function addRecentScanTable(scan) {
            recentScans.unshift(scan);
            if (recentScans.length > 10) recentScans.pop();
            
            const tbody = document.getElementById('recentScansBody');
            tbody.innerHTML = recentScans.map(s => \`
                <tr>
                    <td>\${s.time}</td>
                    <td>\${s.name}</td>
                    <td>\${s.student_number}</td>
                    <td>\${s.event_name}</td>
                    <td>\${s.type}</td>
                    <td><span style="padding:0.25rem 0.5rem; border-radius:0.25rem; font-size:0.75rem; background:\${s.status === 'Present' ? '#d1fae5; color:#065f46' : '#fef3c7; color:#92400e'}">\${s.status}</span></td>
                </tr>
            \`).join('');
        }

        function onScanSuccess(decodedText, decodedResult) {
            const eventId = document.getElementById('eventSelect').value;
            const scanType = document.getElementById('scanType').value;

            if (!eventId) {
                playSound('warning');
                showResult('warning', 'SELECT AN EVENT', 'Please select an event before scanning QR codes.');
                return;
            }

            // Pause scanner briefly to prevent double reads
            html5QrcodeScanner.pause(true);

            fetch('/api/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: scanType })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    playSound('success');
                    showResult('success', data.title, data.message, data.photo);
                    speakText(data.speech);
                    addRecentScanTable(data.scanRecord);
                } else {
                    playSound(data.soundType || 'error');
                    showResult(data.boxType || 'error', data.title, data.message, data.photo);
                    speakText(data.speech);
                }
                setTimeout(() => { html5QrcodeScanner.resume(); }, 2500);
            })
            .catch(err => {
                playSound('error');
                showResult('error', 'SYSTEM ERROR', 'Failed to process attendance scan.');
                setTimeout(() => { html5QrcodeScanner.resume(); }, 2500);
            });
        }

        const html5QrcodeScanner = new Html5QrcodeScanner(
            "reader", { fps: 10, qrbox: { width: 250, height: 250 } }, false);
        html5QrcodeScanner.render(onScanSuccess, (err) => {});
    </script>
</body>
</html>`);
        });
    });
});

// Scan Processing API endpoint
app.post('/api/scan', isScanner, (req, res) => {
    const { qr_token, event_id, scan_type } = req.body;
    if (!qr_token || !event_id) {
        return res.json({ success: false, title: 'INVALID REQUEST', message: 'Missing QR or Event information.', speech: 'Invalid scan request.', soundType: 'error', boxType: 'error' });
    }

    db.get(`SELECT * FROM students WHERE qr_token = ? AND status = 'Approved'`, [qr_token], (err, student) => {
        if (!student) {
            return res.json({ success: false, title: 'INVALID QR CODE', message: 'The scanned QR code is unknown, disabled, or pending approval.', speech: 'Invalid QR code.', soundType: 'error', boxType: 'error' });
        }

        db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
            if (!event) {
                return res.json({ success: false, title: 'EVENT NOT FOUND', message: 'Selected event does not exist.', speech: 'Event not found.', soundType: 'error', boxType: 'error' });
            }

            db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student.id], (err, existingAttendance) => {
                const now = new Date();
                const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                if (scan_type === 'Time Out') {
                    if (!existingAttendance) {
                        return res.json({ success: false, title: 'NO TIME IN RECORD', message: `${student.first_name} ${student.last_name} has not recorded a Time In for this event.`, speech: `${student.first_name} ${student.last_name}, no time in recorded.`, soundType: 'warning', boxType: 'warning' });
                    }
                    db.run(`UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = ?`, [existingAttendance.id], function(err) {
                        logAudit(req.session.user.username, 'ATTENDANCE_TIMEOUT', `Recorded Time Out for ${student.student_number} at event ${event.name}`, req.ip);
                        return res.json({
                            success: true,
                            title: 'TIME OUT RECORDED',
                            message: `${student.first_name} ${student.last_name} (${student.student_number}) - Time Out logged successfully.`,
                            photo: student.photo,
                            speech: `${student.first_name} ${student.last_name}, time out recorded.`,
                            scanRecord: {
                                time: timeString,
                                name: `${student.first_name} ${student.last_name}`,
                                student_number: student.student_number,
                                event_name: event.name,
                                type: 'Time Out',
                                status: existingAttendance.status
                            }
                        });
                    });
                } else {
                    // Time In
                    if (existingAttendance) {
                        return res.json({
                            success: false,
                            boxType: 'warning',
                            soundType: 'warning',
                            title: 'ALREADY RECORDED',
                            message: `${student.first_name} ${student.last_name} is already recorded for this event.`,
                            photo: student.photo,
                            speech: `${student.first_name} ${student.last_name}, you are already recorded for this event.`
                        });
                    }

                    // Calculate status (Present / Late)
                    let status = 'Present';
                    // Example check start time vs now
                    const eventStart = new Date(`${event.event_date}T${event.start_time || '08:00'}`);
                    const diffMins = (now - eventStart) / (1000 * 60);
                    db.get(`SELECT late_threshold_mins FROM settings WHERE id = 1`, (err, settings) => {
                        const threshold = settings ? settings.late_threshold_mins : 15;
                        if (diffMins > threshold) {
                            status = 'Late';
                        }

                        db.run(`INSERT INTO attendance (event_id, student_id, time_in, status, recorded_by) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?)`,
                            [event_id, student.id, status, req.session.user.username], function(err) {
                                if (err) {
                                    return res.json({ success: false, title: 'DATABASE ERROR', message: 'Could not save attendance record.', speech: 'Database error.', soundType: 'error', boxType: 'error' });
                                }
                                logAudit(req.session.user.username, 'ATTENDANCE_TIMEIN', `Recorded ${status} Time In for ${student.student_number} at event ${event.name}`, req.ip);
                                return res.json({
                                    success: true,
                                    title: `ATTENDANCE RECORDED (${status.toUpperCase()})`,
                                    message: `${student.first_name} ${student.last_name} (${student.student_number}) - Position: ${student.position}`,
                                    photo: student.photo,
                                    speech: `${student.first_name} ${student.last_name}, attendance recorded as ${status}.`,
                                    scanRecord: {
                                        time: timeString,
                                        name: `${student.first_name} ${student.last_name}`,
                                        student_number: student.student_number,
                                        event_name: event.name,
                                        type: 'Time In',
                                        status: status
                                    }
                                });
                            });
                    });
                }
            });
        });
    });
});
// PART 4: app.js - Student Portal (/member) & Profile Dashboard
app.get('/member', isStudentUser, (req, res) => {
    db.get(`SELECT * FROM students WHERE email = ?`, [req.session.user.username], (err, student) => {
        if (!student) return res.redirect('/login');

        db.all(`SELECT a.*, e.name as event_name, e.event_date FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.student_id = ? ORDER BY e.event_date DESC`, [student.id], (err, attendanceHistory) => {
            db.all(`SELECT * FROM events WHERE status != 'Cancelled' ORDER BY event_date ASC`, (err, upcomingEvents) => {
                db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
                    // Generate QR data URL for digital ID
                    QRCode.toDataURL(student.qr_token || 'NO_QR', { width: 300 }, (err, qrCodeUrl) => {
                        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Student Portal - ${settings ? settings.club_name : 'Club'}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg); margin: 0; padding: 2rem; }
        .portal-container { max-width: 900px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 2rem; }
        .id-card { background: white; border-radius: 1rem; padding: 2rem; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); display: flex; gap: 2rem; align-items: center; margin-bottom: 2rem; border-top: 6px solid var(--primary); }
        .id-photo { width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 4px solid #e2e8f0; }
        .id-qr { width: 140px; height: 140px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
        .btn { background: var(--primary); color: white; border: none; padding: 0.5rem 1rem; border-radius: 0.375rem; text-decoration: none; font-weight: 600; font-size: 0.875rem; display: inline-block; cursor: pointer; }
    </style>
</head>
<body>
    <div class="portal-container">
        <div class="header">
            <div>
                <h2 style="margin:0; color:#1e293b;">Student Portal</h2>
                <p style="margin:0.25rem 0 0 0; color:#64748b;">${settings ? settings.club_name : ''}</p>
            </div>
            <div>
                <a href="/logout" class="btn" style="background:#ef4444;"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
            </div>
        </div>

        <div class="id-card">
            <img src="/uploads/${student.photo}" class="id-photo">
            <div style="flex: 1;">
                <h3 style="margin:0; font-size:1.75rem; color:#1e293b;">${student.first_name} ${student.middle_name || ''} ${student.last_name}</h3>
                <p style="margin:0.25rem 0; color:var(--primary); font-weight:600; font-size:1.1rem;">${student.position}</p>
                <p style="margin:0.25rem 0; color:#64748b;">Student No: <strong>${student.student_number}</strong></p>
                <p style="margin:0.25rem 0; color:#64748b;">Email: ${student.email}</p>
                <p style="margin:0.25rem 0; color:#64748b;">School Year: ${settings ? settings.school_year : '2025-2026'}</p>
            </div>
            <div>
                <img src="${qrCodeUrl}" class="id-qr" title="Digital QR Code">
                <p style="text-align:center; font-size:0.75rem; color:#64748b; margin:0.25rem 0 0 0;">Digital QR</p>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <h3 style="margin-top:0; color:#334155;"><i class="fa-solid fa-clipboard-user"></i> Attendance History</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Event</th>
                            <th>Date</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${attendanceHistory.length === 0 ? '<tr><td colspan="3" style="text-align:center; color:#64748b;">No attendance recorded yet.</td></tr>' : 
                          attendanceHistory.map(a => `<tr><td>${a.event_name}</td><td>${a.event_date}</td><td><span style="padding:0.25rem 0.5rem; border-radius:0.25rem; font-size:0.75rem; background:${a.status==='Present'?'#d1fae5;color:#065f46':'#fef3c7;color:#92400e'}">${a.status}</span></td></tr>`).join('')}
                    </tbody>
                </table>
            </div>

            <div class="card">
                <h3 style="margin-top:0; color:#334155;"><i class="fa-solid fa-calendar-days"></i> Upcoming Club Events</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Event Name</th>
                            <th>Date</th>
                            <th>Location</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${upcomingEvents.length === 0 ? '<tr><td colspan="3" style="text-align:center; color:#64748b;">No upcoming events scheduled.</td></tr>' :
                          upcomingEvents.map(e => `<tr><td>${e.name}</td><td>${e.event_date}</td><td>${e.location || 'N/A'}</td></tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</body>
</html>`);
                    });
                });
            });
        });
    });
});
// PART 5: app.js - Admin Dashboard & Analytics Calculations
app.get('/admin', isAdmin, (req, res) => {
    db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
        db.get(`SELECT COUNT(*) as total FROM students WHERE status = 'Approved'`, (err, r1) => {
            db.get(`SELECT COUNT(*) as total FROM students WHERE status = 'Pending'`, (err, r2) => {
                db.get(`SELECT COUNT(*) as total FROM students WHERE status = 'Approved' AND membership_status = 'Active'`, (err, r3) => {
                    db.get(`SELECT COUNT(*) as total FROM events WHERE status = 'Active' OR status = 'Upcoming'`, (err, r4) => {
                        db.all(`SELECT a.*, s.first_name, s.last_name, s.student_number, e.name as event_name FROM attendance a JOIN students s ON a.student_id = s.id JOIN events e ON a.event_id = e.id ORDER BY a.time_in DESC LIMIT 10`, (err, recentScans) => {
                            db.all(`SELECT * FROM events ORDER BY event_date DESC LIMIT 5`, (err, eventsList) => {
                                res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard - ${settings ? settings.club_name : 'Club'}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; overflow-y: auto; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; color: #f8fafc; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; transition: 0.2s; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .header { display: flex; justify-content: space-between; align-items: center; background: white; padding: 1rem 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 2rem; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .stat-card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); display: flex; align-items: center; justify-content: space-between; border-left: 5px solid var(--primary); }
        .stat-card h3 { margin: 0; font-size: 2rem; color: #1e293b; }
        .stat-card p { margin: 0; color: #64748b; font-weight: 600; font-size: 0.875rem; }
        .stat-icon { font-size: 2.5rem; color: #cbd5e1; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 2rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
        .badge { padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; font-weight: 600; }
        .badge-success { background: #d1fae5; color: #065f46; }
        .badge-warning { background: #fef3c7; color: #92400e; }
        .db-status { display: inline-flex; align-items: center; gap: 0.5rem; background: #d1fae5; color: #065f46; padding: 0.25rem 0.75rem; border-radius: 1rem; font-size: 0.875rem; font-weight: 600; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin" class="active"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations"><i class="fa-solid fa-user-check"></i> Registrations (${r2 ? r2.total : 0})</a>
        <a href="/admin/positions"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/scanner" target="_blank"><i class="fa-solid fa-qrcode"></i> Scanner Portal</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>

    <div class="main-content">
        <div class="header">
            <div>
                <h2 style="margin:0; color:#1e293b;">Dashboard Overview</h2>
                <p style="margin:0.25rem 0 0 0; color:#64748b;">${settings ? settings.school_name : ''} — ${settings ? settings.club_name : ''}</p>
            </div>
            <div class="db-status">
                <span style="height:10px; width:10px; background:#10b981; border-radius:50%; display:inline-block;"></span> Database Connected
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div>
                    <h3>${r1 ? r1.total : 0}</h3>
                    <p>Approved Students</p>
                </div>
                <i class="fa-solid fa-users stat-icon"></i>
            </div>
            <div class="stat-card" style="border-left-color: #f59e0b;">
                <div>
                    <h3>${r2 ? r2.total : 0}</h3>
                    <p>Pending Registrations</p>
                </div>
                <i class="fa-solid fa-user-clock stat-icon"></i>
            </div>
            <div class="stat-card" style="border-left-color: #10b981;">
                <div>
                    <h3>${r3 ? r3.total : 0}</h3>
                    <p>Active Members</p>
                </div>
                <i class="fa-solid fa-user-check stat-icon"></i>
            </div>
            <div class="stat-card" style="border-left-color: #3b82f6;">
                <div>
                    <h3>${r4 ? r4.total : 0}</h3>
                    <p>Active / Upcoming Events</p>
                </div>
                <i class="fa-solid fa-calendar stat-icon"></i>
            </div>
        </div>

        <div class="card">
            <h3 style="margin-top:0; color:#1e293b;"><i class="fa-solid fa-bolt"></i> Real-Time Recent Attendance Scans</h3>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Student Name</th>
                        <th>Student Number</th>
                        <th>Event</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${recentScans.length === 0 ? '<tr><td colspan="5" style="text-align:center; color:#64748b;">No recent attendance scans recorded.</td></tr>' :
                      recentScans.map(s => `<tr><td>${s.time_in}</td><td>${s.first_name} ${s.last_name}</td><td>${s.student_number}</td><td>${s.event_name}</td><td><span class="badge ${s.status==='Present'?'badge-success':'badge-warning'}">${s.status}</span></td></tr>`).join('')}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
                            });
                        });
                    });
                });
            });
        });
    });
});
// PART 6: app.js - Admin Management Pages (Students, Registrations, Positions, Events, Settings, ID Printing, Backup)
app.get('/admin/students', isAdmin, (req, res) => {
    db.all(`SELECT * FROM students WHERE status = 'Approved' ORDER BY last_name ASC`, (err, students) => {
        db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
            res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Manage Students - Admin</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
        .student-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students" class="active"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations"><i class="fa-solid fa-user-check"></i> Registrations</a>
        <a href="/admin/positions"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>
    <div class="main-content">
        <h2 style="margin-top:0; color:#1e293b;">Approved Students Directory</h2>
        <div class="card">
            <table>
                <thead>
                    <tr>
                        <th>Photo</th>
                        <th>Student Number</th>
                        <th>Name</th>
                        <th>Position</th>
                        <th>Email</th>
                        <th>Membership</th>
                    </tr>
                </thead>
                <tbody>
                    ${students.length === 0 ? '<tr><td colspan="6" style="text-align:center; color:#64748b;">No approved students found.</td></tr>' :
                      students.map(s => `<tr><td><img src="/uploads/${s.photo}" class="student-avatar"></td><td><strong>${s.student_number}</strong></td><td>${s.first_name} ${s.last_name}</td><td>${s.position}</td><td>${s.email}</td><td><span style="padding:0.25rem 0.5rem; border-radius:0.25rem; font-size:0.75rem; background:#d1fae5; color:#065f46">${s.membership_status}</span></td></tr>`).join('')}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
        });
    });
});

app.get('/admin/registrations', isAdmin, (req, res) => {
    db.all(`SELECT * FROM students WHERE status = 'Pending' ORDER BY created_at DESC`, (err, pending) => {
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Pending Registrations</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
        .student-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
        .btn { padding: 0.375rem 0.75rem; border: none; border-radius: 0.25rem; font-weight: 600; font-size: 0.75rem; cursor: pointer; text-decoration: none; display: inline-block; }
        .btn-success { background: #10b981; color: white; }
        .btn-danger { background: #ef4444; color: white; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations" class="active"><i class="fa-solid fa-user-check"></i> Registrations</a>
        <a href="/admin/positions"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>
    <div class="main-content">
        <h2 style="margin-top:0; color:#1e293b;">Pending Student Registrations</h2>
        <div class="card">
            <table>
                <thead>
                    <tr>
                        <th>Photo</th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Position</th>
                        <th>Date Submitted</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${pending.length === 0 ? '<tr><td colspan="6" style="text-align:center; color:#64748b;">No pending registrations.</td></tr>' :
                      pending.map(s => `<tr><td><img src="/uploads/${s.photo}" class="student-avatar"></td><td>${s.first_name} ${s.last_name}</td><td>${s.email}</td><td>${s.position}</td><td>${s.created_at}</td><td><a href="/admin/registrations/approve/${s.id}" class="btn btn-success"><i class="fa-solid fa-check"></i> Approve</a> <a href="/admin/registrations/reject/${s.id}" class="btn btn-danger"><i class="fa-solid fa-xmark"></i> Reject</a></td></tr>`).join('')}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
    });
});

// Approve Registration & Generate Student Number + QR Token
app.get('/admin/registrations/approve/:id', isAdmin, (req, res) => {
    const studentId = req.params.id;
    db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
        db.get(`SELECT COUNT(*) as count FROM students WHERE status = 'Approved'`, (err, r) => {
            const prefix = settings ? settings.num_prefix : 'SC-';
            const startNum = settings ? settings.start_number : 1;
            const length = settings ? settings.num_length : 6;
            const nextNum = startNum + (r ? r.count : 0);
            const studentNumber = prefix + '2026-' + String(nextNum).padStart(length, '0');
            const qrToken = 'QR-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-' + Date.now();

            db.run(`UPDATE students SET student_number = ?, qr_token = ?, status = 'Approved' WHERE id = ?`, [studentNumber, qrToken, studentId], function(err) {
                logAudit(req.session.user.username, 'APPROVE_STUDENT', `Approved student ID ${studentId} with number ${studentNumber}`, req.ip);
                res.redirect('/admin/registrations');
            });
        });
    });
});

app.get('/admin/registrations/reject/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM students WHERE id = ? AND status = 'Pending'`, [req.params.id], function(err) {
        logAudit(req.session.user.username, 'REJECT_STUDENT', `Rejected/deleted registration ID ${req.params.id}`, req.ip);
        res.redirect('/admin/registrations');
    });
});

// Positions Management
app.get('/admin/positions', isAdmin, (req, res) => {
    db.all(`SELECT * FROM positions`, (err, positions) => {
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Manage Positions</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 1.5rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
        input, button { padding: 0.5rem 1rem; border: 1px solid #cbd5e1; border-radius: 0.375rem; font-size: 1rem; }
        button { background: var(--primary); color: white; border: none; font-weight: 600; cursor: pointer; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations"><i class="fa-solid fa-user-check"></i> Registrations</a>
        <a href="/admin/positions" class="active"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>
    <div class="main-content">
        <h2 style="margin-top:0; color:#1e293b;">Customizable Club Positions</h2>
        <div class="card">
            <form action="/admin/positions" method="POST" style="display: flex; gap: 1rem;">
                <input type="text" name="name" placeholder="New Position Name (e.g. Project Director)" required style="flex:1;">
                <button type="submit"><i class="fa-solid fa-plus"></i> Add Position</button>
            </form>
        </div>
        <div class="card">
            <table>
                <thead>
                    <tr><th>Position Name</th></tr>
                </thead>
                <tbody>
                    ${positions.map(p => `<tr><td><strong>${p.name}</strong></td></tr>`).join('')}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
    });
});

app.post('/admin/positions', isAdmin, (req, res) => {
    const { name } = req.body;
    if (name) {
        db.run(`INSERT OR IGNORE INTO positions (name) VALUES (?)`, [name], (err) => {
            logAudit(req.session.user.username, 'ADD_POSITION', `Created position ${name}`, req.ip);
            res.redirect('/admin/positions');
        });
    } else {
        res.redirect('/admin/positions');
    }
});

// Events Management
app.get('/admin/events', isAdmin, (req, res) => {
    db.all(`SELECT * FROM events ORDER BY event_date DESC`, (err, events) => {
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Manage Events</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 1.5rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
        .form-group { margin-bottom: 1rem; }
        label { display: block; font-weight: 600; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; }
        input, select { width: 100%; padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 0.375rem; box-sizing: border-box; }
        button { background: var(--primary); color: white; border: none; padding: 0.75rem 1.5rem; font-weight: 600; border-radius: 0.375rem; cursor: pointer; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations"><i class="fa-solid fa-user-check"></i> Registrations</a>
        <a href="/admin/positions"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events" class="active"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>
    <div class="main-content">
        <h2 style="margin-top:0; color:#1e293b;">Event Management</h2>
        <div class="card">
            <h3 style="margin-top:0;">Create New Event</h3>
            <form action="/admin/events" method="POST">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                    <div class="form-group"><label>Event Name *</label><input type="text" name="name" required></div>
                    <div class="form-group"><label>Event Type *</label>
                        <select name="event_type" required>
                            <option value="General Club Assembly">General Club Assembly</option>
                            <option value="Club Meeting">Club Meeting</option>
                            <option value="Officer Meeting">Officer Meeting</option>
                            <option value="Workshop">Workshop</option>
                            <option value="Seminar">Seminar</option>
                            <option value="Custom Event">Custom Event</option>
                        </select>
                    </div>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem;">
                    <div class="form-group"><label>Event Date *</label><input type="date" name="event_date" required></div>
                    <div class="form-group"><label>Start Time *</label><input type="time" name="start_time" required></div>
                    <div class="form-group"><label>End Time *</label><input type="time" name="end_time" required></div>
                </div>
                <div class="form-group"><label>Location</label><input type="text" name="location"></div>
                <button type="submit"><i class="fa-solid fa-plus"></i> Create Event</button>
            </form>
        </div>
        <div class="card">
            <h3 style="margin-top:0;">Events List</h3>
            <table>
                <thead>
                    <tr><th>Event Name</th><th>Type</th><th>Date</th><th>Time</th><th>Status</th></tr>
                </thead>
                <tbody>
                    ${events.length === 0 ? '<tr><td colspan="5" style="text-align:center; color:#64748b;">No events created yet.</td></tr>' :
                      events.map(e => `<tr><td><strong>${e.name}</strong></td><td>${e.event_type}</td><td>${e.event_date}</td><td>${e.start_time} - ${e.end_time}</td><td><span style="padding:0.25rem 0.5rem; border-radius:0.25rem; font-size:0.75rem; background:#d1fae5; color:#065f46">${e.status}</span></td></tr>`).join('')}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
    });
});

app.post('/admin/events', isAdmin, (req, res) => {
    const { name, event_type, event_date, start_time, end_time, location } = req.body;
    if (name && event_date) {
        db.run(`INSERT INTO events (name, event_type, event_date, start_time, end_time, location, status) VALUES (?, ?, ?, ?, ?, ?, 'Upcoming')`,
            [name, event_type, event_date, start_time, end_time, location || 'School Campus'], (err) => {
                logAudit(req.session.user.username, 'CREATE_EVENT', `Created event ${name}`, req.ip);
                res.redirect('/admin/events');
            });
    } else {
        res.redirect('/admin/events');
    }
});

// A4 ID Printing (8 IDs per A4 Page requirement)
app.get('/admin/id-printing', isAdmin, (req, res) => {
    db.all(`SELECT * FROM students WHERE status = 'Approved' ORDER BY last_name ASC`, (err, students) => {
        db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
            // Generate QR code data urls for all students
            let processed = 0;
            const studentsWithQr = [];
            if (students.length === 0) {
                renderPrintPage(res, settings, []);
                return;
            }
            students.forEach(s => {
                QRCode.toDataURL(s.qr_token, { width: 250 }, (err, url) => {
                    studentsWithQr.push({ ...s, qrDataUrl: url });
                    processed++;
                    if (processed === students.length) {
                        renderPrintPage(res, settings, studentsWithQr);
                    }
                });
            });
        });
    });
});

function renderPrintPage(res, settings, students) {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Print Student IDs (8 per A4)</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #e2e8f0; margin: 0; padding: 2rem; }
        .no-print { text-align: center; margin-bottom: 2rem; }
        .btn { background: #4f46e5; color: white; border: none; padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600; border-radius: 0.5rem; cursor: pointer; }
        .a4-page { width: 210mm; height: 297mm; background: white; margin: 0 auto 2rem auto; padding: 10mm; box-sizing: border-box; display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(4, 1fr); gap: 5mm; page-break-after: always; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .id-card { border: 2px dashed #cbd5e1; border-radius: 0.5rem; padding: 10px; display: flex; flex-direction: column; justify-content: space-between; background: white; box-sizing: border-box; position: relative; overflow: hidden; }
        .id-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #4f46e5; padding-bottom: 5px; }
        .id-body { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
        .id-photo { width: 70px; height: 70px; border-radius: 50%; object-fit: cover; border: 2px solid #4f46e5; }
        .id-qr { width: 85px; height: 85px; }
        .id-footer { text-align: center; font-size: 8px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 3px; }
        @media print {
            body { background: white; padding: 0; }
            .no-print { display: none; }
            .a4-page { margin: 0; box-shadow: none; border: none; }
        }
    </style>
</head>
<body>
    <div class="no-print">
        <h2>Student Club ID Cards (8 IDs per A4 Bond Paper)</h2>
        <button class="btn" onclick="window.print()"><i class="fa-solid fa-print"></i> Print All ID Cards</button>
        <a href="/admin" style="margin-left: 1rem; color: #4f46e5; text-decoration: none; font-weight: 600;">Back to Dashboard</a>
    </div>
    ${chunkArray(students, 8).map(pageStudents => `
        <div class="a4-page">
            ${pageStudents.map(s => `
                <div class="id-card">
                    <div class="id-header">
                        <span style="font-size: 9px; font-weight: bold; color: #1e293b;">${settings ? settings.club_name : 'Student Club'}</span>
                        <span style="font-size: 8px; background: #4f46e5; color: white; padding: 1px 4px; border-radius: 3px;">${settings ? settings.school_year : '2025-2026'}</span>
                    </div>
                    <div class="id-body">
                        <img src="/uploads/${s.photo}" class="id-photo">
                        <div style="flex: 1;">
                            <div style="font-size: 11px; font-weight: bold; color: #1e293b;">${s.first_name} ${s.last_name}</div>
                            <div style="font-size: 9px; color: #4f46e5; font-weight: bold;">${s.position}</div>
                            <div style="font-size: 8px; color: #64748b; margin-top: 2px;">No: ${s.student_number}</div>
                        </div>
                        <img src="${s.qrDataUrl}" class="id-qr">
                    </div>
                    <div class="id-footer">
                        ${settings ? settings.school_name : 'School'} • Official Membership ID
                    </div>
                </div>
            `).join('')}
        </div>
    `).join('')}
</body>
</html>`);
}

function chunkArray(arr, size) {
    const results = [];
    for (let i = 0; i < arr.length; i += size) {
        results.push(arr.slice(i, i + size));
    }
    return results;
}

// Reports Page
app.get('/admin/reports', isAdmin, (req, res) => {
    db.all(`SELECT e.name as event_name, s.first_name, s.last_name, s.student_number, a.time_in, a.status FROM attendance a JOIN events e ON a.event_id = e.id JOIN students s ON a.student_id = s.id ORDER BY a.time_in DESC`, (err, attendance) => {
        db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
            res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Attendance Reports</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
        th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.875rem; }
        th { background: #f8fafc; color: #475569; }
        .btn { background: var(--primary); color: white; border: none; padding: 0.5rem 1rem; border-radius: 0.375rem; font-weight: 600; cursor: pointer; margin-bottom: 1rem; display: inline-block; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations"><i class="fa-solid fa-user-check"></i> Registrations</a>
        <a href="/admin/positions"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports" class="active"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>
    <div class="main-content">
        <h2 style="margin-top:0; color:#1e293b;">Comprehensive Attendance Report</h2>
        <div class="card">
            <button class="btn" onclick="window.print()"><i class="fa-solid fa-print"></i> Print Report</button>
            <table>
                <thead>
                    <tr><th>Event Name</th><th>Student Name</th><th>Student Number</th><th>Time In</th><th>Status</th></tr>
                </thead>
                <tbody>
                    ${attendance.length === 0 ? '<tr><td colspan="5" style="text-align:center; color:#64748b;">No attendance records found.</td></tr>' :
                      attendance.map(a => `<tr><td>${a.event_name}</td><td>${a.first_name} ${a.last_name}</td><td>${a.student_number}</td><td>${a.time_in}</td><td><span style="padding:0.25rem 0.5rem; border-radius:0.25rem; font-size:0.75rem; background:#d1fae5; color:#065f46">${a.status}</span></td></tr>`).join('')}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
        });
    });
});

// Backup & Restore Page
app.get('/admin/backup', isAdmin, (req, res) => {
    db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Backup & Restore</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); margin-bottom: 1.5rem; }
        .btn { background: var(--primary); color: white; border: none; padding: 0.75rem 1.5rem; font-weight: 600; border-radius: 0.375rem; cursor: pointer; text-decoration: none; display: inline-block; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations"><i class="fa-solid fa-user-check"></i> Registrations</a>
        <a href="/admin/positions"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup" class="active"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>
    <div class="main-content">
        <h2 style="margin-top:0; color:#1e293b;">Database Backup & Restore</h2>
        <div class="card">
            <h3 style="margin-top:0;">Download Database Backup</h3>
            <p style="color: #64748b; font-size: 0.875rem;">Download a secure SQLite database file containing all student records, attendance, and events.</p>
            <a href="/admin/backup/download" class="btn"><i class="fa-solid fa-download"></i> Download Backup File</a>
        </div>
    </div>
</body>
</html>`);
    });
});

app.get('/admin/backup/download', isAdmin, (req, res) => {
    res.download(path.join(__dirname, 'school_club_attendance.db'));
});

// Settings Page
app.get('/admin/settings', isAdmin, (req, res) => {
    db.get(`SELECT * FROM settings WHERE id = 1`, (err, settings) => {
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>System Settings</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --primary: #4f46e5; --bg: #f8fafc; --sidebar-width: 260px; }
        body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; display: flex; }
        .sidebar { width: var(--sidebar-width); background: #1e293b; color: white; height: 100vh; position: fixed; padding: 1.5rem 1rem; box-sizing: border-box; }
        .sidebar h2 { font-size: 1.25rem; margin-top: 0; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        .sidebar a { display: block; color: #94a3b8; text-decoration: none; padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 0.25rem; font-weight: 600; }
        .sidebar a:hover, .sidebar a.active { background: var(--primary); color: white; }
        .sidebar a i { margin-right: 0.75rem; width: 20px; text-align: center; }
        .main-content { margin-left: var(--sidebar-width); flex: 1; padding: 2rem; box-sizing: border-box; }
        .card { background: white; padding: 1.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .form-group { margin-bottom: 1rem; }
        label { display: block; font-weight: 600; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; }
        input { width: 100%; padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 0.375rem; box-sizing: border-box; }
        button { background: var(--primary); color: white; border: none; padding: 0.75rem 1.5rem; font-weight: 600; border-radius: 0.375rem; cursor: pointer; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>Club Admin</h2>
        <a href="/admin"><i class="fa-solid fa-chart-pie"></i> Dashboard</a>
        <a href="/admin/students"><i class="fa-solid fa-users"></i> Students</a>
        <a href="/admin/registrations"><i class="fa-solid fa-user-check"></i> Registrations</a>
        <a href="/admin/positions"><i class="fa-solid fa-id-badge"></i> Positions</a>
        <a href="/admin/events"><i class="fa-solid fa-calendar-check"></i> Events</a>
        <a href="/admin/attendance"><i class="fa-solid fa-clipboard-list"></i> Attendance</a>
        <a href="/admin/reports"><i class="fa-solid fa-file-lines"></i> Reports</a>
        <a href="/admin/id-printing"><i class="fa-solid fa-id-card"></i> ID Printing</a>
        <a href="/admin/backup"><i class="fa-solid fa-database"></i> Backup & Restore</a>
        <a href="/admin/settings" class="active"><i class="fa-solid fa-gear"></i> Settings</a>
        <a href="/logout"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
    </div>
    <div class="main-content">
        <h2 style="margin-top:0; color:#1e293b;">School & Club Settings</h2>
        <div class="card">
            <form action="/admin/settings" method="POST">
                <div class="form-group"><label>School Name</label><input type="text" name="school_name" value="${settings ? settings.school_name : ''}"></div>
                <div class="form-group"><label>Student Club Name</label><input type="text" name="club_name" value="${settings ? settings.club_name : ''}"></div>
                <div class="form-group"><label>Club Adviser</label><input type="text" name="club_adviser" value="${settings ? settings.club_adviser : ''}"></div>
                <div class="form-group"><label>School Year</label><input type="text" name="school_year" value="${settings ? settings.school_year : ''}"></div>
                <button type="submit"><i class="fa-solid fa-save"></i> Save Settings</button>
            </form>
        </div>
    </div>
</body>
</html>`);
    });
});

app.post('/admin/settings', isAdmin, (req, res) => {
    const { school_name, club_name, club_adviser, school_year } = req.body;
    db.run(`UPDATE settings SET school_name = ?, club_name = ?, club_adviser = ?, school_year = ? WHERE id = 1`,
        [school_name, club_name, club_adviser, school_year], (err) => {
            logAudit(req.session.user.username, 'UPDATE_SETTINGS', 'Updated system settings', req.ip);
            res.redirect('/admin/settings');
        });
});

// Root redirect
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Start Server
app.listen(PORT, () => {
    console.log(`School Student Club QR Code Attendance System running on port ${PORT}`);
});
