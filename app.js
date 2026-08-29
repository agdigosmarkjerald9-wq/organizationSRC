/**
 * TWO-TABLE BILLIARDS BUSINESS MANAGEMENT SYSTEM (SINGLE-FILE VERSION)
 * Run: npm install && node app.js
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const cors = require('cors');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'billiards-secret-key-998877';

// --- DATABASE SETUP ---
const db = new Database('billiards.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT,
    force_password_change INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    phone TEXT,
    password TEXT,
    membership TEXT DEFAULT 'REGULAR',
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS billiard_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    status TEXT DEFAULT 'AVAILABLE', -- AVAILABLE, PLAYING, RESERVED
    rate REAL DEFAULT 100.0,
    current_session_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    table_id INTEGER,
    start_time DATETIME,
    end_time DATETIME,
    rate REAL,
    duration_minutes INTEGER DEFAULT 0,
    amount REAL DEFAULT 0,
    status TEXT DEFAULT 'Active' -- Active, Paused, Completed
  );

  CREATE TABLE IF NOT EXISTS session_pauses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    pause_time DATETIME,
    resume_time DATETIME
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    customer_name TEXT,
    contact_number TEXT,
    table_id INTEGER,
    date TEXT,
    start_time TEXT,
    end_time TEXT,
    num_players INTEGER,
    notes TEXT,
    estimated_cost REAL,
    status TEXT DEFAULT 'Pending' -- Pending, Confirmed, Playing, Completed, Cancelled, No-show
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no TEXT,
    customer_id INTEGER,
    table_id INTEGER,
    total_amount REAL,
    amount_paid REAL,
    change REAL,
    payment_method TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_no TEXT UNIQUE,
    session_id INTEGER,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    message TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER,
    customer_name TEXT,
    request_type TEXT,
    status TEXT DEFAULT 'Pending' -- Pending, Acknowledged, Completed
  );

  CREATE TABLE IF NOT EXISTS loyalty_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    points INTEGER,
    type TEXT, -- Earned, Used
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    points_required INTEGER,
    discount_value REAL,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT UNIQUE,
    discount_pct REAL,
    bonus_points_multiplier REAL
  );

  CREATE TABLE IF NOT EXISTS daily_closing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE,
    opening_cash REAL,
    cash_revenue REAL,
    gcash_revenue REAL,
    other_revenue REAL,
    total_revenue REAL,
    expected_cash REAL,
    actual_cash REAL,
    difference REAL
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed Default Settings & Tables if not exists
const defaultSettings = [
  ['business_name', 'Cue Master Billiards'],
  ['business_address', '123 Main Street, City Center'],
  ['contact_number', '+63 912 345 6789'],
  ['opening_time', '10:00'],
  ['closing_time', '00:00'],
  ['table_1_rate', '100'],
  ['table_2_rate', '100'],
  ['billing_type', 'per_hour'],
  ['rounding', 'exact'],
  ['min_charge', '50'],
  ['points_per_spending', '100'],
  ['gcash_number', '09171234567'],
  ['gcash_name', 'Cue Master Billiards']
];

for (let [k, v] of defaultSettings) {
  const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
  if (!exists) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
}

// Seed Tables
const tableCount = db.prepare('SELECT COUNT(*) as cnt FROM billiard_tables').get().cnt;
if (tableCount === 0) {
  db.prepare('INSERT INTO billiard_tables (name, rate, status) VALUES (?, ?, ?)').run('Table 1', 100.0, 'AVAILABLE');
  db.prepare('INSERT INTO billiard_tables (name, rate, status) VALUES (?, ?, ?)').run('Table 2', 100.0, 'AVAILABLE');
}

// Seed Admin User
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hashed = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password, role, force_password_change) VALUES (?, ?, ?, ?)').run('admin', hashed, 'admin', 1);
}

// Seed Memberships
const memCount = db.prepare('SELECT COUNT(*) as cnt FROM memberships').get().cnt;
if (memCount === 0) {
  db.prepare('INSERT INTO memberships (level, discount_pct, bonus_points_multiplier) VALUES (?, ?, ?)').run('REGULAR', 0, 1.0);
  db.prepare('INSERT INTO memberships (level, discount_pct, bonus_points_multiplier) VALUES (?, ?, ?)').run('SILVER', 5, 1.2);
  db.prepare('INSERT INTO memberships (level, discount_pct, bonus_points_multiplier) VALUES (?, ?, ?)').run('GOLD', 10, 1.5);
}

// --- MIDDLEWARES ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false
}));

// Helper to log activities
function logActivity(user, action) {
  db.prepare('INSERT INTO activity_logs (user, action) VALUES (?, ?)').run(user, action);
}

// --- HTML TEMPLATES & VIEWS ---

const baseLayout = (title, content, userRole = 'customer') => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="/socket.io/socket.io.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="min-h-screen flex flex-col">
  <div id="toast-container" class="fixed top-5 right-5 z-50 flex flex-col gap-2"></div>
  ${content}
  <script>
    const socket = io();
    function showToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = \`px-4 py-3 rounded shadow-lg text-white \${type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'} transition transform translate-y-0 opacity-100\`;
      toast.innerText = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }
  </script>
</body>
</html>
`;

// --- CUSTOMER ROUTES ---

app.get('/', (req, res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(s => [s.key, s.value]));
  const tables = db.prepare('SELECT * FROM billiard_tables').all();
  const customerId = req.session.customerId;
  const customer = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null;

  const html = baseLayout('Cue Master Billiards - Customer Portal', `
    <header class="bg-slate-900 border-b border-slate-800 p-4 sticky top-0 z-40">
      <div class="max-w-6xl mx-auto flex justify-between items-center">
        <div class="flex items-center gap-3">
          <div class="bg-emerald-600 p-2 rounded-lg text-xl font-bold"><i class="fa-solid fa-circle-dot"></i></div>
          <div>
            <h1 class="font-bold text-lg">${settings.business_name}</h1>
            <p class="text-xs text-slate-400">${settings.business_address} | ${settings.contact_number}</p>
          </div>
        </div>
        <nav class="hidden md:flex items-center gap-4 text-sm">
          <a href="/" class="hover:text-emerald-400">Home</a>
          <a href="/tables" class="hover:text-emerald-400">Tables</a>
          <a href="/book" class="hover:text-emerald-400">Book Table</a>
          ${customer ? `
            <a href="/customer/dashboard" class="hover:text-emerald-400">Dashboard</a>
            <a href="/customer/rewards" class="hover:text-emerald-400">Rewards</a>
            <a href="/customer/call-staff" class="text-amber-400 font-semibold"><i class="fa-solid fa-bell"></i> Call Staff</a>
            <a href="/customer/logout" class="text-rose-400">Logout (${customer.name})</a>
          ` : `
            <a href="/customer/login" class="bg-emerald-600 px-3 py-1.5 rounded font-semibold hover:bg-emerald-500">Login</a>
            <a href="/customer/register" class="bg-slate-800 px-3 py-1.5 rounded font-semibold hover:bg-slate-700">Register</a>
          `}
        </nav>
        <button onclick="toggleMobileMenu()" class="md:hidden text-xl"><i class="fa-solid fa-bars"></i></button>
      </div>
      <div id="mobile-menu" class="hidden md:hidden pt-4 pb-2 border-t border-slate-800 flex flex-col gap-2 text-sm">
        <a href="/" class="py-1">Home</a>
        <a href="/tables" class="py-1">Tables</a>
        <a href="/book" class="py-1">Book Table</a>
        ${customer ? `
          <a href="/customer/dashboard" class="py-1">Dashboard</a>
          <a href="/customer/rewards" class="py-1">Rewards</a>
          <a href="/customer/call-staff" class="py-1 text-amber-400">Call Staff</a>
          <a href="/customer/logout" class="py-1 text-rose-400">Logout</a>
        ` : `
          <a href="/customer/login" class="py-1 text-emerald-400">Login</a>
          <a href="/customer/register" class="py-1 text-emerald-400">Register</a>
        `}
      </div>
    </header>

    <main class="flex-1 max-w-6xl w-full mx-auto p-4 md:p-6 flex flex-col gap-8">
      <div class="bg-gradient-to-r from-emerald-900 to-slate-900 border border-emerald-800/50 rounded-2xl p-6 md:p-10 flex flex-col md:flex-row justify-between items-center gap-6 shadow-xl">
        <div class="flex flex-col gap-3 max-w-xl">
          <span class="bg-emerald-500/20 text-emerald-400 text-xs font-semibold px-3 py-1 rounded-full w-fit">Open Daily: ${settings.opening_time} - ${settings.closing_time}</span>
          <h2 class="text-3xl md:text-4xl font-extrabold tracking-tight">Play Like a Pro. Reserve Your Table Today.</h2>
          <p class="text-slate-300 text-sm md:text-base">Experience professional tournament-grade tables, instant reservation, and live bill tracking.</p>
          <div class="flex gap-3 pt-2">
            <a href="/book" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-lg font-bold text-sm transition">Book A Table</a>
            <a href="/tables" class="bg-slate-800 hover:bg-slate-700 px-5 py-2.5 rounded-lg font-bold text-sm transition border border-slate-700">Check Tables</a>
          </div>
        </div>
        <div class="bg-slate-950/60 p-6 rounded-xl border border-slate-800 w-full md:w-80 flex flex-col gap-4">
          <h3 class="font-bold text-emerald-400 border-b border-slate-800 pb-2 flex items-center justify-between">
            <span>Live Table Status</span>
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
          </h3>
          <div id="live-tables-container" class="flex flex-col gap-3">
            ${tables.map(t => `
              <div class="flex justify-between items-center bg-slate-900 p-3 rounded-lg border border-slate-800">
                <div class="flex items-center gap-2">
                  <i class="fa-solid fa-bowling-ball text-emerald-500"></i>
                  <span class="font-semibold">${t.name}</span>
                </div>
                <span class="px-2.5 py-1 rounded text-xs font-bold ${t.status === 'AVAILABLE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}" id="table-status-${t.id}">
                  ${t.status === 'AVAILABLE' ? '🟢 AVAILABLE' : '🔴 PLAYING'}
                </span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </main>

    <footer class="bg-slate-900 border-t border-slate-800 py-6 text-center text-xs text-slate-500">
      &copy; 2026 ${settings.business_name}. All rights reserved.
    </footer>

    <script>
      function toggleMobileMenu() {
        document.getElementById('mobile-menu').classList.toggle('hidden');
      }
      socket.on('table_update', (data) => {
        data.forEach(t => {
          const badge = document.getElementById(\`table-status-\${t.id}\`);
          if (badge) {
            badge.innerText = t.status === 'AVAILABLE' ? '🟢 AVAILABLE' : '🔴 PLAYING';
            badge.className = \`px-2.5 py-1 rounded text-xs font-bold \${t.status === 'AVAILABLE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}\`;
          }
        });
      });
    </script>
  `);
  res.send(html);
});

app.get('/tables', (req, res) => {
  const tables = db.prepare('SELECT * FROM billiard_tables').all();
  res.send(baseLayout('Tables - Cue Master Billiards', `
    <div class="max-w-4xl mx-auto p-6 w-full flex flex-col gap-6">
      <h2 class="text-2xl font-bold">Billiard Tables</h2>
      <div class="grid md:grid-cols-2 gap-6">
        ${tables.map(t => `
          <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col gap-4">
            <div class="flex justify-between items-center">
              <h3 class="text-xl font-bold">${t.name}</h3>
              <span class="px-3 py-1 rounded text-xs font-bold ${t.status === 'AVAILABLE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}">${t.status}</span>
            </div>
            <p class="text-slate-400 text-sm">Hourly Rate: <span class="text-white font-bold">₱${t.rate}/hour</span></p>
            <div class="flex gap-3 pt-2">
              <a href="/book?table=${t.id}" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded text-sm font-bold flex-1 text-center">Book This Table</a>
              <a href="/table/${t.id}" class="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded text-sm font-bold border border-slate-700 text-center">QR Info</a>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `));
});

app.get('/table/:id', (req, res) => {
  const tableId = req.params.id;
  const table = db.prepare('SELECT * FROM billiard_tables WHERE id = ?').get(tableId);
  if (!table) return res.status(404).send('Table not found');

  let session = null;
  if (table.current_session_id) {
    session = db.prepare('SELECT sessions.*, customers.name as customer_name FROM sessions JOIN customers ON sessions.customer_id = customers.id WHERE sessions.id = ?').get(table.current_session_id);
  }

  res.send(baseLayout(`${table.name} Info`, `
    <div class="max-w-md mx-auto p-6 w-full flex flex-col gap-6 my-auto">
      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4 text-center">
        <h2 class="text-3xl font-extrabold text-emerald-400">${table.name}</h2>
        <div class="text-lg font-semibold px-4 py-2 rounded bg-slate-800 w-fit mx-auto">
          Status: <span class="${table.status === 'AVAILABLE' ? 'text-emerald-400' : 'text-rose-400'}">${table.status}</span>
        </div>
        <p class="text-slate-400 text-sm">Hourly Rate: <strong class="text-white">₱${table.rate}</strong></p>
        ${session ? `
          <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 text-left flex flex-col gap-2">
            <p class="text-xs text-slate-400 font-bold uppercase">Current Active Session</p>
            <p class="text-sm">Customer: <strong class="text-white">${session.customer_name}</strong></p>
            <p class="text-sm">Start Time: <strong class="text-white">${new Date(session.start_time).toLocaleTimeString()}</strong></p>
          </div>
        ` : ''}
        <div class="flex flex-col gap-3 pt-4">
          <a href="/book?table=${table.id}" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded-lg font-bold text-sm">BOOK THIS TABLE</a>
          <button onclick="callStaff(${table.id})" class="bg-amber-600 hover:bg-amber-500 py-3 rounded-lg font-bold text-sm">CALL STAFF</button>
        </div>
      </div>
    </div>
    <script>
      function callStaff(tableId) {
        fetch('/api/customer/call-staff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table_id: tableId, request_type: 'Table QR Assistance' })
        }).then(res => res.json()).then(data => {
          if (data.success) showToast('Staff has been notified!');
        });
      }
    </script>
  `));
});

app.get('/customer/login', (req, res) => {
  res.send(baseLayout('Customer Login', `
    <div class="max-w-md mx-auto w-full p-6 my-auto">
      <form action="/customer/login" method="POST" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 shadow-xl">
        <h2 class="text-2xl font-bold text-center mb-2">Customer Login</h2>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Email</label>
          <input type="email" name="email" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Password</label>
          <input type="password" name="password" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Login</button>
        <p class="text-xs text-center text-slate-400 mt-2">Don't have an account? <a href="/customer/register" class="text-emerald-400 font-bold">Register</a></p>
      </form>
    </div>
  `));
});

app.post('/customer/login', (req, res) => {
  const { email, password } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  if (customer && bcrypt.compareSync(password, customer.password)) {
    req.session.customerId = customer.id;
    res.redirect('/customer/dashboard');
  } else {
    res.send(baseLayout('Error', '<div class="p-8 text-center"><p class="text-rose-500 font-bold">Invalid email or password.</p><a href="/customer/login" class="text-emerald-400 underline text-sm mt-4 inline-block">Try Again</a></div>'));
  }
});

app.get('/customer/register', (req, res) => {
  res.send(baseLayout('Customer Register', `
    <div class="max-w-md mx-auto w-full p-6 my-auto">
      <form action="/customer/register" method="POST" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 shadow-xl">
        <h2 class="text-2xl font-bold text-center mb-2">Create Account</h2>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Full Name</label>
          <input type="text" name="name" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Email</label>
          <input type="email" name="email" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Phone Number</label>
          <input type="text" name="phone" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Password</label>
          <input type="password" name="password" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Register</button>
        <p class="text-xs text-center text-slate-400 mt-2">Already have an account? <a href="/customer/login" class="text-emerald-400 font-bold">Login</a></p>
      </form>
    </div>
  `));
});

app.post('/customer/register', (req, res) => {
  const { name, email, phone, password } = req.body;
  try {
    const hashed = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO customers (name, email, phone, password) VALUES (?, ?, ?, ?)').run(name, email, phone, hashed);
    req.session.customerId = info.lastInsertRowid;
    res.redirect('/customer/dashboard');
  } catch (err) {
    res.send(baseLayout('Error', '<div class="p-8 text-center"><p class="text-rose-500 font-bold">Email already registered.</p><a href="/customer/register" class="text-emerald-400 underline text-sm mt-4 inline-block">Try Again</a></div>'));
  }
});

app.get('/customer/logout', (req, res) => {
  req.session.customerId = null;
  res.redirect('/');
});

app.get('/customer/dashboard', (req, res) => {
  if (!req.session.customerId) return res.redirect('/customer/login');
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  const reservations = db.prepare('SELECT * FROM reservations WHERE customer_name = ? ORDER BY date DESC').all(customer.name);
  const history = db.prepare('SELECT sessions.*, billiard_tables.name as table_name FROM sessions JOIN billiard_tables ON sessions.table_id = billiard_tables.id WHERE customer_id = ? AND status = ? ORDER BY start_time DESC').all(customer.id, 'Completed');
  const activeSession = db.prepare('SELECT sessions.*, billiard_tables.name as table_name FROM sessions JOIN billiard_tables ON sessions.table_id = billiard_tables.id WHERE customer_id = ? AND sessions.status = ?').get(customer.id, 'Active');

  const totalHours = history.reduce((acc, s) => acc + (s.duration_minutes || 0), 0) / 60;
  const totalSpending = history.reduce((acc, s) => acc + (s.amount || 0), 0);

  res.send(baseLayout('Customer Dashboard', `
    <div class="max-w-6xl mx-auto p-4 md:p-6 w-full flex flex-col gap-6">
      <div class="flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-900 p-6 rounded-2xl border border-slate-800 gap-4">
        <div>
          <h2 class="text-2xl font-bold">Welcome, ${customer.name}</h2>
          <p class="text-xs text-slate-400">Membership: <span class="text-emerald-400 font-bold">${customer.membership}</span> | Points: <span class="text-amber-400 font-bold">${customer.points} pts</span></p>
        </div>
        <div class="flex gap-2">
          <a href="/book" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded text-sm font-bold">Book Table</a>
          <a href="/customer/call-staff" class="bg-amber-600 hover:bg-amber-500 px-4 py-2 rounded text-sm font-bold">Call Staff</a>
        </div>
      </div>

      <div class="grid md:grid-cols-3 gap-6">
        <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 flex flex-col gap-1">
          <span class="text-xs text-slate-400 font-bold uppercase">Total Playing Hours</span>
          <span class="text-2xl font-extrabold text-white">${totalHours.toFixed(1)} hrs</span>
        </div>
        <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 flex flex-col gap-1">
          <span class="text-xs text-slate-400 font-bold uppercase">Total Spending</span>
          <span class="text-2xl font-extrabold text-white">₱${totalSpending.toFixed(2)}</span>
        </div>
        <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 flex flex-col gap-1">
          <span class="text-xs text-slate-400 font-bold uppercase">Loyalty Points</span>
          <span class="text-2xl font-extrabold text-amber-400">${customer.points} pts</span>
        </div>
      </div>

      ${activeSession ? `
        <div class="bg-emerald-950/40 border border-emerald-800/60 p-6 rounded-2xl flex flex-col gap-3">
          <h3 class="font-bold text-emerald-400 flex items-center gap-2"><i class="fa-solid fa-circle-dot animate-ping"></i> Active Session on ${activeSession.table_name}</h3>
          <p class="text-sm">Started at: ${new Date(activeSession.start_time).toLocaleTimeString()}</p>
        </div>
      ` : ''}

      <div class="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col gap-4">
        <h3 class="font-bold text-lg border-b border-slate-800 pb-2">My Reservations</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-slate-400 bg-slate-950 uppercase">
              <tr>
                <th class="p-3">ID</th>
                <th class="p-3">Table</th>
                <th class="p-3">Date / Time</th>
                <th class="p-3">Est. Cost</th>
                <th class="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              ${reservations.map(r => `
                <tr class="border-b border-slate-800">
                  <td class="p-3 font-bold">${r.id}</td>
                  <td class="p-3">Table ${r.table_id}</td>
                  <td class="p-3">${r.date} (${r.start_time} - ${r.end_time})</td>
                  <td class="p-3">₱${r.estimated_cost}</td>
                  <td class="p-3 font-bold text-emerald-400">${r.status}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `));
});

app.get('/book', (req, res) => {
  const tables = db.prepare('SELECT * FROM billiard_tables').all();
  const selectedTable = req.query.table || 1;
  res.send(baseLayout('Book Table', `
    <div class="max-w-lg mx-auto p-6 w-full my-auto">
      <form action="/book" method="POST" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 shadow-xl">
        <h2 class="text-2xl font-bold text-center mb-2">Reserve a Table</h2>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Customer Name</label>
          <input type="text" name="customer_name" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Contact Number</label>
          <input type="text" name="contact_number" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-slate-400 font-bold">Table</label>
            <select name="table_id" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
              ${tables.map(t => `<option value="${t.id}" ${t.id == selectedTable ? 'selected' : ''}>${t.name} (₱${t.rate}/hr)</option>`).join('')}
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-slate-400 font-bold">Date</label>
            <input type="date" name="date" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-slate-400 font-bold">Start Time</label>
            <input type="time" name="start_time" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-xs text-slate-400 font-bold">End Time</label>
            <input type="time" name="end_time" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Number of Players</label>
          <input type="number" name="num_players" value="2" min="1" max="6" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Optional Notes</label>
          <textarea name="notes" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500"></textarea>
        </div>
        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Confirm Reservation</button>
      </form>
    </div>
  `));
});

app.post('/book', (req, res) => {
  const { customer_name, contact_number, table_id, date, start_time, end_time, num_players, notes } = req.body;
  const [startH, startM] = start_time.split(':').map(Number);
  const [endH, endM] = end_time.split(':').map(Number);
  const hours = (endH + endM / 60) - (startH + startM / 60);
  if (hours <= 0) return res.send(baseLayout('Error', '<div class="p-8 text-center"><p class="text-rose-500 font-bold">End time must be after start time.</p><a href="/book" class="text-emerald-400 underline text-sm mt-4 inline-block">Back</a></div>'));

  const table = db.prepare('SELECT * FROM billiard_tables WHERE id = ?').get(table_id);
  const estimated_cost = Math.max(hours * table.rate, 50);

  const dateStr = date.replace(/-/g, '');
  const randNum = Math.floor(100 + Math.random() * 900);
  const resId = `RES-${dateStr}-${randNum}`;

  db.prepare('INSERT INTO reservations (id, customer_name, contact_number, table_id, date, start_time, end_time, num_players, notes, estimated_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    resId, customer_name, contact_number, table_id, date, start_time, end_time, num_players, notes, estimated_cost
  );

  res.send(baseLayout('Reservation Confirmed', `
    <div class="max-w-md mx-auto p-6 w-full my-auto">
      <div class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 text-center">
        <div class="text-emerald-500 text-4xl"><i class="fa-solid fa-circle-check"></i></div>
        <h2 class="text-2xl font-bold">Reservation Successful!</h2>
        <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 text-left flex flex-col gap-2 text-sm">
          <p>Reservation ID: <strong class="text-emerald-400">${resId}</strong></p>
          <p>Table: <strong>${table.name}</strong></p>
          <p>Date & Time: <strong>${date} (${start_time} - ${end_time})</strong></p>
          <p>Estimated Price: <strong class="text-emerald-400">₱${estimated_cost}</strong></p>
        </div>
        <a href="/" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Back to Home</a>
      </div>
    </div>
  `));
});

app.get('/customer/call-staff', (req, res) => {
  res.send(baseLayout('Call Staff', `
    <div class="max-w-md mx-auto p-6 w-full my-auto">
      <form id="call-form" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 shadow-xl">
        <h2 class="text-2xl font-bold text-center mb-2 text-amber-400"><i class="fa-solid fa-bell"></i> Call Staff</h2>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Your Name</label>
          <input type="text" id="customer_name" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-amber-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Table</label>
          <select id="table_id" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-amber-500">
            <option value="1">Table 1</option>
            <option value="2">Table 2</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Request Type</label>
          <select id="request_type" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-amber-500">
            <option value="Need assistance">Need assistance</option>
            <option value="Need to end my session">Need to end my session</option>
            <option value="Need table assistance">Need table assistance</option>
            <option value="Need equipment assistance">Need equipment assistance</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <button type="submit" class="bg-amber-600 hover:bg-amber-500 py-3 rounded font-bold text-sm mt-2">Send Request</button>
      </form>
    </div>
    <script>
      document.getElementById('call-form').onsubmit = (e) => {
        e.preventDefault();
        fetch('/api/customer/call-staff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_name: document.getElementById('customer_name').value,
            table_id: document.getElementById('table_id').value,
            request_type: document.getElementById('request_type').value
          })
        }).then(res => res.json()).then(data => {
          if (data.success) {
            showToast('Staff requested successfully!');
            setTimeout(() => window.location.href = '/', 1500);
          }
        });
      };
    </script>
  `));
});

app.post('/api/customer/call-staff', (req, res) => {
  const { table_id, customer_name, request_type } = req.body;
  db.prepare('INSERT INTO customer_requests (table_id, customer_name, request_type, status) VALUES (?, ?, ?, ?)').run(
    table_id, customer_name || 'Anonymous', request_type || 'Need assistance', 'Pending'
  );
  io.emit('new_request');
  res.json({ success: true });
});

app.get('/customer/rewards', (req, res) => {
  if (!req.session.customerId) return res.redirect('/customer/login');
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  const rewards = db.prepare('SELECT * FROM rewards WHERE is_active = 1').all();
  res.send(baseLayout('Rewards', `
    <div class="max-w-4xl mx-auto p-6 w-full flex flex-col gap-6">
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex justify-between items-center">
        <div>
          <h2 class="text-xl font-bold">Loyalty Rewards</h2>
          <p class="text-xs text-slate-400">Every ₱100 spent = 1 point.</p>
        </div>
        <div class="bg-amber-500/20 text-amber-400 px-4 py-2 rounded-xl font-bold">
          Available Points: ${customer.points} pts
        </div>
      </div>
      <div class="grid md:grid-cols-2 gap-6">
        ${rewards.map(r => `
          <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col justify-between gap-4">
            <div>
              <h3 class="font-bold text-lg">${r.title}</h3>
              <p class="text-amber-400 font-semibold text-sm mt-1">${r.points_required} Points Required</p>
            </div>
            <button onclick="showToast('Reward redeemed successfully!')" class="bg-emerald-600 hover:bg-emerald-500 py-2 rounded font-bold text-sm">Redeem Reward</button>
          </div>
        `).join('')}
      </div>
    </div>
  `));
});


// --- OWNER / ADMIN ROUTES ---

function requireAdmin(req, res, next) {
  if (req.session.adminId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.adminId);
    if (user && user.force_password_change && req.path !== '/admin/change-password') {
      return res.redirect('/admin/change-password');
    }
    return next();
  }
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  res.send(baseLayout('Admin Login', `
    <div class="max-w-md mx-auto w-full p-6 my-auto">
      <form action="/admin/login" method="POST" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 shadow-xl">
        <h2 class="text-2xl font-bold text-center mb-2">Owner Admin Login</h2>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Username</label>
          <input type="text" name="username" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Password</label>
          <input type="password" name="password" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Login</button>
      </form>
    </div>
  `));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.adminId = user.id;
    logActivity(user.username, 'Admin Logged In');
    if (user.force_password_change) {
      return res.redirect('/admin/change-password');
    }
    res.redirect('/admin/dashboard');
  } else {
    res.send(baseLayout('Error', '<div class="p-8 text-center"><p class="text-rose-500 font-bold">Invalid username or password.</p><a href="/admin/login" class="text-emerald-400 underline text-sm mt-4 inline-block">Try Again</a></div>'));
  }
});

app.get('/admin/change-password', (req, res) => {
  res.send(baseLayout('Change Password Required', `
    <div class="max-w-md mx-auto w-full p-6 my-auto">
      <form action="/admin/change-password" method="POST" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 shadow-xl">
        <h2 class="text-2xl font-bold text-center mb-2 text-amber-400">Change Default Password</h2>
        <p class="text-xs text-slate-400 text-center">For security reasons, you must change your default password before proceeding.</p>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">New Password</label>
          <input type="password" name="new_password" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm focus:outline-none focus:border-emerald-500">
        </div>
        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Update Password</button>
      </form>
    </div>
  `));
});

app.post('/admin/change-password', requireAdmin, (req, res) => {
  const { new_password } = req.body;
  const hashed = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?').run(hashed, req.session.adminId);
  logActivity('admin', 'Password Changed');
  res.redirect('/admin/dashboard');
});

const adminLayout = (title, activeMenu, content) => {
  const menus = [
    { name: 'Dashboard', icon: 'fa-chart-pie', link: '/admin/dashboard' },
    { name: 'Tables', icon: 'fa-bowling-ball', link: '/admin/tables' },
    { name: 'Active Sessions', icon: 'fa-stopwatch', link: '/admin/sessions' },
    { name: 'Reservations', icon: 'fa-calendar', link: '/admin/reservations' },
    { name: 'Customers', icon: 'fa-users', link: '/admin/customers' },
    { name: 'Payments', icon: 'fa-wallet', link: '/admin/payments' },
    { name: 'Receipts', icon: 'fa-receipt', link: '/admin/receipts' },
    { name: 'Loyalty', icon: 'fa-star', link: '/admin/loyalty' },
    { name: 'Analytics', icon: 'fa-chart-line', link: '/admin/analytics' },
    { name: 'Customer Requests', icon: 'fa-bell', link: '/admin/requests' },
    { name: 'Daily Closing', icon: 'fa-cash-register', link: '/admin/closing' },
    { name: 'Settings', icon: 'fa-gear', link: '/admin/settings' },
  ];

  return baseLayout(title, `
    <div class="flex h-screen overflow-hidden">
      <aside class="w-64 bg-slate-900 border-r border-slate-800 flex flex-col hidden lg:flex">
        <div class="p-6 border-b border-slate-800 flex items-center gap-3">
          <div class="bg-emerald-600 p-2 rounded-lg text-white font-bold"><i class="fa-solid fa-circle-dot"></i></div>
          <span class="font-bold text-lg">Owner Panel</span>
        </div>
        <nav class="flex-1 overflow-y-auto p-4 flex flex-col gap-1">
          ${menus.map(m => `
            <a href="${m.link}" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-semibold ${activeMenu === m.name ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}">
              <i class="fa-solid ${m.icon} w-5"></i> ${m.name}
            </a>
          `).join('')}
        </nav>
        <div class="p-4 border-t border-slate-800">
          <a href="/admin/logout" class="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-semibold text-rose-400 hover:bg-rose-500/10">
            <i class="fa-solid fa-right-from-bracket w-5"></i> Logout
          </a>
        </div>
      </aside>
      <div class="flex-1 flex flex-col overflow-hidden">
        <header class="bg-slate-900 border-b border-slate-800 p-4 flex justify-between items-center lg:hidden">
          <span class="font-bold">Owner Dashboard</span>
          <a href="/admin/logout" class="text-rose-400 text-sm font-bold">Logout</a>
        </header>
        <main class="flex-1 overflow-y-auto p-6 bg-slate-950 flex flex-col gap-6">
          ${content}
        </main>
      </div>
    </div>
  `);
};

app.get('/admin/logout', (req, res) => {
  req.session.adminId = null;
  res.redirect('/admin/login');
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const tables = db.prepare('SELECT * FROM billiard_tables').all();
  const today = new Date().toISOString().split('T')[0];
  
  const todayRevenue = db.prepare('SELECT SUM(total_amount) as total FROM payments WHERE date(created_at) = ?').get(today).total || 0;
  const todaySessions = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE date(start_time) = ?').get(today).cnt;
  const activeSessions = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE status = ?').get('Active').cnt;
  const requests = db.prepare('SELECT * FROM customer_requests WHERE status = ?').all('Pending');

  res.send(adminLayout('Owner Dashboard', 'Dashboard', `
    <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-2">
        <span class="text-xs text-slate-400 font-bold uppercase">Today's Revenue</span>
        <span class="text-3xl font-extrabold text-emerald-400">₱${todayRevenue.toFixed(2)}</span>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-2">
        <span class="text-xs text-slate-400 font-bold uppercase">Today's Sessions</span>
        <span class="text-3xl font-extrabold text-white">${todaySessions}</span>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-2">
        <span class="text-xs text-slate-400 font-bold uppercase">Playing Hours</span>
        <span class="text-3xl font-extrabold text-white">--</span>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-2">
        <span class="text-xs text-slate-400 font-bold uppercase">Active Sessions</span>
        <span class="text-3xl font-extrabold text-amber-400">${activeSessions}</span>
      </div>
    </div>

    <div class="grid md:grid-cols-2 gap-6">
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-4">
        <h3 class="font-bold text-lg border-b border-slate-800 pb-2">Table Status</h3>
        <div class="grid grid-cols-2 gap-4">
          ${tables.map(t => `
            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex flex-col gap-2">
              <span class="font-bold">${t.name}</span>
              <span class="px-2.5 py-1 rounded text-xs font-bold w-fit ${t.status === 'AVAILABLE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}">${t.status}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-4">
        <h3 class="font-bold text-lg border-b border-slate-800 pb-2">Pending Customer Requests</h3>
        <div class="flex flex-col gap-3" id="admin-requests-list">
          ${requests.length === 0 ? '<p class="text-xs text-slate-500">No pending requests.</p>' : requests.map(r => `
            <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 flex justify-between items-center text-sm">
              <div>
                <p class="font-bold">Table ${r.table_id} - ${r.customer_name}</p>
                <p class="text-xs text-amber-400">${r.request_type}</p>
              </div>
              <button onclick="acknowledgeRequest(${r.id})" class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1 rounded text-xs font-bold">Acknowledge</button>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    <script>
      function acknowledgeRequest(id) {
        fetch('/api/admin/request/' + id, { method: 'POST' }).then(() => location.reload());
      }
    </script>
  `));
});

app.get('/admin/tables', requireAdmin, (req, res) => {
  const tables = db.prepare('SELECT * FROM billiard_tables').all();
  const customers = db.prepare('SELECT * FROM customers').all();

  res.send(adminLayout('Tables Management', 'Tables', `
    <div class="flex flex-col gap-6">
      <h2 class="text-2xl font-bold">Tables & Session Controls</h2>
      <div class="grid md:grid-cols-2 gap-6">
        ${tables.map(t => `
          <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-4">
            <div class="flex justify-between items-center">
              <h3 class="text-xl font-bold">${t.name}</h3>
              <span class="px-3 py-1 rounded text-xs font-bold ${t.status === 'AVAILABLE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}">${t.status}</span>
            </div>
            <p class="text-sm text-slate-400">Rate: <strong class="text-white">₱${t.rate}/hour</strong></p>
            ${t.status === 'AVAILABLE' ? `
              <form action="/admin/session/start" method="POST" class="flex flex-col gap-3 pt-2 border-t border-slate-800">
                <input type="hidden" name="table_id" value="${t.id}">
                <select name="customer_id" required class="bg-slate-950 border border-slate-800 rounded p-2 text-sm">
                  <option value="">Select Customer</option>
                  ${customers.map(c => `<option value="${c.id}">${c.name} (${c.email})</option>`).join('')}
                </select>
                <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-2 rounded text-sm font-bold">Start Session</button>
              </form>
            ` : `
              <div class="pt-2 border-t border-slate-800 flex gap-2">
                <a href="/admin/sessions" class="bg-amber-600 hover:bg-amber-500 py-2 px-4 rounded text-sm font-bold flex-1 text-center">Manage Active Session</a>
              </div>
            `}
          </div>
        `).join('')}
      </div>
    </div>
  `));
});

app.post('/admin/session/start', requireAdmin, (req, res) => {
  const { table_id, customer_id } = req.body;
  const table = db.prepare('SELECT * FROM billiard_tables WHERE id = ?').get(table_id);
  
  const startTime = new Date().toISOString();
  const info = db.prepare('INSERT INTO sessions (customer_id, table_id, start_time, rate, status) VALUES (?, ?, ?, ?, ?)').run(
    customer_id, table_id, startTime, table.rate, 'Active'
  );

  db.prepare('UPDATE billiard_tables SET status = ?, current_session_id = ? WHERE id = ?').run('PLAYING', info.lastInsertRowid, table_id);
  io.emit('table_update', db.prepare('SELECT * FROM billiard_tables').all());
  res.redirect('/admin/sessions');
});

app.get('/admin/sessions', requireAdmin, (req, res) => {
  const activeSessions = db.prepare('SELECT sessions.*, customers.name as customer_name, billiard_tables.name as table_name FROM sessions JOIN customers ON sessions.customer_id = customers.id JOIN billiard_tables ON sessions.table_id = billiard_tables.id WHERE sessions.status = ?').all('Active');

  res.send(adminLayout('Active Sessions', 'Active Sessions', `
    <div class="flex flex-col gap-6">
      <h2 class="text-2xl font-bold">Active Billiards Sessions</h2>
      <div class="grid md:grid-cols-2 gap-6">
        ${activeSessions.length === 0 ? '<p class="text-slate-500 text-sm">No active sessions.</p>' : activeSessions.map(s => `
          <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl flex flex-col gap-4">
            <div class="flex justify-between items-center">
              <h3 class="text-xl font-bold">${s.table_name}</h3>
              <span class="text-emerald-400 font-bold text-sm">${s.customer_name}</span>
            </div>
            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex justify-between items-center">
              <div>
                <p class="text-xs text-slate-400 font-bold uppercase">Timer</p>
                <p class="text-2xl font-mono font-bold text-white" id="timer-${s.id}">00:00:00</p>
              </div>
              <div class="text-right">
                <p class="text-xs text-slate-400 font-bold uppercase">Current Bill</p>
                <p class="text-2xl font-bold text-emerald-400" id="bill-${s.id}">₱0.00</p>
              </div>
            </div>
            <div class="flex gap-2">
              <form action="/admin/session/end/${s.id}" method="POST" class="flex-1">
                <button type="submit" class="w-full bg-rose-600 hover:bg-rose-500 py-2.5 rounded font-bold text-sm">End Session & Pay</button>
              </form>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    <script>
      const activeSessions = ${JSON.stringify(activeSessions)};
      setInterval(() => {
        activeSessions.forEach(s => {
          const start = new Date(s.start_time).getTime();
          const now = new Date().getTime();
          const diff = Math.floor((now - start) / 1000);
          const hrs = String(Math.floor(diff / 3600)).padStart(2, '0');
          const mins = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
          const secs = String(diff % 60).padStart(2, '0');
          
          const timerEl = document.getElementById('timer-' + s.id);
          if (timerEl) timerEl.innerText = \`\${hrs}:\${mins}:\${secs}\`;

          const hours = diff / 3600;
          const bill = Math.max(hours * s.rate, 50);
          const billEl = document.getElementById('bill-' + s.id);
          if (billEl) billEl.innerText = '₱' + bill.toFixed(2);
        });
      }, 1000);
    </script>
  `));
});

app.post('/admin/session/end/:id', requireAdmin, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const endTime = new Date().toISOString();
  const diffMinutes = Math.max(Math.floor((new Date(endTime) - new Date(session.start_time)) / 60000), 1);
  const amount = Math.max((diffMinutes / 60) * session.rate, 50);

  db.prepare('UPDATE sessions SET end_time = ?, duration_minutes = ?, amount = ?, status = ? WHERE id = ?').run(
    endTime, diffMinutes, amount, 'Completed', sessionId
  );

  db.prepare('UPDATE billiard_tables SET status = ?, current_session_id = NULL WHERE id = ?').run('AVAILABLE', session.table_id);
  io.emit('table_update', db.prepare('SELECT * FROM billiard_tables').all());

  res.redirect(`/admin/payment/${sessionId}`);
});

app.get('/admin/payment/:sessionId', requireAdmin, (req, res) => {
  const session = db.prepare('SELECT sessions.*, customers.name as customer_name FROM sessions JOIN customers ON sessions.customer_id = customers.id WHERE sessions.id = ?').get(req.params.sessionId);
  res.send(adminLayout('Payment', 'Active Sessions', `
    <div class="max-w-lg mx-auto w-full p-6 my-auto">
      <form action="/admin/payment" method="POST" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 shadow-xl">
        <h2 class="text-2xl font-bold text-center mb-2">Process Payment</h2>
        <input type="hidden" name="session_id" value="${session.id}">
        <input type="hidden" name="customer_id" value="${session.customer_id}">
        <input type="hidden" name="table_id" value="${session.table_id}">
        <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 text-sm flex flex-col gap-2">
          <p>Customer: <strong>${session.customer_name}</strong></p>
          <p>Total Amount: <strong class="text-emerald-400 text-lg">₱${session.amount.toFixed(2)}</strong></p>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Payment Method</label>
          <select name="payment_method" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm">
            <option value="Cash">Cash</option>
            <option value="GCash">GCash</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Amount Paid</label>
          <input type="number" step="any" name="amount_paid" required class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm">
        </div>
        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Complete Payment & Print Receipt</button>
      </form>
    </div>
  `));
});

app.post('/admin/payment', requireAdmin, (req, res) => {
  const { session_id, customer_id, table_id, payment_method, amount_paid } = req.body;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
  const change = parseFloat(amount_paid) - session.amount;
  const receiptNo = `REC-${Math.floor(100000 + Math.random() * 900000)}`;

  db.prepare('INSERT INTO payments (receipt_no, customer_id, table_id, total_amount, amount_paid, change, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    receiptNo, customer_id, table_id, session.amount, amount_paid, change, payment_method
  );

  const pointsEarned = Math.floor(session.amount / 100);
  if (pointsEarned > 0) {
    db.prepare('UPDATE customers SET points = points + ? WHERE id = ?').run(pointsEarned, customer_id);
  }

  res.redirect(`/admin/receipt/${receiptNo}`);
});

app.get('/admin/receipt/:receiptNo', requireAdmin, (req, res) => {
  const receiptNo = req.params.receiptNo;
  const payment = db.prepare('SELECT payments.*, customers.name as customer_name FROM payments JOIN customers ON payments.customer_id = customers.id WHERE receipt_no = ?').get(receiptNo);

  res.send(adminLayout('Receipt', 'Receipts', `
    <div class="max-w-md mx-auto w-full p-6 my-auto">
      <div class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4 text-center">
        <h2 class="text-2xl font-bold">Cue Master Billiards</h2>
        <p class="text-xs text-slate-400">Receipt No: <strong>${payment.receipt_no}</strong></p>
        <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 text-left text-sm flex flex-col gap-2">
          <p>Customer: <strong>${payment.customer_name}</strong></p>
          <p>Table: <strong>Table ${payment.table_id}</strong></p>
          <p>Total Amount: <strong class="text-emerald-400">₱${payment.total_amount.toFixed(2)}</strong></p>
          <p>Amount Paid: <strong>₱${payment.amount_paid.toFixed(2)}</strong></p>
          <p>Change: <strong>₱${payment.change.toFixed(2)}</strong></p>
          <p>Method: <strong>${payment.payment_method}</strong></p>
        </div>
        <button onclick="window.print()" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm">Print Receipt</button>
        <a href="/admin/dashboard" class="text-slate-400 hover:text-white text-xs">Back to Dashboard</a>
      </div>
    </div>
  `));
});

app.post('/api/admin/request/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE customer_requests SET status = ? WHERE id = ?').run('Completed', req.params.id);
  res.json({ success: true });
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(s => [s.key, s.value]));
  res.send(adminLayout('Settings', 'Settings', `
    <div class="max-w-2xl mx-auto w-full flex flex-col gap-6">
      <h2 class="text-2xl font-bold">Business Settings</h2>
      <form action="/admin/settings" method="POST" class="bg-slate-900 border border-slate-800 p-8 rounded-2xl flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Business Name</label>
          <input type="text" name="business_name" value="${settings.business_name}" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Table 1 Rate (₱/hr)</label>
          <input type="number" name="table_1_rate" value="${settings.table_1_rate}" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-slate-400 font-bold">Table 2 Rate (₱/hr)</label>
          <input type="number" name="table_2_rate" value="${settings.table_2_rate}" class="bg-slate-950 border border-slate-800 rounded p-2.5 text-sm">
        </div>
        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 py-3 rounded font-bold text-sm mt-2">Save Settings</button>
      </form>
    </div>
  `));
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  for (let [k, v] of Object.entries(req.body)) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, k);
  }
  res.redirect('/admin/settings');
});

app.get('/admin/reservations', requireAdmin, (req, res) => { res.send(adminLayout('Reservations', 'Reservations', '<h2 class="text-2xl font-bold">Reservations Calendar</h2>')); });
app.get('/admin/customers', requireAdmin, (req, res) => { res.send(adminLayout('Customers', 'Customers', '<h2 class="text-2xl font-bold">Customer Management</h2>')); });
app.get('/admin/payments', requireAdmin, (req, res) => { res.send(adminLayout('Payments', 'Payments', '<h2 class="text-2xl font-bold">Payment History</h2>')); });
app.get('/admin/receipts', requireAdmin, (req, res) => { res.send(adminLayout('Receipts', 'Receipts', '<h2 class="text-2xl font-bold">Receipts List</h2>')); });
app.get('/admin/loyalty', requireAdmin, (req, res) => { res.send(adminLayout('Loyalty', 'Loyalty', '<h2 class="text-2xl font-bold">Loyalty & Rewards</h2>')); });
app.get('/admin/analytics', requireAdmin, (req, res) => { res.send(adminLayout('Analytics', 'Analytics', '<h2 class="text-2xl font-bold">Business Analytics</h2>')); });
app.get('/admin/requests', requireAdmin, (req, res) => { res.send(adminLayout('Customer Requests', 'Customer Requests', '<h2 class="text-2xl font-bold">Customer Requests</h2>')); });
app.get('/admin/closing', requireAdmin, (req, res) => { res.send(adminLayout('Daily Closing', 'Daily Closing', '<h2 class="text-2xl font-bold">Daily Cash Closing</h2>')); });

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Cue Master Billiards System running on port ${PORT}`);
});
