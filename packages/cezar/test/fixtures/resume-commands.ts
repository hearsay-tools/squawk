/** The session id and hostile ids of the resume-command tests. Each runner's golden take-over command for `sessionId` is `runners/<id>/__fixtures__/resume-command.txt`. */
export const sessionId = 's1';
export const unsafeSessionIds = [
  '', 'a b', "a'b", 'a`id`', 'a && calc.exe', '$(id)', '-x', '--help', 'a'.repeat(201),
];
