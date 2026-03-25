// api/transferencias.js
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

async function setJSON(key, value, ex) {
  const str = JSON.stringify(value);
  if (ex) await redisCall('SET', key, str, 'EX', String(ex));
  else await redisCall('SET', key, str);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — listar transferencias pendientes
  if (req.method === 'GET') {
    try {
      const ids = await getJSON('transferencias:pendientes') || [];
      const todas = [];
      for (const id of ids) {
        const t = await getJSON(`transferencia:${id}`);
        if (t) todas.push(t);
      }
      return res.status(200).json({ transferencias: todas });
    } catch (e) {
      return res.status(200).json({ transferencias: [], error: e.message });
    }
  }

  // POST — confirmar o rechazar
  if (req.method === 'POST') {
    const { id, accion } = req.body; // accion: 'confirmar' | 'rechazar'
    try {
      const t = await getJSON(`transferencia:${id}`);
      if (!t) return res.status(404).json({ error: 'Transferencia no encontrada' });

      t.estado = accion === 'confirmar' ? 'confirmada' : 'rechazada';
      await setJSON(`transferencia:${id}`, t, 2592000);

      // Actualizar estado de la mudanza asociada en Redis
      try {
        const clienteEmail = t.clienteEmail;
        const clienteIds = await getJSON(`cliente:${clienteEmail}`) || [];
        for (const mudId of clienteIds) {
          const mudanza = await getJSON(`mudanza:${mudId}`);
          if (mudanza && mudanza.tipoPago === 'transferencia' && mudanza.estado === 'pago_transferencia_pendiente') {
            mudanza.estado = accion === 'confirmar' ? 'cotizacion_aceptada' : 'transferencia_rechazada';
            await setJSON(`mudanza:${mudId}`, mudanza, 2592000);
            break;
          }
        }
      } catch(e) { console.error('Error actualizando mudanza:', e.message); }

      // Notificar al cliente
      const resend = new Resend(process.env.RESEND_API_KEY);
      if (t.clienteEmail) {
        if (accion === 'confirmar') {
          await resend.emails.send({
            from: 'MudateYa <onboarding@resend.dev>',
            to: t.clienteEmail,
            subject: `✅ ¡Tu reserva está confirmada! — MudateYa`,
            html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#22C36A;padding:18px 22px"><h2 style="margin:0;color:#041A0E">✅ ¡Reserva confirmada!</h2></div><div style="padding:22px"><p style="color:#7AADA0;line-height:1.7">Hola <strong style="color:#E8F5EE">${t.clienteNombre}</strong>, validamos tu transferencia de <strong style="color:#22C36A">${t.monto}</strong>. Tu mudanza con <strong style="color:#E8F5EE">${t.mudancero}</strong> está confirmada.</p><p style="color:#7AADA0;margin-top:12px">Podés ver el detalle en <a href="https://mudateya.vercel.app/mi-mudanza" style="color:#22C36A">tu panel</a>.</p></div></div>`,
          });
        } else {
          await resend.emails.send({
            from: 'MudateYa <onboarding@resend.dev>',
            to: t.clienteEmail,
            subject: `Información sobre tu transferencia — MudateYa`,
            html: `<div style="font-family:Arial,sans-serif;max-width:580px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden"><div style="background:#2A3C32;padding:18px 22px"><h2 style="margin:0;color:#E8F5EE">Transferencia no validada</h2></div><div style="padding:22px"><p style="color:#7AADA0;line-height:1.7">Hola <strong style="color:#E8F5EE">${t.clienteNombre}</strong>, no pudimos validar tu transferencia. Por favor contactanos respondiendo este email para resolver el inconveniente.</p></div></div>`,
          });
        }
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
};
