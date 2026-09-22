'use strict';
const STORAGE_KEY = 'mindmap-app-v1';
const PALETTE = ['#7c3aed','#db2777','#2563eb','#e11d48','#0891b2','#c026d3','#16a34a','#ea580c'];
const NODE_H = 28, VGAP = 10, HGAP = 60;
const PLACEHOLDER = '入力してください';
const COLORS = ['#7c3aed','#a855f7','#ec4899','#f43f5e','#f97316','#eab308','#84cc16','#22c55e','#14b8a6','#06b6d4','#3b82f6','#6366f1','#0f172a','#6b7280','#92400e','#dc2626','#065f46','#1d4ed8'];
const SHAPES = { '': 'なし', pill: '丸枠', round: '角丸', rect: '四角' };
const LINES = { '': '実線', dashed: '破線', dotted: '点線' };
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = t => new Date(t).toLocaleDateString('ja-JP', {month:'numeric', day:'numeric'});
const measureCtx = document.createElement('canvas').getContext('2d');

// ---------- データ ----------
function node(text, children) { return { id: uid(), text, children: children || [] }; }
function sampleData() {
  const c1 = { id: uid(), name: '仕事', color: PALETTE[0] };
  const c2 = { id: uid(), name: 'プライベート', color: PALETTE[2] };
  return { version: 2, categories: [c1, c2], maps: [{
    id: uid(), categoryId: c1.id, title: 'サンプル: アプリ企画', updatedAt: Date.now(),
    root: node('マインドマップアプリ', [
      node('機能', [node('カテゴリ管理'), node('複数マップ'), node('JSON 保存/読込')]),
      node('操作', [node('Tab で子を追加'), node('Enter で兄弟を追加'), node('ダブルクリックで編集')]),
      node('今後', [node('ドラッグで並べ替え'), node('画像やリンクの添付'), node('クラウド同期')]),
    ])
  }]};
}
function load() {
  try { const d = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (d && d.categories && d.maps) return migrate(d); } catch (e) {}
  return sampleData();
}
function migrate(d) { // v1: dx は画面の左右 → v2: dx は親から外側への向き (左側の枝は符号を反転)
  if ((d.version || 1) < 2) {
    d.maps.forEach(m => m.root.children.forEach(c => { if (c.side === 'L') (function flip(n) { if (n.dx) n.dx = -n.dx; n.children.forEach(flip); })(c); }));
    d.version = 2;
  }
  return d;
}
let data = load();
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { console.warn('保存できません', e); } }, 200);
  if (window.cloud) window.cloud.observe(); // クラウド同期に変更を知らせる
}

