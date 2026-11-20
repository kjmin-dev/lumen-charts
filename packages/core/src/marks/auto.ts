/** Learn on full draws at the current LOD. Latch acquisition so that a cheap interim
 * Canvas frame cannot repeatedly cancel pipeline creation. Compare blocks of GPU
 * samples to avoid paying two renderer transitions for one window upload. */
export class AutoMarks {
	private state: 'canvas' | 'loading' | 'gpu' = 'canvas';
	private readonly canvasSamples: number[] = [];
	private readonly gpuSamples: number[] = [];
	private reference = 0;
	private smallFrames = 0;
	private cooldown = 0;
	private poorBlocks = 0;
	private blocks = 0;
	private switchDebt = 0;

	public wants(eligible: boolean, small: boolean, full: boolean): boolean {
		if (full && this.cooldown > 0) this.cooldown--;
		if (full && this.state !== 'canvas') {
			this.smallFrames = small ? this.smallFrames + 1 : 0;
			if (this.smallFrames >= 8) this.stop();
		}
		if (this.state === 'canvas') {
			if (!eligible) {
				this.canvasSamples.length = 0;
				return false;
			}
			if (!this.cooldown && this.canvasSamples.filter(ms => ms >= 6).length >= 3) {
				this.reference = median(this.canvasSamples);
				this.state = 'loading';
			}
		}
		return this.state !== 'canvas';
	}
	public canvas(cost: number, eligible: boolean): void {
		if (this.state !== 'canvas' || this.cooldown) return;
		if (!eligible) {
			this.canvasSamples.length = 0;
			return;
		}
		if (this.canvasSamples.length === 5) this.canvasSamples.shift();
		this.canvasSamples.push(cost);
	}
	public gpu(cost: number): void {
		if (this.state === 'loading') {
			this.state = 'gpu';
			this.switchDebt = Math.max(0, cost - this.reference);
			return;
		}
		if (this.state !== 'gpu') return;
		this.gpuSamples.push(cost);
		if (this.gpuSamples.length < 12) return;
		const typical = median(this.gpuSamples);
		for (const ms of this.gpuSamples) this.switchDebt += ms - this.reference;
		this.switchDebt = Math.max(0, this.switchDebt);
		this.gpuSamples.length = 0;
		this.blocks++;
		this.poorBlocks = typical >= this.reference * 0.85 ? this.poorBlocks + 1 : 0;
		if (this.poorBlocks >= 2 || (this.blocks >= 4 && this.switchDebt > 0 && typical >= this.reference * 0.6))
			this.stop();
	}
	private stop(): void {
		this.state = 'canvas';
		this.canvasSamples.length = 0;
		this.gpuSamples.length = 0;
		this.blocks = 0;
		this.poorBlocks = 0;
		this.smallFrames = 0;
		this.cooldown = 30;
	}
}
function median(values: readonly number[]): number {
	const sorted = Float64Array.from(values);
	sorted.sort();
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
