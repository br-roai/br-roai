// lua_host_core.js — núcleo COMUM do host Lua (Fengari) do BR-AI.
// A ordem de módulos (derivada de bootstrap.lua + os módulos do simulador) e a
// montagem/dispatch da VM ficam aqui; a web (lua_host_web.js) e a estática
// (static_host.js) só fornecem "getText(rel)" (fetch vs. bundle em memória).
//
//   create({ fengari, getText, onReadyTree? }) -> { ready:Promise, dispatch(m,arg):Promise<string> }
//   parseModuleList(bootSrc) -> [rel...]   (testável em Node)
//
// Uso (navegador): window.BRAI_LUA_HOST.create({ fengari: window.fengari, getText, onReadyTree })
// Uso (Node):      const { create, parseModuleList } = require('./lua_host_core')
(function (root) {
  'use strict';

  function parseModuleList(bootSrc) {
    var files = [];
    var re = /f\(\s*"([^"]+)"\s*\)/g, m;
    while ((m = re.exec(bootSrc)) !== null) files.push(m[1]);
    // módulos exclusivos do simulador (não carregados no cliente do RO)
    files.push('src/sim/json.lua', 'src/sim/skill_req_level.lua', 'src/sim/runtime.lua');
    return files;
  }

  function create(opts) {
    var F = opts.fengari;
    var lua = F.lua, lauxlib = F.lauxlib, lualib = F.lualib;
    var to_luastring = F.to_luastring, to_jsstring = F.to_jsstring;
    var getText = opts.getText;
    var L = null;

    function loadChunk(rel, src) {
      var st = lauxlib.luaL_loadstring(L, to_luastring('--@' + rel + '\n' + src));
      if (st !== lua.LUA_OK) throw new Error('compilar ' + rel + ': ' + to_jsstring(lua.lua_tostring(L, -1)));
      if (lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0) !== lua.LUA_OK) throw new Error('executar ' + rel + ': ' + to_jsstring(lua.lua_tostring(L, -1)));
      lua.lua_settop(L, 0);
    }

    function rawDispatch(method, argJson) {
      lua.lua_getglobal(L, to_luastring('SIM_DISPATCH'));
      lua.lua_pushstring(L, to_luastring(method));
      lua.lua_pushstring(L, to_luastring(argJson || ''));
      if (lua.lua_pcall(L, 2, 1, 0) !== lua.LUA_OK) {
        var e = to_jsstring(lua.lua_tostring(L, -1)); lua.lua_settop(L, 0);
        throw new Error('SIM_DISPATCH(' + method + '): ' + e);
      }
      var res = to_jsstring(lua.lua_tostring(L, -1)); lua.lua_settop(L, 0);
      return res;
    }

    async function init() {
      L = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(L);
      var boot = await getText('bootstrap.lua');
      var files = parseModuleList(boot);
      var srcs = await Promise.all(files.map(function (f) { return Promise.resolve(getText(f)).then(function (t) { return [f, t]; }); }));
      var byName = {}; srcs.forEach(function (p) { byName[p[0]] = p[1]; });
      for (var i = 0; i < files.length; i++) loadChunk(files[i], byName[files[i]]);
      if (opts.onReadyTree) { try { var t = opts.onReadyTree(); if (t) rawDispatch('setTree', t); } catch (e) {} }
    }

    var ready = init();
    return {
      ready: ready,
      dispatch: async function (method, argJson) { await ready; return rawDispatch(method, argJson); },
      rawDispatch: function (method, argJson) { return rawDispatch(method, argJson); },
    };
  }

  var api = { create: create, parseModuleList: parseModuleList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_LUA_HOST = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
