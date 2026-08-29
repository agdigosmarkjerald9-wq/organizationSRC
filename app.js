/**
 * COMPLETE BILLIARDS BUSINESS MANAGEMENT SYSTEM
 * Single-file Node.js + Express + SQLite + Socket.IO Architecture
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. DATABASE INITIALIZATION & SCHEMA
// ==========================================
const dbFile = path.join(__dirname, 'billiards.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected to SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT DEFAULT 'Cue Masters Billiards',
        address TEXT DEFAULT '123 Cue Street, Metro Manila',
        phone TEXT DEFAULT '09123456789',
        hours TEXT DEFAULT '1:00 PM - 12:00 AM',
        gcash_number TEXT DEFAULT '09123456789',
        gcash_name TEXT DEFAULT 'Owner Name',
        default_rate REAL DEFAULT 120.0,
        loyalty_rate INTEGER DEFAULT 100
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT CHECK(role IN ('admin','customer')) DEFAULT 'customer',
        phone TEXT,
        points INTEGER DEFAULT 0,
        membership TEXT DEFAULT 'Regular',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS billiard_tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_number INTEGER UNIQUE,
        name TEXT,
        hourly_rate REAL DEFAULT 120.0,
        status TEXT CHECK(status IN ('Available','Playing','Reserved','Maintenance')) DEFAULT 'Available',
        current_customer TEXT,
        start_time DATETIME,
        session_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER,
        customer_name TEXT,
        start_time DATETIME,
        end_time DATETIME,
        duration_minutes INTEGER DEFAULT 0,
        rate REAL,
        total_amount REAL,
        payment_method TEXT,
        status TEXT DEFAULT 'Active',
        handled_by TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT,
        contact_number TEXT,
        table_id INTEGER,
        date TEXT,
        start_time TEXT,
        end_time TEXT,
        players INTEGER,
        notes TEXT,
        status TEXT DEFAULT 'Pending'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS customer_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER,
        customer_name TEXT,
        request_type TEXT,
        status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS daily_closing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE,
        cash_revenue REAL,
        gcash_revenue REAL,
        total_revenue REAL,
        total_sessions INTEGER,
        total_hours REAL,
        opening_cash REAL,
        actual_cash REAL,
        difference REAL
    )`);

    // Seed Initial Tables if empty
    db.get(`SELECT COUNT(*) as count FROM billiard_tables`, (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO billiard_tables (table_number, name, hourly_rate, status) VALUES (1, 'Table 1', 120, 'Available')`);
            db.run(`INSERT INTO billiard_tables (table_number, name, hourly_rate, status) VALUES (2, 'Table 2', 120, 'Available')`);
        }
    });

    // Seed Default Admin Account (admin / admin123)
    db.get(`SELECT COUNT(*) as count FROM users WHERE role='admin'`, async (err, row) => {
        if (row.count === 0) {
            const hashed = await bcrypt.hash('admin123', 10);
            db.run(`INSERT INTO users (name, email, password, role, phone) VALUES ('Admin Owner', 'admin@billiards.com', ?, 'admin', '09999999999')`, [hashed]);
        }
    });

    // Seed Settings if empty
    db.get(`SELECT COUNT(*) as count FROM settings`, (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO settings (id) VALUES (1)`);
        }
    });
});

// ==========================================
// 2. MIDDLEWARE & CONFIGURATION
// ==========================================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'billiards-secret-key-9988',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// ==========================================
// 3. REAL-TIME WEBSOCKET (SOCKET.IO)
// ==========================================
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Client disconnected'));
});

function broadcastTableUpdate() {
    db.all(`SELECT * FROM billiard_tables`, (err, tables) => {
        if (!err) io.emit('table_update', tables);
    });
}

function broadcastRequestsUpdate() {
    db.all(`SELECT * FROM customer_requests WHERE status != 'Completed'`, (err, reqs) => {
        if (!err) io.emit('requests_update', reqs);
    });
}

// ==========================================
// 4. ROUTES: ADMIN & CUSTOMER PORTALS
// ==========================================

// --- AUTHENTICATION & LOGIN ---
app.get('/login', (req, res) => {
    res.send(renderAuthPage());
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.user = user;
            if (user.role === 'admin') res.redirect('/admin');
            else res.redirect('/customer');
        } else {
            res.send("<script>alert('Invalid credentials!'); window.location='/login';</script>");
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// --- CUSTOMER REGISTRATION ---
app.get('/register', (req, res) => {
    res.send(renderRegisterPage());
});

app.post('/register', async (req, res) => {
    const { name, email, password, phone } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (name, email, password, role, phone) VALUES (?, ?, ?, 'customer', ?)`,
        [name, email, hashed, phone], (err) => {
            if (err) res.send("<script>alert('Email already exists!'); window.location='/register';</script>");
            else res.send("<script>alert('Registration successful! Please login.'); window.location='/login';</script>");
        });
});

// ==========================================
// 5. OWNER / ADMIN DASHBOARD (`/admin`)
// ==========================================
app.get('/admin', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
    
    db.all(`SELECT * FROM billiard_tables`, (err, tables) => {
        db.all(`SELECT * FROM customer_requests WHERE status != 'Completed'`, (err2, requests) => {
            db.get(`SELECT SUM(total_amount) as rev, COUNT(*) as sessions, SUM(duration_minutes)/60.0 as hours FROM sessions WHERE date(start_time) = date('now')`, (err3, todayStats) => {
                db.all(`SELECT * FROM reservations WHERE status='Pending'`, (err4, reservations) => {
                    res.send(renderAdminDashboard(tables, requests, todayStats, reservations));
                });
            });
        });
    });
});

// Admin Actions: Start/Pause/End Session
app.post('/admin/table/:id/action', (req, res) => {
    const tableId = req.params.id;
    const { action, customer_name, rate } = req.body;

    if (action === 'start') {
        const startTime = new Date().toISOString();
        db.run(`UPDATE billiard_tables SET status='Playing', current_customer=?, start_time=? WHERE id=?`,
            [customer_name || 'Walk-in Guest', startTime, tableId], () => {
                db.run(`INSERT INTO sessions (table_id, customer_name, start_time, rate, status) VALUES (?, ?, ?, ?, 'Active')`,
                    [tableId, customer_name || 'Walk-in Guest', startTime, rate || 120], () => {
                        broadcastTableUpdate();
                        res.redirect('/admin');
                    });
            });
    } else if (action === 'end') {
        db.get(`SELECT * FROM billiard_tables WHERE id=?`, [tableId], (err, table) => {
            if (table && table.start_time) {
                const startTime = new Date(table.start_time);
                const endTime = new Date();
                const durationMins = Math.max(1, Math.round((endTime - startTime) / 60000));
                const totalAmount = (durationMins / 60) * table.hourly_rate;

                db.run(`UPDATE sessions SET end_time=?, duration_minutes=?, total_amount=?, status='Completed' WHERE table_id=? AND status='Active'`,
                    [endTime.toISOString(), durationMins, totalAmount, tableId], () => {
                        db.run(`UPDATE billiard_tables SET status='Available', current_customer=NULL, start_time=NULL WHERE id=?`, [tableId], () => {
                            broadcastTableUpdate();
                            res.redirect(`/admin/payment/${tableId}?amount=${totalAmount}&duration=${durationMins}`);
                        });
                    });
            } else {
                res.redirect('/admin');
            }
        });
    } else if (action === 'maintenance') {
        db.run(`UPDATE billiard_tables SET status='Maintenance' WHERE id=?`, [tableId], () => {
            broadcastTableUpdate();
            res.redirect('/admin');
        });
    } else if (action === 'available') {
        db.run(`UPDATE billiard_tables SET status='Available', current_customer=NULL, start_time=NULL WHERE id=?`, [tableId], () => {
            broadcastTableUpdate();
            res.redirect('/admin');
        });
    }
});

// Admin Payment Gateway & Processing
app.get('/admin/payment/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
    const tableId = req.params.id;
    const { amount, duration } = req.query;
    res.send(renderPaymentPage(tableId, amount, duration));
});

app.post('/admin/payment/process', (req, res) => {
    const { table_id, amount, payment_method, cash_paid } = req.body;
    const change = cash_paid ? parseFloat(cash_paid) - parseFloat(amount) : 0;
    
    db.run(`UPDATE sessions SET payment_method=? WHERE table_id=? AND status='Completed'`, 
        [payment_method, table_id], () => {
            res.send(renderReceiptPage(amount, payment_method, cash_paid, change));
        });
});

// Handle Customer Requests
app.post('/admin/request/:id/update', (req, res) => {
    const reqId = req.params.id;
    const { status } = req.body;
    db.run(`UPDATE customer_requests SET status=? WHERE id=?`, [status, reqId], () => {
        broadcastRequestsUpdate();
        res.redirect('/admin');
    });
});

// ==========================================
// 6. CUSTOMER PORTAL (`/customer`)
// ==========================================
app.get('/customer', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    db.all(`SELECT * FROM billiard_tables`, (err, tables) => {
        db.all(`SELECT * FROM reservations WHERE customer_name=?`, [req.session.user.name], (err2, reservations) => {
            res.send(renderCustomerPortal(req.session.user, tables, reservations));
        });
    });
});

// Customer QR Code Page
app.get('/customer/table/:id', (req, res) => {
    const tableId = req.params.id;
    db.get(`SELECT * FROM billiard_tables WHERE id=?`, [tableId], (err, table) => {
        res.send(renderCustomerTableQR(table));
    });
});

// Customer Assistance / Call Staff
app.post('/customer/request', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { table_id, request_type } = req.body;
    db.run(`INSERT INTO customer_requests (table_id, customer_name, request_type) VALUES (?, ?, ?)`,
        [table_id, req.session.user.name, request_type], () => {
            broadcastRequestsUpdate();
            res.send("<script>alert('Staff notified successfully!'); window.location='/customer';</script>");
        });
});

// Customer Online Booking / Reservation
app.post('/customer/reserve', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { table_id, date, start_time, end_time, players, notes } = req.body;
    db.run(`INSERT INTO reservations (customer_name, contact_number, table_id, date, start_time, end_time, players, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
        [req.session.user.name, req.session.user.phone, table_id, date, start_time, end_time, players, notes], () => {
            res.send("<script>alert('Reservation submitted successfully!'); window.location='/customer';</script>");
        });
});

// ==========================================
// 7. HTML TEMPLATES & FRONTEND UI ENGINE
// ==========================================

function renderAuthPage() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Login - Billiards Management System</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); width: 100%; max-width: 400px; border-top: 4px solid #10b981; }
            h2 { text-align: center; color: #10b981; margin-bottom: 24px; }
            label { display: block; margin-bottom: 8px; font-size: 14px; color: #94a3b8; }
            input { width: 100%; padding: 12px; margin-bottom: 20px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #10b981; border: none; color: white; font-weight: bold; border-radius: 6px; cursor: pointer; transition: 0.2s; }
            button:hover { background: #059669; }
            .links { text-align: center; margin-top: 15px; font-size: 14px; }
            .links a { color: #38bdf8; text-decoration: none; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>🎱 Cue Masters Sign In</h2>
            <form action="/login" method="POST">
                <label>Email Address</label>
                <input type="email" name="email" required placeholder="admin@billiards.com">
                <label>Password</label>
                <input type="password" name="password" required placeholder="••••••••">
                <button type="submit">Sign In</button>
            </form>
            <div class="links">
                Don't have an account? <a href="/register">Register here</a>
            </div>
        </div>
    </body>
    </html>`;
}

function renderRegisterPage() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Register - Billiards Management System</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); width: 100%; max-width: 400px; border-top: 4px solid #38bdf8; }
            h2 { text-align: center; color: #38bdf8; margin-bottom: 24px; }
            label { display: block; margin-bottom: 8px; font-size: 14px; color: #94a3b8; }
            input { width: 100%; padding: 10px; margin-bottom: 15px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #38bdf8; border: none; color: #0f172a; font-weight: bold; border-radius: 6px; cursor: pointer; }
            .links { text-align: center; margin-top: 15px; font-size: 14px; }
            .links a { color: #10b981; text-decoration: none; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>🎱 Customer Registration</h2>
            <form action="/register" method="POST">
                <label>Full Name</label>
                <input type="text" name="name" required placeholder="Juan Dela Cruz">
                <label>Email Address</label>
                <input type="email" name="email" required placeholder="juan@gmail.com">
                <label>Phone Number</label>
                <input type="text" name="phone" required placeholder="09123456789">
                <label>Password</label>
                <input type="password" name="password" required placeholder="••••••••">
                <button type="submit">Create Account</button>
            </form>
            <div class="links">
                Already have an account? <a href="/login">Sign In</a>
            </div>
        </div>
    </body>
    </html>`;
}

function renderAdminDashboard(tables, requests, todayStats, reservations) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Owner Dashboard - Billiards System</title>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0b0f19; color: #f8fafc; margin: 0; padding: 0; }
            header { background: #1e293b; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
            h1 { margin: 0; color: #10b981; font-size: 22px; }
            .container { padding: 30px 40px; max-width: 1400px; margin: auto; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
            .stat-card { background: #1e293b; padding: 20px; border-radius: 10px; border-left: 4px solid #10b981; }
            .stat-card h3 { margin: 0 0 10px 0; color: #94a3b8; font-size: 14px; }
            .stat-card p { margin: 0; font-size: 24px; font-weight: bold; }
            .tables-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 25px; margin-bottom: 30px; }
            .table-card { background: #1e293b; border-radius: 12px; padding: 25px; border: 1px solid #334155; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
            .badge { display: inline-block; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
            .badge-available { background: #065f46; color: #34d399; }
            .badge-playing { background: #7f1d1d; color: #fca5a5; }
            .badge-maintenance { background: #78350f; color: #fde68a; }
            .btn { padding: 10px 16px; border-radius: 6px; border: none; font-weight: bold; cursor: pointer; margin-right: 8px; margin-top: 10px; }
            .btn-start { background: #10b981; color: white; }
            .btn-end { background: #ef4444; color: white; }
            .btn-maint { background: #f59e0b; color: white; }
            .requests-section { background: #1e293b; padding: 25px; border-radius: 12px; margin-top: 30px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; }
            th { color: #94a3b8; font-size: 13px; }
            a.logout { color: #ef4444; text-decoration: none; font-weight: bold; }
        </style>
    </head>
    <body>
        <header>
            <h1>🎱 Cue Masters Owner Dashboard (2 Tables Active)</h1>
            <div>
                <a href="/customer" target="_blank" style="color: #38bdf8; margin-right: 20px; text-decoration: none;">Customer Portal ↗</a>
                <a href="/logout" class="logout">Logout</a>
            </div>
        </header>

        <div class="container">
            <div class="stats-grid">
                <div class="stat-card">
                    <h3>Today's Revenue</h3>
                    <p>₱${todayStats && todayStats.rev ? todayStats.rev.toFixed(2) : '0.00'}</p>
                </div>
                <div class="stat-card" style="border-left-color: #38bdf8;">
                    <h3>Today's Sessions</h3>
                    <p>${todayStats && todayStats.sessions ? todayStats.sessions : 0}</p>
                </div>
                <div class="stat-card" style="border-left-color: #f59e0b;">
                    <h3>Playing Hours</h3>
                    <p>${todayStats && todayStats.hours ? todayStats.hours.toFixed(1) : '0.0'} hrs</p>
                </div>
                <div class="stat-card" style="border-left-color: #a855f7;">
                    <h3>Pending Reservations</h3>
                    <p>${reservations.length}</p>
                </div>
            </div>

            <h2>🎱 Table Management</h2>
            <div class="tables-grid" id="tablesContainer">
                ${tables.map(t => `
                    <div class="table-card">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <h2 style="margin:0;">${t.name}</h2>
                            <span class="badge badge-${t.status.toLowerCase()}">${t.status}</span>
                        </div>
                        <p style="color: #94a3b8; margin: 10px 0;">Hourly Rate: ₱${t.hourly_rate}</p>
                        ${t.status === 'Playing' ? `
                            <p><strong>Customer:</strong> ${t.current_customer}</p>
                            <p><strong>Started:</strong> ${new Date(t.start_time).toLocaleTimeString()}</p>
                            <p><strong>Elapsed Time:</strong> <span class="live-timer" data-start="${t.start_time}">Calculating...</span></p>
                            <form action="/admin/table/${t.id}/action" method="POST" style="display:inline;">
                                <input type="hidden" name="action" value="end">
                                <button type="submit" class="btn btn-end">End Session & Pay</button>
                            </form>
                        ` : `
                            <form action="/admin/table/${t.id}/action" method="POST" style="margin-top: 15px;">
                                <input type="hidden" name="action" value="start">
                                <input type="text" name="customer_name" placeholder="Customer Name" required style="padding: 8px; background: #0f172a; border: 1px solid #334155; color: white; border-radius: 4px; margin-right: 5px;">
                                <button type="submit" class="btn btn-start">Start Session</button>
                            </form>
                        `}
                        <div style="margin-top: 15px;">
                            <form action="/admin/table/${t.id}/action" method="POST" style="display:inline;">
                                <input type="hidden" name="action" value="${t.status === 'Maintenance' ? 'available' : 'maintenance'}">
                                <button type="submit" class="btn btn-maint">${t.status === 'Maintenance' ? 'Set Available' : 'Maintenance'}</button>
                            </form>
                            <a href="/customer/table/${t.id}" target="_blank" class="btn" style="background: #334155; color: white; text-decoration: none; display:inline-block;">View QR / Page</a>
                        </div>
                    </div>
                `).join('')}
            </div>

            <div class="requests-section">
                <h2>🔔 Live Customer Assistance Requests</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Table</th>
                            <th>Customer Name</th>
                            <th>Request</th>
                            <th>Time</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody id="requestsTable">
                        ${requests.length === '0' ? `<tr><td colspan="5" style="text-align:center; color:#94a3b8;">No active requests</td></tr>` : 
                        requests.map(r => `
                            <tr>
                                <td>Table ${r.table_id}</td>
                                <td>${r.customer_name}</td>
                                <td><span style="color: #f59e0b; font-weight: bold;">${r.request_type}</span></td>
                                <td>${new Date(r.created_at).toLocaleTimeString()}</td>
                                <td>
                                    <form action="/admin/request/${r.id}/update" method="POST">
                                        <input type="hidden" name="status" value="Completed">
                                        <button type="submit" class="btn btn-start" style="padding: 5px 10px; font-size: 12px;">Mark Resolved</button>
                                    </form>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <script>
            const socket = io();
            socket.on('table_update', (tables) => {
                location.reload(); // Simple live refresh sync
            });
            socket.on('requests_update', (reqs) => {
                location.reload();
            });

            // Live Timer Calculator
            setInterval(() => {
                document.querySelectorAll('.live-timer').forEach(el => {
                    const start = new Date(el.getAttribute('data-start'));
                    const now = new Date();
                    const diff = Math.floor((now - start) / 1000);
                    const hrs = String(Math.floor(diff / 3600)).padStart(2, '0');
                    const mins = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
                    const secs = String(diff % 60).padStart(2, '0');
                    el.innerText = \`\${hrs}:\${mins}:\${secs}\`;
                });
            }, 1000);
        </script>
    </body>
    </html>`;
}

function renderPaymentPage(tableId, amount, duration) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Payment Gateway</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 40px; border-radius: 12px; width: 400px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border-top: 4px solid #10b981; }
            h2 { color: #10b981; text-align: center; }
            .amount { font-size: 32px; font-weight: bold; text-align: center; margin: 20px 0; color: #38bdf8; }
            label { display: block; margin-bottom: 8px; color: #94a3b8; }
            select, input { width: 100%; padding: 12px; margin-bottom: 20px; background: #0f172a; border: 1px solid #334155; color: white; border-radius: 6px; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #10b981; border: none; color: white; font-weight: bold; border-radius: 6px; cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>💰 Process Payment</h2>
            <p style="text-align:center; color:#94a3b8;">Duration: ${Math.floor(duration/60)}h ${duration%60}m</p>
            <div class="amount">₱${parseFloat(amount).toFixed(2)}</div>
            <form action="/admin/payment/process" method="POST">
                <input type="hidden" name="table_id" value="${tableId}">
                <input type="hidden" name="amount" value="${amount}">
                <label>Payment Method</label>
                <select name="payment_method" id="payMethod" onchange="toggleCash()">
                    <option value="Cash">Cash</option>
                    <option value="GCash">GCash</option>
                </select>
                <div id="cashBox">
                    <label>Cash Paid (₱)</label>
                    <input type="number" step="any" name="cash_paid" placeholder="500">
                </div>
                <button type="submit">Complete & Print Receipt</button>
            </form>
        </div>
        <script>
            function toggleCash() {
                const method = document.getElementById('payMethod').value;
                document.getElementById('cashBox').style.display = method === 'Cash' ? 'block' : 'none';
            }
        </script>
    </body>
    </html>`;
}

function renderReceiptPage(amount, method, paid, change) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Digital Receipt</title>
        <style>
            body { font-family: monospace; background: #f1f5f9; color: #0f172a; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .receipt { background: white; padding: 30px; width: 320px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); border-radius: 8px; }
            h2 { text-align: center; margin-bottom: 5px; }
            .center { text-align: center; color: #64748b; font-size: 12px; margin-bottom: 20px; }
            .line { border-bottom: 1px dashed #cbd5e1; margin: 15px 0; }
            .row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
            button { width: 100%; padding: 10px; background: #0f172a; color: white; border: none; border-radius: 4px; margin-top: 15px; cursor: pointer; }
        </style>
    </head>
    <body>
        <div class="receipt">
            <h2>CUE MASTERS BILLIARDS</h2>
            <div class="center">Official Digital Receipt<br>${new Date().toLocaleString()}</div>
            <div class="line"></div>
            <div class="row"><span>Total Amount:</span> <strong>₱${parseFloat(amount).toFixed(2)}</strong></div>
            <div class="row"><span>Payment Method:</span> <strong>${method}</strong></div>
            ${method === 'Cash' ? `
                <div class="row"><span>Cash Paid:</span> ₱${parseFloat(paid).toFixed(2)}</div>
                <div class="row"><span>Change:</span> <strong>₱${parseFloat(change).toFixed(2)}</strong></div>
            ` : ''}
            <div class="line"></div>
            <div class="center">Thank you for playing!<br>Come again soon.</div>
            <button onclick="window.location='/admin'">Back to Admin Dashboard</button>
        </div>
    </body>
    </html>`;
}

function renderCustomerPortal(user, tables, reservations) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Customer Portal - Cue Masters</title>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; }
            header { background: #1e293b; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
            .container { padding: 30px 40px; max-width: 1200px; margin: auto; }
            .card { background: #1e293b; padding: 25px; border-radius: 12px; margin-bottom: 25px; border: 1px solid #334155; }
            .tables-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
            .table-box { background: #0f172a; padding: 20px; border-radius: 8px; border-left: 4px solid #38bdf8; }
            .btn { padding: 10px 16px; background: #38bdf8; color: #0f172a; font-weight: bold; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; margin-top: 10px; }
            input, select { width: 100%; padding: 10px; margin: 8px 0 15px 0; background: #0f172a; border: 1px solid #334155; color: white; border-radius: 6px; box-sizing: border-box; }
        </style>
    </head>
    <body>
        <header>
            <h2>🎱 Welcome, ${user.name} (Customer Portal)</h2>
            <a href="/logout" style="color: #ef4444; text-decoration: none; font-weight: bold;">Logout</a>
        </header>

        <div class="container">
            <div class="card">
                <h3>🎱 Live Billiard Table Status</h3>
                <div class="tables-grid">
                    ${tables.map(t => `
                        <div class="table-box">
                            <h4>${t.name}</h4>
                            <p>Status: <strong style="color: ${t.status === 'Available' ? '#34d399' : '#fca5a5'}">${t.status}</strong></p>
                            <p>Rate: ₱${t.hourly_rate}/hour</p>
                            <a href="/customer/table/${t.id}" class="btn">View Table / QR Page</a>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="card">
                <h3>📅 Book / Reserve a Table</h3>
                <form action="/customer/reserve" method="POST">
                    <label>Select Table</label>
                    <select name="table_id">
                        ${tables.map(t => `<option value="${t.id}">${t.name} (₱${t.hourly_rate}/hr)</option>`).join('')}
                    </select>
                    <label>Date</label>
                    <input type="date" name="date" required>
                    <label>Start Time</label>
                    <input type="time" name="start_time" required>
                    <label>End Time</label>
                    <input type="time" name="end_time" required>
                    <label>Number of Players</label>
                    <input type="number" name="players" value="2" min="1" max="6">
                    <label>Optional Notes</label>
                    <input type="text" name="notes" placeholder="e.g. Cue stick preference">
                    <button type="submit" class="btn" style="width:100%;">Confirm Reservation</button>
                </form>
            </div>
        </div>

        <script>
            const socket = io();
            socket.on('table_update', () => location.reload());
        </script>
    </body>
    </html>`;
}

function renderCustomerTableQR(table) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>${table.name} - Quick Access</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 40px; border-radius: 12px; text-align: center; width: 380px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border-top: 4px solid #38bdf8; }
            h2 { color: #38bdf8; margin-top: 0; }
            .status { font-size: 18px; font-weight: bold; margin: 15px 0; color: ${table.status === 'Available' ? '#34d399' : '#fca5a5'}; }
            .btn { width: 100%; padding: 12px; background: #ef4444; color: white; border: none; font-weight: bold; border-radius: 6px; cursor: pointer; margin-top: 10px; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>🎱 ${table.name}</h2>
            <div class="status">Status: ${table.status}</div>
            <p>Hourly Rate: ₱${table.hourly_rate}</p>
            <hr style="border-color: #334155; margin: 20px 0;">
            <h3>🆘 Call Staff / Assistance</h3>
            <form action="/customer/request" method="POST">
                <input type="hidden" name="table_id" value="${table.id}">
                <select name="request_type" style="width:150px; padding:10px; background:#0f172a; color:white; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">
                    <option value="Need assistance">Need assistance</option>
                    <option value="Need table cleaned">Need table cleaned</option>
                    <option value="Need equipment assistance">Need equipment assistance</option>
                    <option value="Ready to end session">Ready to end session</option>
                </select><br>
                <button type="submit" class="btn">🔔 CALL STAFF NOW</button>
            </form>
            <a href="/customer" style="display:block; margin-top:20px; color:#38bdf8; text-decoration:none;">← Back to Customer Portal</a>
        </div>
    </body>
    </html>`;
}

// ==========================================
// 8. SERVER START
// ==========================================
server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🎱 Cue Masters Billiards Management System Active!`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`👉 Admin Login: http://localhost:${PORT}/login (admin@billiards.com / admin123)`);
    console.log(`==================================================`);
});
