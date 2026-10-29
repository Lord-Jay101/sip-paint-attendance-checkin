const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const {
  initDatabase,
  findGuestByName,
  findGuestsByExactName,
  guestIsCheckedInForEvent,
  findGuestById,
  checkInGuest,
  firstNameFrom,
  suggestGuestsByNamePrefix,
  addGuest,
  importGuests,
  getAllGuests,
  getGuestCount,
  getAttendanceStats,
  setGuestSeated,
  updateGuest,
  deleteGuest,
  bulkCheckIn,
  bulkCheckOut,
  bulkDeleteGuests,
  getConferenceSettings,
  saveConferenceSettings,
  currentConference,
  findAttendance,
  checkOutGuest,
  EVENT_CAPACITY,
  normalizePackage,
  listPackages,
  createPackage,
  updatePackage,
  deactivatePackage,
  addPackageItem,
  renamePackageItem,
  deactivatePackageItem,
  getGuestDistribution,
  setGuestItemReceived
} = require('./database');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2024';
const EVENT_NAME = process.env.EVENT_NAME || 'Sip & Paint';
const EVENT_DETAILS = {
  presenter: 'Vibe Curators',
  subtitle: 'The Upper Echelon',
  theme: 'Tequila Sunrise',
  venue: 'Delicacy Treats, Maseru East',
  dateLabel: '24 October',
  hosts: ['Delicacy Treats', "Let's Chill"],
  contacts: { whatsapp: '57279252', phone: '69295354' },
  packages: [
    { id: 'silver', name: 'Silver', price: 'M800' },
    { id: 'gold', name: 'Gold', price: 'M1,100' },
    { id: 'platinum', name: 'Platinum', price: 'M1,300' }
  ]
};
const adminSessions = new Map(); // token -> expiry

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter(req, file, cb) {
    const name = (file.originalname || '').toLowerCase();
    const ok =
      name.endsWith('.xlsx') ||
      name.endsWith('.xls') ||
      name.endsWith('.csv') ||
      (file.mimetype && /spreadsheet|excel|csv|octet-stream/.test(file.mimetype));
    if (ok) cb(null, true);
    else cb(new Error('Please upload an Excel (.xlsx, .xls) or CSV file.'));
  }
});

function createAdminToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized. Admin access required.' });
  }
  if (Date.now() > adminSessions.get(token)) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
  next();
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  // Practical validation — rejects empty / obvious junk without being overly strict
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254;
}

function conferenceError(state) {
  if (!state || !state.configured) return 'Event dates have not been configured.';
  if (state.phase === 'before') return 'Check-in opens on 24 October.';
  if (state.phase === 'after') return 'Sip & Paint has ended.';
  return 'Attendance can only be recorded on the event day.';
}

const PACKAGE_NAMES = { silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };

function welcomeMessage(name, guestPackage, packageName) {
  const known = PACKAGE_NAMES[guestPackage];
  const unchangedLegacy = known && (!packageName || packageName === known);
  const packageLabel = unchangedLegacy
    ? `${known} package`
    : (packageName || guestPackage || 'package');
  return `Welcome, ${name}.\n\nYour ${packageLabel} is waiting for you.\n\nEnjoy the event.`;
}

function guestHasBookedPackage(guest) {
  return !!(guest && (guest.package_id || (guest.package && String(guest.package).trim())));
}

function packagesMatch(guest, chosen) {
  const chosenText = String(chosen || '').trim();
  if (!chosenText || !guest) return false;
  const chosenId = /^\d+$/.test(chosenText) ? parseInt(chosenText, 10) : null;
  if (chosenId && guest.package_id && chosenId === Number(guest.package_id)) return true;
  const chosenKey = normalizePackage(chosenText);
  const guestKey = normalizePackage(guest.package);
  if (chosenKey && guestKey && chosenKey === guestKey) return true;
  if (guest.package_name && chosenText.toLowerCase() === String(guest.package_name).toLowerCase()) return true;
  if (guest.package && chosenText.toLowerCase() === String(guest.package).toLowerCase()) return true;
  return false;
}

