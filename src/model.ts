/**
 * Logistic regression written out by hand, so every reason shown on screen is
 * a weight times a value that anyone can check.
 */
export interface Model {
  mean: number[];
  scale: number[];
  weights: number[];
  bias: number;
}

export interface FitOptions {
  iterations: number;
  learningRate: number;
  l2: number;
}

const DEFAULTS: FitOptions = { iterations: 3000, learningRate: 0.1, l2: 0.01 };

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export function fitLogistic(X: number[][], y: boolean[], options: Partial<FitOptions> = {}): Model {
  const { iterations, learningRate, l2 } = { ...DEFAULTS, ...options };
  const n = X.length;
  const width = X[0]?.length ?? 0;

  // Standardise so one large-valued feature cannot dominate the gradient.
  const mean = Array.from({ length: width }, (_, j) => X.reduce((s, row) => s + (row[j] ?? 0), 0) / n);
  const scale = Array.from({ length: width }, (_, j) => {
    const variance = X.reduce((s, row) => s + ((row[j] ?? 0) - (mean[j] ?? 0)) ** 2, 0) / n;
    return Math.sqrt(variance) || 1;
  });
  const Z = X.map((row) => row.map((v, j) => (v - (mean[j] ?? 0)) / (scale[j] ?? 1)));

  const weights = new Array<number>(width).fill(0);
  let bias = 0;
  for (let step = 0; step < iterations; step++) {
    const gradW = new Array<number>(width).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const row = Z[i] ?? [];
      let z = bias;
      for (let j = 0; j < width; j++) z += (weights[j] ?? 0) * (row[j] ?? 0);
      const error = sigmoid(z) - (y[i] ? 1 : 0);
      gradB += error;
      for (let j = 0; j < width; j++) gradW[j] = (gradW[j] ?? 0) + error * (row[j] ?? 0);
    }
    for (let j = 0; j < width; j++) {
      weights[j] = (weights[j] ?? 0) - learningRate * ((gradW[j] ?? 0) / n + l2 * (weights[j] ?? 0));
    }
    bias -= learningRate * (gradB / n);
  }
  return { mean, scale, weights, bias };
}

/** Probability of leaving, 0 to 1. */
export function predict(model: Model, x: number[]): number {
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j++) {
    z += (model.weights[j] ?? 0) * (((x[j] ?? 0) - (model.mean[j] ?? 0)) / (model.scale[j] ?? 1));
  }
  return sigmoid(z);
}

/** Chance a random leaver is scored above a random stayer. 0.5 is a coin flip, 1 is perfect. */
export function auc(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (pos.length === 0 || neg.length === 0) return NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
