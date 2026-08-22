/**
 * ClubTrack QR Attendance System
 * Organization and Club Management System for High School
 * Entire backend, database migrations, security, and full frontend SPA template in ONE FILE.
 */

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware setup
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session Store configuration with PostgreSQL
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'clubtrack-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' }
}));

// --- DATABASE INITIALIZATION MIGRATIONS ---
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name VARCHAR(255) DEFAULT 'ABC High School',
        org_name VARCHAR(255) DEFAULT 'Supreme Student Council',
        school_year VARCHAR(50) DEFAULT '2026–2027',
        org_description VARCHAR(500) DEFAULT 'Official student leadership organization.',
        org_prefix VARCHAR(50) DEFAULT 'SSC',
        accent_color VARCHAR(50) DEFAULT '#4f46e5',
        org_logo TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'scanner', 'member')),
        name VARCHAR(255) NOT NULL,
        must_change_password BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        member_id VARCHAR(100) UNIQUE NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        middle_name VARCHAR(100),
        last_name VARCHAR(100) NOT NULL,
        gender VARCHAR(50),
        grade_level VARCHAR(50) NOT NULL,
        section VARCHAR(50) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        contact_info VARCHAR(100),
        email VARCHAR(150),
        profile_photo TEXT,
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        late_cutoff TIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL,
        time_in TIME,
        time_out TIME,
        status VARCHAR(50) DEFAULT 'Present' CHECK (status IN ('Present', 'Late', 'Absent')),
        scan_method VARCHAR(50) DEFAULT 'QR',
        manual_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        expiration_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        scanner_user_id INTEGER REFERENCES users(id),
        event_id INTEGER REFERENCES events(id),
        scan_type VARCHAR(20) NOT NULL,
        qr_value TEXT,
        result_status VARCHAR(50) NOT NULL,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        username VARCHAR(100),
        role VARCHAR(50),
        action VARCHAR(150) NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure default settings row exists
    const settingsCheck = await client.query('SELECT COUNT(*) FROM organization_settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_description, org_prefix, accent_color)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official student leadership organization.', 'SSC', '#4f46e5');
      `);
    }

    // Ensure default Admin user exists
    const adminCheck = await client.query("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
    if (adminCheck.rows.length === 0) {
      const hashedAdminPass = await bcrypt.hash('admin123', 10);
      await client.query(`
        INSERT INTO users (username, password, role, name, must_change_password)
        VALUES ('admin', $1, 'admin', 'System Administrator', TRUE);
      `, [hashedAdminPass]);
      console.log('Default admin account created: username: admin, password: admin123');
    }
  } catch (err) {
    console.error('Database migration error:', err);
  } finally {
    client.release();
  }
}

// Audit logger helper
async function logAudit(req, action, details) {
  try {
    const userId = req.session && req.session.user ? req.session.user.id : null;
    const username = req.session && req.session.user ? req.session.user.username : 'guest';
    const role = req.session && req.session.user ? req.session.user.role : 'guest';
    await pool.query(
      `INSERT INTO audit_logs (user_id, username, role, action, details) VALUES ($1, $2, $3, $4, $5)`,
      [userId, username, role, action, details]
    );
  } catch (e) {
    console.error('Audit logging failed:', e);
  }
}

// --- AUTHENTICATION MIDDLEWARES ---
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      if (req.xhr || req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized. Please log in.' });
      }
      return res.redirect('/login');
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied for your role.' });
    }
    if (req.session.user.must_change_password && req.path !== '/change-password-forced' && !req.path.startsWith('/api/')) {
      return res.redirect('/change-password-forced');
    }
    next();
  };
}

// --- API ROUTES ---

// Settings getter/setter
app.get('/api/settings', async (req, res) => {
  const result = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  res.json(result.rows[0] || {});
});

app.post('/api/settings', requireAuth('admin'), async (req, res) => {
  const { school_name, org_name, school_year, org_description, org_prefix, accent_color, org_logo } = req.body;
  await pool.query(`
    UPDATE organization_settings 
    SET school_name = $1, org_name = $2, school_year = $3, org_description = $4, org_prefix = $5, accent_color = $6, org_logo = $7
    WHERE id = (SELECT id FROM organization_settings LIMIT 1)
  `, [school_name, org_name, school_year, org_description, org_prefix, accent_color, org_logo]);
  await logAudit(req, 'UPDATE_SETTINGS', 'Updated organization branding and configuration.');
  res.json({ success: true });
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.name,
      must_change_password: user.must_change_password
    };

    await logAudit(req, 'USER_LOGIN', `User ${username} logged in successfully as ${user.role}.`);

    let redirectUrl = '/dashboard';
    if (user.role === 'scanner') redirectUrl = '/scanner';
    else if (user.role === 'member') redirectUrl = '/member';

    res.json({ success: true, redirect: redirectUrl, mustChangePassword: user.must_change_password });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Forced password change endpoint
app.post('/api/change-password', requireAuth(), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  }
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows[0];
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    const hashedNew = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashedNew, user.id]);
    req.session.user.must_change_password = false;
    await logAudit(req, 'PASSWORD_CHANGE', 'User successfully changed their password.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN STATS & MEMBERS API ---
app.get('/api/admin/stats', requireAuth('admin'), async (req, res) => {
  try {
    const totalMembers = await pool.query('SELECT COUNT(*) FROM members');
    const activeMembers = await pool.query("SELECT COUNT(*) FROM members WHERE status = 'active'");
    const today = new Date().toISOString().split('T')[0];
    const presentToday = await pool.query('SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date = $1', [today]);
    const timeInToday = await pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND time_in IS NOT NULL', [today]);
    const timeOutToday = await pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND time_out IS NOT NULL', [today]);
    const lateToday = await pool.query("SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND status = 'Late'", [today]);
    const invalidScans = await pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result_status = 'INVALID'");

    res.json({
      totalMembers: parseInt(totalMembers.rows[0].count),
      activeMembers: parseInt(activeMembers.rows[0].count),
      presentToday: parseInt(presentToday.rows[0].count),
      timeInToday: parseInt(timeInToday.rows[0].count),
      timeOutToday: parseInt(timeOutToday.rows[0].count),
      lateToday: parseInt(lateToday.rows[0].count),
      invalidScans: parseInt(invalidScans.rows[0].count)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all members
app.get('/api/members', requireAuth('admin'), async (req, res) => {
  const result = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id ORDER BY m.last_name ASC');
  res.json(result.rows);
});

// Register member
app.post('/api/members', requireAuth('admin'), async (req, res) => {
  const { first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email, profile_photo } = req.body;
  try {
    // Get organization prefix
    const settings = await pool.query('SELECT org_prefix FROM organization_settings LIMIT 1');
    const prefix = settings.rows[0] ? settings.rows[0].org_prefix : 'SSC';
    const year = new Date().getFullYear();

    // Generate unique Member ID
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seqNum = parseInt(countRes.rows[0].count) + 1;
    const member_id = `${prefix}-${year}-${String(seqNum).padStart(4, '0')}`;

    // Generate unique username
    let baseUsername = (first_name + last_name).toLowerCase().replace(/[^a-z0-9]/g, '');
    let username = baseUsername;
    let uCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    let counter = 1;
    while (uCheck.rows.length > 0) {
      counter++;
      username = `${baseUsername}${counter}`;
      uCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    }

    // Generate temporary password (random 8 chars)
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Create user account
    const userResult = await pool.query(
      `INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, 'member', $3, TRUE) RETURNING id`,
      [username, hashedPassword, `${first_name} ${last_name}`]
    );
    const userId = userResult.rows[0].id;

    // Create unique secure token for QR code
    const qr_token = `CLUBTRACK:MEMBER:${crypto.randomUUID()}`;

    const memberResult = await pool.query(`
      INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email, profile_photo, qr_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *
    `, [userId, member_id, first_name, middle_name || '', last_name, gender, grade_level, section, position || 'Member', contact_info, email, profile_photo, qr_token]);

    await logAudit(req, 'REGISTER_MEMBER', `Registered member ${first_name} ${last_name} (${member_id}).`);

    res.json({
      success: true,
      member: memberResult.rows[0],
      credentials: {
        username,
        tempPassword,
        member_id
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete member
app.delete('/api/members/:id', requireAuth('admin'), async (req, res) => {
  try {
    const memberId = req.params.id;
    const memRes = await pool.query('SELECT user_id, first_name, last_name FROM members WHERE id = $1', [memberId]);
    if (memRes.rows.length === 0) return res.status(404).json({ error: 'Member not found.' });
    const userId = memRes.rows[0].user_id;

    await pool.query('DELETE FROM users WHERE id = $1', [userId]); // Cascades to members & attendance
    await logAudit(req, 'DELETE_MEMBER', `Deleted member ${memRes.rows[0].first_name} ${memRes.rows[0].last_name}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset member password
