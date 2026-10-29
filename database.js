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
  addColumn('package_id', 'package_id INTEGER');

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
  ensurePackageTables(db);
  db.close();
}

function ensurePackageTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price TEXT,
      legacy_key TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS package_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    );
    CREATE TABLE IF NOT EXISTS guest_item_receipts (
      guest_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      received INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guest_id, item_id),
      FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES package_items(id)
    );
  `);

  const count = db.prepare('SELECT COUNT(*) AS n FROM packages').get().n;
  if (count === 0) {
    const seed = db.prepare(
      'INSERT INTO packages (name, price, legacy_key, sort_order, active) VALUES (?, ?, ?, ?, 1)'
    );
    seed.run('Silver', 'M800', 'silver', 1);
    seed.run('Gold', 'M1,100', 'gold', 2);
    seed.run('Platinum', 'M1,300', 'platinum', 3);
  }

  db.prepare(`
    UPDATE guests
    SET package_id = (
      SELECT id FROM packages
      WHERE packages.legacy_key = guests.package
         OR LOWER(packages.name) = LOWER(guests.package)
      ORDER BY packages.active DESC, packages.id ASC
      LIMIT 1
    )
    WHERE package_id IS NULL
      AND package IS NOT NULL
      AND TRIM(package) != ''
  `).run();
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
    package_id: row.package_id || null,
    created_at: row.created_at || null
  };
}

function withPackageNames(guests) {
  const list = (Array.isArray(guests) ? guests : [guests]).filter(Boolean);
  if (!list.length) return guests;
  const db = getDb();
  const pkgs = db.prepare('SELECT id, name, price, legacy_key FROM packages').all();
  db.close();
  const byId = new Map(pkgs.map((pkg) => [pkg.id, pkg]));
  const byKey = new Map(pkgs.filter((pkg) => pkg.legacy_key).map((pkg) => [pkg.legacy_key, pkg]));
  const byName = new Map(pkgs.map((pkg) => [String(pkg.name).toLowerCase(), pkg]));
  for (const guest of list) {
    const pkg = (guest.package_id && byId.get(guest.package_id))
      || (guest.package && byKey.get(guest.package))
      || (guest.package && byName.get(String(guest.package).toLowerCase()))
      || null;
    if (pkg) {
      guest.package_id = pkg.id;
      guest.package_name = pkg.name;
      guest.package_price = pkg.price || null;
    } else {
      guest.package_name = null;
      guest.package_price = null;
    }
  }
  return guests;
}

function findGuestByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, package_id, created_at
    FROM guests
    WHERE email IS NOT NULL
      AND LOWER(TRIM(email)) = ?
  `);
  const guest = stmt.get(normalized);
  db.close();
  return withPackageNames(mapGuest(guest));
}

function findGuestByName(name) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, package_id, created_at
    FROM guests
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
  `);
  const guest = stmt.get(name?.trim() || '');
  db.close();
  return withPackageNames(mapGuest(guest));
}

function findGuestsByExactName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return [];
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, package_id, created_at
    FROM guests
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
    ORDER BY id
  `).all(trimmed);
  db.close();
  return withPackageNames(rows.map(mapGuest));
}

