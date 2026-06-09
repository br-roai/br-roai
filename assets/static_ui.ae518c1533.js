// static_ui.js — UI da versão estática SEM barra no topo: os botões ficam DENTRO dos
// controles existentes. Simulador: "Importar cenário" no #scnbar. Editor: "Importar árvore"
// nos controles de árvore + importar/exportar de monstros/skills perto dos botões deles.
//  • Cenários/árvores: carregar = upload (validado); combobox oculto até existir item.
//  • Monstros/skills/summons: importar/exportar (localStorage via backend).
// classify()/validate() são puros e testáveis em Node.
(function (root) {
  'use strict';

  function classify(filename, obj) {
    var name = String(filename || 'importado').replace(/\.json$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'importado';
    if (obj && (Array.isArray(obj.entities) || obj.grid)) return { kind: 'scenario', rel: 'scenarios/' + name + '.json', name: name };
    if (obj && (obj.spec || (obj.type && obj.children) || obj.homunType != null)) return { kind: 'tree', rel: 'trees/' + name + '/tree.json', name: name };
    if (obj && (Array.isArray(obj.monsters) || Array.isArray(obj.groups))) return { kind: 'monsters', rel: 'monsters.json', name: 'monsters' };
    if (obj && obj.choices) { if (/summon|invoc/i.test(filename || '')) return { kind: 'summons', rel: 'homun_summons.json', name: 'homun_summons' }; return { kind: 'skills', rel: 'homun_skills.json', name: 'homun_skills' }; }
    return { kind: 'unknown', rel: '', name: name };
  }
  function validate(kind, obj) {
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'JSON vazio ou inválido.' };
    if (kind === 'scenario') {
      if (!Array.isArray(obj.entities)) return { ok: false, error: 'Este arquivo não é um cenário válido (faltam "entities").' };
      if (!obj.grid || typeof obj.grid.w !== 'number' || typeof obj.grid.h !== 'number') return { ok: false, error: 'Este arquivo não é um cenário válido (faltam "grid.w"/"grid.h").' };
      return { ok: true };
    }
    if (kind === 'tree') {
      var spec = obj.spec || obj;
      if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') return { ok: false, error: 'Este arquivo não é uma árvore válida (faltam "spec.type").' };
      return { ok: true };
    }
    return { ok: true };
  }

  var api = { classify: classify, validate: validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_STATIC_UI = api;

  if (typeof document === 'undefined') return;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function baseName(fn) { return String(fn || 'arquivo').replace(/\.json$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'arquivo'; }
  function toggle(el, show) { if (el) el.style.display = show ? 'inline-block' : 'none'; }
  function setMsg(t, isErr) { var m = $('braiMsg'); if (m) { m.textContent = t || ''; m.className = 'brai-msg ' + (isErr ? 'err' : 'okmsg'); } }
  function backend() { return window.BRAI_STATIC_BACKEND; }

  function rebuildSelect(sel, names, ph) { if (!sel) return; var cur = sel.value; sel.innerHTML = '<option value="">' + ph + '</option>' + names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join(''); if (names.indexOf(cur) >= 0) sel.value = cur; }
  async function refreshLists() {
    if (window.scenarios && $('scnList')) { var s = await window.scenarios.list(); var n = s.data || []; rebuildSelect($('scnList'), n, '— cenários —'); toggle($('scnList'), n.length > 0); toggle($('btnScnLoad'), n.length > 0); }
    if (window.trees && $('treeList')) { var t = await window.trees.list(); var tn = t.data || []; rebuildSelect($('treeList'), tn, '— salvas —'); toggle($('treeList'), tn.length > 0); toggle($('btnOpen'), tn.length > 0); }
  }

  async function importTyped(file, kind) { return importNamed(await file.text(), file.name, kind); }
  async function importNamed(text, fname, kind) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return setMsg('Arquivo não é um JSON válido.', true); }
    var bk = backend(); if (!bk || !bk.importFile) return setMsg('Backend indisponível.', true);
    if (kind === 'scenario' || kind === 'tree') {
      var v = validate(kind, obj); if (!v.ok) return setMsg(v.error, true);
      var name = baseName(fname);
      bk.importFile(kind === 'scenario' ? 'scenarios/' + name + '.json' : 'trees/' + name + '/tree.json', text);
      await refreshLists();
      if (kind === 'scenario') { if ($('scnList')) $('scnList').value = name; if ($('btnScnLoad')) $('btnScnLoad').click(); setMsg('Cenário "' + name + '" carregado.', false); }
      else { if ($('treeList')) $('treeList').value = name; if ($('btnOpen')) $('btnOpen').click(); setMsg('Árvore "' + name + '" carregada.', false); }
    } else {
      var rel = kind === 'monsters' ? 'monsters.json' : kind === 'skills' ? 'homun_skills.json' : 'homun_summons.json';
      bk.importFile(rel, text);
      setMsg((kind === 'monsters' ? 'Monstros' : kind === 'skills' ? 'Skills' : 'Summons') + ' importados. Recarregue para aplicar.', false);
    }
  }
  async function loadExample(kind, name) {        // selecionar um exemplo = carregar direto (na memória)
    if (!name) return;
    var url = (kind === 'scenario' ? 'data/examples/scenarios/' : 'data/examples/trees/') + encodeURIComponent(name) + '.json';
    var r; try { r = await fetch(url, { cache: 'force-cache' }); } catch (e) { return setMsg('Falha ao carregar exemplo.', true); }
    if (!r || !r.ok) return setMsg('Exemplo não encontrado.', true);
    return importNamed(await r.text(), name + '.json', kind);
  }
  async function exportConfig(rel, label) { try { var bk = backend(); if (bk && bk.exportConfig) { await bk.exportConfig(rel); setMsg(label + ' exportados (download).', false); } } catch (e) { setMsg('Falha ao exportar ' + label + '.', true); } }

  function mkBtn(label, fn, title) { var b = document.createElement('button'); b.textContent = label; if (title) b.title = title; b.onclick = fn; return b; }
  function mkImport(label, kind, inputId, title) {
    var b = document.createElement('button'); b.textContent = label; if (title) b.title = title;
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json'; inp.style.display = 'none'; if (inputId) inp.id = inputId;
    inp.addEventListener('change', function () { if (inp.files && inp.files[0]) importTyped(inp.files[0], kind); inp.value = ''; });
    b.onclick = function () { inp.click(); }; b.appendChild(inp); return b;
  }
  function mkMsg() { var s = document.createElement('span'); s.id = 'braiMsg'; s.className = 'brai-msg okmsg'; return s; }
  function after(node, ref) { if (ref && ref.parentNode) ref.parentNode.insertBefore(node, ref.nextSibling); }

  var examples = { scenarios: [], trees: [] };
  async function loadExamples() { try { var r = await fetch('data/examples/manifest.json', { cache: 'force-cache' }); if (r.ok) examples = await r.json(); } catch (e) {} }
  function fillEx(sel, names) { if (!sel) return; sel.innerHTML = '<option value="">— carregar exemplo —</option>' + (names || []).map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join(''); }
  async function downloadExample(kind, name) {
    if (!name) return; var url = (kind === 'scenario' ? 'data/examples/scenarios/' : 'data/examples/trees/') + encodeURIComponent(name) + '.json';
    try { var r = await fetch(url, { cache: 'force-cache' }); if (!r.ok) return setMsg('Exemplo não encontrado.', true); var text = await r.text(); var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name + '.json'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); setMsg('Exemplo "' + name + '" baixado — agora use Importar.', false); } catch (e) { setMsg('Falha ao baixar exemplo.', true); }
  }

  async function injectSim() {
    var bar = $('scnbar'); if (!bar) return;
    bar.appendChild(mkImport('📤 Importar cenário', 'scenario', 'braiImpScn', 'Carregar um cenário .json do seu computador'));
    var exsel = document.createElement('select'); exsel.id = 'braiExScn'; exsel.style.display = 'none'; exsel.title = 'Cenários de exemplo — selecione para carregar'; exsel.addEventListener('change', function () { if (exsel.value) loadExample('scenario', exsel.value); }); bar.appendChild(exsel);
    var exb = mkBtn('baixar exemplo', function () { downloadExample('scenario', exsel.value); }, 'Baixar o cenário de exemplo selecionado (.json)'); exb.id = 'braiExScnDl'; exb.style.display = 'none'; bar.appendChild(exb);
    bar.appendChild(mkMsg());
    await loadExamples(); fillEx(exsel, examples.scenarios); toggle(exsel, (examples.scenarios || []).length > 0); toggle(exb, (examples.scenarios || []).length > 0);
    await refreshLists();
  }
  async function injectEditor() {
    var tb = $('toolbar'); if (!tb) return;
    var imp = mkImport('📤 Importar árvore', 'tree', 'braiImpTree', 'Carregar uma árvore .json do seu computador');
    if ($('treeList') && $('treeList').parentNode) $('treeList').parentNode.insertBefore(imp, $('treeList')); else tb.appendChild(imp);   // treeList agora vive em #tbRow1
    var exsel = document.createElement('select'); exsel.id = 'braiExTree'; exsel.style.display = 'none'; exsel.title = 'Exemplos de árvore — selecione para carregar'; exsel.addEventListener('change', function () { if (exsel.value) loadExample('tree', exsel.value); });
    var exb = mkBtn('baixar exemplo', function () { downloadExample('tree', exsel.value); }, 'Baixar a árvore de exemplo selecionada (.json)'); exb.id = 'braiExTreeDl'; exb.style.display = 'none';
    after(exb, $('btnSaveTree')); after(exsel, $('btnSaveTree'));
    // import/export de monstros/skills movido p/ DENTRO dos respectivos modais (só na estática)
    tb.appendChild(mkMsg());
    await loadExamples(); fillEx(exsel, examples.trees); toggle(exsel, (examples.trees || []).length > 0); toggle(exb, (examples.trees || []).length > 0);
    await refreshLists();
  }
  function boot() { if ($('scnbar')) injectSim(); else if ($('toolbar')) injectEditor(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
