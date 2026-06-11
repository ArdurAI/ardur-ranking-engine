/**
 * CLI — read an AggregationArtifact (stdin or file arg), rank it, write a
 * RankingArtifact to stdout.
 *
 * SCAFFOLD ONLY. Usage (once implemented):
 *   node --experimental-strip-types src/cli.ts < aggregation.json > ranking.json
 */

import { readFileSync } from 'node:fs';
import { runRanking } from './index.ts';
import type { AggregationArtifact } from './contracts.ts';

function readInput(): AggregationArtifact {
  const path = process.argv[2];
  const raw = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8');
  return JSON.parse(raw) as AggregationArtifact;
}

function main(): void {
  const ranking = runRanking(readInput());
  process.stdout.write(JSON.stringify(ranking, null, 2));
}

main();
