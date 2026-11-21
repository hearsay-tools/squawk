/** Python library warnings in the agy archive are startup noise, not the task failure. */
export function antigravityStderr(stderr: string): string {
  let warning = false;
  return stderr.split(/\r?\n/).filter(line => {
    if (/^.+:\d+: SyntaxWarning:/.test(line)) { warning = true; return false; }
    if (warning && /^\s/.test(line)) return false;
    warning = false;
    return true;
  }).join('\n').trim();
}
