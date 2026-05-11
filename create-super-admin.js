const { PrismaClient } = require('@prisma/client');
const bcryptjs = require('bcryptjs');

const prisma = new PrismaClient();

async function createSuperAdmin() {
  const username = 'super-admin';
  const name = 'Super Administrator';
  const password = 'S!perAdm1n#2026$Secure'; // Starkes Passwort

  try {
    // Prüfen ob User bereits existiert
    const existing = await prisma.user.findUnique({ where: { username } });

    if (existing) {
      console.log('❌ Benutzer "super-admin" existiert bereits!');
      console.log('');
      console.log('Setze isSuperAdmin auf true...');

      await prisma.user.update({
        where: { username },
        data: { isSuperAdmin: true }
      });

      console.log('✅ Super-Admin Flag wurde gesetzt!');
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('🔐 LOGIN-DATEN:');
      console.log('═══════════════════════════════════════════');
      console.log('Benutzername: super-admin');
      console.log('Passwort: (dein bestehendes Passwort verwenden)');
      console.log('═══════════════════════════════════════════');
      console.log('');
      console.log('Falls du das Passwort ändern möchtest, lösche den');
      console.log('User erst und führe das Skript erneut aus.');

    } else {
      // Neuen Super-Admin erstellen
      const hash = bcryptjs.hashSync(password, 10);

      const user = await prisma.user.create({
        data: {
          username,
          name,
          password: hash,
          isSuperAdmin: true,
          isAdmin: false
        }
      });

      // Settings erstellen
      await prisma.settings.create({
        data: {
          userId: user.id,
          wochenstunden: 40,
          darkMode: false,
          emailTo: '',
          setupDone: true,
          employees: JSON.stringify([])
        }
      });

      console.log('✅ Super-Admin Account erfolgreich erstellt!');
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('🔐 LOGIN-DATEN:');
      console.log('═══════════════════════════════════════════');
      console.log('Benutzername: super-admin');
      console.log('Passwort:     S!perAdm1n#2026$Secure');
      console.log('═══════════════════════════════════════════');
      console.log('');
      console.log('⚠️  WICHTIG: Notiere dir das Passwort sicher!');
      console.log('');
      console.log('🌐 Login: https://zeiterfassung-green-two.vercel.app/');
      console.log('   → Automatische Weiterleitung zum Super-Admin Portal');
    }

  } catch (err) {
    console.error('❌ Fehler:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

createSuperAdmin();
