// api/registrar-transferencia.js
const { Resend } = require('resend');

async function redisCall(method, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const response = await fetch(`${url}/${[method, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getJSON(key) {
  const val = await redisCall('GET', key);
  if (!val) return null;
  return JSON.parse(val);
}

async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else await redisCall('SET', key, str);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { clienteEmail, clienteNombre, mudancero, desde, hasta, monto, fecha } = req.body;

  // Guardar en Redis
  try {
    const id = 'MYA-TRANS-' + Date.now();
    const transferencia = { id: 'TRANS-' + Date.now(), clienteEmail, clienteNombre, mudancero, desde, hasta, monto, fecha, estado: 'pendiente' };
    const transId = transferencia.id;
    await setJSON(`transferencia:${transId}`, transferencia, 2592000);
    const idx = await getJSON('transferencias:pendientes') || [];
    idx.push(transId);
    await setJSON('transferencias:pendientes', idx, 2592000);

    // También crear mudanza en el sistema para que aparezca en /mi-mudanza
    const mudanza = {
      id,
      clienteEmail,
      clienteNombre,
      desde,
      hasta,
      ambientes: '—',
      fecha,
      estado: 'pago_transferencia_pendiente',
      fechaPublicacion: new Date().toISOString(),
      expira: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      cotizaciones: [],
      cotizacionAceptada: { mudanceroNombre: mudancero, precio: parseInt((monto||'0').replace(/\D/g,'')), mudanceroTel: '' },
      tipoPago: 'transferencia',
      montoTransferencia: monto,
    };
    await setJSON(`mudanza:${id}`, mudanza, 2592000);
    const clienteIdx = await getJSON(`cliente:${clienteEmail}`) || [];
    clienteIdx.push(id);
    await setJSON(`cliente:${clienteEmail}`, clienteIdx, 2592000);
  } catch (e) {
    console.error('Error guardando en Redis:', e.message);
  }

  // Emails
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const adminEmail = process.env.ADMIN_EMAIL;

    if (adminEmail) {
      await resend.emails.send({
        from: 'MudateYa <onboarding@resend.dev>',
        to: adminEmail,
        subject: `💸 Transferencia pendiente — ${clienteNombre} · ${monto}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#FFB300;padding:18px 22px"><h2 style="margin:0;color:#041A0E">💸 Transferencia pendiente de validación</h2></div><div style="padding:22px"><table style="width:100%"><tr><td style="color:#7AADA0;padding:6px 0;width:35%">Cliente</td><td><strong>${clienteNombre}</strong></td></tr><tr><td style="color:#7AADA0;padding:6px 0">Email</td><td>${clienteEmail}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Mudancero</td><td>${mudancero}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Desde</td><td>${desde}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Hasta</td><td>${hasta}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Monto</td><td style="color:#FFB300;font-weight:700">${monto}</td></tr><tr><td style="color:#7AADA0;padding:6px 0">Fecha</td><td>${fecha}</td></tr></table><a href="https://mudateya.vercel.app/admin" style="display:inline-block;margin-top:16px;background:#FFB300;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Ver en Admin →</a></div></div>`,
      });
    }

    if (clienteEmail) {
      await resend.emails.send({
        from: 'MudateYa <onboarding@resend.dev>',
        to: clienteEmail,
        subject: `Recibimos tu comprobante — MudateYa`,
        html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">✅ Comprobante recibido</h2></div><div style="padding:22px"><p style="color:#7AADA0;line-height:1.7">Hola <strong style="color:#E8F5EE">${clienteNombre}</strong>, recibimos tu comprobante de <strong style="color:#22C36A">${monto}</strong>. Lo validamos en las próximas <strong style="color:#E8F5EE">2 horas hábiles</strong> y te confirmamos por email.</p></div></div>`,
      });
    }
  } catch (e) {
    console.error('Error enviando emails:', e.message);
  }

  return res.status(200).json({ ok: true });
};

