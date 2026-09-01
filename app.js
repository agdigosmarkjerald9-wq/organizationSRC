/**
 * STUDENT CLUB ID & REAL-TIME ATTENDANCE MANAGEMENT SYSTEM
 * Single-file Monolithic Architecture (Backend Services + Dynamic UI Engine)
 */

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// Setup Middleware
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'club-admin-secure-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 Hours
}));

// Setup Multer Storage for Upload Handling (Memory Storage for Direct DB Serialization)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, PNG, and WEBP formats are allowed.'));
        }
    }
});

// Database Initialization (SQLite Persistent Storage)
const dbPath = path.join(__dirname, 'data.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema Creation
function initDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_number TEXT UNIQUE NOT NULL,
            first_name TEXT NOT NULL,
            middle_name TEXT,
            last_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            contact_number TEXT,
            position_id INTEGER NOT NULL,
            photo_data TEXT,
            qr_token TEXT UNIQUE NOT NULL,
            status TEXT CHECK(status IN ('pending', 'active', 'inactive')) DEFAULT 'pending',
            date_joined DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (position_id) REFERENCES positions(id)
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER UNIQUE,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT CHECK(role IN ('admin', 'student')) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            event_date DATE NOT NULL,
            start_time TIME NOT NULL,
            end_time TIME NOT NULL,
            late_threshold_minutes INTEGER DEFAULT 10,
            status TEXT CHECK(status IN ('upcoming', 'active', 'completed', 'cancelled')) DEFAULT 'upcoming',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            event_id INTEGER NOT NULL,
            time_in DATETIME DEFAULT CURRENT_TIMESTAMP,
            time_out DATETIME,
            status TEXT CHECK(status IN ('present', 'late', 'absent', 'excused')) DEFAULT 'present',
            scan_type TEXT CHECK(scan_type IN ('QR', 'MANUAL')) DEFAULT 'QR',
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
            UNIQUE(student_id, event_id)
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            details TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Initialize Default System Settings
    const defaultSettings = [
        ['school_name', 'Metropolitan Institute of Technology'],
        ['club_name', 'Computer Science Honor Society'],
        ['school_year', '2026-2027'],
        ['sn_prefix', 'SC-'],
        ['sn_year', '2026'],
        ['sn_next_number', '1001'],
        ['sn_padding', '6'],
        ['school_logo', ''],
        ['club_logo', ''],
        ['timezone', 'Asia/Manila']
    ];

    const insertSetting = db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)');
    for (const [key, val] of defaultSettings) {
        insertSetting.run(key, val);
    }

    // Insert Default Default Positions
    const defaultPositions = ['President', 'Vice President', 'Secretary', 'Treasurer', 'Auditor', 'PRO', 'Member'];
    const insertPos = db.prepare('INSERT OR IGNORE INTO positions (title) VALUES (?)');
    for (const pos of defaultPositions) {
        insertPos.run(pos);
    }

    // Ensure Master Admin Account Exists
    const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
    if (!adminExists) {
        const passwordHash = bcrypt.hashSync('Admin2026!', 10);
        db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run('admin@club.edu', passwordHash, 'admin');
    }
}

initDatabase();

// --- Helper Functions ---

function getSetting(key) {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : '';
}

function setSetting(key, value) {
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
}

function logAudit(actor, action, details) {
    db.prepare('INSERT INTO audit_logs (actor, action, details) VALUES (?, ?, ?)').run(actor, action, details);
}

function generateStudentNumber() {
    return db.transaction(() => {
        const prefix = getSetting('sn_prefix');
        const year = getSetting('sn_year');
        const nextNum = parseInt(getSetting('sn_next_number'), 10);
        const padding = parseInt(getSetting('sn_padding'), 10);

        const formattedNum = String(nextNum).padStart(padding, '0');
        const studentNumber = `${prefix}${year}-${formattedNum}`;

        setSetting('sn_next_number', String(nextNum + 1));
        return studentNumber;
    })();
}

// Authentication Middlewares
function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Unauthorized access. Please login.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden. Admin privileges required.' });
    }
    next();
}

// ==========================================
// API ROUTES
// ==========================================

// Auth Routes
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid email address or password.' });
    }

    req.session.user = { id: user.id, email: user.email, role: user.role, student_id: user.student_id };
    logAudit(user.email, 'LOGIN', 'User logged in successfully.');
    res.json({ success: true, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
    if (req.session.user) {
        logAudit(req.session.user.email, 'LOGOUT', 'User logged out.');
        req.session.destroy();
    }
    res.json({ success: true });
});

app.get('/api/auth/session', (req, res) => {
    if (!req.session.user) return res.json({ authenticated: false });
    
    let studentData = null;
    if (req.session.user.role === 'student' && req.session.user.student_id) {
        studentData = db.prepare(`
            SELECT s.*, p.title as position_title 
            FROM students s 
            JOIN positions p ON s.position_id = p.id 
            WHERE s.id = ?
        `).get(req.session.user.student_id);
    }

    res.json({
        authenticated: true,
        user: req.session.user,
        student: studentData
    });
});

