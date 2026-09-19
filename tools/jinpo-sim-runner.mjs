#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');

const TEAMS = ['A', 'B', 'C'];
const TACTICS = ['rush', 'guard', 'stealth', 'annihilate', 'honden'];
const LEVELS = new Set(['weak', 'strong', 'max']);

function parseArgs(argv) {
  const out = {
    games: 2000,
    seed: 1105,
    out: path.join(ROOT, 'sim-results'),
    level: 'strong',
    tactics: TACTICS.slice(),
    progress: 250
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--games') out.games = Number(next());
    else if (a === '--seed') out.seed = Number(next());
    else if (a === '--out') out.out = path.resolve(next());
    else if (a === '--level') out.level = String(next());
    else if (a === '--tactics') out.tactics = String(next()).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--progress') out.progress = Number(next());
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(out.games) || out.games <= 0) throw new Error('--games must be a positive number');
  if (!Number.isFinite(out.seed)) throw new Error('--seed must be a number');
  if (!LEVELS.has(out.level)) throw new Error('--level must be weak, strong, or max');
  out.games = Math.floor(out.games);
  return out;
}

function printHelp() {
  console.log(`JINPO automatic simulator

Usage:
  node tools/jinpo-sim-runner.mjs --games 2000 --seed 1105 --out sim-results

Options:
  --games N          Number of games to run. Default: 2000
  --seed N           Deterministic seed. Default: 1105
  --out DIR          Output directory for CSV/JSON. Default: ./sim-results
  --level LEVEL      weak, strong, or max. Default: strong
  --tactics LIST     Comma-separated tactics. Default: rush,guard,stealth,annihilate,honden
  --progress N       Print progress every N games. Default: 250
`);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeMath(rand) {
  const math = {};
  for (const k of Object.getOwnPropertyNames(Math)) {
    Object.defineProperty(math, k, Object.getOwnPropertyDescriptor(Math, k));
  }
  math.random = rand;
  return math;
}

function extractScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
}

