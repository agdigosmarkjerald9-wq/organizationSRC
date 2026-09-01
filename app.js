/**
 * School Student Club QR Code Attendance Web System
 * Complete Unified Application Code (app.js)
 * Timezone: Asia/Manila
 */

process.env.TZ = "Asia/Manila";

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure persistent upload directories exist
const uploadDirs = ["uploads/photos", "uploads/logos", "backups"];
uploadDirs.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Database Initialization (Persistent SQLite Storage with WAL Mode)
const dbPath = path.join(__dirname, "data.sqlite");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Critical Error: Failed to connect to SQLite database:", err);
  } else {
    console.log("Database connected successfully: data.sqlite");
  }
});

// Enable SQLite WAL Mode & Foreign Key Constraints to prevent data loss on restarts
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = NORMAL;");
db.run("PRAGMA foreign_keys = ON;");

// Initialize Database Tables
db.serialize(() => {
  // Settings Table
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      school_name TEXT DEFAULT 'Central High School',
      club_name TEXT DEFAULT 'Computer Science Club',
      school_year TEXT DEFAULT '2025-2026',
      school_logo TEXT DEFAULT '',
      club_logo TEXT DEFAULT ''
    )
  `);

  // Insert default settings row if missing
  db.run(`
    INSERT OR IGNORE INTO settings (id, school_name, club_name, school_year)
    VALUES (1, 'Central High School', 'Computer Science Club', '2025-2026')
  `);

  // Users Table (Admin, Scanner User, Student)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      raw_temp_password TEXT DEFAULT '',
      role TEXT CHECK(role IN ('admin', 'scanner', 'student')) NOT NULL,
      student_id INTEGER UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )
  `);

  // Positions Table
  db.run(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT ''
    )
  `);

  // Seed default positions
  const defaultPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor', 'Member'];
  defaultPositions.forEach((pos) => {
    db.run(`INSERT OR IGNORE INTO positions (name) VALUES (?)`, [pos]);
  });

  // Students Table
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_number TEXT UNIQUE,
      first_name TEXT NOT NULL,
      middle_name TEXT DEFAULT '',
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      contact_number TEXT DEFAULT '',
      position_id INTEGER,
      photo_path TEXT NOT NULL,
      qr_token TEXT UNIQUE,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
    )
  `);

  // Events Table
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      event_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      location TEXT NOT NULL,
      late_threshold_minutes INTEGER DEFAULT 15,
      status TEXT CHECK(status IN ('upcoming', 'active', 'completed')) DEFAULT 'upcoming',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Attendance Records Table
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      time_in DATETIME,
      time_out DATETIME,
      status TEXT CHECK(status IN ('Present', 'Late', 'Absent', 'Excused')) DEFAULT 'Absent',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, student_id),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    )
  `);

  // Audit Logs Table
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Default Accounts if missing
  const salt = bcrypt.genSaltSync(10);
  const adminPasswordHash = bcrypt.hashSync("admin123", salt);
  const scannerPasswordHash = bcrypt.hashSync("scanner123", salt);

  db.run(`
    INSERT OR IGNORE INTO users (username, password_hash, raw_temp_password, role)
    VALUES ('admin', ?, 'admin123', 'admin')
  `, [adminPasswordHash]);

  db.run(`
    INSERT OR IGNORE INTO users (username, password_hash, raw_temp_password, role)
    VALUES ('scanner', ?, 'scanner123', 'scanner')
  `, [scannerPasswordHash]);
});

// Middleware Setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use(
  session({
    store: new SQLiteStore({ db: "sessions.sqlite", dir: __dirname }),
    secret: process.env.SESSION_SECRET || "super-secret-club-key-2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }
  })
);

// File Upload Configuration (Multer)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "student_photo") {
      cb(null, "uploads/photos/");
    } else if (file.fieldname === "school_logo" || file.fieldname === "club_logo") {
      cb(null, "uploads/logos/");
    } else if (file.fieldname === "backup_file") {
      cb(null, "backups/");
    } else {
      cb(null, "uploads/");
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "backup_file") {
      return cb(null, true);
    }
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeType = allowedTypes.test(file.mimetype);
    if (extName && mimeType) {
      return cb(null, true);
    }
    cb(new Error("Only image files (JPG, PNG, WEBP) are allowed!"));
  }
});

// Helper: Audit Logger
function logAudit(username, action, details, ip) {
  db.run(
    `INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)`,
    [username || "System", action, details, ip || "127.0.0.1"]
  );
}

// Authentication Middleware
function requireAuth(roles = []) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect("/login");
    }
    if (roles.length > 0 && !roles.includes(req.session.user.role)) {
      return res.status(403).send("Forbidden: Unauthorized Access Rights.");
    }
    next();
  };
}

// Global UI Layout Wrapper
function renderPage(title, content, user = null) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - QR Attendance System</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
      <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css" rel="stylesheet">
      <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
      <style>
        body { background-color: #f4f6f9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .navbar-brand { font-weight: 700; letter-spacing: 0.5px; }
        .card { border: none; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .id-card-frame {
          width: 323px; height: 215px; border: 2px solid #2c3e50; border-radius: 8px;
          background: #ffffff; padding: 8px; position: relative; box-sizing: border-box; display: inline-block;
        }
        @media print {
          .no-print { display: none !important; }
          .a4-page { width: 210mm; height: 297mm; padding: 10mm; margin: auto; page-break-after: always; }
          .grid-container { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15mm; }
        }
      </style>
    </head>
    <body>
      ${
        user
          ? `
      <nav class="navbar navbar-expand-lg navbar-dark bg-dark mb-4 no-print">
        <div class="container-fluid">
          <a class="navbar-brand" href="#"><i class="bi bi-qr-code-scan me-2"></i>Club Attendance</a>
          <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
            <span class="navbar-toggler-icon"></span>
          </button>
          <div class="collapse navbar-collapse" id="navbarNav">
            <ul class="navbar-nav me-auto">
              ${
                user.role === "admin"
                  ? `
                <li class="nav-item"><a class="nav-link" href="/admin/dashboard">Dashboard</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/students">Students & Credentials</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/positions">Positions</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/events">Events</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/print-ids">Print IDs</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/reports">Reports</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/database">Database Backup</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/settings">Settings</a></li>
                <li class="nav-item"><a class="nav-link" href="/admin/audit">Audit Logs</a></li>
              `
                  : ""
              }
              ${user.role === "scanner" ? `<li class="nav-item"><a class="nav-link" href="/scanner">Scanner Interface</a></li>` : ""}
              ${user.role === "student" ? `<li class="nav-item"><a class="nav-link" href="/member">Member Portal</a></li>` : ""}
            </ul>
            <div class="d-flex align-items-center text-white me-3">
              <i class="bi bi-person-circle me-1"></i> ${user.username} (${user.role.toUpperCase()})
            </div>
            <a href="/logout" class="btn btn-outline-light btn-sm">Logout</a>
          </div>
        </div>
      </nav>`
          : ""
      }
      <div class="container-fluid px-4">
        ${content}
      </div>
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    </body>
    </html>
  `;
}

