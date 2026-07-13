# PII gate — re-scans the outgoing diff independently of pre-commit, so a
# commit made with --no-verify (or a clone that never installed hooks) still
# gets caught before it reaches the remote. Reads the standard pre-push
# stdin protocol: one "<local ref> <local sha> <remote ref> <remote sha>"
# line per updated ref.
zero_sha="0000000000000000000000000000000000000000"
empty_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

while read -r local_ref local_sha remote_ref remote_sha
do
  [ "$local_sha" = "$zero_sha" ] && continue # deleting a ref — nothing to scan

  if [ "$remote_sha" != "$zero_sha" ]; then
    base="$remote_sha"
  else
    # New branch / new upstream: diff against what's actually new relative
    # to main, falling back to the tip commit, then to "scan everything in
    # this commit" — never silently skip the check.
    # Assumes the default branch is origin/main; adapt this for repos whose
    # default branch is named differently (e.g. master, develop).
    base=$(git merge-base origin/main "$local_sha" 2>/dev/null)
    [ -z "$base" ] && base=$(git rev-parse "$local_sha^" 2>/dev/null)
    [ -z "$base" ] && base="$empty_tree"
  fi

  node scripts/check-pii.mjs --range "$base..$local_sha" || exit 1
done
