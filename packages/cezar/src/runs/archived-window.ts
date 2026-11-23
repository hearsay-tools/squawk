/** How many archived root runs the run lists carry per project (#864): `GET /run-summaries?archived=recent`
 *  and `GET /workspace/runs-index`. Unarchived runs are never cut; older archived runs page in
 *  through `GET /run-summaries/archived` and the workspace search. */
export const ARCHIVED_WINDOW = 200;
