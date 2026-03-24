// api/cotizaciones.js
// Maneja el sistema de cotizaciones: crear mudanza, enviar cotización, listar

const { Resend } = require('resend');

// Simulamos storage con variables en memoria para desarrollo
// En producción usar Vercel KV o similar
let mudanzasDB = {};
let cotizacionesDB = {};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── PUBLICAR MUDANZA ──────────────────────────────────────────────────────
  if (action === 'publicar' && req.method === 'POST') {
    const { clienteEmail, clienteNombre, desde, hasta, ambientes, fecha,
            servicios, extras, zonaBase, precio_estimado } = req.body;

    if (!clienteEmail || !desde || !hasta) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    const id = 'MYA-' + Date.now();
    const mudanza = {
      id, clienteEmail, clienteNombre, desde, hasta, ambientes,
      fecha, servicios, extras, zonaBase, precio_estimado,
      estado: 'buscando',
      fechaPublicacion: new Date().toISOString(),
      expira: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24hs
      cotizaciones: [],
    };

    mudanzasDB[id] = mudanza;

    // Notificar a mudanceros de la zona por email
    try {
      await notificarMudanceros(mudanza);
    } catch (e) {
      console.error('Error notificando mudanceros:', e);
    }

    return res.status(200).json({ ok: true, id, mudanza });
  }

  // ── COTIZAR (mudancero envía precio) ──────────────────────────────────────
  if (action === 'cotizar' && req.method === 'POST') {
    const { mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel,
            precio, nota, tiempoEstimado } = req.body;

    if (!mudanzaId || !mudanceroEmail || !precio) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    const mudanza = mudanzasDB[mudanzaId];
    if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });
    if (mudanza.estado !== 'buscando') {
      return res.status(400).json({ error: 'Esta mudanza ya no acepta cotizaciones' });
    }

    // Verificar si ya cotizó
    const yaCotizo = mudanza.cotizaciones.find(c => c.mudanceroEmail === mudanceroEmail);
    if (yaCotizo) return res.status(400).json({ error: 'Ya enviaste una cotización para esta mudanza' });

    const cotizacion = {
      id: 'COT-' + Date.now(),
      mudanzaId, mudanceroEmail, mudanceroNombre, mudanceroTel,
      precio: parseInt(precio),
      nota: nota || '',
      tiempoEstimado: tiempoEstimado || '',
      fecha: new Date().toISOString(),
      estado: 'pendiente',
    };

    mudanza.cotizaciones.push(cotizacion);

    // Notificar al cliente
    try {
      await notificarCliente(mudanza, cotizacion);
    } catch (e) {
      console.error('Error notificando cliente:', e);
    }

    return res.status(200).json({ ok: true, cotizacion });
  }

  // ── ACEPTAR COTIZACIÓN ────────────────────────────────────────────────────
  if (action === 'aceptar' && req.method === 'POST') {
    const { mudanzaId, cotizacionId } = req.body;
    const mudanza = mudanzasDB[mudanzaId];
    if (!mudanza) return res.status(404).json({ error: 'Mudanza no encontrada' });

    const cot = mudanza.cotizaciones.find(c => c.id === cotizacionId);
    if (!cot) return res.status(404).json({ error: 'Cotización no encontrada' });

    mudanza.estado = 'cotizacion_aceptada';
    mudanza.cotizacionAceptada = cot;
    cot.estado = 'aceptada';

    return res.status(200).json({ ok: true, mudanza, cotizacion: cot });
  }

  // ── LISTAR MUDANZAS DEL CLIENTE ───────────────────────────────────────────
  if (action === 'mis-mudanzas' && req.method === 'GET') {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Falta email' });
    const mis = Object.values(mudanzasDB).filter(m => m.clienteEmail === email);
    return res.status(200).json({ mudanzas: mis });
  }

  // ── LISTAR MUDANZAS POR ZONA (para mudanceros) ───────────────────────────
  if (action === 'por-zona' && req.method === 'GET') {
    const { zona, email } = req.query;
    const disponibles = Object.values(mudanzasDB).filter(m => {
      if (m.estado !== 'buscando') return false;
      if (new Date(m.expira) < new Date()) return false;
      // No mostrar si ya cotizó
      if (email && m.cotizaciones.find(c => c.mudanceroEmail === email)) return false;
      // Filtrar por zona si se especifica
      if (zona && m.zonaBase && !m.desde.toLowerCase().includes(zona.toLowerCase()) &&
          !m.zonaBase.toLowerCase().includes(zona.toLowerCase())) return false;
      return true;
    });
    return res.status(200).json({ mudanzas: disponibles });
  }

  // ── MIS COTIZACIONES (para mudanceros) ────────────────────────────────────
  if (action === 'mis-cotizaciones' && req.method === 'GET') {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Falta email' });
    const mis = Object.values(mudanzasDB).filter(m =>
      m.cotizaciones.some(c => c.mudanceroEmail === email)
    ).map(m => ({
      ...m,
      miCotizacion: m.cotizaciones.find(c => c.mudanceroEmail === email)
    }));
    return res.status(200).json({ mudanzas: mis });
  }

  return res.status(400).json({ error: 'Acción no reconocida' });
};

