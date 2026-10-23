# Research and Measurements

The measurements behind the decisions of this build, taken in October 2026 on a Redmi AX6S running OpenWrt 25.12.6 (`xq-25.12`) with a real home configuration. Each section ends with the decision it led to.

**Contents:** [Test setup](#test-setup) · [1. irqbalance](#1-irqbalance-vs-packet-steering) · [2. Official kmods](#2-official-kmod-compatibility) · [3. Traffic accounting](#3-traffic-accounting-with-hardware-offloading) · [4. Interface counters](#4-interface-counters-with-hardware-offloading) · [5. CPU governor](#5-cpu-frequency-governor) · [6. Latency](#6-latency-and-jitter) · [7. Kernel hardening](#7-cost-of-kernel-hardening) · [8. Extreme build](#8-extreme-build-experiment-dropped) · [9. WAN bufferbloat](#9-wan-bufferbloat-and-the-need-for-sqm)

## Test setup

* **Router:** HFO + WED on, 5 GHz HE160 on channel 100, 2.4 GHz HT20, packet steering, LuCI, statistics, nlbwmon, DoH, UPnP, watchcat.
* **Wi-Fi client:** a laptop with Intel Wi-Fi 6 (2×2, HE160, −42 dBm), or a VM on it behind NAT. **Wired:** a PC on `lan1` (1 Gbit/s).
* **Tools:** `iperf3` (15 s per run), `irtt` (UDP probes every 10 ms for 25 s), router CPU from `/proc/stat` during each run (the share of both cores, so 100 % means both are busy), `nlbw -c csv` deltas for accounting.
* **Pitfalls of the method:**
  * The Wi-Fi link changes after every reconnect (e.g. HE-MCS 3 vs 9 after a router reflash), so firmwares or settings are compared only in interleaved runs on one connection.
  * The client's Wi-Fi power save adds latency spikes of tens of ms: switch it off for latency tests (`iw dev <wlan> set power_save off`).
  * nlbwmon zeroes the conntrack counters on every dump: measure accounting through `nlbw` deltas after more than 30 s (its refresh interval), never through `/proc/net/nf_conntrack`.
  * CPU per Gbit/s is only comparable at similar throughput: when Wi-Fi throughput drops, the CPU load stays about the same and the ratio inflates.
  * Some public test servers block a client after heavy use (proof.ovh.net did after ~12 GB). Spread the load.
  * Do not ping the ISP gateway at a high rate: it rate-limits ICMP (64 % loss at 50 pings/s) and then also holds back transit ICMP for ~0.9 s, which looks like a stall of the whole connection. Ping external hosts instead (1.1.1.1, 8.8.8.8: no stalls at 100 pings/s).

## 1. irqbalance vs packet steering

A/B with `irqbalance` and with packet steering only (both directions, 4 streams, 20 s):

| | with `irqbalance` | packet steering only |
|---|---|---|
| Wi-Fi throughput | 1301 / 902 Mbit/s | 1228 / 925 Mbit/s (Wi-Fi noise) |
| Wired throughput | ~933 Mbit/s | ~933 Mbit/s |
| CPU load | equal within 1.5 % | equal within 1.5 % |
| IPIs per GB | — | 33–39 % fewer |

`irqbalance` always moves the RX interrupt of `mtk_eth` to CPU1, while packet steering pins both `napi/mtk_eth-*` threads to CPU0, which causes cross-core wakeups and gains nothing. **Decision:** no `irqbalance`.

## 2. Official kmod compatibility

* With the official vermagic, official kmods installed but were rejected by the kernel: `struct module` was 704 bytes here and 640 in the official build, which disables `KALLSYMS`.
* Disabling `KALLSYMS` alone was not enough: the kernel configuration differed from the official SDK in 1333 symbols, many of them changing `net_device`, `struct net` or `sk_buff`, so modules would load and corrupt memory.
* With `CONFIG_ALL_KMODS=y` and `KALLSYMS` off, 14 differences remain, none affecting the ABI (GCC version strings, `schedutil`, zram backends). The kernel shrank by 259 KiB of flash and 764 KiB of RAM.
* Verified on the router: official `kmod-dummy` and `kmod-wireguard` load; a WireGuard tunnel carried 2.1 GiB at 528 / 602 Mbit/s without kernel errors.

**Decision:** keep `ALL_KMODS` and `KALLSYMS` off as long as the vermagic is the official one; re-check after every kernel update ([UPGRADING.md](UPGRADING.md#appendix-b-kernel-configuration-parity-check)).

## 3. Traffic accounting with hardware offloading

nlbwmon counts the conntrack counters, which for offloaded flows come from the PPE. Six bugs were found and fixed:

1. **Phantom jumps of ~4 GB (2³²):** the PPE flow counters went backwards on unbind/rebind, and `nf_ct_acct_add()` truncated the negative delta to 32 bits. About 10 jumps per hour before the fix; none in 43- and 62-minute load tests after it (patch `970`).
2. **Lost tail of every closed connection:** the flowtable polls the counters only every ~3 s and removed the hardware entry after a TCP FIN without a final poll (patch `971`).
3. **Lost tail even with a final poll:** the PPE unbinds an entry by itself after a TCP FIN, and the driver then folded only its software copy of the counters, not the hardware MIB counter (second part of patch `970`).
4. **A neighbour in the same PPE bucket stopped counting:** on the MT7622 a bucket of the PPE hash table has two slots. When a second flow bound to the other slot, the driver detached the first one, although it stayed bound in hardware: its counters stopped while it kept sending, and after the flowtable removed it, its PPE entry stayed bound and kept forwarding. Patch `970` now detaches only the entry naming the slot being bound, as proposed in [openwrt/openwrt#26107](https://github.com/openwrt/openwrt/pull/26107).
5. **A firewall reload dropped the offloaded flows:** fw4 replaces the flowtable on every reload, and its block callbacks were unbound before the flows were freed, so the driver never removed their PPE entries. The flows stopped counting, were never offloaded again (their driver entries blocked the new ones), and kept forwarding in hardware until they ended. Fixed by patches `972` and `973` from the SmartRG tree ([target-cascade](https://github.com/cmonroe/target-cascade)).
6. **Flows with one direction on the CPU were polled late:** the flowtable polls the hardware counters only when a tenth of the flow timeout has passed since the timeout was last refreshed, and every packet of the CPU direction refreshes it. On the MT7622 Wi-Fi → WAN always takes the CPU (no WED RX), so the counts of a Wi-Fi download reached conntrack only when it paused, and `nf_ct_acct_add()` truncated a poll of 4 GiB or more to 32 bits. Patches `975` and `974`, found in the code of 6.12.

| Test (nlbwmon count / payload) | before | patch `971` only | `970` + `971` |
|---|---|---|---|
| 300 MiB, connection closed at once | 69–84 % | 70–86 %; 50–59 % on another server | **105.0 %** (5 of 5) |
| 30 × 10 MiB, each on its own connection | — | **4.0 %** | **105.1 %** |
| 300 MiB, connection idle 10 s before closing | 105 % | 105 % | 105 % |
| iperf3 TCP upload / download, 10 s | — | 105 % / 108 % | 105 % / 108 % |
| HTTP/3 (QUIC, UDP) | — | 108 % | 108 % |
| 1-hour mixed load, share of the payload | 90.7 % | — | **105.0 %** |
| All clients vs the WAN port hardware counter | 86.9 % | — | **100.0 %** |

105 % is the payload plus TCP/IP headers.

**Bucket test (bug 4):** three 5 Mbit/s UDP flows from the build PC to an iperf3 server, with source ports chosen with the driver's hash function (`mtk_ppe_hash_entry()`) so that flow B lands in the bucket of flow A (slots `0x2fce` and `0x2fcf` in `/sys/kernel/debug/ppe0/bind`) and flow C in another bucket. B starts 45 s after A. Conntrack bytes against what iperf3 sent:

| Flow | sent (with headers) | before | after |
|---|---|---|---|
| A, first in the bucket | 64.5 MB | **29.1 MB**, stopped when B bound; its PPE entry outlived the flow | 64.5 MB |
| B, its neighbour | 35.5 MB | 35.5 MB | 35.5 MB |
| C, another bucket | 48.4 MB | 48.4 MB | 48.4 MB |

After the fix all three are counted to within 600 bytes (the PPE counts the 18 bytes of L2 headers per packet too), no PPE entry outlives its flow, and a 145 MB download closed at once is still counted at 105.2 % (2 of 2).

**Firewall reload test (bug 5):** one 5 Mbit/s UDP flow, `/etc/init.d/firewall reload` after 30 s, conntrack bytes against what iperf3 sent (58.04 MB with headers): before, 18.6 MB, the flow was never offloaded again, and its PPE entry kept forwarding until the flow ended; after, 58.04 MB, the flow stayed offloaded and its PPE entry went away with it. The bucket test and the download test give the same results as above.

**Wi-Fi download (bug 6):** one HTTPS connection from a 5 GHz client for 90 s, conntrack sampled every 2 s. With `975` the download direction (WAN → Wi-Fi, PPE + WED) reached conntrack every 3–4 s during the transfer, and 5.18 GB of payload on that one connection were counted as 5.55 GB (107 %, as for Wi-Fi before), more than 4 GiB without loss. Without the patches the whole download would have come in one poll at the end, truncated to 32 bits (about 1.25 GB); the old firmware was not measured.

**Decision:** patches `970` and `971` (see [UPGRADING.md](UPGRADING.md), checklist items 11–12).

## 4. Interface counters with hardware offloading

The software counters of the network interfaces never see offloaded traffic. During a 210 MB download the `wan` counter grew by 0.1 MB, the switch port's hardware counter by 220 MB. A collectd `ethstat` graph of the hardware counter was a first workaround.

The backport of the upstream `mt7530` `.get_stats64` series (Linux 6.16) and its fix (7.1) makes the hardware counters the statistics of `wan` and `lan1`–`lan3`: `wan` +220.9 MB and `lan1` +220.2 MB for the same download, the `wan` graph showed 36.3 MB/s over 30 s for a 1 GB download, and 200 consecutive reads of `/proc/net/dev` logged no kernel errors. `br-lan` and the Wi-Fi interfaces still count only CPU-handled traffic. **Decision:** keep the backport, drop `ethstat`.

## 5. CPU frequency governor

| | `schedutil` | `performance` |
|---|---|---|
| CPU per Gbit/s, Wi-Fi → LAN bridge | 89 % | 64.5 % |
| CPU per Gbit/s, LAN → Wi-Fi bridge | 65 %¹ | 55.7 % |
| CPU, LAN → WAN (offloaded) | ~6 % | ~1 % |
| Wi-Fi round-trip at idle (median) | 1.60 ms | 1.42 ms |
| Latency under load | same | same |
| Throughput | same (limited by Wi-Fi) | same |
| WAN up after power-on | 20.6–21.0 s | 20.7–21.0 s |
| Router temperature at idle | 57 °C | 59–59.5 °C |

¹ No run above 880 Mbit/s; average of all runs. The `performance` column: runs at ≥ 880 Mbit/s.

At a fixed 1.35 GHz the same work takes a smaller share of time than at the lower clocks `schedutil` picks; the CPU is not the bottleneck either way (50–60 % busy at ~900 Mbit/s over the bridge). Earlier, at idle: 3.8 % CPU with `schedutil` vs 6.0 % with `ondemand`. **Decision:** `schedutil` stays the default; `performance` can be chosen in LuCI → *System → CPU Frequency* (`luci-app-cpufreq`, see the [README](README.md#1-compiler-and-cpu-arm-cortex-a53)).

## 6. Latency and jitter

`irtt` probes every 10 ms from the laptop on Wi-Fi to the wired PC (the path of a PC → VR headset stream), 4 interleaved rounds per setting on one connection. Round-trip median (p99):

| Scenario | `schedutil` | `performance` |
|---|---|---|
| Idle | 1.60 ms (3.0) | 1.42 ms (2.6) |
| UDP 200 Mbit/s towards the Wi-Fi client (VR-like stream) | 1.81 ms (8.5) | 1.83 ms (8.4) |
| TCP at full speed towards the Wi-Fi client | 22 ms (54) | 22 ms (42) |
| TCP at full speed from the Wi-Fi client | 5.3 ms (12.8) | 6.8 ms (12.5) |

Packet loss stayed at or below 0.32 %. The spikes under load come from the Wi-Fi queues (aggregation and airtime scheduling in mt76/mac80211), the same for every firmware and governor: a full-speed download to the same client raises the median to 12–22 ms and p99 to 40–100 ms, depending on the link rate. For VR, avoid saturating the same Wi-Fi during streaming; firmware or CPU settings do not change this.

## 7. Cost of kernel hardening

A/B on the extreme build (below), 8 runs per direction: disabling `RODATA_FULL_DEFAULT_ENABLED`, `ARM64_SW_TTBR0_PAN` (the Cortex-A53 has no hardware PAN), `HARDENED_USERCOPY` and `SLAB_FREELIST_HARDENED/RANDOM`:

| CPU per Gbit/s | hardening on | hardening off |
|---|---|---|
| Wi-Fi → LAN bridge | 66.1 ± 2.8 % | 67.0 ± 2.8 % (no difference, t = −0.7) |
| LAN → Wi-Fi bridge | 54.5 ± 1.2 % | 51.7 ± 1.4 % (−5 %, t = 4.1; 1.3 points of CPU load) |

Same throughput. **Decision:** keep the hardening, which protects the kernel and the Wi-Fi drivers reachable over the air.

## 8. Extreme build experiment (dropped)

A separate branch tested a build without any compatibility concessions:
* no package manager;
* all in-tree drivers built into the kernel: 9 modules instead of 97, only the wireless stack (built outside the kernel tree) and `gpio-button-hotplug`;
* unused kernel exports dropped with `CONFIG_TRIM_UNUSED_KSYMS`: 395 instead of 13 901, plus a whitelist for the out-of-tree modules. OpenWrt's `CONFIG_STRIP_KERNEL_EXPORTS` is marked `BROKEN` since Linux 6.6;
* the `performance` governor;
* only LuCI, statistics, nlbwmon, DoH, UPnP and watchcat.

| | `xq-25.12` | `xq-25.12` + `performance` | extreme |
|---|---|---|---|
| WAN up after power-on | 20.6–21.0 s | 20.7–21.0 s | 17.5–17.9 s |
| `MemAvailable` 5 min after boot | 114 MB | 117 MB | 134 MB |
| Read-only rootfs / `sysupgrade` image | 11.5 / 17.8 MB | same | 6.0 / 11.5 MB |
| Full build from scratch (Ryzen 9 5900X) | 20 min | same | 14 min |
| CPU per Gbit/s, Wi-Fi → LAN bridge | 89 % | 64.5 % | 66.1 % |
| CPU per Gbit/s, LAN → Wi-Fi bridge (≥ 880 Mbit/s) | 65 %¹ | 55.7 % | 54.3 % |
| Latency, idle / VR-like stream (median) | 1.60 / 1.81 ms | 1.42 / 1.83 ms | 1.50 / 1.96 ms |

¹ Average of all runs, none above 880 Mbit/s.

The lower CPU load came from the governor alone; the main build with `performance` needs the same CPU. The latency did not improve either. The only gains of the leaner image itself were 3 s faster boot, 17 MB more free memory (of 242 MB, mostly unused anyway), a smaller image and a faster build. Its costs: no installable packages or official kmods, no PPPoE, SQM or diagnostic tools, and a second branch to maintain. **Decision:** dropped; the branch was deleted.

Findings worth keeping for future work:
* **OpenWrt `CONFIG_KERNEL_*` options win.** A kernel configuration fragment in `env/kernel-config` is merged last into the target configuration, but OpenWrt's `CONFIG_KERNEL_*` options (`DEBUG_FS`, `IO_URING`, the stack protector) are applied after it.
* **mac80211 debugfs selects `KERNEL_DEBUG_FS`.**
* **`wpad-basic-*` breaks the 5 GHz AP of this build:** it rejects the WNM sleep mode options that `77_wireless` sets. Check access points with `ubus list 'hostapd.*'`; `iwinfo` also lists an AP that failed to start.
* **`sysupgrade` keeps settings by the conffiles lists in `/lib/apk/packages`.** They must stay even without a package manager.
* **Built-in drivers can open new kconfig questions:** making `TCP_CONG_BBR` built in opens the `DEFAULT_BBR` choice and stops a non-interactive build. `make listnewconfig` finds such questions.
* **Stripped modules keep their export names only in `__ksymtab_strings`.**

## 9. WAN bufferbloat and the need for SQM

Pings every 20 ms to 1.1.1.1 and 8.8.8.8 from the wired PC, idle and with the ISP link (~550/550 Mbit/s) saturated by 4 parallel downloads or 4 iperf3 upload streams, hardware offloading on, 2 rounds. Round-trip to 1.1.1.1:

| | Throughput | Median (change) | p99 | Max |
|---|---|---|---|---|
| Idle | — | 8.9 ms | 12.9 ms | 19.0 ms |
| Download saturated | 540–556 Mbit/s | 8.9–9.0 ms (+0.1) | 13.2–13.3 ms | 17.1 ms |
| Upload saturated | 513–573 Mbit/s | 8.8–8.9 ms (0) | 15.5–18.1 ms | 21.3 ms |

8.8.8.8 behaves the same; packet loss stays at or below 0.1 %. The ISP link does not bloat under load, so SQM would cost the hardware offloading (and cap the throughput at what the CPU can shape) without improving the latency. **Decision:** keep hardware flow offloading; no SQM or QoS on this link. On a link that does bloat, follow [SQM or hardware offloading?](README.md#sqm-or-hardware-offloading).

## 10. Wi-Fi driver fixes from mt76 master

OpenWrt 25.12 builds mt76 from Git HEAD 2026-03-19 plus the fixes that reached Linux 6.18.55; mac80211 comes from backports 6.18.55. OpenWrt main has mt76 2026-10-08 and mac80211 7.2. The firmware is the same in both (MT7915 20240429, MT7622 WMAC 20220630), so rate control and the RF side do not change.

Of the 387 mt76 commits since our version, 139 touch the code of this board's chips (MT7915E on 5 GHz, the MT7622 WMAC through `mt7615` on 2.4 GHz, the core and `connac` library) and 41 of them are already in 25.12. Every remaining commit that changes a compiled file was checked against the functions our drivers call: most are for MT7925/7927/7928, MT7996, MLO, NAN, or for the mt76 hardware scan and channel contexts, which neither driver uses (both use `mt76_sw_scan` and mac80211's chanctx emulation). 18 fixes apply to us and on top of 25.12's patches without conflicts (`package/kernel/mt76/patches/0300…0317`):

* station add/removal races that corrupt memory (`20f0979088`, `b1bc93f953`, `8f69e214f0`, `7ff2f295a6`), a NULL dereference in the 2.4 GHz driver (`bd41e0fbea`), frames to disassociated stations stuck in the queues (`0898393ee0`);
* firmware recovery (SER): RX hang detection (`af601a725f`), stuck TX queues (`130273a947`), the PHY setup that a full restart skipped (`b1f962a838`), and an out-of-bounds write in the coredump that a firmware crash produces (`fd3dc2614c`; coredump support is built in);
* the per-station RSSI average (`ed62359710`): since "mt76: improve signal strength reporting" (February 2022) mt76 fed it zeros, so the adaptive sensitivity (SCS) of the MT7622 WMAC always fell back to its default;
* TX aggregation on the VO queue (`f67ffb60cd`), HE DCM and VHT RX STBC peer capabilities (`e593243800`, `41cecc382b`), 4th-chain ACK RSSI (`cdc6c0d07c`), bounds checks (`04017929f6`, `1c9854c436`, `2802466a94`).

**SCS on the 2.4 GHz radio** (channel 1, 10 clients, weakest at −61 dBm), measured on the new firmware by switching `/sys/kernel/debug/ieee80211/wl0/mt76/scs` at runtime, 2 minutes each, interleaved:

| | SCS off (old behaviour) | SCS on |
|---|---|---|
| Packet detection threshold (OFDM / CCK) | −98 / −110 dBm, fixed | mostly −74 / −78 dBm, back to the default for a moment every ~30 s |
| False CCA (CCK, per interval) | 1000–1700 | 130–490 |
| Channel busy (survey) | 27.1 % / 34.8 % | 14.8 % / 14.5 % |
| Receive time | 44.4 % / 43.3 % | 19.0 % / 19.1 % |
| Transmit time | 2.5 % / 3.1 % | 2.6 % / 2.6 % |
| Ping loss, sum over the 10 clients | 6 % / 13 % | 3 % / 0 % |

The radio no longer counts the noise of the busy 2.4 GHz band as a busy channel, so it waits less before sending. The threshold never goes above the weakest connected client (and −72 dBm); a far device that is not connected yet is only heard while the threshold is back at its default. If such a device has trouble joining the 2.4 GHz network, `echo 0 > /sys/kernel/debug/ieee80211/wl0/mt76/scs` restores the old behaviour until the next reboot.

**Not taken:** the whole mt76 HEAD needs mac80211 7.2 APIs (`ieee80211_txq_aql_pending()`, link-ID template getters) that OpenWrt main only builds on kernel 6.18. The power-save buffering for MT7915 (`9a46d8d21d`, `9e613fb007`) is a behaviour change with little effect here: offloaded traffic from the WAN goes through WED past the driver, and only host-path frames to dozing 5 GHz clients would be affected. mac80211 fixes from Linux 6.18.56–58 (e.g. extension frame validation, oversized fragments, PS teardown) arrive with the next mac80211 update of 25.12, which happened every 2–3 months so far.
