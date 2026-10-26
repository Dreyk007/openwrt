#!/usr/bin/env ucode
// Firmware update check of the Xiaomi AX3200 / Redmi AX6S build: the LuCI page System ->
// AX3200 / AX6S build updates and the notice on the Overview page. The check and the download
// run in the background (/usr/libexec/fwupdate); the page polls status. The user's packages
// are kept across an update by /usr/libexec/fwupdate-packages.

'use strict';

import { readfile, stat, access, unlink, popen } from 'fs';
import { cursor } from 'uci';

const DIR = '/tmp/fwupdate';
const IMAGE = DIR + '/firmware.bin';
const CHECKING = DIR + '/checking';
// a check or a download that has not finished after this long has died
const STALE = 900;
const PACKAGES = '/usr/libexec/fwupdate-packages';

function read_json(file) {
	const s = readfile(file);
	if (s == null)
		return null;
	try {
		return json(s);
	}
	catch (e) {
		return null;
	}
}

// the JSON a command prints, or null
function command_json(cmd) {
	const p = popen(cmd + ' 2>/dev/null');
	if (!p)
		return null;
	const out = p.read('all');
	p.close();
	try {
		return json(out);
	}
	catch (e) {
		return null;
	}
}

function installed() {
	const s = readfile('/etc/ax3200_release') || '';
	const get = (k) => {
		const m = match(s, regexp('(^|\n)' + k + "='([^']*)'"));
		return m ? m[2] : '';
	};
	return { release: get('RELEASE'), commit: get('COMMIT') };
}

// the shell returns at once and leaves cmd running on its own
function background(cmd) {
	system('(' + cmd + ') </dev/null >/dev/null 2>&1 &');
}

function running(file) {
	const s = stat(file);
	return s != null && time() - s.mtime < STALE;
}

function downloading() {
	const dl = read_json(DIR + '/download.json');
	return dl && dl.state == 'downloading' && time() - dl.started < STALE;
}

function asu_installed() {
	return access('/usr/share/luci/menu.d/luci-app-attendedsysupgrade.json') || access('/usr/bin/owut');
}

function status() {
	const c = cursor();
	const asu = asu_installed() ? true : false;
	const dl = read_json(DIR + '/download.json');
	if (dl && dl.state == 'downloading') {
		const s = stat(DIR + '/firmware.part');
		dl.done = s ? s.size : 0;
		if (time() - dl.started >= STALE)
			dl.state = 'error', dl.error = 'stalled';
	}
	return {
		installed: installed(),
		status: read_json(DIR + '/status.json'),
		download: dl,
		checking: running(CHECKING),
		settings: {
			enabled: c.get('fwupdate', 'settings', 'enabled') != '0',
			notify: c.get('fwupdate', 'settings', 'notify') != '0',
			skip: c.get('fwupdate', 'settings', 'skip') || ''
		},
		asu: asu,
		asu_alerts: asu && c.get('attendedsysupgrade', 'client', 'login_check_for_upgrades') != '0',
		packages: read_json('/etc/fwupdate/restore.json'),
		// the time of the last boot: whether the restart after a restore has happened yet
		booted: +(match(readfile('/proc/stat') || '', /\nbtime ([0-9]+)/) || [ 0, 0 ])[1]
	};
}

function check() {
	if (running(CHECKING))
		return { result: 'busy' };
	system('mkdir -p ' + DIR + ' && touch ' + CHECKING);
	background('/usr/libexec/fwupdate check; rm -f ' + CHECKING);
	return { result: 'started' };
}

function download() {
	if (downloading())
		return { result: 'busy' };
	const st = read_json(DIR + '/status.json');
	if (!st || !st.latest)
		return { error: 'no_release' };
	if (st.method == 'manual')
		return { error: 'manual' };
	background('/usr/libexec/fwupdate download');
	return { result: 'started' };
}

function upgrade(keep, packages) {
	const st = read_json(DIR + '/status.json');
	const dl = read_json(DIR + '/download.json');

	if (!st || !st.latest || !dl || dl.state != 'ready' || dl.tag != st.latest.tag ||
	    dl.sha256 != st.latest.sysupgrade.sha256 || !access(IMAGE))
		return { error: 'not_ready' };
	if (st.method == 'manual')
		return { error: 'manual' };

	keep = keep && st.method != 'reset' && dl.allow_backup;
	// without the settings the list of packages is not kept either
	if (keep && packages) {
		if (system([ PACKAGES, 'request', st.latest.tag ]) != 0)
			return { error: 'packages' };
	}
	else {
		system([ PACKAGES, 'forget' ]);
	}
	// sysupgrade does not return: start it after the reply has been sent
	background('sleep 1; exec /sbin/sysupgrade ' + (keep ? '' : '-n ') + IMAGE);
	return { result: 'ok', keep: keep };
}

function skip(tag) {
	const c = cursor();
	c.set('fwupdate', 'settings', 'skip', (type(tag) == 'string') ? tag : '');
	c.commit('fwupdate');
	return { result: 'ok' };
}

// Attended Sysupgrade shows its own notices about official OpenWrt releases
function asu_off() {
	const c = cursor();
	if (!c.get('attendedsysupgrade', 'client'))
		return { error: 'not_installed' };
	c.set('attendedsysupgrade', 'client', 'login_check_for_upgrades', '0');
	c.commit('attendedsysupgrade');
	return { result: 'ok' };
}

function discard() {
	if (downloading())
		return { result: 'busy' };
	unlink(IMAGE);
	unlink(DIR + '/firmware.part');
	unlink(DIR + '/download.json');
	return { result: 'ok' };
}

function packages_command(cmd) {
	return { result: (system([ PACKAGES, cmd ]) == 0) ? 'ok' : 'error' };
}

const methods = {
	status: { call: () => status() },
	check: { call: () => check() },
	download: { call: () => download() },
	discard: { call: () => discard() },
	upgrade: {
		args: { keep: false, packages: false },
		call: (req) => upgrade(req.args.keep ? true : false, req.args.packages ? true : false)
	},
	// the packages the user added to or removed from the image
	packages: { call: () => command_json(PACKAGES + ' list') || { error: 'list' } },
	// before a settings backup, so that the archive holds the current list
	packages_save: { call: () => packages_command('save') },
	packages_retry: { call: () => packages_command('retry') },
	packages_cancel: { call: () => packages_command('cancel') },
	packages_dismiss: { call: () => packages_command('dismiss') },
	skip: {
		args: { tag: '' },
		call: (req) => skip(req.args.tag)
	},
	asu_off: { call: () => asu_off() }
};

return { 'luci.fwupdate': methods };
