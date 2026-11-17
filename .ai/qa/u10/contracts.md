# Cockpit browser contracts

Area u10; campaign hearsay-tools/squawk#3816.

These are browser boundaries, not substitutes for the pure rule tests. Read app.tsx, routes.tsx, the API query/live modules, and the affected route/component before changing a spec.

| Contract | Realistic regression |
| --- | --- |
| Project URLs, sidebar links, search and back navigation preserve the selected project and task. | A remount or redirect loses route/query state or opens another project. |
| Task creation, queued amendments, reply completion, review feedback and finish persist through HTTP and live updates. | An optimistic bubble hides a dropped write; a continuation loses its prompt. |
| Flat views show all source rows; virtualized views bound the DOM and keep content under the reader. | Missing rows shrink the baseline; bad startMargin leaves a gap; a cache restore moves the reading position. |
| Git and GitHub views render real changes, commits, references and actionable states. | API wiring or virtualization drops source entries or routes to the wrong diff. |
| Settings save real state and a cold document reads it back. | Cache-only success disappears on reload; zero is mistaken for an absent value. |
| Skills and workflows expose the runner catalog, preserve step order and serialize the selected flow. | A picker or keyboard sensor changes a different item; save drops steps. |
| Worker, peer, activity, ask and wait surfaces show the right live relationship and lifecycle. | Stale updates keep a resolved obligation open or hide a pending one. |
| Mobile, iOS, touch, themes, density and keyboard access remain usable. | A breakpoint remount loses a draft; controls clip, overlap, lose focus or become too small. |
| Decorative content stays hidden from assistive technology; readable text and focus remain visible. | An icon pollutes the accessible name; text contrast or focus indication disappears. |
| Empty/error/recovery states explain the state and provide a working next action. | A missing route is blank or its return link is broken. |
| Reports, artifacts, markdown and previews show authored content through their real browser boundary. | Sanitization, iframe or download wiring hides content or opens the wrong resource. |

No production change is authorized. Distinct viewport, input, live transport and accessibility boundaries stay covered.
