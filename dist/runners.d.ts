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
export {};
