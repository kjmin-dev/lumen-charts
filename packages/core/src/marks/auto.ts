/** Measure on the host that will render the chart. A trial starts after repeated costly
 * full Canvas frames. Switching back uses a lower density boundary and a cooldown. */
export class AutoMarks {
	private active = false;
	private misses = 0;
	private cheap = 0;
	private cooldown = 0;
	private canvasMs = 0;
	private gpuMs = 0;
	private samples = 0;
	private switchDebt = 0;
	public wants(eligible: boolean, small: boolean, full: boolean): boolean {
		if (full && this.cooldown > 0) this.cooldown--;
		if (full && !this.active && !eligible) this.misses = 0;
		if (full && this.active) {
			this.cheap = small ? this.cheap + 1 : 0;
			if (this.cheap >= 8) this.stop();
		}
		return this.active || (eligible && this.misses >= 3 && !this.cooldown);
	}
	public canvas(cost: number, eligible: boolean): void {
		if (!eligible || this.cooldown) {
			this.misses = 0;
			return;
		}
		this.misses = cost >= 6 ? this.misses + 1 : Math.max(0, this.misses - 1);
		this.canvasMs = this.canvasMs ? this.canvasMs * 0.75 + cost * 0.25 : cost;
	}
	public gpu(cost: number): void {
		if (!this.active) {
			this.active = true;
			this.samples = 0;
			this.gpuMs = 0;
			this.switchDebt = Math.max(0, cost - this.canvasMs);
			return;
		}
		this.gpuMs = this.samples ? this.gpuMs * 0.75 + cost * 0.25 : cost;
		this.samples++;
		this.switchDebt = Math.max(0, this.switchDebt + cost - this.canvasMs);
		if ((this.samples >= 6 && this.gpuMs >= this.canvasMs * 0.85) || (this.samples >= 16 && this.switchDebt > 0))
			this.stop();
	}
	private stop(): void {
		this.active = false;
		this.cheap = 0;
		this.misses = 0;
		this.cooldown = 30;
		this.canvasMs = 0;
	}
}
