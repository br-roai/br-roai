// static_host.js — host Lua para a versão ESTÁTICA: usa o núcleo COMUM lua_host_core.js
// mas serve as fontes Lua do BUNDLE em memória (window.BRAI_LUA_FILES), sem fetch de /lua.
(function () {
  'use strict';
  if (!window.fengari) { throw new Error('fengari não carregou antes de static_host.js'); }
  if (!window.BRAI_LUA_HOST) { throw new Error('lua_host_core.js não carregou antes de static_host.js'); }
  if (!window.BRAI_LUA_FILES) { throw new Error('lua-bundle (BRAI_LUA_FILES) não carregou antes de static_host.js'); }

  function getText(rel) {
    var s = window.BRAI_LUA_FILES[rel];
    if (s == null) return Promise.reject(new Error('módulo Lua ausente no bundle: ' + rel));
    return Promise.resolve(s);
  }

  window.BRAIHost = window.BRAI_LUA_HOST.create({
    fengari: window.fengari,
    getText: getText,
    onReadyTree: function () { try { return sessionStorage.getItem('brai.simTree'); } catch (e) { return null; } },
  });
})();
