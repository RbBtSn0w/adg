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
cleanup() { rm -f .npmrc; }
trap cleanup EXIT
{
  echo "@rbbtsn0w:registry=https://npm.pkg.github.com"
  echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}'
} > .npmrc

echo "Publishing ${version} to GitHub Packages under dist-tag '${tag}'..."
npm publish --registry https://npm.pkg.github.com --tag "$tag" \
  || echo "GitHub Packages: nothing to publish or version ${version} already exists."
