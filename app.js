/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Core Application Engine & Database Management
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const compression = require('compression');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Global Configurations & Environment Variables
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TZ || 'Asia/Manila';
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'club_attendance_secret_key_2026_x89a';

// Ensure Upload Directory Structure Exists
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const LOGOS_DIR = path.join(UPLOADS_DIR, 'logos');
const PHOTOS_DIR = path.join(UPLOADS_DIR, 'photos');
const BACKUPS_DIR = path.join(__dirname, 'backups');

[UPLOADS_DIR, LOGOS_DIR, PHOTOS_DIR, BACKUPS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Middleware Configuration
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 Hours
    }
}));

// Safe Timezone Date Utility
function getPhTimezoneDate(dateInput) {
    const date = dateInput ? new Date(dateInput) : new Date();
    return new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
}

function formatISOString(date = new Date()) {
    const phDate = getPhTimezoneDate(date);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${phDate.getFullYear()}-${pad(phDate.getMonth() + 1)}-${pad(phDate.getDate())} ${pad(phDate.getHours())}:${pad(phDate.getMinutes())}:${pad(phDate.getSeconds())}`;
}

// Universal Persistence Database Interface (SQLite3 / PostgreSQL dynamic driver)
class DatabaseAdapter {
    constructor() {
        this.isPg = !!DATABASE_URL;
        this.db = null;
        this.init();
    }

    init() {
        if (this.isPg) {
            const { Pool } = require('pg');
            this.db = new Pool({
                connectionString: DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
            });
            console.log('[DATABASE] Connected to PostgreSQL instance via DATABASE_URL');
        } else {
            const sqlite3 = require('sqlite3').verbose();
            const dbPath = path.join(__dirname, 'school_club_attendance.db');
            this.db = new sqlite3.Database(dbPath);
            console.log(`[DATABASE] Connected to SQLite local store: ${dbPath}`);
        }
        this.setupTables();
    }

    query(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (this.isPg) {
                // Convert ? placeholders to $1, $2 for PostgreSQL compatibility
                let paramIndex = 1;
                const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
                this.db.query(pgSql, params, (err, res) => {
                    if (err) return reject(err);
                    resolve({ rows: res.rows, insertId: res.rows[0]?.id });
                });
            } else {
                if (sql.trim().toUpperCase().startsWith('SELECT')) {
                    this.db.all(sql, params, (err, rows) => {
                        if (err) return reject(err);
                        resolve({ rows });
                    });
                } else {
                    this.db.run(sql, params, function (err) {
                        if (err) return reject(err);
                        resolve({ rows: [], insertId: this.lastID, changes: this.changes });
                    });
                }
            }
        });
    }

    async setupTables() {
        const primaryKeySyntax = this.isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
        
        try {
            // Settings Configuration Table
            await this.query(`
                CREATE TABLE IF NOT EXISTS settings (
                    id ${primaryKeySyntax},
                    setting_key VARCHAR(100) UNIQUE NOT NULL,
                    setting_value TEXT
                )
            `);

            // Users Table (Admin, Scanner, Students)
            await this.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id ${primaryKeySyntax},
                    username VARCHAR(100) UNIQUE NOT NULL,
                    email VARCHAR(150) UNIQUE NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'SCANNER', 'STUDENT')),
                    student_id INTEGER DEFAULT NULL,
                    created_at TEXT NOT NULL
                )
            `);

            // Positions Master Table
            await this.query(`
                CREATE TABLE IF NOT EXISTS positions (
                    id ${primaryKeySyntax},
                    title VARCHAR(100) UNIQUE NOT NULL,
                    description TEXT,
                    is_active INTEGER DEFAULT 1,
                    created_at TEXT NOT NULL
                )
            `);

            // Students Core Registry
            await this.query(`
                CREATE TABLE IF NOT EXISTS students (
                    id ${primaryKeySyntax},
                    student_number VARCHAR(50) UNIQUE NOT NULL,
                    first_name VARCHAR(100) NOT NULL,
                    middle_name VARCHAR(100),
                    last_name VARCHAR(100) NOT NULL,
                    email VARCHAR(150) UNIQUE NOT NULL,
                    contact_number VARCHAR(30),
                    position_id INTEGER NOT NULL,
                    photo_path TEXT NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'ALUMNI', 'RESIGNED')),
                    qr_token VARCHAR(255) UNIQUE NOT NULL,
                    qr_enabled INTEGER DEFAULT 1,
                    date_joined TEXT NOT NULL,
                    expiration_date TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (position_id) REFERENCES positions(id)
                )
            `);

            // Position History Log
            await this.query(`
                CREATE TABLE IF NOT EXISTS position_history (
                    id ${primaryKeySyntax},
                    student_id INTEGER NOT NULL,
                    position_title VARCHAR(100) NOT NULL,
                    assigned_date TEXT NOT NULL,
                    school_year VARCHAR(20) NOT NULL,
                    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
                )
            `);

            // Events Registry
            await this.query(`
                CREATE TABLE IF NOT EXISTS events (
                    id ${primaryKeySyntax},
                    name VARCHAR(150) NOT NULL,
                    description TEXT,
                    event_type VARCHAR(50) NOT NULL,
                    event_date TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    late_threshold_minutes INTEGER DEFAULT 15,
                    location VARCHAR(150),
                    organizer VARCHAR(100),
                    status VARCHAR(20) DEFAULT 'UPCOMING' CHECK (status IN ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
                    target_audience VARCHAR(50) DEFAULT 'ALL',
                    specific_positions TEXT,
                    created_at TEXT NOT NULL
                )
            `);

            // Attendance Logs
            await this.query(`
                CREATE TABLE IF NOT EXISTS attendance (
                    id ${primaryKeySyntax},
                    event_id INTEGER NOT NULL,
                    student_id INTEGER NOT NULL,
                    time_in TEXT,
                    time_out TEXT,
                    status VARCHAR(20) NOT NULL CHECK (status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
                    excused_reason TEXT,
                    excused_by INTEGER,
                    recorded_by INTEGER,
                    created_at TEXT NOT NULL,
                    UNIQUE(event_id, student_id),
                    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
                    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
                )
            `);

            // System Audit Logs
            await this.query(`
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id ${primaryKeySyntax},
                    user_id INTEGER,
                    username VARCHAR(100),
                    action VARCHAR(100) NOT NULL,
                    details TEXT,
                    ip_address VARCHAR(45),
                    created_at TEXT NOT NULL
                )
            `);

            await this.seedDefaults();
            console.log('[DATABASE] All database tables initialized safely with index enforcement.');
        } catch (err) {
            console.error('[DATABASE INIT ERROR]', err);
        }
    }

    async seedDefaults() {
        // Seed Configuration Defaults
        const defaultSettings = [
            ['school_name', 'Central State High School'],
            ['school_address', '123 Academic Way, Education City'],
            ['school_contact', '+63 (045) 892-1011'],
            ['school_email', 'admin@centralstate.edu.ph'],
            ['school_year', '2026-2027'],
            ['club_name', 'Supreme Student Computer Club'],
            ['club_adviser', 'Prof. Alexander Wright'],
            ['organization_name', 'SSCC Academic Guild'],
            ['school_logo', '/uploads/logos/default_school_logo.png'],
            ['club_logo', '/uploads/logos/default_club_logo.png'],
            ['registration_enabled', '1'],
            ['student_number_prefix', 'SC-2026-'],
            ['student_number_counter', '1'],
            ['student_number_padding', '6'],
            ['min_participation_threshold', '75']
        ];

        for (const [key, val] of defaultSettings) {
            const exists = await this.query(`SELECT id FROM settings WHERE setting_key = ?`, [key]);
            if (exists.rows.length === 0) {
                await this.query(`INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)`, [key, val]);
            }
        }

        // Seed Core Positions
        const defaultPositions = [
            'President', 'Vice President', 'Secretary', 'Treasurer', 
            'Auditor', 'Public Information Officer', 'Peace Officer', 
            'Representative', 'Member'
        ];

        for (const pos of defaultPositions) {
            const exists = await this.query(`SELECT id FROM positions WHERE title = ?`, [pos]);
            if (exists.rows.length === 0) {
                await this.query(`INSERT INTO positions (title, description, created_at) VALUES (?, ?, ?)`, 
                    [pos, `Official executive/member position: ${pos}`, formatISOString()]);
            }
        }

        // Seed Root Admin Account
        const adminCheck = await this.query(`SELECT id FROM users WHERE role = 'ADMIN'`);
        if (adminCheck.rows.length === 0) {
            const passwordHash = await bcrypt.hash('Admin@123456', 10);
            await this.query(
                `INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)`,
                ['admin', 'admin@club.edu.ph', passwordHash, 'ADMIN', formatISOString()]
            );
            console.log('[SYSTEM SEED] Default Administrator Account Created -> Username: admin | Pass: Admin@123456');
        }

        // Seed Default Scanner Account
        const scannerCheck = await this.query(`SELECT id FROM users WHERE role = 'SCANNER'`);
        if (scannerCheck.rows.length === 0) {
            const scannerHash = await bcrypt.hash('Scanner@123456', 10);
            await this.query(
                `INSERT INTO users (username, email, password, role, created_at) VALUES (?, ?, ?, ?, ?)`,
                ['scanner', 'scanner@club.edu.ph', scannerHash, 'SCANNER', formatISOString()]
            );
            console.log('[SYSTEM SEED] Default Scanner Terminal User Created -> Username: scanner | Pass: Scanner@123456');
        }
    }
}

const db = new DatabaseAdapter();

