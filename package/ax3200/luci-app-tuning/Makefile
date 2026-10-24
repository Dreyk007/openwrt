#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI operating modes for the Xiaomi AX3200 / Redmi AX6S
LUCI_DESCRIPTION:=Switches flow offloading, WED, bridger, packet steering, the CPU frequency \
	governor and SQM together as tested operating modes (System -> Operating mode).
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-uci +ucode-mod-fs

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Dreyk <dreyksmail@gmail.com>

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
