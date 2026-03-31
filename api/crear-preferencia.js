// api/crear-preferencia.js
const { MercadoPagoConfig, Preference } = require('mercadopago');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ error: 'Configuración de pago incompleta' });

  try {
    const { mudanceroNombre, monto, desde, hasta, ambientes, mudanzaId, cotizacionId, tipoPago } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto inválido' });

    // tipoPago: 'anticipo' (50% al aceptar) | 'saldo' (50% al completar) | undefined (pago único)
    const esSplit = tipoPago === 'anticipo' || tipoPago === 'saldo';
    const montoFinal = esSplit ? Math.round(monto * 0.5) : monto;
    const labelTipo = tipoPago === 'anticipo' ? '50% anticipo' : tipoPago === 'saldo' ? '50% saldo final' : '';
    const tituloItem = `MudateYa${labelTipo ? ' — '+labelTipo : ''} · ${mudanceroNombre}`;

    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(client);
    const siteUrl = process.env.SITE_URL || 'https://mudateya.vercel.app';

    const result = await preference.create({ body: {
      items: [{
        id:          `mudanza-${mudanzaId||Date.now()}-${tipoPago||'unico'}`,
        title:       tituloItem,
        description: `${desde} → ${hasta} · ${ambientes}`,
        quantity:    1,
        unit_price:  Number(montoFinal),
        currency_id: 'ARS',
      }],
      back_urls: {
        success: `${siteUrl}/pago-exitoso?monto=${montoFinal}&mudancero=${encodeURIComponent(mudanceroNombre)}&mudanzaId=${mudanzaId||''}&cotizacionId=${cotizacionId||''}&tipoPago=${tipoPago||'unico'}`,
        failure: `${siteUrl}?pago=error`,
        pending: `${siteUrl}?pago=pendiente`,
      },
      auto_return:          'approved',
      statement_descriptor: 'MUDATEYA',
      external_reference:   `${mudanzaId||'MYA'}-${tipoPago||'unico'}-${cotizacionId||Date.now()}`,
      metadata:             { mudancero: mudanceroNombre, desde, hasta, ambientes, mudanzaId, cotizacionId, tipoPago },
      notification_url:     `${siteUrl}/api/webhook-mp`,
    }});

    return res.status(200).json({
      id:          result.id,
      init_point:  result.init_point  || result.initPoint,
      sandbox_url: result.sandbox_init_point || result.sandboxInitPoint,
      montoFinal,
      tipoPago: tipoPago || 'unico',
    });

  } catch (error) {
    console.error('Error creando preferencia MP:', error);
    return res.status(500).json({ error: 'Error al crear el pago', detalle: error.message });
  }
};
