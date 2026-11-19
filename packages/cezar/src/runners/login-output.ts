/** CLI-output normalization shared by the runner status parsers (`runners/<id>/login-probe.ts`),
 *  moved verbatim from `core/provider-auth.ts`. Not a per-runner table: no row here is keyed by
 *  runner id. */

const ANSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function normalizedOutput(stdout: string): string {
  return stdout.replace(ANSI_SEQUENCE, '').trim().toLowerCase();
}

function normalizedLines(...outputs: string[]): string[] {
  return outputs.flatMap((output) => normalizedOutput(output).split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

export { normalizedLines };
