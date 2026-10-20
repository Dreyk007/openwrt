/* Licensed to the public under the Apache License 2.0. */

/*
 * Hardware (switch MIB) byte counters of Ethernet ports, collected by the
 * collectd ethstat plugin (/etc/collectd/conf.d/ethstat.conf). Unlike the
 * interface plugin they include traffic forwarded by hardware flow offloading.
 */

'use strict';
'require baseclass';

return baseclass.extend({
	title: _('Ethernet (hardware counters)'),

	rrdargs(graph, host, plugin, plugin_instance, dtype) {
		return {
			per_instance: true,
			title: "%H: Hardware transfer on %pi",
			vlabel: "Bytes/s",
			number_format: "%5.1lf%sB/s",
			totals_format: "%5.1lf%sB",

			data: {
				instances: {
					derive: [ "tx_bytes", "rx_bytes" ]
				},

				options: {
					derive_tx_bytes: {
						title: "Bytes (TX)",
						total: true,
						color: "00ff00"
					},

					derive_rx_bytes: {
						title: "Bytes (RX)",
						flip: true,
						total: true,
						color: "0000ff"
					}
				}
			}
		};
	}
});
