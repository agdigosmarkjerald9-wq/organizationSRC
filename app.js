/**
 * ClubTrack QR Attendance Management System
 * High School Organization and Club Management Platform
 * Complete Backend, PostgreSQL Database, Auth, Scanner Portal, and Responsive Frontend in ONE file.
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool Setup supporting Render / Heroku / Local connection URIs
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/clubtrack_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // set secure: true if using enforced HTTPS proxy
}));

// --- DATABASE INITIALIZATION ---
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name VARCHAR(255) DEFAULT 'ABC High School',
        org_name VARCHAR(255) DEFAULT 'Supreme Student Council',
        school_year VARCHAR(50) DEFAULT '2026–2027',
        org_description VARCHAR(500) DEFAULT 'Official student governing body fostering leadership and excellence.',
        accent_color VARCHAR(50) DEFAULT '#2563eb',
        id_prefix VARCHAR(50) DEFAULT 'SSC'
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'member', 'scanner')),
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
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        late_cutoff TIME NOT NULL,
        requirement VARCHAR(50) DEFAULT 'All Members'
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL,
        time_in TIME,
        time_out TIME,
        status VARCHAR(50) DEFAULT 'Present',
        scan_method VARCHAR(50) DEFAULT 'QR',
        manual_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        date_posted TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expiration_date DATE
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        username VARCHAR(100),
        role VARCHAR(50),
        action VARCHAR(255) NOT NULL,
        details TEXT
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        scanner_user VARCHAR(100),
        event_id INTEGER,
        scan_type VARCHAR(20),
        qr_value TEXT,
        result_status VARCHAR(50),
        message TEXT
      );
    `);

    // Insert default settings if empty
    const settingsCheck = await client.query('SELECT COUNT(*) FROM organization_settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_description, accent_color, id_prefix)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official student governing body fostering leadership and excellence.', '#2563eb', 'SSC')
      `);
    }

    // Insert default Admin if none exists
    const adminCheck = await client.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
    if (parseInt(adminCheck.rows[0].count) === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await client.query(
        "INSERT INTO users (username, password_hash, role, name, must_change_password) VALUES ($1, $2, $3, $4, $5)",
        ['admin', hash, 'admin', 'System Administrator', true]
      );
      console.log('Default Admin Account Created: username -> admin, password -> admin123');
    }
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

initDB();

// Helper Logger
async function logAction(req, action, details) {
  try {
    const username = req.session && req.session.user ? req.session.user.username : 'Guest';
    const role = req.session && req.session.user ? req.session.user.role : 'guest';
    await pool.query(
      'INSERT INTO audit_logs (username, role, action, details) VALUES ($1, $2, $3, $4)',
      [username, role, action, details]
    );
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

// --- MIDDLEWARES ---
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'admin') {
      return res.status(403).send('Access Denied: Insufficient Privileges');
    }
    if (req.session.user.must_change_password && req.path !== '/change-password' && req.method !== 'POST') {
      return res.redirect('/change-password');
    }
    next();
  };
}

// --- API & AUTH ROUTES ---

app.get('/login', async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const s = settingsRes.rows[0] || {};
  res.send(renderLoginPage(s));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.send(renderLoginPage({ error: 'Invalid username or password.' }));
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await logAction(req, 'Failed Login', `Failed attempt for username: ${username}`);
      return res.send(renderLoginPage({ error: 'Invalid username or password.' }));
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.name,
      must_change_password: user.must_change_password
    };

    await logAction(req, 'Successful Login', `User logged in with role: ${user.role}`);

    if (user.must_change_password) {
      return res.redirect('/change-password');
    }

    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error during login.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Force Password Change Route
app.get('/change-password', requireAuth(), async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  res.send(renderPasswordChangePage(settingsRes.rows[0], req.session.user));
});

app.post('/change-password', requireAuth(), async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (!new_password || new_password.length < 8 || new_password !== confirm_password) {
    return res.send(renderPasswordChangePage(null, req.session.user, 'Passwords must match and be at least 8 characters long.'));
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows[0];
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return res.send(renderPasswordChangePage(null, req.session.user, 'Current temporary password is incorrect.'));
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [newHash, user.id]);
    req.session.user.must_change_password = false;

    await logAction(req, 'Password Changed', 'User successfully changed their temporary password.');

    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error updating password.');
  }
});

// --- STANDALONE SCANNER PORTAL LINK ---
app.get('/scanner', requireAuth('scanner'), async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const eventsRes = await pool.query('SELECT * FROM events ORDER BY event_date DESC, start_time DESC');
  res.send(renderScannerPortal(settingsRes.rows[0], eventsRes.rows, req.session.user));
});

// QR Processing API Endpoint for Scanner
app.post('/api/scan', requireAuth('scanner'), async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  const scannerName = req.session.user.username;

  if (!qr_token || !event_id || !scan_type) {
    return res.json({ success: false, error_type: 'INVALID', message: 'Missing required scan attributes.' });
  }

  try {
    // Find member by token
    const memberRes = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id WHERE m.qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      await pool.query(
        'INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [scannerName, event_id, scan_type, qr_token, 'INVALID', 'QR Code not registered']
      );
      return res.json({ success: false, error_type: 'UNREGISTERED', message: 'This QR Code does not belong to a registered member.' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'active') {
      return res.json({ success: false, error_type: 'INACTIVE', message: 'Member account is currently inactive.' });
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    const event = eventRes.rows[0];

    // Check existing attendance for today/event
    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, todayStr]);

    const nowTime = new Date().toTimeString().split(' ')[0];

    if (scan_type === 'TIME_IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          success: false,
          error_type: 'DUPLICATE',
          message: `${member.first_name} ${member.last_name} already has a Time In record for this event.`,
          time_recorded: attRes.rows[0].time_in,
          member
        });
      }

      // Compute status (Present vs Late based on cutoff)
      let status = 'Present';
      if (event && nowTime > event.late_cutoff) {
        status = 'Late';
      }

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [nowTime, status, attRes.rows[0].id]);
      } else {
        await pool.query(
          'INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, $6)',
          [member.id, event_id, todayStr, nowTime, status, 'QR']
        );
      }

      await pool.query(
        'INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [scannerName, event_id, scan_type, qr_token, 'SUCCESS', `Time In recorded for ${member.member_id}`]
      );

      return res.json({ success: true, scan_type: 'TIME_IN', member, time: nowTime, date: todayStr, status });
    } 
    
    else if (scan_type === 'TIME_OUT') {
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ success: false, error_type: 'NO_TIME_IN', message: `${member.first_name} ${member.last_name} has no Time In record yet for this event.` });
      }
      if (attRes.rows[0].time_out) {
        return res.json({
          success: false,
          error_type: 'DUPLICATE',
          message: `${member.first_name} ${member.last_name} already recorded a Time Out for this event.`,
          time_recorded: attRes.rows[0].time_out,
          member
        });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [nowTime, attRes.rows[0].id]);

      await pool.query(
        'INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [scannerName, event_id, scan_type, qr_token, 'SUCCESS', `Time Out recorded for ${member.member_id}`]
      );

      return res.json({ success: true, scan_type: 'TIME_OUT', member, time: nowTime, date: todayStr });
    }

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error_type: 'SERVER_ERROR', message: 'Internal server error processing scan.' });
  }
});

// --- MEMBER PORTAL ---
app.get('/member', requireAuth('member'), async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const memberRes = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id WHERE u.id = $1', [req.session.user.id]);
  if (memberRes.rows.length === 0) return res.send('Member profile not found.');
  const member = memberRes.rows[0];

  const qrImage = await QRCode.toDataURL(member.qr_token);
  const attendanceRes = await pool.query(`
    SELECT a.*, e.event_name FROM attendance a 
    JOIN events e ON a.event_id = e.id 
    WHERE a.member_id = $1 ORDER BY a.attendance_date DESC
  `, [member.id]);

  const announcementsRes = await pool.query('SELECT * FROM announcements ORDER BY date_posted DESC LIMIT 5');

  res.send(renderMemberPortal(settingsRes.rows[0], member, qrImage, attendanceRes.rows, announcementsRes.rows));
});

// --- ADMIN PORTAL ---
app.get('/admin', requireAuth('admin'), async (req, res) => {
  const tab = req.query.tab || 'dashboard';
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];

  // Dashboard Stats
  const stats = {};
  const memCount = await pool.query('SELECT COUNT(*) FROM members');
  stats.total_members = memCount.rows[0].count;
  const activeCount = await pool.query("SELECT COUNT(*) FROM members WHERE status='active'");
  stats.active_members = activeCount.rows[0].count;

  const todayStr = new Date().toISOString().split('T')[0];
  const todayAtt = await pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = $1', [todayStr]);
  stats.present_today = todayAtt.rows[0].count;

  const timeInToday = await pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND time_in IS NOT NULL', [todayStr]);
  stats.time_in_today = timeInToday.rows[0].count;

  const timeOutToday = await pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND time_out IS NOT NULL', [todayStr]);
  stats.time_out_today = timeOutToday.rows[0].count;

  const lateToday = await pool.query("SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND status='Late'", [todayStr]);
  stats.late_today = lateToday.rows[0].count;

  const invalidScans = await pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result_status != 'SUCCESS'");
  stats.invalid_scans = invalidScans.rows[0].count;

  const membersList = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id ORDER BY m.last_name ASC');
  const eventsList = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
  const announcementsList = await pool.query('SELECT * FROM announcements ORDER BY date_posted DESC');
  const liveAttendance = await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.member_id, m.grade_level, m.section, e.event_name 
    FROM attendance a JOIN members m ON a.member_id = m.id JOIN events e ON a.event_id = e.id 
    ORDER BY a.created_at DESC LIMIT 25
  `);
  const auditLogs = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 50');
  const scannerAccounts = await pool.query("SELECT * FROM users WHERE role = 'scanner'");

  res.send(renderAdminPortal({
    tab,
    settings,
    stats,
    members: membersList.rows,
    events: eventsList.rows,
    announcements: announcementsList.rows,
    liveAttendance: liveAttendance.rows,
    auditLogs: auditLogs.rows,
    scannerAccounts: scannerAccounts.rows,
    query: req.query
  }));
});

// Admin Actions
app.post('/admin/settings', requireAuth('admin'), async (req, res) => {
  const { school_name, org_name, school_year, org_description, accent_color, id_prefix } = req.body;
  await pool.query(
    'UPDATE organization_settings SET school_name=$1, org_name=$2, school_year=$3, org_description=$4, accent_color=$5, id_prefix=$6',
    [school_name, org_name, school_year, org_description, accent_color, id_prefix]
  );
  await logAction(req, 'Update Settings', 'Organization settings updated successfully.');
  res.redirect('/admin?tab=settings');
});

// Register Member with Automatic ID, Username, Temp Password & QR Token
app.post('/admin/members/add', requireAuth('admin'), async (req, res) => {
  const { first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email } = req.body;
  try {
    const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
    const s = settingsRes.rows[0];
    const year = new Date().getFullYear();

    // Generate Member ID
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seq = parseInt(countRes.rows[0].count) + 1;
    const member_id = `${s.id_prefix}-${year}-${String(seq).padStart(4, '0')}`;

    // Generate Username
    let baseUsername = `${first_name.toLowerCase().replace(/[^a-z]/g, '')}${last_name.toLowerCase().replace(/[^a-z]/g, '')}`;
    let username = baseUsername;
    let uCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    let counter = 1;
    while (uCheck.rows.length > 0) {
      username = `${baseUsername}${counter}`;
      uCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      counter++;
    }

    // Generate Random Temp Password (8 chars)
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hash = await bcrypt.hash(tempPassword, 10);

    // Create User Account
    const userInsert = await pool.query(
      'INSERT INTO users (username, password_hash, role, name, must_change_password) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [username, hash, 'member', `${first_name} ${last_name}`, true]
    );
    const userId = userInsert.rows[0].id;

    // Secure QR Token
    const qrToken = `CLUBTRACK:MEMBER:${crypto.randomUUID()}`;

    // Create Member Record
    await pool.query(
      `INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email, qr_token, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active')`,
      [userId, member_id, first_name, middle_name || '', last_name, gender, grade_level, section, position || 'Member', contact_info, email, qrToken]
    );

    await logAction(req, 'Register Member', `Registered member ${member_id} (${first_name} ${last_name})`);

    // Render Secure Credentials Card Screen immediately
    const qrImage = await QRCode.toDataURL(qrToken);
    res.send(renderCredentialsScreen(s, {
      member_id,
      first_name,
      middle_name,
      last_name,
      grade_level,
      section,
      position,
      username,
      tempPassword,
      qrImage
    }));
  } catch (e) {
    console.error(e);
    res.status(500).send('Error registering member: ' + e.message);
  }
});

// Delete Member
app.post('/admin/members/delete/:id', requireAuth('admin'), async (req, res) => {
  const memberId = req.params.id;
  try {
    const memRes = await pool.query('SELECT * FROM members WHERE id = $1', [memberId]);
    if (memRes.rows.length > 0) {
      const m = memRes.rows[0];
      await pool.query('DELETE FROM users WHERE id = $1', [m.user_id]); // Cascades to members and attendance
      await logAction(req, 'Delete Member', `Deleted member ID ${m.member_id}`);
    }
    res.redirect('/admin?tab=members');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error deleting member.');
  }
});

// Reset Member Password
app.post('/admin/members/reset-password/:id', requireAuth('admin'), async (req, res) => {
  const memberId = req.params.id;
  try {
    const memRes = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id WHERE m.id = $1', [memberId]);
    if (memRes.rows.length === 0) return res.status(404).send('Member not found.');
    const member = memRes.rows[0];

    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hash = await bcrypt.hash(tempPassword, 10);

    await pool.query('UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2', [hash, member.user_id]);
    await logAction(req, 'Password Reset', `Reset password for member ${member.member_id}`);

    const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
    const s = settingsRes.rows[0];
    const qrImage = await QRCode.toDataURL(member.qr_token);

    res.send(renderCredentialsScreen(s, {
      member_id: member.member_id,
      first_name: member.first_name,
      middle_name: member.middle_name,
      last_name: member.last_name,
      grade_level: member.grade_level,
      section: member.section,
      position: member.position,
      username: member.username,
      tempPassword,
      qrImage
    }, 'Password successfully reset!'));
  } catch (e) {
    console.error(e);
    res.status(500).send('Error resetting password.');
  }
});

// Events Management
app.post('/admin/events/add', requireAuth('admin'), async (req, res) => {
  const { event_name, description, event_date, start_time, end_time, late_cutoff, requirement } = req.body;
  await pool.query(
    'INSERT INTO events (event_name, description, event_date, start_time, end_time, late_cutoff, requirement) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [event_name, description, event_date, start_time, end_time, late_cutoff, requirement]
  );
  await logAction(req, 'Create Event', `Created attendance event: ${event_name}`);
  res.redirect('/admin?tab=events');
});

app.post('/admin/events/delete/:id', requireAuth('admin'), async (req, res) => {
  await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
  await logAction(req, 'Delete Event', `Deleted event ID ${req.params.id}`);
  res.redirect('/admin?tab=events');
});

// Announcements Management
app.post('/admin/announcements/add', requireAuth('admin'), async (req, res) => {
  const { title, message, expiration_date } = req.body;
  await pool.query(
    'INSERT INTO announcements (title, message, expiration_date) VALUES ($1, $2, $3)',
    [title, message, expiration_date || null]
  );
  await logAction(req, 'Create Announcement', `Posted announcement: ${title}`);
  res.redirect('/admin?tab=announcements');
});

app.post('/admin/announcements/delete/:id', requireAuth('admin'), async (req, res) => {
  await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
  res.redirect('/admin?tab=announcements');
});

// Scanner Accounts Management
app.post('/admin/scanners/add', requireAuth('admin'), async (req, res) => {
  const { name, username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password || 'scanner123', 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role, name, must_change_password) VALUES ($1, $2, $3, $4, $5)',
      [username, hash, 'scanner', name, false]
    );
    await logAction(req, 'Create Scanner', `Created scanner officer account: ${username}`);
    res.redirect('/admin?tab=scanners');
  } catch (e) {
    res.status(500).send('Error creating scanner account: ' + e.message);
  }
});

app.post('/admin/scanners/delete/:id', requireAuth('admin'), async (req, res) => {
  await pool.query("DELETE FROM users WHERE id = $1 AND role = 'scanner'", [req.params.id]);
  res.redirect('/admin?tab=scanners');
});

// Manual Attendance Correction / Addition
app.post('/admin/attendance/manual', requireAuth('admin'), async (req, res) => {
  const { member_id, event_id, attendance_date, time_in, time_out, status, manual_reason } = req.body;
  try {
    await pool.query(
      `INSERT INTO attendance (member_id, event_id, attendance_date, time_in, time_out, status, scan_method, manual_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', $7)`,
      [member_id, event_id, attendance_date, time_in || null, time_out || null, status, manual_reason]
    );
    await logAction(req, 'Manual Attendance', `Added manual attendance for member ID ${member_id}. Reason: ${manual_reason}`);
    res.redirect('/admin?tab=attendance');
  } catch (e) {
    res.status(500).send('Error adding manual attendance: ' + e.message);
  }
});

app.post('/admin/attendance/delete/:id', requireAuth('admin'), async (req, res) => {
  await pool.query('DELETE FROM attendance WHERE id = $1', [req.params.id]);
  await logAction(req, 'Delete Attendance', `Deleted attendance record ID ${req.params.id}`);
  res.redirect('/admin?tab=attendance');
});

// --- HTML TEMPLATES & FRONTEND UI ---

function renderLoginPage(settings = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - ClubTrack QR Attendance System</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 flex items-center justify-center min-h-screen">
  <div class="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-md border border-slate-700">
    <div class="text-center mb-6">
      <div class="inline-block p-3 bg-blue-100 text-blue-600 rounded-full mb-3">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg>
      </div>
      <h1 class="text-2xl font-bold text-slate-800">ClubTrack QR System</h1>
      <p class="text-sm text-slate-500">${settings.org_name || 'Organization & Club Management'} (${settings.school_name || 'High School'})</p>
    </div>

    ${settings.error ? `<div class="mb-4 p-3 bg-red-100 text-red-700 text-sm rounded-lg border border-red-200">${settings.error}</div>` : ''}

    <form action="/login" method="POST" class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Username</label>
        <input type="text" name="username" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <div>
        <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Password</label>
        <input type="password" name="password" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <button type="submit" class="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition shadow-lg">Sign In</button>
    </form>
    
    <div class="mt-6 text-center text-xs text-slate-400">
      Default Admin: <code class="bg-slate-100 px-1 py-0.5 rounded text-slate-600">admin</code> / <code class="bg-slate-100 px-1 py-0.5 rounded text-slate-600">admin123</code>
    </div>
  </div>
</body>
</html>`;
}

function renderPasswordChangePage(settings, user, error = null) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Update - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 flex items-center justify-center min-h-screen p-4">
  <div class="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700">
    <div class="mb-6 p-4 bg-amber-50 border-l-4 border-amber-500 text-amber-800 rounded-r-lg">
      <h3 class="font-bold text-base mb-1">IMPORTANT SECURITY REMINDER</h3>
      <p class="text-xs leading-relaxed">Welcome, ${user.name}! Your account is currently using a temporary password. For security compliance, you are required to create a new private password before proceeding.</p>
    </div>

    ${error ? `<div class="mb-4 p-3 bg-red-100 text-red-700 text-sm rounded-lg">${error}</div>` : ''}

    <form action="/change-password" method="POST" class="space-y-4">
      <div>
        <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Current Temporary Password</label>
        <input type="password" name="current_password" required class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <div>
        <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">New Private Password (Min 8 Characters)</label>
        <input type="password" name="new_password" required minlength="8" class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <div>
        <label class="block text-xs font-semibold text-slate-600 uppercase mb-1">Confirm New Password</label>
        <input type="password" name="confirm_password" required minlength="8" class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <button type="submit" class="w-full py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition shadow-lg">Secure Account & Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function renderCredentialsScreen(settings, data, customTitle = "MEMBER SUCCESSFULLY REGISTERED") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Member Credentials - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 flex items-center justify-center min-h-screen p-4">
  <div class="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-700 text-center">
    <div class="inline-block p-3 bg-emerald-100 text-emerald-600 rounded-full mb-3">
      <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
    </div>
    <h2 class="text-xl font-bold text-slate-800 mb-1">${customTitle}</h2>
    <p class="text-xs text-slate-500 mb-6">${settings.school_name} - ${settings.org_name}</p>

    <div class="bg-slate-50 p-4 rounded-xl border border-slate-200 text-left space-y-2 mb-6">
      <div class="flex justify-between"><span class="text-xs text-slate-500">Full Name:</span><span class="font-bold text-slate-800">${data.first_name} ${data.middle_name || ''} ${data.last_name}</span></div>
      <div class="flex justify-between"><span class="text-xs text-slate-500">Member ID:</span><span class="font-mono font-bold text-blue-600">${data.member_id}</span></div>
      <div class="flex justify-between"><span class="text-xs text-slate-500">Grade & Section:</span><span class="font-semibold text-slate-800">${data.grade_level} - ${data.section}</span></div>
      <div class="flex justify-between"><span class="text-xs text-slate-500">Username:</span><span class="font-mono font-bold text-slate-800">${data.username}</span></div>
      <div class="flex justify-between bg-amber-50 p-2 rounded border border-amber-200">
        <span class="text-xs text-amber-800 font-bold">Temporary Password:</span>
        <span class="font-mono font-bold text-red-600 text-base">${data.tempPassword}</span>
      </div>
    </div>

    <div class="mb-6 flex justify-center">
      <img src="${data.qrImage}" alt="Member QR Code" class="w-40 h-40 border p-2 rounded-xl bg-white shadow">
    </div>

    <div class="flex gap-3">
      <button onclick="window.print()" class="flex-1 py-2.5 bg-slate-800 text-white rounded-lg hover:bg-slate-900 font-semibold text-sm">Print Credentials</button>
      <a href="/admin?tab=members" class="flex-1 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold text-sm flex items-center justify-center">Back to Members</a>
    </div>
  </div>
</body>
</html>`;
}

function renderScannerPortal(settings, events, user) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Standalone Scanner Portal - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/html5-qrcode"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">
  <!-- Top Bar -->
  <header class="bg-slate-900 border-b border-slate-800 p-4 flex justify-between items-center">
    <div>
      <h1 class="font-bold text-lg text-blue-400">📱 Scanner Portal</h1>
      <p class="text-xs text-slate-400">${settings.org_name} | Officer: ${user.name}</p>
    </div>
    <div class="flex items-center gap-3">
      <button id="soundToggle" onclick="toggleSound()" class="px-3 py-1.5 bg-slate-800 text-xs rounded-lg font-semibold border border-slate-700">🔊 Sound: ON</button>
      <a href="/logout" class="px-3 py-1.5 bg-red-600/20 text-red-400 text-xs rounded-lg font-semibold hover:bg-red-600/30">Logout</a>
    </div>
  </header>

  <!-- Main Scanner Layout -->
  <main class="flex-1 max-w-xl w-full mx-auto p-4 flex flex-col gap-4">
    <!-- Event Selection -->
    <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
      <label class="block text-xs font-semibold text-slate-400 uppercase mb-2">1. Select Attendance Event</label>
      <select id="eventSelect" class="w-full bg-slate-800 border border-slate-700 p-3 rounded-xl text-white font-semibold outline-none focus:ring-2 focus:ring-blue-500">
        ${events.map(e => `<option value="${e.id}">${e.event_name} (${e.event_date})</option>`).join('')}
      </select>
    </div>

    <!-- Scan Type Selection -->
    <div class="grid grid-cols-2 gap-3">
      <button onclick="setScanType('TIME_IN')" id="btnTimeIn" class="py-4 bg-blue-600 text-white font-bold rounded-xl shadow-lg border-2 border-blue-400 text-lg transition">TIME IN</button>
      <button onclick="setScanType('TIME_OUT')" id="btnTimeOut" class="py-4 bg-slate-800 text-slate-400 font-bold rounded-xl shadow-lg border-2 border-slate-700 text-lg transition">TIME OUT</button>
    </div>

    <!-- Scanner Box -->
    <div class="bg-slate-900 p-4 rounded-xl border border-slate-800 text-center relative overflow-hidden">
      <div id="reader" class="w-full rounded-lg overflow-hidden mb-3"></div>
      <button onclick="startScanner()" id="startCamBtn" class="w-full py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 shadow-lg">START CAMERA</button>
      <button onclick="stopScanner()" id="stopCamBtn" class="w-full py-3 bg-red-600 text-white font-bold rounded-xl hover:bg-red-700 shadow-lg hidden mt-2">STOP CAMERA</button>
    </div>

    <!-- Result Display Card -->
    <div id="resultCard" class="hidden p-6 rounded-2xl text-center border shadow-xl transition-all">
      <div id="resultIcon" class="text-4xl mb-2"></div>
      <h2 id="resultTitle" class="text-xl font-black mb-1"></h2>
      <p id="resultName" class="text-lg font-bold"></p>
      <p id="resultDetails" class="text-sm text-slate-300 mt-1"></p>
      <div id="resultTime" class="mt-4 font-mono text-2xl font-black"></div>
    </div>
  </main>

  <script>
    let currentScanType = 'TIME_IN';
    let soundEnabled = true;
    let html5QrCode = null;
    let isProcessing = false;

    function toggleSound() {
      soundEnabled = !soundEnabled;
      document.getElementById('soundToggle').innerText = soundEnabled ? '🔊 Sound: ON' : '🔇 Sound: OFF';
    }

    function playAudioTone(type) {
      if (!soundEnabled) return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'success') {
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1); // A5
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } else {
        osc.frequency.setValueAtTime(200, ctx.currentTime);
        osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      }
    }

    function setScanType(type) {
      currentScanType = type;
      const btnIn = document.getElementById('btnTimeIn');
      const btnOut = document.getElementById('btnTimeOut');
      if (type === 'TIME_IN') {
        btnIn.className = 'py-4 bg-blue-600 text-white font-bold rounded-xl shadow-lg border-2 border-blue-400 text-lg transition';
        btnOut.className = 'py-4 bg-slate-800 text-slate-400 font-bold rounded-xl shadow-lg border-2 border-slate-700 text-lg transition';
      } else {
        btnOut.className = 'py-4 bg-blue-600 text-white font-bold rounded-xl shadow-lg border-2 border-blue-400 text-lg transition';
        btnIn.className = 'py-4 bg-slate-800 text-slate-400 font-bold rounded-xl shadow-lg border-2 border-slate-700 text-lg transition';
      }
    }

    function startScanner() {
      const eventId = document.getElementById('eventSelect').value;
      if (!eventId) {
        alert('Please select an event first.');
        return;
      }
      document.getElementById('startCamBtn').classList.add('hidden');
      document.getElementById('stopCamBtn').classList.remove('hidden');

      html5QrCode = new Html5Qrcode("reader");
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          if (isProcessing) return;
          isProcessing = true;
          await processScan(decodedText, eventId);
          setTimeout(() => { isProcessing = false; }, 2500);
        },
        (error) => {}
      ).catch(err => {
        alert('Camera permission error or not supported on insecure HTTP. Ensure HTTPS or localhost.');
        stopScanner();
      });
    }

    function stopScanner() {
      if (html5QrCode) {
        html5QrCode.stop().then(() => {
          document.getElementById('startCamBtn').classList.remove('hidden');
          document.getElementById('stopCamBtn').classList.add('hidden');
        }).catch(err => console.log(err));
      }
    }

    async function processScan(token, eventId) {
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr_token: token, event_id: eventId, scan_type: currentScanType })
        });
        const data = await res.json();
        const card = document.getElementById('resultCard');
        card.classList.remove('hidden');

        if (data.success) {
          playAudioTone('success');
          card.className = 'p-6 rounded-2xl text-center border bg-emerald-950 border-emerald-500 text-emerald-100 shadow-xl';
          document.getElementById('resultIcon').innerText = '✓';
          document.getElementById('resultTitle').innerText = data.scan_type === 'TIME_IN' ? 'TIME IN RECORDED' : 'TIME OUT RECORDED';
          document.getElementById('resultName').innerText = `${data.member.first_name} ${data.member.last_name}`;
          document.getElementById('resultDetails').innerText = `ID: ${data.member.member_id} | Grade ${data.member.grade_level} - ${data.member.section}`;
          document.getElementById('resultTime').innerText = `${data.time} (${data.date})`;
        } else {
          playAudioTone('error');
          card.className = 'p-6 rounded-2xl text-center border bg-red-950 border-red-500 text-red-100 shadow-xl';
          document.getElementById('resultIcon').innerText = '⚠';
          document.getElementById('resultTitle').innerText = data.error_type === 'DUPLICATE' ? 'ALREADY RECORDED' : 'QR CODE UNREGISTERED';
          document.getElementById('resultName').innerText = data.member ? `${data.member.first_name} ${data.member.last_name}` : 'Invalid Token';
          document.getElementById('resultDetails').innerText = data.message;
          document.getElementById('resultTime').innerText = data.time_recorded ? `Recorded at: ${data.time_recorded}` : '';
        }
      } catch (e) {
        console.error(e);
      }
    }
  </script>
</body>
</html>`;
}

function renderMemberPortal(settings, member, qrImage, attendance, announcements) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Member Portal - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">
  <header class="bg-slate-950 border-b border-slate-800 p-4 sticky top-0 z-50 flex justify-between items-center">
    <div class="flex items-center gap-3">
      <div class="bg-blue-600 text-white font-bold p-2 rounded-xl text-sm">${settings.org_name || 'CLUB'}</div>
      <div>
        <h1 class="font-bold text-base">${member.first_name} ${member.last_name}</h1>
        <p class="text-xs text-slate-400 font-mono">${member.member_id}</p>
      </div>
    </div>
    <a href="/logout" class="px-4 py-2 bg-red-600/20 text-red-400 text-xs rounded-xl font-semibold hover:bg-red-600/30">Logout</a>
  </header>

  <main class="max-w-4xl mx-auto p-4 space-y-6">
    <!-- Announcements -->
    ${announcements.length > 0 ? `
    <div class="bg-blue-950 border border-blue-800 p-4 rounded-2xl shadow-lg">
      <h3 class="font-bold text-blue-300 text-sm mb-2 uppercase tracking-wider">📢 Organization Announcements</h3>
      <div class="space-y-3">
        ${announcements.map(a => `
          <div class="bg-blue-900/50 p-3 rounded-xl border border-blue-700">
            <h4 class="font-bold text-white text-sm">${a.title}</h4>
            <p class="text-xs text-blue-200 mt-1">${a.message}</p>
            <span class="text-[10px] text-blue-400 mt-2 block">${a.date_posted}</span>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <div class="grid md:grid-cols-2 gap-6">
      <!-- Digital ID Card (Standardized High School ID Size) -->
      <div class="bg-white text-slate-900 rounded-2xl shadow-2xl p-6 border-4 border-slate-200 flex flex-col items-center text-center relative overflow-hidden max-w-[360px] mx-auto w-full">
        <div class="absolute top-0 left-0 right-0 h-3 bg-blue-600"></div>
        <p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">${settings.school_name}</p>
        <h3 class="text-base font-black text-blue-900">${settings.org_name}</h3>
        <p class="text-[9px] font-semibold bg-slate-100 px-2 py-0.5 rounded-full text-slate-600 my-1 uppercase">Official Member ID Card</p>

        <div class="w-24 h-24 bg-slate-200 rounded-full mx-auto my-3 overflow-hidden border-2 border-blue-600 flex items-center justify-center text-slate-400 font-bold text-xl">
          ${member.first_name[0]}${member.last_name[0]}
        </div>

        <h4 class="font-extrabold text-slate-900 text-lg leading-tight">${member.first_name} ${member.last_name}</h4>
        <p class="text-xs font-mono font-bold text-blue-600 mt-0.5">${member.member_id}</p>
        <p class="text-xs font-semibold text-slate-600">Grade ${member.grade_level} - ${member.section}</p>
        <span class="inline-block px-3 py-0.5 bg-blue-100 text-blue-800 font-bold text-[10px] rounded-full mt-1">${member.position}</span>

        <div class="my-4 bg-white p-2 rounded-xl border shadow-inner">
          <img src="${qrImage}" alt="QR ID" class="w-32 h-32 mx-auto">
        </div>

        <div class="flex gap-2 w-full mt-2">
          <button onclick="window.print()" class="flex-1 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800">Print ID Card</button>
        </div>
      </div>

      <!-- Profile & Stats -->
      <div class="space-y-6">
        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">👤 Member Profile Details</h3>
          <div class="space-y-3 text-sm">
            <div class="flex justify-between border-b border-slate-700 pb-2"><span class="text-slate-400">Username:</span><span class="font-mono font-bold">${member.username}</span></div>
            <div class="flex justify-between border-b border-slate-700 pb-2"><span class="text-slate-400">Gender:</span><span>${member.gender || 'N/A'}</span></div>
            <div class="flex justify-between border-b border-slate-700 pb-2"><span class="text-slate-400">Email:</span><span>${member.email || 'N/A'}</span></div>
            <div class="flex justify-between border-b border-slate-700 pb-2"><span class="text-slate-400">Contact:</span><span>${member.contact_info || 'N/A'}</span></div>
            <div class="flex justify-between"><span class="text-slate-400">Account Status:</span><span class="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 font-bold text-xs rounded">${member.status}</span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Attendance History Table -->
    <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl overflow-x-auto">
      <h3 class="font-bold text-base mb-4 text-blue-400">📊 My Attendance Records</h3>
      <table class="w-full text-left text-xs whitespace-nowrap">
        <thead>
          <tr class="text-slate-400 border-b border-slate-700">
            <th class="pb-3">Date</th>
            <th class="pb-3">Event</th>
            <th class="pb-3">Time In</th>
            <th class="pb-3">Time Out</th>
            <th class="pb-3">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-700">
          ${attendance.length === 0 ? `<tr><td colspan="5" class="py-4 text-center text-slate-500">No attendance records found.</td></tr>` : attendance.map(a => `
            <tr>
              <td class="py-3 font-mono">${a.attendance_date}</td>
              <td class="py-3 font-semibold text-white">${a.event_name}</td>
              <td class="py-3 font-mono text-emerald-400">${a.time_in || '—'}</td>
              <td class="py-3 font-mono text-amber-400">${a.time_out || '—'}</td>
              <td class="py-3"><span class="px-2 py-0.5 rounded font-bold ${a.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}">${a.status}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>`;
}

function renderAdminPortal(data) {
  const { tab, settings, stats, members, events, announcements, liveAttendance, auditLogs, scannerAccounts } = data;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard - ClubTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen flex">
  <!-- Sidebar -->
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col hidden md:flex">
    <div class="p-5 border-b border-slate-800">
      <h2 class="font-extrabold text-blue-500 text-lg">ClubTrack Admin</h2>
      <p class="text-xs text-slate-400">${settings.org_name}</p>
    </div>
    <nav class="flex-1 p-4 space-y-1 text-sm font-semibold">
      <a href="/admin?tab=dashboard" class="block px-4 py-2.5 rounded-xl ${tab === 'dashboard' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">📊 Dashboard</a>
      <a href="/admin?tab=members" class="block px-4 py-2.5 rounded-xl ${tab === 'members' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">👥 Manage Members</a>
      <a href="/admin?tab=attendance" class="block px-4 py-2.5 rounded-xl ${tab === 'attendance' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">🕒 Live & Attendance</a>
      <a href="/admin?tab=events" class="block px-4 py-2.5 rounded-xl ${tab === 'events' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">📅 Events Setup</a>
      <a href="/admin?tab=announcements" class="block px-4 py-2.5 rounded-xl ${tab === 'announcements' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">📢 Announcements</a>
      <a href="/admin?tab=scanners" class="block px-4 py-2.5 rounded-xl ${tab === 'scanners' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">📱 Scanner Accounts</a>
      <a href="/admin?tab=logs" class="block px-4 py-2.5 rounded-xl ${tab === 'logs' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">🛡️ Audit Logs</a>
      <a href="/admin?tab=settings" class="block px-4 py-2.5 rounded-xl ${tab === 'settings' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-900'}">⚙️ Organization Settings</a>
    </nav>
    <div class="p-4 border-t border-slate-800">
      <a href="/logout" class="block w-full py-2.5 text-center bg-red-600/20 text-red-400 font-semibold rounded-xl text-sm">Logout Admin</a>
    </div>
  </aside>

  <!-- Main Content Area -->
  <main class="flex-1 flex flex-col min-h-screen overflow-y-auto">
    <header class="bg-slate-950 border-b border-slate-800 p-4 flex justify-between items-center md:hidden">
      <h1 class="font-bold text-blue-500">ClubTrack Admin</h1>
      <a href="/logout" class="text-xs text-red-400 font-semibold">Logout</a>
    </header>

    <div class="p-6 space-y-6">
      ${tab === 'dashboard' ? `
        <div>
          <h2 class="text-2xl font-black mb-1">Admin Dashboard Overview</h2>
          <p class="text-xs text-slate-400">Real-time tracking for ${settings.school_name}</p>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="bg-slate-800 p-4 rounded-2xl border border-slate-700 shadow">
            <p class="text-xs text-slate-400 uppercase font-bold">Total Members</p>
            <h3 class="text-3xl font-black text-blue-400 mt-1">${stats.total_members}</h3>
          </div>
          <div class="bg-slate-800 p-4 rounded-2xl border border-slate-700 shadow">
            <p class="text-xs text-slate-400 uppercase font-bold">Active Members</p>
            <h3 class="text-3xl font-black text-emerald-400 mt-1">${stats.active_members}</h3>
          </div>
          <div class="bg-slate-800 p-4 rounded-2xl border border-slate-700 shadow">
            <p class="text-xs text-slate-400 uppercase font-bold">Time In Today</p>
            <h3 class="text-3xl font-black text-cyan-400 mt-1">${stats.time_in_today}</h3>
          </div>
          <div class="bg-slate-800 p-4 rounded-2xl border border-slate-700 shadow">
            <p class="text-xs text-slate-400 uppercase font-bold">Invalid Scans</p>
            <h3 class="text-3xl font-black text-red-400 mt-1">${stats.invalid_scans}</h3>
          </div>
        </div>

        <!-- Live Attendance Monitor Table -->
        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">🔴 Live Attendance Feed</h3>
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead>
              <tr class="text-slate-400 border-b border-slate-700">
                <th class="pb-3">Member</th>
                <th class="pb-3">Event</th>
                <th class="pb-3">Time In</th>
                <th class="pb-3">Time Out</th>
                <th class="pb-3">Method</th>
                <th class="pb-3">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700">
              ${liveAttendance.length === 0 ? `<tr><td colspan="6" class="py-4 text-center text-slate-500">No records found today.</td></tr>` : liveAttendance.map(a => `
                <tr>
                  <td class="py-3 font-semibold text-white">${a.first_name} ${a.last_name} <span class="text-slate-400 font-mono text-[10px]">(${a.member_id})</span></td>
                  <td class="py-3">${a.event_name}</td>
                  <td class="py-3 font-mono text-emerald-400">${a.time_in || '—'}</td>
                  <td class="py-3 font-mono text-amber-400">${a.time_out || '—'}</td>
                  <td class="py-3 font-mono">${a.scan_method}</td>
                  <td class="py-3"><span class="px-2 py-0.5 rounded font-bold ${a.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}">${a.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      ${tab === 'members' ? `
        <div class="flex justify-between items-center">
          <div>
            <h2 class="text-2xl font-black mb-1">Member Accounts Management</h2>
            <p class="text-xs text-slate-400">Register new high school club members with auto-generated ID, credentials & QR.</p>
          </div>
        </div>

        <!-- Add Member Form Card -->
        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">➕ Register New Member</h3>
          <form action="/admin/members/add" method="POST" class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">First Name</label>
              <input type="text" name="first_name" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Middle Name</label>
              <input type="text" name="middle_name" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Last Name</label>
              <input type="text" name="last_name" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Gender</label>
              <select name="gender" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Grade Level</label>
              <input type="text" name="grade_level" required placeholder="Grade 10" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Section</label>
              <input type="text" name="section" required placeholder="Rizal" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Position</label>
              <input type="text" name="position" value="Member" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Contact Number</label>
              <input type="text" name="contact_info" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Email (Optional)</label>
              <input type="email" name="email" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div class="md:col-span-3 flex justify-end">
              <button type="submit" class="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition shadow-lg">Register Member & Generate ID</button>
            </div>
          </form>
        </div>

        <!-- Members Table -->
        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl overflow-x-auto">
          <h3 class="font-bold text-base mb-4 text-blue-400">📋 Registered Members List (${members.length})</h3>
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead>
              <tr class="text-slate-400 border-b border-slate-700">
                <th class="pb-3">Member ID</th>
                <th class="pb-3">Full Name</th>
                <th class="pb-3">Username</th>
                <th class="pb-3">Grade & Section</th>
                <th class="pb-3">Position</th>
                <th class="pb-3">Status</th>
                <th class="pb-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700">
              ${members.map(m => `
                <tr>
                  <td class="py-3 font-mono font-bold text-blue-400">${m.member_id}</td>
                  <td class="py-3 font-semibold text-white">${m.last_name}, ${m.first_name}</td>
                  <td class="py-3 font-mono">${m.username}</td>
                  <td class="py-3">${m.grade_level} - ${m.section}</td>
                  <td class="py-3">${m.position}</td>
                  <td class="py-3"><span class="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded font-bold">${m.status}</span></td>
                  <td class="py-3 text-right space-x-2">
                    <form action="/admin/members/reset-password/${m.id}" method="POST" class="inline">
                      <button type="submit" class="px-2.5 py-1 bg-amber-600/20 text-amber-400 rounded hover:bg-amber-600/30 font-bold">Reset Pass</button>
                    </form>
                    <form action="/admin/members/delete/${m.id}" method="POST" class="inline" onsubmit="return confirm('Are you sure you want to delete this member?');">
                      <button type="submit" class="px-2.5 py-1 bg-red-600/20 text-red-400 rounded hover:bg-red-600/30 font-bold">Delete</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      ${tab === 'attendance' ? `
        <div>
          <h2 class="text-2xl font-black mb-1">Attendance Management & Manual Entry</h2>
          <p class="text-xs text-slate-400">Correct or add manual attendance records with audit tracking.</p>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">📝 Add Manual Attendance</h3>
          <form action="/admin/attendance/manual" method="POST" class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Select Member</label>
              <select name="member_id" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
                ${members.map(m => `<option value="${m.id}">${m.last_name}, ${m.first_name} (${m.member_id})</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Select Event</label>
              <select name="event_id" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
                ${events.map(e => `<option value="${e.id}">${e.event_name} (${e.event_date})</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Date</label>
              <input type="date" name="attendance_date" required value="${new Date().toISOString().split('T')[0]}" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Time In</label>
              <input type="time" name="time_in" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Time Out</label>
              <input type="time" name="time_out" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Status</label>
              <select name="status" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
                <option value="Present">Present</option>
                <option value="Late">Late</option>
                <option value="Excused">Excused</option>
              </select>
            </div>
            <div class="md:col-span-3">
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Reason for Manual Entry</label>
              <input type="text" name="manual_reason" required placeholder="e.g., QR scanner was unavailable / phone battery died" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div class="md:col-span-3 flex justify-end">
              <button type="submit" class="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition">Save Manual Attendance</button>
            </div>
          </form>
        </div>
      ` : ''}

      ${tab === 'events' ? `
        <div>
          <h2 class="text-2xl font-black mb-1">Events Management</h2>
          <p class="text-xs text-slate-400">Configure meetings, practices, and assemblies with automatic late cutoff classification.</p>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">➕ Create New Attendance Event</h3>
          <form action="/admin/events/add" method="POST" class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="md:col-span-2">
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Event Name</label>
              <input type="text" name="event_name" required placeholder="Monthly Organization Meeting" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Event Date</label>
              <input type="date" name="event_date" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Start Time</label>
              <input type="time" name="start_time" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Late Cutoff Time</label>
              <input type="time" name="late_cutoff" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Expected End Time</label>
              <input type="time" name="end_time" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div class="md:col-span-3 flex justify-end">
              <button type="submit" class="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition">Create Event</button>
            </div>
          </form>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl overflow-x-auto">
          <h3 class="font-bold text-base mb-4 text-blue-400">📅 Scheduled Events (${events.length})</h3>
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead>
              <tr class="text-slate-400 border-b border-slate-700">
                <th class="pb-3">Event Name</th>
                <th class="pb-3">Date</th>
                <th class="pb-3">Time</th>
                <th class="pb-3">Late Cutoff</th>
                <th class="pb-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700">
              ${events.map(e => `
                <tr>
                  <td class="py-3 font-bold text-white">${e.event_name}</td>
                  <td class="py-3 font-mono">${e.event_date}</td>
                  <td class="py-3 font-mono">${e.start_time} - ${e.end_time}</td>
                  <td class="py-3 font-mono text-amber-400">${e.late_cutoff}</td>
                  <td class="py-3 text-right">
                    <form action="/admin/events/delete/${e.id}" method="POST" onsubmit="return confirm('Delete this event?');">
                      <button type="submit" class="px-2.5 py-1 bg-red-600/20 text-red-400 rounded font-bold">Delete</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      ${tab === 'announcements' ? `
        <div>
          <h2 class="text-2xl font-black mb-1">Announcement System</h2>
          <p class="text-xs text-slate-400">Post notifications displayed instantly on member portals.</p>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">📢 Post New Announcement</h3>
          <form action="/admin/announcements/add" method="POST" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Title</label>
              <input type="text" name="title" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Message Content</label>
              <textarea name="message" required rows="3" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none"></textarea>
            </div>
            <button type="submit" class="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition">Publish Announcement</button>
          </form>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl space-y-4">
          <h3 class="font-bold text-base text-blue-400">Active Announcements</h3>
          ${announcements.map(a => `
            <div class="bg-slate-900 p-4 rounded-xl border border-slate-700 flex justify-between items-start">
              <div>
                <h4 class="font-bold text-white text-sm">${a.title}</h4>
                <p class="text-xs text-slate-300 mt-1">${a.message}</p>
                <span class="text-[10px] text-slate-500 mt-2 block">Posted: ${a.date_posted}</span>
              </div>
              <form action="/admin/announcements/delete/${a.id}" method="POST">
                <button type="submit" class="px-2 py-1 bg-red-600/20 text-red-400 rounded text-xs font-bold">Delete</button>
              </form>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${tab === 'scanners' ? `
        <div>
          <h2 class="text-2xl font-black mb-1">Scanner Accounts Management</h2>
          <p class="text-xs text-slate-400">Create restricted accounts for officers who operate the QR scanner portal.</p>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">📱 Create Scanner Account</h3>
          <form action="/admin/scanners/add" method="POST" class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Officer Name</label>
              <input type="text" name="name" required placeholder="Maria Santos" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Username</label>
              <input type="text" name="username" required placeholder="scanner_maria" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Password</label>
              <input type="password" name="password" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div class="md:col-span-3 flex justify-end">
              <button type="submit" class="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition">Create Scanner Account</button>
            </div>
          </form>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <h3 class="font-bold text-base mb-4 text-blue-400">Active Scanner Operators (${scannerAccounts.length})</h3>
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead>
              <tr class="text-slate-400 border-b border-slate-700">
                <th class="pb-3">Name</th>
                <th class="pb-3">Username</th>
                <th class="pb-3">Standalone Scanner Link</th>
                <th class="pb-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700">
              ${scannerAccounts.map(sc => `
                <tr>
                  <td class="py-3 font-semibold text-white">${sc.name}</td>
                  <td class="py-3 font-mono">${sc.username}</td>
                  <td class="py-3 font-mono text-blue-400"><a href="/scanner" target="_blank" class="underline">/scanner Portal Link</a></td>
                  <td class="py-3 text-right">
                    <form action="/admin/scanners/delete/${sc.id}" method="POST" onsubmit="return confirm('Revoke scanner account?');">
                      <button type="submit" class="px-2.5 py-1 bg-red-600/20 text-red-400 rounded font-bold">Revoke</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      ${tab === 'logs' ? `
        <div>
          <h2 class="text-2xl font-black mb-1">System Audit Logs</h2>
          <p class="text-xs text-slate-400">Immutable trail of administrative and scanning actions.</p>
        </div>
        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl overflow-x-auto">
          <table class="w-full text-left text-xs whitespace-nowrap">
            <thead>
              <tr class="text-slate-400 border-b border-slate-700">
                <th class="pb-3">Timestamp</th>
                <th class="pb-3">User</th>
                <th class="pb-3">Role</th>
                <th class="pb-3">Action</th>
                <th class="pb-3">Details</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700">
              ${auditLogs.map(l => `
                <tr>
                  <td class="py-3 font-mono text-slate-400">${l.timestamp}</td>
                  <td class="py-3 font-bold text-white">${l.username}</td>
                  <td class="py-3 uppercase font-mono text-[10px]">${l.role}</td>
                  <td class="py-3 font-semibold text-blue-400">${l.action}</td>
                  <td class="py-3 text-slate-300">${l.details}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      ${tab === 'settings' ? `
        <div>
          <h2 class="text-2xl font-black mb-1">Organization Settings</h2>
          <p class="text-xs text-slate-400">Customize school details, organization titles, ID card prefixes, and themes.</p>
        </div>

        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow-xl">
          <form action="/admin/settings" method="POST" class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">School Name</label>
              <input type="text" name="school_name" value="${settings.school_name}" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Organization / Club Name</label>
              <input type="text" name="org_name" value="${settings.org_name}" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">School Year</label>
              <input type="text" name="school_year" value="${settings.school_year}" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Member ID Prefix</label>
              <input type="text" name="id_prefix" value="${settings.id_prefix}" required class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">
            </div>
            <div class="md:col-span-2">
              <label class="block text-xs font-semibold text-slate-400 uppercase mb-1">Organization Description</label>
              <textarea name="org_description" rows="2" class="w-full bg-slate-900 border border-slate-700 p-2.5 rounded-xl text-white outline-none">${settings.org_description}</textarea>
            </div>
            <div class="md:col-span-2 flex justify-end">
              <button type="submit" class="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition">Save Changes</button>
            </div>
          </form>
        </div>
      ` : ''}
    </div>
  </main>
</body>
</html>`;
}

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
});
