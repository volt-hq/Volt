#!/usr/bin/env bash
# Model-check a TLA+ module in this directory with TLC.
#
#   ./check.sh                       # check LeaseBroker (baseline .cfg)
#   ./check.sh LeaseBroker leak.cfg  # check LeaseBroker with a specific .cfg
#
# Requires a Java 17+ runtime (set JAVA_HOME, or have `java` on PATH). Downloads
# tla2tools.jar into this directory on first run (it is git-ignored).
set -euo pipefail
cd "$(dirname "$0")"

MODULE="${1:-LeaseBroker}"
CONFIG="${2:-$MODULE.cfg}"
JAR="tla2tools.jar"

if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then
  JAVA="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA="java"
else
  echo "error: no Java runtime. Install a JDK 17+ (e.g. 'brew install openjdk@17')" >&2
  echo "       or download Temurin from https://adoptium.net and set JAVA_HOME." >&2
  exit 1
fi

if [[ ! -f "$JAR" ]]; then
  echo "downloading $JAR ..." >&2
  curl -L -sS --fail -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar"
fi

echo "checking $MODULE.tla with $CONFIG ..." >&2
exec "$JAVA" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
  -workers auto -config "$CONFIG" "$MODULE.tla"
