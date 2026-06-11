/**
 * CLI — read an AggregationArtifact (stdin or file arg), rank it, write a
 * RankingArtifact to stdout.
 *
 * Usage:
 *   node --experimental-strip-types src/cli.ts < aggregation.json > ranking.json
 *   node --experimental-strip-types src/cli.ts aggregation.json > ranking.json
 */
import { readFileSync } from 'node:fs';
import { runRanking } from "./index.js";
import { validateAggregationArtifact } from "./validate.js";
function fail(msg) {
    process.stderr.write(`ardur-ranking-engine: ${msg}\n`);
    process.exit(1);
}
function readInput() {
    const path = process.argv[2];
    const raw = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        return fail(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        return validateAggregationArtifact(parsed);
    }
    catch (err) {
        return fail(`invalid input: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function main() {
    const artifact = readInput();
    const ranking = runRanking(artifact);
    process.stdout.write(JSON.stringify(ranking, null, 2));
}
main();
