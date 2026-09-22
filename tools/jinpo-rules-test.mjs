#!/usr/bin/env node
/* 陣vs歩 のルール検証。index.html からエンジン部分だけを取り出して実行する。
   使い方: node tools/jinpo-rules-test.mjs                                   */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = scripts.find(s => s.includes('const CELL = 40;') && s.includes('const RULES ='));
const core = main.slice(main.indexOf('const CELL = 40;'), main.indexOf('/* ===== ネットワーク層'));
const ctx = { console, Date, Math, window: null };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(core + '\nwindow.__C__ = { SQ, ADJ, TDEF, RULES, WEAPONS, WP, weaponsFor, freeRoster, fixedOf, ROSTER, effWp, corrIndex };', ctx);
const { SQ, ADJ, TDEF, RULES, WEAPONS, WP, weaponsFor, freeRoster, fixedOf, ROSTER, effWp, corrIndex } = ctx.__C__;

let pass = 0, fail = 0, group = '';
const g_ = t => { group = t; console.log('— ' + t + ' —'); };
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ❌ [' + group + '] ' + m); } };

/* ---- 補助 ---- */
function squad(L, team, wp = {}) {
    const cells = Object.values(SQ).filter(q => q.team === team && q.kind === 'corridor').map(q => q.id);
    const mega = fixedOf(L, 'mega'), flag = fixedOf(L, 'flag'), free = freeRoster(L).slice(0, 6);
    const list = [{ role: 'mega', pos: cells[0], name: mega.name, wp: wp[mega.name] || null },
                  { role: 'flag', pos: cells[1], name: flag.name, wp: wp[flag.name] || null }];
    free.forEach((m, i) => list.push({ role: 'soldier', pos: cells[2 + i], name: m.name, wp: wp[m.name] || null }));
    return list;
}
const mk = (wpA = {}, wpB = {}, first = 'blue') =>
    RULES.newGame(squad('A', 'blue', wpA), squad('B', 'red', wpB), first, { blue: 'A', red: 'B' });
const S_ = (g, n) => g.soldiers.find(x => x.name === n);
/* keep 以外を2階(C/D)へ退避して盤面を空ける */
function park(g, keep) {
    const sp = [];
    for (let i = 1; i <= 30; i++) sp.push('C' + i);
    for (let i = 1; i <= 30; i++) sp.push('D' + i);
    let k = 0;
    g.soldiers.forEach(o => { if (!keep.includes(o.name)) o.pos = sp[k++]; });
}
const refresh = g => g.soldiers.forEach(s => { if (s.alive && s.team === g.activeTeam) s.steps = RULES.stepsFor(g, s); });

/* ================= 盤面 ================= */
g_('盤面');
{
    const T = Object.values(SQ).filter(q => q.kind === 'T');
    ok(T.length === 15, '潜伏所は15か所');
    const doors = TDEF.map(t => t[1]).join(',');
    ok(doors === 'A4,A7,A18,A30,B3,B12,B25,C8,C18,C21,C28,D1,D6,D21,D28', '潜伏所の扉が指定どおり（' + doors + '）');
    ok(T.every(q => ADJ[q.id].length === 1 && ADJ[q.id][0] === q.door), '各潜伏所は扉マス1つとだけ繋がる');
    ok(T.filter(q => q.team === 'blue').length === 8 && T.filter(q => q.team === 'red').length === 7, '青8か所・赤7か所');
    ok(Object.values(SQ).filter(q => q.kind === 'room').length === 0, '大部屋X/Yは存在しない');
    ok(!Object.keys(SQ).some(id => /^[XY]\d+$/.test(id)), 'X・Yのマスが残っていない');
    ok(ADJ.P1.includes('A5') && ADJ.P1.includes('A6') && !ADJ.P1.includes('A3'), '青階段の入口はA5・A6');
    ok(ADJ.P10.includes('C5') && ADJ.P10.includes('C6') && !ADJ.P10.includes('C3'), '青階段の出口はC5・C6');
    ok(ADJ.Q1.includes('B27') && ADJ.Q1.includes('B28') && ADJ.Q10.includes('D27') && ADJ.Q10.includes('D28'), '赤階段は従来どおり');
    const pos = {};
    let dup = 0;
    Object.values(SQ).forEach(q => { const k = q.x + ',' + q.y; if (pos[k]) dup++; pos[k] = 1; });
    ok(dup === 0, 'マスが重なっていない');
    ok(Object.values(SQ).every(q => q.x >= 0 && q.x + q.w <= 816 && q.y >= 0 && q.y + q.h <= 1336), '全マスが盤面の内側');
}

