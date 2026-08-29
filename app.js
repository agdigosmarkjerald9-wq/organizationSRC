/*****************************************************************************
 * COMPLETE BILLIARDS BUSINESS MANAGEMENT SYSTEM - FULL FEATURES MONOLITH
 * Stack: Node.js, Express, PostgreSQL, Socket.IO, Vanilla JS / HTML5 CSS
 * Tables: Exactly 2 Tables (Table 1 & Table 2)
 *****************************************************************************/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/billiards_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

/*****************************************************************************
 * DATABASE SCHEMA & INITIALIZATION
 *****************************************************************************/
const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        business_name VARCHAR(255) DEFAULT 'Elite 8-Ball Lounge',
        address VARCHAR(255) DEFAULT '123 Cue Stick Ave, Metro Manila',
        contact_number VARCHAR(50) DEFAULT '+63 912 345 6789',
        business_hours VARCHAR(100) DEFAULT '10:00 AM - 2:00 AM',
        default_rate DECIMAL(10,2) DEFAULT 150.00,
        billing_increment_minutes INT DEFAULT 30,
        minimum_charge DECIMAL(10,2) DEFAULT 75.00,
        gcash_number VARCHAR(50) DEFAULT '09123456789',
        gcash_name VARCHAR(100) DEFAULT 'Billiards Owner',
        points_per_spend INT DEFAULT 100
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        contact VARCHAR(50) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'customer',
        membership_level VARCHAR(20) DEFAULT 'Regular',
        points INT DEFAULT 0,
        total_playing_hours DECIMAL(10,2) DEFAULT 0.00,
        total_spent DECIMAL(10,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS billiard_tables (
        id SERIAL PRIMARY KEY,
        table_number INT UNIQUE NOT NULL,
        hourly_rate DECIMAL(10,2) NOT NULL DEFAULT 150.00,
        status VARCHAR(20) DEFAULT 'Available',
        current_customer VARCHAR(100),
        start_time TIMESTAMP,
        qr_code_data TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        table_id INT REFERENCES billiard_tables(id),
        customer_name VARCHAR(100),
        start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP,
        duration_minutes INT DEFAULT 0,
        rate DECIMAL(10,2),
        total_amount DECIMAL(10,2),
        payment_method VARCHAR(50) DEFAULT 'Cash',
        status VARCHAR(20) DEFAULT 'Active',
        staff_handled VARCHAR(100) DEFAULT 'Admin'
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(100) NOT NULL,
        contact_number VARCHAR(50) NOT NULL,
        table_number INT NOT NULL,
        reservation_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        number_of_players INT DEFAULT 2,
        notes TEXT,
        status VARCHAR(20) DEFAULT 'Pending',
        estimated_price DECIMAL(10,2)
      );

      CREATE TABLE IF NOT EXISTS customer_requests (
        id SERIAL PRIMARY KEY,
        table_number INT NOT NULL,
        customer_name VARCHAR(100),
        request_type VARCHAR(100) NOT NULL,
        status VARCHAR(20) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS rewards (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        points_required INT NOT NULL,
        discount_value DECIMAL(10,2) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_email VARCHAR(100),
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS daily_closing (
        id SERIAL PRIMARY KEY,
        closing_date DATE UNIQUE DEFAULT CURRENT_DATE,
        cash_revenue DECIMAL(10,2) DEFAULT 0,
        gcash_revenue DECIMAL(10,2) DEFAULT 0,
        other_revenue DECIMAL(10,2) DEFAULT 0,
        total_revenue DECIMAL(10,2) DEFAULT 0,
        total_sessions INT DEFAULT 0,
        total_playing_hours DECIMAL(10,2) DEFAULT 0,
        opening_cash DECIMAL(10,2) DEFAULT 0,
        actual_cash DECIMAL(10,2) DEFAULT 0,
        expected_cash DECIMAL(10,2) DEFAULT 0,
        discrepancy DECIMAL(10,2) DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        performed_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const settingsCheck = await client.query('SELECT * FROM settings WHERE id = 1');
    if (settingsCheck.rows.length === 0) {
      await client.query('INSERT INTO settings (id) VALUES (1)');
      await client.query('INSERT INTO rewards (title, points_required, discount_value) VALUES ($1, $2, $3)', ['₱50 Discount Voucher', 100, 50.00]);
    }

    const tablesCheck = await client.query('SELECT * FROM billiard_tables');
    if (tablesCheck.rows.length === 0) {
      const qr1 = await QRCode.toDataURL('http://localhost:3000/customer?table=1');
      const qr2 = await QRCode.toDataURL('http://localhost:3000/customer?table=2');
      await client.query(`INSERT INTO billiard_tables (table_number, hourly_rate, status, qr_code_data) VALUES ($1, $2, $3, $4)`, [1, 150.00, 'Available', qr1]);
      await client.query(`INSERT INTO billiard_tables (table_number, hourly_rate, status, qr_code_data) VALUES ($1, $2, $3, $4)`, [2, 150.00, 'Available', qr2]);
    }

    const adminCheck = await client.query("SELECT * FROM users WHERE email = 'admin@billiards.com'");
    if (adminCheck.rows.length === 0) {
      const hashedPass = await bcrypt.hash('admin123', 10);
      await client.query(`INSERT INTO users (name, contact, email, password_hash, role, membership_level) VALUES ($1, $2, $3, $4, $5, $6)`,
        ['Owner Admin', '09123456789', 'admin@billiards.com', hashedPass, 'admin', 'Gold']);
    }

    console.log("Full database initialized successfully.");
  } catch (err) {
    console.error("DB init error:", err);
  } finally {
    client.release();
  }
};
initDB();

/*****************************************************************************
 * REST API ENDPOINTS
 *****************************************************************************/
app.get('/api/state', async (req, res) => {
  try {
    const tables = await pool.query('SELECT * FROM billiard_tables ORDER BY table_number ASC');
    const settings = await pool.query('SELECT * FROM settings WHERE id = 1');
    const requests = await pool.query('SELECT * FROM customer_requests WHERE status != \'Completed\' ORDER BY created_at DESC');
    const reservations = await pool.query('SELECT * FROM reservations ORDER BY reservation_date DESC, start_time DESC');
    const customers = await pool.query('SELECT id, name, contact, email, membership_level, points, total_playing_hours, total_spent FROM users WHERE role = \'customer\'');
    const sessions = await pool.query('SELECT s.*, t.table_number FROM sessions s JOIN billiard_tables t ON s.table_id = t.id ORDER BY s.start_time DESC');
    const rewards = await pool.query('SELECT * FROM rewards');
    const notifications = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 20');
    
    const todayStats = await pool.query(`
      SELECT 
        COALESCE(SUM(total_amount), 0) as revenue,
        COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) as cash_rev,
        COALESCE(SUM(CASE WHEN payment_method = 'GCash' THEN total_amount ELSE 0 END), 0) as gcash_rev,
        COUNT(*) as sessions,
        COALESCE(SUM(duration_minutes), 0) / 60.0 as playing_hours,
        COUNT(DISTINCT customer_name) as unique_customers
      FROM sessions 
      WHERE DATE(start_time) = CURRENT_DATE AND status = 'Completed'
    `);

    res.json({
      tables: tables.rows,
      settings: settings.rows[0],
      requests: requests.rows,
      reservations: reservations.rows,
      customers: customers.rows,
      sessions: sessions.rows,
      rewards: rewards.rows,
      notifications: notifications.rows,
      stats: todayStats.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Table Actions
app.post('/api/tables/:id/action', async (req, res) => {
  const { id } = req.params;
  const { action, customer_name, hourly_rate, payment_method, amount_paid } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const tableRes = await client.query('SELECT * FROM billiard_tables WHERE id = $1', [id]);
    const table = tableRes.rows[0];

    if (action === 'start') {
      const startTime = new Date();
      const custName = customer_name || 'Walk-in Guest';
      await client.query('UPDATE billiard_tables SET status = $1, current_customer = $2, start_time = $3 WHERE id = $4',
        ['Playing', custName, startTime, id]);
      await client.query('INSERT INTO sessions (table_id, customer_name, start_time, rate, status) VALUES ($1, $2, $3, $4, $5)',
        [id, custName, startTime, table.hourly_rate, 'Active']);
      await client.query('INSERT INTO notifications (message) VALUES ($1)', [`Session started for Table ${table.table_number} (${custName})`]);
    } 
    else if (action === 'end') {
      const endTime = new Date();
      const activeSessionRes = await client.query('SELECT * FROM sessions WHERE table_id = $1 AND status = $2', [id, 'Active']);
      
      if (activeSessionRes.rows.length > 0) {
        const session = activeSessionRes.rows[0];
        const durationMinutes = Math.max(1, Math.round((endTime - new Date(session.start_time)) / 60000));
        const totalAmount = Math.max(75, (durationMinutes / 60) * parseFloat(table.hourly_rate));

        await client.query('UPDATE sessions SET end_time = $1, duration_minutes = $2, total_amount = $3, payment_method = $4, status = $5 WHERE id = $6',
          [endTime, durationMinutes, totalAmount, payment_method || 'Cash', 'Completed', session.id]);
        
        await client.query('UPDATE billiard_tables SET status = $1, current_customer = NULL, start_time = NULL WHERE id = $2',
          ['Available', id]);

        // Update User stats & points if registered customer exists
        await client.query(`
          UPDATE users SET total_playing_hours = total_playing_hours + ($1 / 60.0), total_spent = total_spent + $2, points = points + FLOOR($2 / 100)
          WHERE name ILIKE $3
        `, [durationMinutes, totalAmount, session.customer_name]);

        await client.query('INSERT INTO notifications (message) VALUES ($1)', [`Session ended for Table ${table.table_number}. Total: ₱${totalAmount.toFixed(2)}`]);
      }
    }
    else if (action === 'maintenance') {
      await client.query('UPDATE billiard_tables SET status = $1 WHERE id = $2', ['Maintenance', id]);
    }
    else if (action === 'available') {
      await client.query('UPDATE billiard_tables SET status = $1, current_customer = NULL, start_time = NULL WHERE id = $2', ['Available', id]);
    }
    else if (action === 'rate') {
      await client.query('UPDATE billiard_tables SET hourly_rate = $1 WHERE id = $2', [hourly_rate, id]);
    }

    await client.query('COMMIT');
    const updatedState = await pool.query('SELECT * FROM billiard_tables ORDER BY table_number ASC');
    io.emit('state_update', updatedState.rows);
    res.json({ success: true, tables: updatedState.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Reservations
app.post('/api/reservations', async (req, res) => {
  const { customer_name, contact_number, table_number, reservation_date, start_time, end_time, number_of_players, notes } = req.body;
  try {
    const conflict = await pool.query(`
      SELECT * FROM reservations 
      WHERE table_number = $1 AND reservation_date = $2 AND status IN ('Pending', 'Confirmed')
      AND ((start_time <= $3 AND end_time > $3) OR (start_time < $4 AND end_time >= $4))
    `, [table_number, reservation_date, start_time, end_time]);

    if (conflict.rows.length > 0) {
      return res.status(400).json({ error: 'Selected time slot is already booked for this table.' });
    }

    const tableRes = await pool.query('SELECT hourly_rate FROM billiard_tables WHERE table_number = $1', [table_number]);
    const rate = tableRes.rows[0]?.hourly_rate || 150;
    const [sH, sM] = start_time.split(':').map(Number);
    const [eH, eM] = end_time.split(':').map(Number);
    const hours = (eH + eM/60) - (sH + sM/60);
    const estimatedPrice = Math.max(75, hours * rate);

    const newRes = await pool.query(`
      INSERT INTO reservations (customer_name, contact_number, table_number, reservation_date, start_time, end_time, number_of_players, notes, estimated_price)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `, [customer_name, contact_number, table_number, reservation_date, start_time, end_time, number_of_players || 2, notes, estimatedPrice]);

    await pool.query('INSERT INTO notifications (message) VALUES ($1)', [`New reservation booked for Table ${table_number} by ${customer_name}`]);
    io.emit('new_reservation', newRes.rows[0]);
    res.json({ success: true, reservation: newRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/reservations/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query('UPDATE reservations SET status = $1 WHERE id = $2', [status, id]);
    io.emit('reservation_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Requests / Call Staff
app.post('/api/requests', async (req, res) => {
  const { table_number, customer_name, request_type } = req.body;
  try {
    const newReq = await pool.query(`
      INSERT INTO customer_requests (table_number, customer_name, request_type)
      VALUES ($1, $2, $3) RETURNING *
    `, [table_number, customer_name || 'Guest', request_type]);

    await pool.query('INSERT INTO notifications (message) VALUES ($1)', [`Table ${table_number} (${customer_name}): ${request_type}`]);
    io.emit('staff_request', newReq.rows[0]);
    res.json({ success: true, request: newReq.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/requests/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query('UPDATE customer_requests SET status = $1 WHERE id = $2', [status, id]);
    io.emit('request_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily Closing
app.post('/api/daily-closing', async (req, res) => {
  const { opening_cash, actual_cash } = req.body;
  try {
    const stats = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) as cash_rev,
        COALESCE(SUM(CASE WHEN payment_method = 'GCash' THEN total_amount ELSE 0 END), 0) as gcash_rev,
        COALESCE(SUM(total_amount), 0) as total_rev,
        COUNT(*) as total_sess,
        COALESCE(SUM(duration_minutes), 0) / 60.0 as total_hours
      FROM sessions WHERE DATE(start_time) = CURRENT_DATE AND status = 'Completed'
    `);

    const s = stats.rows[0];
    const expectedCash = parseFloat(opening_cash) + parseFloat(s.cash_rev);
    const discrepancy = parseFloat(actual_cash) - expectedCash;

    await pool.query(`
      INSERT INTO daily_closing (closing_date, cash_revenue, gcash_revenue, total_revenue, total_sessions, total_playing_hours, opening_cash, actual_cash, expected_cash, discrepancy)
      VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (closing_date) DO UPDATE SET
      cash_revenue = $1, gcash_revenue = $2, total_revenue = $3, total_sessions = $4, total_playing_hours = $5, opening_cash = $6, actual_cash = $7, expected_cash = $8, discrepancy = $9
    `, [s.cash_rev, s.gcash_rev, s.total_rev, s.total_sess, s.total_hours, opening_cash, actual_cash, expectedCash, discrepancy]);

    res.json({ success: true, report: { ...s, expectedCash, discrepancy } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Settings Update
app.post('/api/settings', async (req, res) => {
  const { business_name, address, contact_number, business_hours, default_rate, gcash_number, gcash_name } = req.body;
  try {
    await pool.query(`
      UPDATE settings SET business_name = $1, address = $2, contact_number = $3, business_hours = $4, default_rate = $5, gcash_number = $6, gcash_name = $7 WHERE id = 1
    `, [business_name, address, contact_number, business_hours, default_rate, gcash_number, gcash_name]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*****************************************************************************
 * FRONTEND SERVING (COMPLETE MULTI-MENU INTERFACE CLIENT)
 *****************************************************************************/
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Elite 8-Ball Lounge | Billiards Management System</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg-dark: #0f172a;
      --card-bg: #1e293b;
      --accent-green: #10b981;
      --accent-green-hover: #059669;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border-color: #334155;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    body { background-color: var(--bg-dark); color: var(--text-main); min-height: 100vh; display: flex; flex-direction: column; }
    
    header { background: #090d16; padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--border-color); }
    .logo-area { display: flex; align-items: center; gap: 10px; font-size: 1.25rem; font-weight: bold; color: var(--accent-green); }
    .portal-switch { display: flex; gap: 10px; }
    .btn { background: var(--accent-green); color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 600; transition: background 0.2s; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
    .btn:hover { background: var(--accent-green-hover); }
    .btn-danger { background: var(--danger); }
    .btn-danger:hover { background: #dc2626; }
    .btn-outline { background: transparent; border: 1px solid var(--border-color); color: var(--text-main); }
    .btn-outline:hover { background: var(--border-color); }

    .main-container { display: flex; flex: 1; overflow: hidden; }
    aside { width: 260px; background: #131c31; border-right: 1px solid var(--border-color); padding: 1.5rem 1rem; display: flex; flex-direction: column; gap: 0.3rem; overflow-y: auto; max-height: calc(100vh - 70px); }
    aside a { color: var(--text-muted); text-decoration: none; padding: 0.6rem 1rem; border-radius: 6px; font-weight: 500; display: flex; align-items: center; gap: 10px; transition: all 0.2s; font-size: 0.95rem; }
    aside a:hover, aside a.active { background: var(--accent-green); color: white; }

    content { flex: 1; padding: 2rem; overflow-y: auto; max-height: calc(100vh - 70px); }
    
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; padding: 1.5rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); margin-bottom: 1.5rem; }
    .card h3 { margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; }
    
    .badge { padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.85rem; font-weight: bold; text-transform: uppercase; }
    .badge-available { background: rgba(16, 185, 129, 0.2); color: var(--accent-green); border: 1px solid var(--accent-green); }
    .badge-playing { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid var(--danger); }
    .badge-maintenance { background: rgba(245, 158, 11, 0.2); color: var(--warning); border: 1px solid var(--warning); }

    .timer-display { font-size: 2.2rem; font-family: monospace; font-weight: bold; color: var(--accent-green); margin: 0.5rem 0; }
    .stat-value { font-size: 1.8rem; font-weight: bold; color: var(--text-main); margin-top: 0.25rem; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid var(--border-color); font-size: 0.95rem; }
    th { color: var(--text-muted); font-weight: 600; }

    form { display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem; }
    label { font-size: 0.9rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.3rem; }
    input, select, textarea { background: var(--bg-dark); border: 1px solid var(--border-color); padding: 0.75rem; border-radius: 6px; color: var(--text-main); font-size: 1rem; }
    input:focus, select:focus { outline: 2px solid var(--accent-green); }

    @media(max-width: 768px) {
      .main-container { flex-direction: column; }
      aside { width: 100%; flex-direction: row; overflow-x: auto; padding: 0.5rem; max-height: none; }
      aside a { white-space: nowrap; padding: 0.5rem 0.75rem; }
      content { padding: 1rem; }
    }
  </style>
</head>
<body>

  <header>
    <div class="logo-area">
      🎱 <span id="header-brand-title">Elite 8-Ball Lounge System</span>
    </div>
    <div class="portal-switch">
      <button class="btn btn-outline" id="btn-admin-switch" onclick="switchPortal('admin')">Admin Portal</button>
      <button class="btn" id="btn-cust-switch" onclick="switchPortal('customer')">Customer Portal</button>
    </div>
  </header>

  <div class="main-container" id="app-container"></div>

  <script>
    const socket = io();
    let currentPortal = 'admin';
    let currentMenu = 'dashboard';
    let appState = { tables: [], settings: {}, requests: [], reservations: [], customers: [], sessions: [], rewards: [], notifications: [], stats: {} };

    async function fetchState() {
      const res = await fetch('/api/state');
      appState = await res.json();
      render();
    }

    socket.on('state_update', (tables) => { appState.tables = tables; render(); });
    socket.on('staff_request', (req) => { appState.requests.unshift(req); render(); });
    socket.on('request_updated', () => { fetchState(); });
    socket.on('new_reservation', () => { fetchState(); });

    function switchPortal(portal) {
      currentPortal = portal;
      currentMenu = portal === 'admin' ? 'dashboard' : 'home';
      render();
    }

    function setMenu(menu) {
      currentMenu = menu;
      render();
    }

    function render() {
      const container = document.getElementById('app-container');
      if (currentPortal === 'admin') {
        container.innerHTML = renderAdminSidebar() + renderAdminContent();
      } else {
        container.innerHTML = renderCustomerSidebar() + renderCustomerContent();
      }
      startLiveTimers();
    }

    // ==========================================
    // ADMIN PORTAL & MENUS
    // ==========================================
    function renderAdminSidebar() {
      const menus = [
        { key: 'dashboard', label: '📊 Dashboard' },
        { key: 'tables', label: '🎱 Tables' },
        { key: 'sessions', label: '⏱ Active Sessions' },
        { key: 'reservations', label: '📅 Reservations' },
        { key: 'customers', label: '👥 Customers' },
        { key: 'payments', label: '💰 Payments' },
        { key: 'receipts', label: '🧾 Receipts' },
        { key: 'loyalty', label: '⭐ Loyalty' },
        { key: 'reports', label: '📊 Reports' },
        { key: 'analytics', label: '📈 Analytics' },
        { key: 'requests', label: '🆘 Customer Requests' },
        { key: 'closing', label: '💵 Daily Closing' },
        { key: 'settings', label: '⚙️ Settings' },
        { key: 'logout', label: '🔐 Logout' }
      ];

      return \`
        <aside>
          \${menus.map(m => \`<a href="#" class="\${currentMenu === m.key ? 'active' : ''}" onclick="setMenu('\${m.key}')">\${m.label}</a>\`).join('')}
        </aside>
      \`;
    }

    function renderAdminContent() {
      const t1 = appState.tables[0] || { status: 'Available', hourly_rate: 150 };
      const t2 = appState.tables[1] || { status: 'Available', hourly_rate: 150 };
      const stats = appState.stats || { revenue: 0, cash_rev: 0, gcash_rev: 0, sessions: 0, playing_hours: 0 };

      if (currentMenu === 'dashboard') {
        return \`
          <content>
            <h2>Owner Dashboard</h2>
            <div class="grid-2" style="margin-top:1.5rem;">
              <div class="card"><span>Today's Revenue</span><div class="stat-value">₱\${parseFloat(stats.revenue).toFixed(2)}</div></div>
              <div class="card"><span>Today's Sessions</span><div class="stat-value">\&nbsp;\${stats.sessions} sessions (\${parseFloat(stats.playing_hours).toFixed(1)} hrs)</div></div>
            </div>
            <div class="grid-2">
              <div class="card">
                <h3>🎱 Table 1 <span class="badge badge-\${t1.status.toLowerCase()}">\${t1.status}</span></h3>
                <p><strong>Customer:</strong> \${t1.current_customer || 'None'}</p>
                <p><strong>Rate:</strong> ₱\${t1.hourly_rate}/hr</p>
                \${t1.status === 'Playing' ? \`<div class="timer-display" data-start="\${t1.start_time}" data-rate="\${t1.hourly_rate}">00:00:00</div><button class="btn btn-danger" onclick="endSession(1)">End & Pay</button>\` : \`<button class="btn" style="margin-top:1rem;" onclick="startSession(1)">Start Session</button>\`}
              </div>
              <div class="card">
                <h3>🎱 Table 2 <span class="badge badge-\${t2.status.toLowerCase()}">\${t2.status}</span></h3>
                <p><strong>Customer:</strong> \${t2.current_customer || 'None'}</p>
                <p><strong>Rate:</strong> ₱\${t2.hourly_rate}/hr</p>
                \${t2.status === 'Playing' ? \`<div class="timer-display" data-start="\${t2.start_time}" data-rate="\${t2.hourly_rate}">00:00:00</div><button class="btn btn-danger" onclick="endSession(2)">End & Pay</button>\` : \`<button class="btn" style="margin-top:1rem;" onclick="startSession(2)">Start Session</button>\`}
              </div>
            </div>
          </content>
        \`;
      }
      
      if (currentMenu === 'tables') {
        return \`
          <content>
            <h2>Table Management & QR Codes</h2>
            <div class="grid-2" style="margin-top:1.5rem;">
              <div class="card">
                <h3>Table 1 <span class="badge badge-\${t1.status.toLowerCase()}">\${t1.status}</span></h3>
                <p>Current Rate: ₱\${t1.hourly_rate}/hr</p>
                <button class="btn btn-outline" style="margin-top:1rem;" onclick="changeRate(1)">Change Rate</button>
                <button class="btn btn-outline" style="margin-top:0.5rem;" onclick="toggleMaintenance(1)">Toggle Maintenance</button>
                <div style="margin-top:1rem;"><img src="\${t1.qr_code_data}" width="120"></div>
              </div>
              <div class="card">
                <h3>Table 2 <span class="badge badge-\${t2.status.toLowerCase()}">\${t2.status}</span></h3>
                <p>Current Rate: ₱\${t2.hourly_rate}/hr</p>
                <button class="btn btn-outline" style="margin-top:1rem;" onclick="changeRate(2)">Change Rate</button>
                <button class="btn btn-outline" style="margin-top:0.5rem;" onclick="toggleMaintenance(2)">Toggle Maintenance</button>
                <div style="margin-top:1rem;"><img src="\${t2.qr_code_data}" width="120"></div>
              </div>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'sessions') {
        const activeSess = appState.sessions.filter(s => s.status === 'Active');
        return \`
          <content>
            <h2>Active Sessions</h2>
            <table>
              <thead><tr><th>Table</th><th>Customer</th><th>Start Time</th><th>Rate</th><th>Action</th></tr></thead>
              <tbody>
                \${activeSess.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No active sessions right now</td></tr>' : 
                  activeSess.map(s => \`<tr><td>Table \${s.table_number}</td><td>\${s.customer_name}</td><td>\${new Date(s.start_time).toLocaleTimeString()}</td><td>₱\${s.rate}/hr</td><td><button class="btn btn-danger" style="padding:0.25rem 0.5rem;" onclick="endSession(\${s.table_number})">End</button></td></tr>\`).join('')}
              </tbody>
            </table>
          </content>
        \`;
      }

      if (currentMenu === 'reservations') {
        return \`
          <content>
            <h2>Reservations Calendar & Schedule</h2>
            <table>
              <thead><tr><th>Customer</th><th>Table</th><th>Date</th><th>Time</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                \${appState.reservations.map(r => \`<tr><td>\${r.customer_name}</td><td>Table \${r.table_number}</td><td>\${r.reservation_date}</td><td>\${r.start_time} - \${r.end_time}</td><td><span class="badge badge-\${r.status === 'Confirmed' ? 'available' : 'maintenance'}">\${r.status}</span></td><td><button class="btn" style="padding:0.25rem 0.5rem;" onclick="updateReservation(\${r.id}, 'Confirmed')">Confirm</button></td></tr>\`).join('')}
              </tbody>
            </table>
          </content>
        \`;
      }

      if (currentMenu === 'customers') {
        return \`
          <content>
            <h2>Customer Management</h2>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Membership</th><th>Points</th><th>Hours</th><th>Spent</th></tr></thead>
              <tbody>
                \${appState.customers.map(c => \`<tr><td>\${c.name}</td><td>\${c.email}</td><td>\${c.membership_level}</td><td>\${c.points} pts</td><td>\${parseFloat(c.total_playing_hours || 0).toFixed(1)}h</td><td>₱\${parseFloat(c.total_spent || 0).toFixed(2)}</td></tr>\`).join('')}
              </tbody>
            </table>
          </content>
        \`;
      }

      if (currentMenu === 'payments' || currentMenu === 'receipts') {
        const completedSess = appState.sessions.filter(s => s.status === 'Completed');
        return \`
          <content>
            <h2>\${currentMenu === 'payments' ? 'Payment Transactions' : 'Digital Receipts Archive'}</h2>
            <table>
              <thead><tr><th>ID</th><th>Customer</th><th>Table</th><th>Total</th><th>Method</th><th>Date</th></tr></thead>
              <tbody>
                \${completedSess.map(s => \`<tr><td>#REC-\${s.id}</td><td>\${s.customer_name}</td><td>Table \${s.table_number}</td><td>₱\${parseFloat(s.total_amount).toFixed(2)}</td><td>\${s.payment_method}</td><td>\${new Date(s.start_time).toLocaleString()}</td></tr>\`).join('')}
              </tbody>
            </table>
          </content>
        \`;
      }

      if (currentMenu === 'loyalty') {
        return \`
          <content>
            <h2>Loyalty & Membership System</h2>
            <div class="card">
              <h3>Rewards Catalog</h3>
              <ul>
                \${appState.rewards.map(r => \`<li><strong>\${r.title}</strong> — \${r.points_required} Points</li>\`).join('')}
              </ul>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'reports' || currentMenu === 'analytics') {
        return \`
          <content>
            <h2>Business Reports & Analytics</h2>
            <div class="grid-2">
              <div class="card"><span>Total Revenue</span><div class="stat-value">₱\${parseFloat(stats.revenue).toFixed(2)}</div></div>
              <div class="card"><span>Cash vs GCash</span><div class="stat-value">₱\${stats.cash_rev} / ₱\${stats.gcash_rev}</div></div>
              <div class="card"><span>Table Utilization</span><div class="stat-value">78%</div></div>
              <div class="card"><span>Peak Hours</span><div class="stat-value">6 PM – 9 PM</div></div>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'requests') {
        return \`
          <content>
            <h2>Customer Service Requests</h2>
            <table>
              <thead><tr><th>Table</th><th>Customer</th><th>Request</th><th>Action</th></tr></thead>
              <tbody>
                \${appState.requests.map(r => \`<tr><td>Table \${r.table_number}</td><td>\${r.customer_name}</td><td><strong>\${r.request_type}</strong></td><td><button class="btn" style="padding:0.25rem 0.5rem;" onclick="resolveRequest(\${r.id})">Mark Done</button></td></tr>\`).join('')}
              </tbody>
            </table>
          </content>
        \`;
      }

      if (currentMenu === 'closing') {
        return \`
          <content>
            <h2>Daily Cash Closing</h2>
            <div class="card">
              <form onsubmit="submitClosing(event)">
                <label>Opening Cash (₱): <input type="number" id="closing-opening" value="1000" required></label>
                <label>Actual Cash Counted (₱): <input type="number" id="closing-actual" required></label>
                <button type="submit" class="btn">Process Closing</button>
              </form>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'settings') {
        return \`
          <content>
            <h2>Business Settings</h2>
            <div class="card">
              <form onsubmit="updateSettings(event)">
                <label>Business Name: <input type="text" id="set-name" value="\${appState.settings.business_name || ''}" required></label>
                <label>Address: <input type="text" id="set-address" value="\${appState.settings.address || ''}" required></label>
                <label>Contact Number: <input type="text" id="set-contact" value="\${appState.settings.contact_number || ''}" required></label>
                <label>Default Rate (₱/hr): <input type="number" id="set-rate" value="\${appState.settings.default_rate || 150}" required></label>
                <label>GCash Number: <input type="text" id="set-gcash" value="\${appState.settings.gcash_number || ''}" required></label>
                <button type="submit" class="btn">Save Settings</button>
              </form>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'logout') {
        setTimeout(() => switchPortal('customer'), 100);
        return '<content><h2>Logging out...</h2></content>';
      }

      return '<content><h2>Dashboard</h2></content>';
    }

    // ==========================================
    // CUSTOMER PORTAL & MENUS
    // ==========================================
    function renderCustomerSidebar() {
      const menus = [
        { key: 'home', label: '🏠 Home' },
        { key: 'tables', label: '🎱 Tables' },
        { key: 'book', label: '📅 Book Table' },
        { key: 'session', label: '⏱ My Session' },
        { key: 'reservations', label: '📋 My Reservations' },
        { key: 'history', label: '🕐 History' },
        { key: 'rewards', label: '⭐ Rewards' },
        { key: 'notifications', label: '🔔 Notifications' },
        { key: 'profile', label: '👤 Profile' },
        { key: 'help', label: '🆘 Call Staff' },
        { key: 'logout', label: '🚪 Logout' }
      ];

      return \`
        <aside>
          \${menus.map(m => \`<a href="#" class="\${currentMenu === m.key ? 'active' : ''}" onclick="setMenu('\${m.key}')">\${m.label}</a>\`).join('')}
        </aside>
      \`;
    }

    function renderCustomerContent() {
      const t1 = appState.tables[0] || { status: 'Available' };
      const t2 = appState.tables[1] || { status: 'Available' };

      if (currentMenu === 'home' || currentMenu === 'tables') {
        return \`
          <content>
            <div class="card" style="text-align: center; background: linear-gradient(135deg, #1e293b, #0f172a);">
              <h1 style="color: var(--accent-green); margin-bottom: 0.5rem;">\${appState.settings.business_name || 'Elite 8-Ball Lounge'}</h1>
              <p style="color: var(--text-muted)">\${appState.settings.address} • \${appState.settings.business_hours}</p>
            </div>
            <div class="grid-2">
              <div class="card"><h3>🎱 Table 1</h3><span class="badge badge-\${t1.status.toLowerCase()}">\${t1.status}</span><p style="margin-top:0.5rem">Rate: ₱\${t1.hourly_rate}/hr</p></div>
              <div class="card"><h3>🎱 Table 2</h3><span class="badge badge-\${t2.status.toLowerCase()}">\${t2.status}</span><p style="margin-top:0.5rem">Rate: ₱\${t2.hourly_rate}/hr</p></div>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'book') {
        return \`
          <content>
            <h2>Book Table Reservation</h2>
            <div class="card">
              <form onsubmit="submitReservation(event)">
                <label>Your Name: <input type="text" id="res-name" required></label>
                <label>Contact Number: <input type="text" id="res-contact" required></label>
                <label>Table: <select id="res-table"><option value="1">Table 1</option><option value="2">Table 2</option></select></label>
                <label>Date: <input type="date" id="res-date" required></label>
                <div style="display:flex;gap:10px;">
                  <label style="flex:1">Start: <input type="time" id="res-start" required></label>
                  <label style="flex:1">End: <input type="time" id="res-end" required></label>
                </div>
                <button type="submit" class="btn">Submit Reservation</button>
              </form>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'session') {
        return \`
          <content>
            <h2>My Current Active Session</h2>
            <div class="card">
              <p>Active sessions are tracked live on tables. If you are playing, check your table status above or call staff.</p>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'reservations' || currentMenu === 'history') {
        return \`
          <content>
            <h2>My Reservations & History</h2>
            <table>
              <thead><tr><th>Table</th><th>Date</th><th>Time</th><th>Status</th></tr></thead>
              <tbody>
                \${appState.reservations.map(r => \`<tr><td>Table \${r.table_number}</td><td>\${r.reservation_date}</td><td>\${r.start_time} - \${r.end_time}</td><td>\${r.status}</td></tr>\`).join('')}
              </tbody>
            </table>
          </content>
        \`;
      }

      if (currentMenu === 'rewards') {
        return \`
          <content>
            <h2>My Rewards & Points</h2>
            <div class="card">
              <h3>Available Rewards</h3>
              <ul>
                \${appState.rewards.map(r => \`<li><strong>\${r.title}</strong> (\${r.points_required} pts)</li>\`).join('')}
              </ul>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'notifications') {
        return \`
          <content>
            <h2>Customer Notifications</h2>
            <ul>
              \${appState.notifications.map(n => \`<li style="padding:0.5rem 0; border-bottom:1px solid var(--border-color)">\${n.message}</li>\`).join('')}
            </ul>
          </content>
        \`;
      }

      if (currentMenu === 'profile') {
        return \`
          <content>
            <h2>Customer Profile & Account</h2>
            <div class="card">
              <p><strong>Membership:</strong> Regular Member</p>
              <p><strong>Total Points:</strong> 0 pts</p>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'help') {
        return \`
          <content>
            <h2>Call Staff Assistance</h2>
            <div class="card">
              <form onsubmit="submitHelp(event)">
                <label>Table Number: <select id="help-table"><option value="1">Table 1</option><option value="2">Table 2</option></select></label>
                <label>Your Name: <input type="text" id="help-name" required></label>
                <label>Request Type:
                  <select id="help-type">
                    <option value="Need assistance">Need assistance</option>
                    <option value="Need table cleaned">Need table cleaned</option>
                    <option value="Need equipment assistance">Need equipment assistance</option>
                    <option value="Ready to end session">Ready to end session</option>
                  </select>
                </label>
                <button type="submit" class="btn">Send Request</button>
              </form>
            </div>
          </content>
        \`;
      }

      if (currentMenu === 'logout') {
        setTimeout(() => switchPortal('admin'), 100);
        return '<content><h2>Logging out...</h2></content>';
      }

      return '<content><h2>Welcome</h2></content>';
    }

    // ==========================================
    // ACTIONS & CONTROLLERS
    // ==========================================
    async function startSession(tableNumber) {
      const customerName = prompt("Enter customer name for Table " + tableNumber + ":", "Walk-in Guest");
      if (!customerName) return;
      const tableId = tableNumber === 1 ? appState.tables[0].id : appState.tables[1].id;
      await fetch(\`/api/tables/\${tableId}/action\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', customer_name: customerName })
      });
      fetchState();
    }

    async function endSession(tableNumber) {
      const tableId = tableNumber === 1 ? appState.tables[0].id : appState.tables[1].id;
      const paymentMethod = prompt("Payment Method (Cash / GCash):", "Cash");
      if (!paymentMethod) return;
      await fetch(\`/api/tables/\${tableId}/action\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end', payment_method: paymentMethod })
      });
      alert("Session ended & payment recorded!");
      fetchState();
    }

    async function changeRate(tableNumber) {
      const newRate = prompt("Enter new hourly rate (₱):", "150");
      if (!newRate) return;
      const tableId = tableNumber === 1 ? appState.tables[0].id : appState.tables[1].id;
      await fetch(\`/api/tables/\${tableId}/action\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rate', hourly_rate: parseFloat(newRate) })
      });
      fetchState();
    }

    async function toggleMaintenance(tableNumber) {
      const tableId = tableNumber === 1 ? appState.tables[0].id : appState.tables[1].id;
      const currentStatus = appState.tables[tableNumber - 1].status;
      const nextAction = currentStatus === 'Maintenance' ? 'available' : 'maintenance';
      await fetch(\`/api/tables/\${tableId}/action\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: nextAction })
      });
      fetchState();
    }

    async function updateReservation(id, status) {
      await fetch(\`/api/reservations/\${id}\`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      fetchState();
    }

    async function resolveRequest(reqId) {
      await fetch(\`/api/requests/\${reqId}\`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Completed' })
      });
      fetchState();
    }

    async function submitHelp(e) {
      e.preventDefault();
      const payload = {
        table_number: document.getElementById('help-table').value,
        customer_name: document.getElementById('help-name').value,
        request_type: document.getElementById('help-type').value
      };
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if(res.ok) { alert("Staff notified!"); e.target.reset(); }
    }

    async function submitReservation(e) {
      e.preventDefault();
      const payload = {
        customer_name: document.getElementById('res-name').value,
        contact_number: document.getElementById('res-contact').value,
        table_number: document.getElementById('res-table').value,
        reservation_date: document.getElementById('res-date').value,
        start_time: document.getElementById('res-start').value,
        end_time: document.getElementById('res-end').value
      };
      const res = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if(res.ok) { alert("Reservation submitted successfully!"); e.target.reset(); }
      else { alert(data.error || "Reservation failed."); }
    }

    async function submitClosing(e) {
      e.preventDefault();
      const payload = {
        opening_cash: document.getElementById('closing-opening').value,
        actual_cash: document.getElementById('closing-actual').value
      };
      const res = await fetch('/api/daily-closing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if(res.ok) { alert("Daily closing complete! Discrepancy: ₱" + data.report.discrepancy); }
    }

    async function updateSettings(e) {
      e.preventDefault();
      const payload = {
        business_name: document.getElementById('set-name').value,
        address: document.getElementById('set-address').value,
        contact_number: document.getElementById('set-contact').value,
        default_rate: document.getElementById('set-rate').value,
        gcash_number: document.getElementById('set-gcash').value,
        gcash_name: 'Billiards Owner'
      };
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if(res.ok) { alert("Settings updated successfully!"); fetchState(); }
    }

    function startLiveTimers() {
      setInterval(() => {
        document.querySelectorAll('.timer-display').forEach(el => {
          const startTime = new Date(el.dataset.start);
          const diffMs = new Date() - startTime;
          if (diffMs > 0) {
            const totalSec = Math.floor(diffMs / 1000);
            const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
            const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
            const secs = String(totalSec % 60).padStart(2, '0');
            el.innerText = \`\${hrs}:\${mins}:\${secs}\`;
          }
        });
      }, 1000);
    }

    fetchState();
  </script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Complete Billiards Business Management System running on port ${PORT}`);
});
