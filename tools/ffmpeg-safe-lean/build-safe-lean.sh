#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: build-safe-lean.sh --sources DIR --build-dir NEW_DIR --output-dir NEW_DIR

DIR must contain the four exact archives named in source-inputs.json.
The build and output directories must not already exist. The script never
downloads sources and never reuses an existing build directory.
USAGE
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

sources=''
build_dir=''
output_dir=''
while (($#)); do
  case "$1" in
    --sources) (($# >= 2)) || { usage; exit 2; }; sources=$2; shift 2 ;;
    --build-dir) (($# >= 2)) || { usage; exit 2; }; build_dir=$2; shift 2 ;;
    --output-dir) (($# >= 2)) || { usage; exit 2; }; output_dir=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done
[[ -n $sources && -n $build_dir && -n $output_dir ]] || { usage; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
sources=$(cd -- "$sources" 2>/dev/null && pwd -P) || die 'source directory does not exist.'
[[ ! -e $build_dir && ! -L $build_dir ]] || die 'build directory already exists; use a new empty path.'
[[ ! -e $output_dir && ! -L $output_dir ]] || die 'output directory already exists; use a new empty path.'
mkdir -p -- "$(dirname -- "$build_dir")" "$(dirname -- "$output_dir")"
build_parent=$(cd -- "$(dirname -- "$build_dir")" && pwd -P)
out_parent=$(cd -- "$(dirname -- "$output_dir")" && pwd -P)
build_dir="$build_parent/$(basename -- "$build_dir")"
output_dir="$out_parent/$(basename -- "$output_dir")"
[[ $build_dir != "$sources"* && $output_dir != "$sources"* ]] || die 'build and output paths must be outside the source archive directory.'

export PATH="/ucrt64/bin:/usr/bin${PATH:+:$PATH}"
for command_name in bash make gcc pkg-config python pacman tar sha256sum awk sed tee; do
  command -v "$command_name" >/dev/null 2>&1 || die "required command is missing: $command_name"
done
command -v nasm >/dev/null 2>&1 && die 'nasm is present but this pinned SAFE LEAN build requires x86 assembly disabled.'
command -v yasm >/dev/null 2>&1 && die 'yasm is present but this pinned SAFE LEAN build requires x86 assembly disabled.'

gcc_version=$(gcc -dumpfullversion)
make_version=$(make --version | sed -n '1s/^GNU Make //p')
pkgconf_version=$(pkg-config --modversion pkgconf 2>/dev/null || pkgconf --version)
python_version=$(python -c 'import platform; print(platform.python_version())')
meson_version=$(python -m mesonbuild.mesonmain --version 2>/dev/null) || die 'Meson 1.12.1 Python package is missing; install the pinned wheel described in toolchain.lock.json.'
ninja_version=$(ninja --version 2>/dev/null) || die 'Ninja is missing; install the pinned tool described in toolchain.lock.json.'
if [[ -f "$script_dir/toolchain.lock.json" ]]; then
  toolchain_lock="$script_dir/toolchain.lock.json"
elif [[ -f "$script_dir/../../toolchain.lock.json" ]]; then
  toolchain_lock="$script_dir/../../toolchain.lock.json"
else
  die 'toolchain.lock.json is missing.'
fi
python "$script_dir/verify-toolchain.py" --lock "$toolchain_lock" || die 'installed MSYS2 packages do not match the pinned toolchain.'
[[ $gcc_version == 15.2.0 ]] || die "GCC version mismatch: expected 15.2.0, got $gcc_version"
[[ $make_version == 4.4.1 ]] || die "GNU make version mismatch: expected 4.4.1, got $make_version"
[[ $pkgconf_version == 2.5.1 ]] || die "pkgconf version mismatch: expected 2.5.1, got $pkgconf_version"
[[ $python_version == 3.12.11 ]] || die "Python version mismatch: expected 3.12.11, got $python_version"
[[ $meson_version == 1.12.1 ]] || die "Meson version mismatch: expected 1.12.1, got $meson_version"
[[ $ninja_version == 1.13.2* ]] || die "Ninja version mismatch: expected 1.13.2, got $ninja_version"

for archive in \
  'ffmpeg-946fcce.tar.gz:0aa2b1de2a5698b20a23e93d539a9a8e82ca0117496c5bdf05d198805f42bb3b' \
  'x264-b35605ace3dd.tar:56d1a073f1f67cf6d3419a02f7663dce76ffc47b4aefe814c048f79ce3040a3d' \
  'lame-3.100-official.tar.gz:ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e' \
  'dav1d-1.5.4.tar:ffd903f96a657615796483435e578557fc976b8a8574c5154117d93f3f901ba4'; do
  name=${archive%%:*}
  hash=${archive#*:}
  "$script_dir/verify-sha256.sh" "$hash" "$sources/$name"
done

mkdir -p -- "$build_dir" "$output_dir" "$build_dir/logs" "$build_dir/prefix"
ffmpeg_source="$build_dir/src/ffmpeg"
x264_source="$build_dir/src/x264"
lame_source="$build_dir/src/lame"
dav1d_source="$build_dir/src/dav1d"
mkdir -p -- "$ffmpeg_source" "$x264_source" "$lame_source" "$dav1d_source"

tar -xzf "$sources/ffmpeg-946fcce.tar.gz" -C "$ffmpeg_source" --strip-components=1
tar -xf "$sources/x264-b35605ace3dd.tar" -C "$x264_source"
tar -xzf "$sources/lame-3.100-official.tar.gz" -C "$lame_source" --strip-components=1
tar -xf "$sources/dav1d-1.5.4.tar" -C "$dav1d_source"

prefix="$build_dir/prefix"
x264_prefix="$prefix/x264"
lame_prefix="$prefix/lame"
dav1d_prefix="$prefix/dav1d"

(
  cd -- "$x264_source"
  ./configure --host=x86_64-w64-mingw32 --prefix="$x264_prefix" \
    --enable-static --disable-cli --disable-asm --enable-pic
  make -j4
  make install
) 2>&1 | tee "$build_dir/logs/x264.log"

(
  cd -- "$lame_source"
  ./configure --host=x86_64-w64-mingw32 --prefix="$lame_prefix" \
    --disable-shared --enable-static --disable-frontend
  make -j4
  make install
) 2>&1 | tee "$build_dir/logs/lame.log"

# LAME 3.100 installs its static library but does not install the pkg-config
# metadata FFmpeg's configure script expects. Emit the stable metadata for the
# just-built library, matching the original SAFE LEAN input contract.
mkdir -p -- "$lame_prefix/lib/pkgconfig"
cat > "$lame_prefix/lib/pkgconfig/libmp3lame.pc" <<PC
prefix=$lame_prefix
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: libmp3lame
Description: LAME MP3 encoder library
Version: 3.100
Libs: -L\${libdir} -lmp3lame
Libs.private: -lm -liconv
Cflags: -I\${includedir}
PC
export PKG_CONFIG_PATH="$x264_prefix/lib/pkgconfig:$lame_prefix/lib/pkgconfig:$dav1d_prefix/lib/pkgconfig"
[[ $(pkg-config --modversion libmp3lame) == 3.100 ]] || die 'generated LAME pkg-config metadata is invalid.'

export PKG_CONFIG_PATH="$x264_prefix/lib/pkgconfig:$lame_prefix/lib/pkgconfig:$dav1d_prefix/lib/pkgconfig"
python -m mesonbuild.mesonmain setup "$build_dir/build/dav1d" "$dav1d_source" \
  --prefix="$dav1d_prefix" --buildtype=release --default-library=static \
  -Denable_asm=false -Denable_docs=false -Denable_examples=false \
  -Denable_tests=false -Denable_tools=false -Dxxhash_muxer=disabled \
  2>&1 | tee "$build_dir/logs/dav1d-setup.log"
python -m mesonbuild.mesonmain compile -C "$build_dir/build/dav1d" -j 4 \
  2>&1 | tee "$build_dir/logs/dav1d-build.log"
python -m mesonbuild.mesonmain install -C "$build_dir/build/dav1d" \
  2>&1 | tee "$build_dir/logs/dav1d-install.log"

export PKG_CONFIG_PATH="$x264_prefix/lib/pkgconfig:$lame_prefix/lib/pkgconfig:$dav1d_prefix/lib/pkgconfig"
(
  cd -- "$ffmpeg_source"
  # FFmpeg's legacy --enable-libmp3lame check does not consume pkg-config
  # include/library flags. Keep the dependency search rooted only in the
  # freshly built prefixes, as in the validated SAFE LEAN prototype.
  export CFLAGS="-O2 -I$lame_prefix/include -I$x264_prefix/include -I$dav1d_prefix/include"
  export LDFLAGS="-L$lame_prefix/lib -L$x264_prefix/lib -L$dav1d_prefix/lib"
  ./configure \
    --prefix=/ffmpeg-safe-lean-av1 \
    --target-os=mingw32 --arch=x86_64 \
    --enable-gpl --enable-version3 \
    --enable-static --disable-shared --disable-debug --disable-doc --disable-ffplay \
    --disable-autodetect --disable-x86asm --disable-indevs --disable-outdevs --disable-devices --disable-hwaccels \
    --enable-schannel --enable-ffmpeg --enable-ffprobe --enable-network \
    --enable-libx264 --enable-libmp3lame --enable-libdav1d \
    --extra-cflags=-O2 --extra-ldflags=-static \
    --pkg-config-flags=--static --pkg-config=pkg-config
  make -j4
) 2>&1 | tee "$build_dir/logs/ffmpeg-build.log"

install -m 0755 "$ffmpeg_source/ffmpeg.exe" "$output_dir/ffmpeg.exe"
install -m 0755 "$ffmpeg_source/ffprobe.exe" "$output_dir/ffprobe.exe"

ffmpeg_sha=$(sha256sum "$output_dir/ffmpeg.exe" | awk '{print $1}')
ffprobe_sha=$(sha256sum "$output_dir/ffprobe.exe" | awk '{print $1}')
cat > "$output_dir/build-config.json" <<JSON
{
  "schemaVersion": 1,
  "candidate": "SAFE LEAN",
  "target": "Windows x64",
  "ffmpegVersion": "9.0.2",
  "sourceCommit": "946fcce07b6dcd0331c8cc609192aeff5e1924f8",
  "effectiveBuildLicense": "GPL-3.0-or-later",
  "buildToolchain": {
    "gcc": "$gcc_version",
    "gnuMake": "$make_version",
    "pkgconf": "$pkgconf_version",
    "python": "$python_version",
    "meson": "$meson_version",
    "ninja": "$ninja_version"
  },
  "sourceArchives": {
    "ffmpeg-946fcce.tar.gz": "0aa2b1de2a5698b20a23e93d539a9a8e82ca0117496c5bdf05d198805f42bb3b",
    "x264-b35605ace3dd.tar": "56d1a073f1f67cf6d3419a02f7663dce76ffc47b4aefe814c048f79ce3040a3d",
    "lame-3.100-official.tar.gz": "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e",
    "dav1d-1.5.4.tar": "ffd903f96a657615796483435e578557fc976b8a8574c5154117d93f3f901ba4"
  },
  "configureOptions": [
    "--target-os=mingw32", "--arch=x86_64", "--enable-gpl", "--enable-version3",
    "--enable-static", "--disable-shared", "--disable-debug", "--disable-doc", "--disable-ffplay",
    "--disable-autodetect", "--disable-x86asm", "--disable-indevs", "--disable-outdevs",
    "--disable-devices", "--disable-hwaccels", "--enable-schannel", "--enable-ffmpeg",
    "--enable-ffprobe", "--enable-network", "--enable-libx264", "--enable-libmp3lame",
    "--enable-libdav1d", "--extra-cflags=-O2", "--extra-ldflags=-static",
    "--pkg-config-flags=--static", "--pkg-config=pkg-config"
  ],
  "dependencyBuildOptions": {
    "x264": ["--host=x86_64-w64-mingw32", "--enable-static", "--disable-cli", "--disable-asm", "--enable-pic"],
    "lame": ["--host=x86_64-w64-mingw32", "--disable-shared", "--enable-static", "--disable-frontend"],
    "dav1d": ["--buildtype=release", "--default-library=static", "-Denable_asm=false", "-Denable_docs=false", "-Denable_examples=false", "-Denable_tests=false", "-Denable_tools=false", "-Dxxhash_muxer=disabled"]
  },
  "dependencySearchEnvironment": {
    "CFLAGS": "-O2 -I\$BUILD_PREFIX/lame/include -I\$BUILD_PREFIX/x264/include -I\$BUILD_PREFIX/dav1d/include",
    "LDFLAGS": "-L\$BUILD_PREFIX/lame/lib -L\$BUILD_PREFIX/x264/lib -L\$BUILD_PREFIX/dav1d/lib"
  },
  "outputs": {
    "ffmpeg.exe": "$ffmpeg_sha",
    "ffprobe.exe": "$ffprobe_sha"
  }
}
JSON

[[ $(find "$output_dir" -mindepth 1 -maxdepth 1 -type f | wc -l) -eq 3 ]] || die 'unexpected output files were produced.'
printf 'SAFE LEAN build completed. Output: %s\n' "$output_dir"