/* ================= 装備データ ================= */
g_('装備データ');
{
    ok(WEAPONS.length === 21, '武器は21種');
    const n = r => WEAPONS.filter(w => w.rarity === r).length;
    ok(n('UR') === 1 && n('SSR') === 3 && n('SR') === 5 && n('R') === 12, '内訳 UR1/SSR3/SR5/R12');
    const ex = { '石井': 'funnel', '関原': 'zutai', '小野寺': 'hardgel' };
    ok(['A', 'B', 'C'].every(L => ROSTER[L].every(m => {
        const ids = weaponsFor(L, m).map(w => w.id);
        return Object.keys(ex).filter(x => x !== m.name).every(x => !ids.includes(ex[x]));
    })), '専用武器は本人以外に出ない');
    ok(weaponsFor('A', ROSTER.A.find(m => m.name === '石井')).some(w => w.id === 'funnel'), '石井はファンネル石井を装備できる');
    ok(/専用武器/.test(RULES.validatePlacement(squad('A', 'blue', { '内藤': 'hardgel' }), 'blue', 'A')), '小野寺以外はハードジェルを持てない');
    ok(RULES.validatePlacement(squad('A', 'blue', { '内藤': 'iincho' }), 'blue', 'A') === null, '専用でない武器は誰でも持てる');
    const c = RULES.weaponConflicts(squad('A', 'blue', { '内藤': 'iincho' }), squad('B', 'red', { '武': 'iincho' }));
    ok(c.length === 1 && c[0] === 'iincho', '両軍の重複を検出する');
    ok(RULES.weaponConflicts(squad('A', 'blue', { '内藤': 'iincho' }), squad('B', 'red', { '武': 'charisma' })).length === 0, '重複がなければ空');
}

/* ================= 常時効果 ================= */
g_('常時効果（行動マス）');
{
    let g = mk(); ok(S_(g, '石井').steps === 6 && S_(g, '内藤').steps === 4, '基本 メガホン6 / 兵4');
    g = mk({ '内藤': 'moonwalk' }); ok(S_(g, '内藤').steps === 5, 'ムーンウォーク +1');
    g = mk({ '内藤': 'zutai' }); ok(S_(g, '内藤').steps === 6 && S_(g, '純平').steps === 4, '図体のでかい関原 本人+2');
    S_(g, '内藤').alive = false; g.zutaiDown.blue = 1; refresh(g); ok(S_(g, '純平').steps === 3, '装備者が倒れると味方-1');
    g = mk({ '内藤': 'charisma' }); ok(S_(g, '純平').steps === 5 && S_(g, '石井').steps === 7, 'カリスマ 味方全員+1');
    g = mk({ '内藤': 'onnabancho' }, {}, 'red'); ok(S_(g, '宮永').steps === 3 && S_(g, '武').steps === 4, '女番長 相手の女-1');
    g = mk({ '内藤': 'virgin' }, {}, 'red'); park(g, ['内藤', '武', '宮永']);
    S_(g, '内藤').pos = 'A5'; S_(g, '武').pos = 'A15'; S_(g, '宮永').pos = 'A17'; refresh(g);
    ok(S_(g, '武').steps === 2 && S_(g, '宮永').steps === 4, 'ヴァージンロード 正面の男のみ-2');
}

