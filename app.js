/*************************************************************
 * SCHOOL CLUB QR CODE ATTENDANCE MANAGEMENT SYSTEM (app.js)
 * Stack: Node.js, Express, PostgreSQL 18, Embedded Views / HTML5
 *************************************************************/

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/school_club_db',
});

// Middleware Configuration
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'club_attendance_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours session expiry
  })
);

// Set View Engine to embedded HTML templates via EJS lightweight rendering
app.set('view engine', 'ejs');
app.engine('ejs', require('ejs').renderFile);

// ---------------------------------------------------------
// DATABASE INITIALIZATION & MIGRATIONS ON STARTUP
// ---------------------------------------------------------
async function initializeDatabase() {
  try {
    const client = await pool.connect();
    
    // Create tables if they do not exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        member_id VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        club VARCHAR(150) DEFAULT 'School Organization',
        year_level VARCHAR(50),
        course VARCHAR(100),
        section VARCHAR(50),
        contact VARCHAR(50),
        email VARCHAR(150),
        photo TEXT,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        temporary_password_status BOOLEAN DEFAULT TRUE,
        qr_token VARCHAR(255) UNIQUE NOT NULL,
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
        status VARCHAR(30) DEFAULT 'Present',
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'Published',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        organization_name VARCHAR(150) DEFAULT 'Supreme Student Council & Clubs',
        school_name VARCHAR(150) DEFAULT 'National High School / University',
        logo TEXT DEFAULT '',
        attendance_start VARCHAR(10) DEFAULT '08:00',
        grace_period INT DEFAULT 15,
        school_year VARCHAR(50) DEFAULT '2026-2027'
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        actor VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure Default Admin Account exists: username: admin, password: password123
    const adminCheck = await client.query('SELECT * FROM admins WHERE username = $1', ['admin']);
    if (adminCheck.rows.length === 0) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('password123', salt);
      await client.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
      console.log('=> Default admin account created: username "admin" / password "password123"');
    }

    // Ensure Default Settings row exists
    const settingsCheck = await client.query('SELECT * FROM settings WHERE id = 1');
    if (settingsCheck.rows.length === 0) {
      await client.query(`INSERT INTO settings (id, organization_name, school_name, attendance_start, grace_period, school_year) VALUES (1, 'Supreme Student Council & Clubs', 'National High School / University', '08:00', 15, '2026-2027')`);
    }

    client.release();
    console.log('=> PostgreSQL Database initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

initializeDatabase();

// ---------------------------------------------------------
// HELPER FUNCTIONS
// ---------------------------------------------------------
function generateRandomPassword() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8-char hex code
}

async function logAudit(action, actor) {
  try {
    await pool.query('INSERT INTO audit_logs (action, actor) VALUES ($1, $2)', [action, actor]);
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

// ---------------------------------------------------------
// ROUTES: HOME & PORTALS REDIRECTS
// ---------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>School Club QR Attendance System</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-slate-100 font-sans min-h-screen flex flex-col justify-between">
      <div class="max-w-4xl mx-auto px-6 py-16 text-center my-auto">
        <span class="bg-indigo-500/20 text-indigo-400 text-xs font-semibold px-3 py-1 rounded-full uppercase tracking-wider">PostgreSQL Powered</span>
        <h1 class="text-4xl md:text-5xl font-extrabold mt-4 tracking-tight text-white">School Club QR Attendance & Management System</h1>
        <p class="text-slate-400 mt-4 max-w-xl mx-auto">Seamless automated attendance tracking, instant digital ID generation, and multi-portal role separation for school organizations.</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
          <a href="/admin/login" class="bg-slate-800 hover:bg-indigo-600 border border-slate-700 hover:border-indigo-500 p-6 rounded-2xl transition shadow-xl group block">
            <div class="text-indigo-400 group-hover:text-white text-2xl font-bold mb-2">Admin Portal</div>
            <p class="text-slate-400 group-hover:text-slate-100 text-sm">Manage members, view reports, configure settings, and oversee operations.</p>
          </a>
          <a href="/scanner" class="bg-slate-800 hover:bg-emerald-600 border border-slate-700 hover:border-emerald-500 p-6 rounded-2xl transition shadow-xl group block">
            <div class="text-emerald-400 group-hover:text-white text-2xl font-bold mb-2">Scanner Portal</div>
            <p class="text-slate-400 group-hover:text-slate-100 text-sm">Smartphone entrance camera scanner for Time-In and Time-Out tracking.</p>
          </a>
          <a href="/member/login" class="bg-slate-800 hover:bg-sky-600 border border-slate-700 hover:border-sky-500 p-6 rounded-2xl transition shadow-xl group block">
            <div class="text-sky-400 group-hover:text-white text-2xl font-bold mb-2">Member Portal</div>
            <p class="text-slate-400 group-hover:text-slate-100 text-sm">Member dashboard to view digital ID card, attendance history, and announcements.</p>
          </a>
        </div>
      </div>
      <footer class="py-6 text-center text-slate-500 text-xs border-t border-slate-800">
        School Club Attendance System &bull; Secure PostgreSQL 18 Backend
      </footer>
    </body>
    </html>
  `);
});

// ---------------------------------------------------------
// 1. ADMIN PORTAL & AUTHENTICATION
// ---------------------------------------------------------
app.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.render('admin_login', { error: 'Invalid username or password' });
    }
    const admin = result.rows[0];
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      return res.render('admin_login', { error: 'Invalid username or password' });
    }
    req.session.adminId = admin.id;
    req.session.adminUser = admin.username;
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.render('admin_login', { error: 'Server database error' });
  }
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  res.redirect('/admin/login');
}

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// Admin Dashboard
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const membersRes = await pool.query('SELECT * FROM members');
    const members = membersRes.rows;
    
    const totalMembers = members.length;
    const activeMembers = members.filter(m => m.status === 'Active').length;
    const inactiveMembers = members.filter(m => m.status === 'Inactive').length;

    const attendanceRes = await pool.query('SELECT * FROM attendance WHERE date = $1', [today]);
    const todayAttendance = attendanceRes.rows;

    const presentToday = todayAttendance.filter(a => a.status === 'Present').length;
    const lateToday = todayAttendance.filter(a => a.status === 'Late').length;
    const totalAttendanceToday = presentToday + lateToday;
    const absentToday = Math.max(0, activeMembers - totalAttendanceToday);
    const attendancePercentage = activeMembers > 0 ? ((totalAttendanceToday / activeMembers) * 100).toFixed(1) : 0;

    const recentScans = await pool.query('SELECT a.*, m.full_name, m.position FROM attendance a JOIN members m ON a.member_id = m.member_id ORDER BY a.created_at DESC LIMIT 5');
    const recentRegs = await pool.query('SELECT * FROM members ORDER BY created_at DESC LIMIT 5');
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');

    res.render('admin_dashboard', {
      adminUser: req.session.adminUser,
      totalMembers,
      activeMembers,
      inactiveMembers,
      presentToday,
      absentToday,
      lateToday,
      totalAttendanceToday,
      attendancePercentage,
      recentScans: recentScans.rows,
      recentRegs: recentRegs.rows,
      settings: settingsRes.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error loading dashboard');
  }
});

// Members Management Page
app.get('/admin/members', requireAdmin, async (req, res) => {
  const { search, status } = req.query;
  try {
    let query = 'SELECT * FROM members WHERE 1=1';
    let params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (full_name ILIKE $${params.length} OR member_id ILIKE $${params.length} OR username ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('admin_members', { members: result.rows, search: search || '', status: status || '', settings: settingsRes.rows[0], adminUser: req.session.adminUser });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading members');
  }
});

// Add Member Action
app.post('/admin/members/add', requireAdmin, async (req, res) => {
  const { full_name, position, club, year_level, course, section, contact, email, photo } = req.body;
  try {
    // Auto-generate Unique Member ID and Username format e.g. CLUB-2026-00X
    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const nextNum = parseInt(countRes.rows[0].count) + 1;
    const year = new Date().getFullYear();
    const member_id = `MEM-${year}-${String(nextNum).padStart(3, '0')}`;
    const username = `CLUB-${year}-${String(nextNum).padStart(3, '0')}`;
    const tempPassword = generateRandomPassword();

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(tempPassword, salt);
    const qr_token = crypto.randomBytes(16).toString('hex');

    await pool.query(
      `INSERT INTO members (member_id, full_name, position, club, year_level, course, section, contact, email, photo, username, password_hash, temporary_password_status, qr_token, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, $13, 'Active')`,
      [member_id, full_name, position || 'Member', club || 'School Club', year_level, course, section, contact, email, photo || '', username, password_hash, qr_token]
    );

    await logAudit(`Created member ${full_name} (${member_id})`, req.session.adminUser);

    // Pass temporary credentials to success render modal or redirect
    res.redirect(`/admin/members?success=1&new_id=${member_id}&new_user=${username}&new_pass=${tempPassword}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error adding member: ' + err.message);
  }
});

