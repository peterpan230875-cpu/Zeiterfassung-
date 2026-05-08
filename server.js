const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcryptjs = require('bcryptjs');
const path = require('path');
const nodemailer = require('nodemailer');
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

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/app', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
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
    await prisma.entry.deleteMany({
      where: { userId: req.session.userId, date: req.params.date }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// ── EINSTELLUNGEN ─────────────────────────────────────────────────────────────
app.post('/api/user-settings', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const { wochenstunden, darkMode, emailTo, employees, setupDone, defaultPause, smtpUser, smtpPass, weekPatterns } = req.body;
    // defaultPause + weekPatterns im employees-JSON mitgespeichert
    const empData = JSON.stringify([{
      id: 1, name: req.session.name,
      defaultPause: parseInt(defaultPause) || 30,
      weekPatterns: weekPatterns || {}
    }]);

    const updateData = {
      wochenstunden: wochenstunden || 38.5,
      darkMode: !!darkMode,
      emailTo: emailTo || '',
      setupDone: setupDone === true,
      employees: empData
    };
    if (smtpUser !== undefined) updateData.smtpUser = smtpUser || '';
    // Passwort nur überschreiben wenn explizit mitgesendet (nicht leer lassen = behalten)
    if (smtpPass && smtpPass.trim() !== '') updateData.smtpPass = smtpPass.trim();

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
    const weekPatterns  = (empArr[0] && empArr[0].weekPatterns)  || {};
    res.json({
      wochenstunden: settings.wochenstunden,
      darkMode: settings.darkMode,
      emailTo: settings.emailTo,
      setupDone: settings.setupDone,
      defaultPause,
      smtpUser: settings.smtpUser || '',
      smtpPassSet: !!(settings.smtpPass && settings.smtpPass.trim()),
      weekPatterns,
      employees: [{ id: 1, name: req.session.name, entries: {} }]
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// ── E-MAIL MIT PDF-ANHANG ─────────────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht authentifiziert' });
  try {
    const { to, subject, pdfBase64, filename } = req.body;
    if (!to || !pdfBase64) return res.status(400).json({ error: 'Fehlende Parameter' });

    // Nutzer-eigene SMTP-Einstellungen laden, Fallback auf Umgebungsvariablen
    const userSettings = await prisma.settings.findUnique({ where: { userId: req.session.userId } });
    const smtpUser = (userSettings && userSettings.smtpUser && userSettings.smtpUser.trim())
      || process.env.SMTP_USER;
    const smtpPass = (userSettings && userSettings.smtpPass && userSettings.smtpPass.trim())
      || process.env.SMTP_PASS;

    if (!smtpUser || !smtpPass) {
      return res.status(500).json({
        error: 'E-Mail nicht konfiguriert. Bitte Absender-E-Mail und App-Passwort in den Einstellungen hinterlegen.'
      });
    }

    const smtpHost = process.env.SMTP_HOST || 'smtp.mail.yahoo.com';
    const smtpPort = parseInt(process.env.SMTP_PORT) || 465;
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,   // 465 = SSL, 587 = STARTTLS
      auth: { user: smtpUser, pass: smtpPass }
    });

    await transporter.sendMail({
      from: `"Zeiterfassung" <${smtpUser}>`,
      to,
      subject,
      text: 'Zeiterfassung im Anhang als PDF.',
      attachments: [{
        filename: filename || 'zeiterfassung.pdf',
        content: Buffer.from(pdfBase64, 'base64'),
        contentType: 'application/pdf'
      }]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Fehler beim Senden: ' + err.message });
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
