export interface StakeLevel {
  id: string;
  smallBlind: number;
  bigBlind: number;
  label: string;
}

/** Уровни блайндов, доступные при создании стола. */
export const STAKES: StakeLevel[] = [
  [10, 20],
  [25, 50],
  [50, 100],
  [100, 200],
  [200, 500],
].map(([sb, bb]) => ({ id: `${sb}-${bb}`, smallBlind: sb, bigBlind: bb, label: `${sb}/${bb}` }));

export function stakeById(id: string): StakeLevel | undefined {
  return STAKES.find((s) => s.id === id);
}

/** Бай-ин по умолчанию: от 40 до 200 больших блайндов. */
export function defaultBuyIn(bigBlind: number) {
  return { minBuyIn: bigBlind * 40, maxBuyIn: bigBlind * 200 };
}
