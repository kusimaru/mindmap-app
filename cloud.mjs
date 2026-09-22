// クラウド同期の配線: ログイン画面、ローカル変更の検出、クラウドからの反映、Service Worker
import { createSyncEngine, createFirebaseTransport, describeAuthError } from './sync.mjs';

const $ = id => document.getElementById(id);
const MM = window.MM;
let transport = null, engine = null, applying = false, observed = null;

// ---------- ローカルの変更を見つけて送信キューに積む (app.js の save() から呼ばれる) ----------
function catSig() { return JSON.stringify(MM.data.categories); }
function snapshotObserved() { observed = { maps: new Map(MM.data.maps.map(m => [m.id, m.updatedAt || 0])), sig: catSig() }; }
function observe() {
  if (!engine || !observed || applying) return;
  const d = MM.data, now = new Map(d.maps.map(m => [m.id, m.updatedAt || 0]));
  for (const [id, t] of now) if (!observed.maps.has(id) || observed.maps.get(id) !== t) engine.markItem(id);
  for (const id of observed.maps.keys()) if (!now.has(id)) engine.removeItem(id);
  const sig = catSig();
  if (sig !== observed.sig) { d.metaUpdatedAt = Date.now(); engine.markMeta(); }
  observed = { maps: now, sig };
}
window.cloud = { observe };

// ---------- クラウドからの反映 ----------
function validMap(m) {
  const okNode = n => n && typeof n === 'object' && typeof n.text === 'string' && Array.isArray(n.children) && n.children.every(okNode);
  return m && typeof m.id === 'string' && typeof m.title === 'string' && okNode(m.root) && (m.strokes === undefined || Array.isArray(m.strokes));
}
function applyRemoteMap(id, map) {
  applying = true;
  try {
    const d = MM.data, i = d.maps.findIndex(x => x.id === id);
    if (!map) { if (i < 0) return; d.maps.splice(i, 1); if (MM.state.mapId === id) MM.closeCurrent(); }
    else { if (i >= 0) d.maps[i] = map; else d.maps.push(map); if (MM.state.mapId === id) { MM.resetHistory(); MM.ensureSelection(); } }
    MM.save(); MM.renderAll();
  } finally { applying = false; snapshotObserved(); }
}
function applyRemoteMeta(meta) {
  applying = true;
  try {
    const d = MM.data;
    if (Array.isArray(meta.categories)) { // クラウド優先。手元にしか無いものは残す (送信待ちかもしれない)
      const remote = meta.categories.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string');
      const ids = new Set(remote.map(c => c.id));
      d.categories = [...remote.map(c => ({ id: c.id, name: c.name.slice(0, 60), color: c.color || '#6b7280' })), ...d.categories.filter(c => !ids.has(c.id))];
    }
    d.metaUpdatedAt = meta.updatedAt || Date.now();
    MM.save(); MM.renderAll();
  } finally { applying = false; snapshotObserved(); }
}

// ---------- 状態表示 ----------
function setStatus(state, detail, error) {
  const badge = $('sync-badge');
  const map = { off: ['オフ', ''], connecting: ['接続中', 'warn'], online: ['同期済み', 'on'], sending: ['送信中', 'warn'], offline: ['オフライン', 'warn'], error: ['エラー', 'err'] };
  const [text, cls] = map[state] || map.off;
  badge.textContent = text; badge.className = 'sync-badge ' + cls;
  if (state === 'error' && error) { $('sync-detail').textContent = 'エラー: ' + describeAuthError(error); console.warn('sync', error); }
  else if (state === 'online') $('sync-detail').textContent = 'この端末とクラウドは同じ状態です。' + (detail && detail.lastWriteMs ? '（最後の送信 ' + (detail.lastWriteMs / 1000).toFixed(1) + ' 秒）' : '');
  else if (state === 'offline') $('sync-detail').textContent = 'つながったときに自動で送ります（未送信 ' + (detail || 0) + '）。';
  else if (state === 'sending') $('sync-detail').textContent = '送信中… (' + (detail || 0) + ' 件)';
}
function message(text) { const el = $('sync-message'); el.textContent = text; el.hidden = !text; }

// ---------- 接続とログイン ----------
async function connect() {
  if (transport) return true;
  setStatus('connecting');
  try { transport = await createFirebaseTransport(); }
  catch (e) { transport = null; setStatus(navigator.onLine ? 'error' : 'offline', 0, e); message('同期の準備ができませんでした。インターネットに接続して、もう一度お試しください。'); return false; }
  engine = createSyncEngine(transport, {
    getItems: () => MM.data.maps, getItem: id => MM.data.maps.find(m => m.id === id) || null,
    getMeta: () => ({ categories: MM.data.categories, updatedAt: MM.data.metaUpdatedAt || 0 }),
    setStatus, applyItem: applyRemoteMap, applyMeta: applyRemoteMeta, isBusy: () => MM.isBusy(), validateItem: validMap
  });
  transport.onAuth(user => {
    $('sync-signed-out').hidden = !!user; $('sync-signed-in').hidden = !user; $('sync-who').textContent = user ? user.email : '';
    if (user) {
      $('sync-account').textContent = user.email + ' としてログイン中';
      try { localStorage.setItem('mindmap-sync', 'on'); } catch {}
      snapshotObserved(); engine.start(user.uid);
    } else { engine.stop(); setStatus('off'); }
  });
  window.addEventListener('online', () => engine && engine.retry());
  return true;
}
$('sync-form').onsubmit = async e => {
  e.preventDefault(); message('');
  if (!(await connect())) return;
  try { await transport.signIn($('sync-email').value.trim(), $('sync-password').value); message(''); }
  catch (err) { message(describeAuthError(err)); }
};
$('sync-signup').onclick = async () => {
  message('');
  if (!$('sync-email').value.trim() || $('sync-password').value.length < 6) { message('メールアドレスと、6文字以上のパスワードを入れてください。'); return; }
  if (!(await connect())) return;
  try { await transport.signUp($('sync-email').value.trim(), $('sync-password').value); message('登録しました。もう一方の端末でも、同じメールアドレスとパスワードでログインしてください。'); }
  catch (err) { message(describeAuthError(err)); }
};
$('sync-reset').onclick = async () => {
  const email = $('sync-email').value.trim(); if (!email) { message('先にメールアドレスを入れてください。'); return; }
  if (!(await connect())) return;
  try { await transport.resetPassword(email); message('パスワード再設定のメールを送りました。届いたメールの案内に従ってください。'); } catch (err) { message(describeAuthError(err)); }
};
$('sync-logout').onclick = async () => {
  if (engine && engine.pendingCount()) { message('未送信の変更があります。「同期済み」になってからログアウトしてください。'); return; }
  try { localStorage.setItem('mindmap-sync', 'off'); } catch {}
  try { await transport.signOut(); } catch {}
  message('ログアウトしました。この端末のマップはそのまま残ります。');
};
{ const box = $('sync-tools'); try { box.open = localStorage.getItem('mindmap-sync-open') === '1'; } catch {}
  box.addEventListener('toggle', () => { try { localStorage.setItem('mindmap-sync-open', box.open ? '1' : '0'); } catch {} }); }

// 前回ログインしていたら自動で接続
(async () => { let wanted = false; try { wanted = localStorage.getItem('mindmap-sync') === 'on'; } catch {} if (wanted) await connect(); else setStatus('off'); })();

// ---------- オフライン起動と自動更新 ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let reloading = false; const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController || !navigator.serviceWorker.controller) return; reloading = true;
    if (MM.isBusy()) return; // 操作中なら次回起動時に新しい版になる
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
