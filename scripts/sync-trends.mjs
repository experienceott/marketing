// OTT Studio · trends sync. Writes data/trends.json:
//  - us.sounds / us.surging: TikTok trending sounds in the US (Creative Center via Apify)
//  - us.hashtags: TikTok trending hashtags in the US
//  - scene: sounds + hashtags pulled from recent videos in OTT's niche hashtags
//  - cities: event-video activity per market (from #<city>events style hashtags) + OTT engagement lift
//    when a post mentions that city; keeps history so week-over-week bumps show up.
// Every source is independent: if one fails, the rest still save.
import fs from 'node:fs/promises';
const TOKEN = process.env.APIFY_TOKEN, FIX = process.env.APIFY_FIXTURES;
if (!TOKEN && !FIX) { console.error('APIFY_TOKEN secret is missing'); process.exit(1); }
const now = new Date().toISOString(), today = now.slice(0, 10);
const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const cfg = await readJSON('data/trends-config.json', {});
const db = await readJSON('data/trends.json', { cities: {} });
const run = async (actor, input, name) => {
  if (FIX) return readJSON(`${FIX}/${name}.json`, []);
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${TOKEN}&timeout=290`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`${actor} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const items = await r.json();
  if (items[0]) console.log(`${name}: ${items.length} items; fields: ${Object.keys(items[0]).slice(0, 40).join(',')}`);
  return items;
};
const pick = (o, ...ks) => { for (const k of ks) { const v = k.split('.').reduce((a, p) => a?.[p], o); if (v != null && v !== '') return v; } return null; };
const num = v => v == null ? null : typeof v === 'number' ? v : (+String(v).replace(/[^\d.]/g, '') || null);
const errors = [];
const safe = async (label, fn) => { try { await fn(); } catch (e) { errors.push(`${label}: ${e.message || e}`); console.error(label, e.message || e); } };

