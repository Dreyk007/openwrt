'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';

const callProfiles = rpc.declare({ object: 'luci.tuning', method: 'profiles' });
const callStatus = rpc.declare({ object: 'luci.tuning', method: 'status' });
const callApply = rpc.declare({
	object: 'luci.tuning',
	method: 'apply',
	params: [ 'profile', 'settings', 'sqm_download', 'sqm_upload' ]
});
const callReboot = rpc.declare({ object: 'system', method: 'reboot', expect: { result: 0 } });

const SETTINGS = [ 'offload', 'wed', 'bridger', 'steering', 'governor', 'sqm' ];

/* Every mode change is applied with a reboot: one simple rule instead of settings that apply at once
   and WED, which needs a reboot anyway */
function REBOOT_NOTE() {
	return _('Applying reboots the router.');
}

/* Texts of the modes, measured on this router (RESEARCH.md sections 9, 11-13) */
function modeTexts() {
	return {
		balanced: {
			title: _('Balanced'),
			badge: _('recommended'),
			who: _('A typical home: phones, a TV, laptops, gaming, an internet plan up to 1 Gbit/s.'),
			pros: [
				_('Internet traffic runs at full speed with almost no CPU load: routing and NAT are done by the hardware, downloads to 5 GHz Wi-Fi devices too (WED).'),
				_('On an ordinary evening (a TV streaming 4K, phones) the Wi-Fi latency stays as low as on a quiet network, with peaks around 14 ms.'),
				_('Saves energy when the network is idle (schedutil governor).')
			],
			cons: [
				_('While one Wi-Fi device downloads at full speed, the other Wi-Fi devices get slightly higher latency peaks than in the Low latency mode: about 30 ms instead of 27 ms.')
			],
			warnings: []
		},
		throughput: {
			title: _('Maximum throughput'),
			who: _('Large copies from a wired NAS or PC to one Wi-Fi device.'),
			pros: [
				_('Data from wired devices to 5 GHz Wi-Fi devices is forwarded by the hardware (bridger) instead of the CPU: the same speed of about 1.3 Gbit/s at ~8% CPU load instead of ~70%.')
			],
			cons: [
				_('5 GHz Wi-Fi devices that receive data from wired devices get higher latency: about 3.5 ms instead of 1.7 ms, even when no other device is busy. Wired devices and internet traffic are not affected.'),
				_('When several 5 GHz Wi-Fi devices receive data from wired devices at the same time, they share the airtime less fairly: one of them can be left with very little speed.'),
				_('Wi-Fi priorities (WMM, used e.g. for voice and video calls) do not apply to data from wired devices to 5 GHz Wi-Fi devices.'),
				_('The CPU stays at its maximum clock (performance governor): the router runs about 2 °C warmer.')
			],
			warnings: [
				_('Not for VR streaming or gaming over Wi-Fi: they need low latency more than a low CPU load.')
			]
		},
		lowlatency: {
			title: _('Low latency'),
			who: _('VR streaming from a wired PC to a headset, online gaming over Wi-Fi.'),
			pros: [
				_('All traffic to Wi-Fi devices goes through the Wi-Fi airtime scheduler, which shares the airtime fairly and keeps the queues short: slightly lower latency peaks while other devices download (about 27 ms instead of 30 ms in the Balanced mode).'),
				_('Slightly lower latency when the network is quiet: the CPU stays at its maximum clock (performance governor).')
			],
			cons: [
				_('Internet downloads to 5 GHz Wi-Fi devices are handled by the CPU instead of the hardware (WED off): 600 Mbit/s take ~70% of one CPU core instead of ~55%. On a 1 Gbit/s plan Wi-Fi devices may not reach the full speed.'),
				_('The router runs about 2 °C warmer (performance governor).')
			],
			warnings: [
				_('A wired gaming PC gains nothing from this mode.'),
				_('Even in this mode a large download to another Wi-Fi device raises the latency of the others.')
			]
		},
		sqm: {
			title: _('SQM (slow link)'),
			who: _('Internet connections slower than ~300 Mbit/s whose latency grows a lot when the connection is busy (grade C–F in a bufferbloat test).'),
			pros: [
				_('Low and stable latency even when the internet connection is fully loaded (CAKE).')
			],
			cons: [
				_('All internet traffic is handled by the CPU (hardware NAT and WED are off): the speed is limited to about 400 Mbit/s for wired and 230–250 Mbit/s for Wi-Fi devices.')
			],
			warnings: [
				_('On a fast connection without bufferbloat this mode only costs speed.')
			]
		},
		custom: {
			title: _('Custom'),
			who: _('Your own combination of the settings under Advanced. This mode is also shown when the settings were changed on other pages or from the command line.'),
			pros: [],
			cons: [],
			warnings: []
		}
	};
}

