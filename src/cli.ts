// Entry-point shim — the pipeline orchestrator expects `src/cli.ts` in every engine.
// Delegates to runners.ts, which owns all argument parsing and the main() call.
import './runners.ts';
