import { clerkToken } from './clerk';

export interface DashboardProblem {
	readonly title?: string;
	readonly detail?: string;
	readonly status?: number;
}

export class DashboardApiError extends Error {
	constructor(
		readonly status: number,
		readonly problem: DashboardProblem
	) {
		super(problem.detail ?? problem.title ?? `Request failed (${status})`);
	}
}

export interface OrganizationOption {
	readonly id: string;
}

export interface DashboardMachineSession {
	readonly token: string;
	readonly expires_in: number;
	readonly gateway_url: string;
	readonly preview_url?: string;
}

/** Keep a valid prior choice, otherwise make a deterministic first selection. */
export const organizationForDashboard = (
	organizations: ReadonlyArray<OrganizationOption>,
	previous?: string
): string | undefined =>
	previous && organizations.some((organization) => organization.id === previous)
		? previous
		: organizations[0]?.id;

const gatewayUrl = (value: string): URL => {
	const url = new URL(value);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error('The session gateway URL is invalid');
	}
	url.username = '';
	url.password = '';
	url.search = '';
	url.hash = '';
	return url;
};

export interface DashboardWebSocketSession {
	readonly url: string;
	readonly protocols: readonly [string];
}

export const machineWebSocketSession = (
	session: DashboardMachineSession,
	machineId: string,
	capability: 'tty' | 'vnc'
): DashboardWebSocketSession => {
	const url = gatewayUrl(session.gateway_url);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/v1/machines/${encodeURIComponent(machineId)}/${capability}`;
	return {
		url: url.toString(),
		protocols: [`nehemiah.capability.${session.token}`]
	};
};

export const machinePreviewUrl = (
	session: DashboardMachineSession,
	machineId: string,
	port: number
): string => {
	gatewayUrl(session.gateway_url);
	if (!session.preview_url) throw new Error('The preview session did not include a URL');
	const supplied = new URL(session.preview_url);
	const fragment = new URLSearchParams(supplied.hash.slice(1));
	const fragmentTokens = fragment.getAll('token');
	if (
		(supplied.protocol !== 'https:' && supplied.protocol !== 'http:') ||
		supplied.username !== '' ||
		supplied.password !== '' ||
		supplied.pathname !== `/preview/${encodeURIComponent(machineId)}/${port}/` ||
		supplied.search !== '' ||
		fragmentTokens.length !== 1 ||
		fragmentTokens[0] === '' ||
		[...fragment.keys()].some((key) => key !== 'token')
	) {
		throw new Error('The preview URL is invalid');
	}
	// Production previews may use a per-lease wildcard origin. The control plane
	// and gateway bind that host cryptographically; dashboard code keeps the
	// fragment-based bootstrap opaque and never turns it into query auth.
	return supplied.toString();
};

export const selectedOrganization = (): string | undefined =>
	typeof localStorage === 'undefined'
		? undefined
		: (localStorage.getItem('nehemiah.organization') ?? undefined);

export const selectOrganization = (id: string): void => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('nehemiah.organization', id);
};

export const dashboardApi = async <T>(
	path: string,
	init: RequestInit = {},
	organizationId = selectedOrganization()
): Promise<T> => {
	const token = await clerkToken();
	const response = await fetch(`/dashboard/api${path.startsWith('/') ? path : `/${path}`}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			...(organizationId ? { 'x-nehemiah-organization-id': organizationId } : {}),
			...(init.body ? { 'content-type': 'application/json' } : {}),
			...init.headers
		}
	});
	if (!response.ok) {
		const problem = (await response.json().catch(() => ({}))) as DashboardProblem;
		throw new DashboardApiError(response.status, problem);
	}
	return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
};
