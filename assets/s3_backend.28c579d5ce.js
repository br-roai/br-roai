// s3_backend.js — backend ESTÁTICO da ponte do BR-AI (S3/CloudFront, sem servidor).
// Modelo de estado:
//   • Cenários e árvores: BIBLIOTECA EM MEMÓRIA (RAM) — NÃO persiste no navegador.
//     Carregar = upload (validado no static_ui); salvar = download. Some no reload.
//   • monsters/skills/summons: localStorage (semeado do default S3 no 1º uso).
//   • Handoff editor→sim (árvore do "Simular"): sessionStorage (estado da ferramenta).
// Usa o núcleo COMUM desktop/shared/bridge_core.js (mesmo contrato da web).
//
// makeStaticBackend(deps) é uma fábrica pura (testável). deps:
//   fetchImpl, localStorage, session, download(name,data,mime), encodeUtf8(str)->Uint8Array,
//   luaFiles (map rel->src), host (BRAIHost), dataPrefix?
(function (root) {
  'use strict';
  var LS = { 'monsters.json': 'brai.monsters', 'homun_skills.json': 'brai.skills', 'homun_summons.json': 'brai.summons', 'homun_skill_params.json': 'brai.skillparams' };

  function isScenario(rel) { return /^scenarios\/.+\.json$/.test(rel); }
  function isTree(rel) { return /^trees\/.+\/tree\.json$/.test(rel); }
  function scnName(rel) { var m = /^scenarios\/(.+)\.json$/.exec(rel); return m ? m[1] : null; }
  function treeName(rel) { var m = /^trees\/(.+)\/tree\.json$/.exec(rel); return m ? m[1] : null; }
  function basename(rel) { var p = rel.split('/'); return p[p.length - 1]; }

  function mimeFor(name) {
    if (/\.zip$/i.test(name)) return 'application/zip';
    if (/\.json$/i.test(name)) return 'application/json';
    if (/\.lua$/i.test(name)) return 'text/plain';
    return 'application/octet-stream';
  }

  function makeStaticBackend(deps) {
    var DATA = deps.dataPrefix || 'data/';
    var fetchImpl = deps.fetchImpl;
    var local = deps.localStorage || null;   // persiste config (monsters/skills/summons)
    var session = deps.session || null;      // handoff (brai.simTree)
    var mem = { scenarios: {}, trees: {} };  // RAM: biblioteca (não persiste)

    function dataUrl(rel) { return DATA + rel; }

    async function readText(rel) {
      if (isScenario(rel)) { var n = scnName(rel); if (mem.scenarios[n] != null) return mem.scenarios[n]; throw new Error('cenário fora da sessão: ' + n); }
      if (isTree(rel)) { var t = treeName(rel); if (mem.trees[t] != null) return mem.trees[t]; throw new Error('árvore fora da sessão: ' + t); }
      if (LS[rel]) {
        var v = local ? local.getItem(LS[rel]) : null;
        if (v != null) return v;
        var r = await fetchImpl(dataUrl(rel), { cache: 'force-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ao ler ' + rel);
        var text = await r.text();
        if (local) { try { local.setItem(LS[rel], text); } catch (e) {} }   // semeia o localStorage
        return text;
      }
      var rr = await fetchImpl(dataUrl(rel), { cache: 'force-cache' });      // fallbacks (ex.: tree_homun.json)
      if (!rr.ok) throw new Error('HTTP ' + rr.status + ' ao ler ' + rel);
      return await rr.text();
    }
    async function readBytes(rel) { return deps.encodeUtf8(await readText(rel)); }

    async function listDir(rel) {
      if (rel === 'scenarios') return { dirs: [], files: Object.keys(mem.scenarios).map(function (n) { return n + '.json'; }) };
      if (rel === 'trees') return { dirs: Object.keys(mem.trees), files: [] };
      return { dirs: [], files: [] };
    }

    // SAVE: cenário/árvore = download (+ memória da sessão); config = localStorage (persiste).
    async function writeData(rel, data) {
      if (isScenario(rel)) { mem.scenarios[scnName(rel)] = String(data); deps.download(basename(rel), data, 'application/json'); return { ok: true, path: rel }; }
      if (isTree(rel)) { mem.trees[treeName(rel)] = String(data); deps.download(treeName(rel) + '.json', data, 'application/json'); return { ok: true, path: rel }; }
      if (LS[rel]) { if (local) { try { local.setItem(LS[rel], String(data)); } catch (e) {} } return { ok: true, path: rel }; }
      deps.download(basename(rel), data, mimeFor(basename(rel))); return { ok: true, path: rel };
    }
    async function writeArtifact() { return { ok: true }; }   // build: nada persiste (só o .zip final é baixado)

    async function readLuaTree() {
      var out = [], F = deps.luaFiles || {};
      for (var rel in F) { if (rel.indexOf('src/sim/') === 0) continue; if (rel === 'sim_boot.lua') continue; out.push({ rel: rel, data: F[rel] }); }
      return out;
    }

    // API extra para o static_ui:
    function importFile(rel, text) {        // upload -> biblioteca/localStorage (sem download)
      if (isScenario(rel)) mem.scenarios[scnName(rel)] = text;
      else if (isTree(rel)) mem.trees[treeName(rel)] = text;
      else if (LS[rel] && local) { try { local.setItem(LS[rel], text); } catch (e) {} }
    }
    async function exportConfig(rel) {      // download da config atual (monsters/skills/summons)
      var text = await readText(rel);
      deps.download(basename(rel), text, 'application/json');
    }

    return {
      ready: Promise.resolve(),
      canWrite: function () { return null; },
      readText: readText, readBytes: readBytes, listDir: listDir,
      writeData: writeData, writeArtifact: writeArtifact, readLuaTree: readLuaTree,
      download: function (n, d) { deps.download(n, d, mimeFor(n)); },
      host: deps.host,
      rememberTree: function (arg) { try { if (session) session.setItem('brai.simTree', arg); } catch (e) {} },
      updateBanner: deps.updateBanner || function () {},
      importFile: importFile, exportConfig: exportConfig,
      _mem: mem,
    };
  }

  var api = { makeStaticBackend: makeStaticBackend, mimeFor: mimeFor, isScenario: isScenario, isTree: isTree };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof window !== 'undefined' && window.BRAI_BRIDGE) {
    function browserDownload(name, data, mime) {
      try {
        var blob = new Blob([data], { type: mime || 'application/octet-stream' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) {}
    }
    var backend = makeStaticBackend({
      fetchImpl: window.fetch.bind(window),
      localStorage: window.localStorage,
      session: window.sessionStorage,
      download: browserDownload,
      encodeUtf8: function (s) { return new TextEncoder().encode(s); },
      luaFiles: window.BRAI_LUA_FILES || {},
      host: window.BRAIHost,
    });
    window.BRAI_STATIC_BACKEND = backend;
    window.BRAI_BRIDGE.install(backend);
    window.BRAIConnectFolder = window.BRAIConnectFolder || function () {};
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
