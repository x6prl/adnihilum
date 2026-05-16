#!/bin/sh
set -eu

SRC_DIR="${1:-tmp/adaptivity}"
DST_DIR="${2:-screenshots}"
SRC="$SRC_DIR/simple-390x844.png"

mkdir -p "$DST_DIR"

if [ ! -f "$SRC" ]; then
	echo "missing screenshot: $SRC" >&2
	exit 1
fi

cp "$SRC" "$DST_DIR/simple-mobile.png"
echo "Copied $DST_DIR/simple-mobile.png"
