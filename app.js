/**
 * ClubTrack QR Attendance System
 * Complete Organization and Club Management System for High School (PostgreSQL Version)
 * All-in-one app.js with ID Card & Credentials Printing
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/clubtrack_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'clubtrack-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ==========================================
// DATABASE INITIALIZATION & MIGRATIONS
// ==========================================
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name TEXT DEFAULT 'ABC High School',
        org_name TEXT DEFAULT 'Supreme Student Council',
        school_year TEXT DEFAULT '2026–2027',
        org_description TEXT DEFAULT 'Official student governing body empowering student leadership.',
        theme_color TEXT DEFAULT '#4f46e5',
        org_logo TEXT DEFAULT '',
        id_prefix TEXT DEFAULT 'SSC'
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'scanner', 'member')),
        name TEXT NOT NULL,
        must_change_password BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        member_id TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        middle_name TEXT DEFAULT '',
        last_name TEXT NOT NULL,
        gender TEXT DEFAULT '',
        grade_level TEXT NOT NULL,
        section TEXT NOT NULL,
        position TEXT DEFAULT 'Member',
        contact_info TEXT DEFAULT '',
        email TEXT DEFAULT '',
        profile_photo TEXT DEFAULT '',
        qr_token TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        event_date DATE NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        late_after TEXT NOT NULL,
        requirement TEXT DEFAULT 'All Members'
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL,
        time_in TEXT DEFAULT NULL,
        time_out TEXT DEFAULT NULL,
        status TEXT DEFAULT 'Absent',
        scan_method TEXT DEFAULT 'QR',
        notes TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at DATE DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        username TEXT,
        role TEXT,
        action TEXT,
        details TEXT
      );
    `);

    const settingsCheck = await pool.query('SELECT COUNT(*) FROM organization_settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_description, theme_color, id_prefix)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official student governing body empowering student leadership.', '#4f46e5', 'SSC')
      `);
    }

    const adminCheck = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
    if (parseInt(adminCheck.rows[0].count) === 0) {
      const hashedAdminPass = await bcrypt.hash('admin123', 10);
      await pool.query(`
        INSERT INTO users (username, password, role, name, must_change_password)
        VALUES ('admin', $1, 'admin', 'System Administrator', TRUE)
      `, [hashedAdminPass]);
      console.log('Default Admin user created (username: admin, password: admin123)');
    }

    console.log('PostgreSQL database successfully initialized.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDB();

async function logAction(req, action, details) {
  try {
    const username = req.session && req.session.user ? req.session.user.username : 'Guest';
    const role = req.session && req.session.user ? req.session.user.role : 'guest';
    await pool.query(
      'INSERT INTO audit_logs (username, role, action, details) VALUES ($1, $2, $3, $4)',
      [username, role, action, details]
    );
  } catch (err) {
    console.error('Audit logging failed:', err);
  }
}

function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).send('Access Denied: Administrator privileges required.');
}

function isScanner(req, res, next) {
  if (req.session && req.session.user && (req.session.user.role === 'scanner' || req.session.user.role === 'admin')) return next();
  res.status(403).send('Access Denied: Scanner privileges required.');
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================
app.get('/login', (req, res) => {
  res.send(renderLoginPage());
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.send(renderLoginPage('Invalid username or password.'));
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.send(renderLoginPage('Invalid username or password.'));

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.name,
      mustChangePassword: user.must_change_password
    };

    await logAction(req, 'LOGIN', `User ${user.username} logged in successfully.`);

    if (user.must_change_password) return res.redirect('/force-password-change');
    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member');
  } catch (err) {
    console.error(err);
    res.send(renderLoginPage('An error occurred during login.'));
  }
});

app.get('/force-password-change', isAuthenticated, (req, res) => {
  res.send(renderForcePasswordChangePage());
});

app.post('/force-password-change', isAuthenticated, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (new_password !== confirm_password || new_password.length < 8) {
    return res.send(renderForcePasswordChangePage('Passwords must match and be at least 8 characters long.'));
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows[0];
    const match = await bcrypt.compare(current_password, user.password);
    if (!match) return res.send(renderForcePasswordChangePage('Current temporary password is incorrect.'));

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, user.id]);
    req.session.user.mustChangePassword = false;

    await logAction(req, 'PASSWORD_CHANGE', 'User completed forced temporary password change.');
    
    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member');
  } catch (err) {
    console.error(err);
    res.send(renderForcePasswordChangePage('Database error updating password.'));
  }
});

app.get('/logout', (req, res) => {
  logAction(req, 'LOGOUT', 'User logged out.');
  req.session.destroy(() => { res.redirect('/login'); });
});

app.get('/', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login');
  if (req.session.user.mustChangePassword) return res.redirect('/force-password-change');
  if (req.session.user.role === 'admin') res.redirect('/admin');
  else if (req.session.user.role === 'scanner') res.redirect('/scanner');
  else res.redirect('/member');
});

// ==========================================
// ADMIN PORTAL ROUTES
// ==========================================
app.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  if (req.session.user.mustChangePassword) return res.redirect('/force-password-change');
  const tab = req.query.tab || 'dashboard';
  res.send(await renderAdminPortal(tab, req));
});

app.post('/admin/settings', isAuthenticated, isAdmin, async (req, res) => {
  const { school_name, org_name, school_year, org_description, theme_color, org_logo, id_prefix } = req.body;
  await pool.query(`
    UPDATE organization_settings 
    SET school_name = $1, org_name = $2, school_year = $3, org_description = $4, theme_color = $5, org_logo = $6, id_prefix = $7
  `, [school_name, org_name, school_year, org_description, theme_color, org_logo, id_prefix]);
  await logAction(req, 'SETTINGS_UPDATE', 'Organization settings updated.');
  res.redirect('/admin?tab=settings&success=1');
});

app.post('/admin/members/add', isAuthenticated, isAdmin, async (req, res) => {
  const { first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email } = req.body;
  
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];
  const prefix = settings.id_prefix || 'SSC';

  const countRes = await pool.query('SELECT COUNT(*) FROM members');
  const nextNum = parseInt(countRes.rows[0].count) + 1;
  const memberId = `${prefix}-${settings.school_year.split('–')[0]}-${String(nextNum).padStart(4, '0')}`;

  let baseUsername = (first_name + last_name).toLowerCase().replace(/[^a-z0-9]/g, '');
  let username = baseUsername;
  let suffix = 1;
  while (true) {
    const userCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length === 0) break;
    username = `${baseUsername}${suffix++}`;
  }

  const tempPasswordRaw = crypto.randomBytes(4).toString('hex').toUpperCase();
  const hashedPassword = await bcrypt.hash(tempPasswordRaw, 10);
  const fullName = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;

  const userResult = await pool.query(`
    INSERT INTO users (username, password, role, name, must_change_password)
    VALUES ($1, $2, 'member', $3, TRUE) RETURNING id
  `, [username, hashedPassword, fullName]);
  const userId = userResult.rows[0].id;

  const qrToken = `CLUBTRACK:MEMBER:` + crypto.randomUUID();

  await pool.query(`
    INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email, qr_token, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active')
  `, [userId, memberId, first_name, middle_name || '', last_name, gender, grade_level, section, position, contact_info, email, qrToken]);

  await logAction(req, 'MEMBER_REGISTER', `Registered member ${fullName} (${memberId})`);
  res.redirect(`/admin?tab=members&new_id=${memberId}&temp_pass=${tempPasswordRaw}&new_user=${username}&new_name=${encodeURIComponent(fullName)}&new_grade=${encodeURIComponent(grade_level)}&new_section=${encodeURIComponent(section)}&new_pos=${encodeURIComponent(position)}&new_token=${encodeURIComponent(qrToken)}`);
});

app.post('/admin/members/toggle-status/:id', isAuthenticated, isAdmin, async (req, res) => {
  const memberId = req.params.id;
  const memRes = await pool.query('SELECT status, member_id FROM members WHERE id = $1', [memberId]);
  if (memRes.rows.length > 0) {
    const newStatus = memRes.rows[0].status === 'active' ? 'inactive' : 'active';
    await pool.query('UPDATE members SET status = $1 WHERE id = $2', [newStatus, memberId]);
    await logAction(req, 'MEMBER_STATUS', `Changed status of member ID ${memRes.rows[0].member_id} to ${newStatus}`);
  }
  res.redirect('/admin?tab=members');
});

app.post('/admin/members/reset-password/:id', isAuthenticated, isAdmin, async (req, res) => {
  const memberId = req.params.id;
  const memRes = await pool.query('SELECT user_id, member_id FROM members WHERE id = $1', [memberId]);
  if (memRes.rows.length > 0) {
    const member = memRes.rows[0];
    const newTempPass = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hashed = await bcrypt.hash(newTempPass, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = TRUE WHERE id = $2', [hashed, member.user_id]);
    await logAction(req, 'PASSWORD_RESET', `Reset temporary password for member ID ${member.member_id}`);
    return res.redirect(`/admin?tab=members&reset_pass=${newTempPass}&reset_member=${member.member_id}`);
  }
  res.redirect('/admin?tab=members');
});

// Print/View ID card endpoint for Admin
app.get('/admin/members/id-card/:id', isAuthenticated, isAdmin, async (req, res) => {
  const memberId = req.params.id;
  const memRes = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id WHERE m.id = $1', [memberId]);
  if (memRes.rows.length === 0) return res.status(404).send('Member not found');
  const member = memRes.rows[0];
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];
  const qrDataUrl = await QRCode.toDataURL(member.qr_token);

  res.send(renderIDCardPrintPage(member, settings, qrDataUrl));
});

app.post('/admin/events/add', isAuthenticated, isAdmin, async (req, res) => {
  const { name, description, event_date, start_time, end_time, late_after, requirement } = req.body;
  await pool.query(`
    INSERT INTO events (name, description, event_date, start_time, end_time, late_after, requirement)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [name, description, event_date, start_time, end_time, late_after, requirement]);
  await logAction(req, 'EVENT_CREATE', `Created attendance event: ${name}`);
  res.redirect('/admin?tab=events');
});

app.post('/admin/events/delete/:id', isAuthenticated, isAdmin, async (req, res) => {
  await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
  await logAction(req, 'EVENT_DELETE', `Deleted event ID ${req.params.id}`);
  res.redirect('/admin?tab=events');
});

app.post('/admin/announcements/add', isAuthenticated, isAdmin, async (req, res) => {
  const { title, message, expires_at } = req.body;
  await pool.query('INSERT INTO announcements (title, message, expires_at) VALUES ($1, $2, $3)', [title, message, expires_at || null]);
  await logAction(req, 'ANNOUNCEMENT_CREATE', `Published announcement: ${title}`);
  res.redirect('/admin?tab=announcements');
});

app.post('/admin/announcements/delete/:id', isAuthenticated, isAdmin, async (req, res) => {
  await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
  await logAction(req, 'ANNOUNCEMENT_DELETE', `Deleted announcement ID ${req.params.id}`);
  res.redirect('/admin?tab=announcements');
});

app.post('/admin/scanners/add', isAuthenticated, isAdmin, async (req, res) => {
  const { name, username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, \'scanner\', $3, FALSE)', [username, hashed, name]);
  await logAction(req, 'SCANNER_CREATE', `Created scanner account: ${username}`);
  res.redirect('/admin?tab=scanners');
});

app.post('/admin/attendance/manual', isAuthenticated, isAdmin, async (req, res) => {
  const { member_id, event_id, attendance_date, time_in, time_out, status, reason } = req.body;
  const existing = await pool.query('SELECT id FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member_id, event_id, attendance_date]);
  if (existing.rows.length > 0) {
    await pool.query('UPDATE attendance SET time_in = COALESCE($1, time_in), time_out = COALESCE($2, time_out), status = $3, scan_method = \'MANUAL\', notes = $4 WHERE id = $5', [time_in || null, time_out || null, status, reason, existing.rows[0].id]);
  } else {
    await pool.query('INSERT INTO attendance (member_id, event_id, attendance_date, time_in, time_out, status, scan_method, notes) VALUES ($1, $2, $3, $4, $5, $6, \'MANUAL\', $7)', [member_id, event_id, attendance_date, time_in || null, time_out || null, status, reason]);
  }
  await logAction(req, 'MANUAL_ATTENDANCE', `Manual attendance update for member ID ${member_id}. Reason: ${reason}`);
  res.redirect('/admin?tab=attendance');
});

// ==========================================
// MEMBER PORTAL ROUTES
// ==========================================
app.get('/member', isAuthenticated, async (req, res) => {
  if (req.session.user.mustChangePassword) return res.redirect('/force-password-change');
  if (req.session.user.role !== 'member') return res.redirect('/');

  const memberRes = await pool.query('SELECT * FROM members WHERE user_id = $1', [req.session.user.id]);
  if (memberRes.rows.length === 0) return res.status(404).send('Member profile not found.');
  const member = memberRes.rows[0];

  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];
  const qrDataUrl = await QRCode.toDataURL(member.qr_token);
  const announcementsRes = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5');
  const attendanceRes = await pool.query('SELECT a.*, e.name as event_name FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.member_id = $1 ORDER BY a.attendance_date DESC', [member.id]);

  res.send(renderMemberPortal(member, settings, qrDataUrl, announcementsRes.rows, attendanceRes.rows));
});

// Print ID Card for logged-in member
app.get('/member/id-card', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'member') return res.status(403).send('Unauthorized');
  const memberRes = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id WHERE m.user_id = $1', [req.session.user.id]);
  if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
  const member = memberRes.rows[0];
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];
  const qrDataUrl = await QRCode.toDataURL(member.qr_token);

  res.send(renderIDCardPrintPage(member, settings, qrDataUrl));
});

app.post('/member/settings/password', isAuthenticated, async (req, res) => {
  if (req.session.user.role !== 'member') return res.status(403).send('Unauthorized');
  const { current_password, new_password, confirm_password } = req.body;
  if (new_password !== confirm_password || new_password.length < 8) {
    return res.redirect('/member?error=Password must match and be at least 8 characters.');
  }

  const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
  const match = await bcrypt.compare(current_password, userRes.rows[0].password);
  if (!match) return res.redirect('/member?error=Current password incorrect.');

  const hashed = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.session.user.id]);
  await logAction(req, 'PASSWORD_CHANGE', 'Member updated password successfully.');
  res.redirect('/member?success=Password updated successfully.');
});

// ==========================================
// SCANNER PORTAL ROUTES
// ==========================================
app.get('/scanner', isAuthenticated, isScanner, async (req, res) => {
  if (req.session.user.mustChangePassword) return res.redirect('/force-password-change');
  const eventsRes = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  res.send(renderScannerPortal(eventsRes.rows, settingsRes.rows[0], req.session.user));
});

app.post('/api/scan', isAuthenticated, isScanner, async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  if (!qr_token || !event_id || !scan_type) {
    return res.json({ success: false, error_type: 'INVALID', message: 'Missing scan parameters.' });
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      await logAction(req, 'INVALID_QR_SCAN', `Unregistered QR scanned: ${qr_token}`);
      return res.json({ success: false, error_type: 'UNREGISTERED', message: 'QR Code does not belong to a registered member.' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'active') {
      return res.json({ success: false, error_type: 'INACTIVE', message: 'Member account is currently inactive.' });
    }

    const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    if (eventRes.rows.length === 0) return res.json({ success: false, error_type: 'INVALID', message: 'Selected event not found.' });
    const event = eventRes.rows[0];

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const timeHHMM = now.toTimeString().substring(0, 5);

    let attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, today]);

    if (scan_type === 'TIME_IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          success: false,
          error_type: 'DUPLICATE',
          message: `${member.first_name} ${member.last_name} already has a Time In record for this event.`,
          existing_time: attRes.rows[0].time_in,
          member
        });
      }

      const status = timeHHMM > event.late_after ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [timeStr, status, attRes.rows[0].id]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, \'QR\')', [member.id, event_id, today, timeStr, status]);
      }

      await logAction(req, 'VALID_SCAN_IN', `Time In recorded for ${member.member_id} at event ${event.name}`);
      return res.json({ success: true, scan_type: 'TIME_IN', member, time: timeStr, date: today, status });
    } 
    
    else if (scan_type === 'TIME_OUT') {
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({
          success: false,
          error_type: 'NO_TIME_IN',
          message: `${member.first_name} ${member.last_name} has no Time In record for today's event yet.`,
          member
        });
      }

      if (attRes.rows[0].time_out) {
        return res.json({
          success: false,
          error_type: 'DUPLICATE',
          message: `${member.first_name} ${member.last_name} already recorded Time Out for this event.`,
          existing_time: attRes.rows[0].time_out,
          member
        });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [timeStr, attRes.rows[0].id]);
      await logAction(req, 'VALID_SCAN_OUT', `Time Out recorded for ${member.member_id} at event ${event.name}`);
      return res.json({ success: true, scan_type: 'TIME_OUT', member, time: timeStr, date: today });
    }

  } catch (err) {
    console.error(err);
    res.json({ success: false, error_type: 'ERROR', message: 'Internal server error processing scan.' });
  }
});

// ==========================================
// HTML UI TEMPLATES & GENERATOR FUNCTIONS
// ==========================================

function renderBaseLayout(title, content, themeColor = '#4f46e5') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | ClubTrack QR Attendance</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    :root { --theme-color: ${themeColor}; }
    .bg-theme { background-color: var(--theme-color); }
    .text-theme { color: var(--theme-color); }
    .border-theme { border-color: var(--theme-color); }
    @media print {
      body { background: white !important; }
      .no-print { display: none !important; }
      .print-card { box-shadow: none !important; border: 2px solid #333 !important; }
    }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 font-sans min-h-screen flex flex-col">
  ${content}
</body>
</html>`;
}

function renderIDCardPrintPage(member, settings, qrDataUrl) {
  return renderBaseLayout('Print ID Card', `
    <div class="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-4">
      <div class="no-print mb-4 flex space-x-3">
        <button onclick="window.print()" class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl shadow bg-theme flex items-center space-x-2">
          <i class="fa-solid fa-print"></i><span>Print ID Card</span>
        </button>
        <a href="javascript:history.back()" class="px-5 py-2.5 bg-white border border-slate-300 text-slate-700 font-semibold rounded-xl shadow-sm hover:bg-slate-50 flex items-center space-x-2">
          <i class="fa-solid fa-arrow-left"></i><span>Back</span>
        </a>
      </div>

      <!-- Professional Printable ID Card Container -->
      <div class="print-card w-[350px] bg-white rounded-3xl shadow-2xl border border-slate-200 overflow-hidden p-6 text-center relative">
        <div class="absolute top-0 left-0 right-0 h-3 bg-indigo-600 bg-theme"></div>
        
        <!-- Header -->
        <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mt-2">${settings.school_name}</div>
        <div class="text-sm font-extrabold text-indigo-600 text-theme mb-3">${settings.org_name}</div>
        <div class="text-[10px] bg-slate-100 text-slate-600 uppercase font-semibold py-1 px-2 rounded-md mb-4 inline-block">Official Member ID Card</div>

        <!-- Photo -->
        <div class="w-24 h-24 bg-slate-100 rounded-full mx-auto mb-4 border-4 border-indigo-50 flex items-center justify-center text-slate-400 text-3xl shadow-inner">
          <i class="fa-solid fa-user"></i>
        </div>

        <!-- Name & Details -->
        <h2 class="text-lg font-bold text-slate-800">${member.first_name} ${member.middle_name ? member.middle_name + ' ' : ''}${member.last_name}</h2>
        <p class="text-xs text-indigo-600 font-semibold mb-3 text-theme">${member.position}</p>

        <div class="bg-slate-50 rounded-2xl p-3 text-left text-xs space-y-1.5 mb-4 border border-slate-100 font-medium">
          <div class="flex justify-between"><span class="text-slate-400">Member ID:</span> <span class="font-mono font-bold text-slate-700">${member.member_id}</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Grade & Sec:</span> <span class="text-slate-700">${member.grade_level} - ${member.section}</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Username:</span> <span class="font-mono text-slate-700">${member.username || 'N/A'}</span></div>
          <div class="flex justify-between"><span class="text-slate-400">School Year:</span> <span class="text-slate-700">${settings.school_year}</span></div>
        </div>

        <!-- QR Code -->
        <div class="bg-white p-2 border border-slate-200 rounded-2xl inline-block shadow-sm">
          <img src="${qrDataUrl}" alt="QR Code" class="w-32 h-32 mx-auto">
        </div>
        <p class="text-[9px] text-slate-400 mt-3">This ID is non-transferable and property of the organization.</p>
      </div>
    </div>
  `, settings.theme_color);
}

function renderLoginPage(errorMsg = '') {
  return renderBaseLayout('Login', `
    <div class="flex-1 flex items-center justify-center p-4">
      <div class="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
        <div class="bg-indigo-600 p-6 text-center text-white bg-theme">
          <div class="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl">
            <i class="fa-solid fa-qrcode"></i>
          </div>
          <h1 class="text-2xl font-bold">ClubTrack QR</h1>
          <p class="text-indigo-100 text-sm mt-1">Organization & Club Management System</p>
        </div>
        <div class="p-8">
          ${errorMsg ? `<div class="mb-4 p-3 bg-red-50 border-l-4 border-red-500 text-red-700 text-sm rounded">${errorMsg}</div>` : ''}
          <form action="/login" method="POST" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Username</label>
              <div class="relative">
                <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400"><i class="fa-solid fa-user"></i></span>
                <input type="text" name="username" required class="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 text-sm" placeholder="Enter your username">
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Password</label>
              <div class="relative">
                <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-400"><i class="fa-solid fa-lock"></i></span>
                <input type="password" name="password" id="passwordInput" required class="w-full pl-10 pr-10 py-2 border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-500 text-sm" placeholder="Enter your password">
                <button type="button" onclick="togglePass()" class="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"><i class="fa-solid fa-eye" id="eyeIcon"></i></button>
              </div>
            </div>
            <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md transition duration-200 bg-theme">
              Sign In
            </button>
          </form>
          <div class="mt-6 text-center text-xs text-slate-400">
            Default Admin: <span class="font-mono bg-slate-100 px-1 py-0.5 rounded text-slate-600">admin</span> / <span class="font-mono bg-slate-100 px-1 py-0.5 rounded text-slate-600">admin123</span>
          </div>
        </div>
      </div>
    </div>
    <script>
      function togglePass() {
        const input = document.getElementById('passwordInput');
        const icon = document.getElementById('eyeIcon');
        if (input.type === 'password') { input.type = 'text'; icon.className = 'fa-solid fa-eye-slash'; }
        else { input.type = 'password'; icon.className = 'fa-solid fa-eye'; }
      }
    </script>
  `);
}

function renderForcePasswordChangePage(errorMsg = '') {
  return renderBaseLayout('Secure Password Change', `
    <div class="flex-1 flex items-center justify-center p-4">
      <div class="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100 p-8">
        <div class="text-center mb-6">
          <div class="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-3 text-xl">
            <i class="fa-solid fa-shield-halved"></i>
          </div>
          <h2 class="text-xl font-bold text-slate-800">Security Reminder</h2>
          <p class="text-xs text-slate-500 mt-1">You are logging in with a temporary password. You must change your password before proceeding.</p>
        </div>
        ${errorMsg ? `<div class="mb-4 p-3 bg-red-50 border-l-4 border-red-500 text-red-700 text-sm rounded">${errorMsg}</div>` : ''}
        <form action="/force-password-change" method="POST" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Current Temporary Password</label>
            <input type="password" name="current_password" required class="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">New Private Password (Min 8 chars)</label>
            <input type="password" name="new_password" required minlength="8" class="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1">Confirm New Password</label>
            <input type="password" name="confirm_password" required minlength="8" class="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm">
          </div>
          <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md bg-theme">
            Update Password & Continue
          </button>
        </form>
      </div>
    </div>
  `);
}

async function renderAdminPortal(tab, req) {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];

  const membersCount = (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count;
  const activeMembersCount = (await pool.query("SELECT COUNT(*) FROM members WHERE status = 'active'")).rows[0].count;
  const today = new Date().toISOString().split('T')[0];
  const presentToday = (await pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND time_in IS NOT NULL', [today])).rows[0].count;
  const invalidScansCount = (await pool.query("SELECT COUNT(*) FROM audit_logs WHERE action = 'INVALID_QR_SCAN'")).rows[0].count;

  const members = (await pool.query('SELECT * FROM members ORDER BY last_name ASC')).rows;
  const events = (await pool.query('SELECT * FROM events ORDER BY event_date DESC')).rows;
  const announcements = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC')).rows;
  const scanners = (await pool.query("SELECT * FROM users WHERE role = 'scanner'")).rows;
  const logs = (await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 50')).rows;
  const liveAttendance = (await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.member_id, m.grade_level, m.section, e.name as event_name 
    FROM attendance a 
    JOIN members m ON a.member_id = m.id 
    JOIN events e ON a.event_id = e.id 
    ORDER BY a.id DESC LIMIT 20
  `)).rows;

  const newId = req.query.new_id;
  const tempPass = req.query.temp_pass;
  const newUser = req.query.new_user;
  const newName = req.query.new_name;
  const newGrade = req.query.new_grade;
  const newSection = req.query.new_section;
  const newPos = req.query.new_pos;
  const newToken = req.query.new_token;

  let newlyCreatedMember = null;
  if (newId && newToken) {
    newlyCreatedMember = members.find(m => m.member_id === newId);
  }

  return renderBaseLayout('Admin Portal', `
    <div class="flex h-screen overflow-hidden">
      <!-- Sidebar -->
      <aside class="w-64 bg-slate-900 text-slate-300 flex flex-col hidden md:flex no-print">
        <div class="p-5 border-b border-slate-800 flex items-center space-x-3">
          <div class="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold bg-theme">
            <i class="fa-solid fa-qrcode"></i>
          </div>
          <div>
            <h2 class="font-bold text-white text-sm">${settings.org_name}</h2>
            <p class="text-xs text-slate-400">Admin Portal</p>
          </div>
        </div>
        <nav class="flex-1 p-4 space-y-1 overflow-y-auto text-sm">
          <a href="/admin?tab=dashboard" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'dashboard' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-chart-pie w-5"></i><span>Dashboard</span></a>
          <a href="/admin?tab=members" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'members' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-users w-5"></i><span>Members</span></a>
          <a href="/admin?tab=attendance" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'attendance' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-clipboard-user w-5"></i><span>Attendance</span></a>
          <a href="/admin?tab=events" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'events' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-calendar-days w-5"></i><span>Events</span></a>
          <a href="/admin?tab=announcements" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'announcements' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-bullhorn w-5"></i><span>Announcements</span></a>
          <a href="/admin?tab=scanners" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'scanners' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-barcode w-5"></i><span>Scanner Accounts</span></a>
          <a href="/admin?tab=logs" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'logs' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-shield-cat w-5"></i><span>System Logs</span></a>
          <a href="/admin?tab=settings" class="flex items-center space-x-3 px-3 py-2.5 rounded-lg ${tab === 'settings' ? 'bg-indigo-600 text-white bg-theme' : 'hover:bg-slate-800'}"><i class="fa-solid fa-gears w-5"></i><span>Settings</span></a>
        </nav>
        <div class="p-4 border-t border-slate-800">
          <a href="/logout" class="flex items-center space-x-3 px-3 py-2 rounded-lg text-red-400 hover:bg-slate-800 text-sm"><i class="fa-solid fa-right-from-bracket w-5"></i><span>Sign Out</span></a>
        </div>
      </aside>

      <!-- Main Content -->
      <div class="flex-1 flex flex-col overflow-hidden">
        <header class="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-6 shadow-sm no-print">
          <h1 class="font-bold text-lg text-slate-800 capitalize">${tab.replace('_', ' ')} Management</h1>
          <div class="flex items-center space-x-4">
            <a href="/scanner" target="_blank" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg flex items-center space-x-1"><i class="fa-solid fa-qrcode"></i><span>Open Scanner Portal</span></a>
            <span class="text-xs text-slate-500 font-medium">Administrator</span>
          </div>
        </header>

        <main class="flex-1 overflow-y-auto p-6 bg-slate-50">
          ${newId ? `
            <div class="mb-6 bg-emerald-50 border border-emerald-200 rounded-xl p-6 text-emerald-900 shadow-sm">
              <h3 class="font-bold text-emerald-800 text-lg mb-2"><i class="fa-solid fa-circle-check"></i> Member Successfully Registered</h3>
              <p class="text-sm mb-4">Credentials generated for <strong>${newName}</strong>. You can print their official ID card containing their QR code, credentials, section, grade level, and position.</p>
              <div class="bg-white p-4 rounded-xl border border-emerald-200 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm font-mono mb-4">
                <div><strong>Member ID:</strong> ${newId}</div>
                <div><strong>Username:</strong> ${newUser}</div>
                <div><strong>Temp Password:</strong> <span class="bg-amber-100 px-2 py-0.5 rounded text-amber-900">${tempPass}</span></div>
              </div>
              ${newlyCreatedMember ? `
                <a href="/admin/members/id-card/${newlyCreatedMember.id}" target="_blank" class="inline-flex items-center space-x-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl shadow bg-theme">
                  <i class="fa-solid fa-id-card"></i><span>Print Member ID Card & Credentials</span>
                </a>
              ` : ''}
            </div>
          ` : ''}

          <!-- TAB: DASHBOARD -->
          ${tab === 'dashboard' ? `
            <div class="space-y-6">
              <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                  <div class="text-xs font-semibold uppercase text-slate-400">Total Members</div>
                  <div class="text-3xl font-bold text-slate-800 mt-1">${membersCount}</div>
                </div>
                <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                  <div class="text-xs font-semibold uppercase text-slate-400">Active Members</div>
                  <div class="text-3xl font-bold text-emerald-600 mt-1">${activeMembersCount}</div>
                </div>
                <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                  <div class="text-xs font-semibold uppercase text-slate-400">Present Today</div>
                  <div class="text-3xl font-bold text-indigo-600 mt-1">${presentToday}</div>
                </div>
                <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                  <div class="text-xs font-semibold uppercase text-slate-400">Invalid Scans Logged</div>
                  <div class="text-3xl font-bold text-red-600 mt-1">${invalidScansCount}</div>
                </div>
              </div>

              <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div class="px-6 py-4 border-b border-slate-100 font-bold text-slate-800 flex justify-between items-center">
                  <span>Live Attendance Stream</span>
                  <span class="text-xs bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full font-medium">Real-time</span>
                </div>
                <div class="overflow-x-auto">
                  <table class="w-full text-left text-sm">
                    <thead class="bg-slate-50 text-slate-500 uppercase text-xs">
                      <tr>
                        <th class="px-6 py-3">Member</th>
                        <th class="px-6 py-3">Event</th>
                        <th class="px-6 py-3">Time In</th>
                        <th class="px-6 py-3">Time Out</th>
                        <th class="px-6 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">
                      ${liveAttendance.length === 0 ? `<tr><td colspan="5" class="px-6 py-4 text-center text-slate-400">No attendance records today.</td></tr>` : 
                        liveAttendance.map(row => `
                          <tr class="hover:bg-slate-50">
                            <td class="px-6 py-3 font-medium text-slate-800">${row.first_name} ${row.last_name} <span class="text-xs text-slate-400 block">${row.member_id}</span></td>
                            <td class="px-6 py-3">${row.event_name}</td>
                            <td class="px-6 py-3 font-mono text-xs">${row.time_in || '—'}</td>
                            <td class="px-6 py-3 font-mono text-xs">${row.time_out || '—'}</td>
                            <td class="px-6 py-3"><span class="px-2.5 py-1 text-xs rounded-full font-medium ${row.status === 'Present' ? 'bg-emerald-100 text-emerald-700' : row.status === 'Late' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}">${row.status}</span></td>
                          </tr>
                        `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ` : ''}

          <!-- TAB: MEMBERS -->
          ${tab === 'members' ? `
            <div class="space-y-6">
              <div class="flex justify-between items-center">
                <h2 class="text-xl font-bold text-slate-800">Member Directory</h2>
                <button onclick="document.getElementById('addMemberModal').classList.remove('hidden')" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold shadow bg-theme flex items-center space-x-2">
                  <i class="fa-solid fa-user-plus"></i><span>Register Member</span>
                </button>
              </div>

              <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table class="w-full text-left text-sm">
                  <thead class="bg-slate-50 text-slate-500 uppercase text-xs">
                    <tr>
                      <th class="px-6 py-3">Member ID</th>
                      <th class="px-6 py-3">Full Name</th>
                      <th class="px-6 py-3">Grade & Section</th>
                      <th class="px-6 py-3">Position</th>
                      <th class="px-6 py-3">Status</th>
                      <th class="px-6 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100">
                    ${members.map(m => `
                      <tr class="hover:bg-slate-50">
                        <td class="px-6 py-3 font-mono text-xs font-semibold">${m.member_id}</td>
                        <td class="px-6 py-3 font-medium text-slate-800">${m.first_name} ${m.last_name}</td>
                        <td class="px-6 py-3">${m.grade_level} - ${m.section}</td>
                        <td class="px-6 py-3">${m.position}</td>
                        <td class="px-6 py-3"><span class="px-2.5 py-1 text-xs rounded-full font-medium ${m.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}">${m.status}</span></td>
                        <td class="px-6 py-3 text-right space-x-3">
                          <a href="/admin/members/id-card/${m.id}" target="_blank" title="Print ID Card & QR" class="text-indigo-600 hover:text-indigo-800"><i class="fa-solid fa-id-card"></i></a>
                          <form action="/admin/members/reset-password/${m.id}" method="POST" class="inline">
                            <button type="submit" title="Reset Password" class="text-amber-600 hover:text-amber-800"><i class="fa-solid fa-key"></i></button>
                          </form>
                          <form action="/admin/members/toggle-status/${m.id}" method="POST" class="inline">
                            <button type="submit" title="Toggle Status" class="text-slate-500 hover:text-slate-800"><i class="fa-solid fa-power-off"></i></button>
                          </form>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Add Member Modal -->
            <div id="addMemberModal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
              <div class="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl">
                <div class="flex justify-between items-center mb-4">
                  <h3 class="text-lg font-bold text-slate-800">Register New Organization Member</h3>
                  <button onclick="document.getElementById('addMemberModal').classList.add('hidden')" class="text-slate-400 hover:text-slate-600"><i class="fa-solid fa-xmark text-lg"></i></button>
                </div>
                <form action="/admin/members/add" method="POST" class="space-y-4">
                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">First Name</label>
                      <input type="text" name="first_name" required class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Last Name</label>
                      <input type="text" name="last_name" required class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Grade Level</label>
                      <input type="text" name="grade_level" placeholder="Grade 10" required class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Section</label>
                      <input type="text" name="section" placeholder="Rizal" required class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Position</label>
                      <input type="text" name="position" value="Member" required class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Gender</label>
                      <input type="text" name="gender" class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                  </div>
                  <button type="submit" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg bg-theme shadow">Create Member Account</button>
                </form>
              </div>
            </div>
          ` : ''}

          <!-- TAB: EVENTS -->
          ${tab === 'events' ? `
            <div class="space-y-6">
              <div class="flex justify-between items-center">
                <h2 class="text-xl font-bold text-slate-800">Attendance Events</h2>
                <button onclick="document.getElementById('addEventModal').classList.remove('hidden')" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold shadow bg-theme">Create Event</button>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                ${events.map(e => `
                  <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between">
                    <div>
                      <h3 class="font-bold text-slate-800 text-lg mb-1">${e.name}</h3>
                      <p class="text-xs text-slate-500 mb-4">${e.description || 'No description provided.'}</p>
                      <div class="space-y-1 text-xs text-slate-600">
                        <div><i class="fa-solid fa-calendar w-5 text-indigo-500"></i> ${e.event_date}</div>
                        <div><i class="fa-solid fa-clock w-5 text-indigo-500"></i> ${e.start_time} - ${e.end_time}</div>
                        <div><i class="fa-solid fa-triangle-exclamation w-5 text-amber-500"></i> Late after: ${e.late_after}</div>
                      </div>
                    </div>
                    <div class="mt-6 pt-4 border-t border-slate-100 flex justify-end">
                      <form action="/admin/events/delete/${e.id}" method="POST">
                        <button type="submit" class="text-red-500 hover:text-red-700 text-xs font-semibold"><i class="fa-solid fa-trash"></i> Delete</button>
                      </form>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Add Event Modal -->
            <div id="addEventModal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
              <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                <h3 class="text-lg font-bold text-slate-800 mb-4">Create Attendance Event</h3>
                <form action="/admin/events/add" method="POST" class="space-y-4">
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Event Name</label>
                    <input type="text" name="name" required class="w-full px-3 py-2 border rounded-lg text-sm">
                  </div>
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Description</label>
                    <textarea name="description" class="w-full px-3 py-2 border rounded-lg text-sm"></textarea>
                  </div>
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Date</label>
                    <input type="date" name="event_date" required class="w-full px-3 py-2 border rounded-lg text-sm">
                  </div>
                  <div class="grid grid-cols-3 gap-2">
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Start</label>
                      <input type="time" name="start_time" required class="w-full px-2 py-2 border rounded-lg text-sm">
                    </div>
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">End</label>
                      <input type="time" name="end_time" required class="w-full px-2 py-2 border rounded-lg text-sm">
                    </div>
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Late After</label>
                      <input type="time" name="late_after" required class="w-full px-2 py-2 border rounded-lg text-sm">
                    </div>
                  </div>
                  <button type="submit" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg bg-theme shadow">Save Event</button>
                </form>
              </div>
            </div>
          ` : ''}

          <!-- TAB: ANNOUNCEMENTS -->
          ${tab === 'announcements' ? `
            <div class="space-y-6">
              <div class="flex justify-between items-center">
                <h2 class="text-xl font-bold text-slate-800">Organization Announcements</h2>
                <button onclick="document.getElementById('addAnnouncementModal').classList.remove('hidden')" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold shadow bg-theme">Post Announcement</button>
              </div>
              <div class="space-y-4">
                ${announcements.map(a => `
                  <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex justify-between items-start">
                    <div>
                      <h3 class="font-bold text-slate-800 text-base">${a.title}</h3>
                      <p class="text-sm text-slate-600 mt-1">${a.message}</p>
                      <span class="text-xs text-slate-400 mt-3 block">Posted on: ${a.created_at}</span>
                    </div>
                    <form action="/admin/announcements/delete/${a.id}" method="POST">
                      <button type="submit" class="text-red-500 hover:text-red-700 text-xs"><i class="fa-solid fa-trash"></i></button>
                    </form>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Add Announcement Modal -->
            <div id="addAnnouncementModal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
              <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                <h3 class="text-lg font-bold text-slate-800 mb-4">Post Announcement</h3>
                <form action="/admin/announcements/add" method="POST" class="space-y-4">
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Title</label>
                    <input type="text" name="title" required class="w-full px-3 py-2 border rounded-lg text-sm">
                  </div>
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Message</label>
                    <textarea name="message" rows="4" required class="w-full px-3 py-2 border rounded-lg text-sm"></textarea>
                  </div>
                  <button type="submit" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg bg-theme shadow">Publish Announcement</button>
                </form>
              </div>
            </div>
          ` : ''}

          <!-- TAB: SCANNERS -->
          ${tab === 'scanners' ? `
            <div class="space-y-6">
              <div class="flex justify-between items-center">
                <h2 class="text-xl font-bold text-slate-800">Scanner Accounts</h2>
                <button onclick="document.getElementById('addScannerModal').classList.remove('hidden')" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold shadow bg-theme">Create Scanner Account</button>
              </div>
              <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table class="w-full text-left text-sm">
                  <thead class="bg-slate-50 text-slate-500 uppercase text-xs">
                    <tr>
                      <th class="px-6 py-3">Name</th>
                      <th class="px-6 py-3">Username</th>
                      <th class="px-6 py-3">Role</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100">
                    ${scanners.map(s => `
                      <tr class="hover:bg-slate-50">
                        <td class="px-6 py-3 font-medium text-slate-800">${s.name}</td>
                        <td class="px-6 py-3 font-mono text-xs">${s.username}</td>
                        <td class="px-6 py-3"><span class="px-2.5 py-1 text-xs bg-indigo-100 text-indigo-700 rounded-full font-medium">Scanner</span></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Add Scanner Modal -->
            <div id="addScannerModal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
              <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
                <h3 class="text-lg font-bold text-slate-800 mb-4">Create Scanner Account</h3>
                <form action="/admin/scanners/add" method="POST" class="space-y-4">
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Full Name / Officer Name</label>
                    <input type="text" name="name" required class="w-full px-3 py-2 border rounded-lg text-sm">
                  </div>
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Username</label>
                    <input type="text" name="username" required class="w-full px-3 py-2 border rounded-lg text-sm">
                  </div>
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Password</label>
                    <input type="password" name="password" required class="w-full px-3 py-2 border rounded-lg text-sm">
                  </div>
                  <button type="submit" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg bg-theme shadow">Create Scanner</button>
                </form>
              </div>
            </div>
          ` : ''}

          <!-- TAB: LOGS -->
          ${tab === 'logs' ? `
            <div class="space-y-6">
              <h2 class="text-xl font-bold text-slate-800">System Audit Logs</h2>
              <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table class="w-full text-left text-sm">
                  <thead class="bg-slate-50 text-slate-500 uppercase text-xs">
                    <tr>
                      <th class="px-6 py-3">Timestamp</th>
                      <th class="px-6 py-3">User</th>
                      <th class="px-6 py-3">Action</th>
                      <th class="px-6 py-3">Details</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 font-mono text-xs">
                    ${logs.map(l => `
                      <tr class="hover:bg-slate-50">
                        <td class="px-6 py-3">${l.timestamp}</td>
                        <td class="px-6 py-3">${l.username} (${l.role})</td>
                        <td class="px-6 py-3 text-indigo-600 font-bold">${l.action}</td>
                        <td class="px-6 py-3 text-slate-600">${l.details}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          ` : ''}

          <!-- TAB: SETTINGS -->
          ${tab === 'settings' ? `
            <div class="max-w-xl bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <h2 class="text-xl font-bold text-slate-800 mb-4">Organization & System Settings</h2>
              <form action="/admin/settings" method="POST" class="space-y-4">
                <div>
                  <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">School Name</label>
                  <input type="text" name="school_name" value="${settings.school_name}" required class="w-full px-3 py-2 border rounded-lg text-sm">
                </div>
                <div>
                  <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Organization Name</label>
                  <input type="text" name="org_name" value="${settings.org_name}" required class="w-full px-3 py-2 border rounded-lg text-sm">
                </div>
                <div>
                  <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">School Year</label>
                  <input type="text" name="school_year" value="${settings.school_year}" required class="w-full px-3 py-2 border rounded-lg text-sm">
                </div>
                <div>
                  <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Member ID Prefix</label>
                  <input type="text" name="id_prefix" value="${settings.id_prefix}" required class="w-full px-3 py-2 border rounded-lg text-sm">
                </div>
                <div>
                  <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Theme Accent Color</label>
                  <input type="color" name="theme_color" value="${settings.theme_color || '#4f46e5'}" class="w-full h-10 border rounded-lg px-2 cursor-pointer">
                </div>
                <div>
                  <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Organization Description</label>
                  <textarea name="org_description" rows="3" class="w-full px-3 py-2 border rounded-lg text-sm">${settings.org_description}</textarea>
                </div>
                <button type="submit" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg bg-theme shadow">Save Changes</button>
              </form>
            </div>
          ` : ''}

          <!-- TAB: ATTENDANCE MANAGEMENT -->
          ${tab === 'attendance' ? `
            <div class="space-y-6">
              <h2 class="text-xl font-bold text-slate-800">Manual Attendance Override</h2>
              <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 max-w-xl">
                <form action="/admin/attendance/manual" method="POST" class="space-y-4">
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Select Member</label>
                    <select name="member_id" required class="w-full px-3 py-2 border rounded-lg text-sm">
                      ${members.map(m => `<option value="${m.id}">${m.first_name} ${m.last_name} (${m.member_id})</option>`).join('')}
                    </select>
                  </div>
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Select Event</label>
                    <select name="event_id" required class="w-full px-3 py-2 border rounded-lg text-sm">
                      ${events.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('')}
                    </select>
                  </div>
                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Attendance Date</label>
                      <input type="date" name="attendance_date" value="${today}" required class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Status</label>
                      <select name="status" class="w-full px-3 py-2 border rounded-lg text-sm">
                        <option value="Present">Present</option>
                        <option value="Late">Late</option>
                        <option value="Absent">Absent</option>
                      </select>
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-4">
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Time In (Optional)</label>
                      <input type="text" name="time_in" placeholder="08:00 AM" class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                    <div>
                      <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Time Out (Optional)</label>
                      <input type="text" name="time_out" placeholder="04:00 PM" class="w-full px-3 py-2 border rounded-lg text-sm">
                    </div>
                  </div>
                  <div>
                    <label class="block text-xs font-semibold uppercase text-slate-500 mb-1">Reason for Manual Override</label>
                    <input type="text" name="reason" placeholder="e.g. QR Scanner offline / excused absence" required class="w-full px-3 py-2 border rounded-lg text-sm">
                  </div>
                  <button type="submit" class="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg bg-theme shadow">Submit Manual Record</button>
                </form>
              </div>
            </div>
          ` : ''}

        </main>
      </div>
    </div>
  `, settings.theme_color);
}

function renderMemberPortal(member, settings, qrDataUrl, announcements, attendanceRecords) {
  return renderBaseLayout('Member Portal', `
    <div class="min-h-screen bg-slate-100 flex flex-col">
      <!-- Top Navigation -->
      <header class="bg-indigo-600 text-white shadow-md bg-theme no-print">
        <div class="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center font-bold">
              <i class="fa-solid fa-id-card"></i>
            </div>
            <div>
              <h1 class="font-bold text-base">${settings.org_name}</h1>
              <p class="text-xs text-indigo-100">${settings.school_name}</p>
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <span class="text-sm font-medium hidden sm:inline">Hello, ${member.first_name}</span>
            <a href="/logout" class="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-semibold transition"><i class="fa-solid fa-right-from-bracket"></i> Sign Out</a>
          </div>
        </div>
      </header>

      <main class="max-w-5xl mx-auto px-4 py-6 flex-1 w-full grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Left: Digital ID Card -->
        <div class="space-y-6">
          <div class="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden text-center p-6 relative">
            <div class="absolute top-3 right-3 no-print">
              <span class="px-2.5 py-1 text-xs rounded-full font-bold uppercase ${member.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}">${member.status}</span>
            </div>
            <div class="text-xs uppercase font-bold tracking-wider text-slate-400 mb-1">${settings.school_name}</div>
            <div class="text-base font-bold text-indigo-600 text-theme mb-3">${settings.org_name}</div>
            <div class="w-24 h-24 bg-slate-100 rounded-full mx-auto mb-4 border-4 border-indigo-50 flex items-center justify-center text-slate-400 text-3xl">
              <i class="fa-solid fa-user"></i>
            </div>
            <h2 class="text-xl font-bold text-slate-800">${member.first_name} ${member.middle_name} ${member.last_name}</h2>
            <p class="text-xs text-slate-500 mb-4 font-medium">${member.position}</p>

            <div class="bg-slate-50 rounded-xl p-3 text-left text-xs space-y-1 mb-4 border border-slate-100">
              <div class="flex justify-between"><span class="text-slate-400">Member ID:</span> <span class="font-mono font-bold text-slate-700">${member.member_id}</span></div>
              <div class="flex justify-between"><span class="text-slate-400">Grade & Section:</span> <span class="font-medium text-slate-700">${member.grade_level} - ${member.section}</span></div>
              <div class="flex justify-between"><span class="text-slate-400">School Year:</span> <span class="font-medium text-slate-700">${settings.school_year}</span></div>
            </div>

            <div class="bg-white p-3 border border-slate-200 rounded-xl inline-block shadow-sm mb-4">
              <img src="${qrDataUrl}" alt="Member QR Code" class="w-36 h-36 mx-auto">
              <p class="text-[10px] text-slate-400 mt-2 font-mono">SECURE QR TOKEN</p>
            </div>

            <div class="no-print">
              <a href="/member/id-card" target="_blank" class="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl shadow bg-theme flex items-center justify-center space-x-2">
                <i class="fa-solid fa-print"></i><span>Print ID Card</span>
              </a>
            </div>
          </div>
        </div>

        <!-- Right: Attendance & Announcements -->
        <div class="md:col-span-2 space-y-6">
          <!-- Announcements -->
          <div class="bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
            <h3 class="font-bold text-slate-800 text-base mb-4 flex items-center space-x-2">
              <i class="fa-solid fa-bullhorn text-indigo-600 text-theme"></i><span>Organization Announcements</span>
            </h3>
            <div class="space-y-3">
              ${announcements.length === 0 ? `<p class="text-xs text-slate-400">No announcements posted.</p>` :
                announcements.map(a => `
                  <div class="p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <h4 class="font-bold text-slate-800 text-sm">${a.title}</h4>
                    <p class="text-xs text-slate-600 mt-1">${a.message}</p>
                    <span class="text-[10px] text-slate-400 mt-2 block">${a.created_at}</span>
                  </div>
                `).join('')}
            </div>
          </div>

          <!-- My Attendance History -->
          <div class="bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
            <h3 class="font-bold text-slate-800 text-base mb-4 flex items-center space-x-2">
              <i class="fa-solid fa-clipboard-user text-indigo-600 text-theme"></i><span>My Attendance Records</span>
            </h3>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead class="bg-slate-50 text-slate-500 uppercase text-xs">
                  <tr>
                    <th class="px-4 py-3">Date</th>
                    <th class="px-4 py-3">Time In</th>
                    <th class="px-4 py-3">Time Out</th>
                    <th class="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 text-xs">
                  ${attendanceRecords.length === 0 ? `<tr><td colspan="4" class="px-4 py-4 text-center text-slate-400">No attendance recorded yet.</td></tr>` :
                    attendanceRecords.map(r => `
                      <tr class="hover:bg-slate-50">
                        <td class="px-4 py-3 font-medium">${r.attendance_date}</td>
                        <td class="px-4 py-3 font-mono">${r.time_in || '—'}</td>
                        <td class="px-4 py-3 font-mono">${r.time_out || '—'}</td>
                        <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full font-medium ${r.status === 'Present' ? 'bg-emerald-100 text-emerald-700' : r.status === 'Late' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}">${r.status}</span></td>
                      </tr>
                    `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  `, settings.theme_color);
}

function renderScannerPortal(events, settings, user) {
  return renderBaseLayout('QR Scanner Portal', `
    <div class="min-h-screen bg-slate-900 text-white flex flex-col">
      <!-- Scanner Header -->
      <header class="bg-slate-800 border-b border-slate-700 p-4 flex justify-between items-center shadow">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center font-bold bg-theme">
            <i class="fa-solid fa-qrcode"></i>
          </div>
          <div>
            <h1 class="font-bold text-sm">ClubTrack QR Scanner</h1>
            <p class="text-xs text-slate-400">Operator: ${user.name}</p>
          </div>
        </div>
        <div class="flex items-center space-x-3">
          <button onclick="toggleAudio()" id="audioToggleBtn" class="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-semibold flex items-center space-x-1.5">
            <i class="fa-solid fa-volume-high text-emerald-400" id="audioIcon"></i><span id="audioText">Sound: ON</span>
          </button>
          <a href="/logout" class="px-3 py-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-lg text-xs font-semibold">Sign Out</a>
        </div>
      </header>

      <main class="flex-1 max-w-lg w-full mx-auto p-4 flex flex-col space-y-4 justify-center">
        <!-- Event Selection -->
        <div class="bg-slate-800 p-4 rounded-2xl border border-slate-700">
          <label class="block text-xs font-semibold uppercase text-slate-400 mb-2">1. Select Attendance Event</label>
          <select id="eventSelect" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
            ${events.map(e => `<option value="${e.id}">${e.name} (${e.event_date})</option>`).join('')}
          </select>
        </div>

        <!-- Scan Type Buttons -->
        <div class="grid grid-cols-2 gap-3">
          <button onclick="setScanType('TIME_IN')" id="btnTimeIn" class="py-4 bg-indigo-600 text-white font-bold rounded-2xl shadow-lg border-2 border-indigo-400 text-base flex flex-col items-center justify-center space-y-1 bg-theme transition">
            <i class="fa-solid fa-right-to-bracket text-lg"></i>
            <span>TIME IN</span>
          </button>
          <button onclick="setScanType('TIME_OUT')" id="btnTimeOut" class="py-4 bg-slate-800 text-slate-400 font-bold rounded-2xl shadow-lg border-2 border-slate-700 text-base flex flex-col items-center justify-center space-y-1 transition">
            <i class="fa-solid fa-right-from-bracket text-lg"></i>
            <span>TIME OUT</span>
          </button>
        </div>

        <!-- Camera Scanner Card -->
        <div class="bg-slate-800 rounded-2xl border border-slate-700 p-4 text-center">
          <div id="reader" class="w-full rounded-xl overflow-hidden mb-4 bg-black min-h-[250px] flex items-center justify-center">
            <p class="text-xs text-slate-500">Camera preview will appear here when started.</p>
          </div>
          <button onclick="startScanner()" id="startCamBtn" class="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow transition">
            <i class="fa-solid fa-camera mr-2"></i> Start Camera Scanner
          </button>
        </div>

        <!-- Scan Result Toast Overlay -->
        <div id="scanResultModal" class="hidden fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div id="resultCard" class="bg-slate-800 border-2 border-emerald-500 rounded-3xl max-w-sm w-full p-6 text-center shadow-2xl">
            <div id="resultIcon" class="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-3 text-3xl">
              <i class="fa-solid fa-check"></i>
            </div>
            <h3 id="resultTitle" class="text-xl font-bold text-white mb-1">QR CODE ACCEPTED</h3>
            <p id="resultName" class="text-lg font-bold text-emerald-400 mb-1">Juan Dela Cruz</p>
            <p id="resultDetails" class="text-xs text-slate-400 mb-6 font-mono">Member ID: SSC-2026-0001</p>
            <button onclick="closeResultModal()" class="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-xl">Scan Next</button>
          </div>
        </div>
      </main>
    </div>

    <!-- html5-qrcode library CDN -->
    <script src="https://unpkg.com/html5-qrcode"></script>
    <script>
      let currentScanType = 'TIME_IN';
      let soundEnabled = true;
      let html5QrCode = null;
      let isProcessing = false;

      function setScanType(type) {
        currentScanType = type;
        const btnIn = document.getElementById('btnTimeIn');
        const btnOut = document.getElementById('btnTimeOut');
        if (type === 'TIME_IN') {
          btnIn.className = 'py-4 bg-indigo-600 text-white font-bold rounded-2xl shadow-lg border-2 border-indigo-400 text-base flex flex-col items-center justify-center space-y-1 bg-theme transition';
          btnOut.className = 'py-4 bg-slate-800 text-slate-400 font-bold rounded-2xl shadow-lg border-2 border-slate-700 text-base flex flex-col items-center justify-center space-y-1 transition';
        } else {
          btnOut.className = 'py-4 bg-indigo-600 text-white font-bold rounded-2xl shadow-lg border-2 border-indigo-400 text-base flex flex-col items-center justify-center space-y-1 bg-theme transition';
          btnIn.className = 'py-4 bg-slate-800 text-slate-400 font-bold rounded-2xl shadow-lg border-2 border-slate-700 text-base flex flex-col items-center justify-center space-y-1 transition';
        }
      }

      function toggleAudio() {
        soundEnabled = !soundEnabled;
        const icon = document.getElementById('audioIcon');
        const text = document.getElementById('audioText');
        if (soundEnabled) {
          icon.className = 'fa-solid fa-volume-high text-emerald-400';
          text.innerText = 'Sound: ON';
        } else {
          icon.className = 'fa-solid fa-volume-xmark text-red-400';
          text.innerText = 'Sound: OFF';
        }
      }

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      function playBeep(type) {
        if (!soundEnabled) return;
        if (audioCtx.state === 'suspended') { audioCtx.resume(); }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        if (type === 'success') {
          osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
          gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.15);
        } else if (type === 'duplicate') {
          osc.frequency.setValueAtTime(440, audioCtx.currentTime);
          gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.3);
        } else {
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(150, audioCtx.currentTime);
          gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.4);
        }
      }

      function startScanner() {
        if (audioCtx.state === 'suspended') { audioCtx.resume(); }
        const startBtn = document.getElementById('startCamBtn');
        startBtn.style.display = 'none';

        html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          async (decodedText) => {
            if (isProcessing) return;
            isProcessing = true;
            await processScanToken(decodedText);
            setTimeout(() => { isProcessing = false; }, 2500);
          },
          (error) => {}
        ).catch(err => {
          alert("Camera initialization error: " + err);
          startBtn.style.display = 'block';
        });
      }

      async function processScanToken(token) {
        const eventId = document.getElementById('eventSelect').value;
        try {
          const response = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: token, event_id: eventId, scan_type: currentScanType })
          });
          const data = await response.json();
          showResultModal(data);
        } catch (err) {
          console.error(err);
          isProcessing = false;
        }
      }

      function showResultModal(data) {
        const modal = document.getElementById('scanResultModal');
        const card = document.getElementById('resultCard');
        const icon = document.getElementById('resultIcon');
        const title = document.getElementById('resultTitle');
        const name = document.getElementById('resultName');
        const details = document.getElementById('resultDetails');

        modal.classList.remove('hidden');

        if (data.success) {
          playBeep('success');
          card.className = 'bg-slate-800 border-2 border-emerald-500 rounded-3xl max-w-sm w-full p-6 text-center shadow-2xl';
          icon.className = 'w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-3 text-3xl';
          icon.innerHTML = '<i class="fa-solid fa-check"></i>';
          title.innerText = data.scan_type === 'TIME_IN' ? 'TIME IN RECORDED' : 'TIME OUT RECORDED';
          name.innerText = data.member.first_name + ' ' + data.member.last_name;
          details.innerText = 'Member ID: ' + data.member.member_id + ' | Time: ' + data.time;
        } else {
          if (data.error_type === 'DUPLICATE') playBeep('duplicate');
          else playBeep('error');

          card.className = 'bg-slate-800 border-2 border-red-500 rounded-3xl max-w-sm w-full p-6 text-center shadow-2xl';
          icon.className = 'w-16 h-16 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center mx-auto mb-3 text-3xl';
          icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
          title.innerText = data.error_type === 'DUPLICATE' ? 'ALREADY RECORDED' : 'INVALID QR CODE';
          name.innerText = data.member ? (data.member.first_name + ' ' + data.member.last_name) : 'Unrecognized QR';
          details.innerText = data.message;
        }
      }

      function closeResultModal() {
        document.getElementById('scanResultModal').classList.add('hidden');
      }
    </script>
  `, settings.theme_color);
}

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
});
