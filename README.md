![OpenWrt logo](include/logo.png)

# OpenWrt 25.12 (`xq-25.12`) — Optimized Custom Build for Xiaomi AX3200 / Redmi AX6S

This repository (branch **`xq-25.12`**) is a specialized fork of the stable **OpenWrt 25.12.6** release (`Linux 6.12.112`), primarily tailored and optimized for the **Xiaomi Router AX3200 (RB01) / Redmi Router AX6S (RB03)** built on the **MediaTek MT7622B + MT7531BE + MT7915E** hardware platform (incorporating upstream MediaTek enhancements from the `remittor` tree).

The goal of this build is to deliver **line-rate 1 Gbps wired & Wi-Fi 6 throughput, minimal network latency and jitter, U-Boot NVRAM anti-brick protection, and a complete out-of-the-box home router feature set** while maintaining 100% compatibility with the official OpenWrt package repository.

---

## Key Changes & Hardware Optimizations for Xiaomi AX3200 / Redmi AX6S

### 1. Low-Level CPU Architecture Optimizations (`ARM Cortex-A53`)
* **Compiler Flags (`-O2 -pipe -mcpu=cortex-a53+crypto+crc`):**
  Upstream OpenWrt builds default to `-Os` (optimize for size), which disables function, loop, and jump alignment (`-falign-functions`, `-falign-loops`, `-falign-jumps`). On the dual-core **MediaTek MT7622B (Cortex-A53 @ 1.35 GHz)** with its in-order execution pipeline, unaligned branch targets incur extra L1 instruction cache misses. Because the AX3200 has 128 MB of NAND flash, this build switches to **`-O2`** and explicitly enables hardware **ARMv8 Crypto Extensions (AES, SHA1/SHA2, GHASH)** and **CRC32** instructions.
* **Global Link-Time Optimization (`CONFIG_USE_LTO=y`):**
  Enables GCC LTO (`-flto=auto -fuse-linker-plugin -fno-fat-lto-objects`) across userland packages and shared libraries, allowing whole-program interprocedural analysis, cross-file function inlining, and aggressive dead code elimination.
* **Dead Code & Data Elimination (`CONFIG_USE_GC_SECTIONS=y`):**
  Compiles userland packages with `-ffunction-sections -fdata-sections` and links with `-Wl,--gc-sections`, ensuring unreferenced functions and data items are removed from final binaries.
* **Enhanced Exploit Mitigation & Security Hardening:**
  Explicitly enforces aggressive compile-time and runtime defenses: Level 2 buffer-overflow protection (`CONFIG_PKG_FORTIFY_SOURCE_2=y`), GCC Stack-Protector Canary for both userland and kernel (`CONFIG_PKG_CC_STACKPROTECTOR_REGULAR=y`, `CONFIG_KERNEL_CC_STACKPROTECTOR_REGULAR=y`), Full Read-Only Relocations (`CONFIG_PKG_RELRO_FULL=y`), and Position-Independent Executables (`CONFIG_PKG_ASLR_PIE_REGULAR=y`).
* **Aggressive Binary Stripping & Reproducible Builds:**
  Uses `sstrip -z` (`CONFIG_USE_SSTRIP=y`, `CONFIG_USE_STRIP=n`) to eliminate superfluous ELF section headers from target binaries, combined with deterministic path remapping (`CONFIG_IREMAP=y`) and kernel dead code elimination requests (`CONFIG_KERNEL_DEAD_CODE_DATA_ELIMINATION=y`).
* **Default CPU Frequency Governor Switched to `schedutil` (`target/linux/mediatek/mt7622/config-6.12`):**
  By default, the `mt7622` target uses the legacy `ondemand` governor, which relies on periodic timer polling and introduces a 10–20 ms ramp-up delay (300 MHz $\rightarrow$ 1.35 GHz) during sudden network traffic bursts. This build enables **`schedutil`** (`CONFIG_CPU_FREQ_DEFAULT_GOV_SCHEDUTIL=y`) as the default kernel governor, scaling CPU frequency directly from the kernel scheduler without polling lag.

### 2. Hardware NAT & Wi-Fi 6 Acceleration (HFO + WED)
* **Hardware Flow Offloading (PPE):**
  Enables the MediaTek **Packet Processing Engine** (`kmod-nft-offload`, `flow_offloading='1'`, `flow_offloading_hw='1'`), handling L3/L4 routing and NAT in hardware at line rate (1 Gbps) with near-zero CPU utilization.
* **Wireless Ethernet Dispatch (`files/etc/modules.conf` $\rightarrow$ `options mt7915e wed_enable=Y`):**
  Enables the hardware **WED** engine for the **MediaTek MT7915E (5 GHz Wi-Fi 6)** radio. Incoming WAN packets are forwarded by the PPE directly into the MT7915E PCIe DMA rings, bypassing the CPU (keeping CPU usage below 5–10% at 850–900 Mbps over Wi-Fi 6).
