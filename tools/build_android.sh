#!/bin/bash
set -euo pipefail

PREFIX=${PREFIX:-/data/data/com.termux/files/usr}
VERSION="${AD_NIHILUM_VERSION:-android-build}"

trap 'rm -f version.h' EXIT

echo "Building Ad Nihilum for Android/Termux"
echo "PREFIX=${PREFIX}"
echo "VERSION=${VERSION}"
echo "Generating version.h"

cat > version.h <<EOF2
#pragma once
#define AD_NIHILUM_VERSION "${VERSION}"
EOF2

echo "Compiling adnihilum with FILELOG=1, SYSLOG=0, ASSEMBLED_HTML=0, DEBOUNCER=0, TAILSCALE=0"
# This direct Termux build intentionally bypasses the CMake ASSEMBLED_HTML
# asset pipeline; it serves the separate files from assets/ instead.
clang -std=c23 -O2 -mcpu=native -fno-plt -fstack-protector-strong \
  -D_FORTIFY_SOURCE=2 -DNDEBUG -DSIMD_ARM=1 \
  -DJS_MINIFY=0 -DFILELOG=1 -DSYSLOG=0 -DSTATISTICS=0 \
  -DLOCK_MEMORY_TO_RAM=0 -DTAILSCALE=0 -DDEBOUNCER=0 \
  -DASSEMBLED_HTML=0 \
  -I"$PREFIX/include" server.c storage.c log.c \
  -o adnihilum \
  -L"$PREFIX/lib" -lmicrohttpd

echo "Built ./adnihilum"
