#!/bin/sh
# Rebuilds libclikcode-compat-x64.dylib (run on a Mac with Xcode or the Command Line Tools):  sh native/macos-compat/build.sh
# Intel only: every Apple Silicon Mac can run macOS 13, so only Intel Macs stuck on an older macOS need it. The deployment target is 10.15
# so the library itself needs nothing newer than the oldest system it is for.
set -e
cd "$(dirname "$0")"
clang -c -arch x86_64 -mmacosx-version-min=10.15 -Wall -O2 -o compat.o compat.c
clang++ -c -std=c++17 -stdlib=libc++ -arch x86_64 -mmacosx-version-min=10.15 -fvisibility=default -O2 -o compat-cpp.o compat.cpp
clang++ -dynamiclib -arch x86_64 -mmacosx-version-min=10.15 -stdlib=libc++ -o libclikcode-compat-x64.dylib compat.o compat-cpp.o
rm -f compat.o compat-cpp.o
ls -l libclikcode-compat-x64.dylib
