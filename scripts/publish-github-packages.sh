#!/usr/bin/env bash
#
# Re-publish the version semantic-release just released to GitHub Packages.
#
# semantic-release publishes to npmjs.org; this mirrors the same version to the
# GitHub Packages registry. The npm dist-tag is derived from the version so a
# prerelease (e.g. 0.1.0-beta.1) lands on its channel tag (`beta`) instead of
# overwriting `latest`. If nothing was released this run the version already
# exists upstream, which we tolerate rather than fail.
#
# Requires GITHUB_TOKEN in the environment (packages:write scope).
set -euo pipefail

# Presence check only — never interpolate the token into a command or file.
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

version="$(node -p "require('./package.json').version")"
if [[ "$version" == *-* ]]; then
  tag="${version#*-}"   # 0.1.0-beta.1 -> beta.1
  tag="${tag%%.*}"      # beta.1       -> beta
else
  tag="latest"
fi

# Write the auth line with a literal ${GITHUB_TOKEN} placeholder (single quotes
# stop bash from expanding it). npm substitutes the env var at publish time, so
# the real token never lands on disk in .npmrc — only the placeholder does.
publish_log="$(mktemp)"
cleanup() { rm -f .npmrc "$publish_log"; }
trap cleanup EXIT
{
  echo "@rbbtsn0w:registry=https://npm.pkg.github.com"
  echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}'
} > .npmrc

echo "Publishing ${version} to GitHub Packages under dist-tag '${tag}'..."
if npm publish --registry https://npm.pkg.github.com --tag "$tag" 2> "$publish_log"; then
  cat "$publish_log" >&2
  exit 0
else
  status=$?
  cat "$publish_log" >&2
fi
if grep -Eqi 'EPUBLISHCONFLICT|cannot publish over|version .+ already exists' "$publish_log"; then
  echo "GitHub Packages: version ${version} already exists; skipping mirror publish."
  exit 0
fi

echo "GitHub Packages publish failed for ${version}." >&2
exit "$status"