// Edit Member
app.post('/admin/members/edit/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { full_name, position, club, year_level, course, section, contact, email, status } = req.body;
  try {
    await pool.query(
      `UPDATE members SET full_name = $1, position = $2, club = $3, year_level = $4, course = $5, section = $6, contact = $7, email = $8, status = $9 WHERE id = $10`,
      [full_name, position, club, year_level, course, section, contact, email, status, id]
    );
    await logAudit(`Updated member ID ${id}`, req.session.adminUser);
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating member');
  }
});

// Delete Member
app.get('/admin/members/delete/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM members WHERE id = $1', [id]);
    await logAudit(`Deleted member record ID ${id}`, req.session.adminUser);
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting member');
  }
});

// Reset Password
app.get('/admin/members/reset-pass/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const tempPassword = generateRandomPassword();
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(tempPassword, salt);

    const memberRes = await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = TRUE WHERE id = $2 RETURNING full_name, member_id, username', [password_hash, id]);
    const m = memberRes.rows[0];
    await logAudit(`Reset password for ${m.full_name}`, req.session.adminUser);

    res.redirect(`/admin/members?reset_user=${m.username}&reset_pass=${tempPassword}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error resetting password');
  }
});

// Regenerate QR Code
app.get('/admin/members/regen-qr/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const new_token = crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE members SET qr_token = $1 WHERE id = $2', [new_token, id]);
    await logAudit(`Regenerated QR code for member ID ${id}`, req.session.adminUser);
    res.redirect('/admin/members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error regenerating QR');
  }
});

// View ID Card Modal Route
app.get('/admin/members/id-card/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    if (memberRes.rows.length === 0) return res.status(404).send('Member not found');
    res.render('admin_id_card', { member: memberRes.rows[0], settings: settingsRes.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading ID card');
  }
});

// Attendance Records View
app.get('/admin/attendance', requireAdmin, async (req, res) => {
  const { date, status, search } = req.query;
  try {
    let query = 'SELECT a.*, m.full_name, m.position, m.club FROM attendance a JOIN members m ON a.member_id = m.member_id WHERE 1=1';
    let params = [];
    if (date) {
      params.push(date);
      query += ` AND a.date = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND a.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (m.full_name ILIKE $${params.length} OR m.member_id ILIKE $${params.length})`;
    }
    query += ' ORDER BY a.created_at DESC';
    const result = await pool.query(query, params);
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('admin_attendance', { attendance: result.rows, date: date || '', status: status || '', search: search || '', settings: settingsRes.rows[0], adminUser: req.session.adminUser });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading attendance');
  }
});

// Reports Page
app.get('/admin/reports', requireAdmin, async (req, res) => {
  try {
    const statsRes = await pool.query(`
      SELECT status, COUNT(*) as count FROM attendance GROUP BY status
    `);
    const totalScans = await pool.query('SELECT COUNT(*) FROM attendance');
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('admin_reports', { stats: statsRes.rows, totalScans: totalScans.rows[0].count, settings: settingsRes.rows[0], adminUser: req.session.adminUser });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading reports');
  }
});

// Announcements Management
app.get('/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('admin_announcements', { announcements: result.rows, settings: settingsRes.rows[0], adminUser: req.session.adminUser });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading announcements');
  }
});

app.post('/admin/announcements/add', requireAdmin, async (req, res) => {
  const { title, message } = req.body;
  try {
    await pool.query('INSERT INTO announcements (title, message) VALUES ($1, $2)', [title, message]);
    await logAudit(`Created announcement: ${title}`, req.session.adminUser);
    res.redirect('/admin/announcements');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error saving announcement');
  }
});

app.get('/admin/announcements/delete/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    res.redirect('/admin/announcements');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting announcement');
  }
});

// Admin Settings
app.get('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('admin_settings', { settings: settingsRes.rows[0], adminUser: req.session.adminUser, success: req.query.success });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading settings');
  }
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  const { organization_name, school_name, logo, attendance_start, grace_period, school_year, new_password } = req.body;
  try {
    await pool.query(
      `UPDATE settings SET organization_name = $1, school_name = $2, logo = $3, attendance_start = $4, grace_period = $5, school_year = $6 WHERE id = 1`,
      [organization_name, school_name, logo, attendance_start, grace_period, school_year]
    );

    if (new_password && new_password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(new_password, salt);
      await pool.query('UPDATE admins SET password_hash = $1 WHERE username = $2', [hash, req.session.adminUser]);
    }

    await logAudit('Updated system settings', req.session.adminUser);
    res.redirect('/admin/settings?success=1');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating settings');
  }
});

// Audit Logs
app.get('/admin/audit-logs', requireAdmin, async (req, res) => {
  try {
    const logs = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('admin_audit', { logs: logs.rows, settings: settingsRes.rows[0], adminUser: req.session.adminUser });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading audit logs');
  }
});

// Database Backup Route
app.get('/admin/backup', requireAdmin, async (req, res) => {
  try {
    const members = await pool.query('SELECT * FROM members');
    const attendance = await pool.query('SELECT * FROM attendance');
    const announcements = await pool.query('SELECT * FROM announcements');
    const settings = await pool.query('SELECT * FROM settings');

    const backupData = {
      export_date: new Date().toISOString(),
      members: members.rows,
      attendance: attendance.rows,
      announcements: announcements.rows,
      settings: settings.rows
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=school_club_backup.json');
    res.send(JSON.stringify(backupData, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating backup');
  }
});


// ---------------------------------------------------------
// 2. SEPARATE SCANNER PORTAL
// ---------------------------------------------------------
app.get('/scanner', async (req, res) => {
  try {
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('scanner', { settings: settingsRes.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading scanner portal');
  }
});

// Scanner API endpoint to process QR scan
app.post('/api/scan', async (req, res) => {
  const { qr_token, mode } = req.body; // mode: 'TIME_IN' or 'TIME_OUT'
  try {
    if (!qr_token) {
      return res.status(400).json({ success: false, message: 'INVALID QR CODE', reason: 'empty_token' });
    }

    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'INVALID QR CODE', reason: 'not_registered' });
    }

    const member = memberRes.rows[0];
    if (member.status !== 'Active') {
      return res.status(403).json({ success: false, message: 'MEMBER INACTIVE', reason: 'inactive' });
    }

    const today = new Date().toISOString().split('T')[0];
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
    
    // Check settings for attendance time & grace period calculation
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    const settings = settingsRes.rows[0];

    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 AND date = $2', [member.member_id, today]);
    
    if (mode === 'TIME_IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          success: false,
          message: 'ALREADY TIMED IN',
          subtext: `Previous Time-In at ${attRes.rows[0].time_in}`,
          member
        });
      }

      // Calculate if Late or Present
      const [startHour, startMin] = settings.attendance_start.split(':').map(Number);
      const now = new Date();
      const currentTotalMins = now.getHours() * 60 + now.getMinutes();
      const startTotalMins = startHour * 60 + startMin + (settings.grace_period || 15);

      const status = currentTotalMins > startTotalMins ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query('UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3', [timeNow, status, attRes.rows[0].id]);
      } else {
        await pool.query('INSERT INTO attendance (member_id, date, time_in, status) VALUES ($1, $2, $3, $4)', [member.member_id, today, timeNow, status]);
      }

      return res.json({
        success: true,
        action: 'TIME_IN',
        message: 'TIME IN SUCCESSFUL',
        time: timeNow,
        date: today,
        status,
        member
      });
    } 
    else if (mode === 'TIME_OUT') {
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({
          success: false,
          message: 'NO TIME-IN RECORD FOUND',
          subtext: 'Please Time-In first before timing out.',
          member
        });
      }
      if (attRes.rows[0].time_out) {
        return res.json({
          success: false,
          message: 'ALREADY TIMED OUT',
          subtext: `Timed out at ${attRes.rows[0].time_out}`,
          member
        });
      }

      await pool.query('UPDATE attendance SET time_out = $1 WHERE id = $2', [timeNow, attRes.rows[0].id]);
      return res.json({
        success: true,
        action: 'TIME_OUT',
        message: 'TIME OUT SUCCESSFUL',
        time: timeNow,
        date: today,
        member
      });
    }

    res.status(400).json({ success: false, message: 'Invalid scan mode' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error processing scan' });
  }
});


// ---------------------------------------------------------
// 3. MEMBER PORTAL & AUTHENTICATION
// ---------------------------------------------------------
app.get('/member/login', (req, res) => {
  res.render('member_login', { error: null });
});

app.post('/member/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM members WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.render('member_login', { error: 'Invalid username or password' });
    }
    const member = result.rows[0];
    const match = await bcrypt.compare(password, member.password_hash);
    if (!match) {
      return res.render('member_login', { error: 'Invalid username or password' });
    }

    req.session.memberId = member.member_id;
    req.session.memberDbId = member.id;

    if (member.temporary_password_status) {
      return res.redirect('/member/change-password');
    }

    res.redirect('/member/dashboard');
  } catch (err) {
    console.error(err);
    res.render('member_login', { error: 'Server database error' });
  }
});

function requireMember(req, res, next) {
  if (req.session && req.session.memberId) {
    return next();
  }
  res.redirect('/member/login');
}

app.get('/member/change-password', requireMember, (req, res) => {
  res.render('member_change_password', { error: null });
});

app.post('/member/change-password', requireMember, async (req, res) => {
  const { new_password } = req.body;
  try {
    if (!new_password || new_password.length < 6) {
      return res.render('member_change_password', { error: 'Password must be at least 6 characters long.' });
    }
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await pool.query('UPDATE members SET password_hash = $1, temporary_password_status = FALSE WHERE member_id = $2', [password_hash, req.session.memberId]);
    res.redirect('/member/dashboard');
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

// Member Dashboard
app.get('/member/dashboard', requireMember, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE member_id = $1', [req.session.memberId]);
    const member = memberRes.rows[0];

    const attRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 ORDER BY date DESC', [member.member_id]);
    const attendance = attRes.rows;

    const totalPresent = attendance.filter(a => a.status === 'Present').length;
    const totalLate = attendance.filter(a => a.status === 'Late').length;
    const totalAbsent = attendance.filter(a => a.status === 'Absent').length;
    const totalScans = totalPresent + totalLate;
    const attendancePercentage = attendance.length > 0 ? ((totalScans / attendance.length) * 100).toFixed(1) : 0;

    const announcementsRes = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5');
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');

    res.render('member_dashboard', {
      member,
      attendance,
      totalPresent,
      totalLate,
      totalAbsent,
      attendancePercentage,
      announcements: announcementsRes.rows,
      settings: settingsRes.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading member dashboard');
  }
});

// Member ID Card View
app.get('/member/id-card', requireMember, async (req, res) => {
  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE member_id = $1', [req.session.memberId]);
    const settingsRes = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.render('member_id_card', { member: memberRes.rows[0], settings: settingsRes.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading member ID card');
  }
});


// ---------------------------------------------------------
// EJS VIEW TEMPLATES EMBEDDED DYNAMICALLY
// ---------------------------------------------------------
const views = {
  // 1. ADMIN LOGIN
  'admin_login.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Admin Portal Login</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen">
  <div class="bg-slate-800 p-8 rounded-2xl border border-slate-700 w-full max-w-md shadow-2xl">
    <div class="text-center mb-6">
      <span class="bg-indigo-500/20 text-indigo-400 text-xs px-3 py-1 rounded-full uppercase font-semibold">Administrator Access</span>
      <h1 class="text-2xl font-bold mt-2 text-white">Admin Portal</h1>
      <p class="text-slate-400 text-xs mt-1">Sign in with default credentials or updated password</p>
    </div>
    <% if (error) { %>
      <div class="bg-rose-500/20 border border-rose-500 text-rose-300 text-xs p-3 rounded-lg mb-4 text-center"><%= error %></div>
    <% } %>
    <form action="/admin/login" method="POST" class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1">Username</label>
        <input type="text" name="username" required value="admin" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
      </div>
      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1">Password</label>
        <input type="password" name="password" required value="password123" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500">
      </div>
      <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 rounded-lg transition text-sm shadow-lg">Sign In to Dashboard</button>
    </form>
    <div class="mt-6 text-center text-xs text-slate-500">
      Default Credentials: <span class="text-indigo-400 font-mono">admin</span> / <span class="text-indigo-400 font-mono">password123</span>
      <div class="mt-2"><a href="/" class="text-slate-400 hover:underline">&larr; Back to Portal Home</a></div>
    </div>
  </div>
</body>
</html>`,

  // 2. ADMIN DASHBOARD
  'admin_dashboard.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Admin Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans flex min-h-screen">
  <!-- Sidebar -->
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div>
      <div class="p-6 border-b border-slate-800">
        <h2 class="text-lg font-bold text-indigo-400 truncate"><%= settings.organization_name %></h2>
        <p class="text-xs text-slate-500 mt-1">Admin Control Center</p>
      </div>
      <nav class="p-4 space-y-1 text-sm">
        <a href="/admin/dashboard" class="flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium">Dashboard</a>
        <a href="/admin/members" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Members Management</a>
        <a href="/admin/attendance" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Attendance Records</a>
        <a href="/admin/reports" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Analytics & Reports</a>
        <a href="/admin/announcements" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Announcements</a>
        <a href="/admin/audit-logs" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Audit Logs</a>
        <a href="/admin/settings" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">System Settings</a>
      </nav>
    </div>
    <div class="p-4 border-t border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-400">Logged as <strong class="text-white"><%= adminUser %></strong></span>
        <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
      </div>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="flex-1 flex flex-col min-w-0 overflow-y-auto">
    <header class="bg-slate-950 border-b border-slate-800 px-6 py-4 flex justify-between items-center md:hidden">
      <span class="font-bold text-indigo-400"><%= settings.organization_name %></span>
      <a href="/admin/logout" class="text-xs text-rose-400">Logout</a>
    </header>

    <div class="p-8 max-w-7xl w-full mx-auto space-y-8">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-extrabold text-white">Dashboard Overview</h1>
          <p class="text-slate-400 text-xs mt-1">Real-time attendance statistics and system overview for <%= settings.school_year %></p>
        </div>
        <div class="flex gap-3">
          <a href="/scanner" target="_blank" class="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-4 py-2.5 rounded-lg font-medium transition shadow">Open Scanner Portal &rarr;</a>
          <a href="/admin/backup" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs px-4 py-2.5 rounded-lg font-medium transition">Download DB Backup</a>
        </div>
      </div>

      <!-- Statistics Grid -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="bg-slate-800 p-5 rounded-2xl border border-slate-700 shadow">
          <span class="text-xs font-semibold text-slate-400 uppercase">Total Members</span>
          <div class="text-3xl font-black mt-2 text-white"><%= totalMembers %></div>
          <div class="text-xs text-indigo-400 mt-1"><%= activeMembers %> Active, <%= inactiveMembers %> Inactive</div>
        </div>
        <div class="bg-slate-800 p-5 rounded-2xl border border-slate-700 shadow">
          <span class="text-xs font-semibold text-slate-400 uppercase">Present Today</span>
          <div class="text-3xl font-black mt-2 text-emerald-400"><%= presentToday %></div>
          <div class="text-xs text-slate-400 mt-1"><%= lateToday %> Late arrivals</div>
        </div>
        <div class="bg-slate-800 p-5 rounded-2xl border border-slate-700 shadow">
          <span class="text-xs font-semibold text-slate-400 uppercase">Absent Today</span>
          <div class="text-3xl font-black mt-2 text-rose-400"><%= absentToday %></div>
          <div class="text-xs text-slate-400 mt-1">Unrecorded active members</div>
        </div>
        <div class="bg-slate-800 p-5 rounded-2xl border border-slate-700 shadow">
          <span class="text-xs font-semibold text-slate-400 uppercase">Attendance Rate</span>
          <div class="text-3xl font-black mt-2 text-sky-400"><%= attendancePercentage %>%</div>
          <div class="text-xs text-slate-400 mt-1"><%= totalAttendanceToday %> Total Scans Today</div>
        </div>
      </div>

      <!-- Recent Activity Tables -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <!-- Recent Scans -->
        <div class="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-bold text-white text-sm">Recent Attendance Scans</h3>
            <a href="/admin/attendance" class="text-xs text-indigo-400 hover:underline">View All</a>
          </div>
          <div class="space-y-3">
            <% if (recentScans.length === 0) { %>
              <p class="text-xs text-slate-500 py-4 text-center">No attendance scans recorded today.</p>
            <% } else { %>
              <% recentScans.forEach(scan => { %>
                <div class="flex justify-between items-center bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 text-xs">
                  <div>
                    <span class="font-bold text-white"><%= scan.full_name %></span>
                    <span class="text-slate-400 block"><%= scan.position %> &bull; In: <%= scan.time_in || 'N/A' %></span>
                  </div>
                  <span class="px-2.5 py-1 rounded-full font-semibold <%= scan.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400' %>"><%= scan.status %></span>
                </div>
              <% }) %>
            <% } %>
          </div>
        </div>

        <!-- Recent Registrations -->
        <div class="bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-bold text-white text-sm">Recently Registered Members</h3>
            <a href="/admin/members" class="text-xs text-indigo-400 hover:underline">View All</a>
          </div>
          <div class="space-y-3">
            <% if (recentRegs.length === 0) { %>
              <p class="text-xs text-slate-500 py-4 text-center">No members registered yet.</p>
            <% } else { %>
              <% recentRegs.forEach(m => { %>
                <div class="flex justify-between items-center bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 text-xs">
                  <div>
                    <span class="font-bold text-white"><%= m.full_name %></span>
                    <span class="text-slate-400 block"><%= m.member_id %> &bull; Username: <code class="text-indigo-300"><%= m.username %></code></span>
                  </div>
                  <span class="px-2.5 py-1 rounded-full font-semibold bg-indigo-500/20 text-indigo-400"><%= m.status %></span>
                </div>
              <% }) %>
            <% } %>
          </div>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`,

  // 3. ADMIN MEMBERS MANAGEMENT
  'admin_members.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Members Management</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans flex min-h-screen">
  <!-- Sidebar -->
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div>
      <div class="p-6 border-b border-slate-800">
        <h2 class="text-lg font-bold text-indigo-400 truncate"><%= settings.organization_name %></h2>
        <p class="text-xs text-slate-500 mt-1">Admin Control Center</p>
      </div>
      <nav class="p-4 space-y-1 text-sm">
        <a href="/admin/dashboard" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Dashboard</a>
        <a href="/admin/members" class="flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium">Members Management</a>
        <a href="/admin/attendance" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Attendance Records</a>
        <a href="/admin/reports" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Analytics & Reports</a>
        <a href="/admin/announcements" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Announcements</a>
        <a href="/admin/audit-logs" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Audit Logs</a>
        <a href="/admin/settings" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">System Settings</a>
      </nav>
    </div>
    <div class="p-4 border-t border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-400">Logged as <strong class="text-white"><%= adminUser %></strong></span>
        <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
      </div>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="flex-1 flex flex-col min-w-0 overflow-y-auto">
    <div class="p-8 max-w-7xl w-full mx-auto space-y-6">
      
      <!-- Notifications / URL Alerts -->
      <% const urlParams = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : ''); %>
      <!-- We handle parameter rendering via server-injected variables or simple query check -->
      
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 class="text-3xl font-extrabold text-white">Members Directory</h1>
          <p class="text-slate-400 text-xs mt-1">Register new club members, inspect credentials, or view digital ID badges.</p>
        </div>
        <button onclick="openAddModal()" class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-4 py-2.5 rounded-lg font-semibold transition shadow">+ Add New Member</button>
      </div>

      <!-- Search & Filters -->
      <form action="/admin/members" method="GET" class="bg-slate-800 p-4 rounded-2xl border border-slate-700 flex flex-wrap gap-4 items-center">
        <input type="text" name="search" value="<%= search %>" placeholder="Search by name, ID, username..." class="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-xs text-white flex-1 focus:outline-none focus:border-indigo-500">
        <select name="status" class="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500">
          <option value="">All Status</option>
          <option value="Active" <%= status === 'Active' ? 'selected' : '' %>>Active</option>
          <option value="Inactive" <%= status === 'Inactive' ? 'selected' : '' %>>Inactive</option>
        </select>
        <button type="submit" class="bg-slate-700 hover:bg-slate-600 text-white text-xs px-4 py-2 rounded-lg font-medium transition">Filter</button>
        <a href="/admin/members" class="text-xs text-slate-400 hover:underline">Reset</a>
      </form>

      <!-- Members Table -->
      <div class="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden shadow">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs text-slate-300">
            <thead class="bg-slate-950 text-slate-400 uppercase font-semibold text-[10px] tracking-wider">
              <tr>
                <th class="p-4">Member</th>
                <th class="p-4">ID / Username</th>
                <th class="p-4">Position / Course</th>
                <th class="p-4">Contact</th>
                <th class="p-4">Status</th>
                <th class="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/50">
              <% if (members.length === 0) { %>
                <tr><td colspan="6" class="p-8 text-center text-slate-500">No members found matching criteria.</td></tr>
              <% } else { %>
                <% members.forEach(m => { %>
                  <tr class="hover:bg-slate-750 transition">
                    <td class="p-4 flex items-center gap-3">
                      <div class="w-9 h-9 rounded-full bg-slate-900 overflow-hidden border border-slate-700 flex items-center justify-center font-bold text-indigo-400">
                        <% if (m.photo) { %>
                          <img src="<%= m.photo %>" class="w-full h-full object-cover">
                        <% } else { %>
                          <%= m.full_name.charAt(0) %>
                        <% } %>
                      </div>
                      <div>
                        <div class="font-bold text-white"><%= m.full_name %></div>
                        <div class="text-[10px] text-slate-400"><%= m.email || 'No email' %></div>
                      </div>
                    </td>
                    <td class="p-4 font-mono">
                      <div class="text-indigo-400"><%= m.member_id %></div>
                      <div class="text-[10px] text-slate-400">User: <%= m.username %></div>
                    </td>
                    <td class="p-4">
                      <div class="text-white"><%= m.position %></div>
                      <div class="text-[10px] text-slate-400"><%= m.course || 'N/A' %> &bull; Year <%= m.year_level || '1' %></div>
                    </td>
                    <td class="p-4 text-slate-300"><%= m.contact || 'N/A' %></td>
                    <td class="p-4">
                      <span class="px-2.5 py-1 rounded-full font-semibold text-[10px] <%= m.status === 'Active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400' %>"><%= m.status %></span>
                    </td>
                    <td class="p-4 text-right space-x-2">
                      <a href="/admin/members/id-card/<%= m.id %>" target="_blank" class="text-indigo-400 hover:underline font-medium">ID Card</a>
                      <a href="/admin/members/reset-pass/<%= m.id %>" onclick="return confirm('Generate a new temporary password for this member?')" class="text-amber-400 hover:underline font-medium">Reset Pass</a>
                      <a href="/admin/members/regen-qr/<%= m.id %>" onclick="return confirm('Regenerate QR Code? Old QR code will be invalidated.')" class="text-sky-400 hover:underline font-medium">New QR</a>
                      <a href="/admin/members/delete/<%= m.id %>" onclick="return confirm('Delete this member permanently?')" class="text-rose-400 hover:underline font-medium">Delete</a>
                    </td>
                  </tr>
                <% }) %>
              <% } %>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </main>

  <!-- Add Member Modal -->
  <div id="addModal" class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm hidden items-center justify-center p-4 z-50">
    <div class="bg-slate-900 border border-slate-700 w-full max-w-xl rounded-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-lg font-bold text-white">Register New Club Member</h3>
        <button onclick="closeAddModal()" class="text-slate-400 hover:text-white">&times;</button>
      </div>
      <p class="text-slate-400 text-xs mb-4">System will automatically generate unique member ID, login credentials, and QR code token.</p>
      
      <form action="/admin/members/add" method="POST" class="space-y-4 text-xs">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-slate-300 font-medium mb-1">Full Name *</label>
            <input type="text" name="full_name" required class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">Position in Club</label>
            <input type="text" name="position" value="Member" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label class="block text-slate-300 font-medium mb-1">Club / Org</label>
            <input type="text" name="club" value="<%= settings.organization_name %>" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">Year Level</label>
            <input type="text" name="year_level" placeholder="e.g. 3rd Year" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">Course / Section</label>
            <input type="text" name="course" placeholder="BSIT 3-A" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-slate-300 font-medium mb-1">Contact Number</label>
            <input type="text" name="contact" placeholder="09123456789" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">Email Address</label>
            <input type="email" name="email" placeholder="student@school.edu" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
          </div>
        </div>
        <div>
          <label class="block text-slate-300 font-medium mb-1">Profile Photo URL (Optional)</label>
          <input type="url" name="photo" placeholder="https://example.com/photo.jpg" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none focus:border-indigo-500">
        </div>
        <div class="flex justify-end gap-3 pt-4 border-t border-slate-800">
          <button type="button" onclick="closeAddModal()" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg font-medium">Cancel</button>
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg font-semibold shadow">Create Member & Generate ID</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function openAddModal() { document.getElementById('addModal').classList.remove('hidden'); document.getElementById('addModal').classList.add('flex'); }
    function closeAddModal() { document.getElementById('addModal').classList.remove('flex'); document.getElementById('addModal').classList.add('hidden'); }
  </script>
</body>
</html>`,

  // 4. ADMIN ID CARD GENERATOR (CR80 PVC aspect ratio + Print rules)
  'admin_id_card.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>ID Card - <%= member.full_name %></title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    @media print {
      body { background: white !important; color: black !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .id-card-box { border: 1px solid #cbd5e1 !important; box-shadow: none !important; }
    }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 flex flex-col items-center justify-center min-h-screen p-6">
  
  <div class="no-print mb-6 flex gap-3">
    <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-xl font-semibold text-xs shadow-lg transition">Print ID Card</button>
    <button onclick="window.close()" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-5 py-2.5 rounded-xl font-semibold text-xs transition">Close Window</button>
  </div>

  <!-- Standard CR80 PVC ID Dimensions container (85.6mm x 53.98mm aspect ratio representation) -->
  <div class="id-card-box bg-slate-950 border border-slate-800 w-[420px] rounded-2xl overflow-hidden shadow-2xl flex flex-col relative text-slate-100">
    
    <!-- Header -->
    <div class="bg-indigo-950 border-b border-indigo-900/50 p-4 text-center">
      <div class="text-[10px] tracking-widest text-indigo-300 font-semibold uppercase"><%= settings.school_name %></div>
      <div class="text-base font-extrabold text-white"><%= settings.organization_name %></div>
    </div>

    <!-- Body -->
    <div class="p-6 flex gap-5 items-center">
      <!-- Member Photo -->
      <div class="w-28 h-32 rounded-xl bg-slate-900 border-2 border-indigo-500/50 overflow-hidden flex items-center justify-center font-bold text-2xl text-indigo-400 shrink-0 shadow">
        <% if (member.photo) { %>
          <img src="<%= member.photo %>" class="w-full h-full object-cover">
        <% } else { %>
          <%= member.full_name.charAt(0) %>
        <% } %>
      </div>

      <!-- Info -->
      <div class="space-y-1.5 flex-1 min-w-0">
        <div>
          <h2 class="text-lg font-black text-white truncate"><%= member.full_name %></h2>
          <p class="text-xs font-semibold text-indigo-400"><%= member.position %></p>
        </div>
        <div class="text-[11px] text-slate-300 space-y-0.5 pt-1">
          <div><strong class="text-slate-400">ID No:</strong> <span class="font-mono text-white"><%= member.member_id %></span></div>
          <div><strong class="text-slate-400">Course:</strong> <%= member.course || 'N/A' %></div>
          <div><strong class="text-slate-400">Year:</strong> <%= member.year_level || 'N/A' %></div>
          <div><strong class="text-slate-400">S.Y.:</strong> <%= settings.school_year %></div>
        </div>
      </div>
    </div>

    <!-- QR Code & Credentials section -->
    <div class="bg-slate-900/80 border-t border-slate-800 p-4 flex justify-between items-center">
      <div class="space-y-1">
        <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Portal Credentials</div>
        <div class="text-[11px]">User: <code class="text-indigo-300 font-bold"><%= member.username %></code></div>
        <div class="text-[11px]">Temp Pass: <code class="text-amber-400 font-bold"><%= member.temporary_password_status ? 'Active Temp' : 'Custom' %></code></div>
        <div class="text-[9px] text-slate-500 max-w-[180px]">Change password upon first login at /member</div>
      </div>
      <div class="bg-white p-2 rounded-xl shadow shrink-0">
        <div id="qrcode" class="w-20 h-20 flex items-center justify-center"></div>
      </div>
    </div>
  </div>

  <script>
    // Generate QR code safely client-side
    new QRCode(document.getElementById("qrcode"), {
      text: "<%= member.qr_token %>",
      width: 80,
      height: 80,
      colorDark: "#020617",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  </script>
</body>
</html>`,

  // 5. ADMIN ATTENDANCE RECORDS
  'admin_attendance.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Attendance Records</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans flex min-h-screen">
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div>
      <div class="p-6 border-b border-slate-800">
        <h2 class="text-lg font-bold text-indigo-400 truncate"><%= settings.organization_name %></h2>
        <p class="text-xs text-slate-500 mt-1">Admin Control Center</p>
      </div>
      <nav class="p-4 space-y-1 text-sm">
        <a href="/admin/dashboard" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Dashboard</a>
        <a href="/admin/members" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Members Management</a>
        <a href="/admin/attendance" class="flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium">Attendance Records</a>
        <a href="/admin/reports" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Analytics & Reports</a>
        <a href="/admin/announcements" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Announcements</a>
        <a href="/admin/audit-logs" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Audit Logs</a>
        <a href="/admin/settings" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">System Settings</a>
      </nav>
    </div>
    <div class="p-4 border-t border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-400">Logged as <strong class="text-white"><%= adminUser %></strong></span>
        <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
      </div>
    </div>
  </aside>

  <main class="flex-1 flex flex-col min-w-0 overflow-y-auto">
    <div class="p-8 max-w-7xl w-full mx-auto space-y-6">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-extrabold text-white">Attendance Logs</h1>
          <p class="text-slate-400 text-xs mt-1">Complete scanned records of time-in and time-out activity.</p>
        </div>
        <button onclick="window.print()" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs px-4 py-2.5 rounded-lg font-medium transition">Print Report</button>
      </div>

      <!-- Filters -->
      <form action="/admin/attendance" method="GET" class="bg-slate-800 p-4 rounded-2xl border border-slate-700 flex flex-wrap gap-4 items-center">
        <input type="date" name="date" value="<%= date %>" class="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none">
        <input type="text" name="search" value="<%= search %>" placeholder="Search name or ID..." class="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-xs text-white flex-1 focus:outline-none">
        <select name="status" class="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none">
          <option value="">All Status</option>
          <option value="Present" <%= status === 'Present' ? 'selected' : '' %>>Present</option>
          <option value="Late" <%= status === 'Late' ? 'selected' : '' %>>Late</option>
        </select>
        <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-4 py-2 rounded-lg font-medium">Filter</button>
        <a href="/admin/attendance" class="text-xs text-slate-400 hover:underline">Reset</a>
      </form>

      <!-- Table -->
      <div class="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden shadow">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs text-slate-300">
            <thead class="bg-slate-950 text-slate-400 uppercase font-semibold text-[10px] tracking-wider">
              <tr>
                <th class="p-4">Date</th>
                <th class="p-4">Member ID & Name</th>
                <th class="p-4">Position</th>
                <th class="p-4">Time In</th>
                <th class="p-4">Time Out</th>
                <th class="p-4">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/50">
              <% if (attendance.length === 0) { %>
                <tr><td colspan="6" class="p-8 text-center text-slate-500">No attendance logs found.</td></tr>
              <% } else { %>
                <% attendance.forEach(att => { %>
                  <tr class="hover:bg-slate-750 transition">
                    <td class="p-4 font-mono text-slate-400"><%= att.date %></td>
                    <td class="p-4">
                      <div class="font-bold text-white"><%= att.full_name %></div>
                      <div class="text-[10px] text-indigo-400 font-mono"><%= att.member_id %></div>
                    </td>
                    <td class="p-4"><%= att.position %></td>
                    <td class="p-4 font-mono text-emerald-400"><%= att.time_in || '—' %></td>
                    <td class="p-4 font-mono text-amber-400"><%= att.time_out || '—' %></td>
                    <td class="p-4">
                      <span class="px-2.5 py-1 rounded-full font-semibold text-[10px] <%= att.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400' %>"><%= att.status %></span>
                    </td>
                  </tr>
                <% }) %>
              <% } %>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`,

  // 6. ADMIN REPORTS & ANALYTICS
  'admin_reports.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Analytics & Reports</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans flex min-h-screen">
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div>
      <div class="p-6 border-b border-slate-800">
        <h2 class="text-lg font-bold text-indigo-400 truncate"><%= settings.organization_name %></h2>
        <p class="text-xs text-slate-500 mt-1">Admin Control Center</p>
      </div>
      <nav class="p-4 space-y-1 text-sm">
        <a href="/admin/dashboard" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Dashboard</a>
        <a href="/admin/members" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Members Management</a>
        <a href="/admin/attendance" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Attendance Records</a>
        <a href="/admin/reports" class="flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium">Analytics & Reports</a>
        <a href="/admin/announcements" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Announcements</a>
        <a href="/admin/audit-logs" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Audit Logs</a>
        <a href="/admin/settings" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">System Settings</a>
      </nav>
    </div>
    <div class="p-4 border-t border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-400">Logged as <strong class="text-white"><%= adminUser %></strong></span>
        <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
      </div>
    </div>
  </aside>

  <main class="flex-1 flex flex-col min-w-0 overflow-y-auto">
    <div class="p-8 max-w-7xl w-full mx-auto space-y-6">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-extrabold text-white">Attendance Analytics</h1>
          <p class="text-slate-400 text-xs mt-1">Aggregated statistics and export options.</p>
        </div>
        <button onclick="window.print()" class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-4 py-2.5 rounded-lg font-semibold shadow">Print Printable Report</button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow">
          <span class="text-xs font-semibold text-slate-400 uppercase">Total System Scans</span>
          <div class="text-4xl font-black mt-3 text-white"><%= totalScans %></div>
          <p class="text-xs text-slate-400 mt-1">Cumulative time-ins logged</p>
        </div>
        <% stats.forEach(s => { %>
          <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow">
            <span class="text-xs font-semibold text-slate-400 uppercase"><%= s.status %> Count</span>
            <div class="text-4xl font-black mt-3 <%= s.status === 'Present' ? 'text-emerald-400' : 'text-amber-400' %>"><%= s.count %></div>
            <p class="text-xs text-slate-400 mt-1">Total categorized as <%= s.status %></p>
          </div>
        <% }) %>
      </div>
    </div>
  </main>
</body>
</html>`,

  // 7. ADMIN ANNOUNCEMENTS
  'admin_announcements.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Announcements</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans flex min-h-screen">
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div>
      <div class="p-6 border-b border-slate-800">
        <h2 class="text-lg font-bold text-indigo-400 truncate"><%= settings.organization_name %></h2>
        <p class="text-xs text-slate-500 mt-1">Admin Control Center</p>
      </div>
      <nav class="p-4 space-y-1 text-sm">
        <a href="/admin/dashboard" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Dashboard</a>
        <a href="/admin/members" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Members Management</a>
        <a href="/admin/attendance" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Attendance Records</a>
        <a href="/admin/reports" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Analytics & Reports</a>
        <a href="/admin/announcements" class="flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium">Announcements</a>
        <a href="/admin/audit-logs" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Audit Logs</a>
        <a href="/admin/settings" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">System Settings</a>
      </nav>
    </div>
    <div class="p-4 border-t border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-400">Logged as <strong class="text-white"><%= adminUser %></strong></span>
        <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
      </div>
    </div>
  </aside>

  <main class="flex-1 flex flex-col min-w-0 overflow-y-auto">
    <div class="p-8 max-w-5xl w-full mx-auto space-y-8">
      <div>
        <h1 class="text-3xl font-extrabold text-white">Club Announcements</h1>
        <p class="text-slate-400 text-xs mt-1">Broadcast announcements directly to member dashboards.</p>
      </div>

      <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow">
        <h3 class="font-bold text-white text-sm mb-4">Create New Announcement</h3>
        <form action="/admin/announcements/add" method="POST" class="space-y-4 text-xs">
          <div>
            <label class="block text-slate-300 font-medium mb-1">Title</label>
            <input type="text" name="title" required class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">Message Content</label>
            <textarea name="message" rows="3" required class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none"></textarea>
          </div>
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-5 py-2.5 rounded-lg transition shadow">Publish Announcement</button>
        </form>
      </div>

      <div class="space-y-4">
        <h3 class="font-bold text-white text-sm">Published Announcements</h3>
        <% if (announcements.length === 0) { %>
          <p class="text-xs text-slate-500">No announcements posted yet.</p>
        <% } else { %>
          <% announcements.forEach(a => { %>
            <div class="bg-slate-800 p-5 rounded-2xl border border-slate-700 flex justify-between items-start">
              <div>
                <h4 class="font-bold text-white text-sm"><%= a.title %></h4>
                <p class="text-slate-300 text-xs mt-1"><%= a.message %></p>
                <span class="text-[10px] text-slate-500 mt-2 block"><%= new Date(a.created_at).toLocaleString() %></span>
              </div>
              <a href="/admin/announcements/delete/<%= a.id %>" onclick="return confirm('Delete this announcement?')" class="text-rose-400 hover:underline text-xs font-semibold">Delete</a>
            </div>
          <% }) %>
        <% } %>
      </div>
    </div>
  </main>
</body>
</html>`,

  // 8. ADMIN SETTINGS
  'admin_settings.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>System Settings</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans flex min-h-screen">
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div>
      <div class="p-6 border-b border-slate-800">
        <h2 class="text-lg font-bold text-indigo-400 truncate"><%= settings.organization_name %></h2>
        <p class="text-xs text-slate-500 mt-1">Admin Control Center</p>
      </div>
      <nav class="p-4 space-y-1 text-sm">
        <a href="/admin/dashboard" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Dashboard</a>
        <a href="/admin/members" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Members Management</a>
        <a href="/admin/attendance" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Attendance Records</a>
        <a href="/admin/reports" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Analytics & Reports</a>
        <a href="/admin/announcements" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Announcements</a>
        <a href="/admin/audit-logs" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Audit Logs</a>
        <a href="/admin/settings" class="flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium">System Settings</a>
      </nav>
    </div>
    <div class="p-4 border-t border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-400">Logged as <strong class="text-white"><%= adminUser %></strong></span>
        <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
      </div>
    </div>
  </aside>

  <main class="flex-1 flex flex-col min-w-0 overflow-y-auto">
    <div class="p-8 max-w-4xl w-full mx-auto space-y-6">
      <div>
        <h1 class="text-3xl font-extrabold text-white">System Settings</h1>
        <p class="text-slate-400 text-xs mt-1">Configure organization parameters and administrative password.</p>
      </div>

      <% if (success) { %>
        <div class="bg-emerald-500/20 border border-emerald-500 text-emerald-300 text-xs p-3 rounded-xl">Settings updated successfully!</div>
      <% } %>

      <form action="/admin/settings" method="POST" class="bg-slate-800 p-6 rounded-2xl border border-slate-700 space-y-4 text-xs shadow">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-slate-300 font-medium mb-1">Organization Name</label>
            <input type="text" name="organization_name" value="<%= settings.organization_name %>" required class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">School Name</label>
            <input type="text" name="school_name" value="<%= settings.school_name %>" required class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label class="block text-slate-300 font-medium mb-1">Attendance Start Time</label>
            <input type="text" name="attendance_start" value="<%= settings.attendance_start %>" placeholder="08:00" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">Grace Period (Minutes)</label>
            <input type="number" name="grace_period" value="<%= settings.grace_period %>" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
          </div>
          <div>
            <label class="block text-slate-300 font-medium mb-1">School Year</label>
            <input type="text" name="school_year" value="<%= settings.school_year %>" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
          </div>
        </div>
        <div>
          <label class="block text-slate-300 font-medium mb-1">Organization Logo URL</label>
          <input type="url" name="logo" value="<%= settings.logo %>" placeholder="https://..." class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
        </div>
        <div class="pt-4 border-t border-slate-700">
          <label class="block text-slate-300 font-medium mb-1">Change Admin Password (Leave blank to keep current)</label>
          <input type="password" name="new_password" placeholder="New secure password" class="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:outline-none">
        </div>
        <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-5 py-2.5 rounded-lg transition shadow">Save Changes</button>
      </form>
    </div>
  </main>
</body>
</html>`,

  // 9. ADMIN AUDIT LOGS
  'admin_audit.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Audit Logs</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans flex min-h-screen">
  <aside class="w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between hidden md:flex">
    <div>
      <div class="p-6 border-b border-slate-800">
        <h2 class="text-lg font-bold text-indigo-400 truncate"><%= settings.organization_name %></h2>
        <p class="text-xs text-slate-500 mt-1">Admin Control Center</p>
      </div>
      <nav class="p-4 space-y-1 text-sm">
        <a href="/admin/dashboard" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Dashboard</a>
        <a href="/admin/members" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Members Management</a>
        <a href="/admin/attendance" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Attendance Records</a>
        <a href="/admin/reports" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Analytics & Reports</a>
        <a href="/admin/announcements" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">Announcements</a>
        <a href="/admin/audit-logs" class="flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium">Audit Logs</a>
        <a href="/admin/settings" class="flex items-center gap-3 px-4 py-2.5 text-slate-300 hover:bg-slate-800 rounded-xl transition">System Settings</a>
      </nav>
    </div>
    <div class="p-4 border-t border-slate-800">
      <div class="flex items-center justify-between">
        <span class="text-xs text-slate-400">Logged as <strong class="text-white"><%= adminUser %></strong></span>
        <a href="/admin/logout" class="text-xs text-rose-400 hover:underline">Logout</a>
      </div>
    </div>
  </aside>

  <main class="flex-1 flex flex-col min-w-0 overflow-y-auto">
    <div class="p-8 max-w-6xl w-full mx-auto space-y-6">
      <div>
        <h1 class="text-3xl font-extrabold text-white">System Audit Trail</h1>
        <p class="text-slate-400 text-xs mt-1">Track administrative actions and security events.</p>
      </div>

      <div class="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden shadow">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="bg-slate-950 text-slate-400 uppercase font-semibold text-[10px]">
            <tr>
              <th class="p-4">Timestamp</th>
              <th class="p-4">Actor</th>
              <th class="p-4">Action Performed</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-700/50">
            <% if (logs.length === 0) { %>
              <tr><td colspan="3" class="p-8 text-center text-slate-500">No audit logs recorded.</td></tr>
            <% } else { %>
              <% logs.forEach(l => { %>
                <tr class="hover:bg-slate-750">
                  <td class="p-4 font-mono text-slate-400"><%= new Date(l.created_at).toLocaleString() %></td>
                  <td class="p-4 font-bold text-indigo-400"><%= l.actor %></td>
                  <td class="p-4 text-white"><%= l.action %></td>
                </tr>
              <% }) %>
            <% } %>
          </tbody>
        </table>
      </div>
    </div>
  </main>
</body>
</html>`,

  // 10. SEPARATE SMARTPHONE SCANNER PORTAL
  'scanner.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scanner Portal - <%= settings.organization_name %></title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
</head>
<body class="bg-slate-950 text-slate-100 font-sans min-h-screen flex flex-col justify-between p-4">
  
  <header class="text-center py-3 border-b border-slate-800">
    <span class="bg-emerald-500/20 text-emerald-400 text-[10px] px-3 py-1 rounded-full uppercase font-semibold tracking-widest">Entrance Scanner Portal</span>
    <h1 class="text-xl font-black text-white mt-1"><%= settings.organization_name %></h1>
  </header>

  <main class="max-w-md w-full mx-auto my-auto space-y-4 py-4">
    <!-- Mode Selection -->
    <div class="grid grid-cols-2 gap-3">
      <button id="btnTimeIn" onclick="setMode('TIME_IN')" class="py-3 rounded-xl font-bold text-xs bg-emerald-600 text-white shadow-lg transition">TIME IN</button>
      <button id="btnTimeOut" onclick="setMode('TIME_OUT')" class="py-3 rounded-xl font-bold text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition">TIME OUT</button>
    </div>

    <!-- Scanner Viewport Area -->
    <div class="bg-slate-900 border-2 border-slate-800 rounded-3xl overflow-hidden p-3 shadow-2xl relative">
      <div id="reader" class="w-full rounded-2xl overflow-hidden"></div>
      <div id="scannerStatus" class="text-center text-xs text-slate-400 mt-2">Point phone camera at member QR code</div>
    </div>

    <!-- Scan Result Popup / Display Box -->
    <div id="resultBox" class="hidden rounded-2xl p-5 border text-center shadow-2xl transition-all">
      <div id="resIcon" class="text-3xl font-black mb-1">✓</div>
      <h2 id="resTitle" class="text-lg font-black">SUCCESSFUL</h2>
      <div id="resDetails" class="text-xs text-slate-300 mt-2 space-y-1"></div>
    </div>
  </main>

  <footer class="text-center text-[10px] text-slate-600 py-2">
    Dedicated Smartphone Attendance Terminal &bull; Secure Token Validation
  </footer>

  <!-- Web Audio API synthesized BEEP / ERROR sounds -->
  <script>
    let currentMode = 'TIME_IN';
    let isProcessing = false;

    function setMode(mode) {
      currentMode = mode;
      const btnIn = document.getElementById('btnTimeIn');
      const btnOut = document.getElementById('btnTimeOut');
      if (mode === 'TIME_IN') {
        btnIn.className = "py-3 rounded-xl font-bold text-xs bg-emerald-600 text-white shadow-lg transition";
        btnOut.className = "py-3 rounded-xl font-bold text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition";
      } else {
        btnOut.className = "py-3 rounded-xl font-bold text-xs bg-indigo-600 text-white shadow-lg transition";
        btnIn.className = "py-3 rounded-xl font-bold text-xs bg-slate-800 text-slate-300 hover:bg-slate-700 transition";
      }
    }

    function playBeep(success = true) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        if (success) {
          osc.frequency.setValueAtTime(800, ctx.currentTime);
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.15);
        } else {
          osc.frequency.setValueAtTime(300, ctx.currentTime);
          gain.gain.setValueAtTime(0.2, ctx.currentTime);
          osc.start();
          osc.stop(ctx.currentTime + 0.3);
        }
      } catch (e) { console.log(e); }
    }

    async function onScanSuccess(decodedText) {
      if (isProcessing) return;
      isProcessing = true;

      try {
        const response = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qr_token: decodedText, mode: currentMode })
        });
        const data = await response.json();
        
        const box = document.getElementById('resultBox');
        const icon = document.getElementById('resIcon');
        const title = document.getElementById('resTitle');
        const details = document.getElementById('resDetails');
        
        box.classList.remove('hidden');

        if (data.success) {
          playBeep(true);
          box.className = "rounded-2xl p-5 border bg-emerald-950/90 border-emerald-500 text-emerald-200 text-center shadow-2xl";
          icon.innerText = "✓";
          title.innerText = data.message;
          details.innerHTML = \`
            <div class="font-bold text-white text-sm">\${data.member.full_name}</div>
            <div>\${data.member.position} &bull; \${data.member.member_id}</div>
            <div class="font-mono text-emerald-400 mt-1">Time: \${data.time} (\${data.status})</div>
          \`;
        } else {
          playBeep(false);
          box.className = "rounded-2xl p-5 border bg-rose-950/90 border-rose-500 text-rose-200 text-center shadow-2xl";
          icon.innerText = "✕";
          title.innerText = data.message;
          details.innerHTML = \`<div class="text-rose-300">\${data.subtext || data.reason || 'Verification failed'}</div>\`;
        }

        setTimeout(() => {
          box.classList.add('hidden');
          isProcessing = false;
        }, 3000);

      } catch (err) {
        console.error(err);
        isProcessing = false;
      }
    }

    const html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onScanSuccess
    ).catch(err => {
      document.getElementById('scannerStatus').innerText = "Camera permission required for scanning.";
    });
  </script>
</body>
</html>`,

  // 11. MEMBER LOGIN
  'member_login.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Member Portal Login</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen">
  <div class="bg-slate-800 p-8 rounded-2xl border border-slate-700 w-full max-w-md shadow-2xl">
    <div class="text-center mb-6">
      <span class="bg-sky-500/20 text-sky-400 text-xs px-3 py-1 rounded-full uppercase font-semibold">Member Portal</span>
      <h1 class="text-2xl font-bold mt-2 text-white">Member Login</h1>
      <p class="text-slate-400 text-xs mt-1">Sign in with your system-generated club username & password</p>
    </div>
    <% if (error) { %>
      <div class="bg-rose-500/20 border border-rose-500 text-rose-300 text-xs p-3 rounded-lg mb-4 text-center"><%= error %></div>
    <% } %>
    <form action="/member/login" method="POST" class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1">Username</label>
        <input type="text" name="username" required placeholder="CLUB-2026-001" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-sky-500">
      </div>
      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1">Password</label>
        <input type="password" name="password" required class="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-sky-500">
      </div>
      <button type="submit" class="w-full bg-sky-600 hover:bg-sky-500 text-white font-semibold py-2.5 rounded-lg transition text-sm shadow-lg">Sign In</button>
    </form>
    <div class="mt-6 text-center text-xs text-slate-500">
      <a href="/" class="text-slate-400 hover:underline">&larr; Back to Portal Home</a>
    </div>
  </div>
</body>
</html>`,

  // 12. MEMBER CHANGE PASSWORD
  'member_change_password.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Change Temporary Password</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen">
  <div class="bg-slate-800 p-8 rounded-2xl border border-slate-700 w-full max-w-md shadow-2xl">
    <div class="text-center mb-6">
      <span class="bg-amber-500/20 text-amber-400 text-xs px-3 py-1 rounded-full uppercase font-semibold">First Login Security</span>
      <h1 class="text-xl font-bold mt-2 text-white">Change Temporary Password</h1>
      <p class="text-slate-400 text-xs mt-1">Your password is temporary. Please create a new secure password before continuing to your dashboard.</p>
    </div>
    <% if (error) { %>
      <div class="bg-rose-500/20 border border-rose-500 text-rose-300 text-xs p-3 rounded-lg mb-4 text-center"><%= error %></div>
    <% } %>
    <form action="/member/change-password" method="POST" class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-slate-300 mb-1">New Password (Min 6 characters)</label>
        <input type="password" name="new_password" required minlength="6" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-sky-500">
      </div>
      <button type="submit" class="w-full bg-sky-600 hover:bg-sky-500 text-white font-semibold py-2.5 rounded-lg transition text-sm shadow-lg">Update Password & Continue</button>
    </form>
  </div>
</body>
</html>`,

  // 13. MEMBER DASHBOARD
  'member_dashboard.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Member Dashboard - <%= member.full_name %></title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans min-h-screen flex flex-col justify-between">
  
  <header class="bg-slate-950 border-b border-slate-800 px-8 py-4 flex justify-between items-center">
    <div>
      <h1 class="font-bold text-sky-400 text-base"><%= settings.organization_name %></h1>
      <p class="text-xs text-slate-500">Member Portal</p>
    </div>
    <div class="flex items-center gap-4 text-xs">
      <span class="text-slate-300">Welcome, <strong class="text-white"><%= member.full_name %></strong></span>
      <a href="/member/logout" class="text-rose-400 hover:underline">Logout</a>
    </div>
  </header>

  <main class="max-w-6xl w-full mx-auto p-8 space-y-8 flex-1">
    
    <!-- Profile & QR Card Box -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      
      <!-- Profile Card -->
      <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow flex flex-col items-center text-center">
        <div class="w-24 h-24 rounded-full bg-slate-900 border-2 border-sky-500 overflow-hidden flex items-center justify-center font-bold text-2xl text-sky-400 mb-3 shadow">
          <% if (member.photo) { %>
            <img src="<%= member.photo %>" class="w-full h-full object-cover">
          <% } else { %>
            <%= member.full_name.charAt(0) %>
          <% } %>
        </div>
        <h2 class="text-lg font-bold text-white"><%= member.full_name %></h2>
        <span class="text-xs text-sky-400 font-semibold"><%= member.position %></span>
        <div class="text-xs text-slate-400 mt-2 space-y-1 w-full border-t border-slate-700/50 pt-3 text-left">
          <div><strong class="text-slate-500">Member ID:</strong> <span class="font-mono text-white"><%= member.member_id %></span></div>
          <div><strong class="text-slate-500">Course:</strong> <%= member.course || 'N/A' %></div>
          <div><strong class="text-slate-500">Year & Sec:</strong> Year <%= member.year_level || '1' %> (<%= member.section || 'N/A' %>)</div>
        </div>
        <a href="/member/id-card" target="_blank" class="w-full mt-4 bg-sky-600 hover:bg-sky-500 text-white font-semibold py-2 rounded-xl text-xs transition shadow">View / Download My ID Card</a>
      </div>

      <!-- QR Token Display Card -->
      <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow flex flex-col items-center justify-center text-center">
        <span class="text-xs font-semibold text-slate-400 uppercase mb-3">My Attendance QR Badge</span>
        <div class="bg-white p-3 rounded-2xl shadow">
          <div id="memberQr" class="w-32 h-32 flex items-center justify-center"></div>
        </div>
        <p class="text-[10px] text-slate-400 mt-3">Present this QR code at the entrance scanner.</p>
      </div>

      <!-- Attendance Stats Card -->
      <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow flex flex-col justify-between">
        <div>
          <h3 class="text-xs font-semibold text-slate-400 uppercase">My Attendance Summary</h3>
          <div class="grid grid-cols-2 gap-4 mt-4">
            <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50">
              <span class="text-[10px] text-slate-400">Present</span>
              <div class="text-2xl font-black text-emerald-400 mt-1"><%= totalPresent %></div>
            </div>
            <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50">
              <span class="text-[10px] text-slate-400">Late</span>
              <div class="text-2xl font-black text-amber-400 mt-1"><%= totalLate %></div>
            </div>
          </div>
        </div>
        <div class="mt-4 pt-4 border-t border-slate-700 flex justify-between items-center text-xs">
          <span class="text-slate-400">Attendance Rate</span>
          <span class="font-bold text-sky-400 text-sm"><%= attendancePercentage %>%</span>
        </div>
      </div>
    </div>

    <!-- Attendance History & Announcements -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      
      <!-- Attendance History -->
      <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow">
        <h3 class="font-bold text-white text-sm mb-4">My Attendance Log</h3>
        <div class="space-y-3 max-h-64 overflow-y-auto">
          <% if (attendance.length === 0) { %>
            <p class="text-xs text-slate-500 py-4 text-center">No attendance records found yet.</p>
          <% } else { %>
            <% attendance.forEach(att => { %>
              <div class="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 flex justify-between items-center text-xs">
                <div>
                  <span class="font-mono text-white"><%= att.date %></span>
                  <span class="text-[10px] text-slate-400 block">In: <%= att.time_in || '—' %> | Out: <%= att.time_out || '—' %></span>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold <%= att.status === 'Present' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400' %>"><%= att.status %></span>
              </div>
            <% }) %>
          <% } %>
        </div>
      </div>

      <!-- Announcements -->
      <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700 shadow">
        <h3 class="font-bold text-white text-sm mb-4">Club Announcements</h3>
        <div class="space-y-3 max-h-64 overflow-y-auto">
          <% if (announcements.length === 0) { %>
            <p class="text-xs text-slate-500 py-4 text-center">No announcements posted.</p>
          <% } else { %>
            <% announcements.forEach(a => { %>
              <div class="bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 text-xs">
                <h4 class="font-bold text-white"><%= a.title %></h4>
                <p class="text-slate-300 mt-1"><%= a.message %></p>
                <span class="text-[10px] text-slate-500 mt-1 block"><%= new Date(a.created_at).toLocaleDateString() %></span>
              </div>
            <% }) %>
          <% } %>
        </div>
      </div>
    </div>
  </main>

  <footer class="py-4 text-center text-xs text-slate-500 border-t border-slate-800">
    Member Portal &bull; <%= settings.organization_name %>
  </footer>

  <script>
    new QRCode(document.getElementById("memberQr"), {
      text: "<%= member.qr_token %>",
      width: 128,
      height: 128,
      colorDark: "#020617",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  </script>
</body>
</html>`,

  // 14. MEMBER ID CARD VIEW
  'member_id_card.ejs': `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>My Digital ID Card</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
</head>
<body class="bg-slate-900 text-slate-100 flex flex-col items-center justify-center min-h-screen p-6">
  
  <div class="mb-6 flex gap-3">
    <button onclick="window.print()" class="bg-sky-600 hover:bg-sky-500 text-white px-5 py-2.5 rounded-xl font-semibold text-xs shadow-lg transition">Print ID Card</button>
    <button onclick="window.close()" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-5 py-2.5 rounded-xl font-semibold text-xs transition">Close Window</button>
  </div>

  <div class="bg-slate-950 border border-slate-800 w-[420px] rounded-2xl overflow-hidden shadow-2xl flex flex-col relative text-slate-100">
    <div class="bg-sky-950 border-b border-sky-900/50 p-4 text-center">
      <div class="text-[10px] tracking-widest text-sky-300 font-semibold uppercase"><%= settings.school_name %></div>
      <div class="text-base font-extrabold text-white"><%= settings.organization_name %></div>
    </div>

    <div class="p-6 flex gap-5 items-center">
      <div class="w-28 h-32 rounded-xl bg-slate-900 border-2 border-sky-500/50 overflow-hidden flex items-center justify-center font-bold text-2xl text-sky-400 shrink-0 shadow">
        <% if (member.photo) { %>
          <img src="<%= member.photo %>" class="w-full h-full object-cover">
        <% } else { %>
          <%= member.full_name.charAt(0) %>
        <% } %>
      </div>

      <div class="space-y-1.5 flex-1 min-w-0">
        <div>
          <h2 class="text-lg font-black text-white truncate"><%= member.full_name %></h2>
          <p class="text-xs font-semibold text-sky-400"><%= member.position %></p>
        </div>
        <div class="text-[11px] text-slate-300 space-y-0.5 pt-1">
          <div><strong class="text-slate-400">ID No:</strong> <span class="font-mono text-white"><%= member.member_id %></span></div>
          <div><strong class="text-slate-400">Course:</strong> <%= member.course || 'N/A' %></div>
          <div><strong class="text-slate-400">Year:</strong> <%= member.year_level || 'N/A' %></div>
          <div><strong class="text-slate-400">S.Y.:</strong> <%= settings.school_year %></div>
        </div>
      </div>
    </div>

    <div class="bg-slate-900/80 border-t border-slate-800 p-4 flex justify-between items-center">
      <div class="space-y-1">
        <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Status</div>
        <div class="text-[11px] text-emerald-400 font-bold"><%= member.status %> Member</div>
        <div class="text-[9px] text-slate-500 max-w-[180px]">Official Organization Digital ID Badge</div>
      </div>
      <div class="bg-white p-2 rounded-xl shadow shrink-0">
        <div id="qrcode" class="w-20 h-20 flex items-center justify-center"></div>
      </div>
    </div>
  </div>

  <script>
    new QRCode(document.getElementById("qrcode"), {
      text: "<%= member.qr_token %>",
      width: 80,
      height: 80,
      colorDark: "#020617",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  </script>
</body>
</html>`
};

// Register dynamic EJS views directly into Express template cache
for (const [filename, content] of Object.entries(views)) {
  app.engine(filename, (filePath, options, callback) => {
    try {
      const rendered = require('ejs').render(content, options);
      return callback(null, rendered);
    } catch (err) {
      return callback(err);
    }
  });
}

// Override view lookup name for views in subfolders or direct render calls
app.use((req, res, next) => {
  const originalRender = res.render;
  res.render = function(view, options, callback) {
    const viewFileName = view + '.ejs';
    if (views[viewFileName]) {
      return originalRender.call(this, viewFileName, options, callback);
    }
    return originalRender.call(this, view, options, callback);
  };
  next();
});

// Start Server
app.listen(PORT, () => {
  console.log(`=> School Club QR Attendance System running on port ${PORT}`);
  console.log(`=> Access Admin Portal at http://localhost:${PORT}/admin/login`);
  console.log(`=> Access Scanner Portal at http://localhost:${PORT}/scanner`);
  console.log(`=> Access Member Portal at http://localhost:${PORT}/member/login`);
});
