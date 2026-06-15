---
description: Coordinate read and write agents working on a project using pi-extended-teams task lists, messaging, in-process readers, and tmux write-agent panes.
---

# pi-extended-teams

Coordinate multiple agents working on a project using shared task lists and messaging. Read agents run in-process without tmux panes. Write agents use tmux panes.

The lead should infer the team workflow from ordinary user requests. The user should not need to say "use read agents", "do not call check_teammate", "open /team", or "read the inbox". If the user asks to test, review, inspect, validate, smoke-test, or get opinions on current changes, default to read-only in-process agents unless implementation is explicitly requested.

## Default lead behavior

- For investigation, review, validation, smoke tests, docs checks, quality checks, and "show me agents working", create or reuse a team and spawn read agents by default.
- Give each read agent only the mission, relevant scope, and desired report shape. Do not paste implementation details the extension/skill should already know.
- After spawning read agents, use `/team` for interactive inspection and `list_teammates` only when tool-data output is useful.
- Do not use raw sleeps, shell waits, or ad hoc `LoopCreate` polling to wait for reports. The extension owns idle lead monitoring: it watches the lead inbox, updates the UI, and wakes the lead when reports are ready.
- Do not use `check_teammate` as a polling/status habit. It is only for explicit liveness diagnosis or a suspected stall.
- When the extension wakes the lead or the user asks for results, collect reports with `read_inbox(team_name, agent_name="team-lead", unread_only=true)` and summarize findings.
- For implementation requests, use write agents only when edits are needed. Respect the write-agent cap and queue.
- At the end of a smoke test or temporary team session, shut down the team when the user asks to stop or when the test is complete.

## Workflow

1.  **Create a team**: Use `team_create(team_name="my-team")`.
2.  **Spawn teammates**: Use `spawn_teammate` to start agents. Use `role: "read"` for in-process investigation and `role: "write"` for tmux implementation. The write-agent cap queues overflow; inspect it with `list_write_queue`.
3.  **Manage tasks**: 
    *   `task_create`: Define work for the team.
    *   `task_list`: List all tasks to monitor progress or find available work.
    *   `task_read`: Get full details of a specific task by ID.
    *   `task_update`: Update a task's status (`pending`, `in_progress`, `completed`, `deleted`) or owner.
4.  **Communicate**: Use `send_message` to give instructions or receive updates. Teammates should use `read_inbox` to check for messages.
5.  **Coordinate writes**: Write agents must call `claim_file` before editing and `release_file` after editing. Claims are advisory protocol state, not filesystem sandbox enforcement.
6.  **Share durable team facts**: Use `write_shared_memory` for decisions and handoff notes, `read_shared_memory` to load them, and `use_skill(name)` to load a relevant skill into context.
7.  **Peek when needed**: Use `/team` to open the teammate overview. Use `check_teammate` only when the user explicitly asks for health/liveness details or a teammate appears stalled.
8.  **Cleanup**:
    *   `process_shutdown_approved`: Orderly removal of a teammate after they've finished.
    *   `team_shutdown`: Shut down the team, close write-agent panes, and remove team/task state.

## Teammate Instructions

When you are spawned as a teammate:
- Your status bar will show "Teammate: name @ team".
- You will automatically start by calling `read_inbox` to get your initial instructions.
- Regularly check `read_inbox` for updates from the lead.
- Use `send_message` to "team-lead" to report progress or ask questions.
- Update your assigned tasks using `task_update`.
- If you are idle for more than 30 seconds, you will automatically check your inbox for new messages.

## Best Practices for Teammates

- **Update Task Status**: As you work, use `task_update` to set your tasks to `in_progress` and then `completed`.
- **Frequent Communication**: Send short summaries of your work back to `team-lead` frequently.
- **Context Matters**: When you finish a task, send a message explaining your results and any new files you created.
- **Independence**: If you get stuck, try to solve it yourself first, but don't hesitate to ask `team-lead` for clarification.
- **Orderly Shutdown**: When you've finished all your work and have no more instructions, notify the lead and wait for shutdown approval.

## Best Practices for Team Leads

- **Clear Assignments**: Use `task_create` for all significant work items.
- **Contextual Prompts**: Provide enough task context for the teammate to work independently, but do not over-specify pi-extended-teams mechanics that this skill already defines. A good prompt says what useful work to do, not how the extension should operate.
- **Team Overview**: Use `/team` for a compact teammate overview, and `list_teammates` when you need the roster as tool data. Use `task_list` when you need task details.
- **Direct Feedback**: Use `send_message` to provide course corrections or new instructions to teammates.
- **Targeted Health Checks**: Do not spam `check_teammate`; it is a diagnostic tool for explicit health/liveness checks, not a normal polling loop.

## Natural request examples

If the user says "test this with agents", "run a smoke test", or "show me agents working", the lead should do roughly this without requiring extra wording:

1. Create a short-lived team for the current project.
2. Spawn 2-3 read agents with concise, useful missions such as UI review, lifecycle review, docs review, test-gap review, or release-risk review.
3. Tell the user to open `/team` only if they asked to see the team UI or would benefit from interactive inspection.
4. Do independent lead work only if it exists; otherwise stop the turn and let the extension wake the lead when reports arrive.
5. When woken, summarize the reports and ask before spawning write agents or making changes.
