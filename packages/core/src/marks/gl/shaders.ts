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

export const scatterVertex =
	header +
	`
layout(location=0) in vec2 corner;
uniform int first;
uniform int stamp;
flat out uint rgba;
flat out ivec2 origin;
void main() {
	int id = first + gl_InstanceID;
	// ranges[i] is the first point at or beyond column i minus the padding.
	int lo = 0, hi = pane.x + stamp - 1;
	while (lo + 1 < hi) {
		int mid = (lo + hi) >> 1;
		if (rangeWord(mid) <= uint(id)) lo = mid; else hi = mid;
	}
	origin = ivec2(lo - stamp + 1, int(recordWord(2 * id)) - stamp / 2);
	rgba = recordWord(2 * id + 1);
	vec2 p = vec2(origin + stamp * ivec2(corner)) / vec2(pane);
	gl_Position = vec4(p * vec2(2,-2) + vec2(-1,1), 0, 1);
}`;

export const scatterFragment =
	header +
	`
uniform int stamp;
uniform bool circle;
flat in uint rgba;
flat in ivec2 origin;
out vec4 pixel;
void main() {
	if (circle && stamp >= 3) {
		ivec2 local = ivec2(int(gl_FragCoord.x), pane.y - 1 - int(gl_FragCoord.y)) - origin;
		float r = float(stamp) / 2.0, d = float(local.x) + 0.5 - r;
		float halfSpan = sqrt(max(0.0, r*r - d*d));
		if (local.y < int(floor(r-halfSpan+0.5)) || local.y >= int(floor(r+halfSpan+0.5))) discard;
	}
	pixel = color(rgba);
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
