#!/usr/bin/env bash
# Publish the Newest First plugin source to the public GitHub repo named in
# public/manifest.json (jonahwei19/remnote-newest-first). RemNote's marketplace
# review requires that repo to exist and be public.
#
# Safe to run repeatedly: it clones what is there, replaces the tracked files
# with the current source, and commits only if something changed. The first
# version of this script re-ran `git init` every time and then pushed with
# --force-with-lease, which cannot work against a remote it has never fetched.
#
#   bash marketplace-plugin/publish-repo.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="jonahwei19/remnote-newest-first"
WORK="$(mktemp -d)/remnote-newest-first"
VERSION="$(python3 -c "import json,sys;v=json.load(open(sys.argv[1]))['version'];print('%d.%d.%d' % (v['major'], v['minor'], v['patch']))" "$HERE/public/manifest.json")"

if gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo clone "$REPO" "$WORK" -- --quiet
  cd "$WORK"
  # Replace the working tree with the current source, keeping .git.
  find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  rsync -a --exclude node_modules --exclude node_modules.min --exclude dist \
        --exclude PluginZip.zip --exclude .git "$HERE/" .
  printf 'node_modules/\ndist/\nPluginZip.zip\n' > .gitignore
  git add -A
  if git diff --cached --quiet; then
    echo "no changes to publish: https://github.com/$REPO"
    exit 0
  fi
  git -c user.email=weinbaumjonah@gmail.com -c user.name="Jonah Weinbaum" \
      commit -qm "Newest First $VERSION"
  git push -q origin HEAD:main
else
  mkdir -p "$WORK"
  rsync -a --exclude node_modules --exclude node_modules.min --exclude dist \
        --exclude PluginZip.zip "$HERE/" "$WORK/"
  cd "$WORK"
  printf 'node_modules/\ndist/\nPluginZip.zip\n' > .gitignore
  git init -q
  git add -A
  git -c user.email=weinbaumjonah@gmail.com -c user.name="Jonah Weinbaum" \
      commit -qm "Newest First $VERSION"
  gh repo create "$REPO" --public --source . --remote origin --push \
    --description "RemNote plugin: practise the cards you just made, first"
fi
echo "published $VERSION: https://github.com/$REPO"