// 1) US trending sounds (popular + surging)
const normSound = s => ({
  title: pick(s, 'title', 'song_name', 'songName', 'music_name', 'name') || '',
  artist: pick(s, 'author', 'artist', 'artist_name', 'authorName', 'singer') || '',
  rank: num(pick(s, 'rank', 'position')),
  change: num(pick(s, 'rank_diff', 'rankDiff', 'rank_change')) ?? null,
  rank_diff_type: pick(s, 'rank_diff_type', 'rankDiffType'),
  isNew: !!pick(s, 'is_new', 'isNew', 'new_on_board'),
  commercial: !!pick(s, 'is_commerce', 'isCommerce', 'commercial', 'is_commercial'),
  url: pick(s, 'link', 'url', 'music_url', 'tiktok_url', 'musicUrl') || '',
  trend: (pick(s, 'trend', 'trends') || []).map?.(t => num(t?.value ?? t)).filter(v => v != null).slice(-14) || []
});
await safe('US sounds', async () => {
  const pop = await run('burbn~tiktok-trending-sounds', { country_code: 'US', period: '7', rank_type: 'popular', maxResults: 20, limit: 20 }, 'sounds-popular');
  const sur = await run('burbn~tiktok-trending-sounds', { country_code: 'US', period: '7', rank_type: 'surging', maxResults: 20, limit: 20 }, 'sounds-surging');
  const p = pop.map(normSound).filter(s => s.title), q = sur.map(normSound).filter(s => s.title);
  if (p.length || q.length) db.us = { ...(db.us || {}), sounds: p, surging: q, sounds_at: now };
});
// 2) US trending hashtags
await safe('US hashtags', async () => {
  const items = await run('automation-lab~tiktok-trends-scraper', { trendType: 'hashtag', countryCode: 'US', period: 7, maxResults: 40 }, 'hashtags');
  const h = items.map(x => ({ tag: String(pick(x, 'hashtag', 'hashtagName', 'name', 'title') || '').replace(/^#/, ''), rank: num(pick(x, 'rank')), change: num(pick(x, 'rankDiff', 'rank_diff', 'rankChange')), posts: num(pick(x, 'postCount', 'publishCount', 'posts', 'videoCount')), views: num(pick(x, 'videoViews', 'views', 'viewCount')), industry: pick(x, 'industry', 'industryName') || '', isNew: !!pick(x, 'isNew', 'is_new', 'newOnBoard') })).filter(x => x.tag);
  if (h.length) db.us = { ...(db.us || {}), hashtags: h, hashtags_at: now };
});
// 3) Scene + cities from real videos (one TikTok run)
const scene = cfg.scene_hashtags || [], cities = cfg.cities || [];
await safe('Scene + cities', async () => {
  const tags = [...new Set([...scene, ...cities.flatMap(c => c.hashtags)])];
  if (!tags.length) return;
  const items = await run('clockworks~tiktok-scraper', { hashtags: tags, resultsPerPage: cfg.videos_per_hashtag || 15 }, 'videos');
  const cutoff = Date.now() - (cfg.window_days || 30) * 864e5;
  const vids = items.filter(v => v.id).map(v => ({ id: v.id, at: v.createTimeISO || (v.createTime ? new Date(v.createTime * 1000).toISOString() : null), views: v.playCount || 0, eng: (v.diggCount || 0) + (v.commentCount || 0) + (v.shareCount || 0), tags: (v.hashtags || []).map(h => String(h.name || h).toLowerCase()).filter(Boolean), from: String(v.searchHashtag?.name || v.input || '').replace(/^#/, '').toLowerCase(), sound: v.musicMeta && !v.musicMeta.musicOriginal ? { name: v.musicMeta.musicName, author: v.musicMeta.musicAuthor } : null, url: v.webVideoUrl, author: v.authorMeta?.name }))
    .filter(v => v.at && Date.parse(v.at) >= cutoff);
  // Scene sounds + hashtags
  const sv = vids.filter(v => scene.includes(v.from) || v.tags.some(t => scene.includes(t)));
  const S = {}, H = {};
  for (const v of sv) {
    if (v.sound?.name) { const k = (v.sound.name + '|' + v.sound.author).toLowerCase(); (S[k] ||= { title: v.sound.name, artist: v.sound.author, uses: 0, views: 0, creators: new Set(), example: v.url }); S[k].uses++; S[k].views += v.views; S[k].creators.add(v.author); }
    for (const t of new Set(v.tags)) if (!scene.includes(t) && t.length > 2 && !/^(fyp|foryou|foryoupage|viral|trending|fy|parati)/.test(t)) { (H[t] ||= { tag: t, uses: 0, views: 0 }); H[t].uses++; H[t].views += v.views; }
  }
  db.scene = {
    at: now, videos: sv.length,
    sounds: Object.values(S).map(s => ({ ...s, creators: s.creators.size })).sort((a, b) => b.creators - a.creators || b.views - a.views).slice(0, 15),
    hashtags: Object.values(H).filter(h => h.uses >= 2).sort((a, b) => b.uses - a.uses || b.views - a.views).slice(0, 20)
  };
  // Cities
  for (const c of cities) {
    const cv = vids.filter(v => c.hashtags.includes(v.from) || v.tags.some(t => c.hashtags.includes(t)));
    const uniq = [...new Map(cv.map(v => [v.id, v])).values()];
    const views = uniq.reduce((s, v) => s + v.views, 0), eng = uniq.reduce((s, v) => s + v.eng, 0);
    const prev = db.cities[c.name] || { history: [] };
    const point = { d: today, videos: uniq.length, avg_views: uniq.length ? Math.round(views / uniq.length) : 0, er: views ? +(eng / views * 100).toFixed(2) : null };
    const history = [...(prev.history || []).filter(h => h.d !== today), point].slice(-120);
    db.cities[c.name] = { ...prev, name: c.name, state: c.state || '', ott: !!c.ott, hashtags: c.hashtags, history, top: uniq.sort((a, b) => b.views - a.views).slice(0, 3).map(v => ({ url: v.url, views: v.views, author: v.author })) };
  }
});
// 4) OTT engagement lift by city mentioned in its own posts (from profiles.json)
await safe('OTT city lift', async () => {
  const prof = await readJSON('data/profiles.json', { profiles: {} });
  const posts = [...(prof.profiles['instagram:overthetopxp']?.stats?.recent || []), ...(prof.profiles['tiktok:overthetopxp']?.stats?.recent || [])];
  const extra = await readJSON('data/posts.json', { posts: [] });
  const all = [...posts.map(p => ({ caption: p.caption, eng: (p.likes || 0) + (p.comments || 0) + (p.shares || 0) })), ...(extra.posts || []).map(p => ({ caption: p.caption, eng: (p.likes || 0) + (p.comments || 0) }))];
  if (all.length < 4) return;
  const avg = all.reduce((s, p) => s + p.eng, 0) / all.length;
  for (const c of cities) {
    const words = c.aliases || [c.name];
    const hit = all.filter(p => words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p.caption || '')));
    if (db.cities[c.name]) db.cities[c.name].ott_lift = hit.length ? { posts: hit.length, pct: Math.round((hit.reduce((s, p) => s + p.eng, 0) / hit.length / avg - 1) * 100) } : null;
  }
});
db.updated_at = now;
db.errors = errors;
await fs.writeFile('data/trends.json', JSON.stringify(db, null, 1));
console.log('Trends saved.', errors.length ? `${errors.length} source(s) failed.` : '');
