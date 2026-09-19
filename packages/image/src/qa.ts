import sharp from 'sharp';

export type AnimationQaStatus = 'PASS' | 'WARN' | 'FAIL';

export interface AnimationQaResult {
  status: AnimationQaStatus;
  failures: string[];
  warnings: string[];
  metrics: {
    foregroundRatios: number[];
    baselines: number[];
    boundingBoxes: Array<{
      left: number;
      top: number;
      width: number;
      height: number;
    }>;
    adjacentDifferences: number[];
  };
}

/** Deterministic, provider-independent checks applied to normalized animation frames. */
export async function runAnimationQa(
  frames: Buffer[],
  expectedSize: 128 | 256,
  expectedCount = 8,
): Promise<AnimationQaResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (frames.length !== expectedCount)
    failures.push(
      `FRAME_COUNT: expected ${expectedCount}, received ${frames.length}`,
    );

  const decoded = await Promise.all(
    frames.map(async (frame, index) => {
      const image = sharp(frame).ensureAlpha();
      const metadata = await image.metadata();
      if (metadata.width !== expectedSize || metadata.height !== expectedSize)
        failures.push(
          `DIMENSIONS: frame ${index} is ${metadata.width ?? 0}x${metadata.height ?? 0}; expected ${expectedSize}x${expectedSize}`,
        );
      const { data, info } = await image
        .raw()
        .toBuffer({ resolveWithObject: true });
      let left = info.width;
      let right = -1;
      let top = info.height;
      let bottom = -1;
      let visible = 0;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * 4 + 3]! < 16) continue;
          visible++;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      const ratio = visible / (info.width * info.height);
      if (visible === 0)
        failures.push(`EMPTY_FRAME: frame ${index} has no foreground`);
      if (ratio < 0.01 || ratio > 0.95)
        failures.push(
          `ALPHA: frame ${index} foreground ratio ${(ratio * 100).toFixed(1)}% is invalid`,
        );
      return {
        ratio,
        baseline: bottom,
        box: {
          left: visible ? left : 0,
          top: visible ? top : 0,
          width: visible ? right - left + 1 : 0,
          height: visible ? bottom - top + 1 : 0,
        },
        fingerprint: await sharp(data, {
          raw: { width: info.width, height: info.height, channels: 4 },
        })
          .resize(32, 32, { kernel: sharp.kernel.nearest })
          .grayscale()
          .raw()
          .toBuffer(),
      };
    }),
  );

  const nonEmpty = decoded.filter(({ box }) => box.height > 0);
  if (nonEmpty.length > 1) {
    const median = (values: number[]) => {
      const sorted = values.slice().sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const heights = nonEmpty.map(({ box }) => box.height);
    const medianHeight = median(heights);
    nonEmpty.forEach(({ box }, index) => {
      const drift = Math.abs(box.height - medianHeight) / medianHeight;
      if (drift > 0.15)
        warnings.push(
          `BOUNDING_BOX_DRIFT: frame ${index} differs ${(drift * 100).toFixed(1)}% from median height`,
        );
    });
    const baselines = nonEmpty.map(({ baseline }) => baseline);
    const medianBaseline = median(baselines);
    nonEmpty.forEach(({ baseline }, index) => {
      const drift = Math.abs(baseline - medianBaseline);
      if (drift > 8)
        warnings.push(
          `BASELINE_DRIFT: frame ${index} differs ${drift}px from median`,
        );
    });
  }

  const adjacentDifferences = decoded.slice(1).map((frame, index) => {
    const previous = decoded[index]!.fingerprint;
    let total = 0;
    for (let offset = 0; offset < frame.fingerprint.length; offset++)
      total += Math.abs(frame.fingerprint[offset]! - previous[offset]!);
    return total / frame.fingerprint.length / 255;
  });
  adjacentDifferences.forEach((difference, index) => {
    if (difference < 0.01)
      warnings.push(
        `DUPLICATE_FRAME: frames ${index} and ${index + 1} differ by ${(difference * 100).toFixed(2)}%`,
      );
  });

  return {
    status: failures.length ? 'FAIL' : warnings.length ? 'WARN' : 'PASS',
    failures,
    warnings,
    metrics: {
      foregroundRatios: decoded.map(({ ratio }) => ratio),
      baselines: decoded.map(({ baseline }) => baseline),
      boundingBoxes: decoded.map(({ box }) => box),
      adjacentDifferences,
    },
  };
}
