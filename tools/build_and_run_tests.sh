#!/bin/sh
set -eu

# run from ..
mkdir -p build
"${CC:-cc}" -std=c2x -O0 -pg -g -Wall -Wextra tests/lp_test.c log.c -o build/lp_test -DDEBUG
./build/lp_test