// Audit Logger Helper
async function logAudit(req, action, details) {
    try {
        const userId = req.session?.user?.id || null;
        const username = req.session?.user?.username || 'SYSTEM_GUEST';
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        await db.query(
            `INSERT INTO audit_logs (user_id, username, action, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, username, action, details, ip, formatISOString()]
        );
    } catch (e) {
        console.error('[AUDIT LOG FAILED]', e);
    }
}

// File Storage Engine Setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'school_logo' || file.fieldname === 'club_logo') {
            cb(null, LOGOS_DIR);
        } else if (file.fieldname === 'student_photo') {
            cb(null, PHOTOS_DIR);
        } else {
            cb(null, UPLOADS_DIR);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file format. Only JPG, JPEG, PNG, and WEBP image uploads are permitted.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB Upload Limit
});

// Authentication Guard Middlewares
function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, message: 'Unauthorized session access. Please log in.' });
    }
    next();
}

function requireRole(roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ success: false, message: 'Authentication required.' });
        }
        if (!roles.includes(req.session.user.role)) {
            return res.status(403).json({ success: false, message: 'Access denied. Inefficient role permissions.' });
        }
        next();
    };
}

// Student ID Number Auto-Generator
async function generateStudentNumber() {
    const prefixRes = await db.query(`SELECT setting_value FROM settings WHERE setting_key = 'student_number_prefix'`);
    const counterRes = await db.query(`SELECT setting_value FROM settings WHERE setting_key = 'student_number_counter'`);
    const paddingRes = await db.query(`SELECT setting_value FROM settings WHERE setting_key = 'student_number_padding'`);

    const prefix = prefixRes.rows[0]?.setting_value || 'SC-2026-';
    let counter = parseInt(counterRes.rows[0]?.setting_value || '1', 10);
    const padding = parseInt(paddingRes.rows[0]?.setting_value || '6', 10);

    let generatedNumber = '';
    let isUnique = false;

    while (!isUnique) {
        const formattedCounter = counter.toString().padStart(padding, '0');
        generatedNumber = `${prefix}${formattedCounter}`;
        
        const check = await db.query(`SELECT id FROM students WHERE student_number = ?`, [generatedNumber]);
        if (check.rows.length === 0) {
            isUnique = true;
        } else {
            counter++;
        }
    }

    // Increment Counter Persistently
    await db.query(`UPDATE settings SET setting_value = ? WHERE setting_key = 'student_number_counter'`, [(counter + 1).toString()]);

    return generatedNumber;
}

// Fetch Global Club System Configuration Helper
async function getSystemSettings() {
    const rows = await db.query(`SELECT setting_key, setting_value FROM settings`);
    const settings = {};
    rows.rows.forEach(row => {
        settings[row.setting_key] = row.setting_value;
    });
    return settings;
}
/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Part 2: Authentication, Registration, Management, & Scanner APIs
 */

// ==========================================
// 1. AUTHENTICATION ENDPOINTS
// ==========================================

// Login Handler (Supports Admin, Scanner, and Student roles)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username/Email and Password are required.' });
        }

        // Query user by username or email
        const userRes = await db.query(
            `SELECT * FROM users WHERE username = ? OR email = ?`,
            [username.trim(), username.trim().toLowerCase()]
        );

        if (userRes.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials provided.' });
        }

        const user = userRes.rows[0];

        // Verify password hash
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials provided.' });
        }

        // Fetch associated student profile if student role
        let studentData = null;
        if (user.role === 'STUDENT' && user.student_id) {
            const stRes = await db.query(
                `SELECT s.*, p.title as position_name 
                 FROM students s 
                 LEFT JOIN positions p ON s.position_id = p.id 
                 WHERE s.id = ?`,
                [user.student_id]
            );
            studentData = stRes.rows[0] || null;
            if (studentData && studentData.status !== 'ACTIVE') {
                return res.status(403).json({ success: false, message: `Account is currently ${studentData.status}. Contact Club Adviser.` });
            }
        }

        // Set session state
        req.session.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            student_id: user.student_id
        };

        await logAudit(req, 'USER_LOGIN', `User ${user.username} (${user.role}) logged in successfully.`);

        res.json({
            success: true,
            message: 'Authentication successful.',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                student: studentData
            }
        });
    } catch (err) {
        console.error('[LOGIN ERROR]', err);
        res.status(500).json({ success: false, message: 'Internal server error during login processing.' });
    }
});

// Logout Handler
app.post('/api/auth/logout', async (req, res) => {
    if (req.session.user) {
        await logAudit(req, 'USER_LOGOUT', `User ${req.session.user.username} logged out.`);
    }
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Logout failure.' });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out successfully.' });
    });
});

// Current User Session State
app.get('/api/auth/me', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }

    try {
        const userRes = await db.query(`SELECT id, username, email, role, student_id FROM users WHERE id = ?`, [req.session.user.id]);
        if (userRes.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'User profile no longer exists.' });
        }

        const user = userRes.rows[0];
        let studentData = null;

        if (user.student_id) {
            const stRes = await db.query(
                `SELECT s.*, p.title as position_name 
                 FROM students s 
                 LEFT JOIN positions p ON s.position_id = p.id 
                 WHERE s.id = ?`,
                [user.student_id]
            );
            studentData = stRes.rows[0] || null;
        }

        res.json({
            success: true,
            user: { ...user, student: studentData }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error retrieving session state.' });
    }
});

// Password Change Handler
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { current_password, new_password, confirm_password } = req.body;

        if (!current_password || !new_password || !confirm_password) {
            return res.status(400).json({ success: false, message: 'All password fields are required.' });
        }

        if (new_password !== confirm_password) {
            return res.status(400).json({ success: false, message: 'New password and confirmation do not match.' });
        }

        if (new_password.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
        }

        const userRes = await db.query(`SELECT * FROM users WHERE id = ?`, [req.session.user.id]);
        const user = userRes.rows[0];

        const isMatch = await bcrypt.compare(current_password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password incorrect.' });
        }

        const newHash = await bcrypt.hash(new_password, 10);
        await db.query(`UPDATE users SET password = ? WHERE id = ?`, [newHash, req.session.user.id]);

        await logAudit(req, 'PASSWORD_CHANGE', `User ${req.session.user.username} updated their account password.`);

        res.json({ success: true, message: 'Password changed successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update password.' });
    }
});

// ==========================================
// 2. PUBLIC SELF-REGISTRATION & POSITIONS API
// ==========================================

// Public Positions List (For Registration & Selection Dropdowns)
app.get('/api/public/positions', async (req, res) => {
    try {
        const result = await db.query(`SELECT id, title FROM positions WHERE is_active = 1 ORDER BY title ASC`);
        res.json({ success: true, positions: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch positions.' });
    }
});

// Registration System Status Check
app.get('/api/public/registration-status', async (req, res) => {
    try {
        const settings = await getSystemSettings();
        res.json({
            success: true,
            registration_enabled: settings.registration_enabled === '1',
            school_name: settings.school_name,
            club_name: settings.club_name,
            school_logo: settings.school_logo,
            club_logo: settings.club_logo
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Status query failed.' });
    }
});

// Student Self-Registration Handler
app.post('/api/public/register', upload.single('student_photo'), async (req, res) => {
    try {
        const settings = await getSystemSettings();
        if (settings.registration_enabled !== '1') {
            return res.status(403).json({ success: false, message: 'Registration is currently closed. Contact Club Adviser.' });
        }

        const { first_name, middle_name, last_name, email, contact_number, position_id } = req.body;

        // Field Validation
        if (!first_name || !last_name || !email || !position_id) {
            return res.status(400).json({ success: false, message: 'First name, last name, email, and position are required.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Student photo is required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Check for Existing Duplicate Email
        const duplicateCheck = await db.query(`SELECT id FROM students WHERE email = ?`, [normalizedEmail]);
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Email address is already registered in the system.' });
        }

        // Generate Pre-approval Token and Student Reference
        const photoPath = `/uploads/photos/${req.file.filename}`;
        const qrToken = 'PENDING-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
        const tempStudentNumber = 'PENDING-' + Date.now();

        const insertRes = await db.query(
            `INSERT INTO students 
            (student_number, first_name, middle_name, last_name, email, contact_number, position_id, photo_path, status, qr_token, qr_enabled, date_joined, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 1, ?, ?)`,
            [
                tempStudentNumber,
                first_name.trim(),
                middle_name ? middle_name.trim() : '',
                last_name.trim(),
                normalizedEmail,
                contact_number ? contact_number.trim() : '',
                position_id,
                photoPath,
                formatISOString().split(' ')[0],
                qrToken,
                formatISOString()
            ]
        );

        await logAudit(null, 'STUDENT_REGISTER_REQUEST', `Registration submitted by ${first_name} ${last_name} (${normalizedEmail})`);

        res.json({
            success: true,
            message: 'Registration submitted successfully! Please wait for Club Adviser approval.'
        });
    } catch (err) {
        console.error('[REGISTRATION ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to process registration.' });
    }
});

// ==========================================
// 3. ADMIN STUDENT REGISTRATION MANAGEMENT
// ==========================================

// Get All Pending Registrations
app.get('/api/admin/registrations/pending', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const result = await db.query(
            `SELECT s.*, p.title as position_name 
             FROM students s 
             LEFT JOIN positions p ON s.position_id = p.id 
             WHERE s.status = 'PENDING' 
             ORDER BY s.created_at DESC`
        );
        res.json({ success: true, pending: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load pending registrations.' });
    }
});

// Approve Pending Registration
app.post('/api/admin/registrations/approve/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;

        const stCheck = await db.query(`SELECT * FROM students WHERE id = ? AND status = 'PENDING'`, [studentId]);
        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending registration record not found.' });
        }

        const pendingStudent = stCheck.rows[0];

        // 1. Generate Permanent Student ID Number
        const officialStudentNumber = await generateStudentNumber();

        // 2. Generate Permanent Secure Token for QR Generation
        const qrToken = `STU-QR-${officialStudentNumber}-${Date.now().toString(36)}`;

        // 3. Fetch Position Name
        const posRes = await db.query(`SELECT title FROM positions WHERE id = ?`, [pendingStudent.position_id]);
        const positionName = posRes.rows[0]?.title || 'Member';

        // 4. Update Student Record
        await db.query(
            `UPDATE students 
             SET student_number = ?, qr_token = ?, status = 'ACTIVE' 
             WHERE id = ?`,
            [officialStudentNumber, qrToken, studentId]
        );

        // 5. Append Position History
        const settings = await getSystemSettings();
        await db.query(
            `INSERT INTO position_history (student_id, position_title, assigned_date, school_year) 
             VALUES (?, ?, ?, ?)`,
            [studentId, positionName, formatISOString().split(' ')[0], settings.school_year || '2026-2027']
        );

        // 6. Automatically Create Default Student User Account
        const defaultPassword = 'Student@123456';
        const passwordHash = await bcrypt.hash(defaultPassword, 10);
        
        await db.query(
            `INSERT INTO users (username, email, password, role, student_id, created_at) 
             VALUES (?, ?, ?, 'STUDENT', ?, ?)`,
            [officialStudentNumber, pendingStudent.email, passwordHash, studentId, formatISOString()]
        );

        await logAudit(req, 'REGISTRATION_APPROVED', `Approved registration for ${pendingStudent.first_name} ${pendingStudent.last_name}. Assigned ID: ${officialStudentNumber}`);

        res.json({
            success: true,
            message: `Student approved! Student Number: ${officialStudentNumber}. Account password set to default: ${defaultPassword}`,
            student_number: officialStudentNumber
        });
    } catch (err) {
        console.error('[APPROVAL ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to approve registration.' });
    }
});

// Reject Pending Registration
app.post('/api/admin/registrations/reject/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const stCheck = await db.query(`SELECT * FROM students WHERE id = ? AND status = 'PENDING'`, [studentId]);

        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending registration not found.' });
        }

        const student = stCheck.rows[0];

        // Delete uploaded photo if exists
        if (student.photo_path && fs.existsSync(path.join(__dirname, 'public', student.photo_path))) {
            try { fs.unlinkSync(path.join(__dirname, 'public', student.photo_path)); } catch(e){}
        }

        await db.query(`DELETE FROM students WHERE id = ?`, [studentId]);
        await logAudit(req, 'REGISTRATION_REJECTED', `Rejected registration for ${student.first_name} ${student.last_name}`);

        res.json({ success: true, message: 'Registration rejected and removed.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to reject registration.' });
    }
});

// Toggle Global Registration Link Access
app.post('/api/admin/settings/toggle-registration', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { enabled } = req.body;
        const value = enabled ? '1' : '0';
        await db.query(`UPDATE settings SET setting_value = ? WHERE setting_key = 'registration_enabled'`, [value]);

        await logAudit(req, 'REGISTRATION_TOGGLE', `Student registration link set to: ${enabled ? 'OPEN' : 'CLOSED'}`);

        res.json({ success: true, message: `Registration is now ${enabled ? 'ENABLED' : 'DISABLED'}.` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update registration status.' });
    }
});

// ==========================================
// 4. STUDENT CORE MANAGEMENT APIs
// ==========================================

// Get All Approved/Active Students with Filters
app.get('/api/students', requireAuth, async (req, res) => {
    try {
        const { search, position_id, status } = req.query;

        let sql = `
            SELECT s.*, p.title as position_name 
            FROM students s 
            LEFT JOIN positions p ON s.position_id = p.id 
            WHERE 1=1 
        `;
        const params = [];

        if (status) {
            sql += ` AND s.status = ?`;
            params.push(status);
        } else {
            sql += ` AND s.status != 'PENDING'`;
        }

        if (position_id) {
            sql += ` AND s.position_id = ?`;
            params.push(position_id);
        }

        if (search) {
            sql += ` AND (s.student_number LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ?)`;
            const q = `%${search.trim()}%`;
            params.push(q, q, q, q);
        }

        sql += ` ORDER BY s.last_name ASC, s.first_name ASC`;

        const result = await db.query(sql, params);
        res.json({ success: true, students: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to retrieve students list.' });
    }
});

// Get Single Student Record & Detail View
app.get('/api/students/:id', requireAuth, async (req, res) => {
    try {
        const studentId = req.params.id;

        // Security check for student role (students can only fetch their own record)
        if (req.session.user.role === 'STUDENT' && req.session.user.student_id != studentId) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        const stRes = await db.query(
            `SELECT s.*, p.title as position_name 
             FROM students s 
             LEFT JOIN positions p ON s.position_id = p.id 
             WHERE s.id = ?`,
            [studentId]
        );

        if (stRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student record not found.' });
        }

        // Fetch position history log
        const historyRes = await db.query(
            `SELECT * FROM position_history WHERE student_id = ? ORDER BY assigned_date DESC`,
            [studentId]
        );

        res.json({
            success: true,
            student: stRes.rows[0],
            history: historyRes.rows
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error retrieving student profile.' });
    }
});

// Update Existing Student Profile (Admin Only)
app.put('/api/students/:id', requireAuth, requireRole(['ADMIN']), upload.single('student_photo'), async (req, res) => {
    try {
        const studentId = req.params.id;
        const { first_name, middle_name, last_name, email, contact_number, position_id, status } = req.body;

        const checkRes = await db.query(`SELECT * FROM students WHERE id = ?`, [studentId]);
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        const currentStudent = checkRes.rows[0];

        // Handle Photo Update if uploaded
        let photoPath = currentStudent.photo_path;
        if (req.file) {
            photoPath = `/uploads/photos/${req.file.filename}`;
            if (currentStudent.photo_path && fs.existsSync(path.join(__dirname, 'public', currentStudent.photo_path))) {
                try { fs.unlinkSync(path.join(__dirname, 'public', currentStudent.photo_path)); } catch(e){}
            }
        }

        // Handle Position Change & History Logging
        if (position_id && parseInt(position_id, 10) !== currentStudent.position_id) {
            const posRes = await db.query(`SELECT title FROM positions WHERE id = ?`, [position_id]);
            if (posRes.rows.length > 0) {
                const settings = await getSystemSettings();
                await db.query(
                    `INSERT INTO position_history (student_id, position_title, assigned_date, school_year) 
                     VALUES (?, ?, ?, ?)`,
                    [studentId, posRes.rows[0].title, formatISOString().split(' ')[0], settings.school_year || '2026-2027']
                );
            }
        }

        await db.query(
            `UPDATE students 
             SET first_name = ?, middle_name = ?, last_name = ?, email = ?, contact_number = ?, position_id = ?, status = ?, photo_path = ? 
             WHERE id = ?`,
            [
                first_name || currentStudent.first_name,
                middle_name !== undefined ? middle_name : currentStudent.middle_name,
                last_name || currentStudent.last_name,
                email || currentStudent.email,
                contact_number !== undefined ? contact_number : currentStudent.contact_number,
                position_id || currentStudent.position_id,
                status || currentStudent.status,
                photoPath,
                studentId
            ]
        );

        // Keep associated user email synced
        if (email) {
            await db.query(`UPDATE users SET email = ? WHERE student_id = ?`, [email, studentId]);
        }

        await logAudit(req, 'STUDENT_UPDATE', `Updated profile details for student ID: ${currentStudent.student_number}`);

        res.json({ success: true, message: 'Student details updated successfully.' });
    } catch (err) {
        console.error('[STUDENT UPDATE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to update student profile.' });
    }
});

// Regenerate QR Code Token for Student
app.post('/api/students/:id/regenerate-qr', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const stCheck = await db.query(`SELECT student_number FROM students WHERE id = ?`, [studentId]);

        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        const newQrToken = `STU-QR-${stCheck.rows[0].student_number}-${Date.now().toString(36)}`;
        await db.query(`UPDATE students SET qr_token = ? WHERE id = ?`, [newQrToken, studentId]);

        await logAudit(req, 'QR_REGENERATED', `Regenerated QR token for Student ID ${stCheck.rows[0].student_number}. Previous QR invalidated.`);

        res.json({ success: true, message: 'QR Code regenerated successfully. Old QR is now invalid.', qr_token: newQrToken });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to regenerate QR code.' });
    }
});

// Toggle QR Active State (Enable/Disable QR)
app.post('/api/students/:id/toggle-qr', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const { enabled } = req.body;

        await db.query(`UPDATE students SET qr_enabled = ? WHERE id = ?`, [enabled ? 1 : 0, studentId]);

        await logAudit(req, 'QR_STATUS_TOGGLE', `Set QR enabled status to ${enabled ? 1 : 0} for student ID: ${studentId}`);

        res.json({ success: true, message: `Student QR Code ${enabled ? 'enabled' : 'disabled'} successfully.` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update QR state.' });
    }
});

// Delete Student Profile (Admin Only)
app.delete('/api/students/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const stCheck = await db.query(`SELECT * FROM students WHERE id = ?`, [studentId]);

        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        const student = stCheck.rows[0];

        // Delete uploaded photo
        if (student.photo_path && fs.existsSync(path.join(__dirname, 'public', student.photo_path))) {
            try { fs.unlinkSync(path.join(__dirname, 'public', student.photo_path)); } catch(e){}
        }

        // Remove user account association
        await db.query(`DELETE FROM users WHERE student_id = ?`, [studentId]);
        // Remove student
        await db.query(`DELETE FROM students WHERE id = ?`, [studentId]);

        await logAudit(req, 'STUDENT_DELETE', `Deleted student ${student.student_number} (${student.first_name} ${student.last_name})`);

        res.json({ success: true, message: 'Student and related access credentials permanently removed.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete student record.' });
    }
});

// Dynamic QR Code Rendering Image Generator Utility
app.get('/api/qr/render/:token', async (req, res) => {
    try {
        const token = req.params.token;
        if (!token) return res.status(400).send('Invalid token');

        // Generate High Resolution Data URL
        const qrImageData = await QRCode.toDataURL(token, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 400,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        const base64Data = qrImageData.replace(/^data:image\/png;base64,/, "");
        const imgBuffer = Buffer.from(base64Data, 'base64');

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': imgBuffer.length
        });
        res.end(imgBuffer);
    } catch (err) {
        res.status(500).send('QR Generation Error');
    }
});

// ==========================================
// 5. CUSTOM POSITIONS MANAGEMENT
// ==========================================

app.get('/api/positions', requireAuth, async (req, res) => {
    try {
        const result = await db.query(`SELECT * FROM positions ORDER BY title ASC`);
        res.json({ success: true, positions: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to retrieve positions.' });
    }
});

app.post('/api/positions', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { title, description } = req.body;
        if (!title) {
            return res.status(400).json({ success: false, message: 'Position title is required.' });
        }

        const check = await db.query(`SELECT id FROM positions WHERE title = ?`, [title.trim()]);
        if (check.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Position title already exists.' });
        }

        await db.query(
            `INSERT INTO positions (title, description, is_active, created_at) VALUES (?, ?, 1, ?)`,
            [title.trim(), description ? description.trim() : '', formatISOString()]
        );

        await logAudit(req, 'POSITION_CREATE', `Created custom position: ${title}`);

        res.json({ success: true, message: 'Position created successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to create position.' });
    }
});

app.put('/api/positions/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { title, description, is_active } = req.body;
        const posId = req.params.id;

        await db.query(
            `UPDATE positions SET title = ?, description = ?, is_active = ? WHERE id = ?`,
            [title.trim(), description || '', is_active ? 1 : 0, posId]
        );

        await logAudit(req, 'POSITION_UPDATE', `Updated position ID: ${posId} (${title})`);

        res.json({ success: true, message: 'Position updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update position.' });
    }
});

app.delete('/api/positions/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const posId = req.params.id;

        // Verify if students are attached
        const attached = await db.query(`SELECT id FROM students WHERE position_id = ?`, [posId]);
        if (attached.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `Cannot delete position. It is currently assigned to ${attached.rows.length} student(s). Reassign them first.` 
            });
        }

        await db.query(`DELETE FROM positions WHERE id = ?`, [posId]);
        await logAudit(req, 'POSITION_DELETE', `Deleted position ID: ${posId}`);

        res.json({ success: true, message: 'Position deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete position.' });
    }
});

// ==========================================
// 6. EVENT MANAGEMENT SYSTEM APIs
// ==========================================

// Get All Events
app.get('/api/events', requireAuth, async (req, res) => {
    try {
        const { status, type } = req.query;
        let sql = `SELECT * FROM events WHERE 1=1`;
        const params = [];

        if (status) {
            sql += ` AND status = ?`;
            params.push(status);
        }

        if (type) {
            sql += ` AND event_type = ?`;
            params.push(type);
        }

        sql += ` ORDER BY event_date DESC, start_time DESC`;

        const result = await db.query(sql, params);
        res.json({ success: true, events: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch events.' });
    }
});

// Create Event
app.post('/api/events', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { name, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, target_audience, specific_positions } = req.body;

        if (!name || !event_type || !event_date || !start_time || !end_time) {
            return res.status(400).json({ success: false, message: 'Event Name, Type, Date, Start Time, and End Time are required.' });
        }

        const insertRes = await db.query(
            `INSERT INTO events 
            (name, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, status, target_audience, specific_positions, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPCOMING', ?, ?, ?)`,
            [
                name.trim(),
                description ? description.trim() : '',
                event_type,
                event_date,
                start_time,
                end_time,
                late_threshold_minutes || 15,
                location ? location.trim() : 'Club Center',
                organizer ? organizer.trim() : 'Club Officers',
                target_audience || 'ALL',
                specific_positions ? JSON.stringify(specific_positions) : null,
                formatISOString()
            ]
        );

        await logAudit(req, 'EVENT_CREATE', `Created event: ${name} (${event_date})`);

        res.json({ success: true, message: 'Event created successfully.', event_id: insertRes.insertId });
    } catch (err) {
        console.error('[EVENT CREATE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to create event.' });
    }
});

