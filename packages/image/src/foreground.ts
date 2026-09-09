import type { GridCell } from './grid';

/** Operates on a copy; source alpha is multiplied rather than replaced. */
export function removeBackground(rgba: Buffer): Buffer {
  if (rgba.length % 4 !== 0) throw new Error('Expected RGBA pixels.');
  const output = Buffer.from(rgba);
  for (let i = 0; i < output.length; i += 4) {
    const alpha = output[i + 3]!;
    const distance = Math.hypot(
      output[i]! - 244,
      output[i + 1]! - 244,
      output[i + 2]! - 244,
    );
    const factor = Math.max(0, Math.min(1, (distance - 18) / 17));
    output[i + 3] = alpha < 16 ? 0 : Math.round(alpha * factor);
  }
  return output;
}

/** Remove small 8-connected components and bound all surviving parts. Mutates alpha. */
export function cleanForeground(
  rgba: Buffer,
  width: number,
  height: number,
): {
  bounds: GridCell;
  removedComponents: number;
  components: number;
  touchesEdge: boolean;
} {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height !== rgba.length / 4
  ) {
    throw new Error('RGBA dimensions do not match buffer.');
  }
  const pixels = width * height;
  const seen = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  const minimumArea = Math.max(64, pixels * 0.0005);
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  let removedComponents = 0,
    components = 0;
  for (let start = 0; start < pixels; start++) {
    if (seen[start] || rgba[start * 4 + 3] === 0) continue;
    let head = 0,
      tail = 1;
    queue[0] = start;
    seen[start] = 1;
    while (head < tail) {
      const pixel = queue[head++]!;
      const x = pixel % width,
        y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!seen[neighbor] && rgba[neighbor * 4 + 3] !== 0) {
            seen[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
    }
    if (tail < minimumArea) {
      removedComponents++;
      for (let i = 0; i < tail; i++) rgba[queue[i]! * 4 + 3] = 0;
    } else {
      components++;
      for (let i = 0; i < tail; i++) {
        const pixel = queue[i]!,
          x = pixel % width,
          y = Math.floor(pixel / width);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left)
    throw new Error('No foreground remains after background/noise removal.');
  return {
    bounds: { left, top, width: right - left + 1, height: bottom - top + 1 },
    removedComponents,
    components,
    touchesEdge:
      left === 0 || top === 0 || right === width - 1 || bottom === height - 1,
  };
}