function sendPackageError(res, err, fallback) {
  if (err && err.message === 'BAD_NAME') return res.status(400).json({ error: 'Enter a name (80 characters or fewer).' });
  if (err && err.message === 'DUPLICATE') return res.status(409).json({ error: 'That name is already in use.' });
  if (err && err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Not found.' });
  if (err && err.message === 'WRONG_PACKAGE') {
    return res.status(400).json({ error: "That item is not part of this guest's package." });
  }
  return res.status(500).json({ error: fallback });
}

function formatCheckInTime(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  } catch {
    return iso;
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
initDatabase();

// Public event info (no sensitive data)
app.get('/api/event', (req, res) => {
  try {
    const conference = currentConference();
    const stats = getAttendanceStats();
    const livePackages = listPackages({ activeOnly: true }).map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      price: pkg.price
    }));
    res.json({
      name: EVENT_NAME,
      ...EVENT_DETAILS,
      packages: livePackages.length ? livePackages : EVENT_DETAILS.packages,
      capacity: EVENT_CAPACITY,
      booked: stats.rsvp,
      spotsLeft: stats.spotsLeft,
      conference: {
        configured: conference.configured,
        startDate: conference.startDate || null,
        endDate: conference.endDate || null,
        dayCount: conference.dayCount || 0,
        days: conference.days || [],
        today: conference.today,
        currentDate: conference.currentDate,
        currentDay: conference.currentDay,
        phase: conference.phase,
        available: conference.available
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to load event information.' });
  }
});

app.get('/api/admin/conference-settings', requireAdmin, (req, res) => {
  try {
    res.json(getConferenceSettings());
  } catch (err) {
    res.status(500).json({ error: 'Unable to load conference settings.' });
  }
});

app.put('/api/admin/conference-settings', requireAdmin, (req, res) => {
  try {
    const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate.trim() : '';
    const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate.trim() : '';
    const saved = saveConferenceSettings(startDate, endDate);
    if (!saved.ok) return res.status(400).json({ error: saved.error });
    res.json({ success: true, settings: saved });
  } catch (err) {
    res.status(500).json({ error: 'Unable to save conference settings.' });
  }
});

/**
 * Name autocomplete for check-in (min 4 characters).
 * Matches the start of a first or last name. Returns names only.
 */
app.get('/api/check-in/suggest', (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 4) {
      return res.json({ suggestions: [] });
    }
    const suggestions = suggestGuestsByNamePrefix(q);
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ suggestions: [] });
  }
});

/**
 * Guest name lookup — does NOT record attendance yet.
 * Outcomes: found | already_checked_in | not_found | validation error
 */
app.post('/api/check-in', (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    if (!name) {
      return res.status(400).json({
        status: 'error',
        error: 'Please enter your name.'
      });
    }
    if (name.length < 2) {
      return res.status(400).json({
        status: 'error',
        error: 'Please enter your full name.'
      });
    }

    const guest = findGuestByName(name);
    if (!guest) {
      return res.json({
        status: 'not_found',
        message: "We couldn't find your booking. Please check the name on your RSVP or speak to the Delicacy Treats team."
      });
    }

    const conference = currentConference();
    const todayRecord = conference.currentDate ? findAttendance(guest.id, conference.currentDate) : null;
    if (!normalizePackage(guest.package)) {
      return res.json({
        status: 'error',
        error: 'This booking has no package yet. Please speak to the door team.'
      });
    }

    if (todayRecord) {
      const requestedId = parseInt(req.body?.id, 10);
      const payload = {
        status: 'already_checked_in',
        id: guest.id,
        name: guest.name,
        firstName: firstNameFrom(guest.name),
        package: guest.package,
        checkedInAt: todayRecord.checked_in_at,
        checkedInAtDisplay: formatCheckInTime(todayRecord.checked_in_at),
        message: welcomeMessage(guest.name, guest.package, guest.package_name)
      };
      if (requestedId === guest.id && guestIsCheckedInForEvent(guest.id)) {
        payload.dashboardToken = issueGuestDashboardToken(guest.id);
      }
      return res.json(payload);
    }

    return res.json({
      status: 'found',
      id: guest.id,
      name: guest.name,
      firstName: firstNameFrom(guest.name),
      package: guest.package,
      message: welcomeMessage(guest.name, guest.package, guest.package_name)
    });
  } catch (err) {
    console.error('Check-in lookup error:', err.message);
    res.status(500).json({
      status: 'error',
      error: 'Something went wrong. Please try again or speak to the door team.'
    });
  }
});

/**
 * Confirm attendance — records check-in after guest verifies on the result page.
 * Requires matching id + name to prevent casual ID guessing.
 */