// --- PUBLIC & AUTHENTICATION ROUTES ---

app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.role === "admin") return res.redirect("/admin/dashboard");
  if (req.session.user.role === "scanner") return res.redirect("/scanner");
  if (req.session.user.role === "student") return res.redirect("/member");
});

app.get("/login", (req, res) => {
  const html = `
    <div class="row justify-content-center mt-5">
      <div class="col-md-4">
        <div class="card shadow">
          <div class="card-header bg-primary text-white text-center py-3">
            <h4 class="mb-0"><i class="bi bi-lock-fill me-2"></i>System Login</h4>
          </div>
          <div class="card-body p-4">
            <form action="/login" method="POST">
              <div class="mb-3">
                <label class="form-label">Username</label>
                <input type="text" name="username" class="form-control" placeholder="Enter username" required>
              </div>
              <div class="mb-3">
                <label class="form-label">Password</label>
                <input type="password" name="password" class="form-control" placeholder="Enter password" required>
              </div>
              <button type="submit" class="btn btn-primary w-100">Sign In</button>
            </form>
            <hr>
            <div class="text-center">
              <a href="/register" class="text-decoration-none">Student Registration Page</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  res.send(renderPage("Login", html));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
    if (err || !user) {
      return res.send(renderPage("Login", `<div class="alert alert-danger text-center">Invalid Credentials. <a href="/login">Try Again</a></div>`));
    }
    const passwordMatch = bcrypt.compareSync(password, user.password_hash);
    if (!passwordMatch) {
      return res.send(renderPage("Login", `<div class="alert alert-danger text-center">Invalid Password. <a href="/login">Try Again</a></div>`));
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      student_id: user.student_id
    };

    logAudit(user.username, "LOGIN", "User logged into the system", req.ip);

    if (user.role === "admin") return res.redirect("/admin/dashboard");
    if (user.role === "scanner") return res.redirect("/scanner");
    if (user.role === "student") return res.redirect("/member");
  });
});

app.get("/logout", (req, res) => {
  if (req.session.user) {
    logAudit(req.session.user.username, "LOGOUT", "User logged out", req.ip);
  }
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/register", (req, res) => {
  db.all(`SELECT * FROM positions ORDER BY name ASC`, [], (err, positions) => {
    let positionOptions = positions.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    const html = `
      <div class="row justify-content-center my-4">
        <div class="col-md-6">
          <div class="card shadow">
            <div class="card-header bg-success text-white py-3">
              <h4 class="mb-0"><i class="bi bi-person-plus-fill me-2"></i>Student Club Registration</h4>
            </div>
            <div class="card-body p-4">
              <form action="/register" method="POST" enctype="multipart/form-data">
                <div class="row">
                  <div class="col-md-4 mb-3">
                    <label class="form-label">First Name *</label>
                    <input type="text" name="first_name" class="form-control" required>
                  </div>
                  <div class="col-md-4 mb-3">
                    <label class="form-label">Middle Name</label>
                    <input type="text" name="middle_name" class="form-control">
                  </div>
                  <div class="col-md-4 mb-3">
                    <label class="form-label">Last Name *</label>
                    <input type="text" name="last_name" class="form-control" required>
                  </div>
                </div>
                <div class="mb-3">
                  <label class="form-label">Email Address *</label>
                  <input type="email" name="email" class="form-control" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">Contact Number (Optional)</label>
                  <input type="text" name="contact_number" class="form-control">
                </div>
                <div class="mb-3">
                  <label class="form-label">Position *</label>
                  <select name="position_id" class="form-select" required>
                    <option value="">Select Club Position</option>
                    ${positionOptions}
                  </select>
                </div>
                <div class="mb-3">
                  <label class="form-label">Student Photo *</label>
                  <input type="file" name="student_photo" class="form-control" accept="image/*" required>
                </div>
                <button type="submit" class="btn btn-success w-100">Submit Registration Request</button>
              </form>
              <div class="text-center mt-3">
                <a href="/login" class="text-decoration-none">Return to Login</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    res.send(renderPage("Student Registration", html));
  });
});

