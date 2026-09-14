export function seededRandom(seed: string, step: number, salt = ""): number {
  let hash = 2166136261;
  for (const character of `${seed}:${step}:${salt}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash << 13;
  hash ^= hash >>> 17;
  hash ^= hash << 5;
  return (hash >>> 0) / 4294967295;
}

export function deterministicId(prefix: string, seed: string, step: number, salt = ""): string {
  const number = Math.floor(seededRandom(seed, step, salt) * 0xffffffffff).toString(36).padStart(8, "0");
  return `${prefix}-${step.toString(36)}-${number}`;
}