function guestIsCheckedInForEvent(guestId) {
  const state = currentConference();
  if (!guestId || !state.configured || state.phase === 'before' || !state.days.length) return false;
  const dates = state.phase === 'during' && state.currentDate
    ? [state.currentDate]
    : state.days.map((day) => day.date);
  if (!dates.length) return false;
  const db = getDb();
  const placeholders = dates.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT 1 AS ok FROM attendance WHERE guest_id = ? AND attendance_date IN (${placeholders}) LIMIT 1`
  ).get(guestId, ...dates);
  db.close();
  return !!row;
}

function findGuestById(id) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, name, email, table_number,
           COALESCE(seated, 0) AS seated,
           checked_in_at, check_in_method, graduating, package, package_id, created_at
    FROM guests
    WHERE id = ?
  `);
  const guest = stmt.get(id);
  db.close();
  return withPackageNames(mapGuest(guest));
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
           checked_in_at, check_in_method, graduating, package, package_id, created_at
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
    guest: withPackageNames(guest),
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
  const current = db.prepare('SELECT id, name, email, package, package_id FROM guests WHERE id = ?').get(id);
  if (!current) {
    db.close();
    return false;
  }
  const newName = name != null ? String(name).trim() : current.name;
  const newEmail = email != null ? normalizeEmail(email) : current.email;
  let newPackage = current.package || null;
  let newPackageId = current.package_id || null;
  if (guestPackage !== undefined) {
    if (guestPackage == null || String(guestPackage).trim() === '') {
      newPackage = null;
      newPackageId = null;
    } else {
      const resolved = resolvePackage(db, guestPackage);
      if (!resolved) {
        db.close();
        throw new Error('BAD_PACKAGE');
      }
      newPackage = storedPackageValue(resolved);
      newPackageId = resolved.id;
    }
  }
  if (!newName) {
    db.close();
    return false;
  }
  try {
    const stmt = db.prepare('UPDATE guests SET name = ?, email = ?, package = ?, package_id = ? WHERE id = ?');
    const result = stmt.run(newName, newEmail || null, newPackage, newPackageId, id);
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
           checked_in_at, check_in_method, graduating, package, package_id, created_at
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
  const resolved = resolvePackage(db, guestPackage);
  if (!resolved) {
    db.close();
    throw new Error('BAD_PACKAGE');
  }
  const stored = storedPackageValue(resolved);
  try {
    const stmt = db.prepare(
      'INSERT INTO guests (name, table_number, email, package, package_id) VALUES (?, ?, ?, ?, ?)'
    );
    const result = stmt.run(
      name?.trim(),
      parseInt(tableNumber, 10) || 0,
      normalizedEmail || null,
      stored,
      resolved.id
    );
    db.close();
    return {
      id: result.lastInsertRowid,
      name: name?.trim(),
      table_number: parseInt(tableNumber, 10) || 0,
      email: normalizedEmail || null,
      package: stored,
      package_id: resolved.id,
      package_name: resolved.name,
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
    'INSERT INTO guests (name, table_number, email, package, package_id) VALUES (?, 0, ?, ?, ?)'
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
      const resolved = row.package ? resolvePackage(db, row.package) : null;
      try {
        insert.run(
          name,
          email,
          resolved ? storedPackageValue(resolved) : null,
          resolved ? resolved.id : null
        );
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
           checked_in_at, check_in_method, graduating, package, package_id, created_at
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
  return withPackageNames(rows.map((row) => guestForDate(row, byGuest.get(row.id) || null)));
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

function resolvePackage(db, value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const byId = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(parseInt(text, 10));
    if (byId) return byId;
  }
  const legacy = normalizePackage(text);
  if (legacy) {
    const byKey = db.prepare('SELECT * FROM packages WHERE legacy_key = ? AND active = 1').get(legacy);
    if (byKey) return byKey;
  }
  return db.prepare('SELECT * FROM packages WHERE active = 1 AND LOWER(name) = LOWER(?)').get(text) || null;
}

function storedPackageValue(pkg) {
  return pkg.legacy_key || pkg.name;
}

function listPackages({ activeOnly = false, withItems = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, price, legacy_key, sort_order, active
    FROM packages
    ${activeOnly ? 'WHERE active = 1' : ''}
    ORDER BY sort_order, id
  `).all();
  const items = withItems
    ? db.prepare(`
        SELECT id, package_id, name, sort_order
        FROM package_items
        WHERE active = 1
        ORDER BY sort_order, id
      `).all()
    : [];
  db.close();
  const byPackage = new Map();
  for (const item of items) {
    if (!byPackage.has(item.package_id)) byPackage.set(item.package_id, []);
    byPackage.get(item.package_id).push({ id: item.id, name: item.name, sort_order: item.sort_order });
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    price: row.price || null,
    legacy_key: row.legacy_key || null,
    sort_order: row.sort_order || 0,
    active: row.active !== 0,
    items: byPackage.get(row.id) || []
  }));
}

function createPackage(name, price) {
  const clean = String(name || '').trim();
  if (!clean || clean.length > 80) throw new Error('BAD_NAME');
  const db = getDb();
  const dup = db.prepare('SELECT id FROM packages WHERE active = 1 AND LOWER(name) = LOWER(?)').get(clean);
  if (dup) {
    db.close();
    throw new Error('DUPLICATE');
  }
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM packages').get().n;
  const priceText = price != null && String(price).trim() ? String(price).trim().slice(0, 40) : null;
  const result = db.prepare(
    'INSERT INTO packages (name, price, sort_order, active) VALUES (?, ?, ?, 1)'
  ).run(clean, priceText, order);
  const id = result.lastInsertRowid;
  db.close();
  return listPackages({ withItems: true }).find((pkg) => pkg.id === id);
}

function updatePackage(id, { name, price } = {}) {
  const clean = String(name || '').trim();
  if (!clean || clean.length > 80) throw new Error('BAD_NAME');
  const db = getDb();
  const current = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(id);
  if (!current) {
    db.close();
    throw new Error('NOT_FOUND');
  }
  const dup = db.prepare(
    'SELECT id FROM packages WHERE active = 1 AND LOWER(name) = LOWER(?) AND id != ?'
  ).get(clean, id);
  if (dup) {
    db.close();
    throw new Error('DUPLICATE');
  }
  const priceText = price === undefined
    ? current.price
    : (price != null && String(price).trim() ? String(price).trim().slice(0, 40) : null);
  db.prepare('UPDATE packages SET name = ?, price = ? WHERE id = ?').run(clean, priceText, id);
  if (!current.legacy_key) {
    db.prepare('UPDATE guests SET package = ? WHERE package_id = ?').run(clean, id);
  }
  db.close();
  return listPackages({ withItems: true }).find((pkg) => pkg.id === id);
}

function deactivatePackage(id) {
  const db = getDb();
  const result = db.prepare('UPDATE packages SET active = 0 WHERE id = ? AND active = 1').run(id);
  db.close();
  return result.changes > 0;
}

function addPackageItem(packageId, name) {
  const clean = String(name || '').trim();
  if (!clean || clean.length > 80) throw new Error('BAD_NAME');
  const db = getDb();
  const pkg = db.prepare('SELECT id FROM packages WHERE id = ? AND active = 1').get(packageId);
  if (!pkg) {
    db.close();
    throw new Error('NOT_FOUND');
  }
  const dup = db.prepare(
    'SELECT id FROM package_items WHERE package_id = ? AND active = 1 AND LOWER(name) = LOWER(?)'
  ).get(packageId, clean);
  if (dup) {
    db.close();
    throw new Error('DUPLICATE');
  }
  const order = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM package_items WHERE package_id = ?'
  ).get(packageId).n;
  const result = db.prepare(
    'INSERT INTO package_items (package_id, name, sort_order, active) VALUES (?, ?, ?, 1)'
  ).run(packageId, clean, order);
  const item = { id: result.lastInsertRowid, name: clean, sort_order: order };
  db.close();
  return item;
}

function renamePackageItem(itemId, name) {
  const clean = String(name || '').trim();
  if (!clean || clean.length > 80) throw new Error('BAD_NAME');
  const db = getDb();
  const current = db.prepare('SELECT * FROM package_items WHERE id = ? AND active = 1').get(itemId);
  if (!current) {
    db.close();
    throw new Error('NOT_FOUND');
  }
  const dup = db.prepare(
    'SELECT id FROM package_items WHERE package_id = ? AND active = 1 AND LOWER(name) = LOWER(?) AND id != ?'
  ).get(current.package_id, clean, itemId);
  if (dup) {
    db.close();
    throw new Error('DUPLICATE');
  }
  db.prepare('UPDATE package_items SET name = ? WHERE id = ?').run(clean, itemId);
  db.close();
  return { id: itemId, name: clean };
}

function deactivatePackageItem(itemId) {
  const db = getDb();
  const result = db.prepare('UPDATE package_items SET active = 0 WHERE id = ? AND active = 1').run(itemId);
  db.close();
  return result.changes > 0;
}

function getGuestDistribution(guestId) {
  const db = getDb();
  const guest = db.prepare('SELECT id, name, package, package_id FROM guests WHERE id = ?').get(guestId);
  if (!guest) {
    db.close();
    return null;
  }
  let pkg = guest.package_id
    ? db.prepare('SELECT id, name FROM packages WHERE id = ?').get(guest.package_id)
    : null;
  if (!pkg && guest.package) {
    const legacy = normalizePackage(guest.package);
    pkg = legacy
      ? db.prepare('SELECT id, name FROM packages WHERE legacy_key = ? ORDER BY active DESC, id ASC').get(legacy)
      : db.prepare('SELECT id, name FROM packages WHERE LOWER(name) = LOWER(?) ORDER BY active DESC, id ASC').get(guest.package);
    if (pkg) db.prepare('UPDATE guests SET package_id = ? WHERE id = ? AND package_id IS NULL').run(pkg.id, guest.id);
  }
  const items = pkg
    ? db.prepare(
      'SELECT id, name FROM package_items WHERE package_id = ? AND active = 1 ORDER BY sort_order, id'
    ).all(pkg.id)
    : [];
  const receipts = db.prepare(
    'SELECT item_id, received FROM guest_item_receipts WHERE guest_id = ?'
  ).all(guest.id);
  db.close();
  const received = new Map(receipts.map((row) => [row.item_id, row.received === 1]));
  const merged = items.map((item) => ({
    id: item.id,
    name: item.name,
    received: !!received.get(item.id)
  }));
  const receivedCount = merged.filter((item) => item.received).length;
  const total = merged.length;
  return {
    guestId: guest.id,
    guestName: guest.name,
    packageId: pkg ? pkg.id : null,
    packageName: pkg ? pkg.name : null,
    items: merged,
    receivedCount,
    total,
    complete: total > 0 && receivedCount === total
  };
}

function setGuestItemReceived(guestId, itemId, received) {
  const db = getDb();
  const guest = db.prepare('SELECT id, package_id FROM guests WHERE id = ?').get(guestId);
  if (!guest) {
    db.close();
    throw new Error('NOT_FOUND');
  }
  const item = db.prepare('SELECT id, package_id, active FROM package_items WHERE id = ?').get(itemId);
  if (!item || item.active !== 1) {
    db.close();
    throw new Error('NOT_FOUND');
  }
  if (!guest.package_id || item.package_id !== guest.package_id) {
    db.close();
    throw new Error('WRONG_PACKAGE');
  }
  db.prepare(`
    INSERT INTO guest_item_receipts (guest_id, item_id, received, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guest_id, item_id) DO UPDATE SET
      received = excluded.received,
      updated_at = CURRENT_TIMESTAMP
  `).run(guestId, itemId, received ? 1 : 0);
  db.close();
  return getGuestDistribution(guestId);
}

module.exports = {
  EVENT_CAPACITY,
  normalizePackage,
  resolvePackage,
  getDb,
  initDatabase,
  normalizeEmail,
  firstNameFrom,
  findGuestByEmail,
  findGuestByName,
  findGuestsByExactName,
  guestIsCheckedInForEvent,
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
  listPackages,
  createPackage,
  updatePackage,
  deactivatePackage,
  addPackageItem,
  renamePackageItem,
  deactivatePackageItem,
  getGuestDistribution,
  setGuestItemReceived,
  findAttendance,
  checkOutGuest
};
