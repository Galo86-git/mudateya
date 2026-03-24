// api/admin-data.js
// Lee datos de Google Sheets para el panel de admin

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  var type = req.query.type; // 'mudanceros' | 'pagos'

  if (!type) {
    return res.status(400).json({ error: 'Falta parámetro type' });
  }

  var sheetUrl = type === 'mudanceros'
    ? process.env.GOOGLE_SHEETS_WEBHOOK_URL
    : process.env.GOOGLE_SHEETS_PAGOS_URL;

  if (!sheetUrl) {
    return res.status(200).json({ rows: [] });
  }

  try {
    // GET al Apps Script para leer datos
    var readUrl = sheetUrl.replace('/exec', '/exec');
    var response = await fetch(readUrl + '?sheet=' + type);
    var text = await response.text();
    var data = JSON.parse(text);

    return res.status(200).json({
      rows: data.rows || [],
      total: data.total || 0,
    });
  } catch (error) {
    console.error('Error leyendo Sheets:', error);
    return res.status(200).json({ rows: [], error: error.message });
  }
};
