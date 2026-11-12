import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../shared.js';

const S = globalThis.ReclipShared;

test('player frames: big http iframes, no banners or ad hosts', () => {
  assert.ok(S.isPlayerFrame({ src: 'https://video.playerrecord.cfd/e/y6x41rf4woaj', width: 640, height: 360 }));
  assert.ok(!S.isPlayerFrame({ src: 'javascript:window.location.replace(x)', width: 640, height: 360 }));
  assert.ok(!S.isPlayerFrame({ src: 'https://ads.example/banner', width: 300, height: 250 }));
  assert.ok(!S.isPlayerFrame({ src: 'https://player.example/e/1', width: 120, height: 600 }));
  assert.ok(!S.isPlayerFrame({ src: 'https://tpc.googlesyndication.com/x', width: 640, height: 360 }));
  assert.ok(!S.isPlayerFrame({ src: undefined, width: 640, height: 360 }));
});

test('requests: playlists and whole files, never segments', () => {
  assert.equal(S.classifyRequest('https://o3.cdn.cc/file/1/tok/uuid/master.m3u8', 'xmlhttprequest'), 'hls');
  assert.equal(S.classifyRequest('https://cdn.example/v/manifest.mpd?x=1', 'xmlhttprequest'), 'dash');
  assert.equal(S.classifyRequest('https://cdn.example/clip.mp4?token=a', 'media'), 'file');
  assert.equal(S.classifyRequest('https://cdn.example/clip.mp4', 'image'), null);
  assert.equal(S.classifyRequest('https://cdn.example/seg-12.ts', 'xmlhttprequest'), null);
  assert.equal(S.classifyRequest('https://cdn.example/chunk.m4s', 'media'), null);
  assert.equal(S.classifyRequest('blob:https://x/1', 'media'), null);
  assert.equal(S.classifyRequest('https://lh3.googleusercontent.com/d/abc=d', 'xmlhttprequest'), null);
});

test('headers: only Referer, Origin and User-Agent', () => {
  const h = S.pickHeaders([
    { name: 'Referer', value: 'https://video.playerrecord.cfd/' },
    { name: 'origin', value: 'https://video.playerrecord.cfd' },
    { name: 'User-Agent', value: 'Mozilla/5.0' },
    { name: 'Cookie', value: 'session=secret' },
  ]);
  assert.deepEqual(h, {
    Referer: 'https://video.playerrecord.cfd/', Origin: 'https://video.playerrecord.cfd', 'User-Agent': 'Mozilla/5.0',
  });
  assert.deepEqual(S.pickHeaders(undefined), {});
});

test('candidates: players, videos, page, then streams (playlists first)', () => {
  const scan = {
    url: 'https://site.example/post',
    players: ['https://video.playerrecord.cfd/e/y6x41rf4woaj'],
    videos: ['https://cdn.example/direct.mp4', 'https://video.playerrecord.cfd/e/y6x41rf4woaj'],
  };
  const streams = [
    { url: 'https://cdn.example/clip.mp4', kind: 'file', seen: 1 },
    { url: 'https://cdn.example/video/video.m3u8', kind: 'hls', seen: 3, headers: { Referer: 'https://p/' } },
    { url: 'https://cdn.example/master.m3u8', kind: 'hls', seen: 2, headers: { Referer: 'https://p/' } },
  ];
  const c = S.buildCandidates(scan, streams);
  assert.deepEqual(c.map(x => [x.kind, x.url]), [
    ['player', 'https://video.playerrecord.cfd/e/y6x41rf4woaj'],
    ['video', 'https://cdn.example/direct.mp4'],
    ['page', 'https://site.example/post'],
    ['stream', 'https://cdn.example/master.m3u8'],
    ['stream', 'https://cdn.example/video/video.m3u8'],
    ['stream', 'https://cdn.example/clip.mp4'],
  ]);
  assert.deepEqual(c[3].headers, { Referer: 'https://p/' });
  assert.deepEqual(S.buildCandidates(null, []), []);
});

test('badge count', () => {
  assert.equal(S.videoCount({ players: ['a'], videos: ['b'] }, []), 2);
  assert.equal(S.videoCount({ players: [], videos: [] }, [{}, {}]), 1);
  assert.equal(S.videoCount(null, []), 0);
});

test('file names', () => {
  assert.equal(S.safeFilename('a/b: c?.mp4', 'x.mp4'), 'a b c .mp4');
  assert.equal(S.safeFilename('', 'x.mp4'), 'x.mp4');
  assert.equal(S.safeFilename('...hidden.mp4', 'x.mp4'), 'hidden.mp4');
});
