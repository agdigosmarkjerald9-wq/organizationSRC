/**
 * ClubTrack QR Attendance System
 * Complete Organization and Club Management System for High School
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Database Connection Config (Supports Render DATABASE_URL or local envs)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/clubtrack_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'clubtrack-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true if utilizing strict HTTPS proxy termination
}));

// --- DATABASE INITIALIZATION & SCHEMA SETUP ---
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization_settings (
        id SERIAL PRIMARY KEY,
        school_name VARCHAR(255) DEFAULT 'ABC High School',
        org_name VARCHAR(255) DEFAULT 'Supreme Student Council',
        school_year VARCHAR(50) DEFAULT '2026-2027',
        org_description VARCHAR(500) DEFAULT 'Official student governance organization.',
        id_prefix VARCHAR(50) DEFAULT 'SSC',
        theme_color VARCHAR(50) DEFAULT '#4f46e5',
        org_logo TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL, -- 'admin', 'member', 'scanner'
        name VARCHAR(150) NOT NULL,
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
        gender VARCHAR(20),
        grade_level VARCHAR(50) NOT NULL,
        section VARCHAR(50) NOT NULL,
        position VARCHAR(100) DEFAULT 'Member',
        contact_info VARCHAR(100),
        email VARCHAR(150),
        profile_photo TEXT,
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'ACTIVE',
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
        status VARCHAR(50) DEFAULT 'ACTIVE'
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL,
        time_in TIME,
        time_out TIME,
        status VARCHAR(50) DEFAULT 'ABSENT', -- Present, Late, Completed, Missing Out
        scan_method VARCHAR(50) DEFAULT 'QR',
        remarks TEXT,
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
        actor VARCHAR(150),
        role VARCHAR(50),
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        scanner_user VARCHAR(150),
        event_id INTEGER,
        scan_type VARCHAR(50),
        qr_value TEXT,
        result_status VARCHAR(50),
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Default Settings Check
    const settingsCheck = await client.query('SELECT * FROM organization_settings LIMIT 1');
    if (settingsCheck.rows.length === 0) {
      await client.query(`
        INSERT INTO organization_settings (school_name, org_name, school_year, org_description, id_prefix, theme_color)
        VALUES ('ABC High School', 'Supreme Student Council', '2026–2027', 'Official Student Organization.', 'SSC', '#4f46e5');
      `);
    }

    // Default Admin Account
    const adminCheck = await client.query("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
    if (adminCheck.rows.length === 0) {
      const hashedPass = await bcrypt.hash('admin123', 10);
      await client.query(
        'INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, $3, $4, $5)',
        ['admin', hashedPass, 'admin', 'System Administrator', true]
      );
      console.log('Default Admin created: username: admin | password: admin123');
    }
  } catch (err) {
    console.error('Database Initialization Error:', err);
  } finally {
    client.release();
  }
}

initDB();

// --- HELPER LOGGING FUNCTION ---
async function logAction(actor, role, action, details) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (actor, role, action, details) VALUES ($1, $2, $3, $4)',
      [actor, role, action, details]
    );
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

// --- AUTH MIDDLEWARES ---
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    if (req.session.user.mustChangePassword && req.path !== '/change-password' && req.path !== '/logout' && req.path !== '/api/change-password') {
      return res.redirect('/change-password');
    }
    return next();
  }
  res.redirect('/login');
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === role) {
      if (req.session.user.mustChangePassword && req.path !== '/change-password' && req.path !== '/logout') {
        return res.redirect('/change-password');
      }
      return next();
    }
    res.status(403).send('Access Denied: Insufficient Privileges.');
  };
}

// --- SHARED CSS & DESIGN SYSTEM ---
const GLOBAL_STYLE = `
  :root {
    --primary: #4f46e5;
    --primary-hover: #4338ca;
    --bg-main: #f3f4f6;
    --card-bg: #ffffff;
    --text-main: #1f2937;
    --text-muted: #6b7280;
    --border: #e5e7eb;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
  body { background: var(--bg-main); color: var(--text-main); display: flex; height: 100vh; overflow: hidden; }
  .sidebar { width: 260px; background: #111827; color: #fff; display: flex; flex-direction: column; transition: all 0.3s; }
  .sidebar-brand { padding: 20px; font-size: 1.2rem; font-weight: bold; background: #1f2937; display: flex; align-items: center; gap: 10px; }
  .sidebar-menu { list-style: none; padding: 15px 0; overflow-y: auto; flex: 1; }
  .sidebar-menu li a { display: flex; align-items: center; gap: 12px; padding: 12px 20px; color: #9ca3af; text-decoration: none; font-size: 0.95rem; transition: 0.2s; }
  .sidebar-menu li a:hover, .sidebar-menu li a.active { background: #374151; color: #fff; border-left: 4px solid var(--primary); }
  .main-content { flex: 1; display: flex; flex-direction: column; overflow-y: auto; }
  .topbar { background: var(--card-bg); padding: 15px 30px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .container { padding: 30px; max-width: 1400px; width: 100%; margin: 0 auto; }
  .card { background: var(--card-bg); border-radius: 10px; padding: 25px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); margin-bottom: 20px; border: 1px solid var(--border); }
  .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 25px; }
  .stat-card { background: var(--card-bg); padding: 20px; border-radius: 10px; border-left: 5px solid var(--primary); box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
  .stat-card h3 { font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; }
  .stat-card p { font-size: 1.8rem; font-weight: bold; color: var(--text-main); }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; background: var(--card-bg); border-radius: 8px; overflow: hidden; }
  th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  th { background: #f9fafb; font-weight: 600; color: var(--text-muted); }
  .btn { background: var(--primary); color: white; padding: 10px 18px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; transition: 0.2s; font-size: 0.9rem; }
  .btn:hover { background: var(--primary-hover); }
  .btn-danger { background: var(--danger); }
  .btn-danger:hover { background: #dc2626; }
  .btn-success { background: var(--success); }
  .btn-success:hover { background: #059669; }
  .btn-secondary { background: #6b7280; }
  .btn-secondary:hover { background: #4b5563; }
  input, select, textarea { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.95rem; margin-top: 6px; margin-bottom: 15px; }
  label { font-weight: 500; font-size: 0.9rem; color: var(--text-main); }
  .badge { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; text-transform: uppercase; display: inline-block; }
  .badge-active, .badge-present { background: #d1fae5; color: #065f46; }
  .badge-late { background: #fef3c7; color: #92400e; }
  .badge-absent, .badge-danger { background: #fee2e2; color: #991b1b; }
  .flex-row { display: flex; gap: 15px; align-items: center; }
  .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; padding: 20px; }
  .modal-content { background: var(--card-bg); padding: 30px; border-radius: 12px; width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); }
  @media print {
    body * { visibility: hidden; }
    .printable-area, .printable-area * { visibility: visible; }
    .printable-area { position: absolute; left: 0; top: 0; width: 100%; }
    .no-print { display: none !important; }
  }
`;

// --- ROUTE: LOGIN PAGE ---
app.get('/login', async (req, res) => {
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Login - ${settings.org_name}</title>
      <style>
        ${GLOBAL_STYLE}
        body { justify-content: center; align-items: center; background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%); }
        .login-card { background: white; padding: 40px; border-radius: 16px; width: 100%; max-width: 420px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2); }
        .login-header { text-align: center; margin-bottom: 30px; }
        .login-header h1 { font-size: 1.5rem; color: var(--text-main); margin-top: 10px; }
        .login-header p { font-size: 0.85rem; color: var(--text-muted); }
      </style>
    </head>
    <body>
      <div class="login-card">
        <div class="login-header">
          <h2>${settings.school_name}</h2>
          <h1>${settings.org_name}</h1>
          <p>QR Code Attendance Management System</p>
        </div>
        ${req.query.error ? `<div style="background:#fee2e2; color:#991b1b; padding:10px; border-radius:6px; margin-bottom:15px; font-size:0.85rem; text-align:center;">${req.query.error}</div>` : ''}
        <form action="/login" method="POST">
          <label>Username</label>
          <input type="text" name="username" required autofocus placeholder="Enter your username">
          <label>Password</label>
          <input type="password" name="password" required placeholder="Enter your password">
          <button type="submit" class="btn" style="width:100%; justify-content:center; margin-top:10px; padding:12px;">Sign In</button>
        </form>
        <div style="text-align: center; margin-top: 20px; font-size: 0.85rem;">
          <a href="/scanner" style="color: var(--primary); text-decoration: none; font-weight: 600;">📱 Open Standalone Scanner Portal</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) {
      return res.redirect('/login?error=Invalid username or password.');
    }
    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.redirect('/login?error=Invalid username or password.');
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      mustChangePassword: user.must_change_password
    };

    await logAction(user.name, user.role, 'USER_LOGIN', `User logged in successfully`);

    if (user.must_change_password) {
      return res.redirect('/change-password');
    }

    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member/portal');
  } catch (err) {
    console.error(err);
    res.redirect('/login?error=Database error occurred during login.');
  }
});

// --- ROUTE: FORCED PASSWORD CHANGE ---
app.get('/change-password', isAuthenticated, async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Security Requirement - Change Password</title>
      <style>
        ${GLOBAL_STYLE}
        body { justify-content: center; align-items: center; background: #f3f4f6; }
        .card-box { background: white; padding: 40px; border-radius: 12px; max-width: 500px; width: 100%; box-shadow: 0 10px 15px rgba(0,0,0,0.1); }
      </style>
    </head>
    <body>
      <div class="card-box">
        <h2 style="color: #b45309; margin-bottom: 10px;">⚠️ Security Password Reset</h2>
        <p style="font-size: 0.9rem; color: #4b5563; margin-bottom: 20px;">
          Welcome! Your account is using a temporary password. You are required to update your password to a secure private one before proceeding.
        </p>
        ${req.query.error ? `<div style="background:#fee2e2; color:#991b1b; padding:10px; border-radius:6px; margin-bottom:15px; font-size:0.85rem;">${req.query.error}</div>` : ''}
        <form action="/change-password" method="POST">
          <label>Current Temporary Password</label>
          <input type="password" name="currentPassword" required>
          <label>New Password (Min 8 Characters)</label>
          <input type="password" name="newPassword" minlength="8" required>
          <label>Confirm New Password</label>
          <input type="password" name="confirmPassword" minlength="8" required>
          <button type="submit" class="btn" style="width:100%; justify-content:center; margin-top:10px;">Update Password & Secure Account</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/change-password', isAuthenticated, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (newPassword !== confirmPassword || newPassword.length < 8) {
    return res.redirect('/change-password?error=Passwords must match and be at least 8 characters.');
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows[0];
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.redirect('/change-password?error=Incorrect current temporary password.');
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, user.id]);
    req.session.user.mustChangePassword = false;

    await logAction(user.name, user.role, 'PASSWORD_CHANGED', 'User successfully updated temporary password');

    if (user.role === 'admin') res.redirect('/admin');
    else if (user.role === 'scanner') res.redirect('/scanner');
    else res.redirect('/member/portal');
  } catch (err) {
    console.error(err);
    res.redirect('/change-password?error=Server error updating password.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// --- ROUTE: STANDALONE SCANNER PORTAL (Dedicated Link for Mobile/Tablets) ---
app.get('/scanner', isAuthenticated, async (req, res) => {
  const eventsRes = await pool.query("SELECT * FROM events WHERE status = 'ACTIVE' ORDER BY event_date DESC");
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Scanner Portal - ${settings.org_name}</title>
      <script src="https://unpkg.com/html5-qrcode"></script>
      <style>
        ${GLOBAL_STYLE}
        body { background: #0f172a; color: #fff; height: 100vh; display: flex; flex-direction: column; overflow-y: auto; }
        .scanner-container { max-width: 600px; width: 100%; margin: 20px auto; padding: 20px; }
        .scanner-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .mode-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
        .mode-btn { padding: 18px; font-size: 1.1rem; font-weight: bold; border-radius: 8px; border: 2px solid #475569; background: #334155; color: #cbd5e1; cursor: pointer; text-align: center; transition: 0.2s; }
        .mode-btn.active { background: var(--primary); border-color: #818cf8; color: white; box-shadow: 0 0 15px rgba(79,70,229,0.4); }
        #reader { width: 100%; border-radius: 8px; overflow: hidden; border: none; background: #000; }
        .result-box { padding: 20px; border-radius: 8px; margin-top: 15px; text-align: center; display: none; }
        .result-success { background: rgba(16, 185, 129, 0.2); border: 1px solid var(--success); color: #34d399; }
        .result-error { background: rgba(239, 68, 68, 0.2); border: 1px solid var(--danger); color: #f87171; }
      </style>
    </head>
    <body>
      <div class="scanner-container">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
          <div>
            <h2 style="font-size: 1.3rem;">📱 Attendance Scanner</h2>
            <p style="font-size: 0.8rem; color: #94a3b8;">Operator: ${req.session.user.name}</p>
          </div>
          <div style="display:flex; gap:10px;">
            <button onclick="toggleSound()" id="soundToggleBtn" class="btn btn-secondary" style="padding:6px 12px; font-size:0.8rem;">🔊 Sound: ON</button>
            <a href="${req.session.user.role === 'admin' ? '/admin' : '/logout'}" class="btn btn-secondary" style="padding:6px 12px; font-size:0.8rem;">Exit</a>
          </div>
        </div>

        <div class="scanner-card">
          <label style="color:#cbd5e1;">Select Attendance Event</label>
          <select id="eventSelect" style="background:#0f172a; color:#fff; border-color:#475569;">
            ${eventsRes.rows.map(e => `<option value="${e.id}">${e.event_name} (${e.event_date})</option>`).join('')}
          </select>

          <label style="color:#cbd5e1; display:block; margin-top:15px; margin-bottom:8px;">Select Scan Mode</label>
          <div class="mode-buttons">
            <button type="button" class="mode-btn active" id="btnTimeIn" onclick="setScanMode('IN')">TIME IN</button>
            <button type="button" class="mode-btn" id="btnTimeOut" onclick="setScanMode('OUT')">TIME OUT</button>
          </div>

          <button onclick="startScanner()" class="btn btn-success" style="width:100%; justify-content:center; padding:14px; font-size:1rem;" id="startCamBtn">▶ Start Camera Scanner</button>
          <div id="reader" style="margin-top: 15px;"></div>
        </div>

        <div id="scanResultBox" class="result-box">
          <h3 id="resultTitle" style="font-size: 1.2rem; margin-bottom: 8px;"></h3>
          <p id="resultDetails" style="font-size: 1rem;"></p>
        </div>
      </div>

      <script>
        let currentMode = 'IN';
        let html5QrCode = null;
        let soundEnabled = true;
        let isProcessing = false;

        function toggleSound() {
          soundEnabled = !soundEnabled;
          document.getElementById('soundToggleBtn').innerText = soundEnabled ? '🔊 Sound: ON' : '🔇 Sound: OFF';
        }

        function playSound(type) {
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
            osc.start();
            osc.stop(ctx.currentTime + 0.25);
          } else if (type === 'duplicate') {
            osc.frequency.setValueAtTime(400, ctx.currentTime);
            osc.frequency.setValueAtTime(300, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
          } else { // error
            osc.frequency.setValueAtTime(200, ctx.currentTime);
            osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.4);
          }
        }

        function setScanMode(mode) {
          currentMode = mode;
          document.getElementById('btnTimeIn').classList.toggle('active', mode === 'IN');
          document.getElementById('btnTimeOut').classList.toggle('active', mode === 'OUT');
        }

        async function startScanner() {
          const startBtn = document.getElementById('startCamBtn');
          startBtn.style.display = 'none';

          if (html5QrCode) {
            try { await html5QrCode.stop(); } catch(e){}
          }

          html5QrCode = new Html5Qrcode("reader");
          const qrConfig = { fps: 10, qrbox: { width: 250, height: 250 } };

          html5QrCode.start(
            { facingMode: "environment" }, 
            qrConfig, 
            async (decodedText) => {
              if (isProcessing) return;
              isProcessing = true;
              await processScan(decodedText);
              setTimeout(() => { isProcessing = false; }, 3000);
            },
            (errorMessage) => {}
          ).catch(err => {
            alert("Camera access error or permission denied: " + err);
            startBtn.style.display = 'block';
          });
        }

        async function processScan(qrToken) {
          const eventId = document.getElementById('eventSelect').value;
          const box = document.getElementById('scanResultBox');
          const title = document.getElementById('resultTitle');
          const details = document.getElementById('resultDetails');

          try {
            const res = await fetch('/api/scan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ qr_token: qrToken, event_id: eventId, scan_type: currentMode })
            });
            const data = await res.json();

            box.style.display = 'block';
            if (data.status === 'success') {
              playSound('success');
              box.className = 'result-box result-success';
              title.innerText = '✓ ' + data.message;
              details.innerHTML = \`<strong>\${data.member.name}</strong><br>ID: \${data.member.member_id}<br>Grade: \${data.member.grade_level} - \${data.member.section}<br>Time: \${data.time}\`;
            } else if (data.status === 'duplicate') {
              playSound('duplicate');
              box.className = 'result-box result-error';
              title.innerText = '⚠ ALREADY RECORDED';
              details.innerHTML = \`<strong>\${data.member.name}</strong><br>\${data.message}\`;
            } else {
              playSound('error');
              box.className = 'result-box result-error';
              title.innerText = '✕ INVALID QR CODE';
              details.innerText = data.message;
            }
          } catch(e) {
            playSound('error');
            box.className = 'result-box result-error';
            title.innerText = '✕ NETWORK ERROR';
            details.innerText = 'Could not communicate with the attendance server.';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// --- API: QR SCAN PROCESSING ENDPOINT ---
app.post('/api/scan', isAuthenticated, async (req, res) => {
  const { qr_token, event_id, scan_type } = req.body;
  const operator = req.session.user.name;

  try {
    const memberRes = await pool.query('SELECT * FROM members WHERE qr_token = $1', [qr_token]);
    if (memberRes.rows.length === 0) {
      await pool.query(
        'INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [operator, event_id, scan_type, qr_token, 'INVALID', 'QR Token not found in database']
      );
      return res.json({ status: 'error', message: 'This QR Code does not belong to a registered member.' });
    }

    const member = memberRes.rows.sync ? memberRes.rows[0] : memberRes.rows[0];
    if (member.status !== 'ACTIVE') {
      return res.json({ status: 'error', message: 'Member account is currently deactivated.' });
    }

    const eventRes = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    const event = eventRes.rows[0];

    const todayStr = new Date().toISOString().split('T')[0];
    const nowTimeStr = new Date().toTimeString().split(' ')[0];

    const attRes = await pool.query(
      'SELECT * FROM attendance WHERE member_id = $1 AND event_id = $2 AND attendance_date = $3',
      [member.id, event_id, todayStr]
    );

    if (scan_type === 'IN') {
      if (attRes.rows.length > 0 && attRes.rows[0].time_in) {
        return res.json({
          status: 'duplicate',
          member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id },
          message: `Already timed in at ${attRes.rows[0].time_in}`
        });
      }

      // Late classification check
      const isLate = nowTimeStr > event.late_cutoff;
      const attendanceStatus = isLate ? 'Late' : 'Present';

      if (attRes.rows.length > 0) {
        await pool.query(
          'UPDATE attendance SET time_in = $1, status = $2 WHERE id = $3',
          [nowTimeStr, attendanceStatus, attRes.rows[0].id]
        );
      } else {
        await pool.query(
          'INSERT INTO attendance (member_id, event_id, attendance_date, time_in, status, scan_method) VALUES ($1, $2, $3, $4, $5, $6)',
          [member.id, event_id, todayStr, nowTimeStr, attendanceStatus, 'QR']
        );
      }

      await pool.query(
        'INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [operator, event_id, 'IN', member.member_id, 'SUCCESS', 'Time In recorded successfully']
      );

      return res.json({
        status: 'success',
        message: 'TIME IN RECORDED',
        time: nowTimeStr,
        member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id, grade_level: member.grade_level, section: member.section }
      });

    } else { // TIME OUT
      if (attRes.rows.length === 0 || !attRes.rows[0].time_in) {
        return res.json({ status: 'error', message: 'Cannot record Time Out without a prior Time In record.' });
      }
      if (attRes.rows[0].time_out) {
        return res.json({
          status: 'duplicate',
          member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id },
          message: `Already timed out at ${attRes.rows[0].time_out}`
        });
      }

      await pool.query(
        'UPDATE attendance SET time_out = $1, status = $2 WHERE id = $3',
        [nowTimeStr, 'Completed', attRes.rows[0].id]
      );

      await pool.query(
        'INSERT INTO scanner_logs (scanner_user, event_id, scan_type, qr_value, result_status, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [operator, event_id, 'OUT', member.member_id, 'SUCCESS', 'Time Out recorded successfully']
      );

      return res.json({
        status: 'success',
        message: 'TIME OUT RECORDED',
        time: nowTimeStr,
        member: { name: `${member.first_name} ${member.last_name}`, member_id: member.member_id, grade_level: member.grade_level, section: member.section }
      });
    }

  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ status: 'error', message: 'Internal server error processing scan.' });
  }
});

// --- ROUTE: ADMIN PORTAL ---
app.get('/admin', isAuthenticated, requireRole('admin'), async (req, res) => {
  const tab = req.query.tab || 'dashboard';
  const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
  const settings = settingsRes.rows[0];

  // Fetch statistics
  const memCount = await pool.query('SELECT COUNT(*) FROM members');
  const activeCount = await pool.query("SELECT COUNT(*) FROM members WHERE status = 'ACTIVE'");
  const todayStr = new Date().toISOString().split('T')[0];
  const presentToday = await pool.query('SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND time_in IS NOT NULL', [todayStr]);
  const lateToday = await pool.query("SELECT COUNT(*) FROM attendance WHERE attendance_date = $1 AND status = 'Late'", [todayStr]);
  const invalidScans = await pool.query("SELECT COUNT(*) FROM scanner_logs WHERE result_status = 'INVALID'");

  const membersList = await pool.query('SELECT * FROM members ORDER BY last_name ASC');
  const eventsList = await pool.query('SELECT * FROM events ORDER BY event_date DESC');
  const scannersList = await pool.query("SELECT * FROM users WHERE role = 'scanner'");
  const announcementsList = await pool.query('SELECT * FROM announcements ORDER BY date_posted DESC');
  const liveAttendance = await pool.query(`
    SELECT a.*, m.first_name, m.last_name, m.member_id, m.grade_level, m.section, e.event_name 
    FROM attendance a 
    JOIN members m ON a.member_id = m.id 
    JOIN events e ON a.event_id = e.id 
    ORDER BY a.created_at DESC LIMIT 50
  `);

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Admin Portal - ${settings.org_name}</title>
      <style>
        ${GLOBAL_STYLE}
        .nav-badge { background: var(--primary); color: white; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; float: right; }
      </style>
    </head>
    <body>
      <div class="sidebar">
        <div class="sidebar-brand">
          <span>🛡️</span> <span>${settings.org_name}</span>
        </div>
        <ul class="sidebar-menu">
          <li><a href="/admin?tab=dashboard" class="${tab==='dashboard'?'active':''}">📊 Dashboard</a></li>
          <li><a href="/admin?tab=members" class="${tab==='members'?'active':''}">👥 Members Directory</a></li>
          <li><a href="/admin?tab=attendance" class="${tab==='attendance'?'active':''}">📋 Attendance Logs</a></li>
          <li><a href="/admin?tab=events" class="${tab==='events'?'active':''}">📅 Events & Schedule</a></li>
          <li><a href="/admin?tab=scanners" class="${tab==='scanners'?'active':''}">📱 Scanner Accounts</a></li>
          <li><a href="/admin?tab=announcements" class="${tab==='announcements'?'active':''}">📢 Announcements</a></li>
          <li><a href="/admin?tab=reports" class="${tab==='reports'?'active':''}">📈 Reports & Export</a></li>
          <li><a href="/admin?tab=settings" class="${tab==='settings'?'active':''}">⚙️ Organization Setup</a></li>
          <li><a href="/scanner" target="_blank">🚀 Open Scanner UI</a></li>
          <li><a href="/logout" style="color:#f87171;">🚪 Sign Out</a></li>
        </ul>
      </div>

      <div class="main-content">
        <div class="topbar">
          <h3>${settings.school_name} - Admin Portal</h3>
          <span style="font-size: 0.9rem; font-weight: 600;">👤 ${req.session.user.name}</span>
        </div>

        <div class="container">
          ${tab === 'dashboard' ? `
            <div class="grid-4">
              <div class="stat-card"><h3>Total Members</h3><p>${memCount.rows[0].count}</p></div>
              <div class="stat-card" style="border-left-color:var(--success);"><h3>Active Members</h3><p>${activeCount.rows[0].count}</p></div>
              <div class="stat-card" style="border-left-color:var(--warning);"><h3>Present Today</h3><p>${presentToday.rows[0].count}</p></div>
              <div class="stat-card" style="border-left-color:var(--danger);"><h3>Invalid QR Scans</h3><p>${invalidScans.rows[0].count}</p></div>
            </div>

            <div class="card">
              <h3>⚡ Live Attendance Stream (Auto-updating)</h3>
              <table>
                <thead>
                  <tr><th>Time</th><th>Member Name</th><th>ID</th><th>Grade & Section</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
                </thead>
                <tbody>
                  ${liveAttendance.rows.map(r => `
                    <tr>
                      <td>${r.created_at ? new Date(r.created_at).toLocaleTimeString() : ''}</td>
                      <td><strong>${r.first_name} ${r.last_name}</strong></td>
                      <td>${r.member_id}</td>
                      <td>${r.grade_level} - ${r.section}</td>
                      <td>${r.event_name}</td>
                      <td>${r.time_in || '---'}</td>
                      <td>${r.time_out || '---'}</td>
                      <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}

          ${tab === 'members' ? `
            <div class="card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
                <h3>Members Management</h3>
                <button onclick="document.getElementById('addMemberModal').style.display='flex'" class="btn">+ Register New Member</button>
              </div>
              <table>
                <thead>
                  <tr><th>Member ID</th><th>Full Name</th><th>Grade & Section</th><th>Position</th><th>Username</th><th>Status</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  ${membersList.rows.map(m => `
                    <tr>
                      <td><strong>${m.member_id}</strong></td>
                      <td>${m.first_name} ${m.middle_name || ''} ${m.last_name}</td>
                      <td>${m.grade_level} - ${m.section}</td>
                      <td>${m.position}</td>
                      <td><code>${m.username || 'N/A'}</code></td>
                      <td><span class="badge badge-${m.status.toLowerCase()}">${m.status}</span></td>
                      <td>
                        <a href="/admin/member/id-card/${m.id}" target="_blank" class="btn btn-secondary" style="padding:5px 10px; font-size:0.75rem;">🖨️ ID Card</a>
                        <form action="/admin/member/reset-pass" method="POST" style="display:inline;">
                          <input type="hidden" name="member_id" value="${m.id}">
                          <button type="submit" class="btn btn-secondary" style="padding:5px 10px; font-size:0.75rem; background:#d97706;">🔑 Reset PW</button>
                        </form>
                        <form action="/admin/member/delete" method="POST" style="display:inline;" onsubmit="return confirm('Delete this member completely?');">
                          <input type="hidden" name="member_id" value="${m.id}">
                          <button type="submit" class="btn btn-danger" style="padding:5px 10px; font-size:0.75rem;">🗑️ Delete</button>
                        </form>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}

          ${tab === 'attendance' ? `
            <div class="card">
              <h3>Attendance Records Management</h3>
              <table>
                <thead>
                  <tr><th>Date</th><th>Member Name</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr>
                </thead>
                <tbody>
                  ${liveAttendance.rows.map(r => `
                    <tr>
                      <td>${r.attendance_date}</td>
                      <td><strong>${r.first_name} ${r.last_name}</strong> (${r.member_id})</td>
                      <td>${r.event_name}</td>
                      <td>${r.time_in || '---'}</td>
                      <td>${r.time_out || '---'}</td>
                      <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}

          ${tab === 'events' ? `
            <div class="card">
              <h3>Create Attendance Event</h3>
              <form action="/admin/event/create" method="POST">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                  <div><label>Event Name</label><input type="text" name="event_name" required></div>
                  <div><label>Event Date</label><input type="date" name="event_date" required></div>
                  <div><label>Start Time</label><input type="time" name="start_time" required></div>
                  <div><label>Expected End Time</label><input type="time" name="end_time" required></div>
                  <div><label>Late Cutoff Time</label><input type="time" name="late_cutoff" required></div>
                  <div><label>Description</label><input type="text" name="description"></div>
                </div>
                <button type="submit" class="btn" style="margin-top:15px;">Schedule Event</button>
              </form>

              <h3 style="margin-top: 30px; margin-bottom: 15px;">Scheduled Events</h3>
              <table>
                <thead>
                  <tr><th>Event Name</th><th>Date</th><th>Start</th><th>End</th><th>Late Cutoff</th><th>Status</th></tr>
                </thead>
                <tbody>
                  ${eventsList.rows.map(e => `
                    <tr>
                      <td><strong>${e.event_name}</strong></td>
                      <td>${e.event_date}</td>
                      <td>${e.start_time}</td>
                      <td>${e.end_time}</td>
                      <td>${e.late_cutoff}</td>
                      <td><span class="badge badge-active">${e.status}</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}

          ${tab === 'scanners' ? `
            <div class="card">
              <h3>Create Scanner Officer Account</h3>
              <form action="/admin/scanner/create" method="POST" style="max-width: 500px;">
                <label>Officer Name</label><input type="text" name="name" required>
                <label>Username</label><input type="text" name="username" required>
                <label>Temporary Password</label><input type="password" name="password" required>
                <button type="submit" class="btn">Create Scanner Account</button>
              </form>

              <h3 style="margin-top: 30px;">Authorized Scanner Officers</h3>
              <table>
                <thead><tr><th>Name</th><th>Username</th><th>Action</th></tr></thead>
                <tbody>
                  ${scannersList.rows.map(s => `
                    <tr><td><strong>${s.name}</strong></td><td><code>${s.username}</code></td><td>Scanner Portal Access Only</td></tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}

          ${tab === 'announcements' ? `
            <div class="card">
              <h3>Broadcast Announcement</h3>
              <form action="/admin/announcement/create" method="POST" style="max-width: 600px;">
                <label>Title</label><input type="text" name="title" required>
                <label>Message Content</label><textarea name="message" rows="4" required></textarea>
                <button type="submit" class="btn">Post Announcement</button>
              </form>

              <h3 style="margin-top: 30px;">Active Announcements</h3>
              ${announcementsList.rows.map(a => `
                <div style="background:#f9fafb; padding:15px; border-radius:8px; border:1px solid var(--border); margin-top:10px;">
                  <h4>${a.title}</h4>
                  <p style="font-size:0.9rem; color:var(--text-muted); margin-top:5px;">${a.message}</p>
                  <small style="color:#9ca3af;">Posted: ${new Date(a.date_posted).toLocaleString()}</small>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${tab === 'reports' ? `
            <div class="card">
              <h3>Reports & CSV Export</h3>
              <p style="color:var(--text-muted); margin-bottom:20px;">Download comprehensive CSV reports for records archiving.</p>
              <a href="/admin/export/csv" class="btn btn-success">📥 Download Full Attendance CSV Report</a>
            </div>
          ` : ''}

          ${tab === 'settings' ? `
            <div class="card">
              <h3>Organization Configuration</h3>
              <form action="/admin/settings/update" method="POST" style="max-width: 600px;">
                <label>School Name</label><input type="text" name="school_name" value="${settings.school_name}" required>
                <label>Organization Name</label><input type="text" name="org_name" value="${settings.org_name}" required>
                <label>School Year</label><input type="text" name="school_year" value="${settings.school_year}" required>
                <label>Organization Description</label><input type="text" name="org_description" value="${settings.org_description}">
                <label>Member ID Prefix</label><input type="text" name="id_prefix" value="${settings.id_prefix}" required>
                <button type="submit" class="btn">Save Configuration</button>
              </form>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Add Member Modal -->
      <div id="addMemberModal" class="modal">
        <div class="modal-content">
          <h3>Register New Organization Member</h3>
          <form action="/admin/member/create" method="POST">
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
              <div><label>First Name</label><input type="text" name="first_name" required></div>
              <div><label>Middle Name</label><input type="text" name="middle_name"></div>
              <div><label>Last Name</label><input type="text" name="last_name" required></div>
              <div><label>Gender</label><select name="gender"><option>Male</option><option>Female</option><option>Other</option></select></div>
              <div><label>Grade Level</label><input type="text" name="grade_level" placeholder="Grade 10" required></div>
              <div><label>Section</label><input type="text" name="section" placeholder="Rizal" required></div>
              <div><label>Position</label><input type="text" name="position" value="Member"></div>
              <div><label>Contact Info</label><input type="text" name="contact_info"></div>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
              <button type="button" onclick="document.getElementById('addMemberModal').style.display='none'" class="btn btn-secondary">Cancel</button>
              <button type="submit" class="btn">Save & Generate Credentials</button>
            </div>
          </form>
        </div>
      </div>
    </body>
    </html>
  `);
});

// --- ADMIN ACTIONS: MEMBER REGISTRATION & DELETION ---
app.post('/admin/member/create', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { first_name, middle_name, last_name, gender, grade_level, section, position, contact_info } = req.body;
  try {
    const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
    const settings = settingsRes.rows[0];

    const countRes = await pool.query('SELECT COUNT(*) FROM members');
    const seqNum = parseInt(countRes.rows[0].count) + 1;
    const memberId = `${settings.id_prefix}-${new Date().getFullYear()}-${String(seqNum).padStart(4, '0')}`;
    
    let username = `${first_name.toLowerCase().replace(/[^a-z]/g, '')}${last_name.toLowerCase().replace(/[^a-z]/g, '')}`;
    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userCheck.rows.length > 0) username += seqNum;

    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const userIns = await pool.query(
      'INSERT INTO users (username, password, role, name, must_change_password) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [username, hashedPassword, 'member', `${first_name} ${last_name}`, true]
    );
    const userId = userIns.rows[0].id;

    const qrToken = 'CLUBTRACK:MEMBER:' + crypto.randomUUID();
    
    await pool.query(
      `INSERT INTO members (user_id, member_id, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, qr_token) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [userId, memberId, first_name, middle_name, last_name, gender, grade_level, section, position, contact_info, qrToken]
    );

    await logAction(req.session.user.name, 'admin', 'MEMBER_REGISTERED', `Registered new member ${memberId} - ${first_name} ${last_name}`);

    // Render Secure Credentials Modal Screen
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><title>Credentials Generated</title><style>${GLOBAL_STYLE}</style></head>
      <body style="display:flex; justify-content:center; align-items:center;">
        <div class="card" style="max-width:500px; width:100%; text-align:center;">
          <h2 style="color:var(--success); margin-bottom:15px;">✓ Member Successfully Registered</h2>
          <p style="text-align:left; font-size:0.95rem; line-height:1.6; margin-bottom:20px;">
            <strong>Full Name:</strong> ${first_name} ${last_name}<br>
            <strong>Member ID:</strong> ${memberId}<br>
            <strong>Username:</strong> <code>${username}</code><br>
            <strong>Temporary Password:</strong> <code style="color:var(--danger); font-size:1.1rem;">${tempPassword}</code>
          </p>
          <div style="background:#fef3c7; color:#92400e; padding:10px; border-radius:6px; font-size:0.85rem; margin-bottom:20px;">
            ⚠️ Save these credentials securely. The temporary password will not be displayed again.
          </div>
          <a href="/admin?tab=members" class="btn" style="width:100%; justify-content:center;">Return to Members Directory</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error registering member.');
  }
});

app.post('/admin/member/delete', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { member_id } = req.body;
  try {
    const memRes = await pool.query('SELECT user_id, member_id FROM members WHERE id = $1', [member_id]);
    if (memRes.rows.length > 0) {
      const { user_id, member_id: mId } = memRes.rows[0];
      await pool.query('DELETE FROM users WHERE id = $1', [user_id]);
      await logAction(req.session.user.name, 'admin', 'MEMBER_DELETED', `Deleted member record ${mId}`);
    }
    res.redirect('/admin?tab=members');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting member.');
  }
});

app.post('/admin/member/reset-pass', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { member_id } = req.body;
  try {
    const memRes = await pool.query('SELECT user_id, first_name, last_name, member_id FROM members WHERE id = $1', [member_id]);
    const m = memRes.rows[0];
    const tempPass = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hashed = await bcrypt.hash(tempPass, 10);

    await pool.query('UPDATE users SET password = $1, must_change_password = TRUE WHERE id = $2', [hashed, m.user_id]);
    await logAction(req.session.user.name, 'admin', 'PASSWORD_RESET', `Reset temporary password for ${m.member_id}`);

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><title>Password Reset</title><style>${GLOBAL_STYLE}</style></head>
      <body style="display:flex; justify-content:center; align-items:center;">
        <div class="card" style="max-width:450px; width:100%; text-align:center;">
          <h3>🔑 Password Reset Generated</h3>
          <p style="margin:20px 0;">New Temporary Password for <strong>${m.first_name} ${m.last_name}</strong> (${m.member_id}):</p>
          <div style="font-size:1.5rem; font-weight:bold; color:var(--primary); padding:10px; background:#e0e7ff; border-radius:6px; margin-bottom:20px;">${tempPass}</div>
          <a href="/admin?tab=members" class="btn" style="width:100%; justify-content:center;">Back to Members</a>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error resetting password.');
  }
});

app.post('/admin/event/create', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { event_name, description, event_date, start_time, end_time, late_cutoff } = req.body;
  try {
    await pool.query(
      'INSERT INTO events (event_name, description, event_date, start_time, end_time, late_cutoff) VALUES ($1, $2, $3, $4, $5, $6)',
      [event_name, description, event_date, start_time, end_time, late_cutoff]
    );
    await logAction(req.session.user.name, 'admin', 'EVENT_CREATED', `Created event ${event_name}`);
    res.redirect('/admin?tab=events');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error creating event.');
  }
});

app.post('/admin/scanner/create', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { name, username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password, role, name) VALUES ($1, $2, $3, $4)', [username, hashed, 'scanner', name]);
    await logAction(req.session.user.name, 'admin', 'SCANNER_CREATED', `Created scanner account ${username}`);
    res.redirect('/admin?tab=scanners');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error creating scanner.');
  }
});

app.post('/admin/announcement/create', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { title, message } = req.body;
  try {
    await pool.query('INSERT INTO announcements (title, message) VALUES ($1, $2)', [title, message]);
    res.redirect('/admin?tab=announcements');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error posting announcement.');
  }
});

app.post('/admin/settings/update', isAuthenticated, requireRole('admin'), async (req, res) => {
  const { school_name, org_name, school_year, org_description, id_prefix } = req.body;
  try {
    await pool.query(
      'UPDATE organization_settings SET school_name = $1, org_name = $2, school_year = $3, org_description = $4, id_prefix = $5 WHERE id = 1',
      [school_name, org_name, school_year, org_description, id_prefix]
    );
    res.redirect('/admin?tab=settings');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error updating settings.');
  }
});

app.get('/admin/export/csv', isAuthenticated, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.member_id, m.first_name, m.last_name, m.grade_level, m.section, e.event_name, a.attendance_date, a.time_in, a.time_out, a.status 
      FROM attendance a 
      JOIN members m ON a.member_id = m.id 
      JOIN events e ON a.event_id = e.id
    `);

    let csv = 'Member ID,First Name,Last Name,Grade,Section,Event,Date,Time In,Time Out,Status\n';
    result.rows.forEach(r => {
      csv += `"${r.member_id}","${r.first_name}","${r.last_name}","${r.grade_level}","${r.section}","${r.event_name}","${r.attendance_date}","${r.time_in || ''}","${r.time_out || ''}","${r.status}"\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('clubtrack_attendance_report.csv');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error generating CSV report.');
  }
});

// --- ROUTE: PRINTABLE ID CARD VIEW ---
app.get('/admin/member/id-card/:id', isAuthenticated, async (req, res) => {
  const memberId = req.params.id;
  try {
    const memRes = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id WHERE m.id = $1', [memberId]);
    if (memRes.rows.length === 0) return res.status(404).send('Member not found.');
    const member = memRes.rows[0];

    const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
    const settings = settingsRes.rows[0];

    const qrImage = await QRCode.toDataURL(member.qr_token);

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><title>ID Card - ${member.first_name} ${member.last_name}</title>
        <style>
          ${GLOBAL_STYLE}
          body { display: flex; justify-content: center; align-items: center; background: #e2e8f0; height: 100vh; }
          .id-card { width: 340px; background: white; border-radius: 12px; box-shadow: 0 10px 20px rgba(0,0,0,0.15); border: 2px solid var(--primary); overflow: hidden; text-align: center; padding: 20px; }
          .id-header { background: var(--primary); color: white; padding: 12px; margin: -20px -20px 15px -20px; }
          .id-header h4 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; }
          .id-header h2 { font-size: 1.1rem; margin-top: 4px; }
          .avatar-box { width: 90px; height: 90px; border-radius: 50%; background: #cbd5e1; margin: 0 auto 15px auto; display: flex; align-items: center; justify-content: center; font-size: 2rem; color: #475569; font-weight: bold; border: 3px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          .qr-img { width: 110px; height: 110px; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div>
          <div class="id-card printable-area">
            <div class="id-header">
              <h4>${settings.school_name}</h4>
              <h2>${settings.org_name}</h2>
            </div>
            <div class="avatar-box">${member.first_name[0]}${member.last_name[0]}</div>
            <h3 style="font-size: 1.2rem; margin-bottom: 2px;">${member.first_name} ${member.last_name}</h3>
            <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px;">${member.position}</p>
            
            <div style="text-align: left; font-size: 0.85rem; background: #f8fafb; padding: 10px; border-radius: 6px; margin-bottom: 12px;">
              <strong>ID No:</strong> ${member.member_id}<br>
              <strong>Grade & Sec:</strong> ${member.grade_level} - ${member.section}<br>
              <strong>Username:</strong> ${member.username}
            </div>

            <img src="${qrImage}" class="qr-img" alt="Member QR">
            <p style="font-size: 0.65rem; color: #94a3b8; margin-top: 10px;">Official Student Organization ID Card - ${settings.school_year}</p>
          </div>
          <div style="text-align: center; margin-top: 20px;" class="no-print">
            <button onclick="window.print()" class="btn">🖨️ Print ID Card</button>
            <a href="/admin?tab=members" class="btn btn-secondary">Back to Admin</a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error generating ID card.');
  }
});

// --- ROUTE: MEMBER PORTAL (Dedicated Link & Dashboard) ---
app.get('/member/portal', isAuthenticated, requireRole('member'), async (req, res) => {
  try {
    const memRes = await pool.query('SELECT m.*, u.username FROM members m JOIN users u ON m.user_id = u.id WHERE u.id = $1', [req.session.user.id]);
    if (memRes.rows.length === 0) return res.status(404).send('Member profile not found.');
    const member = memRes.rows[0];

    const settingsRes = await pool.query('SELECT * FROM organization_settings LIMIT 1');
    const settings = settingsRes.rows[0];

    const attRes = await pool.query(`
      SELECT a.*, e.event_name FROM attendance a JOIN events e ON a.event_id = e.id WHERE a.member_id = $1 ORDER BY a.attendance_date DESC
    `, [member.id]);

    const annRes = await pool.query('SELECT * FROM announcements ORDER BY date_posted DESC LIMIT 5');
    const qrImage = await QRCode.toDataURL(member.qr_token);

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8"><title>Member Portal - ${settings.org_name}</title>
        <style>${GLOBAL_STYLE}</style>
      </head>
      <body>
        <div class="sidebar">
          <div class="sidebar-brand"><span>🎓</span> <span>Member Portal</span></div>
          <ul class="sidebar-menu">
            <li><a href="/member/portal" class="active">👤 My Profile & QR</a></li>
            <li><a href="/logout" style="color:#f87171;">🚪 Sign Out</a></li>
          </ul>
        </div>
        <div class="main-content">
          <div class="topbar">
            <h3>Welcome, ${member.first_name} ${member.last_name}!</h3>
            <span>ID: ${member.member_id}</span>
          </div>
          <div class="container">
            <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 20px;">
              <div class="card" style="text-align: center;">
                <div style="width: 100px; height: 100px; border-radius: 50%; background: #e0e7ff; color: var(--primary); font-size: 2.2rem; display: flex; align-items: center; justify-content: center; margin: 0 auto 15px auto; font-weight: bold;">
                  ${member.first_name[0]}${member.last_name[0]}
                </div>
                <h3>${member.first_name} ${member.last_name}</h3>
                <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:15px;">${member.position}</p>
                <div style="background:#f9fafb; padding:12px; border-radius:8px; text-align:left; font-size:0.9rem; margin-bottom:15px;">
                  <strong>Member ID:</strong> ${member.member_id}<br>
                  <strong>Grade & Section:</strong> ${member.grade_level} - ${member.section}<br>
                  <strong>Username:</strong> ${member.username}<br>
                  <strong>Status:</strong> <span class="badge badge-active">${member.status}</span>
                </div>
                <img src="${qrImage}" style="width: 140px; height: 140px; margin: 10px 0;" alt="QR"><br>
                <a href="/admin/member/id-card/${member.id}" target="_blank" class="btn" style="width:100%; justify-content:center; margin-top:10px;">🖨️ Print / Download ID</a>
              </div>

              <div>
                <div class="card">
                  <h3>📢 Organization Announcements</h3>
                  ${annRes.rows.map(a => `
                    <div style="border-bottom:1px solid var(--border); padding: 12px 0;">
                      <h4 style="font-size:1rem; color:var(--primary);">${a.title}</h4>
                      <p style="font-size:0.9rem; color:var(--text-main); margin-top:4px;">${a.message}</p>
                      <small style="color:var(--text-muted);">Posted on ${new Date(a.date_posted).toLocaleDateString()}</small>
                    </div>
                  `).join('')}
                </div>

                <div class="card">
                  <h3>📋 My Attendance History</h3>
                  <table>
                    <thead><tr><th>Date</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                    <tbody>
                      ${attRes.rows.map(r => `
                        <tr>
                          <td>${r.attendance_date}</td>
                          <td>${r.event_name}</td>
                          <td>${r.time_in || '---'}</td>
                          <td>${r.time_out || '---'}</td>
                          <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading member portal.');
  }
});

// --- ROOT REDIRECT ---
app.get('/', (req, res) => {
  res.redirect('/login');
});

// --- SERVER LISTENER ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClubTrack QR Attendance System running on port ${PORT}`);
});