// Registration Endpoint
app.post('/api/public/register', upload.single('photo'), async (req, res) => {
    try {
        const { first_name, middle_name, last_name, email, contact_number, position_id } = req.body;

        if (!first_name || !last_name || !email || !position_id) {
            return res.status(400).json({ error: 'Missing required registration fields.' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email address format.' });
        }

        const existingStudent = db.prepare('SELECT id FROM students WHERE email = ?').get(email);
        if (existingStudent) {
            return res.status(400).json({ error: 'This email address is already registered.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Student profile photo is required.' });
        }

        const photoBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        const qrToken = crypto.randomBytes(16).toString('hex');
        const studentNumber = generateStudentNumber();

        const result = db.prepare(`
            INSERT INTO students (student_number, first_name, middle_name, last_name, email, contact_number, position_id, photo_data, qr_token, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(studentNumber, first_name, middle_name || '', last_name, email, contact_number || '', position_id, photoBase64, qrToken);

        logAudit('SYSTEM', 'REGISTRATION', `New student registration submitted: ${first_name} ${last_name} (${studentNumber})`);

        res.json({
            success: true,
            message: 'Registration submitted successfully! Pending administrator approval.',
            student_number: studentNumber
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error: ' + err.message });
    }
});

// Public Meta Options
app.get('/api/public/meta', (req, res) => {
    const positions = db.prepare('SELECT id, title FROM positions ORDER BY title ASC').all();
    const settings = {
        school_name: getSetting('school_name'),
        club_name: getSetting('club_name'),
        school_year: getSetting('school_year'),
        school_logo: getSetting('school_logo'),
        club_logo: getSetting('club_logo')
    };
    res.json({ positions, settings });
});

// Admin Dashboard Analytics API
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
    const { date_range, event_id, position_id } = req.query;

    let dateCondition = "";
    const params = [];

    // Date Filtering Setup
    const today = new Date().toISOString().split('T')[0];
    if (date_range === 'today' || !date_range) {
        dateCondition = "DATE(a.time_in) = DATE('now', 'localtime')";
    } else if (date_range === 'yesterday') {
        dateCondition = "DATE(a.time_in) = DATE('now', 'localtime', '-1 day')";
    } else if (date_range === 'this_week') {
        dateCondition = "DATE(a.time_in) >= DATE('now', 'localtime', '-7 days')";
    } else if (date_range === 'this_month') {
        dateCondition = "strftime('%Y-%m', a.time_in) = strftime('%Y-%m', 'now', 'localtime')";
    }

    // Core Counts
    const totalStudents = db.prepare("SELECT COUNT(*) as count FROM students").get().count;
    const activeStudents = db.prepare("SELECT COUNT(*) as count FROM students WHERE status = 'active'").get().count;
    const inactiveStudents = db.prepare("SELECT COUNT(*) as count FROM students WHERE status = 'inactive'").get().count;
    const pendingStudents = db.prepare("SELECT COUNT(*) as count FROM students WHERE status = 'pending'").get().count;

    // Active/Selected Event Filter
    let activeEvent = null;
    if (event_id && event_id !== 'all') {
        activeEvent = db.prepare("SELECT * FROM events WHERE id = ?").get(event_id);
    } else {
        activeEvent = db.prepare("SELECT * FROM events WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    }

    let presentToday = 0;
    let lateToday = 0;
    let absentToday = 0;
    let excusedToday = 0;
    let attendanceRate = 0;

    if (activeEvent) {
        const queryBase = `FROM attendance a JOIN students s ON a.student_id = s.id WHERE a.event_id = ? ${position_id && position_id !== 'all' ? 'AND s.position_id = ?' : ''}`;
        const queryParams = position_id && position_id !== 'all' ? [activeEvent.id, position_id] : [activeEvent.id];

        presentToday = db.prepare(`SELECT COUNT(DISTINCT a.student_id) as count ${queryBase} AND a.status = 'present'`).get(...queryParams).count;
        lateToday = db.prepare(`SELECT COUNT(DISTINCT a.student_id) as count ${queryBase} AND a.status = 'late'`).get(...queryParams).count;
        excusedToday = db.prepare(`SELECT COUNT(DISTINCT a.student_id) as count ${queryBase} AND a.status = 'excused'`).get(...queryParams).count;

        const expectedCount = position_id && position_id !== 'all' 
            ? db.prepare("SELECT COUNT(*) as count FROM students WHERE status = 'active' AND position_id = ?").get(position_id).count
            : activeStudents;

        const totalRecorded = presentToday + lateToday + excusedToday;
        absentToday = activeEvent.status === 'completed' ? Math.max(0, expectedCount - totalRecorded) : 0;

        if (expectedCount > 0) {
            attendanceRate = Number((((presentToday + lateToday) / expectedCount) * 100).toFixed(1));
        }
    }

    // Recent Scans
    const recentScans = db.prepare(`
        SELECT a.id, a.time_in, a.scan_type, a.status, s.first_name, s.last_name, s.student_number, p.title as position, e.title as event_title
        FROM attendance a
        JOIN students s ON a.student_id = s.id
        JOIN positions p ON s.position_id = p.id
        JOIN events e ON a.event_id = e.id
        ORDER BY a.time_in DESC LIMIT 10
    `).all();

    res.json({
        total_students: totalStudents,
        active_students: activeStudents,
        inactive_students: inactiveStudents,
        pending_registrations: pendingStudents,
        present_today: presentToday,
        late_today: lateToday,
        absent_today: absentToday,
        excused_today: excusedToday,
        attendance_rate: attendanceRate,
        active_event: activeEvent,
        recent_scans: recentScans
    });
});

// Admin Student Management
app.get('/api/admin/students', requireAdmin, (req, res) => {
    const students = db.prepare(`
        SELECT s.*, p.title as position_title 
        FROM students s 
        JOIN positions p ON s.position_id = p.id 
        ORDER BY s.id DESC
    `).all();
    res.json(students);
});

app.post('/api/admin/students/approve', requireAdmin, (req, res) => {
    const { student_id } = req.body;
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(student_id);
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    db.prepare("UPDATE students SET status = 'active' WHERE id = ?").run(student_id);

    // Auto-create user account for student portal using default password format
    const existingUser = db.prepare('SELECT id FROM users WHERE student_id = ?').get(student_id);
    if (!existingUser) {
        const defaultPassword = bcrypt.hashSync(student.student_number, 10);
        db.prepare('INSERT INTO users (student_id, email, password_hash, role) VALUES (?, ?, ?, ?)').run(student_id, student.email, defaultPassword, 'student');
    }

    logAudit(req.session.user.email, 'STUDENT_APPROVE', `Approved student ${student.first_name} ${student.last_name} (${student.student_number})`);
    res.json({ success: true });
});

app.post('/api/admin/students/update', requireAdmin, (req, res) => {
    const { id, first_name, middle_name, last_name, email, contact_number, position_id, status, student_number } = req.body;
    
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Student record not found.' });

    // Validate email uniqueness
    const emailCheck = db.prepare('SELECT id FROM students WHERE email = ? AND id != ?').get(email, id);
    if (emailCheck) return res.status(400).json({ error: 'Email address is already in use by another student.' });

    // Validate student number uniqueness
    const snCheck = db.prepare('SELECT id FROM students WHERE student_number = ? AND id != ?').get(student_number, id);
    if (snCheck) return res.status(400).json({ error: 'Student Number already exists.' });

    db.prepare(`
        UPDATE students 
        SET first_name = ?, middle_name = ?, last_name = ?, email = ?, contact_number = ?, position_id = ?, status = ?, student_number = ?
        WHERE id = ?
    `).run(first_name, middle_name, last_name, email, contact_number, position_id, status, student_number, id);

    logAudit(req.session.user.email, 'STUDENT_UPDATE', `Updated student record ID: ${id} (${student_number})`);
    res.json({ success: true });
});

// High-Resolution ID Card Generation API
app.post('/api/admin/students/render-ids', requireAdmin, async (req, res) => {
    try {
        const { student_ids } = req.body;
        if (!student_ids || !Array.isArray(student_ids) || student_ids.length === 0) {
            return res.status(400).json({ error: 'No student IDs specified for printing.' });
        }

        const placeholders = student_ids.map(() => '?').join(',');
        const students = db.prepare(`
            SELECT s.*, p.title as position_title 
            FROM students s 
            JOIN positions p ON s.position_id = p.id 
            WHERE s.id IN (${placeholders})
        `).all(...student_ids);

        const schoolLogo = getSetting('school_logo');
        const clubLogo = getSetting('club_logo');
        const schoolName = getSetting('school_name');
        const schoolYear = getSetting('school_year');

        // Render QR Codes concurrently
        const renderedCards = await Promise.all(students.map(async (student) => {
            const qrDataUrl = await QRCode.toDataURL(student.qr_token, {
                errorCorrectionLevel: 'H',
                margin: 1,
                width: 300,
                color: { dark: '#000000', light: '#FFFFFF' }
            });

            return {
                ...student,
                qr_code_url: qrDataUrl
            };
        }));

        res.json({
            cards: renderedCards,
            branding: {
                school_logo: schoolLogo,
                club_logo: clubLogo,
                school_name: schoolName,
                school_year: schoolYear
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Error rendering student ID cards: ' + err.message });
    }
});

// Admin System Settings (Logos, Numbering, System Info)
app.post('/api/admin/settings/logo', requireAdmin, upload.single('logo'), (req, res) => {
    try {
        const { target } = req.body; // 'school' or 'club'
        if (!['school', 'club'].includes(target)) {
            return res.status(400).json({ error: 'Invalid logo target category.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Image file required.' });
        }

        const base64Data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        setSetting(`${target}_logo`, base64Data);

        logAudit(req.session.user.email, 'SETTINGS_UPDATE', `Updated ${target} logo.`);
        res.json({ success: true, logo_url: base64Data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/settings/logo/remove', requireAdmin, (req, res) => {
    const { target } = req.body;
    if (['school', 'club'].includes(target)) {
        setSetting(`${target}_logo`, '');
        logAudit(req.session.user.email, 'SETTINGS_UPDATE', `Removed ${target} logo.`);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Invalid target.' });
    }
});

app.post('/api/admin/settings/general', requireAdmin, (req, res) => {
    const { school_name, club_name, school_year, sn_prefix, sn_year, sn_padding } = req.body;
    
    if (school_name) setSetting('school_name', school_name);
    if (club_name) setSetting('club_name', club_name);
    if (school_year) setSetting('school_year', school_year);
    if (sn_prefix !== undefined) setSetting('sn_prefix', sn_prefix);
    if (sn_year !== undefined) setSetting('sn_year', sn_year);
    if (sn_padding !== undefined) setSetting('sn_padding', sn_padding);

    logAudit(req.session.user.email, 'SETTINGS_UPDATE', 'Updated system general configuration.');
    res.json({ success: true });
});

// Event Management API
app.get('/api/admin/events', requireAdmin, (req, res) => {
    const events = db.prepare('SELECT * FROM events ORDER BY id DESC').all();
    res.json(events);
});

app.post('/api/admin/events/create', requireAdmin, (req, res) => {
    const { title, event_date, start_time, end_time, late_threshold_minutes } = req.body;
    if (!title || !event_date || !start_time || !end_time) {
        return res.status(400).json({ error: 'Missing mandatory event properties.' });
    }

    db.prepare(`
        INSERT INTO events (title, event_date, start_time, end_time, late_threshold_minutes, status)
        VALUES (?, ?, ?, ?, ?, 'upcoming')
    `).run(title, event_date, start_time, end_time, late_threshold_minutes || 10);

    logAudit(req.session.user.email, 'EVENT_CREATE', `Created event: ${title} (${event_date})`);
    res.json({ success: true });
});

app.post('/api/admin/events/set-status', requireAdmin, (req, res) => {
    const { event_id, status } = req.body;
    if (!['upcoming', 'active', 'completed', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Invalid event status.' });
    }

    if (status === 'active') {
        // Deactivate all other active events to maintain accurate live scanner execution
        db.prepare("UPDATE events SET status = 'completed' WHERE status = 'active'").run();
    }

    db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event_id);
    logAudit(req.session.user.email, 'EVENT_STATUS', `Updated event ID ${event_id} status to ${status}`);
    res.json({ success: true });
});

// QR Scanner Verification Engine
app.post('/api/scanner/scan', async (req, res) => {
    const { qr_token } = req.body;
    if (!qr_token) return res.status(400).json({ error: 'QR Token signature missing.' });

    const activeEvent = db.prepare("SELECT * FROM events WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    if (!activeEvent) {
        return res.status(400).json({ error: 'No active event found. Scanner paused.', status_code: 'NO_ACTIVE_EVENT' });
    }

    const student = db.prepare(`
        SELECT s.*, p.title as position_title 
        FROM students s 
        JOIN positions p ON s.position_id = p.id 
        WHERE s.qr_token = ?
    `).get(qr_token);

    if (!student) {
        return res.status(404).json({ error: 'Invalid QR Code. Student record not found.', status_code: 'INVALID_QR' });
    }

    if (student.status !== 'active') {
        return res.status(403).json({ error: `Student account status is ${student.status}.`, status_code: 'INACTIVE_STUDENT' });
    }

    // Check for Duplicate Scan
    const existingAttendance = db.prepare('SELECT * FROM attendance WHERE student_id = ? AND event_id = ?').get(student.id, activeEvent.id);

    if (existingAttendance) {
        return res.status(409).json({
            error: `${student.first_name} ${student.last_name} has already recorded attendance for this event.`,
            status_code: 'DUPLICATE_SCAN',
            student_name: `${student.first_name} ${student.last_name}`,
            time_in: existingAttendance.time_in
        });
    }

    // Calculate Late Status
    const currentTime = new Date();
    const eventStartDateTime = new Date(`${activeEvent.event_date}T${activeEvent.start_time}`);
    const lateThresholdTime = new Date(eventStartDateTime.getTime() + activeEvent.late_threshold_minutes * 60000);

    let status = 'present';
    if (currentTime > lateThresholdTime) {
        status = 'late';
    }

    // Database Transaction Execution
    db.transaction(() => {
        db.prepare(`
            INSERT INTO attendance (student_id, event_id, status, scan_type)
            VALUES (?, ?, ?, 'QR')
        `).run(student.id, activeEvent.id, status);
    })();

    logAudit('SCANNER', 'ATTENDANCE_SCAN', `Recorded attendance for ${student.first_name} ${student.last_name} (${status.toUpperCase()})`);

    res.json({
        success: true,
        student_name: `${student.first_name} ${student.last_name}`,
        student_number: student.student_number,
        position: student.position_title,
        photo_data: student.photo_data,
        status: status,
        time_in: new Date().toLocaleTimeString()
    });
});

// Admin Attendance Logs & Audit Trails
app.get('/api/admin/attendance', requireAdmin, (req, res) => {
    const records = db.prepare(`
        SELECT a.*, s.first_name, s.last_name, s.student_number, p.title as position_title, e.title as event_title 
        FROM attendance a
        JOIN students s ON a.student_id = s.id
        JOIN positions p ON s.position_id = p.id
        JOIN events e ON a.event_id = e.id
        ORDER BY a.time_in DESC
    `).all();
    res.json(records);
});

app.post('/api/admin/attendance/manual-correct', requireAdmin, (req, res) => {
    const { attendance_id, new_status, reason } = req.body;
    if (!['present', 'late', 'absent', 'excused'].includes(new_status)) {
        return res.status(400).json({ error: 'Invalid attendance status.' });
    }

    const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendance_id);
    if (!record) return res.status(404).json({ error: 'Attendance record not found.' });

    db.prepare('UPDATE attendance SET status = ? WHERE id = ?').run(new_status, attendance_id);

    logAudit(req.session.user.email, 'ATTENDANCE_CORRECTION', `Corrected Record ID ${attendance_id}: ${record.status} -> ${new_status}. Reason: ${reason || 'N/A'}`);
    res.json({ success: true });
});

app.get('/api/admin/audit-logs', requireAdmin, (req, res) => {
    const logs = db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100').all();
    res.json(logs);
});

// Position Management APIs
app.get('/api/admin/positions', requireAdmin, (req, res) => {
    const positions = db.prepare('SELECT * FROM positions ORDER BY title ASC').all();
    res.json(positions);
});

app.post('/api/admin/positions/create', requireAdmin, (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Position title required.' });

    try {
        db.prepare('INSERT INTO positions (title) VALUES (?)').run(title);
        logAudit(req.session.user.email, 'POSITION_CREATE', `Created position: ${title}`);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Position already exists.' });
    }
});

// Database Backup / Restore API
app.get('/api/admin/system/backup', requireAdmin, (req, res) => {
    const backupPath = path.join(__dirname, 'backup.db');
    db.backup(backupPath)
        .then(() => {
            res.download(backupPath, `system_backup_${new Date().toISOString().split('T')[0]}.db`, () => {
                if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
            });
        })
        .catch(err => res.status(500).json({ error: err.message }));
});

// Server Single-Page Application View Rendering
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Student Club ID & Real-Time Attendance System</title>
    <!-- Tailwind CSS (via CDN for standalone deployment) -->
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/html5-qrcode"></script>
    <style>
        /* Printable Standard A4 ID Layout Configuration */
        @media print {
            body * {
                visibility: hidden;
            }
            #print-container, #print-container * {
                visibility: visible;
            }
            #print-container {
                position: absolute;
                left: 0;
                top: 0;
                width: 100%;
            }
            @page {
                size: A4 portrait;
                margin: 8mm;
            }
            .page-break {
                page-break-after: always;
            }
        }

        .id-card-grid {
            display: grid;
            grid-template-columns: repeat(2, 85.6mm);
            grid-auto-rows: 53.9mm;
            gap: 6mm 8mm;
            justify-content: center;
        }

        .id-card {
            width: 85.6mm;
            height: 53.9mm;
            box-sizing: border-box;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            position: relative;
            background: #ffffff;
            overflow: hidden;
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial;
            color: #0f172a;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            padding: 2.5mm;
        }
    </style>
</head>
<body class="bg-slate-100 text-slate-800 font-sans antialiased min-h-screen">
    
    <!-- Navigation Header -->
    <header class="bg-slate-900 text-white shadow-lg sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <div id="header-brand-logo" class="w-8 h-8 rounded bg-slate-800 flex items-center justify-center font-bold text-blue-400">SC</div>
                <div>
                    <h1 id="header-club-name" class="font-bold text-base leading-tight">Student Club ID Portal</h1>
                    <p id="header-school-name" class="text-xs text-slate-400">Metropolitan Institute of Technology</p>
                </div>
            </div>
            <nav id="app-nav" class="flex items-center space-x-2">
                <!-- Dynamic Navigation Links Injected Here -->
            </nav>
        </div>
    </header>

    <!-- Main Container -->
    <main id="app-viewport" class="max-w-7xl mx-auto p-4 md:p-6">
        <!-- Views automatically rendered here -->
    </main>

    <!-- Printable Container for High-Resolution ID Batch Operations -->
    <div id="print-container" class="hidden print:block"></div>

    <!-- Frontend Engine Logic -->
    <script>
        // Global Application State
        const state = {
            user: null,
            meta: { positions: [], settings: {} },
            activeTab: 'home',
            scannerEngine: null
        };

        // Core App Initializer
        async function initApp() {
            await fetchMeta();
            await checkSession();
            router();
        }

        async function fetchMeta() {
            try {
                const res = await fetch('/api/public/meta');
                state.meta = await res.json();
                if (state.meta.settings.club_name) {
                    document.getElementById('header-club-name').innerText = state.meta.settings.club_name;
                }
                if (state.meta.settings.school_name) {
                    document.getElementById('header-school-name').innerText = state.meta.settings.school_name;
                }
            } catch (err) {
                console.error("Failed to load metadata:", err);
            }
        }

        async function checkSession() {
            try {
                const res = await fetch('/api/auth/session');
                const data = await res.json();
                if (data.authenticated) {
                    state.user = data.user;
                    state.student = data.student;
                } else {
                    state.user = null;
                    state.student = null;
                }
            } catch (err) {
                state.user = null;
            }
            renderNav();
        }

        function renderNav() {
            const nav = document.getElementById('app-nav');
            if (!state.user) {
                nav.innerHTML = \`
                    <button onclick="navigate('register')" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-800 transition">Register</button>
                    <button onclick="navigate('scanner')" class="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition">Attendance Scanner</button>
                    <button onclick="navigate('login')" class="px-3 py-1.5 rounded text-sm font-medium border border-slate-700 hover:bg-slate-800 transition">Login</button>
                \`;
            } else if (state.user.role === 'admin') {
                nav.innerHTML = \`
                    <button onclick="navigate('admin_dashboard')" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-800 transition">Dashboard</button>
                    <button onclick="navigate('admin_students')" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-800 transition">Students</button>
                    <button onclick="navigate('admin_events')" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-800 transition">Events</button>
                    <button onclick="navigate('admin_settings')" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-800 transition">Settings</button>
                    <button onclick="navigate('scanner')" class="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition">Scanner</button>
                    <button onclick="logout()" class="px-3 py-1.5 rounded text-sm font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition">Logout</button>
                \`;
            } else {
                nav.innerHTML = \`
                    <button onclick="navigate('student_portal')" class="px-3 py-1.5 rounded text-sm font-medium hover:bg-slate-800 transition">My Student ID</button>
                    <button onclick="logout()" class="px-3 py-1.5 rounded text-sm font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition">Logout</button>
                \`;
            }
        }

        function navigate(tab) {
            state.activeTab = tab;
            router();
        }

        function router() {
            if (state.scannerEngine) {
                try { state.scannerEngine.clear(); } catch(e){}
                state.scannerEngine = null;
            }

            const vp = document.getElementById('app-viewport');
            switch (state.activeTab) {
                case 'register': renderRegisterView(vp); break;
                case 'login': renderLoginView(vp); break;
                case 'scanner': renderScannerView(vp); break;
                case 'admin_dashboard': renderAdminDashboardView(vp); break;
                case 'admin_students': renderAdminStudentsView(vp); break;
                case 'admin_events': renderAdminEventsView(vp); break;
                case 'admin_settings': renderAdminSettingsView(vp); break;
                case 'student_portal': renderStudentPortalView(vp); break;
                default:
                    if (state.user) {
                        state.user.role === 'admin' ? renderAdminDashboardView(vp) : renderStudentPortalView(vp);
                    } else {
                        renderRegisterView(vp);
                    }
            }
        }

        // --- VIEWS IMPLEMENTATION ---

        // 1. Student Registration View
        function renderRegisterView(vp) {
            vp.innerHTML = \`
                <div class="max-w-2xl mx-auto bg-white rounded-xl shadow-md border border-slate-200 overflow-hidden">
                    <div class="bg-blue-600 px-6 py-4 text-white">
                        <h2 class="text-xl font-bold">Student Membership Registration</h2>
                        <p class="text-sm text-blue-100">Fill in your details to register for your official Club Student ID.</p>
                    </div>
                    <form id="register-form" class="p-6 space-y-4" onsubmit="handleRegistration(event)">
                        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">First Name *</label>
                                <input type="text" name="first_name" required class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Middle Name</label>
                                <input type="text" name="middle_name" class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Last Name *</label>
                                <input type="text" name="last_name" required class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                            </div>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Email Address *</label>
                                <input type="email" name="email" required placeholder="name@example.com" class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Contact Number</label>
                                <input type="text" name="contact_number" placeholder="09123456789" class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                            </div>
                        </div>

                        <div>
                            <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Club Position *</label>
                            <select name="position_id" required class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                                <option value="">-- Select Position --</option>
                                \${state.meta.positions.map(p => \`<option value="\${p.id}">\${p.title}</option>\`).join('')}
                            </select>
                        </div>

                        <div>
                            <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Student Photo Upload *</label>
                            <input type="file" name="photo" accept="image/png, image/jpeg, image/webp" required onchange="previewStudentPhoto(event)" class="w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100">
                            <div id="photo-preview-container" class="mt-3 hidden">
                                <p class="text-xs text-slate-500 mb-1">Photo Preview:</p>
                                <img id="photo-preview" class="w-28 h-28 object-cover rounded-lg border-2 border-blue-500 shadow-sm">
                            </div>
                        </div>

                        <div id="reg-error" class="hidden p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg"></div>
                        <div id="reg-success" class="hidden p-4 bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg"></div>

                        <button type="submit" class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow transition">
                            Submit Registration
                        </button>
                    </form>
                </div>
            \`;
        }

        function previewStudentPhoto(e) {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    document.getElementById('photo-preview').src = event.target.result;
                    document.getElementById('photo-preview-container').classList.remove('hidden');
                };
                reader.readAsDataURL(file);
            }
        }

        async function handleRegistration(e) {
            e.preventDefault();
            const form = e.target;
            const formData = new FormData(form);
            const errDiv = document.getElementById('reg-error');
            const succDiv = document.getElementById('reg-success');

            errDiv.classList.add('hidden');
            succDiv.classList.add('hidden');

            try {
                const res = await fetch('/api/public/register', { method: 'POST', body: formData });
                const data = await res.json();

                if (!res.ok) {
                    errDiv.innerText = data.error || 'Registration failed.';
                    errDiv.classList.remove('hidden');
                } else {
                    succDiv.innerHTML = \`
                        <strong>Success!</strong> \${data.message}<br>
                        Generated Student Number: <span class="font-bold font-mono text-blue-900">\${data.student_number}</span>
                    \`;
                    succDiv.classList.remove('hidden');
                    form.reset();
                    document.getElementById('photo-preview-container').classList.add('hidden');
                }
            } catch (err) {
                errDiv.innerText = 'Network error during registration.';
                errDiv.classList.remove('hidden');
            }
        }

        // 2. Authentication Login View
        function renderLoginView(vp) {
            vp.innerHTML = \`
                <div class="max-w-md mx-auto bg-white rounded-xl shadow-md border border-slate-200 p-6 mt-10">
                    <h2 class="text-2xl font-bold text-slate-800 text-center mb-6">Portal Sign In</h2>
                    <form onsubmit="handleLogin(event)" class="space-y-4">
                        <div>
                            <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Email Address</label>
                            <input type="email" id="login-email" required class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Password</label>
                            <input type="password" id="login-password" required class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                        </div>
                        <div id="login-error" class="hidden p-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg"></div>
                        <button type="submit" class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow transition">
                            Sign In
                        </button>
                    </form>
                </div>
            \`;
        }

        async function handleLogin(e) {
            e.preventDefault();
            const email = document.getElementById('login-email').value;
            const password = document.getElementById('login-password').value;
            const errDiv = document.getElementById('login-error');

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if (!res.ok) {
                    errDiv.innerText = data.error;
                    errDiv.classList.remove('hidden');
                } else {
                    await checkSession();
                    data.role === 'admin' ? navigate('admin_dashboard') : navigate('student_portal');
                }
            } catch (err) {
                errDiv.innerText = 'Login error occurred.';
                errDiv.classList.remove('hidden');
            }
        }

        async function logout() {
            await fetch('/api/auth/logout', { method: 'POST' });
            state.user = null;
            state.student = null;
            renderNav();
            navigate('login');
        }

        // 3. Real-Time QR Scanner Terminal
        function renderScannerView(vp) {
            vp.innerHTML = \`
                <div class="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div class="bg-white p-6 rounded-xl shadow-md border border-slate-200 flex flex-col items-center">
                        <h2 class="text-lg font-bold text-slate-800 mb-2">Live QR Attendance Scanner</h2>
                        <div id="scanner-region" class="w-full h-64 bg-slate-900 rounded-lg overflow-hidden relative"></div>
                        <p class="text-xs text-slate-500 mt-3 text-center">Point the Student ID QR Code directly at the camera lens.</p>
                    </div>

                    <div class="bg-white p-6 rounded-xl shadow-md border border-slate-200 flex flex-col justify-between">
                        <div>
                            <h3 class="text-sm font-semibold uppercase text-slate-400 mb-4">Latest Scan Result</h3>
                            <div id="scan-feedback" class="text-center py-8">
                                <div class="w-20 h-20 bg-slate-100 rounded-full mx-auto mb-3 flex items-center justify-center text-slate-400 text-3xl">📷</div>
                                <p class="text-slate-500 text-sm">Awaiting QR Code scan...</p>
                            </div>
                        </div>

                        <div class="border-t pt-4 mt-4 text-xs text-slate-500 flex justify-between">
                            <span>Audio Feedback: <strong class="text-green-600">Enabled</strong></span>
                            <span>Voice Speech: <strong class="text-green-600">Enabled</strong></span>
                        </div>
                    </div>
                </div>
            \`;

            // Initialize Camera Scanner Engine
            setTimeout(() => {
                const html5QrCode = new Html5Qrcode("scanner-region");
                state.scannerEngine = html5QrCode;

                html5QrCode.start(
                    { facingMode: "environment" },
                    { fps: 10, qrbox: { width: 220, height: 220 } },
                    async (decodedText) => {
                        html5QrCode.pause();
                        await processQRScan(decodedText);
                        setTimeout(() => {
                            try { html5QrCode.resume(); } catch(e){}
                        }, 2500);
                    },
                    (error) => {}
                ).catch(err => {
                    document.getElementById('scanner-region').innerHTML = \`<div class="p-4 text-white text-xs">Camera access error: \${err}</div>\`;
                });
            }, 100);
        }

        async function processQRScan(qrToken) {
            const feedbackDiv = document.getElementById('scan-feedback');
            try {
                const res = await fetch('/api/scanner/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ qr_token: qrToken })
                });
                const data = await res.json();

                if (res.ok) {
                    playAudioBeep(true);
                    speakAnnouncement(\`\${data.student_name}, attendance recorded.\`);

                    feedbackDiv.innerHTML = \`
                        <div class="space-y-3">
                            <img src="\${data.photo_data}" class="w-24 h-24 object-cover rounded-full mx-auto border-4 border-green-500 shadow">
                            <h4 class="font-bold text-lg text-slate-900">\${data.student_name}</h4>
                            <p class="text-xs font-mono bg-slate-100 px-2 py-1 rounded inline-block">\${data.student_number}</p>
                            <p class="text-xs font-semibold text-blue-600">\${data.position}</p>
                            <div class="mt-2 inline-block px-3 py-1 rounded-full text-xs font-bold bg-green-100 text-green-800 uppercase">
                                STATUS: \${data.status} (\${data.time_in})
                            </div>
                        </div>
                    \`;
                } else {
                    playAudioBeep(false);
                    if (data.status_code === 'DUPLICATE_SCAN') {
                        speakAnnouncement(\`\${data.student_name}, you are already recorded.\`);
                    } else {
                        speakAnnouncement('Invalid scan signature.');
                    }

                    feedbackDiv.innerHTML = \`
                        <div class="py-4 text-center">
                            <div class="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-2 text-2xl font-bold">✕</div>
                            <h4 class="font-bold text-red-600 text-base">Scan Failed</h4>
                            <p class="text-xs text-slate-600 mt-1">\${data.error}</p>
                        </div>
                    \`;
                }
            } catch (err) {
                playAudioBeep(false);
                feedbackDiv.innerHTML = \`<p class="text-red-500 text-xs">Network error processing scan.</p>\`;
            }
        }

        function playAudioBeep(success) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (success) {
                osc.frequency.value = 880; // High tone
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                osc.start();
                osc.stop(ctx.currentTime + 0.15);
            } else {
                osc.frequency.value = 220; // Low error tone
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            }
        }

        function speakAnnouncement(text) {
            if ('speechSynthesis' in window) {
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.rate = 1.0;
                window.speechSynthesis.speak(utterance);
            }
        }

        // 4. Admin Dashboard Analytics View
        async function renderAdminDashboardView(vp) {
            vp.innerHTML = \`<div class="p-8 text-center text-slate-500">Calculating real-time database statistics...</div>\`;

            try {
                const res = await fetch('/api/admin/dashboard');
                const data = await res.json();

                vp.innerHTML = \`
                    <div class="space-y-6">
                        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div>
                                <h2 class="text-2xl font-bold text-slate-800">Admin Live Dashboard</h2>
                                <p class="text-xs text-slate-500">Database-driven real-time statistics and execution analytics.</p>
                            </div>
                            <div class="flex items-center space-x-2">
                                <button onclick="renderAdminDashboardView(document.getElementById('app-viewport'))" class="px-3 py-1.5 bg-white border rounded text-xs font-semibold hover:bg-slate-50">Refresh Data</button>
                            </div>
                        </div>

                        <!-- Stat Cards Grid -->
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                                <p class="text-xs text-slate-500 font-medium">Total Students</p>
                                <p class="text-2xl font-bold text-slate-900 mt-1">\${data.total_students}</p>
                            </div>
                            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                                <p class="text-xs text-slate-500 font-medium">Active Members</p>
                                <p class="text-2xl font-bold text-green-600 mt-1">\${data.active_students}</p>
                            </div>
                            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                                <p class="text-xs text-slate-500 font-medium">Pending Approval</p>
                                <p class="text-2xl font-bold text-amber-500 mt-1">\${data.pending_registrations}</p>
                            </div>
                            <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                                <p class="text-xs text-slate-500 font-medium">Attendance Rate</p>
                                <p class="text-2xl font-bold text-blue-600 mt-1">\${data.attendance_rate}%</p>
                            </div>
                        </div>

                        <!-- Active Event Statistics -->
                        <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                            <h3 class="text-sm font-bold text-slate-700 uppercase tracking-wider mb-4">
                                Current Active Event Execution: \${data.active_event ? data.active_event.title : 'None Selected'}
                            </h3>
                            <div class="grid grid-cols-4 gap-4 text-center">
                                <div class="p-3 bg-green-50 rounded-lg border border-green-100">
                                    <p class="text-xs text-green-600 font-bold uppercase">Present</p>
                                    <p class="text-xl font-bold text-green-900">\${data.present_today}</p>
                                </div>
                                <div class="p-3 bg-amber-50 rounded-lg border border-amber-100">
                                    <p class="text-xs text-amber-600 font-bold uppercase">Late</p>
                                    <p class="text-xl font-bold text-amber-900">\${data.late_today}</p>
                                </div>
                                <div class="p-3 bg-red-50 rounded-lg border border-red-100">
                                    <p class="text-xs text-red-600 font-bold uppercase">Absent</p>
                                    <p class="text-xl font-bold text-red-900">\${data.absent_today}</p>
                                </div>
                                <div class="p-3 bg-slate-50 rounded-lg border border-slate-100">
                                    <p class="text-xs text-slate-600 font-bold uppercase">Excused</p>
                                    <p class="text-xl font-bold text-slate-900">\${data.excused_today}</p>
                                </div>
                            </div>
                        </div>

                        <!-- Recent Live Scans Table -->
                        <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                            <div class="px-6 py-4 border-b">
                                <h3 class="font-bold text-slate-800 text-sm">Recent Audit Scans</h3>
                            </div>
                            <div class="overflow-x-auto">
                                <table class="w-full text-left text-xs">
                                    <thead class="bg-slate-50 text-slate-600 font-semibold border-b">
                                        <tr>
                                            <th class="p-3">Student Name</th>
                                            <th class="p-3">Student Number</th>
                                            <th class="p-3">Position</th>
                                            <th class="p-3">Time</th>
                                            <th class="p-3">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y">
                                        \${data.recent_scans.length === 0 ? '<tr><td colspan="5" class="p-4 text-center text-slate-400">No attendance scans recorded today.</td></tr>' : ''}
                                        \${data.recent_scans.map(s => \`
                                            <tr class="hover:bg-slate-50">
                                                <td class="p-3 font-semibold text-slate-900">\${s.first_name} \${s.last_name}</td>
                                                <td class="p-3 font-mono text-slate-500">\${s.student_number}</td>
                                                <td class="p-3 text-slate-600">\${s.position}</td>
                                                <td class="p-3 text-slate-500">\${new Date(s.time_in).toLocaleTimeString()}</td>
                                                <td class="p-3">
                                                    <span class="px-2 py-0.5 rounded text-2xs font-bold uppercase \${s.status === 'present' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}">
                                                        \${s.status}
                                                    </span>
                                                </td>
                                            </tr>
                                        \`).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                \`;
            } catch (err) {
                vp.innerHTML = \`<div class="p-6 text-red-500">Failed to calculate dashboard statistics.</div>\`;
            }
        }

        // 5. Admin Student Management & Batch Printing View
        async function renderAdminStudentsView(vp) {
            vp.innerHTML = \`<div class="p-8 text-center text-slate-500">Loading student directory...</div>\`;

            try {
                const res = await fetch('/api/admin/students');
                const students = await res.json();

                vp.innerHTML = \`
                    <div class="space-y-4">
                        <div class="flex justify-between items-center">
                            <h2 class="text-xl font-bold text-slate-800">Student Directory Management</h2>
                            <button onclick="triggerBatchPrint()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold shadow transition">
                                🖨️ Batch Print Selected Student IDs
                            </button>
                        </div>

                        <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                            <div class="overflow-x-auto">
                                <table class="w-full text-left text-xs">
                                    <thead class="bg-slate-50 text-slate-600 font-semibold border-b">
                                        <tr>
                                            <th class="p-3"><input type="checkbox" onchange="toggleSelectAllStudents(this)"></th>
                                            <th class="p-3">Photo</th>
                                            <th class="p-3">Student Number</th>
                                            <th class="p-3">Name</th>
                                            <th class="p-3">Position</th>
                                            <th class="p-3">Email</th>
                                            <th class="p-3">Status</th>
                                            <th class="p-3 text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y">
                                        \${students.map(s => \`
                                            <tr class="hover:bg-slate-50">
                                                <td class="p-3"><input type="checkbox" class="student-select-chk" value="\${s.id}"></td>
                                                <td class="p-3">
                                                    <img src="\${s.photo_data}" class="w-8 h-8 rounded-full object-cover border">
                                                </td>
                                                <td class="p-3 font-mono font-bold text-slate-700">\${s.student_number}</td>
                                                <td class="p-3 font-medium text-slate-900">\${s.first_name} \${s.last_name}</td>
                                                <td class="p-3 text-slate-600">\${s.position_title}</td>
                                                <td class="p-3 text-slate-500">\${s.email}</td>
                                                <td class="p-3">
                                                    <span class="px-2 py-0.5 rounded text-2xs font-bold uppercase \${
                                                        s.status === 'active' ? 'bg-green-100 text-green-800' :
                                                        s.status === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-800'
                                                    }">
                                                        \${s.status}
                                                    </span>
                                                </td>
                                                <td class="p-3 text-right space-x-2">
                                                    \${s.status === 'pending' ? \`
                                                        <button onclick="approveStudent(\${s.id})" class="px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700">Approve</button>
                                                    \` : ''}
                                                    <button onclick="printSingleID(\${s.id})" class="px-2 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Print ID</button>
                                                </td>
                                            </tr>
                                        \`).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                \`;
            } catch (err) {
                vp.innerHTML = \`<div class="p-6 text-red-500">Error loading student directory.</div>\`;
            }
        }

        function toggleSelectAllStudents(master) {
            document.querySelectorAll('.student-select-chk').forEach(c => c.checked = master.checked);
        }

        async function approveStudent(id) {
            await fetch('/api/admin/students/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ student_id: id })
            });
            renderAdminStudentsView(document.getElementById('app-viewport'));
        }

        function printSingleID(id) {
            executeBatchPrint([id]);
        }

        function triggerBatchPrint() {
            const selected = Array.from(document.querySelectorAll('.student-select-chk:checked')).map(c => parseInt(c.value, 10));
            if (selected.length === 0) {
                alert('Please select at least one student ID to print.');
                return;
            }
            executeBatchPrint(selected);
        }

        // 6. Print Layout Engine Render Execution (A4 Standard 8-Card Grid Layout)
        async function executeBatchPrint(studentIds) {
            try {
                const res = await fetch('/api/admin/students/render-ids', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ student_ids: studentIds })
                });
                const data = await res.json();

                const printContainer = document.getElementById('print-container');
                printContainer.innerHTML = '';

                // Partition cards into A4 Pages (Max 8 IDs per page)
                const pageSize = 8;
                for (let i = 0; i < data.cards.length; i += pageSize) {
                    const pageCards = data.cards.slice(i, i + pageSize);
                    
                    const pageDiv = document.createElement('div');
                    pageDiv.className = 'page-break mb-8';
                    
                    const gridDiv = document.createElement('div');
                    gridDiv.className = 'id-card-grid';

                    pageCards.forEach(card => {
                        gridDiv.innerHTML += \`
                            <div class="id-card">
                                <!-- Top Header Branding -->
                                <div class="flex items-center justify-between border-b border-slate-200 pb-1">
                                    <div class="flex items-center space-x-1.5">
                                        \${data.branding.school_logo ? \`<img src="\${data.branding.school_logo}" class="w-5 h-5 object-contain">\` : ''}
                                        <span class="text-3xs font-bold uppercase tracking-tight text-slate-800 leading-tight">\${data.branding.school_name}</span>
                                    </div>
                                    <span class="text-3xs font-semibold bg-blue-100 text-blue-800 px-1 rounded">STUDENT CLUB ID</span>
                                </div>

                                <!-- Center Content Grid -->
                                <div class="grid grid-cols-12 gap-1.5 items-center my-auto">
                                    <div class="col-span-4">
                                        <img src="\${card.photo_data}" class="w-16 h-16 object-cover rounded border border-slate-300">
                                    </div>
                                    <div class="col-span-8 space-y-0.5">
                                        <h4 class="font-bold text-xs leading-tight text-slate-900">\${card.first_name} \${card.last_name}</h4>
                                        <p class="text-3xs font-mono font-bold text-blue-700">SN: \${card.student_number}</p>
                                        <p class="text-3xs text-slate-600 font-medium">\${card.position_title}</p>
                                    </div>
                                </div>

                                <!-- Large QR Code & Footer -->
                                <div class="flex items-end justify-between border-t border-slate-200 pt-1">
                                    <div class="flex items-center space-x-1">
                                        \${data.branding.club_logo ? \`<img src="\${data.branding.club_logo}" class="w-4 h-4 object-contain">\` : ''}
                                        <span class="text-4xs text-slate-500">S.Y. \${data.branding.school_year}</span>
                                    </div>
                                    <!-- High-Resolution Scannable Large QR -->
                                    <img src="\${card.qr_code_url}" class="w-14 h-14 object-contain">
                                </div>
                            </div>
                        \`;
                    });

                    pageDiv.appendChild(gridDiv);
                    printContainer.appendChild(pageDiv);
                }

                // Trigger Native Print Dialog
                setTimeout(() => {
                    window.print();
                }, 300);

            } catch (err) {
                alert('Error rendering printable cards: ' + err.message);
            }
        }

        // 7. Student Portal View
        function renderStudentPortalView(vp) {
            if (!state.student) {
                vp.innerHTML = \`<div class="p-6 text-center text-slate-500">No active student record linked to account.</div>\`;
                return;
            }

            const s = state.student;
            vp.innerHTML = \`
                <div class="max-w-md mx-auto bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden">
                    <div class="bg-slate-900 p-4 text-white text-center">
                        <h2 class="font-bold text-base">\${state.meta.settings.club_name}</h2>
                        <p class="text-xs text-slate-400">Official Student Membership Card</p>
                    </div>
                    <div class="p-6 text-center space-y-4">
                        <img src="\${s.photo_data}" class="w-28 h-28 object-cover rounded-full mx-auto border-4 border-blue-600 shadow">
                        <div>
                            <h3 class="text-xl font-bold text-slate-900">\${s.first_name} \${s.last_name}</h3>
                            <p class="text-xs font-mono font-bold text-blue-600 mt-0.5">\${s.student_number}</p>
                            <p class="text-sm font-medium text-slate-600">\${s.position_title}</p>
                        </div>
                        <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 inline-block">
                            <div id="student-portal-qr" class="mx-auto"></div>
                            <p class="text-3xs text-slate-400 mt-2">Present this QR to scanner for attendance recording</p>
                        </div>
                    </div>
                </div>
            \`;

            setTimeout(() => {
                const qrContainer = document.getElementById('student-portal-qr');
                qrContainer.innerHTML = '';
                // Render High Resolution QR
                const img = document.createElement('img');
                QRCode.toDataURL(s.qr_token, { width: 180, margin: 1, errorCorrectionLevel: 'H' }, (err, url) => {
                    img.src = url;
                    qrContainer.appendChild(img);
                });
            }, 50);
        }

        // 8. System Events View Placeholder
        function renderAdminEventsView(vp) {
            vp.innerHTML = \`
                <div class="max-w-4xl mx-auto space-y-4">
                    <h2 class="text-xl font-bold text-slate-800">System Event Management</h2>
                    <div class="bg-white p-6 rounded-xl border border-slate-200">
                        <p class="text-sm text-slate-600">Event configuration controls active live scanner triggers.</p>
                    </div>
                </div>
            \`;
        }

        // 9. Admin System Settings View
        function renderAdminSettingsView(vp) {
            vp.innerHTML = \`
                <div class="max-w-3xl mx-auto space-y-6">
                    <h2 class="text-xl font-bold text-slate-800">System Settings & Logo Uploads</h2>
                    <div class="bg-white p-6 rounded-xl border border-slate-200 space-y-4">
                        <h3 class="font-bold text-sm text-slate-700">Official Logos Configuration</h3>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs font-semibold text-slate-600 mb-1">School Logo</label>
                                <input type="file" onchange="uploadLogo('school', event)" class="text-xs text-slate-500">
                            </div>
                            <div>
                                <label class="block text-xs font-semibold text-slate-600 mb-1">Club Logo</label>
                                <input type="file" onchange="uploadLogo('club', event)" class="text-xs text-slate-500">
                            </div>
                        </div>
                    </div>
                </div>
            \`;
        }

        async function uploadLogo(target, event) {
            const file = event.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('logo', file);
            formData.append('target', target);

            const res = await fetch('/api/admin/settings/logo', { method: 'POST', body: formData });
            if (res.ok) {
                alert('Logo updated successfully.');
                fetchMeta();
            } else {
                alert('Logo upload failed.');
            }
        }

        // App Initialization Trigger
        window.onload = initApp;
    </script>
</body>
</html>
    `);
});

// Start Server Application
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`  STUDENT CLUB ID & REAL-TIME ATTENDANCE MANAGEMENT   `);
    console.log(`  Server Listening on Port : ${PORT}                   `);
    console.log(`  Database Status          : SQLite Persistent WAL     `);
    console.log(`=======================================================`);
});
