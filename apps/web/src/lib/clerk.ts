import { env } from '$env/dynamic/public';

export interface ClerkSession {
	getToken(options?: { template?: string }): Promise<string | null>;
}

export interface ClerkLike {
	readonly user: { readonly id: string; readonly fullName?: string | null } | null;
	readonly session: ClerkSession | null;
	load(): Promise<void>;
	openSignIn(): void;
	signOut(): Promise<void>;
	addListener(listener: () => void): () => void;
}

declare global {
	interface Window {
		Clerk?: ClerkLike;
	}
}

let loading: Promise<ClerkLike> | undefined;

/** Load ClerkJS from the instance's own Frontend API, as recommended for vanilla JS apps. */
export const loadClerk = (): Promise<ClerkLike> => {
	if (loading) return loading;
	loading = new Promise((resolve, reject) => {
		const publishableKey = env.PUBLIC_CLERK_PUBLISHABLE_KEY;
		const frontendApi = env.PUBLIC_CLERK_FRONTEND_API;
		if (!publishableKey || !frontendApi || !/^[a-zA-Z0-9.-]+$/.test(frontendApi)) {
			reject(new Error('Clerk dashboard authentication is not configured'));
			return;
		}
		const finish = async () => {
			if (!window.Clerk) throw new Error('ClerkJS did not initialize');
			await window.Clerk.load();
			resolve(window.Clerk);
		};
		if (window.Clerk) {
			void finish().catch(reject);
			return;
		}
		const script = document.createElement('script');
		script.async = true;
		script.crossOrigin = 'anonymous';
		script.dataset.clerkPublishableKey = publishableKey;
		script.src = `https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
		script.addEventListener('load', () => void finish().catch(reject), { once: true });
		script.addEventListener('error', () => reject(new Error('Could not load ClerkJS')), {
			once: true
		});
		document.head.append(script);
	});
	return loading;
};

export const clerkToken = async (): Promise<string> => {
	const clerk = await loadClerk();
	const token = await clerk.session?.getToken();
	if (!token) throw new Error('Sign in to continue');
	return token;
};
