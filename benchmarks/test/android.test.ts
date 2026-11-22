import { describe, expect, it } from 'vitest';
import {
	describeDevice,
	hasAbstractSocket,
	parseBattery,
	parseGetprop,
	parseResidentBytes,
	parseThermal,
	parseVersionName,
} from '../src/android.ts';

const BATTERY = `Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Dock powered: false
  Max charging current: 0
 Time when the latest updated value of the Max charging current was sent via battery changed broadcast: 0
  Charge counter: 3762000
  status: 2
  health: 2
  present: true
  level: 86
  scale: 100
  voltage: 4343
  temperature: 268
  technology: Li-ion
  Charging state: 0
`;

const THERMAL = `IsStatusOverride: false
Thermal Status: 1
Cached temperatures:
	Temperature{mValue=28.6, mType=2, mName=SUBBAT, mStatus=0}
	Temperature{mValue=43.3, mType=0, mName=AP, mStatus=0}
HAL Ready: true
HAL connection:
	ThermalHAL AIDL 3  connected: yes
Current temperatures from HAL:
	Temperature{mValue=29.8, mType=0, mName=AP, mStatus=0}
	Temperature{mValue=26.9, mType=2, mName=BAT, mStatus=0}
	Temperature{mValue=31.4, mType=3, mName=SKIN, mStatus=1}
Current cooling devices from HAL:
	CoolingDevice{mValue=0, mType=2, mName=battery}
`;

describe('parseBattery', () => {
	it('reads the level, the temperature in degrees, the status and the power sources', () => {
		expect(parseBattery(BATTERY)).toEqual({
			level: 86,
			temperatureC: 26.8,
			status: 'charging',
			powered: ['usb'],
		});
	});

	it('gives nulls and an unknown status for text it cannot read', () => {
		expect(parseBattery('')).toEqual({ level: null, temperatureC: null, status: 'unknown', powered: [] });
	});
});

describe('parseThermal', () => {
	it("reads the status and the HAL's current temperatures, not the cached ones", () => {
		expect(parseThermal(THERMAL)).toEqual({ status: 1, temperatures: { AP: 29.8, BAT: 26.9, SKIN: 31.4 } });
	});

	it('gives no status and no temperatures for text it cannot read', () => {
		expect(parseThermal('Permission denied')).toEqual({ status: null, temperatures: {} });
	});
});

describe('parseGetprop', () => {
	it('reads one property per line, values may be empty or hold brackets', () => {
		const text = '[ro.product.model]: [SM-F966N]\n[ro.soc.model]: [SM8750]\n[empty]: []\n[odd]: [a [b]]\nnoise\n';
		expect(parseGetprop(text)).toEqual({
			'ro.product.model': 'SM-F966N',
			'ro.soc.model': 'SM8750',
			empty: '',
			odd: 'a [b]',
		});
	});
});

describe('describeDevice', () => {
	it('names the device from its properties, with null for those missing or empty', () => {
		const properties = {
			'ro.product.manufacturer': 'samsung',
			'ro.product.model': 'SM-F966N',
			'ro.soc.model': 'SM8750',
			'ro.build.version.release': '17',
			'ro.build.version.sdk': '',
		};
		expect(describeDevice('R3CY', properties, '157.0.8103.78', null)).toEqual({
			serial: 'R3CY',
			manufacturer: 'samsung',
			model: 'SM-F966N',
			soc: 'SM8750',
			android: '17',
			sdk: null,
			chrome: '157.0.8103.78',
			display: null,
		});
	});
});

describe('hasAbstractSocket', () => {
	const unix =
		'Num       RefCount Protocol Flags    Type St Inode Path\n' +
		'0000000000000000: 00000002 00000000 00010000 0001 01 97511366 @Terrace_devtools_remote\n';

	it('finds a socket by its whole name only', () => {
		expect(hasAbstractSocket(unix, 'chrome_devtools_remote')).toBe(false);
		expect(hasAbstractSocket(unix, 'Terrace_devtools_remote')).toBe(true);
		const chrome = `${unix}0000000000000000: 00000002 00000000 00010000 0001 01 97845044 @chrome_devtools_remote\n`;
		expect(hasAbstractSocket(chrome, 'chrome_devtools_remote')).toBe(true);
	});
});

describe('parseResidentBytes', () => {
	it('sums the kibibytes of every process', () => {
		expect(parseResidentBytes('  5536\n  1024\n')).toBe((5536 + 1024) * 1024);
	});

	it('gives null when no process was listed', () => {
		expect(parseResidentBytes('')).toBeNull();
		expect(parseResidentBytes('bad pid list\n')).toBeNull();
	});
});

describe('parseVersionName', () => {
	it('takes the first version, the one installed over the system image', () => {
		expect(parseVersionName('    versionName=157.0.8103.78\n    versionName=149.0.7827.102\n')).toBe('157.0.8103.78');
		expect(parseVersionName('')).toBeNull();
	});
});