app.post("/register", upload.single("student_photo"), (req, res) => {
  const { first_name, middle_name, last_name, email, contact_number, position_id } = req.body;
  if (!req.file) {
    return res.status(400).send("Student photo is required.");
  }
  const photo_path = "/uploads/photos/" + req.file.filename;

  db.run(
    `INSERT INTO students (first_name, middle_name, last_name, email, contact_number, position_id, photo_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [first_name, middle_name, last_name, email, contact_number, position_id, photo_path],
    function (err) {
      if (err) {
        return res.status(500).send("Database Error: Registration failed.");
      }
      logAudit("System", "REGISTRATION_SUBMITTED", `Pending registration created for ${first_name} ${last_name}`, req.ip);
      const html = `
        <div class="row justify-content-center mt-5">
          <div class="col-md-6 text-center">
            <div class="card p-5 shadow">
              <i class="bi bi-check-circle-fill text-success display-1 mb-3"></i>
              <h3>Registration Submitted Successfully!</h3>
              <p class="text-muted">Your registration is pending approval from the club administrator. Once approved, your account credentials and QR ID will be generated.</p>
              <a href="/login" class="btn btn-primary mt-3">Back to Login</a>
            </div>
          </div>
        </div>
      `;
      res.send(renderPage("Registration Submitted", html));
    }
  );
});

// --- ADMIN DASHBOARD & MANAGEMENT ROUTES ---

app.get("/admin/dashboard", requireAuth(["admin"]), (req, res) => {
  const stats = {};
  db.get(`SELECT COUNT(*) as total FROM students WHERE status='approved'`, [], (e, r) => {
    stats.activeStudents = r ? r.total : 0;
    db.get(`SELECT COUNT(*) as total FROM students WHERE status='pending'`, [], (e, r) => {
      stats.pendingStudents = r ? r.total : 0;
      db.get(`SELECT COUNT(*) as total FROM events WHERE status='active'`, [], (e, r) => {
        stats.activeEvents = r ? r.total : 0;
        db.get(`SELECT COUNT(*) as total FROM attendance WHERE status='Present'`, [], (e, r) => {
          stats.present = r ? r.total : 0;
          db.get(`SELECT COUNT(*) as total FROM attendance WHERE status='Late'`, [], (e, r) => {
            stats.late = r ? r.total : 0;
            db.get(`SELECT COUNT(*) as total FROM attendance WHERE status='Absent'`, [], (e, r) => {
              stats.absent = r ? r.total : 0;
              db.get(`SELECT COUNT(*) as total FROM attendance WHERE status='Excused'`, [], (e, r) => {
                stats.excused = r ? r.total : 0;

                const totalMarked = stats.present + stats.late + stats.absent + stats.excused;
                const attendanceRate = totalMarked > 0 ? (((stats.present + stats.late) / totalMarked) * 100).toFixed(1) : "0.0";

                db.all(
                  `SELECT a.*, s.first_name, s.last_name, e.name as event_name 
                   FROM attendance a 
                   JOIN students s ON a.student_id = s.id 
                   JOIN events e ON a.event_id = e.id 
                   ORDER BY a.id DESC LIMIT 5`,
                  [],
                  (err, recentScans) => {
                    const scansHtml = recentScans
                      .map(
                        (s) => `
                      <tr>
                        <td>${s.first_name} ${s.last_name}</td>
                        <td>${s.event_name}</td>
                        <td>${s.time_in ? new Date(s.time_in).toLocaleTimeString() : '-'}</td>
                        <td><span class="badge bg-${s.status === 'Present' ? 'success' : s.status === 'Late' ? 'warning' : 'danger'}">${s.status}</span></td>
                      </tr>
                    `
                      )
                      .join("");

                    const html = `
                      <h2 class="mb-4">Admin Dashboard</h2>
                      <div class="row g-3 mb-4">
                        <div class="col-md-3">
                          <div class="card bg-primary text-white p-3">
                            <h5>Active Students</h5>
                            <h2>${stats.activeStudents}</h2>
                          </div>
                        </div>
                        <div class="col-md-3">
                          <div class="card bg-warning text-dark p-3">
                            <h5>Pending Requests</h5>
                            <h2>${stats.pendingStudents}</h2>
                          </div>
                        </div>
                        <div class="col-md-3">
                          <div class="card bg-success text-white p-3">
                            <h5>Active Events</h5>
                            <h2>${stats.activeEvents}</h2>
                          </div>
                        </div>
                        <div class="col-md-3">
                          <div class="card bg-info text-white p-3">
                            <h5>Attendance Rate</h5>
                            <h2>${attendanceRate}%</h2>
                          </div>
                        </div>
                      </div>

                      <div class="row g-3 mb-4">
                        <div class="col-md-3"><div class="card p-3 border-start border-success border-4">Present: <strong>${stats.present}</strong></div></div>
                        <div class="col-md-3"><div class="card p-3 border-start border-warning border-4">Late: <strong>${stats.late}</strong></div></div>
                        <div class="col-md-3"><div class="card p-3 border-start border-danger border-4">Absent: <strong>${stats.absent}</strong></div></div>
                        <div class="col-md-3"><div class="card p-3 border-start border-secondary border-4">Excused: <strong>${stats.excused}</strong></div></div>
                      </div>

                      <div class="card">
                        <div class="card-header bg-dark text-white">Recent Attendance Logs</div>
                        <div class="card-body p-0">
                          <table class="table table-striped mb-0">
                            <thead><tr><th>Student</th><th>Event</th><th>Time In</th><th>Status</th></tr></thead>
                            <tbody>${scansHtml || '<tr><td colspan="4" class="text-center">No recent records</td></tr>'}</tbody>
                          </table>
                        </div>
                      </div>
                    `;
                    res.send(renderPage("Dashboard", html, req.session.user));
                  }
                );
              });
            });
          });
        });
      });
    });
  });
});

app.get("/admin/students", requireAuth(["admin"]), (req, res) => {
  db.all(
    `SELECT s.*, p.name as position_name, u.username, u.raw_temp_password 
     FROM students s 
     LEFT JOIN positions p ON s.position_id = p.id 
     LEFT JOIN users u ON u.student_id = s.id
     ORDER BY s.id DESC`,
    [],
    (err, students) => {
      const rows = students
        .map(
          (s) => `
        <tr>
          <td><img src="${s.photo_path}" width="40" height="40" class="rounded-circle" style="object-fit: cover;"></td>
          <td>${s.student_number || 'N/A'}</td>
          <td>${s.first_name} ${s.last_name}</td>
          <td>${s.position_name || 'Unassigned'}</td>
          <td><span class="badge bg-dark">${s.username || 'N/A'}</span></td>
          <td><span class="badge bg-info text-dark">${s.raw_temp_password || 'N/A'}</span></td>
          <td><span class="badge bg-${s.status === 'approved' ? 'success' : s.status === 'pending' ? 'warning' : 'danger'}">${s.status}</span></td>
          <td>
            ${
              s.status === 'pending'
                ? `<a href="/admin/students/approve/${s.id}" class="btn btn-sm btn-success">Approve</a>`
                : `<a href="/admin/students/regenerate-qr/${s.id}" class="btn btn-sm btn-secondary">Regen QR</a>`
            }
            <a href="/admin/students/delete/${s.id}" class="btn btn-sm btn-danger" onclick="return confirm('Delete student permanently?')">Delete</a>
          </td>
        </tr>
      `
        )
        .join("");

      const html = `
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h2>Student & Credentials Management</h2>
        </div>
        <div class="card">
          <div class="card-body p-0">
            <table class="table table-striped align-middle mb-0">
              <thead>
                <tr>
                  <th>Photo</th>
                  <th>Student #</th>
                  <th>Name</th>
                  <th>Position</th>
                  <th>Username</th>
                  <th>Temp Password</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>${rows || '<tr><td colspan="8" class="text-center">No students registered yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      `;
      res.send(renderPage("Student & Credentials Management", html, req.session.user));
    }
  );
});

app.get("/admin/students/approve/:id", requireAuth(["admin"]), (req, res) => {
  const studentId = req.params.id;
  const studentNum = "STU-" + Math.floor(100000 + Math.random() * 900000);
  const username = "user_" + Math.floor(1000 + Math.random() * 9000);
  const rawPassword = "Pass" + Math.floor(1000 + Math.random() * 9000);
  const qrToken = "QR-" + Date.now() + "-" + Math.random().toString(36).substring(2, 9);
  const passwordHash = bcrypt.hashSync(rawPassword, 10);

  db.run(
    `UPDATE students SET student_number = ?, qr_token = ?, status = 'approved' WHERE id = ?`,
    [studentNum, qrToken, studentId],
    function (err) {
      if (err) return res.status(500).send("Approval failed.");

      db.run(
        `INSERT INTO users (username, password_hash, raw_temp_password, role, student_id) VALUES (?, ?, ?, 'student', ?)`,
        [username, passwordHash, rawPassword, studentId],
        function (err) {
          logAudit(req.session.user.username, "APPROVE_STUDENT", `Approved Student ID: ${studentId}, Generated User: ${username}`, req.ip);
          const html = `
            <div class="card p-4 mx-auto mt-5" style="max-width: 500px;">
              <h4 class="text-success"><i class="bi bi-check-circle me-2"></i>Student Approved!</h4>
              <p>Generated Credentials:</p>
              <ul>
                <li><strong>Student Number:</strong> ${studentNum}</li>
                <li><strong>Username:</strong> ${username}</li>
                <li><strong>Temporary Password:</strong> ${rawPassword}</li>
              </ul>
              <a href="/admin/students" class="btn btn-primary">Return to Students List</a>
            </div>
          `;
          res.send(renderPage("Approval Success", html, req.session.user));
        }
      );
    }
  );
});

