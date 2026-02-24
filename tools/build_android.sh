#!/bin/bash
set -euo pipefail

PREFIX=${PREFIX:-/data/data/com.termux/files/usr}
VERSION="${AD_NIHILUM_VERSION:-android-build}"

trap 'rm -f version.h' EXIT
cat > version.h <<EOF2
#pragma once
#define AD_NIHILUM_VERSION "${VERSION}"
EOF2

clang -std=c23 -O2 -mcpu=native -fno-plt -fstack-protector-strong \
  -D_FORTIFY_SOURCE=2 -DNDEBUG -DSIMD_ARM=1 \
  -DJS_MINIFY=0 -DFILELOG=0 -DSYSLOG=0 -DSTATISTICS=0 \
  -I"$PREFIX/include" server.c storage.c log.c \
  -o adnihilum \
  -L"$PREFIX/lib" -lmicrohttpd
