import sharp from 'sharp';
import type { SpritePromptInput } from './prompt';

type Animation = SpritePromptInput['animation'];
type Point = readonly [x: number, y: number];
type Pose = {
  bodyOffset?: number;
  leftHand: Point;
  rightHand: Point;
  leftFoot: Point;
  rightFoot: Point;
  weaponEnd?: Point;
};

const idle: Pose[] = [0, -2, -4, -2, 0, 2, 4, 2].map((bodyOffset, i) => ({
  bodyOffset,
  leftHand: [-28 - (i % 2) * 2, 124],
  rightHand: [30 + (i % 2) * 2, 122],
  leftFoot: [-18, 218],
  rightFoot: [18, 218],
}));

const walk: Pose[] = [
  {
    leftHand: [28, 128],
    rightHand: [-30, 126],
    leftFoot: [-38, 218],
    rightFoot: [30, 202],
  },
  {
    leftHand: [20, 132],
    rightHand: [-22, 120],
    leftFoot: [-24, 220],
    rightFoot: [22, 211],
  },
  {
    leftHand: [8, 126],
    rightHand: [-10, 126],
    leftFoot: [-6, 220],
    rightFoot: [10, 216],
  },
  {
    leftHand: [-18, 120],
    rightHand: [22, 132],
    leftFoot: [22, 210],
    rightFoot: [-16, 220],
  },
  {
    leftHand: [-30, 126],
    rightHand: [28, 128],
    leftFoot: [38, 218],
    rightFoot: [-30, 202],
  },
  {
    leftHand: [-22, 120],
    rightHand: [20, 132],
    leftFoot: [24, 220],
    rightFoot: [-22, 211],
  },
  {
    leftHand: [-10, 126],
    rightHand: [8, 126],
    leftFoot: [6, 220],
    rightFoot: [-10, 216],
  },
  {
    leftHand: [22, 132],
    rightHand: [-18, 120],
    leftFoot: [-22, 210],
    rightFoot: [16, 220],
  },
] satisfies Pose[];

const attack: Pose[] = [
  {
    leftHand: [-30, 126],
    rightHand: [28, 118],
    leftFoot: [-20, 218],
    rightFoot: [20, 218],
    weaponEnd: [72, 86],
  },
  {
    leftHand: [-32, 124],
    rightHand: [6, 88],
    leftFoot: [-24, 218],
    rightFoot: [18, 218],
    weaponEnd: [-12, 42],
  },
  {
    leftHand: [-30, 122],
    rightHand: [-18, 78],
    leftFoot: [-28, 218],
    rightFoot: [18, 216],
    weaponEnd: [-54, 42],
  },
  {
    leftHand: [-26, 126],
    rightHand: [30, 92],
    leftFoot: [-30, 218],
    rightFoot: [24, 214],
    weaponEnd: [78, 70],
  },
  {
    leftHand: [-18, 132],
    rightHand: [52, 116],
    leftFoot: [-34, 218],
    rightFoot: [30, 210],
    weaponEnd: [100, 116],
  },
  {
    leftHand: [-14, 136],
    rightHand: [48, 138],
    leftFoot: [-30, 218],
    rightFoot: [28, 212],
    weaponEnd: [92, 166],
  },
  {
    leftHand: [-24, 130],
    rightHand: [36, 132],
    leftFoot: [-24, 218],
    rightFoot: [24, 216],
    weaponEnd: [74, 158],
  },
  {
    leftHand: [-30, 126],
    rightHand: [28, 118],
    leftFoot: [-20, 218],
    rightFoot: [20, 218],
    weaponEnd: [72, 86],
  },
] satisfies Pose[];

const run = walk.map((pose) => ({ ...pose }));
const hurt = attack
  .slice()
  .reverse()
  .map((pose) => ({ ...pose }));
const death = attack.map((pose, index) => ({
  ...pose,
  bodyOffset: (pose.bodyOffset ?? 0) + index * 12,
}));
const poses: Record<Animation, Pose[]> = {
  idle,
  walk,
  run,
  attack,
  hurt,
  death,
};