app.post('/api/members/:id/reset-password', requireAuth('admin'), async (req, res) => {
  try {
    const memberId = req.params.id;
    const memRes = await pool.query('SELECT user_id, first_name, last_name FROM members WHERE id = $1', [memberId]);
    if (memRes.rows.length === 0) return res.status(404).json({ error: 'Member not found.' });
    const userId = memRes.rows[0].user_id;

    const newTempPass = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hashed = await bcrypt.hash(newTempPass, 10);

    await pool.query('UPDATE users SET password = $1, must_change_password = TRUE WHERE id = $2', [hashed, userId]);
    await logAudit(req, 'RESET_PASSWORD', `Reset password for member ${memRes.rows[0].first_name} ${memRes.rows[0].last_name}`);
    res.json({ success: true, tempPassword: newTempPass });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- EVENTS API ---
app.get('/api/events', requireAuth(), async (req, res) => {
  const result = await pool.query('SELECT * FROM events ORDER BY event_date DESC, start_time DESC');
  res.json(result.rows);
});

app.post('/api/events', requireAuth('admin'), async (req, res) => {
  const { event_name, description, event_date, start_time, end_time, late_cutoff } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO events (event_name, description, event_date, start_time, end_time, late_cutoff)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [event_name, description, event_date, start_time, end_time, late_cutoff]);
    await logAudit(req, 'CREATE_EVENT', `Created event: ${event_name} on ${event_date}`);
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SCANNER & ATTENDANCE RECORDING ---
app.post('/api/scan', requireAuth(), async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body; // scan_type: 'TIME IN' or 'TIME OUT'
  const scannerUserId = req.session.user.id;
  const today = new Date().toISOString().split('T')[0];

  try {
    // 1. Validate QR Token format and lookup member
    const memRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memRes.rows.length === 0) {
      await pool.query(
        'INSERT INTO scanner_logs (scanner_user_id, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [scannerUserId, event_id, scan_type, qr_token, 'INVALID', 'QR Code not registered']
      );
      return res.status(400).json({ status: 'INVALID', message: 'This QR Code does not belong to a registered member.' });
    }

    const member = memRes.rows[0];
    if (member.status !== 'active') {
      return res.status(400).json({ status: 'INACTIVE', message: 'Member account is currently inactive.' });
    }

    // 2. Lookup Event details for Late cutoff
    const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    if (eventRes.rows.length === 0) {
      return res.status(400).json({ status: 'ERROR', message: 'Selected attendance event not found.' });
    }
    const event = eventRes.rows[0];

    // 3. Check existing attendance record for today & event
    let attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, today]);
    
    const nowTime = new Date().toTimeString().split(' ')[0]; // HH:MM:SS

    if (scan_type === 'TIME IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          status: 'DUPLICATE_IN',
          member,
          time_in: attRes.rows[0].time_in,
          message: `${member.first_name} ${member.last_name} already has a Time In record for this event.`
        });
      }

      // Calculate Present or Late status based on late_cutoff
      const status = nowTime > event.late_cutoff ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [nowTime, status, attRes.rows[0].id]);
      } else {
        await pool.query(
          'INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, $6)',
          [member.id, event_id, today, nowTime, status, 'QR']
        );
      }

      await pool.query(
        'INSERT INTO scanner_logs (scanner_user_id, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [scannerUserId, event_id, scan_type, qr_token, 'SUCCESS', `Time In recorded for ${member.member_id}`]
      );

      return res.json({ status: 'SUCCESS_IN', member, time_in: nowTime, attendance_status: status });

    } else if (scan_type === 'TIME OUT') {
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({
          status: 'NO_TIME_IN',
          member,
          message: `${member.first_name} ${member.last_name} has no Time In record yet for this event.`
        });
      }
      if (attRes.rows[0].time_out) {
        return res.json({
          status: 'DUPLICATE_OUT',
          member,
          time_out: attRes.rows[0].time_out,
          message: `${member.first_name} ${member.last_name} already timed out for this event.`
        });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [nowTime, attRes.rows[0].id]);
      await pool.query(
        'INSERT INTO scanner_logs (scanner_user_id, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [scannerUserId, event_id, scan_type, qr_token, 'SUCCESS', `Time Out recorded for ${member.member_id}`]
      );

      return res.json({ status: 'SUCCESS_OUT', member, time_out: nowTime });
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Attendance Logs for Admin/Scanner
app.get('/api/attendance/live', requireAuth(), async (req, res) => {
  const result = await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.member_id, m.grade_level, m.section, e.event_name
    FROM attendance a
    JOIN members m ON a.member_id = m.id
    JOIN events e ON a.event_id = e.id
    ORDER BY a.created_at DESC LIMIT 50
  `);
  res.json(result.rows);
});

// Member Portal Data endpoint
app.get('/api/member/profile', requireAuth('member'), async (req, res) => {
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const memRes = await pool.query('SELECT * FROM members WHERE user_id = $1', [req.session.user.id]);
    const settings = await pool.query('SELECT * FROM organization_settings LIMIT 1');
    const announcements = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5');

    const member = memRes.rows[0];
    const qrDataUrl = await QRCode.toDataURL(member.qr_token);

    // Attendance history for member
    const attendance = await pool.query(`
      SELECT a.*, e.event_name FROM attendance a 
      JOIN events e ON a.event_id = e.id 
      WHERE a.member_id = $1 ORDER BY a.attendance_date DESC
    `, [member.id]);

    res.json({
      user: userRes.rows[0],
      member,
      settings: settings.rows[0],
      qrDataUrl,
      announcements: announcements.rows,
      attendance: attendance.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Scanner Management
app.get('/api/scanners', requireAuth('admin'), async (req, res) => {
  const result = await pool.query("SELECT id, username, name, created_at FROM users WHERE role = 'scanner'");
  res.json(result.rows);
});

app.post('/api/scanners', requireAuth('admin'), async (req, res) => {
  const { name, username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, 'scanner', $3, FALSE) RETURNING id, username, name",
      [username, hashed, name]
    );
    await logAudit(req, 'CREATE_SCANNER', `Created scanner account: ${username}`);
    res.json({ success: true, scanner: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/scanners/:id', requireAuth('admin'), async (req, res) => {
  await pool.query("DELETE FROM users WHERE id = $1 AND role = 'scanner'", [req.params.id]);
  await logAudit(req, 'DELETE_SCANNER', `Deleted scanner account ID ${req.params.id}`);
  res.json({ success: true });
});

// Announcements
app.get('/api/announcements', requireAuth(), async (req, res) => {
  const result = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
  res.json(result.rows);
});

app.post('/api/announcements', requireAuth('admin'), async (req, res) => {
  const { title, message, expiration_date } = req.body;
  await pool.query('INSERT INTO announcements (title, message, expiration_date) VALUES ($1, $2, $3)', [title, message, expiration_date || null]);
  await logAudit(req, 'CREATE_ANNOUNCEMENT', `Created announcement: ${title}`);
  res.json({ success: true });
});

app.delete('/api/announcements/:id', requireAuth('admin'), async (req, res) => {
  await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Audit Logs endpoint
app.get('/api/audit-logs', requireAuth('admin'), async (req, res) => {
  const result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
  res.json(result.rows);
});

// --- FRONTEND VIEWS & SINGLE PAGE INTERFACE ---

app.get('/login', (req, res) => {
  res.send(getLoginPageHtml());
});

app.get('/change-password-forced', requireAuth(), (req, res) => {
  res.send(getForcedPasswordPageHtml());
});

app.get('/scanner', requireAuth(), (req, res) => {
  if (req.session.user.role === 'member') return res.redirect('/member');
  res.send(getScannerPortalHtml());
});

app.get('/member', requireAuth('member'), (req, res) => {
  res.send(getMemberPortalHtml());
});

app.get('/dashboard', requireAuth('admin'), (req, res) => {
  res.send(getAdminDashboardHtml());
});

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'admin') return res.redirect('/dashboard');
  if (req.session.user.role === 'scanner') return res.redirect('/scanner');
  return res.redirect('/member');
});

// --- HTML TEMPLATES GENERATOR FUNCTIONS ---

function getLoginPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - ClubTrack QR Attendance System</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-900 flex items-center justify-center min-h-screen">
  <div class="bg-slate-800 border border-slate-700 p-8 rounded-2xl shadow-2xl w-full max-w-md">
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-indigo-600 rounded-xl text-white text-2xl font-bold mb-4 shadow-lg shadow-indigo-500/30">
        <i class="fa-solid fa-qrcode"></i>
      </div>
      <h1 class="text-2xl font-black text-white tracking-wide">ClubTrack</h1>
      <p class="text-xs text-indigo-400 font-semibold uppercase tracking-wider mt-1">QR Attendance Management System</p>
    </div>

    <div id="errorBox" class="hidden mb-4 p-3 bg-rose-500/20 border border-rose-500 text-rose-300 text-sm rounded-lg"></div>

    <form id="loginForm" class="space-y-5">
      <div>
        <label class="block text-xs font-semibold uppercase text-slate-400 mb-2">Username</label>
        <div class="relative">
          <span class="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400"><i class="fa-solid fa-user"></i></span>
          <input type="text" id="username" required class="w-full pl-10 pr-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm" placeholder="Enter your username">
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold uppercase text-slate-400 mb-2">Password</label>
        <div class="relative">
          <span class="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400"><i class="fa-solid fa-lock"></i></span>
          <input type="password" id="password" required class="w-full pl-10 pr-12 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm" placeholder="Enter your password">
          <button type="button" onclick="togglePass()" class="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-white"><i id="eyeIcon" class="fa-solid fa-eye"></i></button>
        </div>
      </div>

      <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl shadow-lg shadow-indigo-600/30 transition duration-200">Sign In</button>
    </form>

    <div class="mt-8 text-center text-xs text-slate-500 border-t border-slate-700 pt-4">
      Default Admin: <span class="text-slate-300 font-mono">admin</span> / <span class="text-slate-300 font-mono">admin123</span>
    </div>
  </div>

  <script>
    function togglePass() {
      const p = document.getElementById('password');
      const icon = document.getElementById('eyeIcon');
      if (p.type === 'password') { p.type = 'text'; icon.className = 'fa-solid fa-eye-slash'; }
      else { p.type = 'password'; icon.className = 'fa-solid fa-eye'; }
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const errorBox = document.getElementById('errorBox');

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
          window.location.href = data.redirect;
        } else {
          errorBox.innerText = data.error || 'Login failed';
          errorBox.classList.remove('hidden');
        }
      } catch (err) {
        errorBox.innerText = 'Network error occurred.';
        errorBox.classList.remove('hidden');
      }
    });
  </script>
</body>
</html>`;
}

function getForcedPasswordPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Reminder - Password Change Required</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-900 flex items-center justify-center min-h-screen p-4">
  <div class="bg-slate-800 border border-slate-700 p-8 rounded-2xl shadow-2xl w-full max-w-lg">
    <div class="text-center mb-6">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-amber-500/20 text-amber-400 rounded-2xl text-2xl mb-3 border border-amber-500/40">
        <i class="fa-solid fa-shield-halved"></i>
      </div>
      <h1 class="text-xl font-bold text-white">IMPORTANT SECURITY REMINDER</h1>
      <p class="text-xs text-amber-400 mt-1 uppercase font-semibold">Temporary Password Change Required</p>
    </div>

    <div class="bg-slate-900 border border-slate-700 p-4 rounded-xl text-slate-300 text-xs mb-6 space-y-2">
      <p>Welcome! Your account is currently using a temporary password provided by the Organization Administrator.</p>
      <p>For your security, you are required to change your password before accessing your Portal. Please create a new private password and do not share it with anyone.</p>
    </div>

    <div id="errorBox" class="hidden mb-4 p-3 bg-rose-500/20 border border-rose-500 text-rose-300 text-xs rounded-lg"></div>

    <form id="passForm" class="space-y-4">
      <div>
        <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Current Temporary Password</label>
        <input type="password" id="currentPassword" required class="w-full px-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:border-indigo-500">
      </div>
      <div>
        <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">New Password (Min 8 Characters)</label>
        <input type="password" id="newPassword" required minlength="8" class="w-full px-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:border-indigo-500">
      </div>
      <div>
        <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Confirm New Password</label>
        <input type="password" id="confirmPassword" required minlength="8" class="w-full px-4 py-3 bg-slate-900 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:border-indigo-500">
      </div>
      <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition shadow-lg shadow-indigo-600/30">Update Password & Secure Account</button>
    </form>
  </div>

  <script>
    document.getElementById('passForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('currentPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;
      const errorBox = document.getElementById('errorBox');

      if (newPassword !== confirmPassword) {
        errorBox.innerText = 'New passwords do not match.';
        errorBox.classList.remove('hidden');
        return;
      }

      try {
        const res = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (res.ok) {
          alert('Password successfully changed! Your account is now secured.');
          window.location.href = '/';
        } else {
          errorBox.innerText = data.error || 'Password update failed';
          errorBox.classList.remove('hidden');
        }
      } catch (err) {
        errorBox.innerText = 'Network error occurred.';
        errorBox.classList.remove('hidden');
      }
    });
  </script>
