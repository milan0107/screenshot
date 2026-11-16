import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

async function readManifest() {
  return JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
}

test('exposes every module dynamically imported by the content script', async () => {
  const manifest = await readManifest();
  const resources = manifest.web_accessible_resources.flatMap(entry => entry.resources);

  assert.ok(resources.includes('src/content/capture-message-handler.js'));
});
