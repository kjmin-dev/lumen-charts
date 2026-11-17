import { type ChartOptions, type DeepPartial, resolveOptions } from './options';
import { type ColorSchemeWatch, watchColorScheme } from './shared/media';

/**
 * The options of a chart: what the application applied, and what that resolves to with the defaults
 * and the theme, which `auto` takes from the system color scheme.
 */
export class ChartSettings {
	/** Everything applied so far, merged; the theme is laid under it whenever it changes. */
	public input: DeepPartial<ChartOptions>;
	/** The options in effect; replaced as a whole by the chart when they change (see `resolve`). */
	public options: ChartOptions;
	/** The system color scheme, watched while the theme is `auto`. */
	private _scheme: ColorSchemeWatch | null = null;
	private readonly _container: HTMLElement;
	private readonly _listener: () => void;

	/** `listener` hears the system color scheme change while the theme is `auto`. */
	public constructor(container: HTMLElement, input: DeepPartial<ChartOptions>, listener: () => void) {
		this._container = container;
		this._listener = listener;
		this.input = input;
		this._watch();
		this.options = this.resolve();
	}

	/** Takes what the application applied, merged already; `resolve` gives the options it leads to. */
	public apply(input: DeepPartial<ChartOptions>): void {
		this.input = input;
		this._watch();
	}

	/** The theme in effect, which `auto` resolves to the system setting. */
	public theme(): 'light' | 'dark' {
		const theme = this.options.theme;
		const dark = theme === 'auto' ? this._scheme?.dark === true : theme === 'dark';
		return dark ? 'dark' : 'light';
	}

	/** Stops watching the system color scheme. */
	public release(): void {
		this._scheme?.release();
		this._scheme = null;
	}

	/** The applied options resolved with the defaults and the theme, as a new object. */
	public resolve(): ChartOptions {
		return resolveOptions(this.input, this._scheme?.dark === true);
	}

	/** Listens to the system color scheme while the theme is `auto`, and only then. */
	private _watch(): void {
		const auto = this.input.theme === 'auto';
		if (auto === (this._scheme !== null)) {
			return;
		}
		if (!auto) {
			this._scheme!.release();
			this._scheme = null;
			return;
		}
		this._scheme = watchColorScheme(this._container.ownerDocument.defaultView, this._listener);
	}
}
