import { z } from 'zod';

export interface GridCell {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Row-major boundaries cover every input pixel, including non-divisible sizes. */
export function gridCells(
  width: number,
  height: number,
  columns = 4,
  rows = 2,
): GridCell[] {
  z.array(z.number().int().positive().max(4096))
    .length(4)
    .parse([width, height, columns, rows]);
  if (columns > width || rows > height)
    throw new Error('Grid cells must contain at least one pixel.');
  return Array.from({ length: rows * columns }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = Math.round((column * width) / columns);
    const top = Math.round((row * height) / rows);
    return {
      left,
      top,
      width: Math.round(((column + 1) * width) / columns) - left,
      height: Math.round(((row + 1) * height) / rows) - top,
    };
  });
}
