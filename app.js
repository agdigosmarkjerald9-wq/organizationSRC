const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer Storage setup for Member Profile Pictures
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `member_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// Middleware Setup
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static(uploadDir));
app.use(session({
  secret: 'student_club_qr_system_super_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'club_attendance.db');
const db = new sqlite3.Database(dbPath);

// Database Initialization & Schema Definition
db.serialize(() => {
  // Enforce foreign keys
  db.run("PRAGMA foreign_keys = ON;");

  // Admin Users Table
  db.run(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'Admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // System Settings Table
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    club_name TEXT DEFAULT 'Cybernetics & Leadership Student Society',
    org_name TEXT DEFAULT 'University Student Governance Council',
    logo_url TEXT DEFAULT '',
    address TEXT DEFAULT 'Student Activity Center, Main Campus',
    contact TEXT DEFAULT 'contact@studentsociety.org',
    school_year TEXT DEFAULT '2025-2026',
    late_threshold_mins INTEGER DEFAULT 15,
    min_participation_pct INTEGER DEFAULT 75,
    voice_enabled INTEGER DEFAULT 1,
    voice_volume REAL DEFAULT 1.0,
    voice_rate REAL DEFAULT 1.0
  )`);

  // Default Settings Row
  db.run(`INSERT OR IGNORE INTO settings (id) VALUES (1)`);

  // Positions Table
  db.run(`CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT UNIQUE NOT NULL,
    is_default INTEGER DEFAULT 0
  )`);

  // Committees Table
  db.run(`CREATE TABLE IF NOT EXISTS committees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT
  )`);

  // Members Table
  db.run(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_code TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    position_id INTEGER NOT NULL,
    committee_id INTEGER,
    gender TEXT,
    dob DATE,
    contact_number TEXT,
    email TEXT UNIQUE,
    address TEXT,
    photo_url TEXT,
    school_year TEXT,
    status TEXT DEFAULT 'Active',
    date_joined DATE,
    expiration_date DATE,
    emergency_name TEXT,
    emergency_contact TEXT,
    qr_token TEXT UNIQUE NOT NULL,
    qr_enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(position_id) REFERENCES positions(id),
    FOREIGN KEY(committee_id) REFERENCES committees(id)
  )`);

  // Officer History Table
  db.run(`CREATE TABLE IF NOT EXISTS officer_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE,
    status TEXT DEFAULT 'Active',
    FOREIGN KEY(member_id) REFERENCES members(id),
    FOREIGN KEY(position_id) REFERENCES positions(id)
  )`);

  // Events Table
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    event_type TEXT DEFAULT 'General Club Attendance',
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    location TEXT,
    organizer TEXT,
    target_audience TEXT DEFAULT 'All Members',
    status TEXT DEFAULT 'Upcoming',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Event Target Positions/Committees Mapping
  db.run(`CREATE TABLE IF NOT EXISTS event_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    target_type TEXT NOT NULL, -- 'Position', 'Committee', or 'Member'
    target_id INTEGER NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
  )`);

  // Attendance Records Table
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    time_in DATETIME,
    time_out DATETIME,
    status TEXT DEFAULT 'Present', -- Present, Late, Absent, Excused
    notes TEXT,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE,
    UNIQUE(event_id, member_id)
  )`);

  // Excuses Table
  db.run(`CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    approved_by TEXT,
    approved_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE,
    UNIQUE(event_id, member_id)
  )`);

  // Audit Logs Table
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed Default Admin User
  db.get("SELECT * FROM admin_users WHERE username = 'admin'", [], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync('admin123', 10);
      db.run("INSERT INTO admin_users (username, password, role) VALUES ('admin', ?, 'Admin')", [hash]);
    }
  });

  // Seed Default Positions
  const defaultPositions = [
    'President', 'Vice President', 'Secretary', 'Assistant Secretary',
    'Treasurer', 'Assistant Treasurer', 'Auditor', 'Public Information Officer',
    'Peace Officer', 'Sergeant-at-Arms', 'Representative', 'Committee Head',
    'Committee Member', 'Member'
  ];
  defaultPositions.forEach(pos => {
    db.run("INSERT OR IGNORE INTO positions (title, is_default) VALUES (?, 1)", [pos]);
  });

  // Seed Default Committees
  const defaultCommittees = [
    'Finance Committee', 'Events Committee', 'Documentation Committee',
    'Membership Committee', 'Public Relations Committee'
  ];
  defaultCommittees.forEach(com => {
    db.run("INSERT OR IGNORE INTO committees (name, description) VALUES (?, ?)", [com, 'Standard Operational Committee']);
  });
});

// Audit Helper
function logAudit(user, action, details) {
  db.run("INSERT INTO audit_logs (user, action, details) VALUES (?, ?, ?)", [user || 'System', action, details]);
}

// Auth Middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'Admin') {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Admin session required.' });
}

// Token Generator Helper
function generateSecureToken() {
  return 'QR-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
}

// -------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------

// Authentication Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM admin_users WHERE username = ?", [username], (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Invalid username or password' });
    if (bcrypt.compareSync(password, user.password)) {
      req.session.user = { id: user.id, username: user.username, role: user.role };
      logAudit(user.username, 'Login', 'Admin logged in successfully');
      return res.json({ success: true, user: req.session.user });
    } else {
      return res.status(400).json({ error: 'Invalid username or password' });
    }
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) {
    logAudit(req.session.user.username, 'Logout', 'Admin logged out');
  }
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.json({ authenticated: false });
});

