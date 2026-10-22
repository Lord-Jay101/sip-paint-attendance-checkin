const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'guests.db');
const EVENT_CAPACITY = 50;
const EVENT_DATE = '2026-10-24';

function normalizePackage(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text.startsWith('silver')) return 'silver';
  if (text.startsWith('gold')) return 'gold';
  if (text.startsWith('plat')) return 'platinum';
  return null;
}

function getDb() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function eventTimeZone() {
  return (process.env.EVENT_TIMEZONE || 'Africa/Maseru').trim() || 'Africa/Maseru';
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function calendarDate(date, zone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function inclusiveDayCount(startDate, endDate) {
  const [ys, ms, ds] = startDate.split('-').map(Number);
  const [ye, me, de] = endDate.split('-').map(Number);
  return Math.round((Date.UTC(ye, me - 1, de) - Date.UTC(ys, ms - 1, ds)) / 86400000) + 1;
}

function formatLongDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function conferenceNow() {
  if (process.env.CONFERENCE_NOW) {
    const override = new Date(process.env.CONFERENCE_NOW);
    if (!Number.isNaN(override.getTime())) return override;
  }
  return new Date();
}

function dateOfTimestamp(value, zone) {
  if (!value) return null;
  const text = String(value).trim();
  let instant;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    instant = new Date(text.replace(' ', 'T') + 'Z');
  } else {
    instant = new Date(text);
  }
  if (Number.isNaN(instant.getTime())) return null;
  return calendarDate(instant, zone);
}

function validateConferenceDates(startDate, endDate) {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    return { ok: false, error: 'Both event dates are required.' };
  }
  if (endDate < startDate) {
    return { ok: false, error: 'End date cannot be before the start date.' };
  }
  const count = inclusiveDayCount(startDate, endDate);
  if (count < 1) return { ok: false, error: 'The event must include at least one day.' };
  if (count > 62) return { ok: false, error: 'The event cannot be longer than 62 days.' };
  return { ok: true, dayCount: count };
}

function listConferenceDays(startDate, endDate) {
  const count = inclusiveDayCount(startDate, endDate);
  const days = [];
  for (let i = 0; i < count; i += 1) {
    const date = addDays(startDate, i);
    days.push({
      day: i + 1,
      date,
      label: `Day ${i + 1} — ${formatLongDate(date)}`
    });
  }
  return days;
}

function describeConference(settings, now) {
  const zone = eventTimeZone();
  const today = calendarDate(now || conferenceNow(), zone);
  const startDate = settings && settings.startDate;
  const endDate = settings && settings.endDate;
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate) {
    return {
      configured: false,
      timeZone: zone,
      today,
      days: [],
      phase: 'unconfigured',
      currentDate: null,
      currentDay: null,
      available: false
    };
  }
  const days = listConferenceDays(startDate, endDate);
  let phase = 'during';
  if (today < startDate) phase = 'before';
  else if (today > endDate) phase = 'after';
  const match = phase === 'during' ? days.find((day) => day.date === today) : null;
  return {
    configured: true,
    timeZone: zone,
    startDate,
    endDate,
    dayCount: days.length,
    days,
    today,
    phase,
    currentDate: match ? match.date : null,
    currentDay: match ? match.day : null,
    available: !!match
  };
}

