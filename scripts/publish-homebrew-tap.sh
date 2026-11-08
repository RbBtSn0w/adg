#!/usr/bin/env bash
set -euo pipefail

: "${HOMEBREW_TAP_DIR:?HOMEBREW_TAP_DIR is required}"
: "${RELEASE_ARCHIVE:?RELEASE_ARCHIVE is required}"

package_name="@rbbtsn0w/adg"
version="${1:-$(node -p "require('./package.json').version")}"

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

if [[ "$version" == *-* ]]; then
  echo "Skipping Homebrew tap publish for prerelease ${version}."
  exit 0
fi

tarball_url=""
for attempt in 1 2 3 4 5; do
  tarball_url="$(npm view "${package_name}@${version}" dist.tarball --silent 2>/dev/null || true)"
  if [[ -n "$tarball_url" ]]; then
    break
  fi
  echo "Waiting for npm tarball metadata for ${package_name}@${version} (attempt ${attempt}/5)..."
  sleep 15
done

if [[ -z "$tarball_url" ]]; then
  echo "Unable to resolve npm tarball URL for ${package_name}@${version}."
  exit 1
fi

sha256="$(curl -fsSL "$tarball_url" | sha256_stream)"
expected_sha256="$(sha256_stream < "$RELEASE_ARCHIVE")"
if [[ "$sha256" != "$expected_sha256" ]]; then
  echo "npm tarball differs from this run's final archive." >&2
  exit 1
fi
formula_path="${HOMEBREW_TAP_DIR}/Formula/adg.rb"

if [[ -f "$formula_path" ]]; then
  FORMULA_PATH="$formula_path" RELEASE_VERSION="$version" RELEASE_SHA256="$sha256" node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const formula=readFileSync(process.env.FORMULA_PATH,'utf8');
const current=formula.match(/adg-(\d+\.\d+\.\d+)\.tgz/);
if (!current) throw Error('Existing Homebrew version cannot be verified');
const a=current[1].split('.').map(Number), b=process.env.RELEASE_VERSION.split('.').map(Number);
const newer=a.some((part,index)=>part>b[index]&&a.slice(0,index).every((value,i)=>value===b[i]));
if (newer) throw Error('Homebrew already points to a newer version; recovery will not overwrite it');
if(current[1]===process.env.RELEASE_VERSION&&!formula.includes(`sha256 "${process.env.RELEASE_SHA256}"`)) throw Error('Existing Homebrew version has a different archive digest');
JS
fi

cat >"$formula_path" <<EOF
require "language/node"

class Adg < Formula
  desc "Agent Directory Group toolkit for plugins and skills"
  homepage "https://github.com/RbBtSn0w/adg"
  url "${tarball_url}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "Agent Directory Group toolkit", shell_output("#{bin}/adg")
  end
end
EOF

echo "Updated ${formula_path} for ${version}."
