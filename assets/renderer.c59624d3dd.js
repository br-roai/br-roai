// renderer.js — UI do simulador com timeline/replay e inspetor de blackboard.
'use strict';

// ---- diagnóstico visível (PRIMEIRA coisa: captura qualquer erro na tela) -----
function showError(msg) {
  let el = document.getElementById('errbar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'errbar';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#7d1a1a;color:#fff;' +
      'padding:8px 12px;font:12px ui-monospace,monospace;z-index:99999;white-space:pre-wrap';
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = '\u26a0 ' + msg;
}
window.addEventListener('error', function (e) { showError((e.message || 'erro') + '  @ ' + (e.filename || '') + ':' + (e.lineno || '')); });
window.addEventListener('unhandledrejection', function (e) { showError('promise: ' + ((e.reason && e.reason.message) || e.reason)); });


const CMD = { NONE: 0, MOVE: 1, ATTACK_OBJECT: 3 };
const MOTION = { STAND: 0, MOVE: 1, ATTACK: 2, DEAD: 3, DAMAGE: 4, SKILL: 7, CASTING: 8 };
const MAX_FRAMES = 5000;
const S_TYPES = [48, 49, 50, 51, 52]; // Homunculus S precisam de tipo base
const SKILL_PALETTE = ['#e06c75', '#56b6c2', '#c678dd', '#d19a66', '#98c379', '#61afef', '#e5c07b'];
// Eleanor: cadeias de combo p/ a visualização (espelha lua/src/data/combos.lua; refinado via comboInfo no boot)
let eleanorChains = {
  power: [{ iro: 'Sonic Claw', cost: 0 }, { iro: 'Silvervein Rush', cost: 1 }, { iro: 'Midnight Frenzy', cost: 2 }],
  grapple: [{ iro: 'Tinder Breaker', cost: 1 }, { iro: 'C.B.C.', cost: 1 }, { iro: 'E.Q.C.', cost: 2, bossForbidden: true }],
};
const EL_STYLE_LABEL = { power: 'Combate (Power)', grapple: 'Agarrão (Grapple)' };
// Sera — Legião invocada: tiers (mob class -> nome + cor do enxame)
const SUMMON_TIERS = {
  2158: { name: 'Hornet', color: '#f2c14e' },
  2159: { name: 'Giant Hornet', color: '#e0883c' },
  2160: { name: 'Luciola Vespa', color: '#d4476a' },
};
function summonTierByMob(mob) { return SUMMON_TIERS[mob] || { name: '—', color: '#9aa4ad' }; }
function summonTier(name) { for (const k in SUMMON_TIERS) { if (SUMMON_TIERS[k].name === name) return SUMMON_TIERS[k]; } return { name: name || '—', color: '#9aa4ad' }; }

function eleanorActiveStep(f) {
  const el = f.eleanor; if (!el || !el.step || el.comboKey !== el.style) return 0;
  if (el.comboAt != null && (f.tick - el.comboAt) > 2200) return 0;   // janela expirou -> pronto p/ reiniciar
  return el.step;
}
function colorForSkill(id) { return SKILL_PALETTE[Math.abs(id || 0) % SKILL_PALETTE.length]; }

const SCENARIO = {
  grid: { w: 40, h: 40 }, dt: 50, homunId: 100, ownerId: 1,
  entities: [
    { id: 1,   kind: 'owner',   x: 10, y: 10, hp: 1000, maxhp: 1000 },
    { id: 100, kind: 'homun',   x: 20, y: 20, hp: 100,  maxhp: 100, sp: 100, maxsp: 100 },
    { id: 200, kind: 'monster', x: 24, y: 23, hp: 60, maxhp: 60, atk: 6, aggro: 9, etype: 1042 },
    { id: 201, kind: 'monster', x: 28, y: 16, hp: 60, maxhp: 60, atk: 6, aggro: 9, etype: 1042 },
  ],
};

const $ = (id) => document.getElementById(id);
const canvas = $('grid');
if (!canvas) showError("canvas '#grid' não encontrado no HTML");
const ctx = canvas ? canvas.getContext('2d') : null;

// estado de reprodução
let frames = [];
let viewIndex = 0;
let playing = false;
let timer = null;
let sel = null;        // id da entidade selecionada (monstro, homúnculo ou dono)
let floaters = [];     // texto flutuante (combat text)
let showAllHp = false; // mostrar HP de todos os monstros
const _lastFloat = {};
function addFloater(gx, gy, text, color, ttl) { const now = performance.now(); const stack = floaters.filter(fl => fl.gx === gx && fl.gy === gy && (now - fl.t0) < 450).length; floaters.push({ gx, gy, text, color, t0: now, ttl: ttl || 2500, stack: stack }); if (floaters.length > 24) floaters.shift(); }
function spawnFloaters(prev, cur) {
  if (!prev || !cur) return;
  const homun = cur.entities.find(e => e.id === SCENARIO.homunId);
  const now = performance.now();
  for (const ln of (cur.log || [])) { const m = /^(.+?) Lv\d+ - SP/.exec(ln); if (m && homun && now - (_lastFloat.__skill || 0) > 500) { addFloater(homun.x, homun.y, m[1], '#ffd86b', 2600); _lastFloat.__skill = now; } }
  const ph = {}; for (const e of prev.entities) ph[e.id] = e.hp;
  for (const e of cur.entities) {
    if (!(e.id in ph)) continue;
    const d = ph[e.id] - e.hp;
    if (Math.abs(d) < 1) continue;
    if (now - (_lastFloat[e.id] || 0) < 320) continue;
    _lastFloat[e.id] = now;
    if (d > 0) addFloater(e.x, e.y, '-' + d, '#ff7a7a', 1400);
    else addFloater(e.x, e.y, '+' + (-d), '#7ee787', 1700);
  }
}
function drawFloaters(c) {
  const now = performance.now();
  floaters = floaters.filter(fl => now - fl.t0 < fl.ttl);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const fl of floaters) {
    const age = (now - fl.t0) / fl.ttl;
    const cx = (fl.gx + 0.5) * c, cy = (fl.gy + 0.5) * c - c * 0.8 - age * c * 1.8 - (fl.stack || 0) * c * 0.42;
    ctx.globalAlpha = Math.max(0, 1 - age * age);
    ctx.font = 'bold ' + Math.max(11, Math.floor(c * 0.4)) + 'px system-ui';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(fl.text, cx, cy);
    ctx.fillStyle = fl.color; ctx.fillText(fl.text, cx, cy);
  }
  ctx.globalAlpha = 1;
}

async function sim(method, obj) {
  if (!window.brai || typeof window.brai.dispatch !== 'function') {
    showError('Ponte indisponível: window.brai não foi exposto pelo preload. Verifique main.js/preload.js.');
    throw new Error('no sim bridge');
  }
  const r = await window.brai.dispatch(method, obj ? JSON.stringify(obj) : '');
  if (!r.ok) { $('status').textContent = 'ERRO: ' + r.error; showError('SIM_DISPATCH(' + method + '): ' + r.error); throw new Error(r.error); }
  $('status').textContent = '';
  return JSON.parse(r.data);
}

const frame = () => frames[viewIndex];
const atLive = () => viewIndex === frames.length - 1;

// ---- avanço / reprodução -------------------------------------------------
async function advance() {
  if (viewIndex < frames.length - 1) {
    viewIndex++;                       // reproduz frames gravados
  } else {
    const prev = frames[frames.length - 1];
    const s = await sim('step');       // avança a simulação (Lua)
    frames.push(s);
    if (frames.length > MAX_FRAMES) frames.shift();
    viewIndex = frames.length - 1;
    spawnFloaters(prev, s);
  }
  render();
}
function schedule() {
  if (!playing) return;
  const fps = parseInt($('speed').value, 10);
  timer = setTimeout(async () => { try { await advance(); } catch (e) {} schedule(); }, Math.max(33, 1000 / fps));
}
function play() { if (playing) return; playing = true; updatePlayBtn(); schedule(); }
function stop() { playing = false; updatePlayBtn(); if (timer) { clearTimeout(timer); timer = null; } }
function togglePlay() { playing ? stop() : play(); }
function updatePlayBtn() { const b = $('btnPlay'); b.textContent = playing ? '⏸' : '▶'; b.classList.toggle('active', playing); }