function settingLabels() {
	const onoff = { 'true': _('on'), 'false': _('off') };
	return {
		offload: {
			title: _('Flow offloading'),
			values: { none: _('none'), software: _('software'), hardware: _('hardware (PPE)') }
		},
		wed: { title: _('WED (internet traffic to 5 GHz Wi-Fi in hardware)'), values: onoff },
		bridger: { title: _('bridger (wired to 5 GHz Wi-Fi traffic in hardware)'), values: onoff },
		steering: {
			title: _('Packet steering'),
			values: {
				'0': _('off'),
				'1': _('mode 1 (Ethernet and Wi-Fi on separate cores)'),
				'2': _('mode 2 (received packets spread over both cores)')
			}
		},
		governor: {
			title: _('CPU frequency governor'),
			values: {
				schedutil: _('schedutil (follows the load)'),
				performance: _('performance (always the maximum frequency)'),
				ondemand: _('ondemand (samples the load periodically)'),
				conservative: _('conservative (changes the frequency in small steps)'),
				powersave: _('powersave (always the minimum frequency)')
			}
		},
		sqm: { title: _('SQM (CAKE on the WAN)'), values: onoff }
	};
}

function warningText(code) {
	return {
		sqm_hw_offload: _('SQM does not work together with hardware flow offloading.'),
		bridger_without_wed: _('bridger needs WED to forward traffic in hardware.')
	}[code] || code;
}

function valueText(labels, key, value) {
	const v = labels[key].values[String(value)];
	return v != null ? v : String(value);
}

function sameSettings(a, b) {
	return SETTINGS.every(function(k) { return String(a[k]) == String(b[k]); });
}

function cpuBusy(prev, cur) {
	if (!prev || !cur)
		return null;
	const a = prev.trim().split(/\s+/).slice(1, 9).map(Number);
	const b = cur.trim().split(/\s+/).slice(1, 9).map(Number);
	let total = 0, idle = 0;
	for (let i = 0; i < 8; i++)
		total += b[i] - a[i];
	idle = (b[3] - a[3]) + (b[4] - a[4]);
	return total > 0 ? Math.round(100 * (total - idle) / total) : null;
}

