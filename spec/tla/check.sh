#!/usr/bin/env bash
# Runs TLC over the RouteStore models. RouteStore.cfg must verify with no error,
# and each older configuration must still report its known invariant violation.
set -euo pipefail

TLC_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
TLC_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"

cd "$(dirname "${BASH_SOURCE[0]}")"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

if [ -n "${TLA_JAR:-}" ]; then
  jar="$TLA_JAR"
else
  jar="$work_dir/tla2tools.jar"
  echo "Downloading TLC v1.7.4"
  curl -fL --retry 3 --silent --show-error -o "$jar" "$TLC_URL"
fi

if [ ! -f "$jar" ]; then
  echo "FAIL no jar at $jar"
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  digest="$(sha256sum "$jar" | cut -d' ' -f1)"
else
  digest="$(shasum -a 256 "$jar" | cut -d' ' -f1)"
fi
if [ "$digest" != "$TLC_SHA256" ]; then
  echo "FAIL tla2tools.jar sha256 is $digest, expected $TLC_SHA256"
  exit 1
fi
echo "PASS tla2tools.jar sha256"

status=0
while read -r module config expected_rc expected_text; do
  metadir="$work_dir/$config.d"
  log="$work_dir/$config.log"
  mkdir -p "$metadir"
  rc=0
  java -cp "$jar" tlc2.TLC -workers 1 -metadir "$metadir" -config "$config" "$module" \
    >"$log" 2>&1 || rc=$?
  if [ "$rc" -eq "$expected_rc" ] && grep -qF "$expected_text" "$log"; then
    echo "PASS $config exit $rc: $expected_text"
  else
    echo "FAIL $config exit $rc, expected exit $expected_rc with: $expected_text"
    cat "$log"
    status=1
  fi
done <<'MODELS'
RouteStore.tla RouteStore.cfg 0 No error has been found
RouteStoreOld.tla RouteStoreOld.cfg 12 Invariant UniqueLivePorts is violated
RouteStoreOld.tla RouteStoreOld-Lock.cfg 12 Invariant LockExclusion is violated
RouteStore.tla RouteStore-Reclaim.cfg 12 Invariant LockExclusion is violated
MODELS

exit "$status"
