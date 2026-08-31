const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Setup (SQLite file-based persistent DB)
const db = new Database('attendance_system.db');

// Enable WAL mode for high performance
db.pragma('journal_mode = WAL');

// Initialize Database Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    grade_level TEXT NOT NULL,
    section TEXT NOT NULL,
    gender TEXT NOT NULL,
    contact TEXT,
    email TEXT,
    address TEXT,
    photo_url TEXT,
    qr_code TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    event_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    location TEXT,
    attendance_type TEXT DEFAULT 'Both',
    status TEXT DEFAULT 'Active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    scan_date DATE NOT NULL,
    time_in TIME,
    time_out TIME,
    status TEXT NOT NULL DEFAULT 'Present',
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(event_id) REFERENCES events(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Insert Default Settings & Default Event if empty
const checkDefaultEvent = db.prepare('SELECT COUNT(*) as count FROM events').get();
if (checkDefaultEvent.count === 0) {
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT INTO events (name, description, event_date, start_time, end_time, location, attendance_type, status)
    VALUES ('General Attendance', 'Daily General Attendance', ?, '07:30', '17:00', 'Main Campus Gate', 'Both', 'Active')
  `).run(today);
}

const checkSettings = db.prepare('SELECT COUNT(*) as count FROM settings').get();
if (checkSettings.count === 0) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('school_name', 'Mabuhay Integrated High School')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('late_threshold_mins', '15')").run();
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// -------------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------------

// Admin Dashboard Summary API
app.get('/api/dashboard/summary', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const activeEvent = db.prepare("SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1").get();
  
  const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students').get().count;
  
  let presentToday = 0;
  let lateToday = 0;
  let absentToday = totalStudents;
  let recentScans = [];

  if (activeEvent) {
    presentToday = db.prepare(`
      SELECT COUNT(DISTINCT student_id) as count FROM attendance 
      WHERE event_id = ? AND status IN ('Present', 'Late')
    `).get(activeEvent.id).count;

    lateToday = db.prepare(`
      SELECT COUNT(DISTINCT student_id) as count FROM attendance 
      WHERE event_id = ? AND status = 'Late'
    `).get(activeEvent.id).count;

    absentToday = totalStudents - presentToday;

    recentScans = db.prepare(`
      SELECT a.*, s.full_name, s.grade_level, s.section, s.photo_url
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      WHERE a.event_id = ?
      ORDER BY a.id DESC LIMIT 8
    `).all(activeEvent.id);
  }

  const attendancePercentage = totalStudents > 0 ? ((presentToday / totalStudents) * 100).toFixed(1) : 0;

  res.json({
    totalStudents,
    presentToday,
    lateToday,
    absentToday: absentToday < 0 ? 0 : absentToday,
    attendancePercentage,
    activeEvent: activeEvent || null,
    recentScans
  });
});

// Students API
app.get('/api/students', (req, res) => {
  const students = db.prepare('SELECT * FROM students ORDER BY created_at DESC').all();
  res.json(students);
});

app.get('/api/students/:id', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  
  const history = db.prepare(`
    SELECT a.*, e.name as event_name 
    FROM attendance a 
    JOIN events e ON a.event_id = e.id 
    WHERE a.student_id = ? 
    ORDER BY a.id DESC
  `).all(req.params.id);

  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) as late,
      SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) as present
    FROM attendance WHERE student_id = ?
  `).get(req.params.id);

  res.json({ student, history, stats });
});