* **`bridger` Intentionally Excluded by Default:**
  The `bridger` (L2 BPF bridge offload) package is only needed in Dumb AP mode; in standard router mode on `MT7622 + MT7915E`, HFO + WED already accelerates WAN $\leftrightarrow$ LAN/Wi-Fi traffic, whereas `bridger` can cause brief client stalls during 802.11k/v/r Wi-Fi roaming and conflict with `tc`/`nftables` packet filters.

### 3. NVRAM Anti-Brick Protection ("6-Reboot Orange LED Brick" Fix)
* **Why It Matters:** Newer stock U-Boot bootloaders on the Xiaomi AX3200 / Redmi AX6S increment the `flag_try_sys1_failed` counter in the `u-boot-env` partition (`/dev/mtd3`) on every boot. After 6 reboots, stock U-Boot attempts to fail over to the secondary firmware slot (`system 1`), which OpenWrt overwrites with the unified `ubi` partition — resulting in a soft-brick (solid orange LED).
* **Solution (`target/linux/mediatek/mt7622/base-files/etc/init.d/bootcount`):**
  Added automatic NVRAM verification on every boot for the `xiaomi,redmi-router-ax6s` board profile (`flag_try_sys1_failed=0`, `flag_try_sys2_failed=0`, `flag_boot_rootfs=0`, `flag_boot_success=1`, `flag_last_success=1`, `boot_fw1="run boot_rd_img;bootm"`, `boot_wait=on`, `uart_en=1`). `fw_setenv` is only invoked when a value differs from the expected state, preventing unnecessary NAND flash wear.

### 4. Reliable Wi-Fi Initialization & Radio Defaults (`77_wireless` & `99-custom-settings`)
* **Guaranteed 5 GHz Radio Detection on First Boot:**
  In `/etc/init.d/boot`, `/sbin/wifi config` normally runs before `/sbin/kmodloader`. To prevent `uci-defaults` from running before the `mt7915e` PCIe driver finishes probing (a known race condition causing the 5 GHz radio to remain unconfigured after flashing), both `77_wireless` and `99-custom-settings` explicitly invoke `/sbin/wifi config` first.
* **Band-Aware Radio Configuration (`2g` vs `5g`):**
  On the Xiaomi AX3200, `radio0` (`wl0`) is the SoC-integrated **2.4 GHz (802.11n)** radio and `radio1` (`wl1`) is the PCIe **5 GHz MT7915E (802.11ax)** radio. Both scripts dynamically inspect each radio's `band` property and configure:
  * **2.4 GHz (`2g`):** `HT20` mode, channel `1`, `cell_density='0'`.
  * **5 GHz (`5g`):** `HE80` mode (80 MHz), non-DFS channel `36` (avoiding sudden 1–10 minute CAC/DFS radar drop-outs), `cell_density='0'`.
  * **Out-of-the-Box Auto-Generated SSIDs:** Wi-Fi is enabled on first boot with unique SSIDs (`redmi-ax6s-2g-0-<MAC>` and `redmi-ax6s-5g-1-<MAC>`) and the default password **`12345678`**.
* **Full `wpad-mbedtls` Suite:**
  Replaces the stripped-down `basic` variant to support **WPA3 (SAE)** and seamless **802.11k/v/r (Fast Transition)** roaming out of the box.

### 5. Network Stack, SMP/IRQ Balancing & Memory Tuning (256 MB RAM)
* **Dual-Core SMP / RPS / RFS + `irqbalance`:**
  Enables `packet_steering='1'` with `steering_flows='128'` (Receive Flow Steering for the `ucode` `packet-steering.uc` daemon) alongside **`irqbalance`** to distribute Ethernet (`mtk_soc_eth`) and Wi-Fi (`mt7915e`) interrupts evenly across `CPU0` and `CPU1`.
* **Sysctl Network Tuning (`files/etc/sysctl.d/99-bbr.conf`):**
  * **TCP BBR** congestion control (`kmod-tcp-bbr`) + **`fq_codel`** packet scheduler + **TCP FastOpen** (`tcp_fastopen=3`).
  * Expanded conntrack table (`net.netfilter.nf_conntrack_max=32768`) and tuned TCP/UDP session timeouts for heavy P2P/torrent and low-latency gaming workloads.
* **Low-Latency `zram-swap` (`lz4`):**
  Uses **`lz4`** compression (`CONFIG_KERNEL_ZRAM_DEF_COMP_LZ4=y`) for minimal decompression overhead on Cortex-A53, paired with `vm.swappiness=100`, `vm.page-cluster=0`, and `vm.vfs_cache_pressure=50`.

### 6. Official Package Repository Compatibility (`vermagic` + `apk`)
* `vermagic_update.sh` and `scripts/getvermagic.sh` lock the built kernel `vermagic` hash to match the official OpenWrt 25.12.6 release (`685dcedeed3538a4cc670fc3fd59eac1`).
* Uses OpenWrt 25.12's native **`apk` (`apk-mbedtls`)** package manager with `luci-app-package-manager`, allowing users to install any official `kmod-*` kernel module or package without `vermagic` mismatch errors.

