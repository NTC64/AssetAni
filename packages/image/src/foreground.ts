import type { GridCell } from './grid';

/** Removes the requested matte. With dimensions, only background-like pixels connected to the canvas edge are removed. */
export function removeBackground(
  rgba: Buffer,
  width?: number,
  height?: number,
): Buffer {
  if (rgba.length % 4 !== 0) throw new Error('Expected RGBA pixels.');
  const output = Buffer.from(rgba);
  if (width !== undefined || height !== undefined) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width! < 1 ||
      height! < 1 ||
      width! * height! !== output.length / 4
    ) {
      throw new Error('RGBA dimensions do not match buffer.');
    }
    const w = width!;
    const h = height!;
    const pixels = w * h;
    const candidates = new Uint8Array(pixels);
    const visited = new Uint8Array(pixels);
    const queue = new Int32Array(pixels);
    let head = 0;
    let tail = 0;
    for (let pixel = 0; pixel < pixels; pixel++) {
      const offset = pixel * 4;
      const distance = Math.hypot(
        output[offset]! - 244,
        output[offset + 1]! - 244,
        output[offset + 2]! - 244,
      );
      if (output[offset + 3]! < 16 || distance <= 60) candidates[pixel] = 1;
    }
    const enqueue = (pixel: number) => {
      if (candidates[pixel] && !visited[pixel]) {
        visited[pixel] = 1;
        queue[tail++] = pixel;
      }
    };
    for (let x = 0; x < w; x++) {
      enqueue(x);
      enqueue((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
      enqueue(y * w);
      enqueue(y * w + w - 1);
    }
    while (head < tail) {
      const pixel = queue[head++]!;
      const x = pixel % w;
      const y = Math.floor(pixel / w);
      output[pixel * 4 + 3] = 0;
      if (x > 0) enqueue(pixel - 1);
      if (x + 1 < w) enqueue(pixel + 1);
      if (y > 0) enqueue(pixel - w);
      if (y + 1 < h) enqueue(pixel + w);
    }
    // Models often draw a neutral gray floor shadow despite the prompt. Remove
    // neutral light pixels only in the lower character zone; colored feet and
    // enclosed highlights elsewhere remain intact.
    for (let y = Math.floor(h * 0.7); y < h; y++)
      for (let x = 0; x < w; x++) {
        const offset = (y * w + x) * 4;
        const red = output[offset]!;
        const green = output[offset + 1]!;
        const blue = output[offset + 2]!;
        const saturation =
          Math.max(red, green, blue) - Math.min(red, green, blue);
        if (Math.max(red, green, blue) >= 180 && saturation <= 12)
          output[offset + 3] = 0;
      }
    return output;
  }
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
  boundaryPixels: number;
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
  const retained: Array<{
    pixels: number[];
    touchesEdge: boolean;
    bounds: GridCell;
  }> = [];
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  let removedComponents = 0;
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
      const componentPixels = Array.from(queue.subarray(0, tail));
      let componentLeft = width;
      let componentTop = height;
      let componentRight = -1;
      let componentBottom = -1;
      for (const pixel of componentPixels) {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        componentLeft = Math.min(componentLeft, x);
        componentRight = Math.max(componentRight, x);
        componentTop = Math.min(componentTop, y);
        componentBottom = Math.max(componentBottom, y);
      }
      retained.push({
        pixels: componentPixels,
        touchesEdge: componentPixels.some((pixel) => {
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          return x === 0 || y === 0 || x === width - 1 || y === height - 1;
        }),
        bounds: {
          left: componentLeft,
          top: componentTop,
          width: componentRight - componentLeft + 1,
          height: componentBottom - componentTop + 1,
        },
      });
    }
  }
  const largest = retained.reduce(
    (selected, component) =>
      component.pixels.length > (selected?.pixels.length ?? 0)
        ? component
        : selected,
    undefined as (typeof retained)[number] | undefined,
  );
  const kept = retained.filter((component) => {
    const likelyGroundShadow =
      component !== largest &&
      largest !== undefined &&
      component.bounds.width >= component.bounds.height * 3 &&
      component.bounds.top >=
        largest.bounds.top + Math.floor(largest.bounds.height * 0.7);
    if (
      component !== largest &&
      (component.touchesEdge || likelyGroundShadow)
    ) {
      removedComponents++;
      for (const pixel of component.pixels) rgba[pixel * 4 + 3] = 0;
      return false;
    }
    for (const pixel of component.pixels) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return true;
  });
  const boundaryPixels = kept.reduce(
    (count, component) =>
      count +
      component.pixels.filter((pixel) => {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        return x === 0 || y === 0 || x === width - 1 || y === height - 1;
      }).length,
    0,
  );
  if (right < left)
    throw new Error('No foreground remains after background/noise removal.');
  return {
    bounds: { left, top, width: right - left + 1, height: bottom - top + 1 },
    removedComponents,
    components: kept.length,
    boundaryPixels,
    touchesEdge: boundaryPixels > 12,
  };
}
