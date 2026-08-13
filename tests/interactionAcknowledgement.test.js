import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/handlers/interactionHandler.js';
import { eventStore } from '../src/eventStore.js';

test('role selection is acknowledged before reading storage', async (t) => {
  const originalGetEvent = eventStore.getEvent;
  const calls = [];

  eventStore.getEvent = async () => {
    calls.push('database');
    return null;
  };
  t.after(() => {
    eventStore.getEvent = originalGetEvent;
  });

  const interaction = {
    customId: 'event_role_select:message-1',
    isModalSubmit: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    deferUpdate: async () => calls.push('acknowledge'),
    followUp: async () => calls.push('follow-up')
  };

  await handleInteraction(interaction);

  assert.deepEqual(calls, ['acknowledge', 'database', 'follow-up']);
});

test('settings button is acknowledged before reading storage', async (t) => {
  const originalGetEvent = eventStore.getEvent;
  const calls = [];

  eventStore.getEvent = async () => {
    calls.push('database');
    return null;
  };
  t.after(() => {
    eventStore.getEvent = originalGetEvent;
  });

  const interaction = {
    customId: 'event_settings:message-1',
    isModalSubmit: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    deferReply: async () => calls.push('acknowledge'),
    editReply: async () => calls.push('edit-reply')
  };

  await handleInteraction(interaction);

  assert.deepEqual(calls, ['acknowledge', 'database', 'edit-reply']);
});

for (const { name, customId, expectedResponse } of [
  { name: 'leave button', customId: 'event_leave:message-1', expectedResponse: 'follow-up' },
  { name: 'close button', customId: 'control_close:message-1', expectedResponse: 'edit-reply' },
  { name: 'ping button', customId: 'control_ping:message-1', expectedResponse: 'edit-reply' }
]) {
  test(`${name} is acknowledged before reading storage`, async (t) => {
    const originalGetEvent = eventStore.getEvent;
    const calls = [];

    eventStore.getEvent = async () => {
      calls.push('database');
      return null;
    };
    t.after(() => {
      eventStore.getEvent = originalGetEvent;
    });

    const interaction = {
      customId,
      isModalSubmit: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      deferUpdate: async () => calls.push('acknowledge'),
      editReply: async () => calls.push('edit-reply'),
      followUp: async () => calls.push('follow-up')
    };

    await handleInteraction(interaction);

    assert.deepEqual(calls, ['acknowledge', 'database', expectedResponse]);
  });
}

test('edit modal submission is acknowledged before reading storage', async (t) => {
  const originalGetEvent = eventStore.getEvent;
  const calls = [];

  eventStore.getEvent = async () => {
    calls.push('database');
    return null;
  };
  t.after(() => {
    eventStore.getEvent = originalGetEvent;
  });

  const interaction = {
    customId: 'event_edit_modal:message-1',
    isModalSubmit: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    deferReply: async () => calls.push('acknowledge'),
    editReply: async () => calls.push('edit-reply')
  };

  await handleInteraction(interaction);

  assert.deepEqual(calls, ['acknowledge', 'database', 'edit-reply']);
});
