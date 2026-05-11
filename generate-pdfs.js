/**
 * PDF-Anleitungen Generator für Zeiterfassung v2.8
 * Konvertiert HTML-Anleitungen zu PDFs mit Puppeteer
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function convertHTMLtoPDF(htmlPath, pdfPath) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();

        // HTML-Datei als absolute URL laden
        const absolutePath = path.resolve(htmlPath);
        await page.goto(`file:///${absolutePath.replace(/\\/g, '/')}`, {
            waitUntil: 'networkidle0'
        });

        // PDF generieren mit A4 Format
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '14mm',
                right: '12mm',
                bottom: '14mm',
                left: '12mm'
            }
        });

        console.log(`✓ ${path.basename(pdfPath)} erstellt`);
        return true;
    } catch (error) {
        console.error(`✗ Fehler bei ${htmlPath}:`, error.message);
        return false;
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('PDF-Anleitungen Generator für Zeiterfassung v2.8');
    console.log('='.repeat(60));
    console.log();

    const files = [
        {
            html: 'public/anleitung-mitarbeiter.html',
            pdf: 'Anleitung-Mitarbeiter.pdf'
        },
        {
            html: 'public/anleitung-admin.html',
            pdf: 'Anleitung-Admin.pdf'
        }
    ];

    let successCount = 0;

    for (const file of files) {
        if (fs.existsSync(file.html)) {
            const success = await convertHTMLtoPDF(file.html, file.pdf);
            if (success) successCount++;
        } else {
            console.log(`✗ Datei nicht gefunden: ${file.html}`);
        }
    }

    console.log();
    console.log('='.repeat(60));

    if (successCount === files.length) {
        console.log(`✅ Alle ${successCount} PDFs wurden erfolgreich erstellt!`);
        console.log();
        console.log('Erstellte Dateien:');

        for (const file of files) {
            if (fs.existsSync(file.pdf)) {
                const stats = fs.statSync(file.pdf);
                const sizeKB = (stats.size / 1024).toFixed(1);
                console.log(`   • ${file.pdf} (${sizeKB} KB)`);
            }
        }
    } else {
        console.log(`⚠️  ${successCount} von ${files.length} PDFs erstellt`);
    }
}

main().catch(console.error);