/* ================= 移動・撃破 ================= */
g_('移動と撃破');
{
    const g = mk({}, { '武': 'iincho' }); park(g, ['武', '内藤', '石井']);
    S_(g, '武').pos = 'A15'; S_(g, '内藤').pos = 'A11'; S_(g, '石井').pos = 'A9'; refresh(g);
    ok(/委員長/.test(RULES.stepMove(g, S_(g, '内藤').sid, 'A13').err || ''), '委員長の威厳 周囲1マスに入れない');
    S_(g, '内藤').pos = 'C1';
    ok(RULES.stepMove(g, S_(g, '石井').sid, 'A11').ok && RULES.stepMove(g, S_(g, '石井').sid, 'A13').ok, 'メガホンは近づける');
}
{
    const g = mk({ '内藤': 'chinbo' }); park(g, ['内藤', '宮永', '武']);
    S_(g, '内藤').pos = 'A20'; S_(g, '宮永').pos = 'A21'; S_(g, '武').pos = 'A23'; refresh(g);
    RULES.stepMove(g, S_(g, '内藤').sid, 'A22');
    ok(!S_(g, '宮永').alive && S_(g, '武').alive, '珍棒 隣の女だけ撃破');
}
{
    const g = mk({}, { '武': 'ikkun' }); park(g, ['内藤', '武']);
    S_(g, '内藤').pos = 'A20'; S_(g, '武').pos = 'A22'; refresh(g);
    RULES.stepMove(g, S_(g, '内藤').sid, 'A22');
    ok(!S_(g, '武').alive && !S_(g, '内藤').alive, 'いっくん 取った相手も道連れ');
}
{
    const g = mk({ '内藤': 'moonwalk' }, { '武': 'aga' }); park(g, ['内藤', '武']);
    S_(g, '内藤').pos = 'A20'; S_(g, '武').pos = 'A22'; refresh(g);
    RULES.stepMove(g, S_(g, '内藤').sid, 'A22');
    ok(S_(g, '内藤').agaDud && effWp(S_(g, '内藤')) === null, 'AGA治療薬 殺した側の装備が無効になる');
}
{
    const g = mk({}, { '市毛': 'phoenix' }); park(g, ['内藤', '市毛']);
    S_(g, '内藤').pos = 'A20'; S_(g, '市毛').pos = 'A22'; refresh(g);
    RULES.stepMove(g, S_(g, '内藤').sid, 'A22');
    ok(S_(g, '市毛').alive && ['Q5', 'Q6'].includes(S_(g, '市毛').pos), 'フェニックス 本陣で復活');
}
{   /* 東横INN: T3 の扉は A18 */
    const g = mk({}, { '武': 'toyoko' }); park(g, ['内藤', '武', '純平']);
    S_(g, '武').pos = 'T3'; S_(g, '内藤').pos = 'A16'; refresh(g);
    RULES.stepMove(g, S_(g, '内藤').sid, 'A18');
    ok(!S_(g, '内藤').alive, '東横INN 扉マスに来た相手が死亡');
    S_(g, '純平').pos = 'A16'; refresh(g);
    RULES.stepMove(g, S_(g, '純平').sid, 'A18');
    ok(S_(g, '純平').alive, '2人目は連れ込まれない（1回限り）');
}

