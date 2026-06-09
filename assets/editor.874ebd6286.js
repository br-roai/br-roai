// editor.js — editor visual de árvores como GRAFO de arrastar e soltar.
// Modelo = spec da árvore (com _uid e posições _x/_y). Paleta/validação vêm do registry (Lua).
'use strict';

const COMPOSITES = ['selector', 'sequence', 'parallel'];
const DECORATORS = ['inverter', 'succeeder', 'cooldown', 'limiter'];
const LEAVES = ['condition', 'action'];
const NW = 200, NH = 58, GX = 28, GY = 66; // largura/altura do nó + gaps de layout

const $ = (id) => document.getElementById(id);
let registry = {};
let paramMeta = {};
function pLabel(k) { return (paramMeta[k] && paramMeta[k].label) || k; }
function pHelp(k) { return (paramMeta[k] && paramMeta[k].help) || ''; }
let tree = null;
let selId = null;
let uidSeq = 1;
let nodeEls = {};       // uid -> elemento DOM
let zoom = 1;           // fator de zoom do canvas
let ctxHomun = 4, ctxBase = 0, catalog = [];
let treeConfig = {};  // knobs do H_Config (migrados/editados) — vão p/ save/build/sim
let cfgDefaults = null;  // BRAI.defaultConfig() (do sim), p/ o painel Config  // contexto p/ skills (UseSkill)
const S_TYPES_E = [48, 49, 50, 51, 52];
const CAT_LABEL = { single: 'Dano alvo único', aoe: 'Dano em área', buff: 'Buff', heal: 'Cura', special: 'Especial', passive: 'Passiva' };
const CAT_ORDER = ['single', 'aoe', 'buff', 'heal', 'special', 'passive'];
// #5: skills efetivas por papel do homún do contexto (p/ o rótulo do nó). Cache recarregado com o catálogo.
let roleCfgCache = null;
let actionSkillsCache = null;   // S3: skills+estado das 8 ações automáticas (rótulo do nó)
const ACTION_ROLE = { UseAoESkill: 'aoeAtk', UseMainSkill: 'mainAtk', UseOffensiveBuff: 'offBuff', UseDefensiveBuff: 'defBuff' };
const PARAM_EXTRA = { UseHealSelf: 'healSelf', UseHealOwner: 'healOwner', UseOwnerBuff: 'ownerBuff', UseCastling: 'castling' };   // ações de skill sem knobs por nó, mas com params por homún [C8]
async function loadCatalog() {
  try { catalog = await callSim('skillCatalog', { homunType: ctxHomun, baseType: ctxBase }); } catch (e) { catalog = []; }
  try { roleCfgCache = await callSim('roleConfig', { homunType: ctxHomun }); } catch (e) { roleCfgCache = null; }   // #5
  try { actionSkillsCache = await callSim('actionSkillsAll', { homunType: ctxHomun, baseType: ctxBase }); } catch (e) { actionSkillsCache = null; }   // S3
}
// rótulo das skills efetivas de uma ação automática (nome + nível). Vazio (ex.: Dieter mainAtk) => ''.
function roleSkillsLabel(actionName) {
  const role = ACTION_ROLE[actionName];
  if (!role || !roleCfgCache) return '';
  const rc = roleCfgCache.find(r => r.key === role);
  if (!rc || !rc.effective || !rc.effective.length) return '';
  return rc.effective.map(e => e.name + ' Lv' + (e.level > 0 ? e.level : (e.maxLevel || '?'))).join(' · ');
}
// Após editar/salvar um modal de config, recarrega o cache do contexto (roleCfgCache via loadCatalog)
// e re-renderiza a árvore/inspetor — assim os rótulos refletem o que está no host (e no Lua/sim).
async function refreshTreeLabels(msg) {
  await loadCatalog();
  renderInspector(); renderAll();
  if (msg) setStatus(msg);
}
// catálogo GLOBAL de monstros/grupos (cadastro do usuário) p/ os nós monsterCheck.
let monCatalog = { monsters: [], groups: [] };
function normCatalog(c) { c = c || {}; return { monsters: Array.isArray(c.monsters) ? c.monsters : [], groups: Array.isArray(c.groups) ? c.groups : [] }; }
function monById(id) { for (const m of monCatalog.monsters) if (m.id === id) return m; return null; }
function grpById(id) { for (const g of monCatalog.groups) if (g.id === id) return g; return null; }
async function loadMonsters() { try { const r = await window.monsters.load(); if (r && r.ok) monCatalog = normCatalog(JSON.parse(r.data)); } catch (e) { monCatalog = { monsters: [], groups: [] }; } }
async function saveMonsters() { try { await window.monsters.save(JSON.stringify(monCatalog, null, 2)); } catch (e) {} }
// Importar/Exportar monstros — só na ESTÁTICA (stateless); salvar/carregar o cadastro.
function monIoMsg(t, isErr) { const m = document.getElementById('monIoMsg'); if (m) { m.textContent = t || ''; m.className = 'sc-io-msg ' + (isErr ? 'err' : 'ok'); } }
function monExportCfg() {
  try {
    const blob = new Blob([JSON.stringify(monCatalog || { monsters: [], groups: [] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'monsters.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    monIoMsg('Monstros exportados (download).', false);
  } catch (e) { monIoMsg('Falha ao exportar.', true); }
}
async function monImportCfg(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.monsters)) throw new Error('fmt');
    monCatalog = normCatalog(obj);
    await saveMonsters(); renderMonManager(); renderInspector(); renderAll();
    monIoMsg('Monstros importados.', false);
  } catch (e) { monIoMsg('Arquivo de monstros inválido.', true); }
}

// ===== Escolha de skills por homúnculo (homun_skills.json) =================
// Alguns Homunculus S têm 2+ skills no mesmo papel (Dieter: Lava Slide/Blast Forge
// em AoE; Pyroclastic/Tempering como buff ofensivo). Aqui escolhe-se qual cada
// ação automática (UseAoESkill, UseOffensiveBuff, ...) usa. Global, na raiz.
let skillChoice = { choices: {} };
let scHomun = null;
let spParams = { params: {} };   // parâmetros GLOBAIS das ações de skill, por papel (homun_skill_params.json)
let spTab = null;   // papel (aba) ativo no modal de Parâmetros (#spModal)
let summonCfg = { choices: {} };
const HOMUN_NAMES = { 1: 'Lif', 2: 'Amistr', 3: 'Filir', 4: 'Vanilmirth', 48: 'Eira', 49: 'Bayeri', 50: 'Sera', 51: 'Dieter', 52: 'Eleanor' };
const SC_ROLE_LABEL = { mainAtk: 'Main skill (alvo único)', aoeAtk: 'Skill em área (AoE)', offBuff: 'Buff ofensivo', defBuff: 'Buff defensivo', healSelf: 'Cura própria', healOwner: 'Cura do dono', ownerBuff: 'Buff no dono', castling: 'Castling' };
const SC_HOMUN_ORDER = [51, 49, 50, 48, 52, 4, 1, 2, 3];  // Homunculus S primeiro
let comboInfoCache = null;   // dados dos combos da Eleanor (BRAI.comboInfo)
let comboNodeUid = null;     // nó UseEleanorOffense ligado ao painel
let comboMode = 'node';     // 'node' (params do nó) | 'default' (padrão em homun_skills.json)
function normChoice(c) { c = c || {}; return { choices: (c.choices && typeof c.choices === 'object') ? c.choices : {} }; }
async function loadSkillChoice() { try { const r = await window.skillChoiceIO.load(); if (r && r.ok) skillChoice = normChoice(JSON.parse(r.data)); } catch (e) { skillChoice = { choices: {} }; } }
async function saveSkillChoice() { try { await window.skillChoiceIO.save(JSON.stringify(skillChoice, null, 2)); } catch (e) {} try { await callSim('setSkillChoice', skillChoice); } catch (e) {} }
// Importar/Exportar skills — só na versão ESTÁTICA (stateless); permite salvar/carregar a config.
function scIsStatic() { return typeof window !== 'undefined' && !!window.BRAI_STATIC_BACKEND; }
function scIoMsg(t, isErr) { const m = document.getElementById('scIoMsg'); if (m) { m.textContent = t || ''; m.className = 'sc-io-msg ' + (isErr ? 'err' : 'ok'); } }
function scExportSkills() {
  try {
    const blob = new Blob([JSON.stringify(skillChoice || { choices: {} }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'homun_skills.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    scIoMsg('Skills exportadas (download).', false);
  } catch (e) { scIoMsg('Falha ao exportar.', true); }
}
async function scImportSkills(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || typeof obj !== 'object' || typeof obj.choices !== 'object') throw new Error('fmt');
    skillChoice = normChoice(obj);
    await saveSkillChoice();
    await renderSkillManager();   // recria o modal a partir do importado
    scIoMsg('Skills importadas.', false);
  } catch (e) { scIoMsg('Arquivo de skills inválido.', true); }
}
// ---- Parâmetros de skill por homúnculo/papel (#spModal) ----
function normParams(p) { p = p || {}; return { params: (p.params && typeof p.params === 'object') ? p.params : {}, overrides: (p.overrides && typeof p.overrides === 'object') ? p.overrides : {} }; }
async function loadSkillParams() { try { const r = await window.skillParamsIO.load(); if (r && r.ok) spParams = normParams(JSON.parse(r.data)); } catch (e) { spParams = { params: {} }; } try { await callSim('setSkillParams', spParams); } catch (e) {} }
async function saveSkillParams() { try { await window.skillParamsIO.save(JSON.stringify(spParams, null, 2)); } catch (e) {} try { await callSim('setSkillParams', spParams); } catch (e) {} }
function spGetRole(role) { return spParams.params[role] || {}; }
// --- camada de OVERRIDE por homúnculo (editada no modal de Skills; persiste em spParams.overrides) ---
function ovEnsure(homun) { spParams.overrides = spParams.overrides || {}; const k = String(homun); spParams.overrides[k] = spParams.overrides[k] || {}; return spParams.overrides[k]; }
function ovEnable(homun, role, knobs) { const h = ovEnsure(homun); const r = {}; (knobs || []).forEach(k => { if (k.globalValue != null) r[k.key] = k.globalValue; }); h[role] = r; }
function ovDisable(homun, role) { const k = String(homun); if (spParams.overrides && spParams.overrides[k]) { delete spParams.overrides[k][role]; if (!Object.keys(spParams.overrides[k]).length) delete spParams.overrides[k]; } }
function ovSetKnob(homun, role, key, value) { const h = ovEnsure(homun); h[role] = h[role] || {}; h[role][key] = value; }
// campo de knob da sobreposição (SEM dica de padrão): number ou booleano sim/não, pré-preenchido c/ o valor efetivo
function ovKnobField(role, knob) {
  const v = (knob.value != null) ? knob.value : knob.globalValue;
  const gv = (knob.globalValue != null) ? knob.globalValue : '';
  if (knob.type === 'boolean') {
    const selv = v ? 'true' : 'false';
    return '<div class="sp-knob"><label title="' + esc(knob.key + (knob.help ? ' — ' + knob.help : '')) + '">' + esc(knob.label || knob.key) + '</label>' +
      '<select class="ovKnob" data-role="' + role + '" data-key="' + knob.key + '" data-type="boolean">' +
      '<option value="true"' + (selv === 'true' ? ' selected' : '') + '>sim</option>' +
      '<option value="false"' + (selv === 'false' ? ' selected' : '') + '>não</option></select></div>';
  }
  return '<div class="sp-knob"><label title="' + esc(knob.key + (knob.help ? ' — ' + knob.help : '')) + '">' + esc(knob.label || knob.key) + '</label>' +
    '<input class="ovKnob" data-role="' + role + '" data-key="' + knob.key + '" data-type="number" data-gv="' + esc(String(gv)) + '" type="number" value="' + esc(String(v != null ? v : '')) + '" /></div>';
}
function spSetKnob(role, key, value) {
  spParams.params[role] = spParams.params[role] || {};
  if (value === null || value === undefined) {
    delete spParams.params[role][key];
    if (!Object.keys(spParams.params[role]).length) delete spParams.params[role];
  } else { spParams.params[role][key] = value; }
}
function spIoMsg(t, isErr) { const m = document.getElementById('spIoMsg'); if (m) { m.textContent = t || ''; m.className = 'sc-io-msg ' + (isErr ? 'err' : 'ok'); } }
function spExportParams() {
  try {
    const blob = new Blob([JSON.stringify(spParams || { params: {} }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'homun_skill_params.json';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    spIoMsg('Parâmetros exportados (download).', false);
  } catch (e) { spIoMsg('Falha ao exportar.', true); }
}
async function spImportParams(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || typeof obj !== 'object' || typeof obj.params !== 'object') throw new Error('fmt');
    spParams = normParams(obj);
    await saveSkillParams();
    await renderSkillParamsModal();
    spIoMsg('Parâmetros importados.', false);
  } catch (e) { spIoMsg('Arquivo de parâmetros inválido.', true); }
}
// campo de um knob no modal GLOBAL: number (vazio = usa o padrão) ou booleano sim/não (sem "herdar")
function spKnobField(role, knob) {
  const cur = spGetRole(role)[knob.key];
  const gv = knob.default;
  if (knob.type === 'boolean') {
    const selv = ((cur != null) ? cur : !!gv) ? 'true' : 'false';   // sem "herdar": mostra o valor efetivo
    const o = [['true', 'sim'], ['false', 'não']];
    return '<div class="sp-knob"><label title="' + esc(knob.key + (knob.help ? ' — ' + knob.help : '')) + '">' + esc(knob.label || knob.key) + '</label>' +
      '<select class="spKnob" data-role="' + role + '" data-key="' + knob.key + '" data-type="boolean">' +
      o.map(x => '<option value="' + x[0] + '"' + (x[0] === selv ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select></div>';
  }
  const v = (cur != null) ? cur : '';
  const ph = (gv !== undefined) ? ' placeholder="' + esc(String(gv)) + '"' : '';
  return '<div class="sp-knob"><label title="' + esc(knob.key + (knob.help ? ' — ' + knob.help : '')) + '">' + esc(knob.label || knob.key) + (gv !== undefined ? ' <span class="sp-gl">· padrão: ' + esc(fmtCfg(gv)) + '</span>' : '') + '</label>' +
    '<input class="spKnob" data-role="' + role + '" data-key="' + knob.key + '" data-type="number" type="number" value="' + v + '"' + ph + ' /></div>';
}
async function loadSummonChoice() { try { const r = await window.summonIO.load(); if (r && r.ok) summonCfg = normChoice(JSON.parse(r.data)); } catch (e) { summonCfg = { choices: {} }; } try { await callSim('setSummonChoice', summonCfg); } catch (e) {} }
async function saveSummonChoice() { try { await window.summonIO.save(JSON.stringify(summonCfg, null, 2)); } catch (e) {} try { await callSim('setSummonChoice', summonCfg); } catch (e) {} }
function renderSummonPanel(si) {
  const saved = (summonCfg.choices[String(scHomun)]) || si.saved || {};
  const cat = (si.perLevel || []).map(p => 'nv' + p.level + ': ' + p.count + '\u00d7 ' + esc(p.name) + ' (' + Math.round(p.duration / 1000) + 's)').join(' \u00b7 ');
  let h = '<div class="sm-panel"><div class="sm-head"><b>Invoca\u00e7\u00e3o \u2014 ' + esc(si.name) + ' \u00b7 padr\u00e3o</b></div>';
  h += '<div class="sm-note">Padr\u00e3o da invoca\u00e7\u00e3o (salvo em <code>homun_summons.json</code>). Os <b>params do n\u00f3</b> <code>UseSeraLegion</code> na \u00e1rvore <b>sobrep\u00f5em</b> isto.</div>';
  h += '<div class="sm-cat">' + cat + '</div>';
  for (const f of (si.fields || [])) {
    const val = (saved[f.key] !== undefined && saved[f.key] !== null) ? saved[f.key] : f.default;
    let ctrl;
    if (f.type === 'enum') ctrl = '<select class="sm-field" data-key="' + f.key + '" data-type="enum">' + (f.options || []).map(o => '<option value="' + o + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    else if (f.type === 'bool') ctrl = '<input type="checkbox" class="sm-field" data-key="' + f.key + '" data-type="bool"' + (val ? ' checked' : '') + '>';
    else ctrl = '<input type="number" class="sm-field" data-key="' + f.key + '" data-type="int"' + (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + ' value="' + val + '" style="width:64px">';
    h += '<div class="sm-row"><label class="sm-lbl">' + esc(f.label) + '</label>' + ctrl + '<div class="sm-help">' + esc(f.help) + '</div></div>';
  }
  return h + '</div>';
}
function scGet(type, role) { const t = skillChoice.choices[String(type)]; return (t && t[role]) ? t[role] : 0; }
function scSet(type, role, id) {
  const k = String(type);
  if (!id) { if (skillChoice.choices[k]) { delete skillChoice.choices[k][role]; if (!Object.keys(skillChoice.choices[k]).length) delete skillChoice.choices[k]; } }
  else { skillChoice.choices[k] = skillChoice.choices[k] || {}; skillChoice.choices[k][role] = id; }
}
// nível por papel (homun_skills.json grava <role>Level; 0/vazio = nível padrão conhecido)
function scGetLevel(type, role) { const t = skillChoice.choices[String(type)]; return (t && t[role + 'Level']) ? t[role + 'Level'] : 0; }
function scSetLevel(type, role, lvl) {
  const k = String(type), key = role + 'Level';
  if (!lvl || lvl <= 0) { if (skillChoice.choices[k]) { delete skillChoice.choices[k][key]; if (!Object.keys(skillChoice.choices[k]).length) delete skillChoice.choices[k]; } }
  else { skillChoice.choices[k] = skillChoice.choices[k] || {}; skillChoice.choices[k][key] = lvl; }
}
// nível POR SKILL (skillLevels[id]; precede o por papel). Chave string (JSON).
function scGetSkillLevel(type, id) { const t = skillChoice.choices[String(type)]; return (t && t.skillLevels && t.skillLevels[String(id)]) ? t.skillLevels[String(id)] : 0; }
function scSetSkillLevel(type, id, lvl) {
  const k = String(type); skillChoice.choices[k] = skillChoice.choices[k] || {};
  const sl = skillChoice.choices[k].skillLevels = skillChoice.choices[k].skillLevels || {};
  if (!lvl || lvl <= 0) { delete sl[String(id)]; if (!Object.keys(sl).length) delete skillChoice.choices[k].skillLevels; if (!Object.keys(skillChoice.choices[k]).length) delete skillChoice.choices[k]; }
  else sl[String(id)] = lvl;
}
// lista de skills do papel (0..N ids; [] = nenhuma). scClearRole remove a chave (= padrão do perfil).
function scSetRoleList(type, role, ids) { const k = String(type); skillChoice.choices[k] = skillChoice.choices[k] || {}; skillChoice.choices[k][role] = (ids || []).slice(); }
function scClearRole(type, role) { const k = String(type); if (skillChoice.choices[k]) { delete skillChoice.choices[k][role]; if (!Object.keys(skillChoice.choices[k]).length) delete skillChoice.choices[k]; } }
function monLabel(id) { const m = monById(id); return m ? (m.desc || ('#' + m.id)) : ('#' + id); }
function nextGroupId() { let mx = 0; for (const g of monCatalog.groups) if (typeof g.id === 'number' && g.id > mx) mx = g.id; return mx + 1; }
function mcSummary(n) { const parts = []; if (n.monster && n.monster !== 0) parts.push(monLabel(n.monster)); if (n.group && n.group !== 0) { const g = grpById(n.group); parts.push('[' + (g ? (g.name || ('grupo ' + g.id)) : ('grupo ' + n.group)) + ']'); } return parts.length ? parts.join(' / ') : '(definir alvo)'; }
function catSkill(id) { for (const s of catalog) if (s.id === id) return s; return null; }
function arrAt(a, lvl) { if (!a || !a.length) return null; return a[lvl - 1] != null ? a[lvl - 1] : a[a.length - 1]; }
function fmtSec(ms) { if (!ms) return null; const v = ms / 1000; return (Number.isInteger(v) ? v : v.toFixed(1)) + 's'; }
function fmtDur(ms) { if (!ms) return null; const v = ms / 1000; if (v >= 60) { const m = v / 60; return (Number.isInteger(m) ? m : m.toFixed(1)) + 'min'; } return (Number.isInteger(v) ? v : v.toFixed(1)) + 's'; }
function skillInfoHtml(s, lvl) {
  const tgt = s.target === 'self' ? 'em si' : s.target === 'ground' ? 'no chão' : 'no alvo';
  const rng = arrAt(s.range, lvl), sp = arrAt(s.sp, lvl), ar = arrAt(s.area, lvl);
  const fc = fmtSec(arrAt(s.fixedCast, lvl)), vc = fmtSec(arrAt(s.varCast, lvl));
  const dl = fmtSec(arrAt(s.delay, lvl)), ru = fmtSec(arrAt(s.reuse, lvl)), du = fmtDur(arrAt(s.duration, lvl));
  const cells = [];
  const cell = (k, v) => { if (v != null && v !== '' && v !== false) cells.push('<div class="si-cell"><span class="si-k">' + k + '</span><span class="si-v">' + v + '</span></div>'); };
  cell('Alvo', tgt);
  cell('Alcance', rng != null ? rng : null);
  cell('SP', sp != null ? sp : null);
  if (ar) cell('Área', ar + '\u00d7' + ar);
  cell('Cast', (fc && vc) ? (fc + ' + ' + vc) : (fc || vc || null));
  cell('Recarga', ru || null);
  cell('Pós-conj.', dl || null);
  cell('Duração', du || null);
  const e = s.effect;
  let eff = '';
  if (e) {
    const isMag = e.kind === 'magic';
    const er = [];
    if (e.dmg) er.push((arrAt(e.dmg, lvl) || 0) + '% do ' + (isMag ? 'MATK' : 'ATK') + (e.dot ? ' por golpe' : ''));
    if (e.dmgFlat) er.push('dano fixo ' + (arrAt(e.dmgFlat, lvl) || 0));
    if (e.hpPct) er.push((arrAt(e.hpPct, lvl) || 0) + '% do HP máx');
    if (e.dot) er.push('DoT a cada ' + (e.dot.interval / 1000) + 's por ' + (fmtDur(arrAt(e.dot.dur, lvl)) || '?'));
    if (e.heal) er.push('cura ~' + (arrAt(e.heal.pct, lvl) || 0) + '% do HP' + (e.heal.who === 'owner' ? ' do dono' : e.heal.who === 'self' ? ' próprio' : ''));
    if (e.status) { const ch = arrAt(e.status.chance, lvl), sd = arrAt(e.status.dur, lvl); er.push('status ' + esc(e.status.name) + ' (' + (ch || 0) + '%' + (sd ? ' · ' + fmtDur(sd) : '') + ')'); }
    const pl = e.desc && (e.desc[lvl - 1] != null ? e.desc[lvl - 1] : e.desc[e.desc.length - 1]);
    eff = (er.length ? '<div class="si-eff">' + er.join(' · ') + '</div>' : '') + (pl ? '<div class="si-lv">Lv' + lvl + ': ' + esc(pl) + '</div>' : '');
  }
  const KIND = { physical: 'físico', magic: 'mágico', heal: 'cura', buff: 'buff', status: 'status', special: 'especial', summon: 'invocação' };
  const kindLabel = e ? (KIND[e.kind] || e.kind) : null;
  return '<div class="skillinfo">' +
    '<div class="si-head"><b>' + esc(s.iro) + '</b>' +
    '<span class="skillcat cat-' + s.cat + '">' + CAT_LABEL[s.cat] + '</span>' +
    (kindLabel ? '<span class="eff-kind">' + esc(kindLabel) + '</span>' : '') + '</div>' +
    '<div class="si-grid">' + cells.join('') + '</div>' +
    eff +
    (((e && e.note) || s.desc) ? '<div class="si-note muted">' + esc((e && e.note) || s.desc || '') + '</div>' : '') +
    '</div>';
}

// Ações com seletor de skill. `cats` filtra o catálogo por categoria.
// UseSkill = dano (alvo único + área), agrupado por tipo; UseSkillBuff = buffs no próprio homún.
const SKILL_ACTIONS = {
  UseSkill: { cats: ['single', 'aoe'], hint: 'Skill de dano: alvo único ou em área (agrupadas por tipo).' },
  UseSkillBuff: { cats: ['buff'], hint: 'Buffs no próprio homúnculo.' },
};
function skillPickerHtml(sel) {
  const spec = SKILL_ACTIONS[sel.name] || SKILL_ACTIONS.UseSkill;
  const list = catalog.filter(s => spec.cats.includes(s.cat));
  const groups = {};
  for (const s of list) (groups[s.cat] = groups[s.cat] || []).push(s);
  let opts = '<option value="">— selecione —</option>';
  for (const cat of CAT_ORDER) {
    if (!groups[cat]) continue;
    opts += '<optgroup label="' + CAT_LABEL[cat] + '">';
    for (const s of groups[cat].sort((a, b) => a.iro.localeCompare(b.iro)))
      opts += '<option value="' + s.id + '"' + (s.id === sel.params.skill ? ' selected' : '') + '>' + esc(s.iro) + '</option>';
    opts += '</optgroup>';
  }
  let h = '<div class="desc">' + esc(spec.hint) + '</div>';
  h += field('Skill disponível', '<select id="iSkill">' + opts + '</select>');
  const sk = catSkill(sel.params.skill);
  if (sk) {
    const lvl = sel.params.level || sk.maxLevel;
    h += skillInfoHtml(sk, lvl);
    let lo = ''; for (let i = 1; i <= sk.maxLevel; i++) lo += '<option value="' + i + '"' + (i === lvl ? ' selected' : '') + '>' + i + '</option>';
    h += field('Nível de execução', '<select id="iLevel">' + lo + '</select>');
    // o parâmetro 'on' (centro do cast) só aparece para skills de ÁREA/solo
    if (sk.target === 'ground') {
      const on = sel.params.on || 'enemy';
      h += field('Alvo do solo', '<select id="iOn">' +
        '<option value="enemy"' + (on === 'enemy' ? ' selected' : '') + '>Monstro (alvo atual)</option>' +
        '<option value="owner"' + (on === 'owner' ? ' selected' : '') + '>Dono</option></select>');
    }
    // intervalo customizado entre usos (ms) — não pode ser menor que pós-conjuração + recarga
    const minMs = (arrAt(sk.delay, lvl) || 0) + (arrAt(sk.reuse, lvl) || 0);
    if (sel.params.interval && sel.params.interval < minMs) sel.params.interval = minMs;   // clamp ao mínimo
    h += field('Intervalo entre usos (ms) — 0 desativa · mín ' + minMs + ' (pós+recarga)',
      '<input id="iInterval" type="number" min="0" step="100" value="' + (sel.params.interval || 0) + '" />');
    h += '<label class="chk"><input id="iReset" type="checkbox"' + (sel.params.reset ? ' checked' : '') +
      ' /> Reiniciar o intervalo quando o alvo mudar</label>';
  } else {
    h += '<div class="desc">Selecione o homúnculo/base na barra de cima e escolha uma skill.</div>';
  }
  return h;
}
function syncCtx() {
  ctxHomun = parseInt($('ctxHomun').value, 10) || 4;
  const isS = S_TYPES_E.includes(ctxHomun);
  $('ctxBase').disabled = !isS;
  if (!isS) $('ctxBase').value = '0';
  ctxBase = isS ? (parseInt($('ctxBase').value, 10) || 0) : 0;
}

// ---- ponte / util --------------------------------------------------------
async function callSim(method, obj) {
  const r = await window.brai.dispatch(method, obj ? JSON.stringify(obj) : '');
  if (!r.ok) { setStatus('ERRO: ' + r.error, true); throw new Error(r.error); }
  return JSON.parse(r.data);
}
function setStatus(msg, isErr) { const e = $('status'); e.textContent = msg || ''; e.style.color = isErr ? 'var(--red)' : 'var(--muted)'; }
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function namesByKind(kind) { return Object.keys(registry).filter(n => registry[n].kind === kind).sort(); }
// nomes LEGÍVEIS + GRUPOS das folhas (registry.title/group via leaf_meta.lua). Código mantido como value.
const LEAF_GROUP_ORDER = ['Vida (HP/SP)', 'Ameaça', 'Alvo', 'Ataque', 'Movimento', 'Skills ofensivas', 'Buffs, cura & defesa', 'Skills (manual)', 'Dono', 'Eleanor & Sera'];
function leafTitle(name) { return (registry[name] && registry[name].title) || name || ''; }
function leafGroup(name) { return (registry[name] && registry[name].group) || 'Outros'; }
function leafOptionsHtml(kind, selected) {
  const byGroup = {};
  namesByKind(kind).forEach(n => { (byGroup[leafGroup(n)] = byGroup[leafGroup(n)] || []).push(n); });
  const groups = Object.keys(byGroup).sort((a, b) => {
    const ia = LEAF_GROUP_ORDER.indexOf(a), ib = LEAF_GROUP_ORDER.indexOf(b);
    return ((ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)) || a.localeCompare(b);
  });
  let html = '';
  for (const g of groups) {
    html += '<optgroup label="' + esc(g) + '">';
    byGroup[g].sort((a, b) => leafTitle(a).localeCompare(leafTitle(b)));
    for (const n of byGroup[g]) html += '<option value="' + esc(n) + '"' + (n === selected ? ' selected' : '') + ' title="' + esc(n) + '">' + esc(leafTitle(n)) + '</option>';
    html += '</optgroup>';
  }
  return html;
}
function paramsSchema(name) { const p = registry[name] && registry[name].params; return (!p || Array.isArray(p)) ? {} : p; }
function paramsOptional(name) { const o = registry[name] && registry[name].optional; return Array.isArray(o) ? o : []; }

function kindOf(n) {
  if (COMPOSITES.includes(n.type)) return 'composite';
  if (DECORATORS.includes(n.type)) return 'decorator';
  if (n.type === 'check') return 'check';
  if (n.type === 'monsterCheck') return 'monstercheck';
  if (n.type === 'condition') return 'leaf-cond';
  if (n.type === 'action') return 'leaf-act';
  return 'unknown';
}
function childrenOf(n) {
  if (COMPOSITES.includes(n.type)) return n.children || [];
  if (DECORATORS.includes(n.type) || n.type === 'check' || n.type === 'monsterCheck') return n.child ? [n.child] : [];
  return [];
}
function assignUids(n) { n._uid = uidSeq++; childrenOf(n).forEach(assignUids); }
function find(n, uid) { if (n._uid === uid) return n; for (const c of childrenOf(n)) { const r = find(c, uid); if (r) return r; } return null; }
function findParent(n, uid, parent) { if (n._uid === uid) return parent; for (const c of childrenOf(n)) { const r = findParent(c, uid, n); if (r !== undefined) return r; } return undefined; }
function isDescendant(n, maybe) { if (n === maybe) return true; for (const c of childrenOf(n)) if (isDescendant(c, maybe)) return true; return false; }
const selected = () => (selId ? find(tree, selId) : null);
if (typeof window !== 'undefined') window.BRAI_EDITOR = { spec: function () { return exportSpec(tree); }, load: function (sp) { tree = JSON.parse(JSON.stringify(sp)); uidSeq = 1; assignUids(tree); selId = tree._uid; autoLayout(); renderInspector(); renderAll(); histInit(); } };
// ---- histórico (undo/redo) ----------------------------------------------
let _hist = [], _hpos = -1, _histTimer = null;
function _clone(n) { return JSON.parse(JSON.stringify(n)); }
function histInit() { _hist = tree ? [_clone(tree)] : []; _hpos = _hist.length - 1; updateUndoButtons(); }
function histRecord() {
  if (_histTimer) { clearTimeout(_histTimer); _histTimer = null; }
  if (!tree) return;
  _hist = _hist.slice(0, _hpos + 1); _hist.push(_clone(tree));
  if (_hist.length > 80) _hist.shift();
  _hpos = _hist.length - 1; updateUndoButtons();
}
function histRecordSoon() { if (_histTimer) clearTimeout(_histTimer); _histTimer = setTimeout(function () { _histTimer = null; histRecord(); }, 450); }
function _histApply() { tree = _clone(_hist[_hpos]); uidSeq = maxUid(tree) + 1; if (!find(tree, selId)) selId = tree._uid; renderInspector(); renderAll(); updateUndoButtons(); }
function undo() { if (_histTimer) { clearTimeout(_histTimer); _histTimer = null; histRecord(); } if (_hpos > 0) { _hpos--; _histApply(); setStatus('Desfeito.'); } }
function redo() { if (_hpos < _hist.length - 1) { _hpos++; _histApply(); setStatus('Refeito.'); } }
function updateUndoButtons() { const u = $('btnUndo'), r = $('btnRedo'); if (u) u.disabled = _hpos <= 0; if (r) r.disabled = _hpos >= _hist.length - 1; }

function exportSpec(n) {
  const out = {};
  for (const k of Object.keys(n)) {
    if (k === '_uid' || k === '_x' || k === '_y' || k === '_depth' || k === '_lx') continue;
    if (k === 'children') out.children = n.children.map(exportSpec);
    else if (k === 'child') out.child = n.child ? exportSpec(n.child) : null;
    else out[k] = n[k];
  }
  return out;
}

// ---- criação de nós ------------------------------------------------------
function newNode(kind) {
  if (COMPOSITES.includes(kind)) { const n = { type: kind, children: [] }; if (kind === 'parallel') n.policy = 'all'; return n; }
  if (kind === 'cooldown') return { type: 'cooldown', ms: 1000, child: null };
  if (kind === 'limiter') return { type: 'limiter', max: 1, child: null };
  if (DECORATORS.includes(kind)) return { type: kind, child: null };
  if (kind === 'check') return { type: 'check', name: namesByKind('condition')[0] || '', params: {}, child: null };
  if (kind === 'monsterCheck') return { type: 'monsterCheck', monster: 0, group: 0, negate: false, child: null };
  if (kind === 'condition') return { type: 'condition', name: namesByKind('condition')[0] || '', params: {} };
  if (kind === 'action') return { type: 'action', name: namesByKind('action')[0] || '', params: {} };
}

// ---- operações de estrutura ---------------------------------------------
function removeFromParent(node) {
  const parent = findParent(tree, node._uid, null);
  if (!parent) return;
  if (COMPOSITES.includes(parent.type)) parent.children.splice(parent.children.indexOf(node), 1);
  else if (DECORATORS.includes(parent.type) || parent.type === 'check' || parent.type === 'monsterCheck') parent.child = null;
}
function canAccept(target, node) {
  if (target === node || isDescendant(node, target)) return { ok: false, why: 'não pode reparentar dentro de si' };
  if (COMPOSITES.includes(target.type)) return { ok: true };
  if (DECORATORS.includes(target.type)) return target.child ? { ok: false, why: 'decorator já tem filho' } : { ok: true };
  if (target.type === 'check') return target.child ? { ok: false, why: 'check já tem filho' } : { ok: true };
  if (target.type === 'monsterCheck') return target.child ? { ok: false, why: 'monsterCheck já tem filho' } : { ok: true };
  return { ok: false, why: 'folha não aceita filhos' };
}
function reparent(node, target) {
  const c = canAccept(target, node);
  if (!c.ok) { setStatus('Reparent inválido: ' + c.why, true); return false; }
  removeFromParent(node);
  if (COMPOSITES.includes(target.type)) target.children.push(node);
  else target.child = node;
  setStatus('');
  return true;
}
function addChild() {
  const sel = selected(); if (!sel) { setStatus('Selecione um nó.', true); return; }
  const node = newNode($('addKind').value); assignUids(node);
  const c = canAccept(sel, node);
  if (!c.ok) { setStatus('Não dá p/ adicionar filho: ' + c.why, true); return; }
  if (COMPOSITES.includes(sel.type)) sel.children.push(node); else sel.child = node;
  selId = node._uid; autoLayout(); renderInspector(); renderAll(); histRecord();
}
function addSibling() {
  const sel = selected(); if (!sel || sel === tree) { setStatus('A raiz não tem irmãos.', true); return; }
  const parent = findParent(tree, selId, null);
  if (!COMPOSITES.includes(parent.type)) { setStatus('O pai precisa ser composite.', true); return; }
  const node = newNode($('addKind').value); assignUids(node);
  parent.children.splice(parent.children.indexOf(sel) + 1, 0, node);
  selId = node._uid; autoLayout(); renderInspector(); renderAll(); histRecord();
}
// ---- ativar/desativar nó (recursivo) -------------------------------------
function setDisabledRec(n, val) {
  if (val) n.disabled = true; else delete n.disabled;
  for (const c of childrenOf(n)) setDisabledRec(c, val);
}
function toggleDisabled() {
  const sel = selected(); if (!sel) { setStatus('Selecione um nó.', true); return; }
  const val = !sel.disabled;
  setDisabledRec(sel, val);
  renderInspector(); renderAll(); histRecord();
  setStatus(val ? 'Nó e filhos desativados (não executam; somem do Lua ao "Gerar Lua").' : 'Nó e filhos reativados.');
}
function del() {
  const sel = selected(); if (!sel) return;
  if (sel === tree) { setStatus('Não dá para excluir a raiz.', true); return; }
  const parent = findParent(tree, selId, null);
  removeFromParent(sel);
  selId = parent._uid; autoLayout(); renderInspector(); renderAll(); histRecord();
}
let _clipboard = null;
function duplicateNode() {
  const sel = selected(); if (!sel) { setStatus('Selecione um nó.', true); return; }
  if (sel === tree) { setStatus('Não dá para duplicar a raiz.', true); return; }
  const parent = findParent(tree, selId, null);
  if (!parent || !COMPOSITES.includes(parent.type)) { setStatus('Só dá para duplicar dentro de um composite.', true); return; }
  const copy = exportSpec(sel); assignUids(copy);
  parent.children.splice(parent.children.indexOf(sel) + 1, 0, copy);
  selId = copy._uid; autoLayout(); renderInspector(); renderAll(); histRecord(); setStatus('Duplicado.');
}
function copyNode() { const sel = selected(); if (!sel) { setStatus('Selecione um nó.', true); return; } _clipboard = exportSpec(sel); setStatus('Copiado: ' + nodeTypeLabel(sel)); }
function pasteNode() {
  if (!_clipboard) { setStatus('Nada para colar.', true); return; }
  const sel = selected(); if (!sel) { setStatus('Selecione um nó.', true); return; }
  const node = JSON.parse(JSON.stringify(_clipboard)); assignUids(node);
  const c = canAccept(sel, node);
  if (c.ok) { if (COMPOSITES.includes(sel.type)) sel.children.push(node); else sel.child = node; }
  else {
    const parent = findParent(tree, selId, null);
    if (parent && COMPOSITES.includes(parent.type)) parent.children.splice(parent.children.indexOf(sel) + 1, 0, node);
    else { setStatus('Não dá para colar aqui: ' + c.why, true); return; }
  }
  selId = node._uid; autoLayout(); renderInspector(); renderAll(); histRecord(); setStatus('Colado.');
}
function closeMenu() { const m = document.getElementById('ctxmenu'); if (m) m.remove(); }
function addNodeOfType(uid, type, mode) {
  const target = find(tree, uid); if (!target) return;
  const node = newNode(type); assignUids(node);
  if (mode === 'sibling') {
    if (target === tree) { setStatus('A raiz não tem irmãos.', true); return; }
    const parent = findParent(tree, uid, null);
    if (!parent || !COMPOSITES.includes(parent.type)) { setStatus('O pai precisa ser composite.', true); return; }
    parent.children.splice(parent.children.indexOf(target) + 1, 0, node);
  } else {
    const c = canAccept(target, node);
    if (!c.ok) { setStatus('Não dá p/ adicionar: ' + c.why, true); return; }
    if (COMPOSITES.includes(target.type)) target.children.push(node); else target.child = node;
  }
  selId = node._uid; autoLayout(); renderInspector(); renderAll(); histRecord();
}
const _TYPE_GROUPS = [
  { label: 'Composite', types: ['selector', 'sequence', 'parallel'] },
  { label: 'Decorator', types: ['inverter', 'succeeder', 'cooldown', 'limiter'] },
  { label: 'Condicional', types: ['check', 'monsterCheck'] },
  { label: 'Folha', types: ['action'] },
];
function openTypeMenu(uid, cx, cy, mode, withActions) {
  closeMenu();
  const target = find(tree, uid); if (!target) return;
  selId = uid; renderInspector(); renderGraph();
  const canChild = canAddChild(target); if (mode === 'child' && !canChild) mode = 'sibling';
  const m = document.createElement('div'); m.id = 'ctxmenu'; m.className = 'ctxmenu';
  let h = '<div class="cm-h">' + (mode === 'sibling' ? 'Adicionar irmão' : 'Adicionar filho') + '</div>';
  for (const g of _TYPE_GROUPS) {
    h += '<div class="cm-group">' + g.label + '</div><div class="cm-grid">';
    for (const t of g.types) h += '<button class="cm-t" data-add="' + t + '" title="' + esc(NODE_HELP[t] || '') + '">' + (NODE_TYPE_LABEL[t] || t) + '</button>';
    h += '</div>';
  }
  if (withActions) {
    h += '<div class="cm-sep"></div>';
    if (mode === 'child') h += '<button class="cm-i" data-act="sibling">Adicionar irmão…</button>';
    else if (canChild) h += '<button class="cm-i" data-act="child">Adicionar filho…</button>';
    h += '<button class="cm-i" data-act="dup">Duplicar</button>';
    h += '<button class="cm-i" data-act="copy">Copiar</button>';
    h += '<button class="cm-i" data-act="paste">Colar</button>';
    h += '<div class="cm-sep"></div><button class="cm-i cm-del" data-act="del">Excluir</button>';
  }
  m.innerHTML = h; document.body.appendChild(m);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(cx, window.innerWidth - mw - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(cy, window.innerHeight - mh - 6)) + 'px';
  m.querySelectorAll('[data-add]').forEach(btn => { btn.onclick = () => { addNodeOfType(uid, btn.dataset.add, mode); closeMenu(); }; btn.addEventListener('mouseenter', (ev) => showHelpTip(ev.clientX, ev.clientY, NODE_HELP[btn.dataset.add] || '')); btn.addEventListener('mouseleave', hideHelpTip); });
  const act = (a, fn) => { const el = m.querySelector('[data-act="' + a + '"]'); if (el) el.onclick = fn; };
  act('sibling', () => openTypeMenu(uid, cx, cy, 'sibling', false));
  act('child', () => openTypeMenu(uid, cx, cy, 'child', false));
  act('dup', () => { duplicateNode(); closeMenu(); });
  act('copy', () => { copyNode(); closeMenu(); });
  act('paste', () => { pasteNode(); closeMenu(); });
  act('del', () => { del(); closeMenu(); });
}

// ---- layout automático (posiciona _x/_y) ---------------------------------
function autoLayout() {
  let leaf = 0;
  (function lay(n, depth) {
    n._depth = depth;
    const kids = childrenOf(n);
    if (!kids.length) n._lx = leaf++;
    else { kids.forEach(k => lay(k, depth + 1)); n._lx = (kids[0]._lx + kids[kids.length - 1]._lx) / 2; }
  })(tree, 0);
  (function place(n) { n._x = Math.round(n._lx * (NW + GX) + 24); n._y = n._depth * (NH + GY) + 20; childrenOf(n).forEach(place); })(tree);
}
function graphExtent() {
  let mx = 0, my = 0;
  (function w(n) { mx = Math.max(mx, n._x + NW); my = Math.max(my, n._y + NH); childrenOf(n).forEach(w); })(tree);
  return { w: mx + 40, h: my + 60 };
}

// ---- render --------------------------------------------------------------
const NODE_TYPE_LABEL = { selector: 'Seletor', sequence: 'Sequência', parallel: 'Paralelo', cooldown: 'Recarga', limiter: 'Limitador', inverter: 'Inverter', succeeder: 'Sucesso', check: 'Condição', monsterCheck: 'Monstro', condition: 'Condição', action: 'Ação' };
const NODE_HELP = {
  selector: 'Seletor (prioridade): tenta os filhos de cima para baixo e para no primeiro que dá certo. Ex.: curar → atacar → seguir.',
  sequence: 'Sequência: executa os filhos em ordem; só dá certo se TODOS derem certo, e para no primeiro que falhar. Ex.: definir alvo → atacar.',
  parallel: 'Paralelo: roda todos os filhos no mesmo tick. A política diz se precisa de todos (all) ou de qualquer um (any).',
  cooldown: 'Recarga (cooldown): deixa o filho agir e depois bloqueia por alguns ms. Ex.: invocar a cada 30s.',
  limiter: 'Limitador: deixa o filho agir no máximo N vezes.',
  inverter: 'Inverter: troca sucesso por falha (e vice-versa) do filho.',
  succeeder: 'Sucesso: sempre dá certo, qualquer que seja o resultado do filho.',
  check: 'Condição com filho: se a condição for verdadeira, executa o filho; senão, falha. Ex.: se tem comando do dono → obedecer.',
  monsterCheck: 'Checagem de monstro: executa o filho só se o alvo for o monstro/grupo escolhido. Ex.: se for chefe → Poison Mist.',
  condition: 'Condição: resulta verdadeiro ou falso; usada para decidir um ramo.',
  action: 'Ação: faz algo no jogo (atacar, usar skill, mover, curar...). É uma folha da árvore.'
};
function nodeHelp(n) { let h = NODE_HELP[n.type] || ''; const meta = registry[n.name]; if (meta && meta.desc && (LEAVES.includes(n.type) || n.type === 'check')) h += (h ? ' — ' : '') + meta.desc; return h; }
function canAddChild(n) { if (COMPOSITES.includes(n.type)) return true; if (DECORATORS.includes(n.type) || n.type === 'check' || n.type === 'monsterCheck') return !n.child; return false; }
function showHelpTip(x, y, text) {
  if (linkDrag || drag) { hideHelpTip(); return; }
  if (!text) { hideHelpTip(); return; }
  let t = document.getElementById('helptip');
  if (!t) { t = document.createElement('div'); t.id = 'helptip'; document.body.appendChild(t); }
  t.textContent = text; t.style.display = 'block';
  const w = t.offsetWidth, h = t.offsetHeight;
  let px = x + 14, py = y + 16;
  if (px + w > window.innerWidth - 6) px = x - w - 14;
  if (px < 6) px = 6;
  if (py + h > window.innerHeight - 6) py = window.innerHeight - h - 6;
  t.style.left = px + 'px'; t.style.top = py + 'px';
}
function hideHelpTip() { const t = document.getElementById('helptip'); if (t) t.style.display = 'none'; }
function nodeTypeLabel(n) { return NODE_TYPE_LABEL[n.type] || n.type; }
function nodeTypeClass(n) { const k = kindOf(n); return k === 'composite' ? 't-comp' : k === 'decorator' ? 't-dec' : k === 'check' ? 't-chk' : k === 'monstercheck' ? 't-mck' : k === 'leaf-cond' ? 't-cnd' : 't-act'; }
function skLabel(s) { return (s.name || ('#' + s.id)) + ' Lv' + ((s.level && s.level > 0) ? s.level : (s.maxLevel || '?')); }
// HTML das skills efetivas de uma ação automática (UMA por linha) + estado none/missing + overrides do nó.
function nodeSkillsHtml(n) {
  const as = actionSkillsCache && actionSkillsCache[n.name];
  const lines = [];
  if (as && as.state === 'ok') as.skills.forEach(s => lines.push('<span class="sk">' + esc(skLabel(s)) + '</span>'));
  else if (as && as.state === 'none') lines.push('<span class="sk sk-warn">\u26a0 nenhuma skill selecionada</span>');
  else if (as && as.state === 'missing') lines.push('<span class="sk sk-na">\u2014 sem skill p/ este tipo</span>');
  const sc = paramsSchema(n.name);
  const ks = Object.keys(sc).filter(k => n.params && n.params[k] != null);
  if (ks.length) lines.push('<span class="sk sk-ov">' + esc(paramStr(n, ks)) + '</span>');
  return lines.length ? lines.join('') : '<span class="sk sk-na">\u2014</span>';
}
function nodeMain(n) {
  if (n.type === 'action' && SKILL_ACTIONS[n.name] && n.params && n.params.skill) { const sk = catSkill(n.params.skill); return sk ? sk.iro : ('skill ' + n.params.skill); }
  if (n.type === 'condition' || n.type === 'check') return n.label || leafTitle(n.name) || '(condição)';
  if (LEAVES.includes(n.type)) return n.label || leafTitle(n.name) || '(sem nome)';
  if (n.type === 'monsterCheck') return (n.negate ? '\u2260 ' : '') + mcSummary(n);
  return n.label || ('(' + nodeTypeLabel(n).toLowerCase() + ')');
}
function nodeTitle(n) {
  if (n.type === 'check') return '? ' + (n.name || '(sem nome)') + ' →';
  if (n.type === 'monsterCheck') return '🎯 ' + (n.negate ? '≠ ' : '') + mcSummary(n) + ' →';
  if (LEAVES.includes(n.type)) return (n.type === 'condition' ? '? ' : '! ') + (n.name || '(sem nome)');
  return n.type + (n.label ? ' · ' + n.label : '');
}
function nodeSub(n) {
  if (n.type === 'check') {
    const sc = paramsSchema(n.name); const ks = Object.keys(sc);
    let p = n.label ? n.name : (ks.length ? paramStr(n, ks) : 'se verdadeiro → filho');
    if (n.label && ks.length) p += ' · ' + paramStr(n, ks);
    return p + (n.child ? '' : '  (sem filho)');
  }
  if (n.type === 'monsterCheck') {
    const base = n.negate ? 'se alvo NÃO casa' : 'se alvo casa';
    return base + (n.child ? '' : '  (sem filho)');
  }
  if (LEAVES.includes(n.type)) {
    // ações de skill: mostra o nome da skill (não o id) + nível e, no solo, o alvo
    if (n.type === 'action' && SKILL_ACTIONS[n.name] && n.params && n.params.skill) {
      const sk = catSkill(n.params.skill);
      let s = 'Lv' + (n.params.level || '?');
      if (n.params.on) s += n.params.on === 'owner' ? ' · no dono' : ' · no monstro';
      if (n.params.interval) s += ' · a cada ' + n.params.interval + 'ms' + (n.params.reset ? ' (reset)' : '');
      return s;
    }
    // #5: ações automáticas mostram as skills efetivas do homún (nome+nível) + overrides explícitos
    if (n.type === 'action' && ACTION_ROLE[n.name]) {
      const skills = roleSkillsLabel(n.name);
      const scA = paramsSchema(n.name);
      const ksA = Object.keys(scA).filter(k => n.params && n.params[k] != null);   // só overrides definidos
      const ov = ksA.length ? paramStr(n, ksA) : '';
      return [skills, ov].filter(Boolean).join('  ·  ');
    }
    const sc = paramsSchema(n.name);
    // só mostra knobs DEFINIDOS (override) ou obrigatórios; opcionais herdados não poluem o rótulo (#4)
    const ks = Object.keys(sc).filter(k => (n.params && n.params[k] != null) || !paramsOptional(n.name).includes(k));
    let p = n.label ? n.name : '';
    if (ks.length) p += (p ? ' · ' : '') + paramStr(n, ks);
    return p || (registry[n.name] ? '' : '⚠ desconhecido');
  }
  if (n.type === 'cooldown') return n.ms + 'ms';
  if (n.type === 'limiter') return 'máx ' + n.max;
  if (n.type === 'parallel') return n.policy;
  const kc = childrenOf(n).length; return kc + (kc === 1 ? ' filho' : ' filhos');
}
function nodeClass(n) {
  const k = kindOf(n);
  let valid = true;
  if (LEAVES.includes(n.type)) valid = registry[n.name] && registry[n.name].kind === n.type;
  if (DECORATORS.includes(n.type)) valid = !!n.child;
  if (n.type === 'check') valid = !!(registry[n.name] && registry[n.name].kind === 'condition');
  if (n.type === 'monsterCheck') valid = !!n.child && !!((n.monster && n.monster !== 0) || (n.group && n.group !== 0));
  const base = k === 'composite' ? 'g-composite' : k === 'decorator' ? 'g-decorator' : k === 'check' ? 'g-check' : k === 'monstercheck' ? 'g-mcheck' : k === 'leaf-cond' ? 'g-cond' : 'g-act';
  return base + (valid ? '' : ' g-bad');
}
// ponto de origem do vínculo na BASE do nó pai (distribuído por ordem dos filhos)
function childOrigin(parent, idx, count) {
  const frac = count <= 1 ? 0.5 : (idx + 1) / (count + 1);
  return { x: parent._x + NW * frac, y: parent._y + NH };
}
function edgePath(x1, y1, x2, y2, cls) {
  return '<path class="' + cls + '" d="M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + GY / 2) + ' ' + x2 + ',' + (y2 - GY / 2) + ' ' + x2 + ',' + y2 + '"/>';
}
// cor do ponto = cor do nó filho ao qual ele pertence
function linkColor(n) {
  const k = kindOf(n);
  return k === 'composite' ? '#3b6fb0' : k === 'decorator' ? '#a07820' : k === 'check' ? '#8957e5'
    : k === 'monstercheck' ? '#c9518a' : k === 'leaf-cond' ? '#3a82c4' : '#2ea043';
}
function drawEdges() {
  const paths = [];
  const dragChild = linkDrag ? linkDrag.child : null;
  (function w(n) {
    const kids = childrenOf(n);
    kids.forEach((c, i) => {
      if (c !== dragChild) {                      // o vínculo arrastado vira fantasma
        const o = childOrigin(n, i, kids.length);
        paths.push(edgePath(o.x, o.y, c._x + NW / 2, c._y, 'n-edge'));
      }
      w(c);
    });
  })(tree);
  // aresta viva: do ponto-fantasma (alvo válido) ou do cursor até o filho arrastado
  if (linkDrag && linkDrag.cur && linkDrag.child) {
    const ch = linkDrag.child;
    const fx = linkDrag.ghost ? linkDrag.ghost.x : linkDrag.cur.x;
    const fy = linkDrag.ghost ? linkDrag.ghost.y : linkDrag.cur.y;
    const cls = 'n-edge live-edge ' + (linkDrag.ghost ? 'valid' : (linkDrag.invalid != null ? 'invalid' : ''));
    paths.push(edgePath(fx, fy, ch._x + NW / 2, ch._y, cls));
  }
  const ext = graphExtent();
  const svg = $('edges');
  svg.setAttribute('width', ext.w); svg.setAttribute('height', ext.h);
  svg.innerHTML = paths.join('');
  const gv = $('gview');
  gv.style.width = ext.w + 'px'; gv.style.height = ext.h + 'px';
  gv.style.transform = 'scale(' + zoom + ')';
  $('graph').style.width = Math.round(ext.w * zoom) + 'px';
  $('graph').style.height = Math.round(ext.h * zoom) + 'px';
  const zl = $('zoomlbl'); if (zl) zl.textContent = Math.round(zoom * 100) + '%';
}
function renderGraph() {
  const parts = [];
  (function w(n) {
    parts.push('<div class="gnode ' + nodeClass(n) + (n.disabled ? ' gdisabled' : '') + (n._uid === selId ? ' sel' : '') + '" data-uid="' + n._uid +
      '" style="left:' + n._x + 'px;top:' + n._y + 'px">' +
      '<span class="type ' + nodeTypeClass(n) + '">' + esc(nodeTypeLabel(n)) + '</span>' +
      '<span class="t" title="' + esc((n.name ? n.name + (registry[n.name] && registry[n.name].desc ? ' — ' + registry[n.name].desc : '') : '')) + '">' + esc(nodeMain(n)) + '</span>' +
      (n.type === 'action' && (ACTION_ROLE[n.name] || PARAM_EXTRA[n.name]) ? '<span class="s s-skills">' + nodeSkillsHtml(n) + '</span>' : '<span class="s">' + esc(nodeSub(n)) + '</span>') + (canAddChild(n) ? '<span class="addbtn" title="Adicionar filho">+</span>' : '') + '</div>');
    // pontos de ligação na BASE do pai — um por filho (na ordem): arrastar = reordenar/reparentar
    const kids = childrenOf(n);
    kids.forEach((c, i) => {
      const o = childOrigin(n, i, kids.length);
      parts.push('<div class="linkh" data-uid="' + c._uid + '" title="Arraste para reordenar ou reparentar" ' +
        'style="left:' + o.x + 'px;top:' + o.y + 'px;border-color:' + linkColor(c) + '"></div>');
    });
    kids.forEach(w);
  })(tree);
  $('nodes').innerHTML = parts.join('');
  nodeEls = {};
  $('nodes').querySelectorAll('.gnode').forEach(el => {
    const uid = parseInt(el.dataset.uid, 10);
    nodeEls[uid] = el;
    el.addEventListener('mousedown', (ev) => startDrag(ev, uid));
    el.addEventListener('mouseenter', (ev) => { const n = find(tree, uid); if (n) showHelpTip(ev.clientX, ev.clientY, nodeHelp(n)); });
    el.addEventListener('mouseleave', hideHelpTip);
    el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openTypeMenu(uid, ev.clientX, ev.clientY, 'child', true); });
    const ab = el.querySelector('.addbtn');
    if (ab) { ab.addEventListener('mousedown', (e) => e.stopPropagation());
      ab.addEventListener('click', (e) => { e.stopPropagation(); const r = ab.getBoundingClientRect(); openTypeMenu(uid, r.right, r.bottom, 'child', false); }); }
  });
  $('nodes').querySelectorAll('.linkh').forEach(el => {
    const uid = parseInt(el.dataset.uid, 10);
    el.addEventListener('mousedown', (ev) => startLinkDrag(ev, uid));
    el.addEventListener('mouseenter', () => { const ce = nodeEls[uid]; if (ce && !linkDrag) ce.classList.add('owns'); });
    el.addEventListener('mouseleave', () => { const ce = nodeEls[uid]; if (ce) ce.classList.remove('owns'); });
  });
  drawEdges();
}
function renderAll() { renderGraph(); renderValidation(); }

// ---- arrastar + reparentar ----------------------------------------------
let drag = null;
function subtreeUids(node) { const out = []; (function w(n) { out.push(n._uid); childrenOf(n).forEach(w); })(node); return out; }
function startDrag(ev, uid) {
  ev.preventDefault(); hideHelpTip();
  const node = find(tree, uid);
  drag = { node, uids: subtreeUids(node), sx: ev.clientX, sy: ev.clientY, moved: false, origin: {} };
  drag.uids.forEach(u => { const n = find(tree, u); drag.origin[u] = { x: n._x, y: n._y }; });
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
}
function onDrag(ev) {
  if (!drag) return;
  const dx = (ev.clientX - drag.sx) / zoom, dy = (ev.clientY - drag.sy) / zoom;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
  drag.uids.forEach(u => {
    const n = find(tree, u);
    n._x = drag.origin[u].x + dx; n._y = drag.origin[u].y + dy;
    const el = nodeEls[u]; if (el) { el.style.left = n._x + 'px'; el.style.top = n._y + 'px'; el.style.pointerEvents = 'none'; }
  });
  drawEdges();
  // alvo de drop sob o cursor
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const targetEl = under && under.closest ? under.closest('.gnode') : null;
  clearDropHighlight();
  if (targetEl) {
    const tUid = parseInt(targetEl.dataset.uid, 10);
    if (!drag.uids.includes(tUid)) {
      const c = canAccept(find(tree, tUid), drag.node);
      targetEl.classList.add(c.ok ? 'drop-ok' : 'drop-bad');
      drag.dropTarget = c.ok ? tUid : null;
    } else drag.dropTarget = null;
  } else drag.dropTarget = null;
}
function clearDropHighlight() { $('nodes').querySelectorAll('.drop-ok,.drop-bad,.reparent-ok').forEach(e => e.classList.remove('drop-ok', 'drop-bad', 'reparent-ok')); }
function endDrag(ev) {
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
  if (!drag) return;
  drag.uids.forEach(u => { const el = nodeEls[u]; if (el) el.style.pointerEvents = ''; });
  clearDropHighlight();
  if (!drag.moved) {                       // clique = selecionar
    selId = drag.node._uid; renderInspector(); renderGraph();
  } else if (drag.dropTarget != null) {    // soltou sobre alvo válido = reparentar
    if (reparent(drag.node, find(tree, drag.dropTarget))) { selId = drag.node._uid; autoLayout(); renderInspector(); renderAll(); histRecord(); }
    else renderAll();
  } else {
    renderValidation(); histRecordSoon(); // só reposicionou
  }
  drag = null;
}

// ---- manipular vínculos (reparentar / reordenar pelo ponto de ligação) ---
let linkDrag = null;
function toGraph(ev) {
  const wrap = $('graphwrap'), r = wrap.getBoundingClientRect();
  return { x: (wrap.scrollLeft + ev.clientX - r.left) / zoom, y: (wrap.scrollTop + ev.clientY - r.top) / zoom };
}
// índice de inserção decidido pela posição x do cursor em relação aos PONTOS de
// ligação na base do pai (não pelos nós-filhos lá embaixo). Assim, arrastar um
// pouco para a esquerda/direita na base do pai já reordena. Ignora o nó arrastado.
function insertIndex(parent, gx, exclude) {
  const all = parent.children || [];
  const pts = [];
  all.forEach((c, i) => { if (c !== exclude) pts.push({ c, x: childOrigin(parent, i, all.length).x }); });
  let idx = 0;
  for (const p of pts) { if (gx >= p.x) idx++; else break; }
  return { idx, kids: pts.map(p => p.c) };
}
// resolve onde o vínculo arrastado seria solto (alvo + índice), e o marcador visual
function resolveLinkDrop(ev) {
  const g = toGraph(ev);
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const el = under && under.closest ? under.closest('.gnode') : null;
  const sub = linkDrag.uids;
  let target = null;
  const child = linkDrag.child;
  linkDrag.invalid = null;
  if (el) {
    const tUid = parseInt(el.dataset.uid, 10);
    if (!sub.includes(tUid)) {
      const tNode = find(tree, tUid);
      if (COMPOSITES.includes(tNode.type)) {
        target = { parent: tNode, index: insertIndex(tNode, g.x, child).idx, composite: true };
      } else if (DECORATORS.includes(tNode.type) || tNode.type === 'check' || tNode.type === 'monsterCheck') {
        if (!tNode.child || tNode.child === child) target = { parent: tNode, single: true };
        else linkDrag.invalid = tUid;
      } else {
        linkDrag.invalid = tUid;   // folha: não pode receber filho
      }
    }
  } else if (COMPOSITES.includes(linkDrag.parent.type)) {
    target = { parent: linkDrag.parent, index: insertIndex(linkDrag.parent, g.x, child).idx, composite: true };
  }
  linkDrag.cur = g; linkDrag.target = target;
}
// reposiciona os pontos do pai abrindo um espaço no índice idx; devolve a posição do ponto-fantasma
function previewDots(parent, idx, draggedUid) {
  const kids = (parent.children || []).filter(function (c) { return c._uid !== draggedUid; });
  const m = kids.length;
  kids.forEach(function (c, j) {
    const slot = j < idx ? j : j + 1;
    const o = childOrigin(parent, slot, m + 1);
    const e = linkDrag.els[c._uid]; if (e) { e.style.left = o.x + 'px'; e.style.top = o.y + 'px'; e.style.display = ''; }
  });
  const g = childOrigin(parent, idx, m + 1);
  return { x: g.x, y: g.y };
}
// fecha o espaço do pai original (quando o ponto é arrastado p/ fora, mostrando "saindo")
function closeGap(parent, draggedUid) {
  const kids = (parent.children || []).filter(function (c) { return c._uid !== draggedUid; });
  const m = kids.length;
  kids.forEach(function (c, j) {
    const o = childOrigin(parent, j, m);
    const e = linkDrag.els[c._uid]; if (e) { e.style.left = o.x + 'px'; e.style.top = o.y + 'px'; }
  });
}
function mkPreviewDot(cls, color) {
  const d = document.createElement('div');
  d.className = 'linkh-preview ' + cls;
  if (color) d.style.color = color;
  return d;
}
function startLinkDrag(ev, uid) {
  ev.preventDefault(); ev.stopPropagation(); hideHelpTip();
  const child = find(tree, uid);
  const parent = findParent(tree, uid, null);
  if (!parent) return;
  linkDrag = { child, parent, uids: subtreeUids(child), cur: toGraph(ev), target: null, els: {}, home: {}, ghost: null, invalid: null };
  $('nodes').querySelectorAll('.linkh').forEach(function (e) {
    e.style.pointerEvents = 'none';
    const u = parseInt(e.dataset.uid, 10); linkDrag.els[u] = e; linkDrag.home[u] = { left: e.style.left, top: e.style.top };
  });
  if (linkDrag.els[uid]) linkDrag.els[uid].style.display = 'none';
  linkDrag.dragDot = mkPreviewDot('drag-dot', linkColor(child));
  linkDrag.ghostDot = mkPreviewDot('ghost-dot', null); linkDrag.ghostDot.style.display = 'none';
  $('nodes').appendChild(linkDrag.dragDot); $('nodes').appendChild(linkDrag.ghostDot);
  document.addEventListener('mousemove', onLinkDrag);
  document.addEventListener('mouseup', endLinkDrag);
  drawEdges();
}
function onLinkDrag(ev) {
  if (!linkDrag) return;
  resolveLinkDrop(ev);
  clearDropHighlight();
  const dUid = linkDrag.child._uid;
  // restaura todos os pontos e aplica o preview do alvo atual
  Object.keys(linkDrag.home).forEach(function (u) { const e = linkDrag.els[u], h = linkDrag.home[u]; if (e) { e.style.left = h.left; e.style.top = h.top; } });
  if (linkDrag.els[dUid]) linkDrag.els[dUid].style.display = 'none';
  if (linkDrag.dragDot) { linkDrag.dragDot.style.left = linkDrag.cur.x + 'px'; linkDrag.dragDot.style.top = linkDrag.cur.y + 'px'; }
  linkDrag.ghost = null;
  const t = linkDrag.target;
  if (t && t.composite) {
    linkDrag.ghost = previewDots(t.parent, t.index, dUid);
    if (t.parent._uid !== linkDrag.parent._uid) { const el = nodeEls[t.parent._uid]; if (el) el.classList.add('reparent-ok'); }
  } else if (t && t.single) {
    const el = nodeEls[t.parent._uid]; if (el) el.classList.add('reparent-ok');
    const o = childOrigin(t.parent, 0, 1); linkDrag.ghost = { x: o.x, y: o.y };
  } else {
    if (COMPOSITES.includes(linkDrag.parent.type)) closeGap(linkDrag.parent, dUid);
    if (linkDrag.invalid != null) { const el = nodeEls[linkDrag.invalid]; if (el) el.classList.add('drop-bad'); }
  }
  if (linkDrag.ghostDot) {
    if (linkDrag.ghost) { linkDrag.ghostDot.style.display = ''; linkDrag.ghostDot.style.left = linkDrag.ghost.x + 'px'; linkDrag.ghostDot.style.top = linkDrag.ghost.y + 'px'; }
    else linkDrag.ghostDot.style.display = 'none';
  }
  drawEdges();
}
function endLinkDrag(ev) {
  document.removeEventListener('mousemove', onLinkDrag);
  document.removeEventListener('mouseup', endLinkDrag);
  const ld = linkDrag; linkDrag = null;
  if (!ld) return;
  if (ld.target) {
    const { parent, index, single } = ld.target;
    removeFromParent(ld.child);
    if (single) parent.child = ld.child;
    else parent.children.splice(index, 0, ld.child);
    selId = ld.child._uid;
    autoLayout(); renderInspector(); renderAll(); histRecord();
    setStatus('');
  } else {
    renderAll();   // cancelado: redesenha sem fantasma
  }
}

// #4: valor EFETIVO de um knob de config global (treeConfig override > defaultConfig) p/ a dica de herança
function effectiveGlobal(f) {
  if (treeConfig && treeConfig[f] != null) return treeConfig[f];
  if (cfgDefaults && cfgDefaults[f] != null) return cfgDefaults[f];
  return undefined;
}
function fmtCfg(v) { return v === true ? 'sim' : v === false ? 'não' : String(v); }
function cfgHint(f) { const gv = effectiveGlobal(f); return (gv !== undefined) ? ' · global: ' + fmtCfg(gv) : ''; }
// monta o campo de um parâmetro; se for 'skill', usa um seletor de skill (por nome)
function paramFieldHtml(f, type, sel) {
  if (f === 'skill') {
    let opts = '<option value="">— skill —</option>';
    for (const sk of catalog.slice().sort((a, b) => a.iro.localeCompare(b.iro)))
      opts += '<option value="' + sk.id + '"' + (sel.params && sk.id === sel.params.skill ? ' selected' : '') + '>' + esc(sk.iro) + '</option>';
    return field(pLabel('skill'), '<select class="iParamSkill" data-f="skill">' + opts + '</select>', pHelp('skill'));
  }
  if (f === 'by') {
    // prioridade de alvo (AcquireTarget / ReacquireIfBetter)
    const cur = (sel.params && sel.params.by) || 'nearest';
    const o = [['nearest', 'Mais próximo'], ['lowestHp', 'Menor HP'], ['ownerAttacker', 'Atacante do dono']];
    return field(pLabel('by'), '<select class="iParam" data-f="by">' +
      o.map(x => '<option value="' + x[0] + '"' + (x[0] === cur ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>');
  }
  if (f === 'combo' || f === 'style') {
    // Homunculus S (Eleanor): combo / estilo
    const cur = (sel.params && sel.params[f]) || 'power';
    const o = f === 'combo'
      ? [['power', 'Power (Sonic Claw)'], ['grapple', 'Grapple (Tinder Breaker)']]
      : [['power', 'Power (Combate)'], ['grapple', 'Grapple (Agarrão)']];
    return field(f === 'combo' ? pLabel('combo') : pLabel('style'), '<select class="iParam" data-f="' + f + '">' +
      o.map(x => '<option value="' + x[0] + '"' + (x[0] === cur ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>');
  }
  // #4: booleano TRI-ESTADO (herdar | sim | não) — ausente = herda a Config global
  if (type === 'boolean') {
    const curB = (sel.params && sel.params[f] != null) ? (sel.params[f] ? 'true' : 'false') : '';
    const gvB = effectiveGlobal(f);
    const o = [['', 'herdar' + (gvB !== undefined ? ' (' + fmtCfg(gvB) + ')' : '')], ['true', 'sim'], ['false', 'não']];
    const selB = '<select class="iParamBool" data-f="' + f + '">' +
      o.map(x => '<option value="' + x[0] + '"' + (x[0] === curB ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select>';
    const optB = paramsOptional(sel.name).includes(f);
    return field(pLabel(f) + (optB ? ' — opcional' : ''), selB, pHelp(f));
  }
  const v = (sel.params && sel.params[f] != null) ? sel.params[f] : '';
  const gv = effectiveGlobal(f);
  const ph = (gv !== undefined) ? ' placeholder="' + esc(String(gv)) + '"' : '';
  const inp = type === 'number'
    ? '<input class="iParam" data-f="' + f + '" type="number" value="' + v + '"' + ph + ' />'
    : '<input class="iParam" data-f="' + f + '" type="text" value="' + esc(v) + '"' + ph + ' />';
  const opt = paramsOptional(sel.name).includes(f);
  return field(pLabel(f) + (opt ? ' — opcional' : '') + cfgHint(f), inp, pHelp(f));
}
// resumo dos params p/ o rótulo do nó (skill aparece pelo nome)
function paramStr(n, ks) {
  return ks.map(k => {
    if (k === 'skill' && n.params && n.params[k]) { const sk = catSkill(n.params[k]); return sk ? sk.iro : ('skill ' + n.params[k]); }
    return k + '=' + (n.params && n.params[k] != null ? n.params[k] : '?');
  }).join(' ');
}

// ---- inspetor ------------------------------------------------------------
function field(l, html, title) { return '<div class="field"><label' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(l) + '</label>' + html + '</div>'; }
function renderInspector() {
  const sel = selected();
  if (!sel) { $('inspector').innerHTML = '<span class="desc">Selecione um nó no grafo.</span>'; return; }
  let typeOpts = '';
  for (const g of _TYPE_GROUPS) {
    let gtypes = g.types;
    if (g.label === 'Condicional' && sel.type === 'condition') gtypes = ['condition'].concat(g.types); // legado: condição-folha existente
    typeOpts += '<optgroup label="' + g.label + '">';
    for (const k of gtypes) {
      const lbl = (k === 'condition') ? 'Condição (folha)' : (NODE_TYPE_LABEL[k] || k);
      typeOpts += '<option value="' + k + '"' + (k === sel.type ? ' selected' : '') + ' title="' + esc(NODE_HELP[k] || '') + '">' + lbl + '</option>';
    }
    typeOpts += '</optgroup>';
  }
  let html = field('Tipo do nó', '<select id="iType">' + typeOpts + '</select>');
  if (NODE_HELP[sel.type]) html += '<div class="desc">' + esc(NODE_HELP[sel.type]) + '</div>';
  if (!LEAVES.includes(sel.type)) html += field('Rótulo (opcional)', '<input id="iLabel" type="text" value="' + esc(sel.label || '') + '" />');
  if (sel.type === 'parallel') html += field('Política', '<select id="iPolicy"><option' + (sel.policy === 'all' ? ' selected' : '') + '>all</option><option' + (sel.policy === 'any' ? ' selected' : '') + '>any</option></select>');
  if (sel.type === 'cooldown') html += field('Cooldown (ms)', '<input id="iMs" type="number" min="1" value="' + sel.ms + '" />');
  if (sel.type === 'limiter') { html += field('Máximo de usos', '<input id="iMax" type="number" min="1" value="' + sel.max + '" />'); html += field('Chave (opcional)', '<input id="iKey" type="text" value="' + esc(sel.key || '') + '" />'); }
  if (sel.type === 'check') {
    html += field('Condição', '<select id="iCheckName">' + leafOptionsHtml('condition', sel.name) + '</select>');
    const cm = registry[sel.name];
    if (cm && cm.desc) html += '<div class="desc">' + esc(cm.desc) + '</div>';
    const sc = paramsSchema(sel.name);
    for (const f of Object.keys(sc)) html += paramFieldHtml(f, sc[f], sel);
  }
  if (sel.type === 'monsterCheck') {
    const monOpts = '<option value="0">— nenhum —</option>' + monCatalog.monsters.slice().sort((a,b)=>String(a.desc||a.id).localeCompare(String(b.desc||b.id))).map(m => '<option value="' + m.id + '"' + (m.id === sel.monster ? ' selected' : '') + '>' + esc((m.desc || ('#' + m.id))) + ' (#' + m.id + ')</option>').join('');
    const grpOpts = '<option value="0">— nenhum —</option>' + monCatalog.groups.map(g => '<option value="' + g.id + '"' + (g.id === sel.group ? ' selected' : '') + '>' + esc(g.name || ('grupo ' + g.id)) + '</option>').join('');
    html += field('Monstro alvo', '<select id="iMon">' + monOpts + '</select>');
    html += field('Grupo', '<select id="iGrp">' + grpOpts + '</select>');
    html += '<div class="field"><label><input id="iNeg" type="checkbox"' + (sel.negate ? ' checked' : '') + '> negar (executa quando NÃO casa)</label></div>';
    html += '<div class="desc">Executa o filho quando o monstro alvo ' + (sel.negate ? '<b>não</b> for o monstro <b>e não</b> estiver no grupo' : 'for o monstro <b>ou</b> estiver no grupo') + '. Sem alvo atual, falha.</div>';
    html += '<div class="field"><button id="iMonMgr" type="button">⚙ gerenciar monstros/grupos</button></div>';
  }
  if (LEAVES.includes(sel.type)) {
    html += field(sel.type === 'condition' ? 'Condição' : 'Ação', '<select id="iName">' + leafOptionsHtml(sel.type, sel.name) + '</select>');
    const meta = registry[sel.name];
    if (meta && meta.desc) html += '<div class="desc">' + esc(meta.desc) + '</div>';
    if (sel.type === 'action' && SKILL_ACTIONS[sel.name]) {
      sel.params = sel.params || {};
      html += skillPickerHtml(sel);
    } else if (sel.type === 'action' && sel.name === 'UseEleanorOffense') {
      sel.params = sel.params || {};
      html += eleanorInspectorHtml(sel);
    } else if (sel.type === 'action' && ACTION_ROLE[sel.name]) {
      sel.params = sel.params || {};
      const skills = roleSkillsLabel(sel.name);
      html += '<div class="field"><label>Skill usada (padrão por homúnculo)</label><div class="desc">' +
        (skills ? esc(skills) : '— este homúnculo não tem skill para este papel —') + '</div></div>';
      html += '<div class="field insp-links">' +
        '<button id="iSkillCfg" type="button">\u2699 Configurar skills\u2026</button>' +
        '<button id="iParamCfg" type="button">\u2699 Par\u00e2metros desta skill\u2026</button></div>';
      // override por nó (#4) RECOLHIDO — em geral, ajuste em "Parâmetros" (global). [C6]
      const sc = paramsSchema(sel.name);
      const hasOv = Object.keys(sc).some(f => sel.params[f] != null);
      const knobsHtml = Object.keys(sc).map(f => paramFieldHtml(f, sc[f], sel)).join('');
      html += '<details class="insp-adv"' + (hasOv ? ' open' : '') + '>' +
        '<summary>\u2699 Avan\u00e7ado: sobrescrever s\u00f3 neste n\u00f3</summary>' +
        '<div class="desc">Em geral, ajuste em <b>Par\u00e2metros</b> (global). Aqui voc\u00ea for\u00e7a um valor s\u00f3 para ESTE n\u00f3 (vence o resto).</div>' +
        knobsHtml + '</details>';
    } else if (sel.type === 'action' && PARAM_EXTRA[sel.name]) {
      sel.params = sel.params || {};
      html += '<div class="field"><button id="iParamCfg" type="button">\u2699 Par\u00e2metros desta skill\u2026</button></div>';
    } else {
      const sc = paramsSchema(sel.name);
      for (const f of Object.keys(sc)) html += paramFieldHtml(f, sc[f], sel);
    }
  }
  html = '<div class="field"><button id="iToggleDisabled" type="button" class="' + (sel.disabled ? 'disabled-on' : '') + '">' + (sel.disabled ? '\u25b6 Ativar (n\u00f3 + filhos)' : '\u23f8 Desativar (n\u00f3 + filhos)') + '</button>' + (sel.disabled ? '<div class="desc">N\u00f3 desativado: n\u00e3o executa, fica cinza e some do Lua ao "Gerar Lua".</div>' : '') + '</div>' + html;
  $('inspector').innerHTML = html;
  wireInspector(sel);
  { const _td = $('iToggleDisabled'); if (_td) _td.onclick = toggleDisabled; }
}
function addSelectFilter(sel, ph) {
  if (!sel || sel.dataset.filt) return;
  if (sel.querySelectorAll('option').length <= 8) return;
  sel.dataset.filt = '1';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'selfilter'; inp.placeholder = ph || 'filtrar…';
  sel.parentNode.insertBefore(inp, sel);
  inp.addEventListener('input', function (e) {
    e.stopPropagation();
    const q = inp.value.trim().toLowerCase();
    sel.querySelectorAll('option').forEach(function (o) { if (o.value === '') return; var hay = (o.textContent + ' ' + (o.title || '')).toLowerCase(); o.hidden = !!q && hay.indexOf(q) < 0; });
    sel.querySelectorAll('optgroup').forEach(function (g) { g.hidden = ![].slice.call(g.children).some(function (o) { return !o.hidden; }); });
  });
}
function wireInspector(sel) {
  addSelectFilter($('iSkill'), 'filtrar skill…'); addSelectFilter($('iName'), 'filtrar…'); addSelectFilter($('iCheckName'), 'filtrar condição…');
  const t = $('iType'); if (t) t.onchange = () => changeType(sel, t.value);
  const lb = $('iLabel'); if (lb) lb.oninput = () => { sel.label = lb.value || undefined; renderGraph(); };
  const pol = $('iPolicy'); if (pol) pol.onchange = () => { sel.policy = pol.value; renderAll(); };
  const ms = $('iMs'); if (ms) ms.oninput = () => { sel.ms = parseInt(ms.value, 10) || 0; renderAll(); };
  const mx = $('iMax'); if (mx) mx.oninput = () => { sel.max = parseInt(mx.value, 10) || 0; renderAll(); };
  const ky = $('iKey'); if (ky) ky.oninput = () => { sel.key = ky.value || undefined; };
  const nm = $('iName'); if (nm) nm.onchange = () => { sel.name = nm.value; sel.params = {}; renderInspector(); renderAll(); };
  const ckn = $('iCheckName'); if (ckn) ckn.onchange = () => { sel.name = ckn.value; sel.params = {}; renderInspector(); renderAll(); };
  const im = $('iMon'); if (im) im.onchange = () => { sel.monster = parseInt(im.value, 10) || 0; renderInspector(); renderAll(); };
  const ig = $('iGrp'); if (ig) ig.onchange = () => { sel.group = parseInt(ig.value, 10) || 0; renderInspector(); renderAll(); };
  const ing = $('iNeg'); if (ing) ing.onchange = () => { sel.negate = ing.checked; renderInspector(); renderAll(); };
  const imgr = $('iMonMgr'); if (imgr) imgr.onclick = () => openMonsterManager();
  const isk = $('iSkill'); if (isk) isk.onchange = () => { const id = parseInt(isk.value, 10) || 0; const sk = catSkill(id); sel.params = { skill: id, level: sk ? sk.maxLevel : 1 }; if (sk && sk.target === 'ground') sel.params.on = sel.params.on || 'enemy'; renderInspector(); renderAll(); };
  const ilv = $('iLevel'); if (ilv) ilv.onchange = () => { sel.params.level = parseInt(ilv.value, 10) || 1; renderInspector(); renderAll(); };
  const ion = $('iOn'); if (ion) ion.onchange = () => { sel.params.on = ion.value; renderAll(); };
  const iiv = $('iInterval'); if (iiv) iiv.onchange = () => {
    const sk2 = catSkill(sel.params.skill); const lvl = sel.params.level || (sk2 ? sk2.maxLevel : 1);
    const minMs = sk2 ? (arrAt(sk2.delay, lvl) || 0) + (arrAt(sk2.reuse, lvl) || 0) : 0;
    let v = parseInt(iiv.value, 10) || 0;
    if (v > 0 && v < minMs) v = minMs;                       // não permite abaixo de pós+recarga
    if (v > 0) sel.params.interval = v; else delete sel.params.interval;
    renderInspector(); renderAll();
  };
  const irs = $('iReset'); if (irs) irs.onchange = () => { if (irs.checked) sel.params.reset = true; else delete sel.params.reset; renderAll(); };
  const ep = $('iEleanorPanel'); if (ep) ep.onclick = () => openComboManager();
  const isc = $('iSkillCfg'); if (isc) isc.onclick = () => openSkillManager();
  const ipc = $('iParamCfg'); if (ipc) ipc.onclick = () => openSkillParams(ACTION_ROLE[sel.name] || PARAM_EXTRA[sel.name]);
  document.querySelectorAll('.iParamSkill').forEach(sk => {
    sk.onchange = () => { const id = parseInt(sk.value, 10); sel.params = sel.params || {}; if (id) sel.params.skill = id; else delete sel.params.skill; renderAll(); };
  });
  document.querySelectorAll('.iParam').forEach(inp => {
    inp.oninput = () => {
      const f = inp.dataset.f; const sc = paramsSchema(sel.name); sel.params = sel.params || {};
      if (sc[f] === 'number') {
        const raw = String(inp.value).trim();
        if (raw === '') { delete sel.params[f]; }          // vazio = parâmetro não informado (não grava NaN)
        else { const n = parseFloat(raw); if (Number.isNaN(n)) delete sel.params[f]; else sel.params[f] = n; }
      } else { sel.params[f] = inp.value; }
      renderAll();
    };
  });
  document.querySelectorAll('.iParamBool').forEach(selb => {
    selb.onchange = () => {
      const f = selb.dataset.f; sel.params = sel.params || {};
      if (selb.value === '') delete sel.params[f];          // herdar (ausente) — #4 tri-estado
      else sel.params[f] = (selb.value === 'true');
      renderAll();
    };
  });
}
function changeType(sel, newType) {
  const keepLabel = sel.label, uid = sel._uid, x = sel._x, y = sel._y;
  for (const k of Object.keys(sel)) delete sel[k];
  Object.assign(sel, newNode(newType));
  sel._uid = uid; sel._x = x; sel._y = y;
  if (!LEAVES.includes(newType) && keepLabel) sel.label = keepLabel;
  childrenOf(sel).forEach(assignUids);
  autoLayout(); renderInspector(); renderAll(); histRecord();
}

// ---- validação -----------------------------------------------------------
function validate() {
  const issues = [];
  (function w(n, path) {
    const where = path || n.type;
    const kids = childrenOf(n);
    if (COMPOSITES.includes(n.type)) { if (!kids.length) issues.push({ lvl: 'warn', msg: where + ': composite sem filhos', uid: n._uid }); }
    else if (DECORATORS.includes(n.type)) {
      if (!n.child) issues.push({ lvl: 'err', msg: where + ': decorator sem filho', uid: n._uid });
      if (n.type === 'cooldown' && !(n.ms > 0)) issues.push({ lvl: 'err', msg: where + ': ms deve ser > 0', uid: n._uid });
      if (n.type === 'limiter' && !(Number.isInteger(n.max) && n.max >= 1)) issues.push({ lvl: 'err', msg: where + ': max inteiro >= 1', uid: n._uid });
    } else if (n.type === 'check') {
      const meta = registry[n.name];
      if (!n.name) issues.push({ lvl: 'err', msg: where + ': check sem condição', uid: n._uid });
      else if (!meta || meta.kind !== 'condition') issues.push({ lvl: 'err', msg: where + ": '" + n.name + "' não é condição", uid: n._uid });
      else { const sc = paramsSchema(n.name), opt = paramsOptional(n.name); for (const f of Object.keys(sc)) { const v = n.params ? n.params[f] : undefined; if (sc[f] === 'number' && typeof v !== 'number' && !opt.includes(f)) issues.push({ lvl: 'warn', msg: where + ": param '" + f + "' ausente", uid: n._uid }); } }
      if (!n.child) issues.push({ lvl: 'warn', msg: where + ': check sem filho (age como condição)', uid: n._uid });
    } else if (n.type === 'monsterCheck') {
      if (!((n.monster && n.monster !== 0) || (n.group && n.group !== 0))) issues.push({ lvl: 'warn', msg: where + ': selecione um monstro ou grupo', uid: n._uid });
      if (!n.child) issues.push({ lvl: 'warn', msg: where + ': monsterCheck sem filho', uid: n._uid });
    } else if (LEAVES.includes(n.type)) {
      const meta = registry[n.name];
      if (!n.name) issues.push({ lvl: 'err', msg: where + ': folha sem nome', uid: n._uid });
      else if (!meta) issues.push({ lvl: 'err', msg: where + ": '" + n.name + "' não existe no registry", uid: n._uid });
      else if (meta.kind !== n.type) issues.push({ lvl: 'err', msg: where + ": '" + n.name + "' é " + meta.kind, uid: n._uid });
      else { const sc = paramsSchema(n.name), opt = paramsOptional(n.name); for (const f of Object.keys(sc)) { const v = n.params ? n.params[f] : undefined; if (sc[f] === 'number' && typeof v !== 'number' && !opt.includes(f)) issues.push({ lvl: 'warn', msg: where + ": param '" + f + "' ausente", uid: n._uid }); } }
    }
    kids.forEach(c => w(c, where + ' › ' + (LEAVES.includes(c.type) ? (c.name || c.type) : c.type)));
  })(tree, null);
  return issues;
}
function focusNode(uid) {
  if (uid == null || !find(tree, uid)) return;
  selId = uid; renderInspector(); renderGraph();
  const el = nodeEls[uid]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
}
function renderValidation() {
  const issues = validate();
  const errs = issues.filter(i => i.lvl === 'err').length;
  $('validation').innerHTML = issues.length === 0 ? '<div class="v-ok">✓ Árvore válida.</div>'
    : issues.map(i => '<div class="v-issue v-' + (i.lvl === 'err' ? 'err' : 'warn') + '"' + (i.uid != null ? ' data-uid="' + i.uid + '"' : '') + ' title="ir para o nó">' + (i.lvl === 'err' ? '✗' : '⚠') + ' ' + esc(i.msg) + '</div>').join('');
  $('validation').querySelectorAll('.v-issue[data-uid]').forEach(el => el.onclick = () => focusNode(parseInt(el.dataset.uid, 10)));
  const badge = $('valid'); badge.textContent = errs ? errs + ' erro(s)' : 'válida'; badge.className = 'valid ' + (errs ? 'err' : 'ok');
  return errs;
}

// ---- árvores salvas (pastas trees/<nome>/) -------------------------------
let currentName = '';
async function refreshTreeList() {
  try {
    const r = await window.trees.list();
    if (!r.ok) return;
    $('treeList').innerHTML = '<option value="">— salvas —</option>' +
      r.data.map(n => '<option value="' + esc(n) + '"' + (n === currentName ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  } catch (e) {}
}
function applyContextToUI() {
  $('ctxHomun').value = String(ctxHomun);
  $('ctxBase').value = String(ctxBase);
  syncCtx();
}
async function openTree() {
  const name = $('treeList').value;
  if (!name) { setStatus('Escolha uma árvore salva na lista.', true); return; }
  const r = await window.trees.load(name);
  if (!r.ok) { setStatus('Erro ao abrir: ' + r.error, true); return; }
  const w = JSON.parse(r.data);
  tree = w.spec || w;
  ctxHomun = w.homunType || 4; ctxBase = w.baseType || 0;
  treeConfig = w.config || {};
  applyContextToUI(); await loadCatalog();
  uidSeq = 1; assignUids(tree); selId = tree._uid; autoLayout();
  currentName = name; $('treeName').value = name;
  renderInspector(); renderAll(); histInit();
  setStatus('Aberta: trees/' + name + '/');
}
async function saveTreeAs() {
  const name = ($('treeName').value || '').trim();
  if (!name) { setStatus('Dê um nome à árvore (será a pasta trees/<nome>/).', true); return; }
  const wrapper = { name: name, homunType: ctxHomun, baseType: ctxBase, config: treeConfig, spec: exportSpec(tree) };
  const r = await window.trees.save(name, JSON.stringify(wrapper, null, 2));
  if (!r.ok) { setStatus('Erro ao salvar: ' + r.error, true); return; }
  currentName = r.name; $('treeName').value = r.name;
  await refreshTreeList();
  setStatus('Salva em trees/' + r.name + '/tree.json');
}
async function buildTreeLua() {
  const name = ($('treeName').value || '').trim();
  if (!name) { setStatus('Dê um nome à árvore antes de gerar o Lua.', true); return; }
  if (renderValidation() > 0) { setStatus('Corrija os erros antes de gerar o Lua.', true); return; }
  const payload = { spec: exportSpec(tree), homunType: ctxHomun, baseType: ctxBase, config: treeConfig };
  const r = await window.trees.build(name, JSON.stringify(payload));
  if (!r.ok) { setStatus('Erro: ' + r.error, true); return; }
  setStatus('Pacote gerado: trees/' + r.name + '/dist/  +  trees/' + r.name + '/' + r.name + '.zip  (' + (r.files || '?') + ' arquivos, pronto p/ a pasta da IA do RO).');
}
async function newTree() {
  const name = ($('treeName').value || '').trim();
  if (!name) { setStatus('Digite um nome para a nova árvore.', true); return; }
  let exists = false;
  try { const r = await window.trees.list(); if (r.ok) exists = r.data.some(n => n.toLowerCase() === name.toLowerCase()); } catch (e) {}
  if (exists && !confirm('Já existe a árvore "' + name + '". Sobrescrever por uma nova (apenas o nó raiz)?')) {
    setStatus('Criação cancelada.'); return;
  }
  tree = { type: 'selector', label: 'root', children: [] };
  uidSeq = 1; assignUids(tree); selId = tree._uid; autoLayout();
  const wrapper = { name: name, homunType: ctxHomun, baseType: ctxBase, config: treeConfig, spec: exportSpec(tree) };
  const r = await window.trees.save(name, JSON.stringify(wrapper, null, 2));
  if (!r.ok) { setStatus('Erro ao criar: ' + r.error, true); return; }
  currentName = r.name; $('treeName').value = r.name;
  await refreshTreeList();
  renderInspector(); renderAll(); histInit();
  setStatus((exists ? 'Sobrescrita' : 'Criada') + ': trees/' + r.name + '/ (só o nó raiz)');
}
async function simulateTree() {
  if (renderValidation() > 0) { setStatus('Corrija os erros antes de simular.', true); return; }
  await callSim('setTree', exportSpec(tree));
  await callSim('setMonsters', monCatalog);
  await callSim('setConfig', treeConfig);
  // passa homún/base p/ o simulador e guarda o estado do editor p/ a volta
  try { sessionStorage.setItem('brai.simContext', JSON.stringify({ homunType: ctxHomun, baseType: ctxBase })); } catch (e) {}
  try { sessionStorage.setItem('brai.simConfig', JSON.stringify(treeConfig || {})); } catch (e) {}   // a config da árvore vale no simulador
  saveEditorState();
  window.location.href = (window.BRAI_SIM_URL || '../renderer/index.html');
}
async function loadDefault() { tree = await callSim('treeSpec'); uidSeq = 1; assignUids(tree); selId = tree._uid; autoLayout(); renderInspector(); renderAll(); histInit(); setStatus('Árvore padrão carregada.'); }

// ---- zoom (roda) e pan (arrastar o fundo) --------------------------------
function setZoom(z, cx, cy) {
  const wrap = $('graphwrap');
  const old = zoom;
  zoom = Math.min(2.2, Math.max(0.3, z));
  // coordenada do grafo sob o cursor, p/ manter o foco ao dar zoom
  const gx = (wrap.scrollLeft + cx) / old, gy = (wrap.scrollTop + cy) / old;
  drawEdges();
  wrap.scrollLeft = gx * zoom - cx;
  wrap.scrollTop = gy * zoom - cy;
}
function initCanvasNav() {
  const wrap = $('graphwrap');
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  // pan: arrastar o fundo (não sobre um nó)
  wrap.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.gnode, .linkh')) return; // nó/ponto têm seu próprio drag
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, sl = wrap.scrollLeft, st = wrap.scrollTop;
    wrap.style.cursor = 'grabbing';
    function mv(ev) { wrap.scrollLeft = sl - (ev.clientX - sx); wrap.scrollTop = st - (ev.clientY - sy); }
    function up() { wrap.style.cursor = ''; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
}

// ---- persistência do estado do editor (round-trip p/ o simulador) --------
// Guarda no sessionStorage (some ao fechar o app, sobrevive à navegação editor<->sim).
const STATE_KEY = 'brai.editorState';
function maxUid(n) { let m = n._uid || 0; for (const c of childrenOf(n)) m = Math.max(m, maxUid(c)); return m; }
function saveEditorState() {
  try {
    const wrap = $('graphwrap');
    sessionStorage.setItem(STATE_KEY, JSON.stringify({
      tree: tree,                 // inclui _uid/_x/_y p/ preservar layout e seleção
      selId: selId,
      ctxHomun: ctxHomun, ctxBase: ctxBase, config: treeConfig,
      treeName: $('treeName').value || '', currentName: currentName,
      zoom: zoom,
      sl: wrap ? wrap.scrollLeft : 0, st: wrap ? wrap.scrollTop : 0,
    }));
  } catch (e) {}
}
function readEditorState() {
  try { const raw = sessionStorage.getItem(STATE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// ---- boot ----------------------------------------------------------------
$('btnAddChild').onclick = addChild;
$('btnAddSibling').onclick = addSibling;
$('btnDelete').onclick = del;
$('btnLayout').onclick = () => { autoLayout(); renderAll(); };
$('btnNew').onclick = newTree;
$('btnOpen').onclick = openTree;
$('btnSaveTree').onclick = saveTreeAs;
$('btnBuildTree').onclick = buildTreeLua;
$('btnLoadDefault').onclick = loadDefault;
$('btnSimulate').onclick = simulateTree;
{ const ak = $('addKind'); if (ak) [].slice.call(ak.options).forEach(function (o) { if (NODE_HELP[o.value]) o.title = NODE_HELP[o.value]; }); }
{ const u = $('btnUndo'); if (u) u.onclick = undo; const r = $('btnRedo'); if (r) r.onclick = redo;
  const ins = $('inspector'); if (ins) { ins.addEventListener('input', histRecordSoon); ins.addEventListener('change', histRecordSoon); } }
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeMenu(); return; }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
  else if (mod && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) { e.preventDefault(); redo(); }
  else if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateNode(); }
  else if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyNode(); }
  else if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteNode(); }
  else if (!mod && (e.key === 'd' || e.key === 'D')) { if (selected()) { e.preventDefault(); toggleDisabled(); } }
  else if (e.key === 'Tab') { if (selected()) { e.preventDefault(); addChild(); } }
  else if (e.key === 'Enter') { if (selected()) { e.preventDefault(); addSibling(); } }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected()) { e.preventDefault(); del(); } }
});
document.addEventListener('mousedown', function (e) { const m = document.getElementById('ctxmenu'); if (m && !m.contains(e.target)) closeMenu(); }, true);

(async function boot() {
  try {
    registry = await callSim('registry');
    try { paramMeta = await callSim('paramMeta'); } catch (e) { paramMeta = {}; }
    try { cfgDefaults = await callSim('defaultConfig'); } catch (e) {}   // #4: dica de herança dos knobs por nó
    await loadMonsters();
    await loadSkillChoice();
    const bm = $('btnMonsters'); if (bm) bm.onclick = () => openMonsterManager();
    const bs = $('btnSkills'); if (bs) bs.onclick = () => openSkillManager();
    const bc = $('btnCombos'); if (bc) bc.onclick = () => openComboManager();
    const bcf = $('btnConfig'); if (bcf) bcf.onclick = () => openConfigManager();
    const bsp = $('btnSkillParams'); if (bsp) bsp.onclick = () => openSkillParams();
    $('ctxHomun').addEventListener('change', async () => { syncCtx(); await loadCatalog(); renderInspector(); renderAll(); });   // #5: atualiza rótulos
    $('ctxBase').addEventListener('change', async () => { syncCtx(); await loadCatalog(); renderInspector(); });
    window.addEventListener('beforeunload', saveEditorState);

    const saved = readEditorState();
    if (saved && saved.tree) {
      // volta do simulador: restaura árvore, contexto, nome, zoom e rolagem
      tree = saved.tree;
      ctxHomun = saved.ctxHomun || 4; ctxBase = saved.ctxBase || 0;
      treeConfig = saved.config || {};
      applyContextToUI(); await loadCatalog();
      currentName = saved.currentName || '';
      $('treeName').value = saved.treeName || '';
      uidSeq = maxUid(tree) + 1;
      selId = (saved.selId != null && find(tree, saved.selId)) ? saved.selId : tree._uid;
      renderInspector(); renderAll(); initCanvasNav(); refreshTreeList(); histInit();
      zoom = saved.zoom || 1; drawEdges();
      const wrap = $('graphwrap'); if (wrap) { wrap.scrollLeft = saved.sl || 0; wrap.scrollTop = saved.st || 0; }
      setStatus('Estado do editor restaurado.');
      return;
    }

    // boot normal: carrega do arquivo compartilhado ou a árvore padrão
    let r = null;
    try { r = await window.files.loadTree(); } catch (e) { r = null; }
    tree = (r && r.ok) ? JSON.parse(r.data) : await callSim('treeSpec');
    syncCtx(); await loadCatalog();
    uidSeq = 1; assignUids(tree); selId = tree._uid; autoLayout();
    renderInspector(); renderAll(); initCanvasNav(); refreshTreeList(); histInit();
  } catch (e) { setStatus('boot: ' + ((e && e.message) || e), true); }
})();

// ===== Painel de Configuração (knobs do H_Config) ==========================
// Os ajustes (AggroHP, HealOwnerHP, AutoMobCount, …) vão p/ o config.lua do
// pacote (Gerar Lua) e valem no simulador. treeConfig guarda o que o usuário/migração definiu.
async function openConfigManager() {
  let ov = document.getElementById('cfgModal');
  if (!ov) { ov = document.createElement('div'); ov.id = 'cfgModal'; ov.className = 'mm-overlay'; document.body.appendChild(ov); }
  renderConfigManager();            // mostra o painel já (mesmo antes do defaultConfig)
  ov.style.display = 'flex';
  if (!cfgDefaults) {
    try { cfgDefaults = await callSim('defaultConfig'); } catch (e) { cfgDefaults = cfgDefaults || {}; }
    renderConfigManager();          // re-renderiza com os knobs quando chegar
  }
}
function closeConfigManager() { const ov = document.getElementById('cfgModal'); if (ov) ov.style.display = 'none'; refreshTreeLabels(); }
function renderConfigManager() {
  const ov = document.getElementById('cfgModal'); if (!ov) return;
  const def = cfgDefaults || {};
  const keys = Object.keys(def).sort();
  const rows = keys.map(function (k) {
    const dv = def[k];
    const ovr = (treeConfig[k] !== undefined && treeConfig[k] !== null);
    const cur = ovr ? treeConfig[k] : dv;
    let input;
    if (typeof dv === 'boolean') input = '<input type="checkbox" class="cfg-in" data-k="' + k + '" data-t="bool"' + (cur ? ' checked' : '') + '>';
    else if (typeof dv === 'number') input = '<input type="number" class="cfg-in" data-k="' + k + '" data-t="num" value="' + esc(cur) + '" style="width:90px">';
    else input = '<input type="text" class="cfg-in" data-k="' + k + '" data-t="str" value="' + esc(cur) + '" style="width:120px">';
    return '<div class="mm-row" style="gap:8px;align-items:center">' +
      '<span style="flex:1' + (ovr ? ';font-weight:700;color:#46c46a' : '') + '">' + esc(k) + '</span>' + input +
      '<span style="color:var(--muted);font-size:11px;min-width:96px;text-align:right">padrão: ' + esc(String(dv)) + '</span></div>';
  }).join('');
  ov.innerHTML =
    '<div class="mm-panel">' +
      '<div class="mm-head"><strong>Configuração — ajustes do H_Config</strong><button id="cfgClose" class="mm-x">fechar ✕</button></div>' +
      '<div class="mm-body"><section class="mm-col" style="flex:1">' +
        '<div class="mm-hint">Vão para o <b>config.lua</b> do pacote (Gerar Lua) e valem no simulador. Em <b style="color:#46c46a">verde</b> = alterado vs. o padrão; limpar um número volta ao padrão.</div>' +
        '<div class="mm-list">' + (rows || '<div class="mm-empty">defaultConfig indisponível</div>') + '</div>' +
        '<div class="mm-add"><button id="cfgReset" class="mm-danger">restaurar tudo ao padrão</button></div>' +
      '</section></div>' +
      '<div class="mm-foot"><button id="cfgSave" class="mm-save" type="button">💾 Salvar</button></div>' +
    '</div>';
  document.getElementById('cfgClose').onclick = closeConfigManager;
  { const b = document.getElementById('cfgSave'); if (b) b.onclick = async () => { try { await callSim('setConfig', treeConfig); } catch (e) {} saveEditorState(); await refreshTreeLabels('Config salva — vale no Lua e no simulador.'); }; }
  ov.onclick = (e) => { if (e.target === ov) closeConfigManager(); };
  Array.prototype.forEach.call(ov.querySelectorAll('.cfg-in'), function (inp) {
    inp.onchange = function () {
      const k = inp.getAttribute('data-k'), t = inp.getAttribute('data-t');
      if (t === 'bool') treeConfig[k] = inp.checked;
      else if (t === 'num') { const v = parseFloat(inp.value); if (isNaN(v)) delete treeConfig[k]; else treeConfig[k] = v; }
      else { if (inp.value === '') delete treeConfig[k]; else treeConfig[k] = inp.value; }
      renderConfigManager();
    };
  });
  const rst = document.getElementById('cfgReset'); if (rst) rst.onclick = function () { treeConfig = {}; renderConfigManager(); };
}

// ===== Gerenciador de monstros e grupos (modal) ============================
// Catálogo GLOBAL (monsters.json): cadastra monstros (id + descrição) e grupos
// (nome + membros). Os nós monsterCheck referenciam monstros/grupos por id.
let mmSearch = '';
let mmGroupId = null;

function mmFilteredMonsters() {
  const q = mmSearch.trim().toLowerCase();
  let list = monCatalog.monsters.slice();
  if (q) list = list.filter(m => String(m.id).includes(q) || String(m.desc || '').toLowerCase().includes(q));
  return list.sort((a, b) => String(a.desc || a.id).localeCompare(String(b.desc || b.id)));
}

function openMonsterManager() {
  let ov = document.getElementById('monModal');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'monModal';
    ov.className = 'mm-overlay';
    document.body.appendChild(ov);
  }
  if (mmGroupId == null && monCatalog.groups.length) mmGroupId = monCatalog.groups[0].id;
  renderMonManager();
  ov.style.display = 'flex';
}
function closeMonManager() { const ov = document.getElementById('monModal'); if (ov) ov.style.display = 'none'; refreshTreeLabels(); }

function renderMonManager() {
  const ov = document.getElementById('monModal');
  if (!ov) return;
  const mons = mmFilteredMonsters();
  const g = mmGroupId != null ? grpById(mmGroupId) : null;
  const memberSet = {};
  if (g) for (const id of (g.members || [])) memberSet[id] = true;

  const monRows = mons.length ? mons.map(m =>
    '<div class="mm-row" data-id="' + m.id + '">' +
      (g ? '<input type="checkbox" class="mm-mem" data-id="' + m.id + '"' + (memberSet[m.id] ? ' checked' : '') + ' title="pertence ao grupo">' : '') +
      '<span class="mm-desc">' + esc(m.desc || '(sem descrição)') + '</span>' +
      '<span class="mm-id">#' + m.id + '</span>' +
      '<button class="mm-del" data-id="' + m.id + '" title="remover do cadastro">✕</button>' +
    '</div>'
  ).join('') : '<div class="mm-empty">nenhum monstro' + (mmSearch ? ' para "' + esc(mmSearch) + '"' : ' cadastrado') + '</div>';

  const grpOpts = monCatalog.groups.map(gr =>
    '<option value="' + gr.id + '"' + (gr.id === mmGroupId ? ' selected' : '') + '>' + esc(gr.name || ('grupo ' + gr.id)) + ' (' + (gr.members || []).length + ')</option>'
  ).join('');

  ov.innerHTML =
    '<div class="mm-panel">' +
      '<div class="mm-head"><strong>Monstros e grupos</strong><button id="mmClose" class="mm-x">fechar ✕</button></div>' +
      (scIsStatic() ? '<div class="sc-io" style="padding:8px 14px 10px"><span class="sc-io-lbl">Config:</span><button id="monExport" type="button">\u2b07 exportar monstros</button><button id="monImport" type="button">\u2b06 importar monstros</button><input id="monImportFile" type="file" accept="application/json,.json" style="display:none"><span class="sc-io-msg" id="monIoMsg"></span></div>' : '') +
      '<div class="mm-body">' +
        '<section class="mm-col">' +
          '<h4>Cadastro de monstros</h4>' +
          '<div class="mm-add"><input id="mmNewId" type="number" placeholder="ID" min="1"><input id="mmNewDesc" type="text" placeholder="descrição"><button id="mmAdd">+ cadastrar</button></div>' +
          '<input id="mmSearch" class="mm-search" type="text" placeholder="buscar por nome ou ID…" value="' + esc(mmSearch) + '">' +
          '<div class="mm-list">' + monRows + '</div>' +
          (g ? '<div class="mm-hint">As caixas marcam quem pertence ao grupo <b>' + esc(g.name || ('grupo ' + g.id)) + '</b>.</div>' : '<div class="mm-hint">Crie/escolha um grupo ao lado para marcar membros.</div>') +
        '</section>' +
        '<section class="mm-col">' +
          '<h4>Grupos</h4>' +
          '<div class="mm-add"><input id="mmNewGrp" type="text" placeholder="nome do novo grupo"><button id="mmAddGrp">+ criar</button></div>' +
          (monCatalog.groups.length ?
            '<div class="mm-grpsel"><label>Grupo: <select id="mmGrpSel">' + grpOpts + '</select></label></div>' +
            '<div class="mm-grpedit">' +
              '<input id="mmGrpName" type="text" value="' + esc(g ? (g.name || '') : '') + '" placeholder="nome do grupo"' + (g ? '' : ' disabled') + '>' +
              '<button id="mmRenameGrp"' + (g ? '' : ' disabled') + '>renomear</button>' +
              '<button id="mmDelGrp" class="mm-danger"' + (g ? '' : ' disabled') + '>excluir grupo</button>' +
            '</div>' +
            (g ? '<div class="mm-members"><b>' + (g.members || []).length + '</b> membro(s): ' + ((g.members || []).map(id => esc(monLabel(id))).join(', ') || '—') + '</div>' : '')
            : '<div class="mm-empty">nenhum grupo ainda</div>') +
        '</section>' +
      '</div>' +
      '<div class="mm-foot"><button id="mmSave" class="mm-save" type="button">💾 Salvar</button></div>' +
    '</div>';

  // wiring
  document.getElementById('mmClose').onclick = closeMonManager;
  { const b = document.getElementById('mmSave'); if (b) b.onclick = async () => { await saveMonsters(); try { await callSim('setMonsters', monCatalog); } catch (e) {} await refreshTreeLabels('Monstros salvos.'); }; }
  ov.onclick = (e) => { if (e.target === ov) closeMonManager(); };
  const _mex = document.getElementById('monExport'); if (_mex) _mex.onclick = monExportCfg;
  const _mim = document.getElementById('monImport'), _mimf = document.getElementById('monImportFile');
  if (_mim && _mimf) { _mim.onclick = () => _mimf.click(); _mimf.onchange = () => { if (_mimf.files && _mimf.files[0]) monImportCfg(_mimf.files[0]); _mimf.value = ''; }; }

  const add = document.getElementById('mmAdd');
  add.onclick = async () => {
    const id = parseInt(document.getElementById('mmNewId').value, 10);
    const desc = document.getElementById('mmNewDesc').value.trim();
    if (!id || id <= 0) { return; }
    if (monById(id)) { const m = monById(id); if (desc) m.desc = desc; }
    else monCatalog.monsters.push({ id: id, desc: desc || ('#' + id) });
    await saveMonsters(); renderMonManager(); renderInspector(); renderAll();
  };

  const srch = document.getElementById('mmSearch');
  srch.oninput = () => { mmSearch = srch.value; renderMonManager(); const el = document.getElementById('mmSearch'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } };

  ov.querySelectorAll('.mm-del').forEach(b => b.onclick = async () => {
    const id = parseInt(b.dataset.id, 10);
    monCatalog.monsters = monCatalog.monsters.filter(m => m.id !== id);
    for (const gr of monCatalog.groups) gr.members = (gr.members || []).filter(x => x !== id);
    await saveMonsters(); renderMonManager(); renderInspector(); renderAll();
  });

  ov.querySelectorAll('.mm-mem').forEach(cb => cb.onchange = async () => {
    const id = parseInt(cb.dataset.id, 10);
    const gr = grpById(mmGroupId); if (!gr) return;
    gr.members = gr.members || [];
    if (cb.checked) { if (gr.members.indexOf(id) < 0) gr.members.push(id); }
    else gr.members = gr.members.filter(x => x !== id);
    await saveMonsters(); renderMonManager(); renderInspector(); renderAll();
  });

  const addGrp = document.getElementById('mmAddGrp');
  if (addGrp) addGrp.onclick = async () => {
    const name = document.getElementById('mmNewGrp').value.trim();
    if (!name) return;
    const id = nextGroupId();
    monCatalog.groups.push({ id: id, name: name, members: [] });
    mmGroupId = id;
    await saveMonsters(); renderMonManager(); renderInspector(); renderAll();
  };

  const grpSel = document.getElementById('mmGrpSel');
  if (grpSel) grpSel.onchange = () => { mmGroupId = parseInt(grpSel.value, 10); renderMonManager(); };

  const rename = document.getElementById('mmRenameGrp');
  if (rename) rename.onclick = async () => {
    const gr = grpById(mmGroupId); if (!gr) return;
    const nm = document.getElementById('mmGrpName').value.trim();
    if (nm) gr.name = nm;
    await saveMonsters(); renderMonManager(); renderInspector(); renderAll();
  };

  const delGrp = document.getElementById('mmDelGrp');
  if (delGrp) delGrp.onclick = async () => {
    monCatalog.groups = monCatalog.groups.filter(x => x.id !== mmGroupId);
    // limpa referências a este grupo nos nós da árvore
    (function clr(n) { if (n.type === 'monsterCheck' && n.group === mmGroupId) n.group = 0; childrenOf(n).forEach(clr); })(tree);
    mmGroupId = monCatalog.groups.length ? monCatalog.groups[0].id : null;
    await saveMonsters(); renderMonManager(); renderInspector(); renderAll();
  };
}


// ===== Tela: Parâmetros das skills por homúnculo (modal #spModal) ==========
// Casca (C3): seletor de homún + close. As seções por papel + knobs + export/import vêm no C4.
async function openSkillParams(focusRole) {
  await loadSkillParams();
  if (focusRole) spTab = focusRole;
  let ov = document.getElementById('spModal');
  if (!ov) { ov = document.createElement('div'); ov.id = 'spModal'; ov.className = 'mm-overlay'; document.body.appendChild(ov); }
  await renderSkillParamsModal();
  ov.style.display = 'flex';
}
function closeSkillParams() { const ov = document.getElementById('spModal'); if (ov) ov.style.display = 'none'; refreshTreeLabels(); }
async function renderSkillParamsModal() {
  const ov = document.getElementById('spModal'); if (!ov) return;
  let pc = [];
  try { pc = await callSim('paramConfig'); } catch (e) { pc = []; }
  const roles = pc || [];
  if (!spTab || !roles.some(r => r.role === spTab)) spTab = roles.length ? roles[0].role : null;
  const tabs = roles.map(r => '<button type="button" class="sp-tab' + (r.role === spTab ? ' active' : '') + '" data-role="' + r.role + '">' + esc(r.label) + '</button>').join('');
  const active = roles.find(r => r.role === spTab);
  const body = active
    ? '<div class="sp-row" data-role="' + active.role + '">' +
        (active.desc ? '<div class="sp-desc">' + esc(active.desc) + '</div>' : '') +
        '<div class="sp-knobs">' + active.knobs.map(k => spKnobField(active.role, k)).join('') + '</div></div>'
    : '';
  const ioBar = '<div class="sc-io"><span class="sc-io-lbl">Config:</span>' +
    '<button id="spExport" type="button">⬇ exportar parâmetros</button>' +
    '<button id="spImport" type="button">⬆ importar parâmetros</button>' +
    '<input id="spImportFile" type="file" accept="application/json,.json" style="display:none">' +
    '<span class="sc-io-msg" id="spIoMsg"></span></div>';
  ov.innerHTML =
    '<div class="mm-panel sc-panel sp-panel">' +
      '<div class="mm-head"><strong>Parâmetros das skills</strong><button id="spClose" class="mm-x">fechar ✕</button></div>' +
      '<div class="mm-body sc-body">' +
        ioBar +
        '<div class="sc-note sp-globalnote">Parâmetros <b>globais</b> das ações de skill: valem para <b>todos os homúnculos</b> que têm a skill do papel — esta é a única fonte da verdade. Precedência: override no nó &gt; estes parâmetros &gt; Config global &gt; padrão.</div>' +
        '<div class="sp-tabs" id="spTabs">' + tabs + '</div>' +
        '<div class="sp-rows" id="spRows">' + body + '</div>' +
      '</div>' +
      '<div class="mm-foot"><button id="spSave" class="mm-save" type="button">💾 Salvar</button></div>' +
    '</div>';
  document.getElementById('spClose').onclick = closeSkillParams;
  { const b = document.getElementById('spSave'); if (b) b.onclick = async () => { await saveSkillParams(); await refreshTreeLabels('Parâmetros salvos — valem na árvore, no Lua e no simulador.'); }; }
  ov.onclick = (e) => { if (e.target === ov) closeSkillParams(); };
  ov.querySelectorAll('.sp-tab').forEach(t => t.onclick = async () => { spTab = t.dataset.role; await renderSkillParamsModal(); });
  ov.querySelectorAll('.spKnob').forEach(el => {
    el.onchange = async () => {
      const role = el.dataset.role, key = el.dataset.key, type = el.dataset.type;
      let value;
      if (type === 'boolean') value = (el.value === 'true');
      else { const raw = String(el.value).trim(); const n = parseFloat(raw); value = (raw === '' || Number.isNaN(n)) ? null : n; }
      spSetKnob(role, key, value);
      await saveSkillParams();
      spIoMsg('Parâmetro atualizado.', false);
    };
  });
  const ex = document.getElementById('spExport'); if (ex) ex.onclick = spExportParams;
  const im = document.getElementById('spImport'), imf = document.getElementById('spImportFile');
  if (im && imf) { im.onclick = () => imf.click(); imf.onchange = () => { if (imf.files && imf.files[0]) spImportParams(imf.files[0]); imf.value = ''; }; }
}

// ===== Tela: Skills por homúnculo (modal) =================================
async function openSkillManager() {
  await loadSkillChoice();
  await loadSummonChoice();
  await loadSkillParams();
  if (scHomun == null) scHomun = ctxHomun || 51;
  let ov = document.getElementById('scModal');
  if (!ov) { ov = document.createElement('div'); ov.id = 'scModal'; ov.className = 'mm-overlay'; document.body.appendChild(ov); }
  await renderSkillManager();
  ov.style.display = 'flex';
}
function closeSkillManager() { const ov = document.getElementById('scModal'); if (ov) ov.style.display = 'none'; refreshTreeLabels(); }

async function renderSkillManager() {
  const ov = document.getElementById('scModal'); if (!ov) return;
  let roles = [];
  try { roles = await callSim('roleConfig', { homunType: scHomun, baseType: (scHomun === ctxHomun ? (ctxBase || 0) : 0) }); } catch (e) { roles = []; }
  let ovc = [];
  try { ovc = await callSim('overrideConfig', { homunType: scHomun }); } catch (e) { ovc = []; }
  const ovByRole = {}; (ovc || []).forEach(o => { ovByRole[o.role] = o; });
  const ovArea = (role) => { const oc = ovByRole[role]; if (!oc) return ''; const checked = !!oc.hasOverride; return '<div class="sc-ovwrap" data-role="' + role + '"><label class="sc-ovchk"><input type="checkbox" class="sc-ovtoggle" data-role="' + role + '"' + (checked ? ' checked' : '') + '> sobrepor parâmetros</label>' + (checked ? '<div class="sc-ovknobs" data-role="' + role + '">' + oc.knobs.map(k => ovKnobField(role, k)).join('') + '</div>' : '') + '</div>'; };

  const homunOpts = SC_HOMUN_ORDER.map(t => '<option value="' + t + '"' + (t === scHomun ? ' selected' : '') + '>' + esc(HOMUN_NAMES[t] || ('#' + t)) + '</option>').join('');

  const skillLine = (role, sk) => {
    const maxLv = sk.maxLevel || 1;
    const cur = sk.level || maxLv;   // pré-seleciona o nível efetivo (skillLevels[id] ou o conhecido); sem rótulo "Padrão"
    let lo = '';
    for (let i = 1; i <= maxLv; i++) lo += '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>' + i + '</option>';
    return '<div class="sc-skill" data-role="' + role + '" data-skill="' + sk.id + '">' +
      '<span class="sc-skill-hot" data-role="' + role + '" data-skill="' + sk.id + '">' +
        '<span class="sc-skill-name">' + esc(sk.name) + '</span>' +
        '<span class="sc-lvlwrap"><span class="sc-lvllbl">nível</span>' +
        '<select class="sc-skill-lvl" data-role="' + role + '" data-skill="' + sk.id + '">' + lo + '</select></span>' +
      '</span>' +
      '<button class="sc-rm" type="button" data-role="' + role + '" data-skill="' + sk.id + '" title="remover">✕</button>' +
      '</div>';
  };
  const roSkillLine = (role, sk) => '<div class="sc-skill sc-skill-ro" data-role="' + role + '" data-skill="' + sk.id + '">' +
    '<span class="sc-skill-hot" data-role="' + role + '" data-skill="' + sk.id + '"><span class="sc-skill-name">' + esc(sk.name) + '</span></span></div>';
  const rows = (roles || []).map(r => {
    const label = esc(SC_ROLE_LABEL[r.key] || r.key);
    if (r.fixed) {
      const effF = r.effective || [];
      if (!effF.length) return '';   // homúnculo não tem essa skill fixa → oculta (não é necessário)
      const bodyF = effF.map(sk => roSkillLine(r.key, sk)).join('');
      return '<div class="sc-row"><span class="sc-role">' + label + ' <span class="sc-fixed-tag" title="Skill fixa do perfil. Os parâmetros desta ação ficam em Parâmetros (global).">fixa</span></span>' +
             '<span class="sc-ctrl"><button class="sc-paramlink" type="button" data-role="' + r.key + '" title="Abrir os parâmetros globais desta ação">⚙ parâmetros</button></span></div>' +
             '<div class="sc-skills" data-role="' + r.key + '">' + bodyF + '</div>' + ovArea(r.key);
    }
    const cands = r.candidates || [];
    if (cands.length === 0) return '';   // homúnculo não tem skill deste papel → oculta (não é necessário)
    const eff = r.effective || [];
    const effIds = eff.map(s => s.id);
    const addable = cands.filter(c => effIds.indexOf(c.id) < 0);
    const addCtrl = '<select class="sc-add" data-role="' + r.key + '"' + (addable.length ? '' : ' disabled') + '>' +
      '<option value="">➕ adicionar skill…</option>' +
      addable.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select>';
    const resetBtn = r.overridden ? '<button class="sc-reset" type="button" data-role="' + r.key + '" title="usar o padrão do perfil">↺ padrão</button>' : '';
    const skillLines = eff.length
      ? eff.map(sk => skillLine(r.key, sk)).join('')
      : '<div class="sc-empty-skill">nenhuma skill — este papel não age</div>';
    return '<div class="sc-row"><span class="sc-role">' + label + '</span>' +
           '<span class="sc-ctrl">' + addCtrl + resetBtn + '</span></div>' +
           '<div class="sc-skills' + (eff.length > 1 ? ' multi' : '') + '" data-role="' + r.key + '">' + skillLines + '</div>' + ovArea(r.key);
  }).join('');

  let si = null; try { si = await callSim('summonInfo', { homunType: scHomun }); } catch (e) {}
  const summonHtml = (si && si.hasSummon) ? renderSummonPanel(si) : '';
  const comboLink = (scHomun === 52) ? '<div class="sc-combolink"><button id="scComboLink" type="button" class="primary">✦ Editar combos da Eleanor (padrão)…</button></div>' : '';
  const inner = rows + comboLink + summonHtml;
  const ioBar = scIsStatic()
    ? '<div class="sc-io"><span class="sc-io-lbl">Config:</span>' +
        '<button id="scExport" type="button">\u2b07 exportar skills</button>' +
        '<button id="scImport" type="button">\u2b06 importar skills</button>' +
        '<input id="scImportFile" type="file" accept="application/json,.json" style="display:none">' +
        '<span class="sc-io-msg" id="scIoMsg"></span></div>'
    : '';

  ov.innerHTML =
    '<div class="mm-panel sc-panel">' +
      '<div class="mm-head"><strong>Skills por homúnculo</strong><button id="scClose" class="mm-x">fechar ✕</button></div>' +
      '<div class="mm-body sc-body">' +
        ioBar +
        '<div class="sc-pick"><label>Homúnculo: <select id="scHomunSel">' + homunOpts + '</select></label>' +
          '<span class="sc-note">Adicione/remova as skills de cada papel (0 ou mais). <b>Padrão</b> = as skills do perfil. Passe o mouse no nome ou no nível para ver os detalhes.</span></div>' +
        '<div class="sc-rows" data-homun="' + scHomun + '">' + inner + '</div>' +
      '</div>' +
      '<div class="mm-foot"><button id="scSave" class="mm-save" type="button">💾 Salvar</button></div>' +
    '</div>';

  document.getElementById('scClose').onclick = closeSkillManager;
  { const b = document.getElementById('scSave'); if (b) b.onclick = async () => { await saveSkillChoice(); await saveSummonChoice(); await refreshTreeLabels('Skills salvas — valem na árvore, no Lua e no simulador.'); }; }
  ov.onclick = (e) => { if (e.target === ov) closeSkillManager(); };
  const hs = document.getElementById('scHomunSel');
  if (hs) hs.onchange = async () => { scHomun = parseInt(hs.value, 10) || 51; await renderSkillManager(); };
  const roleByKey = {}; (roles || []).forEach(r => { roleByKey[r.key] = r; });
  const effIdsOf = (role) => ((roleByKey[role] && roleByKey[role].effective) || []).map(s => s.id);
  ov.querySelectorAll('.sc-add').forEach(sel => sel.onchange = async () => {
    const id = parseInt(sel.value, 10) || 0; if (!id) return;
    const list = effIdsOf(sel.dataset.role); if (list.indexOf(id) < 0) list.push(id);
    scSetRoleList(scHomun, sel.dataset.role, list);
    await saveSkillChoice(); setStatus('Skill adicionada (' + (HOMUN_NAMES[scHomun] || scHomun) + ').');
    await renderSkillManager();
  });
  ov.querySelectorAll('.sc-rm').forEach(btn => btn.onclick = async () => {
    const id = parseInt(btn.dataset.skill, 10), role = btn.dataset.role;
    scSetRoleList(scHomun, role, effIdsOf(role).filter(x => x !== id));
    await saveSkillChoice(); setStatus('Skill removida (' + (HOMUN_NAMES[scHomun] || scHomun) + ').');
    await renderSkillManager();
  });
  ov.querySelectorAll('.sc-reset').forEach(btn => btn.onclick = async () => {
    scClearRole(scHomun, btn.dataset.role);
    await saveSkillChoice(); setStatus('Papel voltou ao padrão (' + (HOMUN_NAMES[scHomun] || scHomun) + ').');
    await renderSkillManager();
  });
  ov.querySelectorAll('.sc-paramlink').forEach(btn => btn.onclick = () => { closeSkillManager(); openSkillParams(btn.dataset.role); });
  ov.querySelectorAll('.sc-ovtoggle').forEach(cb => cb.onchange = async () => {
    const role = cb.dataset.role, oc = ovByRole[role];
    if (cb.checked) ovEnable(scHomun, role, oc ? oc.knobs : []); else ovDisable(scHomun, role);
    await saveSkillParams();
    setStatus((cb.checked ? 'Sobreposição ligada' : 'Sobreposição removida') + ' (' + (HOMUN_NAMES[scHomun] || scHomun) + ' · ' + role + ').');
    await renderSkillManager();
  });
  ov.querySelectorAll('.ovKnob').forEach(el => el.onchange = async () => {
    const role = el.dataset.role, key = el.dataset.key, type = el.dataset.type;
    let value;
    if (type === 'boolean') value = (el.value === 'true');
    else { const raw = String(el.value).trim(); let nn = parseFloat(raw); if (raw === '' || Number.isNaN(nn)) { nn = parseFloat(el.dataset.gv); if (Number.isNaN(nn)) nn = 0; el.value = nn; } value = nn; }
    ovSetKnob(scHomun, role, key, value);
    await saveSkillParams();
    setStatus('Override atualizado (' + (HOMUN_NAMES[scHomun] || scHomun) + ').');
  });
  ov.querySelectorAll('.sc-skill-lvl').forEach(sel => sel.onchange = async () => {
    scSetSkillLevel(scHomun, parseInt(sel.dataset.skill, 10), parseInt(sel.value, 10) || 0);
    await saveSkillChoice(); setStatus('Nível de skill atualizado (' + (HOMUN_NAMES[scHomun] || scHomun) + ').');
  });
  ov.querySelectorAll('.sm-field').forEach(el => el.onchange = async () => {
    const key = el.dataset.key, ty = el.dataset.type;
    let v; if (ty === 'bool') v = el.checked; else if (ty === 'int') v = parseInt(el.value, 10); else v = el.value;
    const k = String(scHomun); summonCfg.choices[k] = summonCfg.choices[k] || {}; summonCfg.choices[k][key] = v;
    await saveSummonChoice(); setStatus('Invocação de ' + (HOMUN_NAMES[scHomun] || scHomun) + ' atualizada.');
  });
  const _cl = document.getElementById('scComboLink');
  if (_cl) _cl.onclick = () => openComboManager('default');
  const _ex = document.getElementById('scExport'); if (_ex) _ex.onclick = scExportSkills;
  const _im = document.getElementById('scImport'), _imf = document.getElementById('scImportFile');
  if (_im && _imf) { _im.onclick = () => _imf.click(); _imf.onchange = () => { if (_imf.files && _imf.files[0]) scImportSkills(_imf.files[0]); _imf.value = ''; }; }

  // card de info (igual ao UseSkill) ao passar o mouse no NOME ou no NÍVEL de cada skill
  let scTip = document.getElementById('scTip');
  if (!scTip) { scTip = document.createElement('div'); scTip.id = 'scTip'; scTip.className = 'sc-tip'; document.body.appendChild(scTip); }
  scTip.style.display = 'none';
  const skillById = (key, id) => { const r = roleByKey[key]; if (!r) return null; for (const c of (r.candidates || [])) if (c.id === id) return c; for (const e of (r.effective || [])) if (e.id === id) return e; return null; };
  const showScTip = (key, id, anchorEl) => {
    const sk = skillById(key, id); if (!sk) { scTip.style.display = 'none'; return; }
    const lv = scGetSkillLevel(scHomun, id) || sk.level || sk.maxLevel || 1;
    scTip.innerHTML = skillInfoHtml(sk, lv);
    scTip.style.display = 'block';
    const rect = anchorEl.getBoundingClientRect();
    const w = scTip.offsetWidth || 300;
    scTip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 12)) + 'px';
    scTip.style.top = (rect.bottom + 6) + 'px';
  };
  const hideScTip = () => { scTip.style.display = 'none'; };
  ov.querySelectorAll('.sc-skill-hot[data-skill]').forEach(el => {
    const key = el.dataset.role, id = parseInt(el.dataset.skill, 10);
    el.addEventListener('mouseenter', () => showScTip(key, id, el));
    el.addEventListener('mouseleave', hideScTip);
  });
  ov.addEventListener('mouseleave', hideScTip, { once: false });
}

// ===== Painel "Combos da Eleanor" (modal) ==================================
// Edita os params do nó UseEleanorOffense selecionado (persistência = params do nó).
function findNodeBy(n, pred) { if (!n) return null; if (pred(n)) return n; for (const c of childrenOf(n)) { const r = findNodeBy(c, pred); if (r) return r; } return null; }
function firstEleanorNode() { return findNodeBy(tree, n => n && n.type === 'action' && n.name === 'UseEleanorOffense'); }

function eleanorInspectorHtml(sel) {
  const p = sel.params || {};
  const style = p.style || 'power';
  const barr = (p.comboSpheres != null) ? p.comboSpheres : 5;
  const win = (p.window != null) ? p.window : 2000;
  return '<div class="desc">Combo da Eleanor num só nó: estilo + esferas + barragem + segurança do Agarrão.</div>' +
    '<div class="ce-sum">Estilo <b>' + esc(style) + '</b> · barragem <b>' + barr + '</b> esferas · janela <b>' + win + '</b>ms</div>' +
    '<div class="field"><button id="iEleanorPanel" type="button" class="primary">✦ Abrir painel de Combos da Eleanor…</button></div>';
}

async function openComboManager(mode) {
  if (!comboInfoCache) { try { comboInfoCache = await callSim('comboInfo'); } catch (e) { comboInfoCache = null; } }
  comboMode = (mode === 'default') ? 'default' : 'node';
  if (comboMode === 'default') { await loadSkillChoice(); comboNodeUid = null; }
  else {
    const sel = selected();
    const node = (sel && sel.type === 'action' && sel.name === 'UseEleanorOffense') ? sel : firstEleanorNode();
    comboNodeUid = node ? node._uid : null;
  }
  let ov = document.getElementById('ceModal');
  if (!ov) { ov = document.createElement('div'); ov.id = 'ceModal'; ov.className = 'mm-overlay'; document.body.appendChild(ov); }
  renderComboManager();
  ov.style.display = 'flex';
}
function closeComboManager() { const ov = document.getElementById('ceModal'); if (ov) ov.style.display = 'none'; refreshTreeLabels(); }

function ceChainHtml(style, p) {
  const links = (comboInfoCache && comboInfoCache[style]) || [];
  const label = (comboInfoCache && comboInfoCache.labels && comboInfoCache.labels[style]) || style;
  let h = '<div class="ce-chain"><div class="ce-chain-title">' + esc(label) + '</div><div class="ce-links">';
  links.forEach((lk, i) => {
    if (i > 0) h += '<div class="ce-arrow">→</div>';
    const curLvl = (p.levels && p.levels[style] && p.levels[style][i] != null) ? p.levels[style][i] : lk.maxLevel;
    let lo = '';
    for (let v = 1; v <= lk.maxLevel; v++) lo += '<option value="' + v + '"' + (v === curLvl ? ' selected' : '') + '>Lv ' + v + '</option>';
    h += '<div class="ce-link' + (lk.finisher ? ' ce-fin' : '') + '">' +
      '<div class="ce-link-name">' + esc(lk.iro) + '</div>' +
      '<div class="ce-cost">💠 ' + lk.cost + ' esfera' + (lk.cost === 1 ? '' : 's') + '</div>' +
      '<select class="ce-lvl" data-style="' + style + '" data-step="' + (i + 1) + '">' + lo + '</select>' +
      (lk.bossForbidden ? '<div class="ce-warn">⨯ proibido em Boss/MVP</div>' : '') +
      '</div>';
  });
  h += '</div></div>';
  return h;
}

function renderComboManager() {
  const ov = document.getElementById('ceModal'); if (!ov) return;
  const isDefault = (comboMode === 'default');
  let p;
  if (isDefault) {
    skillChoice.choices['52'] = skillChoice.choices['52'] || {};
    p = skillChoice.choices['52'].combo = skillChoice.choices['52'].combo || {};
  } else {
    const node = comboNodeUid ? find(tree, comboNodeUid) : null;
    if (!node) {
      ov.innerHTML = '<div class="mm-panel ce-panel"><div class="mm-head"><strong>Combos da Eleanor</strong>' +
        '<button id="ceClose" class="mm-x">fechar ✕</button></div><div class="mm-body" style="flex-direction:column">' +
        '<div class="mm-empty">Nenhum nó <b>UseEleanorOffense</b> na árvore. Crie um agora (entra como filho do nó selecionado ou da raiz):</div>' +
        '<div class="ce-actions"><button id="ceCreate" type="button" class="primary">+ criar nó UseEleanorOffense</button></div></div></div>';
      document.getElementById('ceClose').onclick = closeComboManager;
  { const b = document.getElementById('ceSave'); if (b) b.onclick = async () => { await saveSkillChoice(); await refreshTreeLabels('Combos salvos.'); }; }
      ov.onclick = (e) => { if (e.target === ov) closeComboManager(); };
      const cc = document.getElementById('ceCreate'); if (cc) cc.onclick = () => ceCreateNode();
      return;
    }
    p = node.params = node.params || {};
  }
  const style = p.style || 'power';
  const defBarr = comboInfoCache ? comboInfoCache.defaults.autoComboSpheres : 5;
  const barr = (p.comboSpheres != null) ? p.comboSpheres : defBarr;
  const win = (p.window != null) ? p.window : 2000;
  const thr = (p.grappleThreatLimit != null) ? p.grappleThreatLimit : 1;
  const allow = (p.allowStyleSwitch !== false);
  const gap = (p.minGap != null) ? p.minGap : 0;
  const styleOpts = [['power', 'Combate (Power)'], ['grapple', 'Agarrão (Grapple)'], ['auto', 'Auto (decide pelo isolamento)']]
    .map(o => '<option value="' + o[0] + '"' + (o[0] === style ? ' selected' : '') + '>' + o[1] + '</option>').join('');

  ov.innerHTML = '<div class="mm-panel ce-panel">' +
    '<div class="mm-head"><strong>Combos da Eleanor' + (isDefault ? ' · padrão' : '') + '</strong><button id="ceClose" class="mm-x">fechar ✕</button></div>' +
    '<div class="mm-body ce-body">' +
      (isDefault
        ? '<div class="ce-note ce-note-def">Editando o <b>padrão</b> da Eleanor (salvo em <code>homun_skills.json</code>). Os <b>params do nó</b> na árvore <b>sobrepõem</b> este padrão.</div>'
        : '<div class="ce-note">Configura o nó <b>UseEleanorOffense</b> selecionado. Salvo nos <b>params do nó</b> da árvore — <b>sobrepõe</b> o padrão da tela de Skills.</div>') +
      '<div class="ce-cfg">' +
        '<div class="field"><label>Estilo padrão</label><select id="ceStyle">' + styleOpts + '</select></div>' +
        '<div class="field"><label>Barragem de esferas (AutoComboSpheres)</label>' +
          '<input id="ceBarr" type="number" min="0" max="10" value="' + barr + '" />' +
          '<div class="ce-help">Mínimo de esferas <b>estimadas</b> antes de iniciar um combo, para garantir que dá pra fechar o finalizador. A Eleanor não enxerga as esferas pela API — o valor é estimado (ataques/dano). Faixa 0–10; a AzzyAI usa 5–10.</div></div>' +
        '<div class="field"><label>Janela de encadeamento (ms)</label><input id="ceWin" type="number" min="0" step="100" value="' + win + '" />' +
          '<div class="ce-help">Tempo máximo entre um elo e o próximo; se estourar, o combo reinicia do começo.</div></div>' +
        '<div class="field"><label>Limite de ameaça p/ Agarrão</label><input id="ceThr" type="number" min="0" value="' + thr + '" />' +
          '<div class="ce-help">Máx. de monstros perto p/ liberar o Agarrão. O Tinder Breaker zera o Flee — em multidão é fatal; acima do limite, cai automaticamente para o Combate.</div></div>' +
        '<div class="field"><label>Intervalo mínimo entre golpes (ms)</label><input id="ceGap" type="number" min="0" step="50" value="' + gap + '" />' +
          '<div class="ce-help">Espaça os golpes do combo p/ não floodar pacotes em servidores lotados (LagReduction). 0 = sem limite; mantenha <b>menor que a janela</b>.</div></div>' +
        '<div class="field"><label class="chk"><input id="ceAllow" type="checkbox"' + (allow ? ' checked' : '') + ' /> Trocar de estilo automaticamente (Style Change)</label>' +
          '<div class="ce-help">Desligado, a Eleanor usa só o estilo atual — evita o loop de Style Change que travava a AzzyAI.</div></div>' +
      '</div>' +
      '<div class="ce-chains">' + ceChainHtml('power', p) + ceChainHtml('grapple', p) + '</div>' +
      '</div>' +
      '<div class="mm-foot"><button id="ceSave" class="mm-save" type="button">💾 Salvar</button></div>' +
    '</div>';

  document.getElementById('ceClose').onclick = closeComboManager;
  { const b = document.getElementById('ceSave'); if (b) b.onclick = async () => { await saveSkillChoice(); await refreshTreeLabels('Combos salvos.'); }; }
  ov.onclick = (e) => { if (e.target === ov) closeComboManager(); };
  const persist = isDefault ? () => { saveSkillChoice(); } : () => { renderInspector(); renderGraph(); };
  document.getElementById('ceStyle').onchange = (e) => { p.style = e.target.value; persist(); };
  document.getElementById('ceBarr').onchange = (e) => { let v = parseInt(e.target.value, 10); if (Number.isNaN(v)) delete p.comboSpheres; else p.comboSpheres = Math.max(0, Math.min(10, v)); persist(); };
  document.getElementById('ceWin').onchange = (e) => { const v = parseInt(e.target.value, 10); if (Number.isNaN(v)) delete p.window; else p.window = Math.max(0, v); persist(); };
  document.getElementById('ceThr').onchange = (e) => { const v = parseInt(e.target.value, 10); if (Number.isNaN(v)) delete p.grappleThreatLimit; else p.grappleThreatLimit = Math.max(0, v); persist(); };
  document.getElementById('ceGap').onchange = (e) => { const v = parseInt(e.target.value, 10); if (Number.isNaN(v) || v <= 0) delete p.minGap; else p.minGap = v; persist(); };
  document.getElementById('ceAllow').onchange = (e) => { if (e.target.checked) delete p.allowStyleSwitch; else p.allowStyleSwitch = false; persist(); };
  ov.querySelectorAll('.ce-lvl').forEach(selct => selct.onchange = () => {
    const st = selct.dataset.style, step = parseInt(selct.dataset.step, 10), val = parseInt(selct.value, 10);
    const links = (comboInfoCache && comboInfoCache[st]) || [];
    p.levels = p.levels || {};
    p.levels[st] = links.map((lk, i) => {
      const cur = (p.levels[st] && p.levels[st][i] != null) ? p.levels[st][i] : lk.maxLevel;
      return (i === step - 1) ? val : cur;
    });
    persist();
  });
}

function ceCreateNode() {
  const node = { type: 'action', name: 'UseEleanorOffense', params: {} };
  assignUids(node);
  const sel = selected();
  let placed = false;
  if (sel && COMPOSITES.includes(sel.type)) { sel.children.push(node); placed = true; }
  else if (sel) { const parent = findParent(tree, sel._uid, null); if (parent && COMPOSITES.includes(parent.type)) { parent.children.splice(parent.children.indexOf(sel) + 1, 0, node); placed = true; } }
  if (!placed && COMPOSITES.includes(tree.type)) { tree.children.push(node); placed = true; }
  if (!placed) { setStatus('Selecione um composite (selector/sequence) para inserir o nó.', true); return; }
  comboNodeUid = node._uid; selId = node._uid;
  autoLayout(); renderInspector(); renderAll(); histRecord();
  renderComboManager();
}
