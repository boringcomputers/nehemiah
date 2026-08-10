import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';
import { publicSupportConfig } from '$lib/public-support';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	setHeaders({
		'cache-control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=60'
	});
	return publicSupportConfig(
		{ url: env.PUBLIC_SUPPORT_URL, email: env.PUBLIC_SUPPORT_EMAIL },
		!dev
	);
};
