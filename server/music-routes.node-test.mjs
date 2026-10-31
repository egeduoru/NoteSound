import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCatalogHandler, loadConfig } from './index.mjs';

const origin = 'http://127.0.0.1:5173';
const config = loadConfig({});
const service = { status: () => ({ available: true }), search: async () => ({ tracks: [] }) };
const music = {
  metadata: async query => [{ title: query, artist: 'Test', mbid: '526bd613-fddd-4bd6-9137-ab709ac74cab' }],
  similarByRecording: async query => [{ title: query, artist: 'Test', score: 1 }],
  listenBrainzUser: async username => [{ mbid: username, score: 1 }],
  soundcloudSearch: async () => ({ enabled: false, tracks: [], warning: 'Approval required' }),
};

async function withServer(run) {
  const server = createServer(createCatalogHandler(config, service, { music }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('HTTP routes for metadata, similar-recordings and SoundCloud preserve CORS and limit input', async () => {
  await withServer(async base => {
    const args = { headers: { Origin: origin } };
    const mb = await fetch(`${base}/api/music/metadata?q=MACAN`, args);
    assert.equal(mb.status, 200);
    assert.equal(mb.headers.get('access-control-allow-origin'), origin);
    assert.equal((await mb.json()).recordings[0].title, 'MACAN');
    const related = await fetch(`${base}/api/music/similar?q=madk1d`, args);
    assert.equal(related.status, 200);
    assert.equal((await related.json()).recommendations[0].title, 'madk1d');
    const sc = await fetch(`${base}/api/discovery/soundcloud/search?q=MACAN`, args);
    assert.equal(sc.status, 200);
    assert.deepEqual((await sc.json()).tracks, []);
    const invalid = await fetch(`${base}/api/music/metadata?q=${'a'.repeat(170)}`, args);
    assert.equal(invalid.status, 400);
  });
});
