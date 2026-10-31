/** Optional, permission-gated public music metadata and SoundCloud discovery.
 * Does not stream or proxy third-party media, and never manufactures playable matches. */
const MB = 'https://musicbrainz.org/ws/2';
const LB = 'https://api.listenbrainz.org/1';
const SC = 'https://api.soundcloud.com';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const OEMBED = 'https://soundcloud.com/oembed';
const clean = (value, max = 160) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, max) : '';
const tokens = (value) => clean(value).toLocaleLowerCase('ru').replace(/[\p{P}\p{S}]/gu, ' ').split(/\s+/).filter(Boolean);
const sameWords = (a, b) => {
  const left = new Set(tokens(a)), right = new Set(tokens(b));
  return !!left.size && [...left].every((x) => right.has(x));
};
const safeUrl = (value) => {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname !== 'soundcloud.com' || u.pathname.split('/').filter(Boolean).length !== 2) return null;
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
};
const validMbid = (value) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value || '');
const validUsername = (name) => /^[\w-]{1,80}$/.test(name || '');

export function matchCandidate(query, title, artist, durationSeconds = 0, expectedDuration = 0) {
  const q = clean(query);
  if (!q || !clean(title) || !clean(artist)) return false;
  const expected = tokens(q);
  const joined = tokens(`${artist} ${title}`);
  if (!expected.every((word) => joined.includes(word))) return false;
  // Never silently promote a cover, live take, or remix for an original query.
  const versions = /\b(remix|cover|live|slowed|sped|nightcore|karaoke|instrumental|bootleg)\b|ремикс|кавер|лайв|минусовка/iu;
  if (versions.test(title) && !versions.test(q)) return false;
  if (expectedDuration > 0 && durationSeconds > 0 && Math.abs(expectedDuration - durationSeconds) > Math.max(20, expectedDuration * .15)) return false;
  return true;
}

