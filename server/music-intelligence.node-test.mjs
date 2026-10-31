import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMusicIntelligence, matchCandidate, validateSoundCloudUrl } from './music-intelligence.mjs';

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const soundcloudItem = { id: 123, access: 'playable', permalink_url: 'https://soundcloud.com/u/mac-example', title: 'ASPHALT 8', metadata_artist: 'MACAN', duration: 185000, user: { username: 'Uploader' } };

test('rejects false version matches and unsafe source links', () => {
  assert.equal(matchCandidate('MACAN ASPHALT 8', 'ASPHALT 8 (cover)', 'MACAN'), false);
  assert.equal(matchCandidate('MACAN ASPHALT 8', 'ASPHALT 8', 'MACAN'), true);
  assert.equal(matchCandidate('MACAN ASPHALT 8', 'ASPHALT 8', 'Другой исполнитель'), false);
  assert.equal(validateSoundCloudUrl('https://soundcloud.com/u/single'), 'https://soundcloud.com/u/single');
  assert.equal(validateSoundCloudUrl('https://soundcloud.com.evil.test/u/single'), null);
  assert.equal(validateSoundCloudUrl('http://soundcloud.com/u/single'), null);
});

test('SoundCloud search disabled by default without approval, no upstream requests', async () => {
  let requests = 0;
  const svc = createMusicIntelligence({ fetcher: async () => { requests++; throw new Error('unreachable'); } });
  const result = await svc.soundcloudSearch('MACAN');
  assert.deepEqual(result.tracks, []);
  assert.equal(result.enabled, false);
  assert.equal(requests, 0);
});

test('authorized SoundCloud search verifies official oEmbed before returning music', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/oauth/token')) return ok({ access_token: 'TEST_ONLY', expires_in: 3600 });
    if (url.includes('/tracks?')) return ok({ collection: [soundcloudItem, { ...soundcloudItem, id: 456, title: 'ASPHALT 8 - cover', permalink_url: 'https://soundcloud.com/u/cover' }] });
    if (url.includes('/oembed?')) return ok({ provider_name: 'SoundCloud', html: '<iframe src="https://w.soundcloud.com/player/?url=abc"></iframe>' });
    throw new Error('Unexpected request');
  };
  const svc = createMusicIntelligence({ fetcher, soundcloudApproved: true, clientId: 'id', clientSecret: 'secret' });
  const result = await svc.soundcloudSearch('MACAN ASPHALT 8');
  assert.equal(result.enabled, true);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].playbackMode, 'embedded');
  assert.equal(result.tracks[0].rights.allowMix, false);
  assert.equal(result.tracks[0].license.download, false);
  assert.ok(requests.find(x => x.url.includes('/tracks?')).options.headers.Authorization.startsWith('OAuth '));
  assert.equal(requests.filter(x => x.url.includes('/oauth/token')).length, 1);
  await svc.soundcloudSearch('MACAN ASPHALT 8');
  assert.equal(requests.filter(x => x.url.includes('/tracks?')).length, 1, 'cache prevents duplicate search');
});

test('MusicBrainz returns verified identities only (not fabricated playable streams)', async () => {
  const urls = [];
  const svc = createMusicIntelligence({ appContact: 'https://example.com/contact', fetcher: async (url, opts) => {
    urls.push({ url, opts });
    return ok({ recordings: [{ id: '526bd613-fddd-4bd6-9137-ab709ac74cab', title: 'ASPHALT 8', 'artist-credit': [{ name: 'MACAN' }], length: 199000, score: 98 }, { id: 'invalid', title: 'Fake', 'artist-credit': [{ name: 'none' }] }] });
  } });
  const tracks = await svc.metadata('MACAN ASPHALT 8');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].duration, 199);
  assert.equal('streamUrl' in tracks[0], false);
  assert.ok(urls[0].opts.headers['User-Agent'].includes('NoteSound-Metadata'));
});

test('ListenBrainz recommendation IDs are not treated as playable links', async () => {
  const svc = createMusicIntelligence({ fetcher: async () => ok({ payload: { mbids: [{ recording_mbid: '526bd613-fddd-4bd6-9137-ab709ac74cab', score: 8.5 }, { recording_mbid: 'not-an-id' }] } }) });
  const result = await svc.listenBrainzUser('public_user');
  assert.deepEqual(result, [{ mbid: '526bd613-fddd-4bd6-9137-ab709ac74cab', score: 8.5 }]);
  assert.deepEqual(await svc.listenBrainzUser('/private'), []);
});

test('ListenBrainz Labs similar-recordings returns only mapped real identities', async () => {
  const calls = [];
  const seed = '526bd613-fddd-4bd6-9137-ab709ac74cab';
  const other = '71342f27-cc1f-433b-baa4-fd53f883ff23';
  const svc = createMusicIntelligence({ fetcher: async (url) => {
    calls.push(url);
    if (url.includes('musicbrainz.org')) return ok({ recordings: [
      { id: seed, title: 'ASPHALT 8', 'artist-credit': [{ name: 'MACAN' }], score: 99 },
    ] });
    if (url.includes('similar-recordings/json')) return ok([{ recording_mbid: other,
      recording_name: 'Другой трек', artist_credit_name: 'Новый исполнитель', score: 3.5 },
      { recording_mbid: seed, recording_name: 'ASPHALT 8', artist_credit_name: 'MACAN' }]);
    throw new Error('Unexpected upstream service');
  }});
  const result = await svc.similarByRecording('MACAN ASPHALT 8');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { mbid: other, title: 'Другой трек', artist: 'Новый исполнитель', score: 3.5 });
  assert.ok(calls.some(v => v.includes('similar-recordings/json')));
  assert.equal('audioUrl' in result[0], false);
});