// Update Event & Status Transitions
app.put('/api/events/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const eventId = req.params.id;
        const { name, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, status, target_audience, specific_positions } = req.body;

        const currentRes = await db.query(`SELECT * FROM events WHERE id = ?`, [eventId]);
        if (currentRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Event not found.' });
        }

        const oldStatus = currentRes.rows[0].status;

        await db.query(
            `UPDATE events 
             SET name = ?, description = ?, event_type = ?, event_date = ?, start_time = ?, end_time = ?, 
                 late_threshold_minutes = ?, location = ?, organizer = ?, status = ?, target_audience = ?, specific_positions = ? 
             WHERE id = ?`,
            [
                name, description, event_type, event_date, start_time, end_time,
                late_threshold_minutes, location, organizer, status, target_audience,
                specific_positions ? JSON.stringify(specific_positions) : null,
                eventId
            ]
        );

        // Automatic Absent Detection Trigger when event status transitions to COMPLETED
        if (status === 'COMPLETED' && oldStatus !== 'COMPLETED') {
            await triggerAutomaticAbsentMarking(eventId);
        }

        await logAudit(req, 'EVENT_UPDATE', `Updated event ID: ${eventId} (${name}), Status set to: ${status}`);

        res.json({ success: true, message: 'Event details updated.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update event details.' });
    }
});

// Automatic Absent Marker Function
async function triggerAutomaticAbsentMarking(eventId) {
    try {
        const eventRes = await db.query(`SELECT * FROM events WHERE id = ?`, [eventId]);
        if (eventRes.rows.length === 0) return;
        const event = eventRes.rows[0];

        // Fetch target eligible active students
        let studentQuery = `SELECT id FROM students WHERE status = 'ACTIVE'`;
        const params = [];

        if (event.target_audience === 'OFFICERS_ONLY') {
            studentQuery += ` AND position_id IN (SELECT id FROM positions WHERE title LIKE '%President%' OR title LIKE '%Officer%' OR title LIKE '%Secretary%' OR title LIKE '%Treasurer%' OR title LIKE '%Auditor%')`;
        } else if (event.target_audience === 'SPECIFIC' && event.specific_positions) {
            try {
                const posIds = JSON.parse(event.specific_positions);
                if (Array.isArray(posIds) && posIds.length > 0) {
                    const placeholders = posIds.map(() => '?').join(',');
                    studentQuery += ` AND position_id IN (${placeholders})`;
                    params.push(...posIds);
                }
            } catch(e){}
        }

        const eligibleStudents = await db.query(studentQuery, params);

        for (const student of eligibleStudents.rows) {
            // Check if record exists
            const attCheck = await db.query(`SELECT id FROM attendance WHERE event_id = ? AND student_id = ?`, [eventId, student.id]);
            if (attCheck.rows.length === 0) {
                // Record as ABSENT automatically
                await db.query(
                    `INSERT INTO attendance (event_id, student_id, status, created_at) VALUES (?, ?, 'ABSENT', ?)`,
                    [eventId, student.id, formatISOString()]
                );
            }
        }
        console.log(`[AUTOMATIC ABSENT DETECTOR] Event ID ${eventId} completed. Absent records registered.`);
    } catch (err) {
        console.error('[AUTOMATIC ABSENT DETECTOR ERROR]', err);
    }
}

// Delete Event
app.delete('/api/events/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const eventId = req.params.id;
        await db.query(`DELETE FROM events WHERE id = ?`, [eventId]);
        await logAudit(req, 'EVENT_DELETE', `Deleted event ID: ${eventId}`);
        res.json({ success: true, message: 'Event deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete event.' });
    }
});

// ==========================================
// 7. REAL-TIME QR SCANNER PROCESSING ENGINE
// ==========================================

// Core Attendance Scan Processing Endpoint
app.post('/api/scanner/scan', requireAuth, requireRole(['ADMIN', 'SCANNER']), async (req, res) => {
    try {
        const { qr_token, event_id, scan_mode } = req.body; // scan_mode: 'TIME_IN' or 'TIME_OUT'

        if (!qr_token || !event_id) {
            return res.status(400).json({ 
                success: false, 
                code: 'INVALID_REQUEST', 
                message: 'QR Token and Selected Event are required.' 
            });
        }

        // 1. Validate Active Event
        const eventRes = await db.query(`SELECT * FROM events WHERE id = ?`, [event_id]);
        if (eventRes.rows.length === 0) {
            return res.status(404).json({ success: false, code: 'EVENT_NOT_FOUND', message: 'Selected event does not exist.' });
        }
        const event = eventRes.rows[0];

        if (event.status === 'CANCELLED') {
            return res.status(400).json({ success: false, code: 'EVENT_CANCELLED', message: 'Selected event has been cancelled.' });
        }

        // 2. Validate Student & Token
        const studentRes = await db.query(
            `SELECT s.*, p.title as position_name 
             FROM students s 
             LEFT JOIN positions p ON s.position_id = p.id 
             WHERE s.qr_token = ?`,
            [qr_token.trim()]
        );

        if (studentRes.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                code: 'INVALID_QR', 
                message: 'INVALID QR CODE. Unrecognized token.' 
            });
        }

        const student = studentRes.rows[0];

        if (student.qr_enabled !== 1) {
            return res.status(403).json({ 
                success: false, 
                code: 'QR_DISABLED', 
                message: 'QR Code is disabled for this student. Contact Adviser.',
                student_name: `${student.first_name} ${student.last_name}`
            });
        }

        if (student.status !== 'ACTIVE') {
            return res.status(403).json({ 
                success: false, 
                code: 'STUDENT_INACTIVE', 
                message: `Student membership is currently ${student.status}.`,
                student_name: `${student.first_name} ${student.last_name}`
            });
        }

        // 3. Check Existing Attendance
        const attRes = await db.query(
            `SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`,
            [event_id, student.id]
        );

        const currentTimeStr = formatISOString();
        const timeOnly = currentTimeStr.split(' ')[1]; // HH:MM:SS

        const isTimeOutMode = scan_mode === 'TIME_OUT';

        if (attRes.rows.length > 0) {
            const existingAttendance = attRes.rows[0];

            if (isTimeOutMode) {
                // Process TIME OUT
                if (existingAttendance.time_out) {
                    return res.status(400).json({
                        success: false,
                        code: 'DUPLICATE_TIMEOUT',
                        message: `${student.first_name} ${student.last_name}, Time Out was already recorded.`,
                        student: student
                    });
                }

                await db.query(
                    `UPDATE attendance SET time_out = ? WHERE id = ?`,
                    [timeOnly, existingAttendance.id]
                );

                await logAudit(req, 'SCAN_TIMEOUT', `Time Out recorded for ${student.student_number} at Event ${event.name}`);

                return res.json({
                    success: true,
                    scan_type: 'TIME_OUT',
                    message: `${student.first_name} ${student.last_name}, time out recorded.`,
                    student: student,
                    attendance: {
                        time_in: existingAttendance.time_in,
                        time_out: timeOnly,
                        status: existingAttendance.status
                    }
                });
            } else {
                // Duplicate TIME IN Check
                return res.status(400).json({
                    success: false,
                    code: 'DUPLICATE_SCAN',
                    message: `${student.first_name} ${student.last_name}, you are already recorded.`,
                    student: student,
                    attendance: existingAttendance
                });
            }
        }

        // If trying to scan Time Out without Time In record
        if (isTimeOutMode) {
            return res.status(400).json({
                success: false,
                code: 'NO_TIME_IN',
                message: `Cannot record Time Out. No prior Time In record found for ${student.first_name} ${student.last_name}.`,
                student: student
            });
        }

        // 4. Calculate Automatic Attendance Status (PRESENT or LATE)
        let attendanceStatus = 'PRESENT';
        
        // Combine event date and start time to compute late status
        const eventStartDateTime = new Date(`${event.event_date}T${event.start_time}`);
        const currentDateTime = getPhTimezoneDate();
        
        // Late threshold buffer in minutes
        const thresholdMs = (event.late_threshold_minutes || 15) * 60 * 1000;
        const lateCutoff = new Date(eventStartDateTime.getTime() + thresholdMs);

        if (currentDateTime > lateCutoff) {
            attendanceStatus = 'LATE';
        }

        // 5. Insert Attendance Log
        await db.query(
            `INSERT INTO attendance 
            (event_id, student_id, time_in, status, recorded_by, created_at) 
            VALUES (?, ?, ?, ?, ?, ?)`,
            [event_id, student.id, timeOnly, attendanceStatus, req.session.user.id, currentTimeStr]
        );

        await logAudit(req, 'SCAN_TIMEIN', `Time In (${attendanceStatus}) recorded for ${student.student_number} (${student.first_name} ${student.last_name}) at Event ${event.name}`);

        return res.json({
            success: true,
            scan_type: 'TIME_IN',
            message: `${student.first_name} ${student.last_name}, attendance recorded.`,
            student: student,
            attendance: {
                time_in: timeOnly,
                time_out: null,
                status: attendanceStatus
            }
        });

    } catch (err) {
        console.error('[SCANNER API ERROR]', err);
        res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Internal processing error during scan.' });
    }
});