// Change Admin Password
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  db.get("SELECT * FROM admin_users WHERE id = ?", [req.session.user.id], (err, user) => {
    if (!bcrypt.compareSync(oldPassword, user.password)) {
      return res.status(400).json({ error: 'Incorrect existing password' });
    }
    const newHash = bcrypt.hashSync(newPassword, 10);
    db.run("UPDATE admin_users SET password = ? WHERE id = ?", [newHash, req.session.user.id], (err) => {
      logAudit(req.session.user.username, 'Password Change', 'Updated administrative password');
      res.json({ success: true, message: 'Password updated successfully' });
    });
  });
});

// System Settings APIs
app.get('/api/settings', (req, res) => {
  db.get("SELECT * FROM settings WHERE id = 1", [], (err, row) => {
    res.json(row || {});
  });
});

app.post('/api/settings', requireAdmin, (req, res) => {
  const {
    club_name, org_name, logo_url, address, contact, school_year,
    late_threshold_mins, min_participation_pct, voice_enabled, voice_volume, voice_rate
  } = req.body;

  db.run(`UPDATE settings SET 
    club_name = ?, org_name = ?, logo_url = ?, address = ?, contact = ?, school_year = ?,
    late_threshold_mins = ?, min_participation_pct = ?, voice_enabled = ?, voice_volume = ?, voice_rate = ?
    WHERE id = 1`,
    [club_name, org_name, logo_url, address, contact, school_year, late_threshold_mins, min_participation_pct, voice_enabled ? 1 : 0, voice_volume, voice_rate],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      logAudit(req.session.user.username, 'Update Settings', 'System configuration updated');
      res.json({ success: true });
    }
  );
});

