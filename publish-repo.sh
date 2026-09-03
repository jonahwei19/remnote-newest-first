#!/usr/bin/env bash
# Publish the Newest First plugin source to the public GitHub repo named in
# public/manifest.json (jonahwei19/remnote-newest-first). RemNote's marketplace
# review requires that repo to exist and be public. Run this yourself; Claude's
# harness blocks creating public repos under your account.
#
#   bash marketplace-plugin/publish-repo.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="jonahwei19/remnote-newest-first"
WORK="$(mktemp -d)/remnote-newest-first"
mkdir -p "$WORK"
rsync -a --exclude node_modules --exclude node_modules.min --exclude dist --exclude PluginZip.zip "$HERE/" "$WORK/"
cd "$WORK"
printf 'node_modules/\ndist/\nPluginZip.zip\n' > .gitignore
git init -q
git add -A
git -c user.email=weinbaumjonah@gmail.com -c user.name="Jonah Weinbaum" commit -qm "Newest First 0.2.0: newest-created-first cards at the front of the RemNote queue"
if gh repo view "$REPO" >/dev/null 2>&1; then
  git remote add origin "https://github.com/$REPO.git"
  git push -u origin HEAD:main --force-with-lease 2>/dev/null || git push -u origin HEAD:main
else
  gh repo create "$REPO" --public --source . --remote origin --push \
    --description "RemNote plugin: practise the cards you just made, first"
fi
echo "published: https://github.com/$REPO"
