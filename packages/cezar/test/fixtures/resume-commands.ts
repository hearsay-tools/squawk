/** The session id and hostile ids of the resume-command tests. Each runner's golden take-over command for `sessionId` is the `resumeCommand` of `runners/<id>/__fixtures__/golden.json`. */
export const sessionId = 's1';
export const unsafeSessionIds = [
  '', 'a b', "a'b", 'a`id`', 'a && calc.exe', '$(id)', '-x', '--help', 'a'.repeat(201),
];
