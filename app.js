/**
 * School Organization QR Atte
 * Complete Full-Stack Single-File Node.js Application for Render Deployment
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Setup (PostgreSQL with SQLite fallback simulation or direct Pool)
let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  // Fallback or local warning, but PostgreSQL is required for Render deployment
  console.warn("WARNING: DATABASE_URL not found. Expecting PostgreSQL connection.");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/org_attendance'
  });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'super_secret_attendance_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // set secure: true in production with HTTPS
}));

// Initialize Database Tables
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        role VARCHAR(50) NOT NULL, -- Super Admin, Organization Admin, Scanner, Member
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        must_change_password BOOLEAN DEFAULT FALSE,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        code VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        logo TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        member_code VARCHAR(50) UNIQUE NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        middle_name VARCHAR(100),
        last_name VARCHAR(100) NOT NULL,
        grade_level VARCHAR(50) NOT NULL,
        section VARCHAR(50) NOT NULL,
        email VARCHAR(150),
        contact_number VARCHAR(50),
        photo TEXT,
        qr_token VARCHAR(255) UNIQUE NOT NULL,
        qr_created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        active BOOLEAN DEFAULT TRUE,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        title VARCHAR(150) NOT NULL,
        event_date DATE NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        attendance_date DATE NOT NULL,
        time_in TIMESTAMP,
        time_out TIMESTAMP,
        scanner_user_id INTEGER REFERENCES users(id),
        status VARCHAR(50) DEFAULT 'PRESENT', -- PRESENT, LATE, ABSENT
        attendance_type VARCHAR(50) DEFAULT 'REGULAR',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create Default Super Admin if not exists
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'ChangeThisPasswordImmediately';
    const checkAdmin = await client.query('SELECT * FROM users WHERE username = $1', [adminUser]);
    if (checkAdmin.rows.length === 0) {
      const hash = await bcrypt.hash(adminPass, 10);
      await client.query(
        'INSERT INTO users (role, username, password_hash, must_change_password) VALUES ($1, $2, $3, $4)',
        ['Super Admin', adminUser, hash, false]
      );
      console.log(`Default Super Admin created: ${adminUser}`);
    }
  } catch (err) {
    console.error("Database initialization error:", err);
  } finally {
    client.release();
  }
}

initDB();

// Helper: Log Activity
async function logActivity(userId, action) {
  try {
    await pool.query('INSERT INTO activity_logs (user_id, action) VALUES ($1, $2)', [userId, action]);
  } catch (err) {
    console.error('Error logging activity:', err);
  }
}

// Authentication Middlewares
function requireAuth(role = null) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (role && req.session.user.role !== role && req.session.user.role !== 'Super Admin') {
      // Allow Super Admin everywhere
      if (role === 'Admin' && (req.session.user.role === 'Organization Admin' || req.session.user.role === 'Super Admin')) {
        return next();
      }
      return res.status(403).send('Access Denied: Unauthorized Role');
    }
    // Check if password change is forced
    if (req.session.user.must_change_password && req.path !== '/member/change-password' && req.path !== '/api/change-password' && req.path !== '/api/logout') {
      if (req.session.user.role === 'Member') {
        return res.redirect('/member/change-password');
      }
    }
    next();
  };
}

// ==================== VIEWS & TEMPLATES (HTML/CSS/JS) ====================

const baseLayout = (title, content, user) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - School Organization QR Attendance System</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    :root { --bs-primary: #4e73df; --bs-success: #1cc88a; --bs-danger: #e74a3b; }
    body { background-color: #f8f9fc; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    .sidebar { min-height: 100vh; background: linear-gradient(180deg, #4e73df 10%, #224abe 100%); color: white; }
    .sidebar a { color: rgba(255,255,255,.8); text-decoration: none; padding: 10px 20px; display: block; border-radius: 5px; margin: 4px 10px; }
    .sidebar a:hover, .sidebar a.active { color: #fff; background: rgba(255,255,255,.15); }
    .card { border: none; box-shadow: 0 0.15rem 1.75rem 0 rgba(58, 59, 69, 0.15); border-radius: 0.5rem; }
    @media print {
      body * { visibility: hidden; }
      .printable-area, .printable-area * { visibility: visible; }
      .printable-area { position: absolute; left: 0; top: 0; width: 100%; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="container-fluid">
    <div class="row">
      ${user ? `
      <nav id="sidebar" class="col-md-3 col-lg-2 d-md-block sidebar collapse p-3 no-print">
        <div class="text-center mb-4">
          <h4><i class="fa-solid fa-qrcode"></i> QR Attendance</h4>
          <small class="text-white-50">${user.role}</small>
        </div>
        <hr class="text-white">
        ${user.role === 'Super Admin' || user.role === 'Organization Admin' ? `
          <a href="/admin"><i class="fa-solid fa-tachometer-alt me-2"></i> Dashboard</a>
          <a href="/admin/organizations"><i class="fa-solid fa-sitemap me-2"></i> Organizations</a>
          <a href="/admin/members"><i class="fa-solid fa-users me-2"></i> Members</a>
          <a href="/admin/attendance"><i class="fa-solid fa-clipboard-user me-2"></i> Attendance</a>
          <a href="/admin/reports"><i class="fa-solid fa-chart-bar me-2"></i> Reports</a>
          <a href="/admin/accounts"><i class="fa-solid fa-user-shield me-2"></i> Accounts</a>
        ` : ''}
        ${user.role === 'Member' ? `
          <a href="/member"><i class="fa-solid fa-home me-2"></i> Dashboard</a>
          <a href="/member/id"><i class="fa-solid id-card me-2"></i> Digital ID</a>
          <a href="/member/change-password"><i class="fa-solid fa-key me-2"></i> Change Password</a>
        ` : ''}
        ${user.role === 'Scanner' ? `
          <a href="/scanner" class="active"><i class="fa-solid fa-camera me-2"></i> Scanner Portal</a>
        ` : ''}
        <hr class="text-white">
        <a href="/api/logout" class="text-danger"><i class="fa-solid fa-sign-out-alt me-2"></i> Logout</a>
      </nav>
      ` : ''}
      <main class="${user ? 'col-md-9 ms-sm-auto col-lg-10 px-md-4 py-4' : 'col-12 p-0'}">
        ${content}
      </main>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>
`;

// ==================== ROUTES ====================

// Public Landing / Login Page
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'Member') return res.redirect('/member');
    if (req.session.user.role === 'Scanner') return res.redirect('/scanner');
    return res.redirect('/admin');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.send(baseLayout('Login', `
    <div class="row justify-content-center align-items-center min-vh-100">
      <div class="col-md-4">
        <div class="card p-4">
          <div class="text-center mb-4">
            <i class="fa-solid fa-qrcode fa-3x text-primary mb-2"></i>
            <h3>School Org Attendance</h3>
            <p class="text-muted">Sign in to your portal</p>
          </div>
          <form id="loginForm">
            <div class="mb-3">
              <label class="form-label">Username</label>
              <input type="text" class="form-control" name="username" required>
            </div>
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" class="form-control" name="password" required>
            </div>
            <div id="loginError" class="alert alert-danger d-none"></div>
            <button type="submit" class="btn btn-primary w-100">Login</button>
          </form>
          <div class="mt-3 text-center">
            <a href="/scanner" class="btn btn-outline-secondary btn-sm w-100 mb-2"><i class="fa-solid fa-camera"></i> Open QR Scanner Portal</a>
            <a href="/member" class="btn btn-outline-info btn-sm w-100"><i class="fa-solid fa-user"></i> Member Portal Login</a>
          </div>
        </div>
      </div>
    </div>
    <script>
      document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
        const data = await res.json();
        if (res.ok) {
          window.location.href = data.redirect;
        } else {
          const errEl = document.getElementById('loginError');
          errEl.textContent = data.error;
          errEl.classList.remove('d-none');
        }
      });
    </script>
  `, null));
});

// API Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1 AND active = true', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = result.rows.id ? result.rows : result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.user = { id: user.id, username: user.username, role: user.role, must_change_password: user.must_change_password };
    await logActivity(user.id, `User logged in: ${user.username}`);

    let redirect = '/admin';
    if (user.role === 'Member') redirect = '/member';
    if (user.role === 'Scanner') redirect = '/scanner';

    res.json({ success: true, redirect });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// API Logout
app.get('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ==================== ADMIN PORTAL ====================

app.get('/admin', requireAuth('Admin'), async (req, res) => {
  try {
    const orgsCount = await pool.query('SELECT COUNT(*) FROM organizations');
    const membersCount = await pool.query('SELECT COUNT(*) FROM members WHERE active = true');
    const presentToday = await pool.query('SELECT COUNT(DISTINCT member_id) FROM attendance WHERE attendance_date = CURRENT_DATE');
    
    res.send(baseLayout('Admin Dashboard', `
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h2>Admin Dashboard</h2>
        <span class="text-muted">Welcome, ${req.session.user.username}</span>
      </div>
      <div class="row g-3 mb-4">
        <div class="col-md-3">
          <div class="card bg-primary text-white p-3">
            <h6>Total Organizations</h6>
            <h3>${orgsCount.rows[0].count}</h3>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card bg-success text-white p-3">
            <h6>Total Active Members</h6>
            <h3>${membersCount.rows[0].count}</h3>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card bg-info text-white p-3">
            <h6>Present Today</h6>
            <h3>${presentToday.rows[0].count}</h3>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card bg-warning text-dark p-3">
            <h6>System Status</h6>
            <h3>Active</h3>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="col-md-12">
          <div class="card p-4">
            <h4>Quick Actions</h4>
            <div class="d-flex gap-2 mt-3">
              <a href="/admin/members" class="btn btn-outline-primary"><i class="fa-solid fa-user-plus"></i> Manage Members</a>
              <a href="/admin/organizations" class="btn btn-outline-success"><i class="fa-solid fa-sitemap"></i> Manage Organizations</a>
              <a href="/admin/attendance" class="btn btn-outline-info"><i class="fa-solid fa-clipboard-list"></i> View Attendance Logs</a>
              <a href="/scanner" class="btn btn-outline-dark" target="_blank"><i class="fa-solid fa-camera"></i> Open Scanner</a>
            </div>
          </div>
        </div>
      </div>
    `, req.session.user));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Organization Management Page
app.get('/admin/organizations', requireAuth('Admin'), async (req, res) => {
  const orgs = await pool.query(`
    SELECT o.*, COUNT(m.id) as member_count 
    FROM organizations o 
    LEFT JOIN members m ON o.id = m.organization_id AND m.active = true 
    GROUP BY o.id ORDER BY o.name
  `);

  res.send(baseLayout('Organization Management', `
    <div class="d-flex justify-content-between align-items-center mb-4">
      <h2>Organization Management</h2>
      <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addOrgModal"><i class="fa-solid fa-plus"></i> Add Organization</button>
    </div>
    <div class="card p-4">
      <table class="table table-striped">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Description</th>
            <th>Members</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${orgs.rows.map(o => `
            <tr>
              <td><strong>${o.code}</strong></td>
              <td>${o.name}</td>
              <td>${o.description || ''}</td>
              <td>${o.member_count}</td>
              <td><span class="badge bg-${o.active ? 'success' : 'secondary'}">${o.active ? 'Active' : 'Inactive'}</span></td>
              <td>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteOrg(${o.id})"><i class="fa-solid fa-trash"></i></button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Modal Add Org -->
    <div class="modal fade" id="addOrgModal" tabindex="-1">
      <div class="modal-dialog">
        <form id="addOrgForm" class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Create Organization</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label">Organization Name</label>
              <input type="text" class="form-control" name="name" required placeholder="e.g. Science Club">
            </div>
            <div class="mb-3">
              <label class="form-label">Code Prefix (e.g. SCI)</label>
              <input type="text" class="form-control" name="code" required placeholder="SCI">
            </div>
            <div class="mb-3">
              <label class="form-label">Description</label>
              <textarea class="form-control" name="description"></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button type="submit" class="btn btn-primary">Save Organization</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      document.getElementById('addOrgForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/api/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) location.reload();
        else alert('Failed to create organization');
      });

      async function deleteOrg(id) {
        if (!confirm('Are you sure you want to delete this organization?')) return;
        const res = await fetch('/api/organizations/' + id, { method: 'DELETE' });
        if (res.ok) location.reload();
        else alert('Error deleting organization');
      }
    </script>
  `, req.session.user));
});

// API Organizations
app.get('/api/organizations', requireAuth(), async (req, res) => {
  const result = await pool.query('SELECT * FROM organizations WHERE active = true');
  res.json(result.rows);
});

app.post('/api/organizations', requireAuth('Admin'), async (req, res) => {
  const { name, code, description } = req.body;
  try {
    await pool.query('INSERT INTO organizations (name, code, description) VALUES ($1, $2, $3)', [name, code.toUpperCase(), description]);
    await logActivity(req.session.user.id, `Created organization: ${name}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/organizations/:id', requireAuth('Admin'), async (req, res) => {
  await pool.query('UPDATE organizations SET active = false WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Member Management Page
app.get('/admin/members', requireAuth('Admin'), async (req, res) => {
  const orgs = await pool.query('SELECT * FROM organizations WHERE active = true');
  const members = await pool.query(`
    SELECT m.*, o.name as org_name 
    FROM members m 
    JOIN organizations o ON m.organization_id = o.id 
    WHERE m.active = true 
    ORDER BY m.created_at DESC
  `);

  res.send(baseLayout('Member Management', `
    <div class="d-flex justify-content-between align-items-center mb-4">
      <h2>Member Management</h2>
      <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addMemberModal"><i class="fa-solid fa-user-plus"></i> Add Member</button>
    </div>
    <div class="card p-4">
      <div class="table-responsive">
        <table class="table table-striped align-middle">
          <thead>
            <tr>
              <th>Member ID</th>
              <th>Full Name</th>
              <th>Organization</th>
              <th>Grade & Section</th>
              <th>Username</th>
              <th>Temp Password</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${members.rows.map(m => `
              <tr>
                <td><strong>${m.member_code}</strong></td>
                <td>${m.first_name} ${m.last_name}</td>
                <td>${m.org_name}</td>
                <td>${m.grade_level} - ${m.section}</td>
                <td><code>${m.username || 'N/A'}</code></td>
                <td><span class="badge bg-warning text-dark">Auto-Generated</span></td>
                <td>
                  <a href="/admin/members/${m.id}/id" class="btn btn-sm btn-outline-primary" target="_blank" title="View ID"><i class="fa-solid fa-id-card"></i></a>
                  <button class="btn btn-sm btn-outline-warning" onclick="regenerateQR(${m.id})" title="Regenerate QR"><i class="fa-solid fa-qrcode"></i></button>
                  <button class="btn btn-sm btn-outline-danger" onclick="deleteMember(${m.id}, '${m.first_name} ${m.last_name}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add Member Modal -->
    <div class="modal fade" id="addMemberModal" tabindex="-1">
      <div class="modal-dialog modal-lg">
        <form id="addMemberForm" class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Register New Member</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body row g-3">
            <div class="col-md-4">
              <label class="form-label">First Name</label>
              <input type="text" class="form-control" name="first_name" required>
            </div>
            <div class="col-md-4">
              <label class="form-label">Middle Name</label>
              <input type="text" class="form-control" name="middle_name">
            </div>
            <div class="col-md-4">
              <label class="form-label">Last Name</label>
              <input type="text" class="form-control" name="last_name" required>
            </div>
            <div class="col-md-6">
              <label class="form-label">Organization</label>
              <select class="form-select" name="organization_id" required>
                ${orgs.rows.map(o => `<option value="${o.id}">${o.name} (${o.code})</option>`).join('')}
              </select>
            </div>
            <div class="col-md-3">
              <label class="form-label">Grade Level</label>
              <input type="text" class="form-control" name="grade_level" required placeholder="Grade 11">
            </div>
            <div class="col-md-3">
              <label class="form-label">Section</label>
              <input type="text" class="form-control" name="section" required placeholder="Section A">
            </div>
            <div class="col-md-6">
              <label class="form-label">Email (Optional)</label>
              <input type="email" class="form-control" name="email">
            </div>
            <div class="col-md-6">
              <label class="form-label">Contact Number (Optional)</label>
              <input type="text" class="form-control" name="contact_number">
            </div>
          </div>
          <div class="modal-footer">
            <button type="submit" class="btn btn-primary">Save & Generate ID / QR</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Success Credentials Modal -->
    <div class="modal fade" id="credModal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header bg-success text-white">
            <h5 class="modal-title">Member Successfully Registered</h5>
          </div>
          <div class="modal-body">
            <p><strong>Member ID:</strong> <span id="resMemberCode"></span></p>
            <p><strong>Username:</strong> <span id="resUsername"></span></p>
            <p><strong>Temporary Password:</strong> <code id="resTempPass" class="fs-5 text-danger"></code></p>
            <div class="alert alert-warning">
              <strong>IMPORTANT REMINDER:</strong> This password is temporary. Please log in to the Member Portal and change your password immediately to secure your account.
            </div>
          </div>
          <div class="modal-footer">
            <a id="printIdBtn" href="#" target="_blank" class="btn btn-primary"><i class="fa-solid fa-print"></i> Print ID Card</a>
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" onclick="location.reload()">Close</button>
          </div>
        </div>
      </div>
    </div>

    <script>
      document.getElementById('addMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/api/members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();
        if (res.ok) {
          bootstrap.Modal.getInstance(document.getElementById('addMemberModal')).hide();
          document.getElementById('resMemberCode').textContent = result.member_code;
          document.getElementById('resUsername').textContent = result.username;
          document.getElementById('resTempPass').textContent = result.temp_password;
          document.getElementById('printIdBtn').href = '/admin/members/' + result.id + '/id';
          new bootstrap.Modal(document.getElementById('credModal')).show();
        } else {
          alert(result.error || 'Failed to add member');
        }
      });

      async function deleteMember(id, name) {
        if (!confirm('Are you sure you want to delete member ' + name + '? This will immediately invalidate their QR code.')) return;
        const res = await fetch('/api/members/' + id, { method: 'DELETE' });
        if (res.ok) location.reload();
        else alert('Error deleting member');
      }

      async function regenerateQR(id) {
        if (!confirm('Regenerating QR code will invalidate the previous one. Proceed?')) return;
        const res = await fetch('/api/members/' + id + '/regenerate-qr', { method: 'POST' });
        if (res.ok) {
          alert('QR Code successfully regenerated.');
          location.reload();
        } else {
          alert('Error regenerating QR code');
        }
      }
    </script>
  `, req.session.user));
});

// API Members CRUD & Generation
app.post('/api/members', requireAuth('Admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { organization_id, first_name, middle_name, last_name, grade_level, section, email, contact_number } = req.body;

    // Get organization code prefix
    const orgRes = await client.query('SELECT code FROM organizations WHERE id = $1', [organization_id]);
    if (orgRes.rows.length === 0) throw new Error('Organization not found');
    const orgCode = orgRes.rows[0].code;

    // Generate unique member ID: ORG-2026-XXXX
    const year = new Date().getFullYear();
    const countRes = await client.query('SELECT COUNT(*) FROM members WHERE organization_id = $1', [organization_id]);
    const seq = parseInt(countRes.rows[0].count) + 1;
    const member_code = `${orgCode}-${year}-${String(seq).padStart(4, '0')}`;

    // Generate Username & Temp Password
    const username = `${orgCode.toLowerCase()}_${first_name.toLowerCase()}${Math.floor(100 + Math.random() * 900)}`;
    const temp_password = crypto.randomBytes(4).toString('hex');
    const password_hash = await bcrypt.hash(temp_password, 10);

    // Create User Account
    const userResult = await client.query(
      'INSERT INTO users (role, username, password_hash, must_change_password) VALUES ($1, $2, $3, $4) RETURNING id',
      ['Member', username, password_hash, true]
    );
    const userId = userResult.rows[0].id;

    // Generate Secure QR Token
    const qr_token = crypto.randomBytes(32).toString('hex');

    // Insert Member
    const memberResult = await client.query(`
      INSERT INTO members (user_id, organization_id, member_code, first_name, middle_name, last_name, grade_level, section, email, contact_number, qr_token)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
    `, [userId, organization_id, member_code, first_name, middle_name || '', last_name, grade_level, section, email || '', contact_number || '', qr_token]);

    await client.query('COMMIT');
    await logActivity(req.session.user.id, `Registered member: ${member_code} (${first_name} ${last_name})`);

    res.json({
      success: true,
      id: memberResult.rows[0].id,
      member_code,
      username,
      temp_password
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/members/:id', requireAuth('Admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const memberRes = await client.query('SELECT user_id, member_code FROM members WHERE id = $1', [req.params.id]);
    if (memberRes.rows.length === 0) throw new Error('Member not found');
    const { user_id, member_code } = memberRes.rows;

    // Soft delete member & invalidate QR token by changing token
    await client.query('UPDATE members SET active = false, deleted_at = CURRENT_TIMESTAMP, qr_token = $1 WHERE id = $2', [`INVALID_${Date.now()}`, req.params.id]);
    await client.query('UPDATE users SET active = false WHERE id = $1', [user_id]);

    await client.query('COMMIT');
    await logActivity(req.session.user.id, `Deleted member: ${member_code} and invalidated QR code.`);
    res.json({ success: true, message: 'Member successfully deleted and QR code invalidated.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/members/:id/regenerate-qr', requireAuth('Admin'), async (req, res) => {
  try {
    const new_qr_token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE members SET qr_token = $1, qr_created_at = CURRENT_TIMESTAMP WHERE id = $2', [new_qr_token, req.params.id]);
    await logActivity(req.session.user.id, `Regenerated QR code for member ID ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Printable Member ID Page
app.get('/admin/members/:id/id', requireAuth('Admin'), async (req, res) => {
  const result = await pool.query(`
    SELECT m.*, o.name as org_name, o.code as org_code, u.username 
    FROM members m 
    JOIN organizations o ON m.organization_id = o.id 
    JOIN users u ON m.user_id = u.id 
    WHERE m.id = $1
  `, [req.params.id]);

  if (result.rows.length === 0) return res.status(404).send('Member not found');
  const m = result.rows;

  // Generate QR code data URL
  const qrDataUrl = await QRCode.toDataURL(m.qr_token, { width: 180 });

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>ID Card - ${m.member_code}</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        body { background: #eef2f7; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .id-card { width: 350px; background: white; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); overflow: hidden; border: 2px solid #4e73df; margin: 20px auto; }
        .id-header { background: #4e73df; color: white; padding: 15px; text-align: center; }
        .id-body { padding: 20px; text-align: center; }
        .id-footer { background: #f8f9fc; padding: 10px; font-size: 10px; text-align: center; border-top: 1px solid #ddd; }
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          .id-card { box-shadow: none; margin: 0; border: 1px solid #000; }
        }
      </style>
    </head>
    <body class="py-5">
      <div class="text-center mb-3 no-print">
        <button onclick="window.print()" class="btn btn-primary"><i class="fa-solid fa-print"></i> Print ID Card</button>
      </div>
      <div class="id-card">
        <div class="id-header">
          <h5>School Organization</h5>
          <small>${m.org_name}</small>
        </div>
        <div class="id-body">
          <div class="mb-3">
            <div class="bg-secondary text-white rounded-circle d-inline-flex align-items-center justify-content-center" style="width: 80px; height: 80px; font-size: 32px;">
              ${m.first_name[0]}${m.last_name[0]}
            </div>
          </div>
          <h4 class="mb-0">${m.first_name} ${m.middle_name ? m.middle_name[0] + '.' : ''} ${m.last_name}</h4>
          <p class="text-muted mb-2">${m.member_code}</p>
          <span class="badge bg-secondary mb-3">${m.grade_level} - ${m.section}</span>
          <div>
            <img src="${qrDataUrl}" alt="QR Code" class="img-fluid" style="width: 140px; height: 140px;">
          </div>
        </div>
        <div class="id-footer">
          <p class="mb-1"><strong>Username:</strong> ${m.username}</p>
          <p class="text-danger mb-0"><strong>IMPORTANT REMINDER:</strong> Please log in to change your temporary password immediately.</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Attendance Management Page
app.get('/admin/attendance', requireAuth('Admin'), async (req, res) => {
  const attendance = await pool.query(`
    SELECT a.*, m.member_code, m.first_name, m.last_name, o.name as org_name, u.username as scanner_name
    FROM attendance a
    JOIN members m ON a.member_id = m.id
    JOIN organizations o ON a.organization_id = o.id
    LEFT JOIN users u ON a.scanner_user_id = u.id
    ORDER BY a.created_at DESC LIMIT 100
  `);

  res.send(baseLayout('Attendance Records', `
    <div class="d-flex justify-content-between align-items-center mb-4">
      <h2>Attendance Logs</h2>
      <button onclick="window.print()" class="btn btn-outline-secondary"><i class="fa-solid fa-print"></i> Print Report</button>
    </div>
    <div class="card p-4 printable-area">
      <div class="table-responsive">
        <table class="table table-striped">
          <thead>
            <tr>
              <th>Date</th>
              <th>Member ID</th>
              <th>Name</th>
              <th>Organization</th>
              <th>Time In</th>
              <th>Time Out</th>
              <th>Status</th>
              <th>Scanner</th>
            </tr>
          </thead>
          <tbody>
            ${attendance.rows.map(att => `
              <tr>
                <td>${att.attendance_date.toISOString().split('T')[0]}</td>
                <td>${att.member_code}</td>
                <td>${att.first_name} ${att.last_name}</td>
                <td>${att.org_name}</td>
                <td>${att.time_in ? new Date(att.time_in).toLocaleTimeString() : '-'}</td>
                <td>${att.time_out ? new Date(att.time_out).toLocaleTimeString() : '-'}</td>
                <td><span class="badge bg-${att.status === 'PRESENT' ? 'success' : 'warning'}">${att.status}</span></td>
                <td>${att.scanner_name || 'System'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `, req.session.user));
});

// Reports Page
app.get('/admin/reports', requireAuth('Admin'), async (req, res) => {
  res.send(baseLayout('Attendance Reports', `
    <h2>Attendance Reports & Analytics</h2>
    <div class="row g-3 mt-3">
      <div class="col-md-6">
        <div class="card p-4">
          <h4>Daily Summary</h4>
          <p class="text-muted">Export daily attendance analytics and reports.</p>
          <a href="/admin/attendance" class="btn btn-primary"><i class="fa-solid fa-download"></i> View Full Logs</a>
        </div>
      </div>
      <div class="col-md-6">
        <div class="card p-4">
          <h4>Organization Breakdown</h4>
          <p class="text-muted">Analyze attendance per club or organization.</p>
          <a href="/admin/organizations" class="btn btn-success"><i class="fa-solid fa-sitemap"></i> View Organizations</a>
        </div>
      </div>
    </div>
  `, req.session.user));
});

// Admin Accounts Management
app.get('/admin/accounts', requireAuth('Super Admin'), async (req, res) => {
  const users = await pool.query('SELECT id, role, username, active, created_at FROM users ORDER BY created_at DESC');
  res.send(baseLayout('Account Management', `
    <div class="d-flex justify-content-between align-items-center mb-4">
      <h2>Staff & Scanner Accounts</h2>
      <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addAccountModal"><i class="fa-solid fa-user-plus"></i> Create Account</button>
    </div>
    <div class="card p-4">
      <table class="table table-striped">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Created At</th>
          </tr>
        </thead>
        <tbody>
          ${users.rows.map(u => `
            <tr>
              <td>${u.username}</td>
              <td><span class="badge bg-info">${u.role}</span></td>
              <td><span class="badge bg-${u.active ? 'success' : 'secondary'}">${u.active ? 'Active' : 'Inactive'}</span></td>
              <td>${new Date(u.created_at).toLocaleDateString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Modal Add Account -->
    <div class="modal fade" id="addAccountModal" tabindex="-1">
      <div class="modal-dialog">
        <form id="addAccountForm" class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Create Staff / Scanner Account</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <label class="form-label">Role</label>
              <select class="form-select" name="role" required>
                <option value="Organization Admin">Organization Admin</option>
                <option value="Scanner">Scanner Account</option>
              </select>
            </div>
            <div class="mb-3">
              <label class="form-label">Username</label>
              <input type="text" class="form-control" name="username" required>
            </div>
            <div class="mb-3">
              <label class="form-label">Password</label>
              <input type="password" class="form-control" name="password" required>
            </div>
          </div>
          <div class="modal-footer">
            <button type="submit" class="btn btn-primary">Create Account</button>
          </div>
        </form>
      </div>
    </div>
    <script>
      document.getElementById('addAccountForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) location.reload();
        else alert('Failed to create account');
      });
    </script>
  `, req.session.user));
});

app.post('/api/accounts', requireAuth('Super Admin'), async (req, res) => {
  const { role, username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (role, username, password_hash) VALUES ($1, $2, $3)', [role, username, hash]);
    await logActivity(req.session.user.id, `Created ${role} account: ${username}`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ==================== MEMBER PORTAL ====================

app.get('/member', requireAuth('Member'), async (req, res) => {
  const memberRes = await pool.query(`
    SELECT m.*, o.name as org_name, o.code as org_code 
    FROM members m 
    JOIN organizations o ON m.organization_id = o.id 
    WHERE m.user_id = $1
  `, [req.session.user.id]);

  if (memberRes.rows.length === 0) return res.status(404).send('Member profile not found');
  const m = memberRes.rows;

  const attendanceRes = await pool.query('SELECT * FROM attendance WHERE member_id = $1 ORDER BY created_at DESC LIMIT 10', [m.id]);
  const qrDataUrl = await QRCode.toDataURL(m.qr_token, { width: 200 });

  res.send(baseLayout('Member Portal', `
    <div class="row">
      <div class="col-md-4 mb-4">
        <div class="card p-4 text-center">
          <div class="bg-primary text-white rounded-circle d-inline-flex align-items-center justify-content-center mx-auto mb-3" style="width: 90px; height: 90px; font-size: 36px;">
            ${m.first_name[0]}${m.last_name[0]}
          </div>
          <h4>${m.first_name} ${m.last_name}</h4>
          <p class="text-muted mb-1"><strong>${m.member_code}</strong></p>
          <span class="badge bg-secondary mb-3">${m.org_name}</span>
          <hr>
          <div class="mb-3">
            <img src="${qrDataUrl}" alt="My QR Code" class="img-fluid border p-2 rounded" style="width: 180px; height: 180px;">
          </div>
          <a href="/admin/members/${m.id}/id" target="_blank" class="btn btn-outline-primary btn-sm"><i class="fa-solid fa-id-card"></i> View Printable Digital ID</a>
        </div>
      </div>
      <div class="col-md-8">
        <div class="card p-4 mb-4">
          <h4>Welcome, ${m.first_name}!</h4>
          <p class="text-muted">Grade Level: ${m.grade_level} | Section: ${m.section}</p>
          <hr>
          <h5>Recent Attendance History</h5>
          <div class="table-responsive">
            <table class="table table-striped">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Time In</th>
                  <th>Time Out</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${attendanceRes.rows.map(att => `
                  <tr>
                    <td>${att.attendance_date.toISOString().split('T')[0]}</td>
                    <td>${att.time_in ? new Date(att.time_in).toLocaleTimeString() : '-'}</td>
                    <td>${att.time_out ? new Date(att.time_out).toLocaleTimeString() : '-'}</td>
                    <td><span class="badge bg-success">${att.status}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `, req.session.user));
});

app.get('/member/change-password', requireAuth('Member'), (req, res) => {
  res.send(baseLayout('Change Password', `
    <div class="row justify-content-center">
      <div class="col-md-6">
        <div class="card p-4">
          <h3>Change Password Required</h3>
          <p class="text-danger">Your account is using a temporary password. You must change your password before continuing.</p>
          <form id="changePassForm">
            <div class="mb-3">
              <label class="form-label">Current / Temporary Password</label>
              <input type="password" class="form-control" name="current_password" required>
            </div>
            <div class="mb-3">
              <label class="form-label">New Password</label>
              <input type="password" class="form-control" name="new_password" required>
            </div>
            <div class="mb-3">
              <label class="form-label">Confirm New Password</label>
              <input type="password" class="form-control" name="confirm_password" required>
            </div>
            <div id="passError" class="alert alert-danger d-none"></div>
            <button type="submit" class="btn btn-primary w-100">Update Password</button>
          </form>
        </div>
      </div>
    </div>
    <script>
      document.getElementById('changePassForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        if (data.new_password !== data.confirm_password) {
          alert('New passwords do not match');
          return;
        }
        const res = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json();
        if (res.ok) {
          window.location.href = '/member';
        } else {
          const errEl = document.getElementById('passError');
          errEl.textContent = result.error;
          errEl.classList.remove('d-none');
        }
      });
    </script>
  `, req.session.user));
});

app.post('/api/change-password', requireAuth('Member'), async (req, res) => {
  const { current_password, new_password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    const user = userRes.rows;
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Incorrect current password' });

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [newHash, req.session.user.id]);
    req.session.user.must_change_password = false;
    await logActivity(req.session.user.id, 'Member changed password successfully.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SCANNER PORTAL ====================

app.get('/scanner', requireAuth(), async (req, res) => {
  if (req.session.user.role !== 'Scanner' && req.session.user.role !== 'Super Admin' && req.session.user.role !== 'Organization Admin') {
    return res.status(403).send('Unauthorized Scanner Portal Access');
  }

  res.send(baseLayout('QR Attendance Scanner', `
    <div class="row justify-content-center">
      <div class="col-md-8 text-center">
        <div class="card p-4 mb-3">
          <h2>QR Code Attendance Scanner</h2>
          <div class="my-3">
            <div class="btn-group" role="group">
              <input type="radio" class="btn-check" name="scanMode" id="modeTimeIn" value="TIME_IN" checked>
              <label class="btn btn-outline-success btn-lg" for="modeTimeIn">TIME IN</label>
              
              <input type="radio" class="btn-check" name="scanMode" id="modeTimeOut" value="TIME_OUT">
              <label class="btn btn-outline-danger btn-lg" for="modeTimeOut">TIME OUT</label>
            </div>
          </div>
          <h4 id="currentModeDisplay" class="text-success mb-3">CURRENT MODE: TIME IN</h4>
          
          <div id="reader" style="width: 100%; max-width: 500px; margin: 0 auto;"></div>
          
          <div id="scanResult" class="mt-4"></div>
        </div>
      </div>
    </div>

    <!-- Include html5-qrcode scanner library -->
    <script src="https://unpkg.com/html5-qrcode"></script>
    <script>
      let currentMode = 'TIME_IN';
      document.querySelectorAll('input[name="scanMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
          currentMode = e.target.value;
          const display = document.getElementById('currentModeDisplay');
          display.textContent = 'CURRENT MODE: ' + currentMode.replace('_', ' ');
          display.className = currentMode === 'TIME_IN' ? 'text-success mb-3' : 'text-danger mb-3';
        });
      });

      // Web Audio API Sound Generator
      function playSound(type) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);

          if (type === 'success') {
            osc.frequency.setValueAtTime(600, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.15);
          } else {
            osc.frequency.setValueAtTime(300, ctx.currentTime);
            osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
          }
        } catch(e) { console.log('Audio error:', e); }
      }

      async function onScanSuccess(decodedText) {
        // Prevent continuous rapid firing
        html5QrCode.pause();
        
        try {
          const res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_token: decodedText, attendance_type: currentMode })
          });
          const data = await res.json();
          const resultEl = document.getElementById('scanResult');
          
          if (res.ok) {
            playSound('success');
            resultEl.innerHTML = \`
              <div class="alert alert-success">
                <h4>\${currentMode === 'TIME_IN' ? 'TIME IN SUCCESSFUL' : 'TIME OUT SUCCESSFUL'}</h4>
                <p><strong>Name:</strong> \${data.member.first_name} \${data.member.last_name}</p>
                <p><strong>Member ID:</strong> \${data.member.member_code}</p>
                <p><strong>Organization:</strong> \${data.member.org_name}</p>
              0</div>
            \`;
          } else {
            playSound('error');
            resultEl.innerHTML = \`
              <div class="alert alert-danger">
                <h4>UNREGISTERED OR INVALID QR CODE</h4>
                <p>\${data.error}</p>
              </div>
            \`;
          }
        } catch (err) {
          playSound('error');
          document.getElementById('scanResult').innerHTML = \`<div class="alert alert-danger">Scan verification network error.</div>\`;
        }

        setTimeout(() => {
          html5QrCode.resume();
        }, 2500);
      }

      const html5QrCode = new Html5Qrcode("reader");
      html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess)
        .catch(err => {
          document.getElementById('reader').innerHTML = '<div class="alert alert-warning">Camera access not available or blocked. Please allow camera permissions.</div>';
        });
    </script>
  `, req.session.user));
});

// API Scan Endpoint
app.post('/api/scan', requireAuth(), async (req, res) => {
  const { qr_token, attendance_type } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate QR Token & Member
    const memberRes = await client.query(`
      SELECT m.*, o.name as org_name, o.active as org_active 
      FROM members m 
      JOIN organizations o ON m.organization_id = o.id 
      WHERE m.qr_token = $1
    `, [qr_token]);

    if (memberRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'QR Code Not Registered' });
    }

    const member = memberRes.rows;
    if (!member.active || member.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Member Account Is Inactive or Deleted' });
    }
    if (!member.org_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Organization Is Inactive' });
    }

    const today = new Date().toISOString().split('T')[0];

    if (attendance_type === 'TIME_IN') {
      // Check if already timed in today
      const existing = await client.query('SELECT * FROM attendance WHERE member_id = $1 AND attendance_date = $2', [member.id, today]);
      if (existing.rows.length > 0 && existing.rows.time_in) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Duplicate Scan: Already Timed In Today' });
      }

      await client.query(`
        INSERT INTO attendance (member_id, organization_id, attendance_date, time_in, scanner_user_id, status, attendance_type)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, 'PRESENT', 'TIME_IN')
      `, [member.id, member.organization_id, today, req.session.user.id]);

    } else {
      // TIME OUT
      const existing = await client.query('SELECT * FROM attendance WHERE member_id = $1 AND attendance_date = $2', [member.id, today]);
      if (existing.rows.length === 0 || !existing.rows.time_in) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot Time Out without a prior Time In record.' });
      }
      if (existing.rows.time_out) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Duplicate Scan: Already Timed Out Today' });
      }

      await client.query('UPDATE attendance SET time_out = CURRENT_TIMESTAMP WHERE id = $1', [existing.rows.id]);
    }

    await client.query('COMMIT');
    res.json({ success: true, member });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
