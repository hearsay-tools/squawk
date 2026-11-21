/** The ACP registry specifies --uid= only for Linux archives. */
export function antigravityLaunchArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'linux' ? ['--uid='] : [];
}
