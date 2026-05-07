const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcryptjs = require('bcryptjs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const app = express();
const PORT = process.env.PORT || 3000;
const prisma = new PrismaClient();

// Session speichern in Memory (für Vercel)
const sessions = {};

class MemorySessionStore extends session.Store {
  get(sid, callback) {
    const sess = sessions[sid];
    callback(null, sess);
  }

  set(sid, sess, callback) {
    sessions[sid] = sess;
    callback(null);
  }

  destroy(sid, callback) {
    delete sessions[sid];
    callback(null);
  }

  clear(callback) {
    Object.keys(sessions).forEach(key => delete sessions[key]);
    callback(null);
  }
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new MemorySessionStore(),
  secret: process.env.SESSION_SECRET || 'zeiterfassung-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

// Test-Route
app.get('/test', (req, res) => {
  res.json({ status: 'ok', message: 'Server läuft!' });
});

// Login-Seite
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/app');
  } else {
    const loginPath = path.join(__dirname, 'public', 'login.html');
    try {
      const fs = require('fs');
      const fileContent = fs.readFileSync(loginPath, 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(fileContent);
    } catch (err) {
      res.status(500).send('Fehler: login.html nicht gefunden');
    }
  }
});

// App-Seite
app.get('/app', (req, res) => {
  if (!req.session.userId) {
    res.redirect('/');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
  }
});

// API: Registrierung
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;

    if (!username || !password || !name) {
      return res.status(400).json({ error: 'Alle Felder erforderlich' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { username }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Benutzer existiert bereits' });
    }

    const hash = bcryptjs.hashSync(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        name,
        password: hash
      }
    });

    // Erstelle Standard-Settings
    await prisma.settings.create({
      data: {
        userId: user.id,
        wochenstunden: 38.5,
        darkMode: false,
        emailTo: '',
        employees: JSON.stringify([
          { id: 1, name: "Max Müller" },
          { id: 2, name: "Anna Schmidt" },
          { id: 3, name: "Peter Weber" }
        ])
      }
    });

    res.json({ success: true, message: 'Registrierung erfolgreich' });
  } catch (error) {
    console.error('Registrierungsfehler:', error);
    res.status(500).json({ error: 'Fehler bei Registrierung' });
  }
});

// API: Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
    }

    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user || !bcryptjs.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }

    req.session.userId = user.id;
    req.session.username = username;
    req.session.name = user.name;

    res.json({ success: true, message: 'Login erfolgreich', user: { username, name: user.name } });
  } catch (error) {
    console.error('Loginfehler:', error);
    res.status(500).json({ error: 'Fehler bei Login' });
  }
});

// API: Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logout erfolgreich' });
});

// API: Benutzerinfo
app.get('/api/user', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId }
    });

    res.json({
      userId: user.id,
      username: req.session.username,
      name: user.name
    });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Benutzerinfo' });
  }
});

// API: Eintrag speichern
app.post('/api/entry', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  try {
    const { date, type, von, bis, pause, bemerkung } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Datum erforderlich' });
    }

    const entry = await prisma.entry.upsert({
      where: {
        userId_date: {
          userId: req.session.userId,
          date: date
        }
      },
      update: {
        type: type || 'normal',
        von: von || null,
        bis: bis || null,
        pause: pause || 0,
        bemerkung: bemerkung || ''
      },
      create: {
        userId: req.session.userId,
        date: date,
        type: type || 'normal',
        von: von || null,
        bis: bis || null,
        pause: pause || 0,
        bemerkung: bemerkung || ''
      }
    });

    res.json({ success: true, entry });
  } catch (error) {
    console.error('Fehler beim Speichern des Eintrags:', error);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// API: Einträge laden
app.get('/api/entries', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  try {
    const entries = await prisma.entry.findMany({
      where: { userId: req.session.userId }
    });

    res.json({ entries });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Einträge' });
  }
});

// API: Eintrag löschen
app.delete('/api/entry/:date', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  try {
    await prisma.entry.delete({
      where: {
        userId_date: {
          userId: req.session.userId,
          date: req.params.date
        }
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Löschen:', error);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// API: Einstellungen speichern
app.post('/api/user-settings', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  try {
    const { wochenstunden, darkMode, emailTo, employees } = req.body;

    const settings = await prisma.settings.upsert({
      where: { userId: req.session.userId },
      update: {
        wochenstunden: wochenstunden || 38.5,
        darkMode: darkMode || false,
        emailTo: emailTo || '',
        employees: JSON.stringify(employees || [])
      },
      create: {
        userId: req.session.userId,
        wochenstunden: wochenstunden || 38.5,
        darkMode: darkMode || false,
        emailTo: emailTo || '',
        employees: JSON.stringify(employees || [])
      }
    });

    res.json({ success: true, settings });
  } catch (error) {
    console.error('Fehler beim Speichern der Einstellungen:', error);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// API: Einstellungen laden
app.get('/api/user-settings', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  try {
    const settings = await prisma.settings.findUnique({
      where: { userId: req.session.userId }
    });

    if (!settings) {
      return res.json({});
    }

    res.json({
      wochenstunden: settings.wochenstunden,
      darkMode: settings.darkMode,
      emailTo: settings.emailTo,
      employees: JSON.parse(settings.employees || '[]')
    });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Einstellungen' });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Zeiterfassung-App läuft auf http://0.0.0.0:${PORT}`);
  console.log(`  Login: http://localhost:${PORT}`);
});

server.on('error', (err) => {
  console.error('Server Fehler:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