const state = { categoryId: 'all', mapId: null, selectedId: null, selected: new Set(), tx: 0, ty: 0, scale: 1, history: [], future: [], editing: null, space: false };
const nodesById = new Map();
const PEN_COLORS = ['#1f2937', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
const PEN_WIDTHS = [1, 2, 4]; // 細 / 中 / 太
state.tool = 'select'; state.pen = { color: '#1f2937', width: 1 }; state.stroke = null; state.erase = null;
state.selStrokes = new Set(); // 選択中の手書き線
const strokeById = id => { const m = cur(); return m && (m.strokes || []).find(st => st.id === id); };
function segDist(w, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((w.x - a[0]) * dx + (w.y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(w.x - (a[0] + t * dx), w.y - (a[1] + t * dy));
}
function distToStroke(st, w) {
  const p = st.points; if (p.length === 1) return Math.hypot(p[0][0] - w.x, p[0][1] - w.y);
  let best = Infinity; for (let i = 0; i < p.length - 1; i++) best = Math.min(best, segDist(w, p[i], p[i + 1])); return best;
}
function strokeAt(w) { // カーソル位置の手書き線
  const m = cur(); if (!m || !m.strokes) return null;
  const tol = 6 / state.scale; let best = null, bd = Infinity;
  m.strokes.forEach(st => { const d = distToStroke(st, w); if (d < tol + st.width / 2 && d < bd) { bd = d; best = st; } });
  return best;
}
function strokesBBox(ids) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  ids.forEach(id => { const st = strokeById(id); if (!st) return; const h = st.width / 2; st.points.forEach(([x, y]) => { x0 = Math.min(x0, x - h); x1 = Math.max(x1, x + h); y0 = Math.min(y0, y - h); y1 = Math.max(y1, y + h); }); });
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
function setSelection(ids, primary) { state.selected = new Set(ids); state.selectedId = primary !== undefined ? primary : (ids[0] || null); }
function topLevelSelected() { // 選択中で、祖先が選択されていないノード
  const m = cur(); if (!m) return [];
  const out = [];
  (function walk(n) { if (state.selected.has(n.id)) { out.push(n.id); return; } n.children.forEach(walk); })(m.root);
  return out;
}
const pos = new Map(); // nodeId -> {x,y,w,h,sh,dir}
const cur = () => data.maps.find(m => m.id === state.mapId) || null;

function findNode(n, id, parent = null) {
  if (n.id === id) return { node: n, parent };
  for (const c of n.children) { const r = findNode(c, id, n); if (r) return r; }
  return null;
}
function countDesc(n) { return n.children.reduce((a, c) => a + 1 + countDesc(c), 0); }
function cloneTree(n) {
  const c = { id: uid(), text: n.text, collapsed: n.collapsed, children: n.children.map(cloneTree) };
  ['side', 'shape', 'color', 'bold', 'line'].forEach(k => { if (n[k]) c[k] = n[k]; });
  return c;
}
function isRoot(n) { const m = cur(); return m && m.root.id === n.id; }
function sideOf(n) { return n.side === 'L' ? 'L' : 'R'; }
function balancedSide(root) { const r = root.children.filter(c => sideOf(c) === 'R').length; return r <= root.children.length - r ? 'R' : 'L'; }
function inSubtree(n, id) { return n.id === id || n.children.some(c => inSubtree(c, id)); }

// ---------- 履歴 ----------
function snapshotState() { const m = cur(); return JSON.stringify({ root: m.root, strokes: m.strokes || [] }); }
function restoreState(str) { const m = cur(); const s = JSON.parse(str); m.root = s.root; m.strokes = s.strokes || []; }
function snapshot(str) { // 木と手書きをまとめて履歴に積む (str を渡すとその状態を積む)
  const m = cur(); if (!m) return;
  state.history.push(str || snapshotState());
  if (state.history.length > 100) state.history.shift();
  state.future = [];
}
function undo() {
  const m = cur(); if (!m || !state.history.length) return;
  finishStroke(false);
  state.future.push(snapshotState());
  restoreState(state.history.pop());
  ensureSelection(); touched();
}
function redo() {
  const m = cur(); if (!m || !state.future.length) return;
  state.history.push(snapshotState());
  restoreState(state.future.pop());
  ensureSelection(); touched();
}
function ensureSelection() {
  const m = cur(); if (!m) return;
  state.selStrokes = new Set([...state.selStrokes].filter(id => strokeById(id)));
  state.selected = new Set([...state.selected].filter(id => findNode(m.root, id)));
  if (!findNode(m.root, state.selectedId)) state.selectedId = [...state.selected][0] || m.root.id;
  state.selected.add(state.selectedId);
}
function touched() { const m = cur(); if (m) m.updatedAt = Date.now(); save(); renderAll(); }

// ---------- ノード操作 ----------
function addChild(id) {
  const m = cur(); const f = findNode(m.root, id); if (!f) return;
  snapshot();
  f.node.collapsed = false;
  const c = node('');
  if (!f.parent) c.side = balancedSide(f.node);
  f.node.children.push(c);
  setSelection([c.id]); touched(); startEdit(c.id, true);
}
function addSibling(id) {
  const m = cur(); const f = findNode(m.root, id); if (!f) return;
  if (!f.parent) return addChild(id);
  snapshot();
  const c = node('');
  if (isRoot(f.parent)) c.side = sideOf(f.node);
  f.parent.children.splice(f.parent.children.indexOf(f.node) + 1, 0, c);
  setSelection([c.id]); touched(); startEdit(c.id, true);
}
function deleteNode(id) { deleteNodes([id]); }
function deleteNodes(ids) { deleteSelection(ids, []); }
function deleteSelection(nodeIds, strokeIds) { // 省略時は選択中のノードと手書き線をまとめて削除
  const m = cur(); if (!m) return;
  if (nodeIds === undefined) nodeIds = topLevelSelected();
  if (strokeIds === undefined) strokeIds = [...state.selStrokes];
  const targets = nodeIds.map(id => findNode(m.root, id)).filter(f => f && f.parent);
  const sset = new Set(strokeIds.filter(id => strokeById(id)));
  if (!targets.length && !sset.size) return;
  snapshot();
  targets.forEach(f => { const i = f.parent.children.indexOf(f.node); if (i >= 0) f.parent.children.splice(i, 1); });
  if (sset.size) m.strokes = m.strokes.filter(st => !sset.has(st.id));
  state.selStrokes = new Set([...state.selStrokes].filter(id => !sset.has(id)));
  if (targets.length) { let sel = targets[0].parent.id; if (!findNode(m.root, sel)) sel = m.root.id; setSelection([sel]); }
  touched();
}
function applyStrokeStyle(fn) { // 選択中の手書き線にスタイルを適用
  const m = cur(); if (!m || !state.selStrokes.size) return;
  snapshot(); m.strokes.forEach(st => { if (state.selStrokes.has(st.id)) fn(st); }); touched();
}
function freeMove(ids, dx, dy, strokeIds) { // 自動配置からのずれを保存 (手書き線も一緒に動かす)
  const m = cur(); if (!m) return;
  snapshot();
  (strokeIds || []).forEach(id => { const st = strokeById(id); if (st) st.points = st.points.map(([x, y]) => [+(x + dx).toFixed(1), +(y + dy).toFixed(1)]); });
  ids.forEach(id => { const n = nodesById.get(id), p = pos.get(id); if (!n) return; n.dx = Math.round((n.dx || 0) + dx * ((p && p.pdir) || 1)); n.dy = Math.round((n.dy || 0) + dy); });
  layout(m.root);
  // ルート直下のトピックが反対側に移ったら側を切り替え、落とした位置はそのまま保つ
  const want = {}, rootE = pos.get(m.root.id);
  ids.forEach(id => {
    const n = nodesById.get(id); if (!n || !m.root.children.includes(n)) return;
    const p = pos.get(id), side = p.x < rootE.x ? 'L' : 'R';
    if (side !== sideOf(n)) { want[id] = { x: p.x, y: p.y }; n.side = side; delete n.dx; delete n.dy; }
  });
  if (Object.keys(want).length) {
    layout(m.root);
    Object.entries(want).forEach(([id, t]) => { const n = nodesById.get(id), p = pos.get(id); n.dx = Math.round((t.x - p.x) * (p.pdir || 1)); n.dy = Math.round(t.y - p.y); });
  }
  ids.forEach(id => { const n = nodesById.get(id); if (!n) return; if (!n.dx) delete n.dx; if (!n.dy) delete n.dy; });
  touched();
}
function applyStyle(fn) { // 選択中のノード全部にスタイルを適用
  const m = cur(); if (!m || !state.selected.size) return;
  snapshot();
  state.selected.forEach(id => { const n = nodesById.get(id); if (n) fn(n); });
  touched();
}
function setProp(key, value) { applyStyle(n => { if (value) n[key] = value; else delete n[key]; }); }
function toggleBold() { const pn = nodesById.get(state.selectedId); const on = !(pn && pn.bold); applyStyle(n => { if (on) n.bold = true; else delete n.bold; }); }
function duplicateNodes() {
  const m = cur(); if (!m) return;
  const ids = topLevelSelected().filter(id => id !== m.root.id); if (!ids.length) return;
  snapshot();
  const created = [];
  ids.forEach(id => {
    const f = findNode(m.root, id); if (!f || !f.parent) return;
    const c = cloneTree(f.node); delete c.dx; delete c.dy;
    f.parent.children.splice(f.parent.children.indexOf(f.node) + 1, 0, c); created.push(c.id);
  });
  setSelection(created); touched();
}
function resetLayout() {
  const m = cur(); if (!m) return;
  snapshot();
  (function walk(n) { delete n.dx; delete n.dy; n.children.forEach(walk); })(m.root);
  touched(); fitView();
}
function toggleCollapse(id) {
  const m = cur(); const f = findNode(m.root, id); if (!f || !f.node.children.length) return;
  snapshot(); f.node.collapsed = !f.node.collapsed; touched();
}
function moveNode(id, delta) { // 兄弟内で順序入れ替え
  const m = cur(); const f = findNode(m.root, id); if (!f || !f.parent) return;
  const arr = f.parent.children, i = arr.indexOf(f.node), j = i + delta;
  if (j < 0 || j >= arr.length) return;
  snapshot(); arr.splice(i, 1); arr.splice(j, 0, f.node); touched();
}

function relocate(id, target, mode, wx, wy) { snapshot(); if (relocateCore(id, target, mode, wx, wy)) touched(); else { state.history.pop(); renderMap(); } }
function relocateMany(ids, target, mode, wx, wy) { // 複数ノードをまとめて移動
  snapshot(); let moved = 0, last = null;
  ids.forEach(id => {
    const ok = last ? relocateCore(id, last, 'after') : relocateCore(id, target, mode, wx, wy);
    if (ok) { moved++; last = id; }
  });
  if (moved) touched(); else { state.history.pop(); renderMap(); }
}
function relocateCore(id, target, mode, wx, wy) { // ドラッグ&ドロップでの移動 (履歴なし)
  const m = cur(); const f = findNode(m.root, id); if (!f || !f.parent) return false;
  const t = findNode(m.root, target); if (!t || inSubtree(f.node, target)) return false;
  f.parent.children.splice(f.parent.children.indexOf(f.node), 1);
  delete f.node.side; delete f.node.dx; delete f.node.dy;
  if (mode === 'child') {
    t.node.collapsed = false;
    if (!t.parent) f.node.side = wx >= 0 ? 'R' : 'L';
    const kids = t.node.children.filter(c => !t.parent ? sideOf(c) === sideOf(f.node) : true);
    let before = wy === undefined ? null : kids.find(c => pos.get(c.id) && pos.get(c.id).y > wy);
    const idx = before ? t.node.children.indexOf(before) : t.node.children.length;
    t.node.children.splice(idx, 0, f.node);
  } else {
    if (isRoot(t.parent)) f.node.side = sideOf(t.node);
    const arr = t.parent.children, i = arr.indexOf(t.node);
    arr.splice(mode === 'before' ? i : i + 1, 0, f.node);
  }
  return true;
}

// ---------- レイアウト ----------
function measure(text, font) {
  measureCtx.font = font || '14px system-ui';
  return Math.max(60, Math.ceil(measureCtx.measureText(text).width) + 28);
}
function layout(root) {
  pos.clear(); nodesById.clear();
  function sh(n) {
    nodesById.set(n.id, n);
    const e = { w: measure(n.text || PLACEHOLDER, (n.bold ? '700 ' : '') + '14px system-ui') + (n.shape ? 12 : 0), h: n.shape ? 32 : NODE_H, sh: 0 }; e.sh = e.h; pos.set(n.id, e);
    if (!n.collapsed && n.children.length) {
      let s = 0; n.children.forEach(c => s += sh(c)); s += VGAP * (n.children.length - 1);
      e.sh = Math.max(e.h, s);
    }
    return e.sh;
  }
  function placeGroup(kids, pe, dir) { // pe: 親の確定位置
    const total = kids.reduce((a, c) => a + pos.get(c.id).sh, 0) + VGAP * (kids.length - 1);
    let cy = pe.y - total / 2;
    kids.forEach(c => { const ce = pos.get(c.id); place(c, pe.x + dir * (pe.w / 2 + HGAP + ce.w / 2), cy + ce.sh / 2, dir, pe); cy += ce.sh + VGAP; });
  }
  function place(n, x, y, dir, pe) {
    const e = pos.get(n.id);
    e.pdir = dir;                                        // この子を置いたときの向き (dx の基準)
    e.x = x + (n.dx || 0) * dir; e.y = y + (n.dy || 0);  // 手動移動のずれ。dx は「親から外側へ」なので側が変わると鏡写しになる
    e.dir = e.x < pe.x ? -1 : 1;                 // 実際に親より左にあれば左向きの枝にする
    if (n.collapsed || !n.children.length) return;
    placeGroup(n.children, e, e.dir);
  }
  sh(root);
  const e = pos.get(root.id); e.w = measure(root.text || PLACEHOLDER, (root.bold ? '700 ' : '500 ') + '16px system-ui') + 24; e.h = 52; e.x = root.dx || 0; e.y = root.dy || 0; e.dir = 1;
  if (root.collapsed) return;
  if (!root.children.some(c => c.side)) { // 旧データ: 前半を右、後半を左に
    const half = Math.ceil(root.children.length / 2);
    root.children.forEach((c, i) => c.side = i < half ? 'R' : 'L');
  }
  placeGroup(root.children.filter(c => sideOf(c) === 'R'), e, 1);
  placeGroup(root.children.filter(c => sideOf(c) === 'L'), e, -1);
}
function curve(x1, y1, x2, y2, dir) { // 親の付け根 → 子の付け根。横の距離が短くても潰れないように制御点を外側に取る
  const k = Math.max(Math.abs(x2 - x1) * 0.5, Math.min(40, Math.abs(y2 - y1) * 0.5 + 12));
  return `M${x1} ${y1} C${x1 + dir * k} ${y1} ${x2 - dir * k} ${y2} ${x2} ${y2}`;
}
function lineY(id, depth) { const p = pos.get(id), n = nodesById.get(id); return (depth === 0 || (n && n.shape)) ? p.y : p.y + p.h / 2 - 6; }
const DASH = { dashed: '8 6', dotted: '2 5' };

// ---------- 描画 ----------
function renderMap() {
  const m = cur(); const svg = $('#svg'); const wrap = $('#canvasWrap');
  wrap.classList.toggle('empty', !m);
  $('#title').disabled = $('#catSelect').disabled = !m;
  ['#btnFit','#btnAlign','#btnDup','#btnOutline','#btnDelMap'].forEach(s => $(s).disabled = !m);
  $('#btnUndo').disabled = !m || !state.history.length;
  $('#btnRedo').disabled = !m || !state.future.length;
  if (!m) { svg.innerHTML = ''; $('#title').value = ''; return; }
  $('#title').value = m.title;
  const sel = $('#catSelect');
  sel.innerHTML = '<option value="">未分類</option>' + data.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = m.categoryId || '';
  layout(m.root);
  let edges = '', nodes = '';
  const branchColor = new Map();
  const dragging = !!(state.drag && state.drag.active);
  function draw(n, parent, inherited, dashIn, depth) {
    const p = pos.get(n.id);
    const color = n.color || inherited, dash = n.line || dashIn;
    p.color = color;
    const boxed = depth === 0 || !!n.shape;
    const dashAttr = DASH[dash] ? ` stroke-dasharray="${DASH[dash]}"` : '';
    if (parent) {
      const pp = pos.get(parent.id);
      const x1 = pp.x + p.dir * pp.w / 2, y1 = lineY(parent.id, depth - 1);
      const x2 = p.x - p.dir * p.w / 2, y2 = lineY(n.id, depth);
      edges += `<path class="edge" stroke="${color}"${dashAttr} d="${curve(x1, y1, x2, y2, p.dir)}"/>`;
      if (!boxed) edges += `<line class="edge" stroke="${color}"${dashAttr} x1="${x2}" y1="${y2}" x2="${p.x + p.dir * p.w / 2}" y2="${y2}"/>`;
    }
    const selected = state.selected.has(n.id);
    const cls = 'node' + (selected ? ' selected' : '') + (depth === 0 ? ' root' : '');
    const cy = boxed ? p.h / 2 : p.h - 6; // 枝の付け根の高さ
    const outer = p.dir >= 0; // 右向きか
    nodes += `<g class="${cls}" data-id="${n.id}" transform="translate(${p.x - p.w / 2} ${p.y - p.h / 2})">`;
    // ホバー用の当たり判定 (外側の + まで含める)
    nodes += `<rect class="zone" x="${outer ? 0 : -60}" y="-4" width="${p.w + 60}" height="${p.h + 8}"/>`;
    if (boxed) {
      const shape = depth === 0 ? (n.shape || 'pill') : n.shape;
      const rx = shape === 'pill' ? p.h / 2 : shape === 'round' ? 8 : 2;
      nodes += `<rect class="shape" width="${p.w}" height="${p.h}" rx="${rx}" stroke="${color}"${dashAttr}/>`;
    }
    nodes += `<rect class="hit" width="${p.w}" height="${p.h}" rx="${boxed ? 6 : 4}"/>`;
    nodes += `<text class="${n.text ? '' : 'ph'}${n.bold ? ' b' : ''}"${state.editing === n.id ? ' opacity="0"' : ''} x="${p.w / 2}" y="${p.h / 2 - (boxed ? 0 : 4)}" text-anchor="middle">${esc(n.text || PLACEHOLDER)}</text>`;
    let bx = outer ? p.w + 16 : -16; // + ボタンの位置
    if (n.children.length && depth > 0) {
      const tx = outer ? p.w + 9 : -9;
      if (n.collapsed) nodes += `<g class="cbadge" data-tog="${n.id}"><title>展開</title><circle cx="${tx}" cy="${cy}" r="9" fill="${color}"/><text x="${tx}" y="${cy}" text-anchor="middle">${countDesc(n)}</text></g>`;
      else nodes += `<g class="tog" data-tog="${n.id}"><title>折りたたみ</title><circle cx="${tx}" cy="${cy}" r="6" stroke="${color}"/><path d="M${tx - 3} ${cy} h6" stroke="${color}"/></g>`;
      bx = outer ? p.w + 30 : -30;
    }
    if (!dragging && state.editing !== n.id) {
      nodes += `<g class="plus" data-plus="${n.id}"><title>子を追加</title><circle cx="${bx}" cy="${cy}" r="9"/><path d="M${bx - 4} ${cy} h8 M${bx} ${cy - 4} v8"/></g>`;
      if (depth > 0 && n.id === state.selectedId) { const mx = bx + (outer ? 22 : -22); nodes += `<g class="minus" data-minus="${n.id}"><title>削除</title><circle cx="${mx}" cy="${cy}" r="9"/><path d="M${mx - 4} ${cy} h8"/></g>`; }
    }
    nodes += '</g>';
    if (!n.collapsed) n.children.forEach(c => {
      let col = color;
      if (depth === 0) { if (!branchColor.has(c.id)) branchColor.set(c.id, PALETTE[branchColor.size % PALETTE.length]); col = branchColor.get(c.id); }
      draw(c, n, col, dash, depth + 1);
    });
  }
  draw(m.root, null, '#7c3aed', '', 0);
  svg.innerHTML = `<g id="view" transform="translate(${state.tx} ${state.ty}) scale(${state.scale})">${edges}${nodes}<g id="ink">${inkHtml(m)}</g><g id="overlay"></g></g>`;
  renderNodeBar(); renderStrokeBar();
}
function strokePath(pts) { // 中点を通る 2 次ベジェで滑らかに
  if (pts.length < 2) return `M${pts[0][0]} ${pts[0][1]} l0.01 0`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) d += ` Q${pts[i][0]} ${pts[i][1]} ${(pts[i][0] + pts[i + 1][0]) / 2} ${(pts[i][1] + pts[i + 1][1]) / 2}`;
  const l = pts[pts.length - 1]; d += ` L${l[0]} ${l[1]}`;
  return d;
}
function inkHtml(m) {
  let h = (m.strokes || []).map(st => { const d = strokePath(st.points), sel = state.selStrokes.has(st.id);
    return (sel ? `<path class="ink halo" stroke-width="${st.width + 6}" d="${d}"/>` : '') + `<path class="ink" data-stroke="${st.id}" stroke="${st.color}" stroke-width="${st.width}" d="${d}"/>`; }).join('');
  const bb = state.selStrokes.size ? strokesBBox([...state.selStrokes]) : null;
  if (bb) h += `<rect class="sbox" x="${bb.x0 - 4}" y="${bb.y0 - 4}" width="${bb.x1 - bb.x0 + 8}" height="${bb.y1 - bb.y0 + 8}"/>`;
  return h;
}
function renderStrokeBar() { // 手書き線だけを選んでいるときのツールバー
  const bar = $('#strokebar'); const m = cur();
  const bb = m && state.selStrokes.size && !state.selectedId ? strokesBBox([...state.selStrokes]) : null;
  if (!bb || (state.drag && state.drag.active) || marquee) { bar.classList.add('hidden'); return; }
  const st = strokeById([...state.selStrokes][0]);
  bar.innerHTML = PEN_COLORS.map(c => `<button class="pc${st && st.color === c ? ' on' : ''}" data-sc="${c}" style="background:${c}"></button>`).join('') +
    `<span class="sep"></span>` + PEN_WIDTHS.map(w => `<button class="pw${st && st.width === w ? ' on' : ''}" data-sw="${w}"><i style="height:${Math.max(1.5, w)}px"></i></button>`).join('') +
    `<span class="sep"></span><button class="nb" data-sdel title="削除 (Delete)">🗑</button>`;
  bar.classList.remove('hidden');
  const wr = wrap.getBoundingClientRect(), bw = bar.offsetWidth, bh = bar.offsetHeight;
  let left = state.tx + (bb.x0 + bb.x1) / 2 * state.scale - bw / 2; left = Math.max(8, Math.min(wr.width - bw - 8, left));
  let top = state.ty + bb.y0 * state.scale - bh - 14; if (top < 8) top = state.ty + bb.y1 * state.scale + 14;
  bar.style.left = left + 'px'; bar.style.top = top + 'px';
}
function renderInk() { const g = $('#ink'), m = cur(); if (g && m) g.innerHTML = inkHtml(m); }
function renderNodeBar() { // 選択ノードの上に出るツールバー (Miro 風)
  const bar = $('#nodebar'); const m = cur(); const p = m && pos.get(state.selectedId); const n = m && nodesById.get(state.selectedId);
  if (!m || !p || !n || p.x === undefined || (state.drag && state.drag.active) || marquee) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#nbShape').textContent = SHAPES[isRoot(n) ? (n.shape || 'pill') : (n.shape || '')];
  $('#nbSw').style.background = p.color || '#7c3aed';
  $('#nbBold').classList.toggle('on', !!n.bold);
  $('#nbDel').disabled = isRoot(n) && state.selected.size === 1;
  const wr = wrap.getBoundingClientRect(), bw = bar.offsetWidth, bh = bar.offsetHeight;
  let left = state.tx + p.x * state.scale - bw / 2;
  left = Math.max(8, Math.min(wr.width - bw - 8, left));
  let top = state.ty + (p.y - p.h / 2) * state.scale - bh - 14;
  if (top < 8) top = state.ty + (p.y + p.h / 2) * state.scale + 14;
  bar.style.left = left + 'px'; bar.style.top = top + 'px';
}
function applyView() {
  const g = $('#view'); if (g) g.setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.scale})`);
  $('#zoomReset').textContent = Math.round(state.scale * 100) + '%';
  if (state.editing) positionEditor();
  renderNodeBar(); renderStrokeBar();
}
function fitView() {
  const m = cur(); if (!m) return;
  layout(m.root);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pos.forEach(p => { if (p.x === undefined) return; x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); });
  (m.strokes || []).forEach(st => st.points.forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }));
  const r = $('#svg').getBoundingClientRect();
  if (!r.width || !r.height) { requestAnimationFrame(fitView); return; }
  const s = Math.min((r.width - 80) / (x1 - x0), (r.height - 80) / (y1 - y0), 1.5);
  state.scale = Math.max(0.2, s);
  state.tx = r.width / 2 - (x0 + x1) / 2 * state.scale;
  state.ty = r.height / 2 - (y0 + y1) / 2 * state.scale;
  applyView();
}

function renderSidebar() {
  const catList = $('#catList');
  const countOf = id => data.maps.filter(m => id === 'all' ? true : (id === '' ? !m.categoryId : m.categoryId === id)).length;
  const uncat = countOf('');
  let html = catItem('all', '全て', '#6b7280', data.maps.length, false);
  html += data.categories.map(c => catItem(c.id, c.name, c.color, countOf(c.id), true)).join('');
  if (uncat || state.categoryId === '') html += catItem('', '未分類', '#9ca3af', uncat, false);
  catList.innerHTML = html;

  const q = $('#search').value.trim().toLowerCase();
  const maps = data.maps
    .filter(m => state.categoryId === 'all' || (state.categoryId === '' ? !m.categoryId : m.categoryId === state.categoryId))
    .filter(m => !q || m.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  $('#mapList').innerHTML = maps.length ? maps.map(m => {
    const c = data.categories.find(c => c.id === m.categoryId);
    return `<div class="item${m.id === state.mapId ? ' active' : ''}" data-map="${m.id}"><span class="dot" style="background:${c ? c.color : '#9ca3af'}"></span><span class="name" title="${esc(m.title)}">${esc(m.title)}</span><span class="date">${fmtDate(m.updatedAt)}</span><button class="x" data-delmap="${m.id}" title="削除">×</button></div>`;
  }).join('') : '<div class="empty-msg">マップがありません</div>';
}
function catItem(id, name, color, count, editable) {
  return `<div class="item${state.categoryId === id ? ' active' : ''}" data-cat="${id}"><span class="dot" style="background:${color}"></span><span class="name">${esc(name)}</span><span class="count">${count}</span>${editable ? `<button class="x" data-delcat="${id}" title="削除">×</button>` : ''}</div>`;
}
function renderAll() { renderSidebar(); renderMap(); applyView(); }

// ---------- 編集 ----------
const editor = $('#editor');
function startEdit(id, selectAll, initial) {
  const m = cur(); const f = findNode(m.root, id); if (!f) return;
  if (state.editing && state.editing !== id) finishEdit(true);
  state.selectedId = id;
  state.editing = id; state.editOrig = f.node.text;
  editor.value = initial !== undefined ? initial : f.node.text;
  if (initial !== undefined) f.node.text = initial; // 文字キーで打ち始めたときはその文字から
  renderMap(); // 編集中はノード側の文字を隠し、入力欄が枝の上に重なる
  editor.style.display = 'block'; positionEditor(); editor.focus();
  if (selectAll && initial === undefined) editor.select();
}
function positionEditor() {
  const p = pos.get(state.editing), n = nodesById.get(state.editing); if (!p || !n) return;
  const s = state.scale, root = isRoot(n), boxed = root || !!n.shape;
  editor.style.left = (state.tx + (p.x - p.w / 2) * s) + 'px';
  editor.style.top = (state.ty + (p.y - p.h / 2) * s) + 'px';
  editor.style.width = (p.w * s) + 'px'; editor.style.height = (p.h * s) + 'px';
  editor.style.font = (n.bold ? '700 ' : root ? '500 ' : '') + ((root ? 16 : 14) * s) + 'px system-ui';
  editor.style.paddingBottom = (boxed ? 0 : 8 * s) + 'px'; // 枝の線の上に文字が乗るように
  editor.style.color = root ? '#1f2937' : '#374151';
  editor.style.borderRadius = (boxed ? (root ? p.h / 2 : 6) : 4) * s + 'px';
}
function liveEdit() { // 打つたびにノード幅と枝を更新
  const n = nodesById.get(state.editing); if (!n) return;
  n.text = editor.value; renderMap(); positionEditor();
}
function finishEdit(commit) {
  if (!state.editing) return;
  const id = state.editing; state.editing = null; editor.style.display = 'none'; editor.blur();
  const m = cur(); const f = m && findNode(m.root, id);
  if (f) {
    const orig = state.editOrig ?? f.node.text, t = editor.value.trim();
    f.node.text = orig;
    if (commit && t !== orig) { snapshot(); f.node.text = t; touched(); return; }
  }
  renderMap();
}
editor.placeholder = PLACEHOLDER;
editor.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); finishEdit(true); }
  else if (e.key === 'Escape') finishEdit(false);
  else if (e.key === 'Tab') { e.preventDefault(); const id = state.editing; finishEdit(true); addChild(id); }
});
editor.addEventListener('input', liveEdit);
editor.addEventListener('blur', () => finishEdit(true));

// ---------- マップ・カテゴリ操作 ----------
function openMap(id) {
  finishEdit(true);
  state.mapId = id; state.history = []; state.future = [];
  const m = cur(); setSelection(m ? [m.root.id] : []); state.selStrokes = new Set();
  renderAll(); fitView();
}
function newMap() {
  const catId = data.categories.some(c => c.id === state.categoryId) ? state.categoryId : (state.categoryId === '' ? null : (data.categories[0] ? data.categories[0].id : null));
  const m = { id: uid(), categoryId: catId, title: '無題のマップ', updatedAt: Date.now(), root: node('中心テーマ') };
  data.maps.push(m); save(); openMap(m.id);
  $('#title').focus(); $('#title').select();
}
function deleteMap(id) {
  const m = data.maps.find(m => m.id === id); if (!m) return;
  if (!confirm(`「${m.title}」を削除しますか？`)) return;
  data.maps = data.maps.filter(x => x.id !== id);
  if (state.mapId === id) { state.mapId = null; setSelection([]); }
  save(); renderAll();
}
function duplicateMap() {
  const m = cur(); if (!m) return;
  const c = { id: uid(), categoryId: m.categoryId, title: m.title + ' のコピー', updatedAt: Date.now(), root: cloneTree(m.root) };
  data.maps.push(c); save(); openMap(c.id);
}
function newCategory() {
  const name = prompt('カテゴリ名'); if (!name || !name.trim()) return;
  const c = { id: uid(), name: name.trim(), color: PALETTE[data.categories.length % PALETTE.length] };
  data.categories.push(c); state.categoryId = c.id; save(); renderAll();
}
function renameCategory(id) {
  const c = data.categories.find(c => c.id === id); if (!c) return;
  const name = prompt('カテゴリ名', c.name); if (!name || !name.trim()) return;
  c.name = name.trim(); save(); renderAll();
}
function deleteCategory(id) {
  const c = data.categories.find(c => c.id === id); if (!c) return;
  const n = data.maps.filter(m => m.categoryId === id).length;
  if (!confirm(`カテゴリ「${c.name}」を削除しますか？${n ? `\n中の ${n} 件のマップは「未分類」に移動します。` : ''}`)) return;
  data.maps.forEach(m => { if (m.categoryId === id) { m.categoryId = null; m.updatedAt = Date.now(); } });
  data.categories = data.categories.filter(x => x.id !== id);
  if (state.categoryId === id) state.categoryId = 'all';
  save(); renderAll();
}

// ---------- 入出力 ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportJson() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  download(`mindmaps-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`, JSON.stringify(data, null, 2), 'application/json');
}
function importJson(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.categories) || !Array.isArray(d.maps)) throw new Error('形式が違います');
      const replace = confirm('現在のデータを置き換えますか？\n[OK] 置き換える　[キャンセル] 既存に追加する');
      if (replace) { data = d; state.mapId = null; state.categoryId = 'all'; }
      else {
        d.categories.forEach(c => { if (!data.categories.some(x => x.id === c.id)) data.categories.push(c); });
        d.maps.forEach(m => { if (!data.maps.some(x => x.id === m.id)) data.maps.push(m); });
      }
      save(); renderAll();
    } catch (e) { alert('読み込みに失敗しました: ' + e.message); }
  };
  r.readAsText(file);
}
function exportOutline() {
  const m = cur(); if (!m) return;
  const lines = [`# ${m.title}`, ''];
  (function walk(n, depth) { lines.push('  '.repeat(depth) + '- ' + (n.text || '(空)')); n.children.forEach(c => walk(c, depth + 1)); })(m.root, 0);
  download(m.title.replace(/[\\/:*?"<>|]/g, '_') + '.md', lines.join('\n'), 'text/markdown');
}

// ---------- イベント: サイドバー・ツールバー ----------
$('#catList').addEventListener('click', e => {
  const del = e.target.closest('[data-delcat]'); if (del) { deleteCategory(del.dataset.delcat); return; }
  const it = e.target.closest('[data-cat]'); if (it) { state.categoryId = it.dataset.cat; renderSidebar(); }
});
$('#catList').addEventListener('dblclick', e => { const it = e.target.closest('[data-cat]'); if (it && it.dataset.cat && it.dataset.cat !== 'all') renameCategory(it.dataset.cat); });
$('#mapList').addEventListener('click', e => {
  const del = e.target.closest('[data-delmap]'); if (del) { deleteMap(del.dataset.delmap); return; }
  const it = e.target.closest('[data-map]'); if (it && it.dataset.map !== state.mapId) openMap(it.dataset.map);
});
$('#search').addEventListener('input', renderSidebar);
$('#btnAddCat').onclick = newCategory;
$('#btnAddMap').onclick = newMap;
$('#btnExport').onclick = exportJson;
$('#btnImport').onclick = () => $('#fileInput').click();
$('#fileInput').addEventListener('change', e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
$('#title').addEventListener('change', e => { const m = cur(); if (!m) return; m.title = e.target.value.trim() || '無題のマップ'; touched(); });
$('#title').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#catSelect').addEventListener('change', e => { const m = cur(); if (!m) return; m.categoryId = e.target.value || null; touched(); });
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnFit').onclick = fitView;
$('#btnAlign').onclick = resetLayout;
$('#btnDup').onclick = duplicateMap;
$('#btnOutline').onclick = exportOutline;
$('#btnDelMap').onclick = () => state.mapId && deleteMap(state.mapId);
$('#btnFitIcon').onclick = fitView;
$('#btnHelp').onclick = () => { const h = $('#help'); h.classList.toggle('open'); try { localStorage.setItem('mindmap-help', h.classList.contains('open') ? '1' : '0'); } catch (e) {} };
$('#zoomIn').onclick = () => zoomAt(1.2);
$('#zoomOut').onclick = () => zoomAt(1 / 1.2);
$('#zoomReset').onclick = () => { state.scale = 1; fitCenterOnly(); };
function zoomAt(f, mx, my) {
  const r = $('#svg').getBoundingClientRect();
  if (mx === undefined) { mx = r.width / 2; my = r.height / 2; }
  const ns = Math.min(3, Math.max(0.2, state.scale * f));
  state.tx = mx - (mx - state.tx) * (ns / state.scale);
  state.ty = my - (my - state.ty) * (ns / state.scale);
  state.scale = ns; applyView();
}
function fitCenterOnly() { const r = $('#svg').getBoundingClientRect(); state.tx = r.width / 2; state.ty = r.height / 2; applyView(); }

// ---------- イベント: キャンバス ----------
const svg = $('#svg'), wrap = $('#canvasWrap'), ctx = $('#ctx');
// ---------- ツール (選択 / ペン / 消しゴム) ----------
function setTool(t) {
  finishStroke(true); state.erase = null;
  state.tool = t; svg.classList.remove('overstroke');
  if (t !== 'select' && state.selStrokes.size) { state.selStrokes.clear(); renderMap(); }
  document.querySelectorAll('#palette [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  svg.classList.toggle('pen', t === 'pen'); svg.classList.toggle('eraser', t === 'eraser');
  $('#penbar').classList.toggle('hidden', t !== 'pen');
  if (t !== 'select') { finishEdit(true); hideCtx(); hidePop(); }
  renderPenBar();
}
function renderPenBar() {
  $('#penbar').innerHTML = `<span class="lbl">色</span>` + PEN_COLORS.map(c => `<button class="pc${c === state.pen.color ? ' on' : ''}" data-pc="${c}" style="background:${c}" title="${c}"></button>`).join('') +
    `<span class="lbl" style="margin-left:6px">太さ</span>` + PEN_WIDTHS.map(w => `<button class="pw${w === state.pen.width ? ' on' : ''}" data-pw="${w}" title="${w}px"><i style="height:${Math.max(1.5, w)}px"></i></button>`).join('');
}
$('#palette').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
$('#penbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.pc) state.pen.color = b.dataset.pc;
  if (b.dataset.pw) state.pen.width = +b.dataset.pw;
  renderPenBar();
});
['#palette', '#penbar', '#strokebar'].forEach(sel => $(sel).addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); }));
$('#strokebar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.sc) applyStrokeStyle(st => st.color = b.dataset.sc);
  else if (b.dataset.sw) applyStrokeStyle(st => st.width = +b.dataset.sw);
  else if (b.hasAttribute('data-sdel')) deleteSelection();
});
function beginStroke(w) {
  state.stroke = { id: uid(), color: state.pen.color, width: state.pen.width, points: [[+w.x.toFixed(1), +w.y.toFixed(1)]] };
  $('#overlay').innerHTML = `<path class="ink" id="liveInk" stroke="${state.stroke.color}" stroke-width="${state.stroke.width}" d=""/>`;
}
function extendStroke(w) {
  const st = state.stroke; if (!st) return;
  const l = st.points[st.points.length - 1];
  if (Math.hypot(w.x - l[0], w.y - l[1]) < 1.5 / state.scale) return;
  st.points.push([+w.x.toFixed(1), +w.y.toFixed(1)]);
  const el = $('#liveInk'); if (el) el.setAttribute('d', strokePath(st.points));
}
function finishStroke(commit) {
  const st = state.stroke; if (!st) return;
  state.stroke = null; const ov = $('#overlay'); if (ov) ov.innerHTML = '';
  const m = cur(); if (!m || !commit) return;
  snapshot(); (m.strokes = m.strokes || []).push(st); touched();
}
function eraseAt(w) {
  const m = cur(); if (!m || !m.strokes || !m.strokes.length) return;
  const r = 10 / state.scale;
  const hit = st => st.points.some(([x, y]) => Math.abs(x - w.x) < r + st.width && Math.abs(y - w.y) < r + st.width && Math.hypot(x - w.x, y - w.y) < r + st.width / 2);
  const before = m.strokes.length;
  m.strokes = m.strokes.filter(st => !hit(st));
  if (m.strokes.length !== before) { state.erase.removed = true; renderInk(); }
}
function finishErase() {
  const er = state.erase; if (!er) return;
  state.erase = null;
  if (er.removed) { snapshot(er.before); touched(); }
}
let pan = null, marquee = null;
const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: (cx - r.left - state.tx) / state.scale, y: (cy - r.top - state.ty) / state.scale }; };
// ---------- タッチ (iPad): 2 本指でピンチ拡大と画面移動、1 本指は背景で画面移動 ----------
const touches = new Map(); let pinch = null;
function cancelDrag() { // ピンチが始まったら進行中のドラッグをなかったことにする
  const d = state.drag; state.drag = null;
  if (d && d.active) { d.nodes.forEach(id => { const n = nodesById.get(id); if (!n) return; n.dx = d.orig[id].dx; n.dy = d.orig[id].dy; if (!n.dx) delete n.dx; if (!n.dy) delete n.dy; }); d.strokes.forEach(id => { const st = strokeById(id); if (st) st.points = d.sorig[id]; }); renderMap(); }
  if (marquee) { marquee = null; $('#marquee').style.display = 'none'; }
  if (pan) { pan = null; svg.classList.remove('panning'); }
}
function touchDown(e) {
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) {
    finishStroke(true); state.erase = null; cancelDrag();
    const [a, b] = [...touches.values()], r = svg.getBoundingClientRect();
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top, s0: state.scale, tx0: state.tx, ty0: state.ty };
    return true;
  }
  return false;
}
function touchMove(e) {
  if (!touches.has(e.pointerId)) return false;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || touches.size < 2) return false;
  const [a, b] = [...touches.values()], r = svg.getBoundingClientRect();
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
  const ns = Math.min(3, Math.max(0.2, pinch.s0 * d / pinch.d0));
  const wx = (pinch.cx - pinch.tx0) / pinch.s0, wy = (pinch.cy - pinch.ty0) / pinch.s0; // 最初に指の中心にあった点を追いかける
  state.scale = ns; state.tx = cx - wx * ns; state.ty = cy - wy * ns; applyView();
  return true;
}
function touchUp(e) {
  touches.delete(e.pointerId);
  if (pinch && touches.size < 2) { pinch = null; return true; }
  return false;
}
let penDown = false, penSeen = false; // Apple Pencil で描いている間は指 (手のひら) を無視する
// 診断: 最近のポインター入力を操作ヘルプに表示する (iPad での不具合調査用)
const diag = { log: [], cancels: 0 };
function diagNote(e) {
  if (e.pointerType === 'pen') penSeen = true;
  if (e.type === 'pointercancel') diag.cancels++;
  if (e.type !== 'pointermove') { diag.log.push(`${e.type} ${e.pointerType} primary=${e.isPrimary} buttons=${e.buttons} id=${e.pointerId}`); if (diag.log.length > 6) diag.log.shift(); }
  const el = $('#diag'); if (el) el.textContent = `cancel:${diag.cancels} tool:${state.tool} stroke:${state.stroke ? 'on' : 'off'} | ` + diag.log.join(' / ');
}
// Safari が独自のスクロール/ジェスチャーを始めて pointercancel を出すのを防ぐ
svg.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
svg.addEventListener('pointerdown', e => {
  hideCtx(); diagNote(e);
  if (e.pointerType === 'pen') penDown = true;
  if (e.pointerType === 'touch') {
    if (penDown || state.stroke || state.erase) return;           // パームリジェクション
    if (touchDown(e)) return;                                       // 2 本指: ピンチ
    // ペン/消しゴム中の指は画面移動 (ただしペン入力を一度も見ていない端末では指で描けるようにする)
    if (state.tool !== 'select' && penSeen) { pan = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty }; return; }
  }
  if (!e.isPrimary && e.pointerType !== 'pen') return;
  if (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32))) { // ペンの消しゴム側
    e.preventDefault(); capture(e); finishStroke(true);
    state.erase = { before: snapshotState(), removed: false }; eraseAt(toWorld(e.clientX, e.clientY)); return;
  }
  if (e.target.closest('.plus, .minus, .tog, .cbadge')) return;
  const g = e.target.closest('.node');
  if (e.button === 1 || (e.button === 0 && state.space)) {
    e.preventDefault(); state.spaceUsed = true; pan = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty }; svg.classList.add('panning'); return;
  }
  if (e.button !== 0) return;
  if (state.tool === 'pen') { e.preventDefault(); capture(e); finishEdit(true); beginStroke(toWorld(e.clientX, e.clientY)); state.stroke.pointerId = e.pointerId; return; }
  if (state.tool === 'eraser') { e.preventDefault(); capture(e); state.erase = { before: snapshotState(), removed: false }; eraseAt(toWorld(e.clientX, e.clientY)); return; }
  if (g) {
    const id = g.dataset.id;
    if (state.editing === id) return;
    if (state.editing) finishEdit(true);
    if (e.ctrlKey || e.metaKey || e.shiftKey) { // 追加選択 / 解除
      const sel = new Set(state.selected);
      if (sel.has(id)) { sel.delete(id); setSelection([...sel], sel.has(state.selectedId) ? state.selectedId : [...sel][0] || null); }
      else { sel.add(id); setSelection([...sel], id); }
      renderMap(); return;
    }
    if (!state.selected.has(id)) { setSelection([id]); state.selStrokes.clear(); } else state.selectedId = id;
    renderMap();
    state.drag = { id, sx: e.clientX, sy: e.clientY, active: false, target: null };
    return;
  }
  const st = strokeAt(toWorld(e.clientX, e.clientY));
  if (st) { // 手書き線をクリック
    if (e.ctrlKey || e.metaKey || e.shiftKey) { if (state.selStrokes.has(st.id)) state.selStrokes.delete(st.id); else state.selStrokes.add(st.id); renderMap(); return; }
    if (!state.selStrokes.has(st.id)) { state.selStrokes = new Set([st.id]); setSelection([]); }
    renderMap();
    state.drag = { id: null, sx: e.clientX, sy: e.clientY, active: false, target: null }; // id なし = 付け替えなしの移動だけ
    return;
  }
  if (e.pointerType === 'touch') { pan = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty }; return; }
  marquee = { sx: e.clientX, sy: e.clientY, add: e.ctrlKey || e.metaKey || e.shiftKey, moved: false };
});
function capture(e) { try { svg.setPointerCapture(e.pointerId); } catch (err) {} } // 描画中はペンが svg の外に出ても追いかける
window.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') { if (penDown || state.stroke || state.erase) return; if (touchMove(e)) return; }
  if (pinch) return;
  if (state.stroke && e.pointerId !== state.stroke.pointerId) return; // 描いている指/ペン以外は無視
  if (!e.isPrimary && e.pointerType !== 'pen' && !state.stroke) return;
  if (pan) {
    state.tx = pan.tx + e.clientX - pan.x; state.ty = pan.ty + e.clientY - pan.y;
    applyView(); return;
  }
  if (state.stroke) { let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []; if (!evs.length) evs = [e]; evs.forEach(ev => extendStroke(toWorld(ev.clientX, ev.clientY))); return; } // ペンの細かい座標も取り込む (無ければ本体の座標)
  if (state.erase) { eraseAt(toWorld(e.clientX, e.clientY)); return; }
  if (!state.drag && !marquee && state.tool === 'select' && e.target === svg) svg.classList.toggle('overstroke', !!strokeAt(toWorld(e.clientX, e.clientY)));
  if (marquee) {
    if (!marquee.moved && Math.abs(e.clientX - marquee.sx) + Math.abs(e.clientY - marquee.sy) < 4) return;
    marquee.moved = true; $('#nodebar').classList.add('hidden');
    const r = wrap.getBoundingClientRect(), el = $('#marquee');
    const x0 = Math.min(marquee.sx, e.clientX) - r.left, y0 = Math.min(marquee.sy, e.clientY) - r.top;
    el.style.display = 'block'; el.style.left = x0 + 'px'; el.style.top = y0 + 'px';
    el.style.width = Math.abs(e.clientX - marquee.sx) + 'px'; el.style.height = Math.abs(e.clientY - marquee.sy) + 'px';
    return;
  }
  const d = state.drag; if (!d) return;
  if (!d.active) {
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 6) return;
    d.active = true; finishEdit(true);
    d.nodes = topLevelSelected();
    d.orig = Object.fromEntries(d.nodes.map(id => { const n = nodesById.get(id), p = pos.get(id); return [id, { dx: n.dx || 0, dy: n.dy || 0, pdir: (p && p.pdir) || 1 }]; }));
    d.strokes = [...state.selStrokes];
    d.sorig = Object.fromEntries(d.strokes.map(id => [id, strokeById(id).points]));
  }
  updateDrag(e.clientX, e.clientY);
});
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);
function onPointerUp(e) {
  diagNote(e);
  if (e.pointerType === 'pen') penDown = false;
  if (e.pointerType === 'touch') { if (state.stroke || state.erase) { touches.delete(e.pointerId); if (e.pointerId !== (state.stroke && state.stroke.pointerId)) return; } else if (touchUp(e)) return; }
  if (state.stroke && e.pointerId !== state.stroke.pointerId) return;
  if (!e.isPrimary && e.pointerType !== 'pen' && !state.stroke) return;
  if (pan) { pan = null; svg.classList.remove('panning'); return; }
  if (state.stroke) { extendStroke(toWorld(e.clientX, e.clientY)); finishStroke(true); return; }
  if (state.erase) { finishErase(); return; }
  if (marquee) {
    const mq = marquee; marquee = null; $('#marquee').style.display = 'none';
    if (!mq.moved) { if (!mq.add) { setSelection([]); state.selStrokes.clear(); renderMap(); } return; }
    const a = toWorld(Math.min(mq.sx, e.clientX), Math.min(mq.sy, e.clientY)), b = toWorld(Math.max(mq.sx, e.clientX), Math.max(mq.sy, e.clientY));
    const hit = [];
    pos.forEach((p, id) => { if (p.x !== undefined && p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y) hit.push(id); });
    const ids = mq.add ? [...new Set([...state.selected, ...hit])] : hit;
    const shit = (cur().strokes || []).filter(st => { const bb = strokesBBox([st.id]); return bb && bb.x0 >= a.x && bb.x1 <= b.x && bb.y0 >= a.y && bb.y1 <= b.y; }).map(st => st.id);
    state.selStrokes = new Set(mq.add ? [...state.selStrokes, ...shit] : shit);
    setSelection(ids, hit[0] || ids[0] || null); renderMap();
    return;
  }
  const d = state.drag; if (!d) return;
  state.drag = null;
  if (!d.active) return;
  state.suppressClick = true;
  const restore = () => {
    d.nodes.forEach(id => { const n = nodesById.get(id); if (!n) return; n.dx = d.orig[id].dx; n.dy = d.orig[id].dy; if (!n.dx) delete n.dx; if (!n.dy) delete n.dy; });
    d.strokes.forEach(id => { const st = strokeById(id); if (st) st.points = d.sorig[id]; });
  };
  restore();
  if (d.target) { const w = toWorld(e.clientX, e.clientY); relocateMany(d.nodes, d.target, d.mode, w.x, w.y); }
  else { const dx = (e.clientX - d.sx) / state.scale, dy = (e.clientY - d.sy) / state.scale; freeMove(d.nodes, dx, dy, d.strokes); }
}
function updateDrag(cx, cy) {
  const d = state.drag; const m = cur(); const w = toWorld(cx, cy);
  const dx = (cx - d.sx) / state.scale, dy = (cy - d.sy) / state.scale;
  d.nodes.forEach(id => { const n = nodesById.get(id); if (n) { n.dx = d.orig[id].dx + dx * d.orig[id].pdir; n.dy = d.orig[id].dy + dy; } }); // dx は「外側向き」なので左側の枝は符号を反転
  d.strokes.forEach(id => { const st = strokeById(id); if (st) st.points = d.sorig[id].map(([x, y]) => [x + dx, y + dy]); });
  renderMap(); // ドラッグ中はその場で動かす
  if (!d.id) { d.target = null; return; } // 手書き線だけの移動: 付け替え判定なし
  const draggedSet = d.nodes.map(id => nodesById.get(id)).filter(Boolean);
  let hit = null;
  (function walk(n, parent, depth) {
    if (hit || draggedSet.some(s => inSubtree(s, n.id))) return;
    const p = pos.get(n.id); if (!p || p.x === undefined) return;
    const inY = Math.abs(w.y - p.y) <= p.h / 2 + 6;
    if (inY) {
      const inner = Math.abs(w.x - p.x) <= p.w / 2 + 8;
      const outerR = w.x > p.x + p.w / 2 + 8 && w.x < p.x + p.w / 2 + 56;
      const outerL = w.x < p.x - p.w / 2 - 8 && w.x > p.x - p.w / 2 - 56;
      if (!parent) { if (inner || outerR || outerL) hit = { n, parent, p, depth, mode: 'child', dir: w.x >= 0 ? 1 : -1 }; }
      else if (p.dir > 0 ? outerR : outerL) hit = { n, parent, p, depth, mode: 'child', dir: p.dir };
      else if (inner) hit = { n, parent, p, depth, mode: w.y < p.y ? 'before' : 'after', dir: p.dir };
    }
    if (!n.collapsed) n.children.forEach(c => walk(c, n, depth + 1));
  })(m.root, null, 0);
  const overlay = $('#overlay');
  if (hit) {
    const { n, parent, p, depth, mode, dir } = hit;
    d.target = n.id; d.mode = mode;
    const g = svg.querySelector(`.node[data-id="${n.id}"]`); if (g) g.classList.add('droptarget');
    let ax, ay;
    if (mode === 'child') { ax = p.x + dir * p.w / 2; ay = lineY(n.id, depth); }
    else { const pp = pos.get(parent.id); ax = pp.x + dir * pp.w / 2; ay = lineY(parent.id, depth - 1); }
    const pd = pos.get(d.id), ex = pd.x - dir * pd.w / 2, ey = lineY(d.id, 1);
    overlay.innerHTML = `<path class="preview" d="${curve(ax, ay, ex, ey, dir)}"/>`;
  } else { d.target = null; overlay.innerHTML = ''; }
}
svg.addEventListener('click', e => {
  if (state.suppressClick) { state.suppressClick = false; return; }
  if (state.tool !== 'select') return;
  const plus = e.target.closest('.plus');
  if (plus) { addChild(plus.dataset.plus); return; }
  const tog = e.target.closest('[data-tog]');
  if (tog) { toggleCollapse(tog.dataset.tog); return; }
  const minus = e.target.closest('.minus');
  if (minus) { deleteNodes(state.selected.has(minus.dataset.minus) ? topLevelSelected() : [minus.dataset.minus]); return; }
});
svg.addEventListener('dblclick', e => { if (state.tool !== 'select') return; const g = e.target.closest('.node'); if (g) startEdit(g.dataset.id, true); });
svg.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.shiftKey) { state.tx -= e.deltaY || e.deltaX; applyView(); return; } // Shift+ホイールで横移動
  if (e.deltaX && !e.deltaY) { state.tx -= e.deltaX; applyView(); return; }  // タッチパッドの横スクロール
  const r = svg.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
