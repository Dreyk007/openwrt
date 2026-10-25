'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require form';
'require dom';

const callStatus = rpc.declare({ object: 'luci.fwupdate', method: 'status' });
const callCheck = rpc.declare({ object: 'luci.fwupdate', method: 'check' });
const callDownload = rpc.declare({ object: 'luci.fwupdate', method: 'download' });
const callUpgrade = rpc.declare({ object: 'luci.fwupdate', method: 'upgrade', params: [ 'keep' ] });
const callSkip = rpc.declare({ object: 'luci.fwupdate', method: 'skip', params: [ 'tag' ] });
const callAsuOff = rpc.declare({ object: 'luci.fwupdate', method: 'asu_off' });

/* Notes in release.json come in English and Russian; LuCI sets the page language on <html> */
function noteText(r) {
	if (!r.note)
		return '';
	return ((document.documentElement.lang || '').indexOf('ru') == 0 && r.note.ru) ? r.note.ru : r.note.en;
}

/* Bootstrap shows lists in sections without bullets */
const LIST_STYLE = 'margin:0 0 0 1.4em; list-style:disc';

function pad(n) {
	return (n < 10 ? '0' : '') + n;
}

/* "25 Oct 2026", the month in the language of LuCI */
function fmtDate(date) {
	const d = (typeof date == 'number') ? new Date(date * 1000) : new Date(date);
	if (isNaN(d))
		return date || '';
	let month;
	try {
		month = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: 'short' }).format(d).replace(/\.$/, '');
	}
	catch (e) {
		month = pad(d.getMonth() + 1);
	}
	return d.getDate() + ' ' + month + ' ' + d.getFullYear();
}

