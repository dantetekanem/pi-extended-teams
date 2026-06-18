# pi-extended-teams Usage Guide

This guide provides detailed examples, patterns, and best practices for using pi-extended-teams.

## Table of Contents

- [Getting Started](#getting-started)
- [Common Workflows](#common-workflows)
- [Hook System](#hook-system)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### Basic Team Setup

First, make sure you're inside a tmux session. Write agents require background tmux screens; read agents run in-process and do not open tmux screens.

```bash
tmux
```

Then start pi:

```bash
pi
```

Create your first team:

> **You:** "List available models for team creation, then create a team named 'my-team' using 'openai-codex/gpt-5.4'"

Set a default model for all teammates:

> **You:** "List available models for team creation, then create a team named 'Research' and use 'openai-codex/gpt-5.4' for everyone"

---

## Common Workflows

### 1. Code Review Team

> **You:** "List available models for team creation"
> **You:** "Create a team named 'code-review' using 'openai-codex/gpt-5.4'"
> **You:** "Spawn a teammate named 'security-reviewer' to check for vulnerabilities"
> **You:** "Spawn a teammate named 'performance-reviewer' using 'claude-agent-sdk/claude-sonnet-4-6' to check for optimization opportunities"
> **You:** "Create a task for security-reviewer: 'Review the auth module for SQL injection risks' and set it to in_progress"
> **You:** "Create a task for performance-reviewer: 'Analyze the database queries for N+1 issues' and set it to in_progress"

### 2. Refactor with Plan Approval

> **You:** "Create a team named 'refactor-squad' using 'openai-codex/gpt-5.4'"
> **You:** "Spawn a teammate named 'refactor-bot' and require plan approval before they make any changes"
> **You:** "Create a task for refactor-bot: 'Refactor the user service to use dependency injection' and set it to in_progress"

Teammate submits a plan. Review it:

> **You:** "List all tasks and show me refactor-bot's plan for task 1"

Approve or reject:

> **You:** "Approve refactor-bot's plan for task 1"

> **You:** "Reject refactor-bot's plan for task 1 with feedback: 'Add unit tests for the new injection pattern'"

### 3. Testing with Automated Hooks

Create a hook script at `.pi/team-hooks/task_completed.sh`:

```bash
#!/bin/bash
# This script runs automatically when any task is completed

echo "Running post-task checks..."
pnpm test
if [ $? -ne 0 ]; then
  echo "Tests failed! Please fix before marking task complete."
  exit 1
fi

pnpm run lint
echo "All checks passed!"
```

> **You:** "Create a team named 'test-team' using 'openai-codex/gpt-5.4'"
> **You:** "Spawn a teammate named 'qa-bot' to write tests"
> **You:** "Create a task for qa-bot: 'Write unit tests for the payment module' and set it to in_progress"

When qa-bot marks the task as completed, the hook automatically runs tests and linting.

### 4. Coordinated Migration

> **You:** "Create a team named 'migration-team' using 'openai-codex/gpt-5.4'"
> **You:** "Spawn a teammate named 'db-migrator' to handle database changes"
> **You:** "Spawn a teammate named 'api-updater' using 'openai-codex/gpt-5.4' to update API endpoints"
> **You:** "Spawn a teammate named 'test-writer' to write tests for the migration"
> **You:** "Create a task for db-migrator: 'Add new columns to the users table' and set it to in_progress"

After db-migrator completes, broadcast the schema change:

> **You:** "Broadcast to the team: 'New columns added to users table: phone, email_verified. Please update your code accordingly.'"

### 5. Mixed-Speed Team

Use different models for cost optimization:

> **You:** "List available models for team creation"
> **You:** "Create a team named 'mixed-speed' using 'openai-codex/gpt-5.4'"
> **You:** "Spawn a teammate named 'architect' using 'openai-codex/gpt-5.4' with 'xhigh' thinking level for design decisions"
> **You:** "Spawn a teammate named 'implementer' using 'claude-agent-sdk/claude-sonnet-4-6' with 'low' thinking level for quick coding"
> **You:** "Spawn a teammate named 'reviewer' using 'openai-codex/gpt-5.4' with 'medium' thinking level for code reviews"

Now you have expensive reasoning for design and reviews, but fast/cheap implementation.

---

## Hook System

### Overview

Hooks are shell scripts that run automatically at specific events. Currently supported:

- **`task_completed.sh`** - Runs when any task's status changes to `completed`

### Hook Location

Hooks should be placed in `.pi/team-hooks/` in your project directory:

```
your-project/
├── .pi/
│   └── team-hooks/
│       └── task_completed.sh
```

### Hook Payload

The hook receives the task data as a JSON string as the first argument:

```bash
#!/bin/bash
TASK_DATA="$1"
echo "Task completed: $TASK_DATA"
```

Example payload:
```json
{
  "id": "task_123",
  "subject": "Fix login bug",
  "description": "Users can't login with special characters",
  "status": "completed",
  "owner": "fixer-bot"
}
```

### Example Hooks

#### Test on Completion

```bash
#!/bin/bash
# .pi/team-hooks/task_completed.sh

TASK_DATA="$1"
SUBJECT=$(echo "$TASK_DATA" | jq -r '.subject')

echo "Running tests after task: $SUBJECT"
pnpm test
```

#### Notify Slack

```bash
#!/bin/bash
# .pi/team-hooks/task_completed.sh

TASK_DATA="$1"
SUBJECT=$(echo "$TASK_DATA" | jq -r '.subject')
OWNER=$(echo "$TASK_DATA" | jq -r '.owner')

curl -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"Task '$SUBJECT' completed by $OWNER\"}" \
  "$SLACK_WEBHOOK_URL"
```

#### Conditional Checks

```bash
#!/bin/bash
# .pi/team-hooks/task_completed.sh

TASK_DATA="$1"
SUBJECT=$(echo "$TASK_DATA" | jq -r '.subject')

# Only run full test suite for production-related tasks
if [[ "$SUBJECT" == *"production"* ]] || [[ "$SUBJECT" == *"deploy"* ]]; then
  pnpm run test:ci
else
  pnpm test
fi
```

---

## Best Practices

### 1. Use Thinking Levels Wisely

- **`off`** - Simple tasks: formatting, moving code, renaming
- **`minimal`** - Quick decisions: small refactors, straightforward bugfixes
- **`low`** - Standard work: typical feature implementation, tests
- **`medium`** - Complex work: architecture decisions, tricky bugs
- **`high`** - Critical work: security reviews, major refactors, design specs
- **`xhigh`** - Deepest available reasoning: architecture audits, thorny debugging, high-stakes review work

### 2. Team Composition

Balanced teams typically include:
- **1-2 high-thinking, high-model** agents for architecture and reviews
- **Use `xhigh` sparingly** for the one teammate doing the hardest reasoning-heavy work
- **2-3 low-thinking, fast-model** agents for implementation
- **1 medium-thinking** agent for coordination

Example:
```bash
# Design/Review duo (expensive but thorough)
spawn "architect" using "openai-codex/gpt-5.4" with "xhigh" thinking
spawn "reviewer" using "openai-codex/gpt-5.4" with "medium" thinking

# Implementation trio (fast and cheap)
spawn "backend-dev" using "claude-agent-sdk/claude-sonnet-4-6" with "low" thinking
spawn "frontend-dev" using "claude-agent-sdk/claude-sonnet-4-6" with "low" thinking
spawn "test-writer" using "claude-agent-sdk/claude-sonnet-4-6" with "off" thinking
```

### 3. Plan Approval for High-Risk Changes

Enable plan approval mode for:
- Database schema changes
- API contract changes
- Security-related work
- Performance-critical code

Disable for:
- Documentation updates
- Test additions
- Simple bug fixes

### 4. Broadcast for Coordination

Use broadcasts when:
- API endpoints change
- Database schemas change
- Deployment happens
- Team priorities shift

### 5. Clear Task Descriptions

Good task:
```
"Add password strength validation to the signup form. 
Requirements: minimum 8 chars, at least one number and symbol.
Use the zxcvbn library for strength calculation."
```

Bad task:
```
"Fix signup form"
```

### 6. Let the Extension Wake the Lead

For routine report completion, you do not need to ask the lead to sleep, wait, or create a separate polling loop. pi-extended-teams watches the lead inbox while the lead is idle and wakes the lead when teammate reports are ready.

Use manual checks only when you need explicit state or suspect a stall:

> **You:** "List all tasks"
> **You:** "Check my inbox for messages"
> **You:** "How is the team doing?"

---

## Troubleshooting

### Teammate Not Responding

**Problem**: A teammate is idle but not picking up messages.

**Solution**:
1. Check if they're still running:
   > **You:** "Check on teammate named 'security-bot'"
2. Check their inbox:
   > **You:** "Read security-bot's inbox"
3. Force kill and respawn if needed:
   > **You:** "Force kill security-bot and respawn them"

### tmux Screen Issues

**Problem**: background tmux screens don't close when killing teammates.

**Solution**: Make sure you started pi inside a tmux session. If you started pi outside tmux, it won't work properly.

```bash
# Correct way
tmux
pi

# Incorrect way
pi  # Then try to use tmux commands
```

### Hook Not Running

**Problem**: Your task_completed.sh script isn't executing.

**Checklist**:
1. File exists at `.pi/team-hooks/task_completed.sh`
2. File is executable: `chmod +x .pi/team-hooks/task_completed.sh`
3. Shebang line is present: `#!/bin/bash`
4. Test manually: `.pi/team-hooks/task_completed.sh '{"test":"data"}'`

### Model Errors

**Problem**: "Model not found" or similar errors.

**Solution**: Use `list_available_models` first and then pass a fully qualified `provider/model` string.

Examples:
- `openai-codex/gpt-5.4`
- `claude-agent-sdk/claude-sonnet-4-6`
- `kimi-coding/kimi-for-coding`

pi-extended-teams does not auto-resolve bare model names like `gpt-5` or `haiku` when creating new teams or spawning new teammates.
If a model is not fully qualified or not available, pi-extended-teams fails fast.

If you want to control the order shown by `list_available_models`, add global or project-local pi-extended-teams config:

- Global: `~/.pi/pi-extended-teams.json`
- Project-local: `.pi/pi-extended-teams.json`

Example:

```json
{
  "providerPriority": [
    "openai-codex",
    "claude-agent-sdk",
    "kimi-coding"
  ]
}
```

Preferred models are still taken from pi settings (`defaultProvider`, `defaultModel`, and `enabledModels`) and are listed first.

### Data Location

All team data is stored in:
- `~/.pi/teams/<team-name>/` - Team configuration, member list
- `~/.pi/tasks/<team-name>/` - Task files
- `~/.pi/messages/<team-name>/` - Message history

You can manually inspect these JSON files to debug issues.

### Write-Agent Screens Not Appearing

**Problem**: write-agent background tmux screens are not appearing.

**Requirements**:
1. Start Pi from inside a tmux session.
2. Make sure `TMUX` is present in the environment.
3. Use read agents for investigation when you do not need a live tmux screen.

pi-extended-teams is tmux-only for write-agent screens. Zellij and iTerm2 pane backends are not supported.

**Debug mode**:
Set `PI_EXTENDED_TEAMS_DEBUG=1` before starting Pi, or add this to `~/.pi/agent/pi-extended-teams/settings.json` or `<project>/.pi/pi-extended-teams.json`:

```json
{
  "debug": { "enabled": true }
}
```

When debug mode is enabled, write-agent spawn requests, queue decisions, launch commands, terminal window/pane IDs, and spawn failures are appended as JSON lines to `~/.pi/teams/<team-name>/debug.log`. Successful `spawn_teammate` results also include the debug log path.

---

## Inter-Agent Communication

Teammates can message each other without your intervention:

```
Frontend Bot → Backend Bot: "What's the response format for /api/users?"
Backend Bot → Frontend Bot: "Returns {id, name, email, created_at}"
```

This enables autonomous coordination. You can see these messages by:
> **You:** "Read backend-bot's inbox"

---

## Cleanup

To remove all team data, shut down the team:

```bash
> "Shut down the team named 'my-team'"
```

`team_shutdown` closes teammate screens, removes team/task state, and runs built-in stale session cleanup. Do not manually delete state unless you are recovering from a broken shutdown.

Or use the delete command:
> **You:** "Delete the team named 'my-team'"
