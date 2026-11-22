// Geometry uses device pixels and window indices. All three backends share the
// binary64 projection and heatmap reduction ranges computed by the chart.
const header = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform ivec2 pane;
uniform usampler2D records;
uniform usampler2D ranges;
uniform usampler2D style;
// Per word texture: log2 of its row width, and the row width less one.
uniform ivec2 recordsStride;
uniform ivec2 rangesStride;
uniform ivec2 styleStride;
uint word(usampler2D source, ivec2 stride, int i) {
	return texelFetch(source, ivec2(i & stride.y, i >> stride.x), 0).r;
}
uint recordWord(int i) { return word(records, recordsStride, i); }
uint rangeWord(int i) { return word(ranges, rangesStride, i); }
uint styleWord(int i) { return word(style, styleStride, i); }
vec4 color(uint bits) {
	return vec4(uvec4(bits, bits >> 8u, bits >> 16u, bits >> 24u) & 255u) / 255.0;
}
`;

// A scatter point is an instance: a square of its own size or the series' (`base`), placed on the
// device pixel its time and price round to. Records hold, per row, `recordWords` words: the pixel
// row of its center, its color (or, for densities, its count as float bits), and with sizes its
// width in device pixels (0: the series' size). The column comes from `ranges`, padded by the
// widest point in view (`stamp`), so any point that covers a column of the strip is drawn.
export const scatterVertex =
	header +
	`
layout(location=0) in vec2 corner;
uniform int first;
uniform int stamp;
uniform int base;
uniform int recordWords;
flat out uint rgba;
flat out ivec2 origin;
flat out int size;
void main() {
	int id = first + gl_InstanceID;
	// ranges[i] is the first point whose center is at or beyond column i minus the padding.
	int lo = 0, hi = pane.x + stamp - 1;
	while (lo + 1 < hi) {
		int mid = (lo + hi) >> 1;
		if (rangeWord(mid) <= uint(id)) lo = mid; else hi = mid;
	}
	int at = recordWords * id;
	size = base;
	if (recordWords > 2) {
		int own = int(recordWord(at + 2));
		if (own > 0) size = own;
	}
	int center = lo - (stamp - 1 - stamp / 2);
	origin = ivec2(center - size / 2, int(recordWord(at)) - size / 2);
	rgba = recordWord(at + 1);
	vec2 p = vec2(origin + size * ivec2(corner)) / vec2(pane);
	gl_Position = vec4(p * vec2(2,-2) + vec2(-1,1), 0, 1);
}`;

// The pixels of a disc whose centers are inside it, as `makeStamp` has them. Below 256 pixels
// across the bounds cannot round otherwise in 32-bit floats: a bound is (s + 1) / 2 -
// sqrt((2c + 1)(2s - 2c - 1)) / 2 for a column c of a disc s wide, which is never a whole number
// (the product of two odd numbers that sum to 2s is a square only for an odd s, whose bound is
// then a half), and stays at least 1 / (4s + 2) away from one, more than ten times the error of a 32-bit
// square root there.
const disc = `
	if (circle && size >= 3) {
		ivec2 local = ivec2(int(gl_FragCoord.x), pane.y - 1 - int(gl_FragCoord.y)) - origin;
		float r = float(size) / 2.0, d = float(local.x) + 0.5 - r;
		float halfSpan = sqrt(max(0.0, r*r - d*d));
		if (local.y < int(floor(r-halfSpan+0.5)) || local.y >= int(floor(r+halfSpan+0.5))) discard;
	}`;

export const scatterFragment =
	header +
	`
uniform bool circle;
flat in uint rgba;
flat in ivec2 origin;
flat in int size;
out vec4 pixel;
void main() {${disc}
	pixel = color(rgba);
}`;

// Densities: every fragment adds its point's count to a 32-bit float target, blended in instance
// order. Counts are whole numbers, so sums are exact below 2^24, as Canvas 2D sums them.
export const densityFragment =
	header +
	`
uniform bool circle;
flat in uint rgba;
flat in ivec2 origin;
flat in int size;
out vec4 pixel;
void main() {${disc}
	pixel = vec4(uintBitsToFloat(rgba), 0.0, 0.0, 0.0);
}`;

const densityHeader =
	header +
	`
precision highp sampler2D;
uniform sampler2D density;
`;

// The largest density of each tile of `tile` by `tile` texels of the level below, `extent` texels
// across: a few passes bring a frame to one texel, read back as the top of the palette.
export const reduceFragment =
	densityHeader +
	`
