// Connect shell (mobile-connect-0.2): the link/loopback helpers the 本地 / 远程 entry point is built on.
//
// The page itself is exercised by a real browser in the browser tests; this file pins the decisions that must not
// drift: which host counts as "本机" (localhost → the connect shell) and which strings are usable game links.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, normalizeLink } from '../mobile/shell/util.js';

test('isLoopbackHost: only the machine itself is 本机', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0']) {
    assert.equal(isLoopbackHost(host), true, `${host} must count as localhost`);
  }
  for (const host of ['192.168.1.5', '10.0.0.7', 'example.com', 'tunnel.example.net', '172.16.4.4', 'localhost.example.com', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} must NOT count as localhost`);
  }
});

test('normalizeLink: accepts what a player pastes', () => {
  assert.equal(normalizeLink('http://192.168.1.5:3000'), 'http://192.168.1.5:3000/');
  assert.equal(normalizeLink('https://game.example.com/?room=ABCD'), 'https://game.example.com/?room=ABCD');
  assert.equal(normalizeLink('192.168.1.5:3000'), 'http://192.168.1.5:3000/');       // scheme optional
  assert.equal(normalizeLink('game.example.com'), 'http://game.example.com/');
  assert.equal(normalizeLink('  "https://a.example.com/x"  '), 'https://a.example.com/x'); // quoting from a chat
  assert.equal(normalizeLink('http://192.168.1.5:3000/#room=ABCD'), 'http://192.168.1.5:3000/#room=ABCD');
});

test('normalizeLink: rejects what is not a link', () => {
  for (const bad of ['', '   ', 'ABCD', 'hello world', 'ftp://example.com', 'javascript:alert(1)', 'http://', '://x', '博士代号']) {
    assert.equal(normalizeLink(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test('normalizeLink: a protocol-relative or unusual but valid host still resolves', () => {
  assert.equal(normalizeLink('http://[::1]:3000'), 'http://[::1]:3000/');
  assert.equal(normalizeLink('sub.domain.example:8443/path?x=1'), 'http://sub.domain.example:8443/path?x=1');
});