</body>
</html>`;
}

function getScannerPortalHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scanner Portal - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <script src="https://unpkg.com/html5-qrcode"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">
  <!-- Top Navigation -->
  <header class="bg-slate-900 border-b border-slate-800 px-4 py-3 flex justify-between items-center">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white"><i class="fa-solid fa-qrcode"></i></div>
      <div>
        <h1 class="font-bold text-sm">ClubTrack Scanner</h1>
        <p class="text-[10px] text-slate-400">Mobile Attendance Terminal</p>
      </div>
    </div>
    <div class="flex items-center space-x-3">
      <button onclick="toggleSound()" id="soundBtn" class="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs font-semibold text-emerald-400"><i class="fa-solid fa-volume-high mr-1"></i> Sound: ON</button>
      <a href="/logout" class="px-3 py-1.5 bg-rose-600/20 border border-rose-500/40 text-rose-300 rounded-lg text-xs font-semibold"><i class="fa-solid fa-right-from-bracket"></i></a>
    </div>
  </header>

  <!-- Main Scanner Content Container -->
  <main class="flex-1 max-w-lg w-full mx-auto p-4 space-y-4">
    <!-- Step 1: Select Event -->
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl space-y-3">
      <label class="block text-xs font-bold uppercase tracking-wider text-indigo-400">1. Select Attendance Event</label>
      <select id="eventSelect" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500"></select>
    </div>

    <!-- Step 2: Select Scan Type -->
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl space-y-3">
      <label class="block text-xs font-bold uppercase tracking-wider text-indigo-400">2. Select Scan Mode</label>
      <div class="grid grid-cols-2 gap-3">
        <button onclick="setScanType('TIME IN')" id="btnTimeIn" class="py-4 px-4 rounded-xl border-2 font-black text-sm transition flex flex-col items-center justify-center space-y-1 bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/30">
          <i class="fa-solid fa-arrow-right-to-bracket text-lg"></i>
          <span>TIME IN</span>
        </button>
        <button onclick="setScanType('TIME OUT')" id="btnTimeOut" class="py-4 px-4 rounded-xl border-2 font-black text-sm transition flex flex-col items-center justify-center space-y-1 bg-slate-950 text-slate-400 border-slate-800">
          <i class="fa-solid fa-arrow-right-from-bracket text-lg"></i>
          <span>TIME OUT</span>
        </button>
      </div>
    </div>

    <!-- Step 3: Camera Scanner Container -->
    <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl shadow-xl space-y-3">
      <div class="flex justify-between items-center">
        <label class="block text-xs font-bold uppercase tracking-wider text-indigo-400">3. Camera QR Scanner</label>
        <button onclick="startScanner()" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg shadow"><i class="fa-solid fa-camera mr-1"></i> Start Camera</button>
      </div>
      <div id="reader" class="w-full overflow-hidden rounded-xl bg-slate-950 border border-slate-800 min-h-[250px] flex items-center justify-center text-slate-500 text-xs">
        Camera inactive. Click "Start Camera".
      </div>
    </div>

    <!-- Scan Result Card Popup / Feedback Area -->
    <div id="scanResultCard" class="hidden p-6 rounded-2xl border text-center space-y-3 shadow-2xl transition duration-300">
      <div id="resultIcon" class="text-4xl"></div>
      <h2 id="resultTitle" class="text-xl font-black"></h2>
      <div id="resultBody" class="text-sm space-y-1"></div>
    </div>
  </main>

  <script>
    let currentScanType = 'TIME IN';
    let soundEnabled = true;
    let html5QrCode = null;
    let isProcessing = false;

    // Web Audio API Sound Generator
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    function playBeep(type) {
      if (!soundEnabled) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'success') {
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.1); // A5
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
      } else if (type === 'error') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, audioCtx.currentTime);
        osc.frequency.setValueAtTime(100, audioCtx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
      } else if (type === 'warning') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(300, audioCtx.currentTime);
        osc.frequency.setValueAtTime(250, audioCtx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.35);
      }
    }

    function toggleSound() {
      soundEnabled = !soundEnabled;
      const btn = document.getElementById('soundBtn');
      if (soundEnabled) {
        btn.className = 'px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs font-semibold text-emerald-400';
        btn.innerHTML = '<i class="fa-solid fa-volume-high mr-1"></i> Sound: ON';
      } else {
        btn.className = 'px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs font-semibold text-rose-400';
        btn.innerHTML = '<i class="fa-solid fa-volume-xmark mr-1"></i> Sound: OFF';
      }
    }

    function setScanType(type) {
      currentScanType = type;
      const btnIn = document.getElementById('btnTimeIn');
      const btnOut = document.getElementById('btnTimeOut');
      if (type === 'TIME IN') {
        btnIn.className = 'py-4 px-4 rounded-xl border-2 font-black text-sm transition flex flex-col items-center justify-center space-y-1 bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/30';
        btnOut.className = 'py-4 px-4 rounded-xl border-2 font-black text-sm transition flex flex-col items-center justify-center space-y-1 bg-slate-950 text-slate-400 border-slate-800';
      } else {
        btnOut.className = 'py-4 px-4 rounded-xl border-2 font-black text-sm transition flex flex-col items-center justify-center space-y-1 bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-600/30';
        btnIn.className = 'py-4 px-4 rounded-xl border-2 font-black text-sm transition flex flex-col items-center justify-center space-y-1 bg-slate-950 text-slate-400 border-slate-800';
      }
    }

    async function loadEvents() {
      const res = await fetch('/api/events');
      const events = await res.json();
      const select = document.getElementById('eventSelect');
      select.innerHTML = '';
      if (events.length === 0) {
        select.innerHTML = '<option value="">No events found. Please create one in Admin Portal.</option>';
        return;
      }
      events.forEach(ev => {
        const opt = document.createElement('option');
        opt.value = ev.id;
        opt.textContent = \`\${ev.event_name} (\${ev.event_date})\`;
        select.appendChild(opt);
      });
    }

    async function startScanner() {
      const eventId = document.getElementById('eventSelect').value;
      if (!eventId) {
        alert('Please select an attendance event first.');
        return;
      }

      if (html5QrCode) {
        try { await html5QrCode.stop(); } catch(e){}
      }

      html5QrCode = new Html5Qrcode("reader");
      const config = { fps: 10, qrbox: { width: 250, height: 250 } };
      
      try {
        await html5QrCode.start(
          { facingMode: "environment" },
          config,
          onScanSuccess,
          onScanFailure
        );
      } catch (err) {
        alert('Camera permission denied or unavailable: ' + err);
      }
    }

    async function onScanSuccess(decodedText) {
      if (isProcessing) return;
      const eventId = document.getElementById('eventSelect').value;
      if (!eventId) return;

      isProcessing = true;
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: currentScanType })
        });
        const data = await res.json();
        const card = document.getElementById('scanResultCard');
        const icon = document.getElementById('resultIcon');
        const title = document.getElementById('resultTitle');
        const body = document.getElementById('resultBody');

        card.classList.remove('hidden');

        if (data.status === 'SUCCESS_IN' || data.status === 'SUCCESS_OUT') {
          playBeep('success');
          card.className = 'p-6 rounded-2xl border bg-emerald-950/60 border-emerald-500 text-center space-y-3 shadow-2xl';
          icon.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
          title.className = 'text-xl font-black text-emerald-300';
          title.innerText = currentScanType + ' RECORDED';
          body.innerHTML = \`<p class="text-base font-bold text-white">\${data.member.first_name} \${data.member.last_name}</p>
                            <p class="text-xs text-slate-300">ID: \${data.member.member_id} | Grade \${data.member.grade_level} - \${data.member.section}</p>
                            <p class="text-xs font-mono text-emerald-400 mt-2">Time: \${data.time_in || data.time_out}</p>\`;
        } else if (data.status === 'DUPLICATE_IN' || data.status === 'DUPLICATE_OUT') {
          playBeep('warning');
          card.className = 'p-6 rounded-2xl border bg-amber-950/60 border-amber-500 text-center space-y-3 shadow-2xl';
          icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-amber-400"></i>';
          title.className = 'text-xl font-black text-amber-300';
          title.innerText = 'ALREADY RECORDED';
          body.innerHTML = \`<p class="text-base font-bold text-white">\${data.member.first_name} \${data.member.last_name}</p>
                            <p class="text-xs text-slate-300">\${data.message}</p>\`;
        } else {
          playBeep('error');
          card.className = 'p-6 rounded-2xl border bg-rose-950/60 border-rose-500 text-center space-y-3 shadow-2xl';
          icon.innerHTML = '<i class="fa-solid fa-circle-xmark text-rose-400"></i>';
          title.className = 'text-xl font-black text-rose-300';
          title.innerText = 'QR CODE NOT REGISTERED';
          body.innerHTML = \`<p class="text-xs text-slate-300">\${data.message || 'This QR Code does not belong to a registered member.'}</p>\`;
        }

        setTimeout(() => {
          card.classList.add('hidden');
          isProcessing = false;
        }, 3500);

      } catch (err) {
        isProcessing = false;
      }
    }

    function onScanFailure(error) {
      // Ignore routine scan frames missing qr code
    }

    loadEvents();
  </script>
</body>
</html>`;
}

function getMemberPortalHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Member Portal - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen">
  <nav class="bg-slate-900 border-b border-slate-800 px-6 py-4 flex justify-between items-center">
    <div class="flex items-center space-x-3">
      <div id="orgLogoContainer" class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center font-bold text-white shadow"><i class="fa-solid fa-graduation-cap"></i></div>
      <div>
        <h1 id="navOrgName" class="font-bold text-sm">ClubTrack Member Portal</h1>
        <p id="navSchoolName" class="text-xs text-slate-400">High School Student Organization</p>
      </div>
    </div>
    <div class="flex items-center space-x-4">
      <span id="memberNameDisplay" class="text-xs font-semibold text-slate-300"></span>
      <a href="/logout" class="px-3 py-1.5 bg-rose-600/20 border border-rose-500/40 text-rose-300 rounded-lg text-xs font-semibold"><i class="fa-solid fa-right-from-bracket mr-1"></i> Logout</a>
    </div>
  </nav>

  <main class="max-w-5xl mx-auto p-6 space-y-6">
    <!-- Profile & Digital ID Card Grid -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Member Info Overview -->
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
        <div class="text-center space-y-2">
          <div id="memberPhotoBox" class="w-24 h-24 bg-slate-800 border-2 border-indigo-500 rounded-full mx-auto flex items-center justify-center text-3xl font-bold text-indigo-400 overflow-hidden shadow-lg">
            <i class="fa-solid fa-user"></i>
          </div>
          <h2 id="fullNameDisplay" class="text-lg font-black text-white"></h2>
          <p id="memberIdDisplay" class="text-xs font-mono text-indigo-400 bg-indigo-950/50 py-1 px-3 rounded-full inline-block border border-indigo-800/50"></p>
        </div>
        <div class="border-t border-slate-800 pt-4 space-y-2 text-xs text-slate-300">
          <div class="flex justify-between"><span class="text-slate-500">Grade & Section:</span> <span id="gradeSectionDisplay" class="font-semibold"></span></div>
          <div class="flex justify-between"><span class="text-slate-500">Position:</span> <span id="positionDisplay" class="font-semibold"></span></div>
          <div class="flex justify-between"><span class="text-slate-500">Username:</span> <span id="usernameDisplay" class="font-semibold font-mono"></span></div>
          <div class="flex justify-between"><span class="text-slate-500">Account Status:</span> <span id="statusDisplay" class="font-semibold uppercase text-emerald-400"></span></div>
        </div>
      </div>

      <!-- Standard Size Digital ID Card Preview & Actions -->
      <div class="md:col-span-2 bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl flex flex-col justify-between">
        <div>
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-400"><i class="fa-solid id-card mr-1"></i> Digital Organization ID Card (Standard Size)</h3>
            <span class="text-[10px] text-slate-500">Official High School Badge</span>
          </div>

          <!-- Standard Printable ID Card Box -->
          <div id="idCardPrintArea" class="bg-gradient-to-br from-slate-950 to-slate-900 border-2 border-indigo-500/50 rounded-2xl p-6 max-w-sm mx-auto shadow-2xl relative overflow-hidden text-center space-y-3">
            <div class="absolute top-0 left-0 right-0 h-2 bg-indigo-600"></div>
            <p id="idSchoolName" class="text-[11px] font-black uppercase text-slate-400 tracking-widest"></p>
            <p id="idOrgName" class="text-sm font-black text-white"></p>
            <p class="text-[10px] font-semibold uppercase text-indigo-400 bg-indigo-950 py-0.5 px-2 rounded inline-block">Member Identification Card</p>

            <div id="idCardPhoto" class="w-20 h-20 bg-slate-800 border-2 border-indigo-400 rounded-full mx-auto flex items-center justify-center text-2xl text-indigo-300 overflow-hidden my-2 shadow">
              <i class="fa-solid fa-user"></i>
            </div>

            <h4 id="idCardName" class="text-base font-black text-white"></h4>
            <div class="text-xs space-y-0.5 text-slate-300">
              <p><span class="text-slate-500">ID:</span> <span id="idCardMemberId" class="font-mono font-bold text-indigo-300"></span></p>
              <p><span class="text-slate-500">Grade & Section:</span> <span id="idCardGrade"></span></p>
              <p><span class="text-slate-500">Position:</span> <span id="idCardPosition"></span></p>
            </div>

            <div class="pt-2 flex justify-center">
              <img id="idCardQrImg" class="w-24 h-24 bg-white p-1 rounded-xl shadow" src="" alt="QR">
            </div>
            <p class="text-[9px] text-slate-500 italic">Property of the school organization.</p>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="mt-6 flex flex-wrap gap-3 justify-center">
          <button onclick="printIdCard()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow"><i class="fa-solid fa-print mr-1"></i> Print ID Card</button>
          <button onclick="downloadIdCard()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold rounded-xl shadow"><i class="fa-solid fa-download mr-1"></i> Save ID Image</button>
        </div>
      </div>
    </div>

    <!-- Attendance History & Announcements -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
        <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-400">My Attendance History</h3>
        <div class="overflow-x-auto max-h-60 overflow-y-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-950 text-slate-400 sticky top-0">
              <tr>
                <th class="p-2">Date</th>
                <th class="p-2">Event</th>
                <th class="p-2">Time In</th>
                <th class="p-2">Time Out</th>
                <th class="p-2">Status</th>
              </tr>
            </thead>
            <tbody id="attendanceTableBody" class="divide-y divide-slate-800 text-slate-300"></tbody>
          </table>
        </div>
      </div>

      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-xl space-y-4">
        <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-400">Organization Announcements</h3>
        <div id="announcementsList" class="space-y-3 max-h-60 overflow-y-auto text-xs"></div>
      </div>
    </div>
  </main>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
  <script>
    async function loadProfile() {
      const res = await fetch('/api/member/profile');
      const data = await res.json();
      const { user, member, settings, qrDataUrl, announcements, attendance } = data;

      document.getElementById('navOrgName').innerText = settings.org_name;
      document.getElementById('navSchoolName').innerText = settings.school_name;
      document.getElementById('memberNameDisplay').innerText = user.name;

      document.getElementById('fullNameDisplay').innerText = member.first_name + ' ' + member.last_name;
      document.getElementById('memberIdDisplay').innerText = member.member_id;
      document.getElementById('gradeSectionDisplay').innerText = 'Grade ' + member.grade_level + ' - ' + member.section;
      document.getElementById('positionDisplay').innerText = member.position;
      document.getElementById('usernameDisplay').innerText = user.username;
      document.getElementById('statusDisplay').innerText = member.status;

      if (member.profile_photo) {
        document.getElementById('memberPhotoBox').innerHTML = \`<img src="\${member.profile_photo}" class="w-full h-full object-cover">\`;
        document.getElementById('idCardPhoto').innerHTML = \`<img src="\${member.profile_photo}" class="w-full h-full object-cover">\`;
      }

      document.getElementById('idSchoolName').innerText = settings.school_name;
      document.getElementById('idOrgName').innerText = settings.org_name;
      document.getElementById('idCardName').innerText = member.first_name + ' ' + member.last_name;
      document.getElementById('idCardMemberId').innerText = member.member_id;
      document.getElementById('idCardGrade').innerText = 'Grade ' + member.grade_level + ' - ' + member.section;
      document.getElementById('idCardPosition').innerText = member.position;
      document.getElementById('idCardQrImg').src = qrDataUrl;

      // Attendance history
      const tbody = document.getElementById('attendanceTableBody');
      tbody.innerHTML = '';
      if (attendance.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">No attendance records found yet.</td></tr>';
      } else {
        attendance.forEach(att => {
          tbody.innerHTML += \`<tr>
            <td class="p-2">\${att.attendance_date}</td>
            <td class="p-2 font-semibold">\${att.event_name}</td>
            <td class="p-2 font-mono text-emerald-400">\${att.time_in || '—'}</td>
            <td class="p-2 font-mono text-amber-400">\${att.time_out || '—'}</td>
            <td class="p-2"><span class="px-2 py-0.5 rounded text-[10px] bg-indigo-950 text-indigo-300 border border-indigo-800">\${att.status}</span></td>
          </tr>\`;
        });
      }

      // Announcements
      const annList = document.getElementById('announcementsList');
      annList.innerHTML = '';
      if (announcements.length === 0) {
        annList.innerHTML = '<p class="text-slate-500">No announcements posted.</p>';
      } else {
        announcements.forEach(ann => {
          annList.innerHTML += \`<div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
            <h4 class="font-bold text-white">\${ann.title}</h4>
            <p class="text-slate-300">\${ann.message}</p>
            <span class="text-[10px] text-slate-500">\${new Date(ann.created_at).toLocaleDateString()}</span>
          </div>\`;
        });
      }
    }

    function printIdCard() {
      const printContents = document.getElementById('idCardPrintArea').innerHTML;
      const originalContents = document.body.innerHTML;
      document.body.innerHTML = \`<div style="display:flex; justify-content:center; align-items:center; height:100vh; background:white;"><div style="border:2px solid #000; padding:20px; border-radius:12px; text-align:center; width:320px;">\${printContents}</div></div>\`;
      window.print();
      document.body.innerHTML = originalContents;
      window.location.reload();
    }

    function downloadIdCard() {
      const card = document.getElementById('idCardPrintArea');
      html2canvas(card, { scale: 3 }).then(canvas => {
        const link = document.createElement('a');
        link.download = 'ClubTrack_IDCard.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      });
    }

    loadProfile();
  </script>
</body>
</html>`;
}

function getAdminDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex">
  <!-- Sidebar -->
  <aside class="w-64 bg-slate-900 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div class="p-6 space-y-6">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white font-bold"><i class="fa-solid fa-qrcode"></i></div>
        <div>
          <h1 class="font-bold text-sm">ClubTrack</h1>
          <p class="text-[10px] text-indigo-400 font-semibold uppercase">Admin Portal</p>
        </div>
      </div>

      <nav class="space-y-1 text-xs font-semibold">
        <button onclick="switchTab('dashboardTab')" id="nav-dashboardTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl bg-indigo-600 text-white shadow"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></button>
        <button onclick="switchTab('membersTab')" id="nav-membersTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"><i class="fa-solid fa-users w-5"></i><span>Manage Members</span></button>
        <button onclick="switchTab('eventsTab')" id="nav-eventsTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"><i class="fa-solid fa-calendar-days w-5"></i><span>Events Management</span></button>
        <button onclick="switchTab('attendanceTab')" id="nav-attendanceTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"><i class="fa-solid fa-clipboard-user w-5"></i><span>Live Attendance</span></button>
        <button onclick="switchTab('scannersTab')" id="nav-scannersTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"><i class="fa-solid fa-mobile-screen w-5"></i><span>Scanner Accounts</span></button>
        <button onclick="switchTab('announcementsTab')" id="nav-announcementsTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></button>
        <button onclick="switchTab('settingsTab')" id="nav-settingsTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"><i class="fa-solid fa-gear w-5"></i><span>Organization Settings</span></button>
        <button onclick="switchTab('logsTab')" id="nav-logsTab" class="w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition"><i class="fa-solid fa-shield-halved w-5"></i><span>System Audit Logs</span></button>
      </nav>
    </div>

    <div class="p-4 border-t border-slate-800">
      <a href="/logout" class="w-full flex items-center justify-center space-x-2 py-2.5 bg-rose-600/20 border border-rose-500/40 text-rose-300 rounded-xl text-xs font-semibold"><i class="fa-solid fa-right-from-bracket"></i><span>Logout</span></a>
    </div>
  </aside>

  <!-- Main Content Area -->
  <main class="flex-1 flex flex-col h-screen overflow-y-auto">
    <header class="bg-slate-900 border-b border-slate-800 px-6 py-4 flex justify-between items-center sticky top-0 z-10">
      <h2 id="currentHeaderTitle" class="font-bold text-base">Dashboard Overview</h2>
      <div class="flex items-center space-x-3">
        <a href="/scanner" target="_blank" class="px-3 py-1.5 bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 rounded-lg text-xs font-semibold"><i class="fa-solid fa-qrcode mr-1"></i> Open Scanner Terminal</a>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <!-- TAB 1: DASHBOARD -->
      <div id="dashboardTab" class="tab-content space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow">
            <p class="text-xs font-bold uppercase text-slate-400">Total Members</p>
            <h3 id="statTotalMembers" class="text-2xl font-black text-white mt-1">0</h3>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow">
            <p class="text-xs font-bold uppercase text-slate-400">Present Today</p>
            <h3 id="statPresentToday" class="text-2xl font-black text-emerald-400 mt-1">0</h3>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow">
            <p class="text-xs font-bold uppercase text-slate-400">Late Today</p>
            <h3 id="statLateToday" class="text-2xl font-black text-amber-400 mt-1">0</h3>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl shadow">
            <p class="text-xs font-bold uppercase text-slate-400">Invalid QR Scans</p>
            <h3 id="statInvalidScans" class="text-2xl font-black text-rose-400 mt-1">0</h3>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow">
          <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-400 mb-4">Live Activity Monitor</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-950 text-slate-400">
                <tr>
                  <th class="p-3">Time</th>
                  <th class="p-3">Member Name</th>
                  <th class="p-3">ID</th>
                  <th class="p-3">Event</th>
                  <th class="p-3">Grade & Section</th>
                  <th class="p-3">Status</th>
                </tr>
              </thead>
              <tbody id="liveAttendanceTable" class="divide-y divide-slate-800 text-slate-300"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 2: MEMBERS MANAGEMENT -->
      <div id="membersTab" class="tab-content hidden space-y-6">
        <div class="flex justify-between items-center">
          <h3 class="text-sm font-bold uppercase text-indigo-400">Registered Members Directory</h3>
          <button onclick="openAddMemberModal()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow"><i class="fa-solid fa-user-plus mr-1"></i> Register New Member</button>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow space-y-4">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-950 text-slate-400">
                <tr>
                  <th class="p-3">Member ID</th>
                  <th class="p-3">Full Name</th>
                  <th class="p-3">Username</th>
                  <th class="p-3">Grade & Section</th>
                  <th class="p-3">Position</th>
                  <th class="p-3">Status</th>
                  <th class="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody id="membersTableBody" class="divide-y divide-slate-800 text-slate-300"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 3: EVENTS MANAGEMENT -->
      <div id="eventsTab" class="tab-content hidden space-y-6">
        <div class="flex justify-between items-center">
          <h3 class="text-sm font-bold uppercase text-indigo-400">Attendance Events</h3>
          <button onclick="openAddEventModal()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow"><i class="fa-solid fa-calendar-plus mr-1"></i> Create Event</button>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-950 text-slate-400">
                <tr>
                  <th class="p-3">Event Name</th>
                  <th class="p-3">Date</th>
                  <th class="p-3">Start Time</th>
                  <th class="p-3">End Time</th>
                  <th class="p-3">Late Cutoff</th>
                </tr>
              </thead>
              <tbody id="eventsTableBody" class="divide-y divide-slate-800 text-slate-300"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 4: LIVE ATTENDANCE -->
      <div id="attendanceTab" class="tab-content hidden space-y-6">
        <h3 class="text-sm font-bold uppercase text-indigo-400">Complete Attendance Logs</h3>
        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-950 text-slate-400">
                <tr>
                  <th class="p-3">Date</th>
                  <th class="p-3">Member</th>
                  <th class="p-3">Event</th>
                  <th class="p-3">Time In</th>
                  <th class="p-3">Time Out</th>
                  <th class="p-3">Status</th>
                </tr>
              </thead>
              <tbody id="fullAttendanceTableBody" class="divide-y divide-slate-800 text-slate-300"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TAB 5: SCANNER ACCOUNTS -->
      <div id="scannersTab" class="tab-content hidden space-y-6">
        <div class="flex justify-between items-center">
          <h3 class="text-sm font-bold uppercase text-indigo-400">Authorized Scanner Officers</h3>
          <button onclick="openAddScannerModal()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow"><i class="fa-solid fa-user-shield mr-1"></i> Add Scanner Account</button>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-950 text-slate-400">
              <tr>
                <th class="p-3">Name</th>
                <th class="p-3">Username</th>
                <th class="p-3">Created</th>
                <th class="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody id="scannersTableBody" class="divide-y divide-slate-800 text-slate-300"></tbody>
          </table>
        </div>
      </div>

      <!-- TAB 6: ANNOUNCEMENTS -->
      <div id="announcementsTab" class="tab-content hidden space-y-6">
        <div class="flex justify-between items-center">
          <h3 class="text-sm font-bold uppercase text-indigo-400">Announcements</h3>
          <button onclick="openAddAnnouncementModal()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow"><i class="fa-solid fa-bullhorn mr-1"></i> Post Announcement</button>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow">
          <div id="adminAnnouncementsList" class="space-y-4 text-xs"></div>
        </div>
      </div>

      <!-- TAB 7: ORGANIZATION SETTINGS -->
      <div id="settingsTab" class="tab-content hidden space-y-6">
        <h3 class="text-sm font-bold uppercase text-indigo-400">Organization Profile & Branding</h3>
        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow max-w-2xl">
          <form id="settingsForm" class="space-y-4 text-xs">
            <div>
              <label class="block font-semibold uppercase text-slate-400 mb-1">School Name</label>
              <input type="text" id="setSchoolName" required class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white">
            </div>
            <div>
              <label class="block font-semibold uppercase text-slate-400 mb-1">Organization Name</label>
              <input type="text" id="setOrgName" required class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white">
            </div>
            <div>
              <label class="block font-semibold uppercase text-slate-400 mb-1">School Year</label>
              <input type="text" id="setSchoolYear" required class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white">
            </div>
            <div>
              <label class="block font-semibold uppercase text-slate-400 mb-1">Member ID Prefix</label>
              <input type="text" id="setOrgPrefix" required class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white uppercase">
            </div>
            <div>
              <label class="block font-semibold uppercase text-slate-400 mb-1">Organization Description</label>
              <textarea id="setOrgDesc" rows="3" class="w-full px-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></textarea>
            </div>
            <button type="submit" class="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl shadow">Save Settings</button>
          </form>
        </div>
      </div>

      <!-- TAB 8: AUDIT LOGS -->
      <div id="logsTab" class="tab-content hidden space-y-6">
        <h3 class="text-sm font-bold uppercase text-indigo-400">System Audit Logs</h3>
        <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow">
          <div class="overflow-x-auto max-h-96 overflow-y-auto">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-950 text-slate-400 sticky top-0">
                <tr>
                  <th class="p-3">Timestamp</th>
                  <th class="p-3">Username</th>
                  <th class="p-3">Role</th>
                  <th class="p-3">Action</th>
                  <th class="p-3">Details</th>
                </tr>
              </thead>
              <tbody id="auditLogsTableBody" class="divide-y divide-slate-800 text-slate-300"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- MODALS -->
  <div id="modalOverlay" class="fixed inset-0 bg-black/70 backdrop-blur-sm hidden items-center justify-center z-50 p-4">
    <!-- Add Member Modal -->
    <div id="addMemberModal" class="modal-box hidden bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-lg space-y-4 text-xs">
      <h3 class="text-sm font-bold uppercase text-indigo-400">Register New Organization Member</h3>
      <form id="addMemberForm" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block text-slate-400 mb-1 font-semibold">First Name</label><input type="text" id="mFirst" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
          <div><label class="block text-slate-400 mb-1 font-semibold">Last Name</label><input type="text" id="mLast" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block text-slate-400 mb-1 font-semibold">Grade Level</label><input type="text" id="mGrade" placeholder="Grade 10" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
          <div><label class="block text-slate-400 mb-1 font-semibold">Section</label><input type="text" id="mSection" placeholder="Rizal" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block text-slate-400 mb-1 font-semibold">Position</label><input type="text" id="mPosition" value="Member" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
          <div><label class="block text-slate-400 mb-1 font-semibold">Gender</label><select id="mGender" class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"><option>Male</option><option>Female</option></select></div>
        </div>
        <div class="flex justify-end space-x-2 pt-2">
          <button type="button" onclick="closeModal()" class="px-4 py-2 bg-slate-800 rounded-xl text-slate-300">Cancel</button>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white font-bold rounded-xl">Save & Register</button>
        </div>
      </form>
    </div>

    <!-- Credentials Result Modal -->
    <div id="credentialsModal" class="modal-box hidden bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-md space-y-4 text-xs text-center">
      <div class="inline-flex w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full items-center justify-center text-xl mb-1"><i class="fa-solid fa-check"></i></div>
      <h3 class="text-sm font-bold uppercase text-emerald-400">Member Successfully Registered</h3>
      <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 text-left space-y-2">
        <p><span class="text-slate-500">Full Name:</span> <span id="credName" class="text-white font-bold"></span></p>
        <p><span class="text-slate-500">Member ID:</span> <span id="credMemberId" class="text-indigo-400 font-mono font-bold"></span></p>
        <p><span class="text-slate-500">Username:</span> <span id="credUsername" class="text-white font-mono font-bold"></span></p>
        <p><span class="text-slate-500">Temporary Password:</span> <span id="credPassword" class="text-amber-400 font-mono font-bold"></span></p>
      </div>
      <p class="text-[10px] text-slate-400">Give these login credentials securely to the member. The temporary password will not be shown again.</p>
      <button onclick="closeModal()" class="w-full py-2.5 bg-indigo-600 text-white font-bold rounded-xl">Done</button>
    </div>

    <!-- Add Event Modal -->
    <div id="addEventModal" class="modal-box hidden bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-md space-y-4 text-xs">
      <h3 class="text-sm font-bold uppercase text-indigo-400">Create Attendance Event</h3>
      <form id="addEventForm" class="space-y-3">
        <div><label class="block text-slate-400 mb-1">Event Name</label><input type="text" id="eName" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        <div><label class="block text-slate-400 mb-1">Event Date</label><input type="date" id="eDate" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        <div class="grid grid-cols-3 gap-2">
          <div><label class="block text-slate-400 mb-1">Start Time</label><input type="time" id="eStart" required class="w-full p-2 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
          <div><label class="block text-slate-400 mb-1">End Time</label><input type="time" id="eEnd" required class="w-full p-2 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
          <div><label class="block text-slate-400 mb-1">Late Cutoff</label><input type="time" id="eCutoff" required class="w-full p-2 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        </div>
        <div class="flex justify-end space-x-2 pt-2">
          <button type="button" onclick="closeModal()" class="px-4 py-2 bg-slate-800 rounded-xl text-slate-300">Cancel</button>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white font-bold rounded-xl">Create Event</button>
        </div>
      </form>
    </div>

    <!-- Add Scanner Modal -->
    <div id="addScannerModal" class="modal-box hidden bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-md space-y-4 text-xs">
      <h3 class="text-sm font-bold uppercase text-indigo-400">Create Scanner Officer Account</h3>
      <form id="addScannerForm" class="space-y-3">
        <div><label class="block text-slate-400 mb-1">Officer Name</label><input type="text" id="sName" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        <div><label class="block text-slate-400 mb-1">Username</label><input type="text" id="sUsername" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        <div><label class="block text-slate-400 mb-1">Password</label><input type="password" id="sPassword" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        <div class="flex justify-end space-x-2 pt-2">
          <button type="button" onclick="closeModal()" class="px-4 py-2 bg-slate-800 rounded-xl text-slate-300">Cancel</button>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white font-bold rounded-xl">Create Scanner</button>
        </div>
      </form>
    </div>

    <!-- Add Announcement Modal -->
    <div id="addAnnouncementModal" class="modal-box hidden bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-md space-y-4 text-xs">
      <h3 class="text-sm font-bold uppercase text-indigo-400">Post Announcement</h3>
      <form id="addAnnouncementForm" class="space-y-3">
        <div><label class="block text-slate-400 mb-1">Title</label><input type="text" id="aTitle" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></div>
        <div><label class="block text-slate-400 mb-1">Message</label><textarea id="aMsg" rows="3" required class="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-white"></textarea></div>
        <div class="flex justify-end space-x-2 pt-2">
          <button type="button" onclick="closeModal()" class="px-4 py-2 bg-slate-800 rounded-xl text-slate-300">Cancel</button>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white font-bold rounded-xl">Publish</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
      document.getElementById(tabId).classList.remove('hidden');

      document.querySelectorAll('aside nav button').forEach(btn => {
        btn.className = 'w-full flex items-center space-x-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white transition';
      });
      document.getElementById('nav-' + tabId).className = 'w-full flex items-center space-x-3 px-4 py-3 rounded-xl bg-indigo-600 text-white shadow';

      if (tabId === 'dashboardTab') loadDashboard();
      if (tabId === 'membersTab') loadMembers();
      if (tabId === 'eventsTab') loadEvents();
      if (tabId === 'attendanceTab') loadLiveAttendance();
      if (tabId === 'scannersTab') loadScanners();
      if (tabId === 'announcementsTab') loadAnnouncements();
      if (tabId === 'settingsTab') loadSettings();
      if (tabId === 'logsTab') loadLogs();
    }

    function openModal(boxId) {
      document.getElementById('modalOverlay').classList.remove('hidden');
      document.getElementById('modalOverlay').classList.add('flex');
      document.querySelectorAll('.modal-box').forEach(b => b.classList.add('hidden'));
      document.getElementById(boxId).classList.remove('hidden');
    }
    function closeModal() {
      document.getElementById('modalOverlay').classList.add('hidden');
      document.getElementById('modalOverlay').classList.remove('flex');
    }

    function openAddMemberModal() { openModal('addMemberModal'); }
    function openAddEventModal() { openModal('addEventModal'); }
    function openAddScannerModal() { openModal('addScannerModal'); }
    function openAddAnnouncementModal() { openModal('addAnnouncementModal'); }

    async function loadDashboard() {
      const statsRes = await fetch('/api/admin/stats');
      const stats = await statsRes.json();
      document.getElementById('statTotalMembers').innerText = stats.totalMembers;
      document.getElementById('statPresentToday').innerText = stats.presentToday;
      document.getElementById('statLateToday').innerText = stats.lateToday;
      document.getElementById('statInvalidScans').innerText = stats.invalidScans;

      const liveRes = await fetch('/api/attendance/live');
      const logs = await liveRes.json();
      const tbody = document.getElementById('liveAttendanceTable');
      tbody.innerHTML = '';
      logs.slice(0, 10).forEach(l => {
        tbody.innerHTML += \`<tr>
          <td class="p-3 font-mono text-slate-400">\${l.created_at ? new Date(l.created_at).toLocaleTimeString() : ''}</td>
          <td class="p-3 font-bold text-white">\${l.first_name} \${l.last_name}</td>
          <td class="p-3 font-mono text-indigo-400">\${l.member_id}</td>
          <td class="p-3">\${l.event_name}</td>
          <td class="p-3">Grade \${l.grade_level} - \${l.section}</td>
          <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-indigo-950 text-indigo-300 border border-indigo-800">\${l.status}</span></td>
        </tr>\`;
      });
    }

    async function loadMembers() {
      const res = await fetch('/api/members');
      const members = await res.json();
      const tbody = document.getElementById('membersTableBody');
      tbody.innerHTML = '';
      members.forEach(m => {
        tbody.innerHTML += \`<tr>
          <td class="p-3 font-mono text-indigo-400 font-bold">\${m.member_id}</td>
          <td class="p-3 font-bold text-white">\${m.first_name} \${m.last_name}</td>
          <td class="p-3 font-mono">\${m.username}</td>
          <td class="p-3">Grade \${m.grade_level} - \${m.section}</td>
          <td class="p-3">\${m.position}</td>
          <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800">\${m.status}</span></td>
          <td class="p-3 text-right space-x-2">
            <button onclick="resetPassword(\${m.id})" title="Reset Password" class="text-amber-400 hover:text-amber-300"><i class="fa-solid fa-key"></i></button>
            <button onclick="deleteMember(\${m.id})" title="Delete Member" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>\`;
      });
    }

    async function loadEvents() {
      const res = await fetch('/api/events');
      const events = await res.json();
      const tbody = document.getElementById('eventsTableBody');
      tbody.innerHTML = '';
      events.forEach(e => {
        tbody.innerHTML += \`<tr>
          <td class="p-3 font-bold text-white">\${e.event_name}</td>
          <td class="p-3">\${e.event_date}</td>
          <td class="p-3 font-mono">\${e.start_time}</td>
          <td class="p-3 font-mono">\${e.end_time}</td>
          <td class="p-3 font-mono text-amber-400">\${e.late_cutoff}</td>
        </tr>\`;
      });
    }

    async function loadLiveAttendance() {
      const res = await fetch('/api/attendance/live');
      const logs = await res.json();
      const tbody = document.getElementById('fullAttendanceTableBody');
      tbody.innerHTML = '';
      logs.forEach(l => {
        tbody.innerHTML += \`<tr>
          <td class="p-3">\${l.attendance_date}</td>
          <td class="p-3 font-bold text-white">\${l.first_name} \${l.last_name} (\${l.member_id})</td>
          <td class="p-3">\${l.event_name}</td>
          <td class="p-3 font-mono text-emerald-400">\${l.time_in || '—'}</td>
          <td class="p-3 font-mono text-amber-400">\${l.time_out || '—'}</td>
          <td class="p-3">\${l.status}</td>
        </tr>\`;
      });
    }

    async function loadScanners() {
      const res = await fetch('/api/scanners');
      const scanners = await res.json();
      const tbody = document.getElementById('scannersTableBody');
      tbody.innerHTML = '';
      scanners.forEach(s => {
        tbody.innerHTML += \`<tr>
          <td class="p-3 font-bold text-white">\${s.name}</td>
          <td class="p-3 font-mono">\${s.username}</td>
          <td class="p-3">\${new Date(s.created_at).toLocaleDateString()}</td>
          <td class="p-3 text-right"><button onclick="deleteScanner(\${s.id})" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash"></i></button></td>
        </tr>\`;
      });
    }

    async function loadAnnouncements() {
      const res = await fetch('/api/announcements');
      const anns = await res.json();
      const div = document.getElementById('adminAnnouncementsList');
      div.innerHTML = '';
      anns.forEach(a => {
        div.innerHTML += \`<div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex justify-between items-start">
          <div class="space-y-1">
            <h4 class="font-bold text-white text-sm">\${a.title}</h4>
            <p class="text-slate-300">\${a.message}</p>
            <span class="text-[10px] text-slate-500">\${new Date(a.created_at).toLocaleDateString()}</span>
          </div>
          <button onclick="deleteAnnouncement(\${a.id})" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash"></i></button>
        </div>\`;
      });
    }

    async function loadSettings() {
      const res = await fetch('/api/settings');
      const s = await res.json();
      document.getElementById('setSchoolName').value = s.school_name || '';
      document.getElementById('setOrgName').value = s.org_name || '';
      document.getElementById('setSchoolYear').value = s.school_year || '';
      document.getElementById('setOrgPrefix').value = s.org_prefix || '';
      document.getElementById('setOrgDesc').value = s.org_description || '';
    }

    async function loadLogs() {
      const res = await fetch('/api/audit-logs');
      const logs = await res.json();
      const tbody = document.getElementById('auditLogsTableBody');
      tbody.innerHTML = '';
      logs.forEach(l => {
        tbody.innerHTML += \`<tr>
          <td class="p-3 font-mono text-slate-400">\ل\lnew Date(l.created_at).toLocaleString()</td>
          <td class="p-3 font-bold text-white">\${l.username}</td>
          <td class="p-3 uppercase text-[10px] text-indigo-400">\${l.role}</td>
          <td class="p-3 font-semibold">\${l.action}</td>
          <td class="p-3 text-slate-400">\${l.details || ''}</td>
        </tr>\`;
      });
    }

    // Form Submissions
    document.getElementById('addMemberForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        first_name: document.getElementById('mFirst').value,
        last_name: document.getElementById('mLast').value,
        grade_level: document.getElementById('mGrade').value,
        section: document.getElementById('mSection').value,
        position: document.getElementById('mPosition').value,
        gender: document.getElementById('mGender').value
      };
      const res = await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        closeModal();
        document.getElementById('credName').innerText = data.member.first_name + ' ' + data.member.last_name;
        document.getElementById('credMemberId').innerText = data.member.member_id;
        document.getElementById('credUsername').innerText = data.credentials.username;
        document.getElementById('credPassword').innerText = data.credentials.tempPassword;
        openModal('credentialsModal');
        loadMembers();
      } else {
        alert(data.error);
      }
    });

    document.getElementById('addEventForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        event_name: document.getElementById('eName').value,
        event_date: document.getElementById('eDate').value,
        start_time: document.getElementById('eStart').value,
        end_time: document.getElementById('eEnd').value,
        late_cutoff: document.getElementById('eCutoff').value
      };
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) { closeModal(); loadEvents(); }
    });

    document.getElementById('addScannerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('sName').value,
        username: document.getElementById('sUsername').value,
        password: document.getElementById('sPassword').value
      };
      const res = await fetch('/api/scanners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) { closeModal(); loadScanners(); }
    });

    document.getElementById('addAnnouncementForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        title: document.getElementById('aTitle').value,
        message: document.getElementById('aMsg').value
      };
      const res = await fetch('/api/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) { closeModal(); loadAnnouncements(); }
    });

    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        school_name: document.getElementById('setSchoolName').value,
        org_name: document.getElementById('setOrgName').value,
        school_year: document.getElementById('setSchoolYear').value,
        org_prefix: document.getElementById('setOrgPrefix').value,
        org_description: document.getElementById('setOrgDesc').value
      };
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) alert('Organization settings updated successfully!');
    });

    async function deleteMember(id) {
      if (confirm('Are you sure you want to delete this member?')) {
        await fetch('/api/members/' + id, { method: 'DELETE' });
        loadMembers();
      }
    }

    async function resetPassword(id) {
      const res = await fetch('/api/members/' + id + '/reset-password', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert('Password reset successful! New temporary password: ' + data.tempPassword);
      }
    }

    async function deleteScanner(id) {
      if (confirm('Delete scanner account?')) {
        await fetch('/api/scanners/' + id, { method: 'DELETE' });
        loadScanners();
      }
    }

    async function deleteAnnouncement(id) {
      await fetch('/api/announcements/' + id, { method: 'DELETE' });
      loadAnnouncements();
    }

    // Initial load
    loadDashboard();
    setInterval(loadDashboard, 10000); // Auto-refresh live data
  </script>
</body>
</html>`;
}

// Start Server and Initialize Database
initializeDatabase().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
  });
});
