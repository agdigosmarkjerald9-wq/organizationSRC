/**
 * ClubTrack QR Attendance System
 * High School Organization and Club Management System
 * Built with Node.js, Express, PostgreSQL, and Embedded Modern HTML/CSS/JS Frontend
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool Setup
// Render supplies process.env.DATABASE_URL automatically when attached to a Postgres instance.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/clubtrack',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'clubtrack-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // Set secure: true if using HTTPS production cookies with proxy trust
}));

// Initialize Database Tables & Default Admin
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name VARCHAR(255) DEFAULT 'ABC High School',
        org_name VARCHAR(255) DEFAULT 'Supreme Student Council',
        school_year VARCHAR(50) DEFAULT '2026–2027',
        org_description VARCHAR(500) DEFAULT 'Official student governing body.',
        theme_color VARCHAR(50) DEFAULT '#4f46e5',
        id_prefix VARCHAR(50) DEFAULT 'SSC'
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL, -- admin, member, scanner
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
        grade_level VARCHAR(50),
        section VARCHAR(50),
        position VARCHAR(100) DEFAULT 'Member',
        contact_info VARCHAR(100),
        email VARCHAR(100),
        profile_photo TEXT,
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'Active',
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
        status VARCHAR(50) DEFAULT 'Present', -- Present, Late, Missing Time Out
        scan_method VARCHAR(50) DEFAULT 'QR',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        expires_at DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        scanned_by VARCHAR(100),
        event_id INTEGER,
        scan_type VARCHAR(50),
        qr_value TEXT,
        result_status VARCHAR(50), -- Success, Invalid, Duplicate, Error
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        actor VARCHAR(100),
        role VARCHAR(50),
        action VARCHAR(255),
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure default settings exist
    const settingsCheck = await client.query('SELECT COUNT(*) FROM organization_settings');
    if (parseInt(settingsCheck.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_description, theme_color, id_prefix)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official student governing body.', '#4f46e5', 'SSC')
      `);
    }

    // Ensure default admin exists
    const adminCheck = await client.query("SELECT * FROM users WHERE username = 'admin'");
    if (adminCheck.rows.length === 0) {
      const hashed = await bcrypt.hash('admin123', 10);
      await client.query(`
        INSERT INTO users (username, password_hash, role, must_change_password)
        VALUES ('admin', $1, 'admin', FALSE)
      `, [hashed]);
      console.log('Default admin account created: admin / admin123');
    }

    console.log('PostgreSQL Database successfully initialized.');
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

initializeDatabase();

// Helper middleware for auth checks
function requireAuth(role = null) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'admin') {
      return res.status(403).send('Access Denied: Insufficient Permissions');
    }
    next();
  };
}

async function logAudit(actor, role, action, details) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (actor, role, action, details) VALUES ($1, $2, $3, $4)',
      [actor, role, action, details]
    );
  } catch (e) {
    console.error('Audit logging failed:', e);
  }
}

// ---------------------------------------------------------
// ROUTES: AUTHENTICATION
// ---------------------------------------------------------

app.get('/login', (req, res) => {
  res.send(renderLoginPage());
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.send(renderLoginPage('Invalid username or password.'));
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.send(renderLoginPage('Invalid username or password.'));
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: user.must_change_password
    };

    await logAudit(user.username, user.role, 'User Login', `Successful login for ${user.username}`);

    if (user.must_change_password) {
      return res.redirect('/change-password-forced');
    }

    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'member') res.redirect('/member');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.send(renderLoginPage('An error occurred during login.'));
  }
});

app.get('/logout', (req, res) => {
  if (req.session.user) {
    logAudit(req.session.user.username, req.session.user.role, 'User Logout', 'Logged out successfully');
  }
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Forced Password Change for temporary passwords
app.get('/change-password-forced', (req, res) => {
  if (!req.session.user || !req.session.user.mustChangePassword) {
    return res.redirect('/login');
  }
  res.send(renderForcedPasswordPage());
});

app.post('/change-password-forced', async (req, res) => {
  if (!req.session.user || !req.session.user.mustChangePassword) {
    return res.redirect('/login');
  }
  const { new_password, confirm_password } = req.body;
  if (!new_password || new_password.length < 8 || new_password !== confirm_password) {
    return res.send(renderForcedPasswordPage('Passwords must match and be at least 8 characters long.'));
  }

  try {
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [hashed, req.session.user.id]
    );
    req.session.user.mustChangePassword = false;
    await logAudit(req.session.user.username, req.session.user.role, 'Forced Password Changed', 'User changed temporary password successfully');
    res.redirect(req.session.user.role === 'admin' ? '/admin' : '/member');
  } catch (err) {
    console.error(err);
    res.send(renderForcedPasswordPage('Database error updating password.'));
  }
});

// ---------------------------------------------------------
// ROUTES: ADMIN PORTAL
// ---------------------------------------------------------

app.get('/admin', requireAuth('admin'), async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
    const stats = {
      totalMembers: (await pool.query('SELECT COUNT(*) FROM members')).rows[0].count,
      activeMembers: (await pool.query("SELECT COUNT(*) FROM members WHERE status='Active'")).rows[0].count,
      presentToday: (await pool.query("SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date=CURRENT_DATE")).rows[0].count,
      timeInToday: (await pool.query("SELECT COUNT(*) FROM attendance WHERE attendance_date=CURRENT_DATE AND time_in IS NOT NULL")).rows[0].count,
      timeOutToday: (await pool.query("SELECT COUNT(*) FROM attendance WHERE attendance_date=CURRENT_DATE AND time_out IS NOT NULL")).rows[0].count,
      lateToday: (await pool.query("SELECT COUNT(*) FROM attendance WHERE attendance_date=CURRENT_DATE AND status='Late'")).rows[0].count,
      invalidScans: (await pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result_status='Invalid'")).rows[0].count
    };
    res.send(renderAdminDashboard(settings, stats));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ---------------------------------------------------------
// ROUTES: MEMBER PORTAL
// ---------------------------------------------------------

app.get('/member', requireAuth('member'), async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE user_id = $1', [req.session.user.id]);
    if (memberRes.rows.length === 0) return res.send('Member profile not found.');
    const member = memberRes.rows[0];
    const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
    const attendance = (await pool.query(`
      SELECT a.*, e.event_name FROM attendance a 
      JOIN events e ON a.event_id = e.id 
      WHERE a.member_id = $1 ORDER BY a.attendance_date DESC LIMIT 20
    `, [member.id])).rows;
    const announcements = (await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5')).rows;

    res.send(renderMemberDashboard(member, settings, attendance, announcements));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// ---------------------------------------------------------
// ROUTES: SCANNER PORTAL
// ---------------------------------------------------------

app.get('/scanner', requireAuth('scanner'), async (req, res) => {
  try {
    const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
    const events = (await pool.query('SELECT * FROM events ORDER BY event_date DESC')).rows;
    res.send(renderScannerPortal(settings, events, req.session.user.username));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// API endpoint for processing QR scans from Scanner portal
app.post('/api/scan', requireAuth('scanner'), async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  const scannerName = req.session.user.username;

  if (!qr_token || !event_id || !scan_type) {
    return res.json({ success: false, status: 'Error', message: 'Missing scan parameters.' });
  }

  try {
    // Validate QR Token format (e.g. CLUBTRACK:MEMBER:token)
    let tokenValue = qr_token;
    if (qr_token.includes('MEMBER:')) {
      tokenValue = qr_token.split('MEMBER:')[1];
    }

    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [tokenValue]);
    if (memberRes.rows.length === 0) {
      await pool.query(
        'INSERT INTO scanner_logs (scanned_by, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [scannerName, event_id, scan_type, qr_token, 'Invalid', 'QR Code not registered']
      );
      return res.json({ success: false, status: 'Invalid', message: 'This QR Code does not belong to a registered member.' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'Active') {
      return res.json({ success: false, status: 'Error', message: 'Member account is currently inactive.' });
    }

    const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    if (eventRes.rows.length === 0) {
      return res.json({ success: false, status: 'Error', message: 'Selected event not found.' });
    }
    const event = eventRes.rows[0];
    const todayStr = new Date().toISOString().split('T')[0];
    const currentTimeStr = new Date().toTimeString().split(' ')[0];

    // Check existing attendance record for today & event
    let attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3', [member.id, event_id, todayStr]);

    if (scan_type === 'TIME IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          success: false,
          status: 'Duplicate',
          message: `${member.first_name} ${member.last_name} already has a Time In record for this event.`,
          time: attRes.rows[0].time_in,
          member
        });
      }

      // Check late status against event late cutoff
      const status = currentTimeStr > event.late_cutoff ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [currentTimeStr, status, attRes.rows[0].id]);
      } else {
        await pool.query(
          'INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, $6)',
          [member.id, event_id, todayStr, currentTimeStr, status, 'QR']
        );
      }

      await pool.query('INSERT INTO scanner_logs (scanned_by, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)', [scannerName, event_id, scan_type, qr_token, 'Success', 'Time In recorded']);
      return res.json({ success: true, status: 'Success', scan_type: 'TIME IN', member, time: currentTimeStr, date: todayStr });

    } else if (scan_type === 'TIME OUT') {
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ success: false, status: 'Error', message: 'Cannot record Time Out without an initial Time In record.' });
      }
      if (attRes.rows[0].time_out) {
        return res.json({
          success: false,
          status: 'Duplicate',
          message: `${member.first_name} ${member.last_name} already recorded Time Out for this event.`,
          time: attRes.rows[0].time_out,
          member
        });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [currentTimeStr, attRes.rows[0].id]);
      await pool.query('INSERT INTO scanner_logs (scanned_by, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)', [scannerName, event_id, scan_type, qr_token, 'Success', 'Time Out recorded']);
      return res.json({ success: true, status: 'Success', scan_type: 'TIME OUT', member, time: currentTimeStr, date: todayStr });
    }

  } catch (err) {
    console.error(err);
    res.json({ success: false, status: 'Error', message: 'Database processing error.' });
  }
});

// ---------------------------------------------------------
// ADMIN API: MEMBERS & EVENTS MANAGEMENT
// ---------------------------------------------------------

app.post('/api/admin/members', requireAuth('admin'), async (req, res) => {
  const { first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email } = req.body;
  try {
    const settings = (await pool.query('SELECT * FROM organization_settings LIMIT 1')).rows[0];
    const prefix = settings.id_prefix || 'SSC';
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seq = parseInt(countRes.rows[0].count) + 1;
    const memberId = `${prefix}-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
    
    // Generate unique username
    let baseUsername = `${first_name.toLowerCase().replace(/[^a-z]/g, '')}${last_name.toLowerCase().replace(/[^a-z]/g, '')}`;
    let username = baseUsername;
    let uCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    let counter = 1;
    while (uCheck.rows.length > 0) {
      username = `${baseUsername}${counter}`;
      uCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      counter++;
    }

    // Generate random temporary password
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const userRes = await pool.query(
      'INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1, $2, $3, TRUE) RETURNING id',
      [username, passwordHash, 'member']
    );
    const userId = userRes.rows[0].id;

    const qrToken = crypto.randomUUID();
    await pool.query(`
      INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, email, qr_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [userId, memberId, first_name, middle_name || '', last_name, gender, grade_level, section, position, contact_info, email, qrToken]);

    await logAudit(req.session.user.username, 'admin', 'Register Member', `Registered ${first_name} ${last_name} (${memberId})`);
    res.redirect('/admin?success=Member registered successfully');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error registering member: ' + err.message);
  }
});

// Events Management Route
app.post('/api/admin/events', requireAuth('admin'), async (req, res) => {
  const { event_name, description, event_date, start_time, end_time, late_cutoff } = req.body;
  try {
    await pool.query(
      'INSERT INTO events (event_name, description, event_date, start_time, end_time, late_cutoff) VALUES ($1, $2, $3, $4, $5, $6)',
      [event_name, description, event_date, start_time, end_time, late_cutoff]
    );
    await logAudit(req.session.user.username, 'admin', 'Create Event', `Created event: ${event_name}`);
    res.redirect('/admin?success=Event created successfully');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating event');
  }
});

// Settings Update Route
app.post('/api/admin/settings', requireAuth('admin'), async (req, res) => {
  const { school_name, org_name, school_year, org_description, theme_color, id_prefix } = req.body;
  try {
    await pool.query(
      'UPDATE organization_settings SET school_name = $1, org_name = $2, school_year = $3, org_description = $4, theme_color = $5, id_prefix = $6 WHERE id = 1',
      [school_name, org_name, school_year, org_description, theme_color, id_prefix]
    );
    await logAudit(req.session.user.username, 'admin', 'Update Settings', 'Updated organization settings');
    res.redirect('/admin?success=Settings updated successfully');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating settings');
  }
});

// ---------------------------------------------------------
// FRONTEND EMBEDDED TEMPLATES & CSS STYLING
// ---------------------------------------------------------

function renderGlobalCSS(themeColor = '#4f46e5') {
  return `
    <style>
      :root {
        --primary: ${themeColor};
        --primary-dark: #3730a3;
        --bg-color: #f8fafc;
        --card-bg: #ffffff;
        --text-main: #1e293b;
        --text-muted: #64748b;
        --border-color: #e2e8f0;
        --success: #10b981;
        --warning: #f59e0b;
        --danger: #ef4444;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
      body { background-color: var(--bg-color); color: var(--text-main); display: flex; height: 100vh; overflow: hidden; }
      
      /* Layout UI */
      .sidebar { width: 260px; background: #ffffff; border-right: 1px solid var(--border-color); display: flex; flex-direction: column; justify-content: space-between; }
      .sidebar-header { padding: 20px; font-weight: bold; font-size: 1.1rem; color: var(--primary); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 10px; }
      .sidebar-menu { list-style: none; padding: 15px; overflow-y: auto; flex: 1; }
      .sidebar-menu li a { display: flex; align-items: center; gap: 12px; padding: 12px 15px; color: var(--text-muted); text-decoration: none; border-radius: 8px; font-weight: 500; transition: 0.2s; }
      .sidebar-menu li a:hover, .sidebar-menu li a.active { background: var(--primary); color: #fff; }
      .main-content { flex: 1; display: flex; flex-direction: column; overflow-y: auto; }
      .top-nav { background: #ffffff; padding: 15px 30px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; }
      .container { padding: 30px; max-width: 1400px; width: 100%; margin: 0 auto; }
      
      /* Cards & Grid */
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
      .stat-card { background: var(--card-bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border-color); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
      .stat-card h4 { color: var(--text-muted); font-size: 0.85rem; text-transform: uppercase; margin-bottom: 8px; }
      .stat-card .value { font-size: 1.8rem; font-weight: bold; color: var(--text-main); }
      
      /* Forms & Tables */
      .card { background: var(--card-bg); border-radius: 12px; border: 1px solid var(--border-color); padding: 25px; margin-bottom: 25px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
      .form-group { margin-bottom: 15px; }
      .form-group label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 0.9rem; }
      .form-control { width: 100%; padding: 10px 14px; border: 1px solid var(--border-color); border-radius: 8px; font-size: 0.95rem; }
      .btn { background: var(--primary); color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
      .btn:hover { opacity: 0.9; }
      .btn-danger { background: var(--danger); }
      .btn-success { background: var(--success); }
      
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid var(--border-color); font-size: 0.9rem; }
      th { background: #f8fafc; font-weight: 600; color: var(--text-muted); }
      
      /* Login Screen */
      .login-wrapper { display: flex; width: 100vw; height: 100vh; align-items: center; justify-content: center; background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%); }
      .login-card { background: white; padding: 40px; border-radius: 16px; width: 100%; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
      
      /* Scanner Layout */
      .scanner-container { display: flex; flex-direction: column; height: 100vh; background: #0f172a; color: white; }
      .scanner-header { padding: 15px 25px; background: #1e293b; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
      .scanner-body { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; text-align: center; }
      
      @media(max-width: 768px) {
        body { flex-direction: column; overflow-y: auto; }
        .sidebar { width: 100%; height: auto; }
        .main-content { overflow-y: visible; height: auto; }
      }
    </style>
  `;
}

function renderLoginPage(errorMessage = '') {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Login - ClubTrack QR Attendance System</title>
      ${renderGlobalCSS()}
    </head>
    <body>
      <div class="login-wrapper">
        <div class="login-card">
          <h2 style="margin-bottom: 5px; color: #1e293b;">ClubTrack QR</h2>
          <p style="color: var(--text-muted); margin-bottom: 25px; font-size: 0.9rem;">Organization & Club Management System</p>
          ${errorMessage ? `<div style="background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 8px; margin-bottom: 15px; font-size: 0.85rem;">${errorMessage}</div>` : ''}
          <form action="/login" method="POST">
            <div class="form-group">
              <label>Username</label>
              <input type="text" name="username" class="form-control" required autofocus placeholder="Enter your username">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" name="password" class="form-control" required placeholder="Enter your password">
            </div>
            <button type="submit" class="btn" style="width: 100%; padding: 12px; margin-top: 10px;">Sign In</button>
          </form>
          <div style="margin-top: 20px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">
            Default Admin: <b>admin</b> / <b>admin123</b>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

function renderForcedPasswordPage(errorMessage = '') {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Security Update Required - ClubTrack</title>
      ${renderGlobalCSS()}
    </head>
    <body>
      <div class="login-wrapper">
        <div class="login-card" style="max-width: 480px;">
          <h3 style="color: var(--danger); margin-bottom: 10px;">Security Reminder</h3>
          <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 20px;">
            Your account is currently using a temporary password. You are required to create a new private password before proceeding.
          </p>
          ${errorMessage ? `<div style="background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 8px; margin-bottom: 15px; font-size: 0.85rem;">${errorMessage}</div>` : ''}
          <form action="/change-password-forced" method="POST">
            <div class="form-group">
              <label>New Private Password (min. 8 characters)</label>
              <input type="password" name="new_password" class="form-control" required minlength="8" placeholder="Create secure password">
            </div>
            <div class="form-group">
              <label>Confirm New Password</label>
              <input type="password" name="confirm_password" class="form-control" required minlength="8" placeholder="Confirm secure password">
            </div>
            <button type="submit" class="btn" style="width: 100%; padding: 12px; margin-top: 10px;">Update Password & Continue</button>
          </form>
        </div>
      </div>
    </body>
    </html>
  `;
}

function renderAdminDashboard(settings, stats) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Admin Portal - ${settings.org_name}</title>
      ${renderGlobalCSS(settings.theme_color)}
    </head>
    <body>
      <div class="sidebar">
        <div>
          <div class="sidebar-header">
            <span>🛡️</span> ${settings.org_name}
          </div>
          <ul class="sidebar-menu">
            <li><a href="/admin" class="active">📊 Dashboard</a></li>
            <li><a href="#members" onclick="switchTab('members')">👥 Members</a></li>
            <li><a href="#events" onclick="switchTab('events')">📅 Events</a></li>
            <li><a href="#settings" onclick="switchTab('settings')">⚙️ Settings</a></li>
            <li><a href="/scanner" target="_blank">📷 Open Scanner</a></li>
          </ul>
        </div>
        <div style="padding: 20px; border-top: 1px solid var(--border-color);">
          <a href="/logout" class="btn btn-danger" style="width: 100%;">Sign Out</a>
        </div>
      </div>
      <div class="main-content">
        <div class="top-nav">
          <h3>Admin Dashboard — ${settings.school_name} (${settings.school_year})</h3>
          <div>Welcome, <b>Administrator</b></div>
        </div>
        <div class="container">
          <div class="stats-grid">
            <div class="stat-card"><h4>Total Members</h4><div class="value">${stats.totalMembers}</div></div>
            <div class="stat-card"><h4>Active Members</h4><div class="value" style="color:var(--success);">${stats.activeMembers}</div></div>
            <div class="stat-card"><h4>Present Today</h4><div class="value" style="color:var(--primary);">${stats.presentToday}</div></div>
            <div class="stat-card"><h4>Time In Today</h4><div class="value">${stats.timeInToday}</div></div>
            <div class="stat-card"><h4>Time Out Today</h4><div class="value">${stats.timeOutToday}</div></div>
            <div class="stat-card"><h4>Late Today</h4><div class="value" style="color:var(--warning);">${stats.lateToday}</div></div>
            <div class="stat-card"><h4>Invalid Scans</h4><div class="value" style="color:var(--danger);">${stats.invalidScans}</div></div>
          </div>

          <div id="tab-members" class="card">
            <h3>Register New Member</h3>
            <form action="/api/admin/members" method="POST" style="margin-top: 15px;">
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
                <div class="form-group"><label>First Name</label><input type="text" name="first_name" class="form-control" required></div>
                <div class="form-group"><label>Middle Name</label><input type="text" name="middle_name" class="form-control"></div>
                <div class="form-group"><label>Last Name</label><input type="text" name="last_name" class="form-control" required></div>
                <div class="form-group"><label>Gender</label><select name="gender" class="form-control"><option>Male</option><option>Female</option><option>Other</option></select></div>
                <div class="form-group"><label>Grade Level</label><input type="text" name="grade_level" class="form-control" placeholder="e.g. Grade 10" required></div>
                <div class="form-group"><label>Section</label><input type="text" name="section" class="form-control" placeholder="e.g. Rizal" required></div>
                <div class="form-group"><label>Position</label><input type="text" name="position" class="form-control" value="Member"></div>
                <div class="form-group"><label>Contact Info</label><input type="text" name="contact_info" class="form-control"></div>
              </div>
              <button type="submit" class="btn" style="margin-top: 15px;">Register Member & Generate Credentials</button>
            </form>
          </div>

          <div id="tab-events" class="card" style="margin-top: 25px;">
            <h3>Create Attendance Event</h3>
            <form action="/api/admin/events" method="POST" style="margin-top: 15px;">
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px;">
                <div class="form-group"><label>Event Name</label><input type="text" name="event_name" class="form-control" required></div>
                <div class="form-group"><label>Event Date</label><input type="date" name="event_date" class="form-control" required></div>
                <div class="form-group"><label>Start Time</label><input type="time" name="start_time" class="form-control" required></div>
                <div class="form-group"><label>Expected End Time</label><input type="time" name="end_time" class="form-control" required></div>
                <div class="form-group"><label>Late Cutoff Time</label><input type="time" name="late_cutoff" class="form-control" required></div>
              </div>
              <div class="form-group" style="margin-top: 15px;"><label>Description</label><textarea name="description" class="form-control" rows="2"></textarea></div>
              <button type="submit" class="btn" style="margin-top: 10px;">Save Attendance Event</button>
            </form>
          </div>

          <div id="tab-settings" class="card" style="margin-top: 25px;">
            <h3>Organization Settings</h3>
            <form action="/api/admin/settings" method="POST" style="margin-top: 15px;">
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px;">
                <div class="form-group"><label>School Name</label><input type="text" name="school_name" class="form-control" value="${settings.school_name}" required></div>
                <div class="form-group"><label>Organization Name</label><input type="text" name="org_name" class="form-control" value="${settings.org_name}" required></div>
                <div class="form-group"><label>School Year</label><input type="text" name="school_year" class="form-control" value="${settings.school_year}" required></div>
                <div class="form-group"><label>ID Prefix (e.g. SSC)</label><input type="text" name="id_prefix" class="form-control" value="${settings.id_prefix}" required></div>
                <div class="form-group"><label>Theme Accent Color</label><input type="color" name="theme_color" class="form-control" value="${settings.theme_color}" style="height: 42px;"></div>
              </div>
              <div class="form-group" style="margin-top: 15px;"><label>Organization Description</label><textarea name="org_description" class="form-control" rows="2">${settings.org_description}</textarea></div>
              <button type="submit" class="btn" style="margin-top: 10px;">Update Settings</button>
            </form>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

function renderMemberDashboard(member, settings, attendance, announcements) {
  const qrDataJson = `CLUBTRACK:MEMBER:${member.qr_token}`;
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Member Portal - ${member.first_name} ${member.last_name}</title>
      <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
      ${renderGlobalCSS(settings.theme_color)}
    </head>
    <body>
      <div class="sidebar">
        <div>
          <div class="sidebar-header"><span>⭐</span> ${settings.org_name}</div>
          <ul class="sidebar-menu">
            <li><a href="/member" class="active">👤 My Profile & QR</a></li>
          </ul>
        </div>
        <div style="padding: 20px; border-top: 1px solid var(--border-color);">
          <a href="/logout" class="btn btn-danger" style="width: 100%;">Sign Out</a>
        </div>
      </div>
      <div class="main-content">
        <div class="top-nav">
          <h3>Member Portal — ${member.first_name} ${member.last_name}</h3>
          <div>ID: <b>${member.member_id}</b></div>
        </div>
        <div class="container">
          <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 25px;">
            <div class="card" style="text-align: center;">
              <h3 style="margin-bottom: 15px;">Digital QR ID</h3>
              <div id="qrcode-container" style="display: flex; justify-content: center; margin: 15px 0;"></div>
              <p style="font-weight: bold; margin-top: 10px;">${member.first_name} ${member.last_name}</p>
              <p style="color: var(--text-muted); font-size: 0.85rem;">${member.grade_level} - ${member.section} | ${member.position}</p>
            </div>
            <div class="card">
              <h3>Announcements</h3>
              ${announcements.length === 0 ? '<p style="color:var(--text-muted); margin-top:10px;">No announcements posted.</p>' : ''}
              ${announcements.map(a => `
                <div style="border-bottom: 1px solid var(--border-color); padding: 12px 0;">
                  <h4 style="color: var(--primary); font-size: 1rem;">${a.title}</h4>
                  <p style="font-size: 0.9rem; margin-top: 4px;">${a.message}</p>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
      <script>
        QRCode.toCanvas(document.createElement('canvas'), '${qrDataJson}', { width: 200 }, function (err, canvas) {
          if (!err) document.getElementById('qrcode-container').appendChild(canvas);
        });
      </script>
    </body>
    </html>
  `;
}

function renderScannerPortal(settings, events, scannerUsername) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>QR Scanner - ${settings.org_name}</title>
      <script src="https://unpkg.com/html5-qrcode"></script>
      ${renderGlobalCSS(settings.theme_color)}
      <style>
        .scan-btn-group { display: flex; gap: 15px; margin: 15px 0; }
        .scan-mode-btn { flex: 1; padding: 15px; font-size: 1.1rem; font-weight: bold; border-radius: 10px; border: 2px solid var(--border-color); background: #1e293b; color: white; cursor: pointer; }
        .scan-mode-btn.active { border-color: var(--primary); background: var(--primary); }
      </style>
    </head>
    <body class="scanner-container">
      <div class="scanner-header">
        <div><b>📷 QR Scanner</b> (${scannerUsername})</div>
        <a href="/logout" style="color: #ef4444; text-decoration: none; font-weight: 500;">Sign Out</a>
      </div>
      <div class="scanner-body">
        <div style="width: 100%; max-width: 500px;">
          <div class="form-group">
            <label style="color: #94a3b8; text-align: left;">SELECT ATTENDANCE EVENT</label>
            <select id="event_select" class="form-control" style="background: #1e293b; color: white; border-color: #334155;">
              ${events.map(e => `<option value="${e.id}">${e.event_name} (${e.event_date})</option>`).join('')}
            </select>
          </div>
          
          <label style="color: #94a3b8; text-align: left; display: block; margin-top: 15px;">SELECT SCAN TYPE</label>
          <div class="scan-btn-group">
            <button type="button" id="btn-time-in" class="scan-mode-btn active" onclick="setScanType('TIME IN')">TIME IN</button>
            <button type="button" id="btn-time-out" class="scan-mode-btn" onclick="setScanType('TIME OUT')">TIME OUT</button>
          </div>

          <div style="margin-top: 20px;">
            <button id="start-camera-btn" class="btn" style="width: 100%; padding: 15px; font-size: 1.1rem;" onclick="startScanner()">START CAMERA</button>
          </div>

          <div id="reader" style="width: 100%; margin-top: 20px; border-radius: 12px; overflow: hidden;"></div>
          
          <div id="scan-result" style="margin-top: 20px; padding: 20px; border-radius: 12px; display: none; font-size: 1.1rem; font-weight: bold;"></div>
        </div>
      </div>

      <script>
        let currentScanType = 'TIME IN';
        let html5QrCode = null;
        let isProcessing = false;

        function setScanType(type) {
          currentScanType = type;
          document.getElementById('btn-time-in').classList.toggle('active', type === 'TIME IN');
          document.getElementById('btn-time-out').classList.toggle('active', type === 'TIME OUT');
        }

        // Web Audio API Sound Feedback
        function playAudio(type) {
          try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            
            if (type === 'success') {
              osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
              gain.gain.setValueAtTime(0.1, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.15);
            } else {
              osc.frequency.setValueAtTime(220, ctx.currentTime); // A3
              gain.gain.setValueAtTime(0.2, ctx.currentTime);
              osc.start();
              osc.stop(ctx.currentTime + 0.4);
            }
          } catch(e) {}
        }

        function startScanner() {
          const eventId = document.getElementById('event_select').value;
          if (!eventId) {
            alert('Please select an event first.');
            return;
          }

          document.getElementById('start-camera-btn').style.display = 'none';
          html5QrCode = new Html5Qrcode("reader");
          
          html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            async (decodedText) => {
              if (isProcessing) return;
              isProcessing = true;

              try {
                const response = await fetch('/api/scan', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ qr_token: decodedText, event_id: eventId, scan_type: currentScanType })
                });
                const resData = await response.json();
                const resultDiv = document.getElementById('scan-result');
                resultDiv.style.display = 'block';

                if (resData.success) {
                  playAudio('success');
                  resultDiv.style.background = '#065f46';
                  resultDiv.style.color = '#34d399';
                  resultDiv.innerHTML = '✓ QR CODE ACCEPTED<br><br>' + resData.member.first_name + ' ' + resData.member.last_name + '<br><span style="font-size:0.85rem; font-weight:normal;">' + currentScanType + ' Recorded at ' + resData.time + '</span>';
                } else {
                  playAudio('error');
                  resultDiv.style.background = '#991b1b';
                  resultDiv.style.color = '#fca5a5';
                  resultDiv.innerHTML = '⚠ ' + resData.status.toUpperCase() + '<br><br>' + resData.message;
                }

                setTimeout(() => {
                  resultDiv.style.display = 'none';
                  isProcessing = false;
                }, 3500);

              } catch(err) {
                isProcessing = false;
              }
            },
            (error) => {}
          ).catch(err => {
            alert('Camera permission denied or unavailable.');
            document.getElementById('start-camera-btn').style.display = 'block';
          });
        }
      </script>
    </body>
    </html>
  `;
}

// Start Server listening on 0.0.0.0 for Render compatibility
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
});