app.post('/api/check-in/confirm', (req, res) => {
  try {
    const id = parseInt(req.body?.id, 10);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    if (!id || !name) {
      return res.status(400).json({
        status: 'error',
        error: 'Unable to confirm. Please go back and try again.'
      });
    }

    const guest = findGuestById(id);
    if (!guest || guest.name.trim().toLowerCase() !== name.toLowerCase()) {
      return res.json({
        status: 'not_found',
        message: "We couldn't find your booking. Please speak to the door team."
      });
    }

    if (!guestHasBookedPackage(guest)) {
      return res.status(400).json({
        status: 'error',
        error: 'This booking has no package yet. Please speak to the door team.'
      });
    }

    if (!String(req.body?.package || '').trim()) {
      return res.status(400).json({
        status: 'error',
        error: 'Please confirm the package you booked.'
      });
    }
    if (!packagesMatch(guest, req.body.package)) {
      return res.status(400).json({
        status: 'error',
        error: 'That package does not match this booking. Please speak to the door team.'
      });
    }

    const conference = currentConference();
    if (!conference.available) {
      return res.status(400).json({
        status: 'error',
        error: conferenceError(conference)
      });
    }

    const guestPackage = guest.package;
    const result = checkInGuest(guest.id, 'self', guestPackage, conference.currentDate);
    if (!result.ok && !result.alreadyCheckedIn) {
      return res.status(500).json({
        status: 'error',
        error: 'Unable to complete check-in. Please speak to the door team.'
      });
    }

    return res.json({
      status: result.alreadyCheckedIn ? 'already_checked_in' : 'checked_in',
      name: result.guest.name,
      firstName: firstNameFrom(result.guest.name),
      package: result.guest.package_id || guestPackage,
      checkedInAt: result.guest.checked_in_at,
      checkedInAtDisplay: formatCheckInTime(result.guest.checked_in_at),
      message: welcomeMessage(result.guest.name, result.guest.package || guestPackage, result.guest.package_name),
      dashboardToken: issueGuestDashboardToken(result.guest.id)
    });
  } catch (err) {
    console.error('Check-in confirm error:', err.message);
    res.status(500).json({
      status: 'error',
      error: 'Something went wrong. Please try again or speak to the door team.'
    });
  }
});

// Admin: login
app.post('/api/admin/login', (req, res) => {
  try {
    const { password } = req.body || {};
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password.' });
    }
    const token = createAdminToken();
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    adminSessions.set(token, expires);
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) adminSessions.delete(token);
  res.json({ success: true });
});

// Admin: list attendees + live stats
app.get('/api/guests', requireAdmin, (req, res) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const guests = getAllGuests(date);
    const count = getGuestCount();
    const stats = getAttendanceStats(date);
    res.json({ guests, count, stats });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    res.json(getAttendanceStats(date));
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Admin: manual check-in (requires password confirm)
app.post('/api/admin/check-in/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Invalid attendee ID.' });
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password. Action not confirmed.' });
    }

    const guest = findGuestById(id);
    if (!guest) return res.status(404).json({ error: 'Attendee not found.' });

    if (!guestHasBookedPackage(guest)) {
      return res.status(400).json({ error: 'Assign a package on this booking before check-in.' });
    }

    const result = checkInGuest(id, 'manual', guest.package, req.body.attendance_date);
    if (result.unavailable) {
      return res.status(400).json({ error: conferenceError(result.state) });
    }
    if (result.wrongDay) {
      return res.status(400).json({ error: 'Attendance can only be recorded on the event day.' });
    }
    if (result.alreadyCheckedIn) {
      return res.json({
        status: 'already_checked_in',
        guest: result.guest,
        checkedInAtDisplay: formatCheckInTime(result.guest.checked_in_at)
      });
    }
    if (!result.ok) {
      return res.status(500).json({ error: 'Failed to check in attendee.' });
    }

    res.json({
      status: 'checked_in',
      guest: result.guest,
      checkedInAtDisplay: formatCheckInTime(result.guest.checked_in_at)
    });
  } catch (err) {
    console.error('Admin check-in error:', err.message);
    res.status(500).json({ error: 'Failed to check in attendee.' });
  }
});