// Mark Student Excused Absence (Admin Only)
app.post('/api/attendance/excuse', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { event_id, student_id, reason } = req.body;

        if (!event_id || !student_id) {
            return res.status(400).json({ success: false, message: 'Event and Student ID are required.' });
        }

        const existing = await db.query(`SELECT id FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student_id]);

        if (existing.rows.length > 0) {
            await db.query(
                `UPDATE attendance SET status = 'EXCUSED', excused_reason = ?, excused_by = ? WHERE id = ?`,
                [reason || 'Approved Excuse', req.session.user.id, existing.rows[0].id]
            );
        } else {
            await db.query(
                `INSERT INTO attendance (event_id, student_id, status, excused_reason, excused_by, created_at) 
                 VALUES (?, ?, 'EXCUSED', ?, ?, ?)`,
                [event_id, student_id, reason || 'Approved Excuse', req.session.user.id, formatISOString()]
            );
        }

        await logAudit(req, 'ATTENDANCE_EXCUSED', `Marked student ID ${student_id} as EXCUSED for Event ID ${event_id}`);

        res.json({ success: true, message: 'Student attendance marked as EXCUSED.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update excuse status.' });
    }
});

// ==========================================
// 8. ACCURATE DATABASE DASHBOARD & ANALYTICS
// ==========================================

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        const { date_filter, event_id, position_id } = req.query;

        // 1. Total Student Counts
        const totalStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status != 'PENDING'`);
        const activeStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status = 'ACTIVE'`);
        const inactiveStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status = 'INACTIVE'`);
        const pendingStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status = 'PENDING'`);

        // Filter Logic construction
        let attendanceWhere = ` WHERE 1=1`;
        const attParams = [];

        if (event_id && event_id !== 'ALL') {
            attendanceWhere += ` AND a.event_id = ?`;
            attParams.push(event_id);
        }

        if (position_id && position_id !== 'ALL') {
            attendanceWhere += ` AND s.position_id = ?`;
            attParams.push(position_id);
        }

        if (date_filter === 'TODAY') {
            const todayStr = formatISOString().split(' ')[0];
            attendanceWhere += ` AND a.created_at LIKE ?`;
            attParams.push(`${todayStr}%`);
        }

        // Aggregate Attendance Breakdown from real database rows
        const presentQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'PRESENT'
        `;
        const presentRes = await db.query(presentQuery, attParams);

        const lateQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'LATE'
        `;
        const lateRes = await db.query(lateQuery, attParams);

        const absentQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'ABSENT'
        `;
        const absentRes = await db.query(absentQuery, attParams);

        const excusedQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'EXCUSED'
        `;
        const excusedRes = await db.query(excusedQuery, attParams);

        const presentCount = parseInt(presentRes.rows[0]?.count || 0, 10);
        const lateCount = parseInt(lateRes.rows[0]?.count || 0, 10);
        const absentCount = parseInt(absentRes.rows[0]?.count || 0, 10);
        const excusedCount = parseInt(excusedRes.rows[0]?.count || 0, 10);

        const totalExpected = presentCount + lateCount + absentCount + excusedCount;
        const validAttendees = presentCount + lateCount;
        
        const attendanceRate = totalExpected > 0 ? ((validAttendees / totalExpected) * 100).toFixed(1) : "0.0";

        // Active / Upcoming Events
        const activeEventsRes = await db.query(`SELECT COUNT(*) as count FROM events WHERE status = 'ACTIVE'`);
        const upcomingEventsRes = await db.query(`SELECT COUNT(*) as count FROM events WHERE status = 'UPCOMING'`);

        // Recent Scan Feed
        const recentScansRes = await db.query(
            `SELECT a.*, s.first_name, s.last_name, s.student_number, s.photo_path, p.title as position_name, e.name as event_name 
             FROM attendance a 
             JOIN students s ON a.student_id = s.id 
             JOIN positions p ON s.position_id = p.id 
             JOIN events e ON a.event_id = e.id 
             ORDER BY a.created_at DESC LIMIT 10`
        );

        res.json({
            success: true,
            stats: {
                total_students: parseInt(totalStudentsRes.rows[0]?.count || 0, 10),
                active_students: parseInt(activeStudentsRes.rows[0]?.count || 0, 10),
                inactive_students: parseInt(inactiveStudentsRes.rows[0]?.count || 0, 10),
                pending_registrations: parseInt(pendingStudentsRes.rows[0]?.count || 0, 10),
                present_count: presentCount,
                late_count: lateCount,
                absent_count: absentCount,
                excused_count: excusedCount,
                attendance_rate: attendanceRate,
                active_events: parseInt(activeEventsRes.rows[0]?.count || 0, 10),
                upcoming_events: parseInt(upcomingEventsRes.rows[0]?.count || 0, 10)
            },
            recent_scans: recentScansRes.rows
        });

    } catch (err) {
        console.error('[DASHBOARD STATS ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to compute dashboard statistics.' });
    }
});

// Analytics: Frequently Late & Most Active Rankings
app.get('/api/analytics/rankings', requireAuth, async (req, res) => {
    try {
        // Top 5 Frequently Late
        const lateRankings = await db.query(
            `SELECT s.id, s.student_number, s.first_name, s.last_name, p.title as position_name, COUNT(a.id) as late_count 
             FROM attendance a 
             JOIN students s ON a.student_id = s.id 
             JOIN positions p ON s.position_id = p.id 
             WHERE a.status = 'LATE' 
             GROUP BY s.id, s.student_number, s.first_name, s.last_name, p.title 
             ORDER BY late_count DESC LIMIT 5`
        );

        // Top 5 Most Active
        const activeRankings = await db.query(
            `SELECT s.id, s.student_number, s.first_name, s.last_name, p.title as position_name, COUNT(a.id) as attended_count 
             FROM attendance a 
             JOIN students s ON a.student_id = s.id 
             JOIN positions p ON s.position_id = p.id 
             WHERE a.status IN ('PRESENT', 'LATE') 
             GROUP BY s.id, s.student_number, s.first_name, s.last_name, p.title 
             ORDER BY attended_count DESC LIMIT 5`
        );

        res.json({
            success: true,
            frequently_late: lateRankings.rows,
            most_active: activeRankings.rows
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to compute analytics rankings.' });
    }
});

// ==========================================
// 9. SYSTEM SETTINGS, BACKUP, & AUDIT LOGS
// ==========================================

// Get Settings
app.get('/api/settings', requireAuth, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch settings.' });
    }
});

// Update Settings & Upload School/Club Logos
app.post('/api/settings', requireAuth, requireRole(['ADMIN']), upload.fields([
    { name: 'school_logo', maxCount: 1 },
    { name: 'club_logo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { school_name, school_address, school_contact, school_email, school_year, club_name, club_adviser, organization_name, student_number_prefix, min_participation_threshold } = req.body;

        const updates = [
            ['school_name', school_name],
            ['school_address', school_address],
            ['school_contact', school_contact],
            ['school_email', school_email],
            ['school_year', school_year],
            ['club_name', club_name],
            ['club_adviser', club_adviser],
            ['organization_name', organization_name],
            ['student_number_prefix', student_number_prefix],
            ['min_participation_threshold', min_participation_threshold]
        ];

        if (req.files?.school_logo) {
            updates.push(['school_logo', `/uploads/logos/${req.files.school_logo[0].filename}`]);
        }

        if (req.files?.club_logo) {
            updates.push(['club_logo', `/uploads/logos/${req.files.club_logo[0].filename}`]);
        }

        for (const [key, val] of updates) {
            if (val !== undefined) {
                await db.query(`UPDATE settings SET setting_value = ? WHERE setting_key = ?`, [val, key]);
            }
        }

        await logAudit(req, 'SETTINGS_UPDATE', 'Updated system configurations and organizational logos.');

        res.json({ success: true, message: 'System configurations updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to save settings.' });
    }
});

// Database Health Indicator Check
app.get('/api/system/health', requireAuth, async (req, res) => {
    try {
        await db.query(`SELECT 1`);
        res.json({
            success: true,
            database: {
                connected: true,
                type: db.isPg ? 'PostgreSQL' : 'SQLite3',
                last_checked: formatISOString()
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            database: {
                connected: false,
                error: err.message
            }
        });
    }
});

// Trigger Manual Database Backup
app.post('/api/system/backup', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const timestamp = Date.now();
        const backupFileName = `backup-${timestamp}.json`;
        const backupPath = path.join(BACKUPS_DIR, backupFileName);

        // Fetch all tables
        const settings = await db.query(`SELECT * FROM settings`);
        const users = await db.query(`SELECT id, username, email, role, student_id, created_at FROM users`);
        const positions = await db.query(`SELECT * FROM positions`);
        const students = await db.query(`SELECT * FROM students`);
        const position_history = await db.query(`SELECT * FROM position_history`);
        const events = await db.query(`SELECT * FROM events`);
        const attendance = await db.query(`SELECT * FROM attendance`);
        const audit_logs = await db.query(`SELECT * FROM audit_logs`);

        const dumpData = {
            metadata: {
                timestamp: formatISOString(),
                version: '1.0.0'
            },
            data: {
                settings: settings.rows,
                users: users.rows,
                positions: positions.rows,
                students: students.rows,
                position_history: position_history.rows,
                events: events.rows,
                attendance: attendance.rows,
                audit_logs: audit_logs.rows
            }
        };

        fs.writeFileSync(backupPath, JSON.stringify(dumpData, null, 2));

        await logAudit(req, 'BACKUP_CREATE', `Created manual system backup: ${backupFileName}`);

        res.json({ success: true, message: 'System database backup created successfully.', filename: backupFileName });
    } catch (err) {
        console.error('[BACKUP ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to generate backup.' });
    }
});

// Audit Logs Endpoint
app.get('/api/system/audit-logs', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const logs = await db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100`);
        res.json({ success: true, logs: logs.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load audit logs.' });
    }
});
/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Part 2: Authentication, Registration, Management, & Scanner APIs
 */

// ==========================================
// 1. AUTHENTICATION ENDPOINTS
// ==========================================

// Login Handler (Supports Admin, Scanner, and Student roles)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username/Email and Password are required.' });
        }

        // Query user by username or email
        const userRes = await db.query(
            `SELECT * FROM users WHERE username = ? OR email = ?`,
            [username.trim(), username.trim().toLowerCase()]
        );

        if (userRes.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials provided.' });
        }

        const user = userRes.rows[0];

        // Verify password hash
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid credentials provided.' });
        }

        // Fetch associated student profile if student role
        let studentData = null;
        if (user.role === 'STUDENT' && user.student_id) {
            const stRes = await db.query(
                `SELECT s.*, p.title as position_name 
                 FROM students s 
                 LEFT JOIN positions p ON s.position_id = p.id 
                 WHERE s.id = ?`,
                [user.student_id]
            );
            studentData = stRes.rows[0] || null;
            if (studentData && studentData.status !== 'ACTIVE') {
                return res.status(403).json({ success: false, message: `Account is currently ${studentData.status}. Contact Club Adviser.` });
            }
        }

        // Set session state
        req.session.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            student_id: user.student_id
        };

        await logAudit(req, 'USER_LOGIN', `User ${user.username} (${user.role}) logged in successfully.`);

        res.json({
            success: true,
            message: 'Authentication successful.',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                student: studentData
            }
        });
    } catch (err) {
        console.error('[LOGIN ERROR]', err);
        res.status(500).json({ success: false, message: 'Internal server error during login processing.' });
    }
});

// Logout Handler
app.post('/api/auth/logout', async (req, res) => {
    if (req.session.user) {
        await logAudit(req, 'USER_LOGOUT', `User ${req.session.user.username} logged out.`);
    }
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Logout failure.' });
        }
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out successfully.' });
    });
});

// Current User Session State
app.get('/api/auth/me', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }

    try {
        const userRes = await db.query(`SELECT id, username, email, role, student_id FROM users WHERE id = ?`, [req.session.user.id]);
        if (userRes.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'User profile no longer exists.' });
        }

        const user = userRes.rows[0];
        let studentData = null;

        if (user.student_id) {
            const stRes = await db.query(
                `SELECT s.*, p.title as position_name 
                 FROM students s 
                 LEFT JOIN positions p ON s.position_id = p.id 
                 WHERE s.id = ?`,
                [user.student_id]
            );
            studentData = stRes.rows[0] || null;
        }

        res.json({
            success: true,
            user: { ...user, student: studentData }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error retrieving session state.' });
    }
});

// Password Change Handler
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { current_password, new_password, confirm_password } = req.body;

        if (!current_password || !new_password || !confirm_password) {
            return res.status(400).json({ success: false, message: 'All password fields are required.' });
        }

        if (new_password !== confirm_password) {
            return res.status(400).json({ success: false, message: 'New password and confirmation do not match.' });
        }

        if (new_password.length < 8) {
            return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
        }

        const userRes = await db.query(`SELECT * FROM users WHERE id = ?`, [req.session.user.id]);
        const user = userRes.rows[0];

        const isMatch = await bcrypt.compare(current_password, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password incorrect.' });
        }

        const newHash = await bcrypt.hash(new_password, 10);
        await db.query(`UPDATE users SET password = ? WHERE id = ?`, [newHash, req.session.user.id]);

        await logAudit(req, 'PASSWORD_CHANGE', `User ${req.session.user.username} updated their account password.`);

        res.json({ success: true, message: 'Password changed successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update password.' });
    }
});

// ==========================================
// 2. PUBLIC SELF-REGISTRATION & POSITIONS API
// ==========================================