app.get("/admin/students/regenerate-qr/:id", requireAuth(["admin"]), (req, res) => {
  const newToken = "QR-" + Date.now() + "-" + Math.random().toString(36).substring(2, 9);
  db.run(`UPDATE students SET qr_token = ? WHERE id = ?`, [newToken, req.params.id], function (err) {
    logAudit(req.session.user.username, "REGENERATE_QR", `Regenerated QR Token for Student ID: ${req.params.id}`, req.ip);
    res.redirect("/admin/students");
  });
});

app.get("/admin/students/delete/:id", requireAuth(["admin"]), (req, res) => {
  db.run(`DELETE FROM students WHERE id = ?`, [req.params.id], function (err) {
    logAudit(req.session.user.username, "DELETE_STUDENT", `Deleted Student ID: ${req.params.id}`, req.ip);
    res.redirect("/admin/students");
  });
});

app.get("/admin/positions", requireAuth(["admin"]), (req, res) => {
  db.all(`SELECT * FROM positions ORDER BY id DESC`, [], (err, positions) => {
    const listHtml = positions
      .map(
        (p) => `
      <tr>
        <td>${p.name}</td>
        <td>${p.description || '-'}</td>
        <td>
          <a href="/admin/positions/delete/${p.id}" class="btn btn-sm btn-danger" onclick="return confirm('Delete position?')">Delete</a>
        </td>
      </tr>
    `
      )
      .join("");

    const html = `
      <div class="row">
        <div class="col-md-4">
          <div class="card">
            <div class="card-header bg-primary text-white">Add Position</div>
            <div class="card-body">
              <form action="/admin/positions/add" method="POST">
                <div class="mb-3">
                  <label class="form-label">Position Name</label>
                  <input type="text" name="name" class="form-control" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">Description</label>
                  <textarea name="description" class="form-control" rows="2"></textarea>
                </div>
                <button type="submit" class="btn btn-primary w-100">Save Position</button>
              </form>
            </div>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card">
            <div class="card-header bg-dark text-white">Club Positions</div>
            <div class="card-body p-0">
              <table class="table table-striped mb-0">
                <thead><tr><th>Name</th><th>Description</th><th>Action</th></tr></thead>
                <tbody>${listHtml}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
    res.send(renderPage("Positions", html, req.session.user));
  });
});

app.post("/admin/positions/add", requireAuth(["admin"]), (req, res) => {
  const { name, description } = req.body;
  db.run(`INSERT INTO positions (name, description) VALUES (?, ?)`, [name, description], function (err) {
    logAudit(req.session.user.username, "ADD_POSITION", `Added Position: ${name}`, req.ip);
    res.redirect("/admin/positions");
  });
});

app.get("/admin/positions/delete/:id", requireAuth(["admin"]), (req, res) => {
  db.run(`DELETE FROM positions WHERE id = ?`, [req.params.id], function (err) {
    logAudit(req.session.user.username, "DELETE_POSITION", `Deleted Position ID: ${req.params.id}`, req.ip);
    res.redirect("/admin/positions");
  });
});

app.get("/admin/events", requireAuth(["admin"]), (req, res) => {
  db.all(`SELECT * FROM events ORDER BY id DESC`, [], (err, events) => {
    const eventRows = events
      .map(
        (e) => `
      <tr>
        <td><strong>${e.name}</strong></td>
        <td>${e.type}</td>
        <td>${e.event_date} (${e.start_time} - ${e.end_time})</td>
        <td>${e.location}</td>
        <td><span class="badge bg-${e.status === 'active' ? 'success' : e.status === 'upcoming' ? 'info' : 'secondary'}">${e.status}</span></td>
        <td>
          <a href="/admin/events/status/${e.id}?status=active" class="btn btn-sm btn-success">Activate</a>
          <a href="/admin/events/status/${e.id}?status=completed" class="btn btn-sm btn-dark">Complete</a>
        </td>
      </tr>
    `
      )
      .join("");

    const html = `
      <div class="row">
        <div class="col-md-4">
          <div class="card">
            <div class="card-header bg-success text-white">Create Event</div>
            <div class="card-body">
              <form action="/admin/events/add" method="POST">
                <div class="mb-2"><label>Event Name</label><input type="text" name="name" class="form-control" required></div>
                <div class="mb-2">
                  <label>Type</label>
                  <select name="type" class="form-select">
                    <option>General Attendance</option><option>Club Meeting</option><option>General Assembly</option>
                    <option>Seminar</option><option>Workshop</option><option>Training</option><option>School Activities</option>
                  </select>
                </div>
                <div class="mb-2"><label>Date</label><input type="date" name="event_date" class="form-control" required></div>
                <div class="mb-2"><label>Start Time</label><input type="time" name="start_time" class="form-control" required></div>
                <div class="mb-2"><label>End Time</label><input type="time" name="end_time" class="form-control" required></div>
                <div class="mb-2"><label>Location</label><input type="text" name="location" class="form-control" required></div>
                <div class="mb-3"><label>Late Threshold (Mins)</label><input type="number" name="late_threshold_minutes" class="form-control" value="15" required></div>
                <button type="submit" class="btn btn-success w-100">Create Event</button>
              </form>
            </div>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card">
            <div class="card-header bg-dark text-white">Event List</div>
            <div class="card-body p-0">
              <table class="table table-striped mb-0">
                <thead><tr><th>Name</th><th>Type</th><th>Schedule</th><th>Location</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>${eventRows || '<tr><td colspan="6" class="text-center">No events found</td></tr>'}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
    res.send(renderPage("Events", html, req.session.user));
  });
});

