#!/usr/bin/env bash
#
# One-shot repository governance setup for the two-branch model:
#   - main: stable releases, PR + reviews + conversation resolution + checks
#   - beta: integration branch, PR + reviews + checks (incl. PR-target gate)
#
# Requires an authenticated `gh` with admin on the repo. Everything is
# overridable via env vars (see the CONFIG block) so it is reusable across
# repos/forks.
#
# ===========================================================================
# COVERED BY THIS SCRIPT  (automated via the GitHub API)
# ===========================================================================
#   [1] Branch rulesets for `main` and `beta`
#       - require PR + 1 review; block direct push / non-ff / deletion
#       - required status checks (Test matrix; + "Validate base branch" on beta)
#       - main also requires conversation resolution
#       - bypass actors: Admin role + release-bot App (RELEASE_BOT_APP_ID)
#       -> create_ruleset() / bypass_actors_json()
#   [2] "Allow GitHub Actions to create and approve pull requests"
#       (required by sync-main-to-beta.yml to open the back-merge PR)
#       -> configure_repo_settings()
#   [3] Merge methods = merge-commit only (squash/rebase off, so squash cannot
#       collapse Conventional-Commit types) + auto-delete merged head branches
#       -> configure_repo_settings()
#
# ===========================================================================
# NOT COVERED — DO MANUALLY  (cannot be scripted; guidance below + printed at end)
# ===========================================================================
#   [M1] Install/scope the release-bot GitHub App on this repo (the central
#        manual prerequisite). sync-main-to-beta.yml reuses it (via
#        actions/create-github-app-token) to mint a token whose PR triggers CI,
#        so NO separate SYNC_TOKEN is needed. Grant the App:
#          - pull-requests: write   (open the back-merge PR)
#          - contents: write        (only if you also route release pushes via it)
#        Its App id (RELEASE_BOT_APP_ID) is already added to the ruleset bypass.
#        (SYNC_TOKEN remains an optional secret override if you prefer a PAT.)
#   [M2] github-actions[bot] bypass for release pushes — semantic-release pushes
#        the `chore(release)` commit + tag with GITHUB_TOKEN (= github-actions[bot]).
#        That bot is NOT covered by the Admin-role bypass and is not reliably
#        addable via the API, so add it by hand to BOTH rulesets:
#          Settings -> Rules -> Rulesets -> main / beta -> Bypass list ->
#          Add bypass -> github-actions[bot] -> mode "Always".
#        (Alternative: route semantic-release pushes through the release-bot App
#        token from [M1], whose App id is already in the bypass list.)
#   [M3] release-managers team bypass on main (optional) — add a Team to the main
#        ruleset bypass list if you want more than repo admins to merge to main.
# ===========================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# CONFIG (override via environment)
# ---------------------------------------------------------------------------
# Prefer a Homebrew gh, fall back to PATH; fail loud if neither is present.
GH="${GH:-/opt/homebrew/bin/gh}"
command -v "$GH" >/dev/null 2>&1 || GH="gh"
if ! command -v "$GH" >/dev/null 2>&1; then
  echo "Error: GitHub CLI ('$GH') is not installed or not in PATH." >&2
  exit 1
fi

api() { "$GH" api -H "Accept: application/vnd.github+json" "$@"; }

# Default to the current repo (override with REPO=owner/name).
REPO="${REPO:-$("$GH" repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "RbBtSn0w/adg")}"

# Required status-check contexts (job names as rendered by Actions).
TEST_CHECKS='{"context":"Test (Node 22)"},{"context":"Test (Node 23)"}'
PR_TARGET_CHECK='{"context":"Validate base branch"}'

# Bypass: repository Admin role always bypasses; add the release-bot App so
# release automation can push to protected branches. Defaults to this repo's
# RELEASE_BOT_APP_ID Actions variable; set BYPASS_APP_ID= to disable.
ADMIN_ROLE_ID="${ADMIN_ROLE_ID:-5}"
BYPASS_APP_ID="${BYPASS_APP_ID-$(api "/repos/${REPO}/actions/variables/RELEASE_BOT_APP_ID" --jq .value 2>/dev/null || true)}"

# Toggles for the non-ruleset repository settings.
APPLY_REPO_SETTINGS="${APPLY_REPO_SETTINGS:-true}"
ALLOW_SQUASH="${ALLOW_SQUASH:-false}"   # off: avoids squash collapsing commit types
ALLOW_REBASE="${ALLOW_REBASE:-false}"
DELETE_BRANCH_ON_MERGE="${DELETE_BRANCH_ON_MERGE:-true}"

