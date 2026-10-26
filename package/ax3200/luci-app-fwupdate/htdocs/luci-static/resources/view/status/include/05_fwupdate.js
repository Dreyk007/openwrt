'use strict';
'require baseclass';
'require rpc';
'require ui';
'require dom';

const callStatus = rpc.declare({ object: 'luci.fwupdate', method: 'status' });

/* the status when the Overview page should tell about a new release, otherwise null */
function pending(d) {
	const st = d && d.status;
	if (!st || !st.update || !st.latest || !d.settings.notify || d.settings.skip == st.latest.tag)
		return null;
	return st;
}

/* a restore that has just ended and restarts the router in a moment */
function rebootPending(d) {
	const pk = d && d.packages;
	return !!(pk && pk.reboot && (pk.state == 'done' || pk.state == 'partial') && d.booted && pk.finished >= d.booted);
}

/*
 * The restore of the user's packages after an update while it runs, waits or restarts the
 * router, and when it did not install everything; null otherwise.
 */
function packagesNotice(d) {
	const pk = d && d.packages;
	if (!pk || !(pk.state in { pending: 1, running: 1, waiting: 1, failed: 1, partial: 1 } || rebootPending(d)))
		return null;
	return Object.assign({ restarting: rebootPending(d) }, pk);
}

function pad(n) {
	return (n < 10 ? '0' : '') + n;
}

/* "15:27", for a time later today */
function fmtClock(sec) {
	const d = new Date(sec * 1000);
	return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function packagesContent(pk) {
	const active = (pk.state == 'pending' || pk.state == 'running' || pk.state == 'waiting');
	let text;

	if (pk.restarting)
		text = _('Your packages are installed. The router restarts now.');
	else if (active && pk.phase == 'connecting')
		text = _('Checking the connection to the package repositories…');
	else if (pk.state == 'pending' && pk.next)
		text = _('The router starts installing your packages at about %s, once the internet and DNS work after the boot.').format(fmtClock(pk.next));
	else if (pk.state == 'pending')
		text = _('Your packages are installed in a moment.');
	else if (pk.state == 'running')
		text = _('Installing your packages…');
	else if (pk.state == 'waiting')
		text = _('No connection to the package repositories: the router installs your packages as soon as it is online.');
	else if (pk.state == 'failed')
		text = _('Your packages could not be installed after the update.');
	else if (pk.result && pk.result.failed && pk.result.failed.length)
		text = _('Some of your packages could not be installed after the update.');
	else
		text = _('Packages installed not from a repository have to be installed again by hand.');

	return [
		E('p', {}, E('strong', _('Your packages after the update'))),
		E('p', (pk.restarting || pk.state == 'running' || pk.phase == 'connecting' || (pk.state == 'pending' && !pk.next)) ? { 'class': 'spinning' } : {},
			pk.restarting ? E('strong', text) : text),
		active ? E('p', {}, E('strong', _('After installing your packages the router restarts once.'))) : ''
	];
}

/*
 * The notice is a LuCI notification at the top of the Overview page. The Footstrap theme
 * switches pages without reloading and sweeps notifications away, and the Overview page
 * runs its includes before it is shown, so the notice is put back whenever it is missing
 * while the Overview page is open, until the user closes it for what it shows.
 */
let notice = null, noticeKey = null, closedKey = null, last = null, lastPackages = null;

function onOverview() {
	const path = location.pathname.replace(/\/+$/, '');
	return path == L.url('admin/status/overview') || path == L.url().replace(/\/+$/, '');
}

/* the changes of every release since the installed one, folded */
function changes(st) {
	let total = 0;
	st.releases.forEach(function(r) { total += r.changes.length; });
	if (!total)
		return '';

	return E('details', { 'style': 'margin:.3em 0 .6em' }, [
		E('summary', { 'style': 'cursor:pointer' }, _('List of changes (%d)').format(total)),
		E('div', { 'style': 'margin-top:.4em' }, st.releases.map(function(r) {
			return E('div', {}, [
				(st.releases.length > 1) ? E('p', { 'style': 'margin:.4em 0 .1em' }, E('strong', r.tag)) : '',
				E('ul', { 'style': 'margin:0 0 0 1.4em; list-style:disc' }, r.changes.map(function(c) {
					return E('li', c.subject);
				}))
			]);
		}))
	]);
}

/*
 * Footstrap draws every button in a notification plain; give the button of the notice the look
 * of the theme's action buttons, taken from one drawn outside of it.
 */
function actionStyle() {
	if (document.getElementById('fwupdate-notice-style'))
		return;
	const probe = E('button', { 'class': 'btn cbi-button cbi-button-action', 'style': 'position:absolute; visibility:hidden' });
	(document.querySelector('#maincontent') || document.body).appendChild(probe);
	const c = getComputedStyle(probe);
	const css = '#fwupdate-notice .cbi-button-action { background:%s; color:%s; border-color:%s; text-decoration:none }'
		.format(c.backgroundColor, c.color, c.borderColor) +
		' #fwupdate-notice .cbi-button-action:hover { filter:brightness(1.12) }';
	probe.parentNode.removeChild(probe);
	document.head.appendChild(E('style', { 'id': 'fwupdate-notice-style' }, css));
}

function content(st, pk) {
	return [
		pk ? E('div', {}, packagesContent(pk)) : '',
		st ? E('p', {}, E('strong', _('A new release of the AX3200 / AX6S build is available: %s.').format(st.latest.tag))) : '',
		(st && st.method == 'manual') ? E('p', _('It has to be installed manually: see the update page.')) : '',
		st ? changes(st) : '',
		E('p', {}, E('a', { 'class': 'btn cbi-button cbi-button-action', 'href': L.url('admin/system/fwupdate') }, _('Open the update page')))
	];
}

function update() {
	const st = last, pk = lastPackages;
	const key = JSON.stringify([ st ? [ st.latest.tag, st.method, st.releases ] : null, pk ? [ pk.state, pk.phase, pk.next, pk.finished || 0, pk.restarting ] : null ]);

	if ((!st && !pk) || !onOverview() || closedKey == key) {
		if (notice && notice.parentNode)
			notice.parentNode.removeChild(notice);
		notice = null;
		return;
	}

	if (notice && document.body.contains(notice)) {
		if (key != noticeKey)
			dom.content(notice.firstElementChild, content(st, pk));
	}
	else {
		actionStyle();
		notice = ui.addNotification(null, content(st, pk), 'notice');
		notice.id = 'fwupdate-notice';
		const close = notice.lastElementChild.querySelector('button');
		if (close)
			close.addEventListener('click', function() { closedKey = noticeKey; });
	}
	noticeKey = key;
}

return baseclass.extend({
	title: _('AX3200 / AX6S build updates'),

	load: function() {
		return L.resolveDefault(callStatus(), null);
	},

	/* called on every refresh of the Overview page; the include itself shows no section */
	render: function(d) {
		last = pending(d);
		lastPackages = packagesNotice(d);
		update();
		/* again once the page is shown and the theme has swept the old notifications */
		window.setTimeout(update, 300);
		window.setTimeout(update, 1500);
		return null;
	}
});
