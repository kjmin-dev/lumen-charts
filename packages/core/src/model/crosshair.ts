/** Where the crosshair is: CSS pixels relative to the pane, or hidden. */
export class Crosshair {
	public x = 0;
	/** NaN for a crosshair without a horizontal line (placed by time alone). */
	public y = 0;
	public visible = false;
	/** What placed it last: the pointer, the keyboard navigator, or the application. */
	public source: 'pointer' | 'keyboard' | 'api' = 'pointer';
	/** The crosshair moved since drawings were last hit-tested for it. */
	public hoverDirty = false;
}