# ---------------------------------------------------------------------------
# Rulesets
# ---------------------------------------------------------------------------
bypass_actors_json() {
  local items="{\"actor_id\":${ADMIN_ROLE_ID},\"actor_type\":\"RepositoryRole\",\"bypass_mode\":\"always\"}"
  if [ -n "${BYPASS_APP_ID}" ]; then
    items="${items},{\"actor_id\":${BYPASS_APP_ID},\"actor_type\":\"Integration\",\"bypass_mode\":\"always\"}"
  fi
  printf '[%s]' "${items}"
}

delete_ruleset_named() {
  local name="$1" ids id
  # More than one ruleset can share a name (e.g. from earlier runs); delete
  # every match. stderr is kept so auth/network errors stay visible.
  ids="$(api "/repos/${REPO}/rulesets" --jq ".[] | select(.name==\"${name}\") | .id")" || return 0
  [ -n "${ids}" ] || return 0
  while read -r id; do
    [ -n "${id}" ] || continue
    echo "Deleting existing ruleset '${name}' (id=${id})"
    api -X DELETE "/repos/${REPO}/rulesets/${id}" >/dev/null
  done <<<"${ids}"
}

create_ruleset() {
  local name="$1" ref="$2" checks_json="$3" thread_resolution="${4:-false}"
  delete_ruleset_named "${name}"
  echo "Creating ruleset '${name}' for refs/heads/${ref}"
  api -X POST "/repos/${REPO}/rulesets" --input - >/dev/null <<JSON
{
  "name": "${name}",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": $(bypass_actors_json),
  "conditions": {
    "ref_name": { "include": ["refs/heads/${ref}"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": ${thread_resolution}
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [${checks_json}]
      }
    }
  ]
}
JSON
}

# ---------------------------------------------------------------------------
# Non-ruleset repository settings
# ---------------------------------------------------------------------------
configure_repo_settings() {
  echo "Enabling 'Allow GitHub Actions to create and approve pull requests'"
  local cur_perm
  cur_perm="$(api "/repos/${REPO}/actions/permissions/workflow" --jq .default_workflow_permissions 2>/dev/null || echo read)"
  api -X PUT "/repos/${REPO}/actions/permissions/workflow" \
    -f default_workflow_permissions="${cur_perm}" \
    -F can_approve_pull_request_reviews=true >/dev/null

  echo "Setting merge methods (merge-commit only) + auto-delete merged branches"
  api -X PATCH "/repos/${REPO}" \
    -F allow_merge_commit=true \
    -F allow_squash_merge="${ALLOW_SQUASH}" \
    -F allow_rebase_merge="${ALLOW_REBASE}" \
    -F delete_branch_on_merge="${DELETE_BRANCH_ON_MERGE}" >/dev/null
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "Repo: ${REPO}"
echo "Bypass actors: Admin role(${ADMIN_ROLE_ID})$([ -n "${BYPASS_APP_ID}" ] && echo " + App(${BYPASS_APP_ID})" || echo " (no release App — set BYPASS_APP_ID)")"

# main requires conversation resolution (4th arg = true); beta does not.
create_ruleset "main"  "main"  "${TEST_CHECKS}"                      "true"
create_ruleset "beta"  "beta"  "${TEST_CHECKS},${PR_TARGET_CHECK}"   "false"

if [ "${APPLY_REPO_SETTINGS}" = "true" ]; then
  configure_repo_settings
else
  echo "Skipping repo settings (APPLY_REPO_SETTINGS=${APPLY_REPO_SETTINGS})."
fi

cat <<NOTE

Done. COVERED by this run: [1] rulesets (main, beta) with bypass, [2]
Actions-create-PR permission, [3] merge-commit-only + auto-delete branches.

NOT COVERED — do these manually (see the header for full context):
  [M1] Install/scope the release-bot App (id ${BYPASS_APP_ID:-<unset>}) on ${REPO}
       with pull-requests:write (and contents:write if it also pushes releases).
       sync-main-to-beta.yml reuses it to open the back-merge PR — no separate
       SYNC_TOKEN needed (SYNC_TOKEN stays an optional PAT override).
  [M2] github-actions[bot] bypass — add it to the main & beta ruleset bypass
       lists in the UI (Settings -> Rules -> Rulesets -> main/beta -> Bypass
       list -> "Always"); the Admin-role bypass does NOT cover the Actions bot.
       (Or route semantic-release via the release-bot App from [M1].)
  [M3] Optional: add a release-managers Team to the main ruleset bypass list.
NOTE
