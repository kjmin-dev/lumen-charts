// Geometry uses device pixels and window indices. All three backends share the
// binary64 projection and heatmap reduction ranges computed by the chart.
const header = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform ivec2 pane;
uniform usampler2D records;
uniform usampler2D ranges;
uint word(usampler2D source, int i) {
	int stride = textureSize(source, 0).x;
	return texelFetch(source, ivec2(i % stride, i / stride), 0).r;
}
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
		int mid = (lo + hi) / 2;
		if (word(ranges, mid) <= uint(id)) lo = mid; else hi = mid;
	}
	origin = ivec2(lo - stamp + 1, int(word(records, 2 * id)) - stamp / 2);
	rgba = word(records, 2 * id + 1);
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
uniform usampler2D style;
uniform int rows;
out vec4 pixel;
void main() {
	int x = int(gl_FragCoord.x) * 2;
	int y = (pane.x + pane.y - 1 - int(gl_FragCoord.y)) * 2;
	int from = int(word(ranges, x)), to = int(word(ranges, x+1));
	int low = int(word(ranges, y)), high = int(word(ranges, y+1));
	uint best = 0u;
	for (int c = from; c < to; ++c) {
		for (int r = low; r < high; ++r) {
			uint bits = word(records, c*rows+r);
			if ((bits & 0x7fffffffu) <= 0x7f800000u)
				best = max(best, (bits >> 31u) != 0u ? ~bits : bits ^ 0x80000000u);
		}
	}
	int slot = 0;
	if (best != 0u) {
		int lo = 1, hi = 256;
		while (lo+1 < hi) {
			int mid = (lo+hi)/2;
			if (best >= word(style, 256+mid)) lo=mid; else hi=mid;
		}
		slot = lo;
	}
	pixel = color(word(style, slot));
}`;