function initDatabase() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      table_number INTEGER DEFAULT 0,
      seated INTEGER DEFAULT 0,
      email TEXT,
      checked_in_at DATETIME,
      check_in_method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_guests_name ON guests(name);
  `);

  const columns = db.prepare('PRAGMA table_info(guests)').all().map((c) => c.name);
  const addColumn = (name, ddl) => {
    if (!columns.includes(name)) {
      try {
        db.exec(`ALTER TABLE guests ADD COLUMN ${ddl}`);
      } catch (_) { /* race / already exists */ }
    }
  };

  addColumn('seated', 'seated INTEGER DEFAULT 0');
  addColumn('email', 'email TEXT');
  addColumn('checked_in_at', 'checked_in_at DATETIME');
  addColumn('check_in_method', 'check_in_method TEXT');
  addColumn('graduating', 'graduating INTEGER');
  addColumn('package', 'package TEXT');

  // Unique email (case-insensitive) — only for rows that have an email
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_email_unique
    ON guests (LOWER(TRIM(email)))
    WHERE email IS NOT NULL AND TRIM(email) != '';

    CREATE TABLE IF NOT EXISTS conference_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

  `);

  const existingSettings = db.prepare(
    'SELECT start_date, end_date FROM conference_settings WHERE id = 1'
  ).get();
  if (!existingSettings) {
    db.prepare(
      'INSERT INTO conference_settings (id, start_date, end_date) VALUES (1, ?, ?)'
    ).run(EVENT_DATE, EVENT_DATE);
  } else if (existingSettings.start_date === '2026-10-08' && existingSettings.end_date === '2026-10-10') {
    db.prepare(
      'UPDATE conference_settings SET start_date = ?, end_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
    ).run(EVENT_DATE, EVENT_DATE);
  }

  ensureAttendanceTable(db);
  migrateLegacyAttendance(db);
  db.close();
}

function ensureAttendanceTable(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attendance'"
  ).get();
  if (exists) {
    const cols = db.prepare('PRAGMA table_info(attendance)').all().map((col) => col.name);
    if (!cols.includes('attendance_date')) {
      db.exec('ALTER TABLE attendance RENAME TO attendance_legacy');
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL,
      checked_in_at DATETIME NOT NULL,
      check_in_method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guest_id, attendance_date),
      FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_guest ON attendance(guest_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date);
  `);

  const legacy = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attendance_legacy'"
  ).get();
  if (!legacy) return;
  const settings = readSettings(db);
  if (!isIsoDate(settings.startDate) || !isIsoDate(settings.endDate)) return;
  const days = listConferenceDays(settings.startDate, settings.endDate);
  const byDay = new Map(days.map((day) => [day.day, day.date]));
  const rows = db.prepare('SELECT guest_id, conference_day, checked_in_at, check_in_method FROM attendance_legacy').all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO attendance (guest_id, attendance_date, checked_in_at, check_in_method)
    VALUES (?, ?, ?, ?)
  `);
  const run = db.transaction((list) => {
    for (const row of list) {
      const date = byDay.get(row.conference_day);
      if (!date || !row.checked_in_at) continue;
      insert.run(row.guest_id, date, row.checked_in_at, row.check_in_method || 'self');
    }
  });
  run(rows);
  db.exec('ALTER TABLE attendance_legacy RENAME TO attendance_legacy_imported');
}

function readSettings(db) {
  const row = db.prepare(
    'SELECT start_date, end_date, updated_at FROM conference_settings WHERE id = 1'
  ).get();
  return {
    startDate: row ? row.start_date : null,
    endDate: row ? row.end_date : null,
    updatedAt: row ? row.updated_at : null
  };
}

function getConferenceSettings() {
  const db = getDb();
  const settings = readSettings(db);
  db.close();
  return { ...settings, ...describeConference(settings) };
}

function saveConferenceSettings(startDate, endDate) {
  const check = validateConferenceDates(startDate, endDate);
  if (!check.ok) return check;
  const db = getDb();
  db.prepare(`
    UPDATE conference_settings
    SET start_date = ?, end_date = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(startDate, endDate);
  const settings = readSettings(db);
  db.close();
  return { ok: true, ...settings, ...describeConference(settings) };
}

function currentConference() {
  const db = getDb();
  const settings = readSettings(db);
  db.close();
  return describeConference(settings);
}

function migrateLegacyAttendance(db) {
  const settings = readSettings(db);
  if (!isIsoDate(settings.startDate) || !isIsoDate(settings.endDate) || settings.endDate < settings.startDate) return;
  const dates = new Set(listConferenceDays(settings.startDate, settings.endDate).map((day) => day.date));
  if (!dates.size) return;
  const zone = eventTimeZone();
  const rows = db.prepare(`
    SELECT id, checked_in_at, check_in_method
    FROM guests
    WHERE COALESCE(seated, 0) = 1
      AND checked_in_at IS NOT NULL
      AND TRIM(checked_in_at) != ''
  `).all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO attendance (guest_id, attendance_date, checked_in_at, check_in_method)
    VALUES (?, ?, ?, ?)
  `);
  const run = db.transaction((list) => {
    for (const row of list) {
      const date = dateOfTimestamp(row.checked_in_at, zone);
      if (!date || !dates.has(date)) continue;
      insert.run(row.id, date, row.checked_in_at, row.check_in_method || 'self');
    }
  });
  run(rows);
}

