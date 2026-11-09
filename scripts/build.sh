#!/bin/sh
# Check and build dist/thwunderlist-<version>.xpi from the source tree.
set -eu
cd "$(dirname "$0")/.."

node --check background.js
node --check experiments/mail-list/api.js
node --check options/options.js
python3 -m json.tool experiments/mail-list/schema.json > /dev/null
version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
out="dist/thwunderlist-$version.xpi"
mkdir -p dist
rm -f "$out"
zip -q -X -MM "$out" manifest.json background.js \
  experiments/mail-list/api.js experiments/mail-list/schema.json styles/mail-list.css \
  options/options.html options/options.js options/options.css \
  icons/thwunderlist.svg LICENSE icons/LICENSE
echo "$out"
