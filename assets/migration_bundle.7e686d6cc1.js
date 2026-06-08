// lua_parse.js — parser de um SUBCONJUNTO de Lua p/ ler os arquivos de config da AzzyAI.
// Suporta o que os arquivos-alvo (H_Config, H_Tactics, H_SkillList, Const_) realmente usam:
//   • atribuições  Nome = valor   e   Tabela[idx] = valor   (idx numérico, string ou símbolo)
//   • construtores de tabela  {a, b, c}  e  { [k]=v, nome=v }  aninhados
//   • números (int, decimal, .80, negativos), strings "..."/'...', true/false/nil
//   • referência a símbolos já definidos (resolvidos via `env` — ex.: TACT_ATTACK_L, ELEANOR)
// NÃO executa funções nem aritmética. É TOLERANTE: erros viram avisos e o parse continua.
// Uso (Node e navegador):  var { parse } = require('./lua_parse');  var r = parse(src, env);
//   → r.env (mutado in-place) e r.warnings[]. Tabelas viram objetos JS comuns ({1:..,2:..} p/ arrays).
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ tokenizer
  function tokenize(src) {
    var toks = [], i = 0, n = src.length, line = 1;
    function push(t, v) { toks.push({ t: t, v: v, line: line }); }
    var NAME0 = /[A-Za-z_]/, NAMEN = /[A-Za-z0-9_]/;
    while (i < n) {
      var c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
      // comentários
      if (c === '-' && src[i + 1] === '-') {
        if (src[i + 2] === '[' && src[i + 3] === '[') {           // bloco --[[ ... ]]
          i += 4;
          while (i < n && !(src[i] === ']' && src[i + 1] === ']')) { if (src[i] === '\n') line++; i++; }
          i += 2; continue;
        }
        i += 2; while (i < n && src[i] !== '\n') i++; continue;   // linha --
      }
      // strings
      if (c === '"' || c === "'") {
        var q = c, s = ''; i++;
        while (i < n && src[i] !== q) {
          if (src[i] === '\\') {
            var e = src[i + 1];
            s += (e === 'n') ? '\n' : (e === 't') ? '\t' : (e === 'r') ? '\r' : e;
            i += 2; continue;
          }
          if (src[i] === '\n') line++;
          s += src[i]; i++;
        }
        i++; push('str', s); continue;
      }
      // números (decimal/.80). O sinal negativo é tratado no parser de valor.
      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        var j = i, num = '';
        // hexadecimal 0x...
        if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
          j = i + 2; var hex = '';
          while (j < n && /[0-9a-fA-F]/.test(src[j])) { hex += src[j]; j++; }
          push('num', parseInt(hex, 16)); i = j; continue;
        }
        while (j < n && /[0-9.]/.test(src[j])) { num += src[j]; j++; }
        push('num', parseFloat(num)); i = j; continue;
      }
      // nomes / palavras-chave
      if (NAME0.test(c)) {
        var k = i, name = '';
        while (k < n && NAMEN.test(src[k])) { name += src[k]; k++; }
        push('name', name); i = k; continue;
      }
      // pontuação
      if ('{}[]=,();'.indexOf(c) >= 0) { push('p', c); i++; continue; }
      if (c === '-') { push('p', '-'); i++; continue; }
      i++; // caractere desconhecido: ignora
    }
    push('eof', null);
    return toks;
  }

  // ------------------------------------------------------------------ parser
  function parse(src, env, opts) {
    env = env || {};
    opts = opts || {};
    var warnings = [];
    var toks = tokenize(String(src || ''));
    var pos = 0;
    function peek() { return toks[pos]; }
    function next() { return toks[pos++]; }
    function isP(v) { var tk = toks[pos]; return tk.t === 'p' && tk.v === v; }
    function eat(v) { if (isP(v)) { pos++; return true; } return false; }

    function resolveName(nm) {
      if (nm === 'true') return true;
      if (nm === 'false') return false;
      if (nm === 'nil') return null;
      if (Object.prototype.hasOwnProperty.call(env, nm)) return env[nm];
      warnings.push('símbolo não resolvido: ' + nm);
      return { __unresolved: nm };
    }
    function normKey(k) {
      if (k && typeof k === 'object' && k.__unresolved != null) return k.__unresolved;
      return k; // número ou string (JS coage número p/ chave de objeto)
    }

    function parseValue(depth) {
      depth = depth || 0;
      if (depth > 60) { return null; }
      var tk = peek();
      if (tk.t === 'p' && tk.v === '-') { next(); var v = parseValue(depth + 1); return (typeof v === 'number') ? -v : v; }
      if (tk.t === 'num') { next(); return tk.v; }
      if (tk.t === 'str') { next(); return tk.v; }
      if (tk.t === 'name') { next(); return resolveName(tk.v); }
      if (tk.t === 'p' && tk.v === '{') { return parseTable(depth + 1); }
      if (tk.t === 'p' && tk.v === '(') { next(); var inner = parseValue(depth + 1); eat(')'); return inner; }
      next(); return null; // token inesperado: consome p/ não travar
    }

    function parseTable(depth) {
      eat('{');
      var out = {}, nextIndex = 1, guard = 0;
      while (true) {
        if (++guard > 100000) break;
        var tk = peek();
        if (!tk || tk.t === 'eof') break;
        if (tk.t === 'p' && tk.v === '}') { next(); break; }
        if (tk.t === 'p' && (tk.v === ',' || tk.v === ';')) { next(); continue; }
        if (tk.t === 'p' && tk.v === '[') {                  // [chave] = valor
          next(); var key = parseValue(depth + 1); eat(']'); eat('=');
          out[normKey(key)] = parseValue(depth + 1); continue;
        }
        if (tk.t === 'name' && toks[pos + 1] && toks[pos + 1].t === 'p' && toks[pos + 1].v === '=') {
          var nm = next().v; next();                         // nome = valor
          out[nm] = parseValue(depth + 1); continue;
        }
        out[nextIndex++] = parseValue(depth + 1);            // posicional (array 1-based)
      }
      Object.defineProperty(out, '__table', { value: true, enumerable: false });
      return out;
    }

    function assignPath(path, val) {
      var o = env;
      for (var k = 0; k < path.length - 1; k++) {
        var key = path[k];
        if (typeof o[key] !== 'object' || o[key] === null) o[key] = {};
        o = o[key];
      }
      o[path[path.length - 1]] = val;
    }

    // pula function/if/for/while/do ... end (heurística; os arquivos-alvo quase não têm)
    function skipBlock() {
      var depth = 0, guard = 0;
      while (peek().t !== 'eof') {
        if (++guard > 1000000) break;
        var tk = next();
        if (tk.t === 'name') {
          if (tk.v === 'function' || tk.v === 'if' || tk.v === 'for' || tk.v === 'while' || tk.v === 'do') depth++;
          else if (tk.v === 'end') { depth--; if (depth <= 0) return; }
        }
      }
    }

    var sguard = 0;
    while (peek().t !== 'eof') {
      if (++sguard > 1000000) break;
      var tk = peek();
      if (tk.t === 'name' && tk.v === 'function') { next(); skipBlock(); continue; }
      if (tk.t === 'name' && (tk.v === 'if' || tk.v === 'for' || tk.v === 'while' || tk.v === 'do' || tk.v === 'repeat')) { next(); skipBlock(); continue; }
      if (tk.t === 'name' && tk.v === 'return') { next(); if (peek().t !== 'eof' && !(peek().t === 'name' && peek().v === 'end')) parseValue(0); continue; }
      if (tk.t === 'name' && tk.v === 'local') { next(); continue; } // segue p/ a atribuição
      if (tk.t === 'name') {
        var base = next().v;
        var path = [base];
        var pg = 0;
        while (isP('[') && ++pg < 50) { next(); var ik = parseValue(0); eat(']'); path.push(normKey(ik)); }
        // acesso por ponto Nome.campo (raro nos dados) — trata como string-chave
        while (isP('.')) { next(); if (peek().t === 'name') path.push(next().v); }
        if (isP('=')) {
          next();
          var val = parseValue(0);
          assignPath(path, val);
          eat(';');
          continue;
        }
        // não é atribuição (ex.: chamada de função): ignora o que restar até quebrar
        eat('('); // consome possível '(' de chamada; o resto vira tokens soltos ignorados
        continue;
      }
      next(); // token solto
    }

    return { env: env, warnings: warnings };
  }

  // Converte uma "tabela" (objeto com chaves 1..N) num array JS, se for densa. Senão devolve igual.
  function toArray(tbl) {
    if (!tbl || typeof tbl !== 'object') return tbl;
    var out = [], i = 1;
    while (Object.prototype.hasOwnProperty.call(tbl, i)) { out.push(tbl[i]); i++; }
    return out;
  }

  var api = { parse: parse, tokenize: tokenize, toArray: toArray };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_LUA_PARSE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// symbols.js — tabela de símbolos da AzzyAI (constantes) p/ resolver os arquivos de config.
