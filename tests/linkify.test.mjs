// Order 23 — pure URL-segmentation tests for the clickable-links parser (node --test).
// Run with the rest of the suite: node --test tests/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinks } from '../src/lib/linkify.ts';

test('plain text without URLs stays one text segment', () => {
  assert.deepEqual(parseLinks('just words, no links here'), [
    { type: 'text', text: 'just words, no links here' },
  ]);
});

test('https URL mid-sentence becomes a link segment', () => {
  assert.deepEqual(parseLinks('watch https://www.youtube.com/watch?v=abc now'), [
    { type: 'text', text: 'watch ' },
    { type: 'link', text: 'https://www.youtube.com/watch?v=abc', href: 'https://www.youtube.com/watch?v=abc' },
    { type: 'text', text: ' now' },
  ]);
});

test('www.-only URL gains an https:// href but keeps its display text', () => {
  assert.deepEqual(parseLinks('go www.example.com/page'), [
    { type: 'text', text: 'go ' },
    { type: 'link', text: 'www.example.com/page', href: 'https://www.example.com/page' },
  ]);
});

test('trailing sentence punctuation is not part of the link', () => {
  assert.deepEqual(parseLinks('see https://example.com.'), [
    { type: 'text', text: 'see ' },
    { type: 'link', text: 'https://example.com', href: 'https://example.com' },
    { type: 'text', text: '.' },
  ]);
});

test('a balanced closing paren stays outside the link', () => {
  assert.deepEqual(parseLinks('(see https://example.com/x)'), [
    { type: 'text', text: '(see ' },
    { type: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
    { type: 'text', text: ')' },
  ]);
});

test('an unbalanced closing paren inside a Wikipedia-style path stays attached', () => {
  assert.deepEqual(parseLinks('read https://en.wikipedia.org/wiki/Foo_(bar) end'), [
    { type: 'text', text: 'read ' },
    { type: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    { type: 'text', text: ' end' },
  ]);
});

test('multiple links keep sentence order', () => {
  const parts = parseLinks('a https://one.com then www.two.org b');
  assert.equal(parts.length, 5);
  assert.equal(parts[1].href, 'https://one.com');
  assert.equal(parts[3].href, 'https://www.two.org');
});

test('javascript: and data: schemes are never links', () => {
  assert.deepEqual(parseLinks('click javascript:alert(1) or data:text/html,x'), [
    { type: 'text', text: 'click javascript:alert(1) or data:text/html,x' },
  ]);
});

test('bare domains without a scheme or www stay plain text', () => {
  assert.deepEqual(parseLinks('visit example.com today'), [
    { type: 'text', text: 'visit example.com today' },
  ]);
});

test('uppercase scheme matches; the text keeps exactly what was typed', () => {
  const parts = parseLinks('go HTTPS://EXAMPLE.COM/A now');
  assert.equal(parts.length, 3);
  assert.equal(parts[1].type, 'link');
  assert.equal(parts[1].text, 'HTTPS://EXAMPLE.COM/A');
  assert.equal(parts[1].href, 'HTTPS://EXAMPLE.COM/A');
});

test('empty text produces no segments', () => {
  assert.deepEqual(parseLinks(''), []);
});
