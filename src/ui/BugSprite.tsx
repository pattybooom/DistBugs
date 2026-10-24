import { memo } from 'react';
import { View } from 'react-native';
import { SPRITE_HEIGHT, SPRITE_WIDTH, spriteKey, spriteRuns } from '../game/sprites';
import { VisualTraits } from '../game/types';

type Props = { visual: VisualTraits; pixel: number };

function BugSpriteView({ visual, pixel }: Props) {
  return (
    <View style={{ width: SPRITE_WIDTH * pixel, height: SPRITE_HEIGHT * pixel }}>
      {spriteRuns(visual).map((run) => (
        <View
          key={`${run.x}-${run.y}`}
          style={{ position: 'absolute', left: run.x * pixel, top: run.y * pixel, width: run.width * pixel, height: pixel, backgroundColor: run.color }}
        />
      ))}
    </View>
  );
}

/** A bug's pixel art, facing up. Its look rarely changes, so it only re-renders when it does. */
export const BugSprite = memo(BugSpriteView, (a, b) => a.pixel === b.pixel && spriteKey(a.visual) === spriteKey(b.visual));