app.post("/admin/events/add", requireAuth(["admin"]), (req, res) => {
  const { name, type, event_date, start_time, end_time, location, late_threshold_minutes } = req.body;
  db.run(
    `INSERT INTO events (name, type, event_date, start_time, end_time, location, late_threshold_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, type, event_date, start_time, end_time, location, late_threshold_minutes],
    function (err) {
      logAudit(req.session.user.username, "CREATE_EVENT", `Created Event: ${name}`, req.ip);
      res.redirect("/admin/events");
    }
  );
});

app.get("/admin/events/status/:id", requireAuth(["admin"]), (req, res) => {
  const { status } = req.query;
  const eventId = req.params.id;

  db.run(`UPDATE events SET status = ? WHERE id = ?`, [status, eventId], function (err) {
    if (status === "completed") {
      db.all(`SELECT id FROM students WHERE status='approved'`, [], (err, students) => {
        students.forEach((s) => {
          db.run(
            `INSERT OR IGNORE INTO attendance (event_id, student_id, status) VALUES (?, ?, 'Absent')`,
            [eventId, s.id]
          );
        });
      });
    }
    logAudit(req.session.user.username, "UPDATE_EVENT_STATUS", `Set Event ID ${eventId} to ${status}`, req.ip);
    res.redirect("/admin/events");
  });
});

// --- CAMERA SCANNER INTERFACE ---

app.get("/scanner", requireAuth(["admin", "scanner"]), (req, res) => {
  db.all(`SELECT * FROM events WHERE status = 'active'`, [], (err, activeEvents) => {
    let eventOptions = activeEvents.map((e) => `<option value="${e.id}">${e.name} (${e.type})</option>`).join("");

    const html = `
      <div class="row justify-content-center">
        <div class="col-md-8">
          <div class="card shadow">
            <div class="card-header bg-dark text-white d-flex justify-content-between align-items-center">
              <h4 class="mb-0"><i class="bi bi-qr-code-scan me-2"></i>Attendance QR Scanner</h4>
              <span class="badge bg-success">Live Mode</span>
            </div>
            <div class="card-body">
              <div class="row mb-3">
                <div class="col-md-6">
                  <label class="form-label">Active Event Target *</label>
                  <select id="eventSelect" class="form-select" required>
                    <option value="">-- Select Active Event --</option>
                    ${eventOptions}
                  </select>
                </div>
                <div class="col-md-6">
                  <label class="form-label">Scan Action Mode</label>
                  <select id="scanMode" class="form-select">
                    <option value="time_in">Time In</option>
                    <option value="time_out">Time Out</option>
                  </select>
                </div>
              </div>

              <!-- Camera Viewport Frame -->
              <div id="reader" style="width: 100%; border-radius: 8px; overflow: hidden; background: #000;" class="mb-3"></div>

              <!-- Voice & Audio Configuration Bar -->
              <div class="p-3 bg-light rounded border mb-3">
                <h6>Voice & Sound Settings</h6>
                <div class="form-check form-check-inline">
                  <input class="form-check-input" type="checkbox" id="voiceToggle" checked>
                  <label class="form-check-label" for="voiceToggle">Voice Announcements</label>
                </div>
                <div class="form-check form-check-inline">
                  <input class="form-check-input" type="checkbox" id="soundToggle" checked>
                  <label class="form-check-label" for="soundToggle">Audio Beep</label>
                </div>
              </div>

              <!-- Realtime Scan Notification Banner with Student Photo -->
              <div id="scanCard" class="card d-none border-2">
                <div class="card-body">
                  <div class="row align-items-center">
                    <div class="col-md-4 text-center mb-3 mb-md-0">
                      <img id="studentPhoto" src="" alt="Student Photo" class="img-thumbnail rounded-circle" style="width: 150px; height: 150px; object-fit: cover; border: 3px solid #0d6efd;">
                    </div>
                    <div class="col-md-8">
                      <h3 id="studentName" class="mb-1 text-primary">Student Name</h3>
                      <p class="mb-1"><strong>Student No:</strong> <span id="studentNumber">-</span></p>
                      <p class="mb-1"><strong>Position:</strong> <span id="studentPosition">-</span></p>
                      <p class="mb-2"><strong>Status:</strong> <span id="attendanceBadge" class="badge bg-success fs-6">Present</span></p>
                      <div id="scanMessage" class="alert alert-info py-2 mb-0" role="alert">
                        Attendance recorded successfully.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

      <script>
        let html5QrCode = null;
        let lastScannedToken = "";
        let lastScanTime = 0;

        function playAudioSignal(type) {
          if (!document.getElementById('soundToggle').checked) return;
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          
          if (type === 'success') {
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.15);
          } else {
            osc.frequency.value = 220;
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
          }
        }

        function speakPhrase(text) {
          if (!document.getElementById('voiceToggle').checked) return;
          if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 0.95;
            utterance.pitch = 1.0;
            window.speechSynthesis.speak(utterance);
          }
        }

        function onScanSuccess(decodedText) {
          const now = Date.now();
          if (decodedText === lastScannedToken && (now - lastScanTime) < 4000) {
            return;
          }
          lastScannedToken = decodedText;
          lastScanTime = now;

          const eventId = document.getElementById('eventSelect').value;
          const scanMode = document.getElementById('scanMode').value;

          if (!eventId) {
            playAudioSignal('error');
            speakPhrase('Please select an active event first.');
            alert('Select an active event from the dropdown menu.');
            return;
          }

          fetch('/api/process-scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: decodedText, event_id: eventId, mode: scanMode })
          })
          .then(res => res.json())
          .then(data => {
            const scanCard = document.getElementById('scanCard');
            const studentPhoto = document.getElementById('studentPhoto');
            const studentName = document.getElementById('studentName');
            const studentNumber = document.getElementById('studentNumber');
            const studentPosition = document.getElementById('studentPosition');
            const attendanceBadge = document.getElementById('attendanceBadge');
            const scanMessage = document.getElementById('scanMessage');

            scanCard.classList.remove('d-none');

            if (data.status === 'success' || data.status === 'duplicate') {
              studentPhoto.src = data.student_photo || 'https://via.placeholder.com/150';
              studentName.innerText = data.student_name;
              studentNumber.innerText = data.student_number || 'N/A';
              studentPosition.innerText = data.student_position || 'Member';

              if (data.status === 'success') {
                playAudioSignal('success');
                scanCard.className = 'card border-2 border-success';
                attendanceBadge.className = 'badge fs-6 bg-' + (data.attendance_status === 'Present' ? 'success' : data.attendance_status === 'Late' ? 'warning' : 'info');
                attendanceBadge.innerText = data.attendance_status;
                scanMessage.className = 'alert alert-success py-2 mb-0';
                scanMessage.innerText = data.message;
                speakPhrase(data.student_name + ', ' + data.message);
              } else {
                playAudioSignal('error');
                scanCard.className = 'card border-2 border-warning';
                attendanceBadge.className = 'badge fs-6 bg-warning text-dark';
                attendanceBadge.innerText = 'Duplicate';
                scanMessage.className = 'alert alert-warning py-2 mb-0';
                scanMessage.innerText = data.message;
                speakPhrase(data.student_name + ', you are already recorded.');
              }
            } else {
              playAudioSignal('error');
              scanCard.className = 'card border-2 border-danger';
              studentPhoto.src = 'https://via.placeholder.com/150?text=Invalid';
              studentName.innerText = 'Unknown Student';
              studentNumber.innerText = '-';
              studentPosition.innerText = '-';
              attendanceBadge.className = 'badge fs-6 bg-danger';
              attendanceBadge.innerText = 'Error';
              scanMessage.className = 'alert alert-danger py-2 mb-0';
              scanMessage.innerText = data.message;
              speakPhrase('Invalid QR code.');
            }
          })
          .catch(err => {
            console.error(err);
          });
        }

        // Camera Fallback initialization to prevent NotReadableError on mobile
        document.addEventListener("DOMContentLoaded", function() {
          html5QrCode = new Html5Qrcode("reader");
          const config = { fps: 10, qrbox: { width: 250, height: 250 } };

          html5QrCode.start({ facingMode: "environment" }, config, onScanSuccess)
            .catch(err => {
              console.warn("FacingMode failed, enumerating cameras...", err);
              Html5Qrcode.getCameras().then(devices => {
                if (devices && devices.length > 0) {
                  const cameraId = devices[devices.length - 1].id;
                  html5QrCode.start(cameraId, config, onScanSuccess).catch(e => {
                    alert("Camera Error: Close other camera apps and refresh.");
                  });
                }
              });
            });
        });
      </script>
    `;
    res.send(renderPage("Scanner", html, req.session.user));
  });
});

// Process Attendance API Endpoint
app.post("/api/process-scan", (req, res) => {
  const { qr_token, event_id, mode } = req.body;

  db.get(
    `SELECT s.*, p.name as position_name 
     FROM students s 
     LEFT JOIN positions p ON s.position_id = p.id 
     WHERE s.qr_token = ? AND s.status = 'approved'`,
    [qr_token],
    (err, student) => {
      if (err || !student) {
        return res.json({ status: "invalid", message: "Invalid QR code." });
      }

      db.get(`SELECT * FROM events WHERE id = ?`, [event_id], (err, event) => {
        if (err || !event) {
          return res.json({ status: "error", message: "Event not found." });
        }

        const fullName = `${student.first_name} ${student.last_name}`;
        const now = new Date();

        if (mode === "time_in") {
          db.get(`SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student.id], (err, record) => {
            if (record && record.time_in) {
              return res.json({
                status: "duplicate",
                student_name: fullName,
                student_number: student.student_number,
                student_position: student.position_name,
                student_photo: student.photo_path,
                message: "You are already recorded."
              });
            }

            const eventStart = new Date(`${event.event_date}T${event.start_time}`);
            const thresholdMs = (event.late_threshold_minutes || 15) * 60 * 1000;
            const status = now.getTime() > eventStart.getTime() + thresholdMs ? "Late" : "Present";

            db.run(
              `INSERT INTO attendance (event_id, student_id, time_in, status)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(event_id, student_id) DO UPDATE SET time_in = excluded.time_in, status = excluded.status`,
              [event_id, student.id, now.toISOString(), status],
              function (err) {
                if (err) return res.json({ status: "error", message: "Database failure recording scan." });
                logAudit("Scanner", "TIME_IN", `Scanned ${fullName} for Event ID ${event_id}`, req.ip);
                return res.json({
                  status: "success",
                  student_name: fullName,
                  student_number: student.student_number,
                  student_position: student.position_name,
                  student_photo: student.photo_path,
                  attendance_status: status,
                  message: "attendance recorded"
                });
              }
            );
          });
        } else if (mode === "time_out") {
          db.run(
            `UPDATE attendance SET time_out = ? WHERE event_id = ? AND student_id = ?`,
            [now.toISOString(), event_id, student.id],
            function (err) {
              logAudit("Scanner", "TIME_OUT", `Time Out for ${fullName} on Event ID ${event_id}`, req.ip);
              return res.json({
                status: "success",
                student_name: fullName,
                student_number: student.student_number,
                student_position: student.position_name,
                student_photo: student.photo_path,
                attendance_status: "Time Out",
                message: "time out recorded"
              });
            }
          );
        }
      });
    }
  );
});