function stepFwd() { if (!atLive()) { viewIndex++; render(); } else advance(); }
function stepBack() { stop(); if (viewIndex > 0) { viewIndex--; render(); } }
function jumpLive() { viewIndex = frames.length - 1; render(); }
function jumpStart() { stop(); viewIndex = 0; render(); }

// Habilita/desabilita o seletor de tipo base conforme o homún (S precisa de base).
// Síncrono e independente do load, para não depender de ordem assíncrona.
function syncBaseUI() {
  const homunSel = $('homun'), baseSel = $('base');
  if (!homunSel || !baseSel) return 4;
  const t = parseInt(homunSel.value, 10) || 4;
  const isS = S_TYPES.includes(t);
  baseSel.disabled = !isS;
  if (!isS) baseSel.value = '0';
  const h = SCENARIO.entities.find(e => e.kind === 'homun');
  if (h) h.homunType = t;
  const lvlEl = $('homunLvl');
  if (h && lvlEl) h.lvl = parseInt(lvlEl.value, 10) || 250;   // SÓ no sim: decide skills aprendidas
  SCENARIO.config = Object.assign({}, SCENARIO.config, { BaseHomunType: isS ? (parseInt(baseSel.value, 10) || 0) : 0 });
  return t;
}
async function loadScenario() { stop(); syncBaseUI(); const s = await sim('load', SCENARIO); try { await sim('setMonsters', monCatalog); } catch (e) {} try { await sim('setSkillChoice', skillChoice); } catch (e) {} try { await sim('setSkillParams', skillParams); } catch (e) {} try { await sim('setSummonChoice', summonCfg); } catch (e) {} frames = [s]; viewIndex = 0; sel = null; renderEntityPanel(); render(); }
async function resetScenario() { stop(); const s = await sim('reset'); frames = [s]; viewIndex = 0; sel = null; renderEntityPanel(); render(); }