uniform ivec2 extent;
uniform int tile;
out vec4 pixel;
void main() {
	ivec2 from = ivec2(gl_FragCoord.xy) * tile;
	ivec2 to = min(from + tile, extent);
	float best = 0.0;
	for (int y = from.y; y < to.y; ++y)
		for (int x = from.x; x < to.x; ++x) best = max(best, texelFetch(density, ivec2(x, y), 0).r);
	pixel = vec4(best, 0.0, 0.0, 0.0);
}`;

// A density's palette entry is the number of thresholds (style words 1 to 255, as `DensityScale`
// makes them) at or below its bits; the colors follow at 256. With `exact`, the palette spans from
// 1 to the largest density, the texel of the last reduction pass (`peak`), and the entry is
// `exactDensitySlot`'s, in whole numbers: 255 (d - 1) / (top - 1) rounded half up, both halved
// together while the top is 2^24 or more, so 255 (d - 1) stays within 32 bits. No density:
// transparent.
export const densityColorFragment =
	densityHeader +
	`
uniform bool exact;
uniform sampler2D peak;
out vec4 pixel;
void main() {
	float d = texelFetch(density, ivec2(gl_FragCoord.xy), 0).r;
	if (!(d > 0.0)) {
		pixel = vec4(0.0);
		return;
	}
	int slot;
	if (exact) {
		uint a = uint(min(d, 4294967040.0)) - 1u;
		uint m = uint(min(texelFetch(peak, ivec2(0), 0).r, 4294967040.0)) - 1u;
		if (m == 0u) {
			slot = 128;
		} else {
			while (m >= 16777216u) {
				m >>= 1u;
				a >>= 1u;
			}
			uint n = 255u * a;
			uint q = n / m;
			slot = min(255, int(q) + (2u * (n - q * m) >= m ? 1 : 0));
		}
	} else {
		uint key = floatBitsToUint(d);
		int lo = 0, hi = 256;
		while (lo + 1 < hi) {
			int mid = (lo + hi) >> 1;
			if (key >= styleWord(mid)) lo = mid; else hi = mid;
		}
		slot = lo;
	}
	pixel = color(styleWord(256 + slot));
}`;

export const heatVertex =
	header +
	`
layout(location=0) in vec2 corner;
void main() {
	gl_Position = vec4(corner * 2.0 - 1.0, 0, 1);
}`;

export const heatFragment =
	header +
	`
uniform int rows;
out vec4 pixel;
void main() {
	int x = int(gl_FragCoord.x) * 2;
	int y = (pane.x + pane.y - 1 - int(gl_FragCoord.y)) * 2;
	int from = int(rangeWord(x)), to = int(rangeWord(x+1));
	int low = int(rangeWord(y)), high = int(rangeWord(y+1));
	uint best = 0u;
	for (int c = from; c < to; ++c) {
		for (int i = c*rows+low, end = c*rows+high; i < end; ++i) {
			uint bits = recordWord(i);
			if ((bits & 0x7fffffffu) <= 0x7f800000u)
				best = max(best, (bits >> 31u) != 0u ? ~bits : bits ^ 0x80000000u);
		}
	}
	int slot = 0;
	if (best != 0u) {
		int lo = 1, hi = 256;
		while (lo+1 < hi) {
			int mid = (lo+hi) >> 1;
			if (best >= styleWord(256+mid)) lo=mid; else hi=mid;
		}
		slot = lo;
	}
	pixel = color(styleWord(slot));
}`;

// Palette slots (see `quantize`), four to a word with the first cell in the low byte: the highest
// slot of the cells a pixel covers picks its color, without a search.
export const heatSlotsFragment =
	header +
	`
uniform int rows;
out vec4 pixel;
void main() {
	int x = int(gl_FragCoord.x) * 2;
	int y = (pane.x + pane.y - 1 - int(gl_FragCoord.y)) * 2;
	int from = int(rangeWord(x)), to = int(rangeWord(x+1));
	int low = int(rangeWord(y)), high = int(rangeWord(y+1));
	uint best = 0u;
	if (low < high) {
		for (int c = from; c < to; ++c) {
			// Cells [a, b) lie in words [a >> 2, (b - 1) >> 2]; bytes of other cells are masked off.
			int a = c*rows+low, b = c*rows+high;
			for (int i = a >> 2, last = (b - 1) >> 2; i <= last; ++i) {
				int lo = max(a - (i << 2), 0), hi = min(b - (i << 2), 4);
				uint bits = recordWord(i) & (0xffffffffu << uint(lo << 3)) & (0xffffffffu >> uint((4 - hi) << 3));
				best = max(best, max(max(bits & 255u, (bits >> 8u) & 255u), max((bits >> 16u) & 255u, bits >> 24u)));
			}
		}
	}
	pixel = color(styleWord(int(best)));
}`;
