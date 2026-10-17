#!/usr/bin/env bash
# Publishes site/handoff/ as the only content of the gh-pages branch (one
# commit, force-pushed), so GitHub Pages serves the phone page and nothing else.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/handoff"
cp "$root"/site/handoff/* "$work/handoff/"
touch "$work/.nojekyll"
cd "$work"
git init -q -b gh-pages
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-ClikCode}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@clikcode.invalid}" commit -qm "Publish the phone handoff page"
git push -f "$(git -C "$root" remote get-url origin)" gh-pages
