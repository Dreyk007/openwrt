#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI firmware update check for the Xiaomi AX3200 / Redmi AX6S build
LUCI_DESCRIPTION:=Checks the GitHub releases of this build, shows a notice on the Overview page \
	and installs a new release from LuCI (System -> AX3200 / AX6S build updates).
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci +uclient-fetch +ca-bundle

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Dreyk <dreyksmail@gmail.com>

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
