// TODO: This is copied from @myobie/pty/src/tui/fuzzy.ts — should be
// exported from @myobie/pty/tui so we can import it directly.

export interface FuzzyResult {
  match: boolean;
  score: number;
}

export function fuzzyMatch(query: string, target: string): FuzzyResult {
  if (query.length === 0) return { match: true, score: 1 };

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length > t.length) return { match: false, score: 0 };

  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  if (qi < q.length) return { match: false, score: 0 };

  const matchPositions = findBestMatch(q, t);

  let score = 0;

  let consecutive = 0;
  for (let i = 0; i < matchPositions.length; i++) {
    if (i > 0 && matchPositions[i] === matchPositions[i - 1]! + 1) {
      consecutive++;
      score += consecutive * 2;
    } else {
      consecutive = 0;
    }
  }

  for (const pos of matchPositions) {
    if (pos === 0 || isBoundary(t, pos)) {
      score += 3;
    }
  }

  if (matchPositions[0] === 0) {
    score += 5;
  }

  score += Math.max(0, 10 - (t.length - q.length));

  return { match: true, score };
}

function isBoundary(str: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = str[pos - 1];
  return prev === "-" || prev === "_" || prev === "/" || prev === " " || prev === ".";
}

function findBestMatch(query: string, target: string): number[] {
  const boundaryMatch = matchPreferBoundaries(query, target);
  if (boundaryMatch) return boundaryMatch;

  const positions: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      positions.push(ti);
      qi++;
    }
  }
  return positions;
}

function matchPreferBoundaries(query: string, target: string): number[] | null {
  const positions: number[] = [];
  let qi = 0;
  let ti = 0;

  while (qi < query.length && ti < target.length) {
    let foundBoundary = false;
    for (let ahead = ti; ahead < target.length; ahead++) {
      if (target[ahead] === query[qi] && isBoundary(target, ahead)) {
        if (canMatch(query, qi + 1, target, ahead + 1)) {
          positions.push(ahead);
          qi++;
          ti = ahead + 1;
          foundBoundary = true;
          break;
        }
      }
    }
    if (!foundBoundary) {
      while (ti < target.length && target[ti] !== query[qi]) ti++;
      if (ti >= target.length) return null;
      positions.push(ti);
      qi++;
      ti++;
    }
  }

  return qi === query.length ? positions : null;
}

function canMatch(query: string, qi: number, target: string, ti: number): boolean {
  while (qi < query.length && ti < target.length) {
    if (target[ti] === query[qi]) qi++;
    ti++;
  }
  return qi >= query.length;
}
