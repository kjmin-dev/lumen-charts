/** Where the crosshair is: CSS pixels relative to the pane, or hidden. */
export class Crosshair {
	public x = 0;
	public y = 0;
	public visible = false;
	/** The crosshair moved since drawings were last hit-tested for it. */
	public hoverDirty = false;
}
