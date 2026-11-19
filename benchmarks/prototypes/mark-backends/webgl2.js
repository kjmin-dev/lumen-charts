import { glQueries } from './timers.js';
import { rows, width } from './scene.js';

const scatterVertex = `
in vec2 point;
uniform vec4 view;
uniform float scale;
flat out int side;
void main() {
	vec2 p = vec2(floor(point.x * scale), point.y) - view.zw;
	gl_Position = vec4((p + 0.5) / view.xy * vec2(2, -2) + vec2(-1, 1), 0, 1);
	if (any(lessThan(p, vec2(0))) || any(greaterThanEqual(p, view.xy))) gl_Position.xy = vec2(4);
	gl_PointSize = 3.0;
	side = gl_VertexID & 1;
}`;
const scatterFragment = `
flat in int side;
out vec4 color;
void main() {
	color = vec4((side == 0 ? vec3(38,166,154) : vec3(239,83,80)) / 255.0, 1);
}`;
const heatVertex = `
void main() {
	vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
	gl_Position = vec4(corner * 2.0 - 1.0, 0, 1);
}`;
const heatFragment = `
uniform vec4 view;
uniform float scale;
uniform sampler2D cells;
out vec4 color;
void main() {
	ivec2 size = textureSize(cells, 0);
	int x = int(floor((gl_FragCoord.x + view.z) / scale));
	int y = int(floor((view.y - gl_FragCoord.y + view.w) * 0.5));
	if (x < 0 || x >= size.x) discard;
	float v = texelFetch(cells, ivec2(x,y), 0).r;
	color = vec4(v, 1.0-v, 128.0/255.0, 1);
}`;

export function webgl2(target, scene, timer) {
	const gl = target.getContext('webgl2', { antialias: false, premultipliedAlpha: true });
	if (!gl) throw new Error('WebGL2 unavailable');
	const queries = timer && glQueries(gl, timer);
	const scatter = scene.type === 'scatter';
	const program = gl.createProgram();
	for (const [kind, source] of [
		[gl.VERTEX_SHADER, scatter ? scatterVertex : heatVertex],
		[gl.FRAGMENT_SHADER, scatter ? scatterFragment : heatFragment],
	]) {
		const shader = gl.createShader(kind);
		gl.shaderSource(shader, '#version 300 es\nprecision highp float;\nprecision highp int;\n' + source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
	gl.useProgram(program);
	gl.disable(gl.DITHER);
	const view = gl.getUniformLocation(program, 'view');
	const scale = gl.getUniformLocation(program, 'scale');
	if (scatter) {
		gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
		gl.bufferData(gl.ARRAY_BUFFER, scene.points, gl.DYNAMIC_DRAW);
		const p = gl.getAttribLocation(program, 'point');
		gl.enableVertexAttribArray(p);
		gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
	} else {
		gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, rows);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows, gl.RED, gl.UNSIGNED_BYTE, scene.cells);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	}
	return (v, first, count, update) => {
		gl.viewport(0, 0, v.w, v.h);
		gl.uniform4f(view, v.w, v.h, v.x + v.shift, v.y);
		gl.uniform1f(scale, v.scale);
		if (update && scatter) gl.bufferSubData(gl.ARRAY_BUFFER, first * 8, scene.points, first * 2, 2);
		if (update && !scatter)
			gl.texSubImage2D(gl.TEXTURE_2D, 0, width - 1, 0, 1, rows, gl.RED, gl.UNSIGNED_BYTE, scene.column);
		const sample = timer?.index >= 0;
		if (sample) queries.start();
		gl.clear(gl.COLOR_BUFFER_BIT);
		if (scatter) gl.drawArrays(gl.POINTS, first, count);
		else gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		if (sample) queries.end();
	};
}