function loadEngine(rand) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const scripts = extractScripts(html);
  const main = scripts.find(s => s.includes('const CELL = 40;') && s.includes('const RULES ='));
  const smart = scripts.find(s => s.includes('window.SMART') && s.includes('function evalState'));
  if (!main || !smart) throw new Error('Could not locate JINPO rule/SMART scripts in index.html');

  const coreStart = main.indexOf('const CELL = 40;');
  const coreEnd = main.indexOf('/* ===== ネットワーク層');
  if (coreStart < 0 || coreEnd < 0) throw new Error('Could not isolate core rule script');
  const core = main.slice(coreStart, coreEnd);
  const expose = `
window.__JINPO_CORE__ = {
  SQ, ADJ, BROKEN_WALL_LINKS, ROSTER, SQUADS, WEAPONS, WP, effWp,
  rosterOf, memberOf, fixedOf, freeRoster, weaponsFor,
  RULES, OTHER, JPN, floorOfPos, corrIndex, forwardSign, adjacentSquares, kusanagiWallsBroken
};`;

  const context = {
    console,
    Date,
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: null,
    Math: makeMath(rand)
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${core}\n${expose}\n${smart}`, context, { filename: 'jinpo-engine.vm.js' });
  instrumentRules(context.__JINPO_CORE__.RULES);
  return context;
}

function instrumentRules(RULES) {
  const origUse = RULES.useWeapon;
  RULES.useWeapon = function useWeaponWithEvent(g, sid, target, extra) {
    const s = RULES.getS(g, sid);
    const wp = s && s.wp;
    const team = s && s.team;
    const name = s && s.name;
    const r = origUse(g, sid, target, extra);
    if (r && r.ok && team && wp) {
      g.simEvents = g.simEvents || [];
      g.simEvents.push({
        type: r.declared ? 'weapon_declare' : 'weapon',
        wp,
        sid,
        name,
        team,
        target: target || null,
        direction: null,
        stage: r.declared ? 'declare' : null,
        turn: g.turn,
        round: Math.ceil(g.turn / 2)
      });
    }
    return r;
  };
}

function shuffle(a, rand) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function pick(a, rand) {
  return a[Math.floor(rand() * a.length)];
}

function weaponWeight(id, tactic) {
  const table = {
    rush: { iincho: 7, charisma: 7, maeba: 7, zutai: 6, moonwalk: 5, ogoru: 4, daichari: 4, funnel: 3 },
    guard: { iincho: 8, toyoko: 6, phoenix: 6, ikkun: 5, aga: 5, hardgel: 5, virgin: 4, onnabancho: 4 },
    stealth: { iemuri: 7, toyoko: 7, shinasadame: 4, virgin: 4, onnabancho: 4, pakuri: 4, hardgel: 3 },
    annihilate: { nonoka: 8, iemuri: 7, chinbo: 6, funnel: 6, ikkun: 5, hardgel: 4, charisma: 4 },
    honden: { maeba: 8, charisma: 7, zutai: 6, moonwalk: 6, iincho: 5, ogoru: 4, shuchi: 3 }
  };
  return ((table[tactic] && table[tactic][id]) || 1);
}

function buildSquad(core, letter, tactic, profile, rand) {
  const { fixedOf, freeRoster, memberOf, weaponsFor } = core;
  const free = shuffle(freeRoster(letter).slice(), rand).slice(0, 6);
  const slots = free.map(m => ({ role: 'soldier', name: m.name, wp: null }));
  slots.push({ role: 'mega', name: fixedOf(letter, 'mega').name, wp: null });
  slots.push({ role: 'flag', name: fixedOf(letter, 'flag').name, wp: null });
  if (profile === 'none') return slots;

  const used = new Set();
  const order = shuffle(slots.map((_, i) => i), rand);
  for (const i of order) {
    if (profile === 'sparse' && rand() < 0.45) continue;
    const m = memberOf(letter, slots[i].name);
    const legal = weaponsFor(letter, m).filter(w => !used.has(w.id));
    if (!legal.length) continue;
    let chosen;
    if (profile === 'random') {
      if (rand() < 0.14) continue;
      chosen = pick(legal, rand);
    } else {
      const ranked = legal
        .map(w => ({ w, score: weaponWeight(w.id, tactic) + rand() * 1.75 }))
        .sort((a, b) => b.score - a.score);
      chosen = ranked[0].w;
    }
    slots[i].wp = chosen.id;
    used.add(chosen.id);
  }
  return slots;
}

function sqList(core, team, pred) {
  return Object.values(core.SQ).filter(q => q.team === team && pred(q)).map(q => q.id);
}

function buildPlacement(core, side, letter, squad, tactic, rand) {
  const { SQ, RULES } = core;
  const doors = side === 'blue' ? ['A3', 'A4', 'C3', 'C4'] : ['B27', 'B28', 'D27', 'D28'];
  const home = side === 'blue' ? ['P5', 'P6'] : ['Q5', 'Q6'];
  const tSquares = sqList(core, side, q => q.kind === 'T');
  const roomSquares = sqList(core, side, q => !!q.room);
  const corrSquares = sqList(core, side, q => q.kind === 'corridor');
  const nonHome = sqList(core, side, q => q.kind !== 'honden');
  const allOwn = sqList(core, side, q => q.kind !== 'void');
  const used = new Set();
  const byRole = {
    flag: squad.filter(s => s.role === 'flag').slice(),
    mega: squad.filter(s => s.role === 'mega').slice(),
    soldier: squad.filter(s => s.role === 'soldier').slice()
  };
  const out = [];
  function take(role, pool) {
    const slot = byRole[role].shift();
    if (!slot) return false;
    const candidates = pool.filter(id => SQ[id] && SQ[id].team === side && !used.has(id));
    const pos = candidates.length ? pick(candidates, rand) : pick(allOwn.filter(id => !used.has(id)), rand);
    if (!pos) return false;
    used.add(pos);
    out.push({ role, pos, name: slot.name, wp: slot.wp });
    return true;
  }
  const flagPools = {
    rush: shuffle(tSquares.concat(roomSquares, home, nonHome), rand),
    guard: shuffle(tSquares.concat(roomSquares, home, nonHome), rand),
    stealth: shuffle(tSquares.concat(roomSquares, nonHome), rand),
    annihilate: shuffle(tSquares.concat(roomSquares, home, nonHome), rand),
    honden: shuffle(home.concat(tSquares, roomSquares, nonHome), rand)
  };
  const megaPools = {
    rush: shuffle(doors.concat(corrSquares, nonHome), rand),
    guard: shuffle(home.concat(doors, corrSquares, nonHome), rand),
    stealth: shuffle(corrSquares.concat(doors, nonHome), rand),
    annihilate: shuffle(corrSquares.concat(doors, nonHome), rand),
    honden: shuffle(doors.concat(corrSquares, nonHome), rand)
  };
  const soldierPools = {
    rush: shuffle(doors.concat(corrSquares, tSquares, nonHome), rand),
    guard: shuffle(doors.concat(home, tSquares, corrSquares, nonHome), rand),
    stealth: shuffle(tSquares.concat(roomSquares, corrSquares, nonHome), rand),
    annihilate: shuffle(corrSquares.concat(doors, tSquares, nonHome), rand),
    honden: shuffle(doors.concat(corrSquares, nonHome), rand)
  };
  take('flag', flagPools[tactic] || flagPools.guard);
  take('mega', megaPools[tactic] || megaPools.rush);
  while (byRole.soldier.length) take('soldier', soldierPools[tactic] || soldierPools.rush);

  const err = RULES.validatePlacement(out, side, letter);
  if (!err) return out;
  return randomPlacement(core, side, letter, squad, rand);
}

function randomPlacement(core, side, letter, squad, rand) {
  const { SQ, RULES } = core;
  for (let attempt = 0; attempt < 80; attempt++) {
    const own = shuffle(Object.values(SQ).filter(q => q.team === side).map(q => q.id), rand);
    const out = squad.map((s, i) => ({ role: s.role, pos: own[i], name: s.name, wp: s.wp }));
    if (!RULES.validatePlacement(out, side, letter)) return out;
  }
  throw new Error(`Could not create legal placement for ${side} team ${letter}`);
}

function matchupSchedule(tactics) {
  const out = [];
  for (const blueTeam of TEAMS) {
    for (const redTeam of TEAMS) {
      if (blueTeam === redTeam) continue;
      for (const first of ['blue', 'red']) {
        for (const blueTactic of tactics) {
          for (const redTactic of tactics) {
            out.push({ blueTeam, redTeam, first, blueTactic, redTactic });
          }
        }
      }
    }
  }
  return out;
}

function weaponProfile(gameIndex, side, tactic) {
  const n = gameIndex + (side === 'red' ? 3 : 0);
  if (n % 12 === 0) return 'none';
  if (n % 7 === 0) return 'sparse';
  if (n % 4 === 0) return 'random';
  return 'biased';
}

function playGame(engine, opts, config, gameIndex, rand) {
  const core = engine.__JINPO_CORE__;
  const { RULES } = core;
  const blueProfile = weaponProfile(gameIndex, 'blue', config.blueTactic);
  const redProfile = weaponProfile(gameIndex, 'red', config.redTactic);
  const blueSquad = buildSquad(core, config.blueTeam, config.blueTactic, blueProfile, rand);
  const redSquad = buildSquad(core, config.redTeam, config.redTactic, redProfile, rand);
  const bluePlace = buildPlacement(core, 'blue', config.blueTeam, blueSquad, config.blueTactic, rand);
  const redPlace = buildPlacement(core, 'red', config.redTeam, redSquad, config.redTactic, rand);
  const g = RULES.newGame(bluePlace, redPlace, config.first, { blue: config.blueTeam, red: config.redTeam });
  g.simEvents = [];
  const mem = { blue: {}, red: {} };
  for (let i = 0; i < 4 && RULES.pendingPakuri(g); i++) {
    engine.SMART.declarePakuri(g, RULES.pendingPakuri(g).team);
  }
  let safety = 0;
  while (g.phase === 'play' && safety++ < 64) {
    const side = g.activeTeam;
    const tactic = side === 'blue' ? config.blueTactic : config.redTactic;
    engine.SMART.act(g, side, mem[side], opts.level, { tactic });
    if (g.phase === 'play') RULES.endTurn(g);
  }
  if (g.phase === 'play') RULES.finalScore(g);
  const winnerSide = g.winner || 'draw';
  return {
    game: gameIndex + 1,
    blueTeam: config.blueTeam,
    redTeam: config.redTeam,
    first: config.first,
    blueTactic: config.blueTactic,
    redTactic: config.redTactic,
    blueWeaponProfile: blueProfile,
    redWeaponProfile: redProfile,
    winnerSide,
    winnerTeam: winnerSide === 'draw' ? 'draw' : config[`${winnerSide}Team`],
    winReason: classifyWin(g),
    turns: g.turn,
    rounds: Math.ceil(g.turn / 2),
    blueAlive: RULES.aliveCount(g, 'blue'),
    redAlive: RULES.aliveCount(g, 'red'),
    blueWeapons: equippedWeapons(bluePlace),
    redWeapons: equippedWeapons(redPlace),
    usedWeapons: (g.simEvents || []).map(e => `${e.team}:${e.wp}${e.stage ? ':' + e.stage : ''}${e.direction ? ':' + e.direction : ''}@${e.turn}`).join('|'),
    events: g.simEvents || []
  };
}

function equippedWeapons(place) {
  return place.map(p => p.wp).filter(Boolean).sort().join('|');
}

function classifyWin(g) {
  const text = (g.winLines || []).join(' ');
  if (!g.winner) return 'draw';
  if (text.includes('旗持ち')) return 'flag';
  if (text.includes('本殿')) return 'honden';
  if (text.includes('全滅')) return 'annihilation';
  if (text.includes('15ラウンド') || text.includes('生存数') || text.includes('敵陣内')) return 'decision';
  return 'other';
}

function bucket(map, key) {
  if (!map.has(key)) map.set(key, { key, games: 0, wins: 0, draws: 0 });
  return map.get(key);
}

function addPerspective(map, key, didWin, isDraw) {
  const b = bucket(map, key);
  b.games++;
  if (didWin) b.wins++;
  if (isDraw) b.draws++;
}

function pairKeys(items) {
  const out = [];
  const uniq = [...new Set(items)].sort();
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) out.push(`${uniq[i]}+${uniq[j]}`);
  }
  return out;
}

function summarize(results) {
  const byTeam = new Map();
  const byTeamVs = new Map();
  const byTactic = new Map();
  const byFirst = new Map();
  const matchups = new Map();
  const weaponStats = new Map();
  const pairStats = new Map();
  const loadouts = new Map();
  const activations = new Map();
  const reasons = new Map();

  for (const r of results) {
    const draw = r.winnerSide === 'draw';
    const blueWin = r.winnerSide === 'blue';
    const redWin = r.winnerSide === 'red';
    addPerspective(byTeam, r.blueTeam, blueWin, draw);
    addPerspective(byTeam, r.redTeam, redWin, draw);
    addPerspective(byTeamVs, `${r.blueTeam}_vs_${r.redTeam}`, blueWin, draw);
    addPerspective(byTeamVs, `${r.redTeam}_vs_${r.blueTeam}`, redWin, draw);
    addPerspective(byTactic, r.blueTactic, blueWin, draw);
    addPerspective(byTactic, r.redTactic, redWin, draw);
    addPerspective(byFirst, `${r.first}:${r[`${r.first}Team`]}`, r.winnerSide === r.first, draw);
    const mk = `${r.blueTeam}_blue_vs_${r.redTeam}_red_first_${r.first}`;
    if (!matchups.has(mk)) matchups.set(mk, { key: mk, games: 0, blueWins: 0, redWins: 0, draws: 0 });
    const mb = matchups.get(mk);
    mb.games++;
    if (blueWin) mb.blueWins++;
    if (redWin) mb.redWins++;
    if (draw) mb.draws++;
    bucket(reasons, r.winReason).games++;

    for (const side of ['blue', 'red']) {
      const team = r[`${side}Team`];
      const opp = r[`${side === 'blue' ? 'red' : 'blue'}Team`];
      const won = r.winnerSide === side;
      const weapons = r[`${side}Weapons`].split('|').filter(Boolean);
      for (const wp of weapons) addPerspective(weaponStats, `${team}:${wp}`, won, draw);
      for (const pair of pairKeys(weapons)) addPerspective(pairStats, `${team}:${pair}`, won, draw);
      const loadKey = `${team}_vs_${opp}_${r[`${side}Tactic`]}:${weapons.join('+') || 'none'}`;
      addPerspective(loadouts, loadKey, won, draw);
    }
    for (const ev of r.events) {
      if (ev.type === 'weapon_declare') continue;
      const side = ev.team;
      const team = r[`${side}Team`];
      const won = r.winnerSide === side;
      const key = `${team}:${ev.wp}`;
      if (!activations.has(key)) activations.set(key, { key, uses: 0, wins: 0, turnSum: 0, roundSum: 0 });
      const a = activations.get(key);
      a.uses++;
      if (won) a.wins++;
      a.turnSum += ev.turn;
      a.roundSum += ev.round;
      const ws = bucket(weaponStats, key);
      ws.uses = (ws.uses || 0) + 1;
    }
  }
  const teamRates = toRows(byTeam);
  const teamRateMap = Object.fromEntries(teamRates.map(r => [r.key, r.winRate]));
  const weaponRows = toRows(weaponStats).map(r => {
    const team = r.key.split(':')[0];
    return { ...r, uses: r.uses || 0, impactVsTeamBaseline: round(r.winRate - (teamRateMap[team] || 0), 4) };
  }).sort((a, b) => b.games - a.games || b.winRate - a.winRate);
  const weaponRateMap = Object.fromEntries(weaponRows.map(r => [r.key, r.winRate]));
  const synergyRows = toRows(pairStats).map(r => {
    const [team, pair] = r.key.split(':');
    const [a, b] = pair.split('+');
    const expected = ((weaponRateMap[`${team}:${a}`] || 0) + (weaponRateMap[`${team}:${b}`] || 0)) / 2;
    return { ...r, synergyLift: round(r.winRate - expected, 4) };
  }).sort((a, b) => b.synergyLift - a.synergyLift || b.games - a.games);
  const activationRows = [...activations.values()].map(a => ({
    key: a.key,
    uses: a.uses,
    winRateAfterUse: round(a.wins / a.uses, 4),
    avgTurn: round(a.turnSum / a.uses, 2),
    avgRound: round(a.roundSum / a.uses, 2)
  })).sort((a, b) => b.uses - a.uses);

  return {
    overall: {
      games: results.length,
      draws: results.filter(r => r.winnerSide === 'draw').length,
      avgTurns: round(results.reduce((s, r) => s + r.turns, 0) / results.length, 2),
      avgRounds: round(results.reduce((s, r) => s + r.rounds, 0) / results.length, 2)
    },
    byTeam: teamRates,
    byTeamVs: toRows(byTeamVs),
    byTactic: toRows(byTactic),
    byFirst: toRows(byFirst),
    matchups: [...matchups.values()].map(r => ({
      ...r,
      blueWinRate: round((r.blueWins || 0) / r.games, 4),
      redWinRate: round((r.redWins || 0) / r.games, 4),
      drawRate: round((r.draws || 0) / r.games, 4)
    })).sort((a, b) => a.key.localeCompare(b.key)),
    winReasons: [...reasons.values()].map(r => ({ key: r.key, games: r.games, rate: round(r.games / results.length, 4) })),
    weaponStats: weaponRows,
    synergies: synergyRows,
    activationTiming: activationRows,
    bestLoadouts: toRows(loadouts).filter(r => r.games >= 2).sort((a, b) => b.winRate - a.winRate || b.games - a.games).slice(0, 80)
  };
}

function toRows(map) {
  return [...map.values()].map(r => ({
    ...r,
    winRate: round(r.games ? r.wins / r.games : 0, 4),
    drawRate: round(r.games ? r.draws / r.games : 0, 4)
  })).sort((a, b) => b.games - a.games || b.winRate - a.winRate || a.key.localeCompare(b.key));
}

function round(n, d = 4) {
  const m = 10 ** d;
  return Math.round(n * m) / m;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, rows) {
  if (!rows.length) {
    fs.writeFileSync(file, '', 'utf8');
    return;
  }
  const cols = Object.keys(rows[0]);
  const body = [cols.join(',')].concat(rows.map(r => cols.map(c => csvEscape(r[c])).join(','))).join('\n');
  fs.writeFileSync(file, `${body}\n`, 'utf8');
}

function main() {
  const opts = parseArgs(process.argv);
  fs.mkdirSync(opts.out, { recursive: true });
  const rand = mulberry32(opts.seed);
  const engine = loadEngine(rand);
  const schedule = matchupSchedule(opts.tactics);
  const results = [];
  const start = Date.now();
  for (let i = 0; i < opts.games; i++) {
    const config = schedule[i % schedule.length];
    results.push(playGame(engine, opts, config, i, rand));
    if (opts.progress && (i + 1) % opts.progress === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`simulated ${i + 1}/${opts.games} games in ${elapsed}s`);
    }
  }
  const summary = summarize(results);
  summary.meta = {
    generatedAt: new Date().toISOString(),
    seed: opts.seed,
    level: opts.level,
    tactics: opts.tactics,
    elapsedMs: Date.now() - start,
    source: 'index.html'
  };
  fs.writeFileSync(path.join(opts.out, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  writeCsv(path.join(opts.out, 'games.csv'), results.map(({ events, ...r }) => r));
  writeCsv(path.join(opts.out, 'matchups.csv'), summary.matchups);
  writeCsv(path.join(opts.out, 'weapon_stats.csv'), summary.weaponStats);
  writeCsv(path.join(opts.out, 'weapon_synergies.csv'), summary.synergies);
  writeCsv(path.join(opts.out, 'activation_timing.csv'), summary.activationTiming);
  writeCsv(path.join(opts.out, 'best_loadouts.csv'), summary.bestLoadouts);
  console.log(JSON.stringify({
    out: opts.out,
    games: opts.games,
    seed: opts.seed,
    level: opts.level,
    elapsedMs: summary.meta.elapsedMs,
    files: ['summary.json', 'games.csv', 'matchups.csv', 'weapon_stats.csv', 'weapon_synergies.csv', 'activation_timing.csv', 'best_loadouts.csv']
  }, null, 2));
}

main();
