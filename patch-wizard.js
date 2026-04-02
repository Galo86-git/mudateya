#!/usr/bin/env node
// patch-wizard.js — Aplicar cambios del catálogo al wizard
// Ejecutar con: node patch-wizard.js mudateya_autoavance.html
// Genera: mudateya_autoavance_patched.html

const fs   = require('fs');
const path = require('path');

const inputFile  = process.argv[2] || 'mudateya_autoavance.html';
const outputFile = inputFile.replace('.html', '_patched.html');

let html = fs.readFileSync(inputFile, 'utf8');
let changes = 0;

// ── PARCHE 1: confirmarCelularYPublicar ────────────────────────────
const p1old = `    window._clienteWA = cel;
    document.getElementById('step3-celular').style.display = 'none';
    publicarMudanzaEnSistema();`;

const p1new = `    window._clienteWA = cel;
    document.getElementById('step3-celular').style.display = 'none';
    _guardarYRedirigirCatalogo();`;

if (html.includes(p1old)) { html = html.replace(p1old, p1new); changes++; console.log('✓ Parche 1 aplicado'); }
else console.warn('✗ Parche 1 NO encontrado');

// ── PARCHE 2: publicarMudanzaEnSistema ─────────────────────────────
const p2old = /async function publicarMudanzaEnSistema\(\)\s*\{[\s\S]*?^  \}/m;
const p2new = `async function publicarMudanzaEnSistema() {
  _guardarYRedirigirCatalogo();
}`;

if (p2old.test(html)) { html = html.replace(p2old, p2new); changes++; console.log('✓ Parche 2 aplicado'); }
else console.warn('✗ Parche 2 NO encontrado — aplicar manualmente');

// ── PARCHE 3: fswPublicar ──────────────────────────────────────────
const p3old = /async function fswPublicar\(user\)\s*\{[\s\S]*?^  \}/m;
const p3new = `async function fswPublicar(user) {
  _guardarYRedirigirCatalogo();
}`;

if (p3old.test(html)) { html = html.replace(p3old, p3new); changes++; console.log('✓ Parche 3 aplicado'); }
else console.warn('✗ Parche 3 NO encontrado — aplicar manualmente');

// ── PARCHE 4: agregar _guardarYRedirigirCatalogo ───────────────────
const nuevaFuncion = `
  // ── NUEVO: guardar mudanza y redirigir al catálogo de mudanceros ──
  function _guardarYRedirigirCatalogo() {
    var user = null;
    try { user = JSON.parse(sessionStorage.getItem('googleUser') || sessionStorage.getItem('clienteUser')); } catch(e) {}

    var esFSW = document.getElementById('fswOverlay').classList.contains('open');
    var desde    = esFSW ? document.getElementById('fsw-desde').value.trim() : getInputVal('desde');
    var hasta    = esFSW ? document.getElementById('fsw-hasta').value.trim() : getInputVal('hasta');
    var fechaLbl = esFSW ? fswGetFechaLabel() : getFechaLabel();
    var ambTxt   = esFSW ? (fswAmb + ' ambiente' + (fswAmb !== 1 ? 's' : '')) : (amb + ' ambiente' + (amb !== 1 ? 's' : ''));
    var precio   = esFSW ? (50000 + (fswAmb - 1) * 30000) : estimarPrecio();

    var objetos = esFSW
      ? Array.from(document.querySelectorAll('#fsw-obj-grid .obj-chip.sel .obj-label')).map(function(e){ return e.textContent; }).join(', ')
      : Array.from(document.querySelectorAll('#step2 .obj-chip.sel .obj-label')).map(function(e){ return e.textContent; }).join(', ');

    var extras = Array.from(document.querySelectorAll('#step2 .extra-chip.sel span:nth-child(2)')).map(function(e){ return e.textContent.trim(); }).join(', ');

    var clienteWA = window._clienteWA !== undefined ? window._clienteWA
      : (user ? localStorage.getItem('clienteWA_' + user.email) || '' : '');

    var mudanzaData = {
      clienteEmail:    user ? user.email : '',
      clienteNombre:   user ? user.name  : '',
      clienteWA:       clienteWA,
      desde:           desde,
      hasta:           hasta,
      ambientes:       ambTxt,
      fecha:           fechaLbl,
      servicios:       objetos,
      extras:          extras,
      zonaBase:        desde,
      precio_estimado: precio,
      tipo:            'mudanza',
    };

    try { sessionStorage.setItem('mudanza_pendiente', JSON.stringify(mudanzaData)); } catch(e) {}
    window.location.href = '/mudanceros-catalogo';
  }
`;

if (!html.includes('_guardarYRedirigirCatalogo')) {
  html = html.replace('</script>', nuevaFuncion + '\n</script>');
  changes++;
  console.log('✓ Parche 4 aplicado');
} else {
  console.log('→ Parche 4 ya estaba aplicado');
}

fs.writeFileSync(outputFile, html, 'utf8');
console.log(`\n✅ ${changes} cambios aplicados → ${outputFile}`);
