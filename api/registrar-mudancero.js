// api/registrar-mudancero.js
// Recibe el formulario completo de onboarding de mudanceros
// Guarda en Redis + notifica al admin + registra en Google Sheets

const { Resend } = require('resend');

// ── REDIS ────────────────────────────────────────────────────────
async function redisCall(method, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis no configurado');
  const response = await fetch(
    `${url}/${[method, ...args].map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
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
  else           await redisCall('SET', key, str);
}

// ── HANDLER ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  try {
    const {
      // Datos personales
      nombre, telefono, email, empresa,
      // Zona
      zonaBase, zonasExtra, distancia,
      // Vehículo
      vehiculo, cantVehiculos, equipo,
      // Servicios y disponibilidad
      servicios, dias, horarios, anticipacion,
      // Precios base
      precio1amb, precio2amb, precio3amb, precio4amb, precioFlete,
      // Texto libre
      extra,
      // Fotos
      foto, fotoCamion, fotoPatente,
      // DNI
      dniFrente, dniDorso, dniAnalisis,
      // Cobro
      metodoCobro, cbu, emailMP, titularCuenta,
      // Meta
      fecha,
    } = req.body;

    // ── VALIDACIONES MÍNIMAS ────────────────────────────────────
    if (!nombre || !telefono || !email || !zonaBase || !vehiculo) {
      return res.status(400).json({ error: 'Faltan campos obligatorios: nombre, teléfono, email, zona, vehículo' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    if (!dniFrente || !dniDorso) {
      return res.status(400).json({ error: 'Faltan fotos del DNI' });
    }
    if (!fotoCamion || !fotoPatente) {
      return res.status(400).json({ error: 'Faltan fotos del vehículo' });
    }

    // ── VERIFICAR QUE NO EXISTA YA ──────────────────────────────
    const existente = await getJSON(`mudancero:perfil:${email}`);
    if (existente && existente.estado !== 'rechazado') {
      return res.status(400).json({ error: 'Ya existe un perfil con ese email', estado: existente.estado });
    }

    // ── ARMAR EL OBJETO PERFIL ──────────────────────────────────
    const id = 'MUD-' + Date.now();

    const perfil = {
      // Identificación
      id,
      email,
      nombre,
      telefono,
      empresa: empresa || '',

      // Zona
      zonaBase,
      zonasExtra:  zonasExtra  || '',
      distancia:   distancia   || '',

      // Vehículo
      vehiculo,
      cantVehiculos: cantVehiculos || '1',
      equipo:        equipo        || 'Solo yo',

      // Servicios
      servicios:   servicios   || '',
      dias:        dias         || '',
      horarios:    horarios     || '',
      anticipacion: anticipacion || '48 horas',

      // Precios base (orientativos)
      precios: {
        amb1:   precio1amb  || '',
        amb2:   precio2amb  || '',
        amb3:   precio3amb  || '',
        amb4:   precio4amb  || '',
        flete:  precioFlete || '',
      },

      // Texto libre
      extra: extra || '',

      // Fotos — guardamos las imágenes en base64
      // Nota: en producción con muchos mudanceros conviene mover esto a un bucket (S3/R2)
      foto:        foto        || '',
      fotoCamion:  fotoCamion  || '',
      fotoPatente: fotoPatente || '',

      // DNI — guardamos las fotos y el análisis de la IA
      dniFrente:   dniFrente  || '',
      dniDorso:    dniDorso   || '',
      dniAnalisis: dniAnalisis || null,  // { numero_dni, apellido, nombres, fecha_nacimiento, ... }

      // Verificación de identidad
      // Si el análisis de la IA encontró el nombre correctamente, marcamos pre-verificado
      // La verificación final la hace un humano (admin)
      verificadoIdentidad: false,     // se activa manualmente o via Metamap
      verificadoVehiculo:  false,     // se activa cuando el admin revisa patente
      verificadoSeguro:    false,     // se activa cuando sube el certificado
      estadoVerificacion: 'pendiente_revision', // pendiente_revision | aprobado | rechazado

      // Cobro
      metodoCobro:    metodoCobro    || 'cbu',
      cbu:            cbu            || '',
      emailMP:        emailMP        || '',
      titularCuenta:  titularCuenta  || '',

      // Metadata
      estado:          'pendiente_revision',
      fechaRegistro:   new Date().toISOString(),
      fechaFormulario: fecha || new Date().toLocaleString('es-AR'),
      calificacion:    0,
      nroResenas:      0,
      trabajosCompletados: 0,
    };

    // ── GUARDAR EN REDIS ────────────────────────────────────────
    // Perfil principal (sin expiración — es permanente)
    await setJSON(`mudancero:perfil:${email}`, perfil);

    // Índice global de mudanceros pendientes de revisión
    const pendientes = await getJSON('mudanceros:pendientes') || [];
    if (!pendientes.includes(email)) pendientes.push(email);
    await setJSON('mudanceros:pendientes', pendientes);

    // Índice global de todos los mudanceros registrados
    const todos = await getJSON('mudanceros:todos') || [];
    if (!todos.includes(email)) todos.push(email);
    await setJSON('mudanceros:todos', todos);

    // ── NOTIFICAR AL ADMIN ──────────────────────────────────────
    try {
      await notificarAdmin(perfil);
    } catch(e) {
      console.warn('Error enviando email al admin:', e.message);
      // No fallar el registro por esto
    }

    // ── LOG EN GOOGLE SHEETS ────────────────────────────────────
    try {
      await logMudanceroSheets(perfil);
    } catch(e) {
      console.warn('Error logging en Sheets:', e.message);
    }

    return res.status(200).json({
      ok:      true,
      id,
      mensaje: 'Solicitud recibida. Te contactamos en 24hs para activar tu perfil.',
    });

  } catch(e) {
    console.error('Error en registrar-mudancero:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ── EMAIL AL ADMIN ───────────────────────────────────────────────
async function notificarAdmin(perfil) {
  const resend    = new Resend(process.env.RESEND_API_KEY);
  const adminMail = process.env.ADMIN_EMAIL;
  if (!process.env.RESEND_API_KEY || !adminMail) return;

  // Armar resumen del análisis de DNI
  const dni = perfil.dniAnalisis;
  const dniResumen = dni
    ? `DNI: ${dni.numero_dni || '?'} · ${dni.apellido || ''} ${dni.nombres || ''} · Vence: ${dni.fecha_vencimiento || '?'} · Legible: ${dni.legible ? '✓' : '✗'}`
    : 'DNI no analizado';

  await resend.emails.send({
    from:    'MudateYa <onboarding@resend.dev>',
    to:      adminMail,
    subject: `🚛 Nuevo mudancero — ${perfil.nombre} · ${perfil.zonaBase} · ${perfil.id}`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:600px;background:#0D1410;color:#E8F5EE;border-radius:16px;overflow:hidden">
  <div style="background:#22C36A;padding:18px 22px">
    <h2 style="margin:0;color:#041A0E">🚛 Nuevo mudancero registrado</h2>
  </div>
  <div style="padding:22px">

    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#7AADA0;padding:6px 0;width:35%">Nombre</td>
          <td><strong>${perfil.nombre}</strong>${perfil.empresa ? ` · ${perfil.empresa}` : ''}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Email</td>
          <td>${perfil.email}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Teléfono</td>
          <td>${perfil.telefono}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Zona</td>
          <td>${perfil.zonaBase}${perfil.zonasExtra ? ` · ${perfil.zonasExtra}` : ''}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Vehículo</td>
          <td>${perfil.vehiculo} · ${perfil.cantVehiculos} unidad/es · ${perfil.equipo}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Servicios</td>
          <td style="font-size:12px">${perfil.servicios}</td></tr>
      <tr><td style="color:#7AADA0;padding:6px 0">Horarios</td>
          <td style="font-size:12px">${perfil.dias} · ${perfil.horarios}</td></tr>
    </table>

    <div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">
      <div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Verificación DNI</div>
      <div style="font-size:13px;color:#E8F5EE">${dniResumen}</div>
    </div>

    <div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">
      <div style="font-size:11px;color:#5A8A78;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Cobro</div>
      <div style="font-size:13px;color:#E8F5EE">
        ${perfil.metodoCobro === 'cbu' ? `CBU/Alias: ${perfil.cbu}` : `MP: ${perfil.emailMP}`}
        ${perfil.titularCuenta ? ` · Titular: ${perfil.titularCuenta}` : ''}
      </div>
    </div>

    ${perfil.extra ? `<div style="background:#172018;border-radius:10px;padding:12px 16px;margin:14px 0">
      <div style="font-size:11px;color:#5A8A78;margin-bottom:4px">Nota</div>
      <div style="font-size:13px;color:#7AADA0;font-style:italic">${perfil.extra}</div>
    </div>` : ''}

    <a href="${process.env.SITE_URL || 'https://mudateya.vercel.app'}/admin"
       style="display:inline-block;margin-top:8px;background:#22C36A;color:#041A0E;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">
      Revisar y aprobar →
    </a>

    <p style="color:#3D6458;font-size:11px;margin-top:16px">
      ID: ${perfil.id} · ${perfil.fechaRegistro}
    </p>
  </div>
</div>`,
  });
}