const openPoseLimbs = [
  [1, 2],
  [2, 3],
  [3, 4],
  [1, 5],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17],
] as const;
const openPoseColors = [
  '#ff0000',
  '#ff5500',
  '#ffaa00',
  '#ffff00',
  '#aaff00',
  '#55ff00',
  '#00ff00',
  '#00ff55',
  '#00ffaa',
  '#00ffff',
  '#00aaff',
  '#0055ff',
  '#0000ff',
  '#5500ff',
  '#aa00ff',
  '#ff00ff',
  '#ff00aa',
] as const;

function midpoint(a: Point, b: Point, bend = 0): Point {
  return [(a[0] + b[0]) / 2 + bend, (a[1] + b[1]) / 2];
}

/** A ready-to-use 512px OpenPose control map for one animation frame. */
export async function createOpenPoseGuide(
  animation: Animation,
  frameIndex: number,
) {
  const pose = poses[animation][frameIndex];
  if (!pose) throw new Error('OpenPose guide frame index must be 0–7.');
  const offset = pose.bodyOffset ?? 0;
  const nose: Point = [0, 48 + offset];
  const neck: Point = [0, 82 + offset];
  const rightShoulder: Point = [16, 86 + offset];
  const leftShoulder: Point = [-16, 86 + offset];
  const rightHip: Point = [12, 148];
  const leftHip: Point = [-12, 148];
  const points: Point[] = [
    nose,
    neck,
    rightShoulder,
    midpoint(rightShoulder, pose.rightHand, 5),
    pose.rightHand,
    leftShoulder,
    midpoint(leftShoulder, pose.leftHand, -5),
    pose.leftHand,
    rightHip,
    midpoint(rightHip, pose.rightFoot, 5),
    pose.rightFoot,
    leftHip,
    midpoint(leftHip, pose.leftFoot, -5),
    pose.leftFoot,
    [8, 44 + offset],
    [-8, 44 + offset],
    [16, 48 + offset],
    [-16, 48 + offset],
  ];
  const project = ([x, y]: Point): Point => [(128 + x) * 2, y * 2];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="#000000"/>
    ${openPoseLimbs
      .map(([from, to], index) => {
        const a = project(points[from]!);
        const b = project(points[to]!);
        return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${openPoseColors[index]}" stroke-width="10" stroke-linecap="round"/>`;
      })
      .join('')}
    ${points
      .map((point, index) => {
        const [x, y] = project(point);
        return `<circle cx="${x}" cy="${y}" r="6" fill="${openPoseColors[index % openPoseColors.length]}"/>`;
      })
      .join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function line(a: Point, b: Point, cellX: number, cellY: number, width = 12) {
  return `<line x1="${cellX + 128 + a[0]}" y1="${cellY + a[1]}" x2="${cellX + 128 + b[0]}" y2="${cellY + b[1]}" stroke="#596273" stroke-width="${width}" stroke-linecap="round"/>`;
}

export async function createPoseGuide(animation: Animation) {
  const figures = poses[animation]
    .map((pose, index) => {
      const cellX = (index % 4) * 256;
      const cellY = Math.floor(index / 4) * 256;
      const offset = pose.bodyOffset ?? 0;
      const shoulder: Point = [0, 82 + offset];
      const hip: Point = [0, 148];
      return `<g>
        <circle cx="${cellX + 128}" cy="${cellY + 48 + offset}" r="20" fill="#7c8799"/>
        ${line(shoulder, hip, cellX, cellY, 24)}
        ${line(shoulder, pose.leftHand, cellX, cellY)}
        ${line(shoulder, pose.rightHand, cellX, cellY)}
        ${line(hip, pose.leftFoot, cellX, cellY, 14)}
        ${line(hip, pose.rightFoot, cellX, cellY, 14)}
        ${pose.weaponEnd ? line(pose.rightHand, pose.weaponEnd, cellX, cellY, 7) : ''}
      </g>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512" viewBox="0 0 1024 512">
    <rect width="1024" height="512" fill="#F4F4F4"/>
    ${figures}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