function syncGuestSummary(db, guestId) {
  const latest = db.prepare(`
    SELECT checked_in_at, check_in_method
    FROM attendance
    WHERE guest_id = ?
    ORDER BY checked_in_at DESC
    LIMIT 1
  `).get(guestId);
  if (latest) {
    db.prepare(`
      UPDATE guests SET seated = 1, checked_in_at = ?, check_in_method = ? WHERE id = ?
    `).run(latest.checked_in_at, latest.check_in_method, guestId);
  } else {
    db.prepare(`
      UPDATE guests SET seated = 0, checked_in_at = NULL, check_in_method = NULL WHERE id = ?
    `).run(guestId);
  }
}

function findAttendance(guestId, attendanceDate) {
  if (!guestId || !isIsoDate(attendanceDate)) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT guest_id, attendance_date, checked_in_at, check_in_method
    FROM attendance
    WHERE guest_id = ? AND attendance_date = ?
  `).get(guestId, attendanceDate);
  db.close();
  return row || null;
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function firstNameFrom(name) {
  const parts = (name || '').trim().split(/\s+/);
  return parts[0] || 'Guest';
}

function mapGuest(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email || null,
    table_number: row.table_number,
    checked_in: !!row.seated,
    seated: !!row.seated,
    checked_in_at: row.checked_in_at || null,
    check_in_method: row.check_in_method || null,
    graduating: row.graduating == null ? null : row.graduating === 1,
    package: row.package || null,
    created_at: row.created_at || null
  };
}

function findGuestByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, created_at
    FROM guests
    WHERE email IS NOT NULL
      AND LOWER(TRIM(email)) = ?
  `);
  const guest = stmt.get(normalized);
  db.close();
  return mapGuest(guest);
}

function findGuestByName(name) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, created_at
    FROM guests
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
  `);
  const guest = stmt.get(name?.trim() || '');
  db.close();
  return mapGuest(guest);
}

function findGuestById(id) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, created_at
    FROM guests
    WHERE id = ?
  `);
  const guest = stmt.get(id);
  db.close();
  return mapGuest(guest);
}

/**
 * Atomically check in an attendee.
 * Returns { ok, alreadyCheckedIn, guest } — uniqueness enforced by
 * UPDATE ... WHERE seated = 0 (no duplicate attendance).
 */
