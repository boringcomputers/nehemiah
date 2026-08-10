import type { Machine } from '$lib/boring';

/** Manages a self-decrementing countdown from a machine's expiry or a fixed TTL. */
export function createCountdown(
	ttl: () => number,
	onTick: (remaining: number) => void
): {
	start: (machine: Machine | null) => void;
	stop: () => void;
} {
	let interval: ReturnType<typeof setInterval> | null = null;
	let remaining = 0;

	function start(machine: Machine | null) {
		stop();
		remaining = machine?.expires_at
			? Math.max(0, Math.round((new Date(machine.expires_at).getTime() - Date.now()) / 1000))
			: ttl();
		onTick(remaining);
		interval = setInterval(() => {
			remaining -= 1;
			onTick(remaining);
			if (remaining <= 0) stop();
		}, 1000);
	}

	function stop() {
		if (interval) clearInterval(interval);
		interval = null;
	}

	return { start, stop };
}
