const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'qr_attendance_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// Database Setup
const dbFile = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Database opening error: ', err.message);
    else console.log('Connected to SQLite database.');
});

// Initialize Tables & Default Data
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_name TEXT,
        school_logo TEXT,
        school_address TEXT,
        contact_info TEXT,
        school_year TEXT,
        late_threshold INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT UNIQUE,
        full_name TEXT,
        grade_level TEXT,
        section TEXT,
        school_year TEXT,
        profile_picture TEXT,
        contact_info TEXT,
        other_info TEXT,
        qr_code TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT,
        description TEXT,
        event_date TEXT,
        start_time TEXT,
        end_time TEXT,
        location TEXT,
        attendance_type TEXT,
        status TEXT,
        allowed_grades TEXT,
        section TEXT,
        late_threshold INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT,
        event_id INTEGER,
        date TEXT,
        time_in TEXT,
        time_out TEXT,
        status TEXT,
        remarks TEXT
    )`);

    // Default Settings
    db.get("SELECT COUNT(*) as count FROM settings", (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO settings (school_name, school_logo, school_address, contact_info, school_year, late_threshold) 
                    VALUES ('Araullo High School', '', 'Manila, Philippines', 'info@araullo.edu.ph', '2026-2027', 15)`);
        }
    });

    // Default Admin (admin / admin123)
    db.get("SELECT COUNT(*) as count FROM admins", async (err, row) => {
        if (row.count === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            db.run(`INSERT INTO admins (username, password) VALUES (?, ?)`, ['admin', hashedPassword]);
        }
    });
});

// Helper Auth Middleware
const isAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    res.redirect('/admin/login');
};

const isStudent = (req, res, next) => {
    if (req.session && req.session.isStudent) return next();
    res.redirect('/student/login');
};

// ==================== VIEWS EMBEDDED GENERATOR (HTML/EJS inline via Express render string or templates) ====================
// To keep app.js completely self-contained without separate views folders, we create an engine or send HTML directly.
// For robust rendering, we'll write view files automatically on startup if they don't exist!

const viewsDir = path.join(__dirname, 'views');
if (!fs.existsSync(viewsDir)) fs.mkdirSync(viewsDir, { recursive: true });

