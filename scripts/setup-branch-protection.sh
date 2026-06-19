#!/usr/bin/env bash
#
# Apply branch-protection rulesets for the two-branch model:
#   - main: stable releases, maintainer-only, PR + reviews + status checks
#   - beta: integration branch, PR + reviews + status checks (incl. PR target gate)
#
# Idempotent-ish: re-running creates duplicate rulesets, so it deletes any
# existing ruleset with the same name first. Requires an authenticated `gh`
# with admin on the repo.
#
# Restricting *who can merge* into main (owner / maintainers / release managers)
# is expressed via the ruleset bypass list. Replace the BYPASS_* placeholders
# with real actor/team IDs, or apply that part in the GitHub UI:
#   Settings -> Rules -> Rulesets -> main -> Bypass list.
set -euo pipefail

# Prefer a Homebrew gh, fall back to PATH; fail loud if neither is present.
GH="${GH:-/opt/homebrew/bin/gh}"
command -v "$GH" >/dev/null 2>&1 || GH="gh"
if ! command -v "$GH" >/dev/null 2>&1; then
  echo "Error: GitHub CLI ('$GH') is not installed or not in PATH." >&2
  exit 1
fi

# Default to the current repo (override with REPO=owner/name).
REPO="${REPO:-$("$GH" repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "RbBtSn0w/adg")}"

api() { "$GH" api -H "Accept: application/vnd.github+json" "$@"; }

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
        "required_status_checks": ${checks_json}
      }
    }
  ]
}
JSON
}

# Job names as rendered by Actions (see .github/workflows/*.yml).
MAIN_CHECKS='[{"context":"Test (Node 22)"},{"context":"Test (Node 23)"}]'
BETA_CHECKS='[{"context":"Test (Node 22)"},{"context":"Test (Node 23)"},{"context":"Validate base branch"}]'

# main requires conversation resolution (4th arg = true); beta does not.
create_ruleset "main"  "main"  "${MAIN_CHECKS}"  "true"
create_ruleset "beta"  "beta"  "${BETA_CHECKS}"  "false"

cat <<'NOTE'

Done. Remaining manual steps:
1. Merge-permission restriction on main:
     Settings -> Rules -> Rulesets -> "main" -> Bypass list
     Add only: Repository admin / Maintainers / Release managers.
   This keeps stable-release merges restricted to authorized people.
2. Allow release automation to push to main AND beta:
     Settings -> Rules -> Rulesets -> "main" & "beta" -> Bypass list
     Add the release-bot App (or "github-actions[bot]") with "Always" bypass mode.
   Without this, semantic-release cannot push its `chore(release)` commits and
   tags to the protected branches and the release pipeline fails.
NOTE