// Public Positions List (For Registration & Selection Dropdowns)
app.get('/api/public/positions', async (req, res) => {
    try {
        const result = await db.query(`SELECT id, title FROM positions WHERE is_active = 1 ORDER BY title ASC`);
        res.json({ success: true, positions: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch positions.' });
    }
});

// Registration System Status Check
app.get('/api/public/registration-status', async (req, res) => {
    try {
        const settings = await getSystemSettings();
        res.json({
            success: true,
            registration_enabled: settings.registration_enabled === '1',
            school_name: settings.school_name,
            club_name: settings.club_name,
            school_logo: settings.school_logo,
            club_logo: settings.club_logo
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Status query failed.' });
    }
});

// Student Self-Registration Handler
app.post('/api/public/register', upload.single('student_photo'), async (req, res) => {
    try {
        const settings = await getSystemSettings();
        if (settings.registration_enabled !== '1') {
            return res.status(403).json({ success: false, message: 'Registration is currently closed. Contact Club Adviser.' });
        }

        const { first_name, middle_name, last_name, email, contact_number, position_id } = req.body;

        // Field Validation
        if (!first_name || !last_name || !email || !position_id) {
            return res.status(400).json({ success: false, message: 'First name, last name, email, and position are required.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Student photo is required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // Check for Existing Duplicate Email
        const duplicateCheck = await db.query(`SELECT id FROM students WHERE email = ?`, [normalizedEmail]);
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Email address is already registered in the system.' });
        }

        // Generate Pre-approval Token and Student Reference
        const photoPath = `/uploads/photos/${req.file.filename}`;
        const qrToken = 'PENDING-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
        const tempStudentNumber = 'PENDING-' + Date.now();

        const insertRes = await db.query(
            `INSERT INTO students 
            (student_number, first_name, middle_name, last_name, email, contact_number, position_id, photo_path, status, qr_token, qr_enabled, date_joined, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 1, ?, ?)`,
            [
                tempStudentNumber,
                first_name.trim(),
                middle_name ? middle_name.trim() : '',
                last_name.trim(),
                normalizedEmail,
                contact_number ? contact_number.trim() : '',
                position_id,
                photoPath,
                formatISOString().split(' ')[0],
                qrToken,
                formatISOString()
            ]
        );

        await logAudit(null, 'STUDENT_REGISTER_REQUEST', `Registration submitted by ${first_name} ${last_name} (${normalizedEmail})`);

        res.json({
            success: true,
            message: 'Registration submitted successfully! Please wait for Club Adviser approval.'
        });
    } catch (err) {
        console.error('[REGISTRATION ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to process registration.' });
    }
});

// ==========================================
// 3. ADMIN STUDENT REGISTRATION MANAGEMENT
// ==========================================

// Get All Pending Registrations
app.get('/api/admin/registrations/pending', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const result = await db.query(
            `SELECT s.*, p.title as position_name 
             FROM students s 
             LEFT JOIN positions p ON s.position_id = p.id 
             WHERE s.status = 'PENDING' 
             ORDER BY s.created_at DESC`
        );
        res.json({ success: true, pending: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load pending registrations.' });
    }
});

// Approve Pending Registration
app.post('/api/admin/registrations/approve/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;

        const stCheck = await db.query(`SELECT * FROM students WHERE id = ? AND status = 'PENDING'`, [studentId]);
        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending registration record not found.' });
        }

        const pendingStudent = stCheck.rows[0];

        // 1. Generate Permanent Student ID Number
        const officialStudentNumber = await generateStudentNumber();

        // 2. Generate Permanent Secure Token for QR Generation
        const qrToken = `STU-QR-${officialStudentNumber}-${Date.now().toString(36)}`;

        // 3. Fetch Position Name
        const posRes = await db.query(`SELECT title FROM positions WHERE id = ?`, [pendingStudent.position_id]);
        const positionName = posRes.rows[0]?.title || 'Member';

        // 4. Update Student Record
        await db.query(
            `UPDATE students 
             SET student_number = ?, qr_token = ?, status = 'ACTIVE' 
             WHERE id = ?`,
            [officialStudentNumber, qrToken, studentId]
        );

        // 5. Append Position History
        const settings = await getSystemSettings();
        await db.query(
            `INSERT INTO position_history (student_id, position_title, assigned_date, school_year) 
             VALUES (?, ?, ?, ?)`,
            [studentId, positionName, formatISOString().split(' ')[0], settings.school_year || '2026-2027']
        );

        // 6. Automatically Create Default Student User Account
        const defaultPassword = 'Student@123456';
        const passwordHash = await bcrypt.hash(defaultPassword, 10);
        
        await db.query(
            `INSERT INTO users (username, email, password, role, student_id, created_at) 
             VALUES (?, ?, ?, 'STUDENT', ?, ?)`,
            [officialStudentNumber, pendingStudent.email, passwordHash, studentId, formatISOString()]
        );

        await logAudit(req, 'REGISTRATION_APPROVED', `Approved registration for ${pendingStudent.first_name} ${pendingStudent.last_name}. Assigned ID: ${officialStudentNumber}`);

        res.json({
            success: true,
            message: `Student approved! Student Number: ${officialStudentNumber}. Account password set to default: ${defaultPassword}`,
            student_number: officialStudentNumber
        });
    } catch (err) {
        console.error('[APPROVAL ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to approve registration.' });
    }
});

// Reject Pending Registration
app.post('/api/admin/registrations/reject/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const stCheck = await db.query(`SELECT * FROM students WHERE id = ? AND status = 'PENDING'`, [studentId]);

        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending registration not found.' });
        }

        const student = stCheck.rows[0];

        // Delete uploaded photo if exists
        if (student.photo_path && fs.existsSync(path.join(__dirname, 'public', student.photo_path))) {
            try { fs.unlinkSync(path.join(__dirname, 'public', student.photo_path)); } catch(e){}
        }

        await db.query(`DELETE FROM students WHERE id = ?`, [studentId]);
        await logAudit(req, 'REGISTRATION_REJECTED', `Rejected registration for ${student.first_name} ${student.last_name}`);

        res.json({ success: true, message: 'Registration rejected and removed.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to reject registration.' });
    }
});

// Toggle Global Registration Link Access
app.post('/api/admin/settings/toggle-registration', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { enabled } = req.body;
        const value = enabled ? '1' : '0';
        await db.query(`UPDATE settings SET setting_value = ? WHERE setting_key = 'registration_enabled'`, [value]);

        await logAudit(req, 'REGISTRATION_TOGGLE', `Student registration link set to: ${enabled ? 'OPEN' : 'CLOSED'}`);

        res.json({ success: true, message: `Registration is now ${enabled ? 'ENABLED' : 'DISABLED'}.` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update registration status.' });
    }
});

// ==========================================
// 4. STUDENT CORE MANAGEMENT APIs
// ==========================================

// Get All Approved/Active Students with Filters
app.get('/api/students', requireAuth, async (req, res) => {
    try {
        const { search, position_id, status } = req.query;

        let sql = `
            SELECT s.*, p.title as position_name 
            FROM students s 
            LEFT JOIN positions p ON s.position_id = p.id 
            WHERE 1=1 
        `;
        const params = [];

        if (status) {
            sql += ` AND s.status = ?`;
            params.push(status);
        } else {
            sql += ` AND s.status != 'PENDING'`;
        }

        if (position_id) {
            sql += ` AND s.position_id = ?`;
            params.push(position_id);
        }

        if (search) {
            sql += ` AND (s.student_number LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ?)`;
            const q = `%${search.trim()}%`;
            params.push(q, q, q, q);
        }

        sql += ` ORDER BY s.last_name ASC, s.first_name ASC`;

        const result = await db.query(sql, params);
        res.json({ success: true, students: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to retrieve students list.' });
    }
});

// Get Single Student Record & Detail View
app.get('/api/students/:id', requireAuth, async (req, res) => {
    try {
        const studentId = req.params.id;

        // Security check for student role (students can only fetch their own record)
        if (req.session.user.role === 'STUDENT' && req.session.user.student_id != studentId) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        const stRes = await db.query(
            `SELECT s.*, p.title as position_name 
             FROM students s 
             LEFT JOIN positions p ON s.position_id = p.id 
             WHERE s.id = ?`,
            [studentId]
        );

        if (stRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student record not found.' });
        }

        // Fetch position history log
        const historyRes = await db.query(
            `SELECT * FROM position_history WHERE student_id = ? ORDER BY assigned_date DESC`,
            [studentId]
        );

        res.json({
            success: true,
            student: stRes.rows[0],
            history: historyRes.rows
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error retrieving student profile.' });
    }
});

// Update Existing Student Profile (Admin Only)
app.put('/api/students/:id', requireAuth, requireRole(['ADMIN']), upload.single('student_photo'), async (req, res) => {
    try {
        const studentId = req.params.id;
        const { first_name, middle_name, last_name, email, contact_number, position_id, status } = req.body;

        const checkRes = await db.query(`SELECT * FROM students WHERE id = ?`, [studentId]);
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        const currentStudent = checkRes.rows[0];

        // Handle Photo Update if uploaded
        let photoPath = currentStudent.photo_path;
        if (req.file) {
            photoPath = `/uploads/photos/${req.file.filename}`;
            if (currentStudent.photo_path && fs.existsSync(path.join(__dirname, 'public', currentStudent.photo_path))) {
                try { fs.unlinkSync(path.join(__dirname, 'public', currentStudent.photo_path)); } catch(e){}
            }
        }

        // Handle Position Change & History Logging
        if (position_id && parseInt(position_id, 10) !== currentStudent.position_id) {
            const posRes = await db.query(`SELECT title FROM positions WHERE id = ?`, [position_id]);
            if (posRes.rows.length > 0) {
                const settings = await getSystemSettings();
                await db.query(
                    `INSERT INTO position_history (student_id, position_title, assigned_date, school_year) 
                     VALUES (?, ?, ?, ?)`,
                    [studentId, posRes.rows[0].title, formatISOString().split(' ')[0], settings.school_year || '2026-2027']
                );
            }
        }

        await db.query(
            `UPDATE students 
             SET first_name = ?, middle_name = ?, last_name = ?, email = ?, contact_number = ?, position_id = ?, status = ?, photo_path = ? 
             WHERE id = ?`,
            [
                first_name || currentStudent.first_name,
                middle_name !== undefined ? middle_name : currentStudent.middle_name,
                last_name || currentStudent.last_name,
                email || currentStudent.email,
                contact_number !== undefined ? contact_number : currentStudent.contact_number,
                position_id || currentStudent.position_id,
                status || currentStudent.status,
                photoPath,
                studentId
            ]
        );

        // Keep associated user email synced
        if (email) {
            await db.query(`UPDATE users SET email = ? WHERE student_id = ?`, [email, studentId]);
        }

        await logAudit(req, 'STUDENT_UPDATE', `Updated profile details for student ID: ${currentStudent.student_number}`);

        res.json({ success: true, message: 'Student details updated successfully.' });
    } catch (err) {
        console.error('[STUDENT UPDATE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to update student profile.' });
    }
});

// Regenerate QR Code Token for Student
app.post('/api/students/:id/regenerate-qr', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const stCheck = await db.query(`SELECT student_number FROM students WHERE id = ?`, [studentId]);

        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        const newQrToken = `STU-QR-${stCheck.rows[0].student_number}-${Date.now().toString(36)}`;
        await db.query(`UPDATE students SET qr_token = ? WHERE id = ?`, [newQrToken, studentId]);

        await logAudit(req, 'QR_REGENERATED', `Regenerated QR token for Student ID ${stCheck.rows[0].student_number}. Previous QR invalidated.`);

        res.json({ success: true, message: 'QR Code regenerated successfully. Old QR is now invalid.', qr_token: newQrToken });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to regenerate QR code.' });
    }
});

// Toggle QR Active State (Enable/Disable QR)
app.post('/api/students/:id/toggle-qr', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const { enabled } = req.body;

        await db.query(`UPDATE students SET qr_enabled = ? WHERE id = ?`, [enabled ? 1 : 0, studentId]);

        await logAudit(req, 'QR_STATUS_TOGGLE', `Set QR enabled status to ${enabled ? 1 : 0} for student ID: ${studentId}`);

        res.json({ success: true, message: `Student QR Code ${enabled ? 'enabled' : 'disabled'} successfully.` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update QR state.' });
    }
});

// Delete Student Profile (Admin Only)
app.delete('/api/students/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const studentId = req.params.id;
        const stCheck = await db.query(`SELECT * FROM students WHERE id = ?`, [studentId]);

        if (stCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        const student = stCheck.rows[0];

        // Delete uploaded photo
        if (student.photo_path && fs.existsSync(path.join(__dirname, 'public', student.photo_path))) {
            try { fs.unlinkSync(path.join(__dirname, 'public', student.photo_path)); } catch(e){}
        }

        // Remove user account association
        await db.query(`DELETE FROM users WHERE student_id = ?`, [studentId]);
        // Remove student
        await db.query(`DELETE FROM students WHERE id = ?`, [studentId]);

        await logAudit(req, 'STUDENT_DELETE', `Deleted student ${student.student_number} (${student.first_name} ${student.last_name})`);

        res.json({ success: true, message: 'Student and related access credentials permanently removed.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete student record.' });
    }
});

// Dynamic QR Code Rendering Image Generator Utility
app.get('/api/qr/render/:token', async (req, res) => {
    try {
        const token = req.params.token;
        if (!token) return res.status(400).send('Invalid token');

        // Generate High Resolution Data URL
        const qrImageData = await QRCode.toDataURL(token, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 400,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        const base64Data = qrImageData.replace(/^data:image\/png;base64,/, "");
        const imgBuffer = Buffer.from(base64Data, 'base64');

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': imgBuffer.length
        });
        res.end(imgBuffer);
    } catch (err) {
        res.status(500).send('QR Generation Error');
    }
});

// ==========================================
// 5. CUSTOM POSITIONS MANAGEMENT
// ==========================================

app.get('/api/positions', requireAuth, async (req, res) => {
    try {
        const result = await db.query(`SELECT * FROM positions ORDER BY title ASC`);
        res.json({ success: true, positions: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to retrieve positions.' });
    }
});

app.post('/api/positions', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { title, description } = req.body;
        if (!title) {
            return res.status(400).json({ success: false, message: 'Position title is required.' });
        }

        const check = await db.query(`SELECT id FROM positions WHERE title = ?`, [title.trim()]);
        if (check.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Position title already exists.' });
        }

        await db.query(
            `INSERT INTO positions (title, description, is_active, created_at) VALUES (?, ?, 1, ?)`,
            [title.trim(), description ? description.trim() : '', formatISOString()]
        );

        await logAudit(req, 'POSITION_CREATE', `Created custom position: ${title}`);

        res.json({ success: true, message: 'Position created successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to create position.' });
    }
});

app.put('/api/positions/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { title, description, is_active } = req.body;
        const posId = req.params.id;

        await db.query(
            `UPDATE positions SET title = ?, description = ?, is_active = ? WHERE id = ?`,
            [title.trim(), description || '', is_active ? 1 : 0, posId]
        );

        await logAudit(req, 'POSITION_UPDATE', `Updated position ID: ${posId} (${title})`);

        res.json({ success: true, message: 'Position updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update position.' });
    }
});

app.delete('/api/positions/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const posId = req.params.id;

        // Verify if students are attached
        const attached = await db.query(`SELECT id FROM students WHERE position_id = ?`, [posId]);
        if (attached.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `Cannot delete position. It is currently assigned to ${attached.rows.length} student(s). Reassign them first.` 
            });
        }

        await db.query(`DELETE FROM positions WHERE id = ?`, [posId]);
        await logAudit(req, 'POSITION_DELETE', `Deleted position ID: ${posId}`);

        res.json({ success: true, message: 'Position deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete position.' });
    }
});

// ==========================================
// 6. EVENT MANAGEMENT SYSTEM APIs
// ==========================================

