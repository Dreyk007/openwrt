'use strict';
'require view';
'require form';
'require fs';
'require poll';

const policy = '/sys/devices/system/cpu/cpufreq/policy0/';

function readValue(name) {
	return L.resolveDefault(fs.read(policy + name), '').then(function (value) {
		return value.trim();
	});
}

function mhz(khz) {
	return khz ? '%s MHz'.format(+(khz / 1000).toFixed(1)) : '?';
}

function currentState(governor, freq) {
	return '%s, %s'.format(governor || '?', mhz(+freq));
}

return view.extend({
	load: function () {
		return Promise.all([
			readValue('scaling_available_governors'),
			readValue('scaling_governor'),
			readValue('scaling_cur_freq'),
			readValue('scaling_min_freq'),
			readValue('scaling_max_freq')
		]);
	},

	render: function (data) {
		const available = data[0].split(/\s+/).filter(function (g) {
			/* userspace needs a frequency set by hand, which this page does not do */
			return g && g != 'userspace';
		});
		const labels = {
			schedutil: _('schedutil: follows the load (default)'),
			performance: _('performance: always the maximum frequency'),
			ondemand: _('ondemand: samples the load periodically'),
			conservative: _('conservative: changes the frequency in small steps'),
			powersave: _('powersave: always the minimum frequency')
		};
		let m, s, o;

		m = new form.Map('cpufreq', _('CPU Frequency'),
			_('The CPU frequency governor of the router, applied immediately and at every boot.'));

		s = m.section(form.NamedSection, 'settings', 'settings');

		o = s.option(form.DummyValue, '_current', _('Current state'),
			_('Frequency range: %s – %s').format(mhz(+data[3]), mhz(+data[4])));
		o.rawhtml = true;
		o.cfgvalue = function () {
			return E('span', { 'id': 'cpufreq-current' }, currentState(data[1], data[2]));
		};

		o = s.option(form.ListValue, 'governor', _('Governor'),
			_('<code>schedutil</code> raises the clock with the load and saves energy at idle. <code>performance</code> keeps the maximum frequency all the time: measured on this router it needed 28%% less CPU per Gbit/s on Wi-Fi to LAN bridging and lowered the idle Wi-Fi latency by about 0.2 ms, but the throughput and the latency under load stayed the same and the router ran about 2 °C warmer.').format());
		available.forEach(function (g) {
			o.value(g, labels[g] || g);
		});
		o.default = 'schedutil';

		poll.add(function () {
			return Promise.all([readValue('scaling_governor'), readValue('scaling_cur_freq')]).then(function (cur) {
				const el = document.getElementById('cpufreq-current');
				if (el)
					el.textContent = currentState(cur[0], cur[1]);
			});
		}, 5);

		return m.render();
	}
});
