// ── SERVER SYNC ──────────────────────────────────────────────────────────
// Diese Datei synchronisiert die Daten mit dem Server statt localStorage zu nutzen

let syncEnabled = true;

// Beim Laden: Lade Einträge vom Server
async function syncLoadEntries() {
  try {
    const res = await fetch('/api/entries');
    if (!res.ok) return false;

    const data = await res.json();
    if (!data.entries) return false;

    // Übertrage Server-Einträge in den State
    const emp = curEmp();
    emp.entries = {};

    data.entries.forEach(entry => {
      if (entry.userId === state.employees[state.selEmp].id || !entry.userId) {
        emp.entries[entry.date] = {
          typ: entry.type,
          von: entry.von,
          bis: entry.bis,
          pause: entry.pause,
          bemerkung: entry.bemerkung
        };
      }
    });

    return true;
  } catch (err) {
    console.error('Fehler beim Laden der Einträge:', err);
    return false;
  }
}

// Beim Speichern: Speichere auf dem Server
async function syncSaveEntry(date, entryData) {
  if (!syncEnabled) return false;

  try {
    const res = await fetch('/api/entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: date,
        type: entryData.typ || 'normal',
        von: entryData.von,
        bis: entryData.bis,
        pause: entryData.pause,
        bemerkung: entryData.bemerkung
      })
    });

    if (!res.ok) {
      console.error('Fehler beim Speichern auf Server');
      return false;
    }

    return true;
  } catch (err) {
    console.error('Fehler beim Server-Sync:', err);
    return false;
  }
}

// Beim Löschen: Lösche auf dem Server
async function syncDeleteEntry(date) {
  if (!syncEnabled) return false;

  try {
    const res = await fetch(`/api/entry/${date}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      console.error('Fehler beim Löschen auf Server');
      return false;
    }

    return true;
  } catch (err) {
    console.error('Fehler beim Server-Sync:', err);
    return false;
  }
}

// Überschreibe die localStorage-Funktionen
const originalSaveState = saveState;
const originalLoadState = loadState;

saveState = function() {
  // Speichere lokal (als Backup)
  localStorage.setItem("zt_v3", JSON.stringify(state));
};

loadState = function() {
  // Lade von localStorage
  try {
    return JSON.parse(localStorage.getItem("zt_v3"));
  } catch (e) {
    return null;
  }
};
