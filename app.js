/**
 * SCHOOL CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM
 * Complete All-In-One Application (Node.js + Express + PostgreSQL + EJS)
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool Setup
// Automatically uses DATABASE_URL if provided (e.g. Render), otherwise falls back to local configuration
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'club_attendance',
        password: process.env.DB_PASSWORD || 'postgres',
        port: process.env.DB_PORT || 5432,
      }
);

// Middleware Configuration
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');

app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if utilizing HTTPS-only production enforcement
  })
);

// Database Initialization Routine
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        position VARCHAR(50) DEFAULT 'Member',
        club VARCHAR(100) DEFAULT 'General School Club',
        year_level VARCHAR(20),
        course VARCHAR(100),
        section VARCHAR(50),
        contact VARCHAR(30),
        email VARCHAR(100),
        photo TEXT,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        temporary_password_status BOOLEAN DEFAULT TRUE,
        qr_token VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        date_joined DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(50) NOT NULL,
        date VARCHAR(20) NOT NULL,
        time_in VARCHAR(20),
        time_out VARCHAR(20),
        status VARCHAR(20) DEFAULT 'Present',
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        organization_name VARCHAR(150) DEFAULT 'Supreme Student Council & Clubs',
        school_name VARCHAR(150) DEFAULT 'National High School',
        logo TEXT DEFAULT '',
        attendance_start VARCHAR(10) DEFAULT '08:00',
        grace_period INTEGER DEFAULT 15,
        scanner_pin VARCHAR(20) DEFAULT '1234'
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        user_name VARCHAR(100) NOT NULL,
        date_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed default admin account if not existing
    const adminCheck = await pool.query('SELECT * FROM admins WHERE username = $1', ['admin']);
    let defaultPlainPassword = '';
    if (adminCheck.rows.length === 0) {
      defaultPlainPassword = Math.random().toString(36).substring(2, 10).toUpperCase();
      const hash = await bcrypt.hash(defaultPlainPassword, 10);
      await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
      console.log('----------------------------------------------------');
      console.log('[SETUP] Default Admin Account Created Successfully!');
      console.log('[SETUP] Username: admin');
      console.log(`[SETUP] Temporary Password: ${defaultPlainPassword}`);
      console.log('----------------------------------------------------');
    }

    // Seed default settings if empty
    const settingsCheck = await pool.query('SELECT * FROM settings WHERE id = 1');
    if (settingsCheck.rows.length === 0) {
      await pool.query('INSERT INTO settings (id, organization_name, school_name) VALUES (1, $1, $2)', [
        'Supreme Student Council & Clubs',
        'National High School'
      ]);
    }
  } catch (err) {
    console.error('Database Initialization Error:', err);
  }
}

// Helper: Log Admin Actions
async function logAudit(action, userName) {
  try {
    await pool.query('INSERT INTO audit_logs (action, user_name) VALUES ($1, $2)', [action, userName]);
  } catch (e) {
    console.error('Audit Log Error:', e);
  }
}

// Middleware Guards
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

function requireMember(req, res, next) {
  if (req.session && req.session.isMember) {
    if (req.session.mustChangePassword && req.path !== '/change-password') {
      return res.redirect('/member/change-password');
    }
    return next();
  }
  res.redirect('/member/login');
}

// ==========================================
// ROUTES: PORTAL ROUTING & AUTHENTICATION
// ==========================================

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>School Club QR Attendance System</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f7f6; color: #333; text-align: center; padding: 50px; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
          h1 { color: #2c3e50; margin-bottom: 10px; }
          p { color: #666; margin-bottom: 30px; }
          .btn { display: block; width: 100%; padding: 14px; margin: 12px 0; background: #3498db; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; transition: 0.2s; box-sizing: border-box; }
          .btn:hover { background: #2980b9; }
          .btn-scanner { background: #2ecc71; }
          .btn-scanner:hover { background: #27ae60; }
          .btn-member { background: #9b59b6; }
          .btn-member:hover { background: #8e44ad; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🏫 Club QR Attendance System</h1>
          <p>Select your designated portal below to proceed.</p>
          <a href="/admin/login" class="btn">Admin Portal</a>
          <a href="/scanner" class="btn btn-scanner">Scanner Portal (Smartphone Entrance)</a>
          <a href="/member/login" class="btn btn-member">Member Portal</a>
        </div>
      </body>
    </html>
  `);
});

// --- ADMIN AUTH & DASHBOARD ---
app.get('/admin/login', (req, res) => {
  res.send(`
    <html>
      <head><title>Admin Login</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif; background:#2c3e50; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
        <div style="background:white; padding:40px; border-radius:8px; width:100%; max-width:400px; box-shadow:0 4px 10px rgba(0,0,0,0.3);">
          <h2 style="margin-top:0; color:#2c3e50; text-align:center;">Admin Portal</h2>
          <form method="POST" action="/admin/login">
            <div style="margin-bottom:15px;">
              <label style="font-size:13px; font-weight:bold; display:block; margin-bottom:5px;">Username</label>
              <input type="text" name="username" required style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
            </div>
            <div style="margin-bottom:20px;">
              <label style="font-size:13px; font-weight:bold; display:block; margin-bottom:5px;">Password</label>
              <input type="password" name="password" required style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
            </div>
            <button type="submit" style="width:100%; padding:12px; background:#3498db; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">Login</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      const admin = result.rows[0];
      const match = await bcrypt.compare(password, admin.password_hash);
      if (match) {
        req.session.isAdmin = true;
        req.session.adminUser = admin.username;
        return res.redirect('/admin');
      }
    }
    res.send("<script>alert('Invalid credentials!'); window.location='/admin/login';</script>");
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// Admin Dashboard Main View
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const totalMembers = (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count;
    const activeMembers = (await pool.query("SELECT COUNT(*) FROM members WHERE status='Active'")).rows[0].count;
    const inactiveMembers = (await pool.query("SELECT COUNT(*) FROM members WHERE status='Inactive'")).rows[0].count;
    
    const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const todayAtt = await pool.query('SELECT * FROM attendance WHERE date = $1', [todayStr]);
    
    const presentToday = todayAtt.rows.filter(r => r.status === 'Present').length;
    const lateToday = todayAtt.rows.filter(r => r.status === 'Late').length;
    const totalAttendanceToday = todayAtt.rows.length;
    const absentToday = Math.max(0, parseInt(activeMembers) - presentToday - lateToday);
    const attendancePct = activeMembers > 0 ? Math.round(((presentToday + lateToday) / activeMembers) * 100) : 0;

    const recentScans = await pool.query('SELECT a.*, m.full_name, m.position FROM attendance a JOIN members m ON a.member_id = m.member_id ORDER BY a.id DESC LIMIT 5');
    const recentRegs = await pool.query('SELECT * FROM members ORDER BY id DESC LIMIT 5');
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];

    res.render('admin_dashboard', {
      totalMembers, activeMembers, inactiveMembers, presentToday, absentToday, lateToday, totalAttendanceToday, attendancePct,
      recentScans: recentScans.rows, recentRegs: recentRegs.rows, settings, adminUser: req.session.adminUser
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading dashboard');
  }
});

// --- MEMBER MANAGEMENT & REGISTRATION ---
app.get('/admin/members', requireAdmin, async (req, res) => {
  try {
    const search = req.query.search || '';
    const statusFilter = req.query.status || '';
    let query = 'SELECT * FROM members WHERE (full_name ILIKE $1 OR member_id ILIKE $1 OR username ILIKE $1)';
    let params = [`%${search}%`];

    if (statusFilter) {
      query += ' AND status = $2';
      params.push(statusFilter);
    }
    query += ' ORDER BY id DESC';

    const members = await pool.query(query, params);
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    res.render('admin_members', { members: members.rows, search, statusFilter, settings });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching members');
  }
});

app.post('/admin/members/add', requireAdmin, async (req, res) => {
  try {
    const { full_name, position, club, year_level, course, section, contact, email, status } = req.body;
    
    // Generate unique member ID and credentials
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const nextIdNum = parseInt(countRes.rows[0].count) + 1;
    const yearStr = new Date().getFullYear();
    const member_id = `MEM-${yearStr}-${String(nextIdNum).padStart(3, '0')}`;
    const username = `CLUB-${yearStr}-${String(nextIdNum).padStart(3, '0')}`;
    const tempPassword = Math.random().toString(36).substring(2, 10).toUpperCase();
    const password_hash = await bcrypt.hash(tempPassword, 10);
    const qr_token = `${member_id}-${crypto.randomBytes(8).toString('hex')}`;

    await pool.query(
      `INSERT INTO members (member_id, full_name, position, club, year_level, course, section, contact, email, username, password_hash, qr_token, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [member_id, full_name, position, club, year_level, course, section, contact, email, username, password_hash, qr_token, status || 'Active']
    );

    await logAudit(`Registered member: ${full_name} (${member_id})`, req.session.adminUser);

    // Render success modal popup with credentials & ID card view capability
    res.send(`
      <html>
        <head><title>Member Created</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; background:#f4f7f6; padding:30px; text-align:center;">
          <div style="background:white; max-width:600px; margin:0 auto; padding:30px; border-radius:10px; box-shadow:0 4px 15px rgba(0,0,0,0.1);">
            <h2 style="color:#27ae60;">✓ MEMBER CREATED SUCCESSFULLY</h2>
            <p>Please safely record or print the portal temporary credentials below:</p>
            <div style="background:#f8f9fa; padding:15px; border-radius:6px; text-align:left; margin-bottom:20px; border:1px solid #ddd;">
              <p><strong>Member ID:</strong> ${member_id}</p>
              <p><strong>TEMPORARY USERNAME:</strong> <span style="color:#d9534f; font-weight:bold;">${username}</span></p>
              <p><strong>TEMPORARY PASSWORD:</strong> <span style="color:#d9534f; font-weight:bold;">${tempPassword}</span></p>
              <p style="font-size:12px; color:#e67e22; margin-top:10px;">⚠️ Member must change this temporary password after their first login.</p>
            </div>
            <a href="/admin/members/id/${member_id}" target="_blank" style="display:inline-block; padding:12px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px; font-weight:bold; margin-right:10px;">View & Print ID Card</a>
            <a href="/admin/members" style="display:inline-block; padding:12px 20px; background:#7f8c8d; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">Back to Members</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating member: ' + err.message);
  }
});

// Printable CR80 Standard ID Card Route
app.get('/admin/members/id/:member_id', requireAdmin, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE member_id = $1', [req.params.member_id]);
    if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
    const member = memberRes.rows[0];
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const schoolYear = new Date().getFullYear() + '-' + (new Date().getFullYear() + 1);

    res.render('member_id_card', { member, settings, schoolYear });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading ID card');
  }
});

app.post('/admin/members/reset-password/:id', requireAdmin, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
    const member = memberRes.rows[0];

    const newTempPass = Math.random().toString(36).substring(2, 10).toUpperCase();
    const hash = await bcrypt.hash(newTempPass, 10);

    await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = TRUE WHERE id = $2', [hash, req.params.id]);
    await logAudit(`Reset password for member: ${member.full_name}`, req.session.adminUser);

    res.send(`
      <html><head><title>Password Reset</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif; text-align:center; padding:50px;">
        <div style="max-width:400px; margin:0 auto; background:white; padding:30px; border-radius:8px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
          <h3>Password Reset Successful</h3>
          <p>New Temporary Password for <strong>${member.full_name}</strong>:</p>
          <h2 style="color:#d9534f; background:#f8f9fa; padding:10px; border:1px solid #ddd;">${newTempPass}</h2>
          <p style="font-size:12px; color:#e67e22;">User must change this upon next login.</p>
          <a href="/admin/members" style="display:inline-block; margin-top:15px; padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:4px;">Back to Members</a>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error resetting password');
  }
});

app.post('/admin/members/regenerate-qr/:id', requireAdmin, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
    const member = memberRes.rows[0];

    const newQrToken = `${member.member_id}-${crypto.randomBytes(8).toString('hex')}`;
    await pool.query('UPDATE members SET qr_token = $1 WHERE id = $2', [newQrToken, req.params.id]);
    await logAudit(`Regenerated QR code for member: ${member.full_name}`, req.session.adminUser);

    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error regenerating QR code');
  }
});

app.post('/admin/members/status/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE members SET status = $1 WHERE id = $2', [status, req.params.id]);
    await logAudit(`Updated member status to ${status} for ID ${req.params.id}`, req.session.adminUser);
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating status');
  }
});

app.post('/admin/members/delete/:id', requireAdmin, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT full_name FROM members WHERE id = $1', [req.params.id]);
    if (memberRes.rows.length > 0) {
      await logAudit(`Deleted member: ${memberRes.rows[0].full_name}`, req.session.adminUser);
    }
    await pool.query('DELETE FROM members WHERE id = $1', [req.params.id]);
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting member');
  }
});

// --- ATTENDANCE MANAGEMENT & REPORTS ---
app.get('/admin/attendance', requireAdmin, async (req, res) => {
  try {
    const { date, search, status } = req.query;
    let query = `SELECT a.*, m.full_name, m.position, m.club FROM attendance a JOIN members m ON a.member_id = m.member_id WHERE 1=1`;
    let params = [];

    if (date) {
      params.push(date);
      query += ` AND a.date = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (m.full_name ILIKE $${params.length} OR m.member_id ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      query += ` AND a.status = $${params.length}`;
    }

    query += ` ORDER BY a.id DESC`;
    const attendance = await pool.query(query, params);
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];

    res.render('admin_attendance', { attendance: attendance.rows, queryParams: req.query, settings });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading attendance table');
  }
});

app.get('/admin/reports', requireAdmin, async (req, res) => {
  try {
    const totalMembers = (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count;
    const totalScans = (await pool.query('SELECT COUNT(*) FROM attendance')).rows[0].count;
    const presentCount = (await pool.query("SELECT COUNT(*) FROM attendance WHERE status='Present'")).rows[0].count;
    const lateCount = (await pool.query("SELECT COUNT(*) FROM attendance WHERE status='Late'")).rows[0].count;
    const absentCount = Math.max(0, parseInt(totalMembers) - parseInt(presentCount) - parseInt(lateCount));
    const attendanceRate = totalMembers > 0 ? Math.round(((parseInt(presentCount) + parseInt(lateCount)) / parseInt(totalMembers)) * 100) : 0;

    const lateMembers = await pool.query("SELECT DISTINCT m.full_name, m.member_id, m.position FROM attendance a JOIN members m ON a.member_id = m.member_id WHERE a.status='Late'");
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];

    res.render('admin_reports', {
      totalMembers, totalScans, presentCount, lateCount, absentCount, attendanceRate,
      lateMembers: lateMembers.rows, settings
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating reports');
  }
});

// --- ANNOUNCEMENTS ---
app.get('/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const announcements = await pool.query('SELECT * FROM announcements ORDER BY id DESC');
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    res.render('admin_announcements', { announcements: announcements.rows, settings });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading announcements');
  }
});

app.post('/admin/announcements/add', requireAdmin, async (req, res) => {
  try {
    const { title, message, status } = req.body;
    await pool.query('INSERT INTO announcements (title, message, status) VALUES ($1, $2, $3)', [title, message, status || 'Active']);
    await logAudit(`Created announcement: ${title}`, req.session.adminUser);
    res.redirect('/admin/announcements');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error saving announcement');
  }
});

app.post('/admin/announcements/delete/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
    res.redirect('/admin/announcements');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting announcement');
  }
});

// --- SETTINGS & AUDIT LOGS ---
app.get('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const auditLogs = await pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50');
    res.render('admin_settings', { settings, auditLogs: auditLogs.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading settings');
  }
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { organization_name, school_name, logo, attendance_start, grace_period, scanner_pin, admin_password } = req.body;
    await pool.query(
      `UPDATE settings SET organization_name = $1, school_name = $2, logo = $3, attendance_start = $4, grace_period = $5, scanner_pin = $6 WHERE id = 1`,
      [organization_name, school_name, logo, attendance_start, parseInt(grace_period), scanner_pin]
    );

    if (admin_password && admin_password.trim() !== '') {
      const hash = await bcrypt.hash(admin_password, 10);
      await pool.query('UPDATE admins SET password_hash = $1 WHERE username = $2', [hash, req.session.adminUser]);
    }

    await logAudit('Updated organization settings & configurations', req.session.adminUser);
    res.redirect('/admin/settings');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating settings');
  }
});

app.get('/admin/backup', requireAdmin, async (req, res) => {
  try {
    const members = (await pool.query('SELECT * FROM members')).rows;
    const attendance = (await pool.query('SELECT * FROM attendance')).rows;
    const settings = (await pool.query('SELECT * FROM settings')).rows;
    
    const backupData = {
      exportDate: new Date().toISOString(),
      settings,
      members,
      attendance
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=club_attendance_backup.json');
    res.send(JSON.stringify(backupData, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error backing up database');
  }
});


// ==========================================
// ROUTES: SEPARATE SCANNER PORTAL (/scanner)
// ==========================================

app.get('/scanner', async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    res.render('scanner', { settings });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading scanner portal');
  }
});

// API Endpoint processing QR attendance scan events from smartphone camera
app.post('/api/scan', async (req, res) => {
  const { token, mode } = req.body; // mode: 'Time In' or 'Time Out'
  if (!token) return res.json({ success: false, message: 'Invalid QR Token payload.' });

  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [token]);
    if (memberRes.rows.length === 0) {
      return res.json({ success: false, errorType: 'INVALID', message: '✕ INVALID QR CODE: Not registered in system.' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'Active') {
      return res.json({ success: false, errorType: 'INACTIVE', message: 'MEMBER INACTIVE: Attendance denied.' });
    }

    const todayDateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const currentTimeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    const attCheck = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND date = $2', [member.member_id, todayDateStr]);
    
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];

    if (mode === 'Time In') {
      if (attCheck.rows.length > 0 && attCheck.rows[0].time_in) {
        return res.json({ success: false, errorType: 'DUPLICATE_IN', message: `ALREADY TIMED IN at ${attCheck.rows[0].time_in}` });
      }

      // Calculate attendance status based on config start time & grace period
      let attStatus = 'Present';
      if (settings && settings.attendance_start) {
        const [startHour, startMin] = settings.attendance_start.split(':').map(Number);
        const now = new Date();
        const totalStartMins = startHour * 60 + startMin + (settings.grace_period || 15);
        const currentTotalMins = now.getHours() * 60 + now.getMinutes();
        if (currentTotalMins > totalStartMins) {
          attStatus = 'Late';
        }
      }

      if (attCheck.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [currentTimeStr, attStatus, attCheck.rows[0].id]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, date, time_in, status) VALUES ($1, $2, $3, $4)', [member.member_id, todayDateStr, currentTimeStr, attStatus]);
      }

      return res.json({
        success: true,
        mode: 'Time In',
        message: 'TIME IN SUCCESSFUL',
        member: {
          name: member.full_name,
          position: member.position,
          member_id: member.member_id,
          photo: member.photo || 'https://via.placeholder.com/150',
          time: currentTimeStr,
          date: todayDateStr,
          status: attStatus
        }
      });

    } else if (mode === 'Time Out') {
      if (attCheck.rows.length === 0 || !attCheck.rows[0].time_in) {
        return res.json({ success: false, errorType: 'NO_TIME_IN', message: 'NO TIME-IN RECORD FOUND for today.' });
      }
      if (attCheck.rows[0].time_out) {
        return res.json({ success: false, errorType: 'DUPLICATE_OUT', message: `ALREADY TIMED OUT at ${attCheck.rows[0].time_out}` });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [currentTimeStr, attCheck.rows[0].id]);

      return res.json({
        success: true,
        mode: 'Time Out',
        message: 'TIME OUT SUCCESSFUL',
        member: {
          name: member.full_name,
          position: member.position,
          member_id: member.member_id,
          photo: member.photo || 'https://via.placeholder.com/150',
          time: currentTimeStr,
          date: todayDateStr,
          status: attCheck.rows[0].status
        }
      });
    }

    res.json({ success: false, message: 'Invalid attendance scan mode selected.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server database scan error' });
  }
});


// ==========================================
// ROUTES: MEMBER PORTAL (/member)
// ==========================================

app.get('/member/login', (req, res) => {
  res.send(`
    <html>
      <head><title>Member Portal Login</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif; background:#8e44ad; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
        <div style="background:white; padding:40px; border-radius:8px; width:100%; max-width:400px; box-shadow:0 4px 15px rgba(0,0,0,0.2);">
          <h2 style="margin-top:0; color:#8e44ad; text-align:center;">Member Portal</h2>
          <form method="POST" action="/member/login">
            <div style="margin-bottom:15px;">
              <label style="font-size:13px; font-weight:bold; display:block; margin-bottom:5px;">Username</label>
              <input type="text" name="username" required placeholder="e.g. CLUB-2026-001" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
            </div>
            <div style="margin-bottom:20px;">
              <label style="font-size:13px; font-weight:bold; display:block; margin-bottom:5px;">Password</label>
              <input type="password" name="password" required style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
            </div>
            <button type="submit" style="width:100%; padding:12px; background:#9b59b6; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">Member Login</button>
          </form>
          <p style="text-align:center; font-size:12px; color:#666; margin-top:15px;">Contact club admin if you forgot your credentials.</p>
        </div>
      </body>
    </html>
  `);
});

app.post('/member/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM members WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      const member = result.rows[0];
      const match = await bcrypt.compare(password, member.password_hash);
      if (match) {
        req.session.isMember = true;
        req.session.memberId = member.member_id;
        req.session.mustChangePassword = member.temporary_password_status;
        
        if (member.temporary_password_status) {
          return res.redirect('/member/change-password');
        }
        return res.redirect('/member');
      }
    }
    res.send("<script>alert('Invalid username or password!'); window.location='/member/login';</script>");
  } catch (err) {
    console.error(err);
    res.status(500).send('Server login error');
  }
});

app.get('/member/change-password', requireMember, (req, res) => {
  res.send(`
    <html>
      <head><title>Change Password</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif; background:#f4f7f6; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
        <div style="background:white; padding:30px; border-radius:8px; width:100%; max-width:400px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
          <h3 style="color:#d9534f; margin-top:0;">Password Change Required</h3>
          <p style="font-size:13px; color:#555;">Your account is currently using a temporary password. You must set a new personal password before accessing your member portal.</p>
          <form method="POST" action="/member/change-password">
            <div style="margin-bottom:20px;">
              <label style="font-size:13px; font-weight:bold; display:block; margin-bottom:5px;">New Password</label>
              <input type="password" name="new_password" required minlength="6" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
            </div>
            <button type="submit" style="width:100%; padding:12px; background:#2ecc71; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">Update Password & Continue</button>
          </form>
        </div>
      </body>
    </html>
  `);
});

app.post('/member/change-password', requireMember, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) {
      return res.send("<script>alert('Password must be at least 6 characters long.'); window.history.back();</script>");
    }

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = FALSE WHERE member_id = $2', [hash, req.session.memberId]);
    req.session.mustChangePassword = false;

    res.redirect('/member');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating password');
  }
});

app.get('/member/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/member/login');
  });
});

app.get('/member', requireMember, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE member_id = $1', [req.session.memberId]);
    const member = memberRes.rows[0];

    const attendance = await pool.query('SELECT * FROM attendance WHERE member_id = $1 ORDER BY id DESC', [member.member_id]);
    const announcements = await pool.query("SELECT * FROM announcements WHERE status = 'Active' ORDER BY id DESC LIMIT 5");
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];

    const totalPresent = attendance.rows.filter(r => r.status === 'Present').length;
    const totalLate = attendance.rows.filter(r => r.status === 'Late').length;
    const totalAbsent = attendance.rows.filter(r => r.status === 'Absent').length;

    res.render('member_dashboard', {
      member, attendance: attendance.rows, announcements: announcements.rows, settings,
      totalPresent, totalLate, totalAbsent
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading member portal');
  }
});


// ==========================================
// EMBEDDED EJS TEMPLATES VIEWS ENGINE
// ==========================================

const ejsTemplates = {
  'admin_dashboard.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Admin Dashboard - <%= settings.organization_name %></title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: #f4f7f6; display: flex; }
    .sidebar { width: 250px; background: #2c3e50; color: white; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .sidebar h2 { font-size: 18px; margin-bottom: 30px; color: #1abc9c; text-align: center; }
    .sidebar a { display: block; color: #ecf0f1; text-decoration: none; padding: 12px 15px; margin-bottom: 8px; border-radius: 4px; transition: 0.2s; }
    .sidebar a:hover, .sidebar a.active { background: #34495e; color: #1abc9c; }
    .main-content { flex: 1; padding: 30px; box-sizing: border-box; overflow-y: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .cards-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); border-left: 4px solid #3498db; }
    .card h3 { margin: 0 0 10px 0; font-size: 14px; color: #7f8c8d; }
    .card .val { font-size: 26px; font-weight: bold; color: #2c3e50; }
    .card.green { border-left-color: #2ecc71; }
    .card.orange { border-left-color: #e67e22; }
    .card.purple { border-left-color: #9b59b6; }
    .table-container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); margin-bottom: 25px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 14px; }
    th { background: #f8f9fa; color: #333; }
    .badge { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .badge-present { background: #d4edda; color: #155724; }
    .badge-late { background: #fff3cd; color: #856404; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2><%= settings.organization_name %></h2>
    <a href="/admin" class="active">📊 Dashboard</a>
    <a href="/admin/members">👥 Member Management</a>
    <a href="/admin/attendance">📋 Attendance Records</a>
    <a href="/admin/reports">📈 Reports & Analytics</a>
    <a href="/admin/announcements">📢 Announcements</a>
    <a href="/admin/settings">⚙️ Settings & Logs</a>
    <a href="/admin/logout" style="color:#e74c3c; margin-top:40px;">🚪 Logout</a>
  </div>
  <div class="main-content">
    <div class="header">
      <h2>Dashboard Overview</h2>
      <div>Logged in as: <strong><%= adminUser %></strong></div>
    </div>

    <div class="cards-grid">
      <div class="card">
        <h3>TOTAL MEMBERS</h3>
        <div class="val"><%= totalMembers %></div>
      </div>
      <div class="card green">
        <h3>ACTIVE MEMBERS</h3>
        <div class="val"><%= activeMembers %></div>
      </div>
      <div class="card orange">
        <h3>PRESENT TODAY</h3>
        <div class="val"><%= presentToday %></div>
      </div>
      <div class="card purple">
        <h3>ATTENDANCE RATE</h3>
        <div class="val"><%= attendanceRate %>%</div>
      </div>
    </div>

    <div class="table-container">
      <h3>Recent Scans Today</h3>
      <table>
        <thead>
          <tr><th>Member ID</th><th>Name</th><th>Position</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
        </thead>
        <tbody>
          <% if (recentScans.length === 0) { %>
            <tr><td colspan="6" style="text-align:center; color:#777;">No scans recorded yet today.</td></tr>
          <% } else { %>
            <% recentScans.forEach(scan => { %>
              <tr>
                <td><%= scan.member_id %></td>
                <td><strong><%= scan.full_name %></strong></td>
                <td><%= scan.position %></td>
                <td><%= scan.time_in || '-' %></td>
                <td><%= scan.time_out || '-' %></td>
                <td><span class="badge <%= scan.status==='Present'?'badge-present':'badge-late' %>"><%= scan.status %></span></td>
              </tr>
            <% }) %>
          <% } %>
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
  `,

  'admin_members.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Member Management</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: #f4f7f6; display: flex; }
    .sidebar { width: 250px; background: #2c3e50; color: white; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .sidebar h2 { font-size: 18px; margin-bottom: 30px; color: #1abc9c; text-align: center; }
    .sidebar a { display: block; color: #ecf0f1; text-decoration: none; padding: 12px 15px; margin-bottom: 8px; border-radius: 4px; }
    .sidebar a:hover, .sidebar a.active { background: #34495e; color: #1abc9c; }
    .main-content { flex: 1; padding: 30px; box-sizing: border-box; overflow-y: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .btn { background: #3498db; color: white; border: none; padding: 10px 18px; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; }
    .btn-green { background: #2ecc71; }
    .table-box { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
    th { background: #f8f9fa; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; }
    .modal-content { background: white; padding: 30px; border-radius: 8px; width: 100%; max-width: 550px; max-height: 90vh; overflow-y: auto; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; font-size: 12px; font-weight: bold; margin-bottom: 5px; }
    .form-group input, .form-group select { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2><%= settings.organization_name %></h2>
    <a href="/admin">📊 Dashboard</a>
    <a href="/admin/members" class="active">👥 Member Management</a>
    <a href="/admin/attendance">📋 Attendance Records</a>
    <a href="/admin/reports">📈 Reports & Analytics</a>
    <a href="/admin/announcements">📢 Announcements</a>
    <a href="/admin/settings">⚙️ Settings & Logs</a>
    <a href="/admin/logout" style="color:#e74c3c; margin-top:40px;">🚪 Logout</a>
  </div>
  <div class="main-content">
    <div class="header">
      <h2>Club Members Directory</h2>
      <button class="btn btn-green" onclick="openModal()">+ Add New Member</button>
    </div>

    <div class="table-box">
      <form method="GET" action="/admin/members" style="margin-bottom:15px; display:flex; gap:10px;">
        <input type="text" name="search" placeholder="Search by name, ID, username..." value="<%= search %>" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px;">
        <select name="status" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
          <option value="">All Status</option>
          <option value="Active" <%= statusFilter==='Active'?'selected':'' %>>Active</option>
          <option value="Inactive" <%= statusFilter==='Inactive'?'selected':'' %>>Inactive</option>
        </select>
        <button type="submit" class="btn">Filter</button>
      </form>

      <table>
        <thead>
          <tr><th>Member ID</th><th>Full Name</th><th>Position</th><th>Course/Year</th><th>Username</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          <% if (members.length === 0) { %>
            <tr><td colspan="7" style="text-align:center; color:#777;">No registered members found.</td></tr>
          <% } else { %>
            <% members.forEach(m => { %>
              <tr>
                <td><%= m.member_id %></td>
                <td><strong><%= m.full_name %></strong></td>
                <td><%= m.position %></td>
                <td><%= m.course %> (<%= m.year_level %>)</td>
                <td><code><%= m.username %></code></td>
                <td><span style="color:<%= m.status==='Active'?'#2ecc71':'#e74c3c' %>; font-weight:bold;"><%= m.status %></span></td>
                <td>
                  <a href="/admin/members/id/<%= m.member_id %>" target="_blank" class="btn" style="padding:5px 10px; font-size:11px;">View ID</a>
                  <form action="/admin/members/reset-password/<%= m.id %>" method="POST" style="display:inline;" onsubmit="return confirm('Reset temporary password for this member?');">
                    <button type="submit" class="btn" style="background:#e67e22; padding:5px 10px; font-size:11px;">Reset Pass</button>
                  </form>
                  <form action="/admin/members/regenerate-qr/<%= m.id %>" method="POST" style="display:inline;" onsubmit="return confirm('Regenerate unique QR code token?');">
                    <button type="submit" class="btn" style="background:#9b59b6; padding:5px 10px; font-size:11px;">New QR</button>
                  </form>
                  <form action="/admin/members/delete/<%= m.id %>" method="POST" style="display:inline;" onsubmit="return confirm('Permanently delete this member?');">
                    <button type="submit" class="btn" style="background:#e74c3c; padding:5px 10px; font-size:11px;">Delete</button>
                  </form>
                </td>
              </tr>
            <% }) %>
          <% } %>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Add Member Modal -->
  <div id="addModal" class="modal">
    <div class="modal-content">
      <h3>Register New Club Member</h3>
      <form method="POST" action="/admin/members/add">
        <div class="form-group"><label>Full Name</label><input type="text" name="full_name" required></div>
        <div class="form-group"><label>Position</label><input type="text" name="position" value="Member" required></div>
        <div class="form-group"><label>Club / Organization</label><input type="text" name="club" value="<%= settings.organization_name %>" required></div>
        <div class="form-group"><label>Year Level</label><input type="text" name="year_level" placeholder="e.g. Grade 12" required></div>
        <div class="form-group"><label>Course / Section</label><input type="text" name="course" placeholder="e.g. STEM / Section A" required></div>
        <div class="form-group"><label>Contact Number</label><input type="text" name="contact"></div>
        <div class="form-group"><label>Email Address</label><input type="email" name="email"></div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
          <button type="button" class="btn" style="background:#95a5a6;" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-green">Save & Generate Credentials</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function openModal() { document.getElementById('addModal').style.display = 'flex'; }
    function closeModal() { document.getElementById('addModal').style.display = 'none'; }
  </script>
</body>
</html>
  `,

  'member_id_card.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Membership ID Card - <%= member.full_name %></title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- Google Chart API for crisp vector QR code rendering -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #eef2f3; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    /* Standard CR80 PVC card aspect ratio simulation & precise print scale */
    .id-card { width: 450px; height: 280px; background: white; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.15); box-sizing: border-box; padding: 20px; position: relative; overflow: hidden; border: 2px solid #2c3e50; display: flex; flex-direction: column; justify-content: space-between; }
    .id-header { display: flex; align-items: center; border-bottom: 2px solid #3498db; padding-bottom: 8px; }
    .id-logo { width: 40px; height: 40px; background: #3498db; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 18px; margin-right: 12px; }
    .id-org-title { font-size: 13px; font-weight: bold; color: #2c3e50; text-transform: uppercase; }
    .id-school { font-size: 10px; color: #7f8c8d; }
    .id-body { display: flex; align-items: center; margin-top: 10px; }
    .avatar-box { width: 90px; height: 110px; background: #ddd; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #666; font-weight: bold; overflow: hidden; margin-right: 15px; border: 1px solid #bbb; }
    .info-box { flex: 1; font-size: 12px; color: #333; }
    .info-box h3 { margin: 0 0 4px 0; font-size: 16px; color: #2c3e50; }
    .info-box p { margin: 2px 0; }
    .qr-container { display: flex; flex-direction: column; align-items: center; justify-content: center; }
    #qrcode canvas, #qrcode img { width: 75px !important; height: 75px !important; }
    .id-footer { background: #2c3e50; color: white; font-size: 9px; text-align: center; padding: 5px; margin: -20px -20px -20px -20px; margin-top: 10px; }
    .credentials-sheet { background: white; max-width: 450px; width: 100%; margin-top: 25px; padding: 20px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); box-sizing: border-box; }
    .btn-print { margin-top: 20px; padding: 12px 25px; background: #2ecc71; color: white; border: none; font-weight: bold; border-radius: 5px; cursor: pointer; font-size: 14px; }
    @media print {
      body { background: white; justify-content: flex-start; padding: 0; }
      .credentials-sheet, .btn-print { display: none; }
      .id-card { box-shadow: none; border: 1px solid #000; }
    }
  </style>
</head>
<body>

  <div class="id-card">
    <div class="id-header">
      <div class="id-logo"><%= settings.organization_name.charAt(0) %></div>
      <div>
        <div class="id-org-title"><%= settings.organization_name %></div>
        <div class="id-school"><%= settings.school_name %> (S.Y. <%= schoolYear %>)</div>
      </div>
    </div>

    <div class="id-body">
      <div class="avatar-box">
        <%= member.full_name.charAt(0) %>
      </div>
      <div class="info-box">
        <h3><%= member.full_name %></h3>
        <p><strong>Position:</strong> <span style="color:#2980b9;"><%= member.position %></span></p>
        <p><strong>ID No:</strong> <%= member.member_id %></p>
        <p><strong>Course/Yr:</strong> <%= member.course %> - <%= member.year_level %></p>
      </div>
      <div class="qr-container">
        <div id="qrcode"></div>
        <span style="font-size:8px; margin-top:3px; color:#555;">Official QR</span>
      </div>
    </div>

    <div class="id-footer">
      OFFICIAL MEMBERSHIP IDENTIFICATION CARD — VALID FOR ACADEMIC YEAR <%= schoolYear %>
    </div>
  </div>

  <div class="credentials-sheet">
    <h3 style="margin-top:0; color:#c0392b; font-size:15px;">⚠️ Portal Initial Access Credentials</h3>
    <p style="font-size:12px; color:#555;">Give this slip or card securely to the member for portal login:</p>
    <p style="font-size:13px; margin:5px 0;"><strong>Username:</strong> <code><%= member.username %></code></p>
    <p style="font-size:13px; margin:5px 0;"><strong>Temporary Password:</strong> <code style="color:#c0392b; font-weight:bold;"><%= member.password_hash ? '******** (Encrypted)' : '' %></code> (Provided upon creation/reset)</p>
    <p style="font-size:11px; color:#e67e22; margin-top:10px;">Please change your temporary password immediately after your first login at <code>/member</code>.</p>
  </div>

  <button class="btn-print" onclick="window.print()">🖨️ Print ID Card</button>

  <script>
    // Generate secure QR Token visualization
    new QRCode(document.getElementById("qrcode"), {
      text: "<%= member.qr_token %>",
      width: 75,
      height: 75,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  </script>
</body>
</html>
  `,

  'scanner.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Entrance QR Scanner - <%= settings.organization_name %></title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- HTML5 QR Code Scanner Library -->
  <script src="https://unpkg.com/html5-qrcode"></script>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #111; color: white; margin: 0; padding: 15px; display: flex; flex-direction: column; align-items: center; min-height: 100vh; box-sizing: border-box; }
    .scanner-container { width: 100%; max-width: 450px; background: #222; padding: 20px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); box-sizing: border-box; text-align: center; }
    h2 { margin-top: 0; color: #2ecc71; font-size: 20px; }
    .mode-selector { display: flex; gap: 10px; margin-bottom: 20px; }
    .mode-btn { flex: 1; padding: 12px; border: none; font-weight: bold; border-radius: 6px; cursor: pointer; font-size: 15px; background: #444; color: #ccc; }
    .mode-btn.active-in { background: #2ecc71; color: white; }
    .mode-btn.active-out { background: #e74c3c; color: white; }
    #reader { width: 100% !important; border-radius: 8px; overflow: hidden; border: none !important; }
    #reader video { width: 100% !important; border-radius: 8px; object-fit: cover; }
    .result-box { margin-top: 20px; padding: 15px; border-radius: 8px; display: none; text-align: left; }
    .success-box { background: #1b4d3e; border: 2px solid #2ecc71; }
    .error-box { background: #5c1d1d; border: 2px solid #e74c3c; }
    .result-box h3 { margin: 0 0 8px 0; font-size: 16px; }
  </style>
</head>
<body>
  <div class="scanner-container">
    <h2>📱 Entrance Scanner Portal</h2>
    <div style="font-size:12px; color:#aaa; margin-bottom:15px;"><%= settings.organization_name %></div>

    <div class="mode-selector">
      <button id="btnIn" class="mode-btn active-in" onclick="setMode('Time In')">TIME IN</button>
      <button id="btnOut" class="mode-btn" onclick="setMode('Time Out')">TIME OUT</button>
    </div>

    <div id="reader"></div>

    <div id="scanResult" class="result-box">
      <h3 id="resHeader">SUCCESS</h3>
      <p id="resMsg" style="margin:5px 0; font-size:14px;"></p>
    </div>
  </div>

  <!-- Audio Synthesizer Beeps via Web Audio API (No external mp3 needed) -->
  <script>
    let currentMode = 'Time In';

    function setMode(mode) {
      currentMode = mode;
      if (mode === 'Time In') {
        document.getElementById('btnIn').className = 'mode-btn active-in';
        document.getElementById('btnOut').className = 'mode-btn';
      } else {
        document.getElementById('btnIn').className = 'mode-btn';
        document.getElementById('btnOut').className = 'mode-btn active-out';
      }
    }

    function playBeep(type) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'success') {
          osc.frequency.setValueAtTime(800, ctx.currentTime);
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.15);
        } else {
          // Triple beep error
          osc.frequency.setValueAtTime(300, ctx.currentTime);
          gain.gain.setValueAtTime(0.2, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.1);
          setTimeout(() => {
            const osc2 = ctx.createOscillator();
            osc2.connect(gain);
            osc2.frequency.setValueAtTime(300, ctx.currentTime);
            osc2.start();
            osc2.stop(ctx.currentTime + 0.1);
          }, 150);
        }
      } catch (e) {
        console.log('Audio Context suppressed');
      }
    }

    let lastScanTime = 0;

    function onScanSuccess(decodedText) {
      const now = Date.now();
      if (now - lastScanTime < 3000) return; // 3-second cooldown to prevent duplicate triggers
      lastScanTime = now;

      fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: decodedText, mode: currentMode })
      })
      .then(res => res.json())
      .then(data => {
        const box = document.getElementById('scanResult');
        const header = document.getElementById('resHeader');
        const msg = document.getElementById('resMsg');
        box.style.display = 'block';

        if (data.success) {
          playBeep('success');
          box.className = 'result-box success-box';
          header.innerHTML = '✓ ' + data.message;
          msg.innerHTML = '<strong>' + data.member.name + '</strong><br>' + data.member.position + '<br>Time: ' + data.member.time + ' (' + data.member.status + ')';
        } else {
          playBeep('error');
          box.className = 'result-box error-box';
          header.innerHTML = '✕ ATTENDANCE ERROR';
          msg.innerHTML = data.message;
        }

        setTimeout(() => { box.style.display = 'none'; }, 4000);
      })
      .catch(err => {
        console.error(err);
      });
    }

    const html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess
    ).catch(err => {
      console.error("Camera permissions denied or unavailable", err);
    });
  </script>
</body>
</html>
  `,

  'member_dashboard.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Member Portal - <%= member.full_name %></title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f7f6; margin: 0; padding: 20px; color: #333; }
    .container { max-width: 800px; margin: 0 auto; }
    .header-card { background: linear-gradient(135deg, #8e44ad, #3498db); color: white; padding: 25px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 15px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .btn { display: inline-block; padding: 10px 18px; background: #9b59b6; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 13px; margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
    th { background: #f8f9fa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-card">
      <div>
        <h2 style="margin:0 0 5px 0;"><%= member.full_name %></h2>
        <p style="margin:0; opacity:0.9;"><%= member.position %> | ID: <strong><%= member.member_id %></strong></p>
      </div>
      <a href="/member/logout" style="background:#e74c3c; color:white; padding:8px 15px; border-radius:4px; text-decoration:none; font-size:13px; font-weight:bold;">Logout</a>
    </div>

    <div class="grid">
      <div class="card" style="text-align:center;">
        <h3>My Membership QR Token</h3>
        <div id="qrcode" style="display:inline-block; margin:10px 0;"></div>
        <p style="font-size:11px; color:#7f8c8d;">Present this QR code at the entrance scanner.</p>
        <a href="/admin/members/id/<%= member.member_id %>" target="_blank" class="btn">View & Download ID Card</a>
      </div>
      <div class="card">
        <h3>Attendance Summary</h3>
        <p><strong>Total Present:</strong> <span style="color:#2ecc71;"><%= totalPresent %></span></p>
        <p><strong>Total Late:</strong> <span style="color:#f39c12;"><%= totalLate %></span></p>
        <p><strong>Total Absent:</strong> <span style="color:#e74c3c;"><%= totalAbsent %></span></p>
        <hr style="border:0; border-top:1px solid #eee; margin:15px 0;">
        <h4 style="margin:0 0 5px 0; font-size:13px;">Latest Club Announcements</h4>
        <% if (announcements.length === 0) { %>
          <p style="font-size:12px; color:#777;">No announcements posted.</p>
        <% } else { %>
          <% announcements.forEach(a => { %>
            <div style="font-size:12px; background:#f9f9f9; padding:8px; border-radius:4px; margin-bottom:5px;">
              <strong><%= a.title %></strong>: <%= a.message %>
            </div>
          <% }) %>
        <% } %>
      </div>
    </div>

    <div class="card">
      <h3>Attendance History Log</h3>
      <table>
        <thead>
          <tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
        </thead>
        <tbody>
          <% if (attendance.length === 0) { %>
            <tr><td colspan="4" style="text-align:center; color:#777;">No attendance history logged yet.</td></tr>
          <% } else { %>
            <% attendance.forEach(att => { %>
              <tr>
                <td><%= att.date %></td>
                <td><%= att.time_in || '-' %></td>
                <td><%= att.time_out || '-' %></td>
                <td><span style="font-weight:bold; color:<%= att.status==='Present'?'#2ecc71':'#e67e22' %>;"><%= att.status %></span></td>
              </tr>
            <% }) %>
          <% } %>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    new QRCode(document.getElementById("qrcode"), {
      text: "<%= member.qr_token %>",
      width: 120,
      height: 120
    });
  </script>
</body>
</html>
  `,

  'admin_attendance.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Attendance Records</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: #f4f7f6; display: flex; }
    .sidebar { width: 250px; background: #2c3e50; color: white; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .sidebar h2 { font-size: 18px; margin-bottom: 30px; color: #1abc9c; text-align: center; }
    .sidebar a { display: block; color: #ecf0f1; text-decoration: none; padding: 12px 15px; margin-bottom: 8px; border-radius: 4px; }
    .sidebar a:hover, .sidebar a.active { background: #34495e; color: #1abc9c; }
    .main-content { flex: 1; padding: 30px; box-sizing: border-box; overflow-y: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .table-box { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
    th { background: #f8f9fa; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2><%= settings.organization_name %></h2>
    <a href="/admin">📊 Dashboard</a>
    <a href="/admin/members">👥 Member Management</a>
    <a href="/admin/attendance" class="active">📋 Attendance Records</a>
    <a href="/admin/reports">📈 Reports & Analytics</a>
    <a href="/admin/announcements">📢 Announcements</a>
    <a href="/admin/settings">⚙️ Settings & Logs</a>
    <a href="/admin/logout" style="color:#e74c3c; margin-top:40px;">🚪 Logout</a>
  </div>
  <div class="main-content">
    <div class="header">
      <h2>Complete Attendance Logs</h2>
      <button onclick="window.print()" style="background:#3498db; color:white; border:none; padding:10px 15px; border-radius:5px; font-weight:bold; cursor:pointer;">Print / Export PDF</button>
    </div>
    <div class="table-box">
      <form method="GET" action="/admin/attendance" style="margin-bottom:15px; display:flex; gap:10px;">
        <input type="text" name="search" placeholder="Search member name or ID..." value="<%= queryParams.search || '' %>" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px;">
        <input type="text" name="date" placeholder="Date (e.g. Aug 25, 2026)" value="<%= queryParams.date || '' %>" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
        <button type="submit" style="padding:8px 15px; background:#3498db; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">Filter</button>
      </form>
      <table>
        <thead>
          <tr><th>Date</th><th>Member ID</th><th>Name</th><th>Position</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
        </thead>
        <tbody>
          <% if (attendance.length === 0) { %>
            <tr><td colspan="7" style="text-align:center; color:#777;">No attendance records found.</td></tr>
          <% } else { %>
            <% attendance.forEach(att => { %>
              <tr>
                <td><%= att.date %></td>
                <td><%= att.member_id %></td>
                <td><strong><%= att.full_name %></strong></td>
                <td><%= att.position %></td>
                <td><%= att.time_in || '-' %></td>
                <td><%= att.time_out || '-' %></td>
                <td><span style="font-weight:bold; color:<%= att.status==='Present'?'#2ecc71':'#e67e22' %>;"><%= att.status %></span></td>
              </tr>
            <% }) %>
          <% } %>
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
  `,

  'admin_reports.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Reports & Analytics</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: #f4f7f6; display: flex; }
    .sidebar { width: 250px; background: #2c3e50; color: white; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .sidebar h2 { font-size: 18px; margin-bottom: 30px; color: #1abc9c; text-align: center; }
    .sidebar a { display: block; color: #ecf0f1; text-decoration: none; padding: 12px 15px; margin-bottom: 8px; border-radius: 4px; }
    .sidebar a:hover, .sidebar a.active { background: #34495e; color: #1abc9c; }
    .main-content { flex: 1; padding: 30px; box-sizing: border-box; overflow-y: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 25px; }
    .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .card h3 { margin: 0 0 10px 0; font-size: 13px; color: #7f8c8d; }
    .card .val { font-size: 24px; font-weight: bold; color: #2c3e50; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2><%= settings.organization_name %></h2>
    <a href="/admin">📊 Dashboard</a>
    <a href="/admin/members">👥 Member Management</a>
    <a href="/admin/attendance">📋 Attendance Records</a>
    <a href="/admin/reports" class="active">📈 Reports & Analytics</a>
    <a href="/admin/announcements">📢 Announcements</a>
    <a href="/admin/settings">⚙️ Settings & Logs</a>
    <a href="/admin/logout" style="color:#e74c3c; margin-top:40px;">🚪 Logout</a>
  </div>
  <div class="main-content">
    <div class="header">
      <h2>Attendance Analytics & Reports</h2>
      <a href="/admin/backup" style="background:#27ae60; color:white; padding:10px 15px; border-radius:5px; text-decoration:none; font-weight:bold; font-size:13px;">📥 Backup Database (JSON)</a>
    </div>

    <div class="grid">
      <div class="card"><h3>TOTAL ENROLLED MEMBERS</h3><div class="val"><%= totalMembers %></div></div>
      <div class="card"><h3>TOTAL ATTENDANCE SCANS</h3><div class="val"><%= totalScans %></div></div>
      <div class="card"><h3>PRESENT COUNT</h3><div class="val" style="color:#2ecc71;"><%= presentCount %></div></div>
      <div class="card"><h3>LATE COUNT</h3><div class="val" style="color:#f39c12;"><%= lateCount %></div></div>
      <div class="card"><h3>OVERALL ATTENDANCE RATE</h3><div class="val" style="color:#3498db;"><%= attendanceRate %>%</div></div>
    </div>
  </div>
</body>
</html>
  `,

  'admin_announcements.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Announcements</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: #f4f7f6; display: flex; }
    .sidebar { width: 250px; background: #2c3e50; color: white; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .sidebar h2 { font-size: 18px; margin-bottom: 30px; color: #1abc9c; text-align: center; }
    .sidebar a { display: block; color: #ecf0f1; text-decoration: none; padding: 12px 15px; margin-bottom: 8px; border-radius: 4px; }
    .sidebar a:hover, .sidebar a.active { background: #34495e; color: #1abc9c; }
    .main-content { flex: 1; padding: 30px; box-sizing: border-box; overflow-y: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .box { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); margin-bottom: 20px; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; font-size: 12px; font-weight: bold; margin-bottom: 5px; }
    .form-group input, .form-group textarea { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    .btn { background: #2ecc71; color: white; border: none; padding: 10px 18px; border-radius: 5px; cursor: pointer; font-weight: bold; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2><%= settings.organization_name %></h2>
    <a href="/admin">📊 Dashboard</a>
    <a href="/admin/members">👥 Member Management</a>
    <a href="/admin/attendance">📋 Attendance Records</a>
    <a href="/admin/reports">📈 Reports & Analytics</a>
    <a href="/admin/announcements" class="active">📢 Announcements</a>
    <a href="/admin/settings">⚙️ Settings & Logs</a>
    <a href="/admin/logout" style="color:#e74c3c; margin-top:40px;">🚪 Logout</a>
  </div>
  <div class="main-content">
    <div class="header"><h2>Club Announcements</h2></div>

    <div class="box">
      <h3>Post New Announcement</h3>
      <form method="POST" action="/admin/announcements/add">
        <div class="form-group"><label>Title</label><input type="text" name="title" required></div>
        <div class="form-group"><label>Message Content</label><textarea name="message" rows="3" required></textarea></div>
        <button type="submit" class="btn">Publish Announcement</button>
      </form>
    </div>

    <div class="box">
      <h3>Active Announcements</h3>
      <% if (announcements.length === 0) { %>
        <p style="color:#777; font-size:13px;">No announcements found.</p>
      <% } else { %>
        <% announcements.forEach(a => { %>
          <div style="border-bottom:1px solid #eee; padding:10px 0;">
            <h4 style="margin:0 0 5px 0;"><%= a.title %></h4>
            <p style="margin:0 0 5px 0; font-size:13px; color:#555;"><%= a.message %></p>
            <form action="/admin/announcements/delete/<%= a.id %>" method="POST" style="display:inline;" onsubmit="return confirm('Delete announcement?');">
              <button type="submit" style="background:#e74c3c; color:white; border:none; padding:4px 8px; border-radius:3px; font-size:11px; cursor:pointer;">Delete</button>
            </form>
          </div>
        <% }) %>
      <% } %>
    </div>
  </div>
</body>
</html>
  `,

  'admin_settings.ejs': `
<!DOCTYPE html>
<html>
<head>
  <title>Settings & Audit Logs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: 'Segoe UI', sans-serif; margin: 0; background: #f4f7f6; display: flex; }
    .sidebar { width: 250px; background: #2c3e50; color: white; min-height: 100vh; padding: 20px; box-sizing: border-box; }
    .sidebar h2 { font-size: 18px; margin-bottom: 30px; color: #1abc9c; text-align: center; }
    .sidebar a { display: block; color: #ecf0f1; text-decoration: none; padding: 12px 15px; margin-bottom: 8px; border-radius: 4px; }
    .sidebar a:hover, .sidebar a.active { background: #34495e; color: #1abc9c; }
    .main-content { flex: 1; padding: 30px; box-sizing: border-box; overflow-y: auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
    .box { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); margin-bottom: 20px; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; font-size: 12px; font-weight: bold; margin-bottom: 5px; }
    .form-group input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    .btn { background: #3498db; color: white; border: none; padding: 10px 18px; border-radius: 5px; cursor: pointer; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; font-size: 12px; }
    th { background: #f8f9fa; }
  </style>
</head>
<body>
  <div class="sidebar">
    <h2><%= settings.organization_name %></h2>
    <a href="/admin">📊 Dashboard</a>
    <a href="/admin/members">👥 Member Management</a>
    <a href="/admin/attendance">📋 Attendance Records</a>
    <a href="/admin/reports">📈 Reports & Analytics</a>
    <a href="/admin/announcements">📢 Announcements</a>
    <a href="/admin/settings" class="active">⚙️ Settings & Logs</a>
    <a href="/admin/logout" style="color:#e74c3c; margin-top:40px;">🚪 Logout</a>
  </div>
  <div class="main-content">
    <div class="header"><h2>System Settings & Audit Logs</h2></div>

    <div class="box">
      <h3>Organization & Attendance Configuration</h3>
      <form method="POST" action="/admin/settings">
        <div class="form-group"><label>Organization Name</label><input type="text" name="organization_name" value="<%= settings.organization_name %>" required></div>
        <div class="form-group"><label>School Name</label><input type="text" name="school_name" value="<%= settings.school_name %>" required></div>
        <div class="form-group"><label>Official Time In Start (e.g. 08:00)</label><input type="text" name="attendance_start" value="<%= settings.attendance_start %>" required></div>
        <div class="form-group"><label>Grace Period (Minutes before marked Late)</label><input type="number" name="grace_period" value="<%= settings.grace_period %>" required></div>
        <div class="form-group"><label>Change Admin Password (leave blank to keep current)</label><input type="password" name="admin_password"></div>
        <button type="submit" class="btn">Save Configurations</button>
      </form>
    </div>

    <div class="box">
      <h3>Admin Audit Trail Logs</h3>
      <table>
        <thead><tr><th>Action Performed</th><th>User / Admin</th><th>Timestamp</th></tr></thead>
        <tbody>
          <% if (auditLogs.length === 0) { %>
            <tr><td colspan="3" style="text-align:center; color:#777;">No audit logs recorded.</td></tr>
          <% } else { %>
            <% auditLogs.forEach(log => { %>
              <tr>
                <td><%= log.action %></td>
                <td><strong><%= log.user_name %></strong></td>
                <td><%= log.date_time %></td>
              </tr>
            <% }) %>
          <% } %>
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
  `
};

// Route template helper engine bindings
app.engine('ejs', (filePath, options, callback) => {
  const filename = require('path').basename(filePath);
  if (ejsTemplates[filename]) {
    try {
      const rendered = require('ejs').render(ejsTemplates[filename], options);
      return callback(null, rendered);
    } catch (err) {
      return callback(err);
    }
  }
  return callback(new Error('Template not found: ' + filename));
});


// ==========================================
// BOOTSTRAP APPLICATION LAUNCHER
// ==========================================
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🏫 School Club QR Attendance System running successfully!`);
    console.log(`🌐 PORT: ${PORT}`);
    console.log(`🔗 Admin Portal:    http://localhost:${PORT}/admin`);
    console.log(`📱 Scanner Portal:  http://localhost:${PORT}/scanner`);
    console.log(`👤 Member Portal:   http://localhost:${PORT}/member`);
    console.log(`====================================================`);
  });
});