svg.addEventListener('contextmenu', e => {
  e.preventDefault();
  const g = e.target.closest('.node'); if (!g) { hideCtx(); return; }
  if (!state.selected.has(g.dataset.id)) setSelection([g.dataset.id]); else state.selectedId = g.dataset.id;
  renderMap();
  const r = wrap.getBoundingClientRect();
  showCtxAt(e.clientX - r.left, e.clientY - r.top);
});
function showCtxAt(x, y) {
  const m = cur(); const f = m && findNode(m.root, state.selectedId); if (!f) return;
  const root = !f.parent, multi = state.selected.size > 1, moved = !!(f.node.dx || f.node.dy);
  ctx.innerHTML = `<div data-act="child">子を追加 <small>Tab</small></div>${root ? '' : '<div data-act="sibling">兄弟を追加 <small>Enter</small></div>'}<div data-act="edit">名前を変更 <small>F2</small></div>${f.node.children.length ? `<div data-act="collapse">${f.node.collapsed ? '展開' : '折りたたみ'} <small>Space</small></div>` : ''}${root ? '' : '<div data-act="dup">複製 <small>Ctrl+D</small></div><hr><div data-act="up">上へ移動 <small>Alt+↑</small></div><div data-act="down">下へ移動 <small>Alt+↓</small></div>'}${moved ? '<div data-act="snap">自動配置に戻す</div>' : ''}${root ? '' : '<hr><div class="danger" data-act="delete">' + (multi ? `選択した ${state.selected.size} 件を削除` : '削除') + ' <small>Delete</small></div>'}`;
  ctx.style.left = x + 'px'; ctx.style.top = y + 'px'; ctx.style.display = 'block';
  const wr = wrap.getBoundingClientRect();
  if (x + ctx.offsetWidth > wr.width - 8) ctx.style.left = (wr.width - ctx.offsetWidth - 8) + 'px';
  if (y + ctx.offsetHeight > wr.height - 8) ctx.style.top = Math.max(8, y - ctx.offsetHeight) + 'px';
}
ctx.addEventListener('click', e => {
  const act = e.target.closest('[data-act]'); if (!act) return;
  const id = state.selectedId; hideCtx();
  ({ child: () => addChild(id), sibling: () => addSibling(id), edit: () => startEdit(id, true), collapse: () => toggleCollapse(id), up: () => moveNode(id, -1), down: () => moveNode(id, 1), dup: duplicateNodes, snap: () => applyStyle(n => { delete n.dx; delete n.dy; }), delete: () => deleteSelection() })[act.dataset.act]();
});
function hideCtx() { ctx.style.display = 'none'; }
document.addEventListener('mousedown', e => { if (!e.target.closest('#ctx')) hideCtx(); if (!e.target.closest('#nbpop') && !e.target.closest('#nodebar')) hidePop(); });
// ツールバーのボタンにフォーカスを残さない (残ると次の Enter / Space がボタンを押してしまう)
['#nodebar', '#nbpop', '.zoom', '#ctx', '#toolbar'].forEach(sel => $(sel).addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); }));

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const m = cur(); if (!m) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); fitView(); return; }
  if (e.key === ' ') { // 押しっぱなし + ドラッグで画面移動、単押しで折りたたみ
    e.preventDefault();
    if (!e.repeat) { state.space = true; state.spaceUsed = false; svg.classList.add('space'); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleBold(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateNodes(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection([...nodesById.keys()], state.selectedId || m.root.id); state.selStrokes = new Set((m.strokes || []).map(st => st.id)); renderMap(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !state.selectedId && state.selStrokes.size) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape') { hideCtx(); if (state.tool !== 'select') { setTool('select'); return; } if (state.selected.size > 1 || state.selStrokes.size) { setSelection(state.selectedId ? [state.selectedId] : []); state.selStrokes.clear(); renderMap(); } return; }
  const id = state.selectedId; if (!id) return;
  const f = findNode(m.root, id); if (!f) return;
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveNode(id, -1); return; }
  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveNode(id, 1); return; }
  switch (e.key) {
    case 'Tab': e.preventDefault(); addChild(id); return;
    case 'Enter': e.preventDefault(); addSibling(id); return;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); return;
    case 'F2': e.preventDefault(); startEdit(id, true); return;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': e.preventDefault(); navigate(f, e.key); return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); startEdit(id, false, e.key); }
});
function navigate(f, key) {
  const p = pos.get(f.node.id); let target = null;
  const firstChild = () => (!f.node.collapsed && f.node.children[0]) ? f.node.children[0] : null;
  if (!f.parent) { // ルート: 右キーで右側、左キーで左側の先頭
    if (key === 'ArrowRight') target = f.node.children.find(c => sideOf(c) === 'R');
    else if (key === 'ArrowLeft') target = f.node.children.find(c => sideOf(c) === 'L');
  } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const outward = (key === 'ArrowRight') === (p.dir > 0);
    target = outward ? firstChild() : f.parent;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (f.parent) {
      const arr = f.parent.children, i = arr.indexOf(f.node);
      target = arr[i + (key === 'ArrowUp' ? -1 : 1)] || null;
      if (!target) { // 兄弟がなければ同じ側で最も近いノード
        let best = null, bd = Infinity;
        const m = cur();
        (function walk(n, parent) {
          const q = pos.get(n.id);
          if (n !== f.node && parent && q.dir === p.dir && (key === 'ArrowUp' ? q.y < p.y : q.y > p.y)) {
            const d = Math.abs(q.y - p.y) + Math.abs(q.x - p.x) * 0.3; if (d < bd) { bd = d; best = n; }
          }
          if (!n.collapsed) n.children.forEach(c => walk(c, n));
        })(m.root, null);
        target = best;
      }
    }
  }
  if (target) { state.selectedId = target.id; renderMap(); }
}
document.addEventListener('keyup', e => {
  if (e.key !== ' ' || !state.space) return;
  state.space = false; svg.classList.remove('space');
  const tag = e.target.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!state.spaceUsed && !pan && state.selectedId) toggleCollapse(state.selectedId);
});
window.addEventListener('blur', () => { state.space = false; svg.classList.remove('space'); });
window.addEventListener('resize', applyView);
try { if (localStorage.getItem('mindmap-help') === '1') $('#help').classList.add('open'); } catch (e) {}

