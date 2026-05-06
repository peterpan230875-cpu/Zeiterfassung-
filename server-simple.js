const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Super-einfache Test-Route
app.get('/', (req, res) => {
  res.send('<h1>✅ Server läuft!</h1><p>Express funktioniert!</p>');
});

app.get('/api/test', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
