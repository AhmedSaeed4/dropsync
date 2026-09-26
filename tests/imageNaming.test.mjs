// Order 37 — AI image naming source-shape tests (node --test).
// Pins the paste-rename wiring across both layouts + the naming route + the shared
// lib, the way archiveSafety.test.mjs pins archive invariants. No network, no
// Firebase: these read the real source files and assert their shape.
// Run: node --test tests/imageNaming.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const editorial = read('../src/components/editorial/EditorialDropZone.tsx');
const classic = read('../src/components/DropZone.tsx');
const route = read('../src/app/api/image-name/route.ts');
const lib = read('../src/lib/imageNaming.ts');

test('junk timestamp names are gone from both layouts', () => {
  assert.equal(editorial.includes('pasted-image-${Date.now()}'), false);
  assert.equal(classic.includes('pasted-image-${Date.now()}'), false);
});

test('both layouts default the AI toggle OFF', () => {
  assert.ok(editorial.includes('const [aiNaming, setAiNaming] = useState(false);'));
  assert.ok(classic.includes('const [aiNaming, setAiNaming] = useState(false);'));
});

test('both layouts name pastes through the shared helper with the clean fallback', () => {
  for (const src of [editorial, classic]) {
    assert.ok(src.includes('await aiNameForImage('));
    assert.ok(src.includes('renamePastedFile('));
    assert.ok(src.includes("base ?? 'Pasted image'"));
  }
});

test('editorial shows the recognizing state before upload', () => {
  assert.ok(editorial.includes("currentName: 'Recognizing image…'"));
});

test('the lib never throws and answers null on failure', () => {
  assert.ok(lib.includes('export async function aiNameForImage'));
  assert.ok(lib.includes('export function renamePastedFile'));
  assert.ok(lib.includes('return null;'));
  assert.ok(lib.includes('/api/image-name'));
});

test('the route requires a Firebase ID token', () => {
  assert.ok(route.includes('verifyIdToken'));
  assert.ok(route.includes("startsWith('Bearer ')"));
});

test('the route forwards to Groq vision chat completions', () => {
  assert.ok(route.includes('https://api.groq.com/openai/v1/chat/completions'));
  assert.ok(route.includes("const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';"));
});

test('the route caps per-user usage like the voice route', () => {
  assert.ok(route.includes('imageNamingUsage'));
  assert.ok(route.includes('const IMAGE_DAILY_LIMIT = 20;'));
});

test('the route sanitizes the model answer and never returns an empty name', () => {
  assert.ok(route.includes('slice(0, 60)'));
  assert.ok(route.includes("'Pasted image'"));
});

test('both toggles explain their state via the shared Tooltip', () => {
  assert.ok(editorial.includes('On — pasted images get AI names'));
  assert.ok(classic.includes('On — pasted images get AI names'));
});
