---
name: run-git-operations
description: Handles git operations, delegating signing-required and remote-auth-required commands to the user when needed.
user-invocable: false
---

# Git Operations Skill

This skill governs how you execute git commands. The environment is detected dynamically — do not assume any particular signing or auth configuration.

## Environment detection

```!
echo "=== Commit signing ==="
SIGN=$(git config --get commit.gpgsign 2>/dev/null || echo "false")
echo "commit.gpgsign=$SIGN"

echo "=== Tag signing ==="
TAG_SIGN=$(git config --get tag.gpgsign 2>/dev/null || echo "not set")
echo "tag.gpgsign=$TAG_SIGN"

echo "=== GPG format ==="
git config --get gpg.format 2>/dev/null || echo "not set"

echo "=== Remote URL ==="
git remote get-url origin 2>/dev/null || echo "no remote"

```

## Local git commands — always run directly

Commands that operate purely locally are always safe to run yourself:

`git add`, `git status`, `git log`, `git diff`, `git branch` (local), `git stash`, `git reset` (local), `git checkout`, `git merge` (local), `git rebase` (local), etc.

## Signing-required commands (git commit, git tag)

Check the environment detection output above:

- **If `commit.gpgsign=true`:** You cannot sign commits because you don't have access to the signing key. Do NOT attempt `git commit` yourself. Instead:
  1. Do all prep work yourself — `git add`, `git reset`, `git stash`, etc. Don't make the user run anything they don't have to.
  2. Output **only** the commit command for the user to run, as a plain directly-pasteable command string. Never use heredoc/`cat <<EOF` form.
  3. For multi-paragraph commit messages, use multiple `-m` flags (one per paragraph).
  4. For multi-commit workflows, stage and pause for each commit — don't batch all commands at the end.

- **If `commit.gpgsign=false` or not set:** Run `git commit` directly yourself.

- **For `git tag`:** apply the same logic using `tag.gpgsign`. If `tag.gpgsign` is not explicitly set, it inherits from `commit.gpgsign`.

Example output format when delegating:
```
git commit -m "Add new feature" -m "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

## Remote git commands (fetch, pull, push)

Check the environment detection output above:

- **If the remote URL uses SSH (`git@...`):** SSH key authentication is required which you may not have access to. Do NOT attempt remote commands yourself — output the exact command for the user to run.
- **If the remote URL uses HTTPS:** Attempt the command directly. If it fails with an authentication error, do NOT retry — output the exact command for the user to run.
- **If there is no remote:** Run commands directly (they will fail harmlessly if a remote is needed).

## General principle

You should run every git command you can directly. Only hand the user commands that require interactive authentication (GPG signing, SSH keys, credential prompts). The user should never have to run `git add`, `git reset`, `git status`, etc. themselves.