/* ================= 任意発動 ================= */
g_('任意発動の武器');
{
    let blanks = 0;
    for (let i = 0; i < 300; i++) {
        const g = mk({ '石井': 'funnel' });
        const before = RULES.aliveCount(g, 'red');
        RULES.useWeapon(g, S_(g, '石井').sid);
        if (S_(g, '石井').alive) { fail++; console.log('  ❌ ファンネルで自分が残った'); break; }
        if (RULES.aliveCount(g, 'red') === before) blanks++;
    }
    ok(blanks > 40 && blanks < 130, 'ファンネル ハズレ率がおよそ3/11（' + blanks + '/300）');
}
{
    const g = mk({ '小野寺': 'x' });   /* 小野寺はAにいないのでハードジェルは別途 */
    const g2 = RULES.newGame(squad('C', 'blue', { '小野寺': 'hardgel' }), squad('B', 'red'), 'blue', { blue: 'C', red: 'B' });
    park(g2, ['小野寺', '武']); S_(g2, '小野寺').pos = 'A20'; S_(g2, '武').pos = 'A22'; refresh(g2);
    ok(RULES.useWeapon(g2, S_(g2, '小野寺').sid, S_(g2, '武').sid).ok, 'ハードジェル 男にも効く');
    RULES.endTurn(g2);
    ok(S_(g2, '武').steps === 0 && !RULES.stepMove(g2, S_(g2, '武').sid, 'A20').ok, '固められた駒は動けない');
    RULES.endTurn(g2); RULES.endTurn(g2);
    ok(S_(g2, '武').steps > 0, '1ターンで解ける');
}
{
    const g = mk({ '内藤': 'daichari' }); park(g, ['内藤', '市毛']);
    S_(g, '内藤').pos = 'A15'; S_(g, '市毛').pos = 'A13'; refresh(g);
    RULES.useWeapon(g, S_(g, '内藤').sid, S_(g, '市毛').sid);
    ok(S_(g, '市毛').pos === 'A3', 'ダイチャリ 相手を前進方向へ5マス');
}
{
    const g = mk({ '内藤': 'iemuri' }); park(g, ['内藤', '武', '市毛']);
    S_(g, '内藤').pos = 'A1'; S_(g, '武').pos = 'T5'; S_(g, '市毛').pos = 'B20';
    RULES.useWeapon(g, S_(g, '内藤').sid);
    ok(!S_(g, '武').alive && S_(g, '市毛').alive, '家無理 潜伏中だけ死亡');
    const g2 = mk({ '内藤': 'iemuri' });
    ok(RULES.useWeapon(g2, S_(g2, '内藤').sid).ok && S_(g2, '内藤').uses.iemuri === 1, '空振りでも消費する');
}
{
    const g = mk({ '内藤': 'shuchi' }); park(g, ['内藤', '松本']);
    S_(g, '内藤').pos = 'A10'; S_(g, '松本').pos = 'C30'; refresh(g);
    const d = RULES.shuchiDests(g, S_(g, '内藤'));
    ok(d.includes('A12') && d.includes('A9'), 'ワープ先は縦横1マス隣');
    ok(RULES.useWeapon(g, S_(g, '内藤').sid, S_(g, '松本').sid, 'A12').ok && S_(g, '松本').pos === 'A12', '酒池クニ林 女子を隣へワープ');
}
{
    const g = mk({ '内藤': 'ogoru' });
    const b80 = g.soldiers.filter(s => s.team === 'blue' && s.year === 80).map(s => s.steps);
    RULES.useWeapon(g, S_(g, '内藤').sid);
    ok(g.soldiers.filter(s => s.team === 'blue' && s.year === 80).every((s, i) => s.steps === b80[i] + 1), '奢るわ 80期+1');
}
{
    const g = mk({ '内藤': 'shinasadame' }); park(g, ['内藤', '武']);
    S_(g, '武').pos = 'T8';
    const r = RULES.useWeapon(g, S_(g, '内藤').sid, 'T8');
    ok(r.ok && /武/.test(r.result), '品定め 潜伏所の中身が分かる');
    ok(!RULES.useWeapon(g, S_(g, '内藤').sid, 'X1').ok, '存在しない部屋は選べない');
}
{
    const g = mk({ '内藤': 'maeba' }); park(g, ['内藤', '市毛']);
    const s = S_(g, '内藤'); s.pos = 'A1'; S_(g, '市毛').pos = 'A9'; refresh(g);
    ok(!RULES.maebaMove(g, s.sid, 'A21').ok, '宣言なしでは突進できない');
    RULES.useWeapon(g, s.sid); RULES.endTurn(g); RULES.endTurn(g);
    ok(RULES.maebaTargets(g, s.sid).every(t => corrIndex(t).idx > 0), '行き先は相手陣地方向のみ');
    ok(RULES.useWeapon(g, s.sid, 'B29').ok && s.pos === 'B29' && !S_(g, '市毛').alive, '人造前歯 一気に進み敵を撃破');
    RULES.endTurn(g); RULES.endTurn(g);
    ok(RULES.useWeapon(g, s.sid).ok, '何度でも宣言できる');
}
{
    const g = mk({ '内藤': 'nonoka' }); park(g, ['内藤', '純平', '武', '市毛', '樋口']);
    S_(g, '内藤').pos = 'A10'; S_(g, '純平').pos = 'A2'; S_(g, '武').pos = 'B20'; S_(g, '市毛').pos = 'T5'; S_(g, '樋口').pos = 'C30'; refresh(g);
    RULES.useWeapon(g, S_(g, '内藤').sid);
    ok(!RULES.stepMove(g, S_(g, '内藤').sid, 'A12').ok, 'ノノカ 宣言後は行動できない');
    RULES.endTurn(g); ok(S_(g, '内藤').alive, '相手のターンではまだ起爆しない');
    RULES.endTurn(g);
    ok(!S_(g, '内藤').alive && !S_(g, '純平').alive && !S_(g, '武').alive, '同じ通りの敵味方を破壊');
    ok(S_(g, '市毛').alive && S_(g, '樋口').alive, '潜伏中と別の階は無事');
}