function loadGuestRow(db, id) {
  return db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, created_at
    FROM guests
    WHERE id = ?
  `).get(id);
}

function guestForDate(row, attendance) {
  const guest = mapGuest(row);
  if (!guest) return null;
  if (!attendance) {
    guest.checked_in = false;
    guest.seated = false;
    guest.checked_in_at = null;
    guest.check_in_method = null;
    return guest;
  }
  guest.checked_in = true;
  guest.seated = true;
  guest.checked_in_at = attendance.checked_in_at;
  guest.check_in_method = attendance.check_in_method || null;
  return guest;
}

function checkInGuest(id, method, guestPackage, attendanceDate) {
  const db = getDb();
  const existing = loadGuestRow(db, id);
  if (!existing) {
    db.close();
    return { ok: false, alreadyCheckedIn: false, guest: null };
  }
  const state = describeConference(readSettings(db));
  if (!state.available || !state.currentDate) {
    db.close();
    return { ok: false, unavailable: true, state, alreadyCheckedIn: false, guest: mapGuest(existing) };
  }
  const date = isIsoDate(attendanceDate) ? attendanceDate : state.currentDate;
  if (date !== state.currentDate) {
    db.close();
    return { ok: false, wrongDay: true, state, alreadyCheckedIn: false, guest: mapGuest(existing) };
  }
  const checkInMethod = method === 'manual' ? 'manual' : 'self';
  const normalizedPackage = normalizePackage(guestPackage);
  let already = false;
  try {
    db.prepare(`
      INSERT INTO attendance (guest_id, attendance_date, checked_in_at, check_in_method)
      VALUES (?, ?, ?, ?)
    `).run(id, date, new Date().toISOString(), checkInMethod);
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) {
      db.close();
      throw err;
    }
    already = true;
  }
  if (!already && normalizedPackage) {
    db.prepare('UPDATE guests SET package = ? WHERE id = ?').run(normalizedPackage, id);
  }
  if (!already) syncGuestSummary(db, id);
  const attendance = db.prepare(`
    SELECT attendance_date, checked_in_at, check_in_method
    FROM attendance WHERE guest_id = ? AND attendance_date = ?
  `).get(id, date);
  const guest = guestForDate(loadGuestRow(db, id), attendance);
  db.close();
  return {
    ok: !already,
    alreadyCheckedIn: already,
    guest,
    attendanceDate: date,
    state
  };
}

function checkOutGuest(id, attendanceDate) {
  const db = getDb();
  const existing = loadGuestRow(db, id);
  if (!existing) {
    db.close();
    return null;
  }
  const state = describeConference(readSettings(db));
  if (!isIsoDate(attendanceDate) || !state.days.some((day) => day.date === attendanceDate)) {
    db.close();
    return { ok: false, invalidDay: true, state };
  }
  const removed = db.prepare(
    'DELETE FROM attendance WHERE guest_id = ? AND attendance_date = ?'
  ).run(id, attendanceDate).changes;
  if (removed > 0) {
    db.prepare('UPDATE guests SET graduating = NULL WHERE id = ?').run(id);
  }
  syncGuestSummary(db, id);
  db.close();
  return { ok: true, removed, attendanceDate };
}

function markGuestSeated(id) {
  return checkInGuest(id, 'self').ok;
}

function setGuestSeated(id, seated, attendanceDate) {
  if (seated) {
    const result = checkInGuest(id, 'manual', null, attendanceDate);
    return !!(result && (result.ok || result.alreadyCheckedIn));
  }
  const state = currentConference();
  const date = attendanceDate || state.currentDate;
  if (!date) return false;
  const result = checkOutGuest(id, date);
  return !!(result && result.ok);
}

function updateGuestTable(id, tableNumber) {
  const db = getDb();
  const stmt = db.prepare('UPDATE guests SET table_number = ? WHERE id = ?');
  const result = stmt.run(parseInt(tableNumber, 10) || 0, id);
  db.close();
  return result.changes > 0;
}

function updateGuest(id, { name, email, package: guestPackage } = {}) {
  const db = getDb();
  const current = db.prepare('SELECT id, name, email, package FROM guests WHERE id = ?').get(id);
  if (!current) {
    db.close();
    return false;
  }
  const newName = name != null ? String(name).trim() : current.name;
  const newEmail = email != null ? normalizeEmail(email) : current.email;
  let newPackage = current.package || null;
  if (guestPackage !== undefined) {
    if (guestPackage == null || String(guestPackage).trim() === '') {
      newPackage = null;
    } else {
      newPackage = normalizePackage(guestPackage);
      if (!newPackage) {
        db.close();
        throw new Error('BAD_PACKAGE');
      }
    }
  }
  if (!newName) {
    db.close();
    return false;
  }
  try {
    const stmt = db.prepare('UPDATE guests SET name = ?, email = ?, package = ? WHERE id = ?');
    const result = stmt.run(newName, newEmail || null, newPackage, id);
    db.close();
    return result.changes > 0;
  } catch (err) {
    db.close();
    if (err && String(err.message).includes('UNIQUE')) {
      const conflict = new Error('EMAIL_TAKEN');
      throw conflict;
    }
    throw err;
  }
}

function deleteGuest(id) {
  const db = getDb();
  db.prepare('DELETE FROM attendance WHERE guest_id = ?').run(id);
  const result = db.prepare('DELETE FROM guests WHERE id = ?').run(id);
  db.close();
  return result.changes > 0;
}

function bulkCheckIn(ids, attendanceDate) {
  const db = getDb();
  const state = describeConference(readSettings(db));
  const date = isIsoDate(attendanceDate) ? attendanceDate : state.currentDate;
  if (!state.available || date !== state.currentDate) {
    db.close();
    return { updated: 0, wrongDay: !state.available ? false : true, unavailable: !state.available, state };
  }
  const insert = db.prepare(`
    INSERT INTO attendance (guest_id, attendance_date, checked_in_at, check_in_method)
    VALUES (?, ?, ?, 'manual')
  `);
  let updated = 0;
  const run = db.transaction((list) => {
    for (const id of list) {
      if (!loadGuestRow(db, id)) continue;
      try {
        insert.run(id, date, new Date().toISOString());
        syncGuestSummary(db, id);
        updated += 1;
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) throw err;
      }
    }
  });
  run(ids || []);
  db.close();
  return { updated, attendanceDate: date, state };
}

function bulkCheckOut(ids, attendanceDate) {
  const db = getDb();
  const state = describeConference(readSettings(db));
  if (!isIsoDate(attendanceDate) || !state.days.some((day) => day.date === attendanceDate)) {
    db.close();
    return { updated: 0, invalidDay: true, state };
  }
  const remove = db.prepare('DELETE FROM attendance WHERE guest_id = ? AND attendance_date = ?');
  const clearGraduating = db.prepare('UPDATE guests SET graduating = NULL WHERE id = ?');
  let updated = 0;
  const run = db.transaction((list) => {
    for (const id of list) {
      const result = remove.run(id, attendanceDate);
      if (result.changes > 0) {
        updated += 1;
        clearGraduating.run(id);
      }
      syncGuestSummary(db, id);
    }
  });
  run(ids || []);
  db.close();
  return { updated, attendanceDate };
}

function bulkDeleteGuests(ids) {
  const db = getDb();
  const attendance = db.prepare('DELETE FROM attendance WHERE guest_id = ?');
  const del = db.prepare('DELETE FROM guests WHERE id = ?');
  let deleted = 0;
  const run = db.transaction((list) => {
    for (const id of list) {
      attendance.run(id);
      const result = del.run(id);
      if (result.changes > 0) deleted += 1;
    }
  });
  run(ids || []);
  db.close();
  return { deleted };
}

function searchGuests(query) {
  const db = getDb();
  const trimmed = (query || '').trim();
  if (!trimmed) return [];
  const stmt = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, created_at
    FROM guests
    WHERE LOWER(name) LIKE LOWER(?)
       OR (email IS NOT NULL AND LOWER(email) LIKE LOWER(?))
    ORDER BY name
    LIMIT 10
  `);
  const pattern = `%${trimmed}%`;
  const guests = stmt.all(pattern, pattern).map(mapGuest);
  db.close();
  return guests;
}

