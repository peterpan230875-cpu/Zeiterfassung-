const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcryptjs = require('bcryptjs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

// ── SESSION STORE IN DATENBANK ────────────────────────────────────────────────
class PrismaSessionStore extends session.Store {
  async get(sid, callback) {
    try {
      const s = await prisma.session.findUnique({ where: { sid } });
      if (!s || s.expiresAt < new Date()) {
        return callback(null, null);
      }
      callback(null, JSON.parse(s.data));
    } catch (err) {
      callback(null, null);
    }
  }

  async set(sid, sess, callback) {
    try {
      const expiresAt = sess.cookie?.expires
        ? new Date(sess.cookie.expires)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.session.upsert({
        where: { sid },
        update: { data: JSON.stringify(sess), expiresAt },
        create: { sid, data: JSON.stringify(sess), expiresAt }
      });
      callback(null);
    } catch (err) {
      callback(null);
    }
  }

  async destroy(sid, callback) {
    try {
      await prisma.session.deleteMany({ where: { sid } });
    } catch (_) {}
    callback(null);
  }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PrismaSessionStore(),
  secret: process.env.SESSION_SECRET || 'zeiterfassung-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ── SEITEN ────────────────────────────────────────────────────────────────────
app.get('/test', (req, res) => res.json({ status: 'ok' }));

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

app.get('/', (req, res) => {
  if (req.session.userId) {
    if (req.session.isSuperAdmin) return res.redirect('/super-admin');
    if (req.session.isAdmin) return res.redirect('/admin');
    return res.redirect('/app');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/app', noCache, (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  if (req.session.isSuperAdmin) return res.redirect('/super-admin');
  if (req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ── ADMIN-SEITEN ─────────────────────────────────────────────────────────────
app.get('/admin-login', noCache, (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/admin', noCache, (req, res) => {
  if (!req.session.userId || !req.session.isAdmin) return res.redirect('/admin-login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin-register', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-register.html'));
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username || !password || !name)
      return res.status(400).json({ error: 'Alle Felder erforderlich' });

    const exists = await prisma.user.findUnique({ where: { username } });
    if (exists) return res.status(400).json({ error: 'Benutzer existiert bereits' });

    const hash = bcryptjs.hashSync(password, 10);
    const user = await prisma.user.create({ data: { username, name, password: hash } });

    await prisma.settings.create({
      data: {
        userId: user.id,
        wochenstunden: 38.5,
        darkMode: false,
        emailTo: '',
        setupDone: false,
        employees: JSON.stringify([
          { id: 1, name: user.name, entries: {} }
        ])
      }
    });

    res.json({ success: true, message: 'Registrierung erfolgreich' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Fehler bei Registrierung' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !bcryptjs.compareSync(password, user.password))
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });

    req.session.userId = user.id;
    req.session.username = username;
    req.session.name = user.name;

    // Super-Admin automatisch erkennen
    if (user.isSuperAdmin) {
      req.session.isSuperAdmin = true;
      return res.json({ success: true, redirect: '/super-admin', isSuperAdmin: true });
    }

    // Admin automatisch erkennen — Admins haben KEINE Zeiterfassung,
    // werden zur Admin-Oberflaeche weitergeleitet
    if (user.isAdmin) {
      req.session.isAdmin = true;
      return res.json({ success: true, redirect: '/admin', isAdmin: true });
    }

    res.json({ success: true, user: { username, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: 'Fehler bei Login' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

app.get('/api/user', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  res.json({ userId: req.session.userId, username: req.session.username, name: req.session.name });
});

// ── EINTRÄGE ──────────────────────────────────────────────────────────────────
app.post('/api/entry', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const { date, type, von, bis, pause, bemerkung } = req.body;
    if (!date) return res.status(400).json({ error: 'Datum erforderlich' });

    // Prüfe ob Monat gesperrt ist
    const [yStr, mStr] = date.split('-');
    const lock = await prisma.monthLock.findUnique({
      where: { userId_year_month: { userId: req.session.userId, year: parseInt(yStr), month: parseInt(mStr) } }
    });
    if (lock) return res.status(403).json({ error: 'Monat ist abgeschlossen — keine Änderungen möglich' });

    // Pruefe ob es ein "Geschlossen"-Tag ist.
    // An Geschlossen-Tagen ist NUR Urlaub oder Zeitausgleich erlaubt - keine normalen Arbeitszeiten.
    const sd = await prisma.specialDay.findUnique({ where: { date } });
    if (sd && sd.type === 'closed') {
      const allowedTypes = ['urlaub', 'zeitausgleich'];
      if (!allowedTypes.includes(type)) {
        return res.status(403).json({ error: 'Geschäft geschlossen — nur Urlaub oder Zeitausgleich möglich' });
      }
    }

    // Prüfe ob der Tag in einer Elternzeit liegt
    try {
      const inLeave = await prisma.parentalLeave.findFirst({
        where: {
          userId: req.session.userId,
          startDate: { lte: date },
          endDate:   { gte: date }
        }
      });
      if (inLeave) {
        return res.status(403).json({ error: 'Elternzeit — in diesem Zeitraum sind keine Einträge möglich' });
      }
    } catch (e) {
      // Tabelle existiert noch nicht — Eintrag erlauben (Safety-Net laeuft beim naechsten Aufruf)
    }

    const pauseInt = parseInt(pause) || 0;
    const vonVal = von && von !== '' ? von : null;
    const bisVal = bis && bis !== '' ? bis : null;

    const entry = await prisma.entry.upsert({
      where: { userId_date: { userId: req.session.userId, date } },
      update: { type: type || 'normal', von: vonVal, bis: bisVal, pause: pauseInt, bemerkung: bemerkung || '' },
      create: { userId: req.session.userId, date, type: type || 'normal', von: vonVal, bis: bisVal, pause: pauseInt, bemerkung: bemerkung || '' }
    });
    res.json({ success: true, entry });
  } catch (err) {
    console.error('Entry error:', err);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

app.get('/api/entries', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const entries = await prisma.entry.findMany({ where: { userId: req.session.userId } });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

app.delete('/api/entry/:date', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const date = req.params.date;
    // Prüfe ob Monat gesperrt ist
    const [yStr, mStr] = date.split('-');
    const lock = await prisma.monthLock.findUnique({
      where: { userId_year_month: { userId: req.session.userId, year: parseInt(yStr), month: parseInt(mStr) } }
    });
    if (lock) return res.status(403).json({ error: 'Monat ist abgeschlossen — keine Änderungen möglich' });

    await prisma.entry.deleteMany({
      where: { userId: req.session.userId, date }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// ── MONATSABSCHLUSS ──────────────────────────────────────────────────────────
app.post('/api/month-lock', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const { year, month } = req.body;
    if (!year || !month) return res.status(400).json({ error: 'Jahr und Monat erforderlich' });

    const lock = await prisma.monthLock.upsert({
      where: { userId_year_month: { userId: req.session.userId, year: parseInt(year), month: parseInt(month) } },
      update: { lockedAt: new Date() },
      create: { userId: req.session.userId, year: parseInt(year), month: parseInt(month) }
    });
    res.json({ success: true, lock });
  } catch (err) {
    console.error('Month-lock error:', err);
    res.status(500).json({ error: 'Fehler beim Abschluss' });
  }
});

app.get('/api/month-locks', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const locks = await prisma.monthLock.findMany({
      where: { userId: req.session.userId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }]
    });
    res.json({ locks });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// ── EINSTELLUNGEN ─────────────────────────────────────────────────────────────
app.post('/api/user-settings', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const { wochenstunden, darkMode, employees, setupDone, defaultPause, weekPatterns, season, urlaubsanspruch, ueberstundenOverride, urlaubGenommen } = req.body;
    // alle Konfigurationen im employees-JSON mitgespeichert
    const empData = JSON.stringify([{
      id: 1, name: req.session.name,
      defaultPause: parseInt(defaultPause) || 30,
      urlaubsanspruch: parseInt(urlaubsanspruch) || 30,
      weekPatterns: weekPatterns || {},
      season: season || 'auto',
      ueberstundenOverride: ueberstundenOverride || {},
      urlaubGenommen: urlaubGenommen || {}
    }]);

    const updateData = {
      wochenstunden: wochenstunden || 38.5,
      darkMode: !!darkMode,
      setupDone: setupDone === true,
      employees: empData
    };

    const settings = await prisma.settings.upsert({
      where: { userId: req.session.userId },
      update: updateData,
      create: { userId: req.session.userId, ...updateData }
    });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

app.get('/api/user-settings', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const settings = await prisma.settings.findUnique({ where: { userId: req.session.userId } });
    if (!settings) return res.json({});
    const empArr = JSON.parse(settings.employees || '[]');
    const defaultPause = (empArr[0] && empArr[0].defaultPause) || 30;
    const urlaubsanspruch = (empArr[0] && empArr[0].urlaubsanspruch) || 30;
    const weekPatterns  = (empArr[0] && empArr[0].weekPatterns)  || {};
    const season        = (empArr[0] && empArr[0].season)        || 'auto';
    const ueberstundenOverride = (empArr[0] && empArr[0].ueberstundenOverride) || {};
    const urlaubGenommen = (empArr[0] && empArr[0].urlaubGenommen) || {};
    res.json({
      wochenstunden: settings.wochenstunden,
      darkMode: settings.darkMode,
      setupDone: settings.setupDone,
      defaultPause,
      urlaubsanspruch,
      weekPatterns,
      season,
      ueberstundenOverride,
      urlaubGenommen,
      employees: [{ id: 1, name: req.session.name, entries: {} }]
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// ── SONDERTAGE (öffentlich für eingeloggte Nutzer + Admin-Verwaltung) ────────
app.get('/api/special-days', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const days = await prisma.specialDay.findMany({ orderBy: { date: 'asc' } });
    res.json({ days });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// Erlaubte Typen fuer Sondertage
const SPECIAL_DAY_TYPES = ['inventur', 'closed', 'schulung'];

// Safety-Net: rangeId-Spalte hinzufuegen falls sie noch nicht existiert
let specialDayRangeIdEnsured = false;
async function ensureSpecialDayRangeId() {
  if (specialDayRangeIdEnsured) return;
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "SpecialDay" ADD COLUMN IF NOT EXISTS "rangeId" TEXT`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "SpecialDay_rangeId_idx" ON "SpecialDay"("rangeId")`
    );
    specialDayRangeIdEnsured = true;
  } catch (err) {
    console.error('ensureSpecialDayRangeId error:', err);
  }
}

app.post('/api/admin/special-day', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureSpecialDayRangeId();
  try {
    const { date, type, label } = req.body;
    if (!date || !type) return res.status(400).json({ error: 'Datum und Typ erforderlich' });
    if (!SPECIAL_DAY_TYPES.includes(type))
      return res.status(400).json({ error: 'Ungueltiger Typ' });

    const day = await prisma.specialDay.upsert({
      where: { date },
      update: { type, label: label || '', rangeId: null },
      create: { date, type, label: label || '' }
    });
    res.json({ success: true, day });
  } catch (err) {
    console.error('special-day error:', err);
    res.status(500).json({ error: 'Fehler beim Speichern: '+(err.message||err) });
  }
});

// Bereich anlegen: ein Eintrag pro Tag, alle mit selber rangeId
app.post('/api/admin/special-day-range', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureSpecialDayRangeId();
  try {
    const { startDate, endDate, type, label } = req.body;
    if (!startDate || !endDate || !type)
      return res.status(400).json({ error: 'Start, Ende und Typ erforderlich' });
    if (!SPECIAL_DAY_TYPES.includes(type))
      return res.status(400).json({ error: 'Ungueltiger Typ' });
    if (startDate > endDate)
      return res.status(400).json({ error: 'Start muss vor Ende liegen' });

    // rangeId generieren
    const rangeId = 'rng_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Alle Tage zwischen Start und Ende anlegen
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    const days = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      days.push(dateStr);
    }
    if (days.length > 366)
      return res.status(400).json({ error: 'Zeitraum zu lang (max. 366 Tage)' });

    // Upsert jeder Tag — vorhandene Eintraege werden ueberschrieben
    const created = [];
    for (const dateStr of days) {
      const day = await prisma.specialDay.upsert({
        where: { date: dateStr },
        update: { type, label: label || '', rangeId },
        create: { date: dateStr, type, label: label || '', rangeId }
      });
      created.push(day);
    }
    res.json({ success: true, days: created, rangeId, count: created.length });
  } catch (err) {
    console.error('special-day-range error:', err);
    res.status(500).json({ error: 'Fehler beim Speichern: '+(err.message||err) });
  }
});

// Einzelnen Tag bearbeiten (Typ / Label)
app.put('/api/admin/special-day/:date', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureSpecialDayRangeId();
  try {
    const { type, label } = req.body;
    if (!type) return res.status(400).json({ error: 'Typ erforderlich' });
    if (!SPECIAL_DAY_TYPES.includes(type))
      return res.status(400).json({ error: 'Ungueltiger Typ' });

    const day = await prisma.specialDay.update({
      where: { date: req.params.date },
      data: { type, label: label || '' }
    });
    res.json({ success: true, day });
  } catch (err) {
    console.error('special-day PUT error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren: '+(err.message||err) });
  }
});

// Ganze Range bearbeiten (Typ / Label aller Tage)
app.put('/api/admin/special-day-range/:rangeId', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureSpecialDayRangeId();
  try {
    const { type, label } = req.body;
    if (!type) return res.status(400).json({ error: 'Typ erforderlich' });
    if (!SPECIAL_DAY_TYPES.includes(type))
      return res.status(400).json({ error: 'Ungueltiger Typ' });

    const result = await prisma.specialDay.updateMany({
      where: { rangeId: req.params.rangeId },
      data: { type, label: label || '' }
    });
    res.json({ success: true, count: result.count });
  } catch (err) {
    console.error('special-day-range PUT error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren: '+(err.message||err) });
  }
});

app.delete('/api/admin/special-day/:date', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  try {
    await prisma.specialDay.deleteMany({ where: { date: req.params.date } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// Ganze Range loeschen
app.delete('/api/admin/special-day-range/:rangeId', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureSpecialDayRangeId();
  try {
    const result = await prisma.specialDay.deleteMany({ where: { rangeId: req.params.rangeId } });
    res.json({ success: true, count: result.count });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Loeschen: '+(err.message||err) });
  }
});

// ── ELTERNZEIT ────────────────────────────────────────────────────────────────
// Safety-Net: Tabelle anlegen falls noch nicht vorhanden (z.B. wenn Vercel
// das build/postinstall-Script nicht ausgefuehrt hat).
let parentalLeaveTableEnsured = false;
async function ensureParentalLeaveTable() {
  if (parentalLeaveTableEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ParentalLeave" (
        "id" TEXT PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "startDate" TEXT NOT NULL,
        "endDate" TEXT NOT NULL,
        "note" TEXT NOT NULL DEFAULT '',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ParentalLeave_userId_fkey" FOREIGN KEY ("userId")
          REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "ParentalLeave_userId_idx" ON "ParentalLeave"("userId")`
    );
    parentalLeaveTableEnsured = true;
    console.log('✓ ParentalLeave Tabelle vorhanden / angelegt');
  } catch (err) {
    console.error('ensureParentalLeaveTable error:', err);
  }
}

// Mitarbeiter ruft eigene Elternzeiten ab (zum Sperren im Kalender)
app.get('/api/parental-leave', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  await ensureParentalLeaveTable();
  try {
    const leaves = await prisma.parentalLeave.findMany({
      where: { userId: req.session.userId },
      orderBy: { startDate: 'asc' }
    });
    res.json({ leaves });
  } catch (err) {
    console.error('parental-leave GET error:', err);
    res.status(500).json({ error: 'Fehler beim Laden: '+(err.message||err) });
  }
});

// Admin: alle Elternzeiten mit Mitarbeiter-Info
app.get('/api/admin/parental-leave', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureParentalLeaveTable();
  try {
    const leaves = await prisma.parentalLeave.findMany({
      include: { user: { select: { id: true, name: true, username: true } } },
      orderBy: [{ startDate: 'desc' }]
    });
    res.json({ leaves });
  } catch (err) {
    console.error('admin parental-leave GET error:', err);
    res.status(500).json({ error: 'Fehler beim Laden: '+(err.message||err) });
  }
});

// Admin: Elternzeit anlegen
app.post('/api/admin/parental-leave', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureParentalLeaveTable();
  try {
    const { userId, startDate, endDate, note } = req.body;
    if (!userId || !startDate || !endDate) {
      return res.status(400).json({ error: 'Mitarbeiter, Von- und Bis-Datum erforderlich' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'Von-Datum muss vor Bis-Datum liegen' });
    }
    const leave = await prisma.parentalLeave.create({
      data: { userId, startDate, endDate, note: note || '' }
    });
    res.json({ success: true, leave });
  } catch (err) {
    console.error('admin parental-leave POST error:', err);
    res.status(500).json({ error: 'Fehler beim Speichern: '+(err.message||err) });
  }
});

// Admin: Elternzeit bearbeiten
app.put('/api/admin/parental-leave/:id', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureParentalLeaveTable();
  try {
    const { startDate, endDate, note } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Von- und Bis-Datum erforderlich' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'Von-Datum muss vor Bis-Datum liegen' });
    }
    const leave = await prisma.parentalLeave.update({
      where: { id: req.params.id },
      data: { startDate, endDate, note: note || '' }
    });
    res.json({ success: true, leave });
  } catch (err) {
    console.error('admin parental-leave PUT error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren: '+(err.message||err) });
  }
});

// Admin: Elternzeit löschen
app.delete('/api/admin/parental-leave/:id', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  await ensureParentalLeaveTable();
  try {
    await prisma.parentalLeave.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('admin parental-leave DELETE error:', err);
    res.status(500).json({ error: 'Fehler beim Löschen: '+(err.message||err) });
  }
});

// ── ADMIN API ─────────────────────────────────────────────────────────────────
app.post('/api/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.isAdmin || !bcryptjs.compareSync(password, user.password))
      return res.status(401).json({ error: 'Ungültige Admin-Anmeldedaten' });

    req.session.userId = user.id;
    req.session.username = username;
    req.session.name = user.name;
    req.session.isAdmin = true;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Admin-Login' });
  }
});

// Admin-Registrierung: Code verifizieren
app.post('/api/verify-admin-code', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code erforderlich' });

    const validCode = process.env.ADMIN_REGISTER_CODE;
    if (!validCode) return res.status(500).json({ error: 'Kein Registrierungscode konfiguriert' });

    // Prüfen ob Code bereits verwendet wurde
    const codeUsed = await prisma.adminCodeUsage.findFirst({
      where: { code: validCode, used: true }
    });

    if (codeUsed) {
      return res.status(403).json({ error: 'Dieser Code wurde bereits verwendet' });
    }

    if (code !== validCode) {
      return res.status(401).json({ error: 'Ungültiger Code' });
    }

    res.json({ success: true, message: 'Code verifiziert' });
  } catch (err) {
    console.error('Verify code error:', err);
    res.status(500).json({ error: 'Fehler bei Code-Verifikation' });
  }
});

// Admin-Registrierung: Neuen Admin anlegen
// TEMPORAERER TEST-CODE — beliebig oft verwendbar, unabhaengig von der Env-Variable.
// Nach Abschluss der Tests entfernen!
const TEST_ADMIN_REGISTER_CODE = 'TEST-ADMIN-2026';

app.post('/api/register-admin', async (req, res) => {
  try {
    const { code, name, username, password } = req.body;
    if (!code || !name || !username || !password) {
      return res.status(400).json({ error: 'Alle Felder erforderlich' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
    }

    const validCode = process.env.ADMIN_REGISTER_CODE;
    const isTestCode = code === TEST_ADMIN_REGISTER_CODE;
    const isValidEnvCode = validCode && code === validCode;

    if (!isTestCode && !isValidEnvCode) {
      return res.status(401).json({ error: 'Ungültiger Code' });
    }

    // Beim Test-Code KEINE Einmal-Pruefung — kann beliebig oft verwendet werden
    if (!isTestCode) {
      const codeUsed = await prisma.adminCodeUsage.findFirst({
        where: { code: validCode, used: true }
      });
      if (codeUsed) {
        return res.status(403).json({ error: 'Dieser Code wurde bereits verwendet' });
      }
    }

    // Prüfen ob Username bereits existiert
    const exists = await prisma.user.findUnique({ where: { username } });
    if (exists) {
      return res.status(400).json({ error: 'Benutzername existiert bereits' });
    }

    // Admin-User anlegen
    const hash = bcryptjs.hashSync(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        name,
        password: hash,
        isAdmin: true
      }
    });

    // Code als verwendet markieren (nur fuer echten Env-Code, nicht fuer Test-Code)
    if (!isTestCode) {
      await prisma.adminCodeUsage.create({
        data: {
          code: validCode,
          used: true,
          usedBy: username,
          usedAt: new Date()
        }
      });
    }

    res.json({ success: true, message: 'Admin-Account erfolgreich erstellt' });
  } catch (err) {
    console.error('Register admin error:', err);
    res.status(500).json({ error: 'Fehler bei Admin-Registrierung' });
  }
});

// Liste aller Mitarbeiter (ohne Admins und Super-Admins)
app.get('/api/admin/users', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  try {
    const users = await prisma.user.findMany({
      where: {
        isAdmin: false,
        isSuperAdmin: false
      },
      select: { id: true, username: true, name: true, createdAt: true },
      orderBy: { name: 'asc' }
    });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Mitarbeiter' });
  }
});

// Einträge eines Mitarbeiters (read-only)
app.get('/api/admin/entries/:userId', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  try {
    const entries = await prisma.entry.findMany({
      where: { userId: req.params.userId },
      orderBy: { date: 'asc' }
    });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Einträge' });
  }
});

// Settings eines Mitarbeiters (für Wochenstunden / Saldo)
app.get('/api/admin/settings/:userId', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  try {
    const settings = await prisma.settings.findUnique({
      where: { userId: req.params.userId }
    });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Einstellungen' });
  }
});

// Admin: Alle Locks aller Mitarbeiter
app.get('/api/admin/month-locks', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  try {
    const locks = await prisma.monthLock.findMany({
      include: { user: { select: { id: true, name: true, username: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }]
    });
    res.json({ locks });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// Admin: Locks pro Mitarbeiter
app.get('/api/admin/month-locks/:userId', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  try {
    const locks = await prisma.monthLock.findMany({
      where: { userId: req.params.userId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }]
    });
    res.json({ locks });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// Admin: Monat freigeben
app.delete('/api/admin/month-lock/:userId/:year/:month', async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Nicht autorisiert' });
  try {
    await prisma.monthLock.deleteMany({
      where: {
        userId: req.params.userId,
        year: parseInt(req.params.year),
        month: parseInt(req.params.month)
      }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Freigeben' });
  }
});

// ── SUPER-ADMIN SEITEN & API ─────────────────────────────────────────────────
app.get('/super-admin-login', noCache, (req, res) => {
  if (req.session.isSuperAdmin) return res.redirect('/super-admin');
  res.sendFile(path.join(__dirname, 'public', 'super-admin-login.html'));
});

app.get('/super-admin', noCache, (req, res) => {
  if (!req.session.userId || !req.session.isSuperAdmin) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'super-admin.html'));
});

app.post('/api/super-admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.isSuperAdmin || !bcryptjs.compareSync(password, user.password))
      return res.status(401).json({ error: 'Ungültige Super-Admin-Anmeldedaten' });

    req.session.userId = user.id;
    req.session.username = username;
    req.session.name = user.name;
    req.session.isSuperAdmin = true;

    res.json({ success: true });
  } catch (err) {
    console.error('Super-Admin login error:', err);
    res.status(500).json({ error: 'Fehler beim Super-Admin-Login' });
  }
});

app.post('/api/super-admin/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

app.get('/api/super-admin/all-users', async (req, res) => {
  if (!req.session.isSuperAdmin) return res.status(401).json({ error: 'Nicht autorisiert' });
  try {
    const users = await prisma.user.findMany({
      where: { isAdmin: false, isSuperAdmin: false },
      select: { id: true, username: true, name: true, createdAt: true }
    });
    res.json(users);
  } catch (err) {
    console.error('Get all users error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Mitarbeiter' });
  }
});

app.get('/api/super-admin/entries/:userId', async (req, res) => {
  if (!req.session.isSuperAdmin) return res.status(401).json({ error: 'Nicht autorisiert' });
  try {
    const { userId } = req.params;
    const { year, month } = req.query;

    let entries;
    if (year && month) {
      // Filter by month
      const y = parseInt(year);
      const m = parseInt(month);
      const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
      const endDate = `${y}-${String(m).padStart(2, '0')}-31`;

      entries = await prisma.entry.findMany({
        where: {
          userId,
          date: { gte: startDate, lte: endDate }
        },
        orderBy: { date: 'asc' }
      });
    } else {
      // All entries
      entries = await prisma.entry.findMany({
        where: { userId },
        orderBy: { date: 'asc' }
      });
    }

    res.json({ entries });
  } catch (err) {
    console.error('Get entries error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Einträge' });
  }
});

app.get('/api/super-admin/settings/:userId', async (req, res) => {
  if (!req.session.isSuperAdmin) return res.status(401).json({ error: 'Nicht autorisiert' });
  try {
    const { userId } = req.params;
    const settings = await prisma.settings.findUnique({ where: { userId } });
    // Gibt Settings im gleichen Format wie /api/admin/settings/:userId zurück
    res.json({ settings });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Einstellungen' });
  }
});

// ── START ──────────────────────────────────────────────────────────────────────
// Lokal: Server starten. Auf Vercel: App exportieren.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server läuft auf http://localhost:${PORT}`);
  });
}

module.exports = app;
