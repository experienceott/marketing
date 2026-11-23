// OTT Studio · Meta sync (Instagram insights + ad spend). Runs daily.
// Private data: written to Supabase table ott_private (members-only), never to this public repo.
const V = 'v24.0', G = `https://graph.facebook.com/${V}`;
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_ROLE_KEY, UT = process.env.META_ACCESS_TOKEN, IG_HANDLE = (process.env.IG_HANDLE || 'overthetopxp').toLowerCase();
if (!SB || !SK) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY secrets are needed (private storage).'); process.exit(1); }
const sb = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { apikey: SK, ...(SK.startsWith('sb_') ? {} : { Authorization: `Bearer ${SK}` }), 'Content-Type': 'application/json', ...(opts.headers || {}) } }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`); const t = await r.text(); return t ? JSON.parse(t) : null; };
const save = (key, data) => sb('ott_private', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify([{ key, data, updated_at: new Date().toISOString() }]) });
const load = async key => (await sb(`ott_private?key=eq.${key}&select=data`))?.[0]?.data || null;
const gq = async (path, token, params = {}) => { const u = new URL(`${G}/${path}`); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); u.searchParams.set('access_token', token); const r = await fetch(u); const j = await r.json(); if (j.error) throw new Error(`${path}: ${j.error.message}`); return j; };
const errors = [], safe = async (l, f) => { try { return await f(); } catch (e) { errors.push(`${l}: ${e.message}`); console.error(l, e.message); } };

// 1) Find the Instagram account + a Page token (Page tokens from a long-lived user token don't expire; keep it privately)
let cred = await load('meta_cred');
if (cred && cred.username?.toLowerCase() !== IG_HANDLE) cred = null;
if (UT) await safe('Find account', async () => {
  const pages = await gq('me/accounts', UT, { fields: 'name,access_token,instagram_business_account{id,username}', limit: 100 });
  const pg = pages.data.find(p => p.instagram_business_account?.username?.toLowerCase() === IG_HANDLE);
  if (!pg) {
    console.error(`@${IG_HANDLE} was not shared with the app. Pages it can see: ` + (pages.data.map(p => `${p.name} (IG: ${p.instagram_business_account?.username || 'none'})`).join(', ') || 'none'));
    await sb('ott_private?key=in.(meta,meta_cred)', { method: 'DELETE' });
    process.exit(1);
  }
  cred = { ig_id: pg.instagram_business_account.id, username: pg.instagram_business_account.username, page: pg.name, page_token: pg.access_token, at: new Date().toISOString() };
  await save('meta_cred', cred);
});
if (!cred) { console.error(errors.join('\n') || 'No Meta connection yet'); process.exit(1); }
const T = cred.page_token, IG = cred.ig_id, out = { updated_at: new Date().toISOString(), username: cred.username };
const now = Math.floor(Date.now() / 1000), d30 = now - 30 * 86400;

// 2) Audience: where followers and engaged/reached people are
const demo = async (metric, breakdown, extra = {}) => { const j = await gq(`${IG}/insights`, T, { metric, period: 'lifetime', metric_type: 'total_value', breakdown, ...extra }); const r = j.data?.[0]?.total_value?.breakdowns?.[0]?.results || []; return r.map(x => ({ k: x.dimension_values?.[0], v: x.value })).sort((a, b) => b.v - a.v); };
out.audience = {};
for (const b of ['city', 'country', 'age', 'gender']) {
  await safe(`followers ${b}`, async () => { (out.audience.followers ||= {})[b] = await demo('follower_demographics', b); });
  await safe(`engaged ${b}`, async () => { (out.audience.engaged ||= {})[b] = await demo('engaged_audience_demographics', b, { timeframe: 'this_month' }); });
  if (b === 'city') await safe('reached city', async () => { (out.audience.reached ||= {}).city = await demo('reached_audience_demographics', b, { timeframe: 'this_month' }); });
}
// 3) When followers are online (hourly, last ~30 days)
await safe('online followers', async () => { const j = await gq(`${IG}/insights`, T, { metric: 'online_followers', period: 'lifetime', since: d30, until: now }); const days = (j.data?.[0]?.values || []).map(v => v.value).filter(v => v && typeof v === 'object'); const hrs = Array(24).fill(0); for (const d of days) for (const [h, n] of Object.entries(d)) hrs[+h] += n; out.online = { days: days.length, by_hour: hrs.map(n => days.length ? Math.round(n / days.length) : 0), tz: 'America/Los_Angeles (Meta reports in Pacific time)' }; });
// 4) Account totals, last 30 days + daily reach
await safe('account totals', async () => { const j = await gq(`${IG}/insights`, T, { metric: 'reach,views,accounts_engaged,total_interactions,likes,comments,saves,shares,profile_views,website_clicks', period: 'day', metric_type: 'total_value', since: d30, until: now }); out.totals = Object.fromEntries((j.data || []).map(m => [m.name, m.total_value?.value ?? null])); });
await safe('daily reach', async () => { const j = await gq(`${IG}/insights`, T, { metric: 'reach', period: 'day', since: d30, until: now }); out.reach_daily = (j.data?.[0]?.values || []).map(v => ({ d: String(v.end_time).slice(0, 10), v: v.value })); });
await safe('followers', async () => { const j = await gq(IG, T, { fields: 'followers_count,media_count' }); out.followers = j.followers_count; });
// 5) Posts with reach, saves, shares
await safe('media', async () => {
  const j = await gq(`${IG}/media`, T, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url,media_url', limit: 30 });
  out.posts = [];
  for (const m of j.data || []) {
    const row = { id: m.id, url: m.permalink, type: m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : m.media_product_type === 'STORY' ? 'Story' : 'Post', at: m.timestamp, likes: m.like_count, comments: m.comments_count, caption: (m.caption || '').slice(0, 160), thumb: m.thumbnail_url || (m.media_type === 'IMAGE' ? m.media_url : null) };
    try { const ins = await gq(`${m.id}/insights`, T, { metric: 'reach,saved,shares,views,total_interactions' }); for (const x of ins.data || []) row[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? null; } catch (e) { row.ins_error = e.message.slice(0, 80); }
    out.posts.push(row);
  }
});
// 6) Ad spend by campaign, last 90 days (needs the user token with ads_read)
if (UT) await safe('ads', async () => {
  const acc = await gq('me/adaccounts', UT, { fields: 'name,account_id,currency', limit: 50 });
  out.ads = [];
  for (const a of acc.data || []) {
    const ins = await gq(`act_${a.account_id}/insights`, UT, { level: 'campaign', date_preset: 'last_90d', fields: 'campaign_name,spend,impressions,reach,clicks,inline_link_clicks,actions,date_start,date_stop', limit: 200 });
    for (const r of ins.data || []) out.ads.push({ account: a.name, currency: a.currency, campaign: r.campaign_name, spend: +r.spend || 0, impressions: +r.impressions || 0, reach: +r.reach || 0, clicks: +r.inline_link_clicks || +r.clicks || 0, purchases: +(r.actions || []).find(x => /purchase/.test(x.action_type))?.value || 0, from: r.date_start, to: r.date_stop });
  }
});
out.errors = errors;
await save('meta', out);
console.log(`Meta saved for @${cred.username}. ${errors.length} part(s) failed.`);
if (errors.length) console.log(errors.join('\n'));
