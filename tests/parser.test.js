import test from 'node:test';
import assert from 'node:assert';
import { parseTemplate, groupSlotsByCategory, reconstructTemplate } from '../src/parser.js';

test('Simple template format', () => {
  const input = `
    Tank
    Healer
    DPS
    DPS
  `;
  const slots = parseTemplate(input);

  assert.strictEqual(slots.length, 4);
  assert.strictEqual(slots[0].name, 'Tank');
  assert.strictEqual(slots[0].build, '');
  assert.strictEqual(slots[0].category, null);
  assert.strictEqual(slots[1].name, 'Healer');
  assert.strictEqual(slots[2].name, 'DPS');
  assert.strictEqual(slots[3].name, 'DPS');
});

test('Advanced template format with category and builds', () => {
  const input = `
    #Tanks
    Mace > Astral aegis - Cleric cowl - Armor of valor
    Heavy Mace > Hellion hood - Guardian armor
    #Healers
    Hallowfall > Mistcaller - Soldier helmet
  `;
  const slots = parseTemplate(input);

  assert.strictEqual(slots.length, 3);
  
  assert.strictEqual(slots[0].category, 'Tanks');
  assert.strictEqual(slots[0].name, 'Mace');
  assert.strictEqual(slots[0].build, 'Astral aegis - Cleric cowl - Armor of valor');

  assert.strictEqual(slots[1].category, 'Tanks');
  assert.strictEqual(slots[1].name, 'Heavy Mace');
  assert.strictEqual(slots[1].build, 'Hellion hood - Guardian armor');

  assert.strictEqual(slots[2].category, 'Healers');
  assert.strictEqual(slots[2].name, 'Hallowfall');
  assert.strictEqual(slots[2].build, 'Mistcaller - Soldier helmet');
});

test('Empty input handles correctly', () => {
  assert.deepStrictEqual(parseTemplate(''), []);
  assert.deepStrictEqual(parseTemplate(null), []);
});

test('Grouping helper groups by category and falls back to Genel', () => {
  const slots = [
    { name: 'Mace', category: 'Tanks' },
    { name: 'Healer', category: 'Healers' },
    { name: 'DPS', category: null }
  ];

  const grouped = groupSlotsByCategory(slots);
  assert.strictEqual(grouped['Tanks'].length, 1);
  assert.strictEqual(grouped['Tanks'][0].name, 'Mace');
  assert.strictEqual(grouped['Healers'].length, 1);
  assert.strictEqual(grouped['Genel'].length, 1);
  assert.strictEqual(grouped['Genel'][0].name, 'DPS');
});

test('Template reconstruction formats slots correctly', () => {
  const slots = [
    { name: 'Mace', build: 'Astral aegis', category: 'Tanks' },
    { name: 'Hallowfall', build: '', category: 'Healers' }
  ];
  const reconstructed = reconstructTemplate(slots);
  assert.strictEqual(reconstructed, '#Tanks\nMace > Astral aegis\n#Healers\nHallowfall');
});