// ---------- ノードツールバー ----------
const nbpop = $('#nbpop');
function hidePop() { nbpop.style.display = 'none'; nbpop.innerHTML = ''; }
function showPop(btn, html) {
  if (nbpop.style.display === 'block' && nbpop.dataset.for === btn.id) { hidePop(); return; }
  hidePop(); hideCtx();
  nbpop.innerHTML = html; nbpop.dataset.for = btn.id; nbpop.style.display = 'block';
  const wr = wrap.getBoundingClientRect(), br = btn.getBoundingClientRect();
  let left = br.left - wr.left, top = br.bottom - wr.top + 6;
  left = Math.max(8, Math.min(wr.width - nbpop.offsetWidth - 8, left));
  if (top + nbpop.offsetHeight > wr.height - 8) top = br.top - wr.top - nbpop.offsetHeight - 6;
  nbpop.style.left = left + 'px'; nbpop.style.top = top + 'px';
}
$('#nbShape').onclick = e => {
  const n = nodesById.get(state.selectedId); if (!n) return;
  const curShape = isRoot(n) ? (n.shape || 'pill') : (n.shape || '');
  showPop(e.currentTarget, `<div class="row">${Object.entries(SHAPES).filter(([k]) => !(isRoot(n) && k === '')).map(([k, v]) => `<button class="opt${k === curShape ? ' on' : ''}" data-shape="${k}">${v}</button>`).join('')}</div>`);
};
$('#nbColor').onclick = e => {
  const n = nodesById.get(state.selectedId); if (!n) return;
  const p = pos.get(n.id);
  showPop(e.currentTarget, `<div class="row"><span class="lbl">線</span>${Object.entries(LINES).map(([k, v]) => `<button class="opt${(n.line || '') === k ? ' on' : ''}" data-line="${k}">${v}</button>`).join('')}</div>` +
    `<div class="row"><span class="lbl">色</span><div class="pal">${COLORS.map(c => `<button style="background:${c}" data-color="${c}" class="${n.color === c ? 'on' : ''}" title="${c}"></button>`).join('')}<button class="auto${n.color ? '' : ' on'}" data-color="" title="枝の色を引き継ぐ">自動</button></div></div>`);
};
nbpop.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.shape !== undefined) { setProp('shape', b.dataset.shape); hidePop(); }
  else if (b.dataset.line !== undefined) { setProp('line', b.dataset.line); }
  else if (b.dataset.color !== undefined) { setProp('color', b.dataset.color); }
  if (nbpop.style.display === 'block') { const btn = $('#' + nbpop.dataset.for); nbpop.style.display = 'none'; btn.click(); }
});
$('#nbBold').onclick = toggleBold;
$('#nbDup').onclick = duplicateNodes;
$('#nbDel').onclick = () => deleteSelection();
$('#nbMore').onclick = e => { const br = e.currentTarget.getBoundingClientRect(), wr = wrap.getBoundingClientRect(); if (ctx.style.display === 'block') { hideCtx(); return; } hidePop(); showCtxAt(br.left - wr.left, br.bottom - wr.top + 6); };

// ---------- 起動 ----------
renderAll(); renderPenBar();
requestAnimationFrame(() => { if (data.maps.length) openMap([...data.maps].sort((a, b) => b.updatedAt - a.updatedAt)[0].id); });

// ---------- クラウド同期 (cloud.mjs) 向けの窓口 ----------
window.MM = {
  get data() { return data; }, set data(d) { data = d; },
  state, cur, save, renderAll, renderSidebar, renderMap, fitView, ensureSelection, setSelection, migrate,
  isBusy: () => !!(state.drag || marquee || state.editing || state.stroke || state.erase || pinch),
  closeCurrent() { state.mapId = null; setSelection([]); state.history = []; state.future = []; },
  resetHistory() { state.history = []; state.future = []; }
};
if (location.protocol === 'file:') $('#sidebar').classList.add('filemode'); // ファイル直開きでは同期を使えない
