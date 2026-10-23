![OpenWrt logo](include/logo.png)

**English** | [Русский](README.ru.md)

# OpenWrt 25.12 (`xq-25.12`) — Optimized Custom Build for Xiaomi AX3200 / Redmi AX6S

This repository (branch **`xq-25.12`**) is a fork of the stable **OpenWrt 25.12.6** release (`Linux 6.12.112`) tailored for the **Xiaomi Router AX3200 (RB01) / Redmi Router AX6S (RB03)** built on the **MediaTek MT7622B + MT7531BE + MT7915E** platform (it also carries the MediaTek changes from the `remittor` tree).

The goal of the build is **line-rate 1 Gbps wired and Wi-Fi 6 throughput, low latency, U-Boot NVRAM anti-brick protection and a complete out-of-the-box home router feature set**, while staying compatible with the official OpenWrt package repository.

> [!WARNING]
> Wi-Fi is **enabled on first boot with the public default password `12345678`** and the web interface has **no root password**. Set both right after flashing (LuCI → *System → Administration* and *Network → Wireless*).

**Contents:** [Key changes](#key-changes) · [SQM or hardware offloading?](#sqm-or-hardware-offloading) · [Wi-Fi 160 MHz and VR](#wi-fi-at-160-mhz-he160-and-vr-streaming) · [Pre-installed packages](#pre-installed-packages) · [Installation](#installation) · [Building](#building) · [Updating to a new release](UPGRADING.md) · [Research and measurements](RESEARCH.md)

---

## Key Changes

### 1. Compiler and CPU (`ARM Cortex-A53`)
* **OpenWrt GCC 15.2.0 toolchain** (`CONFIG_GCC_USE_VERSION_15=y`) instead of the default GCC 14.3, with better instruction scheduling for the in-order Cortex-A53 pipeline (~241 KB smaller compressed SquashFS).
* **Compiler flags `-O2 -pipe -mcpu=cortex-a53+crypto+crc`:** upstream builds use `-Os`, which disables function/loop/jump alignment. The AX3200 has 128 MB of NAND, so this build trades size for speed with `-O2` and enables the ARMv8 **Crypto Extensions (AES, SHA1/SHA2, GHASH)** and **CRC32** instructions.
* **Link-Time Optimization** (`CONFIG_USE_LTO=y`) and **dead code/data elimination** (`CONFIG_USE_GC_SECTIONS=y`) for userland packages.
* **`FORTIFY_SOURCE=2`** (`CONFIG_PKG_FORTIFY_SOURCE_2=y`) instead of the default level 1. The other hardening options (stack protector for userland and kernel, full RELRO, PIE) and `sstrip -z` binary stripping are OpenWrt defaults and are kept as is.
* **`schedutil` CPU frequency governor** by default (`target/linux/mediatek/mt7622/config-6.12`) instead of `ondemand`. `ondemand` samples the load periodically and ramps up the clock (437.5 MHz → 1.35 GHz) with a delay on traffic bursts; `schedutil` scales the frequency directly from the scheduler. Measured on the device at idle: 3.8 % CPU load with `schedutil` vs 6.0 % with `ondemand`.
* **`performance` governor (optional):** keeps the CPU at 1.35 GHz all the time. Compared with `schedutil` it needs less CPU for the same traffic on the paths the CPU handles (−28 % per Gbit/s on Wi-Fi → LAN bridging) and lowers the idle Wi-Fi round-trip time by about 0.2 ms (1.60 → 1.42 ms median), but the throughput (limited by Wi-Fi) and the latency under load stay the same, and the router runs about 2 °C warmer. `schedutil` therefore stays the default. Switch in LuCI → *System → CPU Frequency* (`luci-app-cpufreq`, part of this build): the choice is applied immediately and at every boot and is kept across upgrades. Details: [RESEARCH.md](RESEARCH.md#5-cpu-frequency-governor).

### 2. Hardware NAT and Wi-Fi 6 Acceleration (HFO + WED)
* **Hardware Flow Offloading (PPE):** the MediaTek **Packet Processing Engine** (`kmod-nft-offload`, `flow_offloading='1'`, `flow_offloading_hw='1'`) handles routing and NAT of established flows in hardware at line rate with almost no CPU load.
* **Wireless Ethernet Dispatch** (`files/etc/modules.conf`: `options mt7915e wed_enable=Y`): offloaded WAN traffic is forwarded by the PPE directly into the DMA rings of the **MT7915E (5 GHz Wi-Fi 6)** radio, bypassing the CPU. The MT7622 has no WED RX, so only WAN → Wi-Fi traffic bypasses the CPU this way; Wi-Fi → WAN traffic is forwarded by the CPU through the software flow offload path.
* **`bridger` is not included:** it is only useful in dumb AP mode. In router mode HFO + WED already accelerate WAN ↔ LAN/Wi-Fi traffic, while `bridger` can cause short client stalls during 802.11k/v/r roaming and conflicts with `tc`/`nftables` filters.
* **Correct flow accounting with HFO:** the per-client statistics of `nlbwmon` are based on the conntrack counters, which for hardware-offloaded flows come from the PPE. Two kernel patches make them correct:
  * `target/linux/mediatek/patches-6.12/970-net-ethernet-mtk_ppe-fix-flow-accounting-on-unbind-and-rebind.patch` fixes the PPE flow counters when a flow is unbound or re-bound. Without it the counters jumped by ~4 GB (2³²) each time, and the traffic since the last poll was lost when the PPE unbound a flow by itself after a TCP FIN.
  * `target/linux/mediatek/patches-6.12/971-netfilter-flowtable-fetch-hardware-counters-before-removing-a-flow.patch` makes the kernel read the hardware counters of a flow one last time before removing it; otherwise they are only polled every ~3 s.

  Without them, connections that close right after a transfer were undercounted: a 300 MiB download was counted at 50–86%, 30 downloads of 10 MiB at 4%. With them every test is counted at 105% of the payload (the payload plus TCP/IP headers).
* **Interface counters with HFO:** offloaded traffic bypasses the CPU, so the software counters of the network interfaces never see it. The backported kernel patches `target/linux/generic/backport-6.12/799-0*-net-dsa-mt7530-*.patch` (`.get_stats64` from Linux 6.16 and its fix from 7.1) report the hardware counters of the switch ports as the statistics of `wan` and `lan1`–`lan3` instead, so the `wan` graph in *Statistics*, the LuCI realtime traffic graphs and `ip -s link` show the real traffic. `br-lan` (offloaded traffic never passes the software bridge) and the Wi-Fi interfaces (WED) still count only traffic handled by the CPU.
* HFO bypasses the Linux queueing layer, so it cannot be combined with SQM — see [SQM or hardware offloading?](#sqm-or-hardware-offloading).

### 3. NVRAM Anti-Brick Protection ("6 reboots → orange LED" fix)
* **Problem:** newer stock U-Boot versions increment `flag_try_sys1_failed` in `u-boot-env` (`/dev/mtd3`) on every boot. After 6 reboots U-Boot fails over to the secondary firmware slot (`system 1`), which OpenWrt has overwritten with its unified UBI partition — the router soft-bricks with a solid orange LED.
* **Solution** (`target/linux/mediatek/mt7622/base-files/etc/init.d/bootcount`): on every boot the values below are checked and `fw_setenv` is called only for values that differ (no needless NAND writes):
  * `flag_try_sys1_failed=0`, `flag_try_sys2_failed=0`, `flag_boot_rootfs=0`, `flag_boot_success=1`, `flag_last_success=1`, `boot_fw1="run boot_rd_img;bootm"` — the anti-brick part;
  * `boot_wait=on` and `uart_en=1` — keep TFTP recovery and the U-Boot serial console usable. Both require physical access to the router.
  * `ssh_en` (only used by the stock firmware) is not touched.

### 4. Wi-Fi Defaults (`77_wireless`)
* **Reliable 5 GHz detection on first boot:** `77_wireless` runs `/sbin/wifi config` before configuring the radios, so the `mt7915e` PCIe radio is present in `/etc/config/wireless` even if it finished probing late.
* `radio0` is the SoC-integrated **2.4 GHz (802.11n)** radio, `radio1` is the PCIe **5 GHz MT7915E (802.11ax)** radio. Each radio is configured by its `band`:
  * **Regulatory domain:** country `PA` for both radios (`CONFIG_PACKAGE_MAC80211_COUNTRY="PA"`). It allows more channels and higher transmit power than many other domains; set your own country in LuCI if local regulations require it.
  * **2.4 GHz:** `HT20`, channel `1`, WPA2 (`psk2+ccmp`) for the best IoT compatibility.
  * **5 GHz:** `HE80`, non-DFS channel `36` (no 1–10 minute DFS/CAC radar drop-outs), `noscan='1'`, WPA2/WPA3 mixed mode (`sae-mixed`), `wnm_sleep_mode='1'`, `wnm_sleep_mode_no_keys='1'`, `dtim_period='3'`, `ocv='0'` (SAE client compatibility).
  * **SSIDs:** `<board>-<band>-<radio><last 4 hex digits of the MAC>`, e.g. `redmi-router-ax6s-2g-0a1b2` and `redmi-router-ax6s-5g-1a1b2`; password **`12345678`**.
* Settings are applied only if the radio has no Wi-Fi key yet, so they never overwrite a restored configuration.
* **Full `wpad-mbedtls`** instead of `wpad-basic-mbedtls`, OpenWrt's default for this router. The basic variant already supports WPA3 (SAE), 802.11r and 802.11k; the full one adds 802.11v (WNM), which the WNM-Sleep Mode of the 5 GHz defaults above needs, as well as WPS, WPA2/WPA3-Enterprise (802.1X, built-in RADIUS server), 802.11s mesh and Wi-Fi Easy Connect (DPP). Fast roaming (802.11k/v/r) stays off, as in stock OpenWrt: it only matters when several access points share one SSID. For such a network enable it in the wireless settings and install `usteer` (`apk add usteer luci-app-usteer`).
* **Wi-Fi driver fixes from mt76 master** (`package/kernel/mt76/patches/0300…0317`, 18 patches on top of the mt76 of OpenWrt 25.12): kernel crashes around client connects and disconnects and around the recovery of the radio firmware, TX aggregation for voice-priority traffic on 5 GHz, correct HE DCM / VHT STBC client capabilities. On 2.4 GHz the adaptive sensitivity (SCS) of the MT7622 works again: a driver bug kept it at its default since 2022. On the busy 2.4 GHz channel of the test setup it halved the time the radio considered the channel busy (31 → 15 %) and reduced ping loss to the clients. The threshold never goes above the weakest connected client; details in [RESEARCH.md](RESEARCH.md#10-wi-fi-driver-fixes-from-mt76-master).

### 5. Network Stack and Memory (256 MB RAM)
* **Packet steering** (`packet_steering='1'`, `steering_flows='128'`): pins the threaded NAPI workers of the Ethernet (`mtk_eth`) and Wi-Fi (`mt76`) drivers to different CPU cores and enables RPS + RFS with 128 flows. `irqbalance` is intentionally not installed: with threaded NAPI the packet processing runs in the threads that packet steering already distributes, while irqbalance only moves the IRQ top halves — without knowing where those threads are pinned, so it can split the Ethernet TX/RX IRQs away from their NAPI CPU. It can still be added with `apk add irqbalance`.
* **Sysctl tuning** (`files/etc/sysctl.d/99-bbr.conf`):
  * **TCP BBR**, `fq_codel` and TCP Fast Open (`tcp_fastopen=3`). They apply to TCP connections terminated on the router itself (LuCI, DoH proxy, `iperf3` server, package downloads), not to traffic forwarded for LAN clients. `fq_codel` is the OpenWrt default qdisc anyway.
  * Larger conntrack table (`nf_conntrack_max=32768`) and adjusted TCP/UDP timeouts for P2P and gaming.
  * Global RFS socket flow table (`net.core.rps_sock_flow_entries=1024`). OpenWrt's packet steering only sets the per-queue flow count (`steering_flows`); without this table RFS stays inactive. It affects only traffic terminated on the router itself.
* **Stealth firewall:** `input`/`forward` policies of the defaults and the `wan` zone are `DROP` instead of `REJECT`, plus `drop_invalid='1'`. SSH (`dropbear`) listens only on the LAN interface (`Interface='lan'`).
* **LAN NTP server** (`system.ntp.enable_server='1'`).
* **`zram-swap` 120 MB with `lz4`** (`CONFIG_KERNEL_ZRAM_DEF_COMP_LZ4=y`) and `vm.swappiness=100`, `vm.page-cluster=0`, `vm.vfs_cache_pressure=50`.
* **Services are restarted indefinitely** after crashes (procd `respawn_retry='0'`); `https-dns-proxy` tolerates WAN reconnects (`conn_loss_time='30'`).

### 6. How the Defaults Are Applied (`99-custom-settings`)
`uci-defaults` scripts run on the first boot after **every** flash, including a sysupgrade that keeps settings. `files/etc/uci-defaults/99-custom-settings` applies the settings from sections 2 and 5 and the DoH, statistics and LuCI theme defaults (see [Pre-installed packages](#pre-installed-packages)) **only once per configuration** and stores a marker in `/etc/config/ax3200`. Your own changes (for example HFO disabled in favour of SQM) are therefore preserved across upgrades. Only removing the collectd include of older builds runs on every flash. The list of LuCI themes is brought in line with the installed themes on every boot (`files/etc/init.d/luci-themes`), so this also works after restoring a settings backup made on another firmware. To re-apply the build defaults:
```sh
uci -q delete ax3200.defaults && uci commit ax3200
sh /rom/etc/uci-defaults/99-custom-settings
reboot
```

### 7. Official Package Repository Compatibility (`vermagic` + `apk`)
* `vermagic_update.sh` downloads the kernel `vermagic` of the official OpenWrt 25.12.6 release (`685dcedeed3538a4cc670fc3fd59eac1`) and `scripts/getvermagic.sh` builds the kernel with it, so `kmod-*` packages from the official repository install without `vermagic` mismatch errors.
* **The kernel configuration matches the official one.** A matching `vermagic` is not enough on its own: an official module only works if every kernel structure it uses has the same layout. The official buildbot builds with `CONFIG_ALL_KMODS=y` and without `KALLSYMS`, which changes `struct module`, `net_device`, `struct net` and `sk_buff`. This build does the same (`CONFIG_ALL_KMODS=y`, `# CONFIG_KERNEL_KALLSYMS is not set`), so its kernel `.config` differs from the one in the official SDK only in the GCC version, the `schedutil` default governor and the zram compression backends — none of them affects the module ABI.
* **Verified on the device:** the official `kmod-dummy` and `kmod-wireguard` (with the NEON-accelerated ChaCha20/Poly1305 modules) load and work; a WireGuard tunnel carried ~2 GiB at 530–600 Mbit/s without kernel errors.
* `ALL_KMODS` only builds all kernel modules into `bin/`; the firmware contains just the selected ones. Without `KALLSYMS` the kernel is ~260 KiB smaller in flash and ~0.7 MiB smaller in RAM, and kernel oops traces show addresses instead of function names (as in official images).
* Packages are managed with OpenWrt 25.12's native **`apk`** (`apk-mbedtls`) and `luci-app-package-manager`.

---

## SQM or Hardware Offloading?

**SQM** (`luci-app-sqm`, CAKE) fights **bufferbloat** — latency spikes when the link is saturated (calls, games and browsing lag while something downloads or uploads). It needs to see every packet. **Hardware flow offloading (HFO)** moves established flows into the PPE, past the Linux queueing layer, so **SQM does nothing while HFO is enabled**. Without HFO, WED does not work either, and all routed and Wi-Fi traffic is handled by the CPU.

| | HFO + WED (default) | SQM (CAKE) |
|---|---|---|
| Max routed throughput | ~1 Gbps, almost no CPU load | CPU-bound; on MT7622 users report roughly 500–600 Mbps with CAKE |
| Latency under load | depends on the ISP / modem buffers | low and stable |
| Best for | fast links (≳ 500 Mbps), links without bufferbloat | slower or asymmetric links: DSL, LTE/5G, cable, PPPoE below ~300–500 Mbps |

**How to choose:** run a bufferbloat test (e.g. Waveform "Bufferbloat Test") over a wired connection with the default settings. If latency under load stays low (grade A/B), keep HFO. If it grows by tens or hundreds of milliseconds and your plan is below ~500 Mbps, switch to SQM.

**Switch to SQM:**
1. LuCI → *Network → Firewall → General Settings* → *Routing/NAT Offloading* → *Flow offloading type*: select **None** (or **Software flow offloading**; it is generally reported to coexist with SQM — check that the CAKE counters of `ifb4…` and the WAN device in `tc -s qdisc` grow under load). *Save & Apply*.
2. LuCI → *Network → SQM QoS*: enable it on the WAN interface (`wan`, or `pppoe-wan` for PPPoE), qdisc `cake`, script `piece_of_cake.qos`, and set download/upload to ~85–95 % of the speeds measured without SQM. *Save & Apply*, then repeat the test.

**Back to HFO:** disable SQM and set *Flow offloading type* to *Hardware flow offloading* again.

The choice is kept across sysupgrades (see [section 6](#6-how-the-defaults-are-applied-99-custom-settings)).

---

## Wi-Fi at 160 MHz (HE160) and VR Streaming

The 5 GHz radio defaults to **HE80 on channel 36** for the widest client compatibility. The MT7915E also supports **160 MHz (HE160)**, which doubles the link rate of the usual 2×2 clients (phones, laptops, VR headsets): up to 2402 Mbit/s instead of 1201 Mbit/s. At 160 MHz the radio uses 2 spatial streams instead of 4, so 3×3/4×4 clients gain less.

With the `PA` regulatory domain the 5470–5725 MHz band (channels 100–128) allows 160 MHz **without DFS**: no 1-minute channel availability check after boot and no channel switches on radar detection.

Trade-offs:
* clients that do not support channels 100–144 will not see the 5 GHz network;
* slightly shorter range at the edge of coverage (the same power is spread over twice the bandwidth);
* outside Panama these channels are usually subject to DFS rules — check your local regulations.

Enable it in LuCI → *Network → Wireless* → 5 GHz radio → *Edit* → *Operating frequency*: mode **AX**, channel **100**, width **160 MHz** → *Save & Apply*, or over SSH:
```sh
uci set wireless.radio1.channel='100'
uci set wireless.radio1.htmode='HE160'
uci commit wireless
wifi reload
```
`iwinfo wl1-ap0 info` then shows `HT Mode: HE160`. To go back to the default, set channel `36` and `HE80`.

**PC VR streaming** (Virtual Desktop, Steam Link, Air Link) benefits most from HE160 — provided the headset supports 160 MHz on 5 GHz (check its specifications; support depends on the model and its firmware):
* connect the PC to a LAN port with a cable, so that there is only one wireless hop;
* keep the headset in the same room as the router, ideally with line of sight;
* connect the headset to the 5 GHz network only;
* the PC ↔ headset traffic is bridged inside the LAN and handled by the CPU (HFO and WED only accelerate routed WAN traffic, SQM does not apply to it); VR streams of a few hundred Mbit/s are well within its capacity.

---

## Pre-installed Packages
* **Web UI:** `luci`, `luci-ssl`, full Russian and English localization (`CONFIG_LUCI_LANG_ru=y`; the language follows the browser). Themes: **Footstrap** (default) — the new LuCI theme with a collapsible sidebar or top bar, light/dark modes, a menu search and an *Appearance* page for colours, density, layout and wallpaper — and the stock **Bootstrap**. After an upgrade from an older build or after restoring a settings backup made on another firmware, Footstrap is listed again and a removed theme (OpenWrt-2020, Material) is replaced with Footstrap automatically.
* **Encrypted DNS (DoH, HTTP/2 & HTTP/3):** `https-dns-proxy` + `luci-app-https-dns-proxy` (Cloudflare and Google out of the box). Clients are not forced to use the router's DNS (`force_dns='0'`), so client-side encrypted DNS such as Android Private DNS (DoT) keeps working.
* **SQM / CAKE QoS:** `luci-app-sqm` (`sqm-scripts`, `kmod-sched-cake`) — installed but **disabled** by default.
* **Home network services:** `luci-app-upnp` (`miniupnpd-nftables`), `luci-app-ddns` (with a LuCI fix from `feeds-patches/luci/`: without internet its status no longer leaves LuCI's Overview empty for 10 s per DDNS service, the two disabled examples included; its autostart is off while no DDNS service is enabled: set up a service, then *Services → Dynamic DNS → Start DDNS*), `luci-app-wol` (`etherwake`), `luci-app-watchcat`, `luci-app-wifischedule`, `luci-app-uhttpd`, `luci-app-cpufreq` (CPU frequency governor, *System → CPU Frequency*; a package of this build in `package/ax3200/`).
* **Monitoring and diagnostics:** `luci-app-nlbwmon` (per-client traffic accounting), `luci-app-statistics` (`collectd` graphs of CPU load and frequency, RAM, `br-lan`/`wan`, Wi-Fi, conntrack, hardware sensors and the MT7915E temperature; the `wan` graph includes offloaded traffic, see [Interface counters with HFO](#2-hardware-nat-and-wi-fi-6-acceleration-hfo--wed)), `luci-app-ttyd` (web terminal), CLI tools `htop`, `nano`, `curl`, `iperf3`, `ethtool`, `tcpdump-mini`, `bind-dig`, `mtr-nojson`.

---

## Installation

> [!IMPORTANT]
> Read the [OpenWrt wiki page for the Xiaomi AX3200 / Redmi AX6S](https://openwrt.org/toh/xiaomi/ax3200) first. It covers **backing up the flash partitions**, **TFTP and UART recovery** and hardware-revision specific issues that are not repeated here. Flashing third-party firmware is at your own risk.

**Known risks (from the wiki):**
* Some newer units have MTD partitions shifted by `-0x20000` and can brick on sysupgrade; on others even the factory image may fail. AX3200 units produced **after 12/2023** with telnet disabled are reported to be affected. Before the first sysupgrade of a unit installed from `factory.bin`, run the checks from the wiki ("Known Issue #1"): `hexdump /dev/mtd8 | head` must start with `0000000 0dd0 edfe`, and `fw_printenv | grep -e ^flag_try -e ^boot_fw` must show `boot_fw1=run boot_rd_img;bootm`.
* The "6 reboots → orange LED" soft-brick is prevented by this build's `bootcount` once OpenWrt has booted (see [section 3](#3-nvram-anti-brick-protection-6-reboots--orange-led-fix)).

### Firmware Images
Built images are placed in `bin/targets/mediatek/mt7622/`:
| File | Purpose |
|---|---|
| `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-factory.bin` | First installation from the stock firmware (or from OpenWrt ≤ 23.05). Contains `ubi-loader` padded to 512 KiB followed by the UBI image. |
| `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-squashfs-sysupgrade.itb` | Regular upgrade from OpenWrt 24.10 / 25.12 (UBI layout). |
| `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-sysupgrade.ubi` | Raw UBI image extracted from `factory.bin` by `build.sh`, for older builds that reject the `.itb` (see below). |
| `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-ubi-loader.itb` | Second-stage U-Boot (`ubi-loader`) alone. |
| `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-initramfs-recovery.itb` | Initramfs recovery image (TFTP). |

### A. From the Stock Firmware with XMiR-Patcher (recommended)
[XMiR-Patcher](https://github.com/openwrt-xiaomi/xmir-patcher) uses a vulnerability in the stock web interface to get SSH access and flashes the firmware for you. It works on Windows, Linux and macOS.

1. Finish the initial setup of the stock firmware (the web interface password is required) and connect your PC to a **LAN** port of the router. The stock firmware is at `192.168.31.1`.
2. Download XMiR-Patcher (*Code → Download ZIP*) and unpack it.
3. Start it: **Windows** — `run.bat`; **Linux/macOS** — install Python 3.8+ and `openssl`, then `./run.sh`.
4. If the router is not at `192.168.31.1`, choose `1 - Set IP-address`.
5. Choose **`2 - Connect to device (install exploit)`** and enter the web interface password when asked.
6. Choose **`4 - Create full backup`**. The dumps of all flash partitions are saved to the `backups/` folder of XMiR-Patcher — **keep them safe**: they contain the factory calibration data unique to your unit and are needed to return to stock or recover from a brick.
7. Copy **only** `openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-factory.bin` into the `firmware/` folder of XMiR-Patcher (no other images in that folder).
8. Choose **`7 - Install firmware (from directory "firmware")`** and wait until the router reboots.
9. Open `http://192.168.1.1` (user `root`, no password), set a root password and change the Wi-Fi password.

If the exploit does not work with your stock firmware version, see the wiki for the alternatives (stock firmware with telnet, `netmode 4` methods, UART).

### B. Upgrade from OpenWrt 24.10 / 25.12
LuCI → *System → Backup / Flash Firmware → Flash new firmware image* with the `...-squashfs-sysupgrade.itb` file, or over SSH:
```sh
sysupgrade /tmp/openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-squashfs-sysupgrade.itb
```

### C. Upgrade from OpenWrt 23.05 or Older (old flash layout)
24.10 changed the flash layout (`ubi-loader` + UBI), so sysupgrade from 23.05 is not possible. Install `factory.bin` with `mtd` as described in the wiki ("24.10 UBI layout", method 1). The configuration is reset — make a backup first. After restoring a 23.05 backup, run:
```sh
uci set system.@system[0].compat_version="2.0"
uci commit system
```

### D. Older Builds That Reject the `.itb` Image
Some older third-party 24.10 builds refuse the FIT image with `Cannot find ubinized rootfs in the factory FIT-image`. Flash the raw UBI image instead (`build.sh` creates it; manually: `dd if=openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-factory.bin of=sysupgrade.ubi bs=512K skip=1`). Copy it to `/tmp/` on the router and run (settings are not kept):
```sh
sysupgrade -n /tmp/openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-sysupgrade.ubi
```

### E. Updating `ubi-loader` (optional)
`sysupgrade` does not touch the `ubi-loader` partition. To update it to the version from this build:
```sh
mtd write /tmp/openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-ubi-loader.itb ubi-loader
reboot
```

### Backup and Recovery
Backing up the flash partitions, TFTP recovery and UART access are described on the [OpenWrt wiki page](https://openwrt.org/toh/xiaomi/ax3200).

---

## Building

The repository root contains the seed configuration [`ax3200.config`](ax3200.config) (generated with `./scripts/diffconfig.sh`) and the rootfs overlay [`files/`](files/).

### Automated Build with `build.sh`
[`build.sh`](build.sh) installs the build dependencies (optional, `apt`), updates the feeds, patches feed packages with `feeds-patches/<feed>/*.patch`, applies `ax3200.config`, synchronizes the kernel `vermagic` (the build stops if this fails), compiles the firmware, extracts `sysupgrade.ubi` (checking the `factory.bin` layout) and writes `sha256sums`.

Because of `CONFIG_ALL_KMODS=y` (see [section 7](#7-official-package-repository-compatibility-vermagic--apk)) all ~1100 kernel module packages are built: the first build takes noticeably longer and `bin/` grows to ~140 MB, while the firmware contains only the selected modules. `kmod-rtl8812au-ct` is excluded because it does not build with GCC 15 (the AX6S has no USB port).

On a fresh Ubuntu 24.04 / 26.04 LTS or Debian system:
```bash
git clone -b xq-25.12 https://github.com/Dreyk007/openwrt.git
cd openwrt
./build.sh --install-deps
```
Subsequent builds:
```bash
./build.sh        # all CPU threads
./build.sh -j4    # custom number of parallel jobs
```

### Build and Release with GitHub Actions
The workflow [`.github/workflows/build-ax3200.yml`](.github/workflows/build-ax3200.yml) runs `build.sh --install-deps` on a GitHub-hosted runner (Ubuntu 26.04 by default) and publishes the files of `bin/targets/mediatek/mt7622/` — the same images, `sha256sums` and buildinfo files as a local build — as a GitHub release. It only runs on demand: *Actions → Build AX3200 firmware → Run workflow*. Options:
* **Release tag** — empty for the next `v<OpenWrt version>-ax3200-r<N>`;
* **Publish as a pre-release**;
* **Runner image** — `ubuntu-26.04`, or `ubuntu-24.04` as a fallback.

A full build takes a few hours on the 4-core runner; the source downloads (`dl/`) are cached between runs. If the build fails, its log is attached to the run as the `build-log` artifact.

**Verifying a download.** The workflow signs a build provenance attestation for every published file ([`actions/attest`](https://github.com/actions/attest), Sigstore): it ties the file's SHA256 to the workflow run and the commit it was built from, and it is recorded in a public transparency log, so it cannot be produced for a file that this workflow did not build. The releases are immutable, so their files and tags cannot be replaced after publication either. Check a downloaded image with the [GitHub CLI](https://cli.github.com/):
```bash
gh attestation verify openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-squashfs-sysupgrade.itb --repo Dreyk007/openwrt
gh release verify-asset <release tag> openwrt-mediatek-mt7622-xiaomi_redmi-router-ax6s-squashfs-sysupgrade.itb --repo Dreyk007/openwrt
```

> The repository also carries OpenWrt's own CI workflows (`kernel.yml`, `packages.yml`, `toolchain.yml`, `github-release.yml`, …). They are meant for openwrt/openwrt: after enabling Actions in the fork, disable them (*Actions → workflow → ⋯ → Disable workflow*, or `gh workflow disable <file>`), otherwise pushes and `v*` tags trigger them.

### Manual Build
```bash
# 1. Update and install package feeds
./scripts/feeds update -a
./scripts/feeds install -a

# 2. Load the AX3200 seed configuration and expand all dependencies
cp ax3200.config .config
make defconfig

# 3. Fetch the official kernel vermagic (required after switching to a new 25.12.x release)
./vermagic_update.sh mediatek mt7622

# 4. Download sources and compile
make download -j$(nproc)
make -j$(nproc)
```

> **Note:** unlike the Linux kernel, `make defconfig` in OpenWrt does **not** reset `.config` to defaults — it expands the short seed copied to `.config` with all dependent symbols.

### Changing the Configuration
Edit the configuration with `make menuconfig` and save the result back as a seed — do not edit `ax3200.config` by hand. Keep `CONFIG_ALL_KMODS=y` and `# CONFIG_KERNEL_KALLSYMS is not set`: they are required for official kmod compatibility.
```bash
cp ax3200.config .config && make defconfig
make menuconfig
./scripts/diffconfig.sh > ax3200.config
```

### Updating to a New OpenWrt Release
[UPGRADING.md](UPGRADING.md) describes in detail how to merge a new minor release (e.g. 25.12.7) into this branch and how to port the build to a new major release, including the vermagic update, the kernel configuration parity check against the official SDK and the on-device verification.

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
* [XMiR-Patcher](https://github.com/openwrt-xiaomi/xmir-patcher)
* [OpenWrt Firmware Selector](https://firmware-selector.openwrt.org/)
* [Developer Documentation](https://openwrt.org/docs/guide-developer/start)

## License

OpenWrt is licensed under GPL-2.0