export function createMusicIntelligence({
  fetcher = fetch,
  now = Date.now,
  soundcloudApproved = false,
  clientId = '', clientSecret = '',
  appContact = 'https://github.com/',
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  let mbAfter = 0;
  let mbTail = Promise.resolve();
  let token = null;
  let tokenExpires = 0;
  let tokenInflight = null;
  const permission = soundcloudApproved === true && !!clientId && !!clientSecret;
  const limitedFetch = async (url, opts = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await fetcher(url, { ...opts, signal: controller.signal });
      if (!resp.ok) throw new Error(`Upstream HTTP ${resp.status}`);
      if (resp.status === 204) return {};
      return await resp.json();
    } finally { clearTimeout(timeout); opts.signal?.removeEventListener('abort', onAbort); }
  };
  const cached = (key, ttl, work) => {
    const hit = cache.get(key);
    if (hit && hit.until > now()) return Promise.resolve(hit.result);
    if (inflight.has(key)) return inflight.get(key);
    const promise = work().then(result => {
      if (cache.size > 250) cache.delete(cache.keys().next().value);
      cache.set(key, { result, until: now() + ttl });
      return result;
    }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
  // The MusicBrainz one-request/second application budget is enforced across requests.
  async function musicbrainz(path, params) {
    const invoke = async () => {
      const wait = Math.max(0, mbAfter - now());
      mbAfter = Math.max(mbAfter, now()) + 1100;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      const url = new URL(`${MB}/${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      url.searchParams.set('fmt', 'json');
      return limitedFetch(url.href, { headers: { 'User-Agent': `NoteSound-Metadata/2.1 (${appContact})`, Accept: 'application/json' } });
    };
    const task = mbTail.then(invoke, invoke);
    mbTail = task.catch(() => undefined);
    return task;
  }
  async function metadata(query) {
    const q = clean(query, 120);
    if (!q) return [];
    return cached(`mb:${q.toLowerCase()}`, 12 * 3600000, async () => {
      const data = await musicbrainz('recording', { query: q, limit: 10 });
      return (Array.isArray(data.recordings) ? data.recordings : [])
        .filter(item => validMbid(item.id) && clean(item.title) && item['artist-credit']?.length)
        .map(item => ({ mbid: item.id, title: clean(item.title), artist: clean(item['artist-credit'].map(v => v?.name || '').filter(Boolean).join(' ')), duration: Math.max(0, Math.round((Number(item.length) || 0) / 1000)), score: Number(item.score) || 0 }))
        .filter(item => item.artist);
    });
  }
  async function listenBrainzUser(username) {
    if (!validUsername(username)) return [];
    return cached(`lb:${username}`, 6 * 3600000, async () => {
      const data = await limitedFetch(`${LB}/cf/recommendation/user/${encodeURIComponent(username)}/recording?count=15`, { headers: { Accept: 'application/json' } });
      return (data.payload?.mbids || []).filter(v => validMbid(v.recording_mbid)).map(v => ({ mbid: v.recording_mbid, score: Number(v.score) || 0 })).slice(0, 15);
    });
  }
  async function similarByRecording(query) {
    const q = clean(query, 120);
    if (!q) return [];
    return cached(`similar:${q.toLowerCase()}`, 3 * 3600000, async () => {
      const matching = (await metadata(q)).filter(r => sameWords(q, `${r.artist} ${r.title}`));
      const seed = matching.sort((a, b) => b.score - a.score)[0];
      if (!seed) return [];
      const url = new URL('https://labs.api.listenbrainz.org/similar-recordings/json');
      url.searchParams.set('recording_mbids', seed.mbid);
      // The algorithm is published by the experimental ListenBrainz Labs dataset hoster.
      url.searchParams.set('algorithm', 'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000');
      const payload = await limitedFetch(url.href, { headers: { Accept: 'application/json' } });
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.data) ? payload.data : [];
      return rows.filter(v => v && validMbid(v.recording_mbid) && v.recording_mbid !== seed.mbid && clean(v.recording_name) && clean(v.artist_credit_name))
        .slice(0, 10)
        .map(v => ({ mbid: v.recording_mbid, title: clean(v.recording_name), artist: clean(v.artist_credit_name), score: Number(v.score) || 0 }));
    });
  }
  async function soundcloudToken() {
    if (!permission) return null;
    if (token && tokenExpires > now() + 60000) return token;
    if (tokenInflight) return tokenInflight;
    tokenInflight = (async () => {
      const resp = await limitedFetch(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      if (typeof resp.access_token !== 'string' || !resp.access_token) throw new Error('SoundCloud OAuth failed');
      token = resp.access_token;
      tokenExpires = now() + Math.max(120, Math.min(3600, Number(resp.expires_in) || 3600)) * 1000;
      return token;
    })().finally(() => { tokenInflight = null; });
    return tokenInflight;
  }
  async function verifyEmbed(url) {
    const cleanUrl = safeUrl(url);
    if (!cleanUrl) return false;
    try {
      const oembed = new URL(OEMBED);
      oembed.searchParams.set('format', 'json');
      oembed.searchParams.set('url', cleanUrl);
      const result = await limitedFetch(oembed.href, { headers: { Accept: 'application/json' } });
      return result.provider_name === 'SoundCloud' && typeof result.html === 'string' && /<iframe\b[^>]*\bsrc=["']https:\/\/w\.soundcloud\.com\/player\//i.test(result.html);
    } catch { return false; }
  }
  async function soundcloudSearch(query) {
    if (!permission) return { enabled: false, tracks: [], warning: 'SoundCloud API недоступен: для каталога требуется одобренный сценарий использования и серверные ключи.' };
    const q = clean(query, 120);
    if (!q) return { enabled: true, tracks: [] };
    return cached(`sc:${q.toLowerCase()}`, 15 * 60000, async () => {
      const access = await soundcloudToken();
      const url = new URL(`${SC}/tracks`);
      url.searchParams.set('q', q);
      url.searchParams.set('access', 'playable');
      url.searchParams.set('limit', '15');
      const data = await limitedFetch(url.href, { headers: { Authorization: `OAuth ${access}`, Accept: 'application/json' } });
      const values = Array.isArray(data) ? data : Array.isArray(data.collection) ? data.collection : [];
      const candidates = values.filter(v => v && v.access === 'playable' && safeUrl(v.permalink_url) && v.id && v.title && v.user).slice(0, 12);
      const tracks = [];
      for (const item of candidates) {
        // Enforce uploader attribution; neither keyword tags nor search rank prove correct identity.
        const title = clean(item.title, 200), artist = clean(item.metadata_artist || item.user?.username, 160);
        const duration = Math.max(0, Math.round((Number(item.duration) || 0) / 1000));
        if (!matchCandidate(q, title, artist, duration)) continue;
        if (!(await verifyEmbed(item.permalink_url))) continue;
        tracks.push({ id: `soundcloud:${item.id}`, sourceId: 'soundcloud', sourceName: 'SoundCloud', platformId: String(item.id),
          title, artist, duration, artwork: typeof item.artwork_url === 'string' && item.artwork_url.startsWith('https://i1.sndcdn.com/') ? item.artwork_url : undefined,
          externalUrl: safeUrl(item.permalink_url), genres: clean(item.genre) ? [clean(item.genre)] : [],
          playbackMode: 'embedded', availability: 'available', rights: { status: 'unknown', basis: 'none', allowMix: false },
          license: { name: 'SoundCloud · только встроенный плеер', download: false } });
        if (tracks.length >= 6) break;
      }
      return { enabled: true, tracks };
    });
  }
  return { metadata, listenBrainzUser, similarByRecording, soundcloudSearch, verifyEmbed, permissionEnabled: permission };
}
export { safeUrl as validateSoundCloudUrl };
