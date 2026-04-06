// api/admin.js
// Panel admin — endpoints para mudanceros, pagos y transferencias

async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const r = await fetch(
    `${url}/${[method,...args].map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}
async function getJSON(key) {
  const v = await redisCall('GET', key);
  return v ? JSON.parse(v) : null;
}
async function setJSON(key, value, ex) {
  const s = JSON.stringify(value);
  if (ex) await redisCall('SET', key, s, 'EX', String(ex));
  else     await redisCall('SET', key, s);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type } = req.query;

  // ── GET mudanceros desde Redis ─────────────────────────────────
  if (type === 'mudanceros' && req.method === 'GET') {
    try {
      const todos = await getJSON('mudanceros:todos') || [];
      const rows = [];
      for (const email of todos) {
        try {
          const p = await getJSON(`mudancero:perfil:${email}`);
          if (!p) continue;
          const dni = p.dniAnalisis || {};
          // Formato array compatible con el panel
          rows.push([
            p.id || '',                                          // 0
            p.nombre || '',                                      // 1
            p.empresa || '',                                     // 2
            p.telefono || '',                                    // 3
            p.email || '',                                       // 4
            p.zonaBase || '',                                    // 5
            p.zonasExtra || '',                                  // 6
            p.cuil || '',                                        // 7
            p.vehiculo || '',                                    // 8
            p.cantVehiculos || '1',                              // 9
            p.equipo || '',                                      // 10
            p.servicios || '',                                   // 11
            p.dias || '',                                        // 12
            p.horarios || '',                                    // 13
            p.extra || '',                                       // 14
            p.metodoCobro || '',                                 // 15
            p.cbu || '',                                         // 16
            p.emailMP || '',                                     // 17
            p.fechaRegistro || '',                               // 18
            p.cuilVerificado ? 'Verificado' : 'No verificado',  // 19
            dni.legible ? 'Legible' : 'No legible',             // 20
            p.estado === 'aprobado' ? 'Aprobado'
              : p.estado === 'rechazado' ? 'Rechazado'
              : 'Pendiente',                                     // 21
          ]);
        } catch(e) { continue; }
      }
      return res.status(200).json({ rows });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET pagos — retorna vacío (migrado a Redis en cotizaciones.js) ──
  if (type === 'pagos' && req.method === 'GET') {
    return res.status(200).json({ rows: [] });
  }

  // ── POST cambiar estado mudancero ──────────────────────────────
  if (req.method === 'POST') {
    const { tipo, email, nuevoEstado } = req.body || {};

    if (tipo === 'cambiar-estado-mudancero' && email && nuevoEstado) {
      try {
        const perfil = await getJSON(`mudancero:perfil:${email}`);
        if (!perfil) return res.status(404).json({ error: 'Mudancero no encontrado' });

        const estadoRedis = nuevoEstado === 'Aprobado' ? 'aprobado'
          : nuevoEstado === 'Rechazado' ? 'rechazado'
          : 'pendiente';

        perfil.estado = estadoRedis;
        await setJSON(`mudancero:perfil:${email}`, perfil);

        // Sacar de pendientes si se aprueba o rechaza
        if (estadoRedis !== 'pendiente') {
          const pendientes = await getJSON('mudanceros:pendientes') || [];
          await setJSON('mudanceros:pendientes', pendientes.filter(e => e !== email));
        }

        // Notificar al mudancero por email
        try {
          const { Resend } = require('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);
          const siteUrl = process.env.SITE_URL || 'https://mudateya.ar';
          const nombre = (perfil.nombre || '').split(' ')[0];
          const aprobado = estadoRedis === 'aprobado';
          await resend.emails.send({
            from: 'MudateYa <noreply@mudateya.ar>',
            to: perfil.email,
            subject: aprobado
              ? `✅ ¡Tu perfil fue aprobado! Ya podés recibir pedidos`
              : `⚠️ Tu perfil necesita correcciones — MudateYa`,
            html: `
<div style="font-family:Inter,Arial,sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden">
  <div style="background:#003580;padding:20px 28px">
    <span style="font-size:20px;font-weight:900;color:#fff">Mudate</span><span style="font-size:20px;font-weight:900;color:#22C36A">Ya</span>
    <span style="margin-left:10px;background:${aprobado?'#22C36A':'#F59E0B'};color:${aprobado?'#003580':'#fff'};font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px">${aprobado?'✅ APROBADO':'⚠️ REVISIÓN'}</span>
  </div>
  <div style="padding:28px">
    <h2 style="margin:0 0 8px;font-size:20px;color:#0F1923">${aprobado?`¡Bienvenido al equipo, ${nombre}!`:`Hola ${nombre}, necesitamos que corrijas algo`}</h2>
    <p style="font-size:14px;color:#475569;margin:0 0 20px;line-height:1.6">
      ${aprobado
        ? 'Tu perfil fue verificado y aprobado. A partir de ahora vas a empezar a recibir pedidos de mudanzas y fletes en tu zona.'
        : 'Revisamos tu perfil y necesitamos que corrijas algunos datos. Escribinos a hola@mudateya.ar y te decimos qué falta.'}
    </p>
    ${aprobado ? `
    <div style="background:#F0FFF4;border:1px solid #BBF7D0;border-radius:12px;padding:18px;margin-bottom:20px">
      <div style="font-size:13px;color:#16A34A;font-weight:600;margin-bottom:8px">¿Qué pasa ahora?</div>
      <ul style="font-size:13px;color:#475569;margin:0;padding-left:16px;line-height:2">
        <li>Cuando un cliente publique una mudanza en tu zona te llega un email</li>
        <li>Entrás a tu panel, ves los detalles y cotizás</li>
        <li>Si el cliente acepta tu cotización, recibís el pago por Mercado Pago</li>
      </ul>
    </div>` : `
    <div style="background:#FFFBEB;border:1px solid #FCD34D;border-radius:12px;padding:18px;margin-bottom:20px">
      <p style="font-size:13px;color:#92400E;margin:0">📧 Escribinos a <strong>hola@mudateya.ar</strong> con el asunto "Corrección de perfil".</p>
    </div>`}
    <a href="${siteUrl}/mi-cuenta" style="display:block;text-align:center;background:#1A6FFF;color:#fff;padding:13px 24px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700">${aprobado?'Ver mi panel →':'Contactar soporte →'}</a>
  </div>
  <div style="background:#F4F6F9;border-top:1px solid #E2E8F0;padding:14px 28px;text-align:center">
    <p style="font-size:11px;color:#94A3B8;margin:0;font-family:monospace">MudateYa · mudateya.ar</p>
  </div>
</div>`,
          });
        } catch(emailErr) {
          console.warn('Email estado mudancero:', emailErr.message);
        }

        return res.status(200).json({ ok: true, estado: nuevoEstado });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  }

  return res.status(404).json({ error: 'Endpoint no encontrado' });
};
