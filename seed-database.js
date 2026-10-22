const {
  initDatabase,
  addGuest,
  getGuestCount,
  getDb
} = require('./database');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

initDatabase();

const SAMPLE_ATTENDEES = [
  ['James Wilson', 'james.wilson@example.com'],
  ['Mary Johnson', 'mary.johnson@example.com'],
  ['Robert Davis', 'robert.davis@example.com'],
  ['Patricia Miller', 'patricia.miller@example.com'],
  ['John Smith', 'john.smith@example.com'],
  ['Jennifer Brown', 'jennifer.brown@example.com'],
  ['Michael Williams', 'michael.williams@example.com'],
  ['Linda Jones', 'linda.jones@example.com'],
  ['David Garcia', 'david.garcia@example.com'],
  ['Elizabeth Martinez', 'elizabeth.martinez@example.com'],
  ['Richard Anderson', 'richard.anderson@example.com'],
  ['Barbara Taylor', 'barbara.taylor@example.com'],
  ['Joseph Thomas', 'joseph.thomas@example.com'],
  ['Susan Moore', 'susan.moore@example.com'],
  ['Thomas Jackson', 'thomas.jackson@example.com'],
  ['Jessica Martin', 'jessica.martin@example.com'],
  ['Charles Lee', 'charles.lee@example.com'],
  ['Sarah White', 'sarah.white@example.com'],
  ['Christopher Harris', 'christopher.harris@example.com'],
  ['Karen Clark', 'karen.clark@example.com'],
  ['Daniel Lewis', 'daniel.lewis@example.com'],
  ['Nancy Robinson', 'nancy.robinson@example.com'],
  ['Matthew Walker', 'matthew.walker@example.com'],
  ['Betty Hall', 'betty.hall@example.com'],
  ['Anthony Young', 'anthony.young@example.com'],
  ['Margaret Allen', 'margaret.allen@example.com'],
  ['Mark King', 'mark.king@example.com'],
  ['Sandra Wright', 'sandra.wright@example.com'],
  ['Donald Scott', 'donald.scott@example.com'],
  ['Dorothy Green', 'dorothy.green@example.com']
];

function emailFromName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '.')
    + '@example.com';
}

/**
 * Backfill emails for existing guests that were seeded without them
 * (from the previous table-finder schema).
 */
function backfillMissingEmails() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, name FROM guests WHERE email IS NULL OR TRIM(email) = ''`
  ).all();
  const update = db.prepare('UPDATE guests SET email = ? WHERE id = ?');
  let updated = 0;
  for (const row of rows) {
    let email = emailFromName(row.name);
    // Ensure uniqueness if collisions occur
    let suffix = 0;
    while (true) {
      const candidate = suffix === 0 ? email : email.replace('@', `+${suffix}@`);
      try {
        update.run(candidate, row.id);
        updated++;
        break;
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          suffix++;
          continue;
        }
        throw err;
      }
    }
  }

  // Legacy "seated" rows may lack check-in metadata
  db.prepare(`
    UPDATE guests
    SET checked_in_at = COALESCE(checked_in_at, created_at, CURRENT_TIMESTAMP),
        check_in_method = COALESCE(check_in_method, 'manual')
    WHERE COALESCE(seated, 0) = 1 AND checked_in_at IS NULL
  `).run();

  db.close();
  return updated;
}

const count = getGuestCount();

if (count === 0) {
  SAMPLE_ATTENDEES.forEach(([name, email]) => {
    addGuest(name, 0, email);
  });
  console.log(`Seeded ${SAMPLE_ATTENDEES.length} sample guests.`);
} else {
  const backfilled = backfillMissingEmails();
  console.log(`Database already has ${count} attendees.`);
  if (backfilled > 0) {
    console.log(`Backfilled email addresses for ${backfilled} existing attendees.`);
  } else {
    console.log('All attendees already have emails. No changes made.');
  }
}
