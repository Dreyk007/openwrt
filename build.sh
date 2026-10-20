#!/usr/bin/env bash
#
# Automated build script for Xiaomi AX3200 / Redmi AX6S OpenWrt firmware
# (MediaTek MT7622, aarch64_cortex-a53, GCC 15.2, musl libc)
#

set -euo pipefail

# Text colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}${BOLD}[SUCCESS]${NC} $*"; }
warn() { echo -e "${YELLOW}${BOLD}[WARNING]${NC} $*"; }
error() { echo -e "${RED}${BOLD}[ERROR]${NC} $*"; }

# Ensure we run from the repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

INSTALL_DEPS=0
JOBS="$(nproc)"

# Parse optional arguments
for arg in "$@"; do
    case "$arg" in
        --install-deps|-i)
            INSTALL_DEPS=1
            ;;
        -j*)
            JOBS="${arg#-j}"
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -i, --install-deps    Install required build dependencies via apt"
            echo "  -j<N>                 Number of parallel compilation jobs (default: $(nproc))"
            echo "  -h, --help            Show this help message"
            exit 0
            ;;
        *)
            warn "Unknown option: $arg"
            ;;
    esac
done

echo -e "${BOLD}================================================================${NC}"
echo -e "${BOLD} OpenWrt Firmware Build System — Xiaomi AX3200 / Redmi AX6S   ${NC}"
echo -e "${BOLD} Target: MediaTek MT7622 (ARM64 Cortex-A53)                   ${NC}"
echo -e "${BOLD}================================================================${NC}"

# 1. Install dependencies if requested or if essential build tools are missing
DEPS_PACKAGES=(
    build-essential
    ca-certificates
    clang
    flex
    bison
    g++
    gawk
    gcc-multilib
    g++-multilib
    gettext
    git
    libncurses-dev
    libssl-dev
    python3
    python3-dev
    python3-setuptools
    python3-pyelftools
    python3-cryptography
    rsync
    sudo
    swig
    unzip
    zlib1g-dev
    file
    wget
    curl
    time
)

if [ "$INSTALL_DEPS" -eq 1 ]; then
    info "Installing build dependencies via apt..."
    if [ "$(id -u)" -eq 0 ]; then
        apt-get update && apt-get install -y "${DEPS_PACKAGES[@]}"
    elif command -v sudo >/dev/null 2>&1; then
        sudo apt-get update && sudo apt-get install -y "${DEPS_PACKAGES[@]}"
    else
        error "Root or sudo privilege is required to install dependencies."
        exit 1
    fi
    success "Dependencies successfully installed."
else
    # Quick sanity check for essential tools
    MISSING_TOOLS=()
    for tool in gcc g++ make gawk bison flex git rsync swig; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            MISSING_TOOLS+=("$tool")
        fi
    done
    if [ "${#MISSING_TOOLS[@]}" -gt 0 ]; then
        warn "Missing essential tools: ${MISSING_TOOLS[*]}"
        warn "Run '$0 --install-deps' to install all build prerequisites."
    fi
fi

# Ensure FORCE_UNSAFE_CONFIGURE is exported if running as root
if [ "$(id -u)" -eq 0 ]; then
    warn "Running build as root is not recommended by OpenWrt. Setting FORCE_UNSAFE_CONFIGURE=1."
    export FORCE_UNSAFE_CONFIGURE=1
fi

# 2. Update and install package feeds
info "Updating and installing OpenWrt package feeds..."
./scripts/feeds update -a
./scripts/feeds install -a
success "Feeds updated and installed."

# 3. Apply target configuration
CONFIG_SEED="ax3200.config"
if [ ! -f "$CONFIG_SEED" ]; then
    error "Configuration seed '$CONFIG_SEED' not found in $(pwd)!"
    exit 1
fi

info "Applying configuration from $CONFIG_SEED..."
cp "$CONFIG_SEED" .config
make defconfig
success "Configuration applied successfully."

# 4. Synchronize kernel vermagic with official OpenWrt repository.
# Without a valid vermagic list the firmware silently gets its own vermagic and
# official kmod-* packages can no longer be installed, so treat failure as fatal.
info "Synchronizing kernel vermagic with official OpenWrt repository (mediatek mt7622)..."
if ! ./vermagic_update.sh mediatek mt7622; then
    error "Cannot synchronize kernel vermagic with the official repository."
    error "Check network access to downloads.openwrt.org and re-run the build."
    exit 1
fi
success "Kernel vermagic synchronized with official repository."

# 5. Pre-download source packages
info "Pre-downloading package sources using $JOBS parallel jobs..."
make download -j"$JOBS"
success "Source downloads complete."

# 6. Compile firmware
info "Starting multi-threaded firmware compilation (-j$JOBS)..."
if ! make -j"$JOBS"; then
    warn "Multi-threaded build failed. Retrying in single-thread debug mode (V=s)..."
    make -j1 V=s
fi
success "Firmware compilation finished successfully."

# 7. Post-process images: Extract raw UBI image and update sha256sums
TARGET_DIR="bin/targets/mediatek/mt7622"
if [ ! -d "$TARGET_DIR" ]; then
    error "Target build directory '$TARGET_DIR' not found!"
    exit 1
fi

FACTORY_BIN="$(find "$TARGET_DIR" -name "openwrt-*-factory.bin" | head -n 1)"
UBI_IMG="$TARGET_DIR/openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-sysupgrade.ubi"

if [ -n "$FACTORY_BIN" ] && [ -f "$FACTORY_BIN" ]; then
    # factory.bin = ubi-loader FIT padded to 512 KiB (size of the "ubi-loader"
    # partition) + UBI image, see Device/xiaomi_redmi-router-ax6s in mt7622.mk
    info "Extracting raw sysupgrade.ubi from factory.bin (offset 512KB)..."
    if [ "$(dd if="$FACTORY_BIN" bs=1 skip=524288 count=4 status=none)" != "UBI#" ]; then
        error "No UBI image at offset 512KB in $FACTORY_BIN (factory.bin layout changed?)"
        exit 1
    fi
    dd if="$FACTORY_BIN" of="$UBI_IMG" bs=512K skip=1 status=none
    success "Created $UBI_IMG"
else
    warn "factory.bin not found; skipping sysupgrade.ubi extraction."
fi

# 7. Generate and verify sha256sums
info "Generating and validating sha256sums in $TARGET_DIR..."
(
    cd "$TARGET_DIR"
    # Select all standard build artifacts
    FILES_TO_HASH=()
    for f in config.buildinfo feeds.buildinfo mt7622-ram-*.bin openwrt-*-factory.bin openwrt-*-recovery.itb openwrt-*-sysupgrade.itb openwrt-*-sysupgrade.ubi openwrt-*-ubi-loader.itb openwrt-*.manifest profiles.json version.buildinfo; do
        if [ -f "$f" ]; then
            FILES_TO_HASH+=("$f")
        fi
    done
    sha256sum -b "${FILES_TO_HASH[@]}" > sha256sums
    sha256sum -c sha256sums
)
success "sha256sums generated and verified."

# 8. Print build summary
echo ""
echo -e "${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD} Build Completed Successfully!                                 ${NC}"
echo -e "${BOLD} Artifacts location: ${TARGET_DIR}                             ${NC}"
echo -e "${BOLD}================================================================${NC}"
ls -lh "$TARGET_DIR"/openwrt-* "$TARGET_DIR"/sha256sums
echo ""
