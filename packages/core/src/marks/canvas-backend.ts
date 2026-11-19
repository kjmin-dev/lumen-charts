import type { PixelBox } from './render';
import { emptyBox } from './render';
import { PixelSurface } from './surface';
import type { MarksWindow } from './window';

export class CanvasMarkBackend extends PixelSurface {
	private readonly cleared: PixelBox = { left: 0, right: 0, top: 0, bottom: 0 };
	public paint(
		context: CanvasRenderingContext2D,
		opacity: number,
		full: boolean,
		dirty: boolean,
		shown: boolean,
		window: MarksWindow,
		drawAll: () => void,
		drawRows: (from: number, to: number, box: PixelBox) => void,
		box: PixelBox,
	): void {
		if (full) {
			this.clear(this.cleared);
			if (shown) drawAll();
			this.cleared.left = Math.min(this.cleared.left, this.box.left);
			this.cleared.top = Math.min(this.cleared.top, this.box.top);
			this.cleared.right = Math.max(this.cleared.right, this.box.right);
			this.cleared.bottom = Math.max(this.cleared.bottom, this.box.bottom);
			this.commit(this.cleared);
		} else if (dirty && shown && window.dirtyTo > window.dirtyFrom) {
			emptyBox(box);
			drawRows(window.dirtyFrom, window.dirtyTo, box);
			this.commit(box);
		}
		this.draw(context, opacity);
	}
}
