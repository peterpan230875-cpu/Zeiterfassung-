const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcryptjs = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ENTRIES_FILE = path.join(DATA_DIR, 'entries.json');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'zeiterfassung-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// JSON-Datei laden
function loadData(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// JSON-Datei speichern
function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Login-Seite
app.get('/', (req, res) => {
  if (req.session.userId) {
    res.redirect('/app');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
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
app.post('/api/register', (req, res) => {
  const { username, password, name } = req.body;

  if (!username || !password || !name) {
    return res.status(400).json({ error: 'Alle Felder erforderlich' });
  }

  let users = loadData(USERS_FILE);

  if (users[username]) {
    return res.status(400).json({ error: 'Benutzer existiert bereits' });
  }

  const hash = bcryptjs.hashSync(password, 10);
  users[username] = {
    id: Date.now().toString(),
    name: name,
    password: hash,
    createdAt: new Date().toISOString()
  };

  saveData(USERS_FILE, users);
  res.json({ success: true, message: 'Registrierung erfolgreich' });
});

// API: Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  let users = loadData(USERS_FILE);
  const user = users[username];

  if (!user || !bcryptjs.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  req.session.userId = user.id;
  req.session.username = username;
  req.session.name = user.name;

  res.json({ success: true, message: 'Login erfolgreich', user: { username, name: user.name } });
});

// API: Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logout erfolgreich' });
});

// API: Benutzerinfo
app.get('/api/user', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  res.json({
    userId: req.session.userId,
    username: req.session.username,
    name: req.session.name
  });
});

// API: Eintrag speichern
app.post('/api/entry', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const { date, type, von, bis, pause, bemerkung } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Datum erforderlich' });
  }

  let entries = loadData(ENTRIES_FILE);
  const entryKey = `${req.session.userId}_${date}`;

  entries[entryKey] = {
    userId: req.session.userId,
    username: req.session.username,
    date: date,
    type: type || 'normal',
    von: von,
    bis: bis,
    pause: pause || 0,
    bemerkung: bemerkung || '',
    savedAt: new Date().toISOString()
  };

  saveData(ENTRIES_FILE, entries);
  res.json({ success: true, entry: entries[entryKey] });
});

// API: Einträge laden
app.get('/api/entries', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  let entries = loadData(ENTRIES_FILE);
  const userEntries = Object.values(entries).filter(e => e.userId === req.session.userId);

  res.json({ entries: userEntries });
});

// API: Eintrag löschen
app.delete('/api/entry/:date', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Nicht authentifiziert' });
  }

  const entryKey = `${req.session.userId}_${req.params.date}`;
  let entries = loadData(ENTRIES_FILE);

  delete entries[entryKey];
  saveData(ENTRIES_FILE, entries);

  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n✓ Zeiterfassung-App läuft auf http://localhost:${PORT}`);
  console.log(`  Login: http://localhost:${PORT}`);
  console.log(`  Daten werden in: ${DATA_DIR} gespeichert\n`);
});
