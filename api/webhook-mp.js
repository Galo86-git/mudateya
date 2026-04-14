// api/webhook-mp.js
// Recibe notificaciones de Mercado Pago cuando un pago cambia de estado
// Configurar en: https://www.mercadopago.com.ar/developers/panel/notifications
// Evento a suscribir: payment

const { MercadoPagoConfig, Payment } = require('mercadopago');

// ── Redis helpers (igual que cotizaciones.js) ─────────────────────────────
async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const res   = await fetch(`${url}/${[method, ...args.map(a => encodeURIComponent(a))].join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result;
}
async function getJSON(key) {
  const val = await redisCall('GET', key);
  try { return val ? JSON.parse(val) : null; } catch(e) { return null; }
}
async function setJSON(key, value, exSeconds) {
  const str = JSON.stringify(value);
  if (exSeconds) await redisCall('SET', key, str, 'EX', String(exSeconds));
  else           await redisCall('SET', key, str);
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { type, data } = req.body;

    // Solo procesar notificaciones de pagos
    if (type !== 'payment') {
      return res.status(200).json({ status: 'ignorado', type });
    }

    if (!data || !data.id) {
      return res.status(200).json({ status: 'sin_id' });
    }

    // Obtener el pago completo desde MP
    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const paymentClient = new Payment(client);
    const pago = await paymentClient.get({ id: data.id });

    const { status, status_detail, external_reference, metadata, transaction_amount } = pago;

    console.log(`[Webhook MP] Pago ${data.id} — ${status} (${status_detail})`);
    console.log(`  Referencia: ${external_reference}`);
    console.log(`  Tipo:       ${metadata?.tipoPago}`);
    console.log(`  MudanzaId:  ${metadata?.mudanzaId}`);
    console.log(`  Monto:      $${transaction_amount}`);

    // Solo procesar pagos aprobados
    if (status !== 'approved') {
      return res.status(200).json({ status: 'no_aprobado', pago_status: status });
    }

    // Extraer datos del metadata
    const mudanzaId = metadata?.mudanzaId;
    const tipoPago  = metadata?.tipoPago; // 'anticipo' | 'saldo'

    if (!mudanzaId || !tipoPago) {
      console.warn('[Webhook MP] Sin mudanzaId o tipoPago en metadata');
      return res.status(200).json({ status: 'sin_metadata' });
    }

    // Evitar doble procesamiento — verificar si ya fue registrado
    const m = await getJSON(`mudanza:${mudanzaId}`);
    if (!m) {
      console.warn(`[Webhook MP] Mudanza ${mudanzaId} no encontrada en Redis`);
      return res.status(200).json({ status: 'mudanza_no_encontrada' });
    }

    // Verificar si ya estaba registrado (idempotencia)
    if (tipoPago === 'anticipo' && m.anticipoPagado) {
      return res.status(200).json({ status: 'ya_registrado' });
    }
    if (tipoPago === 'saldo' && m.saldoPagado) {
      return res.status(200).json({ status: 'ya_registrado' });
    }

    // Registrar el pago
    if (tipoPago === 'anticipo') {
      m.anticipoPagado    = true;
      m.mpAnticipoPagoId  = String(data.id);
    }
    if (tipoPago === 'saldo') {
      m.saldoPagado    = true;
      m.mpSaldoPagoId  = String(data.id);
    }
    m.ultimoUpdatePago = new Date().toISOString();

    await setJSON(`mudanza:${mudanzaId}`, m, 604800);

    console.log(`[Webhook MP] ✅ Pago ${tipoPago} registrado para mudanza ${mudanzaId}`);
    return res.status(200).json({ status: 'ok', tipoPago, mudanzaId });

  } catch (error) {
    console.error('[Webhook MP] Error:', error.message);
    // MP reintenta si devolvés error — siempre devolver 200
    return res.status(200).json({ status: 'error_procesado', error: error.message });
  }
};
