import type {
  AnimationType,
  GamePresetName,
  SpriteDirection,
} from '@sprite/contracts';

export interface GamePreset {
  frameSize: 128 | 256;
  fps: Record<AnimationType, number>;
  animations: AnimationType[];
  directions: SpriteDirection[];
  pivot: { x: number; y: number };
}

const fps = {
  idle: 8,
  walk: 10,
  run: 12,
  attack: 12,
  hurt: 10,
  death: 10,
} satisfies Record<AnimationType, number>;

export const GAME_PRESETS: Record<GamePresetName, GamePreset> = {
  platformer: {
    frameSize: 128,
    fps,
    animations: ['idle', 'walk', 'run', 'attack', 'hurt', 'death'],
    directions: ['right'],
    pivot: { x: 0.5, y: 0 },
  },
  side_scroller: {
    frameSize: 256,
    fps,
    animations: ['idle', 'walk', 'run', 'attack', 'hurt', 'death'],
    directions: ['right'],
    pivot: { x: 0.5, y: 0 },
  },
  top_down_rpg: {
    frameSize: 128,
    fps,
    animations: ['idle', 'walk', 'run', 'attack', 'hurt', 'death'],
    directions: [
      'south',
      'south-west',
      'west',
      'north-west',
      'north',
      'north-east',
      'east',
      'south-east',
    ],
    pivot: { x: 0.5, y: 0 },
  },
};

export function resolveGamePreset(
  name: GamePresetName,
  overrides: {
    animation?: AnimationType;
    frameSize?: 128 | 256;
    fps?: number;
    direction?: SpriteDirection;
  } = {},
) {
  const preset = GAME_PRESETS[name];
  const animation = overrides.animation ?? preset.animations[0]!;
  return {
    ...preset,
    frameSize: overrides.frameSize ?? preset.frameSize,
    direction: overrides.direction ?? preset.directions[0]!,
    fps: overrides.fps ?? preset.fps[animation],
    animation,
  };
}