return view.extend({
	load: function() {
		return Promise.all([ callProfiles(), callStatus() ]);
	},

	render: function(data) {
		this.order = data[0].order;
		this.profiles = data[0].profiles;
		this.status = data[1];
		this.texts = modeTexts();
		this.labels = settingLabels();
		this.selected = this.status.profile;
		this.custom = Object.assign({}, this.status.settings);
		this.dl = Math.round((this.status.sqm.saved_download || this.status.sqm.download || 0) / 1000);
		this.ul = Math.round((this.status.sqm.saved_upload || this.status.sqm.upload || 0) / 1000);
		this.cpu = null;
		this.prevStat = this.status.cpu_stat;

		this.root = E('div', { 'class': 'cbi-map' }, [
			E('h2', _('Operating mode')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Sets flow offloading, WED, bridger, packet steering, the CPU frequency governor and SQM together, as modes tested on this router.')),
			E('div', { 'id': 'tuning-reboot' }),
			E('div', { 'class': 'cbi-section' }, [ E('h3', _('Current state')), E('div', { 'id': 'tuning-state' }) ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', _('Modes')), E('div', { 'id': 'tuning-cards' }) ]),
			E('div', { 'class': 'cbi-section', 'id': 'tuning-sqm' }),
			E('details', { 'class': 'cbi-section' }, [
				E('summary', { 'style': 'cursor:pointer' }, _('Advanced: individual settings')),
				E('p', { 'class': 'cbi-section-descr' }, _('Changing a setting here switches to the Custom mode.')),
				E('div', { 'id': 'tuning-advanced' })
			]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', _('Changes')), E('div', { 'id': 'tuning-changes' }) ]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handleApplyClick')
				}, _('Apply'))
			])
		]);

		this.refresh();
		poll.add(L.bind(this.pollStatus, this), 5);

		return this.root;
	},

	node: function(id) {
		return this.root.querySelector('#' + id);
	},

	target: function() {
		return this.selected == 'custom' ? this.custom : this.profiles[this.selected];
	},

	modeTitle: function(id) {
		return (this.texts[id] || this.texts.custom).title;
	},

	summary: function(s) {
		const L1 = this.labels;
		return [
			_('NAT: %s').format(valueText(L1, 'offload', s.offload)),
			'WED ' + valueText(L1, 'wed', s.wed),
			'bridger ' + valueText(L1, 'bridger', s.bridger),
			_('steering %s').format(String(s.steering)),
			String(s.governor),
			'SQM ' + valueText(L1, 'sqm', s.sqm)
		].join(' · ');
	},

	refresh: function() {
		this.renderReboot();
		this.renderState();
		this.renderCards();
		this.renderSqm();
		this.renderAdvanced();
		this.renderChanges();
	},

	renderReboot: function() {
		const node = this.node('tuning-reboot');
		if (!this.status.reboot_required) {
			dom.content(node, null);
			return;
		}
		dom.content(node, E('div', { 'class': 'alert-message warning' }, [
			E('p', _('A reboot is needed to apply the WED setting.')),
			E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, 'handleReboot') }, _('Reboot now'))
		]));
	},

	renderState: function() {
		const s = this.status, cur = s.settings, L1 = this.labels;
		const row = function(title, value) {
			return E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left', 'width': '40%' }, title), E('td', { 'class': 'td left' }, value) ]);
		};
		const wed = valueText(L1, 'wed', cur.wed) +
			((s.wed_running != cur.wed) ? ' (' + _('running: %s').format(valueText(L1, 'wed', s.wed_running)) + ')' : '');
		const bridger = valueText(L1, 'bridger', cur.bridger) +
			((s.bridger_running != cur.bridger) ? ' (' + _('running: %s').format(valueText(L1, 'bridger', s.bridger_running)) + ')' : '');
		const gov = valueText(L1, 'governor', cur.governor) +
			((s.governor_running && s.governor_running != cur.governor) ? ' (' + _('running: %s').format(s.governor_running) + ')' : '');
		const sqm = valueText(L1, 'sqm', cur.sqm) +
			(cur.sqm ? ', ' + _('%s / %s Mbit/s').format(Math.round(s.sqm.download / 1000), Math.round(s.sqm.upload / 1000)) : '');

		const table = E('table', { 'class': 'table' }, [
			row(_('Active mode'), E('strong', this.modeTitle(s.profile))),
			row(L1.offload.title, valueText(L1, 'offload', cur.offload)),
			row(L1.wed.title, wed),
			row(L1.bridger.title, bridger),
			row(L1.steering.title, valueText(L1, 'steering', cur.steering)),
			row(L1.governor.title, gov),
			row(L1.sqm.title, sqm),
			row(_('CPU load'), this.cpu != null ? this.cpu + '%' : '…'),
			row(_('CPU frequency'), s.freq_khz ? _('%d MHz').format(Math.round(s.freq_khz / 1000)) : '?'),
			row(_('PPE entries in use'), String(s.ppe_bound)),
			row(_('bridger rules in hardware'), String(s.bridger_hw_flows))
		]);

		const warn = (s.warnings || []).map(function(w) {
			return E('div', { 'class': 'alert-message warning' }, warningText(w));
		});

		dom.content(this.node('tuning-state'), [ table ].concat(warn));
	},

	renderCards: function() {
		const self = this;
		const ids = this.order.concat([ 'custom' ]);

		dom.content(this.node('tuning-cards'), ids.map(function(id) {
			const t = self.texts[id];
			const selected = (id == self.selected);
			const active = (id == self.status.profile);
			const list = function(items, sign) {
				return items.length ? E('ul', { 'style': 'margin:.3em 0 .3em 1.2em' }, items.map(function(i) {
					return E('li', {}, sign + ' ' + i);
				})) : '';
			};

			return E('div', {
				'class': 'cbi-section-node',
				'style': 'border:2px solid ' + (selected ? 'var(--primary-color-high, #0069d6)' : 'var(--border-color-medium, #ccc)') +
					'; border-radius:6px; padding:.7em 1em; margin:.6em 0; cursor:pointer',
				'click': function() {
					self.selected = id;
					if (id == 'custom') {
						if (sameSettings(self.custom, self.profiles[self.status.profile] || {}))
							self.custom = Object.assign({}, self.status.settings);
						self.root.querySelector('details').open = true;
					}
					self.refresh();
				}
			}, [
				E('div', { 'style': 'display:flex; align-items:center; gap:.6em' }, [
					E('input', { 'type': 'radio', 'name': 'tuning-mode', 'checked': selected ? '' : null }),
					E('strong', { 'style': 'font-size:110%' }, t.title),
					t.badge ? E('span', { 'class': 'label notice' }, t.badge) : '',
					active ? E('span', { 'class': 'label success' }, _('active')) : ''
				]),
				E('p', { 'style': 'margin:.4em 0' }, (id == 'custom') ? t.who : [ E('em', _('Recommended for:')), ' ', t.who ]),
				(id != 'custom') ? E('p', { 'style': 'margin:.2em 0; opacity:.8' }, self.summary(self.profiles[id])) : '',
				t.pros.length ? E('div', [ E('strong', _('Pros')), list(t.pros, '+') ]) : '',
				t.cons.length ? E('div', [ E('strong', _('Cons')), list(t.cons, '−') ]) : '',
				E('div', {}, t.warnings.map(function(w) {
					return E('div', { 'class': 'alert-message warning', 'style': 'margin:.3em 0; padding:.3em .6em' }, w);
				}))
			]);
		}));
	},

	renderSqm: function() {
		const self = this;
		const node = this.node('tuning-sqm');
		const on = !!this.target().sqm;

		if (!this.status.sqm.available) {
			dom.content(node, [ E('h3', _('SQM rates')), E('p', { 'class': 'cbi-section-descr' }, _('SQM needs the sqm-scripts package.')) ]);
			return;
		}

		const input = function(value, cb) {
			return E('input', {
				'type': 'number', 'min': '1', 'step': '1', 'class': 'cbi-input-text', 'value': value || '',
				'disabled': on ? null : '',
				'input': function(ev) { cb(+ev.target.value || 0); self.renderChanges(); }
			});
		};

		dom.content(node, [
			E('h3', _('SQM rates')),
			E('p', { 'class': 'cbi-section-descr' }, on ? [
				_('Set 85–95% of the speeds measured without SQM, e.g. with a bufferbloat test:'), ' ',
				E('a', { 'href': 'https://www.waveform.com/tools/bufferbloat', 'target': '_blank', 'rel': 'noreferrer' }, 'waveform.com/tools/bufferbloat'), '.'
			] : _('Used only when SQM is on: in the SQM mode or under Advanced.')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Download, Mbit/s')),
				E('div', { 'class': 'cbi-value-field' }, input(this.dl, function(v) { self.dl = v; }))
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Upload, Mbit/s')),
				E('div', { 'class': 'cbi-value-field' }, input(this.ul, function(v) { self.ul = v; }))
			])
		]);
	},

	renderAdvanced: function() {
		const self = this;
		const t = this.target();
		const L1 = this.labels;
		const governors = this.status.governors && this.status.governors.length ? this.status.governors : [ 'schedutil', 'performance' ];

		const select = function(key, options) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, L1[key].title),
				E('div', { 'class': 'cbi-value-field' }, E('select', {
					'class': 'cbi-input-select',
					'change': function(ev) {
						const v = ev.target.value;
						self.custom = Object.assign({}, t);
						self.custom[key] = (v == 'true') ? true : (v == 'false') ? false : v;
						self.selected = 'custom';
						for (let i = 0; i < self.order.length; i++)
							if (sameSettings(self.custom, self.profiles[self.order[i]]))
								self.selected = self.order[i];
						self.refresh();
					}
				}, options.map(function(o) {
					return E('option', { 'value': String(o), 'selected': String(t[key]) == String(o) ? '' : null }, valueText(L1, key, o));
				})))
			]);
		};

		dom.content(this.node('tuning-advanced'), [
			select('offload', [ 'hardware', 'software', 'none' ]),
			select('wed', [ true, false ]),
			select('bridger', [ false, true ]),
			select('steering', [ '2', '1', '0' ]),
			select('governor', governors),
			select('sqm', [ false, true ])
		]);
	},

	changes: function() {
		const cur = this.status.settings, t = this.target(), L1 = this.labels;
		const out = [];
		SETTINGS.forEach(function(k) {
			if (String(cur[k]) != String(t[k]))
				out.push('%s: %s → %s'.format(L1[k].title, valueText(L1, k, cur[k]), valueText(L1, k, t[k])));
		});
		if (t.sqm && (!cur.sqm || this.dl * 1000 != this.status.sqm.download || this.ul * 1000 != this.status.sqm.upload))
			out.push(_('SQM rates: %s / %s Mbit/s').format(this.dl, this.ul));
		return out;
	},

	renderChanges: function() {
		const ch = this.changes();
		const t = this.target();
		const items = [];

		if (!ch.length)
			items.push(E('p', _('No changes.')));
		else
			items.push(E('ul', { 'style': 'margin-left:1.2em' }, ch.map(function(c) { return E('li', c); })));
		if (ch.length)
			items.push(E('div', { 'class': 'alert-message warning' }, REBOOT_NOTE()));
		if (t.sqm && t.offload == 'hardware')
			items.push(E('div', { 'class': 'alert-message warning' }, warningText('sqm_hw_offload')));
		if (t.bridger && !t.wed)
			items.push(E('div', { 'class': 'alert-message warning' }, warningText('bridger_without_wed')));

		dom.content(this.node('tuning-changes'), items);
	},

	pollStatus: function() {
		return callStatus().then(L.bind(function(s) {
			this.cpu = cpuBusy(this.prevStat, s.cpu_stat);
			this.prevStat = s.cpu_stat;
			const changed = !sameSettings(s.settings, this.status.settings) || s.reboot_required != this.status.reboot_required;
			this.status = s;
			this.renderReboot();
			this.renderState();
			if (changed) {
				this.renderCards();
				this.renderChanges();
			}
		}, this));
	},

	handleApplyClick: function() {
		const t = this.target();

		if (t.sqm && (!(this.dl > 0) || !(this.ul > 0))) {
			ui.addTimeLimitedNotification(null, E('p', _('Enter the download and upload rates for SQM.')), 5000, 'warning');
			return;
		}
		if (!this.changes().length && (this.selected == this.status.profile || sameSettings(t, this.status.settings))) {
			ui.addTimeLimitedNotification(null, E('p', _('Nothing to change.')), 5000, 'info');
			return;
		}

		const ch = this.changes();
		ui.showModal(_('Apply the mode'), [
			ch.length ? E('ul', { 'style': 'margin-left:1.2em' }, ch.map(function(c) { return E('li', c); })) : '',
			E('p', REBOOT_NOTE()),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'btn cbi-button-apply', 'click': ui.createHandlerFn(this, function() {
					ui.hideModal();
					return this.doApply().then(L.bind(function(res) {
						if (res && res.result == 'ok')
							return this.handleReboot();
					}, this));
				}) }, _('Apply and reboot'))
			])
		]);
	},

	doApply: function() {
		const settings = (this.selected == 'custom') ? this.custom : {};

		return callApply(this.selected, settings, this.dl * 1000, this.ul * 1000).then(L.bind(function(res) {
			if (!res || res.error) {
				ui.addNotification(null, E('p', _('Error: %s').format(res ? res.error : '?')), 'danger');
				return res;
			}
			return callStatus().then(L.bind(function(s) {
				this.status = s;
				this.selected = s.profile;
				this.custom = Object.assign({}, s.settings);
				this.refresh();
				return res;
			}, this));
		}, this));
	},

	handleReboot: function() {
		return callReboot().then(function() {
			ui.showModal(_('Rebooting…'), [
				E('p', { 'class': 'spinning' }, _('The router is rebooting.'))
			]);
			ui.awaitReconnect();
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