// Estratégia: começa com um FALLBACK embarcado (valores canônicos da 1.5x) e, se o zip trouxer
// Const_.lua / Const.lua / H_SkillList.lua, faz parse deles POR CIMA (o arquivo do usuário vence).
// Assim a decodificação de tuplas de tática e de IDs de skill é resiliente a faltar Const_.
(function (root) {
  'use strict';
  var luaParse = (typeof require !== 'undefined') ? require('./lua_parse.js')
    : (typeof window !== 'undefined' ? window.BRAI_LUA_PARSE : null);

  // --- tipos de homúnculo (V_HOMUNTYPE) ---
  var HOMUN_TYPES = {
    LIF: 1, AMISTR: 2, FILIR: 3, VANILMIRTH: 4,
    LIF2: 5, AMISTR2: 6, FILIR2: 7, VANILMIRTH2: 8,
    LIF_H: 9, AMISTR_H: 10, FILIR_H: 11, VANILMIRTH_H: 12,
    LIF_H2: 13, AMISTR_H2: 14, FILIR_H2: 15, VANILMIRTH_H2: 16,
    EIRA: 48, BAYERI: 49, BEYERI: 49, SERA: 50, DIETER: 51, ELEANOR: 52,
  };
  var HOMUN_NAMES = {
    1: 'Lif', 2: 'Amistr', 3: 'Filir', 4: 'Vanilmirth',
    5: 'Lif', 6: 'Amistr', 7: 'Filir', 8: 'Vanilmirth',
    9: 'Lif', 10: 'Amistr', 11: 'Filir', 12: 'Vanilmirth',
    13: 'Lif', 14: 'Amistr', 15: 'Filir', 16: 'Vanilmirth',
    48: 'Eira', 49: 'Bayeri', 50: 'Sera', 51: 'Dieter', 52: 'Eleanor',
  };

  // --- constantes de tática (valores que aparecem nas tuplas de MyTact) ---
  var TACTIC_CONSTS = {
    // campos (índices) — não usados como valor, mas definidos por completude
    TACT_BASIC: 1, TACT_SKILL: 2, TACT_KITE: 3, TACT_CAST: 4, TACT_PUSHBACK: 5,
    TACT_DEBUFF: 6, TACT_SIZE: 7, TACT_SKILLCLASS: 7, TACT_RESCUE: 8, TACT_SP: 9,
    TACT_SNIPE: 10, TACT_FFA: 11, TACT_KS: 11, TACT_WEIGHT: 12, TACT_CHASE: 13,
    // TACT_BASIC (campo 1) — resposta ao monstro
    TACT_TANKMOB: -2, TACT_TANK: -1, TACT_IGNORE: 0,
    TACT_ATTACK_L: 2, TACT_ATTACK_M: 3, TACT_ATTACK_H: 4,
    TACT_REACT_L: 5, TACT_REACT_M: 7, TACT_REACT_H: 8, TACT_REACT_SELF: 9,
    TACT_SNIPE_L: 10, TACT_SNIPE_M: 11, TACT_SNIPE_H: 12,
    TACT_ATK_L_REACT_M: 13, TACT_ATTACK_LAST: 14, TACT_ATTACK_TOP: 15,
    // uso de skill (campo 2)
    SKILL_NEVER: 0, SKILL_ALWAYS: 100,
    // kite (campo 3)
    KITE_ALWAYS: 2, KITE_REACT: 1, KITE_NEVER: 0,
    // cast react (campo 4)
    CAST_REACT: 1, CAST_PASSIVE: 0, CAST_REACT_ANY: 9,
    // pushback (campo 5)
    PUSH_FRIEND: 2, PUSH_SELF: 1, PUSH_NEVER: 0,
    // debuff (campo 6)
    DEBUFF_NEVER: 0, DEBUFF_ANY_C: -1, DEBUFF_ANY_A: 1, DEBUFF_ASH_A: 8043, DEBUFF_ASH_C: -8043,
    // skill class (campo 7)
    CLASS_BOTH: -1, CLASS_OLD: 0, CLASS_S: 1, CLASS_MOB: 2,
    CLASS_COMBO_1: 3, CLASS_COMBO_2: 4, CLASS_MINION: 5, CLASS_GRAPPLE: 6,
    // rescue (campo 8)
    RESCUE_NEVER: 0, RESCUE_FRIEND: 1, RESCUE_RETAINER: 2, RESCUE_SELF: 3, RESCUE_OWNER: 4, RESCUE_ALL: 5,
    // snipe (campo 10)
    SNIPE_OK: 1, SNIPE_DISABLE: 0,
    // KS (campo 11)
    KS_NEVER: 0, KS_ALWAYS: 1, KS_POLITE: -1,
    // chase (campo 13)
    CHASE_NORMAL: -1, CHASE_ALWAYS: 0, CHASE_NEVER: 1, CHASE_CLEVER: 2,
    // friend/pvp
    ALLY: 13, KOS: 12, ENEMY: 11, NEUTRAL: 10, RETAINER: 2, FRIEND: 1, PKFRIEND: 3,
  };

  // --- IDs de skill (name → id). Só p/ resolver SkillList/flags; metadados NÃO migram. ---
  var SKILL_IDS = {
    // mercenário (não-homún, ignorados na prática)
    MS_BASH: 8201, MS_MAGNUM: 8202, MS_BOWLINGBASH: 8203, MS_PARRYING: 8204, MS_REFLECTSHIELD: 8205,
    MS_BERSERK: 8206, MA_DOUBLE: 8207, MA_SHOWER: 8208, MA_SKIDTRAP: 8209, MA_LANDMINE: 8210,
    MA_SANDMAN: 8211, MA_FREEZINGTRAP: 8212, MA_REMOVETRAP: 8213, MA_CHARGEARROW: 8214, MA_SHARPSHOOTING: 8215,
    ML_PIERCE: 8216, ML_BRANDISH: 8217, ML_SPIRALPIERCE: 8218, ML_DEFENDER: 8219, ML_AUTOGUARD: 8220,
    ML_DEVOTION: 8221, MER_MAGNIFICAT: 8222, MER_QUICKEN: 8223, MER_SIGHT: 8224, MER_CRASH: 8225,
    MER_REGAIN: 8226, MER_TENDER: 8227, MER_BENEDICTION: 8228, MER_RECUPERATE: 8229, MER_MENTALCURE: 8230,
    MER_COMPRESS: 8231, MER_PROVOKE: 8232, MER_AUTOBERSERK: 8233, MER_DECAGI: 8234, MER_SCAPEGOAT: 8235,
    MER_LEXDIVINA: 8236, MER_ESTIMATION: 8237,
    // homún clássico
    HLIF_HEAL: 8001, HLIF_AVOID: 8002, HLIF_CHANGE: 8004, HAMI_CASTLE: 8005, HAMI_DEFENCE: 8006,
    HAMI_BLOODLUST: 8008, HFLI_MOON: 8009, HFLI_FLEET: 8010, HFLI_SPEED: 8011, HFLI_SBR44: 8012,
    HVAN_CAPRICE: 8013, HVAN_CHAOTIC: 8014, HVAN_SELFDESTRUCT: 8016,
    // homún S
    MUTATION_BASEJOB: 8017, MH_SUMMON_LEGION: 8018, MH_NEEDLE_OF_PARALYZE: 8019, MH_POISON_MIST: 8020,
    MH_PAIN_KILLER: 8021, MH_LIGHT_OF_REGENE: 8022, MH_OVERED_BOOST: 8023, MH_ERASER_CUTTER: 8024,
    MH_XENO_SLASHER: 8025, MH_SILENT_BREEZE: 8026, MH_STYLE_CHANGE: 8027, MH_SONIC_CRAW: 8028,
    MH_SONIC_CLAW: 8028, MH_SILVERVEIN_RUSH: 8029, MH_MIDNIGHT_FRENZY: 8030, MH_STAHL_HORN: 8031,
    MH_GOLDENE_FERSE: 8032, MH_STEINWAND: 8033, MH_HEILIGE_STANGE: 8034, MH_ANGRIFFS_MODUS: 8035,
    MH_TINDER_BREAKER: 8036, MH_CBC: 8037, MH_EQC: 8038, MH_MAGMA_FLOW: 8039, MH_GRANITIC_ARMOR: 8040,
    MH_LAVA_SLIDE: 8041, MH_PYROCLASTIC: 8042, MH_VOLCANIC_ASH: 8043, MH_BLAST_FORGE: 8044, MH_TEMPERING: 8045,
  };

  function buildFallback() {
    var env = {};
    var src = [HOMUN_TYPES, TACTIC_CONSTS, SKILL_IDS];
    for (var s = 0; s < src.length; s++) for (var k in src[s]) if (src[s].hasOwnProperty(k)) env[k] = src[s][k];
    return env;
  }

  // env de símbolos: FALLBACK + (Const_/Const/H_SkillList do zip, se houver). `files` = {name→texto}.
  function buildEnv(files, parseFn) {
    parseFn = parseFn || (luaParse && luaParse.parse);
    var env = buildFallback();
    var warnings = [];
    files = files || {};
    ['Const_.lua', 'Const.lua', 'H_SkillList.lua'].forEach(function (f) {
      var txt = pick(files, f);
      if (txt != null && parseFn) {
        try { var r = parseFn(txt, env); if (r && r.warnings) warnings = warnings.concat(r.warnings.map(function (w) { return f + ': ' + w; })); }
        catch (e) { warnings.push(f + ': falha ao parsear (' + e.message + ')'); }
      }
    });
    return { env: env, warnings: warnings };
  }

  // procura um arquivo no mapa ignorando caixa e caminho
  function pick(files, name) {
    if (files[name] != null) return files[name];
    var low = String(name).toLowerCase();
    for (var k in files) if (files.hasOwnProperty(k)) {
      var base = String(k).replace(/^.*[\\/]/, '').toLowerCase();
      if (base === low) return files[k];
    }
    return null;
  }

  // tipo de perfil/papel: evoluções (5..16) caem no clássico base (1..4); Homun S (48..52) = ele mesmo
  function baseProfileType(t) {
    t = Number(t) || 0;
    if (t >= 48) return t;
    if (t >= 1 && t <= 16) return ((t - 1) % 4) + 1;
    return t;
  }
  function isHomunS(t) { t = Number(t) || 0; return t >= 48 && t <= 52; }

  var api = {
    HOMUN_TYPES: HOMUN_TYPES, HOMUN_NAMES: HOMUN_NAMES,
    TACTIC_CONSTS: TACTIC_CONSTS, SKILL_IDS: SKILL_IDS,
    buildFallback: buildFallback, buildEnv: buildEnv, pick: pick,
    baseProfileType: baseProfileType, isHomunS: isHomunS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_MIG_SYMBOLS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// zip_read.js — LEITOR de zip client-side (o desktop/zip.js só ESCREVE, via zlib do Node).
// Lê o diretório central do ZIP e descompacta cada entrada (deflate/method 8 ou store/0).
//   • Node: zlib.inflateRawSync (síncrono) — usado nos testes.
//   • Navegador: DecompressionStream('deflate-raw') (assíncrono) ou window.fflate, se presente.
// readZip(bytes) → Promise<{ basename → texto }>  (ignora caminho/pasta-raiz; latin1 p/ não quebrar).
(function (root) {
  'use strict';
  var isNode = (typeof module !== 'undefined' && module.exports);
  var zlib = null; if (isNode) { try { zlib = require('zlib'); } catch (e) {} }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function toBytes(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (isNode && Buffer.isBuffer(buf)) return new Uint8Array(buf);
    if (buf && buf.buffer) return new Uint8Array(buf.buffer);
    return new Uint8Array(buf);
  }
  function decodeText(bytes) {
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('latin1').decode(bytes); } catch (e) {}
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e2) {}
    }
    if (isNode) return Buffer.from(bytes).toString('latin1');
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s;
  }
  function baseName(p) { return String(p).replace(/^.*[\\/]/, ''); }

  // localiza o EOCD (End Of Central Directory) varrendo de trás p/ frente
  function findEOCD(b) {
    for (var i = b.length - 22; i >= 0; i--) {
      if (u32(b, i) === 0x06054b50) return i;
    }
    return -1;
  }

  // lista de entradas {name, method, offset(local header), compSize, uncompSize}
  function parseEntries(b) {
    var eocd = findEOCD(b);
    if (eocd < 0) throw new Error('zip inválido (EOCD não encontrado)');
    var count = u16(b, eocd + 10);
    var cdOff = u32(b, eocd + 16);
    var entries = [], p = cdOff;
    for (var i = 0; i < count && p + 46 <= b.length; i++) {
      if (u32(b, p) !== 0x02014b50) break;
      var method = u16(b, p + 10);
      var compSize = u32(b, p + 20);
      var uncompSize = u32(b, p + 24);
      var nameLen = u16(b, p + 28);
      var extraLen = u16(b, p + 30);
      var commentLen = u16(b, p + 32);
      var lho = u32(b, p + 42);
      var name = decodeText(b.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name: name, method: method, lho: lho, compSize: compSize, uncompSize: uncompSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // posição+tamanho dos dados comprimidos a partir do local header
  function dataSlice(b, e) {
    var p = e.lho;
    if (u32(b, p) !== 0x04034b50) throw new Error('local header inválido: ' + e.name);
    var nameLen = u16(b, p + 26);
    var extraLen = u16(b, p + 28);
    var start = p + 30 + nameLen + extraLen;
    return b.subarray(start, start + e.compSize);
  }

  function inflateSyncNode(slice, method) {
    if (method === 0) return slice;
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(slice)));
  }
  function inflateAsync(slice, method) {
    if (method === 0) return Promise.resolve(slice);
    if (isNode && zlib) return Promise.resolve(inflateSyncNode(slice, method));
    if (root.fflate && root.fflate.inflateSync) { try { return Promise.resolve(root.fflate.inflateSync(slice)); } catch (e) {} }
    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([slice]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    }
    return Promise.reject(new Error('sem descompactador disponível no ambiente'));
  }

  // Node síncrono (testes)
  function readZipSync(buf) {
    if (!zlib) throw new Error('readZipSync só no Node');
    var b = toBytes(buf), out = {};
    parseEntries(b).forEach(function (e) {
      if (/\/$/.test(e.name)) return; // diretório
      var data = inflateSyncNode(dataSlice(b, e), e.method);
      out[baseName(e.name)] = decodeText(data);
    });
    return out;
  }

  // universal (assíncrono) — usado pela UI no navegador
  function readZip(buf) {
    var b = toBytes(buf);
    var entries;
    try { entries = parseEntries(b); } catch (e) { return Promise.reject(e); }
    var out = {};
    var chain = Promise.resolve();
    entries.forEach(function (e) {
      if (/\/$/.test(e.name)) return;
      chain = chain.then(function () {
        return inflateAsync(dataSlice(b, e), e.method).then(function (data) {
          out[baseName(e.name)] = decodeText(toBytes(data));
        });
      });
    });
    return chain.then(function () { return out; });
  }

  var api = { readZip: readZip, readZipSync: readZipSync, parseEntries: parseEntries, baseName: baseName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_ZIP_READ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// map_config.js — H_Config (knobs) → bb.config do BR-AI + toggles de ramo (Use*=0 desativa nó).
// Retorna { config, branchToggles, rows, consumed, notes }. NÃO mexe em skills (map_skills cuida).
//   rows = linhas do relatório de→para: { from, to, status: 'mapped'|'adjusted'|'note', reason }
(function (root) {
  'use strict';

  // H_Config → config.<X> (cópia numérica direta)
  var DIRECT = {
    AggroHP: 'AggroHP', AggroSP: 'AggroSP', FleeHP: 'FleeHP',
    HealSelfHP: 'HealSelfHP', HealOwnerHP: 'HealOwnerHP',
    AutoMobCount: 'AutoMobCount', AttackSkillReserveSP: 'AttackSkillReserveSP',
    CastleDefendThreshold: 'CastleDefendThreshold', AutoComboSpheres: 'AutoComboSpheres',
    FollowStayBack: 'FollowStayBack', SphereTrackFactor: 'SphereTrackFactor',
    KiteBounds: 'KiteBounds', KiteStep: 'KiteStep', DanceMinSP: 'DanceMinSP',  // Fase 8a
    RescueOwnerLowHP: 'RescueOwnerLowHP',  // Fase 8b
    IdleWalkSP: 'IdleWalkSP', IdleWalkDistance: 'IdleWalkDistance', AutoMobMode: 'AutoMobMode', AoEFixedLevel: 'AoEFixedLevel',  // Fase 8c
  };
  // H_Config (0/1) → config.<X> (booleano)
  var BOOLS = {
    UseAttackSkill: 'UseAttackSkill', UseOffensiveBuff: 'UseOffensiveBuff',
    UseDefensiveBuff: 'UseDefensiveBuff', UseAutoHeal: 'UseAutoHeal', SuperPassive: 'SuperPassive',
    KiteMonsters: 'KiteMonsters', ForceKite: 'ForceKite', UseDanceAttack: 'UseDanceAttack', EleanorDoNotSwitchMode: 'EleanorDoNotSwitchMode',  // Fase 8a
    UseSkillOnly: 'UseSkillOnly', OpportunisticTargeting: 'OpportunisticTargeting', DefensiveBuffOwnerMobbed: 'DefensiveBuffOwnerMobbed',  // Fase 8b
    UseIdleWalk: 'UseIdleWalk', MoveSticky: 'MoveSticky', MoveStickyFight: 'MoveStickyFight', AoEMaximizeTargets: 'AoEMaximizeTargets', UseHomunSSkillChase: 'UseHomunSSkillChase', UseHomunSSkillAttack: 'UseHomunSSkillAttack',  // Fase 8c
  };
  // ramos da árvore ligados/desligados conforme um flag (por label ou nome de ação)
  // on:'nonzero' → habilitado quando ≠0 (0 desativa). on:'zero' → habilitado quando ==0 (ex.: DoNotChase=1 desativa)
  var BRANCHES = [
    { flag: 'UseAutoHeal', on: 'nonzero', target: { label: 'cura-urgente' }, desc: 'cura urgente' },
    { flag: 'UseCastleDefend', on: 'nonzero', target: { action: 'UseCastling' }, desc: 'Castling (Amistr)' },
    { flag: 'UseSeraPainkiller', on: 'nonzero', target: { action: 'UseOwnerBuff' }, desc: 'Painkiller no dono (Sera)' },
    { flag: 'UseSeraCallLegion', on: 'nonzero', target: { action: 'UseSummon' }, desc: 'Summon Legion (Sera)' },
    { flag: 'UseOffensiveBuff', on: 'nonzero', target: { action: 'UseOffensiveBuff' }, desc: 'buffs ofensivos' },
    { flag: 'UseDefensiveBuff', on: 'nonzero', target: { action: 'UseDefensiveBuff' }, desc: 'buffs defensivos' },
    { flag: 'UseAttackSkill', on: 'nonzero', target: { actions: ['UseAoESkill', 'UseMainSkill'] }, desc: 'skills de ataque' },
    { flag: 'DoNotChase', on: 'zero', target: { action: 'ChaseTarget' }, desc: 'perseguir alvo' },
  ];

  function has(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function bool(v) { return num(v) !== 0; }

  function mapConfig(hconfig) {
    hconfig = hconfig || {};
    var config = {}, branchToggles = [], rows = [], notes = [], consumed = {};
    function mark(k) { consumed[k] = true; }

    // diretos
    for (var k in DIRECT) if (DIRECT.hasOwnProperty(k) && has(hconfig, k)) {
      var dst = DIRECT[k], val = num(hconfig[k]);
      config[dst] = val; mark(k);
      rows.push({ from: k + ' = ' + hconfig[k], to: 'config.' + dst + ' = ' + val, status: 'mapped' });
    }
    // booleanos 0/1
    for (var b in BOOLS) if (BOOLS.hasOwnProperty(b) && has(hconfig, b)) {
      var bd = BOOLS[b], bv = bool(hconfig[b]);
      config[bd] = bv; mark(b);
      rows.push({ from: b + ' = ' + hconfig[b], to: 'config.' + bd + ' = ' + bv, status: 'mapped' });
    }
    // OldHomunType → BaseHomunType
    if (has(hconfig, 'OldHomunType')) {
      config.BaseHomunType = num(hconfig.OldHomunType); mark('OldHomunType');
      rows.push({ from: 'OldHomunType = ' + hconfig.OldHomunType, to: 'config.BaseHomunType = ' + config.BaseHomunType, status: 'mapped' });
    }
    // Painkiller / Legion → flags de config (papel/ramo)
    if (has(hconfig, 'UseSeraPainkiller')) {
      config.UseOwnerBuff = bool(hconfig.UseSeraPainkiller); mark('UseSeraPainkiller');
      rows.push({ from: 'UseSeraPainkiller = ' + hconfig.UseSeraPainkiller, to: 'config.UseOwnerBuff = ' + config.UseOwnerBuff, status: 'mapped' });
    }
    if (has(hconfig, 'UseSeraCallLegion')) {
      config.UseSummon = bool(hconfig.UseSeraCallLegion); mark('UseSeraCallLegion');
      rows.push({ from: 'UseSeraCallLegion = ' + hconfig.UseSeraCallLegion, to: 'config.UseSummon = ' + config.UseSummon, status: 'mapped' });
    }
    // pares estacionário/móvel → um único knob (usa o MAIOR, com nota)
    reducePair('MoveBounds', 'StationaryMoveBounds', 'MobileMoveBounds');
    reducePair('AggroDist', 'StationaryAggroDist', 'MobileAggroDist');
    function reducePair(dst, a, c) {
      var hasA = has(hconfig, a), hasC = has(hconfig, c);
      if (!hasA && !hasC) return;
      var va = hasA ? num(hconfig[a]) : null, vc = hasC ? num(hconfig[c]) : null;
      var val = Math.max(va == null ? -Infinity : va, vc == null ? -Infinity : vc);
      config[dst] = val; if (hasA) mark(a); if (hasC) mark(c);
      var adjusted = (hasA && hasC && va !== vc);
      rows.push({
        from: [hasA ? a + ' = ' + hconfig[a] : null, hasC ? c + ' = ' + hconfig[c] : null].filter(Boolean).join(' · '),
        to: 'config.' + dst + ' = ' + val, status: adjusted ? 'adjusted' : 'mapped',
        reason: adjusted ? 'BR-AI usa um só valor; adotei o maior (estacionário/móvel)' : undefined,
      });
    }

    // toggles de ramo
    BRANCHES.forEach(function (br) {
      if (!has(hconfig, br.flag)) return;
      mark(br.flag);
      var v = num(hconfig[br.flag]);
      var enabled = (br.on === 'zero') ? (v === 0) : (v !== 0);
      branchToggles.push({ match: br.target, enabled: enabled, from: br.flag + ' = ' + hconfig[br.flag], desc: br.desc });
      rows.push({
        from: br.flag + ' = ' + hconfig[br.flag],
        to: (enabled ? 'mantém' : 'DESATIVA') + ' ramo «' + br.desc + '»',
        status: 'mapped',
      });
    });

    return { config: config, branchToggles: branchToggles, rows: rows, consumed: consumed, notes: notes };
  }

  var api = { mapConfig: mapConfig, DIRECT: DIRECT, BOOLS: BOOLS, BRANCHES: BRANCHES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_MIG_MAP_CONFIG = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// map_skills.js — extrai SÓ as 4 skills padrão por papel + nível, por tipo de homún.
// NÃO importa a lista de skills nem metadados (SkillInfo) — a base do BR-AI é mais atual.
// Entrada: skillList (env.SkillList = {tipo:{id:nível}}) e hconfig (H_Config). Saída:
//   { skillChoices:{choices:{tipo:{mainAtk?,aoeAtk?,offBuff?,defBuff?, *Level?}}}, rows, consumed, notes, disabledRoles }
// Override de papel é gravado SÓ quando difere do padrão do BR-AI; nível sempre que houver.
(function (root) {
  'use strict';

  // IDs (canônicos) — só p/ legibilidade
  var ID = {
    HLIF_AVOID: 8002, HLIF_CHANGE: 8004, HAMI_DEFENCE: 8006, HAMI_BLOODLUST: 8008,
    HFLI_MOON: 8009, HFLI_FLEET: 8010, HFLI_SPEED: 8011, HVAN_CAPRICE: 8013,
    MH_NEEDLE: 8019, MH_POISON_MIST: 8020, MH_OVERED_BOOST: 8023, MH_ERASER_CUTTER: 8024,
    MH_XENO_SLASHER: 8025, MH_SONIC_CLAW: 8028, MH_STAHL_HORN: 8031, MH_GOLDENE_FERSE: 8032,
    MH_STEINWAND: 8033, MH_HEILIGE_STANGE: 8034, MH_ANGRIFFS_MODUS: 8035, MH_MAGMA_FLOW: 8039,
    MH_GRANITIC_ARMOR: 8040, MH_LAVA_SLIDE: 8041, MH_PYROCLASTIC: 8042, MH_BLAST_FORGE: 8044, MH_TEMPERING: 8045,
  };

  // padrões do BR-AI (espelham lua/src/data/profiles.lua) — p/ saber quando GRAVAR override
  var DEFAULTS = {
    1: { offBuff: ID.HLIF_CHANGE, defBuff: ID.HLIF_AVOID },
    2: { offBuff: ID.HAMI_BLOODLUST, defBuff: ID.HAMI_DEFENCE },
    3: { mainAtk: ID.HFLI_MOON, offBuff: ID.HFLI_FLEET, defBuff: ID.HFLI_SPEED },
    4: { mainAtk: ID.HVAN_CAPRICE },
    48: { mainAtk: ID.MH_ERASER_CUTTER, aoeAtk: ID.MH_XENO_SLASHER, offBuff: ID.MH_OVERED_BOOST },
    49: { mainAtk: ID.MH_STAHL_HORN, aoeAtk: ID.MH_HEILIGE_STANGE, offBuff: ID.MH_GOLDENE_FERSE, defBuff: ID.MH_STEINWAND },
    50: { mainAtk: ID.MH_NEEDLE, aoeAtk: ID.MH_POISON_MIST },
    51: { aoeAtk: ID.MH_LAVA_SLIDE, offBuff: ID.MH_PYROCLASTIC, defBuff: ID.MH_GRANITIC_ARMOR },
    52: { mainAtk: ID.MH_SONIC_CLAW },
  };

  // specs por tipo: como resolver a skill de cada papel a partir do H_Config.
  //   single  → { role, id, enableKey?, levelKey? }   (enableKey ausente = sempre ligado)
  //   alts    → { role, alts:[{id, enableKey, levelKey?}] }  (escolhe o 1º habilitado)
  var SPECS = {
    1: [{ role: 'offBuff', id: ID.HLIF_CHANGE }, { role: 'defBuff', id: ID.HLIF_AVOID, levelKey: 'LifEscapeLevel' }],
    2: [{ role: 'offBuff', id: ID.HAMI_BLOODLUST }, { role: 'defBuff', id: ID.HAMI_DEFENCE, levelKey: 'AmiBulwarkLevel' }],
    3: [{ role: 'mainAtk', id: ID.HFLI_MOON }, { role: 'offBuff', id: ID.HFLI_FLEET, levelKey: 'FilirFlitLevel' }, { role: 'defBuff', id: ID.HFLI_SPEED, levelKey: 'FilirAccelLevel' }],
    4: [{ role: 'mainAtk', id: ID.HVAN_CAPRICE }],
    48: [
      { role: 'mainAtk', id: ID.MH_ERASER_CUTTER, enableKey: 'UseEiraEraseCutter', levelKey: 'EiraEraseCutterLevel' },
      { role: 'aoeAtk', id: ID.MH_XENO_SLASHER, enableKey: 'UseEiraXenoSlasher', levelKey: 'EiraXenoSlasherLevel' },
      { role: 'offBuff', id: ID.MH_OVERED_BOOST, enableKey: 'UseEiraOveredBoost' },
    ],
    49: [
      { role: 'mainAtk', id: ID.MH_STAHL_HORN, enableKey: 'UseBayeriStahlHorn', levelKey: 'BayeriStahlHornLevel' },
      { role: 'aoeAtk', id: ID.MH_HEILIGE_STANGE, enableKey: 'UseBayeriHailegeStar', levelKey: 'BayeriHailegeStarLevel' },
      { role: 'offBuff', alts: [{ id: ID.MH_GOLDENE_FERSE, enableKey: 'UseBayeriGoldenPherze' }, { id: ID.MH_ANGRIFFS_MODUS, enableKey: 'UseBayeriAngriffModus' }] },
      { role: 'defBuff', id: ID.MH_STEINWAND, enableKey: 'UseBayeriSteinWand', levelKey: 'BayeriSteinWandLevel' },
    ],
    50: [
      { role: 'mainAtk', id: ID.MH_NEEDLE, enableKey: 'UseSeraParalyze', levelKey: 'SeraParalyzeLevel' },
      { role: 'aoeAtk', id: ID.MH_POISON_MIST, enableKey: 'UseSeraPoisonMist', levelKey: 'SeraPoisonMistLevel' },
    ],
    51: [
      { role: 'aoeAtk', alts: [{ id: ID.MH_LAVA_SLIDE, enableKey: 'UseDieterLavaSlide', levelKey: 'DieterLavaSlideLevel' }, { id: ID.MH_BLAST_FORGE, enableKey: 'UseDieterBlastForge' }] },
      { role: 'offBuff', alts: [{ id: ID.MH_PYROCLASTIC, enableKey: 'UseDieterPyroclastic', levelKey: 'DieterPyroclasticLevel' }, { id: ID.MH_TEMPERING, enableKey: 'UseDieterTempering', levelKey: 'UseDieterTemperingLevel' }] },
      { role: 'defBuff', alts: [{ id: ID.MH_GRANITIC_ARMOR, enableKey: 'UseDieterGraniticArmor' }, { id: ID.MH_MAGMA_FLOW, enableKey: 'UseDieterMagmaFlow' }] },
    ],
    52: [{ role: 'mainAtk', id: ID.MH_SONIC_CLAW, enableKey: 'UseEleanorSonicClaw', levelKey: 'EleanorSonicClawLevel' }],
  };

  function has(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function enabled(hconfig, key) { return !key || (has(hconfig, key) ? num(hconfig[key]) !== 0 : true); }

  function mapSkills(skillList, hconfig) {
    skillList = skillList || {}; hconfig = hconfig || {};
    var choices = {}, rows = [], notes = [], consumed = {}, disabledRoles = {};
    function mark(k) { if (k) consumed[k] = true; }
    function slLevel(type, id) { var t = skillList[type] || skillList[String(type)]; return t ? (t[id] || t[String(id)]) : null; }
    function lvlKey(key) { if (key && has(hconfig, key)) { mark(key); var n = num(hconfig[key]); return n > 0 ? n : null; } return null; }

    Object.keys(SPECS).forEach(function (typeKey) {
      var type = Number(typeKey);
      var specs = SPECS[type], roles = {}, def = DEFAULTS[type] || {};
      specs.forEach(function (sp) {
        var id = null, levelKey = sp.levelKey;
        if (sp.alts) {
          for (var a = 0; a < sp.alts.length; a++) { mark(sp.alts[a].enableKey); }
          for (var b = 0; b < sp.alts.length; b++) {
            if (enabled(hconfig, sp.alts[b].enableKey)) { id = sp.alts[b].id; levelKey = sp.alts[b].levelKey; break; }
          }
          if (id == null) { notes.push(skillNote(type, sp.role, 'nenhuma skill habilitada p/ o papel — mantém padrão do BR-AI')); return; }
        } else {
          mark(sp.enableKey);
          if (!enabled(hconfig, sp.enableKey)) {
            disabledRoles[type] = disabledRoles[type] || {}; disabledRoles[type][sp.role] = true;
            notes.push(skillNote(type, sp.role, 'desabilitada na AzzyAI (' + sp.enableKey + '=0)'));
            rows.push({ from: sp.enableKey + ' = 0', to: tname(type) + ': papel ' + sp.role + ' DESATIVADO', status: 'note' });
            return;
          }
          id = sp.id;
        }
        var level = lvlKey(levelKey) || slLevel(type, id) || null;
        var differs = def[sp.role] != null && id !== def[sp.role];
        if (differs) roles[sp.role] = id;
        if (level != null) roles[sp.role + 'Level'] = level;
        rows.push({
          from: tname(type) + ' · ' + sp.role + (levelKey ? ' (' + levelKey + ')' : ''),
          to: 'skill #' + id + (differs ? ' (override do padrão)' : ' (padrão)') + (level != null ? ' · nível ' + level : ''),
          status: differs ? 'adjusted' : 'mapped',
        });
      });
      if (Object.keys(roles).length) choices[String(type)] = roles;
    });

    return { skillChoices: { choices: choices }, rows: rows, consumed: consumed, notes: notes, disabledRoles: disabledRoles };
  }

  var TN = { 1: 'Lif', 2: 'Amistr', 3: 'Filir', 4: 'Vanilmirth', 48: 'Eira', 49: 'Bayeri', 50: 'Sera', 51: 'Dieter', 52: 'Eleanor' };
  function tname(t) { return TN[t] || ('tipo ' + t); }
  function skillNote(type, role, msg) { return tname(type) + ' · ' + role + ': ' + msg; }

  var api = { mapSkills: mapSkills, DEFAULTS: DEFAULTS, SPECS: SPECS, ID: ID };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_MIG_MAP_SKILLS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// map_tactics.js — H_Tactics + H_Avoid → grupos por TUPLA IDÊNTICA + nós monsterCheck.
// Monstros com a MESMA tupla caem no MESMO "Grupo N". A tupla == Padrão (MyTact[0]) é pulada.
// Cada grupo vira monsterCheck(group=N) → filho (comportamento traduzido). H_Avoid → grupo
// "Evitar (MVP)" + config.BossGroup. Saída:
//   { monsters, groups, tacticsBranch, bossGroupId, rows, notes, consumed, tacticsRaw }
(function (root) {
  'use strict';
  var luaParse = (typeof require !== 'undefined') ? require('./lua_parse.js')
    : (typeof window !== 'undefined' ? window.BRAI_LUA_PARSE : null);
  var toArray = luaParse && luaParse.toArray;

  // índices (0-based) e constantes dos campos da tupla
  var F_BASIC = 0, F_KITE = 2, F_SNIPE = 9, F_CHASE = 12;
  var TACT_IGNORE = 0, KITE_ALWAYS = 2;
  function isSnipe(b) { return b >= 10 && b <= 12; }            // TACT_SNIPE_L/M/H
  function isReact(b) { return b === 5 || b === 7 || b === 8 || b === 9; } // TACT_REACT_*

  function behaviorFor(t) {
    var basic = t[F_BASIC], kite = t[F_KITE];
    if (basic === TACT_IGNORE) return 'ignore';
    if (kite === KITE_ALWAYS) return 'kite';
    if (isSnipe(basic)) return 'snipe';
    if (isReact(basic)) return 'react';
    return 'attack';
  }
  // filho do monsterCheck por comportamento. fid: 'green' (nó já existe) | 'yellow' (aproximado)
  function childFor(beh) {
    switch (beh) {
      case 'ignore': return { node: { type: 'action', name: 'Idle', label: 'ignorar' }, fid: 'yellow', hint: 'Ignorar' };
      case 'kite': return { node: { type: 'action', name: 'Kite', label: 'kite' }, fid: 'green', hint: 'Kite' };
      case 'snipe': return { node: { type: 'action', name: 'UseMainSkill', label: 'snipe (skill)' }, fid: 'yellow', hint: 'Snipe' };
      case 'react': return { node: { type: 'check', name: 'BeingAttacked', label: 'só se atacado', child: { type: 'action', name: 'AttackTarget' } }, fid: 'yellow', hint: 'Reagir' };
      default: return { node: { type: 'action', name: 'AttackTarget', label: 'atacar' }, fid: 'green', hint: 'Atacar' };
    }
  }

  // nomes dos monstros vêm dos comentários do H_Tactics (o parser os descarta)
  function parseNames(rawText) {
    var names = {};
    if (!rawText) return names;
    var re = /MyTact\[(\d+)\]\s*=\s*\{[^}]*\}\s*--\s*(.*)/g, m;
    while ((m = re.exec(rawText))) { names[Number(m[1])] = m[2].trim(); }
    return names;
  }

  function densify(t) { return toArray ? toArray(t) : t; }

  function mapTactics(myTact, avoid, rawTacticsText, opts) {
    var useAvoid = !(opts && opts.useAvoid === false);  // UseAvoid=0 na AzzyAI → sem grupo Evitar
    myTact = myTact || {};
    var names = parseNames(rawTacticsText);
    var rows = [], notes = [], consumed = {}, tacticsRaw = {};

    var defaultSig = myTact[0] ? JSON.stringify(densify(myTact[0])) : null;

    // agrupa ids (≠0, ≠avoid) por assinatura da tupla, pulando os iguais ao Padrão
    var avoidSet = {};
    if (avoid) for (var ak in avoid) if (avoid.hasOwnProperty(ak) && Number(avoid[ak]) !== 0) avoidSet[Number(ak)] = true;

    var bySig = {}, order = [];
    Object.keys(myTact).forEach(function (k) {
      var id = Number(k);
      if (id === 0 || avoidSet[id]) return;
      var tup = densify(myTact[k]);
      if (!tup || !tup.length) return;
      var sig = JSON.stringify(tup);
      tacticsRaw[id] = tup;
      if (sig === defaultSig) return;                 // já é o comportamento padrão da árvore
      if (!bySig[sig]) { bySig[sig] = { sig: sig, tuple: tup, members: [] }; order.push(sig); }
      bySig[sig].members.push(id);
    });

    var monsters = [], groups = [], singles = [], monsterChecks = [], gid = 0;
    function addMonster(id) { monsters.push({ id: id, desc: names[id] || ('Mob ' + id) }); }

    order.forEach(function (sig) {
      var g = bySig[sig];
      var beh = behaviorFor(g.tuple);
      var cf = childFor(beh);
      if (g.members.length === 1) {                       // 1 monstro => "tática por monstro" (monsterCheck por id)
        var id = g.members[0]; addMonster(id);
        var dsc = names[id] || ('Mob ' + id);
        singles.push({ id: id, desc: dsc, behavior: cf.hint, fid: cf.fid });
        monsterChecks.push({ type: 'monsterCheck', monster: id, label: dsc, child: cf.node });
        if (cf.fid === 'yellow') notes.push(dsc + ': comportamento «' + cf.hint + '» é encaixe aproximado — revise.');
        rows.push({ from: dsc, to: dsc + ' → ' + cf.hint + (cf.fid === 'yellow' ? ' 🟡' : ' 🟢'), status: cf.fid === 'yellow' ? 'adjusted' : 'mapped' });
      } else {                                            // 2+ monstros => grupo
        gid++;
        var name = 'Grupo ' + gid + ' · ' + cf.hint;
        g.members.forEach(addMonster);
        groups.push({ id: gid, name: name, members: g.members.slice(), behavior: cf.hint, fid: cf.fid });
        monsterChecks.push({ type: 'monsterCheck', group: gid, label: name, child: cf.node });
        if (cf.fid === 'yellow') notes.push(name + ': comportamento «' + cf.hint + '» é encaixe aproximado — revise o filho do monsterCheck.');
        rows.push({ from: g.members.map(function (mid) { return names[mid] || mid; }).join(', '), to: name + ' → ' + cf.hint + (cf.fid === 'yellow' ? ' 🟡' : ' 🟢'), status: cf.fid === 'yellow' ? 'adjusted' : 'mapped' });
      }
    });

    // H_Avoid → SEMPRE vira config.BossGroup (detecção de chefe: TargetIsBoss, poda do EQC).
    // O ramo de FUGA (monsterCheck→Flee) só é injetado quando UseAvoid≠0 (UseAvoid=0 = não foge, igual à AzzyAI).
    var bossGroupId = 0;
    var avoidIds = Object.keys(avoidSet).map(Number);
    if (avoidIds.length) {
      gid++; bossGroupId = gid;
      avoidIds.forEach(addMonster);
      groups.push({ id: gid, name: 'Grupo ' + gid + ' · Evitar (MVP)', members: avoidIds, behavior: 'Evitar (MVP)', fid: 'green' });
      consumed['MyAvoid'] = true;
      if (useAvoid) {
        monsterChecks.push({ type: 'monsterCheck', group: gid, label: 'Grupo ' + gid + ' · Evitar (MVP)', child: { type: 'action', name: 'Flee', label: 'fugir do chefe' } });
        rows.push({ from: avoidIds.length + ' MVP(s) de H_Avoid', to: 'Grupo ' + gid + ' → ramo de fuga + config.BossGroup', status: 'mapped' });
        notes.push('Evitar (MVP): ' + avoidIds.length + ' monstros do H_Avoid → grupo de fuga + config.BossGroup = ' + bossGroupId + '.');
      } else {
        rows.push({ from: avoidIds.length + ' MVP(s) de H_Avoid · UseAvoid=0', to: 'config.BossGroup = ' + bossGroupId + ' (detecção de chefe; SEM ramo de fuga)', status: 'mapped' });
        notes.push('UseAvoid=0: BossGroup definido p/ detecção de chefe, mas sem ramo de fuga (igual à AzzyAI).');
      }
    }

    var tacticsBranch = monsterChecks.length
      ? { type: 'selector', label: 'Táticas por monstro', children: monsterChecks }
      : null;

    return {
      monsters: monsters, groups: groups, singles: singles, tacticsBranch: tacticsBranch, bossGroupId: bossGroupId,
      rows: rows, notes: notes, consumed: consumed, tacticsRaw: tacticsRaw,
    };
  }

  var api = { mapTactics: mapTactics, behaviorFor: behaviorFor, childFor: childFor, parseNames: parseNames };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_MIG_MAP_TACTICS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// map_misc.js — listas auxiliares (A_Friends, Mob_ID) → notas informativas no relatório.
// O BR-AI ainda não tem sistema de amigos/PVP; aqui só relatamos (honestidade > silêncio).
(function (root) {
  'use strict';
  var NAMES = { 13: 'ALLY', 12: 'KOS', 11: 'ENEMY', 10: 'NEUTRAL', 2: 'RETAINER', 1: 'FRIEND', 3: 'PKFRIEND' };

  function mapMisc(friends, mobid) {
    var rows = [], notes = [], consumed = {};
    var counts = {}, total = 0;
    if (friends && typeof friends === 'object') {
      for (var k in friends) if (friends.hasOwnProperty(k)) {
        var n = Number(k); if (isNaN(n)) continue;
        var v = friends[k]; var label = NAMES[Number(v)] || (v === true ? 'FRIEND' : String(v));
        counts[label] = (counts[label] || 0) + 1; total++;
      }
    }
    if (total) {
      var parts = Object.keys(counts).map(function (c) { return counts[c] + '×' + c; }).join(', ');
      notes.push(total + ' entradas de amigos/PVP detectadas (' + parts + '). O BR-AI ainda não tem sistema de amigos — registre manualmente se for usar PVP.');
      rows.push({ from: 'A_Friends (' + total + ' entradas)', to: 'não migrado (sem sistema de amigos no BR-AI)', status: 'note' });
    }
    if (mobid && typeof mobid === 'object') {
      var mc = Object.keys(mobid).length;
      if (mc) { notes.push(mc + ' IDs customizados em Mob_ID — informativo.'); rows.push({ from: 'Mob_ID (' + mc + ')', to: 'informativo', status: 'note' }); }
    }
    return { rows: rows, notes: notes, consumed: consumed };
  }

  var api = { mapMisc: mapMisc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_MIG_MAP_MISC = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// migrate.js — orquestra a migração AzzyAI → BR-AI. JS puro (Node + navegador).
//   migrate(files, opts) → MigrationResult {
//     wrapper:{name,homunType,baseType,spec}, config, monsters, skillChoices,
//     report:{ sections:[{title,rows}], counts }, notes, fromMigration:true }
//   files = { basename → texto }   opts = { defaultTree?, homunType?, name? }
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  function dep(node, win) { return req ? req(node) : (typeof window !== 'undefined' ? window[win] : null); }
  var luaParse = dep('./lua_parse.js', 'BRAI_LUA_PARSE');
  var symbols = dep('./symbols.js', 'BRAI_MIG_SYMBOLS');
  var mapCfg = dep('./map_config.js', 'BRAI_MIG_MAP_CONFIG');
  var mapSkl = dep('./map_skills.js', 'BRAI_MIG_MAP_SKILLS');
  var mapTac = dep('./map_tactics.js', 'BRAI_MIG_MAP_TACTICS');
  var mapMsc = dep('./map_misc.js', 'BRAI_MIG_MAP_MISC');

  var pick = symbols.pick;
  function parse(txt, env) { return luaParse.parse(txt, env || {}); }

  // árvore padrão: no navegador a UI passa opts.defaultTree; no Node lemos o JSON compartilhado.
  function loadDefaultTree(opts) {
    if (opts && opts.defaultTree) return JSON.parse(JSON.stringify(opts.defaultTree));
    if (req) { var fs = req('fs'), path = req('path'); return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tree_homun.json'), 'utf8')); }
    throw new Error('árvore padrão não fornecida (opts.defaultTree)');
  }

  // ---- utilidades de árvore ----
  function walk(n, fn) {
    if (!n || typeof n !== 'object') return;
    fn(n);
    if (Array.isArray(n.children)) n.children.forEach(function (c) { walk(c, fn); });
    if (n.child) walk(n.child, fn);
  }
  function matchNode(n, m) {
    if (m.label) return n.label === m.label;
    if (m.action) return n.type === 'action' && n.name === m.action;
    if (m.actions) return n.type === 'action' && m.actions.indexOf(n.name) >= 0;
    return false;
  }
  function applyToggles(spec, toggles) {
    (toggles || []).forEach(function (t) {
      if (t.enabled !== false) return;          // só desativamos quando o flag pede
      walk(spec, function (n) { if (matchNode(n, t.match)) n.disabled = true; });
    });
  }
  function disableActions(spec, names) {
    walk(spec, function (n) { if (n.type === 'action' && names.indexOf(n.name) >= 0) n.disabled = true; });
  }
  function findByLabel(spec, label) {
    var found = null; walk(spec, function (n) { if (!found && n.label === label) found = n; }); return found;
  }

  // tipo de homún alvo: opção do usuário, senão o tipo com mais skills no SkillList, senão 4
  function pickType(opts, hconfig, skillList) {
    if (opts && opts.homunType) return Number(opts.homunType);
    var best = 0, bestN = -1;
    Object.keys(skillList || {}).forEach(function (k) {
      var t = Number(k); if (isNaN(t)) return;
      var n = Object.keys(skillList[k] || {}).length;
      var bonus = (t >= 48 && t <= 52) ? 0.5 : 0;   // desempate: prefere Homun S
      if (n + bonus > bestN) { bestN = n + bonus; best = t; }
    });
    if (best) return best;
    if (hconfig && hconfig.OldHomunType) return Number(hconfig.OldHomunType);
    return 4;
  }

  var SKIP_UNKNOWN = { LastSavedDate: 1, TactLastSavedDate: 1, ConfigPath: 1, AggressiveRelogPath: 1, AggressiveRelogTracking: 1, MagicNumber: 1, MagicNumber2: 1 };
  // knobs sem sentido no BR-AI (motor/timing/PVP) — "ignorados de propósito", não "requer atenção"
  var IGNORE_NOISE = {
    SpawnDelay: 1, AutoSkillDelay: 1, AutoSkillLimit: 1, AttackTimeLimit: 1, CastTimeRatio: 1,
    ChaseSPPause: 1, ChaseSPPauseSP: 1, ChaseSPPauseTime: 1, StienWandTelePause: 1, SteinWandTelePause: 1,
    LagReduction: 1, TankMonsterLimit: 1, AssumeHomun: 1, AttackLastFullSP: 1, LiveMobID: 1, AoEReserveSP: 1,
    PVPmode: 1, PVPMode: 1, PainkillerFriends: 1, PainkillerFriendsSave: 1, StandbyFriending: 1, MirAIFriending: 1,
    DefendStandby: 1, StickyStandby: 1, NewAutoFriend: 1, KSMercHomun: 1, RouteWalkCircle: 1,
  };

  function migrate(files, opts) {
    files = files || {}; opts = opts || {};
    var warnings = [];

    // 1) símbolos (FALLBACK + Const_/H_SkillList do zip)
    var built = symbols.buildEnv(files, luaParse.parse);
    var env = built.env; warnings = warnings.concat(built.warnings || []);

    // 2) parse dos arquivos de dados (no env de símbolos p/ resolver TACT_*, ELEANOR, etc.)
    var hconfig = {};
    var cfgTxt = pick(files, 'H_Config.lua'); if (cfgTxt != null) parse(cfgTxt, hconfig);
    var tacTxt = pick(files, 'H_Tactics.lua'); if (tacTxt != null) parse(tacTxt, env);
    var avoTxt = pick(files, 'H_Avoid.lua'); if (avoTxt != null) parse(avoTxt, env);
    var friTxt = pick(files, 'A_Friends.lua'); if (friTxt != null) parse(friTxt, env);
    var mobTxt = pick(files, 'Mob_ID.lua'); if (mobTxt != null) parse(mobTxt, env);

    // 3) mapeadores
    var rCfg = mapCfg.mapConfig(hconfig);
    var rSkl = mapSkl.mapSkills(env.SkillList || {}, hconfig);
    var useAvoid = !(hconfig.UseAvoid !== undefined && Number(hconfig.UseAvoid) === 0);  // UseAvoid=0 → sem grupo MVP
    var rTac = mapTac.mapTactics(env.MyTact || {}, env.MyAvoid || {}, tacTxt || '', { useAvoid: useAvoid });
    var rMsc = mapMsc.mapMisc(env.MyFriends || {}, env.MobID || {});

    // 4) tipo alvo + config final
    var homunType = pickType(opts, hconfig, env.SkillList || {});
    var baseType = symbols.isHomunS(homunType) ? (opts.baseType != null ? Number(opts.baseType) : Number(hconfig.OldHomunType || 0)) : 0;
    var config = {};
    for (var ck in rCfg.config) config[ck] = rCfg.config[ck];
    if (rTac.bossGroupId) config.BossGroup = rTac.bossGroupId;
    config.BaseHomunType = baseType;

    // Fase 8a: nível da invocação (Sera) → summon_choice (homun_summons.json)
    var summonChoices = { choices: {} };
    var summonLvl = Number(hconfig.SeraCallLegionLevel || 0);
    var summonOn = hconfig.UseSeraCallLegion === undefined || Number(hconfig.UseSeraCallLegion) !== 0;
    if (summonOn && summonLvl > 0) summonChoices.choices['50'] = { level: summonLvl };

    // 5) árvore: padrão → toggles → papéis desativados (do tipo) → injeta táticas
    var spec = loadDefaultTree(opts);
    applyToggles(spec, rCfg.branchToggles);
    var dr = rSkl.disabledRoles[homunType] || {};
    if (dr.aoeAtk) disableActions(spec, ['UseAoESkill']);
    if (dr.mainAtk) disableActions(spec, ['UseMainSkill']);
    if (rTac.tacticsBranch) {
      var combat = findByLabel(spec, 'combate-acao') || findByLabel(spec, 'Engajar');
      if (combat && Array.isArray(combat.children)) combat.children.unshift(rTac.tacticsBranch);
      else if (Array.isArray(spec.children)) spec.children.push(rTac.tacticsBranch);
    }
    // Fase 8a: ramos opcionais (nós já existentes), ligados pelo flag de config
    var combat8a = findByLabel(spec, 'combate-acao');
    if (combat8a && Array.isArray(combat8a.children)) {
      if (config.KiteMonsters || config.ForceKite) {
        var ti = -1; for (var ki = 0; ki < combat8a.children.length; ki++) { if (combat8a.children[ki].label === 'Táticas por monstro') { ti = ki; break; } }
        combat8a.children.splice(ti + 1, 0, { type: 'action', name: 'Kite', params: { gate: 'KiteMonsters' }, label: 'kitar' });
      }
      if (config.UseDanceAttack) {
        var ai = -1; for (var di = 0; di < combat8a.children.length; di++) { var cd = combat8a.children[di]; if (cd.type === 'check' && cd.name === 'InAttackRange') { ai = di; break; } }
        var dance = { type: 'action', name: 'DanceAttack', params: { gate: 'UseDanceAttack' }, label: 'dança' };
        if (ai >= 0) combat8a.children.splice(ai, 0, dance); else combat8a.children.push(dance);
      }
    }
    // Fase 8b: proteção do dono + estratégia de mira (nós já existentes, ligados por config)
    if (Array.isArray(spec.children)) {
      var engIdx = -1; for (var bi = 0; bi < spec.children.length; bi++) { if (spec.children[bi].label === 'Engajar') { engIdx = bi; break; } }
      if (engIdx < 0) engIdx = spec.children.length;
      if (config.DefensiveBuffOwnerMobbed) {                                  // buff no dono quando cercado (OwnerUnderAttack + UseOwnerBuff)
        spec.children.splice(engIdx, 0, { type: 'check', name: 'OwnerUnderAttack', params: { count: 2 }, label: 'dono cercado', child: { type: 'action', name: 'UseOwnerBuff', label: 'buff defensivo no dono' } });
        engIdx++;
      }
      if ((config.RescueOwnerLowHP || 0) > 0) {                               // resgate posicional quando o dono está com HP baixo
        spec.children.splice(engIdx, 0, { type: 'action', name: 'RescueOwner', label: 'resgatar dono' });
        engIdx++;
      }
    }
    if (config.OpportunisticTargeting) {                                      // troca p/ um alvo melhor (liga o ReacquireIfBetter)
      var setAlvo = findByLabel(spec, 'Definir alvo');
      if (setAlvo && Array.isArray(setAlvo.children)) {
        var temIdx = -1; for (var ci2 = 0; ci2 < setAlvo.children.length; ci2++) { if (setAlvo.children[ci2].label === 'Tem alvo') { temIdx = ci2; break; } }
        var reacq = { type: 'action', name: 'ReacquireIfBetter', params: { gate: 'OpportunisticTargeting' }, label: 'mira oportunista' };
        if (temIdx >= 0) setAlvo.children.splice(temIdx, 0, reacq); else setAlvo.children.unshift(reacq);
      }
    }
    if (config.UseSkillOnly) {                                                // só skill: bloqueia TODO ataque normal
      walk(spec, function (nn) { if (nn && nn.type === 'action' && nn.name === 'AttackTarget') { nn.params = nn.params || {}; nn.params.blockIf = 'UseSkillOnly'; } });
    }
    // Fase 8c: IdleWalk no ramo «ocioso» (os demais knobs — sticky, AoE, skill-S — são só config lida por nós já existentes)
    if (config.UseIdleWalk) {
      var ocioso = findByLabel(spec, 'ocioso');
      if (ocioso && Array.isArray(ocioso.children)) {
        var idi = -1; for (var oi = 0; oi < ocioso.children.length; oi++) { if (ocioso.children[oi].name === 'Idle') { idi = oi; break; } }
        var iw = { type: 'action', name: 'IdleWalk', label: 'perambular' };
        if (idi >= 0) ocioso.children.splice(idi, 0, iw); else ocioso.children.push(iw);
      }
    }

    // 6) catálogo de monstros (grupos das táticas)
    var monsters = { monsters: rTac.monsters, groups: rTac.groups };

    // 7) knobs não migrados (transparência)
    var consumed = {};
    [rCfg.consumed, rSkl.consumed, rTac.consumed].forEach(function (c) { for (var k in c) consumed[k] = true; });
    if (hconfig.UseAvoid !== undefined) consumed.UseAvoid = true;            // tratado via useAvoid (map_tactics)
    if (summonOn && summonLvl > 0) consumed.SeraCallLegionLevel = true;       // foi p/ summon_choice
    var ignored = [], couldImplement = [];
    Object.keys(hconfig).forEach(function (k) {
      if (consumed[k] || SKIP_UNKNOWN[k]) return;
      if (IGNORE_NOISE[k] || /Level$/.test(k)) ignored.push(k);              // interno/PVP/timing ou nível órfão (skill off/não-escolhida)
      else couldImplement.push(k);
    });

    // 8) relatório
    var attention = [];
    rSkl.notes.concat(rTac.notes, rMsc.notes).forEach(function (msg) { attention.push({ from: '⚠️', to: msg, status: 'note' }); });
    if (couldImplement.length) attention.push({ from: couldImplement.length + ' knobs poderiam ser implementados', to: couldImplement.slice(0, 24).join(', ') + (couldImplement.length > 24 ? '…' : ''), status: 'note' });
    if (ignored.length) attention.push({ from: ignored.length + ' ignorados de propósito (internos/PVP/níveis órfãos)', to: ignored.slice(0, 12).join(', ') + (ignored.length > 12 ? '…' : ''), status: 'note' });

    var sections = [
      { title: 'Configuração e ramos', rows: rCfg.rows },
      { title: 'Skills (4 papéis + nível)', rows: rSkl.rows },
      { title: 'Táticas por monstro', rows: rTac.rows },
      { title: 'Listas (amigos/avoid)', rows: rMsc.rows },
      { title: 'Não migrado / requer atenção', rows: attention },
    ];
    var counts = { mapped: 0, adjusted: 0, note: 0 };
    sections.forEach(function (s) { s.rows.forEach(function (r) { if (counts[r.status] != null) counts[r.status]++; }); });
    counts.groups = rTac.groups.length;
    counts.singles = (rTac.singles || []).length;
    counts.monsters = rTac.monsters.length;
    counts.skillTypes = Object.keys(rSkl.skillChoices.choices).length;
    counts.couldImplement = couldImplement.length;
    counts.ignored = ignored.length;

    var name = (opts.name || 'azzyai-migrada');
    return {
      wrapper: { name: name, homunType: homunType, baseType: baseType, spec: spec },
      config: config,
      monsters: monsters,
      singles: rTac.singles,
      skillChoices: rSkl.skillChoices,
      summonChoices: summonChoices,
      report: { sections: sections, counts: counts },
      tacticsRaw: rTac.tacticsRaw,
      warnings: warnings,
      fromMigration: true,
    };
  }

  // applyGroupNames — renomeia grupos (de->para) e os labels dos nos monsterCheck. Puro; usado pela UI.
  function applyGroupNames(result, overrides) {
    if (!result || !overrides) return result;
    var groups = (result.monsters && result.monsters.groups) || [];
    groups.forEach(function (g) {
      var nm = overrides[g.id];
      if (nm != null && String(nm).trim() !== '') g.name = String(nm);
    });
    if (result.wrapper && result.wrapper.spec) {
      walk(result.wrapper.spec, function (n) {
        if (n.type === 'monsterCheck' && n.group != null) {
          var nm = overrides[n.group];
          if (nm != null && String(nm).trim() !== '') n.label = String(nm);
        }
      });
    }
    return result;
  }

// applyMonsterNames — renomeia monstros (singles) e o label dos monsterCheck(monster=id). Puro.
  function applyMonsterNames(result, overrides) {
    if (!result || !overrides) return result;
    var mons = (result.monsters && result.monsters.monsters) || [];
    mons.forEach(function (m) { var nm = overrides[m.id]; if (nm != null && String(nm).trim() !== '') m.desc = String(nm); });
    (result.singles || []).forEach(function (sg) { var nm = overrides[sg.id]; if (nm != null && String(nm).trim() !== '') sg.desc = String(nm); });
    if (result.wrapper && result.wrapper.spec) {
      walk(result.wrapper.spec, function (n) {
        if (n.type === 'monsterCheck' && n.monster != null) {
          var nm = overrides[n.monster]; if (nm != null && String(nm).trim() !== '') n.label = String(nm);
        }
      });
    }
    return result;
  }

  var api = { migrate: migrate, applyGroupNames: applyGroupNames, applyMonsterNames: applyMonsterNames, _walk: walk, _applyToggles: applyToggles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BRAI_MIGRATE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

;
// default_tree.js — AUTOGERADO de desktop/shared/tree_homun.json (arvore padrao BR-AI).
// Embarca a arvore padrao p/ o migrador funcionar sem fetch (estatica/offline).
(function(root){
  var TREE = {
  "type": "selector",
  "label": "root",
  "children": [
    {
      "type": "check",
      "name": "HasOwnerCommand",
      "label": "comando",
      "child": {
        "type": "action",
        "name": "HandleOwnerCommand"
      }
    },
    {
      "type": "check",
      "name": "ShouldFlee",
      "label": "sobrevivencia",
      "child": {
        "type": "action",
        "name": "Flee"
      }
    },
    {
      "type": "selector",
      "label": "cura-urgente",
      "children": [
        {
          "type": "action",
          "name": "UseHealSelf"
        },
        {
          "type": "action",
          "name": "UseHealOwner"
        }
      ]
    },
    {
      "type": "action",
      "name": "UseCastling"
    },
    {
      "type": "action",
      "name": "UseOwnerBuff"
    },
    {
      "type": "sequence",
      "label": "Engajar",
      "children": [
        {
          "type": "selector",
          "label": "Definir alvo",
          "children": [
            {
              "type": "check",
              "name": "OwnerUnderAttack",
              "params": {},
              "label": "Dono sob ataque",
              "child": {
                "type": "action",
                "name": "AcquireOwnerAttacker",
                "params": {}
              }
            },
            {
              "type": "check",
              "name": "HasValidTarget",
              "params": {},
              "label": "Tem alvo"
            },
            {
              "type": "check",
              "name": "CanEngage",
              "params": {},
              "label": "Pode engajar",
              "child": {
                "type": "action",
                "name": "AcquireTarget",
                "params": {}
              }
            }
          ]
        },
        {
          "type": "selector",
          "label": "combate-acao",
          "children": [
            {
              "type": "action",
              "name": "UseSummon"
            },
            {
              "type": "action",
              "name": "UseAoESkill"
            },
            {
              "type": "action",
              "name": "UseMainSkill"
            },
            {
              "type": "check",
              "name": "InAttackRange",
              "child": {
                "type": "action",
                "name": "AttackTarget"
              }
            },
            {
              "type": "action",
              "name": "ChaseTarget"
            }
          ]
        }
      ]
    },
    {
      "type": "selector",
      "label": "ocioso",
      "children": [
        {
          "type": "check",
          "name": "TooFarFromOwner",
          "params": {
            "dist": 3
          },
          "child": {
            "type": "action",
            "name": "MoveToOwner"
          }
        },
        {
          "type": "action",
          "name": "UseOffensiveBuff"
        },
        {
          "type": "action",
          "name": "UseDefensiveBuff"
        },
        {
          "type": "action",
          "name": "Idle"
        }
      ]
    }
  ]
};
  if (typeof module !== "undefined" && module.exports) module.exports = TREE;
  if (typeof window !== "undefined") window.BRAI_DEFAULT_TREE = TREE;
})(typeof globalThis !== "undefined" ? globalThis : this);
