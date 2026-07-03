/**
 * Tool entrypoint — uniform agent-ready CLI for ardur-ranking-engine.
 *
 * Usage:
 *   node --experimental-strip-types src/runners.ts --describe
 *   node --experimental-strip-types src/runners.ts \
 *       [--in <path|->] [--out <path|->] \
 *       [--provider <name>] [--now <iso8601>] [--run-id <id>]
 *
 * Flags:
 *   --in <path|->        Input file path or - for stdin (default: -)
 *   --out <path|->       Output file path or - for stdout (default: -)
 *   --provider <name>    Provider hint (ranking is always deterministic; any value accepted)
 *   --now <iso8601>      Reference clock — drives generatedAt and runId (default: wall clock)
 *   --run-id <id>        Override run ID for idempotent replay
 *   --describe           Emit input/output JSON-Schema derived from @ardurai/contracts and exit
 *
 * Error model:
 *   All failures write { error: { code, message, stage, detail } } to stdout and exit non-zero.
 *   stderr carries human-readable diagnostic context.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { runRanking } from './index.ts';
import { validateAggregationArtifact } from './validate.ts';
import { SCHEMA_VERSION, CONTRACT_REVISION, assertCompatibleArtifact } from './contracts.ts';
import { parseRankingArtifact } from '@ardurai/contracts/zod';
import type { AggregationArtifact } from './contracts.ts';

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

type ErrorCode =
  | 'INPUT_PARSE'
  | 'INPUT_INVALID'
  | 'IO_READ'
  | 'IO_WRITE'
  | 'RANKING_FAILED'
  | 'OUTPUT_VALIDATION_FAILED'
  | 'INVALID_FLAG'
  | 'MISSING_FLAG_VALUE';

interface CliError {
  error: {
    code: ErrorCode;
    message: string;
    stage: 'ranking';
    detail?: string;
  };
}

function emitError(code: ErrorCode, message: string, detail?: string): never {
  const envelope: CliError = {
    error: {
      code,
      message,
      stage: 'ranking',
      ...(detail !== undefined && { detail }),
    },
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
  process.stderr.write(`ardur-ranking-engine: ${message}${detail !== undefined ? ` — ${detail}` : ''}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliFlags {
  in: string;
  out: string;
  provider: string;
  now: string | null;
  runId: string | null;
  describe: boolean;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    in: '-',
    out: '-',
    provider: 'deterministic',
    now: null,
    runId: null,
    describe: false,
  };

  const args = argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--describe':
        flags.describe = true;
        break;
      case '--in':
        if (i + 1 >= args.length || args[i + 1]!.startsWith('--'))
          emitError('MISSING_FLAG_VALUE', '--in requires a value');
        flags.in = args[++i]!;
        break;
      case '--out':
        if (i + 1 >= args.length || args[i + 1]!.startsWith('--'))
          emitError('MISSING_FLAG_VALUE', '--out requires a value');
        flags.out = args[++i]!;
        break;
      case '--provider':
        if (i + 1 >= args.length || args[i + 1]!.startsWith('--'))
          emitError('MISSING_FLAG_VALUE', '--provider requires a value');
        flags.provider = args[++i]!;
        break;
      case '--now':
        if (i + 1 >= args.length || args[i + 1]!.startsWith('--'))
          emitError('MISSING_FLAG_VALUE', '--now requires a value');
        flags.now = args[++i]!;
        break;
      case '--run-id':
        if (i + 1 >= args.length || args[i + 1]!.startsWith('--'))
          emitError('MISSING_FLAG_VALUE', '--run-id requires a value');
        flags.runId = args[++i]!;
        break;
      default:
        if (arg !== undefined && arg.startsWith('--')) {
          emitError('INVALID_FLAG', `unknown flag: ${arg}`);
        }
        // Tolerate positional arg as --in for backward compat with old callers.
        if (arg !== undefined) {
          flags.in = arg;
        }
    }
    i++;
  }

  return flags;
}

// ---------------------------------------------------------------------------
// --describe: JSON-Schema derived from @ardurai/contracts
// ---------------------------------------------------------------------------

const CYCLE_SCHEMA = {
  type: 'object',
  required: ['id', 'windowStart', 'windowEnd'],
  properties: {
    id: { type: 'string' },
    windowStart: { type: 'string', format: 'date-time' },
    windowEnd: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

const TOPIC_META_SCHEMA = {
  type: 'object',
  required: ['id', 'label', 'description'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'AggregationArtifact',
  description: 'Output of ardur-news-aggregator; input to ardur-ranking-engine',
  type: 'object',
  required: [
    'schemaVersion',
    'artifact',
    'runId',
    'upstreamRunId',
    'generatedAt',
    'cycle',
    'topics',
    'warnings',
    'data',
  ],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    contractRevision: { type: 'number' },
    artifact: { const: 'aggregation' },
    runId: { type: 'string' },
    upstreamRunId: { type: ['string', 'null'] },
    generatedAt: { type: 'string', format: 'date-time' },
    cycle: CYCLE_SCHEMA,
    topics: { type: 'array', items: TOPIC_META_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
    data: {
      type: 'object',
      required: ['itemsByTopic', 'clustersByTopic', 'coverageByTopic'],
      properties: {
        itemsByTopic: { type: 'object', additionalProperties: { type: 'array' } },
        clustersByTopic: { type: 'object', additionalProperties: { type: 'array' } },
        coverageByTopic: { type: 'object' },
        documentsByTopic: { type: 'object', additionalProperties: { type: 'array' } },
        factsByCluster: { type: 'object', additionalProperties: { type: 'array' } },
      },
    },
  },
} as const;

const OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'RankingArtifact',
  description: 'Output of ardur-ranking-engine; input to ardur-top10-engine',
  type: 'object',
  required: [
    'schemaVersion',
    'contractRevision',
    'artifact',
    'runId',
    'upstreamRunId',
    'generatedAt',
    'cycle',
    'topics',
    'warnings',
    'data',
  ],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    contractRevision: { const: CONTRACT_REVISION },
    artifact: { const: 'ranking' },
    runId: { type: 'string' },
    upstreamRunId: { type: ['string', 'null'] },
    generatedAt: { type: 'string', format: 'date-time' },
    cycle: CYCLE_SCHEMA,
    topics: { type: 'array', items: TOPIC_META_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
    data: {
      type: 'object',
      required: ['rankedByTopic', 'audit', 'weightProfile'],
      properties: {
        rankedByTopic: { type: 'object', additionalProperties: { type: 'array' } },
        audit: { type: 'array' },
        weightProfile: { type: 'string' },
        factsByCluster: { type: 'object', additionalProperties: { type: 'array' } },
        documentsByTopic: { type: 'object', additionalProperties: { type: 'array' } },
      },
    },
  },
} as const;

const DESCRIPTOR = {
  name: '@ardurai/ranking-engine',
  stage: 'ranking',
  contract: {
    schemaVersion: SCHEMA_VERSION,
    contractRevision: CONTRACT_REVISION,
  },
  input: INPUT_SCHEMA,
  output: OUTPUT_SCHEMA,
  flags: [
    {
      name: '--in',
      type: 'string',
      required: false,
      default: '-',
      description: 'Input file path or - for stdin',
    },
    {
      name: '--out',
      type: 'string',
      required: false,
      default: '-',
      description: 'Output file path or - for stdout',
    },
    {
      name: '--provider',
      type: 'string',
      required: false,
      default: 'deterministic',
      description: 'Provider hint; ranking is always deterministic regardless of value',
    },
    {
      name: '--now',
      type: 'string',
      required: false,
      format: 'date-time',
      description: 'ISO 8601 reference clock — drives generatedAt and the default runId',
    },
    {
      name: '--run-id',
      type: 'string',
      required: false,
      description: 'Override run ID for idempotent replay',
    },
    {
      name: '--describe',
      type: 'boolean',
      required: false,
      description: "Emit this engine's input/output JSON-Schema derived from @ardurai/contracts and exit",
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function readInput(path: string): AggregationArtifact {
  let raw: string;
  try {
    raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch (err) {
    return emitError(
      'IO_READ',
      `cannot read input: ${path}`,
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return emitError(
      'INPUT_PARSE',
      'input is not valid JSON',
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    return validateAggregationArtifact(parsed);
  } catch (err) {
    return emitError(
      'INPUT_INVALID',
      'input failed contract validation',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function writeOutput(path: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  try {
    if (path === '-') {
      process.stdout.write(json);
    } else {
      writeFileSync(path, json, 'utf8');
    }
  } catch (err) {
    emitError(
      'IO_WRITE',
      `cannot write output: ${path}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const flags = parseArgs(process.argv);

  if (flags.describe) {
    process.stdout.write(JSON.stringify(DESCRIPTOR, null, 2) + '\n');
    return;
  }

  let now: Date | undefined;
  if (flags.now !== null) {
    now = new Date(flags.now);
    if (isNaN(now.valueOf())) {
      emitError('INVALID_FLAG', `--now value is not a valid ISO 8601 timestamp: ${flags.now}`);
    }
  }

  if (flags.provider !== 'deterministic') {
    process.stderr.write(
      `ardur-ranking-engine: warning: --provider ${flags.provider} ignored; ranking is always deterministic\n`,
    );
  }

  const aggregation = readInput(flags.in);

  let ranking: ReturnType<typeof runRanking>;
  try {
    const opts = {
      ...(now !== undefined && { now }),
      ...(flags.runId !== null && { runId: flags.runId }),
    };
    ranking = runRanking(aggregation, opts);
  } catch (err) {
    emitError(
      'RANKING_FAILED',
      'unexpected error during ranking',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Pre-emit self-validation: Zod-validate the ranking artifact before writing
  // so a schema regression in the engine fails here (with detail) instead of
  // at the downstream top10 engine's input gate (with a truncated error).
  try {
    assertCompatibleArtifact(ranking, 'ranking');
    parseRankingArtifact(ranking as unknown);
  } catch (validateErr) {
    emitError(
      'OUTPUT_VALIDATION_FAILED',
      'ranking artifact failed pre-emit Zod validation',
      validateErr instanceof Error ? validateErr.message : String(validateErr),
    );
  }

  writeOutput(flags.out, ranking);
}

main();