app.post('/api/students', async (req, res) => {
  try {
    const { id, first_name, middle_name, last_name, grade_level, section, gender, contact, email, address, photo_url } = req.body;
    
    if (!id || !first_name || !last_name || !grade_level || !section || !gender) {
      return res.status(400).json({ error: 'Please complete all required fields.' });
    }

    const exists = db.prepare('SELECT id FROM students WHERE id = ?').get(id);
    if (exists) return res.status(400).json({ error: 'Student ID already registered.' });

    const full_name = `${first_name} ${middle_name ? middle_name + ' ' : ''}${last_name}`;
    const qr_code = await QRCode.toDataURL(id, { margin: 1, width: 250 });

    const stmt = db.prepare(`
      INSERT INTO students (id, first_name, middle_name, last_name, full_name, grade_level, section, gender, contact, email, address, photo_url, qr_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, first_name, middle_name || '', last_name, full_name, grade_level, section, gender, contact || '', email || '', address || '', photo_url || '', qr_code);

    res.json({ success: true, message: 'Student registered successfully!', studentId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/students/:id', (req, res) => {
  db.prepare('DELETE FROM attendance WHERE student_id = ?').run(req.params.id);
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Student and attendance records deleted.' });
});

// Events API
app.get('/api/events', (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY event_date DESC, id DESC').all();
  res.json(events);
});

app.post('/api/events', (req, res) => {
  const { name, description, event_date, start_time, end_time, location, attendance_type, status } = req.body;
  
  if (status === 'Active') {
    db.prepare("UPDATE events SET status = 'Completed' WHERE status = 'Active'").run();
  }

  const stmt = db.prepare(`
    INSERT INTO events (name, description, event_date, start_time, end_time, location, attendance_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(name, description || '', event_date, start_time, end_time, location || 'School Campus', attendance_type || 'Both', status || 'Active');

  res.json({ success: true, message: 'Event created successfully!' });
});

app.put('/api/events/:id/status', (req, res) => {
  const { status } = req.body;
  if (status === 'Active') {
    db.prepare("UPDATE events SET status = 'Completed' WHERE status = 'Active'").run();
  }
  db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// QR Scanner Scan Endpoint
app.post('/api/scan', (req, res) => {
  const { studentId, eventId, scanType } = req.body; // scanType: 'IN' or 'OUT'
  
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) {
    return res.status(404).json({ success: false, code: 'INVALID_QR', message: 'Invalid QR Code. Student not found.' });
  }

  const event = eventId 
    ? db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) 
    : db.prepare("SELECT * FROM events WHERE status = 'Active' ORDER BY id DESC LIMIT 1").get();

  if (!event) {
    return res.status(400).json({ success: false, code: 'NO_ACTIVE_EVENT', message: 'No active event selected.' });
  }

  const today = new Date().toISOString().split('T')[0];
  const now = new Date();
  const timeString = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Check existing attendance record for today and this event
  let record = db.prepare('SELECT * FROM attendance WHERE student_id = ? AND event_id = ? AND scan_date = ?')
    .get(studentId, event.id, today);

  if (scanType === 'IN') {
    if (record && record.time_in) {
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_TIME_IN',
        student,
        message: `${student.full_name}, Time In was already recorded today.`
      });
    }

    // Determine Late status based on Event Start Time
    let status = 'Present';
    const [startH, startM] = event.start_time.split(':').map(Number);
    const eventStartTime = new Date();
    eventStartTime.setHours(startH, startM, 0, 0);

    // Late threshold (15 mins buffer)
    const lateThreshold = new Date(eventStartTime.getTime() + 15 * 60000);
    if (now > lateThreshold) {
      status = 'Late';
    }

    if (!record) {
      db.prepare(`
        INSERT INTO attendance (student_id, event_id, scan_date, time_in, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(studentId, event.id, today, timeString, status);
    } else {
      db.prepare('UPDATE attendance SET time_in = ?, status = ? WHERE id = ?')
        .run(timeString, status, record.id);
    }

    return res.json({
      success: true,
      action: 'Time In',
      student,
      time: timeString,
      status,
      message: `${student.full_name}, Time In recorded.`
    });
  } else if (scanType === 'OUT') {
    if (!record || !record.time_in) {
      return res.status(400).json({
        success: false,
        code: 'NO_TIME_IN',
        student,
        message: `${student.full_name}, you must Time In first before Time Out.`
      });
    }

    if (record.time_out) {
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_TIME_OUT',
        student,
        message: `${student.full_name}, Time Out was already recorded.`
      });
    }

    db.prepare('UPDATE attendance SET time_out = ? WHERE id = ?').run(timeString, record.id);

    return res.json({
      success: true,
      action: 'Time Out',
      student,
      time: timeString,
      status: record.status,
      message: `${student.full_name}, Time Out recorded.`
    });
  }
});

// Attendance Records API with Search & Filters
app.get('/api/attendance', (req, res) => {
  const { event_id, grade_level, section, status, search, date } = req.query;
  
  let query = `
    SELECT a.*, s.full_name, s.grade_level, s.section, e.name as event_name 
    FROM attendance a
    JOIN students s ON a.student_id = s.id
    JOIN events e ON a.event_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (event_id) { query += ' AND a.event_id = ?'; params.push(event_id); }
  if (grade_level) { query += ' AND s.grade_level = ?'; params.push(grade_level); }
  if (section) { query += ' AND s.section LIKE ?'; params.push(`%${section}%`); }
  if (status) { query += ' AND a.status = ?'; params.push(status); }
  if (date) { query += ' AND a.scan_date = ?'; params.push(date); }
  if (search) {
    query += ' AND (s.full_name LIKE ? OR s.id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY a.id DESC';
  const records = db.prepare(query).all(...params);
  res.json(records);
});

// -------------------------------------------------------------------
// FRONTEND HTML / UI CODE (Single Page Web Application)
// -------------------------------------------------------------------

app.get('/scanner', (req, res) => {
  res.send(getScannerHTML());
});

app.get('*', (req, res) => {
  res.send(getMainAppHTML());
});

// Start Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`QR Attendance System Running at: http://localhost:${PORT}`);
  console.log(`Scanner Portal URL: http://localhost:${PORT}/scanner`);
  console.log(`====================================================`);
});

// -------------------------------------------------------------------
// HTML TEMPLATES
// -------------------------------------------------------------------

function getMainAppHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Code Attendance & ID System</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css" rel="stylesheet">
  <style>
    :root { --sidebar-width: 260px; --primary: #1e3a8a; --accent: #2563eb; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background-color: #f8fafc; }
    #sidebar { width: var(--sidebar-width); position: fixed; top: 0; left: 0; height: 100vh; background: #0f172a; color: #fff; z-index: 1000; transition: all 0.3s; }
    #sidebar .nav-link { color: #94a3b8; padding: 12px 20px; font-weight: 500; border-radius: 8px; margin: 4px 12px; }
    #sidebar .nav-link:hover, #sidebar .nav-link.active { color: #fff; background: var(--accent); }
    #content { margin-left: var(--sidebar-width); padding: 30px; }
    .card-stat { border: none; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); }
    .badge-present { background: #dcfce7; color: #166534; }
    .badge-late { background: #fef9c3; color: #854d0e; }
    .badge-absent { background: #fee2e2; color: #991b1b; }

    /* A4 PRINTING CSS SPECIFIC FOR 8 IDs PER PAGE */
    @media print {
      body * { visibility: hidden; }
      #printArea, #printArea * { visibility: visible; }
      #printArea { position: absolute; left: 0; top: 0; width: 100%; }
      .no-print { display: none !important; }

      @page {
        size: A4 portrait;
        margin: 8mm;
      }

      .a4-grid {
        display: grid;
        grid-template-columns: repeat(2, 85.6mm);
        grid-template-rows: repeat(4, 53.9mm);
        gap: 6mm 10mm;
        justify-content: center;
        page-break-after: always;
      }

      .id-card-print {
        width: 85.6mm;
        height: 53.9mm;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        box-sizing: border-box;
        padding: 6px;
        background: #fff !important;
        -webkit-print-color-adjust: exact;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        position: relative;
        overflow: hidden;
      }
    }

    /* Screen ID Preview Card */
    .id-card {
      width: 320px;
      height: 200px;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      background: linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%);
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);
      padding: 12px;
      position: relative;
      display: inline-flex;
      flex-direction: column;
      justify-content: space-between;
    }
  </style>
</head>
<body>

  <!-- Sidebar -->
  <div id="sidebar">
    <div class="p-3 text-center border-bottom border-secondary">
      <h5 class="fw-bold mb-0 text-white"><i class="fa-solid fa-qrcode text-primary me-2"></i>QR Attendance</h5>
      <small class="text-muted">Admin Portal v1.0</small>
    </div>
    <ul class="nav flex-column mt-3">
      <li class="nav-item"><a href="#" class="nav-link active" onclick="showTab('dashboard')"><i class="fa-solid fa-chart-line me-2"></i>Dashboard</a></li>
      <li class="nav-item"><a href="#" class="nav-link" onclick="showTab('students')"><li class="fa-solid fa-user-graduate me-2"></i>Students</a></li>
      <li class="nav-item"><a href="#" class="nav-link" onclick="showTab('print-ids')"><i class="fa-solid fa-id-card me-2"></i>Print Student IDs</a></li>
      <li class="nav-item"><a href="#" class="nav-link" onclick="showTab('events')"><i class="fa-solid fa-calendar-days me-2"></i>Events</a></li>
      <li class="nav-item"><a href="#" class="nav-link" onclick="showTab('attendance')"><i class="fa-solid fa-clipboard-user me-2"></i>Attendance Records</a></li>
      <li class="nav-item"><a href="#" class="nav-link" onclick="showTab('reports')"><i class="fa-solid fa-file-invoice me-2"></i>Reports</a></li>
      <li class="nav-item mt-4"><a href="/scanner" target="_blank" class="nav-link bg-primary text-white"><i class="fa-solid fa-camera me-2"></i>Open Scanner Portal</a></li>
    </ul>
  </div>

  <!-- Content -->
  <div id="content">

    <!-- DASHBOARD TAB -->
    <div id="tab-dashboard" class="tab-content">
      <h3 class="fw-bold mb-4">Dashboard Overview</h3>
      <div class="row g-3 mb-4">
        <div class="col-md-3">
          <div class="card card-stat p-3 bg-white">
            <div class="text-muted small">Total Registered Students</div>
            <h2 class="fw-bold text-dark mb-0" id="dash-total-students">0</h2>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-stat p-3 bg-white border-start border-success border-4">
            <div class="text-muted small">Present Today</div>
            <h2 class="fw-bold text-success mb-0" id="dash-present">0</h2>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-stat p-3 bg-white border-start border-warning border-4">
            <div class="text-muted small">Late Students Today</div>
            <h2 class="fw-bold text-warning mb-0" id="dash-late">0</h2>
          </div>
        </div>
        <div class="col-md-3">
          <div class="card card-stat p-3 bg-white border-start border-danger border-4">
            <div class="text-muted small">Absent Students Today</div>
            <h2 class="fw-bold text-danger mb-0" id="dash-absent">0</h2>
          </div>
        </div>
      </div>

      <div class="row g-4">
        <div class="col-md-8">
          <div class="card border-0 shadow-sm p-3">
            <h5 class="fw-bold mb-3">Recent Live Scans</h5>
            <div class="table-responsive">
              <table class="table align-middle">
                <thead><tr><th>Student</th><th>Grade & Section</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
                <tbody id="dash-recent-table"></tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card border-0 shadow-sm p-3">
            <h5 class="fw-bold mb-3">Active Event</h5>
            <div id="active-event-card" class="p-3 bg-light rounded">Loading active event...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- STUDENTS TAB -->
    <div id="tab-students" class="tab-content d-none">
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold mb-0">Student Management</h3>
        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addStudentModal"><i class="fa-solid fa-plus me-1"></i> Add New Student</button>
      </div>
      <div class="card border-0 shadow-sm p-3">
        <div class="table-responsive">
          <table class="table table-hover align-middle">
            <thead>
              <tr><th>ID</th><th>Photo</th><th>Name</th><th>Grade Level</th><th>Section</th><th>Gender</th><th>Actions</th></tr>
            </thead>
            <tbody id="students-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- PRINT IDs TAB -->
    <div id="tab-print-ids" class="tab-content d-none">
      <div class="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h3 class="fw-bold mb-0">Printable Student IDs</h3>
          <small class="text-muted">A4 Layout formatted for exactly 8 IDs per page.</small>
        </div>
        <button class="btn btn-success" onclick="printSelectedIDs()"><i class="fa-solid fa-print me-1"></i> Print Selected IDs</button>
      </div>

      <div class="card border-0 shadow-sm p-3 mb-4">
        <div class="d-flex gap-3 align-items-center">
          <input type="checkbox" id="selectAllIds" onchange="toggleSelectAll(this)" class="form-check-input">
          <label for="selectAllIds" class="fw-bold">Select All Students</label>
        </div>
      </div>

      <div class="row g-3" id="id-cards-preview-container"></div>
    </div>

    <!-- EVENTS TAB -->
    <div id="tab-events" class="tab-content d-none">
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h3 class="fw-bold mb-0">Event Management</h3>
        <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#addEventModal"><i class="fa-solid fa-plus me-1"></i> Create Event</button>
      </div>
      <div class="card border-0 shadow-sm p-3">
        <table class="table align-middle">
          <thead><tr><th>Event Name</th><th>Date</th><th>Time</th><th>Location</th><th>Status</th><th>Action</th></tr></thead>
          <tbody id="events-table-body"></tbody>
        </table>
      </div>
    </div>

    <!-- ATTENDANCE RECORDS TAB -->
    <div id="tab-attendance" class="tab-content d-none">
      <h3 class="fw-bold mb-4">Attendance Records</h3>
      <div class="card border-0 shadow-sm p-3 mb-4">
        <div class="row g-2">
          <div class="col-md-3"><input type="text" id="att-search" class="form-control" placeholder="Search Student..." onkeyup="loadAttendanceRecords()"></div>
          <div class="col-md-2">
            <select id="att-grade" class="form-select" onchange="loadAttendanceRecords()">
              <option value="">All Grade Levels</option>
              <option value="Grade 7">Grade 7</option>
              <option value="Grade 8">Grade 8</option>
              <option value="Grade 9">Grade 9</option>
              <option value="Grade 10">Grade 10</option>
              <option value="Grade 11">Grade 11</option>
              <option value="Grade 12">Grade 12</option>
            </select>
          </div>
          <div class="col-md-2">
            <select id="att-status" class="form-select" onchange="loadAttendanceRecords()">
              <option value="">All Status</option>
              <option value="Present">Present</option>
              <option value="Late">Late</option>
            </select>
          </div>
          <div class="col-md-3"><input type="date" id="att-date" class="form-control" onchange="loadAttendanceRecords()"></div>
        </div>
      </div>
      <div class="card border-0 shadow-sm p-3">
        <table class="table align-middle">
          <thead><tr><th>Date</th><th>Student ID</th><th>Name</th><th>Grade & Section</th><th>Event</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>
          <tbody id="attendance-table-body"></tbody>
        </table>
      </div>
    </div>

    <!-- REPORTS TAB -->
    <div id="tab-reports" class="tab-content d-none">
      <h3 class="fw-bold mb-4">Attendance Reports</h3>
      <div class="card border-0 shadow-sm p-4 text-center">
        <h5>Export & Print Attendance Reports</h5>
        <p class="text-muted">Generate comprehensive reports filtered by date and event.</p>
        <div>
          <button class="btn btn-outline-primary me-2" onclick="window.print()"><i class="fa-solid fa-print me-1"></i> Print Current View</button>
          <button class="btn btn-success" onclick="exportCSV()"><i class="fa-solid fa-file-csv me-1"></i> Export to CSV</button>
        </div>
      </div>
    </div>

  </div>

  <!-- ADD STUDENT MODAL -->
  <div class="modal fade" id="addStudentModal" tabindex="-1">
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title fw-bold">Register Student</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
        <form id="addStudentForm" onsubmit="saveStudent(event)">
          <div class="modal-body row g-3">
            <div class="col-md-4"><label class="form-label">Student ID *</label><input type="text" id="stud_id" class="form-control" required placeholder="2026-0001"></div>
            <div class="col-md-4"><label class="form-label">First Name *</label><input type="text" id="stud_fn" class="form-control" required></div>
            <div class="col-md-4"><label class="form-label">Middle Name</label><input type="text" id="stud_mn" class="form-control"></div>
            <div class="col-md-4"><label class="form-label">Last Name *</label><input type="text" id="stud_ln" class="form-control" required></div>
            <div class="col-md-4">
              <label class="form-label">Grade Level *</label>
              <select id="stud_grade" class="form-select" required>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="Grade 9">Grade 9</option>
                <option value="Grade 10">Grade 10</option>
                <option value="Grade 11">Grade 11</option>
                <option value="Grade 12">Grade 12</option>
              </select>
            </div>
            <div class="col-md-4"><label class="form-label">Section *</label><input type="text" id="stud_section" class="form-control" required placeholder="STEM-A"></div>
            <div class="col-md-4">
              <label class="form-label">Gender *</label>
              <select id="stud_gender" class="form-select" required>
                <option value="Male">Male</option><option value="Female">Female</option>
              </select>
            </div>
            <div class="col-md-4"><label class="form-label">Contact Number</label><input type="text" id="stud_contact" class="form-control"></div>
            <div class="col-md-4"><label class="form-label">Email</label><input type="email" id="stud_email" class="form-control"></div>
            <div class="col-md-12"><label class="form-label">Photo URL (Optional)</label><input type="url" id="stud_photo" class="form-control" placeholder="https://via.placeholder.com/150"></div>
          </div>
          <div class="modal-footer"><button type="submit" class="btn btn-primary">Save & Generate QR</button></div>
        </form>
      </div>
    </div>
  </div>

  <!-- ADD EVENT MODAL -->
  <div class="modal fade" id="addEventModal" tabindex="-1">
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header"><h5 class="modal-title fw-bold">Create Event</h5><button class="btn-close" data-bs-dismiss="modal"></button></div>
        <form onsubmit="saveEvent(event)">
          <div class="modal-body row g-3">
            <div class="col-md-12"><label class="form-label">Event Name *</label><input type="text" id="ev_name" class="form-control" required placeholder="General Attendance"></div>
            <div class="col-md-6"><label class="form-label">Date *</label><input type="date" id="ev_date" class="form-control" required></div>
            <div class="col-md-3"><label class="form-label">Start Time *</label><input type="time" id="ev_start" class="form-control" required></div>
            <div class="col-md-3"><label class="form-label">End Time *</label><input type="time" id="ev_end" class="form-control" required></div>
            <div class="col-md-12"><label class="form-label">Location</label><input type="text" id="ev_location" class="form-control" placeholder="Gymnasium / Gate 1"></div>
          </div>
          <div class="modal-footer"><button type="submit" class="btn btn-primary">Create Event</button></div>
        </form>
      </div>
    </div>
  </div>

  <!-- Hidden Print Container -->
  <div id="printArea"></div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    let allStudents = [];

    document.addEventListener('DOMContentLoaded', () => {
      loadDashboard();
      loadStudents();
      loadEvents();
    });

    function showTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.add('d-none'));
      document.querySelectorAll('#sidebar .nav-link').forEach(el => el.classList.remove('active'));
      document.getElementById('tab-' + tabId).classList.remove('d-none');
      if (tabId === 'dashboard') loadDashboard();
      if (tabId === 'students') loadStudents();
      if (tabId === 'print-ids') renderIDPreviews();
      if (tabId === 'attendance') loadAttendanceRecords();
    }

    async function loadDashboard() {
      const res = await fetch('/api/dashboard/summary');
      const data = await res.json();
      document.getElementById('dash-total-students').innerText = data.totalStudents;
      document.getElementById('dash-present').innerText = data.presentToday;
      document.getElementById('dash-late').innerText = data.lateToday;
      document.getElementById('dash-absent').innerText = data.absentToday;

      const ev = data.activeEvent;
      document.getElementById('active-event-card').innerHTML = ev ? 
        \`<h6 class="fw-bold text-primary mb-1">\${ev.name}</h6>
         <p class="small text-muted mb-0"><i class="fa-regular fa-clock me-1"></i>\${ev.start_time} - \${ev.end_time}</p>
         <p class="small text-muted mb-0"><i class="fa-solid fa-location-dot me-1"></i>\${ev.location}</p>\` 
        : '<span class="text-danger">No active event set.</span>';

      const tbody = document.getElementById('dash-recent-table');
      tbody.innerHTML = data.recentScans.map(s => `
        <tr>
          <td><div class="fw-bold">\${s.full_name}</div><small class="text-muted">\${s.student_id}</small></td>
          <td>\${s.grade_level} - \${s.section}</td>
          <td>\${s.time_in || '-'}</td>
          <td>\${s.time_out || '-'}</td>
          <td><span class="badge \${s.status === 'Late' ? 'badge-late' : 'badge-present'}">\${s.status}</span></td>
        </tr>
      `).join('');
    }

    async function loadStudents() {
      const res = await fetch('/api/students');
      allStudents = await res.json();
      const tbody = document.getElementById('students-table-body');
      tbody.innerHTML = allStudents.map(s => `
        <tr>
          <td class="fw-bold">\${s.id}</td>
          <td><img src="\${s.photo_url || 'https://via.placeholder.com/40'}" class="rounded-circle" width="40" height="40"></td>
          <td>\${s.full_name}</td>
          <td>\${s.grade_level}</td>
          <td>\${s.section}</td>
          <td>\${s.gender}</td>
          <td>
            <button class="btn btn-sm btn-outline-danger" onclick="deleteStudent('\${s.id}')"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>
      `).join('');
    }

    async function saveStudent(e) {
      e.preventDefault();
      const body = {
        id: document.getElementById('stud_id').value,
        first_name: document.getElementById('stud_fn').value,
        middle_name: document.getElementById('stud_mn').value,
        last_name: document.getElementById('stud_ln').value,
        grade_level: document.getElementById('stud_grade').value,
        section: document.getElementById('stud_section').value,
        gender: document.getElementById('stud_gender').value,
        contact: document.getElementById('stud_contact').value,
        email: document.getElementById('stud_email').value,
        photo_url: document.getElementById('stud_photo').value
      };

      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        bootstrap.Modal.getInstance(document.getElementById('addStudentModal')).hide();
        loadStudents();
      } else {
        alert(data.error);
      }
    }

    async function deleteStudent(id) {
      if (!confirm('Are you sure you want to delete this student?')) return;
      await fetch('/api/students/' + id, { method: 'DELETE' });
      loadStudents();
    }

    function renderIDPreviews() {
      const container = document.getElementById('id-cards-preview-container');
      container.innerHTML = allStudents.map(s => `
        <div class="col-md-4">
          <div class="card p-2">
            <div class="d-flex align-items-center gap-2 mb-2">
              <input type="checkbox" class="form-check-input student-select-checkbox" value="\${s.id}">
              <span class="fw-bold text-truncate">\${s.full_name}</span>
            </div>
            <div class="id-card">
              <div class="d-flex justify-content-between align-items-center border-bottom pb-1">
                <span class="fw-bold text-primary" style="font-size: 11px;">MABUHAY INTEGRATED HS</span>
                <span class="badge bg-secondary" style="font-size: 9px;">STUDENT ID</span>
              </div>
              <div class="d-flex gap-2 my-1 align-items-center">
                <img src="\${s.photo_url || 'https://via.placeholder.com/60'}" width="55" height="55" class="rounded border">
                <div style="font-size: 11px;">
                  <div class="fw-bold text-dark">\${s.full_name}</div>
                  <div class="text-muted">ID: \${s.id}</div>
                  <div class="text-primary fw-semibold">\${s.grade_level} - \${s.section}</div>
                </div>
              </div>
              <div class="d-flex justify-content-between align-items-end border-top pt-1">
                <small class="text-muted" style="font-size: 8px;">SY 2026-2027</small>
                <img src="\${s.qr_code}" width="45" height="45">
              </div>
            </div>
          </div>
        </div>
      `).join('');
    }

    function toggleSelectAll(master) {
      document.querySelectorAll('.student-select-checkbox').forEach(cb => cb.checked = master.checked);
    }

    function printSelectedIDs() {
      const checkedIds = Array.from(document.querySelectorAll('.student-select-checkbox:checked')).map(cb => cb.value);
      const selectedStudents = allStudents.filter(s => checkedIds.includes(s.id));

      if (selectedStudents.length === 0) {
        alert('Please select at least one student to print IDs.');
        return;
      }

      const printArea = document.getElementById('printArea');
      printArea.innerHTML = '';

      // Split into chunks of 8 for exact A4 pages
      for (let i = 0; i < selectedStudents.length; i += 8) {
        const chunk = selectedStudents.slice(i, i + 8);
        const page = document.createElement('div');
        page.className = 'a4-grid';

        chunk.forEach(s => {
          page.innerHTML += `
            <div class="id-card-print">
              <div style="border-bottom: 1.5px solid #1e3a8a; padding-bottom: 2px; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 9px; font-weight: bold; color: #1e3a8a;">MABUHAY INTEGRATED HS</span>
                <span style="font-size: 7px; background: #e2e8f0; padding: 1px 4px; border-radius: 3px; font-weight: bold;">STUDENT</span>
              </div>
              <div style="display: flex; gap: 8px; margin: 4px 0; align-items: center;">
                <img src="\${s.photo_url || 'https://via.placeholder.com/50'}" style="width: 48px; height: 48px; border-radius: 4px; border: 1px solid #ccc; object-fit: cover;">
                <div style="font-size: 9px; line-height: 1.2;">
                  <div style="font-weight: bold; color: #0f172a;">\${s.full_name}</div>
                  <div style="color: #475569;">ID: \${s.id}</div>
                  <div style="color: #2563eb; font-weight: 600;">\${s.grade_level} - \${s.section}</div>
                </div>
              </div>
              <div style="border-top: 1px dashed #cbd5e1; padding-top: 2px; display: flex; justify-content: space-between; align-items: flex-end;">
                <span style="font-size: 7px; color: #64748b;">SY 2026-2027</span>
                <img src="\${s.qr_code}" style="width: 42px; height: 42px;">
              </div>
            </div>
          `;
        });
        printArea.appendChild(page);
      }

      window.print();
    }

    async function loadEvents() {
      const res = await fetch('/api/events');
      const events = await res.json();
      const tbody = document.getElementById('events-table-body');
      tbody.innerHTML = events.map(e => `
        <tr>
          <td class="fw-bold">\${e.name}</td>
          <td>\${e.event_date}</td>
          <td>\${e.start_time} - \${e.end_time}</td>
          <td>\${e.location}</td>
          <td><span class="badge \${e.status === 'Active' ? 'bg-success' : 'bg-secondary'}">\${e.status}</span></td>
          <td>
            \${e.status !== 'Active' ? `<button class="btn btn-sm btn-outline-primary" onclick="setActiveEvent(\${e.id})">Set Active</button>` : ''}
          </td>
        </tr>
      `).join('');
    }

    async function saveEvent(e) {
      e.preventDefault();
      const body = {
        name: document.getElementById('ev_name').value,
        event_date: document.getElementById('ev_date').value,
        start_time: document.getElementById('ev_start').value,
        end_time: document.getElementById('ev_end').value,
        location: document.getElementById('ev_location').value,
        status: 'Active'
      };
      await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      bootstrap.Modal.getInstance(document.getElementById('addEventModal')).hide();
      loadEvents();
    }

    async function setActiveEvent(id) {
      await fetch('/api/events/' + id + '/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Active' })
      });
      loadEvents();
    }

    async function loadAttendanceRecords() {
      const g = document.getElementById('att-grade').value;
      const s = document.getElementById('att-status').value;
      const d = document.getElementById('att-date').value;
      const q = document.getElementById('att-search').value;

      const res = await fetch(\`/api/attendance?grade_level=\${g}&status=\${s}&date=\${d}&search=\${q}\`);
      const data = await res.json();

      const tbody = document.getElementById('attendance-table-body');
      tbody.innerHTML = data.map(r => `
        <tr>
          <td>\${r.scan_date}</td>
          <td class="fw-bold">\${r.student_id}</td>
          <td>\${r.full_name}</td>
          <td>\${r.grade_level} - \${r.section}</td>
          <td>\${r.event_name}</td>
          <td>\${r.time_in || '-'}</td>
          <td>\${r.time_out || '-'}</td>
          <td><span class="badge \${r.status === 'Late' ? 'badge-late' : 'badge-present'}">\${r.status}</span></td>
        </tr>
      `).join('');
    }

    function exportCSV() {
      window.location.href = '/api/attendance';
    }
  </script>
</body>
</html>`;
}

// -------------------------------------------------------------------
// MOBILE SCANNER PORTAL HTML WITH HTML5-QRCODE & TTS SPEECH
// -------------------------------------------------------------------

function getScannerHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QR Attendance Scanner Portal</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css" rel="stylesheet">
  <script src="https://unpkg.com/html5-qrcode"></script>
  <style>
    body { background: #0f172a; color: #fff; font-family: system-ui, sans-serif; min-height: 100vh; }
    .scanner-card { background: #1e293b; border-radius: 16px; border: 1px solid #334155; }
    #reader { width: 100%; border-radius: 12px; overflow: hidden; background: #000; }
    .btn-mode { font-weight: bold; padding: 12px; border-radius: 10px; }
    .active-in { background: #22c55e !important; color: #fff !important; }
    .active-out { background: #ef4444 !important; color: #fff !important; }
    .result-card { display: none; background: #fff; color: #000; border-radius: 16px; padding: 20px; text-align: center; }
  </style>
</head>
<body class="p-3">

  <div class="container max-width-sm" style="max-width: 500px;">
    <!-- Header -->
    <div class="text-center my-3">
      <h4 class="fw-bold mb-0 text-white"><i class="fa-solid fa-qrcode text-primary me-2"></i>Attendance Scanner</h4>
      <small class="text-secondary">Mobile Portal</small>
    </div>

    <!-- Active Mode Selector -->
    <div class="row g-2 mb-3">
      <div class="col-6">
        <button id="btnTimeIn" class="btn btn-outline-success w-100 btn-mode active-in" onclick="setMode('IN')">
          <i class="fa-solid fa-right-to-bracket me-1"></i> TIME IN
        </button>
      </div>
      <div class="col-6">
        <button id="btnTimeOut" class="btn btn-outline-danger w-100 btn-mode" onclick="setMode('OUT')">
          <i class="fa-solid fa-right-from-bracket me-1"></i> TIME OUT
        </button>
      </div>
    </div>

    <!-- Scanner Box -->
    <div class="scanner-card p-3 mb-3">
      <div id="reader"></div>
      <div class="mt-3 text-center">
        <button id="btnStartScanner" class="btn btn-primary btn-sm" onclick="startCamera()"><i class="fa-solid fa-camera me-1"></i> Start Camera</button>
        <button id="btnStopScanner" class="btn btn-secondary btn-sm d-none" onclick="stopCamera()"><i class="fa-solid fa-pause me-1"></i> Stop Camera</button>
      </div>
    </div>

    <!-- Large Live Result Popup Display -->
    <div id="resultCard" class="result-card shadow-lg">
      <div id="resultStatusBadge" class="badge mb-2 p-2 fs-6"></div>
      <img id="resPhoto" src="" width="90" height="90" class="rounded-circle border mb-2" style="object-fit: cover;">
      <h4 id="resName" class="fw-bold mb-1"></h4>
      <p id="resDetails" class="text-muted mb-2 small"></p>
      <div id="resTime" class="fw-bold text-primary"></div>
    </div>
  </div>

  <script>
    let currentMode = 'IN';
    let html5QrCode = null;
    let isProcessing = false;

    function setMode(mode) {
      currentMode = mode;
      document.getElementById('btnTimeIn').className = 'btn w-100 btn-mode ' + (mode === 'IN' ? 'active-in' : 'btn-outline-success');
      document.getElementById('btnTimeOut').className = 'btn w-100 btn-mode ' + (mode === 'OUT' ? 'active-out' : 'btn-outline-danger');
    }

    function speak(text) {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); // Stop previous audio
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        window.speechSynthesis.speak(utterance);
      }
    }

    function startCamera() {
      html5QrCode = new Html5Qrcode("reader");
      html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        onScanSuccess
      ).then(() => {
        document.getElementById('btnStartScanner').classList.add('d-none');
        document.getElementById('btnStopScanner').classList.remove('d-none');
      }).catch(err => alert("Camera permission error: " + err));
    }

    function stopCamera() {
      if (html5QrCode) {
        html5QrCode.stop().then(() => {
          document.getElementById('btnStartScanner').classList.remove('d-none');
          document.getElementById('btnStopScanner').classList.add('d-none');
        });
      }
    }

    async function onScanSuccess(decodedText) {
      if (isProcessing) return;
      isProcessing = true;

      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ studentId: decodedText, scanType: currentMode })
        });

        const data = await res.json();
        const card = document.getElementById('resultCard');
        card.style.display = 'block';

        if (res.ok && data.success) {
          document.getElementById('resultStatusBadge').className = 'badge bg-success p-2 fs-6';
          document.getElementById('resultStatusBadge').innerText = '✓ ' + data.action.toUpperCase() + ' SUCCESS';
          document.getElementById('resPhoto').src = data.student.photo_url || 'https://via.placeholder.com/90';
          document.getElementById('resName').innerText = data.student.full_name;
          document.getElementById('resDetails').innerText = \`ID: \${data.student.id} | \${data.student.grade_level} - \${data.student.section}\`;
          document.getElementById('resTime').innerText = \`Time: \${data.time} (\${data.status})\`;

          speak(\`\${data.student.full_name}, \${data.action} recorded.\`);
        } else {
          document.getElementById('resultStatusBadge').className = 'badge bg-danger p-2 fs-6';
          document.getElementById('resultStatusBadge').innerText = '✕ SCAN WARNING / ERROR';
          document.getElementById('resPhoto').src = (data.student && data.student.photo_url) ? data.student.photo_url : 'https://via.placeholder.com/90';
          document.getElementById('resName').innerText = data.student ? data.student.full_name : 'Invalid QR Code';
          document.getElementById('resDetails').innerText = data.message;
          document.getElementById('resTime').innerText = '';

          speak(data.message || "Invalid QR Code.");
        }

        setTimeout(() => {
          card.style.display = 'none';
          isProcessing = false;
        }, 3500);

      } catch (err) {
        speak("Connection error.");
        isProcessing = false;
      }
    }

    // Auto start scanner on mobile launch
    window.addEventListener('load', () => {
      startCamera();
    });
  </script>
</body>
</html>`;
}
