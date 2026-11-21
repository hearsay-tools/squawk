/**
 * Query issueOrPullRequest once per number and use __typename for the actual kind. Include
 * branch-work and review timestamps for freshness decisions.
 */
export function refStatusQuery(numbers: number[]): string {
  const aliases = numbers
    .map(
      (n, i) =>
        `    r${i}: issueOrPullRequest(number: ${n}) { __typename ... on PullRequest { url mergedAt state isDraft reviewDecision mergeable commits(last: 1) { nodes { commit { committedDate parents(first: 1) { totalCount nodes { committedDate } } statusCheckRollup { state } } } } reviews(last: 1, states: CHANGES_REQUESTED) { nodes { submittedAt } } reviewRequests(first: 20) { totalCount nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } } timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } } } } } ... on Issue { state stateReason } }`,
    )
    .join('\n');
  return `query ($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\nnameWithOwner\n${aliases}\n  }\n}`;
}