// ── LOG EN GOOGLE SHEETS ─────────────────────────────────────────
async function logMudanceroSheets(perfil) {
  const webhookUrl = process.env.GOOGLE_SHEETS_MUDANCEROS_URL;
  if (!webhookUrl) return;

  const dni = perfil.dniAnalisis || {};

  const row = {
    ID:                perfil.id,
    'Fecha registro':  new Date(perfil.fechaRegistro).toLocaleString('es-AR', {
                         timeZone: 'America/Argentina/Buenos_Aires'
                       }),
    Nombre:            perfil.nombre,
    Empresa:           perfil.empresa    || '—',
    Email:             perfil.email,
    Teléfono:          perfil.telefono,
    'Zona base':       perfil.zonaBase,
    'Zonas extra':     perfil.zonasExtra || '—',
    Vehículo:          perfil.vehiculo,
    'Cantidad vehíc.': perfil.cantVehiculos,
    Equipo:            perfil.equipo,
    Servicios:         perfil.servicios,
    Días:              perfil.dias,
    Horarios:          perfil.horarios,
    Anticipación:      perfil.anticipacion,
    'P/1amb':          perfil.precios.amb1   || '—',
    'P/2amb':          perfil.precios.amb2   || '—',
    'P/3amb':          perfil.precios.amb3   || '—',
    'P/4amb':          perfil.precios.amb4   || '—',
    'P/flete':         perfil.precios.flete  || '—',
    // DNI análisis
    'DNI número':      dni.numero_dni        || '—',
    'DNI apellido':    dni.apellido          || '—',
    'DNI nombres':     dni.nombres           || '—',
    'DNI nacimiento':  dni.fecha_nacimiento  || '—',
    'DNI vencimiento': dni.fecha_vencimiento || '—',
    'DNI legible':     dni.legible ? 'SI' : 'NO',
    // Cobro
    'Método cobro':    perfil.metodoCobro,
    'CBU/Alias':       perfil.cbu            || '—',
    'Email MP':        perfil.emailMP        || '—',
    Titular:           perfil.titularCuenta  || '—',
    Estado:            'PENDIENTE_REVISION',
  };

  await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(row),
  });
}
