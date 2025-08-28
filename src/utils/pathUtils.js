// Convierte nombres de archivo a un ID base64url seguro, y viceversa.

function toBase64Url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')        // convertir a base64 normal
    .replace(/\+/g, '-')       // reemplazar símbolos para URL segura
    .replace(/\//g, '_')
    .replace(/=+$/, '');       // quitar padding "="
}

function fromBase64Url(b64) {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const base64 = b64.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(base64, 'base64').toString('utf8');
}

module.exports = { toBase64Url, fromBase64Url };