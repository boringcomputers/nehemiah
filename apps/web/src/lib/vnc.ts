import { wsUrl } from '$lib/boring';

export interface VncHandle {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	rfb: any;
	teardown: () => void;
}

export interface VncOptions {
	screen: HTMLDivElement;
	machineId: string;
	connection?: {
		readonly url: string;
		readonly protocols?: readonly string[];
	};
	viewOnly?: boolean;
	qualityLevel?: number;
	compressionLevel?: number;
	onConnect?: () => void;
	onDisconnect?: () => void;
}

/**
 * Connect to a machine's VNC display via noVNC, with retry logic.
 * Returns a handle to the RFB instance and a teardown function, or null
 * if the component has been disposed.
 */
export async function connectVnc(
	opts: VncOptions,
	disposed: () => boolean
): Promise<VncHandle | null> {
	if (disposed() || !opts.screen) return null;

	const { default: RFB } = await import('@novnc/novnc');
	if (disposed()) return null;

	teardownScreen(opts.screen);

	const url = opts.connection?.url ?? wsUrl(`/v1/machines/${opts.machineId}/vnc`);
	const rfb = new RFB(opts.screen, url, {
		wsProtocols: opts.connection?.protocols ? [...opts.connection.protocols] : undefined
	});
	rfb.scaleViewport = true;
	rfb.resizeSession = false;
	rfb.background = '#000';
	if (opts.viewOnly) rfb.viewOnly = true;
	if (opts.qualityLevel !== undefined) rfb.qualityLevel = opts.qualityLevel;
	if (opts.compressionLevel !== undefined) rfb.compressionLevel = opts.compressionLevel;

	rfb.addEventListener('connect', () => {
		if (!disposed()) opts.onConnect?.();
	});
	rfb.addEventListener('disconnect', () => {
		if (!disposed()) opts.onDisconnect?.();
	});

	function teardown() {
		try {
			rfb.disconnect();
		} catch {
			/* ignore */
		}
		teardownScreen(opts.screen);
	}

	return { rfb, teardown };
}

/** Clear noVNC-injected DOM children from a container. */
export function teardownScreen(screen: HTMLDivElement | undefined) {
	if (screen) screen.innerHTML = '';
}
