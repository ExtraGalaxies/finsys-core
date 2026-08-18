#!/usr/bin/env bash
# Typecheck a CONSUMER of the built tarball, the way a stranger's tsc would.
#
# WHY THIS EXISTS. This repo's own tsconfig sets skipLibCheck: true, so lint,
# build and test here never typecheck dist/*.d.ts — the one artifact consumers
# actually load. tsc's DEFAULT is skipLibCheck: false, and under it any dangling
# reference in our .d.ts is the consumer's compile error, not ours. That is how
# `export { ... } from 'survey-core'` sat in dist/index.d.ts while survey-core
# was an OPTIONAL peer nobody installs: TS2307 for every consumer on defaults,
# green here (SYS-3420). Found by a review of a downstream package, not by
# anything in this repo.
#
# WHAT IT DOES. `npm pack` the package, install ONLY that tarball into a fresh
# fixture (its declared dependencies come along; optional peers do not — that
# is the point), import the root entry, and run this repo's own tsc over the
# fixture with skipLibCheck: false, under two module resolutions.
#
# WHAT IT DOES NOT DO. It does not exercise every subpath export or every
# named type — it loads the root .d.ts, which is what every consumer loads. A
# subpath whose .d.ts dangles would need its own import line below.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSC="$ROOT/node_modules/.bin/tsc"
[ -x "$TSC" ] || { echo "::error::no tsc at $TSC — run npm ci first"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARBALL="$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK" 2>/dev/null | tail -1)"
[ -s "$WORK/$TARBALL" ] || { echo "::error::npm pack produced no tarball"; exit 2; }
PKG_NAME="$(node -p 'require(process.argv[1]+"/package.json").name' "$ROOT")"

FIX="$WORK/consumer"
mkdir -p "$FIX"
cat > "$FIX/package.json" <<JSON
{ "name": "consumer-fixture", "private": true, "type": "module" }
JSON
# --ignore-scripts: nothing in the fixture may execute; we are checking types.
# No .npmrc here on purpose — the fixture is a stranger's project, not ours.
( cd "$FIX" && npm install --no-audit --no-fund --ignore-scripts --silent "$WORK/$TARBALL" )

cat > "$FIX/consumer.ts" <<TS
import * as pkg from '${PKG_NAME}'
void pkg
TS

fail=0
for res in nodenext bundler; do
  case "$res" in
    nodenext) mod=NodeNext ;;
    bundler)  mod=ESNext ;;
  esac
  cat > "$FIX/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false,
    "module": "$mod",
    "moduleResolution": "$res",
    "target": "ES2022",
    "types": []
  },
  "files": ["consumer.ts"]
}
JSON
  if out="$("$TSC" -p "$FIX" 2>&1)"; then
    echo "consumer typecheck (moduleResolution=$res, skipLibCheck=false): OK"
  else
    echo "consumer typecheck (moduleResolution=$res, skipLibCheck=false): FAILED"
    echo "$out" | sed 's/^/  /'
    fail=1
  fi
done
exit $fail
