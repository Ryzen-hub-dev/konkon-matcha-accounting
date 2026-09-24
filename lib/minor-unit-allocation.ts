export function allocateMinorUnits(total: number, weights: number[], message = "Amounts exceed the safe accounting range.") {
  if (!Number.isSafeInteger(total) || total < 0 || !weights.length || weights.some(weight => !Number.isSafeInteger(weight) || weight < 0)) throw new Error(message);
  const weightTotal = weights.reduce((sum, weight) => sum + BigInt(weight), BigInt(0));
  if (!weightTotal) {
    if (total) throw new Error(message);
    return weights.map(() => 0);
  }
  const parts = weights.map((weight, index) => ({
    index,
    value: Number(BigInt(total) * BigInt(weight) / weightTotal),
    remainder: BigInt(total) * BigInt(weight) % weightTotal,
  }));
  const remaining = total - parts.reduce((sum, part) => sum + part.value, 0);
  const priority = [...parts].sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < remaining; index++) priority[index].value++;
  return parts.map(part => part.value);
}

export function sliceMinorUnits(total: number, quantity: number, alreadyUsed: number, requested: number, message = "Amounts cannot be reconciled.") {
  if (![total, quantity, alreadyUsed, requested].every(Number.isSafeInteger) || total < 0 || quantity < 1 || alreadyUsed < 0 || requested < 1 || alreadyUsed + requested > quantity) throw new Error(message);
  const cumulative = (count: number) => Math.floor(total / quantity) * count + Math.min(total % quantity, count);
  return cumulative(alreadyUsed + requested) - cumulative(alreadyUsed);
}
