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

/*
 * The notice is a LuCI notification at the top of the Overview page. The Footstrap theme
 * switches pages without reloading and sweeps notifications away, and the Overview page
 * runs its includes before it is shown, so the notice is put back whenever it is missing
 * while the Overview page is open, until the user closes it for this release.
 */
let notice = null, noticeKey = null, closedTag = null, last = null;

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

function content(st) {
	return [
		E('p', {}, E('strong', _('A new release of the AX3200 / AX6S build is available: %s.').format(st.latest.tag))),
		(st.method == 'manual') ? E('p', _('It has to be installed manually: see the update page.')) : '',
		changes(st),
		E('p', {}, E('a', { 'class': 'btn cbi-button cbi-button-action', 'href': L.url('admin/system/fwupdate') }, _('Open the update page')))
	];
}

function update() {
	const st = last;

	if (!st || !onOverview() || closedTag == st.latest.tag) {
		if (notice && notice.parentNode)
			notice.parentNode.removeChild(notice);
		notice = null;
		return;
	}

	const key = JSON.stringify([ st.latest.tag, st.method, st.releases ]);
	if (notice && document.body.contains(notice)) {
		if (key != noticeKey)
			dom.content(notice.firstElementChild, content(st));
	}
	else {
		const tag = st.latest.tag;
		actionStyle();
		notice = ui.addNotification(null, content(st), 'notice');
		notice.id = 'fwupdate-notice';
		const close = notice.lastElementChild.querySelector('button');
		if (close)
			close.addEventListener('click', function() { closedTag = tag; });
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
		update();
		/* again once the page is shown and the theme has swept the old notifications */
		window.setTimeout(update, 300);
		window.setTimeout(update, 1500);
		return null;
	}
});
