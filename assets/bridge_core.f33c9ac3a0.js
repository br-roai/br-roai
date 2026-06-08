// bridge_core.js — núcleo COMUM da ponte do BR-AI (web + estática).
// Monta window.brai/trees/scenarios/monsters/skillChoiceIO/summonIO/files a partir
// de um "backend" abstrato. A web (fs_bridge.js) e a estática (s3_backend.js) só
// implementam o backend; a lógica dos globais (o CONTRATO) fica aqui, idêntica.
//
// Contrato do backend:
//   ready            : Promise              (resolvida quando o backend está pronto)
//   canWrite()       : null | {ok:false,error}   (porta de escrita; null = pode)
//   readText(rel)    : Promise<string>      (lança se faltar)
//   readBytes(rel)   : Promise<Uint8Array>
//   listDir(rel)     : Promise<{dirs:[],files:[]}>
//   writeData(rel,d) : Promise             (SAVE do usuário; na estática = download)
//   writeArtifact(rel,d): Promise          (artefato do build; na estática = no-op)
//   readLuaTree()    : Promise<[{rel,data}]>
//   download(name,d) : void
//   host             : { dispatch(method, argJson):Promise<string> }
//   rememberTree(arg): void                (persiste setTree p/ o handoff; pode ser no-op)
//   updateBanner?()  : void
//
// Uso (navegador):  window.BRAI_BRIDGE.install(backend)
// Uso (Node/teste): const { install } = require('./bridge_core'); install(backend, target)
(function (root) {
  'use strict';

  function safeName(n) { return String(n || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim(); }
  function byLocale(a, b) { return a.localeCompare(b); }

  function install(backend, target) {
    target = target || (typeof window !== 'undefined' ? window : {});
    var ready = backend.ready || Promise.resolve();
    function need() { return backend.canWrite ? backend.canWrite() : null; }
    function writeArtifact(rel, data) { return (backend.writeArtifact || backend.writeData)(rel, data); }

    // ---- brai.dispatch (host Lua da página) ----
    target.brai = {
      dispatch: async function (method, argJson) {
        try {
          if (method === 'setTree' && argJson && backend.rememberTree) backend.rememberTree(argJson);
          var data = await backend.host.dispatch(method, argJson);
          return { ok: true, data: data };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      },
    };

    // ---- trees ----
    target.trees = {
      list: async function () { await ready; try { var j = await backend.listDir('trees'); return { ok: true, data: (j.dirs || []).sort(byLocale) }; } catch (e) { return { ok: true, data: [] }; } },
      load: async function (name) { await ready; try { return { ok: true, data: await backend.readText('trees/' + safeName(name) + '/tree.json') }; } catch (e) { return { ok: false, error: 'não foi possível abrir tree.json: ' + (e.message || e) }; } },
      save: async function (name, jsonText) {
        await ready; var n = need(); if (n) return n; var sn = safeName(name); if (!sn) return { ok: false, error: 'nome da árvore vazio' };
        try { await backend.writeData('trees/' + sn + '/tree.json', jsonText); return { ok: true, name: sn, folder: 'trees/' + sn }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
      },
      build: async function (name, payloadJson) {
        await ready; var n = need(); if (n) return n;
        try {
          var payload = JSON.parse(payloadJson);
          var spec = payload.spec || payload;
          var sn = safeName(name); if (!sn) return { ok: false, error: 'nome da árvore vazio' };
          var ctx = { homunType: payload.homunType, baseType: payload.baseType };
          var catalog = { monsters: [], groups: [] };
          try { catalog = JSON.parse((await target.monsters.load()).data); } catch (e) {}
          var choices = { choices: {} };
          try { choices = JSON.parse((await target.skillChoiceIO.load()).data); } catch (e) {}
          var summonChoices = { choices: {} };
          try { summonChoices = JSON.parse((await target.summonIO.load()).data); } catch (e) {}
          var gen = {
            'tree_homun.lua': target.BRAI_BUILD.generate(spec),
            'config.lua': target.BRAI_BUILD.generateConfig(ctx),
            'monsters.lua': target.BRAI_BUILD.generateMonsters(catalog),
            'skill_choice.lua': target.BRAI_BUILD.generateSkillChoice(choices),
            'summon_choice.lua': target.BRAI_BUILD.generateSummonChoice(summonChoices),
          };
          for (var fn in gen) await writeArtifact('trees/' + sn + '/' + fn, gen[fn]);

          var runtime = await backend.readLuaTree();
          var entries = [];
          for (var i = 0; i < runtime.length; i++) {
            var rel = runtime[i].rel;
            entries.push({ name: rel === 'AI.lua' ? 'AI.lua' : ('brai/lua/' + rel), data: runtime[i].data });
          }
          ['tree_homun.lua', 'config.lua', 'monsters.lua', 'skill_choice.lua'].forEach(function (f) {
            var zn = 'brai/lua/src/' + f, idx = -1;
            for (var k = 0; k < entries.length; k++) if (entries[k].name === zn) { idx = k; break; }
            if (idx >= 0) entries[idx].data = gen[f]; else entries.push({ name: zn, data: gen[f] });
          });
          var hn = { 1: 'Lif', 2: 'Amistr', 3: 'Filir', 4: 'Vanilmirth', 48: 'Eira', 49: 'Bayeri', 50: 'Sera', 51: 'Dieter', 52: 'Eleanor' };
          entries.push({ name: 'LEIA-ME.txt', data: [
            'BR-AI — pacote da IA "' + sn + '"', '',
            'INSTALAR: extraia AI.lua + a pasta brai/ em <RO>/AI/USER_AI/ e ative com /hoai.',
            'Homúnculo: ' + (hn[ctx.homunType] || ctx.homunType || '?') + (ctx.baseType ? (' / base ' + (hn[ctx.baseType] || ctx.baseType)) : '') + '.',
          ].join('\r\n') });

          for (var e = 0; e < entries.length; e++) await writeArtifact('trees/' + sn + '/dist/' + entries[e].name, entries[e].data);
          var zipBytes = target.BRAI_ZIP.zipBytes(entries);
          await writeArtifact('trees/' + sn + '/' + sn + '.zip', zipBytes);
          backend.download(sn + '.zip', zipBytes);
          return { ok: true, name: sn, dist: 'trees/' + sn + '/dist', zip: 'trees/' + sn + '/' + sn + '.zip', files: entries.length };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      },
    };

    // ---- scenarios ----
    target.scenarios = {
      list: async function () { await ready; try { var j = await backend.listDir('scenarios'); return { ok: true, data: (j.files || []).filter(function (f) { return f.toLowerCase().endsWith('.json'); }).map(function (f) { return f.slice(0, -5); }).sort(byLocale) }; } catch (e) { return { ok: true, data: [] }; } },
      load: async function (name) { await ready; try { return { ok: true, data: await backend.readText('scenarios/' + safeName(name) + '.json') }; } catch (e) { return { ok: false, error: 'não foi possível abrir o cenário: ' + (e.message || e) }; } },
      save: async function (name, jsonText) { await ready; var n = need(); if (n) return n; var sn = safeName(name); if (!sn) return { ok: false, error: 'nome do cenário vazio' }; try { await backend.writeData('scenarios/' + sn + '.json', jsonText); return { ok: true, name: sn }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    };

    // ---- monsters (catálogo global na raiz) ----
    target.monsters = {
      load: async function () { await ready; try { return { ok: true, data: await backend.readText('monsters.json') }; } catch (e) { return { ok: true, data: JSON.stringify({ monsters: [], groups: [] }) }; } },
      save: async function (jsonText) { await ready; var n = need(); if (n) return n; try { await backend.writeData('monsters.json', jsonText); return { ok: true, path: 'monsters.json' }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    };

    // ---- skillChoice (escolha global de skills na raiz: homun_skills.json) ----
    target.skillChoiceIO = {
      load: async function () { await ready; try { return { ok: true, data: await backend.readText('homun_skills.json') }; } catch (e) { return { ok: true, data: JSON.stringify({ choices: {} }) }; } },
      save: async function (jsonText) { await ready; var n = need(); if (n) return n; try { await backend.writeData('homun_skills.json', jsonText); return { ok: true, path: 'homun_skills.json' }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    };

    // ---- summonIO (config global de invocacoes na raiz: homun_summons.json) ----
    target.summonIO = {
      load: async function () { await ready; try { return { ok: true, data: await backend.readText('homun_summons.json') }; } catch (e) { return { ok: true, data: JSON.stringify({ choices: {} }) }; } },
      save: async function (jsonText) { await ready; var n = need(); if (n) return n; try { await backend.writeData('homun_summons.json', jsonText); return { ok: true, path: 'homun_summons.json' }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    };

    // ---- files (fallbacks usados pelo editor) ----
    target.files = {
      loadTree: async function () { await ready; try { return { ok: true, data: await backend.readText('desktop/shared/tree_homun.json') }; } catch (e) { return { ok: false, error: 'sem arquivo' }; } },
      saveTree: async function (jsonText) { await ready; var n = need(); if (n) return n; try { await backend.writeData('desktop/shared/tree_homun.json', jsonText); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
      buildLua: async function (jsonText) { await ready; var n = need(); if (n) return n; try { await backend.writeData('lua/src/tree_homun.lua', target.BRAI_BUILD.generate(JSON.parse(jsonText))); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; } },
    };

    if (backend.updateBanner) { try { backend.updateBanner(); } catch (e) {} }
    return target;
  }

  var api = { install: install, safeName: safeName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_BRIDGE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