// Admin: check out (requires password confirm)
app.post('/api/admin/check-out/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Invalid attendee ID.' });
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password. Action not confirmed.' });
    }

    const guest = findGuestById(id);
    if (!guest) return res.status(404).json({ error: 'Attendee not found.' });

    const result = checkOutGuest(id, req.body.attendance_date);
    if (!result) return res.status(404).json({ error: 'Attendee not found.' });
    if (result.invalidDay) {
      return res.status(400).json({ error: 'That is not an event day.' });
    }
    if (!result.removed) {
      return res.json({
        status: 'not_checked_in',
        guest
      });
    }

    res.json({
      status: 'checked_out',
      guest: findGuestById(id)
    });
  } catch (err) {
    console.error('Admin check-out error:', err.message);
    res.status(500).json({ error: 'Failed to check out attendee.' });
  }
});

// Admin: bulk check-in / check-out / delete (requires password)
app.post('/api/admin/bulk', requireAdmin, (req, res) => {
  try {
    const { password, action, ids, attendance_date: attendanceDate } = req.body || {};
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password. Action not confirmed.' });
    }
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'Select at least one attendee.' });
    }
    const parsedIds = ids
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!parsedIds.length) {
      return res.status(400).json({ error: 'Select at least one attendee.' });
    }

    if (action === 'checkin') {
      const result = bulkCheckIn(parsedIds, attendanceDate);
      if (result.unavailable) return res.status(400).json({ error: conferenceError(result.state) });
      if (result.wrongDay) {
        return res.status(400).json({ error: 'Attendance can only be recorded on the event day.' });
      }
      return res.json({
        success: true,
        action: 'checkin',
        updated: result.updated,
        message: `Checked in ${result.updated} attendee${result.updated === 1 ? '' : 's'}.`
      });
    }
    if (action === 'checkout') {
      const result = bulkCheckOut(parsedIds, attendanceDate);
      if (result.invalidDay) return res.status(400).json({ error: 'That is not an event day.' });
      return res.json({
        success: true,
        action: 'checkout',
        updated: result.updated,
        message: `Checked out ${result.updated} attendee${result.updated === 1 ? '' : 's'}.`
      });
    }
    if (action === 'delete') {
      const result = bulkDeleteGuests(parsedIds);
      return res.json({
        success: true,
        action: 'delete',
        deleted: result.deleted,
        message: `Deleted ${result.deleted} attendee${result.deleted === 1 ? '' : 's'}.`
      });
    }
    return res.status(400).json({ error: 'Unknown bulk action.' });
  } catch (err) {
    console.error('Bulk action error:', err.message);
    res.status(500).json({ error: 'Bulk action failed.' });
  }
});

// Admin: set / clear attendance (password confirm)
app.patch('/api/guests/:id/seated', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password, seated } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Invalid attendee ID.' });
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password. Action not confirmed.' });
    }
    if (seated) {
      const result = checkInGuest(id, 'manual', null, req.body.attendance_date);
      if (result.unavailable) return res.status(400).json({ error: conferenceError(result.state) });
      if (result.wrongDay) {
        return res.status(400).json({ error: 'Attendance can only be recorded on the event day.' });
      }
      if (result.ok || result.alreadyCheckedIn) {
        return res.json({ success: true, guest: result.guest });
      }
      return res.status(404).json({ error: 'Attendee not found.' });
    }
    const ok = setGuestSeated(id, false, req.body.attendance_date);
    if (ok) res.json({ success: true });
    else res.status(404).json({ error: 'Attendee not found.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update.' });
  }
});

// Admin: update attendee name/email
app.patch('/api/guests/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password, name, email, package: guestPackage } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Invalid attendee ID.' });
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password. Action not confirmed.' });
    }
    if (email != null && email !== '' && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    try {
      const ok = updateGuest(id, { name, email, package: guestPackage });
      if (ok) res.json({ success: true, guest: findGuestById(id) });
      else res.status(404).json({ error: 'Attendee not found.' });
    } catch (e) {
      if (e.message === 'EMAIL_TAKEN') {
        return res.status(409).json({ error: 'That email is already on the guest list.' });
      }
      if (e.message === 'BAD_PACKAGE') {
        return res.status(400).json({ error: 'Choose a package from the list.' });
      }
      throw e;
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to update attendee.' });
  }
});

// Admin: delete attendee
app.delete('/api/guests/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Invalid attendee ID.' });
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password. Action not confirmed.' });
    }
    const ok = deleteGuest(id);
    if (ok) res.json({ success: true });
    else res.status(404).json({ error: 'Attendee not found.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete attendee.' });
  }
});

