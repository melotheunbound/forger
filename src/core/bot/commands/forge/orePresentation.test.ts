import { expect, test } from 'bun:test';
import { oreTraitText, oreInformationText } from './orePresentation';

test('Bismuth uses grouped traits and chest odds instead of None and guaranteed drops', () => {
  const ore = {
    chance: '1/1',
    multiplier: '8',
    price: null,
    unique_price_multiplier: '10',
    neutral_multiplier: true,
    display: {
      weapon_traits: ['+18% attack speed'],
      armor_traits: ['Heal 2.5% maximum health on Black Hole'],
      chance_text: 'Tier I: 2%; Tier II: 6%; Tier III: 10%; Tier IV: 15%',
      multiplier_note: 'Neutral: follows ordinary ores in mixed recipes.',
    },
  };
  expect(oreTraitText(ore)).toContain('Weapon Traits');
  expect(oreTraitText(ore)).toContain('Armor Traits');
  expect(oreTraitText(ore)).not.toContain('None');
  expect(oreInformationText(ore)).toContain('Chest bonus chance');
  expect(oreInformationText(ore)).not.toContain('1/1');
  expect(oreInformationText(ore)).toContain('Neutral');
  expect(oreInformationText(ore)).toContain('Not available');
});

test('ordinary ore details retain their chance and legacy traits', () => {
  expect(oreInformationText({ chance: '1/3', multiplier: '0.3', price: '$4.50' })).toContain('Chance: **1/3**');
  expect(oreTraitText({ trait: { description: 'A known bonus', type: 'Weapon' } })).toContain('A known bonus');
});
