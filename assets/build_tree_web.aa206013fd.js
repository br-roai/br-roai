// build_tree_web.js — versão de navegador de tools/build_tree.js (só as funções puras).
// Gera o Lua a partir do JSON (mesma lógica do Node). Expõe window.BRAI_BUILD.
(function () {
  'use strict';
  var IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  function luaString(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  function luaValue(v, indent) {
    if (v === null || v === undefined) return 'nil';
    var t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') return String(v);
    if (t === 'string') return luaString(v);
    if (Array.isArray(v)) return luaArray(v, indent);
    if (t === 'object') return luaObject(v, indent);
    throw new Error('tipo nao suportado: ' + t);
  }
  function rep(n) { var s = ''; for (var i = 0; i < n; i++) s += '\t'; return s; }
  function luaArray(arr, indent) {
    if (arr.length === 0) return '{}';
    var pad = rep(indent + 1);
    var items = arr.map(function (x) { return pad + luaValue(x, indent + 1); });
    return '{\n' + items.join(',\n') + '\n' + rep(indent) + '}';
  }
  function luaObject(obj, indent) {
    var keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    var pad = rep(indent + 1);
    var parts = keys.map(function (k) {
      var key = IDENT.test(k) ? k : '[' + luaString(k) + ']';
      return pad + key + ' = ' + luaValue(obj[k], indent + 1);
    });
    return '{\n' + parts.join(',\n') + '\n' + rep(indent) + '}';
  }
  function pruneDisabled(spec) {
    if (!spec || typeof spec !== 'object') return spec;
    if (spec.disabled) return null;
    var out = {};
    var keys = Object.keys(spec);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'disabled') continue;
      if (k === 'children' && Array.isArray(spec.children)) {
        var arr = [];
        for (var j = 0; j < spec.children.length; j++) { var pc = pruneDisabled(spec.children[j]); if (pc != null) arr.push(pc); }
        out.children = arr;
      } else if (k === 'child') {
        out.child = spec.child ? pruneDisabled(spec.child) : null;
      } else {
        out[k] = spec[k];
      }
    }
    var DEC_REQ = { inverter: 1, succeeder: 1, cooldown: 1, limiter: 1 };
    if (DEC_REQ[out.type] && out.child == null) return null;
    return out;
  }
  // treeUsesMonsterCheck: espelho de tools/build_tree.js (paridade obrigatoria). [PLANO-GERACAO-LUA #2]
  function treeUsesMonsterCheck(spec) {
    if (!spec || typeof spec !== 'object') return false;
    if (spec.disabled) return false;
    if (spec.type === 'monsterCheck') return true;
    if (Array.isArray(spec.children)) {
      for (var i = 0; i < spec.children.length; i++) if (treeUsesMonsterCheck(spec.children[i])) return true;
    }
    if (spec.child && treeUsesMonsterCheck(spec.child)) return true;
    return false;
  }
  function generate(spec) {
    spec = pruneDisabled(spec) || { type: 'selector', children: [] };
    return [
      '-- tree_homun.lua — GERADO por BR-AI (web). Nao editar a mao.',
      '-- Fonte da verdade: o JSON correspondente (editor visual).',
      'BRAI = BRAI or {}',
      '',
      'BRAI.treeSpec = ' + luaValue(spec, 0),
      '',
      'return BRAI.treeSpec',
      '',
    ].join('\n');
  }
  var HOMUN_NAMES = { 1: 'Lif', 2: 'Amistr', 3: 'Filir', 4: 'Vanilmirth', 48: 'Eira', 49: 'Bayeri', 50: 'Sera', 51: 'Dieter', 52: 'Eleanor' };
  function generateConfig(ctx) {
    ctx = ctx || {};
    var ht = ctx.homunType || 0, bt = ctx.baseType || 0;
    var hn = HOMUN_NAMES[ht] || ('tipo ' + ht);
    var bn = bt ? (HOMUN_NAMES[bt] || ('tipo ' + bt)) : 'nenhuma';
    var cfg = {};
    var src = ctx.config || {};
    Object.keys(src).forEach(function (k) { if (src[k] !== undefined && src[k] !== null) cfg[k] = src[k]; });
    if (cfg.BaseHomunType === undefined) cfg.BaseHomunType = bt;
    var lines = Object.keys(cfg).map(function (k) {
      var key = IDENT.test(k) ? k : '[' + luaString(k) + ']';
      return '\t' + key + ' = ' + luaValue(cfg[k], 1) + ',';
    });
    return [
      '-- config.lua — GERADO por BR-AI (web). Nao editar a mao.',
      '-- Config de runtime desta arvore (knobs migrados / forma base).',
      '-- Homunculo: ' + hn + ' · Forma base: ' + bn,
      'BRAI = BRAI or {}',
      '',
      'BRAI.userConfig = {',
      lines.join('\n'),
      '}',
      '',
      'return BRAI.userConfig',
      '',
    ].join('\n');
  }
  function generateMonsters(catalog) {
    catalog = catalog || {};
    var data = {
      monsters: Array.isArray(catalog.monsters) ? catalog.monsters : [],
      groups: Array.isArray(catalog.groups) ? catalog.groups : [],
    };
    return [
      '-- monsters.lua — GERADO por BR-AI (web). Nao editar a mao.',
      'BRAI = BRAI or {}',
      '',
      'local catalog = ' + luaValue(data, 0),
      '',
      'if BRAI.monsterGroups then BRAI.monsterGroups.load(catalog) end',
      'BRAI.monsterCatalog = catalog',
      '',
      'return catalog',
      '',
    ].join('\n');
  }
  function generateSkillChoice(choices) {
    var src = (choices && choices.choices) ? choices.choices : (choices || {});
    var data = {};
    Object.keys(src).forEach(function (k) {
      var roles = src[k] || {}, r = {};
      ['mainAtk', 'aoeAtk', 'offBuff', 'defBuff'].forEach(function (rk) {
        var rv = roles[rk];
        if (Array.isArray(rv)) { var lst = rv.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x > 0; }); r[rk] = lst; }   // lista (inclui VAZIA = nenhuma skill)
        else { var v = parseInt(rv, 10); if (v > 0) r[rk] = v; }
        var lv = parseInt(roles[rk + 'Level'], 10);
        if (lv > 0) r[rk + 'Level'] = lv;
      });
      if (roles.combo && typeof roles.combo === 'object') r.combo = roles.combo;
      if (roles.skillLevels && typeof roles.skillLevels === 'object') {
        var sl = {}; Object.keys(roles.skillLevels).forEach(function (id) { var lv2 = parseInt(roles.skillLevels[id], 10); if (lv2 > 0) sl[String(id)] = lv2; });
        if (Object.keys(sl).length) r.skillLevels = sl;
      }
      if (Object.keys(r).length) data[String(k)] = r;
    });
    return [
      '-- skill_choice.lua — GERADO por BR-AI (web). Nao editar a mao.',
      'BRAI = BRAI or {}',
      '',
      'local choices = ' + luaValue({ choices: data }, 0),
      '',
      'if BRAI.setSkillChoice then BRAI.setSkillChoice(choices) end',
      'BRAI.skillChoiceRaw = choices',
      '',
      'return choices',
      '',
    ].join('\n');
  }
  function generateSummonChoice(choices) {
    var src = (choices && choices.choices) ? choices.choices : (choices || {});
    var data = {};
    Object.keys(src).forEach(function (k) {
      var p = src[k] || {}, r = {};
      if (p.level != null && parseInt(p.level, 10) >= 1) r.level = parseInt(p.level, 10);
      if (typeof p.resummon === 'string') r.resummon = p.resummon;
      if (p.minCount != null && parseInt(p.minCount, 10) >= 1) r.minCount = parseInt(p.minCount, 10);
      if (p.minMobCount != null && parseInt(p.minMobCount, 10) >= 0) r.minMobCount = parseInt(p.minMobCount, 10);
      if (typeof p.vsBossOnly === 'boolean') r.vsBossOnly = p.vsBossOnly;
      if (Object.keys(r).length) data[String(k)] = r;
    });
    return [
      '-- summon_choice.lua — GERADO por BR-AI (web). Nao editar a mao.',
      'BRAI = BRAI or {}',
      '',
      'local choices = ' + luaValue({ choices: data }, 0),
      '',
      'if BRAI.setSummonChoice then BRAI.setSummonChoice(choices) end',
      'BRAI.summonChoiceRaw = choices',
      '',
      'return choices',
      '',
    ].join('\n');
  }
  function generateSkillParams(params) {
    var src = (params && params.params) ? params.params : (params || {});
    var data = {};
    Object.keys(src).forEach(function (role) {
      var knobs = src[role] || {}, rr = {};
      Object.keys(knobs).forEach(function (key) { var v = knobs[key]; if (typeof v === 'number' || typeof v === 'boolean') rr[key] = v; });
      if (Object.keys(rr).length) data[role] = rr;
    });
    return [
      '-- skill_params.lua — GERADO por BR-AI (web). Nao editar a mao.',
      'BRAI = BRAI or {}',
      '',
      'local params = ' + luaValue({ params: data }, 0),
      '',
      'if BRAI.setSkillParams then BRAI.setSkillParams(params) end',
      'BRAI.skillParamsRaw = params',
      '',
      'return params',
      '',
    ].join('\n');
  }
  var api = { generate: generate, generateConfig: generateConfig, generateMonsters: generateMonsters, generateSkillChoice: generateSkillChoice, generateSummonChoice: generateSummonChoice, generateSkillParams: generateSkillParams, treeUsesMonsterCheck: treeUsesMonsterCheck };
  if (typeof window !== 'undefined') window.BRAI_BUILD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
