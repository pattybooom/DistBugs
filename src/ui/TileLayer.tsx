import { memo, useMemo } from 'react';
import { Image, ImageSourcePropType, View } from 'react-native';
import { Arena, Biome, Habitat } from '../game/types';
import { ART, ART_UNIT, hexSlotOrigin, layoutTiles, objectSlotOrigin } from './tileLayout';

/** Drawn by tools/tiles/generate_tiles.py. */
const ATLASES: Record<Biome, ImageSourcePropType> = {
  meadow: require('../../assets/tiles/meadow.png'),
  swamp: require('../../assets/tiles/swamp.png'),
  desert: require('../../assets/tiles/desert.png'),
  tidepool: require('../../assets/tiles/tidepool.png'),
};

/** Each biome's main ground colour, shown through any hairline between tiles. */
export const BIOME_GROUND: Record<Biome, string> = {
  meadow: '#5c9a3e',
  swamp: '#4c5a2e',
  desert: '#d9b36a',
  tidepool: '#bfae86',
};

type Props = { arena: Arena; habitat: Habitat; seed: number; scale: number };

/** One atlas slot, shown through a window the slot's size. */
function Slot({ atlas, origin, size, left, top, pixel }: {
  atlas: ImageSourcePropType;
  origin: { x: number; y: number };
  size: { width: number; height: number };
  left: number;
  top: number;
  pixel: number;
}) {
  return (
    <View style={{ position: 'absolute', left, top, width: size.width * pixel, height: size.height * pixel, overflow: 'hidden' }}>
      <Image
        source={atlas}
        fadeDuration={0}
        style={{ position: 'absolute', left: -origin.x * pixel, top: -origin.y * pixel, width: ART.atlas.width * pixel, height: ART.atlas.height * pixel }}
      />
    </View>
  );
}

function TileLayerView({ arena, habitat, seed, scale }: Props) {
  const layout = useMemo(() => layoutTiles(arena, habitat, seed), [arena, habitat, seed]);
  const atlas = ATLASES[arena.biome];
  // Screen points per art pixel.
  const pixel = ART_UNIT * scale;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
      {layout.hexes.map((hex) => (
        <Slot key={hex.key} atlas={atlas} origin={hexSlotOrigin(hex.slot)} size={ART.hex} left={hex.x * scale} top={hex.y * scale} pixel={pixel} />
      ))}
      {layout.objects.map((object) => (
        <Slot key={`o${object.key}`} atlas={atlas} origin={objectSlotOrigin(object.slot)} size={ART.object} left={object.x * scale} top={object.y * scale} pixel={pixel} />
      ))}
    </View>
  );
}

/** The arena's hex tilemap. It only changes with the arena or the screen size, so it skips the simulation's redraws. */
export const TileLayer = memo(TileLayerView);