### 7. Pre-Installed "Home Router" Package Suite (English & Russian UI)
* **Web UI:** `luci`, `luci-ssl`, `luci-i18n-base-ru` (full Russian and English localization), `Bootstrap`, `OpenWrt-2020`, and `Material` themes.
* **Encrypted DNS (DoH HTTP/2 & HTTP/3):** `https-dns-proxy` + `luci-app-https-dns-proxy` (lightweight C daemon, ~40 KB footprint).
* **Smart Queue Management (SQM / CAKE QoS):** `luci-app-sqm` (`sqm-scripts`, `kmod-sched-cake`) — pre-installed and disabled by default so Hardware Flow Offloading remains active unless the user explicitly enables SQM.
* **Home Network Services:** `luci-app-upnp` (`miniupnpd-nftables`), `luci-app-ddns`, `luci-app-wol` (`etherwake`), `luci-app-watchcat`, `luci-app-wifischedule`, `luci-app-usteer` (802.11k/v/r roaming controller), `luci-app-uhttpd`.
* **Monitoring & Diagnostics:** `luci-app-nlbwmon` (per-client traffic accounting), `luci-app-statistics` (`collectd` graphs for CPU, RAM, interfaces, Wi-Fi, and MT7915E thermal sensor), `luci-app-ttyd` (web terminal), and CLI utilities (`htop`, `nano`, `curl`, `iperf3`, `ethtool`, `tcpdump-mini`, `bind-dig`, `mtr-nojson`).

---

## Quick Build Instructions for Xiaomi AX3200 / Redmi AX6S

The repository root includes the seed configuration [`ax3200.config`](ax3200.config) (generated via `./scripts/diffconfig.sh`) and the custom rootfs overlay [`files/`](files/).

> **Note on `make defconfig` in OpenWrt:** Unlike the mainline Linux kernel build system, running `make defconfig` in OpenWrt does **not** reset an existing `.config` to default values. Instead, it reads the short seed configuration copied to `.config` and expands all dependent Kconfig symbols around your selections.

```bash
# 1. Update and install package feeds
./scripts/feeds update -a
./scripts/feeds install -a

# 2. Load the AX3200 seed configuration and expand full dependencies
cp ax3200.config .config
make defconfig

# 3. Refresh official kernel vermagic (when upgrading to a newer 25.12.x point release)
./vermagic_update.sh mediatek mt7622

# 4. Download sources and compile firmware
make download -j$(nproc)
make -j$(nproc)
```

Compiled firmware images are placed in `bin/targets/mediatek/mt7622/`:
* `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-factory.bin` — initial factory image for flashing from stock firmware.
* `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-squashfs-sysupgrade.itb` — standard sysupgrade image for upgrading from OpenWrt 24.10 / 25.12.
* `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-ubi-loader.itb` — second-stage UBI loader image.
* `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-initramfs-recovery.itb` — TFTP recovery image.

*(If upgrading from an older build that rejects FIT `itb` validation, you can extract the raw `sysupgrade.ubi` image directly from `factory.bin` via: `dd if=openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-factory.bin of=sysupgrade.ubi bs=512K skip=1`).*

---

## Automated One-Step Build via `build.sh`

For a fully automated build from scratch, a standalone script [`build.sh`](build.sh) is provided in the repository root. It handles system dependency installation via `apt`, updates package feeds, applies `ax3200.config`, synchronizes kernel `vermagic`, compiles firmware using all CPU cores, extracts the raw `sysupgrade.ubi` image, and verifies `sha256sums`.

### 1. Fresh System Setup (Ubuntu 24.04 / 26.04 LTS or Debian)

On a freshly installed system, clone the branch and run the script with `--install-deps`:

```bash
# Clone the repository
git clone -b xq-25.12 https://github.com/Dreyk007/openwrt.git
cd openwrt

# Install all build prerequisites via apt and build firmware
./build.sh --install-deps
```

### 2. Subsequent Builds

If prerequisites are already installed, run `build.sh` directly:

```bash
# Build using all available CPU threads
./build.sh

# Or specify custom parallel jobs (e.g., -j4)
./build.sh -j4
```

---

## About OpenWrt Project

OpenWrt Project is a Linux operating system targeting embedded devices. Instead
of trying to create a single, static firmware, OpenWrt provides a fully
writable filesystem with package management. This frees you from the
application selection and configuration provided by the vendor and allows you
to customize the device through the use of packages to suit any application.
For developers, OpenWrt is the framework to build an application without having
to build a complete firmware around it; for users this means the ability for
full customization, to use the device in ways never envisioned.

### Support & Documentation

* [Xiaomi AX3200 / Redmi AX6S OpenWrt Wiki](https://openwrt.org/toh/xiaomi/ax3200)
* [OpenWrt Firmware Selector](https://firmware-selector.openwrt.org/)
* [Developer Documentation](https://openwrt.org/docs/guide-developer/start)

## License

OpenWrt is licensed under GPL-2.0