// Admin: add attendee to RSVP list (email optional — check-in is by name)
app.post('/api/guests', requireAdmin, (req, res) => {
  try {
    const { name, email, package: guestPackage } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (guestPackage == null || String(guestPackage).trim() === '') {
      return res.status(400).json({ error: 'Choose the package this guest paid for.' });
    }
    try {
      const guest = addGuest(name, 0, email || null, guestPackage || null);
      res.status(201).json(guest);
    } catch (e) {
      if (e.message === 'EMAIL_TAKEN') {
        return res.status(409).json({ error: 'That email is already on the guest list.' });
      }
      if (e.message === 'AT_CAPACITY') {
        return res.status(409).json({ error: 'Sip & Paint is limited to 50 guests.' });
      }
      if (e.message === 'BAD_PACKAGE') {
        return res.status(400).json({ error: 'Choose the package this guest paid for.' });
      }
      throw e;
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to add attendee.' });
  }
});

/**
 * Parse spreadsheet rows into { name, email? } entries.
 * Looks for Name / Full Name / Guest / Attendee columns; otherwise uses the first column.
 */
function extractGuestsFromSheet(workbook) {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (!rows.length) {
    // Fallback: treat as a single-column list with no header
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    return matrix
      .map((r) => ({ name: String(r[0] || '').trim() }))
      .filter((r) => r.name && !/^name$/i.test(r.name));
  }

  const keys = Object.keys(rows[0] || {});
  const findKey = (...candidates) =>
    keys.find((k) => candidates.some((c) => k.trim().toLowerCase() === c));

  const nameKey =
    findKey('name', 'full name', 'fullname name', 'guest', 'attendee', 'full_name') ||
    keys[0];
  const emailKey = findKey('email', 'email address', 'e-mail', 'mail');
  const packageKey = findKey('package', 'ticket', 'tier');

  return rows
    .map((row) => ({
      name: String(row[nameKey] || '').trim(),
      email: emailKey ? String(row[emailKey] || '').trim() : '',
      package: packageKey ? String(row[packageKey] || '').trim() : ''
    }))
    .filter((r) => r.name);
}

// Admin: import guests from Excel / CSV
app.post('/api/guests/import', requireAdmin, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    }
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Please choose an Excel or CSV file.' });
      }

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const entries = extractGuestsFromSheet(workbook);
      if (!entries.length) {
        return res.status(400).json({
          error: 'No guest names found. Use a column headed “Name”, or put one name per row.'
        });
      }

      const result = importGuests(entries);
      res.json({
        success: true,
        imported: result.imported,
        skipped: result.skipped,
        total: entries.length,
        message: `Imported ${result.imported} guest${result.imported === 1 ? '' : 's'}` +
          (result.skipped ? ` (${result.skipped} skipped — blank or already on the list)` : '') +
          (result.capacitySkipped ? `. ${result.capacitySkipped} left out because the event is limited to 50.` : '.')
      });
    } catch (e) {
      console.error('Import error:', e.message);
      res.status(500).json({ error: 'Could not read that spreadsheet. Please try again.' });
    }
  });
});

app.get('/api/packages', (req, res) => {
  try {
    const packages = listPackages({ activeOnly: true }).map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      price: pkg.price
    }));
    res.json({ packages });
  } catch (err) {
    res.status(500).json({ error: 'Unable to load packages.' });
  }
});

app.get('/api/admin/packages', requireAdmin, (req, res) => {
  try {
    res.json({ packages: listPackages({ activeOnly: true, withItems: true }) });
  } catch (err) {
    res.status(500).json({ error: 'Unable to load packages.' });
  }
});

app.post('/api/admin/packages', requireAdmin, (req, res) => {
  try {
    const pkg = createPackage(req.body?.name, req.body?.price);
    res.status(201).json({ success: true, package: pkg });
  } catch (err) {
    sendPackageError(res, err, 'Unable to add that package.');
  }
});

app.patch('/api/admin/packages/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid package.' });
    const pkg = updatePackage(id, { name: req.body?.name, price: req.body?.price });
    res.json({ success: true, package: pkg });
  } catch (err) {
    sendPackageError(res, err, 'Unable to update that package.');
  }
});

app.delete('/api/admin/packages/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid package.' });
    const ok = deactivatePackage(id);
    if (!ok) return res.status(404).json({ error: 'Package not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Unable to remove that package.' });
  }
});

app.post('/api/admin/packages/:id/items', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid package.' });
    const item = addPackageItem(id, req.body?.name);
    res.status(201).json({ success: true, item });
  } catch (err) {
    sendPackageError(res, err, 'Unable to add that item.');
  }
});

