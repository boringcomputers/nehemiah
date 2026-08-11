import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { collectPublicStatus, PUBLIC_STATUS_CACHE_CONTROL } from '$lib/server/public-status';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'cache-control': PUBLIC_STATUS_CACHE_CONTROL });
	return collectPublicStatus({
		controlPlaneUrl: env.STATUS_CONTROL_PLANE_URL,
		gatewayUrl: env.STATUS_GATEWAY_URL,
		production: !dev
	});
};
