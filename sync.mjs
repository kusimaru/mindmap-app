// クラウド同期 (余白ノートと同じ Firebase プロジェクト・同じログインを使う)
// ルール: 新しい方 (updatedAt) が勝つ。マップ 1 件 = Firestore の 1 ドキュメント (+ 分割チャンク)。
//
// Firestore の配置:
//   users/{uid}/mindmaps/{mapId}          {updatedAt, title, categoryId, deleted, chunks, rev}
//   users/{uid}/mindmaps/{mapId}/parts/{n} {d: base64 のかけら}
//   users/{uid}/meta/mindmap              {categories, updatedAt}
// マップは JSON → UTF-8 → base64 にして、1 MiB 制限より小さなかけらに分ける。

export const SDK_VERSION = '10.14.1';
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD39zOakI_jQFvkSPj03zv9ByPUugXKMew',
  authDomain: 'yohaku-note-3c146.firebaseapp.com',
  projectId: 'yohaku-note-3c146',
  storageBucket: 'yohaku-note-3c146.firebasestorage.app',
  messagingSenderId: '402523531846',
  appId: '1:402523531846:web:84e8fbbbc0f83b3d37f847'
};
const CHUNK_BYTES = 600000; // 3 の倍数: かけら単位で正しい base64 になる

export function encodeChunks(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj)), out = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    const slice = bytes.subarray(i, i + CHUNK_BYTES); let s = '';
    for (let j = 0; j < slice.length; j += 8192) s += String.fromCharCode.apply(null, slice.subarray(j, j + 8192));
    out.push(btoa(s));
  }
  return out.length ? out : [''];
}
export function decodeChunks(chunks) {
  const parts = chunks.map(c => { const bin = atob(c), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; });
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return JSON.parse(new TextDecoder().decode(all));
}
export function describeAuthError(e) {
  const code = e?.code || '';
  if (code.includes('invalid-email')) return 'メールアドレスの形が正しくありません。';
  if (code.includes('missing-password') || code.includes('weak-password')) return 'パスワードは6文字以上にしてください。';
  if (code.includes('email-already-in-use')) return 'このメールアドレスはすでに登録されています。「ログイン」を押してください。';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'メールアドレスかパスワードが違います。初めての場合は「新規登録」を押してください。';
  if (code.includes('too-many-requests')) return '試行回数が多すぎます。しばらく待ってからやり直してください。';
  if (code.includes('network-request-failed')) return 'インターネットに接続できません。';
  if (code.includes('operation-not-allowed')) return 'メール/パスワードでのログインが Firebase 側で有効になっていません。';
  if (code.includes('permission-denied')) return 'Firestore のルールでこのアプリの保存先 (users/{uid}/mindmaps, users/{uid}/meta/mindmap) が許可されていません。';
  return e?.message || String(e);
}

