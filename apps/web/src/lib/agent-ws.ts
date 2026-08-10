import { wsUrl } from '$lib/boring';

export interface AgentMessage {
	type: string;
	text?: string;
}

export interface AgentCallbacks {
	onSay?: (text: string) => void;
	onAction?: (text: string) => void;
	onPreview?: (url: string) => void;
	onDone?: (text: string) => void;
	onError?: (text: string) => void;
	onClose?: () => void;
}

/**
 * Open a WebSocket to a machine's agent endpoint and dispatch parsed messages
 * to callbacks. Returns the WebSocket for external lifecycle management.
 */
export function connectAgent(
	machineId: string,
	path: string,
	goal: string,
	callbacks: AgentCallbacks
): WebSocket {
	const ws = new WebSocket(wsUrl(path));
	const normalizedGoal = goal.trim();
	const goalBytes = new TextEncoder().encode(normalizedGoal).byteLength;
	const startFrame = JSON.stringify({ type: 'start', version: 1, goal: normalizedGoal });

	ws.onopen = () => {
		if (
			goalBytes < 1 ||
			goalBytes > 4096 ||
			new TextEncoder().encode(startFrame).byteLength > 64 * 1024
		) {
			callbacks.onError?.('the agent goal must be between 1 and 4096 UTF-8 bytes');
			ws.close(1008, 'invalid_start_frame');
			return;
		}
		ws.send(startFrame);
	};

	ws.onmessage = (e) => {
		let m: AgentMessage;
		try {
			m = JSON.parse(e.data);
		} catch {
			return;
		}
		switch (m.type) {
			case 'done':
				callbacks.onDone?.(m.text || 'done');
				ws.close();
				break;
			case 'error':
				callbacks.onError?.(m.text || 'something went wrong');
				ws.close();
				break;
			case 'say':
				if (m.text) callbacks.onSay?.(m.text);
				break;
			case 'action':
				if (m.text) callbacks.onAction?.(m.text);
				break;
			case 'preview':
				if (m.text) callbacks.onPreview?.(m.text);
				break;
		}
	};

	ws.onclose = () => callbacks.onClose?.();

	return ws;
}