/**
 * Public check-in suggestions: match first or last name prefix.
 * Requires at least 4 characters. Returns names only (limited).
 */
function suggestGuestsByNamePrefix(query) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 4) return [];

  const db = getDb();
  const prefix = trimmed.toLowerCase();
  const stmt = db.prepare(`
    SELECT DISTINCT name
    FROM guests
    WHERE LOWER(TRIM(name)) LIKE ? || '%'
       OR LOWER(name) LIKE '% ' || ? || '%'
    ORDER BY name
    LIMIT 8
  `);
  const rows = stmt.all(prefix, prefix);
  db.close();
  return rows.map((r) => ({ name: r.name }));
}

function addGuest(name, tableNumber, email, guestPackage) {
  const db = getDb();
  const booked = db.prepare('SELECT COUNT(*) AS count FROM guests').get().count;
  if (booked >= EVENT_CAPACITY) {
    db.close();
    throw new Error('AT_CAPACITY');
  }
  const normalizedEmail = normalizeEmail(email);
  const pkg = normalizePackage(guestPackage);
  try {
    const stmt = db.prepare(
      'INSERT INTO guests (name, table_number, email, package) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(
      name?.trim(),
      parseInt(tableNumber, 10) || 0,
      normalizedEmail || null,
      pkg
    );
    db.close();
    return {
      id: result.lastInsertRowid,
      name: name?.trim(),
      table_number: parseInt(tableNumber, 10) || 0,
      email: normalizedEmail || null,
      package: pkg,
      checked_in: false
    };
  } catch (err) {
    db.close();
    if (err && String(err.message).includes('UNIQUE')) {
      const conflict = new Error('EMAIL_TAKEN');
      throw conflict;
    }
    throw err;
  }
}

