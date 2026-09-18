export type SearchableUser = { _id: string; fullName: string; username: string; email?: string; role?: string };

function normalise(value: string) { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function fuzzyScore(haystack: string, needle: string) {
  if (!needle) return 1;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return 10_000 - exact * 10 - haystack.length;
  let at = 0, gap = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found < 0) return -1;
    gap += found - at; at = found + 1;
  }
  return 1_000 - gap - haystack.length;
}

export function searchUsers<T extends SearchableUser>(users: readonly T[], query: string) {
  const needle = normalise(query);
  if (!needle) return [...users];
  return users.map(user => {
    const values = [user.fullName, user.username, user.email || "", user.role || ""].map(normalise);
    return { user, score: Math.max(...values.map(value => fuzzyScore(value, needle)), fuzzyScore(values.join(" "), needle)) };
  }).filter(result => result.score >= 0).sort((a, b) => b.score - a.score || a.user.fullName.localeCompare(b.user.fullName)).map(result => result.user);
}