// --- DATABASE BACKUP & RESTORE ENGINE ---

app.get("/admin/database", requireAuth(["admin"]), (req, res) => {
  fs.readdir(path.join(__dirname, "backups"), (err, files) => {
    const backupList = (files || []).filter(f => f.endsWith('.sqlite')).map(f => `
      <tr>
        <td>${f}</td>
        <td>
          <a href="/admin/database/download/${f}" class="btn btn-sm btn-primary">Download</a>
        </td>
      </tr>
    `).join('');

    const html = `
      <div class="row">
        <div class="col-md-6">
          <div class="card mb-4">
            <div class="card-header bg-dark text-white">Create Database Backup</div>
            <div class="card-body">
              <p class="text-muted">Download a complete SQLite snapshot of your system to prevent data loss.</p>
              <a href="/admin/database/create-backup" class="btn btn-success w-100">
                <i class="bi bi-download me-2"></i>Generate & Download Backup (.sqlite)
              </a>
            </div>
          </div>
          <div class="card">
            <div class="card-header bg-danger text-white">Restore Database</div>
            <div class="card-body">
              <form action="/admin/database/restore" method="POST" enctype="multipart/form-data">
                <div class="mb-3">
                  <label class="form-label">Upload SQLite Backup File</label>
                  <input type="file" name="backup_file" class="form-control" required>
                </div>
                <button type="submit" class="btn btn-danger w-100" onclick="return confirm('Warning: Restoring will overwrite all current data. Continue?')">
                  Restore Database
                </button>
              </form>
            </div>
          </div>
        </div>

        <div class="col-md-6">
          <div class="card">
            <div class="card-header bg-secondary text-white">Local System Backups</div>
            <div class="card-body p-0">
              <table class="table table-striped mb-0">
                <thead><tr><th>File Name</th><th>Action</th></tr></thead>
                <tbody>${backupList || '<tr><td colspan="2" class="text-center">No backup files found</td></tr>'}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
    res.send(renderPage("Database Management", html, req.session.user));
  });
});

app.get("/admin/database/create-backup", requireAuth(["admin"]), (req, res) => {
  const backupFileName = `backup-${Date.now()}.sqlite`;
  const backupPath = path.join(__dirname, "backups", backupFileName);

  db.run("PRAGMA wal_checkpoint(FULL);", () => {
    fs.copyFile(dbPath, backupPath, (err) => {
      if (err) return res.status(500).send("Backup Generation Failed.");
      logAudit(req.session.user.username, "CREATE_BACKUP", `Created Backup: ${backupFileName}`, req.ip);
      res.download(backupPath);
    });
  });
});

app.get("/admin/database/download/:filename", requireAuth(["admin"]), (req, res) => {
  const filePath = path.join(__dirname, "backups", req.params.filename);
  res.download(filePath);
});

app.post("/admin/database/restore", requireAuth(["admin"]), upload.single("backup_file"), (req, res) => {
  if (!req.file) return res.status(400).send("Please upload a file.");

  const uploadedPath = req.file.path;
  db.close((err) => {
    fs.copyFile(uploadedPath, dbPath, (err) => {
      if (err) return res.status(500).send("Failed to restore database.");
      logAudit(req.session.user.username, "RESTORE_DATABASE", `Restored DB from ${req.file.filename}`, req.ip);
      res.send(renderPage("Restore Success", `<div class="alert alert-success mt-5 text-center">Database restored successfully! <a href="/login">Re-login to System</a></div>`));
    });
  });
});

// --- PRINTING ENGINE WITH CREDENTIALS PRINTED ON ID CARD ---

app.get("/api/qr/:token", async (req, res) => {
  try {
    const qrDataUrl = await QRCode.toDataURL(req.params.token, {
      width: 300,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" }
    });
    const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
    const img = Buffer.from(base64Data, "base64");
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": img.length });
    res.end(img);
  } catch (err) {
    res.status(500).send("Error generating QR");
  }
});

// UPDATED: Print IDs Route including Temporary Username & Password directly on the printed ID Layout
app.get("/admin/print-ids", requireAuth(["admin"]), (req, res) => {
  db.get(`SELECT * FROM settings WHERE id = 1`, [], (err, settings) => {
    db.all(
      `SELECT s.*, p.name as position_name, u.username, u.raw_temp_password 
       FROM students s 
       LEFT JOIN positions p ON s.position_id = p.id 
       LEFT JOIN users u ON u.student_id = s.id 
       WHERE s.status = 'approved'`,
      [],
      (err, students) => {
        const idCardsHtml = students
          .map(
            (s) => `
          <div class="id-card-frame m-2">
            <div class="d-flex justify-content-between align-items-center mb-1 border-bottom pb-1">
              <img src="${settings.school_logo || 'https://via.placeholder.com/30'}" height="22">
              <div class="text-center" style="font-size: 8px; font-weight: bold; line-height: 1.1;">
                <div>${settings.school_name}</div>
                <div class="text-primary">${settings.club_name}</div>
              </div>
              <img src="${settings.club_logo || 'https://via.placeholder.com/30'}" height="22">
            </div>
            <div class="row g-1 align-items-center">
              <div class="col-4 text-center">
                <img src="${s.photo_path}" style="width: 55px; height: 55px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc;">
              </div>
              <div class="col-8" style="font-size: 9px; line-height: 1.2;">
                <div><strong>Name:</strong> ${s.first_name} ${s.last_name}</div>
                <div><strong>ID No:</strong> ${s.student_number}</div>
                <div><strong>Position:</strong> ${s.position_name || 'Member'}</div>
                <div><strong>S.Y.:</strong> ${settings.school_year}</div>
              </div>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-1 border-top pt-1">
              <div style="font-size: 8px; background: #f8f9fa; padding: 2px 4px; border-radius: 3px; border: 1px solid #ddd;">
                <div><strong>User:</strong> ${s.username || 'N/A'}</div>
                <div><strong>Pass:</strong> ${s.raw_temp_password || 'N/A'}</div>
              </div>
              <img src="/api/qr/${s.qr_token}" style="height: 48px; width: 48px;">
            </div>
          </div>
        `
          )
          .join("");

        const html = `
          <div class="no-print mb-3">
            <button onclick="window.print()" class="btn btn-primary"><i class="bi bi-printer me-2"></i>Print A4 Sheet Page</button>
          </div>
          <div class="a4-page">
            <div class="d-flex flex-wrap justify-content-start">
              ${idCardsHtml || '<div>No approved students available for printing.</div>'}
            </div>
          </div>
        `;
        res.send(renderPage("Print Student IDs", html, req.session.user));
      }
    );
  });
});

app.get("/member", requireAuth(["student"]), (req, res) => {
  const studentId = req.session.user.student_id;
  db.get(
    `SELECT s.*, p.name as position_name FROM students s LEFT JOIN positions p ON s.position_id = p.id WHERE s.id = ?`,
    [studentId],
    (err, student) => {
      db.all(
        `SELECT a.*, e.name as event_name, e.event_date FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.student_id = ? ORDER BY a.id DESC`,
        [studentId],
        (err, attendanceRecords) => {
          const attendanceRows = attendanceRecords
            .map(
              (r) => `
            <tr>
              <td>${r.event_name}</td>
              <td>${r.event_date}</td>
              <td>${r.time_in ? new Date(r.time_in).toLocaleTimeString() : '-'}</td>
              <td><span class="badge bg-${r.status === 'Present' ? 'success' : r.status === 'Late' ? 'warning' : 'danger'}">${r.status}</span></td>
            </tr>
          `
            )
            .join("");

          const html = `
            <div class="row">
              <div class="col-md-4">
                <div class="card text-center p-3">
                  <img src="${student.photo_path}" class="rounded-circle mx-auto mb-3" style="width: 120px; height: 120px; object-fit: cover;">
                  <h4>${student.first_name} ${student.last_name}</h4>
                  <p class="text-muted mb-1">${student.position_name || 'Member'}</p>
                  <p class="badge bg-secondary mb-3">${student.student_number}</p>
                  <div class="border p-2 rounded bg-light">
                    <img src="/api/qr/${student.qr_token}" class="img-fluid" style="max-width: 180px;">
                    <div class="small text-muted mt-1">Official Member QR Token</div>
                  </div>
                </div>
              </div>
              <div class="col-md-8">
                <div class="card mb-4">
                  <div class="card-header bg-primary text-white">Attendance History</div>
                  <div class="card-body p-0">
                    <table class="table table-striped mb-0">
                      <thead><tr><th>Event</th><th>Date</th><th>Time In</th><th>Status</th></tr></thead>
                      <tbody>${attendanceRows || '<tr><td colspan="4" class="text-center">No attendance history found</td></tr>'}</tbody>
                    </table>
                  </div>
                </div>

                <div class="card">
                  <div class="card-header bg-dark text-white">Change Account Password</div>
                  <div class="card-body">
                    <form action="/member/change-password" method="POST">
                      <div class="mb-3">
                        <label class="form-label">New Password</label>
                        <input type="password" name="new_password" class="form-control" required minlength="6">
                      </div>
                      <button type="submit" class="btn btn-dark">Update Password</button>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          `;
          res.send(renderPage("Student Portal", html, req.session.user));
        }
      );
    }
  );
});

app.post("/member/change-password", requireAuth(["student"]), (req, res) => {
  const { new_password } = req.body;
  const passwordHash = bcrypt.hashSync(new_password, 10);
  db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, req.session.user.id], function (err) {
    logAudit(req.session.user.username, "CHANGE_PASSWORD", "Student changed password", req.ip);
    res.send(renderPage("Password Updated", `<div class="alert alert-success">Password updated successfully! <a href="/member">Return to Portal</a></div>`, req.session.user));
  });
});

app.get("/admin/settings", requireAuth(["admin"]), (req, res) => {
  db.get(`SELECT * FROM settings WHERE id = 1`, [], (err, settings) => {
    const html = `
      <div class="row justify-content-center">
        <div class="col-md-6">
          <div class="card">
            <div class="card-header bg-dark text-white">School & Club Branding Settings</div>
            <div class="card-body">
              <form action="/admin/settings" method="POST" enctype="multipart/form-data">
                <div class="mb-3">
                  <label class="form-label">School Name</label>
                  <input type="text" name="school_name" class="form-control" value="${settings.school_name}" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">Club Name</label>
                  <input type="text" name="club_name" class="form-control" value="${settings.club_name}" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">School Year</label>
                  <input type="text" name="school_year" class="form-control" value="${settings.school_year}" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">School Logo</label>
                  <input type="file" name="school_logo" class="form-control">
                </div>
                <div class="mb-3">
                  <label class="form-label">Club Logo</label>
                  <input type="file" name="club_logo" class="form-control">
                </div>
                <button type="submit" class="btn btn-primary w-100">Save System Settings</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    `;
    res.send(renderPage("Settings", html, req.session.user));
  });
});

app.post(
  "/admin/settings",
  requireAuth(["admin"]),
  upload.fields([{ name: "school_logo", maxCount: 1 }, { name: "club_logo", maxCount: 1 }]),
  (req, res) => {
    const { school_name, club_name, school_year } = req.body;

    db.get(`SELECT * FROM settings WHERE id = 1`, [], (err, settings) => {
      let school_logo = settings.school_logo;
      let club_logo = settings.club_logo;

      if (req.files["school_logo"]) {
        school_logo = "/uploads/logos/" + req.files["school_logo"][0].filename;
      }
      if (req.files["club_logo"]) {
        club_logo = "/uploads/logos/" + req.files["club_logo"][0].filename;
      }

      db.run(
        `UPDATE settings SET school_name = ?, club_name = ?, school_year = ?, school_logo = ?, club_logo = ? WHERE id = 1`,
        [school_name, club_name, school_year, school_logo, club_logo],
        function (err) {
          logAudit(req.session.user.username, "UPDATE_SETTINGS", "Updated school and club settings", req.ip);
          res.redirect("/admin/settings");
        }
      );
    });
  }
);

app.get("/admin/reports", requireAuth(["admin"]), (req, res) => {
  db.all(`SELECT * FROM events ORDER BY id DESC`, [], (err, events) => {
    const eventOptions = events.map((e) => `<option value="${e.id}">${e.name}</option>`).join("");

    const html = `
      <div class="card mb-4">
        <div class="card-header bg-dark text-white">Generate Attendance & Audit Reports</div>
        <div class="card-body">
          <form action="/admin/reports/export" method="GET" class="row g-3">
            <div class="col-md-4">
              <label class="form-label">Event Target</label>
              <select name="event_id" class="form-select">
                <option value="">All Events</option>
                ${eventOptions}
              </select>
            </div>
            <div class="col-md-3">
              <label class="form-label">Status Filter</label>
              <select name="status" class="form-select">
                <option value="">All Statuses</option>
                <option>Present</option>
                <option>Late</option>
                <option>Absent</option>
                <option>Excused</option>
              </select>
            </div>
            <div class="col-md-3 d-flex align-items-end">
              <button type="submit" class="btn btn-success w-100"><i class="bi bi-file-earmark-excel me-2"></i>Export CSV Report</button>
            </div>
          </form>
        </div>
      </div>
    `;
    res.send(renderPage("Reports", html, req.session.user));
  });
});

app.get("/admin/reports/export", requireAuth(["admin"]), (req, res) => {
  const { event_id, status } = req.query;
  let query = `
    SELECT a.id, e.name as event_name, s.student_number, s.first_name, s.last_name, a.time_in, a.time_out, a.status 
    FROM attendance a 
    JOIN events e ON a.event_id = e.id 
    JOIN students s ON a.student_id = s.id 
    WHERE 1=1
  `;
  const params = [];

  if (event_id) {
    query += ` AND a.event_id = ?`;
    params.push(event_id);
  }
  if (status) {
    query += ` AND a.status = ?`;
    params.push(status);
  }

  db.all(query, params, (err, rows) => {
    let csv = "Record ID,Event Name,Student Number,First Name,Last Name,Time In,Time Out,Status\n";
    rows.forEach((r) => {
      csv += `"${r.id}","${r.event_name}","${r.student_number}","${r.first_name}","${r.last_name}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=Attendance_Report_${Date.now()}.csv`);
    res.status(200).send(csv);
  });
});

