// OTT Studio · sync public social profiles (Instagram + TikTok) through Apify.
// Runs daily, on demand, and when Rechelle adds a handle in the app (GitHub issue "profile: instagram:handle").
// Writes data/profiles.json and stores profile photos in media/profiles/ so images never expire.
import fs from 'node:fs/promises';
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) { console.error('APIFY_TOKEN secret is missing'); process.exit(1); }
const today = new Date().toISOString().slice(0, 10), now = new Date().toISOString();
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const db = await readJSON('data/profiles.json', { updated_at: null, profiles: {} });
const tracked = await readJSON('data/handles.json', { handles: [] });
const fromIssue = (process.env.ISSUE_TITLE || '').toLowerCase().match(/(instagram|tiktok):[a-z0-9._]{1,40}/g) || [];
tracked.handles = [...new Set([...tracked.handles.map(h => h.toLowerCase()), ...fromIssue])];
const only = fromIssue.length ? fromIssue : tracked.handles; // an issue run fetches just the new handles
const run = async (actor, input) => {
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${TOKEN}&timeout=280`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`${actor} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const savePhoto = async (url, path) => { if (!url) return null; try { const r = await fetch(url); if (!r.ok) return null; await fs.writeFile(path, Buffer.from(await r.arrayBuffer())); return path; } catch { return null; } };
const upsert = (key, data) => {
  const prev = db.profiles[key] || {}, history = (prev.history || []).filter(h => h.d !== today);
  if (data.followers != null) history.push({ d: today, f: data.followers });
  db.profiles[key] = { ...prev, ...data, history: history.slice(-400), fetched_at: now, error: null };
};
await fs.mkdir('media/profiles', { recursive: true });
const ig = only.filter(h => h.startsWith('instagram:')).map(h => h.split(':')[1]);
const tt = only.filter(h => h.startsWith('tiktok:')).map(h => h.split(':')[1]);
if (ig.length) {
  const items = await run('apify~instagram-scraper', { directUrls: ig.map(u => `https://www.instagram.com/${u}/`), resultsType: 'details', resultsLimit: 1 });
  const seen = new Set();
  for (const it of items) {
    const u = String(it.username || '').toLowerCase(); if (!u) continue; seen.add(u);
    const photo = await savePhoto(it.profilePicUrlHD || it.profilePicUrl, `media/profiles/instagram-${u}.jpg`);
    upsert(`instagram:${u}`, { platform: 'instagram', handle: u, name: it.fullName || '', bio: it.biography || '', followers: it.followersCount ?? null, following: it.followsCount ?? null, posts: it.postsCount ?? null, verified: !!it.verified, private: !!it.private, link: it.externalUrl || '', url: `https://www.instagram.com/${u}/`, photo: photo || db.profiles[`instagram:${u}`]?.photo || null });
  }
  for (const u of ig) if (!seen.has(u)) db.profiles[`instagram:${u}`] = { ...(db.profiles[`instagram:${u}`] || {}), platform: 'instagram', handle: u, error: 'Not found or private', fetched_at: now };
}
if (tt.length) {
  const items = await run('clockworks~tiktok-scraper', { profiles: tt, resultsPerPage: 1 });
  const seen = new Set();
  for (const it of items) {
    const a = it.authorMeta || {}; const u = String(a.name || '').toLowerCase(); if (!u || seen.has(u)) continue; seen.add(u);
    const photo = await savePhoto(a.avatar || a.originalAvatarUrl, `media/profiles/tiktok-${u}.jpg`);
    upsert(`tiktok:${u}`, { platform: 'tiktok', handle: u, name: a.nickName || '', bio: a.signature || '', followers: a.fans ?? null, following: a.following ?? null, posts: a.video ?? null, likes: a.heart ?? null, verified: !!a.verified, private: !!a.privateAccount, url: `https://www.tiktok.com/@${u}`, photo: photo || db.profiles[`tiktok:${u}`]?.photo || null });
  }
  for (const u of tt) if (!seen.has(u)) db.profiles[`tiktok:${u}`] = { ...(db.profiles[`tiktok:${u}`] || {}), platform: 'tiktok', handle: u, error: 'Not found or private', fetched_at: now };
}
db.updated_at = now;
await fs.writeFile('data/profiles.json', JSON.stringify(db, null, 1));
await fs.writeFile('data/handles.json', JSON.stringify(tracked, null, 1));
console.log(`Synced ${ig.length} Instagram and ${tt.length} TikTok handles.`);