// Get All Events
app.get('/api/events', requireAuth, async (req, res) => {
    try {
        const { status, type } = req.query;
        let sql = `SELECT * FROM events WHERE 1=1`;
        const params = [];

        if (status) {
            sql += ` AND status = ?`;
            params.push(status);
        }

        if (type) {
            sql += ` AND event_type = ?`;
            params.push(type);
        }

        sql += ` ORDER BY event_date DESC, start_time DESC`;

        const result = await db.query(sql, params);
        res.json({ success: true, events: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch events.' });
    }
});

// Create Event
app.post('/api/events', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { name, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, target_audience, specific_positions } = req.body;

        if (!name || !event_type || !event_date || !start_time || !end_time) {
            return res.status(400).json({ success: false, message: 'Event Name, Type, Date, Start Time, and End Time are required.' });
        }

        const insertRes = await db.query(
            `INSERT INTO events 
            (name, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, status, target_audience, specific_positions, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPCOMING', ?, ?, ?)`,
            [
                name.trim(),
                description ? description.trim() : '',
                event_type,
                event_date,
                start_time,
                end_time,
                late_threshold_minutes || 15,
                location ? location.trim() : 'Club Center',
                organizer ? organizer.trim() : 'Club Officers',
                target_audience || 'ALL',
                specific_positions ? JSON.stringify(specific_positions) : null,
                formatISOString()
            ]
        );

        await logAudit(req, 'EVENT_CREATE', `Created event: ${name} (${event_date})`);

        res.json({ success: true, message: 'Event created successfully.', event_id: insertRes.insertId });
    } catch (err) {
        console.error('[EVENT CREATE ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to create event.' });
    }
});

// Update Event & Status Transitions
app.put('/api/events/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const eventId = req.params.id;
        const { name, description, event_type, event_date, start_time, end_time, late_threshold_minutes, location, organizer, status, target_audience, specific_positions } = req.body;

        const currentRes = await db.query(`SELECT * FROM events WHERE id = ?`, [eventId]);
        if (currentRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Event not found.' });
        }

        const oldStatus = currentRes.rows[0].status;

        await db.query(
            `UPDATE events 
             SET name = ?, description = ?, event_type = ?, event_date = ?, start_time = ?, end_time = ?, 
                 late_threshold_minutes = ?, location = ?, organizer = ?, status = ?, target_audience = ?, specific_positions = ? 
             WHERE id = ?`,
            [
                name, description, event_type, event_date, start_time, end_time,
                late_threshold_minutes, location, organizer, status, target_audience,
                specific_positions ? JSON.stringify(specific_positions) : null,
                eventId
            ]
        );

        // Automatic Absent Detection Trigger when event status transitions to COMPLETED
        if (status === 'COMPLETED' && oldStatus !== 'COMPLETED') {
            await triggerAutomaticAbsentMarking(eventId);
        }

        await logAudit(req, 'EVENT_UPDATE', `Updated event ID: ${eventId} (${name}), Status set to: ${status}`);

        res.json({ success: true, message: 'Event details updated.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update event details.' });
    }
});

// Automatic Absent Marker Function
async function triggerAutomaticAbsentMarking(eventId) {
    try {
        const eventRes = await db.query(`SELECT * FROM events WHERE id = ?`, [eventId]);
        if (eventRes.rows.length === 0) return;
        const event = eventRes.rows[0];

        // Fetch target eligible active students
        let studentQuery = `SELECT id FROM students WHERE status = 'ACTIVE'`;
        const params = [];

        if (event.target_audience === 'OFFICERS_ONLY') {
            studentQuery += ` AND position_id IN (SELECT id FROM positions WHERE title LIKE '%President%' OR title LIKE '%Officer%' OR title LIKE '%Secretary%' OR title LIKE '%Treasurer%' OR title LIKE '%Auditor%')`;
        } else if (event.target_audience === 'SPECIFIC' && event.specific_positions) {
            try {
                const posIds = JSON.parse(event.specific_positions);
                if (Array.isArray(posIds) && posIds.length > 0) {
                    const placeholders = posIds.map(() => '?').join(',');
                    studentQuery += ` AND position_id IN (${placeholders})`;
                    params.push(...posIds);
                }
            } catch(e){}
        }

        const eligibleStudents = await db.query(studentQuery, params);

        for (const student of eligibleStudents.rows) {
            // Check if record exists
            const attCheck = await db.query(`SELECT id FROM attendance WHERE event_id = ? AND student_id = ?`, [eventId, student.id]);
            if (attCheck.rows.length === 0) {
                // Record as ABSENT automatically
                await db.query(
                    `INSERT INTO attendance (event_id, student_id, status, created_at) VALUES (?, ?, 'ABSENT', ?)`,
                    [eventId, student.id, formatISOString()]
                );
            }
        }
        console.log(`[AUTOMATIC ABSENT DETECTOR] Event ID ${eventId} completed. Absent records registered.`);
    } catch (err) {
        console.error('[AUTOMATIC ABSENT DETECTOR ERROR]', err);
    }
}

// Delete Event
app.delete('/api/events/:id', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const eventId = req.params.id;
        await db.query(`DELETE FROM events WHERE id = ?`, [eventId]);
        await logAudit(req, 'EVENT_DELETE', `Deleted event ID: ${eventId}`);
        res.json({ success: true, message: 'Event deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete event.' });
    }
});

// ==========================================
// 7. REAL-TIME QR SCANNER PROCESSING ENGINE
// ==========================================

// Core Attendance Scan Processing Endpoint
app.post('/api/scanner/scan', requireAuth, requireRole(['ADMIN', 'SCANNER']), async (req, res) => {
    try {
        const { qr_token, event_id, scan_mode } = req.body; // scan_mode: 'TIME_IN' or 'TIME_OUT'

        if (!qr_token || !event_id) {
            return res.status(400).json({ 
                success: false, 
                code: 'INVALID_REQUEST', 
                message: 'QR Token and Selected Event are required.' 
            });
        }

        // 1. Validate Active Event
        const eventRes = await db.query(`SELECT * FROM events WHERE id = ?`, [event_id]);
        if (eventRes.rows.length === 0) {
            return res.status(404).json({ success: false, code: 'EVENT_NOT_FOUND', message: 'Selected event does not exist.' });
        }
        const event = eventRes.rows[0];

        if (event.status === 'CANCELLED') {
            return res.status(400).json({ success: false, code: 'EVENT_CANCELLED', message: 'Selected event has been cancelled.' });
        }

        // 2. Validate Student & Token
        const studentRes = await db.query(
            `SELECT s.*, p.title as position_name 
             FROM students s 
             LEFT JOIN positions p ON s.position_id = p.id 
             WHERE s.qr_token = ?`,
            [qr_token.trim()]
        );

        if (studentRes.rows.length === 0) {
            return res.status(404).json({ 
                success: false, 
                code: 'INVALID_QR', 
                message: 'INVALID QR CODE. Unrecognized token.' 
            });
        }

        const student = studentRes.rows[0];

        if (student.qr_enabled !== 1) {
            return res.status(403).json({ 
                success: false, 
                code: 'QR_DISABLED', 
                message: 'QR Code is disabled for this student. Contact Adviser.',
                student_name: `${student.first_name} ${student.last_name}`
            });
        }

        if (student.status !== 'ACTIVE') {
            return res.status(403).json({ 
                success: false, 
                code: 'STUDENT_INACTIVE', 
                message: `Student membership is currently ${student.status}.`,
                student_name: `${student.first_name} ${student.last_name}`
            });
        }

        // 3. Check Existing Attendance
        const attRes = await db.query(
            `SELECT * FROM attendance WHERE event_id = ? AND student_id = ?`,
            [event_id, student.id]
        );

        const currentTimeStr = formatISOString();
        const timeOnly = currentTimeStr.split(' ')[1]; // HH:MM:SS

        const isTimeOutMode = scan_mode === 'TIME_OUT';

        if (attRes.rows.length > 0) {
            const existingAttendance = attRes.rows[0];

            if (isTimeOutMode) {
                // Process TIME OUT
                if (existingAttendance.time_out) {
                    return res.status(400).json({
                        success: false,
                        code: 'DUPLICATE_TIMEOUT',
                        message: `${student.first_name} ${student.last_name}, Time Out was already recorded.`,
                        student: student
                    });
                }

                await db.query(
                    `UPDATE attendance SET time_out = ? WHERE id = ?`,
                    [timeOnly, existingAttendance.id]
                );

                await logAudit(req, 'SCAN_TIMEOUT', `Time Out recorded for ${student.student_number} at Event ${event.name}`);

                return res.json({
                    success: true,
                    scan_type: 'TIME_OUT',
                    message: `${student.first_name} ${student.last_name}, time out recorded.`,
                    student: student,
                    attendance: {
                        time_in: existingAttendance.time_in,
                        time_out: timeOnly,
                        status: existingAttendance.status
                    }
                });
            } else {
                // Duplicate TIME IN Check
                return res.status(400).json({
                    success: false,
                    code: 'DUPLICATE_SCAN',
                    message: `${student.first_name} ${student.last_name}, you are already recorded.`,
                    student: student,
                    attendance: existingAttendance
                });
            }
        }

        // If trying to scan Time Out without Time In record
        if (isTimeOutMode) {
            return res.status(400).json({
                success: false,
                code: 'NO_TIME_IN',
                message: `Cannot record Time Out. No prior Time In record found for ${student.first_name} ${student.last_name}.`,
                student: student
            });
        }

        // 4. Calculate Automatic Attendance Status (PRESENT or LATE)
        let attendanceStatus = 'PRESENT';
        
        // Combine event date and start time to compute late status
        const eventStartDateTime = new Date(`${event.event_date}T${event.start_time}`);
        const currentDateTime = getPhTimezoneDate();
        
        // Late threshold buffer in minutes
        const thresholdMs = (event.late_threshold_minutes || 15) * 60 * 1000;
        const lateCutoff = new Date(eventStartDateTime.getTime() + thresholdMs);

        if (currentDateTime > lateCutoff) {
            attendanceStatus = 'LATE';
        }

        // 5. Insert Attendance Log
        await db.query(
            `INSERT INTO attendance 
            (event_id, student_id, time_in, status, recorded_by, created_at) 
            VALUES (?, ?, ?, ?, ?, ?)`,
            [event_id, student.id, timeOnly, attendanceStatus, req.session.user.id, currentTimeStr]
        );

        await logAudit(req, 'SCAN_TIMEIN', `Time In (${attendanceStatus}) recorded for ${student.student_number} (${student.first_name} ${student.last_name}) at Event ${event.name}`);

        return res.json({
            success: true,
            scan_type: 'TIME_IN',
            message: `${student.first_name} ${student.last_name}, attendance recorded.`,
            student: student,
            attendance: {
                time_in: timeOnly,
                time_out: null,
                status: attendanceStatus
            }
        });

    } catch (err) {
        console.error('[SCANNER API ERROR]', err);
        res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Internal processing error during scan.' });
    }
});

// Mark Student Excused Absence (Admin Only)
app.post('/api/attendance/excuse', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { event_id, student_id, reason } = req.body;

        if (!event_id || !student_id) {
            return res.status(400).json({ success: false, message: 'Event and Student ID are required.' });
        }

        const existing = await db.query(`SELECT id FROM attendance WHERE event_id = ? AND student_id = ?`, [event_id, student_id]);

        if (existing.rows.length > 0) {
            await db.query(
                `UPDATE attendance SET status = 'EXCUSED', excused_reason = ?, excused_by = ? WHERE id = ?`,
                [reason || 'Approved Excuse', req.session.user.id, existing.rows[0].id]
            );
        } else {
            await db.query(
                `INSERT INTO attendance (event_id, student_id, status, excused_reason, excused_by, created_at) 
                 VALUES (?, ?, 'EXCUSED', ?, ?, ?)`,
                [event_id, student_id, reason || 'Approved Excuse', req.session.user.id, formatISOString()]
            );
        }

        await logAudit(req, 'ATTENDANCE_EXCUSED', `Marked student ID ${student_id} as EXCUSED for Event ID ${event_id}`);

        res.json({ success: true, message: 'Student attendance marked as EXCUSED.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update excuse status.' });
    }
});

// ==========================================
// 8. ACCURATE DATABASE DASHBOARD & ANALYTICS
// ==========================================

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
        const { date_filter, event_id, position_id } = req.query;

        // 1. Total Student Counts
        const totalStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status != 'PENDING'`);
        const activeStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status = 'ACTIVE'`);
        const inactiveStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status = 'INACTIVE'`);
        const pendingStudentsRes = await db.query(`SELECT COUNT(*) as count FROM students WHERE status = 'PENDING'`);

        // Filter Logic construction
        let attendanceWhere = ` WHERE 1=1`;
        const attParams = [];

        if (event_id && event_id !== 'ALL') {
            attendanceWhere += ` AND a.event_id = ?`;
            attParams.push(event_id);
        }

        if (position_id && position_id !== 'ALL') {
            attendanceWhere += ` AND s.position_id = ?`;
            attParams.push(position_id);
        }

        if (date_filter === 'TODAY') {
            const todayStr = formatISOString().split(' ')[0];
            attendanceWhere += ` AND a.created_at LIKE ?`;
            attParams.push(`${todayStr}%`);
        }

        // Aggregate Attendance Breakdown from real database rows
        const presentQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'PRESENT'
        `;
        const presentRes = await db.query(presentQuery, attParams);

        const lateQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'LATE'
        `;
        const lateRes = await db.query(lateQuery, attParams);

        const absentQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'ABSENT'
        `;
        const absentRes = await db.query(absentQuery, attParams);

        const excusedQuery = `
            SELECT COUNT(DISTINCT a.student_id) as count 
            FROM attendance a 
            JOIN students s ON a.student_id = s.id 
            ${attendanceWhere} AND a.status = 'EXCUSED'
        `;
        const excusedRes = await db.query(excusedQuery, attParams);

        const presentCount = parseInt(presentRes.rows[0]?.count || 0, 10);
        const lateCount = parseInt(lateRes.rows[0]?.count || 0, 10);
        const absentCount = parseInt(absentRes.rows[0]?.count || 0, 10);
        const excusedCount = parseInt(excusedRes.rows[0]?.count || 0, 10);

        const totalExpected = presentCount + lateCount + absentCount + excusedCount;
        const validAttendees = presentCount + lateCount;
        
        const attendanceRate = totalExpected > 0 ? ((validAttendees / totalExpected) * 100).toFixed(1) : "0.0";

        // Active / Upcoming Events
        const activeEventsRes = await db.query(`SELECT COUNT(*) as count FROM events WHERE status = 'ACTIVE'`);
        const upcomingEventsRes = await db.query(`SELECT COUNT(*) as count FROM events WHERE status = 'UPCOMING'`);

        // Recent Scan Feed
        const recentScansRes = await db.query(
            `SELECT a.*, s.first_name, s.last_name, s.student_number, s.photo_path, p.title as position_name, e.name as event_name 
             FROM attendance a 
             JOIN students s ON a.student_id = s.id 
             JOIN positions p ON s.position_id = p.id 
             JOIN events e ON a.event_id = e.id 
             ORDER BY a.created_at DESC LIMIT 10`
        );

        res.json({
            success: true,
            stats: {
                total_students: parseInt(totalStudentsRes.rows[0]?.count || 0, 10),
                active_students: parseInt(activeStudentsRes.rows[0]?.count || 0, 10),
                inactive_students: parseInt(inactiveStudentsRes.rows[0]?.count || 0, 10),
                pending_registrations: parseInt(pendingStudentsRes.rows[0]?.count || 0, 10),
                present_count: presentCount,
                late_count: lateCount,
                absent_count: absentCount,
                excused_count: excusedCount,
                attendance_rate: attendanceRate,
                active_events: parseInt(activeEventsRes.rows[0]?.count || 0, 10),
                upcoming_events: parseInt(upcomingEventsRes.rows[0]?.count || 0, 10)
            },
            recent_scans: recentScansRes.rows
        });

    } catch (err) {
        console.error('[DASHBOARD STATS ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to compute dashboard statistics.' });
    }
});