app.get("/admin/audit", requireAuth(["admin"]), (req, res) => {
  db.all(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100`, [], (err, logs) => {
    const rows = logs
      .map(
        (l) => `
      <tr>
        <td>${l.timestamp}</td>
        <td><strong>${l.username}</strong></td>
        <td><span class="badge bg-secondary">${l.action}</span></td>
        <td>${l.details}</td>
        <td>${l.ip_address}</td>
      </tr>
    `
      )
      .join("");

    const html = `
      <div class="card">
        <div class="card-header bg-dark text-white">System Security & Action Audit Logs</div>
        <div class="card-body p-0">
          <table class="table table-striped mb-0" style="font-size: 13px;">
            <thead><tr><th>Timestamp</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" class="text-center">No audit logs available</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
    res.send(renderPage("Audit Logs", html, req.session.user));
  });
});

app.use((req, res) => {
  res.status(404).send(renderPage("Page Not Found", `<div class="text-center mt-5"><h1>404</h1><p>Requested endpoint does not exist.</p><a href="/">Return Home</a></div>`));
});

// Safe Database Shutdown Handlers to guarantee data persistence
function shutdownGracefully() {
  console.log("\nClosing SQLite database connection cleanly...");
  db.close((err) => {
    if (err) {
      console.error("Error closing database:", err.message);
    } else {
      console.log("Database connection closed securely.");
    }
    process.exit(0);
  });
}

process.on("SIGINT", shutdownGracefully);
process.on("SIGTERM", shutdownGracefully);
process.on("SIGUSR2", shutdownGracefully);

app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`Server successfully started on port ${PORT}`);
  console.log(`Timezone forced to: Asia/Manila`);
  console.log(`Persistent Database: data.sqlite (WAL Mode Enabled)`);
  console.log(`=================================================`);
});
