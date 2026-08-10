import { wsUrl } from '$lib/boring';

export interface TerminalHandle {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	term: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fit: any;
	ws: WebSocket;
	cleanup: () => void;
}

export interface TerminalOptions {
	host: HTMLDivElement;
	machineId: string;
	connection?: {
		readonly url: string;
		readonly protocols?: string | string[] | readonly string[];
	};
	fontSize?: number;
	theme?: Record<string, string>;
	bannerText: string;
	onClose?: () => void;
}

/**
 * Set up an xterm.js terminal connected to a machine PTY via WebSocket,
 * including the copy-selection key handler and resize listener. Managed hosts
 * terminate this in the restart-safe guest agent; local mode uses serial.
 * Returns handles for cleanup.
 */
export async function setupTerminal(opts: TerminalOptions): Promise<TerminalHandle> {
	const { Terminal } = await import('@xterm/xterm');
	const { FitAddon } = await import('@xterm/addon-fit');

	const term = new Terminal({
		fontFamily: "'Geist Mono', ui-monospace, monospace",
		fontSize: opts.fontSize ?? 13,
		cursorBlink: true,
		theme: opts.theme ?? {
			background: '#0a0a0a',
			foreground: '#ededed',
			cursor: '#ededed',
			selectionBackground: '#003674',
			black: '#000000',
			green: '#00ca50',
			brightBlack: '#7d7d7d',
			white: '#ededed'
		}
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(opts.host);
	fit.fit();

	const onResize = () => fit.fit();
	window.addEventListener('resize', onResize);

	const ws = opts.connection
		? new WebSocket(opts.connection.url, opts.connection.protocols as string | string[] | undefined)
		: new WebSocket(wsUrl(`/v1/machines/${opts.machineId}/tty`));
	ws.binaryType = 'arraybuffer';
	const enc = new TextEncoder();

	ws.onmessage = (e) => {
		if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
		else term.write(e.data);
	};
	ws.onclose = () => opts.onClose?.();

	term.onData((d: string) => ws.readyState === WebSocket.OPEN && ws.send(enc.encode(d)));

	// Copy selection: Cmd+C (mac) or Ctrl+Shift+C; bare Ctrl+C stays SIGINT.
	term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
		if (
			e.type === 'keydown' &&
			e.key.toLowerCase() === 'c' &&
			(e.metaKey || (e.ctrlKey && e.shiftKey))
		) {
			const sel = term.getSelection();
			if (sel) {
				void navigator.clipboard?.writeText(sel).catch(() => {});
				return false;
			}
		}
		return true;
	});

	// Clear boot scrollback and show the banner. If the component is closed within
	// this window, cleanup() cancels the timer so we never reset()/write() a
	// disposed xterm instance.
	let disposed = false;
	const bannerTimer = setTimeout(() => {
		if (disposed) return;
		term.reset();
		term.write(opts.bannerText);
		if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode('\n'));
	}, 500);

	term.focus();

	function cleanup() {
		disposed = true;
		clearTimeout(bannerTimer);
		window.removeEventListener('resize', onResize);
		try {
			ws.close();
		} catch {
			/* ignore */
		}
		term.dispose();
	}

	return { term, fit, ws, cleanup };
}