// ---------- Firebase 接続 ----------
export async function createFirebaseTransport(config = FIREBASE_CONFIG) {
  const base = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  const [{ initializeApp }, A, F] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  const app = initializeApp(config), auth = A.getAuth(app);
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() }); }
  catch { db = F.getFirestore(app); }
  const chunkCounts = new Map();
  const ref = (uid, c, id) => F.doc(db, 'users', uid, c, id), parts = (uid, c, id) => F.collection(db, 'users', uid, c, id, 'parts');
  return {
    kind: 'firebase',
    onAuth(cb) { return A.onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, email: u.email || '' } : null)); },
    signIn: (email, password) => A.signInWithEmailAndPassword(auth, email, password),
    signUp: (email, password) => A.createUserWithEmailAndPassword(auth, email, password),
    resetPassword: email => A.sendPasswordResetEmail(auth, email),
    signOut: () => A.signOut(auth),
    async write(uid, c, id, obj, meta) {
      const chunks = encodeChunks(obj), batch = F.writeBatch(db);
      batch.set(ref(uid, c, id), { ...meta, deleted: false, chunks: chunks.length, rev: meta.updatedAt });
      chunks.forEach((d, i) => batch.set(F.doc(parts(uid, c, id), String(i)), { d }));
      await batch.commit();
      const known = chunkCounts.get(c + '/' + id);
      if (known === undefined || known > chunks.length) { // 前の版の余ったかけらを消す
        const old = await F.getDocs(parts(uid, c, id)); const extra = []; old.forEach(d => { if (Number(d.id) >= chunks.length) extra.push(d.ref); });
        if (extra.length) { const b2 = F.writeBatch(db); extra.forEach(r => b2.delete(r)); await b2.commit(); }
      }
      chunkCounts.set(c + '/' + id, chunks.length);
    },
    async remove(uid, c, id, updatedAt) {
      const batch = F.writeBatch(db); batch.set(ref(uid, c, id), { deleted: true, updatedAt, chunks: 0, rev: updatedAt });
      const old = await F.getDocs(parts(uid, c, id)); old.forEach(d => batch.delete(d.ref)); await batch.commit(); chunkCounts.set(c + '/' + id, 0);
    },
    async read(uid, c, id) {
      const meta = await F.getDoc(ref(uid, c, id)); if (!meta.exists() || meta.data().deleted) return null;
      const n = meta.data().chunks, snap = await F.getDocsFromServer(parts(uid, c, id)), arr = [];
      snap.forEach(d => { arr[Number(d.id)] = d.data().d; });
      const chunks = arr.slice(0, n); if (chunks.length !== n || chunks.some(x => typeof x !== 'string')) throw new Error('incomplete');
      return { updatedAt: meta.data().updatedAt, obj: decodeChunks(chunks) };
    },
    listen(uid, c, cb) {
      return F.onSnapshot(F.collection(db, 'users', uid, c), snap => {
        cb(snap.docChanges().map(ch => ({ type: ch.type, id: ch.doc.id, ...ch.doc.data() })), snap.metadata.fromCache);
      }, e => cb(null, false, e));
    },
    writeMeta: (uid, metaId, obj) => F.setDoc(ref(uid, 'meta', metaId), obj),
    listenMeta(uid, metaId, cb) { return F.onSnapshot(ref(uid, 'meta', metaId), d => cb(d.exists() ? d.data() : null), e => cb(null, e)); }
  };
}

