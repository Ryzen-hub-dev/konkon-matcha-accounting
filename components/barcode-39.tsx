const CODE_39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
  "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn", F: "nnwnwwnnn",
  G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn", K: "wnnnnnnww", L: "nnwnnnnww",
  M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn", P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn",
  S: "nnwnnnwwn", T: "nnnnwnwwn", U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw",
  Y: "wwnnwnnnn", Z: "nwwwwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn",
  "$": "nwnwnwnnn", "/": "nwnwnnnwn", "+": "nwnnnwnwn", "%": "nnnwnwnwn", "*": "nwnnwnwnn",
};

export function Barcode39({ value, height = 54 }: { value: string; height?: number }) {
  const clean = value.toUpperCase().split("").filter((character) => CODE_39[character]).join("");
  const encoded = `*${clean}*`;
  const bars: Array<{ x: number; width: number }> = [];
  let x = 8;
  for (const character of encoded) {
    const pattern = CODE_39[character];
    pattern.split("").forEach((width, index) => {
      const size = width === "w" ? 3 : 1;
      if (index % 2 === 0) bars.push({ x, width: size });
      x += size;
    });
    x += 1;
  }
  return <svg className="barcode-39" viewBox={`0 0 ${x + 8} ${height}`} role="img" aria-label={`Barcode ${clean}`} preserveAspectRatio="none">
    <rect width={x + 8} height={height} fill="#fff" />
    {bars.map((bar, index) => <rect key={index} x={bar.x} y="3" width={bar.width} height={height - 16} fill="#172019" />)}
    <text x={(x + 8) / 2} y={height - 3} textAnchor="middle" fontSize="7" fontFamily="monospace" letterSpacing="1">{clean}</text>
  </svg>;
}