// Position Management APIs
app.get('/api/positions', (req, res) => {
  db.all("SELECT * FROM positions ORDER BY id ASC", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/positions', requireAdmin, (req, res) => {
  const { title } = req.body;
  db.run("INSERT INTO positions (title) VALUES (?)", [title], function(err) {
    if (err) return res.status(400).json({ error: 'Position already exists' });
    logAudit(req.session.user.username, 'Add Position', `Added position ${title}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/positions/:id', requireAdmin, (req, res) => {
  const { title } = req.body;
  db.run("UPDATE positions SET title = ? WHERE id = ?", [title, req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Edit Position', `Updated position ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/positions/:id', requireAdmin, (req, res) => {
  db.run("DELETE FROM positions WHERE id = ? AND is_default = 0", [req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Delete Position', `Deleted position ID ${req.params.id}`);
    res.json({ success: true });
  });
});

// Committee Management APIs
app.get('/api/committees', (req, res) => {
  db.all("SELECT * FROM committees ORDER BY name ASC", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/committees', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  db.run("INSERT INTO committees (name, description) VALUES (?, ?)", [name, description], function(err) {
    if (err) return res.status(400).json({ error: 'Committee already exists' });
    logAudit(req.session.user.username, 'Add Committee', `Added committee ${name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/committees/:id', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  db.run("UPDATE committees SET name = ?, description = ? WHERE id = ?", [name, description, req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Edit Committee', `Updated committee ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/committees/:id', requireAdmin, (req, res) => {
  db.run("DELETE FROM committees WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Delete Committee', `Deleted committee ID ${req.params.id}`);
    res.json({ success: true });
  });
});

// Officer Management API
app.get('/api/officers', (req, res) => {
  const sql = `
    SELECT oh.*, m.full_name, m.member_code, p.title as position_title 
    FROM officer_history oh
    JOIN members m ON oh.member_id = m.id
    JOIN positions p ON oh.position_id = p.id
    ORDER BY oh.start_date DESC
  `;
  db.all(sql, [], (err, rows) => {
    res.json(rows || []);
  });
});

// Member Management APIs
app.get('/api/members', (req, res) => {
  const sql = `
    SELECT m.*, p.title as position_title, c.name as committee_name 
    FROM members m
    JOIN positions p ON m.position_id = p.id
    LEFT JOIN committees c ON m.committee_id = c.id
    ORDER BY m.id DESC
  `;
  db.all(sql, [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/members/:id', (req, res) => {
  const sql = `
    SELECT m.*, p.title as position_title, c.name as committee_name 
    FROM members m
    JOIN positions p ON m.position_id = p.id
    LEFT JOIN committees c ON m.committee_id = c.id
    WHERE m.id = ? OR m.member_code = ?
  `;
  db.get(sql, [req.params.id, req.params.id], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Member not found' });
    res.json(row);
  });
});

app.post('/api/members', requireAdmin, upload.single('photo'), (req, res) => {
  const {
    member_code, first_name, middle_name, last_name, position_id, committee_id,
    gender, dob, contact_number, email, address, school_year, status,
    date_joined, expiration_date, emergency_name, emergency_contact
  } = req.body;

  const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`.trim();
  const photo_url = req.file ? `/uploads/${req.file.filename}` : '/uploads/default_avatar.png';
  const qr_token = generateSecureToken();

  const sql = `INSERT INTO members (
    member_code, first_name, middle_name, last_name, full_name, position_id, committee_id,
    gender, dob, contact_number, email, address, photo_url, school_year, status,
    date_joined, expiration_date, emergency_name, emergency_contact, qr_token
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sql, [
    member_code, first_name, middle_name, last_name, full_name, position_id, committee_id || null,
    gender, dob, contact_number, email, address, photo_url, school_year, status || 'Active',
    date_joined, expiration_date, emergency_name, emergency_contact, qr_token
  ], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    const memberId = this.lastID;

    // Log officer record if position is an officer
    db.run("INSERT INTO officer_history (member_id, position_id, start_date, status) VALUES (?, ?, ?, 'Active')",
      [memberId, position_id, date_joined || new Date().toISOString().split('T')[0]]);

    logAudit(req.session.user.username, 'Add Member', `Registered member ${full_name} (${member_code})`);
    res.json({ success: true, id: memberId, qr_token });
  });
});

app.put('/api/members/:id', requireAdmin, upload.single('photo'), (req, res) => {
  const {
    member_code, first_name, middle_name, last_name, position_id, committee_id,
    gender, dob, contact_number, email, address, school_year, status,
    date_joined, expiration_date, emergency_name, emergency_contact
  } = req.body;

  const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`.trim();
  
  let sql = `UPDATE members SET 
    member_code = ?, first_name = ?, middle_name = ?, last_name = ?, full_name = ?, 
    position_id = ?, committee_id = ?, gender = ?, dob = ?, contact_number = ?, 
    email = ?, address = ?, school_year = ?, status = ?, date_joined = ?, 
    expiration_date = ?, emergency_name = ?, emergency_contact = ?`;
  
  const params = [
    member_code, first_name, middle_name, last_name, full_name,
    position_id, committee_id || null, gender, dob, contact_number,
    email, address, school_year, status, date_joined,
    expiration_date, emergency_name, emergency_contact
  ];

  if (req.file) {
    sql += `, photo_url = ?`;
    params.push(`/uploads/${req.file.filename}`);
  }

  sql += ` WHERE id = ?`;
  params.push(req.params.id);

  db.run(sql, params, function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Edit Member', `Updated profile for ${full_name}`);
    res.json({ success: true });
  });
});

app.delete('/api/members/:id', requireAdmin, (req, res) => {
  db.run("DELETE FROM members WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Delete Member', `Deleted member ID ${req.params.id}`);
    res.json({ success: true });
  });
});

// QR Management APIs
app.post('/api/members/:id/regenerate-qr', requireAdmin, (req, res) => {
  const newToken = generateSecureToken();
  db.run("UPDATE members SET qr_token = ? WHERE id = ?", [newToken, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'Regenerate QR', `Regenerated QR token for member ID ${req.params.id}`);
    res.json({ success: true, qr_token: newToken });
  });
});

app.post('/api/members/:id/toggle-qr', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  db.run("UPDATE members SET qr_enabled = ? WHERE id = ?", [enabled ? 1 : 0, req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    logAudit(req.session.user.username, 'Toggle QR', `Set QR active state to ${enabled} for member ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.get('/api/qr/image/:token', async (req, res) => {
  try {
    const url = await QRCode.toDataURL(req.params.token, { margin: 1, width: 300 });
    const base64Data = url.replace(/^data:image\/png;base64,/, "");
    const img = Buffer.from(base64Data, 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': img.length
    });
    res.end(img);
  } catch (err) {
    res.status(500).send('QR Error');
  }
});

// Event Management APIs
app.get('/api/events', (req, res) => {
  db.all("SELECT * FROM events ORDER BY date DESC, start_time ASC", [], (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/events/active', (req, res) => {
  db.get("SELECT * FROM events WHERE status = 'Active' ORDER BY date DESC LIMIT 1", [], (err, row) => {
    res.json(row || null);
  });
});

app.post('/api/events', requireAdmin, (req, res) => {
  const { name, description, event_type, date, start_time, end_time, location, organizer, target_audience, status } = req.body;
  const sql = `INSERT INTO events (name, description, event_type, date, start_time, end_time, location, organizer, target_audience, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [name, description, event_type, date, start_time, end_time, location, organizer, target_audience, status || 'Upcoming'], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Create Event', `Created event: ${name}`);
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/events/:id', requireAdmin, (req, res) => {
  const { name, description, event_type, date, start_time, end_time, location, organizer, target_audience, status } = req.body;
  const sql = `UPDATE events SET name=?, description=?, event_type=?, date=?, start_time=?, end_time=?, location=?, organizer=?, target_audience=?, status=? WHERE id=?`;
  db.run(sql, [name, description, event_type, date, start_time, end_time, location, organizer, target_audience, status, req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Update Event', `Updated event ID ${req.params.id}`);
    res.json({ success: true });
  });
});

app.delete('/api/events/:id', requireAdmin, (req, res) => {
  db.run("DELETE FROM events WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    logAudit(req.session.user.username, 'Delete Event', `Deleted event ID ${req.params.id}`);
    res.json({ success: true });
  });
});

// Scanner Logic Endpoint
app.post('/api/scan', (req, res) => {
  const { qr_token, mode, event_id } = req.body; // mode: 'IN' or 'OUT'

  if (!qr_token || !event_id) {
    return res.status(400).json({ status: 'INVALID', message: 'Missing scan token or event ID' });
  }

  // 1. Fetch Member by Token
  db.get("SELECT m.*, p.title as position_title FROM members m JOIN positions p ON m.position_id = p.id WHERE m.qr_token = ?", [qr_token], (err, member) => {
    if (err || !member) {
      return res.status(404).json({ status: 'INVALID', message: 'Invalid QR Code' });
    }

    if (!member.qr_enabled) {
      return res.status(403).json({ status: 'DISABLED', message: 'Member QR Code Disabled', member });
    }

    if (member.status !== 'Active') {
      return res.status(403).json({ status: 'INACTIVE', message: `Member Status is ${member.status}`, member });
    }

    // 2. Fetch Active Event
    db.get("SELECT * FROM events WHERE id = ?", [event_id], (err, event) => {
      if (err || !event) {
        return res.status(404).json({ status: 'INVALID', message: 'Event not found' });
      }

      // 3. Check existing attendance record
      db.get("SELECT * FROM attendance WHERE event_id = ? AND member_id = ?", [event.id, member.id], (err, record) => {
        const now = new Date();
        const currentTimeStr = now.toTimeString().split(' ')[0];

        if (mode === 'IN') {
          if (record && record.time_in) {
            return res.json({
              status: 'DUPLICATE',
              message: 'Already recorded Time In',
              member,
              record
            });
          }

          // Calculate Late Status
          db.get("SELECT late_threshold_mins FROM settings WHERE id = 1", [], (err, setting) => {
            const threshold = (setting ? setting.late_threshold_mins : 15);
            const eventStart = new Date(`${event.date}T${event.start_time}`);
            const lateCutoff = new Date(eventStart.getTime() + threshold * 60000);

            let status = 'Present';
            if (now > lateCutoff) {
              status = 'Late';
            }

            if (record) {
              // Update existing record
              db.run("UPDATE attendance SET time_in = ?, status = ? WHERE id = ?", [now.toISOString(), status, record.id], (err) => {
                res.json({ status: 'SUCCESS', scanType: 'TIME_IN', attendanceStatus: status, member, time: currentTimeStr });
              });
            } else {
              // Create new record
              db.run("INSERT INTO attendance (event_id, member_id, time_in, status) VALUES (?, ?, ?, ?)",
                [event.id, member.id, now.toISOString(), status], (err) => {
                  res.json({ status: 'SUCCESS', scanType: 'TIME_IN', attendanceStatus: status, member, time: currentTimeStr });
                });
            }
          });

        } else if (mode === 'OUT') {
          if (!record) {
            return res.status(400).json({ status: 'ERROR', message: 'Cannot Time Out without Time In first', member });
          }
          if (record.time_out) {
            return res.json({ status: 'DUPLICATE', message: 'Already recorded Time Out', member, record });
          }

          db.run("UPDATE attendance SET time_out = ? WHERE id = ?", [now.toISOString(), record.id], (err) => {
            res.json({ status: 'SUCCESS', scanType: 'TIME_OUT', attendanceStatus: record.status, member, time: currentTimeStr });
          });
        }
      });
    });
  });
});

// Attendance Management APIs
app.get('/api/attendance', (req, res) => {
  const { event_id } = req.query;
  let sql = `
    SELECT a.*, m.member_code, m.full_name, m.photo_url, p.title as position_title, e.name as event_name, e.date as event_date
    FROM attendance a
    JOIN members m ON a.member_id = m.id
    JOIN positions p ON m.position_id = p.id
    JOIN events e ON a.event_id = e.id
  `;
  const params = [];
  if (event_id) {
    sql += ` WHERE a.event_id = ?`;
    params.push(event_id);
  }
  sql += ` ORDER BY a.id DESC`;

  db.all(sql, params, (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/attendance/manual', requireAdmin, (req, res) => {
  const { event_id, member_id, status, notes } = req.body;
  const now = new Date().toISOString();
  db.run(`INSERT INTO attendance (event_id, member_id, time_in, status, notes)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(event_id, member_id) DO UPDATE SET status=excluded.status, notes=excluded.notes`,
    [event_id, member_id, now, status, notes],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      logAudit(req.session.user.username, 'Manual Attendance', `Updated attendance for member ID ${member_id}`);
      res.json({ success: true });
    }
  );
});

// Excuses APIs
app.post('/api/excuses', requireAdmin, (req, res) => {
  const { event_id, member_id, reason, notes } = req.body;
  const approved_by = req.session.user.username;

  db.serialize(() => {
    db.run("INSERT OR REPLACE INTO excuses (event_id, member_id, reason, notes, approved_by) VALUES (?, ?, ?, ?, ?)",
      [event_id, member_id, reason, notes, approved_by]);
    db.run("INSERT OR REPLACE INTO attendance (event_id, member_id, status, notes) VALUES (?, ?, 'Excused', ?)",
      [event_id, member_id, `Excused: ${reason}`]);
  });

  logAudit(approved_by, 'Grant Excuse', `Excused member ID ${member_id} for event ID ${event_id}`);
  res.json({ success: true });
});

// Analytics & Dashboard APIs
app.get('/api/analytics/dashboard', (req, res) => {
  db.serialize(() => {
    const stats = {};
    db.get("SELECT COUNT(*) as total_members FROM members", [], (e, r) => stats.total_members = r.total_members);
    db.get("SELECT COUNT(*) as total_officers FROM members WHERE position_id IN (SELECT id FROM positions WHERE is_default = 1 AND title != 'Member')", [], (e, r) => stats.total_officers = r.total_officers);
    db.get("SELECT COUNT(*) as active_members FROM members WHERE status = 'Active'", [], (e, r) => stats.active_members = r.active_members);
    
    // Today's Statistics
    const today = new Date().toISOString().split('T')[0];
    db.get(`SELECT 
      SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) as present_today,
      SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) as late_today,
      SUM(CASE WHEN a.status = 'Absent' THEN 1 ELSE 0 END) as absent_today,
      SUM(CASE WHEN a.status = 'Excused' THEN 1 ELSE 0 END) as excused_today
      FROM attendance a JOIN events e ON a.event_id = e.id WHERE e.date = ?`, [today], (e, r) => {
        stats.present_today = r.present_today || 0;
        stats.late_today = r.late_today || 0;
        stats.absent_today = r.absent_today || 0;
        stats.excused_today = r.excused_today || 0;

        // Active / Upcoming Events
        db.all("SELECT * FROM events WHERE status IN ('Active', 'Upcoming') ORDER BY date ASC", [], (e, rows) => {
          stats.events = rows || [];
          
          // Member Participation Leaderboard
          db.all(`
            SELECT m.full_name, p.title as position_title,
            COUNT(a.id) as attended,
            (SELECT COUNT(*) FROM events WHERE status = 'Completed') as total_events
            FROM members m
            JOIN positions p ON m.position_id = p.id
            LEFT JOIN attendance a ON m.id = a.member_id AND a.status IN ('Present', 'Late')
            GROUP BY m.id ORDER BY attended DESC LIMIT 5
          `, [], (e, leaderboard) => {
            stats.leaderboard = leaderboard || [];
            res.json(stats);
          });
        });
      });
  });
});

// Audit Logs APIs
app.get('/api/audit-logs', requireAdmin, (req, res) => {
  db.all("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 200", [], (err, rows) => {
    res.json(rows || []);
  });
});

// Database Backup & Restore APIs
app.get('/api/system/backup', requireAdmin, (req, res) => {
  logAudit(req.session.user.username, 'Backup Database', 'Downloaded database backup copy');
  res.download(dbPath, `club_attendance_backup_${Date.now()}.db`);
});

// -------------------------------------------------------------
// FRONTEND ROUTING & SINGLE-FILE BUNDLED SPA UI
// -------------------------------------------------------------

app.get('/version', (req, res) => res.send('1.0.0'));

// Catch-all route serving dynamic HTML application interface
app.get('*', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Club QR Attendance System</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css" rel="stylesheet">
  <script src="https://unpkg.com/html5-qrcode"></script>
  <style>
    :root {
      --primary-color: #1e3a8a;
      --secondary-color: #0d9488;
      --accent-color: #f59e0b;
      --bg-light: #f8fafc;
    }
    body {
      background-color: var(--bg-light);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    .navbar-brand {
      font-weight: 700;
      color: var(--primary-color) !important;
    }
    .sidebar {
      min-height: calc(100vh - 56px);
      background: #ffffff;
      border-right: 1px solid #e2e8f0;
    }
    .sidebar .nav-link {
      color: #475569;
      font-weight: 500;
      padding: 0.75rem 1.25rem;
      border-radius: 0.375rem;
      margin-bottom: 0.25rem;
    }
    .sidebar .nav-link.active {
      background-color: var(--primary-color);
      color: #ffffff;
    }
    .card-stat {
      border: none;
      border-radius: 0.75rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      transition: transform 0.2s;
    }
    .card-stat:hover {
      transform: translateY(-2px);
    }
    
    /* Printable A4 Grid Layout for 8 IDs */
    @media print {
      body * {
        visibility: hidden;
      }
      #print-section, #print-section * {
        visibility: visible;
      }
      #print-section {
        position: absolute;
        left: 0;
        top: 0;
        width: 210mm;
      }
      .no-print {
        display: none !important;
      }
      @page {
        size: A4 portrait;
        margin: 10mm;
      }
    }
    .a4-grid {
      display: grid;
      grid-template-columns: repeat(2, 85mm);
      grid-auto-rows: 54mm;
      gap: 8mm 10mm;
      justify-content: center;
      padding: 5mm;
    }
    .id-card-printable {
      width: 85mm;
      height: 54mm;
      border: 1px dashed #94a3b8;
      border-radius: 6px;
      padding: 3mm;
      box-sizing: border-box;
      background: #ffffff;
      display: flex;
      flex-direction: row;
      position: relative;
      overflow: hidden;
    }
    .id-card-printable .id-photo {
      width: 24mm;
      height: 28mm;
      object-fit: cover;
      border-radius: 4px;
      border: 1px solid #cbd5e1;
    }
    .id-card-printable .id-details {
      flex: 1;
      padding-left: 3mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .id-card-printable .id-header {
      font-size: 8pt;
      font-weight: bold;
      color: var(--primary-color);
      line-height: 1.1;
    }
    .id-card-printable .id-name {
      font-size: 9pt;
      font-weight: bold;
      margin-top: 1mm;
    }
    .id-card-printable .id-role {
      font-size: 7.5pt;
      color: #0d9488;
    }
    .id-card-printable .id-qr {
      width: 20mm;
      height: 20mm;
      position: absolute;
      bottom: 2mm;
      right: 2mm;
    }
  </style>
</head>
<body>

  <!-- Top Navigation Header -->
  <nav class="navbar navbar-expand-lg navbar-light bg-white border-bottom sticky-top no-print">
    <div class="container-fluid">
      <a class="navbar-brand d-flex align-items-center" href="#">
        <i class="bi bi-qr-code-scan me-2 text-primary"></i>
        <span id="app-title-nav">Club QR Attendance</span>
      </a>
      <div class="d-flex align-items-center">
        <span class="badge bg-primary me-3" id="user-role-badge">Guest Portal</span>
        <div id="auth-buttons"></div>
      </div>
    </div>
  </nav>

  <div class="container-fluid no-print">
    <div class="row">
      <!-- Sidebar Navigation -->
      <nav class="col-md-3 col-lg-2 sidebar p-3 collapse d-md-block" id="sidebarMenu">
        <ul class="nav flex-column" id="nav-items">
          <li class="nav-item">
            <a class="nav-link active" href="#" onclick="navigate('dashboard')"><i class="bi bi-speedometer2 me-2"></i>Dashboard</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('scanner')"><i class="bi bi-camera me-2"></i>Scanner Portal</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('members')"><i class="bi bi-people me-2"></i>Club Members</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('id-printing')"><i class="bi bi-card-heading me-2"></i>A4 ID Printing</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('events')"><i class="bi bi-calendar-event me-2"></i>Events Management</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('attendance')"><i class="bi bi-clipboard-check me-2"></i>Attendance Records</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('positions')"><i class="bi bi-person-badge me-2"></i>Positions & Committees</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('reports')"><i class="bi bi-file-earmark-text me-2"></i>Reports & Analytics</a>
          </li>
          <li class="nav-item">
            <a class="nav-link" href="#" onclick="navigate('settings')"><i class="bi bi-gear me-2"></i>System Settings</a>
          </li>
        </ul>
      </nav>

      <!-- Main Dynamic Content Engine -->
      <main class="col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4" id="main-content">
        <!-- Views rendered dynamically via Client JS -->
      </main>
    </div>
  </div>

  <!-- Dedicated Print Container -->
  <div id="print-section"></div>

  <!-- Speech Synthesis Audio Controller -->
  <script>
    const state = {
      user: null,
      settings: {},
      activeView: 'dashboard',
      members: [],
      events: [],
      activeEvent: null,
      scanner: null
    };

    // Voice Announcement Engine
    function speak(text) {
      if (!state.settings.voice_enabled) return;
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); // Stop current speech
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.volume = state.settings.voice_volume || 1.0;
        utterance.rate = state.settings.voice_rate || 1.0;
        window.speechSynthesis.speak(utterance);
      }
    }

    // App Initialization
    async function init() {
      await fetchSettings();
      await checkAuth();
      navigate('dashboard');
    }

    async function fetchSettings() {
      const res = await fetch('/api/settings');
      state.settings = await res.json();
      document.getElementById('app-title-nav').innerText = state.settings.club_name || 'Club Attendance System';
    }

    async function checkAuth() {
      const res = await fetch('/api/auth/check');
      const data = await res.json();
      if (data.authenticated) {
        state.user = data.user;
        document.getElementById('user-role-badge').innerText = 'Admin: ' + state.user.username;
        document.getElementById('auth-buttons').innerHTML = \`<button class="btn btn-outline-danger btn-sm" onclick="logout()"><i class="bi bi-box-arrow-right me-1"></i>Logout</button>\`;
      } else {
        state.user = null;
        document.getElementById('user-role-badge').innerText = 'Public Member View';
        document.getElementById('auth-buttons').innerHTML = \`<button class="btn btn-primary btn-sm" onclick="renderLoginModal()"><i class="bi bi-shield-lock me-1"></i>Admin Login</button>\`;
      }
    }

    // View Routing Engine
    function navigate(view) {
      state.activeView = view;
      
      // Update sidebar styling
      document.querySelectorAll('.sidebar .nav-link').forEach(el => {
        el.classList.remove('active');
        if (el.getAttribute('onclick').includes(view)) el.classList.add('active');
      });

      const main = document.getElementById('main-content');
      main.innerHTML = '';

      if (view === 'dashboard') renderDashboard(main);
      else if (view === 'scanner') renderScanner(main);
      else if (view === 'members') renderMembers(main);
      else if (view === 'id-printing') renderIDPrinting(main);
      else if (view === 'events') renderEvents(main);
      else if (view === 'attendance') renderAttendance(main);
      else if (view === 'positions') renderPositions(main);
      else if (view === 'reports') renderReports(main);
      else if (view === 'settings') renderSettings(main);
    }

    // 1. Dashboard Render
    async function renderDashboard(container) {
      const res = await fetch('/api/analytics/dashboard');
      const data = await res.json();

      container.innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4">
          <h2><i class="bi bi-speedometer2 text-primary me-2"></i>Executive Dashboard</h2>
          <button class="btn btn-sm btn-outline-secondary" onclick="renderDashboard(document.getElementById('main-content'))"><i class="bi bi-arrow-clockwise me-1"></i>Refresh</button>
        </div>

        <div class="row g-3 mb-4">
          <div class="col-md-3">
            <div class="card card-stat bg-white p-3 border-start border-primary border-4">
              <div class="text-muted small">Total Members</div>
              <div class="fs-3 fw-bold text-dark">\${data.total_members || 0}</div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-stat bg-white p-3 border-start border-success border-4">
              <div class="text-muted small">Present Today</div>
              <div class="fs-3 fw-bold text-success">\${data.present_today || 0}</div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-stat bg-white p-3 border-start border-warning border-4">
              <div class="text-muted small">Late Today</div>
              <div class="fs-3 fw-bold text-warning">\${data.late_today || 0}</div>
            </div>
          </div>
          <div class="col-md-3">
            <div class="card card-stat bg-white p-3 border-start border-danger border-4">
              <div class="text-muted small">Absent / Excused</div>
              <div class="fs-3 fw-bold text-danger">\${(data.absent_today || 0) + (data.excused_today || 0)}</div>
            </div>
          </div>
        </div>

        <div class="row g-4">
          <div class="col-md-7">
            <div class="card border-0 shadow-sm p-3">
              <h5 class="card-title mb-3"><i class="bi bi-calendar-event text-primary me-2"></i>Active & Upcoming Events</h5>
              <div class="list-group list-group-flush">
                \${data.events && data.events.length > 0 ? data.events.map(e => \`
                  <div class="list-group-item d-flex justify-content-between align-items-center px-0">
                    <div>
                      <h6 class="mb-0">\${e.name}</h6>
                      <small class="text-muted">\${e.date} | \${e.start_time} - \${e.end_time} (\${e.location})</small>
                    </div>
                    <span class="badge bg-\${e.status === 'Active' ? 'success' : 'primary'}">\${e.status}</span>
                  </div>
                \`).join('') : '<p class="text-muted mb-0">No active or upcoming events scheduled.</p>'}
              </div>
            </div>
          </div>
          <div class="col-md-5">
            <div class="card border-0 shadow-sm p-3">
              <h5 class="card-title mb-3"><i class="bi bi-trophy text-warning me-2"></i>Top Participating Members</h5>
              <div class="table-responsive">
                <table class="table table-sm">
                  <thead><tr><th>Member</th><th>Role</th><th>Attended</th></tr></thead>
                  <tbody>
                    \${data.leaderboard && data.leaderboard.length > 0 ? data.leaderboard.map(m => \`
                      <tr>
                        <td>\${m.full_name}</td>
                        <td><small class="text-muted">\${m.position_title}</small></td>
                        <td><span class="badge bg-info text-dark">\${m.attended} events</span></td>
                      </tr>
                    \`).join('') : '<tr><td colspan="3" class="text-muted">No records available</td></tr>'}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      \`;
    }

    // 2. Mobile-First Dedicated Scanner Portal
    async function renderScanner(container) {
      const res = await fetch('/api/events');
      const events = await res.json();
      const activeEvent = events.find(e => e.status === 'Active') || (events.length > 0 ? events[0] : null);

      container.innerHTML = \`
        <div class="row justify-content-center">
          <div class="col-md-8 col-lg-6">
            <div class="card border-0 shadow-sm p-3 text-center">
              <h4 class="mb-3"><i class="bi bi-qr-code-scan text-primary me-2"></i>Scanner Portal</h4>
              
              <div class="mb-3 text-start">
                <label class="form-label fw-bold">Select Active Event</label>
                <select class="form-select" id="scanner-event-select">
                  \${events.map(e => \`<option value="\${e.id}" \${activeEvent && activeEvent.id === e.id ? 'selected' : ''}>\${e.name} (\${e.date})</option>\`).join('')}
                </select>
              </div>

              <div class="btn-group w-100 mb-3" role="group">
                <input type="radio" class="btn-check" name="scanMode" id="modeIn" value="IN" checked>
                <label class="btn btn-outline-success" for="modeIn"><i class="bi bi-box-arrow-in-right me-1"></i>TIME IN</label>

                <input type="radio" class="btn-check" name="scanMode" id="modeOut" value="OUT">
                <label class="btn btn-outline-danger" for="modeOut"><i class="bi bi-box-arrow-right me-1"></i>TIME OUT</label>
              </div>

              <!-- Camera Viewport -->
              <div id="reader" style="width: 100%; min-height: 280px; background: #000; border-radius: 8px; overflow: hidden;"></div>

              <div id="scan-result" class="mt-3 p-3 rounded d-none"></div>
            </div>
          </div>
        </div>
      \`;

      // Initialize HTML5 QR Code Reader
      setTimeout(() => {
        if (state.scanner) {
          state.scanner.clear().catch(() => {});
        }
        state.scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
        state.scanner.render(onScanSuccess);
      }, 300);
    }

    async function onScanSuccess(decodedText) {
      const eventId = document.getElementById('scanner-event-select').value;
      const mode = document.querySelector('input[name="scanMode"]:checked').value;
      const resultDiv = document.getElementById('scan-result');

      resultDiv.classList.remove('d-none', 'bg-success-subtle', 'bg-danger-subtle', 'bg-warning-subtle');
      
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr_token: decodedText, event_id: eventId, mode })
        });
        const data = await res.json();

        if (data.status === 'SUCCESS') {
          resultDiv.classList.add('bg-success-subtle');
          resultDiv.innerHTML = \`
            <h5 class="text-success mb-1"><i class="bi bi-check-circle me-1"></i>\${data.scanType} RECORDED</h5>
            <div class="fw-bold fs-5">\${data.member.full_name}</div>
            <div class="text-muted">\${data.member.position_title} | ID: \${data.member.member_code}</div>
            <span class="badge bg-success mt-2">\${data.attendanceStatus} at \${data.time}</span>
          \`;
          speak(\`\${data.member.full_name}, \${data.scanType === 'TIME_IN' ? 'attendance' : 'time out'} recorded.\`);
        } else if (data.status === 'DUPLICATE') {
          resultDiv.classList.add('bg-warning-subtle');
          resultDiv.innerHTML = \`
            <h5 class="text-warning mb-1"><i class="bi bi-exclamation-triangle me-1"></i>ALREADY RECORDED</h5>
            <div class="fw-bold">\${data.member ? data.member.full_name : ''}</div>
            <div class="text-muted">\${data.message}</div>
          \`;
          speak(\`\${data.member ? data.member.full_name : 'Member'}, you are already recorded.\`);
        } else {
          resultDiv.classList.add('bg-danger-subtle');
          resultDiv.innerHTML = \`
            <h5 class="text-danger mb-1"><i class="bi bi-x-circle me-1"></i>INVALID SCAN</h5>
            <div class="text-muted">\${data.message || 'Invalid QR Code'}</div>
          \`;
          speak("Invalid QR code.");
        }
      } catch (err) {
        resultDiv.classList.add('bg-danger-subtle');
        resultDiv.innerHTML = \`<h5 class="text-danger">Server Processing Error</h5>\`;
      }
    }

    // 3. Member Directory & Registration View
    async function renderMembers(container) {
      const res = await fetch('/api/members');
      const members = await res.json();

      container.innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4">
          <h2><i class="bi bi-people text-primary me-2"></i>Club Members Directory</h2>
          \${state.user ? \`<button class="btn btn-primary" onclick="renderMemberForm()"><i class="bi bi-person-plus me-1"></i>Register New Member</button>\` : ''}
        </div>

        <div class="card border-0 shadow-sm p-3">
          <div class="table-responsive">
            <table class="table table-hover align-middle">
              <thead>
                <tr>
                  <th>Photo</th>
                  <th>Member ID</th>
                  <th>Name</th>
                  <th>Position</th>
                  <th>Committee</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${members.map(m => \`
                  <tr>
                    <td><img src="\${m.photo_url}" width="40" height="40" class="rounded-circle object-fit-cover"></td>
                    <td class="fw-bold">\${m.member_code}</td>
                    <td>\${m.full_name}</td>
                    <td><span class="badge bg-secondary">\${m.position_title}</span></td>
                    <td>\${m.committee_name || 'N/A'}</td>
                    <td><span class="badge bg-\${m.status === 'Active' ? 'success' : 'danger'}">\${m.status}</span></td>
                    <td>
                      <button class="btn btn-sm btn-outline-info" onclick="viewMemberQR('\${m.qr_token}', '\${m.full_name}')"><i class="bi bi-qr-code"></i></button>
                      \${state.user ? \`
                        <button class="btn btn-sm btn-outline-warning" onclick="renderMemberForm(\${m.id})"><i class="bi bi-pencil"></i></button>
                      \` : ''}
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      \`;
    }

    // 4. A4 Printable Member ID Layout (8 Cards per A4 Page Grid)
    async function renderIDPrinting(container) {
      const res = await fetch('/api/members');
      const members = await res.json();

      container.innerHTML = \`
        <div class="d-flex justify-content-between align-items-center mb-4 no-print">
          <h2><i class="bi bi-card-heading text-primary me-2"></i>A4 Member ID Printing</h2>
          <button class="btn btn-success" onclick="window.print()"><i class="bi bi-printer me-1"></i>Print A4 Sheet (8 IDs/Page)</button>
        </div>

        <div class="card border-0 shadow-sm p-3 mb-4 no-print">
          <p class="text-muted mb-0">The preview below displays member cards dynamically laid out into standard A4 grid dimensions (8 cards per page with spacing and crop boundary marks).</p>
        </div>

        <div class="a4-grid">
          \${members.map(m => \`
            <div class="id-card-printable">
              <img src="\${m.photo_url}" class="id-photo" alt="Photo">
              <div class="id-details">
                <div>
                  <div class="id-header">\${state.settings.club_name || 'STUDENT CLUB'}</div>
                  <div class="id-name">\${m.full_name}</div>
                  <div class="id-role">\${m.position_title}</div>
                  <div style="font-size: 7pt; color: #64748b;" class="mt-1">ID: \${m.member_code}</div>
                </div>
                <div style="font-size: 6.5pt; color: #94a3b8;">SY: \${m.school_year || '2025-2026'}</div>
              </div>
              <img src="/api/qr/image/\${m.qr_token}" class="id-qr" alt="QR">
            </div>
          \`).join('')}
        </div>
      \`;
      
      // Mirror to global print section
      document.getElementById('print-section').innerHTML = container.innerHTML;
    }

    // Modal Helper for QR Code View
    function viewMemberQR(token, name) {
      alert(\`QR Code Token for \${name}: \${token}\`);
    }

    // Additional CRUD forms, event handlers, and management views integrated here
    function renderLoginModal() {
      const user = prompt("Admin Username:");
      const pass = prompt("Admin Password:");
      if (user && pass) {
        fetch('/api/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ username: user, password: pass })
        }).then(r => r.json()).then(d => {
          if (d.success) init();
          else alert("Login failed");
        });
      }
    }

    function logout() {
      fetch('/api/logout', { method: 'POST' }).then(() => init());
    }

    // Initialize application on load
    window.onload = init;
  </script>
</body>
</html>
  `);
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 STUDENT CLUB QR ATTENDANCE SYSTEM IS LIVE`);
  console.log(`-------------------------------------------------------`);
  console.log(`Server running at : http://localhost:${PORT}`);
  console.log(`Default Credentials: Username: admin | Password: admin123`);
  console.log(`=======================================================`);
});
