# Super-Admin Einrichtung

## Was ist der Super-Admin?

Der **Super-Admin** hat vollständigen Lesezugriff auf alle Mitarbeiterdaten, kann aber keine Änderungen vornehmen.

### Unterschied zwischen Admin und Super-Admin:

| Feature | Regulärer Admin | Super-Admin |
|---------|----------------|-------------|
| Mitarbeiterdaten ansehen | ✅ Nur abgeschlossene Monate | ✅ **Alle Daten live** |
| Monat wieder freigeben | ✅ Ja | ❌ Nein (read-only) |
| Sondertage verwalten | ✅ Ja | ❌ Nein |
| Daten bearbeiten | ❌ Nein | ❌ Nein |

## Super-Admin Account erstellen

### Manuell in der Datenbank

Da der Super-Admin **volle Einsicht in alle Daten** hat, muss dieser Account manuell in der Datenbank erstellt werden.

**Schritte:**

1. **Neuen Benutzer anlegen** (über die normale Registrierung auf der Website)
   - Benutzername wählen (z.B. `superadmin`)
   - Sicheres Passwort vergeben
   - Registrierung abschließen

2. **isSuperAdmin Flag in der Datenbank setzen:**

   ```sql
   UPDATE "User" 
   SET "isSuperAdmin" = true 
   WHERE username = 'superadmin';
   ```

   ⚠️ **Wichtig:** Ersetze `'superadmin'` mit dem tatsächlichen Benutzernamen.

3. **Fertig!** Der Benutzer kann sich jetzt unter `/super-admin-login` anmelden.

### Über Prisma Studio (empfohlen)

1. Prisma Studio starten:
   ```bash
   npx prisma studio
   ```

2. Im Browser öffnet sich `http://localhost:5555`

3. Navigiere zu **User** Tabelle

4. Finde den gewünschten Benutzer

5. Setze das Feld `isSuperAdmin` auf `true`

6. Speichern ✓

## Zugriff auf Super-Admin Portal

- **Login:** Über die normale Login-Seite [https://zeiterfassung-green-two.vercel.app/](https://zeiterfassung-green-two.vercel.app/)
- Das System erkennt automatisch anhand von Benutzername und Passwort, dass es sich um einen Super-Admin handelt
- Nach dem Login erfolgt automatische Weiterleitung zum Super-Admin Portal (`/super-admin`)

## Sicherheitshinweise

⚠️ **Der Super-Admin hat Zugriff auf alle sensiblen Mitarbeiterdaten!**

- Verwende ein **sehr starkes Passwort** (min. 12 Zeichen, Groß-/Kleinbuchstaben, Zahlen, Sonderzeichen)
- Teile die Zugangsdaten **niemals** mit unbefugten Personen
- Erstelle **nur einen** Super-Admin Account
- Ändere das Passwort regelmäßig
- Bei Verdacht auf Missbrauch: Sofort `isSuperAdmin` in der DB auf `false` setzen

---

**Version:** 2.8  
**Entwickelt von:** S.Michlenz