// ---------- 同期エンジン ----------
// host: {getItems() -> [{id, updatedAt}], getItem(id), getMeta() -> {..., updatedAt}, setStatus(state, detail, error),
//        applyItem(id, obj|null), applyMeta(meta), isBusy(), validateItem(obj)}
export function createSyncEngine(transport, host, { col = 'mindmaps', metaId = 'mindmap', pendingKey = 'mindmap-sync-pending' } = {}) {
  const pending = new Map(); let uid = null, unsubs = [], timer = null, flushing = false, readQueue = [], reading = false, stopped = false;
  const seen = new Set(); let firstSnapshot = false;
  const persist = () => { try { localStorage.setItem(pendingKey, JSON.stringify([...pending.keys()])); } catch {} };
  try { for (const k of JSON.parse(localStorage.getItem(pendingKey) || '[]')) pending.set(k, true); } catch {}
  const schedule = (ms = 1500) => { clearTimeout(timer); timer = setTimeout(flush, ms); };
  let lastWriteMs = 0;
  function mark(kind, id = '') { pending.set(kind + ':' + id, true); persist(); if (uid) schedule(); }
  async function flush() {
    if (!uid || flushing || stopped) return;
    if (!pending.size) { host.setStatus('online', { lastWriteMs }); return; }
    if (host.isBusy()) { schedule(700); return; }
    flushing = true; host.setStatus('sending', pending.size);
    try {
      for (const key of [...pending.keys()]) {
        if (host.isBusy()) { schedule(700); break; }
        const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1); const t0 = performance.now();
        if (kind === 'item') {
          const it = host.getItem(id);
          if (it) await transport.write(uid, col, id, it, { updatedAt: it.updatedAt || Date.now(), title: it.title || '', categoryId: it.categoryId || '' });
          else await transport.remove(uid, col, id, Date.now());
        } else if (kind === 'meta') {
          const meta = host.getMeta();
          await transport.writeMeta(uid, metaId, { ...meta, updatedAt: meta.updatedAt || Date.now() });
        }
        pending.delete(key); persist(); lastWriteMs = Math.round(performance.now() - t0);
      }
      if (!pending.size) host.setStatus('online', { lastWriteMs });
    } catch (e) { host.setStatus(navigator.onLine ? 'error' : 'offline', pending.size, e); schedule(15000); }
    finally { flushing = false; if (pending.size && !timer) schedule(); }
  }
  function queueRead(id, updatedAt) { readQueue = readQueue.filter(r => r.id !== id); readQueue.push({ id, updatedAt }); drainReads(); }
  async function drainReads() {
    if (reading || !uid) return; reading = true;
    try {
      while (readQueue.length && !stopped) {
        if (host.isBusy()) { await new Promise(r => setTimeout(r, 400)); continue; }
        const job = readQueue.shift();
        try {
          const got = await transport.read(uid, col, job.id);
          if (!got) continue;
          const cur = host.getItem(job.id), curStamp = cur ? (cur.updatedAt || 0) : -1; // 通信の間に手元で編集されていたら手元を優先
          if (pending.has('item:' + job.id) || curStamp >= (got.updatedAt || 0)) continue;
          const obj = got.obj; if (obj && obj.id === job.id && host.validateItem(obj)) host.applyItem(job.id, obj);
        } catch (e) { console.warn('sync read failed', job.id, e); readQueue.push(job); await new Promise(r => setTimeout(r, 3000)); if (readQueue.length === 1 && readQueue[0] === job) break; }
      }
    } finally { reading = false; }
  }
  function onChanges(changes, fromCache, error) {
    if (error) { host.setStatus('error', 0, error); return; }
    for (const ch of changes || []) {
      if (ch.type === 'removed') continue;
      seen.add(ch.id);
      const local = host.getItem(ch.id), localStamp = local ? (local.updatedAt || 0) : -1, remoteStamp = ch.updatedAt || 0, pendingLocal = pending.has('item:' + ch.id);
      if (ch.deleted) {
        if (local && localStamp > remoteStamp) { mark('item', ch.id); continue; }
        if (local && !pendingLocal) host.applyItem(ch.id, null);
        continue;
      }
      if (local && localStamp >= remoteStamp) continue;
      if (pendingLocal && local) continue;
      queueRead(ch.id, remoteStamp);
    }
    if (!firstSnapshot && !fromCache) { // 初回: クラウドに無い手元のマップを送る
      firstSnapshot = true;
      for (const it of host.getItems()) if (!seen.has(it.id)) mark('item', it.id);
      if (!pending.has('meta:')) mark('meta');
    }
  }
  function onMeta(meta, error) {
    if (error) { host.setStatus('error', 0, error); return; }
    if (!meta) return;
    if ((meta.updatedAt || 0) > (host.getMeta().updatedAt || 0) && !pending.has('meta:')) host.applyMeta(meta);
  }
  return {
    markItem: id => mark('item', id), removeItem: id => mark('item', id), markMeta: () => mark('meta'),
    pendingCount: () => pending.size,
    start(userId) {
      this.stop(); stopped = false; uid = userId; host.setStatus('connecting');
      firstSnapshot = false; seen.clear();
      unsubs = [transport.listen(uid, col, (ch, fc, e) => onChanges(ch, fc, e)), transport.listenMeta(uid, metaId, onMeta)];
      if (pending.size) schedule(500); else host.setStatus('online');
    },
    stop() { stopped = true; for (const u of unsubs) try { u(); } catch {} unsubs = []; uid = null; clearTimeout(timer); timer = null; readQueue = []; },
    flushNow() { clearTimeout(timer); timer = null; return flush(); },
    retry() { if (uid) schedule(200); }
  };
}
