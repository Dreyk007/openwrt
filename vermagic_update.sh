#!/usr/bin/env bash
#
# Fetch the official kernel vermagic hashes for BOARD/SUBTARGET from the
# OpenWrt release repository into vermagic-<board>-<subtarget>-<version>.list.
# scripts/getvermagic.sh uses this list to replace the locally computed
# vermagic, so that kmods from the official repository can be installed.
#
# Usage: ./vermagic_update.sh [BOARD] [SUBTARGET] [OUTDIR]
#
# The existing list is replaced only after the new one has been downloaded and
# validated. On any error the script exits non-zero and leaves it untouched.

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

BOARD=$1
SUBTARGET=$2
OUTDIR=$3

[ -z "$OUTDIR" ] && OUTDIR=$SCRIPT_DIR

log_msg() {
	printf "%s\n" "$1"
}

log_err() {
	printf "\033[31mERROR: %s\033[m\n" "$1" >&2
}

die() {
	log_err "$1"
	exit 1
}

config_file="$OUTDIR/.config"

if [ -z "$BOARD" ]; then
	[ ! -f "$config_file" ] && die "File '.config' not found"
	BOARD=$( grep -o -P '(?<=CONFIG_TARGET_BOARD=").*(?=")' "$config_file" 2>/dev/null )
	[ -z "$BOARD" ] && die "Cannot determine BOARD"
fi
if [ -z "$SUBTARGET" ]; then
	[ ! -f "$config_file" ] && die "File '.config' not found"
	SUBTARGET=$( grep -o -P '(?<=CONFIG_TARGET_SUBTARGET=").*(?=")' "$config_file" 2>/dev/null )
	[ -z "$SUBTARGET" ] && die "Cannot determine SUBTARGET"
fi

version_file="$OUTDIR/include/version.mk"
#VERSION_NUMBER:=$(if $(VERSION_NUMBER),$(VERSION_NUMBER),25.12.6)
#VERSION_REPO:=$(if $(VERSION_REPO),$(VERSION_REPO),https://downloads.openwrt.org/releases/25.12.6)

VERSION_NUMBER=$( grep -o -P '(?<=,\$\(VERSION_NUMBER\),).*(?=\))' "$version_file" 2>/dev/null )
[ -z "$VERSION_NUMBER" ] && die "Cannot determine VERSION_NUMBER"

VERSION_REPO=$( grep -o -P '(?<=,\$\(VERSION_REPO\),http).*(?=\))' "$version_file" 2>/dev/null )
[ -z "$VERSION_REPO" ] && die "Cannot determine VERSION_REPO"
VERSION_REPO=http$VERSION_REPO

# Kernel version of this tree (e.g. 6.12.112-1), the same key getvermagic.sh looks up
KERNEL_PATCHVER=$( grep -o -P '(?<=^KERNEL_PATCHVER:=).*' "$OUTDIR/target/linux/$BOARD/Makefile" 2>/dev/null )
LINUX_VERSION=$( grep -o -P "(?<=^LINUX_VERSION-$KERNEL_PATCHVER = ).*" "$OUTDIR/target/linux/generic/kernel-$KERNEL_PATCHVER" 2>/dev/null )
LINUX_RELEASE=$( grep -o -P '(?<=^LINUX_RELEASE\?=).*' "$OUTDIR/include/kernel-version.mk" 2>/dev/null )
KERNEL_VER=
if [ -n "$KERNEL_PATCHVER" ] && [ -n "$LINUX_VERSION" ] && [ -n "$LINUX_RELEASE" ]; then
	KERNEL_VER=$KERNEL_PATCHVER$LINUX_VERSION-$LINUX_RELEASE
else
	log_msg "WARNING: Cannot determine local kernel version, skipping kernel match check"
fi

kmods_url=$VERSION_REPO/targets/$BOARD/$SUBTARGET/kmods/
vermagic_file=$OUTDIR/vermagic-$BOARD-$SUBTARGET-$VERSION_NUMBER.list

tmp_file=$( mktemp "$OUTDIR/.vermagic.XXXXXX" ) || die "Cannot create temporary file in '$OUTDIR'"
trap 'rm -f "$tmp_file"' EXIT

curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 -o "$tmp_file" "$kmods_url" ||
	die "Cannot download WEB-page from '$kmods_url'"

# Directory entries look like: <a href="6.12.112-1-685dcedeed3538a4cc670fc3fd59eac1/">
vermagic=$( grep -o -E 'href="[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9a-f]{32}/"' "$tmp_file" |
	sed -E 's/^href="//; s/\/"$//' | sort -u )
[ -z "$vermagic" ] && die "Cannot find kmods on '$kmods_url'"

if [ -n "$KERNEL_VER" ] && ! printf "%s\n" "$vermagic" | grep -q "^$KERNEL_VER-"; then
	die "No official kmods for kernel $KERNEL_VER on '$kmods_url' (found: $( echo $vermagic ))"
fi

printf "%s\n" "$vermagic" > "$tmp_file" || die "Cannot write temporary file '$tmp_file'"
chmod 644 "$tmp_file"

if cmp -s "$tmp_file" "$vermagic_file"; then
	log_msg "File '$( basename "$vermagic_file" )' is up to date."
else
	mv -f "$tmp_file" "$vermagic_file" || die "Cannot update '$vermagic_file'"
	log_msg "File '$( basename "$vermagic_file" )' updated."
fi

# Drop lists left over from previous releases of this target
for old_file in "$OUTDIR"/vermagic-"$BOARD"-"$SUBTARGET"-*.list; do
	[ -f "$old_file" ] && [ "$old_file" != "$vermagic_file" ] && rm -f "$old_file"
done

log_msg "$( printf "%s\n" "$vermagic" | sed 's/^/vermagic: /' )"
exit 0