/* ================= 村上 ================= */
g_('パクリ大国代表村上');
{
    const g = mk({ '内藤': 'pakuri', '純平': 'charisma' }, { '武': 'iincho' });
    ok(g.pakuriPending.length === 1, '開始時にコピー宣言待ち');
    ok(/村上/.test(RULES.stepMove(g, S_(g, '陶山').sid, 'A10').err || ''), '宣言が済むまで誰も動けない');
    const ch = RULES.pakuriChoices(g);
    ok(ch.includes('iincho') && ch.includes('charisma') && !ch.includes('pakuri'), 'コピー候補は試合に出ている武器');
    ok(RULES.declarePakuri(g, S_(g, '内藤').sid, 'iincho').ok && effWp(S_(g, '内藤')) === 'iincho', '相手の武器をコピーできる');
    ok(RULES.stepMove(g, S_(g, '陶山').sid, 'A10').ok, '宣言後は動ける');
}

/* ================= 決着 ================= */
g_('決着判定');
{
    const g = mk({ '内藤': 'nonoka' }); park(g, ['内藤', '有働', '樋口']);
    S_(g, '内藤').pos = 'A10'; S_(g, '有働').pos = 'A2'; S_(g, '樋口').pos = 'B20'; refresh(g);
    RULES.useWeapon(g, S_(g, '内藤').sid); RULES.endTurn(g); RULES.endTurn(g);
    ok(g.phase === 'over' && g.winner === null, '両軍の旗持ちが同時に倒れたら引き分け');
}
{
    const g = mk({}, { '樋口': 'phoenix' }); park(g, ['内藤', '樋口']);
    S_(g, '内藤').pos = 'A20'; S_(g, '樋口').pos = 'A22'; refresh(g);
    RULES.stepMove(g, S_(g, '内藤').sid, 'A22');
    ok(g.phase === 'over' && g.winner === 'blue', '旗持ちはフェニックスでも復活できず決着');
}

console.log('\n通過 ' + pass + ' / 失敗 ' + fail);
process.exit(fail ? 1 : 0);
