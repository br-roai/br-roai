// zip_web.js — escritor de ZIP de navegador (método STORE, sem dependências).
// Equivale ao desktop/zip.js, mas sem zlib: armazena sem compressão (zip válido).
// window.BRAI_ZIP.zipBytes(entries) -> Uint8Array. entries: [{name, data:string|Uint8Array}].
(function () {
  'use strict';
  var TE = new TextEncoder();
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) { var c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function bytes(d) { return (d instanceof Uint8Array) ? d : TE.encode(String(d)); }

  function dosTime(d) {
    var t = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    var dt = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { t: t & 0xFFFF, dt: dt & 0xFFFF };
  }

  function zipBytes(entries) {
    var now = dosTime(new Date());
    var chunks = [];           // partes do stream local
    var central = [];          // entradas do diretório central
    var offset = 0;
    function push(arr) { chunks.push(arr); offset += arr.length; }

    for (var i = 0; i < entries.length; i++) {
      var nameBuf = TE.encode(entries[i].name);
      var raw = bytes(entries[i].data);
      var crc = crc32(raw);

      var lh = new Uint8Array(30);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);   // assinatura local
      dv.setUint16(4, 20, true);           // versão
      dv.setUint16(6, 0, true);            // flags
      dv.setUint16(8, 0, true);            // método 0 = store
      dv.setUint16(10, now.t, true);
      dv.setUint16(12, now.dt, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, raw.length, true);  // tamanho comprimido = bruto (store)
      dv.setUint32(22, raw.length, true);
      dv.setUint16(26, nameBuf.length, true);
      dv.setUint16(28, 0, true);
      var localOffset = offset;
      push(lh); push(nameBuf); push(raw);

      var ch = new Uint8Array(46);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);           // método 0
      cv.setUint16(12, now.t, true);
      cv.setUint16(14, now.dt, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, raw.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBuf.length, true);
      cv.setUint32(42, localOffset, true);
      central.push({ head: ch, name: nameBuf });
    }

    var centralStart = offset;
    for (var j = 0; j < central.length; j++) { push(central[j].head); push(central[j].name); }
    var centralSize = offset - centralStart;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    push(eocd);

    var total = 0, k;
    for (k = 0; k < chunks.length; k++) total += chunks[k].length;
    var out = new Uint8Array(total), pos = 0;
    for (k = 0; k < chunks.length; k++) { out.set(chunks[k], pos); pos += chunks[k].length; }
    return out;
  }

  window.BRAI_ZIP = { zipBytes: zipBytes, crc32: crc32 };
})();
