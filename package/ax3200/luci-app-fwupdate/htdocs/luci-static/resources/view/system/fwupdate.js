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
const callUpgrade = rpc.declare({ object: 'luci.fwupdate', method: 'upgrade', params: [ 'keep', 'packages' ] });
const callSkip = rpc.declare({ object: 'luci.fwupdate', method: 'skip', params: [ 'tag' ] });
const callAsuOff = rpc.declare({ object: 'luci.fwupdate', method: 'asu_off' });
const callPackages = rpc.declare({ object: 'luci.fwupdate', method: 'packages' });
const callPackagesSave = rpc.declare({ object: 'luci.fwupdate', method: 'packages_save' });
const callPackagesRetry = rpc.declare({ object: 'luci.fwupdate', method: 'packages_retry' });
const callPackagesCancel = rpc.declare({ object: 'luci.fwupdate', method: 'packages_cancel' });
const callPackagesDismiss = rpc.declare({ object: 'luci.fwupdate', method: 'packages_dismiss' });

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

/* "15:27", for a time later today */
function fmtClock(sec) {
	const d = new Date(sec * 1000);
	return pad(d.getHours()) + ':' + pad(d.getMinutes());
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

function names(list) {
	return list.map(function(p) { return (typeof p == 'string') ? p : p.name; }).join(', ');
}

/* after installing the packages the router restarts once, so that they start as after a boot */
function rebootNote() {
	return E('p', {}, E('strong', _('After installing your packages the router restarts once.')));
}

/* a restore that has just ended and restarts the router in a moment */
function rebootPending(d) {
	const pk = d && d.packages;
	return !!(pk && pk.reboot && (pk.state == 'done' || pk.state == 'partial') && d.booted && pk.finished >= d.booted);
}

/* a list of packages: on one line while it is short, folded with its count when it is long */
const SHORT_LIST = 6;

function packageList(label, list, extra) {
	const text = names(list) + (extra ? ' ' + extra : '');
	if (list.length <= SHORT_LIST)
		return E('p', label + ': ' + text);
	return E('details', { 'style': 'margin:.4em 0' }, [
		E('summary', { 'style': 'cursor:pointer' }, label + ' (' + list.length + ')'),
		E('p', { 'style': 'margin:.3em 0 0 1.2em' }, text)
	]);
}

/* packages with the reason why they did not work out, folded the same way */
function reasonList(label, list) {
	const items = E('ul', { 'style': LIST_STYLE }, list.map(function(f) {
		return E('li', f.name + ' — ' + packageReason(f));
	}));
	if (list.length <= SHORT_LIST)
		return E('div', {}, [ E('p', label + ':'), items ]);
	return E('details', { 'style': 'margin:.4em 0' }, [
		E('summary', { 'style': 'cursor:pointer' }, label + ' (' + list.length + ')'),
		items
	]);
}

function packageReason(f) {
	switch (f.reason) {
	case 'not_found': return _('not in the package repositories');
	case 'conflict': return _('conflicts with the firmware');
	case 'space': return _('not enough space');
	case 'untrusted': return _('the key of its repository is missing');
	case 'network': return _('no connection');
	case 'skipped': return _('kept, because not every package could be installed');
	default: return (f.action == 'remove') ? _('could not be removed') : _('could not be installed');
	}
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
		return Promise.all([ callStatus(), L.resolveDefault(callPackages(), null) ]);
	},

	render: function(data) {
		this.data = data[0];
		/* the packages the user added to or removed from the image */
		this.pkgs = (data[1] && data[1].added) ? data[1] : { added: [], removed: [] };
		this.keep = true;
		this.keepPackages = true;

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
				E('div', { 'class': 'cbi-section', 'id': 'fwupdate-packages' }),
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
		/* like after flashing: wait for the router and load the page again */
		if (rebootPending(this.data) && !this.rebootShown) {
			this.rebootShown = true;
			ui.showModal(_('Restarting the router'), [
				E('p', { 'class': 'spinning' }, E('strong', _('Your packages are installed. The router restarts now.')))
			]);
			ui.awaitReconnect(window.location.host);
		}
		this.renderAsu();
		this.renderInstalled();
		this.renderPackages();
		this.renderRelease();
	},

	/* the number of the user's package changes, and those that come back without the user */
	packageCount: function() {
		return this.pkgs.added.length + this.pkgs.removed.length;
	},

	manualPackages: function() {
		return this.pkgs.added.filter(function(p) { return p.source == 'file'; });
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
			'change': L.bind(function(ev) { this.keep = ev.target.checked; this.renderRelease(); }, this)
		});

		/* without the settings the list of packages is not kept either */
		const count = this.packageCount();
		const pkgAllowed = keepAllowed && this.keep;
		const keepPkgs = E('input', {
			'type': 'checkbox',
			'checked': (pkgAllowed && this.keepPackages) ? '' : null,
			'disabled': pkgAllowed ? null : '',
			'change': L.bind(function(ev) { this.keepPackages = ev.target.checked; this.renderRelease(); }, this)
		});

		/* a row of its own: the themes align .cbi-page-actions differently */
		items.push(E('div', { 'style': 'display:flex; flex-wrap:wrap; align-items:center; gap:.6em 1em; margin:1em 0' }, [
			(st.method != 'manual') ? E('label', {}, [ keep, ' ', _('Keep settings') ]) : '',
			(st.method != 'manual' && count) ? E('label', {
				'title': pkgAllowed ? null : _('Without the settings the list of packages is not kept either.')
			}, [ keepPkgs, ' ', _('Keep my packages (%d)').format(count) ]) : '',
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

		/* only while the packages are kept */
		if (st.method != 'manual' && count && pkgAllowed && this.keepPackages)
			items.push(this.packageDetails());

		dom.content(node, items);
	},

	/* what "Keep my packages" brings back, folded */
	packageDetails: function() {
		const again = this.pkgs.added.filter(function(p) { return p.source != 'file'; });
		const manual = this.manualPackages();

		return E('details', { 'style': 'margin:-.4em 0 1em' }, [
			E('summary', { 'style': 'cursor:pointer' }, _('What is kept')),
			E('div', { 'style': 'margin-top:.4em' }, [
				again.length ? packageList(_('Installed again after the update'), again) : '',
				this.pkgs.removed.length ? packageList(_('Firmware packages you removed will be removed again'), this.pkgs.removed) : '',
				manual.length ? packageList(_('Installed not from a repository (from a file or by a script), to be installed again by hand'), manual) : '',
				(again.length || this.pkgs.removed.length) ? rebootNote() : ''
			])
		]);
	},

	renderPackages: function() {
		const pk = this.data.packages;
		const node = this.node('fwupdate-packages');

		/* a request turns into a restore after the update */
		if (!pk || pk.state == 'requested') {
			dom.content(node, null);
			node.style.display = 'none';
			return;
		}
		node.style.display = '';

		const res = pk.result;
		const items = [ E('h3', _('Your packages after the update')) ];
		const button = L.bind(function(title, fn, action) {
			return E('button', {
				'class': 'btn cbi-button' + (action ? ' cbi-button-action' : ''),
				'click': ui.createHandlerFn(this, function() { return fn().then(L.bind(this.pollStatus, this)); })
			}, title);
		}, this);
		let buttons = [];

		switch (pk.state) {
		case 'pending':
			if (pk.phase == 'connecting')
				items.push(E('p', { 'class': 'spinning' }, _('Checking the connection to the package repositories…')));
			else if (pk.next)
				items.push(E('p', _('The router starts installing your packages at about %s, once the internet and DNS work after the boot.').format(fmtClock(pk.next))));
			else
				items.push(E('p', { 'class': 'spinning' }, _('Your packages are installed in a moment.')));
			items.push(rebootNote());
			buttons = [ button(_('Cancel'), callPackagesCancel) ];
			break;
		case 'running':
			items.push(E('p', { 'class': 'spinning' }, _('Installing your packages…')), rebootNote());
			break;
		case 'waiting':
			items.push((pk.phase == 'connecting')
				? E('p', { 'class': 'spinning' }, _('Checking the connection to the package repositories…'))
				: E('p', _('No connection to the package repositories: the router installs your packages as soon as it is online.')), rebootNote());
			if (pk.tried)
				items.push(E('p', _('Attempts: %d, the last at %s.').format(pk.attempts || 0, fmtTime(pk.tried)) +
					((pk.next && pk.phase != 'connecting') ? ' ' + _('The next one at about %s.').format(fmtClock(pk.next)) : '')));
			buttons = [ button(_('Try again now'), callPackagesRetry, true), button(_('Cancel'), callPackagesCancel) ];
			break;
		case 'cancelled':
			items.push(E('p', _('You cancelled installing your packages.')));
			buttons = [ button(_('Try again'), callPackagesRetry, true), button(_('Hide'), callPackagesDismiss) ];
			break;
		default: {
			const failed = (res && res.failed) || [], manual = (res && res.manual) || [];
			items.push(E('p', {}, E('strong', (pk.state == 'failed') ? _('Your packages could not be installed.')
				: failed.length ? _('Some of your packages could not be installed.')
				: manual.length ? _('Your packages are installed again, except those installed not from a repository.')
				: _('Your packages are installed again.'))));
			/* trying again only helps with what apk refused, not with packages from a file */
			buttons = (failed.length || !res) ? [ button(_('Try again'), callPackagesRetry, true), button(_('Hide'), callPackagesDismiss) ]
				: [ button(_('Hide'), callPackagesDismiss) ];
		}
		}

		if (res && pk.state != 'running') {
			const failed = res.failed || [];
			const installs = failed.filter(function(f) { return f.action != 'remove'; });
			const removals = failed.filter(function(f) { return f.action == 'remove'; });

			if (res.installed && res.installed.length)
				items.push(packageList(_('Installed again'), res.installed, res.deps ? _('(and %d packages they need)').format(res.deps) : ''));
			if (res.replaced && res.replaced.length)
				items.push(packageList(_('Replaced'), res.replaced.map(function(r) { return r.name + ' → ' + r.by; })));
			if (res.removed && res.removed.length)
				items.push(packageList(_('Firmware packages you removed are removed again'), res.removed));
			if (res.disabled && res.disabled.length)
				items.push(packageList(_('Services switched off again'), res.disabled));
			if (installs.length)
				items.push(reasonList(_('Not installed'), installs));
			if (removals.length)
				items.push(reasonList(_('Could not be removed again'), removals));
			if (res.manual && res.manual.length)
				items.push(packageList(_('Installed not from a repository (from a file or by a script), install them again by hand'), res.manual));
			if (res.changed && res.changed.length)
				items.push(E('p', _('The packages changed these settings files: %s. Their earlier versions are in %s.')
					.format(res.changed.join(', '), '/etc/fwupdate/config-before')));
			if (installs.length)
				items.push(E('p', _('"Try again" installs the missing packages once more, e.g. after they appear in the repositories or space is freed.')));
			const messages = failed.filter(function(f) { return f.message; });
			if (messages.length)
				items.push(E('details', {}, [
					E('summary', { 'style': 'cursor:pointer' }, _('Details')),
					E('pre', { 'style': 'white-space:pre-wrap' }, messages.map(function(f) { return f.name + ':\n' + f.message; }).join('\n\n'))
				]));
		}
		if (rebootPending(this.data))
			items.push(E('p', { 'class': 'spinning' }, E('strong', _('Your packages are installed. The router restarts now.'))));
		else if (pk.reboot && (pk.state == 'done' || pk.state == 'partial'))
			items.push(E('p', _('The router restarted after installing the packages.')));
		if (pk.error && pk.state != 'running')
			items.push(E('details', {}, [ E('summary', { 'style': 'cursor:pointer' }, _('Details')), E('pre', { 'style': 'white-space:pre-wrap' }, pk.error) ]));

		if (buttons.length)
			items.push(E('div', { 'style': 'display:flex; flex-wrap:wrap; gap:.6em 1em; margin:1em 0' }, buttons));

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

		const packages = keep && this.keepPackages && this.packageCount() > 0;
		const manual = this.manualPackages();

		ui.showModal(_('Update to %s').format(st.latest.tag), [
			keep ? E('p', _('The settings are kept.')) : E('div', {}, [
				why ? E('p', why) : '',
				E('p', { 'class': 'alert-message warning' },
					_('Without the settings the router starts as after a reset: address 192.168.1.1, no password, Wi-Fi password 12345678.'))
			]),
			packages ? E('p', _('Once the router is online after the update, it installs your packages again.')) : '',
			(packages && manual.length) ? packageList(_('Packages installed not from a repository (from a file or by a script) are not installed again'), manual) : '',
			(packages && this.pkgs.added.length > manual.length || packages && this.pkgs.removed.length) ? rebootNote() : '',
			E('p', {}, E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'handleBackup') }, _('Download a backup of the settings'))),
			E('p', _('Do not unplug the router while it installs the update.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return this.doUpgrade(keep, packages);
					})
				}, _('Install'))
			])
		]);
	},

	/* the same as Backup / Flash Firmware -> Generate archive, with the current list of packages */
	handleBackup: function(ev) {
		const parent = ev.currentTarget.parentNode;
		return L.resolveDefault(callPackagesSave(), null).then(function() {
			const form = E('form', {
				'method': 'post',
				'action': L.env.cgi_base + '/cgi-backup',
				'enctype': 'application/x-www-form-urlencoded'
			}, E('input', { 'type': 'hidden', 'name': 'sessionid', 'value': rpc.getSessionID() }));

			parent.appendChild(form);
			form.submit();
			form.parentNode.removeChild(form);
		});
	},

	doUpgrade: function(keep, packages) {
		return callUpgrade(keep, packages).then(L.bind(function(res) {
			if (res && res.error == 'packages')
				return this.showError(_('The list of packages could not be saved.'));
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