// Analytics: Frequently Late & Most Active Rankings
app.get('/api/analytics/rankings', requireAuth, async (req, res) => {
    try {
        // Top 5 Frequently Late
        const lateRankings = await db.query(
            `SELECT s.id, s.student_number, s.first_name, s.last_name, p.title as position_name, COUNT(a.id) as late_count 
             FROM attendance a 
             JOIN students s ON a.student_id = s.id 
             JOIN positions p ON s.position_id = p.id 
             WHERE a.status = 'LATE' 
             GROUP BY s.id, s.student_number, s.first_name, s.last_name, p.title 
             ORDER BY late_count DESC LIMIT 5`
        );

        // Top 5 Most Active
        const activeRankings = await db.query(
            `SELECT s.id, s.student_number, s.first_name, s.last_name, p.title as position_name, COUNT(a.id) as attended_count 
             FROM attendance a 
             JOIN students s ON a.student_id = s.id 
             JOIN positions p ON s.position_id = p.id 
             WHERE a.status IN ('PRESENT', 'LATE') 
             GROUP BY s.id, s.student_number, s.first_name, s.last_name, p.title 
             ORDER BY attended_count DESC LIMIT 5`
        );

        res.json({
            success: true,
            frequently_late: lateRankings.rows,
            most_active: activeRankings.rows
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to compute analytics rankings.' });
    }
});

// ==========================================
// 9. SYSTEM SETTINGS, BACKUP, & AUDIT LOGS
// ==========================================

// Get Settings
app.get('/api/settings', requireAuth, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Could not fetch settings.' });
    }
});

// Update Settings & Upload School/Club Logos
app.post('/api/settings', requireAuth, requireRole(['ADMIN']), upload.fields([
    { name: 'school_logo', maxCount: 1 },
    { name: 'club_logo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { school_name, school_address, school_contact, school_email, school_year, club_name, club_adviser, organization_name, student_number_prefix, min_participation_threshold } = req.body;

        const updates = [
            ['school_name', school_name],
            ['school_address', school_address],
            ['school_contact', school_contact],
            ['school_email', school_email],
            ['school_year', school_year],
            ['club_name', club_name],
            ['club_adviser', club_adviser],
            ['organization_name', organization_name],
            ['student_number_prefix', student_number_prefix],
            ['min_participation_threshold', min_participation_threshold]
        ];

        if (req.files?.school_logo) {
            updates.push(['school_logo', `/uploads/logos/${req.files.school_logo[0].filename}`]);
        }

        if (req.files?.club_logo) {
            updates.push(['club_logo', `/uploads/logos/${req.files.club_logo[0].filename}`]);
        }

        for (const [key, val] of updates) {
            if (val !== undefined) {
                await db.query(`UPDATE settings SET setting_value = ? WHERE setting_key = ?`, [val, key]);
            }
        }

        await logAudit(req, 'SETTINGS_UPDATE', 'Updated system configurations and organizational logos.');

        res.json({ success: true, message: 'System configurations updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to save settings.' });
    }
});

// Database Health Indicator Check
app.get('/api/system/health', requireAuth, async (req, res) => {
    try {
        await db.query(`SELECT 1`);
        res.json({
            success: true,
            database: {
                connected: true,
                type: db.isPg ? 'PostgreSQL' : 'SQLite3',
                last_checked: formatISOString()
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            database: {
                connected: false,
                error: err.message
            }
        });
    }
});

// Trigger Manual Database Backup
app.post('/api/system/backup', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const timestamp = Date.now();
        const backupFileName = `backup-${timestamp}.json`;
        const backupPath = path.join(BACKUPS_DIR, backupFileName);

        // Fetch all tables
        const settings = await db.query(`SELECT * FROM settings`);
        const users = await db.query(`SELECT id, username, email, role, student_id, created_at FROM users`);
        const positions = await db.query(`SELECT * FROM positions`);
        const students = await db.query(`SELECT * FROM students`);
        const position_history = await db.query(`SELECT * FROM position_history`);
        const events = await db.query(`SELECT * FROM events`);
        const attendance = await db.query(`SELECT * FROM attendance`);
        const audit_logs = await db.query(`SELECT * FROM audit_logs`);

        const dumpData = {
            metadata: {
                timestamp: formatISOString(),
                version: '1.0.0'
            },
            data: {
                settings: settings.rows,
                users: users.rows,
                positions: positions.rows,
                students: students.rows,
                position_history: position_history.rows,
                events: events.rows,
                attendance: attendance.rows,
                audit_logs: audit_logs.rows
            }
        };

        fs.writeFileSync(backupPath, JSON.stringify(dumpData, null, 2));

        await logAudit(req, 'BACKUP_CREATE', `Created manual system backup: ${backupFileName}`);

        res.json({ success: true, message: 'System database backup created successfully.', filename: backupFileName });
    } catch (err) {
        console.error('[BACKUP ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to generate backup.' });
    }
});

// Audit Logs Endpoint
app.get('/api/system/audit-logs', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const logs = await db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100`);
        res.json({ success: true, logs: logs.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load audit logs.' });
    }
});
/**
 * SCHOOL STUDENT CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Part 4: Complete Client-Side JS Router, QR Scanner, Speech Engine & Printing Logic
 */

// Global State Management
let currentUser = null;
let currentClubSettings = null;
let html5QrcodeScanner = null;
let scannerAudioContext = null;

// ==========================================================================
// INITIALIZATION & SINGLE PAGE ROUTER
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuthStatus();
    await fetchClubSettings();
    
    // Initial Route based on URL hash or default
    const currentHash = window.location.hash.replace('#', '') || 'dashboard';
    navigate(currentHash);

    // Dynamic Navigation Hash Handler
    window.addEventListener('hashchange', () => {
        const hash = window.location.hash.replace('#', '');
        if (hash) renderView(hash);
    });
});

async function checkAuthStatus() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.success) {
            currentUser = data.user;
            updateUserProfileUI();
        } else {
            // Redirect to public registration or scanner if not logged in
            if (window.location.hash !== '#register') {
                window.location.hash = 'register';
            }
        }
    } catch (err) {
        console.error('Auth check error:', err);
    }
}

async function fetchClubSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.success && data.settings) {
            currentClubSettings = data.settings;
            document.getElementById('sb-club-name').innerText = data.settings.club_name || 'School Club';
            document.getElementById('sb-school-year').innerText = `S.Y. ${data.settings.school_year || ''}`;
            if (data.settings.club_logo_url) {
                document.getElementById('sb-club-logo').src = data.settings.club_logo_url;
            }
        }
    } catch (err) {
        console.error('Settings fetch error:', err);
    }
}

function updateUserProfileUI() {
    if (!currentUser) return;
    document.getElementById('topbar-username').innerText = currentUser.full_name || currentUser.username;
    document.getElementById('topbar-userrole').innerText = currentUser.role.toUpperCase();
    if (currentUser.profile_picture_url) {
        document.getElementById('topbar-user-photo').src = currentUser.profile_picture_url;
    }

    // Role-based UI visibility toggle
    const adminItems = document.querySelectorAll('.nav-item-admin');
    const studentItems = document.querySelectorAll('.nav-item-student');

    if (currentUser.role === 'student') {
        adminItems.forEach(el => el.classList.add('hidden'));
        studentItems.forEach(el => el.classList.remove('hidden'));
    } else {
        adminItems.forEach(el => el.classList.remove('hidden'));
        studentItems.forEach(el => el.classList.add('hidden'));
    }
}

function navigate(viewName) {
    window.location.hash = viewName;
    renderView(viewName);
}

function renderView(viewName) {
    // Stop scanner if leaving scanner view
    if (html5QrcodeScanner && viewName !== 'scanner') {
        stopScanner();
    }

    // Update Sidebar Navigation Active State
    document.querySelectorAll('.sidebar-menu a').forEach(a => a.classList.remove('active'));
    const activeNav = document.getElementById(`nav-${viewName}`);
    if (activeNav) activeNav.classList.add('active');

    const container = document.getElementById('view-container');
    const title = document.getElementById('page-heading-title');

    switch (viewName) {
        case 'dashboard':
            title.innerText = 'Dashboard Overview';
            renderDashboardView(container);
            break;
        case 'students':
            title.innerText = 'Student Records Management';
            renderStudentsView(container);
            break;
        case 'registrations':
            title.innerText = 'Pending Registration Approvals';
            renderRegistrationsView(container);
            break;
        case 'positions':
            title.innerText = 'Officer & Executive Positions';
            renderPositionsView(container);
            break;
        case 'events':
            title.innerText = 'Club Activities & Events';
            renderEventsView(container);
            break;
        case 'scanner':
            title.innerText = 'QR Code Terminal';
            renderScannerView(container);
            break;
        case 'reports':
            title.innerText = 'Attendance Reports & Analytics';
            renderReportsView(container);
            break;
        case 'settings':
            title.innerText = 'Club Configuration & Database Backup';
            renderSettingsView(container);
            break;
        case 'student-portal':
            title.innerText = 'My Digital Club ID & Attendance';
            renderStudentPortalView(container);
            break;
        case 'register':
            title.innerText = 'Public Student Club Registration';
            renderPublicRegisterView(container);
            break;
        default:
            container.innerHTML = '<h2>404 - View Not Found</h2>';
    }
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.reload();
}

// ==========================================================================
// VIEW 1: DASHBOARD OVERVIEW
// ==========================================================================
async function renderDashboardView(container) {
    container.innerHTML = '<p>Loading metrics...</p>';
    try {
        const res = await fetch('/api/dashboard/stats');
        const data = await res.json();
        
        if (!data.success) throw new Error(data.message);
        const { stats, recentLogs, upcomingEvents } = data;

        container.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon blue"><i class="fa-solid fa-users"></i></div>
                    <div class="stat-details">
                        <h3>${stats.totalStudents}</h3>
                        <p>Total Registered Students</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon yellow"><i class="fa-solid fa-clock-rotate-left"></i></div>
                    <div class="stat-details">
                        <h3>${stats.pendingApprovals}</h3>
                        <p>Pending Approvals</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon green"><i class="fa-solid fa-calendar-check"></i></div>
                    <div class="stat-details">
                        <h3>${stats.activeEvents}</h3>
                        <p>Active Events Today</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon purple"><i class="fa-solid fa-clipboard-user"></i></div>
                    <div class="stat-details">
                        <h3>${stats.todayAttendance}</h3>
                        <p>Scans Recorded Today</p>
                    </div>
                </div>
            </div>

            <div class="grid" style="grid-template-columns: 2fr 1fr; gap: 20px;">
                <div class="card">
                    <div class="card-header">
                        <span class="card-title"><i class="fa-solid fa-list-check"></i> Recent Attendance Activity</span>
                        <button class="btn btn-secondary btn-sm" onclick="navigate('reports')">View All</button>
                    </div>
                    <div class="table-responsive">
                        <table class="table">
                            <thead>
                                <tr>
                                    <th>Student</th>
                                    <th>Event</th>
                                    <th>Type</th>
                                    <th>Time</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${recentLogs.map(log => `
                                    <tr>
                                        <td><strong>${log.first_name} ${log.last_name}</strong><br><small class="text-muted">${log.student_number}</small></td>
                                        <td>${log.event_title}</td>
                                        <td><span class="badge ${log.scan_type === 'TIME_IN' ? 'badge-info' : 'badge-warning'}">${log.scan_type}</span></td>
                                        <td>${new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                                        <td><span class="badge ${log.status === 'ON_TIME' ? 'badge-success' : 'badge-danger'}">${log.status}</span></td>
                                    </tr>
                                `).join('') || '<tr><td colspan="5" style="text-align:center;">No recent attendance recorded today.</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="card">
                    <div class="card-header">
                        <span class="card-title"><i class="fa-solid fa-calendar-day"></i> Upcoming Events</span>
                        <button class="btn btn-primary btn-sm" onclick="navigate('events')"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        ${upcomingEvents.map(e => `
                            <div style="padding: 10px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: #f8fafc;">
                                <strong>${e.title}</strong>
                                <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
                                    <i class="fa-solid fa-clock"></i> ${new Date(e.event_date).toLocaleDateString()} | ${e.start_time} - ${e.end_time}
                                </div>
                            </div>
                        `).join('') || '<p style="font-size:13px; color:var(--text-muted);">No upcoming events scheduled.</p>'}
                    </div>
                </div>
            </div>
        `;
    } catch (err) {
        container.innerHTML = `<div class="card" style="color:var(--danger-color);">Failed to load dashboard data: ${err.message}</div>`;
    }
}

