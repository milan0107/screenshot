import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE, makeMessage } from '../src/shared/protocol.js';

test('makeMessage creates a task-scoped envelope', () => {
  assert.deepEqual(makeMessage(MESSAGE.SCROLL_TO, 'task-1', { top: 120 }), {
    source: 'longshot', type: 'SCROLL_TO', taskId: 'task-1', payload: { top: 120 }
  });
});

test('makeMessage rejects an unknown type', () => {
  assert.throws(() => makeMessage('UNKNOWN', 'task-1'), /Unknown message type/);
});