app.patch('/api/admin/package-items/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid item.' });
    const item = renamePackageItem(id, req.body?.name);
    res.json({ success: true, item });
  } catch (err) {
    sendPackageError(res, err, 'Unable to update that item.');
  }
});

app.delete('/api/admin/package-items/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid item.' });
    const ok = deactivatePackageItem(id);
    if (!ok) return res.status(404).json({ error: 'Item not found.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Unable to remove that item.' });
  }
});

app.get('/api/admin/guests/:id/distribution', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid guest.' });
    const distribution = getGuestDistribution(id);
    if (!distribution) return res.status(404).json({ error: 'Guest not found.' });
    res.json(distribution);
  } catch (err) {
    res.status(500).json({ error: 'Unable to load this guest\'s package.' });
  }
});

const guestDashboardSessions = new Map();
const GUEST_DASHBOARD_SESSION_MS = 8 * 60 * 60 * 1000;

function issueGuestDashboardToken(guestId) {
  const token = crypto.randomBytes(32).toString('hex');
  guestDashboardSessions.set(token, {
    guestId,
    expires: Date.now() + GUEST_DASHBOARD_SESSION_MS
  });
  return token;
}

function requireGuestDashboard(req, res, next) {
  const token = req.headers['x-guest-token'];
  const session = token ? guestDashboardSessions.get(token) : null;
  if (!session || Date.now() > session.expires) {
    if (token) guestDashboardSessions.delete(token);
    return res.status(401).json({
      code: 'session',
      error: 'Please verify your name again.'
    });
  }
  if (!guestIsCheckedInForEvent(session.guestId)) {
    guestDashboardSessions.delete(token);
    return res.status(403).json({
      code: 'revoked',
      error: "You haven't checked in yet. Please complete your check-in before accessing your dashboard."
    });
  }
  req.guestDashboardId = session.guestId;
  next();
}

app.post('/api/guest-dashboard/verify', (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Please enter your name.' });

    const matches = findGuestsByExactName(name);
    if (!matches.length) {
      return res.status(404).json({
        error: "We couldn't find your name in our guest records. Please check your spelling and try again."
      });
    }

    const checkedIn = matches.filter((guest) => guestIsCheckedInForEvent(guest.id));
    if (!checkedIn.length) {
      return res.status(403).json({
        error: "You haven't checked in yet. Please complete your check-in before accessing your dashboard."
      });
    }

    if (!String(req.body?.package || '').trim()) {
      return res.status(400).json({ error: 'Please confirm the package you booked.' });
    }

    const verified = checkedIn.filter((guest) => packagesMatch(guest, req.body.package));
    if (!verified.length) {
      return res.status(400).json({
        error: 'That package does not match this booking. Please try again.'
      });
    }
    if (verified.length > 1) {
      return res.status(409).json({
        error: 'We found more than one guest with these details. Please speak to the door team.'
      });
    }

    res.json({ success: true, token: issueGuestDashboardToken(verified[0].id) });
  } catch (err) {
    res.status(500).json({ error: 'Unable to verify your booking. Please try again.' });
  }
});

app.get('/api/guest-dashboard', requireGuestDashboard, (req, res) => {
  try {
    const distribution = getGuestDistribution(req.guestDashboardId);
    if (!distribution) {
      return res.status(401).json({ code: 'session', error: 'Please verify your name again.' });
    }
    res.json({
      name: distribution.guestName,
      packageName: distribution.packageName,
      items: distribution.items.map((item) => ({
        name: item.name,
        received: !!item.received
      })),
      receivedCount: distribution.receivedCount,
      total: distribution.total,
      complete: distribution.complete
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to load your package.' });
  }
});

app.put('/api/admin/guests/:id/items/:itemId', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    if (!id || !itemId) return res.status(400).json({ error: 'Invalid item.' });
    if (typeof req.body?.received !== 'boolean') {
      return res.status(400).json({ error: 'Say whether the item was received.' });
    }
    const distribution = setGuestItemReceived(id, itemId, req.body.received);
    res.json({ success: true, distribution });
  } catch (err) {
    sendPackageError(res, err, 'Unable to save that item.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`${EVENT_NAME} running at http://localhost:${PORT}`);
  console.log(`Guest check-in: http://localhost:${PORT}/`);
  console.log(`Admin:          http://localhost:${PORT}/admin.html`);
});

