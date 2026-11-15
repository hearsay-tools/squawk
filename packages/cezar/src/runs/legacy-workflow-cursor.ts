/**
 * The read-time upgrade of a saved workflow position (ADR 0064). A row saved before the
 * `workflowCursor` fact names its CI or provider-retry step as `workflowResumeStepId`; it is read as
 * a cursor that resumes that step, and the next write of the row stores the cursor instead.
 */
export function upgradeLegacyWorkflowCursor(row: Record<string, unknown>): void {
  if (!('workflowResumeStepId' in row)) return;
  const stepId = row.workflowResumeStepId;
  delete row.workflowResumeStepId;
  if (typeof stepId === 'string' && row.workflowCursor === undefined) row.workflowCursor = { stepId, mode: 'resume' };
}
