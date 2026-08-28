# Goal: Interrupt a stuck teammate command without killing the teammate

## Goal

Let the lead recover a spawned agent that is blocked in a long-running tool command by interrupting that command without killing the teammate. Expose the behavior through a lead-only tool and a dedicated shortcut in the selected-agent live view while keeping the agent session, roster membership, task context, and file claims intact.

## Specs

- Add a lead-only public tool named `interrupt_teammate` for interrupting one named active teammate's current tool command.
- Support both in-process read agents and tmux-backed write agents through their native cancellation mechanisms: `AgentSession.abort()` for a signal-aware in-process tool run and Pi's native Escape interrupt for a tmux-backed writer.
- Require current-tool proof (`activeToolName`/working state) instead of interrupting an idle agent or a model turn that is not running a tool.
- Keep interruption separate from `stop_teammate`: interruption must not remove the teammate, close its recipient, tear down its session, release its claims, or mark its task complete.
- After interruption, leave the teammate able to receive a follow-up message or continue its loop.
- Add a dedicated `i` shortcut for the selected teammate in the live agent view; preserve `x` for stopping the entire teammate and Escape for leaving the view.
- Return truthful, distinct outcomes when an in-process command was interrupted, an interrupt was delivered to a tmux writer, no current command exists, the teammate does not exist, cancellation remains pending, or interruption is unsupported/failed.
- Bound the lead-facing call. Pi cancellation is cooperative for custom tools, so a signal-ignoring tool must produce an explicit pending outcome instead of hanging the lead or claiming it stopped.
- Keep authorization lead-only and avoid exposing process-control capability to teammates.
- Add focused behavior tests before implementation.
- Update the public tool and live-navigation documentation.
- Do not add dependencies, commit, push, publish, start services, or change unrelated orchestration behavior.
- `goal.md` is the persistent project harness and must remain after completion unless Leo explicitly requests deletion.

## Acceptance criteria

1. A lead can call `interrupt_teammate` with an active read-agent name and abort its in-flight tool command without removing or finalizing that agent.
2. A lead can call the same tool with an active tmux-backed write-agent name and deliver Pi's Escape interrupt to its foreground command without stopping the pane or removing the agent; the result distinguishes key delivery from confirmed command settlement.
3. The interrupted teammate remains active, retains its claims/task context, and can receive subsequent work.
4. Teammates cannot access the new process-control tool.
5. In the live agent view, pressing `i` on the selected active teammate invokes the same interruption path and reports the outcome; `x` and Escape retain their existing meanings.
6. Missing, no-running-command, pending, unsupported, and failed interruption states produce explicit results and never claim success or fall back to whole-agent teardown.
7. Focused automated tests cover tool authorization, read-agent command interruption and resumption, write-agent Escape delivery, lifecycle preservation, bounded cooperative-cancellation behavior, and the live-view shortcut.
8. Relevant focused tests and `pnpm typecheck` pass.
9. README/skill guidance names the new tool, shortcut, and distinction from `stop_teammate`.
10. A fresh read-only non-author review finds no material lifecycle, cleanup, authorization, process-control, or regression issue in the final diff.

## Definition of done

The tool, runtime adapters, keyboard path, focused tests, documentation, integrated verification, and independent review are complete. Every acceptance criterion has concrete evidence; no active file claims or unresolved material findings remain.

## Verification plan

- Establish the installed Pi extension APIs for tool cancellation and keyboard handling from complete official docs/source evidence.
- Add failing focused regressions for the public tool and selected-agent shortcut before implementation.
- Exercise read-agent and tmux-backed write-agent interruption through their narrowest test seams, including proof that teardown/removal and claim release do not occur.
- Run the relevant focused Vitest files and `pnpm typecheck`.
- Run a real spawned-agent smoke exercise only if the existing harness can do so without starting an unauthorized service; otherwise document the exact integration-test boundary.
- Ask a fresh read-only agent to review the final diff and evidence against all acceptance criteria.
