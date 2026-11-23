// OTT Studio · sync public social profiles (Instagram + TikTok) through Apify.
// Runs daily on a schedule (.github/workflows/social-sync.yml), on demand, and when Rechelle adds a
// handle in the app (GitHub issue "profile: instagram:handle").
// Tracks OTT, talent from data/handles.json, and every competitor in data/competitors.json.
// Writes data/profiles.json (profile + daily follower history + recent post stats) and stores
// profile photos in media/profiles/ so images never expire.
import fs from 'node:fs/promises';
const TOKEN = process.env.APIFY_TOKEN, FIXTURES = process.env.APIFY_FIXTURES; // FIXTURES: local test mode
if (!TOKEN && !FIXTURES) { console.error('APIFY_TOKEN secret is missing'); process.exit(1); }
const today = new Date().toISOString().slice(0, 10), now = new Date().toISOString();
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const db = await readJSON('data/profiles.json', { updated_at: null, profiles: {} });
const tracked = await readJSON('data/handles.json', { handles: [] });
const comp = await readJSON('data/competitors.json', { competitors: [] });
const compHandles = [...(comp.self?.handles || []), ...comp.competitors.flatMap(c => c.handles || [])].map(h => h.toLowerCase());
const fromIssue = (process.env.ISSUE_TITLE || '').toLowerCase().match(/(instagram|tiktok):[a-z0-9._]{1,40}/g) || [];
tracked.handles = [...new Set([...tracked.handles.map(h => h.toLowerCase()), ...fromIssue])];
const all = [...new Set([...tracked.handles, ...compHandles])];
const only = fromIssue.length ? fromIssue : all; // an issue run fetches just the new handles
const run = async (actor, input) => {
  if (FIXTURES) return JSON.parse(await fs.readFile(`${FIXTURES}/${actor.split('~')[1]}.json`, 'utf8'));
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${TOKEN}&timeout=290`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`${actor} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const savePhoto = async (url, path) => { if (!url || FIXTURES) return null; try { const r = await fetch(url); if (!r.ok) return null; await fs.writeFile(path, Buffer.from(await r.arrayBuffer())); return path; } catch { return null; } };
const upsert = (key, data) => {
  const prev = db.profiles[key] || {}, history = (prev.history || []).filter(h => h.d !== today);
  if (data.followers != null) history.push({ d: today, f: data.followers });
  db.profiles[key] = { ...prev, ...data, history: history.slice(-400), fetched_at: now, error: null };
};
// Recent post stats: posting pace, average engagement, engagement rate, best post.
const DAY = 864e5;
const summarize = (posts, followers, byViews = false) => {
  posts = posts.filter(p => p.at).sort((a, b) => b.at.localeCompare(a.at));
  if (!posts.length) return null;
  const inter = p => (p.likes || 0) + (p.comments || 0) + (p.shares || 0);
  const span = Math.max(1, (Date.parse(posts[0].at) - Date.parse(posts[posts.length - 1].at)) / DAY);
  const avg = Math.round(posts.reduce((s, p) => s + inter(p), 0) / posts.length);
  const views = posts.filter(p => p.views != null);
  const best = [...posts].sort((a, b) => inter(b) - inter(a))[0];
  return {
    sample: posts.length,
    last_post: posts[0].at,
    posts_per_week: +(posts.length > 1 ? (posts.length - 1) / span * 7 : 0).toFixed(1),
    avg_interactions: avg,
    avg_views: views.length ? Math.round(views.reduce((s, p) => s + p.views, 0) / views.length) : null,
    engagement_rate: byViews ? (views.length ? +(views.reduce((s, p) => s + inter(p), 0) / Math.max(1, views.reduce((s, p) => s + p.views, 0)) * 100).toFixed(2) : null) : (followers ? +(avg / followers * 100).toFixed(2) : null),
    engagement_basis: byViews ? 'views' : 'followers',
    formats: posts.reduce((m, p) => (m[p.type] = (m[p.type] || 0) + 1, m), {}),
    best: { thumb_src: best.thumb || null, url: best.url, type: best.type, at: best.at, interactions: inter(best), views: best.views ?? null, caption: (best.caption || '').slice(0, 160), sound: best.sound || null },
    recent: posts.slice(0, 6).map(p => ({ url: p.url, type: p.type, at: p.at, likes: p.likes, comments: p.comments, shares: p.shares ?? null, views: p.views ?? null, caption: (p.caption || '').slice(0, 120), sound: p.sound || null }))
  };
};
await fs.mkdir('media/profiles', { recursive: true }); await fs.mkdir('media/posts', { recursive: true });
const ig = only.filter(h => h.startsWith('instagram:')).map(h => h.split(':')[1]);
const tt = only.filter(h => h.startsWith('tiktok:')).map(h => h.split(':')[1]);
const failures = [];
if (ig.length) {
  try {
    const items = await run('apify~instagram-scraper', { directUrls: ig.map(u => `https://www.instagram.com/${u}/`), resultsType: 'details', resultsLimit: 1 });
    const seen = new Set();
    for (const it of items) {
      const u = String(it.username || '').toLowerCase(); if (!u) continue; seen.add(u);
      const photo = await savePhoto(it.profilePicUrlHD || it.profilePicUrl, `media/profiles/instagram-${u}.jpg`);
      const posts = (it.latestPosts || []).filter(p => !p.isPinned).map(p => ({ url: p.url || (p.shortCode ? `https://www.instagram.com/p/${p.shortCode}/` : ''), type: p.type === 'Sidecar' ? 'Carousel' : p.type === 'Video' ? 'Reel' : (p.type || 'Photo'), at: p.timestamp, likes: p.likesCount > 0 ? p.likesCount : 0, comments: p.commentsCount || 0, views: p.videoViewCount ?? p.videoPlayCount ?? null, caption: p.caption, thumb: p.displayUrl || null }));
      const st = summarize(posts, it.followersCount); if (st?.best) { st.best.thumb = await savePhoto(st.best.thumb_src, `media/posts/best-instagram-${u}.jpg`) || db.profiles[`instagram:${u}`]?.stats?.best?.thumb || null; delete st.best.thumb_src; }
      upsert(`instagram:${u}`, { platform: 'instagram', handle: u, name: it.fullName || '', bio: it.biography || '', followers: it.followersCount ?? null, following: it.followsCount ?? null, posts: it.postsCount ?? null, verified: !!it.verified, private: !!it.private, link: it.externalUrl || '', url: `https://www.instagram.com/${u}/`, photo: photo || db.profiles[`instagram:${u}`]?.photo || null, stats: st });
    }
    for (const u of ig) if (!seen.has(u)) db.profiles[`instagram:${u}`] = { ...(db.profiles[`instagram:${u}`] || {}), platform: 'instagram', handle: u, error: 'Not found or private', fetched_at: now };
  } catch (e) { failures.push(String(e.message || e)); }
}
if (tt.length) {
  try {
    const items = await run('clockworks~tiktok-scraper', { profiles: tt, resultsPerPage: 12, profileSorting: 'latest', excludePinnedPosts: true });
    const byUser = {};
    for (const it of items) { const a = it.authorMeta || {}; const u = String(a.name || '').toLowerCase(); if (!u) continue; (byUser[u] ||= { a, vids: [] }).vids.push(it); }
    for (const [u, { a, vids }] of Object.entries(byUser)) {
      const photo = await savePhoto(a.avatar || a.originalAvatarUrl, `media/profiles/tiktok-${u}.jpg`);
      const posts = vids.filter(v => v.id).map(v => ({ url: v.webVideoUrl || `https://www.tiktok.com/@${u}/video/${v.id}`, type: v.isSlideshow ? 'Slideshow' : 'Video', at: v.createTimeISO || (v.createTime ? new Date(v.createTime * 1000).toISOString() : null), likes: v.diggCount || 0, comments: v.commentCount || 0, shares: v.shareCount || 0, views: v.playCount ?? null, caption: v.text, thumb: v.videoMeta?.coverUrl || v.videoMeta?.originalCoverUrl || null, sound: v.musicMeta ? { name: v.musicMeta.musicName || '', author: v.musicMeta.musicAuthor || '', original: !!v.musicMeta.musicOriginal } : null }));
      const st = summarize(posts, a.fans, true); if (st?.best) { st.best.thumb = await savePhoto(st.best.thumb_src, `media/posts/best-tiktok-${u}.jpg`) || db.profiles[`tiktok:${u}`]?.stats?.best?.thumb || null; delete st.best.thumb_src; }
      upsert(`tiktok:${u}`, { platform: 'tiktok', handle: u, name: a.nickName || '', bio: a.signature || '', followers: a.fans ?? null, following: a.following ?? null, posts: a.video ?? null, likes: a.heart ?? null, verified: !!a.verified, private: !!a.privateAccount, url: `https://www.tiktok.com/@${u}`, photo: photo || db.profiles[`tiktok:${u}`]?.photo || null, stats: st });
    }
    for (const u of tt) if (!byUser[u]) db.profiles[`tiktok:${u}`] = { ...(db.profiles[`tiktok:${u}`] || {}), platform: 'tiktok', handle: u, error: 'Not found or private', fetched_at: now };
  } catch (e) { failures.push(String(e.message || e)); }
}
db.updated_at = now;
await fs.writeFile('data/profiles.json', JSON.stringify(db, null, 1));
await fs.writeFile('data/handles.json', JSON.stringify(tracked, null, 1));
console.log(`Synced ${ig.length} Instagram and ${tt.length} TikTok handles.`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
