import { assembleSprite, PALETTES, shiftHue, SPRITE_HEIGHT, SPRITE_WIDTH, spriteColors, spriteRuns } from '../src/game/sprites';
import { BODY_SHAPES, EYE_STYLES, FEATURES, HORN_STYLES, VisualTraits } from '../src/game/types';

const every = (): VisualTraits[] =>
  BODY_SHAPES.flatMap((body) => EYE_STYLES.flatMap((eyes) => HORN_STYLES.flatMap((horns) => FEATURES.map((feature) => ({
    body, eyes, horns, feature, palette: 0, hueShift: 0,
  })))));

describe('sprites', () => {
  test('every combination assembles to a full-size grid', () => {
    for (const visual of every()) {
      const grid = assembleSprite(visual);
      expect(grid).toHaveLength(SPRITE_HEIGHT);
      grid.forEach((row) => expect(row).toHaveLength(SPRITE_WIDTH));
    }
  });

  test('runs cover exactly the painted pixels', () => {
    for (const visual of every()) {
      const painted = assembleSprite(visual).flat().filter(Boolean).length;
      const covered = spriteRuns(visual).reduce((sum, run) => sum + run.width, 0);
      expect(covered).toBe(painted);
    }
  });

  test('features change how a bug looks', () => {
    const base: VisualTraits = { body: 'round', eyes: 'dot', horns: 'none', feature: 'none', palette: 0, hueShift: 0 };
    const plain = JSON.stringify(assembleSprite(base));
    for (const feature of FEATURES.slice(1)) expect(JSON.stringify(assembleSprite({ ...base, feature }))).not.toBe(plain);
  });

  test('hue shift recolours the body but keeps the accent', () => {
    const base: VisualTraits = { body: 'round', eyes: 'dot', horns: 'none', feature: 'spots', palette: 1, hueShift: 0 };
    const shifted = spriteColors({ ...base, hueShift: 20 });
    expect(shifted.B).not.toBe(PALETTES[1].body);
    expect(shifted.A).toBe(PALETTES[1].accent);
  });

  test('shifting hue a full turn returns the same colour', () => {
    for (const palette of PALETTES) {
      expect(shiftHue(palette.body, 0)).toBe(palette.body);
      expect(shiftHue(palette.body, 360)).toBe(palette.body);
    }
  });
});
