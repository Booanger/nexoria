import { test } from 'node:test';
import assert from 'node:assert';
import { eventStore } from '../src/eventStore.js';

// Force the eventStore to use an in-memory database mock for unit testing
console.log('🧪 Mocking eventStore in-memory for concurrency tests...');
const mockDb = new Map();
eventStore.getEvent = async (id) => mockDb.get(id) || null;
eventStore.saveEvent = async (id, data) => {
  // Deep clone to simulate database serialization
  mockDb.set(id, JSON.parse(JSON.stringify(data)));
};
eventStore.deleteEvent = async (id) => mockDb.delete(id);
eventStore.getEventsByLeader = async (leaderId) => Array.from(mockDb.values()).filter(e => e.leaderId === leaderId);

// Setup mock config for event database tests
const mockEventId = 'test_concurrency_event_123';
const getMockEventData = () => ({
  id: mockEventId,
  title: 'CONCURRENCY TEST EVENT',
  description: 'Testing multiple simultaneous registrations',
  leaderId: '11111111',
  leaderUsername: 'TestLeader',
  slots: [
    { id: 'slot_1', name: 'Tank', category: 'Tanks', userId: null, username: null },
    { id: 'slot_2', name: 'Healer', category: 'Healers', userId: null, username: null },
    { id: 'slot_3', name: 'DPS 1', category: 'DPS', userId: null, username: null },
    { id: 'slot_4', name: 'DPS 2', category: 'DPS', userId: null, username: null },
    { id: 'slot_5', name: 'Support', category: 'Support', userId: null, username: null }
  ],
  createdAt: Date.now()
});

/**
 * Mocks the role selection logic to check concurrency behavior.
 * @param {string} userId 
 * @param {string} username 
 * @param {string} slotId 
 */
async function simulateJoinRole(userId, username, slotId) {
  // 1. Fetch current state
  const event = await eventStore.getEvent(mockEventId);
  if (!event) {
    return { success: false, reason: 'Event not found' };
  }

  // 2. Find selected slot
  const slot = event.slots.find(s => s.id === slotId);
  if (!slot) {
    return { success: false, reason: 'Slot not found' };
  }

  // Check if already taken
  if (slot.userId !== null) {
    return { success: false, reason: 'Already occupied', currentOwner: slot.username };
  }

  // Remove the user from any other slot they might be occupying in this event (single role limit)
  for (const s of event.slots) {
    if (s.userId === userId) {
      s.userId = null;
      s.username = null;
    }
  }

  // 3. Occupy slot
  slot.userId = userId;
  slot.username = username;

  // 4. Save back to database
  await eventStore.saveEvent(mockEventId, event);
  return { success: true };
}

test('Simulated Concurrency Stres Testleri', async (t) => {

  await t.test('Senaryo 1: Farklı kullanıcıların AYNI slota aynı anda katılım denemesi', async () => {
    // Reset event to initial empty state
    await eventStore.saveEvent(mockEventId, getMockEventData());

    console.log('\n🚀 Senaryo 1: 5 Kullanıcı aynı anda "slot_1" (Tank) slotuna katılmaya çalışıyor...');

    const simulatedUsers = [
      { id: 'user_1', name: 'Ahmet' },
      { id: 'user_2', name: 'Mehmet' },
      { id: 'user_3', name: 'Süleyman' },
      { id: 'user_4', name: 'Yusuf' },
      { id: 'user_5', name: 'Ömer' }
    ];

    // Fire 5 asynchronous calls at the exact same millisecond
    const results = await Promise.all(
      simulatedUsers.map(user => simulateJoinRole(user.id, user.name, 'slot_1'))
    );

    console.log('📊 İstek Sonuçları:');
    results.forEach((res, index) => {
      console.log(`- Kullanıcı ${simulatedUsers[index].name}: ${res.success ? '✅ BAŞARILI (Slot Kapıldı)' : `❌ REDDEDİLDİ (${res.reason})`}`);
    });

    const successfulOps = results.filter(r => r.success).length;
    console.log(`ℹ️ Toplam başarılı işlem sayısı: ${successfulOps}`);

    const finalEvent = await eventStore.getEvent(mockEventId);
    const finalSlot = finalEvent.slots.find(s => s.id === 'slot_1');

    console.log(`👑 Slotun nihai sahibi: ${finalSlot.username || 'Boş'}`);
    
    assert.ok(finalEvent !== null, 'Etkinlik veritabanında kaybolmamalı.');
    assert.strictEqual(successfulOps, 1, 'Aynı slota sadece 1 kişi yerleşebilmeli.');
    assert.ok(finalSlot.userId !== null, 'Slot boş kalmamalı.');
  });

  await t.test('Senaryo 2: Farklı kullanıcıların FARKLI slotlara aynı anda katılım denemesi', async () => {
    // Reset event to initial empty state
    await eventStore.saveEvent(mockEventId, getMockEventData());

    console.log('\n🚀 Senaryo 2: 5 Kullanıcı aynı anda FARKLI slotlara katılmaya çalışıyor...');

    const simulatedUsers = [
      { id: 'user_1', name: 'Ahmet', targetSlot: 'slot_1' },
      { id: 'user_2', name: 'Mehmet', targetSlot: 'slot_2' },
      { id: 'user_3', name: 'Süleyman', targetSlot: 'slot_3' },
      { id: 'user_4', name: 'Yusuf', targetSlot: 'slot_4' },
      { id: 'user_5', name: 'Ömer', targetSlot: 'slot_5' }
    ];

    // Fire 5 asynchronous calls at the exact same millisecond to different target slots
    const results = await Promise.all(
      simulatedUsers.map(user => simulateJoinRole(user.id, user.name, user.targetSlot))
    );

    console.log('📊 İstek Sonuçları:');
    results.forEach((res, index) => {
      console.log(`- Kullanıcı ${simulatedUsers[index].name} -> ${simulatedUsers[index].targetSlot}: ${res.success ? '✅ BAŞARILI' : `❌ REDDEDİLDİ (${res.reason})`}`);
    });

    const successfulOps = results.filter(r => r.success).length;
    console.log(`ℹ️ Toplam başarılı işlem sayısı: ${successfulOps}`);

    const finalEvent = await eventStore.getEvent(mockEventId);
    
    // Assert all 5 users were successfully assigned to their respective slots
    simulatedUsers.forEach(user => {
      const slot = finalEvent.slots.find(s => s.id === user.targetSlot);
      assert.strictEqual(slot.userId, user.id, `${user.name} kendi hedeflediği slota yerleşmiş olmalı.`);
    });
    
    assert.strictEqual(successfulOps, 5, 'Tüm kullanıcılar kendi slotlarına başarıyla yerleşebilmeli.');
  });

  // Clean up mock event
  await eventStore.deleteEvent(mockEventId);
});