// ==========================================================================
// VIEW 2: QR CODE SCANNER TERMINAL & AUDIO FEEDBACK
// ==========================================================================
function renderScannerView(container) {
    container.innerHTML = `
        <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 20px;">
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><i class="fa-solid fa-qrcode"></i> Live Optical QR Terminal</span>
                </div>
                
                <div class="form-group">
                    <label>Select Target Event for Attendance</label>
                    <select id="scanner-event-select" class="form-control" onchange="handleScannerEventChange()">
                        <option value="">-- Loading Active Events --</option>
                    </select>
                </div>

                <div class="scanner-viewport-box" id="reader"></div>

                <div style="margin-top: 15px; display: flex; gap: 10px; justify-content: center;">
                    <button id="btn-start-scanner" class="btn btn-primary" onclick="startScanner()"><i class="fa-solid fa-camera"></i> Start Camera Scanner</button>
                    <button id="btn-stop-scanner" class="btn btn-danger hidden" onclick="stopScanner()"><i class="fa-solid fa-video-slash"></i> Stop Camera</button>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <span class="card-title"><i class="fa-solid fa-square-poll-vertical"></i> Scan Verification Feed</span>
                    <span id="scan-mode-indicator" class="badge badge-info">TIME_IN MODE</span>
                </div>

                <div id="scan-result-container" style="min-height: 250px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; border: 2px dashed var(--border-color); border-radius: var(--radius-lg); padding: 20px;">
                    <i class="fa-solid fa-qrcode" style="font-size: 48px; color: var(--text-muted); margin-bottom: 10px;"></i>
                    <p style="color: var(--text-muted); font-size: 14px;">Scan a student QR Code ID card to record real-time attendance.</p>
                </div>

                <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--border-color);">
                    <div class="form-group">
                        <label>Manual Student Number Input Fallback</label>
                        <div class="flex gap-2">
                            <input type="text" id="manual-student-no" class="form-control" placeholder="e.g., 2026-10042">
                            <button class="btn btn-secondary" onclick="processManualScan()"><i class="fa-solid fa-keyboard"></i> Submit</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    loadActiveEventsForScanner();
}

async function loadActiveEventsForScanner() {
    const select = document.getElementById('scanner-event-select');
    try {
        const res = await fetch('/api/events');
        const data = await res.json();
        if (data.success) {
            select.innerHTML = data.events.map(e => `
                <option value="${e.id}">${e.title} (${new Date(e.event_date).toLocaleDateString()})</option>
            `).join('');
        }
    } catch (err) {
        select.innerHTML = '<option value="">Error loading events</option>';
    }
}

function startScanner() {
    const eventId = document.getElementById('scanner-event-select').value;
    if (!eventId) {
        alert('Please select an active event before starting the scanner terminal.');
        return;
    }

    html5QrcodeScanner = new Html5Qrcode("reader");
    const config = { fps: 10, qrbox: { width: 220, height: 220 } };

    html5QrcodeScanner.start(
        { facingMode: "environment" },
        config,
        onScanSuccess
    ).then(() => {
        document.getElementById('btn-start-scanner').classList.add('hidden');
        document.getElementById('btn-stop-scanner').classList.remove('hidden');
    }).catch(err => {
        alert('Camera access failed: ' + err);
    });
}

function stopScanner() {
    if (html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => {
            html5QrcodeScanner.clear();
            document.getElementById('btn-start-scanner').classList.remove('hidden');
            document.getElementById('btn-stop-scanner').classList.add('hidden');
        }).catch(err => console.error(err));
    }
}

async function onScanSuccess(decodedText) {
    // Temporarily pause scanner to prevent duplicate multi-scans
    if (html5QrcodeScanner) {
        html5QrcodeScanner.pause();
    }

    await executeAttendanceRecord(decodedText);

    // Resume scanning after 2 seconds
    setTimeout(() => {
        if (html5QrcodeScanner) {
            try { html5QrcodeScanner.resume(); } catch(e){}
        }
    }, 2000);
}

async function processManualScan() {
    const input = document.getElementById('manual-student-no').value.trim();
    if (!input) return;
    await executeAttendanceRecord(input);
    document.getElementById('manual-student-no').value = '';
}

async function executeAttendanceRecord(qrPayload) {
    const eventId = document.getElementById('scanner-event-select').value;
    const resultBox = document.getElementById('scan-result-container');

    try {
        const res = await fetch('/api/attendance/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_payload: qrPayload, event_id: eventId })
        });

        const data = await res.json();

        if (data.success) {
            playAudioBeep(true);
            speakText(`Welcome, ${data.student.first_name}`);

            resultBox.innerHTML = `
                <div class="scan-result-card w-full" style="padding: 15px; background: #f0fdf4; border-radius: var(--radius-md);">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <img src="${data.student.profile_picture_url || 'https://ui-avatars.com/api/?name=' + data.student.first_name}" style="width: 70px; height: 70px; border-radius: 50%; object-fit: cover;">
                        <div style="text-align: left;">
                            <h3 style="color: var(--success-color); margin-bottom: 2px;">${data.scan_type} SUCCESSFUL</h3>
                            <h2 style="font-size: 18px; color: var(--text-main);">${data.student.first_name} ${data.student.last_name}</h2>
                            <p style="font-size: 13px; color: var(--text-muted);">${data.student.student_number} | ${data.student.grade_level} - ${data.student.section}</p>
                            <div style="margin-top: 6px;">
                                <span class="badge badge-success">${data.status}</span>
                                <span class="badge badge-info">${data.student.position_name}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            playAudioBeep(false);
            speakText('Scan Warning');

            resultBox.innerHTML = `
                <div class="scan-result-card w-full" style="padding: 15px; background: #fef2f2; border-left-color: var(--danger-color); border-radius: var(--radius-md);">
                    <h3 style="color: var(--danger-color); margin-bottom: 5px;"><i class="fa-solid fa-circle-exclamation"></i> ${data.message}</h3>
                    <p style="font-size: 13px; color: var(--text-muted);">Timestamp: ${new Date().toLocaleTimeString()}</p>
                </div>
            `;
        }
    } catch (err) {
        playAudioBeep(false);
        resultBox.innerHTML = `<p style="color: var(--danger-color);">Terminal Network Error: ${err.message}</p>`;
    }
}

// Synthesize Text-To-Speech Confirmation
function speakText(text) {
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        window.speechSynthesis.speak(utterance);
    }
}

// Generate Native Web Audio Oscillator Synthesized Beep
function playAudioBeep(isSuccess) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        if (isSuccess) {
            osc.frequency.setValueAtTime(880, ctx.currentTime); // Pitch A5
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.15);
        } else {
            osc.frequency.setValueAtTime(300, ctx.currentTime); // Pitch E4 low warning
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
        }
    } catch(e) {}
}

// ==========================================================================
// VIEW 3: STUDENT RECORDS MANAGEMENT & A4 BATCH ID PRINTING
// ==========================================================================
async function renderStudentsView(container) {
    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <span class="card-title"><i class="fa-solid fa-user-graduate"></i> Enrolled Student Directory</span>
                <div class="flex gap-2">
                    <button class="btn btn-success btn-sm" onclick="printSelectedBatchIDs()"><i class="fa-solid fa-print"></i> Print Selected A4 IDs</button>
                    <button class="btn btn-primary btn-sm" onclick="openAddStudentModal()"><i class="fa-solid fa-user-plus"></i> Add Student</button>
                </div>
            </div>

            <div class="flex gap-4" style="margin-bottom: 15px;">
                <input type="text" id="search-students" class="form-control" placeholder="Search by name, student #, or section..." onkeyup="filterStudentsTable()">
            </div>

            <div class="table-responsive">
                <table class="table" id="students-table">
                    <thead>
                        <tr>
                            <th><input type="checkbox" id="select-all-students" onclick="toggleSelectAllStudents(this)"></th>
                            <th>Photo</th>
                            <th>Student #</th>
                            <th>Full Name</th>
                            <th>Grade & Section</th>
                            <th>Position</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="students-table-body">
                        <tr><td colspan="8" style="text-align:center;">Loading student records...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;

    loadStudentsTableData();
}

async function loadStudentsTableData() {
    const tbody = document.getElementById('students-table-body');
    try {
        const res = await fetch('/api/students');
        const data = await res.json();

        if (data.success) {
            tbody.innerHTML = data.students.map(s => `
                <tr>
                    <td><input type="checkbox" class="student-checkbox" value="${s.id}"></td>
                    <td><img src="${s.profile_picture_url || 'https://ui-avatars.com/api/?name=' + s.first_name}" class="avatar-thumb"></td>
                    <td><strong>${s.student_number}</strong></td>
                    <td>${s.last_name}, ${s.first_name} ${s.middle_name || ''}</td>
                    <td>Grade ${s.grade_level} - ${s.section}</td>
                    <td><span class="badge badge-info">${s.position_name}</span></td>
                    <td><span class="badge ${s.status === 'APPROVED' ? 'badge-success' : 'badge-warning'}">${s.status}</span></td>
                    <td>
                        <button class="btn btn-secondary btn-sm" onclick="previewSingleIDCard(${s.id})" title="Print Single ID"><i class="fa-solid fa-id-card"></i></button>
                    </td>
                </tr>
            `).join('');
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" style="color:var(--danger-color);">Failed to load students: ${err.message}</td></tr>`;
    }
}

function toggleSelectAllStudents(master) {
    document.querySelectorAll('.student-checkbox').forEach(cb => cb.checked = master.checked);
}

// A4 Grid ID Card Batch Printing Logic (Max 8 Cards Grid System)
async function printSelectedBatchIDs() {
    const checkedBoxes = document.querySelectorAll('.student-checkbox:checked');
    const selectedIds = Array.from(checkedBoxes).map(cb => cb.value);

    if (selectedIds.length === 0) {
        alert('Please select at least one student card to generate a print layout.');
        return;
    }

    try {
        const res = await fetch('/api/students/batch-ids', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ student_ids: selectedIds })
        });
        const data = await res.json();

        if (data.success) {
            const printContainer = document.getElementById('print-section');
            printContainer.classList.remove('hidden');

            let html = '<div class="a4-print-grid">';
            data.cards.forEach(card => {
                html += `
                    <div class="id-card">
                        <div class="id-card-header">
                            <img src="${card.club_logo_url || '/uploads/logos/default_club_logo.png'}" alt="Logo">
                            <div class="titles">
                                <h4>${card.school_name}</h4>
                                <p>${card.club_name} Membership ID</p>
                            </div>
                        </div>
                        <div class="id-card-body">
                            <img src="${card.profile_picture_url || 'https://ui-avatars.com/api/?name=' + card.first_name}" class="id-photo">
                            <div class="id-details">
                                <div class="student-name">${card.first_name} ${card.last_name}</div>
                                <div class="student-num">${card.student_number}</div>
                                <div class="position-badge">${card.position_name}</div>
                            </div>
                            <div class="id-qr-zone">
                                <img src="${card.qr_code_base64}" alt="QR">
                            </div>
                        </div>
                        <div class="id-card-footer">
                            Official School Club Identification Card • S.Y. ${card.school_year}
                        </div>
                    </div>
                `;
            });
            html += '</div>';

            printContainer.innerHTML = html;
            window.print();
            
            // Re-hide print section after print window closes
            setTimeout(() => printContainer.classList.add('hidden'), 1000);
        }
    } catch (err) {
        alert('Failed to generate printable IDs: ' + err.message);
    }
}

// ==========================================================================
// VIEW 4: PUBLIC REGISTRATION PORTAL
// ==========================================================================
function renderPublicRegisterView(container) {
    container.innerHTML = `
        <div class="standalone-container">
            <div class="card">
                <div class="card-header" style="justify-content: center; text-align: center; flex-direction: column;">
                    <h2 style="color: var(--primary-color);">Student Club Membership Registration</h2>
                    <p style="font-size: 13px; color: var(--text-muted);">Fill in your official details to register and generate your digital QR ID.</p>
                </div>
                
                <form id="public-reg-form" onsubmit="handlePublicRegistration(event)">
                    <div class="form-group">
                        <label>Student Identification Number *</label>
                        <input type="text" name="student_number" class="form-control" required placeholder="e.g., 2026-10492">
                    </div>

                    <div class="form-row">
                        <div class="form-group">
                            <label>First Name *</label>
                            <input type="text" name="first_name" class="form-control" required>
                        </div>
                        <div class="form-group">
                            <label>Last Name *</label>
                            <input type="text" name="last_name" class="form-control" required>
                        </div>
                    </div>

                    <div class="form-row">
                        <div class="form-group">
                            <label>Grade Level *</label>
                            <select name="grade_level" class="form-control" required>
                                <option value="7">Grade 7</option>
                                <option value="8">Grade 8</option>
                                <option value="9">Grade 9</option>
                                <option value="10">Grade 10</option>
                                <option value="11">Grade 11</option>
                                <option value="12">Grade 12</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Section *</label>
                            <input type="text" name="section" class="form-control" required placeholder="e.g., Einstein">
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Profile Picture Photograph *</label>
                        <input type="file" name="profile_picture" class="form-control" accept="image/*" required>
                    </div>

                    <div class="form-group">
                        <label>Account Password *</label>
                        <input type="password" name="password" class="form-control" required minlength="6">
                    </div>

                    <button type="submit" class="btn btn-primary w-full" style="padding: 12px;"><i class="fa-solid fa-paper-plane"></i> Submit Registration Application</button>
                </form>
            </div>
        </div>
    `;
}

async function handlePublicRegistration(e) {
    e.preventDefault();
    const formData = new FormData(e.target);

    try {
        const res = await fetch('/api/public/register', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            alert('Registration submitted successfully! Your application is pending adviser approval.');
            window.location.hash = 'register';
            e.target.reset();
        } else {
            alert('Registration failed: ' + data.message);
        }
    } catch (err) {
        alert('Error submitting registration: ' + err.message);
    }
}

// ==========================================================================
// VIEW 5: REPORTS & CSV EXPORT ENGINE
// ==========================================================================
function renderReportsView(container) {
    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <span class="card-title"><i class="fa-solid fa-file-invoice"></i> Export Attendance Reports</span>
            </div>
            
            <div class="form-row" style="align-items: flex-end;">
                <div class="form-group">
                    <label>Select Event</label>
                    <select id="report-event-id" class="form-control">
                        <option value="">All Events</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Export Format</label>
                    <button class="btn btn-success w-full" onclick="exportAttendanceCSV()"><i class="fa-solid fa-file-csv"></i> Export CSV Spreadsheet</button>
                </div>
            </div>
        </div>
    `;

    loadReportEventsDropdown();
}

async function loadReportEventsDropdown() {
    const select = document.getElementById('report-event-id');
    try {
        const res = await fetch('/api/events');
        const data = await res.json();
        if (data.success) {
            data.events.forEach(e => {
                const opt = document.createElement('option');
                opt.value = e.id;
                opt.innerText = e.title;
                select.appendChild(opt);
            });
        }
    } catch(e){}
}

function exportAttendanceCSV() {
    const eventId = document.getElementById('report-event-id').value;
    window.location.href = `/api/reports/attendance/csv?event_id=${eventId}`;
}
