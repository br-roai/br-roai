// migration_ui.js — UI da tela de migração (upload → de→para → abrir no editor).
// JS puro; usa os módulos window.BRAI_* (lua_parse/zip_read/migrate) e a árvore padrão embutida.
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  var HOMUN = { 1: 'Lif', 2: 'Amistr', 3: 'Filir', 4: 'Vanilmirth', 48: 'Eira', 49: 'Bayeri', 50: 'Sera', 51: 'Dieter', 52: 'Eleanor' };
  function isHomunS(t) { t = Number(t); return t >= 48 && t <= 52; }
  var zipRead = window.BRAI_ZIP_READ, migrator = window.BRAI_MIGRATE;
  var lastFiles = null, lastResult = null;
  var curHomun = null, curBase = 0;      // seleção atual (homún + forma base)
  var groupOverrides = {};                // id do grupo -> nome editado (sobrevive a re-migrações)
  var monsterOverrides = {};              // id do monstro (single) -> desc editada

  // ---------------------------------------------------------------- loading
  function showLoading(on, msg) {
    var el = $('loading'); if (!el) return;
    if (msg) $('loadingMsg').textContent = msg;
    el.style.display = on ? 'flex' : 'none';
    var drop = $('drop'); if (drop) drop.classList.toggle('busy', !!on);
  }

  // ---------------------------------------------------------------- upload
  function wireUpload() {
    var drop = $('drop'), input = $('file');
    $('pick').onclick = function (e) { e.stopPropagation(); input.click(); };
    drop.onclick = function () { if (!drop.classList.contains('busy')) input.click(); };
    input.onchange = function () { if (input.files && input.files[0]) handleFile(input.files[0]); };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });
  }

  function handleFile(file) {
    $('err1').textContent = '';
    showLoading(true, 'Lendo o arquivo…');          // feedback imediato
    var fr = new FileReader();
    fr.onload = function () {
      zipRead.readZip(new Uint8Array(fr.result)).then(function (files) {
        var luas = Object.keys(files).filter(function (k) { return /\.lua$/i.test(k); });
        if (!luas.length) throw new Error('Nenhum arquivo .lua encontrado no zip.');
        lastFiles = files;
        curHomun = null; curBase = 0; groupOverrides = {};   // nova migração: reseta seleção/renomeações
        $('detected').innerHTML = 'Arquivos lidos: ' + luas.map(function (k) { return '<code>' + esc(k) + '</code>'; }).join(' ');
        showLoading(true, 'Convertendo a IA…');
        // deixa o spinner PINTAR antes da migração síncrona (que pode bloquear a thread)
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            try { runMigrate(); showStep(2); }
            catch (e) { $('err1').innerHTML = '<span class="err">Falha ao converter: ' + esc(e.message) + '</span>'; showStep(1); }
            showLoading(false);
          });
        });
      }).catch(function (e) { showLoading(false); $('err1').innerHTML = '<span class="err">Falha ao ler o zip: ' + esc(e.message) + '</span>'; });
    };
    fr.onerror = function () { showLoading(false); $('err1').innerHTML = '<span class="err">Não consegui ler o arquivo.</span>'; };
    fr.readAsArrayBuffer(file);
  }

  function runMigrate() {
    var opts = { defaultTree: window.BRAI_DEFAULT_TREE, name: 'azzyai-migrada' };
    if (curHomun != null) opts.homunType = curHomun;
    if (curHomun != null && isHomunS(curHomun)) opts.baseType = curBase;
    lastResult = migrator.migrate(lastFiles, opts);
    migrator.applyGroupNames(lastResult, groupOverrides);   // reaplica renomeações de grupo
    migrator.applyMonsterNames(lastResult, monsterOverrides); // e de monstro (singles)
    curHomun = lastResult.wrapper.homunType;                // sincroniza com o resultado (1ª vez)
    curBase = lastResult.wrapper.baseType;
    render(lastResult);
  }

  // ---------------------------------------------------------------- render do de→para
  function render(r) {
    var c = r.report.counts;
    $('title2').textContent = 'Migração: ' + (HOMUN[r.wrapper.homunType] || ('tipo ' + r.wrapper.homunType)) +
      (r.wrapper.baseType ? ' (forma base ' + (HOMUN[r.wrapper.baseType] || r.wrapper.baseType) + ')' : '');
    $('summary').innerHTML =
      pill('ok', c.mapped, 'mapeados') + pill('warn', c.adjusted, 'ajustados') + pill('', c.note, 'a revisar') +
      pill('acc', c.groups, 'grupos de monstro') + pill('acc', c.monsters, 'monstros') + pill('acc', c.skillTypes, 'tipos c/ skills');

    wireSelectors();   // homún + forma base (espelha o syncCtx do editor)

    $('sections').innerHTML = r.report.sections.map(function (s) {
      if (!s.rows.length) return '';
      if (s.title === 'Táticas por monstro') return renderTacticsPanels(r);   // 2 painéis: grupos (2+) e monstros (1)
      var body = s.rows.map(function (row) {
        return '<tr><td class="from"><span class="badge ' + (row.status || 'note') + '">' +
          ({ mapped: '✓', adjusted: '⚙', note: '⚠' }[row.status] || '•') + '</span>' + esc(row.from) + '</td>' +
          '<td class="arrow">→</td><td>' + esc(row.to) + (row.reason ? ' <span class="muted">(' + esc(row.reason) + ')</span>' : '') + '</td></tr>';
      }).join('');
      return '<section class="card"><h3 onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'\':\'none\'">' +
        esc(s.title) + '<span class="count">' + s.rows.length + ' itens</span></h3><div><table>' + body + '</table></div></section>';
    }).join('');
    wireGroupInputs();

    $('hint').textContent = (r.warnings && r.warnings.length) ? (r.warnings.length + ' aviso(s) de parsing (não-fatais)') : '';
  }
  function pill(cls, n, label) { return '<span class="pill ' + cls + '"><b>' + (n || 0) + '</b> ' + label + '</span>'; }

  function wireSelectors() {
    var sel = $('homunSel'), bsel = $('baseSel');
    sel.value = String(curHomun);
    var hs = isHomunS(curHomun);
    bsel.disabled = !hs;
    bsel.value = String(hs ? curBase : 0);
    sel.onchange = function () { curHomun = Number(sel.value); if (!isHomunS(curHomun)) curBase = 0; runMigrate(); };
    bsel.onchange = function () { curBase = Number(bsel.value); runMigrate(); };
  }

  // dois painéis: "Táticas por grupos de monstros" (2+ monstros) e "Táticas por monstro" (1 monstro).
  // Nomes editáveis sobrevivem à troca de tipo/base (o agrupamento independe do homúnculo).
  function behBadge(x) { return x.behavior ? ('<span class="gbeh' + (x.fid === 'yellow' ? ' warn' : '') + '">' + esc(x.behavior) + (x.fid === 'yellow' ? ' \u26a0' : '') + '</span>') : ''; }
  function renderTacticsPanels(r) { return renderGroupPanel(r) + renderSinglePanel(r); }
  function renderGroupPanel(r) {
    var gs = (r.monsters && r.monsters.groups) || [];
    if (!gs.length) return '';
    var byId = {}; (r.monsters.monsters || []).forEach(function (m) { byId[m.id] = m.desc; });
    var rows = gs.map(function (g) {
      var names = g.members.slice(0, 4).map(function (id) { return byId[id] || ('#' + id); }).join(', ');
      if (g.members.length > 4) names += ' +' + (g.members.length - 4);
      return '<tr class="grp-row"><td><input class="gname" data-gid="' + g.id + '" value="' + escAttr(g.name) + '" title="renomeie este grupo" /></td>' +
        '<td>' + behBadge(g) + '</td>' +
        '<td class="muted">' + g.members.length + ' monstros' + (names ? ': ' + esc(names) : '') + '</td></tr>';
    }).join('');
    return '<section class="card"><h3>Táticas por grupos de monstros <span class="count">' + gs.length + ' grupos \u00b7 renomeie como quiser</span></h3><div><table>' + rows + '</table></div></section>';
  }
  function renderSinglePanel(r) {
    var ss = r.singles || [];
    if (!ss.length) return '';
    var rows = ss.map(function (sg) {
      return '<tr class="grp-row"><td><input class="mname" data-mid="' + sg.id + '" value="' + escAttr(sg.desc) + '" title="renomeie este monstro (#' + sg.id + ')" /></td>' +
        '<td>' + behBadge(sg) + '</td>' +
        '<td class="muted">#' + sg.id + '</td></tr>';
    }).join('');
    return '<section class="card"><h3>Táticas por monstro <span class="count">' + ss.length + ' monstros \u00b7 1 monstro cada \u00b7 renomeie como quiser</span></h3><div><table>' + rows + '</table></div></section>';
  }
  function wireGroupInputs() {
    Array.prototype.forEach.call(document.querySelectorAll('input.gname'), function (inp) {
      inp.oninput = function () {
        groupOverrides[Number(inp.getAttribute('data-gid'))] = inp.value;
        migrator.applyGroupNames(lastResult, groupOverrides);
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('input.mname'), function (inp) {
      inp.oninput = function () {
        monsterOverrides[Number(inp.getAttribute('data-mid'))] = inp.value;
        migrator.applyMonsterNames(lastResult, monsterOverrides);
      };
    });
  }

  // ---------------------------------------------------------------- layout (uids + posições)
  function kidsOf(n) { var a = []; if (Array.isArray(n.children)) a = a.concat(n.children); if (n.child) a.push(n.child); return a; }
  function layout(tree) {
    var uid = 0, leaf = 0;
    (function walk(n, depth) {
      n._uid = ++uid; n._x = 40 + depth * 210;
      var ks = kidsOf(n);
      if (!ks.length) { n._y = 40 + (leaf++) * 64; }
      else { ks.forEach(function (c) { walk(c, depth + 1); }); n._y = (ks[0]._y + ks[ks.length - 1]._y) / 2; }
    })(tree, 0);
  }

  // ---------------------------------------------------------------- handoff p/ o editor (seletivo)
  // 3 caixas perto do OK: o que aplicar. A árvore (com táticas) precisa dos grupos -> inclui Monstros.
  function selection() {
    var tree = !!($('optTree') && $('optTree').checked);
    var mon = tree || !!($('optMon') && $('optMon').checked);
    var skills = !!($('optSkills') && $('optSkills').checked);
    return { tree: tree, mon: mon, skills: skills };
  }
  function updateOkState() {
    var tree = !!($('optTree') && $('optTree').checked);
    if ($('optMon')) { if (tree) $('optMon').checked = true; $('optMon').disabled = tree; }  // árvore => monstros
    var s = selection();
    if ($('ok')) $('ok').disabled = !(s.tree || s.mon || s.skills);
  }
  function persistMonsters(r) {
    try { localStorage.setItem('brai.monsters', JSON.stringify(r.monsters)); } catch (e) {}
    try { if (window.monsters && window.monsters.save) window.monsters.save(JSON.stringify(r.monsters, null, 2)); } catch (e) {}
  }
  function persistSkills(r) {
    try { localStorage.setItem('brai.skills', JSON.stringify(r.skillChoices)); } catch (e) {}
    try { if (window.skillChoiceIO && window.skillChoiceIO.save) window.skillChoiceIO.save(JSON.stringify(r.skillChoices, null, 2)); } catch (e) {}
    // Fase 8a: nível da invocação (Sera) viaja junto das skills (homun_summons.json)
    if (r.summonChoices && r.summonChoices.choices && Object.keys(r.summonChoices.choices).length) {
      try { localStorage.setItem('brai.summons', JSON.stringify(r.summonChoices)); } catch (e) {}
      try { if (window.summonIO && window.summonIO.save) window.summonIO.save(JSON.stringify(r.summonChoices, null, 2)); } catch (e) {}
    }
  }
  function openInEditor() {
    var r = lastResult; if (!r) return;
    var s = selection();
    if (!(s.tree || s.mon || s.skills)) return;
    var w = r.wrapper;
    if (s.mon) persistMonsters(r);
    if (s.skills) persistSkills(r);
    if (s.tree) {
      layout(w.spec);
      try {
        sessionStorage.setItem('brai.editorState', JSON.stringify({
          tree: w.spec, ctxHomun: w.homunType, ctxBase: w.baseType, config: r.config,
          treeName: w.name, currentName: '', selId: w.spec._uid, zoom: 1, sl: 0, st: 0, fromMigration: true,
        }));
        sessionStorage.setItem('brai.migConfig', JSON.stringify(r.config));
      } catch (e) {}
    } else {
      // não substitui a árvore do usuário: descarta um estado de migração antigo p/ não sequestrar o editor
      try { var prev = JSON.parse(sessionStorage.getItem('brai.editorState') || 'null'); if (prev && prev.fromMigration) sessionStorage.removeItem('brai.editorState'); } catch (e) {}
      try { sessionStorage.removeItem('brai.migConfig'); } catch (e) {}
    }
    window.location.href = 'editor.html';
  }

  function download(r) {
    var bundle = { wrapper: r.wrapper, config: r.config, monsters: r.monsters, skillChoices: r.skillChoices, summonChoices: r.summonChoices, report: r.report, warnings: r.warnings };
    var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'migracao-azzyai.json';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------------------------------------------------------- passos
  function showStep(n) { $('step1').classList.toggle('active', n === 1); $('step2').classList.toggle('active', n === 2); }

  function boot() {
    if (!zipRead || !migrator || !window.BRAI_DEFAULT_TREE) { $('err1').innerHTML = '<span class="err">Módulos do migrador não carregaram.</span>'; return; }
    wireUpload();
    $('ok').onclick = openInEditor;
    $('dl').onclick = function () { if (lastResult) download(lastResult); };
    ['optTree', 'optMon', 'optSkills'].forEach(function (id) { var el = $(id); if (el) el.onchange = updateOkState; });
    updateOkState();
    $('again').onclick = function () {
      lastFiles = null; lastResult = null; curHomun = null; curBase = 0; groupOverrides = {}; monsterOverrides = {};
      ['optTree', 'optMon', 'optSkills'].forEach(function (id) { var el = $(id); if (el) el.checked = true; });
      updateOkState();
      $('file').value = ''; $('detected').textContent = ''; showLoading(false); showStep(1);
    };
  }
  // superfície pública (usada pelos smokes de navegador e por testes)
  window.BRAI_MIGRATION_UI = {
    getResult: function () { return lastResult; },
    selection: selection,
    layout: layout,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