/**
 * Bulk-import attendees by name (and optional email).
 * Skips blank rows and names that already exist (case-insensitive).
 */
function importGuests(entries) {
  const db = getDb();
  const findExisting = db.prepare(
    'SELECT id FROM guests WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))'
  );
  const insert = db.prepare(
    'INSERT INTO guests (name, table_number, email, package) VALUES (?, 0, ?, ?)'
  );
  let booked = db.prepare('SELECT COUNT(*) AS count FROM guests').get().count;

  let imported = 0;
  let skipped = 0;
  let capacitySkipped = 0;
  const errors = [];

  const run = db.transaction((rows) => {
    for (const row of rows) {
      const name = (row.name || '').trim();
      if (!name) {
        skipped++;
        continue;
      }
      if (findExisting.get(name)) {
        skipped++;
        continue;
      }
      if (booked >= EVENT_CAPACITY) {
        capacitySkipped++;
        continue;
      }
      const email = normalizeEmail(row.email) || null;
      const pkg = normalizePackage(row.package);
      try {
        insert.run(name, email, pkg);
        imported++;
        booked++;
      } catch (err) {
        if (err && String(err.message).includes('UNIQUE')) {
          skipped++;
        } else {
          errors.push(name);
        }
      }
    }
  });

  run(entries || []);
  db.close();
  return { imported, skipped, capacitySkipped, errors };
}

function getAllGuests(attendanceDate) {
  const db = getDb();
  const state = describeConference(readSettings(db));
  const date = isIsoDate(attendanceDate) ? attendanceDate : state.currentDate;
  const rows = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, created_at
    FROM guests
    ORDER BY name
  `).all();
  const records = date
    ? db.prepare(`
        SELECT guest_id, attendance_date, checked_in_at, check_in_method
        FROM attendance
        WHERE attendance_date = ?
      `).all(date)
    : [];
  db.close();
  const byGuest = new Map(records.map((row) => [row.guest_id, row]));
  return rows.map((row) => guestForDate(row, byGuest.get(row.id) || null));
}

function getGuestCount() {
  const db = getDb();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM guests');
  const { count } = stmt.get();
  db.close();
  return count;
}

function getAttendanceStats(attendanceDate) {
  const db = getDb();
  const state = describeConference(readSettings(db));
  const date = isIsoDate(attendanceDate) ? attendanceDate : state.currentDate;
  const row = db.prepare('SELECT COUNT(*) AS rsvp FROM guests').get();
  const checkedRow = date
    ? db.prepare('SELECT COUNT(*) AS checked_in FROM attendance WHERE attendance_date = ?').get(date)
    : { checked_in: 0 };
  db.close();
  const rsvp = row.rsvp || 0;
  const checkedIn = checkedRow.checked_in || 0;
  const remaining = Math.max(0, rsvp - checkedIn);
  const attendance = rsvp > 0 ? Math.round((checkedIn / rsvp) * 1000) / 10 : 0;
  return {
    rsvp,
    checkedIn,
    remaining,
    attendance,
    capacity: EVENT_CAPACITY,
    spotsLeft: Math.max(0, EVENT_CAPACITY - rsvp)
  };
}

module.exports = {
  EVENT_CAPACITY,
  normalizePackage,
  getDb,
  initDatabase,
  normalizeEmail,
  firstNameFrom,
  findGuestByEmail,
  findGuestByName,
  findGuestById,
  checkInGuest,
  searchGuests,
  suggestGuestsByNamePrefix,
  addGuest,
  importGuests,
  getAllGuests,
  getGuestCount,
  getAttendanceStats,
  markGuestSeated,
  setGuestSeated,
  updateGuestTable,
  updateGuest,
  deleteGuest,
  bulkCheckIn,
  bulkCheckOut,
  bulkDeleteGuests,
  getConferenceSettings,
  saveConferenceSettings,
  currentConference,
  findAttendance,
  checkOutGuest
};