// Write view templates on boot
fs.writeFileSync(path.join(viewsDir, 'layout.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><%= title || 'QR Attendance System' %></title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css">
    <style>
        body { background-color: #f8f9fa; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .sidebar { min-height: 100vh; background: #212529; color: #fff; }
        .sidebar a { color: #adb5bd; text-decoration: none; padding: 10px 20px; display: block; transition: 0.2s; }
        .sidebar a:hover, .sidebar a.active { color: #fff; background: #343a40; border-left: 4px solid #0d6efd; }
        .card-stat { border: none; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        @media print {
            .no-print { display: none !important; }
            .print-container { width: 100% !important; margin: 0 !important; padding: 0 !important; }
            body { background: white !important; }
        }
    </style>
</head>
<body>
    <%- body %>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
</body>
</html>
`);

// --- ADMIN LOGIN VIEW ---
fs.writeFileSync(path.join(viewsDir, 'admin_login.ejs'), `
<div class="container d-flex justify-content-center align-items-center min-vh-100">
    <div class="card shadow p-4" style="width: 400px; border-radius: 12px;">
        <div class="text-center mb-4">
            <i class="fas fa-school fa-3x text-primary mb-2"></i>
            <h3>Admin Portal</h3>
            <p class="text-muted">Sign in to manage attendance</p>
        </div>
        <% if(locals.error) { %>
            <div class="alert alert-danger"><%= error %></div>
        <% } %>
        <form action="/admin/login" method="POST">
            <div class="mb-3">
                <label class="form-label">Username</label>
                <input type="text" name="username" class="form-control" required autofocus>
            </div>
            <div class="mb-3">
                <label class="form-label">Password</label>
                <input type="password" name="password" class="form-control" required>
            </div>
            <button type="submit" class="btn btn-primary w-100 py-2">Login</button>
        </form>
        <div class="text-center mt-3">
            <a href="/scanner" class="text-decoration-none">Go to QR Scanner <i class="fas fa-qrcode"></i></a> | 
            <a href="/student/login" class="text-decoration-none">Student Portal</a>
        </div>
    </div>
</div>
`);

// --- ADMIN DASHBOARD VIEW ---
fs.writeFileSync(path.join(viewsDir, 'admin_dashboard.ejs'), `
<div class="container-fluid">
    <div class="row">
        <div class="col-md-3 col-lg-2 sidebar p-0 no-print">
            <div class="p-3 text-center border-bottom border-secondary">
                <h5><i class="fas fa-qrcode"></i> QR Attendance</h5>
                <small class="text-muted">Admin Panel</small>
            </div>
            <nav class="mt-3">
                <a href="/admin/dashboard" class="active"><i class="fas fa-tachometer-alt me-2"></i> Dashboard</a>
                <a href="/admin/students"><i class="fas fa-user-graduate me-2"></i> Students</a>
                <a href="/admin/events"><i class="fas fa-calendar-alt me-2"></i> Events</a>
                <a href="/admin/attendance"><i class="fas fa-clipboard-list me-2"></i> Attendance Logs</a>
                <a href="/admin/reports"><i class="fas fa-chart-bar me-2"></i> Reports</a>
                <a href="/admin/ids"><i class="fas id-card me-2"></i> ID Printing</a>
                <a href="/admin/settings"><i class="fas fa-cogs me-2"></i> School Settings</a>
                <a href="/scanner" target="_blank"><i class="fas fa-camera me-2"></i> Open Scanner</a>
                <a href="/admin/logout" class="text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a>
            </nav>
        </div>
        <div class="col-md-9 col-lg-10 ms-sm-auto px-md-4 py-4">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2>Dashboard Overview</h2>
                <span class="badge bg-primary p-2 fs-6">Active Event: <%= activeEvent ? activeEvent.event_name : 'No Active Event' %></span>
            </div>

            <div class="row g-3 mb-4">
                <div class="col-md-3">
                    <div class="card card-stat p-3 bg-primary text-white">
                        <h6 class="text-uppercase">Total Students</h6>
                        <h3><%= stats.totalStudents %></h3>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card card-stat p-3 bg-success text-white">
                        <h6 class="text-uppercase">Present Today</h6>
                        <h3><%= stats.totalPresent %></h3>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card card-stat p-3 bg-warning text-dark">
                        <h6 class="text-uppercase">Late Today</h6>
                        <h3><%= stats.totalLate %></h3>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card card-stat p-3 bg-danger text-white">
                        <h6 class="text-uppercase">Absent / Unscanned</h6>
                        <h3><%= stats.totalAbsent %></h3>
                    </div>
                </div>
            </div>

            <div class="card shadow-sm border-0">
                <div class="card-header bg-white py-3">
                    <h5 class="mb-0"><i class="fas fa-history text-primary me-2"></i> Live Attendance Activity</h5>
                </div>
                <div class="card-body table-responsive">
                    <table class="table table-hover align-middle">
                        <thead class="table-light">
                            <tr>
                                <th>Student Name</th>
                                <th>Grade & Section</th>
                                <th>Event</th>
                                <th>Time In</th>
                                <th>Time Out</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <% if(recentLogs.length === 0) { %>
                                <tr><td colspan="6" class="text-center text-muted py-4">No attendance scans recorded yet.</td></tr>
                            <% } else { %>
                                <% recentLogs.forEach(log => { %>
                                    <tr>
                                        <td><strong><%= log.full_name %></strong><br><small class="text-muted"><%= log.student_id %></small></td>
                                        <td>Grade <%= log.grade_level %> - <%= log.section %></td>
                                        <td><%= log.event_name %></td>
                                        <td><%= log.time_in || '-' %></td>
                                        <td><%= log.time_out || '-' %></td>
                                        <td>
                                            <% if(log.status === 'Present') { %>
                                                <span class="badge bg-success">Present</span>
                                            <% } else if(log.status === 'Late') { %>
                                                <span class="badge bg-warning text-dark">Late</span>
                                            <% } else { %>
                                                <span class="badge bg-secondary"><%= log.status %></span>
                                            <% } %>
                                        </td>
                                    </tr>
                                <% }) %>
                            <% } %>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</div>
`);

// --- STUDENTS MANAGEMENT VIEW ---
fs.writeFileSync(path.join(viewsDir, 'admin_students.ejs'), `
<div class="container-fluid">
    <div class="row">
        <div class="col-md-3 col-lg-2 sidebar p-0 no-print">
            <div class="p-3 text-center border-bottom border-secondary">
                <h5><i class="fas fa-qrcode"></i> QR Attendance</h5>
            </div>
            <nav class="mt-3">
                <a href="/admin/dashboard"><i class="fas fa-tachometer-alt me-2"></i> Dashboard</a>
                <a href="/admin/students" class="active"><i class="fas fa-user-graduate me-2"></i> Students</a>
                <a href="/admin/events"><i class="fas fa-calendar-alt me-2"></i> Events</a>
                <a href="/admin/attendance"><i class="fas fa-clipboard-list me-2"></i> Attendance Logs</a>
                <a href="/admin/reports"><i class="fas fa-chart-bar me-2"></i> Reports</a>
                <a href="/admin/ids"><i class="fas id-card me-2"></i> ID Printing</a>
                <a href="/admin/settings"><i class="fas fa-cogs me-2"></i> School Settings</a>
                <a href="/admin/logout" class="text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a>
            </nav>
        </div>
        <div class="col-md-9 col-lg-10 ms-sm-auto px-md-4 py-4">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2>Manage Students</h2>
                <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addStudentModal"><i class="fas fa-plus me-1"></i> Add New Student</button>
            </div>

            <div class="card shadow-sm border-0 mb-4 p-3">
                <form action="/admin/students" method="GET" class="row g-3">
                    <div class="col-md-4">
                        <input type="text" name="search" class="form-control" placeholder="Search name or ID..." value="<%= search || '' %>">
                    </div>
                    <div class="col-md-3">
                        <select name="grade" class="form-select">
                            <option value="">All Grade Levels</option>
                            <option value="7" <%= grade=='7'?'selected':'' %>>Grade 7</option>
                            <option value="8" <%= grade=='8'?'selected':'' %>>Grade 8</option>
                            <option value="9" <%= grade=='9'?'selected':'' %>>Grade 9</option>
                            <option value="10" <%= grade=='10'?'selected':'' %>>Grade 10</option>
                            <option value="11" <%= grade=='11'?'selected':'' %>>Grade 11</option>
                            <option value="12" <%= grade=='12'?'selected':'' %>>Grade 12</option>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <button type="submit" class="btn btn-dark w-100"><i class="fas fa-search me-1"></i> Filter</button>
                    </div>
                    <div class="col-md-2">
                        <a href="/admin/students" class="btn btn-outline-secondary w-100">Reset</a>
                    </div>
                </form>
            </div>

            <div class="card shadow-sm border-0">
                <div class="card-body table-responsive">
                    <table class="table table-hover align-middle">
                        <thead class="table-light">
                            <tr>
                                <th>Photo</th>
                                <th>Student ID</th>
                                <th>Full Name</th>
                                <th>Grade & Section</th>
                                <th>School Year</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            <% if(students.length === 0) { %>
                                <tr><td colspan="6" class="text-center text-muted py-4">No students found.</td></tr>
                            <% } else { %>
                                <% students.forEach(student => { %>
                                    <tr>
                                        <td>
                                            <% if(student.profile_picture) { %>
                                                <img src="/uploads/<%= student.profile_picture %>" class="rounded-circle" width="40" height="40" style="object-fit: cover;">
                                            <% } else { %>
                                                <img src="https://via.placeholder.com/40" class="rounded-circle" width="40" height="40">
                                            <% } %>
                                        </td>
                                        <td><strong><%= student.student_id %></strong></td>
                                        <td><%= student.full_name %></td>
                                        <td>Grade <%= student.grade_level %> - <%= student.section %></td>
                                        <td><%= student.school_year %></td>
                                        <td>
                                            <button class="btn btn-sm btn-info text-white" onclick="viewIdCard('<%= student.student_id %>', '<%= student.full_name %>', '<%= student.grade_level %>', '<%= student.section %>', '<%= student.school_year %>', '<%= student.profile_picture %>')"><i class="fas fa-id-card"></i> ID</button>
                                            <a href="/admin/students/delete/<%= student.id %>" class="btn btn-sm btn-danger" onclick="return confirm('Delete this student?')"><i class="fas fa-trash"></i></a>
                                        </td>
                                    </tr>
                                <% }) %>
                            <% } %>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</div>

<div class="modal fade" id="addStudentModal" tabindex="-1">
    <div class="modal-dialog modal-lg">
        <div class="modal-content">
            <form action="/admin/students/add" method="POST" enctype="multipart/form-data">
                <div class="modal-header">
                    <h5 class="modal-title">Register New Student</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body row g-3">
                    <div class="col-md-6">
                        <label class="form-label">Student ID</label>
                        <input type="text" name="student_id" class="form-control" required placeholder="e.g. 2026-0001">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">Full Name</label>
                        <input type="text" name="full_name" class="form-control" required placeholder="Juan Dela Cruz">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">Grade Level</label>
                        <select name="grade_level" class="form-select" required>
                            <option value="7">Grade 7</option>
                            <option value="8">Grade 8</option>
                            <option value="9">Grade 9</option>
                            <option value="10">Grade 10</option>
                            <option value="11">Grade 11</option>
                            <option value="12">Grade 12</option>
                        </select>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">Section</label>
                        <input type="text" name="section" class="form-control" required placeholder="Einstein">
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">School Year</label>
                        <input type="text" name="school_year" class="form-control" value="2026-2027" required>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">Contact Information</label>
                        <input type="text" name="contact_info" class="form-control" placeholder="Parent/Guardian Phone">
                    </div>
                    <div class="col-md-12">
                        <label class="form-label">Profile Picture</label>
                        <input type="file" name="profile_picture" class="form-control">
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                    <button type="submit" class="btn btn-primary">Save Student & Generate QR</button>
                </div>
            </form>
        </div>
    </div>
</div>

<div class="modal fade" id="idPreviewModal" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content text-center p-3">
            <div class="modal-header border-0">
                <h5 class="modal-title">Student ID Preview</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <div id="idCardBox" class="card p-3 mx-auto shadow" style="width: 300px; border: 2px solid #0d6efd; border-radius: 12px;">
                    <h6 class="text-primary fw-bold mb-1"><%= schoolSettings ? schoolSettings.school_name : 'School Name' %></h6>
                    <small class="text-muted"><%= schoolSettings ? schoolSettings.school_address : '' %></small>
                    <hr class="my-2">
                    <img id="modalStudentImg" src="" class="rounded-circle mx-auto my-2" width="90" height="90" style="object-fit: cover; border: 3px solid #0d6efd;">
                    <h5 id="modalStudentName" class="fw-bold mb-0"></h5>
                    <p id="modalStudentId" class="text-muted mb-1"></p>
                    <span id="modalGradeSec" class="badge bg-secondary mb-3"></span>
                    <div id="modalQrcode" class="d-flex justify-content-center mb-2"></div>
                    <small class="text-muted">School Year: <span id="modalSchoolYear"></span></small>
                </div>
            </div>
            <div class="modal-footer border-0 justify-content-center">
                <button type="button" class="btn btn-primary" onclick="window.print()"><i class="fas fa-print me-1"></i> Print ID Card</button>
            </div>
        </div>
    </div>
</div>

<script>
function viewIdCard(id, name, grade, sec, sy, pic) {
    document.getElementById('modalStudentName').innerText = name;
    document.getElementById('modalStudentId').innerText = 'ID: ' + id;
    document.getElementById('modalGradeSec').innerText = 'Grade ' + grade + ' - ' + sec;
    document.getElementById('modalSchoolYear').innerText = sy;
    document.getElementById('modalStudentImg').src = pic ? '/uploads/' + pic : 'https://via.placeholder.com/90';
    
    const qrContainer = document.getElementById('modalQrcode');
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
        text: id,
        width: 110,
        height: 110
    });

    new bootstrap.Modal(document.getElementById('idPreviewModal')).show();
}
</script>
`);

// --- EVENTS MANAGEMENT VIEW ---
fs.writeFileSync(path.join(viewsDir, 'admin_events.ejs'), `
<div class="container-fluid">
    <div class="row">
        <div class="col-md-3 col-lg-2 sidebar p-0 no-print">
            <div class="p-3 text-center border-bottom border-secondary">
                <h5><i class="fas fa-qrcode"></i> QR Attendance</h5>
            </div>
            <nav class="mt-3">
                <a href="/admin/dashboard"><i class="fas fa-tachometer-alt me-2"></i> Dashboard</a>
                <a href="/admin/students"><i class="fas fa-user-graduate me-2"></i> Students</a>
                <a href="/admin/events" class="active"><i class="fas fa-calendar-alt me-2"></i> Events</a>
                <a href="/admin/attendance"><i class="fas fa-clipboard-list me-2"></i> Attendance Logs</a>
                <a href="/admin/reports"><i class="fas fa-chart-bar me-2"></i> Reports</a>
                <a href="/admin/ids"><i class="fas id-card me-2"></i> ID Printing</a>
                <a href="/admin/settings"><i class="fas fa-cogs me-2"></i> School Settings</a>
                <a href="/admin/logout" class="text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a>
            </nav>
        </div>
        <div class="col-md-9 col-lg-10 ms-sm-auto px-md-4 py-4">
            <div class="d-flex justify-content-between align-items-center mb-4">
                <h2>Manage Attendance Events</h2>
                <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addEventModal"><i class="fas fa-plus me-1"></i> Create Event</button>
            </div>

            <div class="card shadow-sm border-0">
                <div class="card-body table-responsive">
                    <table class="table table-hover align-middle">
                        <thead class="table-light">
                            <tr>
                                <th>Event Name</th>
                                <th>Date & Time</th>
                                <th>Location</th>
                                <th>Status</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            <% if(events.length === 0) { %>
                                <tr><td colspan="5" class="text-center text-muted py-4">No events created yet.</td></tr>
                            <% } else { %>
                                <% events.forEach(ev => { %>
                                    <tr>
                                        <td><strong><%= ev.event_name %></strong><br><small class="text-muted"><%= ev.description %></small></td>
                                        <td><%= ev.event_date %> <br><small class="text-muted"><%= ev.start_time %> - <%= ev.end_time %></small></td>
                                        <td><%= ev.location %></td>
                                        <td>
                                            <% if(ev.status === 'Active') { %>
                                                <span class="badge bg-success">Active</span>
                                            <% } else { %>
                                                <span class="badge bg-secondary">Completed</span>
                                            <% } %>
                                        </td>
                                        <td>
                                            <a href="/scanner?event=<%= ev.id %>" target="_blank" class="btn btn-sm btn-success"><i class="fas fa-qrcode"></i> Scanner Link</a>
                                            <a href="/admin/events/delete/<%= ev.id %>" class="btn btn-sm btn-danger" onclick="return confirm('Delete event?')"><i class="fas fa-trash"></i></a>
                                        </td>
                                    </tr>
                                <% }) %>
                            <% } %>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</div>

<div class="modal fade" id="addEventModal" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content">
            <form action="/admin/events/add" method="POST">
                <div class="modal-header">
                    <h5 class="modal-title">Create Attendance Event</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body row g-3">
                    <div class="col-12">
                        <label class="form-label">Event Name</label>
                        <input type="text" name="event_name" class="form-control" required placeholder="e.g. Flag Ceremony / General Assembly">
                    </div>
                    <div class="col-12">
                        <label class="form-label">Description</label>
                        <textarea name="description" class="form-control" rows="2"></textarea>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">Date</label>
                        <input type="date" name="event_date" class="form-control" required>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">Status</label>
                        <select name="status" class="form-select">
                            <option value="Active">Active</option>
                            <option value="Completed">Completed</option>
                        </select>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">Start Time</label>
                        <input type="time" name="start_time" class="form-control" required>
                    </div>
                    <div class="col-md-6">
                        <label class="form-label">End Time</label>
                        <input type="time" name="end_time" class="form-control" required>
                    </div>
                    <div class="col-12">
                        <label class="form-label">Location</label>
                        <input type="text" name="location" class="form-control" placeholder="School Gymnasium / Main Quadrangle">
                    </div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                    <button type="submit" class="btn btn-primary">Create Event</button>
                </div>
            </form>
        </div>
    </div>
</div>
`);

// --- ID PRINTING (8 IDs PER A4 PAGE) VIEW ---
fs.writeFileSync(path.join(viewsDir, 'admin_ids.ejs'), `
<div class="container-fluid">
    <div class="row">
        <div class="col-md-3 col-lg-2 sidebar p-0 no-print">
            <div class="p-3 text-center border-bottom border-secondary">
                <h5><i class="fas fa-qrcode"></i> QR Attendance</h5>
            </div>
            <nav class="mt-3">
                <a href="/admin/dashboard"><i class="fas fa-tachometer-alt me-2"></i> Dashboard</a>
                <a href="/admin/students"><i class="fas fa-user-graduate me-2"></i> Students</a>
                <a href="/admin/events"><i class="fas fa-calendar-alt me-2"></i> Events</a>
                <a href="/admin/attendance"><i class="fas fa-clipboard-list me-2"></i> Attendance Logs</a>
                <a href="/admin/reports"><i class="fas fa-chart-bar me-2"></i> Reports</a>
                <a href="/admin/ids" class="active"><i class="fas id-card me-2"></i> ID Printing</a>
                <a href="/admin/settings"><i class="fas fa-cogs me-2"></i> School Settings</a>
                <a href="/admin/logout" class="text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a>
            </nav>
        </div>
        <div class="col-md-9 col-lg-10 ms-sm-auto px-md-4 py-4">
            <div class="d-flex justify-content-between align-items-center mb-4 no-print">
                <h2>Batch Student ID Printing (8 IDs per A4 Page)</h2>
                <button class="btn btn-primary" onclick="window.print()"><i class="fas fa-print me-1"></i> Print All ID Cards</button>
            </div>

            <style>
                @media print {
                    .sidebar, .no-print { display: none !important; }
                    body { background: white !important; }
                    .a4-sheet { width: 210mm; height: 297mm; padding: 10mm; margin: 0 auto; page-break-after: always; }
                    .id-grid { display: grid; grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(4, 1fr); gap: 10mm; justify-items: center; }
                    .school-id-card { width: 85.6mm; height: 54mm; border: 1px dashed #999; border-radius: 6px; padding: 8px; background: #fff; box-sizing: border-box; display: flex; flex-direction: row; align-items: center; justify-content: space-between; }
                }
                .school-id-card { width: 320px; height: 200px; border: 2px solid #0d6efd; border-radius: 8px; padding: 12px; background: #fff; display: flex; flex-direction: row; align-items: center; justify-content: space-between; box-shadow: 0 4px 6px rgba(0,0,0,0.1); margin-bottom: 20px; }
                .id-grid-screen { display: flex; flex-wrap: wrap; gap: 20px; }
            </style>

            <div class="id-grid-screen">
                <% students.forEach((student, index) => { %>
                    <div class="school-id-card">
                        <div class="text-center" style="width: 50%;">
                            <h6 class="text-primary fw-bold mb-0" style="font-size: 11px;"><%= schoolSettings ? schoolSettings.school_name : 'School Name' %></h6>
                            <img src="<%= student.profile_picture ? '/uploads/' + student.profile_picture : 'https://via.placeholder.com/70' %>" class="rounded-circle my-1" width="60" height="60" style="object-fit: cover; border: 2px solid #0d6efd;">
                            <p class="fw-bold mb-0" style="font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><%= student.full_name %></p>
                            <small class="text-muted d-block" style="font-size: 10px;"><%= student.student_id %></small>
                            <span class="badge bg-secondary" style="font-size: 9px;">Grade <%= student.grade_level %> - <%= student.section %></span>
                        </div>
                        <div class="text-center" style="width: 45%;">
                            <div id="qrcode_<%= student.student_id %>" class="d-flex justify-content-center"></div>
                            <small class="text-muted" style="font-size: 8px;">SY: <%= student.school_year %></small>
                        </div>
                    </div>
                    <script>
                        setTimeout(() => {
                            new QRCode(document.getElementById("qrcode_<%= student.student_id %>"), {
                                text: "<%= student.student_id %>",
                                width: 75,
                                height: 75
                            });
                        }, 200);
                    </script>
                <% }) %>
            </div>
        </div>
    </div>
</div>
`);

// --- REPORTS VIEW ---
fs.writeFileSync(path.join(viewsDir, 'admin_reports.ejs'), `
<div class="container-fluid">
    <div class="row">
        <div class="col-md-3 col-lg-2 sidebar p-0 no-print">
            <div class="p-3 text-center border-bottom border-secondary">
                <h5><i class="fas fa-qrcode"></i> QR Attendance</h5>
            </div>
            <nav class="mt-3">
                <a href="/admin/dashboard"><i class="fas fa-tachometer-alt me-2"></i> Dashboard</a>
                <a href="/admin/students"><i class="fas fa-user-graduate me-2"></i> Students</a>
                <a href="/admin/events"><i class="fas fa-calendar-alt me-2"></i> Events</a>
                <a href="/admin/attendance"><i class="fas fa-clipboard-list me-2"></i> Attendance Logs</a>
                <a href="/admin/reports" class="active"><i class="fas fa-chart-bar me-2"></i> Reports</a>
                <a href="/admin/ids"><i class="fas id-card me-2"></i> ID Printing</a>
                <a href="/admin/settings"><i class="fas fa-cogs me-2"></i> School Settings</a>
                <a href="/admin/logout" class="text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a>
            </nav>
        </div>
        <div class="col-md-9 col-lg-10 ms-sm-auto px-md-4 py-4">
            <div class="d-flex justify-content-between align-items-center mb-4 no-print">
                <h2>Attendance Reports</h2>
                <button class="btn btn-primary" onclick="window.print()"><i class="fas fa-print me-1"></i> Print Report</button>
            </div>

            <div class="card shadow-sm border-0 mb-4 p-3 no-print">
                <form action="/admin/reports" method="GET" class="row g-3">
                    <div class="col-md-4">
                        <label class="form-label">Select Event</label>
                        <select name="event_id" class="form-select">
                            <option value="">All Events</option>
                            <% events.forEach(ev => { %>
                                <option value="<%= ev.id %>" <%= eventId == ev.id ? 'selected' : '' %>><%= ev.event_name %> (<%= ev.event_date %>)</option>
                            <% }) %>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <label class="form-label">&nbsp;</label>
                        <button type="submit" class="btn btn-dark w-100"><i class="fas fa-filter me-1"></i> Generate Report</button>
                    </div>
                </form>
            </div>

            <div class="card shadow-sm border-0">
                <div class="card-header bg-white py-3">
                    <h5 class="mb-0">Attendance Summary Report</h5>
                </div>
                <div class="card-body table-responsive">
                    <table class="table table-bordered align-middle">
                        <thead class="table-light">
                            <tr>
                                <th>Student ID</th>
                                <th>Student Name</th>
                                <th>Grade & Section</th>
                                <th>Event</th>
                                <th>Time In</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <% if(reports.length === 0) { %>
                                <tr><td colspan="6" class="text-center text-muted py-4">No records found for this filter.</td></tr>
                            <% } else { %>
                                <% reports.forEach(r => { %>
                                    <tr>
                                        <td><%= r.student_id %></td>
                                        <td><strong><%= r.full_name %></strong></td>
                                        <td>Grade <%= r.grade_level %> - <%= r.section %></td>
                                        <td><%= r.event_name %></td>
                                        <td><%= r.time_in || '-' %></td>
                                        <td><%= r.status %></td>
                                    </tr>
                                <% }) %>
                            <% } %>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</div>
`);

// --- SCHOOL SETTINGS VIEW ---
fs.writeFileSync(path.join(viewsDir, 'admin_settings.ejs'), `
<div class="container-fluid">
    <div class="row">
        <div class="col-md-3 col-lg-2 sidebar p-0 no-print">
            <div class="p-3 text-center border-bottom border-secondary">
                <h5><i class="fas fa-qrcode"></i> QR Attendance</h5>
            </div>
            <nav class="mt-3">
                <a href="/admin/dashboard"><i class="fas fa-tachometer-alt me-2"></i> Dashboard</a>
                <a href="/admin/students"><i class="fas fa-user-graduate me-2"></i> Students</a>
                <a href="/admin/events"><i class="fas fa-calendar-alt me-2"></i> Events</a>
                <a href="/admin/attendance"><i class="fas fa-clipboard-list me-2"></i> Attendance Logs</a>
                <a href="/admin/reports"><i class="fas fa-chart-bar me-2"></i> Reports</a>
                <a href="/admin/ids"><i class="fas id-card me-2"></i> ID Printing</a>
                <a href="/admin/settings" class="active"><i class="fas fa-cogs me-2"></i> School Settings</a>
                <a href="/admin/logout" class="text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a>
            </nav>
        </div>
        <div class="col-md-9 col-lg-10 ms-sm-auto px-md-4 py-4">
            <h2 class="mb-4">School Settings</h2>
            <div class="card shadow-sm border-0 p-4" style="max-width: 600px;">
                <% if(success) { %>
                    <div class="alert alert-success">Settings updated successfully!</div>
                <% } %>
                <form action="/admin/settings" method="POST">
                    <div class="mb-3">
                        <label class="form-label">School Name</label>
                        <input type="text" name="school_name" class="form-control" value="<%= settings ? settings.school_name : '' %>" required>
                    </div>
                    <div class="mb-3">
                        <label class="form-label">School Address</label>
                        <input type="text" name="school_address" class="form-control" value="<%= settings ? settings.school_address : '' %>">
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Contact Information</label>
                        <input type="text" name="contact_info" class="form-control" value="<%= settings ? settings.contact_info : '' %>">
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Current School Year</label>
                        <input type="text" name="school_year" class="form-control" value="<%= settings ? settings.school_year : '' %>">
                    </div>
                    <div class="mb-3">
                        <label class="form-label">Late Threshold (Minutes after event start time)</label>
                        <input type="number" name="late_threshold" class="form-control" value="<%= settings ? settings.late_threshold : 15 %>">
                    </div>
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                </form>
            </div>
        </div>
    </div>
</div>
`);

// --- DEDICATED QR SCANNER PAGE (/scanner) ---
fs.writeFileSync(path.join(viewsDir, 'scanner.ejs'), `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QR Attendance Scanner</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css">
    <script src="https://unpkg.com/html5-qrcode"></script>
    <style>
        body { background: #121212; color: #fff; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .scanner-container { max-width: 600px; margin: auto; padding: 20px; }
        .scan-card { background: #1e1e1e; border: none; border-radius: 12px; box-shadow: 0 8px 16px rgba(0,0,0,0.3); }
    </style>
</head>
<body>
    <div class="scanner-container py-4">
        <div class="text-center mb-3">
            <h3><i class="fas fa-qrcode text-primary"></i> Live Attendance Scanner</h3>
            <p class="text-muted">Active Event: <strong class="text-info"><%= activeEvent ? activeEvent.event_name : 'No Active Event Selected' %></strong></p>
        </div>

        <div class="card scan-card p-3 mb-4">
            <div id="reader" style="width: 100%; border-radius: 8px; overflow: hidden;"></div>
            <div class="mt-3 text-center">
                <button id="startBtn" class="btn btn-success px-4" onclick="startScanner()"><i class="fas fa-camera me-1"></i> Start Scanner</button>
                <button id="stopBtn" class="btn btn-danger px-4 d-none" onclick="stopScanner()"><i class="fas fa-stop me-1"></i> Stop Scanner</button>
            </div>
        </div>

        <div id="resultCard" class="card scan-card p-4 text-center d-none">
            <img id="resPic" src="" class="rounded-circle mx-auto mb-3" width="100" height="100" style="object-fit: cover; border: 3px solid #0d6efd;">
            <h4 id="resName" class="fw-bold mb-1"></h4>
            <p id="resId" class="text-muted mb-2"></p>
            <span id="resGrade" class="badge bg-secondary mb-3 fs-6"></span>
            <div id="resStatusAlert" class="alert py-2 mb-0 fw-bold"></div>
        </div>
    </div>

    <script>
        let html5QrCode;
        const activeEventId = "<%= activeEvent ? activeEvent.id : '' %>";

        function playSound(type) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            if(type === 'success') {
                osc.frequency.setValueAtTime(600, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.1);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                osc.start();
                osc.stop(ctx.currentTime + 0.15);
            } else {
                osc.frequency.setValueAtTime(300, ctx.currentTime);
                osc.frequency.setValueAtTime(150, ctx.currentTime + 0.1);
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            }
        }

        function startScanner() {
            if (!activeEventId) {
                alert("Please set an active event in Admin Panel before scanning!");
                return;
            }
            html5QrCode = new Html5Qrcode("reader");
            html5QrCode.start(
                { facingMode: "environment" },
                { fps: 10, qrbox: 250 },
                async (decodedText) => {
                    // Stop temporarily to prevent double fire
                    await processScan(decodedText);
                }
            ).then(() => {
                document.getElementById('startBtn').classList.add('d-none');
                document.getElementById('stopBtn').classList.remove('d-none');
            }).catch(err => {
                alert("Camera error: " + err);
            });
        }

        function stopScanner() {
            if(html5QrCode) {
                html5QrCode.stop().then(() => {
                    document.getElementById('startBtn').classList.remove('d-none');
                    document.getElementById('stopBtn').classList.add('d-none');
                });
            }
        }

        async function processScan(studentId) {
            try {
                const response = await fetch('/api/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ student_id: studentId, event_id: activeEventId })
                });
                const data = await response.json();
                
                const resCard = document.getElementById('resultCard');
                resCard.classList.remove('d-none');
                
                if(data.success) {
                    playSound('success');
                    document.getElementById('resPic').src = data.student.profile_picture ? '/uploads/' + data.student.profile_picture : 'https://via.placeholder.com/100';
                    document.getElementById('resName').innerText = data.student.full_name;
                    document.getElementById('resId').innerText = 'ID: ' + data.student.student_id;
                    document.getElementById('resGrade').innerText = 'Grade ' + data.student.grade_level + ' - ' + data.student.section;
                    
                    const alertBox = document.getElementById('resStatusAlert');
                    alertBox.className = 'alert alert-success py-2 mb-0 fw-bold';
                    alertBox.innerText = data.message + ' (' + data.time + ')';
                } else {
                    playSound('error');
                    document.getElementById('resPic').src = 'https://via.placeholder.com/100';
                    document.getElementById('resName').innerText = "Unknown / Unregistered";
                    document.getElementById('resId').innerText = 'Scanned Code: ' + studentId;
                    document.getElementById('resGrade').innerText = 'N/A';
                    
                    const alertBox = document.getElementById('resStatusAlert');
                    alertBox.className = 'alert alert-danger py-2 mb-0 fw-bold';
                    alertBox.innerText = data.message;
                }
            } catch(e) {
                console.error(e);
            }
        }
    </script>
</body>
</html>
`);

// --- STUDENT LOGIN / PORTAL VIEW ---
fs.writeFileSync(path.join(viewsDir, 'student_login.ejs'), `
<div class="container d-flex justify-content-center align-items-center min-vh-100">
    <div class="card shadow p-4" style="width: 400px; border-radius: 12px;">
        <div class="text-center mb-4">
            <i class="fas fa-user-graduate fa-3x text-primary mb-2"></i>
            <h3>Student Portal</h3>
            <p class="text-muted">Enter your Student ID to view attendance</p>
        </div>
        <% if(locals.error) { %>
            <div class="alert alert-danger"><%= error %></div>
        <% } %>
        <form action="/student/portal" method="POST">
            <div class="mb-3">
                <label class="form-label">Student ID</label>
                <input type="text" name="student_id" class="form-control" required placeholder="e.g. 2026-0001" autofocus>
            </div>
            <button type="submit" class="btn btn-primary w-100 py-2">View Portal</button>
        </form>
        <div class="text-center mt-3">
            <a href="/admin/login" class="text-decoration-none">Admin Login</a>
        </div>
    </div>
</div>
`);

fs.writeFileSync(path.join(viewsDir, 'student_portal.ejs'), `
<div class="container py-5">
    <div class="row justify-content-center">
        <div class="col-md-8">
            <div class="card shadow border-0 p-4 mb-4">
                <div class="d-flex align-items-center mb-4">
                    <img src="<%= student.profile_picture ? '/uploads/' + student.profile_picture : 'https://via.placeholder.com/90' %>" class="rounded-circle me-3" width="90" height="90" style="object-fit: cover; border: 3px solid #0d6efd;">
                    <div>
                        <h3 class="fw-bold mb-0"><%= student.full_name %></h3>
                        <p class="text-muted mb-1">Student ID: <%= student.student_id %></p>
                        <span class="badge bg-primary">Grade <%= student.grade_level %> - <%= student.section %></span>
                    </div>
                </div>
                <hr>
                <h5 class="mb-3"><i class="fas fa-clipboard-list text-primary me-2"></i> My Attendance History</h5>
                <div class="table-responsive">
                    <table class="table table-hover align-middle">
                        <thead class="table-light">
                            <tr>
                                <th>Event</th>
                                <th>Date</th>
                                <th>Time In</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <% if(attendance.length === 0) { %>
                                <tr><td colspan="4" class="text-center text-muted py-3">No attendance records found.</td></tr>
                            <% } else { %>
                                <% attendance.forEach(att => { %>
                                    <tr>
                                        <td><%= att.event_name %></td>
                                        <td><%= att.date %></td>
                                        <td><%= att.time_in || '-' %></td>
                                        <td>
                                            <span class="badge bg-<%= att.status === 'Present' ? 'success' : 'warning text-dark' %>"><%= att.status %></span>
                                        </td>
                                    </tr>
                                <% }) %>
                            <% } %>
                        </tbody>
                    </table>
                </div>
                <div class="text-end mt-3">
                    <a href="/student/login" class="btn btn-secondary btn-sm">Logout</a>
                </div>
            </div>
        </div>
    </div>
</div>
`);


// ==================== APP ROUTES ====================

// Root redirect
app.get('/', (req, res) => {
    res.redirect('/scanner');
});

// --- ADMIN AUTH ROUTES ---
app.get('/admin/login', (req, res) => {
    res.render('admin_login', { title: 'Admin Login' });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admins WHERE username = ?", [username], async (err, admin) => {
        if (admin && await bcrypt.compare(password, admin.password)) {
            req.session.isAdmin = true;
            res.redirect('/admin/dashboard');
        } else {
            res.render('admin_login', { title: 'Admin Login', error: 'Invalid username or password' });
        }
    });
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

// --- ADMIN DASHBOARD ---
app.get('/admin/dashboard', isAdmin, (req, res) => {
    db.get("SELECT * FROM events WHERE status = 'Active' LIMIT 1", (err, activeEvent) => {
        db.get("SELECT COUNT(*) as count FROM students", (err, studentRow) => {
            const today = new Date().toISOString().split('T')[0];
            db.get("SELECT COUNT(DISTINCT student_id) as count FROM attendance WHERE date = ? AND status IN ('Present', 'Late')", [today], (err, presentRow) => {
                db.get("SELECT COUNT(DISTINCT student_id) as count FROM attendance WHERE date = ? AND status = 'Late'", [today], (err, lateRow) => {
                    
                    const totalStudents = studentRow.count || 0;
                    const totalPresent = presentRow.count || 0;
                    const totalLate = lateRow.count || 0;
                    const totalAbsent = Math.max(0, totalStudents - totalPresent);

                    const query = `
                        SELECT a.*, s.full_name, s.grade_level, s.section, e.event_name 
                        FROM attendance a 
                        JOIN students s ON a.student_id = s.student_id 
                        JOIN events e ON a.event_id = e.id 
                        ORDER BY a.id DESC LIMIT 10
                    `;
                    db.all(query, [], (err, recentLogs) => {
                        db.get("SELECT * FROM settings LIMIT 1", (err, schoolSettings) => {
                            res.render('admin_dashboard', {
                                title: 'Admin Dashboard',
                                activeEvent,
                                stats: { totalStudents, totalPresent, totalLate, totalAbsent },
                                recentLogs: recentLogs || [],
                                schoolSettings
                            });
                        });
                    });
                });
            });
        });
    });
});

// --- STUDENTS MANAGEMENT ---
app.get('/admin/students', isAdmin, (req, res) => {
    const { search, grade } = req.query;
    let query = "SELECT * FROM students WHERE 1=1";
    let params = [];

    if (search) {
        query += " AND (full_name LIKE ? OR student_id LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
    }
    if (grade) {
        query += " AND grade_level = ?";
        params.push(grade);
    }
    query += " ORDER BY id DESC";

    db.all(query, params, (err, students) => {
        db.get("SELECT * FROM settings LIMIT 1", (err, schoolSettings) => {
            res.render('admin_students', { title: 'Manage Students', students, search, grade, schoolSettings });
        });
    });
});

app.post('/admin/students/add', isAdmin, upload.single('profile_picture'), (req, res) => {
    const { student_id, full_name, grade_level, section, school_year, contact_info } = req.body;
    const profile_picture = req.file ? req.file.filename : '';

    db.run(`INSERT INTO students (student_id, full_name, grade_level, section, school_year, profile_picture, contact_info, qr_code) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [student_id, full_name, grade_level, section, school_year, profile_picture, contact_info, student_id],
        (err) => {
            res.redirect('/admin/students');
        }
    );
});

app.get('/admin/students/delete/:id', isAdmin, (req, res) => {
    db.run("DELETE FROM students WHERE id = ?", [req.params.id], () => {
        res.redirect('/admin/students');
    });
});

// --- EVENTS ---
app.get('/admin/events', isAdmin, (req, res) => {
    db.all("SELECT * FROM events ORDER BY id DESC", [], (err, events) => {
        res.render('admin_events', { title: 'Manage Events', events });
    });
});

app.post('/admin/events/add', isAdmin, (req, res) => {
    const { event_name, description, event_date, start_time, end_time, location, status } = req.body;
    db.run(`INSERT INTO events (event_name, description, event_date, start_time, end_time, location, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [event_name, description, event_date, start_time, end_time, location, status], () => {
            res.redirect('/admin/events');
        }
    );
});

app.get('/admin/events/delete/:id', isAdmin, (req, res) => {
    db.run("DELETE FROM events WHERE id = ?", [req.params.id], () => {
        res.redirect('/admin/events');
    });
});

// --- ID PRINTING (8 IDs PER A4 PAGE) ---
app.get('/admin/ids', isAdmin, (req, res) => {
    db.all("SELECT * FROM students ORDER BY grade_level, full_name", [], (err, students) => {
        db.get("SELECT * FROM settings LIMIT 1", (err, schoolSettings) => {
            res.render('admin_ids', { title: 'ID Card Batch Printing', students, schoolSettings });
        });
    });
});

// --- ATTENDANCE LOGS & REPORTS ---
app.get('/admin/attendance', isAdmin, (req, res) => {
    db.all(`SELECT a.*, s.full_name, s.grade_level, s.section, e.event_name 
            FROM attendance a 
            JOIN students s ON a.student_id = s.student_id 
            JOIN events e ON a.event_id = e.id 
            ORDER BY a.id DESC LIMIT 100`, [], (err, logs) => {
        res.render('admin_attendance', { title: 'Attendance Logs', logs });
    });
});

// Dedicated simple logs view creation
fs.writeFileSync(path.join(viewsDir, 'admin_attendance.ejs'), `
<div class="container-fluid">
    <div class="row">
        <div class="col-md-3 col-lg-2 sidebar p-0 no-print">
            <div class="p-3 text-center border-bottom border-secondary">
                <h5><i class="fas fa-qrcode"></i> QR Attendance</h5>
            </div>
            <nav class="mt-3">
                <a href="/admin/dashboard"><i class="fas fa-tachometer-alt me-2"></i> Dashboard</a>
                <a href="/admin/students"><i class="fas fa-user-graduate me-2"></i> Students</a>
                <a href="/admin/events"><i class="fas fa-calendar-alt me-2"></i> Events</a>
                <a href="/admin/attendance" class="active"><i class="fas fa-clipboard-list me-2"></i> Attendance Logs</a>
                <a href="/admin/reports"><i class="fas fa-chart-bar me-2"></i> Reports</a>
                <a href="/admin/ids"><i class="fas id-card me-2"></i> ID Printing</a>
                <a href="/admin/settings"><i class="fas fa-cogs me-2"></i> School Settings</a>
                <a href="/admin/logout" class="text-danger"><i class="fas fa-sign-out-alt me-2"></i> Logout</a>
            </nav>
        </div>
        <div class="col-md-9 col-lg-10 ms-sm-auto px-md-4 py-4">
            <h2>All Attendance Logs</h2>
            <div class="card shadow-sm border-0 mt-4">
                <div class="card-body table-responsive">
                    <table class="table table-hover align-middle">
                        <thead class="table-light">
                            <tr>
                                <th>Student ID</th>
                                <th>Full Name</th>
                                <th>Grade & Section</th>
                                <th>Event</th>
                                <th>Date</th>
                                <th>Time In</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <% logs.forEach(l => { %>
                                <tr>
                                    <td><%= l.student_id %></td>
                                    <td><strong><%= l.full_name %></strong></td>
                                    <td>Grade <%= l.grade_level %> - <%= l.section %></td>
                                    <td><%= l.event_name %></td>
                                    <td><%= l.date %></td>
                                    <td><%= l.time_in %></td>
                                    <td><span class="badge bg-success"><%= l.status %></span></td>
                                </tr>
                            <% }) %>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</div>
`);

app.get('/admin/reports', isAdmin, (req, res) => {
    const { event_id } = req.query;
    let query = `SELECT a.*, s.full_name, s.grade_level, s.section, e.event_name 
                 FROM attendance a 
                 JOIN students s ON a.student_id = s.student_id 
                 JOIN events e ON a.event_id = e.id`;
    let params = [];
    if (event_id) {
        query += " WHERE a.event_id = ?";
        params.push(event_id);
    }
    query += " ORDER BY a.id DESC";

    db.all(query, params, (err, reports) => {
        db.all("SELECT * FROM events", [], (err, events) => {
            res.render('admin_reports', { title: 'Reports', reports, events, eventId: event_id || '' });
        });
    });
});

// --- SETTINGS ---
app.get('/admin/settings', isAdmin, (req, res) => {
    db.get("SELECT * FROM settings LIMIT 1", (err, settings) => {
        res.render('admin_settings', { title: 'School Settings', settings, success: req.query.success });
    });
});

app.post('/admin/settings', isAdmin, (req, res) => {
    const { school_name, school_address, contact_info, school_year, late_threshold } = req.body;
    db.run(`UPDATE settings SET school_name = ?, school_address = ?, contact_info = ?, school_year = ?, late_threshold = ?`,
        [school_name, school_address, contact_info, school_year, late_threshold], () => {
            res.redirect('/admin/settings?success=1');
        }
    );
});

// --- SEPARATE QR SCANNER PAGE (/scanner) ---
app.get('/scanner', (req, res) => {
    const eventIdQuery = req.query.event;
    if (eventIdQuery) {
        db.get("SELECT * FROM events WHERE id = ?", [eventIdQuery], (err, activeEvent) => {
            res.render('scanner', { activeEvent });
        });
    } else {
        db.get("SELECT * FROM events WHERE status = 'Active' LIMIT 1", (err, activeEvent) => {
            res.render('scanner', { activeEvent });
        });
    }
});

// Scanner API endpoint
app.post('/api/scan', (req, res) => {
    const { student_id, event_id } = req.body;

    db.get("SELECT * FROM students WHERE student_id = ?", [student_id], (err, student) => {
        if (!student) {
            return res.json({ success: false, message: 'Unregistered Student QR Code!' });
        }

        db.get("SELECT * FROM events WHERE id = ?", [event_id], (err, event) => {
            if (!event) {
                return res.json({ success: false, message: 'Invalid or No Active Event Selected!' });
            }

            const today = new Date().toISOString().split('T')[0];
            const nowTime = new Date().toTimeString().split(' ')[0].substring(0, 5); // HH:MM

            // Check if already scanned today for this event
            db.get("SELECT * FROM attendance WHERE student_id = ? AND event_id = ? AND date = ?", [student_id, event_id, today], (err, existing) => {
                if (existing) {
                    return res.json({ success: false, message: 'Already recorded attendance for this event!', student });
                }

                // Determine Present or Late based on start_time + late_threshold
                // For simplicity, compare time strings or default to Present if within threshold
                let status = 'Present';
                // E.g., event.start_time is '08:00'
                if (event.start_time) {
                    const [eventH, eventM] = event.start_time.split(':').map(Number);
                    const [nowH, nowM] = nowTime.split(':').map(Number);
                    const eventTotalMin = eventH * 60 + eventM;
                    const nowTotalMin = nowH * 60 + nowM;
                    const threshold = event.late_threshold || 15;

                    if (nowTotalMin > eventTotalMin + threshold) {
                        status = 'Late';
                    }
                }

                db.run(`INSERT INTO attendance (student_id, event_id, date, time_in, status) VALUES (?, ?, ?, ?, ?)`,
                    [student_id, event_id, today, nowTime, status], () => {
                        res.json({ success: true, message: `Successfully Recorded (${status})!`, time: nowTime, student });
                    }
                );
            });
        });
    });
});

// --- STUDENT PORTAL ROUTES ---
app.get('/student/login', (req, res) => {
    res.render('student_login', { title: 'Student Portal Login' });
});

app.post('/student/portal', (req, res) => {
    const { student_id } = req.body;
    db.get("SELECT * FROM students WHERE student_id = ?", [student_id], (err, student) => {
        if (!student) {
            return res.render('student_login', { title: 'Student Portal Login', error: 'Student ID not found' });
        }
        db.all(`SELECT a.*, e.event_name FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.student_id = ? ORDER BY a.id DESC`, [student_id], (err, attendance) => {
            res.render('student_portal', { title: 'Student Portal', student, attendance });
        });
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`QR Attendance System running on port ${PORT}`);
});