// ---- cenários salvos (scenarios/<nome>.json) -----------------------------
// Captura o estado ATUAL (frame ao vivo) como cenário inicial reutilizável.
function captureScenario(srcFrame) {
  const f = srcFrame || frames[frames.length - 1] || frame();
  const src = (f && f.entities) ? f.entities : SCENARIO.entities;
  const ents = [];
  for (const e of src) {
    if (e.motion === MOTION.DEAD) continue;
    const o = { id: e.id, kind: e.kind, x: e.x, y: e.y, hp: e.hp, maxhp: e.maxhp };
    if (e.sp != null) o.sp = e.sp;
    if (e.maxsp != null) o.maxsp = e.maxsp;
    if (e.atk != null) o.atk = e.atk;          // ATK (físico) — homún e monstro
    if (e.matk != null) o.matk = e.matk;       // MATK (mágico) — homún
    if (e.kind === 'homun') o.homunType = parseInt($('homun').value, 10) || 4;
    if (e.kind === 'monster') {
      o.aggro = e.aggro; o.atkInterval = e.atkInterval;
      o.aggressive = e.aggressive !== false;
      if (e.etype != null) o.etype = e.etype;  // classe/ID do monstro (V_TYPE) — p/ monsterCheck
      if (e.boss) o.boss = true;               // preserva flag de Boss/MVP no round-trip
    }
    ents.push(o);
  }
  return {
    grid: SCENARIO.grid, dt: SCENARIO.dt, homunId: SCENARIO.homunId, ownerId: SCENARIO.ownerId,
    config: SCENARIO.config || {},
    homunType: parseInt($('homun').value, 10) || 4,
    baseType: parseInt($('base').value, 10) || 0,
    entities: ents,
  };
}
// cenário p/ ARQUIVO: mantém os STATS (HP/SP/ATK/MATK) e a posição do homúnculo, mas remove o
// TIPO do homún (homunType/baseType/config.BaseHomunType). O tipo é a seleção da SESSÃO (seletor
// homún/base), não do cenário — assim o mesmo cenário serve p/ qualquer tipo de homúnculo.
function stripHomunType(e) { const o = {}; for (const k in e) if (k !== 'homunType') o[k] = e[k]; return o; }
function scenarioForFile(scn) {
  const out = {};
  for (const k in scn) out[k] = scn[k];
  out.entities = (scn.entities || []).map(e => (e.kind === 'homun' ? stripHomunType(e) : e));
  delete out.homunType; delete out.baseType;
  if (out.config) { const c = {}; for (const k in out.config) if (k !== 'BaseHomunType') c[k] = out.config[k]; out.config = c; }
  return out;
}
async function refreshScenarioList() {
  try {
    const r = await window.scenarios.list();
    if (!r.ok) return;
    const cur = $('scnList').value;
    $('scnList').innerHTML = '<option value="">— cenários —</option>' +
      r.data.map(n => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  } catch (e) {}
}
async function saveScenario() {
  const name = ($('scnName').value || '').trim();
  if (!name) { $('status').textContent = 'Dê um nome ao cenário.'; return; }
  const r = await window.scenarios.save(name, JSON.stringify(scenarioForFile(captureScenario()), null, 2));
  if (!r.ok) { showError('salvar cenário: ' + r.error); return; }
  $('scnName').value = r.name;
  await refreshScenarioList();
  $('scnList').value = r.name;
  $('status').textContent = 'Cenário salvo: scenarios/' + r.name + '.json';
}
async function loadScenarioFile() {
  const name = $('scnList').value;
  if (!name) { $('status').textContent = 'Escolha um cenário salvo na lista.'; return; }
  const r = await window.scenarios.load(name);
  if (!r.ok) { showError('carregar cenário: ' + r.error); return; }
  let scn; try { scn = JSON.parse(r.data); } catch (e) { showError('cenário inválido: ' + e.message); return; }
  SCENARIO.grid = scn.grid || SCENARIO.grid;
  SCENARIO.dt = scn.dt || SCENARIO.dt;
  SCENARIO.homunId = scn.homunId || SCENARIO.homunId;
  SCENARIO.ownerId = scn.ownerId || SCENARIO.ownerId;
  SCENARIO.config = scn.config || {};
  if (Array.isArray(scn.entities)) SCENARIO.entities = scn.entities;   // mantém stats/posição do mundo
  // IGNORA o TIPO do homúnculo do arquivo: o tipo vem do seletor ATUAL da sessão — syncBaseUI
  // (em loadScenario) aplica o tipo do seletor no homún. Não sobrescreve os seletores pelo arquivo.
  $('scnName').value = name;
  await loadScenario();
  $('status').textContent = 'Cenário carregado: ' + name;
}

// ---- desenho -------------------------------------------------------------
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
const cell = () => canvas.width / SCENARIO.grid.w;

function colorFor(e) {
  if (e.motion === MOTION.DEAD) return '#444b53';
  if (e.kind === 'owner') return css('--blue');
  if (e.kind === 'homun') return css('--green');
  if (e.kind === 'ally') return '#a371f7';
  if (e.state === 'passivo') return '#6e7681';   // monstro passivo
  if (e.state === 'provocado') return css('--run'); // provocado
  return css('--red');                            // agressivo
}
function labelFor(e) { return e.kind === 'owner' ? 'D' : e.kind === 'homun' ? 'H' : e.kind === 'ally' ? 'A' : 'M'; }
// cor da barra de HP por fração (verde > amarelo > vermelho)
function hpColor(frac) { return frac > 0.5 ? '#3fb950' : frac > 0.25 ? '#d29922' : '#f85149'; }
// desenha barras de HP (e SP) acima da entidade
function drawBars(e, cx, cy, c) {
  const w = Math.max(10, c * 0.9), x0 = cx - w / 2;
  let y = cy - c * 0.74;
  if (e.maxhp) {
    const frac = Math.max(0, Math.min(1, e.hp / e.maxhp));
    ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(x0 - 1, y - 1, w + 2, 5);
    ctx.fillStyle = e.motion === MOTION.DEAD ? '#444b53' : hpColor(frac);
    ctx.fillRect(x0, y, w * frac, 3);
    y += 5;
  }
  if (e.maxsp) {
    const frac = Math.max(0, Math.min(1, e.sp / e.maxsp));
    ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(x0 - 1, y - 1, w + 2, 4);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(x0, y, w * frac, 2);
  }
}

function draw(f) {
  const c = cell();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1c232c'; ctx.lineWidth = 1;
  for (let i = 0; i <= SCENARIO.grid.w; i++) {
    ctx.beginPath(); ctx.moveTo(i * c, 0); ctx.lineTo(i * c, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * c); ctx.lineTo(canvas.width, i * c); ctx.stroke();
  }
  const homun = f.entities.find(e => e.id === SCENARIO.homunId);

  // alcance de aggro do monstro selecionado (quadrado de Chebyshev)
  if (sel != null) {
    const m = f.entities.find(e => e.id === sel && e.kind === 'monster');
    if (m && m.aggro) {
      const half = (m.aggro + 0.5) * c, mx = (m.x + 0.5) * c, my = (m.y + 0.5) * c;
      ctx.strokeStyle = '#f8514955'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.strokeRect(mx - half, my - half, half * 2, half * 2);
      ctx.setLineDash([]);
    }
  }

  // skills de área no solo (lingering)
  for (const fx of (f.ground || [])) {
    const half = Math.floor(fx.size / 2), side = fx.size * c;
    const x0 = (fx.x - half) * c, y0 = (fx.y - half) * c, col = colorForSkill(fx.skill);
    ctx.fillStyle = col + '2e'; ctx.fillRect(x0, y0, side, side);
    ctx.strokeStyle = col + '99'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, side, side);
  }

  // intenção de movimento
  if (f.intent && f.intent.kind === 'move' && homun) {
    ctx.strokeStyle = '#3b4a59'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo((homun.x + 0.5) * c, (homun.y + 0.5) * c);
    ctx.lineTo((f.intent.x + 0.5) * c, (f.intent.y + 0.5) * c);
    ctx.stroke(); ctx.setLineDash([]);
  }
  // linhas de ameaça: monstro que mira no homún/dono (sutil, tracejada)
  for (const e of f.entities) {
    if (e.kind === 'monster' && e.target && e.motion !== MOTION.DEAD) {
      const t = f.entities.find(x => x.id === e.target);
      if (t && (t.kind === 'homun' || t.kind === 'owner' || t.kind === 'ally')) {
        ctx.strokeStyle = '#f8514944'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo((e.x + 0.5) * c, (e.y + 0.5) * c); ctx.lineTo((t.x + 0.5) * c, (t.y + 0.5) * c); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  // ataques em andamento (linha vermelha sólida do atacante ao alvo)
  for (const e of f.entities) {
    if ((e.motion === MOTION.ATTACK || e.motion === MOTION.SKILL) && e.target) {
      const t = f.entities.find(x => x.id === e.target);
      if (t) {
        ctx.strokeStyle = '#f85149dd'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo((e.x + 0.5) * c, (e.y + 0.5) * c); ctx.lineTo((t.x + 0.5) * c, (t.y + 0.5) * c); ctx.stroke();
      }
    }
  }
  // entidades
  for (const e of f.entities) {
    if (e.kind === 'summon') continue;   // insetos: desenhados em drawSeraLegionOverlay
    const cx = (e.x + 0.5) * c, cy = (e.y + 0.5) * c;
    const isTarget = (e.id === f.target && e.motion !== MOTION.DEAD);
    const isSel = (e.id === sel);
    // anel de alvo atual (amarelo) ou de seleção (branco translúcido)
    if (isTarget) {
      ctx.strokeStyle = '#f0c000'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, c * 0.52, 0, Math.PI * 2); ctx.stroke();
    } else if (isSel) {
      ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(cx, cy, c * 0.52, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = colorFor(e);
    ctx.beginPath(); ctx.arc(cx, cy, c * 0.38, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0d1117'; ctx.font = `bold ${Math.floor(c * 0.42)}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(labelFor(e), cx, cy + 0.5);
    // barras: homún/dono/aliado sempre; monstro só quando é o alvo (ou selecionado p/ inspeção)
    const showBars = (e.kind !== 'monster') || isTarget || isSel || showAllHp;
    if (showBars) drawBars(e, cx, cy, c);
  }
  drawFloaters(c);
  drawEleanorOverlay(f, c);
  drawSeraLegionOverlay(f, c);
}

const _KIND_COLOR = { selector: '#4d8fd6', sequence: '#4d8fd6', parallel: '#4d8fd6', inverter: '#c79a3a', succeeder: '#c79a3a', cooldown: '#c79a3a', limiter: '#c79a3a', check: '#a974e6', monsterCheck: '#d76aa0', condition: '#4aa3e0', action: '#46c46a' };
function renderTree(f) {
  const t = f.tree || [];
  $('tree').innerHTML = t.map((n, i) => ({ n: n, i: i })).filter((x) => !x.n.off).map(({ n, i }) => {
    const pad = 6 + n.depth * 14;
    // filho sintético de skill (PLANO-SKILLS-NO-NO): lista a skill da ação; acende a usada no
    // tick (active); estados none/missing viram aviso discreto.
    if (n.kind === 'skillRef') {
      let scls = 'tnode tn-skill';
      const warn = (n.skillState === 'none' || n.skillState === 'missing');
      if (n.active) scls += ' tn-skill-on';
      if (warn) scls += ' tn-skill-warn';
      return '<div class="' + scls + '" data-idx="' + i + '" style="padding-left:' + pad + 'px">' +
        '<span class="tn-skill-mark">' + (warn ? '\u26a0' : '\u2726') + '</span>' +
        '<span class="tn-lbl">' + esc(n.label) + '</span></div>';
    }
    let cls = n.status ? 's-' + n.status : 's-none';
    if (n.kind === 'action' && n.status === 'failure') cls += ' act-fail';
    // ação cuja skill está ausente/não selecionada: destaque sutil no nó
    if (n.kind === 'action' && (n.skillState === 'none' || n.skillState === 'missing')) cls += ' tn-needs-skill';
    const dotcls = n.status === 'running' ? 'tn-run' : n.status === 'success' ? 'tn-ok'
      : n.status === 'failure' ? (n.kind === 'action' ? 'tn-fail' : 'tn-no') : 'tn-none';
    const bar = _KIND_COLOR[n.kind] || '#5b6770';
    return '<div class="tnode ' + cls + '" data-idx="' + i + '" style="padding-left:' + pad + 'px">' +
      '<span class="tn-dot ' + dotcls + '"></span>' +
      '<span class="tn-bar" style="background:' + bar + '"></span>' +
      '<span class="tn-lbl">' + esc(n.label) + '</span></div>';
  }).join('');
}

function explainNode(n) {
  if (!n) return '';
  if (n.kind === 'skillRef') {
    if (n.skillState === 'missing') return 'Este tipo de hom\u00fanculo n\u00e3o tem skill para este papel \u2014 a a\u00e7\u00e3o \u00e9 ignorada.';
    if (n.skillState === 'none') return 'Nenhuma skill selecionada para este papel \u2014 a a\u00e7\u00e3o n\u00e3o ser\u00e1 usada. Configure na tela \u201cSkills por hom\u00fanculo\u201d.';
    return n.active ? '\u2726 Skill em uso neste tick.' : '\u2726 Skill configurada para esta a\u00e7\u00e3o.';
  }
  const k = n.kind, st = n.status;
  if (st === 'success') return '✓ Deu certo neste tick.';
  if (st === 'running') return '▶ Está executando agora.';
  if (st === 'failure') {
    if (k === 'action') return '✗ A ação tentou e falhou (alvo fora de alcance, sem SP, em recarga…). Veja o log abaixo.';
    if (k === 'check' || k === 'condition') return 'Condição falsa — fluxo normal: a árvore segue para a próxima opção.';
    if (k === 'monsterCheck') return 'O alvo não é o monstro/grupo escolhido (ou não há alvo).';
    return 'Falhou — a árvore segue para a próxima opção.';
  }
  return 'Não avaliado neste tick: uma opção de prioridade mais alta já resolveu antes.';
}
function showTreeTip(x, y, n) {
  let t = document.getElementById('treetip');
  if (!t) { t = document.createElement('div'); t.id = 'treetip'; document.body.appendChild(t); }
  const kindTxt = (n.kind === 'skillRef') ? 'skill' : (n.kind || '');
  let extra = '';
  if (n.kind === 'action' && n.skillState === 'missing') extra = '<div class="tt-skill tt-skill-missing">\u26a0 Este hom\u00fanculo n\u00e3o tem skill para este papel \u2014 a a\u00e7\u00e3o \u00e9 ignorada.</div>';
  else if (n.kind === 'action' && n.skillState === 'none') extra = '<div class="tt-skill tt-skill-none">\u26a0 Nenhuma skill selecionada \u2014 a a\u00e7\u00e3o n\u00e3o ser\u00e1 usada. Configure em \u201cSkills por hom\u00fanculo\u201d.</div>';
  t.innerHTML = '<div class="tt-title">' + esc(n.label) + (n.name ? ' <span class="tt-code">' + esc(n.name) + '</span>' : '') + ' <span class="tt-kind">' + esc(kindTxt) + '</span></div>' + extra + '<div class="tt-exp">' + esc(explainNode(n)) + '</div>';
  t.style.display = 'block';
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.min(x + 12, window.innerWidth - w - 8) + 'px';
  t.style.top = Math.min(y + 12, window.innerHeight - h - 8) + 'px';
}
function bar(kind, pct) {
  return `<div class="bar"><i class="${kind}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
}
function renderBB(f) {
  const bb = f.bb;
  if (!bb) { $('bb').innerHTML = '<span class="muted">—</span>'; return; }
  const it = f.intent ? `${f.intent.kind}${f.intent.reason ? ' · ' + f.intent.reason : ''}` : '—';
  const flags = [];
  flags.push(`<span class="chip ${bb.flags.berserk ? 'on' : ''}">berserk</span>`);
  flags.push(`<span class="chip ${bb.flags.standby ? 'on' : ''}">standby</span>`);
  $('bb').innerHTML = `
    <div class="bbrow"><span class="k">HP ${Math.round(bb.self.hpPct)}%</span>${bar('hp', bb.self.hpPct)}</div>
    <div class="bbrow"><span class="k">SP ${Math.round(bb.self.spPct)}%</span>${bar('sp', bb.self.spPct)}</div>
    <div class="bbrow"><span class="k">HP dono ${bb.owner.exists && bb.owner.hpPct != null ? Math.round(bb.owner.hpPct) + '%' : '—'}</span>${bb.owner.exists && bb.owner.hpPct != null ? bar('hp', bb.owner.hpPct) : ''}</div>
    <div class="bbrow"><span class="k">dist. dono</span><span>${bb.owner.exists ? bb.owner.dist : '—'} (limite ${bb.config.MoveBounds})</span></div>
    <div class="bbrow"><span class="k">monstros</span><span>${bb.monsters} · AggroDist ${bb.config.AggroDist}</span></div>
    <div class="bbrow"><span class="k">alvo</span><span>${f.target || '—'}</span></div>
    <div class="bbrow"><span class="k">intenção</span><span>${esc(it)}</span></div>
    <div class="bbrow"><span class="k">flags</span><span>${flags.join(' ')}</span></div>`;
}

function elOrbsHtml(spheres, max) {
  max = max || 10;
  const full = Math.floor(spheres + 1e-9), half = (spheres - full) >= 0.5 - 1e-9;
  let h = '<div class="el-orbs">';
  for (let i = 0; i < max; i++) h += '<i class="el-orb ' + (i < full ? 'full' : (i === full && half ? 'half' : 'empty')) + '"></i>';
  return h + '</div>';
}
function renderEleanor(f) {
  const panel = $('eleanorPanel'), el = f.eleanor;
  if (!el) { if (panel) panel.style.display = 'none'; return; }
  if (panel) panel.style.display = '';
  const active = eleanorActiveStep(f);
  const chain = eleanorChains[el.style] || eleanorChains.power;
  const styleCls = el.style === 'grapple' ? 'grapple' : 'power';
  let h = '<div class="el-row"><span class="el-badge el-' + styleCls + '">' + esc(EL_STYLE_LABEL[el.style] || el.style) + '</span>' +
    (el.rooted ? '<span class="el-badge el-rooted">⚓ Flee 0 (enraizada)</span>' : '') + '</div>';
  h += '<div class="el-row el-sphwrap">' + elOrbsHtml(el.spheres || 0, 10) +
    '<span class="el-sphnum">' + (Math.round((el.spheres || 0) * 10) / 10).toFixed(1) + ' / 10</span></div>';
  h += '<div class="el-hint">esferas estimadas (a API do cliente não expõe a contagem)</div>';
  h += '<div class="el-chain">';
  chain.forEach((lk, i) => {
    if (i > 0) h += '<span class="el-arrow">→</span>';
    let st = 'pend';
    if (active > 0) st = (i < active - 1) ? 'done' : (i === active - 1 ? 'cur' : 'next');
    h += '<span class="el-step ' + st + (lk.bossForbidden ? ' el-boss' : '') + '"><b>' + esc(lk.iro) +
      '</b><span class="el-cost">💠 ' + lk.cost + (lk.bossForbidden ? ' · ⊘ boss' : '') + '</span></span>';
  });
  h += '</div>';
  $('eleanor').innerHTML = h;
}
function drawEleanorOverlay(f, c) {
  const el = f.eleanor; if (!el) return;
  const homun = f.entities.find(e => e.id === SCENARIO.homunId);
  if (!homun || homun.motion === MOTION.DEAD) return;
  const cx = (homun.x + 0.5) * c, cy = (homun.y + 0.5) * c;
  if (el.rooted) { ctx.strokeStyle = '#e0556e'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(cx, cy, c * 0.58, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
  const max = 10, full = Math.floor(el.spheres + 1e-9), half = (el.spheres - full) >= 0.5 - 1e-9;
  const r = Math.max(2, c * 0.06), gap = r * 2.1, ox = cx - (max - 1) * gap / 2, oy = cy - c * 0.62;
  for (let i = 0; i < max; i++) {
    const x = ox + i * gap;
    ctx.beginPath(); ctx.arc(x, oy, r, 0, Math.PI * 2);
    if (i < full) { ctx.fillStyle = '#4fd2e0'; ctx.fill(); }
    else if (i === full && half) { ctx.globalAlpha = 0.45; ctx.fillStyle = '#4fd2e0'; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = '#4fd2e088'; ctx.lineWidth = 1; ctx.stroke(); }
    else { ctx.strokeStyle = '#3a4a55'; ctx.lineWidth = 1; ctx.stroke(); }
  }
  const chain = eleanorChains[el.style] || eleanorChains.power, active = eleanorActiveStep(f);
  const pgap = c * 0.22, px = cx - (chain.length - 1) * pgap / 2, py = oy - r - c * 0.18;
  const col = el.style === 'grapple' ? '#e0894f' : '#e0c64f';
  for (let i = 0; i < chain.length; i++) {
    const x = px + i * pgap;
    ctx.beginPath(); ctx.arc(x, py, c * 0.05, 0, Math.PI * 2);
    if (active > 0 && i < active) { ctx.fillStyle = col; ctx.fill(); }
    else { ctx.strokeStyle = col + '99'; ctx.lineWidth = 1.3; ctx.stroke(); }
  }
}
function legionPipsHtml(count, max, color) {
  let h = '<div class="lg-pips">';
  for (let i = 0; i < (max || 0); i++) {
    h += '<i class="lg-pip ' + (i < count ? 'full' : 'empty') + '"' + (i < count ? ' style="background:' + color + ';border-color:' + color + ';color:' + color + '"' : '') + '></i>';
  }
  return h + '</div>';
}
function renderSera(f) {
  const panel = $('seraPanel'), sr = f.sera;
  if (!sr) { if (panel) panel.style.display = 'none'; return; }
  if (panel) panel.style.display = '';
  const tier = summonTier(sr.tier);
  const fracDur = sr.total > 0 ? Math.max(0, Math.min(1, sr.remaining / sr.total)) : 0;
  let h = '<div class="lg-row"><span class="lg-badge" style="background:' + tier.color + '22;border-color:' + tier.color + ';color:' + tier.color + '">' + esc(sr.tier) + ' · Lv' + sr.level + '</span>';
  h += sr.active ? '<span class="lg-badge lg-on">ativa</span>'
    : (sr.resummonReady ? '<span class="lg-badge lg-ready">pronta p/ invocar</span>' : '<span class="lg-badge lg-off">sem SP/alvo</span>');
  h += '</div>';
  h += '<div class="lg-row lg-pipwrap">' + legionPipsHtml(sr.count, sr.max, tier.color) + '<span class="lg-num">' + sr.count + ' / ' + sr.max + '</span></div>';
  h += '<div class="lg-row"><div class="lg-ring" title="janela de duração da legião"><i style="width:' + (fracDur * 100).toFixed(1) + '%;background:' + tier.color + '"></i></div><span class="lg-time">' + fmtTime(sr.remaining || 0) + '</span></div>';
  h += '<div class="lg-hint">legião estimada — o cliente não expõe a contagem nem o dono dos atores</div>';
  let agg = 0, n = 0;
  for (const m of (sr.members || [])) { agg += (m.hpPct || 0); n++; }
  const avgHp = n ? Math.round(agg / n) : 0;
  h += '<div class="lg-stats"><span>🐝 ' + sr.count + ' vivos</span><span>HP médio ' + avgHp + '%</span><span>dano total ' + (sr.damageDealt || 0) + '</span></div>';
  $('sera').innerHTML = h;
}
function drawSeraLegionOverlay(f, c) {
  const sr = f.sera; if (!sr) return;
  const homun = f.entities.find(e => e.id === SCENARIO.homunId);
  if (!homun || homun.motion === MOTION.DEAD) return;
  const cx = (homun.x + 0.5) * c, cy = (homun.y + 0.5) * c;
  if (sr.active && sr.total > 0) {
    const frac = Math.max(0, Math.min(1, sr.remaining / sr.total)), tier = summonTier(sr.tier);
    ctx.strokeStyle = '#2a3038'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, c * 0.62, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = tier.color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, c * 0.62, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
  }
  for (const m of (sr.members || [])) {
    const mx = (m.x + 0.5) * c, my = (m.y + 0.5) * c, tier = summonTierByMob(m.mob);
    const ttlFrac = sr.total > 0 ? Math.max(0.3, Math.min(1, (m.ttl || 0) / sr.total)) : 1;
    if (m.target) {
      const t = f.entities.find(e => e.id === m.target);
      if (t) {
        ctx.globalAlpha = 0.35 * ttlFrac; ctx.strokeStyle = tier.color; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo((t.x + 0.5) * c, (t.y + 0.5) * c); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
    const r = Math.max(2, c * 0.16);
    ctx.globalAlpha = ttlFrac; ctx.fillStyle = tier.color;
    ctx.beginPath(); ctx.moveTo(mx, my - r); ctx.lineTo(mx + r, my); ctx.lineTo(mx, my + r); ctx.lineTo(mx - r, my); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    if (m.hpPct != null && m.hpPct < 100) {
      const w = c * 0.34, x0 = mx - w / 2, y = my - r - 4;
      ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(x0 - 1, y - 1, w + 2, 4);
      ctx.fillStyle = hpColor(m.hpPct / 100); ctx.fillRect(x0, y, w * m.hpPct / 100, 2);
    }
  }
}
function renderHUD() {
  const live = atLive();
  $('hud').innerHTML =
    `<span class="badge ${live ? 'live' : 'replay'}">${live ? 'AO VIVO' : 'REPLAY'}</span>` +
    `<span>tick ${frame().tick}</span>`;
  $('timeline').max = String(Math.max(0, frames.length - 1));
  $('timeline').value = String(viewIndex);
  $('frameLbl').textContent = `${viewIndex + 1} / ${frames.length}`;
}
function fmtTime(ms) { const v = ms / 1000; if (v >= 60) { const m = v / 60; return (Number.isInteger(m) ? m : m.toFixed(1)) + 'min'; } return (Number.isInteger(v) ? v : v.toFixed(1)) + 's'; }
function skRow(item, cls) {
  const frac = item.total ? Math.max(0, Math.min(1, item.remaining / item.total)) : 0;
  return '<div class="sk-row"><span class="sk-name">' + esc(item.name) + '</span>' +
    '<div class="sk-bar"><i class="' + cls + '" style="width:' + (frac * 100).toFixed(1) + '%"></i></div>' +
    '<span class="sk-time">' + fmtTime(item.remaining) + '</span></div>';
}
function gndRow(item) {
  const frac = item.total ? Math.max(0, Math.min(1, item.remaining / item.total)) : 0;
  const col = colorForSkill(item.skill);
  return '<div class="sk-row"><span class="sk-swatch" style="background:' + col + '"></span>' +
    '<span class="sk-name">' + esc(item.name) + '</span>' +
    '<div class="sk-bar"><i style="width:' + (frac * 100).toFixed(1) + '%;background:' + col + '"></i></div>' +
    '<span class="sk-time">' + fmtTime(item.remaining) + '</span></div>';
}
function renderSkills(f) {
  const sk = f.skills || { cooldowns: [], buffs: [] };
  const buffIds = new Set((sk.buffs || []).map(b => b.skill));
  const cds = (sk.cooldowns || []).filter(c => !buffIds.has(c.skill));
  let html = '';
  html += (sk.buffs || []).map(b => skRow(b, 'sk-fill-buff')).join('');
  html += cds.map(c => skRow(c, 'sk-fill-cd')).join('');
  html += (f.ground || []).map(g => gndRow(g)).join('');
  $('skills').innerHTML = html || '<span class="muted">—</span>';
}
function renderLog() {
  const lines = [];
  const start = Math.max(0, viewIndex - 400);
  for (let i = start; i <= viewIndex; i++) {
    const fr = frames[i];
    if (fr && fr.log && fr.log.length) for (const l of fr.log) lines.push('[' + fr.tick + '] ' + l);
  }
  const el = $('log');
  // linhas de falha (prefixo [FALHA]) saem destacadas em vermelho
  el.innerHTML = lines.slice(-30).map(l =>
    '<span class="logline' + (l.indexOf('[FALHA]') >= 0 ? ' logfail' : '') + '">' + esc(l) + '</span>'
  ).join('\n');
  el.scrollTop = el.scrollHeight;
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function render() { const f = frame(); if (!f) return; draw(f); renderTree(f); renderBB(f); renderEleanor(f); renderSera(f); renderSkills(f); renderHUD(); renderLog();
  if (sel != null) { const m = f.entities.find(e => e.id === sel); const el = $('mpState'); if (m && el) el.textContent = 'estado: ' + (m.state || '-'); }
  refreshTooltip(); }

// ---- interação -----------------------------------------------------------
// ---- interação: arrastar/criar/editar monstros + mover o dono ------------
let down = null;
function cellFromEvent(ev) {
  const rect = canvas.getBoundingClientRect(), c = cell();
  return { gx: Math.floor((ev.clientX - rect.left) / c), gy: Math.floor((ev.clientY - rect.top) / c) };
}
function entityAt(f, gx, gy) {
  // homúnculo, dono e monstros são todos arrastáveis/editáveis
  return f.entities.find(e => (e.kind === 'monster' || e.kind === 'owner' || e.kind === 'homun' || e.kind === 'ally') && e.x === gx && e.y === gy && e.motion !== MOTION.DEAD);
}

// ---- tooltip rico no hover (atualiza em tempo real via render) ------------
const HOMUN_NAMES = { 1: 'Lif', 2: 'Amistr', 3: 'Filir', 4: 'Vanilmirth', 48: 'Eira', 49: 'Bayeri', 50: 'Sera', 51: 'Dieter', 52: 'Eleanor' };
let hoverCell = null;            // célula sob o cursor (coords de grid)
let mouseXY = { x: 0, y: 0 };    // posição do cursor (cliente) p/ posicionar
let tipEl = null;
function tipDom() { if (!tipEl) { tipEl = document.createElement('div'); tipEl.id = 'enttip'; tipEl.style.display = 'none'; document.body.appendChild(tipEl); } return tipEl; }
function pctOf(cur, max) { return max > 0 ? Math.round((Math.max(0, cur) / max) * 100) : 0; }
function ttRow(k, v) { return '<div class="tt-r"><span>' + esc(k) + '</span><span>' + esc(String(v)) + '</span></div>'; }
function ttBar(k, cur, max, col) {
  const p = pctOf(cur, max);
  return '<div class="tt-r"><span>' + k + '</span><span>' + Math.max(0, Math.round(cur || 0)) + ' / ' + Math.round(max || 0) + ' (' + p + '%)</span></div>' +
         '<div class="tt-bar"><i style="width:' + p + '%;background:' + col + '"></i></div>';
}
function tooltipHtml(e) {
  let title, sub = '';
  if (e.kind === 'homun') { title = 'Homúnculo'; sub = HOMUN_NAMES[e.homunType] || ('tipo ' + (e.homunType || 0)); }
  else if (e.kind === 'owner') { title = 'Dono'; }
  else if (e.kind === 'ally') { title = 'Aliado'; }
  else { title = 'Monstro'; const m = monByType(e.etype); sub = m ? (m.desc || ('#' + e.etype)) : ('classe #' + (e.etype || 0)); }
  let rows = ttRow('ID', '#' + e.id);
  if (e.kind === 'monster') { const m = monByType(e.etype); rows += ttRow('Classe', '#' + (e.etype || 0) + (m && m.desc ? ' · ' + m.desc : '')); }
  if (e.kind === 'homun') rows += ttRow('Tipo', HOMUN_NAMES[e.homunType] || ('tipo ' + (e.homunType || 0)));
  rows += ttBar('HP', e.hp, e.maxhp, '#3fb950');
  rows += ttBar('SP', e.sp, e.maxsp, '#3b82f6');
  if (e.kind === 'homun') rows += ttRow('ATK / MATK', (e.atk || 0) + ' / ' + (e.matk || 0));
  if (e.kind === 'monster' && e.state) rows += ttRow('Estado', e.state);
  if (e.kind === 'monster' && e.status) rows += ttRow('Status', e.status);
  return '<div class="tt-h"><b>' + esc(title) + '</b>' + (sub ? ' <span class="tt-sub">' + esc(String(sub)) + '</span>' : '') + '</div>' + rows;
}
function refreshTooltip() {
  const t = tipDom();
  const f = hoverCell && frame();
  const e = f ? entityAt(f, hoverCell.gx, hoverCell.gy) : null;
  if (!e) { t.style.display = 'none'; return; }
  t.innerHTML = tooltipHtml(e);
  t.style.display = 'block';
  const pad = 14; let x = mouseXY.x + pad, y = mouseXY.y + pad;
  const w = t.offsetWidth, h = t.offsetHeight;
  if (x + w > window.innerWidth - 4) x = mouseXY.x - w - pad;
  if (x < 4) x = 4;
  if (y + h > window.innerHeight - 4) y = window.innerHeight - h - 4;
  if (y < 4) y = 4;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
canvas.addEventListener('mousemove', (ev) => {
  mouseXY = { x: ev.clientX, y: ev.clientY };
  if (down && down.ent) { hoverCell = null; refreshTooltip(); return; }  // arrastando: sem tooltip
  const { gx, gy } = cellFromEvent(ev);
  hoverCell = { gx, gy };
  refreshTooltip();
});
canvas.addEventListener('mouseleave', () => { hoverCell = null; refreshTooltip(); });
async function simLive(method, obj) { const s = await sim(method, obj); frames[frames.length - 1] = s; viewIndex = frames.length - 1; return s; }

canvas.addEventListener('mousedown', (ev) => {
  if (!atLive()) { jumpLive(); return; }
  const { gx, gy } = cellFromEvent(ev);
  const ent = entityAt(frame(), gx, gy);
  down = { gx, gy, ent: ent || null, moved: false };
});
document.addEventListener('mousemove', (ev) => {
  if (!down || !down.ent) return;
  const { gx, gy } = cellFromEvent(ev);
  const nx = Math.max(0, Math.min(SCENARIO.grid.w - 1, gx)), ny = Math.max(0, Math.min(SCENARIO.grid.h - 1, gy));
  if (nx !== down.ent.x || ny !== down.ent.y) { down.moved = true; down.ent.x = nx; down.ent.y = ny; render(); }
});
document.addEventListener('mouseup', async (ev) => {
  if (!down) return;
  const d = down; down = null;
  if (d.ent) {
    if (d.moved) {                                   // arrastou: reposiciona a entidade
      await simLive('moveEntity', { id: d.ent.id, x: d.ent.x, y: d.ent.y });
      sel = d.ent.id; renderEntityPanel(); render();
    } else {                                         // clique simples: seleciona p/ editar
      sel = d.ent.id; renderEntityPanel();
    }
  } else {
    sel = null; renderEntityPanel();                 // clique em célula vazia: desmarca
  }
});

async function newMonster() {
  if (!atLive()) jumpLive();
  const h = frame().entities.find(e => e.kind === 'homun') || { x: 20, y: 20 };
  await simLive('addMonster', { x: Math.min(SCENARIO.grid.w - 1, h.x + 4), y: h.y, hp: 300, atk: 6, atkInterval: 1000, aggressive: true });
  let id = null; for (const e of frame().entities) if (e.kind === 'monster') id = (id == null ? e.id : Math.max(id, e.id));
  sel = id; renderEntityPanel(); render();
}

function renderEntityPanel() {
  const el = $('monpanel');
  if (sel == null) { el.innerHTML = ''; return; }
  const e = frame().entities.find(x => x.id === sel);
  if (!e) { sel = null; el.innerHTML = ''; return; }
  if (e.kind === 'monster') return renderMonsterPanel(e, el);
  if (e.kind === 'homun') return renderHomunPanel(e, el);
  if (e.kind === 'owner') return renderOwnerPanel(e, el);
  if (e.kind === 'ally') return renderAllyPanel(e, el);
  el.innerHTML = '';
}

function renderMonsterPanel(m, el) {
  el.innerHTML =
    '<div class="mp-title">Monstro #' + m.id + '</div>' +
    '<label>HP <input id="mpHp" type="number" min="1" value="' + (m.maxhp || m.hp) + '"></label>' +
    '<label>Ataque <input id="mpAtk" type="number" min="0" value="' + (m.atk || 0) + '"></label>' +
    '<label>Intervalo (s) <input id="mpInt" type="number" min="0.05" step="0.05" value="' + ((m.atkInterval || 1000) / 1000) + '"></label>' +
    '<label>Alcance <input id="mpAggro" type="number" min="1" value="' + (m.aggro || 10) + '"></label>' +
    '<label><input id="mpAgg" type="checkbox" ' + (m.aggressive ? 'checked' : '') + '> agressivo</label>' +
    '<label>Classe (ID) <input id="mpType" type="number" min="0" value="' + (m.etype || 0) + '" title="ID da classe do monstro (V_TYPE); usado pelos nós monsterCheck"></label>' +
    (monCatalog.monsters.length ? '<label>do cadastro <select id="mpTypePick"><option value="">—</option>' + monCatalog.monsters.slice().sort((a,b)=>String(a.desc||a.id).localeCompare(String(b.desc||b.id))).map(mm => '<option value="' + mm.id + '"' + (mm.id === m.etype ? ' selected' : '') + '>' + esc(mm.desc || ('#' + mm.id)) + ' (#' + mm.id + ')</option>').join('') + '</select></label>' : '') +
    (monByType(m.etype) ? '<span class="mp-state">classe: ' + esc(monByType(m.etype).desc || ('#' + m.etype)) + '</span>' : '') +
    '<span class="mp-state" id="mpState">estado: ' + (m.state || '-') + '</span>' +
    '<div class="mp-btns"><button id="mpAttack">comandar ataque</button><button id="mpDel">remover</button><button id="mpClose">fechar</button></div>';
  $('mpHp').onchange = async () => { const v = parseInt($('mpHp').value, 10) || 1; await simLive('updateMonster', { id: m.id, maxhp: v, hp: v }); render(); };
  $('mpAtk').onchange = async () => { await simLive('updateMonster', { id: m.id, atk: parseInt($('mpAtk').value, 10) || 0 }); render(); };
  $('mpInt').onchange = async () => { await simLive('updateMonster', { id: m.id, atkInterval: Math.max(50, Math.round((parseFloat($('mpInt').value) || 1) * 1000)) }); render(); };
  $('mpAggro').onchange = async () => { await simLive('updateMonster', { id: m.id, aggro: parseInt($('mpAggro').value, 10) || 1 }); render(); };
  $('mpAgg').onchange = async () => { await simLive('updateMonster', { id: m.id, aggressive: $('mpAgg').checked }); render(); };
  if ($('mpType')) $('mpType').onchange = async () => { await simLive('updateMonster', { id: m.id, etype: parseInt($('mpType').value, 10) || 0 }); render(); };
  if ($('mpTypePick')) $('mpTypePick').onchange = async () => { const v = parseInt($('mpTypePick').value, 10); if (v) { await simLive('updateMonster', { id: m.id, etype: v }); render(); } };
  $('mpAttack').onclick = async () => { await simLive('command', { cmd: CMD.ATTACK_OBJECT, a: m.id }); render(); };
  $('mpDel').onclick = async () => { await simLive('removeMonster', { id: m.id }); sel = null; renderEntityPanel(); render(); };
  $('mpClose').onclick = () => { sel = null; renderEntityPanel(); };
}

function renderHomunPanel(h, el) {
  el.innerHTML =
    '<div class="mp-title">Homúnculo #' + h.id + '</div>' +
    '<label>HP <input id="enHp" type="number" min="0" value="' + (h.hp || 0) + '"></label>' +
    '<label>HP máx <input id="enMaxHp" type="number" min="1" value="' + (h.maxhp || h.hp || 1) + '"></label>' +
    '<label>SP <input id="enSp" type="number" min="0" value="' + (h.sp || 0) + '"></label>' +
    '<label>SP máx <input id="enMaxSp" type="number" min="1" value="' + (h.maxsp || h.sp || 1) + '"></label>' +
    '<label title="dano físico base (skills físicas)">ATK <input id="enAtk" type="number" min="0" value="' + (h.atk || 0) + '"></label>' +
    '<label title="dano mágico base (skills mágicas: Caprice, Erase Cutter, Xeno Slasher...)">MATK <input id="enMatk" type="number" min="0" value="' + (h.matk || 0) + '"></label>' +
    '<div class="mp-btns"><button id="mpClose">fechar</button></div>';
  wireStatInputs(h.id);
  $('mpClose').onclick = () => { sel = null; renderEntityPanel(); };
}

function renderOwnerPanel(o, el) {
  el.innerHTML =
    '<div class="mp-title">Dono #' + o.id + '</div>' +
    '<label>HP <input id="enHp" type="number" min="0" value="' + (o.hp || 0) + '"></label>' +
    '<label>HP máx <input id="enMaxHp" type="number" min="1" value="' + (o.maxhp || o.hp || 1) + '"></label>' +
    '<div class="mp-btns"><button id="mpClose">fechar</button></div>';
  wireStatInputs(o.id);
  $('mpClose').onclick = () => { sel = null; renderEntityPanel(); };
}

function renderAllyPanel(a, el) {
  el.innerHTML =
    '<div class="mp-title">Aliado #' + a.id + '</div>' +
    '<label>HP <input id="enHp" type="number" min="0" value="' + (a.hp || 0) + '"></label>' +
    '<label>HP máx <input id="enMaxHp" type="number" min="1" value="' + (a.maxhp || a.hp || 1) + '"></label>' +
    '<div class="desc">Aliado: monstros podem mirá-lo. Em KSMode=polite, o homúnculo não rouba o alvo dele.</div>' +
    '<div class="mp-btns"><button id="mpDelAlly">remover</button><button id="mpClose">fechar</button></div>';
  wireStatInputs(a.id);
  $('mpDelAlly').onclick = async () => { await simLive('removeMonster', { id: a.id }); sel = null; renderEntityPanel(); render(); };
  $('mpClose').onclick = () => { sel = null; renderEntityPanel(); };
}

async function newAlly() {
  if (!atLive()) jumpLive();
  const h = frame().entities.find(e => e.kind === 'homun') || { x: 20, y: 20 };
  await simLive('addAlly', { x: Math.max(0, h.x - 6), y: h.y, hp: 1000 });
  let id = null; for (const e of frame().entities) if (e.kind === 'ally') id = (id == null ? e.id : Math.max(id, e.id));
  sel = id; renderEntityPanel(); render();
}

// liga os inputs de HP/SP (quando presentes) à dispatch updateEntity
function wireStatInputs(id) {
  const hp = $('enHp'); if (hp) hp.onchange = async () => { await simLive('updateEntity', { id, hp: parseInt(hp.value, 10) || 0 }); render(); };
  const mhp = $('enMaxHp'); if (mhp) mhp.onchange = async () => { await simLive('updateEntity', { id, maxhp: parseInt(mhp.value, 10) || 1 }); render(); };
  const sp = $('enSp'); if (sp) sp.onchange = async () => { await simLive('updateEntity', { id, sp: parseInt(sp.value, 10) || 0 }); render(); };
  const msp = $('enMaxSp'); if (msp) msp.onchange = async () => { await simLive('updateEntity', { id, maxsp: parseInt(msp.value, 10) || 1 }); render(); };
  const atk = $('enAtk'); if (atk) atk.onchange = async () => { await simLive('updateEntity', { id, atk: parseInt(atk.value, 10) || 0 }); render(); };
  const matk = $('enMatk'); if (matk) matk.onchange = async () => { await simLive('updateEntity', { id, matk: parseInt(matk.value, 10) || 0 }); render(); };
}

$('btnStart').onclick = jumpStart;
$('btnBack').onclick = stepBack;
$('btnPlay').onclick = togglePlay;
$('btnFwd').onclick = stepFwd;
$('btnLive').onclick = () => { jumpLive(); };
$('btnReset').onclick = resetScenario;
$('btnNewMon').onclick = newMonster;
$('btnNewAlly').onclick = newAlly;
$('btnScnSave').onclick = saveScenario;
$('btnScnLoad').onclick = loadScenarioFile;
$('timeline').addEventListener('input', () => { stop(); viewIndex = parseInt($('timeline').value, 10); render(); });
$('speed').addEventListener('input', () => { if (playing) { stop(); play(); } });
$('tree').addEventListener('click', (ev) => { const el = ev.target.closest('.tnode'); if (!el) return; const f = frame(); const n = f && f.tree && f.tree[parseInt(el.dataset.idx, 10)]; if (n) showTreeTip(ev.clientX, ev.clientY, n); });
document.addEventListener('mousedown', (ev) => { const t = document.getElementById('treetip'); if (t && t.style.display !== 'none' && !t.contains(ev.target) && !(ev.target.closest && ev.target.closest('.tnode'))) t.style.display = 'none'; }, true);
$('homun').addEventListener('change', () => { syncBaseUI(); loadScenario(); });
$('base').addEventListener('change', () => loadScenario());
{ const le = $('homunLvl'); if (le) le.addEventListener('change', () => loadScenario()); }
{ const sp = (fps) => { $('speed').value = String(fps); if (playing) { stop(); play(); } };
  if ($('spd05')) $('spd05').onclick = () => sp(4);
  if ($('spd1')) $('spd1').onclick = () => sp(8);
  if ($('spd2')) $('spd2').onclick = () => sp(16);
  if ($('btnAllHp')) $('btnAllHp').onclick = () => { showAllHp = !showAllHp; const bb = $('btnAllHp'); bb.textContent = showAllHp ? 'HP: todos' : 'HP: alvo'; bb.classList.toggle('active', showAllHp); render(); }; }
if ($('mapsize')) { const applyMap = () => { const n = parseInt($('mapsize').value, 10) || 600; canvas.width = n; canvas.height = n; const lf = $('left'); if (lf) lf.style.width = (n + 2) + 'px'; render(); }; $('mapsize').addEventListener('input', applyMap); applyMap(); }
syncBaseUI(); // estado inicial do seletor de base

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); stop(); stepFwd(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); stepBack(); }
  else if (e.code === 'Home') { jumpStart(); }
  else if (e.code === 'End') { stop(); jumpLive(); }
});

// Catálogo de monstros/grupos (cadastro do editor) — usado pelos nós monsterCheck.
let monCatalog = { monsters: [], groups: [] };
function monByType(id) { for (const m of monCatalog.monsters) if (m.id === id) return m; return null; }
async function loadMonsters() {
  try { const r = await window.monsters.load(); if (r && r.ok) { const c = JSON.parse(r.data); monCatalog = { monsters: Array.isArray(c.monsters) ? c.monsters : [], groups: Array.isArray(c.groups) ? c.groups : [] }; } } catch (e) { monCatalog = { monsters: [], groups: [] }; }
  try { await sim('setMonsters', monCatalog); } catch (e) {}
}

// Escolha de skills por homúnculo (homun_skills.json) — override por papel/tipo.
let skillChoice = { choices: {} };
async function loadSkillChoice() {
  try { const r = await window.skillChoiceIO.load(); if (r && r.ok) { const c = JSON.parse(r.data); skillChoice = { choices: (c && c.choices) ? c.choices : {} }; } } catch (e) { skillChoice = { choices: {} }; }
  try { await sim('setSkillChoice', skillChoice); } catch (e) {}
}

// Parâmetros de skill por homúnculo/papel (homun_skill_params.json) — knobs AutoMobCount, HealSelfHP, ...
let skillParams = { params: {} };
async function loadSkillParams() {
  try { const r = await window.skillParamsIO.load(); if (r && r.ok) { const c = JSON.parse(r.data); skillParams = { params: (c && c.params) ? c.params : {} }; } } catch (e) { skillParams = { params: {} }; }
  try { await sim('setSkillParams', skillParams); } catch (e) {}
}

// Config de invocações por homúnculo (homun_summons.json) — Legião da Sera.
let summonCfg = { choices: {} };
async function loadSummonChoice() {
  try { const r = await window.summonIO.load(); if (r && r.ok) { const c = JSON.parse(r.data); summonCfg = { choices: (c && c.choices) ? c.choices : {} }; } } catch (e) { summonCfg = { choices: {} }; }
  try { await sim('setSummonChoice', summonCfg); } catch (e) {}
}

// Config da ÁRVORE (treeConfig) passada pelo editor ao "Simular" — sobrepõe a config do cenário.
async function loadSimConfig() {
  try { const raw = sessionStorage.getItem('brai.simConfig'); if (!raw) return; const cfg = JSON.parse(raw); if (cfg && typeof cfg === 'object') await sim('setConfig', cfg); } catch (e) {}
}

// Aplica o homúnculo/base escolhidos no editor (passados via sessionStorage).
function applySimContext() {
  try {
    const raw = sessionStorage.getItem('brai.simContext');
    if (!raw) return;
    const ctx = JSON.parse(raw);
    if (ctx.homunType != null) $('homun').value = String(ctx.homunType);
    if (ctx.baseType != null) $('base').value = String(ctx.baseType);
    // one-shot: a escolha do editor ("Simular") só vale nesta entrada; nas
    // navegações por link o simulador mantém o próprio homún (via brai.simSetup).
    sessionStorage.removeItem('brai.simContext');
  } catch (e) {}
}

// ---- persistência do SETUP do simulador (round-trip editor <-> simulador) ----
// O usuário quer manter a CONFIGURAÇÃO (cenário selecionado + UI) ao trocar de
// tela, mas a SIMULAÇÃO deve RESETAR ao frame 0. Por isso salvamos o cenário no
// estado de reset (frame 0) + a config de UI no sessionStorage (sobrevive à
// navegação, some ao fechar o app) — mesma estratégia do editor (brai.editorState).
const SIM_SETUP_KEY = 'brai.simSetup';
function persistSetup() {
  try {
    const scn = captureScenario(frames[0]);   // frame 0 = estado inicial (reset) do cenário atual
    sessionStorage.setItem(SIM_SETUP_KEY, JSON.stringify({
      scenario: scn,
      ui: {
        homun: $('homun') ? $('homun').value : null,
        base: $('base') ? $('base').value : null,
        homunLvl: $('homunLvl') ? $('homunLvl').value : null,
        speed: $('speed') ? $('speed').value : null,
        mapsize: $('mapsize') ? $('mapsize').value : null,
        scnName: $('scnName') ? $('scnName').value : '',
        scnListSel: $('scnList') ? $('scnList').value : '',
        showAllHp: !!showAllHp,
      },
    }));
  } catch (e) {}
}
function restoreSetup() {
  let saved = null;
  try { const raw = sessionStorage.getItem(SIM_SETUP_KEY); saved = raw ? JSON.parse(raw) : null; } catch (e) { saved = null; }
  if (!saved || !saved.scenario) return null;
  const scn = saved.scenario, ui = saved.ui || {};
  // o cenário preservado vira o alvo do reset (loadScenario carrega o frame 0 dele)
  if (scn.grid) SCENARIO.grid = scn.grid;
  if (scn.dt) SCENARIO.dt = scn.dt;
  if (scn.homunId) SCENARIO.homunId = scn.homunId;
  if (scn.ownerId) SCENARIO.ownerId = scn.ownerId;
  SCENARIO.config = scn.config || {};
  if (Array.isArray(scn.entities)) SCENARIO.entities = scn.entities;
  // UI (homún/base podem ser sobrescritos por applySimContext no fluxo "Simular")
  if (ui.homun != null && $('homun')) $('homun').value = String(ui.homun);
  if (ui.base != null && $('base')) $('base').value = String(ui.base);
  if (ui.homunLvl != null && $('homunLvl')) $('homunLvl').value = String(ui.homunLvl);
  if (ui.speed != null && $('speed')) $('speed').value = String(ui.speed);
  if (ui.scnName != null && $('scnName')) $('scnName').value = ui.scnName;
  if (ui.showAllHp) { showAllHp = true; const b = $('btnAllHp'); if (b) { b.textContent = 'HP: todos'; b.classList.add('active'); } }
  if (ui.mapsize != null && $('mapsize')) {
    $('mapsize').value = String(ui.mapsize);
    const n = parseInt(ui.mapsize, 10) || 600;
    if (canvas) { canvas.width = n; canvas.height = n; }
    const lf = $('left'); if (lf) lf.style.width = (n + 2) + 'px';
  }
  return { scnListSel: ui.scnListSel };
}

(async function boot() {
  try {
    window.addEventListener('beforeunload', persistSetup);  // salva o setup ao sair (igual ao editor)
    const restored = restoreSetup();           // restaura cenário + UI salvos (se houver)
    applySimContext();                          // "Simular" do editor tem prioridade no homún/base (one-shot)
    await loadMonsters(); await loadSkillChoice(); await loadSkillParams(); await loadSummonChoice(); await loadSimConfig();
    try { const ci = await sim('comboInfo'); if (ci && ci.power && ci.grapple) eleanorChains = ci; } catch (e) {}
    await loadScenario();
    await refreshScenarioList();
    if (restored && restored.scnListSel) { const sl = $('scnList'); if (sl) sl.value = restored.scnListSel; }
  }
  catch (e) { showError('boot: ' + ((e && e.message) || e)); }
})();