// ── NOTIFICAR MUDANCEROS ───────────────────────────────────────────────────
async function notificarMudanceros(mudanza) {
  const resendKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!resendKey || !adminEmail) return;

  const resend = new Resend(resendKey);
  const expira = new Date(mudanza.expira).toLocaleString('es-AR', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
  });

  // Por ahora notificamos al admin que reenvía a los mudanceros
  // En producción: buscar mudanceros por zona y notificarlos directamente
  await resend.emails.send({
    from: 'MudateYa <onboarding@resend.dev>',
    to: adminEmail,
    subject: `🚛 Nueva mudanza publicada — ${mudanza.desde} → ${mudanza.hasta}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:20px 24px">
          <h1 style="margin:0;font-size:18px;color:#041A0E">🚛 Nueva mudanza disponible — ${mudanza.id}</h1>
        </div>
        <div style="padding:24px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px;width:40%">De</td><td style="padding:8px 0;font-size:13px"><strong>${mudanza.desde}</strong></td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">A</td><td style="padding:8px 0;font-size:13px"><strong>${mudanza.hasta}</strong></td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Tamaño</td><td style="padding:8px 0;font-size:13px">${mudanza.ambientes}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Fecha</td><td style="padding:8px 0;font-size:13px">${mudanza.fecha}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Extras</td><td style="padding:8px 0;font-size:13px">${mudanza.extras||'—'}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Precio estimado</td><td style="padding:8px 0;font-size:13px">$${parseInt(mudanza.precio_estimado||0).toLocaleString('es-AR')}</td></tr>
            <tr><td style="padding:8px 0;color:#7AADA0;font-size:13px">Expira</td><td style="padding:8px 0;font-size:13px;color:#FFB300">${expira}</td></tr>
          </table>
          <div style="margin-top:20px;padding:14px;background:#172018;border-radius:10px;font-size:13px;color:#7AADA0">
            <strong style="color:#22C36A">Para cotizar:</strong> Entrá a mudateya.ar/mi-cuenta → sección Pedidos → buscá la mudanza ${mudanza.id}
          </div>
        </div>
      </div>
    `,
  });
}

// ── NOTIFICAR CLIENTE ──────────────────────────────────────────────────────
async function notificarCliente(mudanza, cotizacion) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  const resend = new Resend(resendKey);

  await resend.emails.send({
    from: 'MudateYa <onboarding@resend.dev>',
    to: mudanza.clienteEmail,
    subject: `💰 Nueva cotización para tu mudanza — ${cotizacion.mudanceroNombre}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
        <div style="background:#22C36A;padding:20px 24px">
          <h1 style="margin:0;font-size:18px;color:#041A0E">💰 Recibiste una cotización</h1>
        </div>
        <div style="padding:24px">
          <p style="color:#7AADA0;line-height:1.7;margin:0 0 16px">
            Hola <strong style="color:#E8F5EE">${mudanza.clienteNombre||''}!</strong><br>
            <strong>${cotizacion.mudanceroNombre}</strong> cotizó tu mudanza de <strong>${mudanza.desde}</strong> a <strong>${mudanza.hasta}</strong>.
          </p>
          <div style="background:#172018;border-radius:12px;padding:16px 20px;margin-bottom:20px">
            <div style="font-family:'Bebas Neue',monospace;font-size:2rem;color:#22C36A;letter-spacing:1px">$${cotizacion.precio.toLocaleString('es-AR')}</div>
            <div style="font-size:12px;color:#7AADA0;margin-top:4px">precio total de la mudanza</div>
            ${cotizacion.nota ? `<div style="margin-top:12px;font-size:13px;color:#7AADA0;font-style:italic">"${cotizacion.nota}"</div>` : ''}
            ${cotizacion.tiempoEstimado ? `<div style="margin-top:8px;font-size:12px;color:#7AADA0">⏱ Tiempo estimado: ${cotizacion.tiempoEstimado}</div>` : ''}
          </div>
          <a href="https://mudateya.ar/mi-mudanza" style="display:inline-block;background:#22C36A;color:#041A0E;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
            Ver todas las cotizaciones →
          </a>
          <p style="color:#3D6458;font-size:11px;margin-top:16px;font-family:monospace">Tenés 24hs para aceptar desde que publicaste la mudanza · ${mudanza.id}</p>
        </div>
      </div>
    `,
  });
}