/* "25 Oct 2026, 15:27", a 24-hour clock */
function fmtTime(sec) {
	const d = new Date(sec * 1000);
	return fmtDate(sec) + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function mb(bytes) {
	return (bytes / 1048576).toFixed(1);
}

function checkError(e) {
	if (e == 'network')
		return _('no connection to GitHub');
	if (e == 'invalid')
		return _('the release information could not be read');
	if (/^http [0-9]+$/.test(e))
		return _('GitHub returned an error (%s)').format(e.replace(/^http/, 'HTTP'));
	if (e == 'http')
		return _('GitHub returned an error');
	return e;
}

function downloadError(dl) {
	switch (dl.error) {
	case 'space': return _('There is not enough free memory for the update.');
	case 'network': return _('The download failed: no connection to GitHub.');
	case 'http': return _('The download failed: GitHub returned an error.');
	case 'size':
	case 'checksum': return _('The downloaded file is damaged. Try again.');
	case 'invalid': return _('The router does not accept this firmware file.');
	case 'manual': return _('This release has to be installed manually.');
	case 'stalled': return _('The download stopped. Try again.');
	case 'no_release': return _('Check for updates first.');
	default: return dl.error || _('Unknown error');
	}
}

return view.extend({
	load: function() {
		return callStatus();
	},

	render: function(data) {
		this.data = data;
		this.keep = true;

		const m = new form.Map('fwupdate');
		const s = m.section(form.NamedSection, 'settings', 'settings', _('Settings'));
		let o;

		o = s.option(form.Flag, 'enabled', _('Check for updates automatically'),
			_('After every start of the router and then at the interval below. Nothing is installed without you.'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'interval', _('Interval'));
		o.value('24', _('once a day'));
		o.value('168', _('once a week'));
		o.value('720', _('once a month'));
		o.default = '24';
		o.depends('enabled', '1');

		o = s.option(form.Flag, 'notify', _('Notice on the Overview page'),
			_('Shows a notice on the Overview page when a new release is out.'));
		o.default = '1';
		o.rmempty = false;

		return m.render().then(L.bind(function(mapNode) {
			this.root = E('div', {}, [
				E('h2', _('AX3200 / AX6S build updates')),
				E('div', { 'class': 'cbi-map-descr' },
					_('New releases of this build are published on GitHub. The router looks for them and can install them from this page.')),
				E('div', { 'id': 'fwupdate-asu' }),
				E('div', { 'class': 'cbi-section' }, [ E('h3', _('Installed firmware')), E('div', { 'id': 'fwupdate-installed' }) ]),
				E('div', { 'class': 'cbi-section', 'id': 'fwupdate-release' }),
				mapNode
			]);
			this.refresh();
			poll.add(L.bind(this.pollStatus, this), 5);
			return this.root;
		}, this));
	},

	node: function(id) {
		return this.root.querySelector('#' + id);
	},

	refresh: function() {
		this.renderAsu();
		this.renderInstalled();
		this.renderRelease();
	},

	/* redraw only on a change, so that a button is not replaced under the pointer */
	pollStatus: function() {
		return callStatus().then(L.bind(function(data) {
			if (JSON.stringify(data) == JSON.stringify(this.data))
				return;
			this.data = data;
			this.refresh();
		}, this));
	},

	renderAsu: function() {
		const d = this.data;
		dom.content(this.node('fwupdate-asu'), d.asu ? E('div', { 'class': 'alert-message warning' }, [
			E('p', _('Attended Sysupgrade is installed. It offers official OpenWrt firmware, which does not include the changes of this build. Update this build on this page.')),
			d.asu_alerts ? E('button', {
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(this, function() {
					return callAsuOff().then(L.bind(this.pollStatus, this));
				})
			}, _('Turn off its update notices')) : ''
		]) : null);
	},

	renderInstalled: function() {
		const d = this.data, st = d.status, inst = d.installed;
		const row = function(title, value) {
			return E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left', 'width': '33%' }, title), E('td', { 'class': 'td left' }, value) ]);
		};
		let last = _('not yet');

		if (d.checking)
			last = _('checking…');
		else if (st && st.checked)
			last = fmtTime(st.checked) + (st.error ? ' · ' + _('failed: %s').format(checkError(st.error)) : '');

		dom.content(this.node('fwupdate-installed'), [
			E('table', { 'class': 'table' }, [
				row(_('Release'), inst.release || _('local build')),
				row(_('Last check'), last),
				(st && st.error && st.success) ? row(_('Last successful check'), fmtTime(st.success)) : ''
			]),
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'disabled': d.checking ? '' : null,
				'click': ui.createHandlerFn(this, 'handleCheck')
			}, _('Check now'))
		]);
	},

	renderRelease: function() {
		const d = this.data, st = d.status;
		const node = this.node('fwupdate-release');

		if (!st || !st.latest) {
			dom.content(node, null);
			return;
		}

		const latest = st.latest;
		const skipped = (d.settings.skip == latest.tag);
		const items = [ E('h3', _('Updates')) ];

		if (!st.update && !st.local) {
			items.push(E('p', _('This is the latest release: %s.').format(latest.tag)));
			dom.content(node, items);
			return;
		}

		items.push(E('p', [
			E('strong', (st.local ? _('Latest release: %s') : _('New release: %s')).format(latest.tag)),
			' · ', fmtDate(latest.date), ' · ',
			E('a', { 'href': latest.url, 'target': '_blank', 'rel': 'noreferrer' }, _('release page on GitHub'))
		]));

		if (st.local)
			items.push(E('p', _('This firmware was built locally, so the router cannot tell whether this release is newer.')));

		if (st.method != 'auto') {
			items.push(E('div', { 'class': 'alert-message warning' }, [
				E('p', {}, E('strong', (st.method == 'manual')
					? _('This update cannot be installed with the button below.')
					: _('This update can only be installed without keeping the settings.'))),
				E('div', {}, st.releases.filter(function(r) { return r.upgrade != 'auto'; }).map(function(r) {
					return E('p', [
						E('strong', r.tag + ': '), noteText(r), ' ',
						r.note_url ? E('a', { 'href': r.note_url, 'target': '_blank', 'rel': 'noreferrer' }, _('Instructions')) : ''
					]);
				}))
			]));
		}

		/* a heading per release only when the update spans several */
		st.releases.forEach(function(r) {
			if (st.releases.length > 1)
				items.push(E('p', { 'style': 'margin:.8em 0 .2em' }, E('strong', r.tag + ' · ' + fmtDate(r.date))));
			items.push(r.changes.length ? E('ul', { 'style': LIST_STYLE }, r.changes.map(function(c) {
				return E('li', c.subject);
			})) : E('p', _('No list of changes.')));
		});

		const dl = d.download;
		if (dl && dl.state == 'downloading' && dl.tag == latest.tag)
			items.push(E('p', { 'class': 'spinning' }, _('Downloading: %s of %s MB').format(mb(dl.done || 0), mb(dl.size))));

		if (skipped)
			items.push(E('p', _('You chose to skip this release: the Overview page does not show it.')));

		/* a release marked reset cannot keep the settings */
		const keepAllowed = (st.method != 'reset');
		const keep = E('input', {
			'type': 'checkbox',
			'checked': (keepAllowed && this.keep) ? '' : null,
			'disabled': keepAllowed ? null : '',
			'change': L.bind(function(ev) { this.keep = ev.target.checked; }, this)
		});

		/* a row of its own: the themes align .cbi-page-actions differently */
		items.push(E('div', { 'style': 'display:flex; flex-wrap:wrap; align-items:center; gap:.6em 1em; margin:1em 0' }, [
			(st.method != 'manual') ? E('label', {}, [ keep, ' ', _('Keep settings') ]) : '',
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'disabled': (st.method == 'manual') ? '' : null,
				'click': ui.createHandlerFn(this, 'handleUpdate')
			}, _('Update now')), ' ',
			st.update ? E('button', {
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(this, 'handleSkip', skipped ? '' : latest.tag)
			}, skipped ? _('Show this release again') : _('Skip this release')) : ''
		]));

		dom.content(node, items);
	},

	handleCheck: function() {
		return callCheck().then(L.bind(function() {
			this.data.checking = true;
			this.refresh();
		}, this));
	},

	handleSkip: function(tag) {
		return callSkip(tag).then(L.bind(this.pollStatus, this));
	},

	handleUpdate: function() {
		const d = this.data;

		if (d.download && d.download.state == 'ready' && d.download.tag == d.status.latest.tag &&
		    d.download.sha256 == d.status.latest.sysupgrade.sha256)
			return this.showConfirm(d);

		return callDownload().then(L.bind(function(res) {
			if (res && res.error)
				return this.showError(downloadError(res));
			return this.showDownload();
		}, this));
	},

	showError: function(text) {
		ui.showModal(_('Update'), [
			E('p', text),
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
		]);
	},

	showDownload: function() {
		const progress = E('p', { 'class': 'spinning' }, _('Downloading…'));
		ui.showModal(_('Downloading the update'), [ progress ]);

		const tick = L.bind(function() {
			return callStatus().then(L.bind(function(data) {
				const dl = data.download;
				this.data = data;
				if (dl && dl.state == 'downloading') {
					dom.content(progress, _('Downloading: %s of %s MB').format(mb(dl.done || 0), mb(dl.size)));
					window.setTimeout(tick, 1000);
				}
				else if (dl && dl.state == 'ready') {
					this.showConfirm(data);
				}
				else {
					this.showError(dl ? downloadError(dl) : _('Unknown error'));
				}
				this.refresh();
			}, this));
		}, this);

		window.setTimeout(tick, 1000);
	},

	/* the choice of "Keep settings" next to the button, unless the release or the image rule it out */
	showConfirm: function(d) {
		const st = d.status, dl = d.download;
		const keep = this.keep && st.method != 'reset' && dl.allow_backup !== false;
		let why = '';

		if (st.method == 'reset')
			why = st.releases.filter(function(r) { return r.upgrade == 'reset'; }).map(noteText).join(' ');
		else if (this.keep && dl.allow_backup === false)
			why = _('This firmware cannot keep the current settings.');

		ui.showModal(_('Update to %s').format(st.latest.tag), [
			keep ? E('p', _('The settings are kept.')) : E('div', {}, [
				why ? E('p', why) : '',
				E('p', { 'class': 'alert-message warning' },
					_('Without the settings the router starts as after a reset: address 192.168.1.1, no password, Wi-Fi password 12345678.'))
			]),
			E('p', {}, E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'handleBackup') }, _('Download a backup of the settings'))),
			E('p', _('Do not unplug the router while it installs the update.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return this.doUpgrade(keep);
					})
				}, _('Install'))
			])
		]);
	},

	/* the same as Backup / Flash Firmware -> Generate archive */
	handleBackup: function(ev) {
		const form = E('form', {
			'method': 'post',
			'action': L.env.cgi_base + '/cgi-backup',
			'enctype': 'application/x-www-form-urlencoded'
		}, E('input', { 'type': 'hidden', 'name': 'sessionid', 'value': rpc.getSessionID() }));

		ev.currentTarget.parentNode.appendChild(form);
		form.submit();
		form.parentNode.removeChild(form);
	},

	doUpgrade: function(keep) {
		return callUpgrade(keep).then(L.bind(function(res) {
			if (!res || res.error)
				return this.showError(_('The update could not be started. Try again.'));

			ui.showModal(_('Installing the update'), [
				E('p', { 'class': 'spinning' }, _('The router is installing the update. Do not unplug it.'))
			]);

			if (res.keep)
				ui.awaitReconnect(window.location.host);
			else
				ui.awaitReconnect(window.location.host, '192.168.1.1', 'openwrt.lan');
		}, this));
	}
});
