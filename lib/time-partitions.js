export function isWithinTimePartition(timestamp, start, end, { includeEnd = false } = {}) {
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const from = typeof start === "number" ? start : Date.parse(start);
  const to = typeof end === "number" ? end : Date.parse(end);
  if (![value, from, to].every(Number.isFinite) || to < from) return false;
  return value >= from && (includeEnd ? value <= to : value < to);
}

export function partitionTimeSeries(items, partitions, timestampOf) {
  if (!Array.isArray(items) || !Array.isArray(partitions) || typeof timestampOf !== "function") {
    throw new TypeError("items, partitions and timestampOf are required.");
  }
  return Object.fromEntries(partitions.map((partition, index) => {
    const includeEnd = index === partitions.length - 1;
    return [partition.key, items.filter(item =>
      isWithinTimePartition(timestampOf(item), partition.startAt, partition.endAt, { includeEnd })
    )];
  }));
}
