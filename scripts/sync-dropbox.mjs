// OTT Studio · Dropbox photo sync. Walks the event photo folders through the Studio Apps Script
// (which holds the Dropbox connection), keeps the cursor so later runs only fetch new files,
// and stores the list privately in Supabase (ott_private: dropbox). Studio adds new photos on load.
const U = process.env.APPS_SCRIPT_URL, SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!U || !SB || !SK) { console.error('Missing APPS_SCRIPT_URL / SUPABASE secrets'); process.exit(1); }
const sb = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { apikey: SK, ...(SK.startsWith('sb_') ? {} : { Authorization: `Bearer ${SK}` }), 'Content-Type': 'application/json', ...(opts.headers || {}) } }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`); const t = await r.text(); return t ? JSON.parse(t) : null; };
const prev = (await sb('ott_private?key=eq.dropbox&select=data'))?.[0]?.data || { files: [], cursor: '' };
const have = new Set(prev.files.map(f => f.path)); let cursor = prev.done ? prev.cursor : (prev.cursor || ''), added = 0, pages = 0;
const started = Date.now();
while (Date.now() - started < 20 * 60e3) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 330e3);
  let j; try { const r = await fetch(U + '?dropbox=list' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal: ctl.signal }); j = JSON.parse(await r.text()); } catch (e) { console.error('page failed', e.message); break; } finally { clearTimeout(to); }
  if (!j.ok) { console.error('Dropbox:', j.error); break; }
  for (const f of j.files || []) if (f.url && !have.has(f.path)) { prev.files.push({ path: f.path, name: f.name, modified: f.modified, url: f.url }); have.add(f.path); added++; }
  cursor = j.cursor || cursor; pages++;
  if (!j.has_more) { prev.done = true; break; }
  if (pages % 5 === 0) await sb('ott_private', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify([{ key: 'dropbox', data: { ...prev, cursor }, updated_at: new Date().toISOString() }]) });
}
prev.cursor = cursor; prev.updated_at = new Date().toISOString();
await sb('ott_private', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify([{ key: 'dropbox', data: prev, updated_at: prev.updated_at }]) });
console.log(`Dropbox: ${added} new files, ${prev.files.length} total, ${pages} pages${prev.done ? ', caught up' : ', will continue next run'}.`);
