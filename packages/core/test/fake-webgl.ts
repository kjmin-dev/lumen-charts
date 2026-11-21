/** A texture of the fake context: its storage, one 32-bit word per texel. */
export interface FakeTexture {
	width: number;
	height: number;
	format: number;
	data: Uint32Array;
	deleted: boolean;
}

export interface FakeUpload {
	unit: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Stands in for a WebGL2 context: keeps texture storage and uploads, programs, uniforms and draws,
 * so a test can read what a mark series handed to the GPU. Shaders are not run.
 */
export class FakeWebGl {
	public readonly NO_ERROR = 0;
	public readonly TEXTURE0 = 0x84c0;
	public readonly ACTIVE_TEXTURE = 0x84e0;
	public readonly MAX_TEXTURE_SIZE = 0x0d33;
	public readonly VERTEX_SHADER = 0x8b31;
	public readonly FRAGMENT_SHADER = 0x8b30;
	public readonly R32UI = 0x8236;
	public readonly UNSIGNED_INT = 0x1405;
	public readonly uploads: FakeUpload[] = [];
	public readonly draws: { fragment: string; uniforms: Record<string, unknown[]> }[] = [];
	public readonly textures: FakeTexture[] = [];
	public maxTextureSize = 4096;
	private _unit = 0;
	private readonly _bound: (FakeTexture | null)[] = [];
	private _program: { fragment: string; uniforms: Record<string, unknown[]> } | null = null;

	public constructor(public readonly canvas: HTMLCanvasElement) {
		// Every other constant a caller reads is a number of its own.
		let next = 0x10000;
		return new Proxy(this, {
			get(target, property, receiver) {
				if (typeof property === 'string' && !(property in target) && /^[A-Z][A-Z0-9_]*$/.test(property)) {
					(target as unknown as Record<string, number>)[property] = next++;
				}
				return Reflect.get(target, property, receiver);
			},
		});
	}

	public get drawingBufferWidth(): number {
		return this.canvas.width;
	}
	public get drawingBufferHeight(): number {
		return this.canvas.height;
	}
	public isContextLost(): boolean {
		return false;
	}
	public getExtension(): null {
		return null;
	}
	public getError(): number {
		return this.NO_ERROR;
	}
	public getParameter(name: number): number {
		if (name === this.MAX_TEXTURE_SIZE) return this.maxTextureSize;
		if (name === this.ACTIVE_TEXTURE) return this.TEXTURE0 + this._unit;
		return 0;
	}

	public createShader(type: number): { type: number; source: string } {
		return { type, source: '' };
	}
	public shaderSource(shader: { source: string }, source: string): void {
		shader.source = source;
	}
	public createProgram(): { fragment: string; uniforms: Record<string, unknown[]> } {
		return { fragment: '', uniforms: {} };
	}
	public attachShader(program: { fragment: string }, shader: { type: number; source: string }): void {
		if (shader.type === this.FRAGMENT_SHADER) program.fragment = shader.source;
	}
	public getProgramParameter(): boolean {
		return true;
	}
	public getUniformLocation(program: object, name: string): { program: object; name: string } {
		return { program, name };
	}
	public useProgram(program: { fragment: string; uniforms: Record<string, unknown[]> }): void {
		this._program = program;
	}
	public uniform1i(location: { name: string } | null, ...values: unknown[]): void {
		if (location && this._program) this._program.uniforms[location.name] = values;
	}
	public uniform2i(location: { name: string } | null, ...values: unknown[]): void {
		this.uniform1i(location, ...values);
	}

	public activeTexture(unit: number): void {
		this._unit = unit - this.TEXTURE0;
	}
	public createTexture(): FakeTexture {
		const texture = { width: 0, height: 0, format: 0, data: new Uint32Array(0), deleted: false };
		this.textures.push(texture);
		return texture;
	}
	public bindTexture(_target: number, texture: FakeTexture | null): void {
		this._bound[this._unit] = texture;
	}
	public bound(unit: number): FakeTexture | null {
		return this._bound[unit] ?? null;
	}
	public texStorage2D(_target: number, _levels: number, format: number, width: number, height: number): void {
		const texture = this._bound[this._unit]!;
		Object.assign(texture, { width, height, format, data: new Uint32Array(width * height) });
	}
	public texSubImage2D(
		_target: number,
		_level: number,
		x: number,
		y: number,
		width: number,
		height: number,
		_format: number,
		_type: number,
		data: Uint32Array,
		offset: number,
	): void {
		const texture = this._bound[this._unit]!;
		if (x + width > texture.width || y + height > texture.height) throw new Error('Upload outside the texture');
		for (let row = 0; row < height; row++) {
			texture.data.set(data.subarray(offset + row * width, offset + (row + 1) * width), (y + row) * texture.width + x);
		}
		this.uploads.push({ unit: this._unit, x, y, width, height });
	}
	public deleteTexture(texture: FakeTexture | null): void {
		if (texture) texture.deleted = true;
	}

	public drawArrays(): void {
		const program = this._program!;
		this.draws.push({ fragment: program.fragment, uniforms: { ...program.uniforms } });
	}
	public drawArraysInstanced(): void {
		this.drawArrays();
	}

	// Calls whose effect the tests do not read.
	public compileShader(): void {}
	public linkProgram(): void {}
	public deleteShader(): void {}
	public deleteProgram(): void {}
	public texParameteri(): void {}
	public pixelStorei(): void {}
	public createBuffer(): object {
		return {};
	}
	public bindBuffer(): void {}
	public bufferData(): void {}
	public deleteBuffer(): void {}
	public vertexAttribPointer(): void {}
	public enableVertexAttribArray(): void {}
	public enable(): void {}
	public disable(): void {}
	public viewport(): void {}
	public scissor(): void {}
	public clear(): void {}

	/** Words `[from, to)` of a texture, in the order the shaders index them. */
	public static words(texture: FakeTexture, from: number, to: number): number[] {
		return [...texture.data.subarray(from, to)];
	}
}
